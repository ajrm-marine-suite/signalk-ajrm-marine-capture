const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const AdmZip = require("adm-zip");
const { ZipArchive } = require("archiver");
const yauzl = require("yauzl");
const packageInfo = require("../package.json");
const openApi = require("./openApi.json");
const {
  INPUT_CONTRACT,
  INPUT_RELATIVE_PATH,
  RECOMPUTED_OUTPUT_RELATIVE_PATH,
  REPLAY_CONTRACT,
  canonicalInputRecord,
  createReplayController,
  extractCanonicalInputDelta,
  normalizeSourcePrefixes,
} = require("./canonical-voyage");
const {
  extractCanonicalInputFromZip,
} = require("./voyage-input-zip");

const MPS_TO_KNOTS = 1.9438444924406046;
const ENGINE_STATIONARY_THRESHOLD_MPS = 0.35;
const ENGINE_STATIONARY_THRESHOLD_KNOTS =
  ENGINE_STATIONARY_THRESHOLD_MPS * MPS_TO_KNOTS;
const AJRM_MARINE_SNAPSHOT_API_REGISTRY = Symbol.for("mcdonaldajr.ajrmMarineSnapshotApi");
const AJRM_MARINE_CAPTURE_API_REGISTRY = Symbol.for("mcdonaldajr.ajrmMarineCaptureApi");
const AJRM_MARINE_DISPLAY_API_REGISTRY = Symbol.for("mcdonaldajr.ajrmMarineDisplayApi");
const CAPTURE_MODES = new Set(["minimal", "voyage", "debug"]);
const POWER_INTENT_PATH = "plugins.ajrmMarinePiController.power.intent";
const AJRM_MARINE_GPS_INTEGRITY_STATE_PATH = "plugins.ajrmMarineGpsIntegrity.navigationIntegrity";
const AJRM_MARINE_TRAFFIC_TARGETS_PATH = "plugins.ajrmMarineTraffic.targets";
const AJRM_MARINE_TRAFFIC_PROFILES_PATH = "plugins.ajrmMarineTraffic.profiles";
const AJRM_MARINE_TRAFFIC_AUTO_PROFILE_PATH = "plugins.ajrmMarineTraffic.autoProfile";
const AJRM_MARINE_TRAFFIC_VOYAGE_STATE_PATH = "plugins.ajrmMarineTraffic.voyageState";
const DR_TRACK_RELATIVE_PATH = "tracks/dr-track.jsonl";
const OBSERVATIONS_RELATIVE_PATH = "observations/observations.jsonl";
const OBSERVATION_EVIDENCE_DIRECTORY = "observations/evidence";
const PARENT_OBSERVATIONS_RELATIVE_PATH =
  "observations/parent-observations.jsonl";
const RECOMPUTED_COMPLETION_RELATIVE_PATH =
  "system/recomputed-replay-completion.json";
const MAX_OBSERVATION_TEXT_CHARACTERS = 2000;
const MAX_OBSERVATIONS_PER_VOYAGE = 1000;
const MAX_OBSERVATIONS_RETURNED = 200;
const MAX_PARENT_OBSERVATIONS_BYTES = 5 * 1024 * 1024;
const MAX_VOYAGE_INDEX_BYTES = 2 * 1024 * 1024;
const voyageBundleMetadataCache = new Map();
const voyageBundleMetadataJobs = new Map();
const CONSOLE_BITE_REPORTS_DIRECTORY = path.join(
  os.homedir(),
  ".signalk",
  "plugin-config-data",
  "signalk-ajrm-marine-console",
  "bite-reports",
);
const DEFAULT_LOG_DIRECTORY = "~/AJRMMarineLogs";
const DEFAULT_VOYAGE_DIRECTORY = `${DEFAULT_LOG_DIRECTORY}/voyages`;
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
  let sogKnots = null;
  let stwKnots = null;
  let voyageState = null;
  let movingSinceMs = null;
  let stoppedSinceMs = null;
  let autoStartInhibited = false;
  let playback = idlePlaybackStatus();
  let replayController = null;
  let replayRunPromise = null;
  let movementSuppressedUntilFreshSpeed = false;
  let navigationContext = {
    profile: null,
    nearestHarbourName: null,
  };
  let lastBundle = null;
  let disk = null;
  let stoppingVoyage = false;
  let shutdownPending = false;
  let lastPowerIntentKey = null;
  let nextVoyageComment = "";
  let notificationSequence = 0;
  let notificationSessionId = randomUUID();
  let observationWriteQueue = Promise.resolve();
  let startupRecoveryPromise = Promise.resolve();
  let startVoyagePromise = null;
  let finalisation = null;
  let lastZipProgressPublishMs = 0;
  let lastReplayStatusPublishMs = 0;
  const recentEvents = [];

  plugin.id = "signalk-ajrm-marine-capture";
  plugin.name = "AJRM Marine Capture";
  plugin.description =
    "Canonical YDEN voyage recorder, fixed-rate replay engine, indexer, and bundle dashboard.";

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
        default: DEFAULT_VOYAGE_DIRECTORY,
      },
      inputSourcePrefixes: {
        type: "array",
        title: "Canonical physical input source prefixes",
        description:
          "Only explicitly sourced updates matching these exact prefixes are replayable input. Derived plugin updates are never written to input/yden-input.jsonl.",
        default: ["YDEN"],
        items: {
          type: "string",
        },
      },
      replayMaximumLagSeconds: {
        type: "number",
        title: "Maximum replay scheduler lag seconds",
        description:
          "A fixed 1x replay fails instead of rebasing when it falls further behind its monotonic schedule.",
        default: 10,
        minimum: 1,
        maximum: 60,
      },
      movementSpeedKnots: {
        type: "number",
        title: "Movement speed threshold knots",
        description:
          "Defaults to the Traffic stationary automute threshold of 0.35 m/s, shown here as knots.",
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
      captureMode: {
        type: "string",
        title: "Voyage diagnostic mode",
        description:
          "Minimal records raw Signal K only. Voyage adds compact start/stop snapshots. Debug adds richer snapshots and periodic snapshots while underway.",
        enum: ["minimal", "voyage", "debug"],
        default: "voyage",
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
    exposeCaptureApi();
    startupRecoveryPromise = closeIncompleteVoyagesOnStartup().catch((error) => {
      logError("startup recovery failed", error);
    });
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

  plugin.stop = async () => {
    replayController?.cancel("Capture plugin stopped");
    if (deltaListener) {
      app.signalk.removeListener("delta", deltaListener);
      deltaListener = null;
    }
    clearInterval(monitorTimer);
    clearInterval(snapshotTimer);
    monitorTimer = null;
    snapshotTimer = null;
    try {
      if (currentVoyage?.recomputedReplay) {
        await abortRecomputedReplayVoyage("Capture plugin stopped");
      } else if (currentVoyage) {
        await stopVoyage("plugin stopped");
      }
    } catch (error) {
      logError("preserve active voyage during plugin stop failed", error);
    }
    if (globalThis[AJRM_MARINE_CAPTURE_API_REGISTRY]?.pluginId === plugin.id) {
      delete globalThis[AJRM_MARINE_CAPTURE_API_REGISTRY];
    }
    if (app.ajrmMarineCaptureApi?.pluginId === plugin.id) delete app.ajrmMarineCaptureApi;
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

    router.get("/voyage/observations", async (req, res) => {
      try {
        res.json(
          await observationStatus({
            limit: req.query?.limit,
          }),
        );
      } catch (error) {
        res.status(500).json({
          ok: false,
          error: "Failed to read voyage observations",
        });
      }
    });

    router.get("/voyages/:file/download", async (req, res) => {
      let download = null;
      let responseClosed = false;
      const cleanupDownload = () => {
        if (download) download.cleanup().catch(() => {});
      };
      res.once("close", () => {
        responseClosed = true;
        cleanupDownload();
      });
      try {
        download = await prepareVoyageDownload(req.params.file);
        if (responseClosed || res.destroyed) {
          await download.cleanup();
          return;
        }
        res.download(download.path, download.fileName, cleanupDownload);
      } catch (error) {
        cleanupDownload();
        if (!responseClosed && !res.destroyed && !res.headersSent) {
          res.status(404).json({ ok: false, error: "Voyage bundle not found" });
        }
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
      try {
        await setAutomaticRecordingEnabled(req.body?.enabled === true);
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

    router.post("/voyage/replay/start", async (req, res) => {
      try {
        const voyage = await startRecomputedReplayVoyage({
          file: req.body?.file,
          comment: req.body?.comment,
        });
        res.json({ ok: true, voyage });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    });

    router.post("/voyage/comment", async (req, res) => {
      try {
        const comment = normalizeComment(req.body?.comment);
        await setVoyageComment(comment);
        addEvent("comment", comment ? "Voyage comment saved" : "Voyage comment cleared");
        publishState();
        res.json({ ok: true, comment });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    });

    router.post("/voyage/observations", async (req, res) => {
      try {
        const observation = await appendObservation({
          text: req.body?.text,
          includeSnapshot: req.body?.includeSnapshot === true,
          source: req.body?.source,
        });
        res.json({
          ok: true,
          observation,
          observationLog: publicObservationLog(currentVoyage?.observations),
        });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    });

    router.post("/voyage/stop", async (_req, res) => {
      try {
        assertOrdinaryVoyageCanStop();
        const bundle = await stopVoyage("manual");
        inhibitAutoStartUntilStationary();
        res.json({ ok: true, bundle });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    });

    router.post("/voyage/replay/stop", async (_req, res) => {
      try {
        if (!currentVoyage?.recomputedReplay) {
          throw new Error("No recomputed replay voyage is active");
        }
        if (playback.state === "failed") {
          throw new Error(
            `Replay failed: ${playback.error || "unknown replay error"}. Interrupt the replay to preserve partial evidence.`,
          );
        }
        if (
          playback.state !== "complete" ||
          playback.complete !== true ||
          playback.valid !== true
        ) {
          throw new Error("Let Capture reach verified replay EOF before building the ZIP");
        }
        const bundle = await stopVoyage("recomputed replay capture stopped");
        res.json({ ok: true, bundle });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    });

    router.post("/voyage/replay/abort", async (req, res) => {
      try {
        if (!currentVoyage?.recomputedReplay) {
          throw new Error("No recomputed replay voyage is active");
        }
        const reason = normalizeComment(req.body?.reason) ||
          "user interrupted recomputed replay";
        const bundle = await abortRecomputedReplayVoyage(reason);
        res.json({ ok: true, bundle });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    });
  };

  plugin.getOpenApi = () => ({
    ...openApi,
    info: {
      ...openApi.info,
      version: packageInfo.version,
    },
  });

  return plugin;

  function normalizeOptions(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      enabled: source.enabled === true,
      voyageDirectory: expandHome(source.voyageDirectory || defaultVoyageDirectory()),
      inputSourcePrefixes: normalizeSourcePrefixes(source.inputSourcePrefixes),
      replayMaximumLagSeconds: clampNumber(
        source.replayMaximumLagSeconds,
        10,
        1,
        60,
      ),
      movementSpeedKnots: clampNumber(
        source.movementSpeedKnots,
        ENGINE_STATIONARY_THRESHOLD_KNOTS,
        0.1,
        100,
      ),
      movementSeconds: clampInt(source.movementSeconds, 20, 1, 86400),
      stoppedMinutes: clampInt(source.stoppedMinutes, 10, 1, 1440),
      captureMode: CAPTURE_MODES.has(source.captureMode) ? source.captureMode : "voyage",
      snapshotIntervalSeconds: clampInt(source.snapshotIntervalSeconds, 300, 30, 86400),
      deleteWorkingDirectoryAfterZip: source.deleteWorkingDirectoryAfterZip !== false,
      minFreeDiskGb: clampNumber(source.minFreeDiskGb, 2, 0.1, 1024),
    };
  }

  function defaultVoyageDirectory() {
    return DEFAULT_VOYAGE_DIRECTORY;
  }

  function ensureDirectories() {
    fs.mkdirSync(options.voyageDirectory, { recursive: true });
  }

  async function reportInterruptedVoyageDirectories() {
    const entries = await fs.promises.readdir(options.voyageDirectory, {
      withFileTypes: true,
    }).catch(() => []);
    const interrupted = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^voyage-\d{8}T\d{6}Z$/.test(entry.name)) {
        continue;
      }
      const zipPath = path.join(options.voyageDirectory, `${entry.name}.zip`);
      const zip = await fs.promises.stat(zipPath).catch(() => null);
      if (!zip?.isFile()) interrupted.push(entry.name);
    }
    if (interrupted.length) {
      addEvent(
        "interrupted-voyages",
        `${interrupted.length} interrupted working director${interrupted.length === 1 ? "y" : "ies"} retained for manual inspection`,
      );
    }
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
    recordCanonicalVoyageData(delta);
    const updates = Array.isArray(delta?.updates) ? delta.updates : [];
    if (handlePowerIntent(updates)) return;
    updates.forEach((update) => {
      const context = update.context || delta.context || "vessels.self";
      if (!isSelfContext(context)) return;
      (update.values || []).forEach((entry) => {
        if (entry.path === "navigation.speedOverGround") {
          if (playback.active) {
            movementSuppressedUntilFreshSpeed = true;
            return;
          }
          sogKnots = speedKnotsFromMps(entry.value);
          refreshEffectiveSpeedFromMotionSources();
          movementSuppressedUntilFreshSpeed = false;
        } else if (entry.path === "navigation.speedThroughWater") {
          stwKnots = speedKnotsFromMps(entry.value);
          refreshEffectiveSpeedFromMotionSources();
        } else if (entry.path === AJRM_MARINE_TRAFFIC_VOYAGE_STATE_PATH) {
          voyageState = normalizeVoyageState(entry.value);
        } else if (entry.path === AJRM_MARINE_GPS_INTEGRITY_STATE_PATH) {
          appendDrTrackSample(entry.value, update.timestamp || delta.timestamp || new Date().toISOString());
        } else if (entry.path === AJRM_MARINE_TRAFFIC_TARGETS_PATH) {
          updateNavigationContextFromTrafficTargets(entry.value);
        } else if (entry.path === AJRM_MARINE_TRAFFIC_PROFILES_PATH) {
          updateNavigationContextFromTrafficProfiles(entry.value);
        } else if (entry.path === AJRM_MARINE_TRAFFIC_AUTO_PROFILE_PATH) {
          updateNavigationContextFromAutoProfile(entry.value);
        }
      });
    });
  }

  function recordCanonicalVoyageData(delta) {
    const voyage = currentVoyage;
    if (!voyage || stoppingVoyage) return;
    if (voyage.recomputedReplay) {
      if (!voyage.recomputedOutputStream) return;
      const deltaSource = String(delta?.$source || delta?.source?.label || "");
      const updates = Array.isArray(delta?.updates) ? delta.updates : [];
      const captureOwned = updates.length > 0
        ? updates.every((update) =>
            String(update?.$source || update?.source?.label || "") === plugin.id,
          )
        : deltaSource === plugin.id;
      if (captureOwned) return;
      const capturedAt = new Date().toISOString();
      writeVoyageStreamRecord(
        voyage,
        "recomputedOutput",
        voyage.recomputedOutputStream,
        {
          contract: "ajrm-marine-recomputed-output-v1",
          schemaVersion: 1,
          elapsedMs: Math.max(
            0,
            Math.round(performance.now() - voyage.monotonicStartedAtMs),
          ),
          capturedAt,
          replaySourceElapsedMs: playback.sourceElapsedMs || 0,
          delta,
        },
      );
      return;
    }
    if (!voyage.canonicalInputStream) return;
    const inputDelta = extractCanonicalInputDelta(
      delta,
      options.inputSourcePrefixes,
    );
    if (!inputDelta) return;
    const elapsedMs = Math.max(
      voyage.lastCanonicalElapsedMs || 0,
      Math.round(performance.now() - voyage.monotonicStartedAtMs),
    );
    voyage.lastCanonicalElapsedMs = elapsedMs;
    writeVoyageStreamRecord(
      voyage,
      "canonicalInput",
      voyage.canonicalInputStream,
      canonicalInputRecord({
        delta: inputDelta,
        elapsedMs,
      }),
    );
  }

  function writeVoyageStreamRecord(voyage, field, stream, record) {
    try {
      const line = `${JSON.stringify(record)}\n`;
      const state = voyage[field];
      state.records += 1;
      state.bytes += Buffer.byteLength(line);
      state.lastElapsedMs = Number(record.elapsedMs) || 0;
      if (!state.firstCapturedAt) state.firstCapturedAt = record.capturedAt || null;
      state.lastCapturedAt = record.capturedAt || state.lastCapturedAt || null;
      stream.write(line, (error) => {
        if (!error) return;
        state.writeErrors += 1;
        logError(`${field} write failed`, error);
      });
    } catch (error) {
      voyage[field].writeErrors += 1;
      logError(`${field} serialization failed`, error);
    }
  }

  function refreshNavigationContextFromSelfPath() {
    updateNavigationContextFromTrafficTargets(app.getSelfPath?.(AJRM_MARINE_TRAFFIC_TARGETS_PATH));
    updateNavigationContextFromTrafficProfiles(app.getSelfPath?.(AJRM_MARINE_TRAFFIC_PROFILES_PATH));
    updateNavigationContextFromAutoProfile(app.getSelfPath?.(AJRM_MARINE_TRAFFIC_AUTO_PROFILE_PATH));
  }

  function updateNavigationContextFromTrafficTargets(value) {
    const targets = unwrapValue(value);
    const profile = normalizeTrafficProfile(targets?.profile);
    if (profile) setNavigationProfile(profile);
  }

  function updateNavigationContextFromTrafficProfiles(value) {
    const profiles = unwrapValue(value);
    const profile = normalizeTrafficProfile(profiles?.current);
    if (profile) setNavigationProfile(profile);
  }

  function updateNavigationContextFromAutoProfile(value) {
    const autoProfile = unwrapValue(value);
    const profile = normalizeTrafficProfile(autoProfile?.profile);
    if (profile) setNavigationProfile(profile);
    const contextProfile = profile || navigationContext.profile;
    const harbourName = cleanHarbourName(
      autoProfile?.insideRegionName ||
        (contextProfile === "harbor" ? autoProfile?.nearestRegionName : ""),
    );
    navigationContext.nearestHarbourName = harbourName || null;
  }

  function setNavigationProfile(profile) {
    navigationContext.profile = profile;
    if (profile !== "harbor") navigationContext.nearestHarbourName = null;
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
      voyageState,
      movementSpeedKnots: options.movementSpeedKnots,
      now,
      movingSinceMs,
      stoppedSinceMs,
      autoStartInhibited,
      movementSuppressed: playback.active || movementSuppressedUntilFreshSpeed,
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
      !currentVoyage.recomputedReplay &&
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
    if (playback.active || movementSuppressedUntilFreshSpeed) return;
    sogKnots = speedKnotsFromMps(app.getSelfPath("navigation.speedOverGround"));
    stwKnots = speedKnotsFromMps(app.getSelfPath("navigation.speedThroughWater"));
    voyageState = normalizeVoyageState(app.getSelfPath(AJRM_MARINE_TRAFFIC_VOYAGE_STATE_PATH)) || voyageState;
    refreshEffectiveSpeedFromMotionSources();
  }

  function refreshEffectiveSpeedFromMotionSources() {
    speedKnots = maxFinite(sogKnots, stwKnots);
  }

  function exposeCaptureApi() {
    const api = {
      pluginId: plugin.id,
      version: packageInfo.version,
      async status() {
        return buildStatus();
      },
      async setAutomaticRecordingEnabled(enabled) {
        await setAutomaticRecordingEnabled(enabled);
        return buildStatus();
      },
      async start({ comment, reason = "BITE run all" } = {}) {
        if (comment !== undefined) await setVoyageComment(comment);
        return startVoyage(reason);
      },
      async startRecomputedReplay({ file, comment } = {}) {
        return startRecomputedReplayVoyage({ file, comment });
      },
      async stop({ reason = "BITE run all complete" } = {}) {
        assertOrdinaryVoyageCanStop();
        return stopVoyage(reason);
      },
      async appendObservation({
        text,
        includeSnapshot = false,
        source = "display",
      } = {}) {
        return appendObservation({ text, includeSnapshot, source });
      },
      async observations({ limit = MAX_OBSERVATIONS_RETURNED } = {}) {
        return observationStatus({ limit });
      },
      async recordRouteSelection(selection) {
        return recordRouteSelection(selection);
      },
      async prepareVoyageDownload(fileName) {
        return prepareVoyageDownload(fileName);
      },
    };
    app.ajrmMarineCaptureApi = api;
    globalThis[AJRM_MARINE_CAPTURE_API_REGISTRY] = api;
  }

  async function prepareVoyageDownload(fileNameValue) {
    const fileName = safeBaseName(fileNameValue);
    const filePath = path.join(options.voyageDirectory, fileName);
    const info = await fs.promises.stat(filePath);
    if (!info.isFile() || !fileName.endsWith(".zip")) {
      throw new Error("Voyage bundle not found");
    }
    return {
      fileName,
      path: filePath,
      temporaryBundle: null,
      async cleanup() {},
    };
  }

  async function setAutomaticRecordingEnabled(enabled) {
    const nextEnabled = enabled === true;
    await persistPluginConfiguration({ enabled: nextEnabled });
    options.enabled = nextEnabled;
    addEvent("settings", `Automatic voyage recording ${options.enabled ? "enabled" : "disabled"}`);
    publishState();
  }

  async function startRecomputedReplayVoyage({ file, comment } = {}) {
    if (currentVoyage) return summarizeVoyage(currentVoyage);
    const parentVoyage = safeBaseName(file);
    if (!parentVoyage || !parentVoyage.endsWith(".zip")) {
      throw new Error("Select a canonical AJRM Marine voyage ZIP to replay");
    }
    const parentVoyagePath = path.join(options.voyageDirectory, parentVoyage);
    const parentInfo = await fs.promises.stat(parentVoyagePath).catch(() => null);
    if (!parentInfo?.isFile()) throw new Error("Parent voyage ZIP was not found");
    const parentIndex = await readVoyageZipIndex(parentVoyagePath);
    if (parentIndex?.canonicalInput?.contract !== INPUT_CONTRACT) {
      throw new Error(
        `Parent voyage does not declare the required ${INPUT_CONTRACT} contract`,
      );
    }
    const recomputedReplay = {
      schemaVersion: 2,
      kind: "recomputed-replay",
      parentVoyage,
      parentVoyagePath,
      playbackMode: "canonical-input",
      rate: 1,
      inputContract: INPUT_CONTRACT,
      replayContract: REPLAY_CONTRACT,
      originalFrom: parentIndex.startedAt || null,
      originalTo: parentIndex.stoppedAt || null,
      originalVoyageStartedAt: parentIndex.startedAt || null,
      timingRequired: true,
      sourceRouteTimeline: {
        routeAtStart: parentIndex.routeAtStart || null,
        selections: Array.isArray(parentIndex.routeSelections)
          ? parentIndex.routeSelections
          : [],
        selectedRoute: parentIndex.selectedRoute || null,
      },
    };
    const replayComment = normalizeComment(comment) ||
      `Recomputed replay of ${parentVoyage}`;
    return startVoyage("recomputed replay", {
      comment: replayComment,
      recomputedReplay,
    });
  }

  function assertOrdinaryVoyageCanStop() {
    if (currentVoyage?.recomputedReplay) {
      throw new Error(
        "Recomputed replay finalises automatically at verified EOF; use Finalise now only as a fallback",
      );
    }
  }

  async function startVoyage(reason, startOptions = {}) {
    await startupRecoveryPromise;
    if (startVoyagePromise) return startVoyagePromise;
    if (currentVoyage) return summarizeVoyage(currentVoyage);
    const startOperation = performVoyageStart(reason, startOptions);
    startVoyagePromise = startOperation;
    try {
      return await startOperation;
    } finally {
      if (startVoyagePromise === startOperation) {
        startVoyagePromise = null;
      }
    }
  }

  async function performVoyageStart(reason, startOptions) {
    if (playback.active && !startOptions.recomputedReplay) {
      throw new Error("A recomputed replay is already active");
    }
    ensureDirectories();
    refreshNavigationContextFromSelfPath();
    const startedAt = new Date();
    const comment = normalizeComment(startOptions.comment)
      || normalizeComment(nextVoyageComment)
      || defaultVoyageComment({
        startedAt,
        profile: navigationContext.profile,
        harbourName: navigationContext.nearestHarbourName,
      });
    const routeReplay = startOptions.recomputedReplay?.sourceRouteTimeline || null;
    let routeRestore = null;
    if (routeReplay) {
      routeRestore = await restoreDisplayRoute(routeReplay.routeAtStart || null);
    }
    const routeAtStart = routeReplay
      ? sanitizeRouteSelection(routeReplay.routeAtStart)
      : await currentDisplayRoute();
    const id = `voyage-${formatFileTime(startedAt)}`;
    const directory = path.join(options.voyageDirectory, id);
    await fs.promises.mkdir(path.join(directory, "snapshots"), { recursive: true });
    await fs.promises.mkdir(path.join(directory, "input"), { recursive: true });
    await fs.promises.mkdir(path.join(directory, "recomputed"), { recursive: true });
    await fs.promises.mkdir(path.join(directory, "system"), { recursive: true });
    await fs.promises.mkdir(path.join(directory, "tracks"), { recursive: true });
    await fs.promises.mkdir(
      path.join(directory, OBSERVATION_EVIDENCE_DIRECTORY),
      { recursive: true },
    );

    const movementGate = resetMovementGateForVoyageStart();
    movingSinceMs = movementGate.movingSinceMs;
    stoppedSinceMs = movementGate.stoppedSinceMs;
    autoStartInhibited = movementGate.autoStartInhibited;

    currentVoyage = {
      id,
      directory,
      startedAt: startedAt.toISOString(),
      reason,
      comment,
      ownContext: normalizeOwnContext(app.selfId || app.selfContext || app.self),
      snapshotCount: 0,
      captureMode: startOptions.recomputedReplay ? "voyage" : options.captureMode,
      recomputedReplay: startOptions.recomputedReplay || null,
      monotonicStartedAtMs: performance.now(),
      lastCanonicalElapsedMs: 0,
      canonicalInput: startOptions.recomputedReplay
        ? null
        : {
            contract: INPUT_CONTRACT,
            schemaVersion: 1,
            fileName: INPUT_RELATIVE_PATH,
            sourcePrefixes: options.inputSourcePrefixes,
            records: 0,
            bytes: 0,
            lastElapsedMs: 0,
            writeErrors: 0,
          },
      recomputedOutput: startOptions.recomputedReplay
        ? {
            contract: "ajrm-marine-recomputed-output-v1",
            schemaVersion: 1,
            fileName: RECOMPUTED_OUTPUT_RELATIVE_PATH,
            records: 0,
            bytes: 0,
            lastElapsedMs: 0,
            writeErrors: 0,
          }
        : null,
      events: [],
      routeAtStart,
      selectedRoute: routeAtStart,
      routeSelections: routeAtStart
        ? [{
            at: startedAt.toISOString(),
            voyageElapsedMs: 0,
            action: "active-at-start",
            selection: routeAtStart,
          }]
        : [],
      routeReplay: routeReplay
        ? {
            nextIndex: 0,
            selections: normalizeRouteTimeline(routeReplay.selections),
            initialRestore: routeRestore,
          }
        : null,
      observations: createObservationLog(),
      drTrack: {
        fileName: DR_TRACK_RELATIVE_PATH,
        samples: 0,
        writeErrors: 0,
        startedAt: startedAt.toISOString(),
        stoppedAt: null,
      },
    };
    if (currentVoyage.recomputedReplay) {
      await copyParentObservations(currentVoyage);
    }
    currentVoyage.drTrackStream = fs.createWriteStream(path.join(directory, DR_TRACK_RELATIVE_PATH), {
      flags: "a",
    });
    if (currentVoyage.recomputedReplay) {
      currentVoyage.recomputedOutputStream = fs.createWriteStream(
        path.join(directory, RECOMPUTED_OUTPUT_RELATIVE_PATH),
        { flags: "a" },
      );
    } else {
      currentVoyage.canonicalInputStream = fs.createWriteStream(
        path.join(directory, INPUT_RELATIVE_PATH),
        { flags: "a" },
      );
    }
    nextVoyageComment = "";
    addVoyageEvent("start", reason);
    publishNotification({
      voyageId: id,
      leaf: "start",
      message: "Voyage recording started.",
      state: "alert",
    });
    addEvent("voyage-started", `${id}: ${reason}`);

    if (currentVoyage.recomputedReplay) {
      try {
        await startCanonicalReplay(currentVoyage);
      } catch (error) {
        replayController?.cancel("Replay startup failed");
        replayController = null;
        replayRunPromise = null;
        await closeCanonicalVoyageStreams(currentVoyage).catch(() => {});
        if (currentVoyage.drTrackStream) {
          const stream = currentVoyage.drTrackStream;
          delete currentVoyage.drTrackStream;
          await new Promise((resolve) => stream.end(resolve)).catch(() => {});
        }
        await cleanupReplayWork(currentVoyage);
        await fs.promises.rm(directory, { recursive: true, force: true });
        currentVoyage = null;
        playback = idlePlaybackStatus();
        publishState();
        throw error;
      }
      currentVoyage.recomputedReplay = {
        ...currentVoyage.recomputedReplay,
        playbackStartedAutomatically: true,
        playbackStartedAt: new Date().toISOString(),
      };
      addVoyageEvent(
        "replay-started",
        "Capture canonical-input replay started automatically at fixed 1x",
      );
      addEvent(
        "replay-started",
        `${currentVoyage.id}: canonical-input replay started automatically at fixed 1x`,
      );
    }
    await writeJson(path.join(directory, "system", "start-status.json"), await buildStatus());
    if (shouldTakeSnapshot("start")) await takeSnapshot("start");
    await writeVoyageIndex(currentVoyage);
    publishState();
    return summarizeVoyage(currentVoyage);
  }

  async function startCanonicalReplay(voyage) {
    const replayWorkDirectory = path.join(
      options.voyageDirectory,
      ".replay-work",
    );
    await fs.promises.mkdir(replayWorkDirectory, { recursive: true });
    const replayInputPath = path.join(
      replayWorkDirectory,
      `${voyage.id}-${randomUUID()}.jsonl`,
    );
    const parentVoyagePath = voyage.recomputedReplay.parentVoyagePath;
    await extractCanonicalInputFromZip(parentVoyagePath, replayInputPath);
    voyage.replayInputPath = replayInputPath;
    delete voyage.recomputedReplay.parentVoyagePath;
    playback = {
      ...idlePlaybackStatus(),
      state: "preparing",
      fileName: voyage.recomputedReplay.parentVoyage,
      inputContract: INPUT_CONTRACT,
      replayContract: REPLAY_CONTRACT,
    };
    movementSuppressedUntilFreshSpeed = true;
    movingSinceMs = null;
    voyage.replayWarmupActive = true;
    const playbackWithVoyageMetadata = (status) => {
      const originalFromMs = Date.parse(
        voyage.recomputedReplay.originalFrom || "",
      );
      const replayOriginalAt = Number.isFinite(originalFromMs)
        ? new Date(
            originalFromMs + Number(status.sourceElapsedMs || 0),
          ).toISOString()
        : null;
      return {
        ...status,
        playing: status.active === true,
        warmupActive:
          status.active === true && voyage.replayWarmupActive === true,
        rate: 1,
        replayOriginalAt,
        fileName: voyage.recomputedReplay.parentVoyage,
        inputContract: INPUT_CONTRACT,
        replayContract: REPLAY_CONTRACT,
      };
    };
    replayController = createReplayController({
      filePath: replayInputPath,
      maximumLagMs: options.replayMaximumLagSeconds * 1000,
      emitDelta(delta) {
        app.handleMessage(plugin.id, delta);
        if (
          (delta.updates || []).some((update) =>
            (update.values || []).some(
              (entry) =>
                entry.path === "navigation.position" &&
                entry.value &&
                Number.isFinite(Number(entry.value.latitude)) &&
                Number.isFinite(Number(entry.value.longitude)),
            ),
          )
        ) {
          voyage.replayWarmupActive = false;
        }
      },
      onStatus(nextStatus) {
        playback = playbackWithVoyageMetadata(nextStatus);
        voyage.recomputedReplay.timing = playback;
        applyReplayRouteTimeline(voyage, playback);
        const now = Date.now();
        if (
          playback.state === "complete" ||
          playback.state === "failed" ||
          playback.state === "aborted" ||
          now - lastReplayStatusPublishMs >= 500
        ) {
          lastReplayStatusPublishMs = now;
          publishState();
        }
      },
    });
    replayRunPromise = replayController.run()
      .then((result) => {
        playback = playbackWithVoyageMetadata(result);
        voyage.recomputedReplay.timing = playback;
        if (result.valid === true) {
          addVoyageEvent(
            "replay-eof",
            `Canonical input reached EOF at ${result.effectiveRatio}x effective rate`,
          );
          addEvent(
            "replay-eof",
            `${voyage.id}: canonical input reached verified EOF`,
          );
        }
        publishState();
        return result;
      })
      .catch((error) => {
        addVoyageEvent("replay-failed", error.message);
        addEvent("replay-failed", `${voyage.id}: ${error.message}`);
        logError("canonical replay failed", error);
        publishState();
        return playback;
      })
      .finally(() => {
        replayController = null;
        if (
          currentVoyage === voyage &&
          playback.state === "complete" &&
          playback.complete === true &&
          playback.valid === true
        ) {
          setImmediate(() => {
            if (currentVoyage !== voyage || stoppingVoyage) return;
            stopVoyage("verified replay EOF")
              .catch((error) => logError("automatic replay finalisation failed", error));
          });
        }
      });
  }

  async function closeCanonicalVoyageStreams(voyage) {
    const streams = [
      ["canonicalInputStream", "canonicalInput"],
      ["recomputedOutputStream", "recomputedOutput"],
    ];
    for (const [streamField, statusField] of streams) {
      const stream = voyage?.[streamField];
      if (voyage) delete voyage[streamField];
      if (!stream) continue;
      await new Promise((resolve, reject) => {
        stream.once("error", reject);
        stream.end(resolve);
      });
      if (voyage[statusField]) {
        voyage[statusField].closedAt = new Date().toISOString();
        voyage[statusField].complete =
          voyage[statusField].writeErrors === 0;
      }
    }
  }

  async function cleanupReplayWork(voyage) {
    if (!voyage?.replayInputPath) return;
    await fs.promises.unlink(voyage.replayInputPath).catch(() => {});
    delete voyage.replayInputPath;
  }

  async function setVoyageComment(value) {
    const comment = normalizeComment(value);
    if (currentVoyage) {
      if (currentVoyage.comment === comment) return comment;
      currentVoyage.comment = comment;
      addVoyageEvent("comment", comment ? "Voyage comment updated" : "Voyage comment cleared");
      await writeVoyageIndex(currentVoyage);
    } else {
      nextVoyageComment = comment;
    }
    return comment;
  }

  async function stopVoyage(reason) {
    if (!currentVoyage) return lastBundle;
    if (stoppingVoyage) return lastBundle;
    stoppingVoyage = true;
    const voyage = currentVoyage;
    beginFinalisation(voyage);
    try {
      await observationWriteQueue;
      addVoyageEvent("stop", reason);
      addEvent("voyage-stopping", `${voyage.id}: ${reason}`);
      if (shouldTakeSnapshot("stop")) await takeSnapshot("stop");
      updateFinalisation("closing-streams", {
        message: "Closing canonical voyage streams",
      });
      if (voyage.recomputedReplay && replayRunPromise) {
        await replayRunPromise;
      }
      if (voyage.routeReplayQueue) {
        await voyage.routeReplayQueue;
      }
      await closeCanonicalVoyageStreams(voyage);
      const captureStop = {
        ok: true,
        recording: voyage.recomputedReplay
          ? voyage.recomputedOutput
          : voyage.canonicalInput,
      };
      voyage.captureStop = captureStop;
      finalisation.streamsClosed = true;
      finalisation.streamsClosedAt = new Date().toISOString();
      if (voyage.recomputedReplay) {
        const replayResult = {
          contract: REPLAY_CONTRACT,
          schemaVersion: 1,
          rate: 1,
          inputContract: INPUT_CONTRACT,
          timing: { ...playback },
          coverage: {
            complete: playback.complete === true,
            preparedComplete: true,
            lastReason:
              playback.state === "complete" ? "end of canonical input" : playback.state,
            recordsTotal: playback.recordsTotal,
            recordsReplayed: playback.recordsReplayed,
          },
          output: voyage.recomputedOutput,
        };
        if (
          playback.state !== "complete" ||
          playback.complete !== true ||
          playback.valid !== true ||
          voyage.recomputedOutput?.complete !== true
        ) {
          throw new Error(
            "Capture did not confirm verified replay EOF and a closed recomputed output",
          );
        }
        const verification = recomputedReplayVerification(
          voyage.recomputedReplay,
          replayResult,
        );
        voyage.recomputedReplay = {
          ...voyage.recomputedReplay,
          status: "complete",
          complete: true,
          incomplete: false,
          verified: verification.verified,
          verificationFailure: verification.failure,
          rate: 1,
          completedAt: new Date().toISOString(),
          result: replayResult,
        };
        voyage.incomplete = false;
        voyage.recomputationVerified = verification.verified;
        voyage.aborted = false;
        await writeRecomputedCompletionCheckpoint(voyage, replayResult, {
          verified: verification.verified,
          verificationFailure: verification.failure,
        });
      }
      const stoppedAt = new Date().toISOString();
      voyage.stoppedAt = stoppedAt;
      voyage.stopReason = reason;
      updateFinalisation("collecting-evidence", {
        message: "Collecting voyage evidence",
      });
      await closeDrTrack(voyage, stoppedAt);
      await copyConsoleBiteReports(voyage);
      await cleanupReplayWork(voyage);
      updateFinalisation("indexing", {
        message: "Building voyage indexes",
      });
      const index = await writeVoyageIndex(voyage);
      updateFinalisation("building-zip", {
        message: "Building disk-backed voyage ZIP",
      });
      if (
        typeof app.ajrmMarineCaptureTestHooks?.beforeZipBuild ===
        "function"
      ) {
        await app.ajrmMarineCaptureTestHooks.beforeZipBuild({
          voyageId: voyage.id,
        });
      }
      const bundle = await bundleVoyage(voyage, index);
      if (voyage.recomputedReplay && bundle?.format !== "zip") {
        throw new Error(
          bundle?.error || "The recomputed voyage could not be packaged as a ZIP",
        );
      }
      if (bundle?.format === "zip" && options.deleteWorkingDirectoryAfterZip) {
        await fs.promises.rm(voyage.directory, { recursive: true, force: true });
        bundle.workingDirectoryDeleted = true;
      }
      currentVoyage = null;
      lastBundle = bundle;
      finishFinalisation(bundle);
      publishNotification({
        voyageId: voyage.id,
        leaf: "stop",
        message: "Voyage recording stopped and diagnostic bundle prepared.",
        state: "alert",
      });
      addEvent("voyage-stopped", `${voyage.id}: ${reason}`);
      publishState();
      return bundle;
    } catch (error) {
      failFinalisation(error);
      throw error;
    } finally {
      stoppingVoyage = false;
    }
  }

  function beginFinalisation(voyage) {
    const now = new Date().toISOString();
    finalisation = {
      contract: "ajrm-marine-capture-finalisation",
      contractVersion: 1,
      voyageId: voyage.id,
      recomputedReplay: Boolean(voyage.recomputedReplay),
      state: "running",
      phase: "preparing",
      message: "Preparing voyage finalisation",
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      streamsClosed: false,
      streamsClosedAt: null,
      recomputationVerified: false,
      zip: null,
      bundle: null,
      error: null,
    };
    publishState();
  }

  function updateFinalisation(phase, changes = {}) {
    if (!finalisation) return;
    finalisation = {
      ...finalisation,
      ...changes,
      phase,
      updatedAt: new Date().toISOString(),
    };
    publishState();
  }

  function finishFinalisation(bundle) {
    if (!finalisation) return;
    const now = new Date().toISOString();
    finalisation = {
      ...finalisation,
      state: "complete",
      phase: "complete",
      message: "Voyage ZIP complete",
      updatedAt: now,
      completedAt: now,
      bundle: bundle
        ? {
            fileName: bundle.fileName,
            bytes: bundle.bytes,
            format: bundle.format,
          }
        : null,
      error: null,
    };
    publishState();
  }

  function failFinalisation(error) {
    if (!finalisation) return;
    finalisation = {
      ...finalisation,
      state: "failed",
      phase: "failed",
      message: "Voyage finalisation failed",
      updatedAt: new Date().toISOString(),
      error: boundedErrorMessage(error),
    };
    publishState();
  }

  async function writeRecomputedCompletionCheckpoint(
    voyage,
    replayResult,
    {
      completedAt = new Date().toISOString(),
      verified = true,
      verificationFailure = null,
    } = {},
  ) {
    const checkpoint = {
      contract: "ajrm-marine-recomputed-completion",
      contractVersion: 1,
      voyageId: voyage.id,
      completedAt,
      completionConfirmed: true,
      verified: verified === true,
      recomputationVerified: verified === true,
      verificationFailure,
      recomputedReplay: {
        ...voyage.recomputedReplay,
        result: replayResult,
      },
      replayResult,
    };
    await writeJson(
      path.join(voyage.directory, RECOMPUTED_COMPLETION_RELATIVE_PATH),
      checkpoint,
    );
    finalisation.recomputationVerified = verified === true;
    finalisation.checkpoint = RECOMPUTED_COMPLETION_RELATIVE_PATH;
    updateFinalisation("streams-closed", {
      message: verified
        ? "Capture streams closed; verified recomputation checkpoint saved"
        : "Capture streams closed; unverified recomputation checkpoint saved",
    });
  }

  async function abortRecomputedReplayVoyage(reason) {
    if (!currentVoyage?.recomputedReplay) {
      throw new Error("No recomputed replay voyage is active");
    }
    if (stoppingVoyage) {
      throw new Error("Voyage finalisation is already in progress");
    }
    stoppingVoyage = true;
    const voyage = currentVoyage;
    try {
      await observationWriteQueue;
      addVoyageEvent("replay-abort", reason);
      addEvent("voyage-aborting", `${voyage.id}: ${reason}`);
      if (shouldTakeSnapshot("stop")) await takeSnapshot("stop");
      replayController?.cancel(reason);
      if (replayRunPromise) await replayRunPromise;
      await closeCanonicalVoyageStreams(voyage);
      const captureStop = {
        ok: true,
        recording: voyage.recomputedOutput,
      };
      voyage.captureStop = captureStop;

      const stoppedAt = new Date().toISOString();
      const replayResult = markReplayResultIncomplete(
        {
          contract: REPLAY_CONTRACT,
          schemaVersion: 1,
          timing: { ...playback },
          coverage: {
            complete: false,
            recordsTotal: playback.recordsTotal,
            recordsReplayed: playback.recordsReplayed,
            lastReason: playback.state,
          },
          output: voyage.recomputedOutput,
        },
        {
          aborted: true,
          abortReason: reason,
          interruptedByRestart: false,
        },
      );
      voyage.stoppedAt = stoppedAt;
      voyage.stopReason = `Recomputed replay interrupted: ${reason}`;
      voyage.incomplete = true;
      voyage.recomputationVerified = false;
      voyage.aborted = true;
      voyage.recomputedReplay = {
        ...voyage.recomputedReplay,
        status: "incomplete",
        complete: false,
        incomplete: true,
        verified: false,
        aborted: true,
        abortReason: reason,
        abortedAt: stoppedAt,
        result: replayResult,
      };
      await closeDrTrack(voyage, stoppedAt);
      await copyConsoleBiteReports(voyage);
      await cleanupReplayWork(voyage);
      await writeJson(
        path.join(voyage.directory, "system", "replay-abort-status.json"),
        {
          ok: true,
          abortedAt: stoppedAt,
          reason,
          incomplete: true,
          verified: false,
          output: voyage.recomputedOutput,
          note:
            "This ZIP preserves partial evidence only and is not a completed recomputation result.",
        },
      );
      const index = await writeVoyageIndex(voyage);
      const bundle = await bundleVoyage(voyage, index);
      if (bundle?.format !== "zip") {
        throw new Error(
          bundle?.error ||
          "The incomplete recomputed voyage could not be packaged as a ZIP",
        );
      }
      if (options.deleteWorkingDirectoryAfterZip) {
        await fs.promises.rm(voyage.directory, {
          recursive: true,
          force: true,
        });
        bundle.workingDirectoryDeleted = true;
      }
      currentVoyage = null;
      lastBundle = bundle;
      publishNotification({
        voyageId: voyage.id,
        leaf: "abort",
        message:
          "Recomputed replay interrupted. Partial evidence was saved in an incomplete, unverified voyage ZIP.",
        state: "alert",
      });
      addEvent("voyage-aborted", `${voyage.id}: incomplete ZIP prepared`);
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
    await fs.promises.mkdir(
      path.join(directory, OBSERVATION_EVIDENCE_DIRECTORY),
      { recursive: true },
    );
    const existingIndex = await readJson(path.join(directory, "index.json"));
    const completionCheckpoint = await readJson(
      path.join(directory, RECOMPUTED_COMPLETION_RELATIVE_PATH),
    );
    const completedRecomputation = await completedRecomputedCompletion(
      id,
      directory,
      completionCheckpoint,
      existingIndex,
    );
    const canonicalInput = existingIndex?.recomputedReplay
      ? existingIndex?.canonicalInput || null
      : await recoverCanonicalInputState(directory, existingIndex?.canonicalInput);
    const voyage = {
      id,
      directory,
      startedAt: existingIndex?.startedAt || startedAtFromVoyageId(id) || now,
      stoppedAt: existingIndex?.recomputedReplay
        ? now
        : canonicalInput?.lastCapturedAt || now,
      reason: existingIndex?.startReason || "recovered incomplete voyage",
      stopReason: "Signal K restarted before AJRM Marine Capture stopped this voyage",
      comment: normalizeComment(existingIndex?.comment),
      ownContext:
        normalizeOwnContext(existingIndex?.ownContext) ||
        normalizeOwnContext(app.selfId || app.selfContext || app.self),
      snapshotCount: await countFiles(path.join(directory, "snapshots"), ".json"),
      captureMode: CAPTURE_MODES.has(existingIndex?.captureMode)
        ? existingIndex.captureMode
        : options.captureMode,
      recomputedReplay: existingIndex?.recomputedReplay || null,
      canonicalInput,
      recomputedOutput:
        completedRecomputation?.result?.output ||
        existingIndex?.recomputedOutput ||
        null,
      captureStop: completedRecomputation
        ? {
            ok: true,
            recoveredFromCompletionCheckpoint: true,
            recoveredAt: now,
            recording: {
              replayResult: completedRecomputation.result,
            },
          }
        : {
            ok: false,
            interruptedByRestart: true,
            error: "Signal K restarted before voyage recording was stopped.",
            recoveredAt: now,
          },
      observations: await rebuildObservationLog(
        directory,
        existingIndex?.observations,
      ),
      events: Array.isArray(existingIndex?.events) ? existingIndex.events.slice(0, 200) : [],
      routeAtStart: existingIndex?.routeAtStart || null,
      selectedRoute: existingIndex?.selectedRoute || null,
      routeSelections: Array.isArray(existingIndex?.routeSelections)
        ? existingIndex.routeSelections
        : [],
      drTrack: null,
      recoveredAt: now,
      interruptedByRestart: true,
    };
    voyage.drTrack = await recoverDrTrackState(
      directory,
      existingIndex?.drTrack,
      voyage.startedAt,
      voyage.stoppedAt,
    );
    if (completedRecomputation) {
      const recomputationVerified =
        completedRecomputation.recomputationVerified === true;
      voyage.stopReason =
        "Signal K restarted after Capture completed; ZIP finalisation recovered";
      voyage.incomplete = false;
      voyage.recomputationVerified = recomputationVerified;
      voyage.recomputedReplay = {
        ...voyage.recomputedReplay,
        ...completedRecomputation.recomputedReplay,
        status: "complete",
        complete: true,
        incomplete: false,
        verified: recomputationVerified,
        verificationFailure:
          completedRecomputation.verificationFailure || null,
        packagingRecoveredAfterRestart: true,
        recoveredAt: now,
        result: completedRecomputation.result,
      };
    } else if (voyage.recomputedReplay) {
      voyage.incomplete = true;
      voyage.recomputationVerified = false;
      voyage.recomputedReplay = {
        ...voyage.recomputedReplay,
        status: "incomplete",
        complete: false,
        incomplete: true,
        verified: false,
        interruptedByRestart: true,
        recoveredAt: now,
        result: markReplayResultIncomplete(
          voyage.recomputedReplay.result,
          {
            aborted: false,
            abortReason:
              "Signal K restarted before recomputed replay finalisation",
            interruptedByRestart: true,
          },
        ),
      };
    }
    beginFinalisation(voyage);
    finalisation.streamsClosed = true;
    finalisation.streamsClosedAt =
      completedRecomputation?.completedAt || now;
    finalisation.recomputationVerified =
      completedRecomputation?.recomputationVerified === true;
    updateFinalisation("recovery", {
      message: completedRecomputation
        ? "Recovering completed recomputation ZIP finalisation"
        : "Packaging interrupted voyage evidence",
    });
    appendVoyageEvent(voyage, "recovered", "Voyage closed at startup after Signal K restart");
    await copyConsoleBiteReports(voyage);
    await writeJson(path.join(directory, "system", "recovery-status.json"), {
      ok: true,
      recoveredAt: now,
      reason: voyage.stopReason,
      incomplete: voyage.incomplete === true,
      recomputationVerified:
        voyage.recomputedReplay
          ? voyage.recomputationVerified === true
          : null,
      note: completedRecomputation
        ? completedRecomputation.recomputationVerified === true
          ? "Capture had already completed and verified the recomputed replay. Startup recovery resumed only the later evidence and ZIP finalisation work."
          : "Capture had completed the replay without verification. Startup recovery resumed ZIP finalisation without certifying the recomputation."
        : voyage.recomputedReplay
          ? "Capture packaged the interrupted recomputed replay as incomplete, unverified evidence."
          : "Capture recovered the complete canonical records present on disk and packaged the interrupted ordinary voyage automatically.",
    });
    const index = await writeVoyageIndex(voyage);
    updateFinalisation("building-zip", {
      message: "Building disk-backed voyage ZIP after restart",
    });
    const bundle = await bundleVoyage(voyage, index);
    if (bundle?.format === "zip" && options.deleteWorkingDirectoryAfterZip) {
      await fs.promises.rm(directory, { recursive: true, force: true });
      bundle.workingDirectoryDeleted = true;
    }
    finishFinalisation(bundle);
    addEvent(
      "voyage-recovered",
      completedRecomputation
        ? `${id}: completed ZIP finalisation recovered after startup`
        : voyage.recomputedReplay
          ? `${id}: incomplete replay evidence packaged after startup`
          : `${id}: ordinary voyage recovered and packaged after startup`,
    );
    logInfo(
      completedRecomputation
        ? `${id} completed ZIP finalisation recovered after startup`
        : voyage.recomputedReplay
          ? `${id} incomplete replay evidence packaged after startup`
          : `${id} ordinary voyage recovered and packaged after startup`,
    );
    publishState();
    return bundle;
  }

  async function recoverCanonicalInputState(directory, existingState) {
    const filePath = path.join(directory, INPUT_RELATIVE_PATH);
    let fileInfo = await fs.promises.stat(filePath).catch(() => null);
    if (!fileInfo?.isFile()) {
      throw new Error(`Interrupted voyage has no ${INPUT_RELATIVE_PATH}`);
    }
    let fileEndsWithLineBreak = false;
    if (fileInfo.size > 0) {
      const handle = await fs.promises.open(filePath, "r");
      try {
        const finalByte = Buffer.alloc(1);
        await handle.read(finalByte, 0, 1, fileInfo.size - 1);
        fileEndsWithLineBreak = finalByte[0] === 10 || finalByte[0] === 13;
      } finally {
        await handle.close();
      }
    }

    const input = fs.createReadStream(filePath);
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let records = 0;
    let offset = 0;
    let lastElapsedMs = 0;
    let firstCapturedAt = null;
    let lastCapturedAt = null;
    let pendingInvalid = null;

    for await (const line of lines) {
      if (pendingInvalid) {
        throw new Error(
          `Invalid canonical input before EOF at byte ${pendingInvalid.offset}: ${pendingInvalid.error.message}`,
        );
      }
      const lineBytes = Buffer.byteLength(line) + 1;
      if (!line) {
        offset += lineBytes;
        continue;
      }
      try {
        const record = JSON.parse(line);
        if (
          record?.contract !== INPUT_CONTRACT ||
          record?.schemaVersion !== 1 ||
          !Number.isFinite(record?.elapsedMs) ||
          record.elapsedMs < lastElapsedMs ||
          !Array.isArray(record?.delta?.updates) ||
          record.delta.updates.length === 0
        ) {
          throw new Error("record does not satisfy the canonical input contract");
        }
        records += 1;
        lastElapsedMs = record.elapsedMs;
        if (!firstCapturedAt) firstCapturedAt = record.capturedAt || null;
        lastCapturedAt = record.capturedAt || lastCapturedAt;
      } catch (error) {
        pendingInvalid = {
          offset,
          error,
          recoverableTrailingFragment:
            error instanceof SyntaxError && !fileEndsWithLineBreak,
        };
      }
      offset += lineBytes;
    }

    let truncatedTrailingBytes = 0;
    if (pendingInvalid) {
      if (!pendingInvalid.recoverableTrailingFragment) {
        throw new Error(
          `Invalid final canonical input record at byte ${pendingInvalid.offset}: ${pendingInvalid.error.message}`,
        );
      }
      truncatedTrailingBytes = Math.max(0, fileInfo.size - pendingInvalid.offset);
      await fs.promises.truncate(filePath, pendingInvalid.offset);
      fileInfo = await fs.promises.stat(filePath);
    }

    return {
      contract: INPUT_CONTRACT,
      schemaVersion: 1,
      fileName: INPUT_RELATIVE_PATH,
      sourcePrefixes: Array.isArray(existingState?.sourcePrefixes)
        ? existingState.sourcePrefixes
        : options.inputSourcePrefixes,
      records,
      bytes: fileInfo.size,
      lastElapsedMs,
      writeErrors: Number(existingState?.writeErrors) || 0,
      firstCapturedAt,
      lastCapturedAt,
      closedAt: new Date().toISOString(),
      complete: true,
      recoveredAfterRestart: true,
      truncatedTrailingBytes,
    };
  }

  async function recoverDrTrackState(
    directory,
    existingState,
    startedAt,
    stoppedAt,
  ) {
    const filePath = path.join(directory, DR_TRACK_RELATIVE_PATH);
    let fileInfo = await fs.promises.stat(filePath).catch(() => null);
    const writeErrors = Number(existingState?.writeErrors) || 0;
    if (!fileInfo?.isFile()) {
      return existingState
        ? {
            fileName: DR_TRACK_RELATIVE_PATH,
            samples: 0,
            writeErrors,
            startedAt: existingState.startedAt || startedAt || null,
            stoppedAt: stoppedAt || null,
            firstSampleAt: null,
            lastSampleAt: null,
            recoveredAfterRestart: true,
            sourceAvailable: false,
          }
        : null;
    }

    let fileEndsWithLineBreak = false;
    if (fileInfo.size > 0) {
      const handle = await fs.promises.open(filePath, "r");
      try {
        const finalByte = Buffer.alloc(1);
        await handle.read(finalByte, 0, 1, fileInfo.size - 1);
        fileEndsWithLineBreak = finalByte[0] === 10 || finalByte[0] === 13;
      } finally {
        await handle.close();
      }
    }

    const input = fs.createReadStream(filePath);
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let samples = 0;
    let invalidRecords = 0;
    let offset = 0;
    let firstSampleAt = null;
    let lastSampleAt = null;
    let finalInvalid = null;

    for await (const line of lines) {
      const lineBytes = Buffer.byteLength(line) + 1;
      finalInvalid = null;
      if (!line) {
        offset += lineBytes;
        continue;
      }
      try {
        const sample = JSON.parse(line);
        if (
          !sample ||
          typeof sample !== "object" ||
          !normalizeIsoTimestamp(sample.ts)
        ) {
          throw new Error("record does not contain a valid DR sample timestamp");
        }
        samples += 1;
        if (!firstSampleAt) firstSampleAt = sample.ts;
        lastSampleAt = sample.ts;
      } catch (error) {
        invalidRecords += 1;
        finalInvalid = {
          offset,
          error,
          recoverableTrailingFragment:
            error instanceof SyntaxError && !fileEndsWithLineBreak,
        };
      }
      offset += lineBytes;
    }

    let truncatedTrailingBytes = 0;
    if (finalInvalid?.recoverableTrailingFragment) {
      truncatedTrailingBytes = Math.max(0, fileInfo.size - finalInvalid.offset);
      await fs.promises.truncate(filePath, finalInvalid.offset);
      fileInfo = await fs.promises.stat(filePath);
      invalidRecords -= 1;
    }

    return {
      fileName: DR_TRACK_RELATIVE_PATH,
      samples,
      bytes: fileInfo.size,
      writeErrors,
      startedAt: existingState?.startedAt || startedAt || firstSampleAt,
      stoppedAt: stoppedAt || lastSampleAt,
      firstSampleAt,
      lastSampleAt,
      recoveredAfterRestart: true,
      invalidRecords,
      truncatedTrailingBytes,
    };
  }

  async function completedRecomputedCompletion(
    voyageId,
    directory,
    checkpoint,
    existingIndex,
  ) {
    const candidates = [];
    if (
      checkpoint?.contract === "ajrm-marine-recomputed-completion" &&
      checkpoint?.contractVersion === 1 &&
      checkpoint?.voyageId === voyageId &&
      (
        checkpoint?.completionConfirmed === true ||
        (
          checkpoint?.verified === true &&
          checkpoint?.recomputationVerified === true
        )
      )
    ) {
      candidates.push({
        source: "completion-checkpoint",
        completedAt: checkpoint.completedAt,
        recomputedReplay: checkpoint.recomputedReplay,
        result: checkpoint.replayResult ||
          checkpoint.recomputedReplay?.result,
      });
    }
    if (
      existingIndex?.id === voyageId &&
      existingIndex?.incomplete !== true &&
      existingIndex?.recomputedReplay?.complete === true
    ) {
      candidates.push({
        source: "completed-index",
        completedAt: existingIndex.recomputedReplay.completedAt,
        recomputedReplay: existingIndex.recomputedReplay,
        result: existingIndex.recomputedReplay.result,
      });
    }
    for (const candidate of candidates) {
      const result = candidate.result;
      if (
        result?.contract !== REPLAY_CONTRACT ||
        result?.coverage?.complete !== true ||
        result?.coverage?.preparedComplete !== true ||
        result?.coverage?.lastReason !== "end of canonical input" ||
        result?.output?.contract !== "ajrm-marine-recomputed-output-v1" ||
        result?.output?.complete !== true
      ) {
        continue;
      }
      if (result.output.fileName !== RECOMPUTED_OUTPUT_RELATIVE_PATH) {
        continue;
      }
      const outputInfo = await fs.promises.stat(
        path.join(directory, RECOMPUTED_OUTPUT_RELATIVE_PATH),
      ).catch(() => null);
      if (
        !outputInfo?.isFile() ||
        outputInfo.size !== Number(result.output.bytes)
      ) {
        continue;
      }
      const verification = recomputedReplayVerification(
        candidate.recomputedReplay,
        result,
      );
      return {
        ...candidate,
        recomputationVerified: verification.verified,
        verificationFailure: verification.failure,
      };
    }
    return null;
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

  async function fetchAiSnapshot(snapshotPresetOverride = null) {
    const ajrmMarineSnapshotApi = getAiSnapshotApi();
    const snapshotPreset =
      snapshotPresetOverride ||
      (options.captureMode === "debug" ? "debug" : "voyage");
    const snapshotOptions = {
      snapshotPreset,
    };
    if (typeof ajrmMarineSnapshotApi?.snapshot === "function") {
      return ajrmMarineSnapshotApi.snapshot(snapshotOptions);
    }
    throw new Error("AJRM Marine Snapshot in-process API is unavailable");
  }

  function appendObservation(input) {
    const operation = observationWriteQueue.then(() =>
      appendObservationNow(input),
    );
    observationWriteQueue = operation.catch(() => {});
    return operation;
  }

  async function appendObservationNow({
    text,
    includeSnapshot = false,
    source = "display",
  } = {}) {
    if (!currentVoyage) {
      throw new Error("Start a voyage before recording an observation");
    }
    if (stoppingVoyage) {
      throw new Error("The voyage is stopping; the observation was not recorded");
    }
    const observationText = normalizeObservationText(text);
    const voyage = currentVoyage;
    voyage.observations =
      voyage.observations || (await rebuildObservationLog(voyage.directory));
    if (voyage.observations.count >= MAX_OBSERVATIONS_PER_VOYAGE) {
      throw new Error(
        `This voyage already has the maximum ${MAX_OBSERVATIONS_PER_VOYAGE} observations`,
      );
    }

    const now = new Date();
    const recordedAt = now.toISOString();
    const observationId = `observation-${formatFileTime(now)}-${randomUUID().slice(0, 8)}`;
    const replayTime = await currentReplayOriginalTime(voyage);
    const evidence = {
      requested: includeSnapshot === true,
      captured: false,
      fileName: null,
      snapshotPreset: includeSnapshot === true ? "debug" : null,
    };
    let evidenceError = null;

    if (includeSnapshot === true) {
      const evidenceFileName = `${observationId}.json`;
      const evidenceRelativePath = `${OBSERVATION_EVIDENCE_DIRECTORY}/${evidenceFileName}`;
      try {
        const snapshot = await fetchAiSnapshot("debug");
        await writeJson(path.join(voyage.directory, evidenceRelativePath), {
          schemaVersion: 1,
          observationId,
          recordedAt,
          replayOriginalAt: replayTime.timestamp,
          snapshot,
        });
        evidence.captured = true;
        evidence.fileName = evidenceRelativePath;
      } catch (error) {
        evidenceError = boundedErrorMessage(error);
      }
    }

    const startedAtMs = Date.parse(voyage.startedAt);
    const record = {
      schemaVersion: 1,
      id: observationId,
      voyageId: voyage.id,
      recordedAt,
      voyageElapsedSeconds: Number.isFinite(startedAtMs)
        ? Math.max(0, (now.getTime() - startedAtMs) / 1000)
        : null,
      replayOriginalAt: replayTime.timestamp,
      replayOriginalAtSource: replayTime.source,
      source: normalizeObservationSource(source),
      text: observationText,
      evidence,
      evidenceError,
    };
    const logPath = path.join(voyage.directory, OBSERVATIONS_RELATIVE_PATH);
    await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
    try {
      await fs.promises.appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
    } catch (error) {
      if (evidence.fileName) {
        await fs.promises
          .unlink(path.join(voyage.directory, evidence.fileName))
          .catch(() => {});
      }
      throw error;
    }

    updateObservationLog(voyage.observations, record);
    appendVoyageEvent(
      voyage,
      "observation",
      `Observation recorded${evidence.captured ? " with snapshot evidence" : ""}`,
    );
    addEvent("observation", `${voyage.id}: observation recorded`);
    const postCommitWarnings = [];
    try {
      await writeVoyageIndex(voyage);
    } catch (error) {
      const warning = `Observation text is safe, but index.json was not refreshed: ${boundedErrorMessage(error)}`;
      postCommitWarnings.push(warning);
      try {
        app.error?.(`[${plugin.id}] ${warning}`);
      } catch {
        // The observation is already durable; diagnostic logging must not
        // turn a committed note into an apparent failed request.
      }
      appendVoyageEvent(voyage, "observation-index-warning", warning);
    }
    try {
      publishState();
    } catch (error) {
      const warning = `Observation text is safe, but live status was not refreshed: ${boundedErrorMessage(error)}`;
      postCommitWarnings.push(warning);
      try {
        app.error?.(`[${plugin.id}] ${warning}`);
      } catch {
        // Preserve the successful append even if the host logger is faulty.
      }
    }
    return postCommitWarnings.length
      ? { ...record, postCommitWarning: postCommitWarnings.join(" ") }
      : record;
  }

  async function observationStatus({ limit } = {}) {
    if (!currentVoyage) {
      return {
        ok: true,
        active: false,
        voyage: null,
        observationLog: null,
        observations: [],
        limits: observationLimits(),
        observationCapabilities: buildObservationCapabilities(),
      };
    }
    const records = await readObservationRecords(
      path.join(currentVoyage.directory, OBSERVATIONS_RELATIVE_PATH),
      normalizeObservationLimit(limit),
    );
    return {
      ok: true,
      active: true,
      voyage: {
        id: currentVoyage.id,
        startedAt: currentVoyage.startedAt,
        recomputedReplay: currentVoyage.recomputedReplay || null,
      },
      observationLog: publicObservationLog(currentVoyage.observations),
      observations: records.reverse(),
      limits: observationLimits(),
      observationCapabilities: buildObservationCapabilities(),
    };
  }

  function buildObservationCapabilities() {
    const snapshotApi = getAiSnapshotApi();
    return {
      available: true,
      requiresActiveVoyage: true,
      snapshotAvailable: typeof snapshotApi?.snapshot === "function",
      snapshotIntegration:
        typeof snapshotApi?.snapshot === "function"
          ? "in-process"
          : "http-fallback-unverified",
      parentReplayLineageSupported: true,
      ...observationLimits(),
    };
  }

  async function currentReplayOriginalTime(voyage) {
    if (!voyage?.recomputedReplay) {
      return { timestamp: null, source: null };
    }
    const originalFromMs = Date.parse(voyage.recomputedReplay.originalFrom || "");
    const sourceElapsedMs = Number(playback.sourceElapsedMs);
    if (Number.isFinite(originalFromMs) && Number.isFinite(sourceElapsedMs)) {
      return {
        timestamp: new Date(originalFromMs + sourceElapsedMs).toISOString(),
        source: "capture.playback.monotonic-source-elapsed",
      };
    }
    return { timestamp: null, source: null };
  }

  async function copyParentObservations(voyage) {
    const parentFileName = safeBaseName(
      voyage?.recomputedReplay?.parentVoyage,
    );
    if (!parentFileName || !parentFileName.endsWith(".zip")) return;
    const parentPath = path.join(options.voyageDirectory, parentFileName);
    try {
      const zip = new AdmZip(parentPath);
      const entry = zip.getEntry(OBSERVATIONS_RELATIVE_PATH);
      if (!entry || entry.isDirectory) return;
      const declaredBytes = Number(entry.header?.size || 0);
      if (
        declaredBytes <= 0 ||
        declaredBytes > MAX_PARENT_OBSERVATIONS_BYTES
      ) {
        throw new Error("parent observation log is empty or too large");
      }
      const content = entry.getData();
      if (
        content.length <= 0 ||
        content.length > MAX_PARENT_OBSERVATIONS_BYTES
      ) {
        throw new Error("parent observation log is empty or too large");
      }
      const records = parseObservationRecords(
        content.toString("utf8"),
        MAX_OBSERVATIONS_PER_VOYAGE,
      );
      const lineageRecords = records.map((record) =>
        parentLineageObservation(record, parentFileName, zip),
      );
      const target = path.join(
        voyage.directory,
        PARENT_OBSERVATIONS_RELATIVE_PATH,
      );
      await fs.promises.writeFile(
        target,
        `${lineageRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
        "utf8",
      );
      const evidenceAvailableInParentCount = lineageRecords.filter(
        (record) => record.lineage?.parentEvidenceAvailable === true,
      ).length;
      voyage.observations.parentLog = {
        parentVoyage: parentFileName,
        fileName: PARENT_OBSERVATIONS_RELATIVE_PATH,
        sourceFileName: OBSERVATIONS_RELATIVE_PATH,
        count: lineageRecords.length,
        firstRecordedAt: lineageRecords[0]?.recordedAt || null,
        lastRecordedAt: lineageRecords.at(-1)?.recordedAt || null,
        evidenceAvailableInParentCount,
        copiedAt: new Date().toISOString(),
      };
      appendVoyageEvent(
        voyage,
        "parent-observations",
        `${lineageRecords.length} parent observation${lineageRecords.length === 1 ? "" : "s"} copied as replay lineage`,
      );
    } catch (error) {
      appendVoyageEvent(
        voyage,
        "parent-observations-warning",
        `Parent observation lineage was not copied: ${boundedErrorMessage(error)}`,
      );
    }
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

  function markReplayResultIncomplete(result, {
    aborted,
    abortReason,
    interruptedByRestart,
  }) {
    const source = result && typeof result === "object" ? result : {};
    const sourceCoverage =
      source.coverage && typeof source.coverage === "object"
        ? source.coverage
        : {};
    const sourceSegments =
      source.resultSegments && typeof source.resultSegments === "object"
        ? source.resultSegments
        : {};
    return {
      schemaVersion: source.schemaVersion || 1,
      kind: source.kind || "recomputed-replay",
      ...source,
      aborted: aborted === true,
      incomplete: true,
      abortReason:
        aborted === true
          ? String(abortReason || source.abortReason || "recomputed replay aborted")
          : source.abortReason || null,
      interruptedByRestart: interruptedByRestart === true,
      interruptionReason:
        interruptedByRestart === true
          ? String(
              abortReason ||
              source.interruptionReason ||
              "Signal K restarted before recomputed replay finalisation",
            )
          : source.interruptionReason || null,
      coverage: {
        ...sourceCoverage,
        complete: false,
        resultSegmentsComplete: false,
      },
      resultSegments: {
        schemaVersion: sourceSegments.schemaVersion || 1,
        ...sourceSegments,
        complete: false,
      },
    };
  }

  async function writeVoyageIndex(voyage) {
    const files = (await listFiles(voyage.directory))
      .filter((entry) => entry.path !== "index.json");
    const index = {
      id: voyage.id,
      version: packageInfo.version,
      createdAt: new Date().toISOString(),
      startedAt: voyage.startedAt,
      stoppedAt: voyage.stoppedAt,
      comment: voyage.comment || "",
      ownContext: voyage.ownContext || null,
      startReason: voyage.reason,
      stopReason: voyage.stopReason,
      snapshotCount: voyage.snapshotCount,
      captureMode: voyage.captureMode || options.captureMode,
      recomputedReplay: voyage.recomputedReplay || null,
      incomplete: voyage.incomplete === true,
      recomputationVerified: voyage.recomputedReplay
        ? voyage.recomputationVerified === true &&
          voyage.recomputedReplay?.verified !== false
        : null,
      aborted: voyage.aborted === true,
      interruptedByRestart: voyage.interruptedByRestart === true,
      recoveredAt: voyage.recoveredAt || null,
      canonicalInput: voyage.canonicalInput || null,
      recomputedOutput: voyage.recomputedOutput || null,
      observations: publicObservationLog(voyage.observations),
      routeAtStart: voyage.routeAtStart || null,
      selectedRoute: voyage.selectedRoute || null,
      routeSelections: voyage.routeSelections || [],
      drTrack: voyage.drTrack || null,
      events: voyage.events,
      fileInventory: {
        contract: "ajrm-marine-voyage-payload-inventory-v1",
        contractVersion: 1,
        excludes: ["index.json"],
        reason:
          "The root manifest is excluded because it cannot reliably declare its own final size and modification time.",
      },
      files,
      hints: [
        "Start with index.json.",
        "Read snapshots/start and snapshots/stop before opening large voyage streams.",
        `Read ${OBSERVATIONS_RELATIVE_PATH} for timestamped skipper observations; optional structured Snapshot evidence is referenced from each observation.`,
        `For a recomputed child, ${PARENT_OBSERVATIONS_RELATIVE_PATH} is lineage copied from the parent and is not counted as a child observation. Verified parent Snapshot evidence stays in the named parent voyage and lineage records contain no dangling child paths.`,
        "Use snapshot timestamps and canonical recording metadata to locate interesting intervals.",
        `${INPUT_RELATIVE_PATH} is the only replayable input and contains explicitly sourced physical updates on one monotonic elapsedMs timeline.`,
        `${RECOMPUTED_OUTPUT_RELATIVE_PATH} is output evidence only and must never be replayed as physical input.`,
        voyage.recomputedReplay?.incomplete === true
          ? "WARNING: this recomputed replay was interrupted. It is incomplete and unverified, preserves partial evidence only, and must not be treated as proof that recalculation completed."
          : voyage.recomputedReplay?.verified === false
            ? `WARNING: this recomputed replay completed but is unverified${voyage.recomputedReplay.verificationFailure ? `: ${voyage.recomputedReplay.verificationFailure}` : "."}`
          : "If recomputedReplay is present, audit its explicit inputContract, replayContract, EOF coverage and effective timing.",
      ],
    };
    const indexPath = path.join(voyage.directory, "index.json");
    await writeJson(indexPath, index);
    return index;
  }

  async function bundleVoyage(voyage) {
    const zipName = `${voyage.id}.zip`;
    const zipPath = path.join(options.voyageDirectory, zipName);
    try {
      await writeDirectoryZip(zipPath, voyage.directory, {
        onProgress(progress) {
          if (!finalisation || finalisation.voyageId !== voyage.id) return;
          finalisation.zip = progress;
          finalisation.updatedAt = new Date().toISOString();
          const now = Date.now();
          if (
            progress.state === "complete" ||
            now - lastZipProgressPublishMs >= 250
          ) {
            lastZipProgressPublishMs = now;
            publishState();
          }
        },
      });
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

  async function buildStatus() {
    refreshNavigationContextFromSelfPath();
    return {
      ok: true,
      plugin: plugin.id,
      version: packageInfo.version,
      timestamp: new Date().toISOString(),
      enabled: options.enabled,
      state:
        finalisation?.state === "running"
          ? "finalising"
          : playback.active
            ? "replaying"
          : currentVoyage
            ? "recording"
            : options.enabled
              ? "watching"
              : "disabled",
      speedKnots,
      sogKnots,
      stwKnots,
      voyageState,
      playback,
      movementSuppressedUntilFreshSpeed,
      autoStartInhibited,
      thresholds: {
        movementSpeedKnots: options.movementSpeedKnots,
        movementSpeedMetersPerSecond: options.movementSpeedKnots / MPS_TO_KNOTS,
        alignedWithTrafficStationaryAutomute: true,
        movementSeconds: options.movementSeconds,
        stoppedMinutes: options.stoppedMinutes,
        minFreeDiskGb: options.minFreeDiskGb,
      },
      captureMode: options.captureMode,
      canonicalInputContract: INPUT_CONTRACT,
      replayContract: REPLAY_CONTRACT,
      inputSourcePrefixes: options.inputSourcePrefixes,
      currentVoyage: currentVoyage ? summarizeVoyage(currentVoyage) : null,
      observationLog: currentVoyage
        ? publicObservationLog(currentVoyage.observations)
        : null,
      observationLimits: observationLimits(),
      observationCapabilities: buildObservationCapabilities(),
      voyageComment: currentVoyage
        ? currentVoyage.comment || ""
        : nextVoyageComment || defaultVoyageComment({
            startedAt: new Date(),
            profile: navigationContext.profile,
            harbourName: navigationContext.nearestHarbourName,
          }),
      lastBundle,
      finalisation,
      zipProgress: finalisation?.zip || null,
      voyages: await listVoyageBundles(),
      disk,
      recentEvents,
    };
  }

  async function listVoyageBundles() {
    return listVoyageBundlesInDirectory(options.voyageDirectory);
  }

  function getAiSnapshotApi() {
    return app.ajrmMarineSnapshotApi || globalThis[AJRM_MARINE_SNAPSHOT_API_REGISTRY] || null;
  }

  function publishState() {
    const values = [
      { path: "plugins.ajrmMarineCapture.version", value: packageInfo.version },
      { path: "plugins.ajrmMarineCapture.enabled", value: options.enabled },
      {
        path: "plugins.ajrmMarineCapture.state",
        value:
          finalisation?.state === "running"
            ? "finalising"
            : playback.active
              ? "replaying"
            : currentVoyage
              ? "recording"
              : options.enabled
                ? "watching"
                : "disabled",
      },
      { path: "plugins.ajrmMarineCapture.speedKnots", value: speedKnots },
      { path: "plugins.ajrmMarineCapture.sogKnots", value: sogKnots },
      { path: "plugins.ajrmMarineCapture.stwKnots", value: stwKnots },
      { path: "plugins.ajrmMarineCapture.voyageState", value: voyageState },
      { path: "plugins.ajrmMarineCapture.playback", value: playback },
      { path: "plugins.ajrmMarineCapture.movementSuppressedUntilFreshSpeed", value: movementSuppressedUntilFreshSpeed },
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
      {
        path: "plugins.ajrmMarineCapture.currentVoyage.observationCount",
        value: currentVoyage?.observations?.count || 0,
      },
      {
        path: "plugins.ajrmMarineCapture.currentVoyage.lastObservationAt",
        value: currentVoyage?.observations?.lastRecordedAt || null,
      },
      {
        path: "plugins.ajrmMarineCapture.currentVoyage.recomputedReplay",
        value: currentVoyage?.recomputedReplay || null,
      },
      { path: "plugins.ajrmMarineCapture.lastBundle.fileName", value: lastBundle?.fileName || null },
      { path: "plugins.ajrmMarineCapture.lastBundle.path", value: lastBundle?.path || null },
      {
        path: "plugins.ajrmMarineCapture.finalisation",
        value: finalisation,
      },
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
    const eventId = `ajrm-marine-capture-${id}-${safeLeaf}-${notificationSequence}`;
    const subjectKey = `ajrm-marine-capture:${id}:${safeLeaf}`;
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
                    provider: "ajrm-marine-capture",
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
    const clearTimer = setTimeout(() => {
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
    clearTimer.unref?.();
  }

  async function recordRouteSelection(selection) {
    if (!currentVoyage) return { recorded: false, reason: "no-active-voyage" };
    const normalized = sanitizeRouteSelection(selection);
    const previous = currentVoyage.selectedRoute;
    const action = !normalized
      ? "closed"
      : previous?.resourceId === normalized.resourceId &&
          previous?.reversed !== normalized.reversed
        ? "reversed"
        : normalized.source === "saved" || normalized.source === "saved-as"
          ? normalized.source
          : "opened";
    const record = {
      at: new Date().toISOString(),
      voyageElapsedMs: Math.max(
        0,
        Math.round(performance.now() - currentVoyage.monotonicStartedAtMs),
      ),
      action,
      selection: normalized,
    };
    currentVoyage.selectedRoute = normalized;
    currentVoyage.routeSelections = Array.isArray(currentVoyage.routeSelections)
      ? currentVoyage.routeSelections
      : [];
    currentVoyage.routeSelections.push(record);
    currentVoyage.routeSelections = currentVoyage.routeSelections.slice(-200);
    appendVoyageEvent(
      currentVoyage,
      normalized ? "route-opened" : "route-closed",
      normalized
        ? `Opened route ${normalized.resource?.name || normalized.resourceId || "unknown"}`
        : "Closed the displayed route",
    );
    await writeVoyageIndex(currentVoyage);
    publishState();
    return { recorded: true, record };
  }

  async function currentDisplayRoute() {
    const api = getDisplayApi();
    if (typeof api?.currentRoute !== "function") return null;
    try {
      return sanitizeRouteSelection(await api.currentRoute());
    } catch (error) {
      addEvent("route-read-failed", error.message);
      return null;
    }
  }

  async function restoreDisplayRoute(selection) {
    const api = getDisplayApi();
    if (typeof api?.restoreRoute !== "function") {
      return {
        available: false,
        restored: false,
        error: "AJRM Marine Display route API is unavailable",
      };
    }
    try {
      const restored = await api.restoreRoute(sanitizeRouteSelection(selection));
      return {
        available: true,
        restored: selection ? Boolean(restored) : restored === null,
        selection: sanitizeRouteSelection(restored),
      };
    } catch (error) {
      addEvent("route-restore-failed", error.message);
      return { available: true, restored: false, error: error.message };
    }
  }

  function getDisplayApi() {
    return (
      app.ajrmMarineDisplayApi ||
      globalThis[AJRM_MARINE_DISPLAY_API_REGISTRY] ||
      null
    );
  }

  function applyReplayRouteTimeline(voyage, replayStatus) {
    const timeline = voyage?.routeReplay;
    const elapsedMs = Number(replayStatus?.sourceElapsedMs);
    if (!timeline || !Number.isFinite(elapsedMs)) return;
    while (timeline.nextIndex < timeline.selections.length) {
      const record = timeline.selections[timeline.nextIndex];
      if (record.voyageElapsedMs > elapsedMs) break;
      timeline.nextIndex += 1;
      const selection = record.selection;
      voyage.routeReplayQueue = (voyage.routeReplayQueue || Promise.resolve())
        .then(() => restoreDisplayRoute(selection))
        .then((result) => {
          voyage.selectedRoute = selection;
          voyage.routeSelections = Array.isArray(voyage.routeSelections)
            ? voyage.routeSelections
            : [];
          voyage.routeSelections.push({
            at: new Date().toISOString(),
            sourceAt: record.at,
            voyageElapsedMs: record.voyageElapsedMs,
            action: record.action,
            selection,
          });
          voyage.routeSelections = voyage.routeSelections.slice(-200);
          appendVoyageEvent(
            voyage,
            selection ? "route-replay-opened" : "route-replay-closed",
            selection
              ? `Replay opened route ${selection.resource?.name || selection.resourceId || "unknown"}`
              : "Replay closed the displayed route",
          );
          return result;
        })
        .catch((error) => logError("route timeline replay failed", error));
    }
  }

  function summarizeVoyage(voyage) {
    return {
      id: voyage.id,
      startedAt: voyage.startedAt,
      reason: voyage.reason,
      comment: voyage.comment || "",
      snapshotCount: voyage.snapshotCount,
      observationLog: publicObservationLog(voyage.observations),
      captureMode: voyage.captureMode || options.captureMode,
      recomputedReplay: voyage.recomputedReplay || null,
      routeAtStart: voyage.routeAtStart || null,
      selectedRoute: voyage.selectedRoute || null,
      routeSelections: voyage.routeSelections || [],
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

  async function copyConsoleBiteReports(voyage) {
    if (!voyage?.directory) return;
    const targetDirectory = path.join(voyage.directory, "system", "bite-reports");
    const copied = [];
    let names = [];
    try {
      names = (await fs.promises.readdir(CONSOLE_BITE_REPORTS_DIRECTORY))
        .filter((name) => name.endsWith(".json"))
        .sort();
    } catch (_error) {
      voyage.biteReports = {
        sourceDirectory: CONSOLE_BITE_REPORTS_DIRECTORY,
        copied: 0,
        available: false,
      };
      appendVoyageEvent(voyage, "bite-reports-missing", "No AJRM Marine Console BITE reports were available");
      return;
    }
    await fs.promises.mkdir(targetDirectory, { recursive: true });
    for (const name of names) {
      const source = path.join(CONSOLE_BITE_REPORTS_DIRECTORY, name);
      const target = path.join(targetDirectory, name);
      try {
        const report = await readJson(source);
        if (!biteReportOverlapsVoyage(voyage, report, name)) continue;
        await fs.promises.copyFile(source, target);
        copied.push(name);
      } catch (error) {
        appendVoyageEvent(voyage, "bite-report-copy-warning", `${name}: ${error.message}`);
      }
      if (copied.length >= 200) break;
    }
    if (!copied.length) {
      voyage.biteReports = {
        sourceDirectory: CONSOLE_BITE_REPORTS_DIRECTORY,
        copied: 0,
        available: false,
      };
      appendVoyageEvent(voyage, "bite-reports-none", "No AJRM Marine Console BITE reports overlapped this voyage");
      return;
    }
    voyage.biteReports = {
      sourceDirectory: CONSOLE_BITE_REPORTS_DIRECTORY,
      directory: "system/bite-reports",
      copied: copied.length,
      files: copied,
      available: true,
    };
    appendVoyageEvent(
      voyage,
      "bite-reports",
      `${copied.length} AJRM Marine Console BITE report${copied.length === 1 ? "" : "s"} copied into voyage bundle`,
    );
  }
};

function createObservationLog() {
  return {
    schemaVersion: 1,
    fileName: OBSERVATIONS_RELATIVE_PATH,
    count: 0,
    evidenceCount: 0,
    evidenceErrorCount: 0,
    firstRecordedAt: null,
    lastRecordedAt: null,
    parentLog: null,
  };
}

async function rebuildObservationLog(directory, existing = null) {
  const records = await readObservationRecords(
    path.join(directory, OBSERVATIONS_RELATIVE_PATH),
    MAX_OBSERVATIONS_PER_VOYAGE,
  );
  const result = createObservationLog();
  for (const record of records) updateObservationLog(result, record);
  if (existing?.parentLog && typeof existing.parentLog === "object") {
    result.parentLog = {
      parentVoyage: stringOrNull(existing.parentLog.parentVoyage),
      fileName: stringOrNull(existing.parentLog.fileName),
      sourceFileName: stringOrNull(existing.parentLog.sourceFileName),
      count: Math.max(0, Math.trunc(Number(existing.parentLog.count) || 0)),
      firstRecordedAt: normalizeIsoTimestamp(
        existing.parentLog.firstRecordedAt,
      ),
      lastRecordedAt: normalizeIsoTimestamp(existing.parentLog.lastRecordedAt),
      evidenceAvailableInParentCount: Math.max(
        0,
        Math.trunc(
          Number(existing.parentLog.evidenceAvailableInParentCount) || 0,
        ),
      ),
      copiedAt: normalizeIsoTimestamp(existing.parentLog.copiedAt),
    };
  }
  return result;
}

function updateObservationLog(log, record) {
  if (!log || !record) return;
  log.count = Math.max(0, Number(log.count) || 0) + 1;
  if (record.evidence?.captured === true) {
    log.evidenceCount = Math.max(0, Number(log.evidenceCount) || 0) + 1;
  }
  if (record.evidence?.requested === true && record.evidenceError) {
    log.evidenceErrorCount =
      Math.max(0, Number(log.evidenceErrorCount) || 0) + 1;
  }
  if (!log.firstRecordedAt) log.firstRecordedAt = record.recordedAt;
  log.lastRecordedAt = record.recordedAt;
}

function publicObservationLog(value) {
  if (!value || typeof value !== "object") return null;
  const parent =
    value.parentLog && typeof value.parentLog === "object"
      ? {
          parentVoyage: stringOrNull(value.parentLog.parentVoyage),
          fileName: stringOrNull(value.parentLog.fileName),
          sourceFileName: stringOrNull(value.parentLog.sourceFileName),
          count: Math.max(0, Math.trunc(Number(value.parentLog.count) || 0)),
          firstRecordedAt: normalizeIsoTimestamp(
            value.parentLog.firstRecordedAt,
          ),
          lastRecordedAt: normalizeIsoTimestamp(value.parentLog.lastRecordedAt),
          evidenceAvailableInParentCount: Math.max(
            0,
            Math.trunc(
              Number(value.parentLog.evidenceAvailableInParentCount) || 0,
            ),
          ),
          copiedAt: normalizeIsoTimestamp(value.parentLog.copiedAt),
          lineageOnly: true,
        }
      : null;
  return {
    schemaVersion: 1,
    fileName: OBSERVATIONS_RELATIVE_PATH,
    count: Math.max(0, Math.trunc(Number(value.count) || 0)),
    evidenceCount: Math.max(
      0,
      Math.trunc(Number(value.evidenceCount) || 0),
    ),
    evidenceErrorCount: Math.max(
      0,
      Math.trunc(Number(value.evidenceErrorCount) || 0),
    ),
    firstRecordedAt: normalizeIsoTimestamp(value.firstRecordedAt),
    lastRecordedAt: normalizeIsoTimestamp(value.lastRecordedAt),
    parentLog: parent,
  };
}

async function readObservationRecords(filePath, limit) {
  const safeLimit = normalizeObservationLimit(limit);
  const text = await fs.promises.readFile(filePath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return parseObservationRecords(text, safeLimit);
}

function parseObservationRecords(text, limit = MAX_OBSERVATIONS_PER_VOYAGE) {
  const records = [];
  const safeLimit = normalizeObservationLimit(limit);
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const record = sanitizeObservationRecord(value);
    if (record) records.push(record);
    if (records.length > safeLimit) records.shift();
  }
  return records;
}

function sanitizeObservationRecord(value) {
  if (!value || typeof value !== "object") return null;
  const id =
    typeof value.id === "string" && value.id.trim()
      ? value.id.trim().slice(0, 120)
      : null;
  const voyageId =
    typeof value.voyageId === "string" && value.voyageId.trim()
      ? value.voyageId.trim().slice(0, 120)
      : null;
  const recordedAt = normalizeIsoTimestamp(value.recordedAt);
  if (!id || !voyageId || !recordedAt) return null;
  let text;
  try {
    text = normalizeObservationText(value.text);
  } catch {
    return null;
  }
  const evidenceValue =
    value.evidence && typeof value.evidence === "object"
      ? value.evidence
      : {};
  return {
    schemaVersion: 1,
    id,
    voyageId,
    recordedAt,
    voyageElapsedSeconds: numberOrNull(value.voyageElapsedSeconds),
    replayOriginalAt: normalizeIsoTimestamp(value.replayOriginalAt),
    replayOriginalAtSource: stringOrNull(value.replayOriginalAtSource),
    source: normalizeObservationSource(value.source),
    text,
    evidence: {
      requested: evidenceValue.requested === true,
      captured: evidenceValue.captured === true,
      fileName: stringOrNull(evidenceValue.fileName),
      snapshotPreset: stringOrNull(evidenceValue.snapshotPreset),
    },
    evidenceError: longStringOrNull(
      value.evidenceError || evidenceValue.error,
    ),
  };
}

function parentLineageObservation(record, parentVoyage, parentZip) {
  const referencedEvidenceFileName =
    record?.evidence?.captured === true
      ? stringOrNull(record.evidence.fileName)
      : null;
  const safeEvidenceFileName = safeParentEvidenceFileName(
    referencedEvidenceFileName,
  );
  const evidenceEntry = safeEvidenceFileName
    ? parentZip?.getEntry(safeEvidenceFileName)
    : null;
  const parentEvidenceAvailable = Boolean(
    evidenceEntry && evidenceEntry.isDirectory !== true,
  );
  const parentEvidenceUnavailableReason =
    referencedEvidenceFileName && !parentEvidenceAvailable
      ? "Parent observation referenced missing or unsafe Snapshot evidence"
      : null;
  return {
    ...record,
    evidence: {
      ...record.evidence,
      captured: false,
      fileName: null,
    },
    lineage: {
      parentVoyage,
      lineageOnly: true,
      parentEvidenceAvailable,
      parentEvidenceFileName: parentEvidenceAvailable
        ? safeEvidenceFileName
        : null,
      parentEvidenceUnavailableReason,
    },
  };
}

function safeParentEvidenceFileName(value) {
  const fileName = stringOrNull(value);
  if (
    !fileName ||
    fileName.includes("\\") ||
    fileName.startsWith("/") ||
    path.posix.normalize(fileName) !== fileName ||
    !fileName.startsWith(`${OBSERVATION_EVIDENCE_DIRECTORY}/`)
  ) {
    return null;
  }
  return fileName;
}

function normalizeObservationText(value) {
  if (typeof value !== "string") {
    throw new Error("Observation text is required");
  }
  const text = value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  if (!text) throw new Error("Observation text is required");
  if (text.length > MAX_OBSERVATION_TEXT_CHARACTERS) {
    throw new Error(
      `Observation text must be ${MAX_OBSERVATION_TEXT_CHARACTERS} characters or fewer`,
    );
  }
  return text;
}

function normalizeObservationSource(value) {
  const source = String(value || "unknown")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return source || "unknown";
}

function normalizeObservationLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return MAX_OBSERVATIONS_RETURNED;
  return Math.max(
    1,
    Math.min(MAX_OBSERVATIONS_PER_VOYAGE, Math.trunc(number)),
  );
}

function observationLimits() {
  return {
    maximumTextCharacters: MAX_OBSERVATION_TEXT_CHARACTERS,
    maximumObservationsPerVoyage: MAX_OBSERVATIONS_PER_VOYAGE,
    maximumReturned: MAX_OBSERVATIONS_RETURNED,
  };
}

function boundedErrorMessage(error) {
  const message =
    error && typeof error.message === "string"
      ? error.message
      : String(error || "unknown error");
  return message.trim().slice(0, 300) || "unknown error";
}

function biteReportOverlapsVoyage(voyage, report, fileName = "") {
  const startMs = Date.parse(voyage?.startedAt || "");
  const stopMs = Date.parse(voyage?.stoppedAt || "");
  if (!Number.isFinite(startMs) || !Number.isFinite(stopMs)) return false;
  const reportStarted = Date.parse(report?.startedAt || report?.createdAt || reportTimestampFromFileName(fileName) || "");
  const reportFinished = Date.parse(report?.finishedAt || report?.completedAt || report?.stoppedAt || "");
  const childTimes = Array.isArray(report?.reports)
    ? report.reports.flatMap((child) => [
      Date.parse(child?.startedAt || ""),
      Date.parse(child?.finishedAt || ""),
    ]).filter(Number.isFinite)
    : [];
  const fromMs = Number.isFinite(reportStarted)
    ? reportStarted
    : childTimes.length
      ? Math.min(...childTimes)
      : NaN;
  const toMs = Number.isFinite(reportFinished)
    ? reportFinished
    : childTimes.length
      ? Math.max(...childTimes)
      : fromMs;
  if (!Number.isFinite(fromMs)) return false;
  const effectiveToMs = Number.isFinite(toMs) ? toMs : fromMs;
  return effectiveToMs >= startMs && fromMs <= stopMs;
}

function reportTimestampFromFileName(fileName) {
  const match = String(fileName || "").match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z/);
  if (!match) return "";
  const [, year, month, day, hour, minute, second, ms] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${ms}Z`;
}

function normalizeIsoTimestamp(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function normalizeOwnContext(value) {
  const context = String(value || "").trim();
  if (!context || context === "vessels.self") return null;
  return context.startsWith("vessels.") ? context : `vessels.${context}`;
}

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
    integrityAssurance: normalizeIntegrityAssurance(state.integrityAssurance),
    navigationReference: normalizeNavigationReferenceProvenance(
      state.navigationProvenance?.navigationReference,
    ),
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
    gpsDependent: booleanOrNull(track?.gpsDependent),
    leewayStatus: stringOrNull(track?.leewayStatus),
    currentOrigin: stringOrNull(track?.currentOrigin),
    assurance: stringOrNull(track?.assurance),
    comparisonAvailable: booleanOrNull(track?.comparisonAvailable),
    unavailableReason: longStringOrNull(track?.unavailableReason),
    provenance: normalizeDrProvenance(track?.provenance),
  };
}

function normalizeIntegrityAssurance(value) {
  if (!value || typeof value !== "object") return null;
  return {
    status: stringOrNull(value.status),
    comparisonAvailable: booleanOrNull(value.comparisonAvailable),
    reason: longStringOrNull(value.reason),
    leewayStatus: stringOrNull(value.leewayStatus),
  };
}

function normalizeNavigationReferenceProvenance(value) {
  if (
    !value
    || value.contract !== "ajrm-marine-navigation-reference"
    || Number(value.schemaVersion) !== 1
  ) {
    return null;
  }
  const reference = value.clockReference;
  return {
    contract: value.contract,
    schemaVersion: 1,
    status: stringOrNull(value.status),
    clockReference: reference && typeof reference === "object"
      ? {
          kind: stringOrNull(reference.kind),
          source: stringOrNull(reference.source),
          method: stringOrNull(reference.method),
          ageMs: numberOrNull(reference.ageMs),
          uncertaintyRad: numberOrNull(reference.uncertaintyRad),
          gpsDependent: booleanOrNull(reference.gpsDependent),
        }
      : null,
  };
}

function normalizeDrProvenance(value) {
  if (!value || typeof value !== "object") return null;
  return {
    heading: normalizeEvidence(value.heading),
    trackThroughWater: normalizeEvidence(value.trackThroughWater),
    speedThroughWater: normalizeEvidence(value.speedThroughWater),
    current: normalizeEvidence(value.current),
    leeway: normalizeEvidence(value.leeway),
  };
}

function normalizeEvidence(value) {
  if (!value || typeof value !== "object") return null;
  return {
    source: stringOrNull(value.source),
    method: stringOrNull(value.method),
    origin: stringOrNull(value.origin),
    ageMs: numberOrNull(value.ageMs),
    uncertaintyRad: numberOrNull(value.uncertaintyRad),
    gpsDependent: booleanOrNull(value.gpsDependent),
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
    integrityAssurance: sample.integrityAssurance,
    navigationReference: sample.navigationReference,
  });
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : null;
}

function longStringOrNull(value) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 500)
    : null;
}

function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function sanitizeRouteSelection(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") throw new Error("Route selection must be an object or null");
  const coordinates = value.resource?.feature?.geometry?.coordinates;
  if (
    value.contract !== "ajrm-marine-display-active-route-v1" ||
    value.resource?.feature?.geometry?.type !== "LineString" ||
    !Array.isArray(coordinates) ||
    coordinates.length < 2
  ) {
    throw new Error("Route selection does not satisfy the AJRM active-route contract");
  }
  for (const point of coordinates) {
    if (
      !Array.isArray(point) ||
      point.length < 2 ||
      !Number.isFinite(Number(point[0])) ||
      !Number.isFinite(Number(point[1]))
    ) {
      throw new Error("Route selection contains invalid GeoJSON coordinates");
    }
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > 1024 * 1024) {
    throw new Error("Route selection exceeds the one-megabyte voyage metadata limit");
  }
  return JSON.parse(json);
}

function normalizeRouteTimeline(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-200)
    .filter((record) => record?.action !== "active-at-start")
    .map((record) => ({
      at: Number.isFinite(Date.parse(record?.at || "")) ? String(record.at) : null,
      voyageElapsedMs: Math.max(0, Math.round(Number(record?.voyageElapsedMs) || 0)),
      action: record?.selection
        ? ["opened", "reversed", "saved", "saved-as"].includes(record?.action)
          ? record.action
          : "opened"
        : "closed",
      selection: sanitizeRouteSelection(record?.selection),
    }))
    .sort((left, right) => left.voyageElapsedMs - right.voyageElapsedMs);
}

async function listVoyageBundlesInDirectory(directory) {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
  const result = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".zip")) continue;
    const filePath = path.join(directory, entry.name);
    const info = await fs.promises.stat(filePath).catch(() => null);
    if (!info?.isFile()) continue;
    const index = await cachedVoyageZipIndex(filePath, info);
    result.push({
      fileName: entry.name,
      bytes: info.size,
      modifiedAt: new Date(info.mtimeMs).toISOString(),
      comment: normalizeComment(index?.comment),
      startedAt: index?.startedAt || null,
      stoppedAt: index?.stoppedAt || null,
      canonicalInput: index?.canonicalInput || null,
      recomputedReplay: index?.recomputedReplay || null,
      observationLog: publicObservationLog(index?.observations),
      downloadUrl: `/plugins/signalk-ajrm-marine-capture/voyages/${encodeURIComponent(entry.name)}/download`,
    });
  }
  return result.sort(compareVoyageBundlesNewestFirst);
}

function compareVoyageBundlesNewestFirst(left, right) {
  const leftVoyageTime = Date.parse(left?.startedAt || "");
  const rightVoyageTime = Date.parse(right?.startedAt || "");
  if (Number.isFinite(leftVoyageTime) && Number.isFinite(rightVoyageTime)) {
    if (leftVoyageTime !== rightVoyageTime) return rightVoyageTime - leftVoyageTime;
  } else if (Number.isFinite(leftVoyageTime)) {
    return -1;
  } else if (Number.isFinite(rightVoyageTime)) {
    return 1;
  }
  const modifiedOrder = String(right?.modifiedAt || "").localeCompare(
    String(left?.modifiedAt || ""),
  );
  if (modifiedOrder !== 0) return modifiedOrder;
  return String(right?.fileName || "").localeCompare(String(left?.fileName || ""));
}

async function cachedVoyageZipIndex(filePath, info) {
  const cacheKey = `${filePath}:${info.size}:${info.mtimeMs}`;
  if (voyageBundleMetadataCache.has(cacheKey)) {
    return voyageBundleMetadataCache.get(cacheKey);
  }
  if (voyageBundleMetadataJobs.has(cacheKey)) {
    return voyageBundleMetadataJobs.get(cacheKey);
  }
  for (const key of voyageBundleMetadataCache.keys()) {
    if (key.startsWith(`${filePath}:`)) voyageBundleMetadataCache.delete(key);
  }
  const job = readVoyageZipIndex(filePath)
    .then((index) => {
      voyageBundleMetadataCache.set(cacheKey, index);
      return index;
    })
    .finally(() => {
      voyageBundleMetadataJobs.delete(cacheKey);
    });
  voyageBundleMetadataJobs.set(cacheKey, job);
  return job;
}

async function readVoyageZipIndex(filePath) {
  return new Promise((resolve) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError || !zip) {
        resolve(null);
        return;
      }
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        zip.close();
        resolve(value);
      };
      zip.once("error", () => finish(null));
      zip.once("end", () => finish(null));
      zip.on("entry", (entry) => {
        if (
          entry.fileName !== "index.json" ||
          /\/$/.test(entry.fileName) ||
          entry.uncompressedSize > MAX_VOYAGE_INDEX_BYTES
        ) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            finish(null);
            return;
          }
          const chunks = [];
          let bytes = 0;
          stream.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes <= MAX_VOYAGE_INDEX_BYTES) chunks.push(chunk);
            else stream.destroy(new Error("Voyage index is too large"));
          });
          stream.once("error", () => finish(null));
          stream.once("end", () => {
            try {
              finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (_error) {
              finish(null);
            }
          });
        });
      });
      zip.readEntry();
    });
  });
}

async function writeDirectoryZip(zipPath, rootDir, { onProgress } = {}) {
  const files = await listFilesForStreamingZip(rootDir);
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const storedGzipEntries = files.filter((file) =>
    file.relativePath.toLowerCase().endsWith(".gz"),
  ).length;
  const partialPath = `${zipPath}.partial`;
  await fs.promises.rm(partialPath, { force: true });
  const output = fs.createWriteStream(partialPath, { flags: "wx" });
  const archive = new ZipArchive({
    zlib: { level: 6 },
  });
  let entriesProcessed = 0;
  let inputBytesProcessed = 0;
  const report = (state, currentEntry = null) => {
    const outputBytes = Number(archive.pointer() || 0);
    const percent = totalBytes > 0
      ? Math.min(100, inputBytesProcessed / totalBytes * 100)
      : state === "complete" ? 100 : 0;
    onProgress?.({
      contract: "ajrm-marine-capture-zip-progress",
      contractVersion: 1,
      state,
      entriesTotal: files.length,
      entriesProcessed,
      inputBytesTotal: totalBytes,
      inputBytesProcessed,
      outputBytes,
      percent,
      currentEntry,
      storedGzipEntries,
      temporaryPath: path.basename(partialPath),
      outputFile: path.basename(zipPath),
    });
  };
  const completed = new Promise((resolve, reject) => {
    output.once("close", resolve);
    output.once("error", reject);
    archive.once("error", reject);
    archive.on("warning", (error) => {
      if (error?.code !== "ENOENT") reject(error);
    });
    archive.on("progress", (progress) => {
      entriesProcessed = Number(progress?.entries?.processed || 0);
      inputBytesProcessed = Number(progress?.fs?.processedBytes || 0);
      report("building");
    });
    archive.on("entry", (entry) => {
      report("building", entry?.name || null);
    });
  });

  try {
    report("building");
    archive.pipe(output);
    for (const file of files) {
      archive.file(file.fullPath, {
        name: file.relativePath,
        store: file.relativePath.toLowerCase().endsWith(".gz"),
      });
    }
    await archive.finalize();
    await completed;
    await fs.promises.rename(partialPath, zipPath);
    entriesProcessed = files.length;
    inputBytesProcessed = totalBytes;
    report("complete");
  } catch (error) {
    archive.abort();
    output.destroy();
    await fs.promises.rm(partialPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function listFilesForStreamingZip(rootDir) {
  const files = [];
  async function visit(directory, prefix = "") {
    const entries = await fs.promises.readdir(directory, {
      withFileTypes: true,
    });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = (
        prefix ? `${prefix}/${entry.name}` : entry.name
      ).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        await visit(fullPath, relativePath);
      } else if (entry.isFile()) {
        const info = await fs.promises.stat(fullPath);
        files.push({
          fullPath,
          relativePath,
          bytes: info.size,
        });
      }
    }
  }
  await visit(rootDir);
  return files;
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
          path: relative.split(path.sep).join("/"),
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

function speedKnotsFromMps(value) {
  const unwrapped = unwrapValue(value);
  if (unwrapped === null || unwrapped === undefined || unwrapped === "") return null;
  const number = Number(unwrapped);
  return Number.isFinite(number) ? Math.max(0, number * MPS_TO_KNOTS) : null;
}

function nextMovementGateState({
  speedKnots,
  voyageState,
  movementSpeedKnots,
  now,
  movingSinceMs,
  stoppedSinceMs,
  autoStartInhibited,
  movementSuppressed = false,
}) {
  if (movementSuppressed) {
    return {
      moving: false,
      movingSinceMs: null,
      stoppedSinceMs: stoppedSinceMs || now,
      autoStartInhibited: autoStartInhibited === true,
    };
  }
  const moving =
    voyageState?.motion === "moving"
      ? true
      : voyageState?.motion === "stationary"
        ? false
        : Number(speedKnots) >= Number(movementSpeedKnots);
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

function normalizeVoyageState(value) {
  const unwrapped = unwrapValue(value);
  if (!unwrapped || typeof unwrapped !== "object") return null;
  const onPassage =
    typeof unwrapped.onPassage === "boolean" ? unwrapped.onPassage : null;
  const motion = ["moving", "stationary", "unknown"].includes(unwrapped.motion)
    ? unwrapped.motion
    : onPassage === true
      ? "moving"
      : onPassage === false
        ? "stationary"
        : "unknown";
  return {
    contract: String(unwrapped.contract || ""),
    onPassage,
    motion,
    source: String(unwrapped.source || "unknown"),
    sogMps: numberOrNull(unwrapped.sogMps),
    stwMps: numberOrNull(unwrapped.stwMps),
    effectiveSpeedMps: numberOrNull(unwrapped.effectiveSpeedMps),
    navigationState: unwrapped.navigationState || null,
    generatedAt: unwrapped.generatedAt || null,
  };
}

function maxFinite(...values) {
  const numbers = values.filter((value) => Number.isFinite(value));
  if (!numbers.length) return null;
  return Math.max(...numbers);
}

function resetMovementGateForVoyageStart() {
  return {
    movingSinceMs: null,
    stoppedSinceMs: null,
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

function defaultVoyageComment({ startedAt = new Date(), profile, harbourName } = {}) {
  const day = dayOfWeek(startedAt);
  const harbour = cleanHarbourName(harbourName);
  if (harbour) return `Departing ${harbour} on ${day}`;
  if (isAnchorageProfile(profile)) return `Departing anchorage on ${day}`;
  return `Departing ${day}`;
}

function dayOfWeek(value) {
  const date = value instanceof Date ? value : new Date(value);
  const safeDate = Number.isFinite(date.getTime()) ? date : new Date();
  return new Intl.DateTimeFormat("en-GB", { weekday: "long" }).format(safeDate);
}

function cleanHarbourName(value) {
  const text = String(value || "")
    .replace(/^harbou?r\s*:\s*/i, "")
    .trim()
    .replace(/\s+/g, " ");
  return text || "";
}

function normalizeTrafficProfile(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "anchored" || text === "anchorage") return "anchor";
  if (text === "harbour") return "harbor";
  return ["anchor", "harbor", "coastal", "offshore"].includes(text) ? text : null;
}

function isAnchorageProfile(value) {
  return normalizeTrafficProfile(value) === "anchor";
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

function safeFilePart(value) {
  return String(value || "event").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "event";
}

function safePathPart(value) {
  return String(value || "event").replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "event";
}

function safeBaseName(value) {
  return path.basename(String(value || ""));
}

function recomputedReplayVerification(recomputedReplay, replayResult) {
  if (
    recomputedReplay?.timingRequired === true &&
    replayResult?.timing?.valid !== true
  ) {
    const rate = replayResult?.timing?.effectiveRate;
    return {
      verified: false,
      failure: Number.isFinite(rate)
        ? `AJRM Marine Capture measured an invalid effective replay rate of ${rate.toFixed(2)}x`
        : "AJRM Marine Capture did not provide valid effective replay timing",
    };
  }
  if (
    replayResult?.coverage?.complete !== true ||
    replayResult?.coverage?.lastReason !== "end of canonical input"
  ) {
    return {
      verified: false,
      failure: "AJRM Marine Capture did not reach canonical input EOF",
    };
  }
  return { verified: true, failure: null };
}

function idlePlaybackStatus() {
  return {
    contract: REPLAY_CONTRACT,
    state: "idle",
    active: false,
    complete: false,
    valid: null,
    requestedRate: 1,
    recordsTotal: 0,
    recordsReplayed: 0,
    sourceDurationMs: 0,
    sourceElapsedMs: 0,
    wallElapsedMs: 0,
    effectiveRate: null,
    effectiveRatio: null,
    startedAt: null,
    completedAt: null,
    error: null,
  };
}

module.exports._private = {
  biteReportOverlapsVoyage,
  cleanHarbourName,
  compareVoyageBundlesNewestFirst,
  defaultVoyageComment,
  drTrackSample,
  nextMovementGateState,
  normalizeOwnContext,
  normalizeObservationText,
  normalizeRouteTimeline,
  normalizeTrafficProfile,
  parseObservationRecords,
  publicObservationLog,
  recomputedReplayVerification,
  resetMovementGateForVoyageStart,
  sanitizeRouteSelection,
  speedKnotsFromMps,
  writeDirectoryZip,
};
