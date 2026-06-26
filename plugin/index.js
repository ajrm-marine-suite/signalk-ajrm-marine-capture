const childProcess = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const zlib = require("node:zlib");
const { randomUUID } = require("node:crypto");
const packageInfo = require("../package.json");

const MPS_TO_KNOTS = 1.9438444924406046;
const ENGINE_STATIONARY_THRESHOLD_MPS = 0.35;
const ENGINE_STATIONARY_THRESHOLD_KNOTS =
  ENGINE_STATIONARY_THRESHOLD_MPS * MPS_TO_KNOTS;
const AJRM_MARINE_LOGGER_API_REGISTRY = Symbol.for("mcdonaldajr.ajrmMarineLoggerApi");
const AJRM_MARINE_SNAPSHOT_API_REGISTRY = Symbol.for("mcdonaldajr.ajrmMarineSnapshotApi");
const CAPTURE_MODES = new Set(["minimal", "voyage", "debug"]);
const CAPTURE_FILE_MODES = new Set(["portable", "reference"]);
const POWER_INTENT_PATH = "plugins.ajrmMarinePiController.power.intent";
const AJRM_MARINE_GPS_INTEGRITY_STATE_PATH = "plugins.ajrmMarineGpsIntegrity.navigationIntegrity";
const DR_TRACK_RELATIVE_PATH = "tracks/dr-track.jsonl";
const PLUGIN_CONFIG_FILE = path.join(
  os.homedir(),
  ".signalk",
  "plugin-config-data",
  "signalk-ajrm-marine-capture.json",
);

module.exports = function ajrmMarineCapture(app) {
  const plugin = {};
  let options = normalizeOptions({});
  let deltaListener = null;
  let monitorTimer = null;
  let snapshotTimer = null;
  let currentVoyage = null;
  let speedKnots = null;
  let movingSinceMs = null;
  let stoppedSinceMs = null;
  let autoStartInhibited = false;
  let lastBundle = null;
  let disk = null;
  let stoppingVoyage = false;
  let shutdownPending = false;
  let lastPowerIntentKey = null;
  let nextVoyageComment = "";
  let notificationSequence = 0;
  let notificationSessionId = randomUUID();
  const recentEvents = [];

  plugin.id = "signalk-ajrm-marine-capture";
  plugin.name = "AJRM Marine Capture";
  plugin.description =
    "Automatic voyage recorder, snapshotter, indexer, and bundle dashboard.";

  plugin.schema = {
    type: "object",
    properties: {
      enabled: {
        type: "boolean",
        title: "Enable automatic voyage recording",
        default: false,
      },
      voyageDirectory: {
        type: "string",
        title: "Voyage bundle directory",
        default: "~/CapturePlusLogs/voyages",
      },
      ajrmMarineLoggerLogDirectory: {
        type: "string",
        title: "CapturePlus log directory",
        description:
          "Used to copy completed CapturePlus recordings into the voyage bundle. Keep aligned with CapturePlus.",
        default: "~/CapturePlusLogs",
      },
      signalKBaseUrl: {
        type: "string",
        title: "Local Signal K base URL",
        description:
          "Used for internal CapturePlus and AJRM Marine Snapshot calls. Typical values are http://127.0.0.1:3000 or https://127.0.0.1:3443.",
        default: "http://127.0.0.1:3000",
      },
      movementSpeedKnots: {
        type: "number",
        title: "Movement speed threshold knots",
        description:
          "Defaults to the Traffic Core/Engine stationary automute threshold of 0.35 m/s, shown here as knots.",
        default: Number(ENGINE_STATIONARY_THRESHOLD_KNOTS.toFixed(2)),
        minimum: 0.1,
      },
      movementSeconds: {
        type: "integer",
        title: "Seconds moving before starting voyage",
        default: 20,
        minimum: 1,
      },
      stoppedMinutes: {
        type: "integer",
        title: "Minutes stopped before ending voyage",
        default: 10,
        minimum: 1,
      },
      captureBackfillMinutes: {
        type: "integer",
        title: "CapturePlus backfill minutes on voyage start",
        default: 30,
        minimum: 0,
        maximum: 1440,
      },
      captureMode: {
        type: "string",
        title: "Voyage diagnostic mode",
        description:
          "Minimal records raw Signal K only. Voyage adds compact start/stop snapshots. Debug adds richer snapshots and periodic snapshots while underway.",
        enum: ["minimal", "voyage", "debug"],
        default: "voyage",
      },
      captureFileMode: {
        type: "string",
        title: "Voyage recording file handling",
        description:
          "Portable copies matching AJRM Marine Logger segments into the voyage zip. Reference records the source file list in the index without duplicating raw logs.",
        enum: ["portable", "reference"],
        default: "reference",
      },
      snapshotIntervalSeconds: {
        type: "integer",
        title: "Debug snapshot interval seconds",
        description:
          "Only used when voyage diagnostic mode is Debug. Voyage mode keeps compact start and stop snapshots only.",
        default: 300,
        minimum: 30,
        maximum: 86400,
      },
      captureCompressionWaitSeconds: {
        type: "integer",
        title: "Seconds to wait for CapturePlus gzip after stop",
        description:
          "AJRM Marine Capture waits briefly after stopping AJRM Marine Logger so completed hourly capture segments can become .jsonl.gz before being copied into the voyage bundle.",
        default: 0,
        minimum: 0,
        maximum: 600,
      },
      deleteWorkingDirectoryAfterZip: {
        type: "boolean",
        title: "Delete uncompressed voyage working folder after zip",
        description:
          "Keeps only the downloadable voyage zip when bundle creation succeeds. Enable this for smaller SD cards.",
        default: true,
      },
      minFreeDiskGb: {
        type: "number",
        title: "Minimum free disk GB",
        description:
          "Voyage recording is stopped if free space falls below this value.",
        default: 2,
        minimum: 0.1,
      },
    },
  };

  plugin.start = (pluginOptions = {}) => {
    options = normalizeOptions(pluginOptions);
    shutdownPending = false;
    lastPowerIntentKey = null;
    notificationSessionId = randomUUID();
    notificationSequence = 0;
    ensureDirectories();
    closeIncompleteVoyagesOnStartup().catch((error) =>
      logError("startup voyage recovery failed", error),
    );
    deltaListener = (delta) => onDelta(delta);
    app.signalk.on("delta", deltaListener);
    monitorTimer = setInterval(() => {
      monitor().catch((error) => logError("monitor failed", error));
    }, 5000);
    if (options.captureMode === "debug") {
      snapshotTimer = setInterval(() => {
        takePeriodicSnapshot().catch((error) => logError("snapshot failed", error));
      }, options.snapshotIntervalSeconds * 1000);
    }
    monitor().catch((error) => logError("initial monitor failed", error));
    addEvent("started", `AJRM Marine Capture v${packageInfo.version} started`);
    app.setPluginStatus(`Started v${packageInfo.version}`);
  };

  plugin.stop = () => {
    if (deltaListener) {
      app.signalk.removeListener("delta", deltaListener);
      deltaListener = null;
    }
    clearInterval(monitorTimer);
    clearInterval(snapshotTimer);
    monitorTimer = null;
    snapshotTimer = null;
    if (currentVoyage) {
      stopVoyage("plugin stopped").catch((error) => logError("stop voyage failed", error));
    }
  };

  plugin.registerWithRouter = function registerWithRouter(router) {
    router.get("/status", async (_req, res) => {
      try {
        res.json(await buildStatus());
      } catch (error) {
        logError("status failed", error);
        res.status(500).json({ ok: false, error: error.message });
      }
    });

    router.get("/voyages", async (_req, res) => {
      try {
        res.json({ ok: true, voyages: await listVoyageBundles() });
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    });

    router.get("/voyages/:file/download", async (req, res) => {
      let temporaryBundle = null;
      try {
        const fileName = safeBaseName(req.params.file);
        const filePath = path.join(options.voyageDirectory, fileName);
        const info = await fs.promises.stat(filePath);
        if (!info.isFile() || !fileName.endsWith(".zip")) {
          res.status(404).json({ ok: false, error: "Voyage bundle not found" });
          return;
        }
        temporaryBundle = await buildPortableDownloadBundle(filePath, fileName);
        const downloadPath = temporaryBundle?.path || filePath;
        res.download(downloadPath, fileName, () => {
          if (temporaryBundle?.directory) {
            fs.promises.rm(temporaryBundle.directory, { recursive: true, force: true }).catch(() => {});
          }
        });
      } catch (error) {
        if (temporaryBundle?.directory) {
          fs.promises.rm(temporaryBundle.directory, { recursive: true, force: true }).catch(() => {});
        }
        res.status(404).json({ ok: false, error: "Voyage bundle not found" });
      }
    });

    router.post("/voyages/:file/delete", async (req, res) => {
      try {
        const fileName = safeBaseName(req.params.file);
        if (!fileName.endsWith(".zip")) {
          res.status(400).json({ ok: false, error: "Only voyage zip files can be deleted" });
          return;
        }
        const filePath = path.join(options.voyageDirectory, fileName);
        const info = await fs.promises.stat(filePath);
        if (!info.isFile()) {
          res.status(404).json({ ok: false, error: "Voyage bundle not found" });
          return;
        }
        await fs.promises.unlink(filePath);
        const voyageId = fileName.replace(/\.zip$/i, "");
        await fs.promises.rm(path.join(options.voyageDirectory, voyageId), {
          recursive: true,
          force: true,
        });
        if (lastBundle?.fileName === fileName) lastBundle = null;
        addEvent("voyage-deleted", fileName);
        publishState();
        res.json({ ok: true, deleted: fileName });
      } catch (error) {
        res.status(404).json({ ok: false, error: "Voyage bundle not found" });
      }
    });

    router.post("/settings", async (req, res) => {
      const enabled = req.body?.enabled === true;
      try {
        await persistPluginConfiguration({ enabled });
        options.enabled = enabled;
        addEvent("settings", `Automatic voyage recording ${options.enabled ? "enabled" : "disabled"}`);
        publishState();
        res.json({ ok: true, enabled: options.enabled });
      } catch (error) {
        logError("settings save failed", error);
        res.status(500).json({ ok: false, error: "Failed to save automatic voyage recording setting" });
      }
    });

    router.post("/voyage/start", async (req, res) => {
      try {
        if (req.body?.comment !== undefined) {
          nextVoyageComment = normalizeComment(req.body.comment);
        }
        const voyage = await startVoyage("manual");
        res.json({ ok: true, voyage });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    });

    router.post("/voyage/comment", async (req, res) => {
      try {
        const comment = normalizeComment(req.body?.comment);
        if (currentVoyage) {
          currentVoyage.comment = comment;
          addVoyageEvent("comment", comment ? "Voyage comment updated" : "Voyage comment cleared");
          await writeVoyageIndex(currentVoyage);
        } else {
          nextVoyageComment = comment;
        }
        addEvent("comment", comment ? "Voyage comment saved" : "Voyage comment cleared");
        publishState();
        res.json({ ok: true, comment });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    });

    router.post("/voyage/stop", async (_req, res) => {
      try {
        const bundle = await stopVoyage("manual");
        inhibitAutoStartUntilStationary();
        res.json({ ok: true, bundle });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    });
  };

  return plugin;

  function normalizeOptions(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      enabled: source.enabled === true,
      voyageDirectory: expandHome(source.voyageDirectory || "~/CapturePlusLogs/voyages"),
      ajrmMarineLoggerLogDirectory: expandHome(source.ajrmMarineLoggerLogDirectory || "~/CapturePlusLogs"),
      signalKBaseUrl: String(source.signalKBaseUrl || "http://127.0.0.1:3000").replace(/\/+$/, ""),
      movementSpeedKnots: clampNumber(
        source.movementSpeedKnots,
        ENGINE_STATIONARY_THRESHOLD_KNOTS,
        0.1,
        100,
      ),
      movementSeconds: clampInt(source.movementSeconds, 20, 1, 86400),
      stoppedMinutes: clampInt(source.stoppedMinutes, 10, 1, 1440),
      captureBackfillMinutes: clampInt(source.captureBackfillMinutes, 30, 0, 1440),
      captureMode: CAPTURE_MODES.has(source.captureMode) ? source.captureMode : "voyage",
      captureFileMode: CAPTURE_FILE_MODES.has(source.captureFileMode)
        ? source.captureFileMode
        : "reference",
      snapshotIntervalSeconds: clampInt(source.snapshotIntervalSeconds, 300, 30, 86400),
      captureCompressionWaitSeconds: clampInt(source.captureCompressionWaitSeconds, 0, 0, 600),
      deleteWorkingDirectoryAfterZip: source.deleteWorkingDirectoryAfterZip !== false,
      minFreeDiskGb: clampNumber(source.minFreeDiskGb, 2, 0.1, 1024),
    };
  }

  function ensureDirectories() {
    fs.mkdirSync(options.voyageDirectory, { recursive: true });
  }

  async function persistPluginConfiguration(changes) {
    const filePath = PLUGIN_CONFIG_FILE;
    const directory = path.dirname(filePath);
    await fs.promises.mkdir(directory, { recursive: true });
    let existing = {};
    try {
      existing = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const configuration =
      existing.configuration && typeof existing.configuration === "object"
        ? existing.configuration
        : {};
    const updated = {
      ...existing,
      configuration: {
        ...configuration,
        ...changes,
      },
    };
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(temporaryPath, `${JSON.stringify(updated, null, 2)}\n`);
    await fs.promises.rename(temporaryPath, filePath);
  }

  function onDelta(delta) {
    const updates = Array.isArray(delta?.updates) ? delta.updates : [];
    if (handlePowerIntent(updates)) return;
    updates.forEach((update) => {
      const context = update.context || delta.context || "vessels.self";
      if (!isSelfContext(context)) return;
      (update.values || []).forEach((entry) => {
        if (entry.path === "navigation.speedOverGround") {
          speedKnots = speedKnotsFromSog(entry.value);
        } else if (entry.path === AJRM_MARINE_GPS_INTEGRITY_STATE_PATH) {
          appendDrTrackSample(entry.value, update.timestamp || delta.timestamp || new Date().toISOString());
        }
      });
    });
  }

  function handlePowerIntent(updates) {
    let handled = false;
    for (const update of updates) {
      for (const entry of update.values || []) {
        if (entry.path !== POWER_INTENT_PATH) continue;
        const intent = unwrapValue(entry.value);
        if (!intent || typeof intent !== "object") continue;
        if (!["shutdown", "reboot"].includes(intent.action)) continue;
        if (!["waiting", "running"].includes(intent.status)) continue;
        const key = `${intent.action}:${intent.requestedAt || intent.runAt || ""}:${intent.status}`;
        if (key === lastPowerIntentKey) {
          handled = true;
          continue;
        }
        lastPowerIntentKey = key;
        shutdownPending = true;
        movingSinceMs = null;
        stoppedSinceMs = Date.now();
        addEvent("power-intent", `AJRM Marine Pi Controller ${intent.action} ${intent.status}`);
        logInfo(`AJRM Marine Pi Controller ${intent.action} ${intent.status}; voyage shutdown started`);
        if (currentVoyage && !stoppingVoyage) {
          stopVoyage(`AJRM Marine Pi Controller ${intent.action} requested`).catch((error) =>
            logError("power intent voyage stop failed", error),
          );
        }
        handled = true;
      }
    }
    return handled;
  }

  function isSelfContext(context) {
    const value = String(context || "");
    if (!value || value === "vessels.self") return true;
    const self = String(app.selfId || app.selfContext || app.self || "");
    return Boolean(self && (value === self || value === `vessels.${self}`));
  }

  async function monitor() {
    refreshSpeedFromSelfPath();
    disk = await readDiskStatus(options.voyageDirectory);
    if (shutdownPending) {
      publishState();
      return;
    }
    if (currentVoyage && disk?.availableBytes < options.minFreeDiskGb * 1024 * 1024 * 1024) {
      await stopVoyage("low disk space");
      publishNotification({
        leaf: "disk",
        message: "Voyage recording stopped because disk space is low.",
        state: "alarm",
      });
      return;
    }

    const now = Date.now();
    const movement = nextMovementGateState({
      speedKnots,
      movementSpeedKnots: options.movementSpeedKnots,
      now,
      movingSinceMs,
      stoppedSinceMs,
      autoStartInhibited,
    });
    movingSinceMs = movement.movingSinceMs;
    stoppedSinceMs = movement.stoppedSinceMs;
    autoStartInhibited = movement.autoStartInhibited;

    if (
      options.enabled &&
      !currentVoyage &&
      movingSinceMs &&
      now - movingSinceMs >= options.movementSeconds * 1000
    ) {
      await startVoyage("movement detected");
    }

    if (
      currentVoyage &&
      !stoppingVoyage &&
      stoppedSinceMs &&
      now - stoppedSinceMs >= options.stoppedMinutes * 60 * 1000
    ) {
      await stopVoyage("vessel stopped");
    }

    publishState();
  }

  function refreshSpeedFromSelfPath() {
    if (typeof app.getSelfPath !== "function") return;
    speedKnots = speedKnotsFromSog(app.getSelfPath("navigation.speedOverGround"));
  }

  async function startVoyage(reason) {
    if (currentVoyage) return summarizeVoyage(currentVoyage);
    ensureDirectories();
    const startedAt = new Date();
    const id = `voyage-${formatFileTime(startedAt)}`;
    const directory = path.join(options.voyageDirectory, id);
    await fs.promises.mkdir(path.join(directory, "snapshots"), { recursive: true });
    await fs.promises.mkdir(path.join(directory, "capture"), { recursive: true });
    await fs.promises.mkdir(path.join(directory, "system"), { recursive: true });
    await fs.promises.mkdir(path.join(directory, "tracks"), { recursive: true });

    currentVoyage = {
      id,
      directory,
      startedAt: startedAt.toISOString(),
      reason,
      comment: nextVoyageComment,
      snapshotCount: 0,
      captureMode: options.captureMode,
      captureFileMode: options.captureFileMode,
      ajrmMarineLogger: null,
      events: [],
      drTrack: {
        fileName: DR_TRACK_RELATIVE_PATH,
        samples: 0,
        writeErrors: 0,
        startedAt: startedAt.toISOString(),
        stoppedAt: null,
      },
    };
    currentVoyage.drTrackStream = fs.createWriteStream(path.join(directory, DR_TRACK_RELATIVE_PATH), {
      flags: "a",
    });
    nextVoyageComment = "";
    addVoyageEvent("start", reason);
    publishNotification({
      voyageId: id,
      leaf: "start",
      message: "Voyage recording started.",
      state: "alert",
    });
    addEvent("voyage-started", `${id}: ${reason}`);

    currentVoyage.ajrmMarineLogger = await callCapturePlus("/capture/start", {
      backfillMinutes: options.captureBackfillMinutes,
    }).catch((error) => ({ ok: false, error: error.message }));
    currentVoyage.captureReferences = initialCaptureReferences(currentVoyage);
    if (currentVoyage.captureReferences.length) {
      addVoyageEvent(
        "capture-reference",
        `${currentVoyage.captureReferences.length} AJRM Marine Logger segment${currentVoyage.captureReferences.length === 1 ? "" : "s"} referenced at voyage start`,
      );
    }
    await writeJson(path.join(directory, "system", "start-status.json"), await buildStatus());
    if (shouldTakeSnapshot("start")) await takeSnapshot("start");
    await writeVoyageIndex(currentVoyage);
    publishState();
    return summarizeVoyage(currentVoyage);
  }

  async function stopVoyage(reason) {
    if (!currentVoyage) return lastBundle;
    if (stoppingVoyage) return lastBundle;
    stoppingVoyage = true;
    const voyage = currentVoyage;
    try {
      addVoyageEvent("stop", reason);
      addEvent("voyage-stopping", `${voyage.id}: ${reason}`);
      if (shouldTakeSnapshot("stop")) await takeSnapshot("stop");
      const captureStop = await callCapturePlus("/capture/stop", {}).catch((error) => ({
        ok: false,
        error: error.message,
      }));
      voyage.captureStop = captureStop;
      const stoppedAt = new Date().toISOString();
      voyage.stoppedAt = stoppedAt;
      voyage.stopReason = reason;
      await closeDrTrack(voyage, stoppedAt);
      await copyCaptureFiles(voyage, captureStop);
      const index = await writeVoyageIndex(voyage);
      const bundle = await bundleVoyage(voyage, index);
      if (bundle?.format === "zip" && options.deleteWorkingDirectoryAfterZip) {
        await fs.promises.rm(voyage.directory, { recursive: true, force: true });
        bundle.workingDirectoryDeleted = true;
      }
      currentVoyage = null;
      lastBundle = bundle;
      publishNotification({
        voyageId: voyage.id,
        leaf: "stop",
        message: "Voyage recording stopped and diagnostic bundle prepared.",
        state: "alert",
      });
      addEvent("voyage-stopped", `${voyage.id}: ${reason}`);
      publishState();
      return bundle;
    } finally {
      stoppingVoyage = false;
    }
  }

  async function closeIncompleteVoyagesOnStartup() {
    const entries = await fs.promises.readdir(options.voyageDirectory, {
      withFileTypes: true,
    }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^voyage-\d{8}T\d{6}Z$/.test(entry.name)) {
        continue;
      }
      const directory = path.join(options.voyageDirectory, entry.name);
      const zipPath = path.join(options.voyageDirectory, `${entry.name}.zip`);
      const existingZip = await fs.promises.stat(zipPath).catch(() => null);
      if (existingZip?.isFile()) continue;
      const bundle = await closeIncompleteVoyageDirectory(entry.name, directory).catch((error) => {
        logError(`failed to recover ${entry.name}`, error);
        return null;
      });
      if (bundle) lastBundle = bundle;
    }
  }

  async function closeIncompleteVoyageDirectory(id, directory) {
    const now = new Date().toISOString();
    await fs.promises.mkdir(path.join(directory, "system"), { recursive: true });
    await fs.promises.mkdir(path.join(directory, "capture"), { recursive: true });
    const existingIndex = await readJson(path.join(directory, "index.json"));
    const voyage = {
      id,
      directory,
      startedAt: existingIndex?.startedAt || startedAtFromVoyageId(id) || now,
      stoppedAt: now,
      reason: existingIndex?.startReason || "recovered incomplete voyage",
      stopReason: "Signal K restarted before AJRM Marine Capture stopped this voyage",
      comment: normalizeComment(existingIndex?.comment),
      snapshotCount: await countFiles(path.join(directory, "snapshots"), ".json"),
      captureMode: CAPTURE_MODES.has(existingIndex?.captureMode)
        ? existingIndex.captureMode
        : options.captureMode,
      captureFileMode: CAPTURE_FILE_MODES.has(existingIndex?.captureFileMode)
        ? existingIndex.captureFileMode
        : "reference",
      ajrmMarineLogger: existingIndex?.ajrmMarineLogger?.start || null,
      captureStop: {
        ok: false,
        interruptedByRestart: true,
        error: "Signal K restarted before voyage recording was stopped.",
        recoveredAt: now,
      },
      captureFiles: await listCaptureFileNames(path.join(directory, "capture")),
      captureReferences: Array.isArray(existingIndex?.captureReferences) && existingIndex.captureReferences.length
        ? existingIndex.captureReferences
        : initialCaptureReferencesFromStart(existingIndex),
      events: Array.isArray(existingIndex?.events) ? existingIndex.events.slice(0, 200) : [],
      recoveredAt: now,
      interruptedByRestart: true,
    };
    appendVoyageEvent(voyage, "recovered", "Voyage closed at startup after Signal K restart");
    if (!voyage.captureFiles.length && !voyage.captureReferences.length) {
      appendVoyageEvent(
        voyage,
        "capture-reference-warning",
        "No copied AJRM Marine Logger files were present in the interrupted voyage directory",
      );
    }
    await writeJson(path.join(directory, "system", "recovery-status.json"), {
      ok: true,
      recoveredAt: now,
      reason: voyage.stopReason,
      note: "This voyage was not resumed because Signal K was stopped or restarted before normal voyage shutdown.",
    });
    const index = await writeVoyageIndex(voyage);
    const bundle = await bundleVoyage(voyage, index);
    if (bundle?.format === "zip" && options.deleteWorkingDirectoryAfterZip) {
      await fs.promises.rm(directory, { recursive: true, force: true });
      bundle.workingDirectoryDeleted = true;
    }
    addEvent("voyage-recovered", `${id}: closed incomplete voyage after startup`);
    logInfo(`${id} closed as incomplete voyage after startup`);
    publishState();
    return bundle;
  }

  async function takePeriodicSnapshot() {
    if (!currentVoyage || !shouldTakeSnapshot("periodic")) return;
    await takeSnapshot("periodic");
    publishState();
  }

  async function takeSnapshot(label) {
    if (!currentVoyage) return null;
    const now = new Date();
    const fileName = `${formatFileTime(now)}-${safeFilePart(label)}.json`;
    const filePath = path.join(currentVoyage.directory, "snapshots", fileName);
    const snapshot = await fetchAiSnapshot().catch((error) => ({
      timestamp: now.toISOString(),
      fallback: true,
      error: error.message,
      self: buildFallbackSelfSnapshot(),
      ajrmMarineCapture: summarizeVoyage(currentVoyage),
    }));
    await writeJson(filePath, snapshot);
    currentVoyage.snapshotCount += 1;
    addVoyageEvent("snapshot", fileName);
    addEvent("snapshot", fileName);
    return filePath;
  }

  async function fetchAiSnapshot() {
    const ajrmMarineSnapshotApi = getAiSnapshotApi();
    const snapshotPreset = options.captureMode === "debug" ? "debug" : "voyage";
    const snapshotOptions = {
      snapshotPreset,
    };
    if (typeof ajrmMarineSnapshotApi?.snapshot === "function") {
      return ajrmMarineSnapshotApi.snapshot(snapshotOptions);
    }
    const query = [
      `snapshotPreset=${encodeURIComponent(snapshotPreset)}`,
    ].join("&");
    return httpJson("GET", `${options.signalKBaseUrl}/plugins/signalk-ajrm-marine-snapshot/snapshot?${query}`);
  }

  function shouldTakeSnapshot(label) {
    if (options.captureMode === "debug") return true;
    if (options.captureMode === "voyage") return label === "start" || label === "stop";
    return false;
  }

  function buildFallbackSelfSnapshot() {
    return {
      timestamp: new Date().toISOString(),
      speedKnots,
      position: unwrapValue(app.getSelfPath?.("navigation.position")),
      courseOverGroundTrue: unwrapValue(app.getSelfPath?.("navigation.courseOverGroundTrue")),
      headingTrue: unwrapValue(app.getSelfPath?.("navigation.headingTrue")),
      notifications: unwrapValue(app.getPath?.("vessels.self.notifications")),
      ajrmMarinePiController: unwrapValue(app.getSelfPath?.("plugins.ajrmMarinePiController")),
    };
  }

  async function copyCaptureFiles(voyage, captureStop) {
    const capturesDir = ajrmMarineLoggerCapturesDir();
    const status = options.captureFileMode === "reference"
      ? await getCapturePlusStatus()
      : await waitForCapturePlusCompression(capturesDir, voyage, captureStop);
    const segments = captureSegmentsForVoyage(status, voyage, captureStop);
    voyage.captureReferences = segments.map((segment) =>
      captureReference(capturesDir, segment),
    );
    if (options.captureFileMode === "reference") {
      voyage.captureFiles = [];
      addVoyageEvent(
        "capture-referenced",
        `${segments.length} AJRM Marine Logger segment${segments.length === 1 ? "" : "s"} referenced without copying`,
      );
      if (!segments.length) addVoyageEvent("capture-copy-warning", "No CapturePlus segments matched voyage range");
      return;
    }
    const copied = [];
    const copiedNames = new Set();
    for (const segment of segments) {
      const copiedName = await copyCaptureCandidate(capturesDir, segment.fileName, voyage.directory);
      if (copiedName && !copiedNames.has(copiedName)) {
        copiedNames.add(copiedName);
        copied.push(copiedName);
        addVoyageEvent("capture-copied", copiedName);
      }
    }
    voyage.captureFiles = copied;
    if (!copied.length) addVoyageEvent("capture-copy-warning", "No CapturePlus segments matched voyage range");
  }

  function initialCaptureReferences(voyage) {
    if (voyage.captureFileMode !== "reference") return [];
    const segments = captureSegmentsForVoyage(
      { captures: [] },
      voyage,
      voyage.captureStop || null,
    );
    return segments.map((segment) => captureReference(ajrmMarineLoggerCapturesDir(), segment));
  }

  function initialCaptureReferencesFromStart(existingIndex) {
    if (!existingIndex || existingIndex.captureFileMode !== "reference") return [];
    const ajrmMarineLoggerStart = existingIndex.ajrmMarineLogger?.start || existingIndex.ajrmMarineLogger;
    const voyage = {
      startedAt: existingIndex.startedAt,
      stoppedAt: existingIndex.stoppedAt || new Date().toISOString(),
      ajrmMarineLogger: ajrmMarineLoggerStart,
    };
    return initialCaptureReferences({
      ...voyage,
      captureFileMode: "reference",
    });
  }

  function ajrmMarineLoggerCapturesDir() {
    const ajrmMarineLoggerApi = getCapturePlusApi();
    const capturePaths = ajrmMarineLoggerApi?.paths ? ajrmMarineLoggerApi.paths() : null;
    return capturePaths?.captures || path.join(options.ajrmMarineLoggerLogDirectory, "captures");
  }

  function captureReference(capturesDir, segment) {
    const fileName = String(segment?.fileName || "");
    return {
      fileName,
      sourcePath: fileName ? path.join(capturesDir, fileName) : "",
      compressedSourcePath:
        fileName && !fileName.endsWith(".gz") ? path.join(capturesDir, `${fileName}.gz`) : "",
      from: segment?.from || segment?.startedAt || null,
      to: segment?.to || segment?.modifiedAt || null,
      compressed: segment?.compressed === true || fileName.endsWith(".gz"),
      bytes: Number(segment?.bytes || segment?.size) || null,
    };
  }

  async function copyCaptureCandidate(capturesDir, fileName, voyageDirectory) {
    const candidates = fileName.endsWith(".gz")
      ? [fileName]
      : [`${fileName}.gz`, fileName];
    for (const candidate of candidates) {
      const source = path.join(capturesDir, candidate);
      const info = await fs.promises.stat(source).catch(() => null);
      if (!info?.isFile()) continue;
      const target = path.join(voyageDirectory, "capture", candidate);
      await fs.promises.copyFile(source, target);
      return candidate;
    }
    return null;
  }

  async function waitForCapturePlusCompression(capturesDir, voyage, captureStop) {
    const deadline = Date.now() + options.captureCompressionWaitSeconds * 1000;
    let status = await getCapturePlusStatus();
    while (Date.now() < deadline) {
      const segments = captureSegmentsForVoyage(status, voyage, captureStop);
      if (segments.length && segments.every((segment) => segment.compressed || segment.fileName.endsWith(".gz"))) {
        return status;
      }
      const plainWithoutGzip = segments.some((segment) =>
        !segment.compressed &&
        !segment.fileName.endsWith(".gz") &&
        !fs.existsSync(path.join(capturesDir, `${segment.fileName}.gz`)),
      );
      if (!plainWithoutGzip) return status;
      await delay(2000);
      status = await getCapturePlusStatus();
    }
    return status;
  }

  async function getCapturePlusStatus() {
    const ajrmMarineLoggerApi = getCapturePlusApi();
    if (ajrmMarineLoggerApi?.status) {
      return ajrmMarineLoggerApi.status().catch((error) => ({ ok: false, error: error.message }));
    }
    return httpJson(
      "GET",
      `${options.signalKBaseUrl}/plugins/signalk-ajrm-marine-logger/status`,
    ).catch((error) => ({ ok: false, error: error.message }));
  }

  function captureSegmentsForVoyage(status, voyage, captureStop) {
    const byName = new Map();
    const range = voyageCaptureRange(voyage);
    for (const segment of Array.isArray(status?.captures) ? status.captures : []) {
      if (!segment?.fileName) continue;
      if (captureSegmentOverlaps(segment, range)) {
        rememberCaptureSegment(byName, segment);
      }
    }
    [captureStop?.recording, voyage.ajrmMarineLogger?.recording, voyage.ajrmMarineLogger].forEach((segment) => {
      if (!segment?.fileName) return;
      if (captureSegmentOverlaps(segment, range)) rememberCaptureSegment(byName, segment);
    });
    return Array.from(byName.values()).sort((left, right) =>
      String(left.from || left.startedAt || left.fileName).localeCompare(
        String(right.from || right.startedAt || right.fileName),
      ),
    );
  }

  function rememberCaptureSegment(segmentsByKey, segment) {
    const key = logicalCaptureFileName(segment.fileName);
    const existing = segmentsByKey.get(key);
    if (!existing || shouldPreferCaptureSegment(segment, existing)) {
      segmentsByKey.set(key, segment);
    }
  }

  function logicalCaptureFileName(fileName) {
    return String(fileName || "").replace(/\.gz$/i, "");
  }

  function shouldPreferCaptureSegment(candidate, existing) {
    const candidateCompressed = candidate?.compressed === true || String(candidate?.fileName || "").endsWith(".gz");
    const existingCompressed = existing?.compressed === true || String(existing?.fileName || "").endsWith(".gz");
    if (candidateCompressed !== existingCompressed) return candidateCompressed;
    const candidateTo = Date.parse(candidate?.to || candidate?.modifiedAt || "");
    const existingTo = Date.parse(existing?.to || existing?.modifiedAt || "");
    const candidateFrom = Date.parse(candidate?.from || candidate?.startedAt || "");
    const existingFrom = Date.parse(existing?.from || existing?.startedAt || "");
    if (
      Number.isFinite(candidateFrom) &&
      Number.isFinite(existingFrom) &&
      candidateFrom !== existingFrom &&
      sameCaptureSegmentEnd(candidateTo, existingTo)
    ) {
      return candidateFrom < existingFrom;
    }
    if (Number.isFinite(candidateTo) && Number.isFinite(existingTo) && candidateTo !== existingTo) {
      return candidateTo > existingTo;
    }
    return Number(candidate?.bytes || candidate?.size || 0) > Number(existing?.bytes || existing?.size || 0);
  }

  function sameCaptureSegmentEnd(leftMs, rightMs) {
    if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) return false;
    return Math.abs(leftMs - rightMs) <= 5000;
  }

  function voyageCaptureRange(voyage) {
    const captureStart = voyage.ajrmMarineLogger?.recording?.from || voyage.startedAt;
    return {
      fromMs: Date.parse(captureStart),
      toMs: Date.parse(voyage.stoppedAt || new Date().toISOString()),
    };
  }

  function captureSegmentOverlaps(segment, range) {
    const fromMs = Date.parse(segment.from || segment.startedAt || recordingStartedAtFromFileName(segment.fileName));
    const toMs = Date.parse(segment.to || segment.modifiedAt || segment.from || segment.startedAt || "");
    if (!Number.isFinite(fromMs)) return true;
    const segmentToMs = Number.isFinite(toMs) ? toMs : fromMs;
    return segmentToMs >= range.fromMs && fromMs <= range.toMs;
  }

  async function writeVoyageIndex(voyage) {
    const files = await listFiles(voyage.directory);
    const captureIndex = await buildCaptureIndex(voyage);
    const index = {
      id: voyage.id,
      version: packageInfo.version,
      createdAt: new Date().toISOString(),
      startedAt: voyage.startedAt,
      stoppedAt: voyage.stoppedAt,
      comment: voyage.comment || "",
      startReason: voyage.reason,
      stopReason: voyage.stopReason,
      snapshotCount: voyage.snapshotCount,
      captureMode: voyage.captureMode || options.captureMode,
      captureFileMode: voyage.captureFileMode || options.captureFileMode,
      interruptedByRestart: voyage.interruptedByRestart === true,
      recoveredAt: voyage.recoveredAt || null,
      ajrmMarineLogger: {
        start: voyage.ajrmMarineLogger,
        stop: voyage.captureStop,
      },
      captureFiles: voyage.captureFiles || [],
      captureReferences: voyage.captureReferences || [],
      drTrack: voyage.drTrack || null,
      captureIndex,
      events: voyage.events,
      files,
      hints: [
        "Start with index.json.",
        "Read snapshots/start and snapshots/stop before opening large capture logs.",
        "Use snapshot timestamps and capture metadata to locate interesting intervals.",
        "Capture files may contain AJRM Marine Logger backfill followed by live records. Use captureIndex for timestamp order, overlap and duplicate guidance before scanning large logs.",
        "If captureFileMode is reference, raw AJRM Marine Logger files were not copied into the bundle; use captureReferences on this server to locate the source recordings.",
      ],
    };
    const indexPath = path.join(voyage.directory, "index.json");
    await writeJson(indexPath, index);
    return index;
  }

  async function buildCaptureIndex(voyage) {
    return buildCaptureIndexForDirectory(voyage.directory, voyage.captureFiles || []);
  }

  async function summarizeCaptureFile(filePath, fileName) {
    const summary = {
      fileName,
      error: null,
      records: 0,
      duplicateRecordsInSample: 0,
      outOfOrderRecords: 0,
      firstTimestamp: null,
      lastTimestamp: null,
      contexts: {},
      sources: {},
      paths: {},
      engineSessions: {},
      engineSequence: {},
      sampleTimeline: [],
    };
    if (!fs.existsSync(filePath)) {
      summary.error = "capture file not found";
      return summary;
    }
    const seen = new Set();
    let lastTimestampMs = null;
    const input = fs.createReadStream(filePath);
    const stream = fileName.endsWith(".gz") ? input.pipe(zlib.createGunzip()) : input;
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      summary.records += 1;
      if (seen.has(line)) summary.duplicateRecordsInSample += 1;
      else if (seen.size < 20000) seen.add(line);
      let record;
      try {
        record = JSON.parse(line);
      } catch (_error) {
        continue;
      }
      const delta = record.delta || record;
      const timestamp = recordTimestamp(record, delta);
      const timestampMs = Date.parse(timestamp);
      if (Number.isFinite(timestampMs)) {
        if (lastTimestampMs !== null && timestampMs < lastTimestampMs) {
          summary.outOfOrderRecords += 1;
        }
        lastTimestampMs = timestampMs;
        if (!summary.firstTimestamp || timestampMs < Date.parse(summary.firstTimestamp)) {
          summary.firstTimestamp = timestamp;
        }
        if (!summary.lastTimestamp || timestampMs > Date.parse(summary.lastTimestamp)) {
          summary.lastTimestamp = timestamp;
        }
        if (summary.sampleTimeline.length < 200) {
          summary.sampleTimeline.push({ timestamp, timestampMs, file: fileName, line: summary.records });
        }
      }
      increment(summary.contexts, delta.context);
      for (const update of delta.updates || []) {
        increment(summary.sources, update.$source);
        for (const value of update.values || []) {
          const valuePath = value.path;
          increment(summary.paths, valuePath);
          indexEngineProjection(summary, valuePath, value.value);
        }
      }
    }
    summary.contexts = topCounts(summary.contexts, 20);
    summary.sources = topCounts(summary.sources, 20);
    summary.paths = topCounts(summary.paths, 50);
    return summary;
  }

  function recordTimestamp(record, delta) {
    let best = Date.parse(record.capturedAt);
    let bestText = record.capturedAt || null;
    for (const update of delta.updates || []) {
      const timestamp = update.timestamp || record.capturedAt;
      const timestampMs = Date.parse(timestamp);
      if (!Number.isFinite(timestampMs)) continue;
      if (!Number.isFinite(best) || timestampMs < best) {
        best = timestampMs;
        bestText = timestamp;
      }
    }
    return bestText || null;
  }

  function increment(counts, key) {
    if (!key) return;
    counts[key] = (counts[key] || 0) + 1;
  }

  function topCounts(counts, limit) {
    return Object.fromEntries(
      Object.entries(counts)
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, limit),
    );
  }

  function engineSequenceTotal(fileSummary, field) {
    return Object.values(fileSummary.engineSequence || {}).reduce(
      (sum, sequenceSummary) => sum + Number(sequenceSummary[field] || 0),
      0,
    );
  }

  function indexEngineProjection(summary, valuePath, value) {
    if (!valuePath?.startsWith?.("plugins.ajrmMarineTraffic") || !value || typeof value !== "object") {
      return;
    }
    const sessionId = value.sessionId || "unknown";
    summary.engineSessions[sessionId] = (summary.engineSessions[sessionId] || 0) + 1;
    if (!Number.isFinite(value.sequence)) return;
    const sequenceKey = `${valuePath}:${sessionId}`;
    const generatedAtMs = Date.parse(value.generatedAt || "");
    const state = summary.engineSequence[sequenceKey] || {
      path: valuePath,
      sessionId,
      first: value.sequence,
      last: value.sequence,
      min: value.sequence,
      max: value.sequence,
      count: 0,
      fileOrderRewinds: 0,
      sequenceRegressions: 0,
      nonMonotonic: 0,
      lastGeneratedAt: value.generatedAt || null,
      lastGeneratedAtMs: Number.isFinite(generatedAtMs) ? generatedAtMs : null,
      lastSequenceInGeneratedOrder: value.sequence,
    };
    const generatedAtWentBackwards =
      Number.isFinite(generatedAtMs) &&
      Number.isFinite(state.lastGeneratedAtMs) &&
      generatedAtMs < state.lastGeneratedAtMs;
    if (generatedAtWentBackwards) {
      state.fileOrderRewinds += 1;
    } else {
      const previousSequence = Number.isFinite(state.lastSequenceInGeneratedOrder)
        ? state.lastSequenceInGeneratedOrder
        : state.last;
      if (value.sequence < previousSequence) {
        state.sequenceRegressions += 1;
      }
      if (Number.isFinite(generatedAtMs)) {
        state.lastGeneratedAt = value.generatedAt || state.lastGeneratedAt;
        state.lastGeneratedAtMs = generatedAtMs;
      }
      state.lastSequenceInGeneratedOrder = value.sequence;
    }
    state.nonMonotonic = state.sequenceRegressions;
    state.last = value.sequence;
    state.min = Math.min(state.min, value.sequence);
    state.max = Math.max(state.max, value.sequence);
    state.count += 1;
    summary.engineSequence[sequenceKey] = state;
  }

  async function bundleVoyage(voyage) {
    const zipName = `${voyage.id}.zip`;
    const zipPath = path.join(options.voyageDirectory, zipName);
    try {
      await execFile("zip", ["-qr", zipPath, "."], { cwd: voyage.directory, timeout: 120000 });
      return {
        fileName: zipName,
        path: zipPath,
        indexFile: "index.json",
        bytes: fileSize(zipPath),
        format: "zip",
      };
    } catch (error) {
      const manifestName = `${voyage.id}-bundle-error.json`;
      const manifestPath = path.join(options.voyageDirectory, manifestName);
      await writeJson(manifestPath, {
        ok: false,
        error: error.message,
        voyageDirectory: voyage.directory,
        note: "zip command failed; the uncompressed voyage directory remains available.",
      });
      return {
        fileName: manifestName,
        path: manifestPath,
        indexFile: "index.json",
        bytes: fileSize(manifestPath),
        format: "json",
        error: error.message,
      };
    }
  }

  async function callCapturePlus(route, body) {
    const ajrmMarineLoggerApi = getCapturePlusApi();
    if (ajrmMarineLoggerApi) {
      if (route === "/capture/start" && typeof ajrmMarineLoggerApi.startCapture === "function") {
        const recording = await ajrmMarineLoggerApi.startCapture(body || {});
        return { ok: true, recording };
      }
      if (route === "/capture/stop" && typeof ajrmMarineLoggerApi.stopCapture === "function") {
        const recording = await ajrmMarineLoggerApi.stopCapture("voyage capture stopped");
        return { ok: true, recording };
      }
    }
    return httpJson("POST", `${options.signalKBaseUrl}/plugins/signalk-ajrm-marine-logger${route}`, body);
  }

  async function buildStatus() {
    const ajrmMarineLoggerApi = getCapturePlusApi();
    const ajrmMarineLogger = ajrmMarineLoggerApi?.status
      ? await ajrmMarineLoggerApi.status().catch((error) => ({ ok: false, error: error.message }))
      : await httpJson(
          "GET",
          `${options.signalKBaseUrl}/plugins/signalk-ajrm-marine-logger/status`,
        ).catch((error) => ({ ok: false, error: error.message }));
    return {
      ok: true,
      plugin: plugin.id,
      version: packageInfo.version,
      timestamp: new Date().toISOString(),
      enabled: options.enabled,
      state: currentVoyage ? "recording" : options.enabled ? "watching" : "disabled",
      speedKnots,
      autoStartInhibited,
      thresholds: {
        movementSpeedKnots: options.movementSpeedKnots,
        movementSpeedMetersPerSecond: options.movementSpeedKnots / MPS_TO_KNOTS,
        alignedWithEngineStationaryAutomute: true,
        movementSeconds: options.movementSeconds,
        stoppedMinutes: options.stoppedMinutes,
        minFreeDiskGb: options.minFreeDiskGb,
      },
      captureMode: options.captureMode,
      captureFileMode: options.captureFileMode,
      currentVoyage: currentVoyage ? summarizeVoyage(currentVoyage) : null,
      voyageComment: currentVoyage ? currentVoyage.comment || "" : nextVoyageComment,
      lastBundle,
      voyages: await listVoyageBundles(),
      disk,
      ajrmMarineLogger: {
        ...ajrmMarineLogger,
        integration: ajrmMarineLoggerApi ? "in-process" : "http",
      },
      recentEvents,
    };
  }

  async function listVoyageBundles() {
    return listVoyageBundlesInDirectory(options.voyageDirectory);
  }

  function getCapturePlusApi() {
    return app.ajrmMarineLoggerApi || globalThis[AJRM_MARINE_LOGGER_API_REGISTRY] || null;
  }

  function getAiSnapshotApi() {
    return app.ajrmMarineSnapshotApi || globalThis[AJRM_MARINE_SNAPSHOT_API_REGISTRY] || null;
  }

  function publishState() {
    const values = [
      { path: "plugins.ajrmMarineCapture.version", value: packageInfo.version },
      { path: "plugins.ajrmMarineCapture.enabled", value: options.enabled },
      { path: "plugins.ajrmMarineCapture.state", value: currentVoyage ? "recording" : options.enabled ? "watching" : "disabled" },
      { path: "plugins.ajrmMarineCapture.speedKnots", value: speedKnots },
      { path: "plugins.ajrmMarineCapture.autoStartInhibited", value: autoStartInhibited },
      { path: "plugins.ajrmMarineCapture.thresholds.movementSpeedKnots", value: options.movementSpeedKnots },
      {
        path: "plugins.ajrmMarineCapture.thresholds.movementSpeedMetersPerSecond",
        value: options.movementSpeedKnots / MPS_TO_KNOTS,
      },
      { path: "plugins.ajrmMarineCapture.currentVoyage.id", value: currentVoyage?.id || null },
      { path: "plugins.ajrmMarineCapture.currentVoyage.startedAt", value: currentVoyage?.startedAt || null },
      { path: "plugins.ajrmMarineCapture.currentVoyage.comment", value: currentVoyage?.comment || null },
      { path: "plugins.ajrmMarineCapture.currentVoyage.snapshotCount", value: currentVoyage?.snapshotCount || 0 },
      { path: "plugins.ajrmMarineCapture.lastBundle.fileName", value: lastBundle?.fileName || null },
      { path: "plugins.ajrmMarineCapture.lastBundle.path", value: lastBundle?.path || null },
    ];
    if (disk) {
      values.push(
        { path: "plugins.ajrmMarineCapture.disk.availableBytes", value: disk.availableBytes },
        { path: "plugins.ajrmMarineCapture.disk.usedRatio", value: Number.isFinite(disk.usedPercent) ? disk.usedPercent / 100 : null },
      );
    }
    app.handleMessage(plugin.id, {
      context: "vessels.self",
      updates: [
        {
          source: { label: plugin.id },
          timestamp: new Date().toISOString(),
          values,
        },
      ],
    });
  }

  function publishNotification({ voyageId, leaf, message, state }) {
    const id = safePathPart(voyageId || currentVoyage?.id || "system");
    const safeLeaf = safePathPart(leaf);
    const notificationPath = `notifications.plugins.ajrmMarineCapture.${id}.${safeLeaf}`;
    const now = new Date().toISOString();
    notificationSequence += 1;
    const eventId = `watchkeeper-capture-${id}-${safeLeaf}-${notificationSequence}`;
    const subjectKey = `watchkeeper-capture:${id}:${safeLeaf}`;
    app.handleMessage(plugin.id, {
      context: "vessels.self",
      updates: [
        {
          source: { label: plugin.id },
          timestamp: now,
          values: [
            {
              path: notificationPath,
              value: {
                method: ["visual", "sound"],
                state: state || "alert",
                message,
                data: {
                  category: "voyage-capture",
                  ajrmMarineNotifications: {
                    schemaVersion: 1,
                    provider: "watchkeeper-capture",
                    providerSessionId: notificationSessionId,
                    sourceSequence: notificationSequence,
                    correlationId: randomUUID(),
                    subjectKey,
                    eventId,
                    revision: Date.parse(now),
                    lifecycle: "event",
                    timestamp: now,
                    priority: {
                      level: "information",
                      score: 100,
                    },
                    supersedes: [],
                    history: { policy: "always" },
                    delivery: {
                      visual: true,
                      audio: true,
                      preempt: false,
                      localPlayback: true,
                      streamOutput: true,
                      repeatSeconds: 0,
                      expiresSeconds: 45,
                    },
                    presentation: {
                      title: "AJRM Marine Capture",
                      label: safeLeaf,
                      message,
                      category: "voyage-capture",
                      facts: [],
                    },
                    actions: [],
                    context: {
                      voyageId: id,
                    },
                  },
                },
              },
            },
          ],
        },
      ],
    });
    setTimeout(() => {
      app.handleMessage(plugin.id, {
        context: "vessels.self",
        updates: [
          {
            source: { label: plugin.id },
            timestamp: new Date().toISOString(),
            values: [{ path: notificationPath, value: null }],
          },
        ],
      });
    }, 15000);
  }

  function summarizeVoyage(voyage) {
    return {
      id: voyage.id,
      startedAt: voyage.startedAt,
      reason: voyage.reason,
      comment: voyage.comment || "",
      snapshotCount: voyage.snapshotCount,
      captureMode: voyage.captureMode || options.captureMode,
      captureFileMode: voyage.captureFileMode || options.captureFileMode,
      directory: voyage.directory,
    };
  }

  function addVoyageEvent(type, message) {
    if (!currentVoyage) return;
    appendVoyageEvent(currentVoyage, type, message);
  }

  function appendVoyageEvent(voyage, type, message) {
    if (!voyage) return;
    voyage.events = Array.isArray(voyage.events) ? voyage.events : [];
    voyage.events.unshift({
      at: new Date().toISOString(),
      type,
      message,
    });
    voyage.events = voyage.events.slice(0, 200);
  }

  function addEvent(type, message) {
    recentEvents.unshift({
      at: new Date().toISOString(),
      type,
      message,
    });
    recentEvents.splice(50);
  }

  function inhibitAutoStartUntilStationary() {
    autoStartInhibited = true;
    movingSinceMs = null;
    stoppedSinceMs = null;
    addEvent("auto-start-inhibited", "Automatic voyage start inhibited until stationary after manual stop");
  }

  function logError(message, error) {
    const text = error && error.stack ? error.stack : error && error.message ? error.message : String(error);
    addEvent("error", `${message}: ${error?.message || error}`);
    app.error(`[${plugin.id}] ${message}: ${text}`);
  }

  function logInfo(message) {
    console.log(`[${plugin.id}] ${message}`);
  }

  function appendDrTrackSample(value, timestamp) {
    const voyage = currentVoyage;
    if (!voyage?.drTrackStream) return;
    const sample = drTrackSample(value, timestamp);
    if (!sample) return;
    const sampleKey = drTrackSampleKey(sample);
    if (sampleKey === voyage.drTrack.lastSampleKey) return;
    voyage.drTrack.lastSampleKey = sampleKey;
    voyage.drTrack.samples += 1;
    if (!voyage.drTrack.firstSampleAt) voyage.drTrack.firstSampleAt = sample.ts;
    voyage.drTrack.lastSampleAt = sample.ts;
    voyage.drTrackStream.write(`${JSON.stringify(sample)}\n`, (error) => {
      if (!error) return;
      voyage.drTrack.writeErrors += 1;
      logError("DR track write failed", error);
    });
  }

  async function closeDrTrack(voyage, stoppedAt) {
    if (!voyage?.drTrack) return;
    voyage.drTrack.stoppedAt = stoppedAt;
    delete voyage.drTrack.lastSampleKey;
    const stream = voyage.drTrackStream;
    delete voyage.drTrackStream;
    if (!stream) return;
    await new Promise((resolve) => stream.end(resolve));
  }
};

function drTrackSample(value, timestamp) {
  const state = unwrapValue(value);
  if (!state || typeof state !== "object") return null;
  const operational = drTrackPosition(state.operationalDeadReckoning || state.deadReckoning);
  const integrity = drTrackPosition(state.integrityDeadReckoning);
  const gps = drTrackPoint(state.gps?.position);
  if (!operational && !integrity && !gps) return null;
  return {
    ts: timestamp || state.timestamp || new Date().toISOString(),
    trust: state.trust || null,
    acceptedGps: state.acceptedGps === true,
    gps,
    operational,
    integrity,
    reasons: Array.isArray(state.reasons) ? state.reasons.slice(0, 5) : [],
  };
}

function drTrackPosition(track) {
  const point = drTrackPoint(track?.position);
  if (!point) return null;
  return {
    ...point,
    source: track?.source || null,
    ageSeconds: numberOrNull(track?.ageSeconds),
    uncertaintyRadiusMeters: numberOrNull(track?.uncertaintyRadiusMeters),
  };
}

function drTrackPoint(position) {
  if (!position) return null;
  const lat = Number(position.latitude);
  const lon = Number(position.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function drTrackSampleKey(sample) {
  return JSON.stringify({
    ts: sample.ts,
    trust: sample.trust,
    acceptedGps: sample.acceptedGps,
    gps: sample.gps,
    operational: sample.operational,
    integrity: sample.integrity,
  });
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function buildCaptureIndexForDirectory(bundleDirectory, captureFiles) {
  const files = [];
  const allRecords = [];
  for (const fileName of captureFiles || []) {
    const filePath = path.join(bundleDirectory, "capture", fileName);
    const summary = await summarizeCaptureFileForIndex(filePath, fileName);
    files.push(summary);
    allRecords.push(...summary.sampleTimeline);
    delete summary.sampleTimeline;
  }
  const sortedSamples = allRecords
    .sort((left, right) => left.timestampMs - right.timestampMs || left.file.localeCompare(right.file) || left.line - right.line)
    .slice(0, 200);
  return {
    schema: "watchkeeper-capture-index-v1",
    sortKey: "delta.updates[].timestamp, fallback capturedAt",
    files,
    sortedSample: sortedSamples.map(({ timestampMs, ...entry }) => entry),
    totals: {
      records: files.reduce((sum, file) => sum + file.records, 0),
      duplicateRecordsInSample: files.reduce((sum, file) => sum + file.duplicateRecordsInSample, 0),
      outOfOrderRecords: files.reduce((sum, file) => sum + file.outOfOrderRecords, 0),
      engineFileOrderRewinds: files.reduce((sum, file) => sum + engineSequenceTotalForIndex(file, "fileOrderRewinds"), 0),
      engineSequenceRegressions: files.reduce((sum, file) => sum + engineSequenceTotalForIndex(file, "sequenceRegressions"), 0),
    },
    notes: [
      "Raw capture files are preserved exactly as AJRM Marine Logger wrote them.",
      "Analyse by update timestamp rather than file order when backfill is present.",
      "Duplicate counts are based on exact repeated JSON lines within the bounded per-file sample.",
      "Engine fileOrderRewinds mean older generatedAt records appeared after newer records, usually because of backfill or overlapping logger files. engineSequenceRegressions are the count to investigate as possible Engine sequence faults.",
    ],
  };
}

async function summarizeCaptureFileForIndex(filePath, fileName) {
  const summary = {
    fileName,
    error: null,
    records: 0,
    duplicateRecordsInSample: 0,
    outOfOrderRecords: 0,
    firstTimestamp: null,
    lastTimestamp: null,
    contexts: {},
    sources: {},
    paths: {},
    engineSessions: {},
    engineSequence: {},
    sampleTimeline: [],
  };
  if (!fs.existsSync(filePath)) {
    summary.error = "capture file not found";
    return summary;
  }
  const seen = new Set();
  let lastTimestampMs = null;
  const input = fs.createReadStream(filePath);
  const stream = fileName.endsWith(".gz") ? input.pipe(zlib.createGunzip()) : input;
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    summary.records += 1;
    if (seen.has(line)) summary.duplicateRecordsInSample += 1;
    else if (seen.size < 20000) seen.add(line);
    let record;
    try {
      record = JSON.parse(line);
    } catch (_error) {
      continue;
    }
    const delta = record.delta || record;
    const timestamp = recordTimestampForIndex(record, delta);
    const timestampMs = Date.parse(timestamp);
    if (Number.isFinite(timestampMs)) {
      if (lastTimestampMs !== null && timestampMs < lastTimestampMs) {
        summary.outOfOrderRecords += 1;
      }
      lastTimestampMs = timestampMs;
      if (!summary.firstTimestamp || timestampMs < Date.parse(summary.firstTimestamp)) {
        summary.firstTimestamp = timestamp;
      }
      if (!summary.lastTimestamp || timestampMs > Date.parse(summary.lastTimestamp)) {
        summary.lastTimestamp = timestamp;
      }
      if (summary.sampleTimeline.length < 200) {
        summary.sampleTimeline.push({ timestamp, timestampMs, file: fileName, line: summary.records });
      }
    }
    incrementForIndex(summary.contexts, delta.context);
    for (const update of delta.updates || []) {
      incrementForIndex(summary.sources, update.$source);
      for (const value of update.values || []) {
        const valuePath = value.path;
        incrementForIndex(summary.paths, valuePath);
        indexEngineProjectionForIndex(summary, valuePath, value.value);
      }
    }
  }
  summary.contexts = topCountsForIndex(summary.contexts, 20);
  summary.sources = topCountsForIndex(summary.sources, 20);
  summary.paths = topCountsForIndex(summary.paths, 50);
  return summary;
}

function recordTimestampForIndex(record, delta) {
  let best = Date.parse(record.capturedAt);
  let bestText = record.capturedAt || null;
  for (const update of delta.updates || []) {
    const timestamp = update.timestamp || record.capturedAt;
    const timestampMs = Date.parse(timestamp);
    if (!Number.isFinite(timestampMs)) continue;
    if (!Number.isFinite(best) || timestampMs < best) {
      best = timestampMs;
      bestText = timestamp;
    }
  }
  return bestText || null;
}

function incrementForIndex(counts, key) {
  if (!key) return;
  counts[key] = (counts[key] || 0) + 1;
}

function topCountsForIndex(counts, limit) {
  return Object.fromEntries(
    Object.entries(counts)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, limit),
  );
}

function engineSequenceTotalForIndex(fileSummary, field) {
  return Object.values(fileSummary.engineSequence || {}).reduce(
    (sum, sequenceSummary) => sum + Number(sequenceSummary[field] || 0),
    0,
  );
}

function indexEngineProjectionForIndex(summary, valuePath, value) {
  if (!valuePath?.startsWith?.("plugins.ajrmMarineTraffic") || !value || typeof value !== "object") {
    return;
  }
  const sessionId = value.sessionId || "unknown";
  summary.engineSessions[sessionId] = (summary.engineSessions[sessionId] || 0) + 1;
  if (!Number.isFinite(value.sequence)) return;
  const sequenceKey = `${valuePath}:${sessionId}`;
  const generatedAtMs = Date.parse(value.generatedAt || "");
  const state = summary.engineSequence[sequenceKey] || {
    path: valuePath,
    sessionId,
    first: value.sequence,
    last: value.sequence,
    min: value.sequence,
    max: value.sequence,
    count: 0,
    fileOrderRewinds: 0,
    sequenceRegressions: 0,
    nonMonotonic: 0,
    lastGeneratedAt: value.generatedAt || null,
    lastGeneratedAtMs: Number.isFinite(generatedAtMs) ? generatedAtMs : null,
    lastSequenceInGeneratedOrder: value.sequence,
  };
  const generatedAtWentBackwards =
    Number.isFinite(generatedAtMs) &&
    Number.isFinite(state.lastGeneratedAtMs) &&
    generatedAtMs < state.lastGeneratedAtMs;
  if (generatedAtWentBackwards) {
    state.fileOrderRewinds += 1;
  } else {
    const previousSequence = Number.isFinite(state.lastSequenceInGeneratedOrder)
      ? state.lastSequenceInGeneratedOrder
      : state.last;
    if (value.sequence < previousSequence) {
      state.sequenceRegressions += 1;
    }
    if (Number.isFinite(generatedAtMs)) {
      state.lastGeneratedAt = value.generatedAt || state.lastGeneratedAt;
      state.lastGeneratedAtMs = generatedAtMs;
    }
    state.lastSequenceInGeneratedOrder = value.sequence;
  }
  if (value.sequence < state.last) state.nonMonotonic += 1;
  state.first = Math.min(state.first, value.sequence);
  state.last = value.sequence;
  state.min = Math.min(state.min, value.sequence);
  state.max = Math.max(state.max, value.sequence);
  state.count += 1;
  summary.engineSequence[sequenceKey] = state;
}

function httpJson(method, url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const request = transport.request(
      parsed,
      {
        method,
        rejectUnauthorized: false,
        timeout: 10000,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": String(payload.length),
            }
          : {},
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsedBody = {};
          try {
            parsedBody = text ? JSON.parse(text) : {};
          } catch {
            parsedBody = { raw: text };
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(parsedBody.error || `HTTP ${response.statusCode}`));
            return;
          }
          resolve(parsedBody);
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("request timed out")));
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function listVoyageBundlesInDirectory(directory) {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
  const result = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".zip")) continue;
    const filePath = path.join(directory, entry.name);
    const info = await fs.promises.stat(filePath).catch(() => null);
    if (!info?.isFile()) continue;
    const index = await readVoyageZipIndex(filePath);
    result.push({
      fileName: entry.name,
      bytes: info.size,
      modifiedAt: new Date(info.mtimeMs).toISOString(),
      comment: normalizeComment(index?.comment),
      startedAt: index?.startedAt || null,
      stoppedAt: index?.stoppedAt || null,
      downloadUrl: `/plugins/signalk-ajrm-marine-capture/voyages/${encodeURIComponent(entry.name)}/download`,
    });
  }
  return result.sort((left, right) => String(right.modifiedAt).localeCompare(String(left.modifiedAt)));
}

async function readVoyageZipIndex(filePath) {
  try {
    const stdout = await execFile("unzip", ["-p", filePath, "index.json"], {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (_error) {
    return null;
  }
}

async function buildPortableDownloadBundle(sourceZipPath, fileName) {
  const index = await readVoyageZipIndex(sourceZipPath);
  const references = Array.isArray(index?.captureReferences) ? index.captureReferences : [];
  if (!references.length) return null;
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "watchkeeper-voyage-download-"));
  const workDir = path.join(directory, "bundle");
  const outputPath = path.join(directory, fileName);
  await fs.promises.mkdir(workDir, { recursive: true });
  await execFile("unzip", ["-q", sourceZipPath, "-d", workDir], { timeout: 120000 });
  await fs.promises.mkdir(path.join(workDir, "capture"), { recursive: true });
  const portableIndexPath = path.join(workDir, "index.json");
  const portableIndex = await readJson(portableIndexPath) || index;
  const captureFiles = [];
  const copiedNames = new Set();
  const missingReferences = [];
  for (const reference of references) {
    const copied = await copyCaptureReferenceForDownload(reference, path.join(workDir, "capture"), copiedNames);
    if (copied) captureFiles.push(copied);
    else missingReferences.push(reference.fileName || reference.sourcePath || "unknown");
  }
  portableIndex.originalCaptureFileMode = portableIndex.captureFileMode || "reference";
  portableIndex.captureFileMode = "portable-download";
  portableIndex.captureFiles = captureFiles;
  portableIndex.captureIndex = await buildCaptureIndexForDirectory(workDir, captureFiles);
  reconcilePortableCaptureReferences(portableIndex);
  portableIndex.portableDownload = {
    createdAt: new Date().toISOString(),
    copiedCaptureFiles: captureFiles.length,
    missingReferences,
  };
  portableIndex.hints = [
    ...(Array.isArray(portableIndex.hints) ? portableIndex.hints : []),
    "This download was rebuilt on demand from a reference-mode voyage bundle. Copied raw AJRM Marine Logger files are in capture/ when they were still present on this server.",
  ];
  await writeJson(portableIndexPath, portableIndex);
  await execFile("zip", ["-qr", outputPath, "."], { cwd: workDir, timeout: 120000 });
  return { path: outputPath, directory };
}

function reconcilePortableCaptureReferences(index) {
  const summariesByLogicalName = new Map();
  for (const summary of index?.captureIndex?.files || []) {
    if (!summary?.fileName) continue;
    summariesByLogicalName.set(logicalCaptureFileNameForDownload(summary.fileName), summary);
  }
  if (!summariesByLogicalName.size || !Array.isArray(index.captureReferences)) return;
  index.captureReferences = index.captureReferences.map((reference) => {
    const summary = summariesByLogicalName.get(logicalCaptureFileNameForDownload(reference?.fileName));
    if (!summary) return reference;
    return {
      ...reference,
      from: summary.firstTimestamp || reference.from || null,
      to: summary.lastTimestamp || reference.to || null,
      records: summary.records,
    };
  });
}

async function copyCaptureReferenceForDownload(reference, captureDirectory, copiedNames) {
  const candidates = [
    reference?.sourcePath,
    reference?.compressedSourcePath,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const info = await fs.promises.stat(candidate).catch(() => null);
    if (!info?.isFile()) continue;
    const fileName = path.basename(candidate);
    if (copiedNames.has(fileName)) return fileName;
    await fs.promises.copyFile(candidate, path.join(captureDirectory, fileName));
    copiedNames.add(fileName);
    return fileName;
  }
  return null;
}

function logicalCaptureFileNameForDownload(fileName) {
  return String(fileName || "").replace(/\.gz$/i, "");
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  } catch (_error) {
    return null;
  }
}

async function countFiles(directory, extension) {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) =>
    entry.isFile() && (!extension || entry.name.endsWith(extension)),
  ).length;
}

async function listCaptureFileNames(directory) {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) =>
      entry.isFile() && /\.(jsonl|jsonl\.gz)$/i.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function readDiskStatus(pathName) {
  const stdout = await execFile("df", ["-Pk", pathName], { timeout: 5000 });
  const lines = stdout.trim().split(/\r?\n/);
  const dataLine = lines[lines.length - 1] || "";
  const parts = dataLine.trim().split(/\s+/);
  if (parts.length < 6) throw new Error(`Unexpected df output for ${pathName}`);
  const totalKb = Number(parts[1]);
  const usedKb = Number(parts[2]);
  const availableKb = Number(parts[3]);
  return {
    path: pathName,
    filesystem: parts[0],
    totalBytes: totalKb * 1024,
    usedBytes: usedKb * 1024,
    availableBytes: availableKb * 1024,
    usedPercent: Number(parts[4].replace("%", "")),
    mountedOn: parts.slice(5).join(" "),
  };
}

async function listFiles(root) {
  const result = [];
  async function walk(directory, prefix) {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, relative);
      } else if (entry.isFile()) {
        const info = await fs.promises.stat(fullPath).catch(() => null);
        result.push({
          path: relative,
          bytes: info?.size || 0,
          modifiedAt: info ? new Date(info.mtimeMs).toISOString() : null,
        });
      }
    }
  }
  await walk(root, "");
  result.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

function execFile(command, args, options) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || "").trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

async function writeJson(filePath, value) {
  await fs.promises.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}

function unwrapValue(value) {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "value")) {
    return value.value;
  }
  return value;
}

function speedKnotsFromSog(value) {
  const unwrapped = unwrapValue(value);
  if (unwrapped === null || unwrapped === undefined || unwrapped === "") return null;
  const number = Number(unwrapped);
  return Number.isFinite(number) ? Math.max(0, number * MPS_TO_KNOTS) : null;
}

function nextMovementGateState({
  speedKnots,
  movementSpeedKnots,
  now,
  movingSinceMs,
  stoppedSinceMs,
  autoStartInhibited,
}) {
  const moving = Number(speedKnots) >= Number(movementSpeedKnots);
  if (moving) {
    return {
      moving,
      movingSinceMs: autoStartInhibited ? null : movingSinceMs || now,
      stoppedSinceMs: null,
      autoStartInhibited: autoStartInhibited === true,
    };
  }
  return {
    moving,
    movingSinceMs: null,
    stoppedSinceMs: stoppedSinceMs || now,
    autoStartInhibited: false,
  };
}

function expandHome(value) {
  const text = String(value || "");
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return text;
}

function clampInt(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeComment(value) {
  return String(value == null ? "" : value)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim()
    .slice(0, 2000);
}

function formatFileTime(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function startedAtFromVoyageId(id) {
  const match = String(id || "").match(/^voyage-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
}

function recordingStartedAtFromFileName(fileName) {
  const match = String(fileName || "").match(/^capture-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  if (!match) return "";
  const [, year, month, day, hour, minute, second, ms] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${ms}Z`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeFilePart(value) {
  return String(value || "event").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "event";
}

function safePathPart(value) {
  return String(value || "event").replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "event";
}

function safeBaseName(value) {
  return path.basename(String(value || ""));
}

module.exports._private = {
  nextMovementGateState,
  speedKnotsFromSog,
};
