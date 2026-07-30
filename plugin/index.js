const childProcess = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const zlib = require("node:zlib");
const { randomUUID } = require("node:crypto");
const AdmZip = require("adm-zip");
const { ZipArchive } = require("archiver");
const yauzl = require("yauzl");
const packageInfo = require("../package.json");

const MPS_TO_KNOTS = 1.9438444924406046;
const ENGINE_STATIONARY_THRESHOLD_MPS = 0.35;
const ENGINE_STATIONARY_THRESHOLD_KNOTS =
  ENGINE_STATIONARY_THRESHOLD_MPS * MPS_TO_KNOTS;
const AJRM_MARINE_LOGGER_API_REGISTRY = Symbol.for("mcdonaldajr.ajrmMarineLoggerApi");
const AJRM_MARINE_SNAPSHOT_API_REGISTRY = Symbol.for("mcdonaldajr.ajrmMarineSnapshotApi");
const AJRM_MARINE_CAPTURE_API_REGISTRY = Symbol.for("mcdonaldajr.ajrmMarineCaptureApi");
const CAPTURE_MODES = new Set(["minimal", "voyage", "debug"]);
const CAPTURE_FILE_MODES = new Set(["portable", "reference"]);
const POWER_INTENT_PATH = "plugins.ajrmMarinePiController.power.intent";
const AJRM_MARINE_GPS_INTEGRITY_STATE_PATH = "plugins.ajrmMarineGpsIntegrity.navigationIntegrity";
const AJRM_MARINE_TRAFFIC_TARGETS_PATH = "plugins.ajrmMarineTraffic.targets";
const AJRM_MARINE_TRAFFIC_PROFILES_PATH = "plugins.ajrmMarineTraffic.profiles";
const AJRM_MARINE_TRAFFIC_AUTO_PROFILE_PATH = "plugins.ajrmMarineTraffic.autoProfile";
const AJRM_MARINE_TRAFFIC_VOYAGE_STATE_PATH = "plugins.ajrmMarineTraffic.voyageState";
const DR_TRACK_RELATIVE_PATH = "tracks/dr-track.jsonl";
const DR_PLOT_FIXES_RELATIVE_PATH = "tracks/dr-plot-fixes.json";
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
const PORTABLE_DOWNLOAD_DIRECTORY_PREFIX = "ajrm-marine-voyage-download-";
const PORTABLE_DOWNLOAD_STAGING_DIRECTORY = ".portable-download-work";
const voyageBundleMetadataCache = new Map();
const voyageBundleMetadataJobs = new Map();
const DR_PLOTTER_FIXES_FILE = path.join(
  os.homedir(),
  ".signalk",
  "plugin-config-data",
  "signalk-ajrm-marine-dr-plotter",
  "plot-fixes.json",
);
const CONSOLE_BITE_REPORTS_DIRECTORY = path.join(
  os.homedir(),
  ".signalk",
  "plugin-config-data",
  "signalk-ajrm-marine-console",
  "bite-reports",
);
const DEFAULT_LOG_DIRECTORY = "~/AJRMMarineLogs";
const DEFAULT_VOYAGE_DIRECTORY = `${DEFAULT_LOG_DIRECTORY}/voyages`;
const LEGACY_LOG_DIRECTORY = ["~/Capture", "PlusLogs"].join("");
const LEGACY_VOYAGE_DIRECTORY = `${LEGACY_LOG_DIRECTORY}/voyages`;
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
  let loggerPlaybackActive = false;
  let loggerPlayback = null;
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
  let cachedLoggerStatus = null;
  let lastZipProgressPublishMs = 0;
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
        default: DEFAULT_VOYAGE_DIRECTORY,
      },
      ajrmMarineLoggerLogDirectory: {
        type: "string",
        title: "AJRM Marine Logger directory",
        description:
          "Used to copy completed AJRM Marine Logger recordings into the voyage bundle. Keep aligned with AJRM Marine Logger.",
        default: DEFAULT_LOG_DIRECTORY,
      },
      signalKBaseUrl: {
        type: "string",
        title: "Local Signal K base URL",
        description:
          "Used for internal AJRM Marine Logger and AJRM Marine Snapshot calls. Typical values are http://127.0.0.1:3000 or https://127.0.0.1:3443.",
        default: "http://127.0.0.1:3000",
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
      captureBackfillMinutes: {
        type: "integer",
        title: "Logger backfill minutes on voyage start",
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
        title: "Seconds to wait for Logger gzip after stop",
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
    exposeCaptureApi();
    startupRecoveryPromise = Promise.all([
      cleanupPortableDownloadWorkspacesOnStartup(),
      closeIncompleteVoyagesOnStartup(),
    ]).catch((error) => {
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
        const loggerStatus = await getAjrmMarineLoggerStatus();
        const playback = loggerStatus?.playback || {};
        const coverage = playback.coverage || {};
        if (playback.lastError) {
          throw new Error(
            `Logger playback failed: ${playback.lastError.message || "unknown playback error"}. Interrupt the replay to preserve partial evidence.`,
          );
        }
        if (playback.resultCapture?.active !== true) {
          throw new Error(
            "Logger's replay-result recorder is no longer active. Interrupt the replay to preserve partial evidence.",
          );
        }
        const playbackIncomplete =
          playback.active ||
          playback.paused ||
          coverage.complete !== true ||
          coverage.preparedComplete !== true ||
          (playback.lastReason || coverage.lastReason) !== "end of capture";
        if (playbackIncomplete) {
          throw new Error(
            "Let Logger reach the end before building the recomputed voyage ZIP",
          );
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

  return plugin;

  function normalizeOptions(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      enabled: source.enabled === true,
      voyageDirectory: expandHome(source.voyageDirectory || defaultVoyageDirectory()),
      ajrmMarineLoggerLogDirectory: expandHome(source.ajrmMarineLoggerLogDirectory || defaultLoggerDirectory()),
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

  function defaultLoggerDirectory() {
    const preferred = expandHome(DEFAULT_LOG_DIRECTORY);
    const legacy = expandHome(LEGACY_LOG_DIRECTORY);
    return !fs.existsSync(preferred) && fs.existsSync(legacy) ? LEGACY_LOG_DIRECTORY : DEFAULT_LOG_DIRECTORY;
  }

  function defaultVoyageDirectory() {
    const preferred = expandHome(DEFAULT_VOYAGE_DIRECTORY);
    const legacy = expandHome(LEGACY_VOYAGE_DIRECTORY);
    return !fs.existsSync(preferred) && fs.existsSync(legacy) ? LEGACY_VOYAGE_DIRECTORY : DEFAULT_VOYAGE_DIRECTORY;
  }

  function ensureDirectories() {
    fs.mkdirSync(options.voyageDirectory, { recursive: true });
  }

  function portableDownloadStagingRoot() {
    return path.join(options.voyageDirectory, PORTABLE_DOWNLOAD_STAGING_DIRECTORY);
  }

  async function cleanupPortableDownloadWorkspacesOnStartup() {
    const removed = await cleanupPortableDownloadWorkspaces([
      os.tmpdir(),
      portableDownloadStagingRoot(),
    ]);
    if (removed) {
      addEvent(
        "portable-download-recovery",
        `Removed ${removed} abandoned portable voyage download workspace${removed === 1 ? "" : "s"}`,
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
    const updates = Array.isArray(delta?.updates) ? delta.updates : [];
    if (handlePowerIntent(updates)) return;
    updates.forEach((update) => {
      const context = update.context || delta.context || "vessels.self";
      if (!isSelfContext(context)) return;
      (update.values || []).forEach((entry) => {
        if (entry.path === "plugins.ajrmMarineLogger.playback") {
          updateLoggerPlaybackState(entry.value);
        } else if (entry.path === "navigation.speedOverGround") {
          if (loggerPlaybackActive) {
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

  function updateLoggerPlaybackState(value) {
    const playback = unwrapValue(value);
    loggerPlayback = playback && typeof playback === "object" ? playback : null;
    const active = playback?.active === true || playback?.playing === true;
    if (active) {
      loggerPlaybackActive = true;
      movementSuppressedUntilFreshSpeed = true;
      movingSinceMs = null;
      return;
    }
    if (loggerPlaybackActive) {
      speedKnots = null;
      movingSinceMs = null;
      stoppedSinceMs = Date.now();
      movementSuppressedUntilFreshSpeed = true;
    }
    loggerPlaybackActive = false;
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
      movementSuppressed: loggerPlaybackActive || movementSuppressedUntilFreshSpeed,
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
    if (loggerPlaybackActive || movementSuppressedUntilFreshSpeed) return;
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
      async startRecomputedReplay({ comment } = {}) {
        return startRecomputedReplayVoyage({ comment });
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
    const temporaryBundle = await buildPortableDownloadBundle(
      filePath,
      fileName,
      portableDownloadStagingRoot(),
    );
    let cleaned = false;
    return {
      fileName,
      path: temporaryBundle?.path || filePath,
      temporaryBundle,
      async cleanup() {
        if (!cleaned && temporaryBundle?.directory) {
          cleaned = true;
          await fs.promises.rm(temporaryBundle.directory, { recursive: true, force: true }).catch(() => {});
        }
      },
    };
  }

  async function setAutomaticRecordingEnabled(enabled) {
    const nextEnabled = enabled === true;
    await persistPluginConfiguration({ enabled: nextEnabled });
    options.enabled = nextEnabled;
    addEvent("settings", `Automatic voyage recording ${options.enabled ? "enabled" : "disabled"}`);
    publishState();
  }

  async function startRecomputedReplayVoyage({ comment } = {}) {
    if (currentVoyage) return summarizeVoyage(currentVoyage);
    const loggerStatus = await getAjrmMarineLoggerStatus();
    const playback = loggerStatus?.playback;
    if (!playback?.loaded) {
      throw new Error("Load the parent voyage in AJRM Marine Logger first");
    }
    if (playback.mode !== "sensor-sources") {
      throw new Error("Select Sensor sources only playback in AJRM Marine Logger first");
    }
    if (playback.sourcePolicy?.id !== "strict-recorded-sensor-source-allowlist-v1") {
      throw new Error("AJRM Marine Logger did not publish the strict sensor source policy");
    }
    const resolvedSensorSourceIds =
      playback.sourcePolicy.resolvedSensorSourceIds ||
      playback.sourcePolicy.sensorSourceIds;
    if (!Array.isArray(resolvedSensorSourceIds) ||
        !resolvedSensorSourceIds.length) {
      throw new Error("Select at least one exact recorded sensor source ID");
    }
    if (playback.rate !== 1) {
      throw new Error("Select 1x playback in AJRM Marine Logger first");
    }
    if (playback.lastError) {
      throw new Error(
        "Reload the parent voyage in AJRM Marine Logger to clear the previous playback error",
      );
    }
    const parentVoyage =
      playback.voyageFileName || playback.displayFileName || playback.fileName;
    const recomputedReplay = {
      schemaVersion: 1,
      kind: "recomputed-replay",
      parentVoyage,
      playbackFileName: playback.fileName,
      displayFileName: playback.displayFileName || playback.fileName,
      sourceKind: playback.sourceKind,
      playbackMode: playback.replayMode || playback.mode,
      rate: playback.rate,
      sourcePolicy: playback.sourcePolicy,
      sourceCatalog: playback.sourceCatalog || {},
      originalFrom: playback.captureFrom || playback.from,
      originalTo: playback.captureTo || playback.to,
      originalVoyageStartedAt: playback.voyageStartedAt || null,
      startedOriginalAt: playback.originalCapturedAt || playback.current || null,
      sourceFilterStatsAtStart: playback.sourceFilterStats || null,
      liveInputIsolationRequired: true,
      liveInputIsolationAtStart: playback.liveInputIsolation || null,
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
        "Use Stop and build ZIP after Logger reaches complete sensor-only replay coverage",
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
    if (loggerPlaybackActive && !startOptions.recomputedReplay) {
      throw new Error("Use Start recomputed replay while Logger playback is active");
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
    const id = `voyage-${formatFileTime(startedAt)}`;
    const directory = path.join(options.voyageDirectory, id);
    await fs.promises.mkdir(path.join(directory, "snapshots"), { recursive: true });
    await fs.promises.mkdir(path.join(directory, "capture"), { recursive: true });
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
      snapshotCount: 0,
      captureMode: startOptions.recomputedReplay ? "voyage" : options.captureMode,
      captureFileMode: startOptions.recomputedReplay ? "portable" : options.captureFileMode,
      recomputedReplay: startOptions.recomputedReplay || null,
      ajrmMarineLogger: null,
      events: [],
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
    nextVoyageComment = "";
    addVoyageEvent("start", reason);
    publishNotification({
      voyageId: id,
      leaf: "start",
      message: "Voyage recording started.",
      state: "alert",
    });
    addEvent("voyage-started", `${id}: ${reason}`);

    currentVoyage.ajrmMarineLogger = await callAjrmMarineLogger(
      currentVoyage.recomputedReplay
        ? "/playback/result-capture/start"
        : "/capture/start",
      currentVoyage.recomputedReplay
        ? {
            parentVoyage: currentVoyage.recomputedReplay.parentVoyage,
            requestedBy: plugin.id,
          }
        : { backfillMinutes: options.captureBackfillMinutes },
    ).catch((error) => ({ ok: false, error: error.message }));
    if (!currentVoyage.ajrmMarineLogger?.ok) {
      const message = currentVoyage.ajrmMarineLogger?.error ||
        "AJRM Marine Logger did not start";
      const failedVoyage = currentVoyage;
      await closeDrTrack(failedVoyage, new Date().toISOString()).catch(() => {});
      await fs.promises.rm(failedVoyage.directory, { recursive: true, force: true })
        .catch(() => {});
      currentVoyage = null;
      throw new Error(message);
    }
    if (currentVoyage.recomputedReplay) {
      const playbackStart = await callAjrmMarineLogger(
        "/playback/play",
        { rate: 1 },
      ).catch((error) => ({ ok: false, error: error.message }));
      if (!playbackStart?.ok) {
        const playbackError =
          playbackStart?.error || "AJRM Marine Logger playback did not start";
        let abortedBundle = null;
        let abortError = null;
        try {
          abortedBundle = await abortRecomputedReplayVoyage(
            `Logger playback failed to start: ${playbackError}`,
          );
        } catch (error) {
          abortError = error;
        }
        if (abortedBundle) {
          throw new Error(
            `${playbackError}. The armed result capture was aborted and saved as incomplete, unverified ZIP ${abortedBundle.fileName}.`,
          );
        }
        throw new Error(
          `${playbackError}. Capture could not safely abort the armed result recorder: ${abortError?.message || "unknown abort failure"}. Use Interrupt replay or restart Signal K.`,
        );
      }
      currentVoyage.ajrmMarineLogger = {
        ...currentVoyage.ajrmMarineLogger,
        playbackStart,
      };
      currentVoyage.recomputedReplay = {
        ...currentVoyage.recomputedReplay,
        playbackStartedAutomatically: true,
        playbackStartedAt: new Date().toISOString(),
      };
      addVoyageEvent(
        "replay-started",
        "Logger sensor-only playback started automatically at 1x",
      );
      addEvent(
        "replay-started",
        `${currentVoyage.id}: Logger playback started automatically at 1x`,
      );
    }
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
      updateFinalisation("closing-logger", {
        message: "Closing AJRM Marine Logger recorder",
      });
      const captureStop = voyage.captureStop?.ok
        ? voyage.captureStop
        : await callAjrmMarineLogger(
            voyage.recomputedReplay
              ? "/playback/result-capture/stop"
              : "/capture/stop",
            {},
          ).catch((error) => ({
            ok: false,
            error: error.message,
          }));
      voyage.captureStop = captureStop;
      if (!captureStop?.ok) {
        throw new Error(
          captureStop?.error ||
          "AJRM Marine Logger did not close the voyage capture",
        );
      }
      finalisation.loggerClosed = true;
      finalisation.loggerClosedAt = new Date().toISOString();
      if (voyage.recomputedReplay) {
        const replayResult = captureStop?.recording?.replayResult || null;
        const resultSegments = validateRecomputedResultSegmentManifest(
          replayResult?.resultSegments,
        );
        if (
          !replayResult ||
          replayResult.coverage?.complete !== true ||
          replayResult.coverage?.preparedComplete !== true ||
          replayResult.coverage?.lastReason !== "end of capture" ||
          replayResult.coverage?.resultSegmentsComplete !== true ||
          resultSegments.complete !== true
        ) {
          throw new Error(
            "AJRM Marine Logger did not confirm complete replay coverage and result segments",
          );
        }
        voyage.recomputedReplay = {
          ...voyage.recomputedReplay,
          status: "complete",
          complete: true,
          incomplete: false,
          verified: true,
          rate: replayResult?.rate ?? voyage.recomputedReplay.rate,
          sourcePolicy:
            replayResult?.sourcePolicy || voyage.recomputedReplay.sourcePolicy,
          sourceCatalog:
            replayResult?.sourceCatalog || voyage.recomputedReplay.sourceCatalog,
          completedAt: new Date().toISOString(),
          result: replayResult,
        };
        voyage.incomplete = false;
        voyage.recomputationVerified = true;
        voyage.aborted = false;
        await writeRecomputedCompletionCheckpoint(voyage, replayResult);
      }
      const stoppedAt = new Date().toISOString();
      voyage.stoppedAt = stoppedAt;
      voyage.stopReason = reason;
      updateFinalisation("collecting-evidence", {
        message: "Copying completed capture segments and voyage evidence",
      });
      await closeDrTrack(voyage, stoppedAt);
      await copyDrPlotFixes(voyage);
      await copyConsoleBiteReports(voyage);
      await copyCaptureFiles(voyage, captureStop);
      if (
        voyage.recomputedReplay &&
        (!Array.isArray(voyage.captureFiles) || !voyage.captureFiles.length)
      ) {
        throw new Error(
          "No recomputed AJRM Marine Logger capture was copied; portable ZIP creation stopped",
        );
      }
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
      loggerClosed: false,
      loggerClosedAt: null,
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
    { completedAt = new Date().toISOString() } = {},
  ) {
    const checkpoint = {
      contract: "ajrm-marine-recomputed-completion",
      contractVersion: 1,
      voyageId: voyage.id,
      completedAt,
      verified: true,
      recomputationVerified: true,
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
    finalisation.recomputationVerified = true;
    finalisation.checkpoint = RECOMPUTED_COMPLETION_RELATIVE_PATH;
    updateFinalisation("logger-closed", {
      message: "Logger closed; recomputation completion checkpoint saved",
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
      const captureStop = await callAjrmMarineLogger(
        "/playback/result-capture/abort",
        { reason },
      ).catch((error) => ({
        ok: false,
        error: error.message,
      }));
      voyage.captureStop = captureStop;
      if (!captureStop?.ok) {
        throw new Error(
          captureStop?.error ||
          "AJRM Marine Logger did not safely abort the recomputed replay capture",
        );
      }

      const stoppedAt = new Date().toISOString();
      const replayResult = markReplayResultIncomplete(
        captureStop?.recording?.replayResult,
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
      await copyDrPlotFixes(voyage);
      await copyConsoleBiteReports(voyage);
      await copyIncompleteRecomputedCaptureFiles(voyage, captureStop);
      if (!voyage.captureFiles.length) {
        appendVoyageEvent(
          voyage,
          "capture-copy-warning",
          "The interrupted replay produced no non-empty partial Logger segments",
        );
      }
      await writeJson(
        path.join(voyage.directory, "system", "replay-abort-status.json"),
        {
          ok: true,
          abortedAt: stoppedAt,
          reason,
          incomplete: true,
          verified: false,
          captureFiles: voyage.captureFiles,
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
    await fs.promises.mkdir(path.join(directory, "capture"), { recursive: true });
    await fs.promises.mkdir(
      path.join(directory, OBSERVATION_EVIDENCE_DIRECTORY),
      { recursive: true },
    );
    const existingIndex = await readJson(path.join(directory, "index.json"));
    const completionCheckpoint = await readJson(
      path.join(directory, RECOMPUTED_COMPLETION_RELATIVE_PATH),
    );
    const completedRecomputation = verifiedRecomputedCompletion(
      id,
      completionCheckpoint,
      existingIndex,
    );
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
      recomputedReplay: existingIndex?.recomputedReplay || null,
      ajrmMarineLogger: existingIndex?.ajrmMarineLogger?.start || null,
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
      captureFiles: await listCaptureFileNames(path.join(directory, "capture")),
      captureReferences: Array.isArray(existingIndex?.captureReferences) && existingIndex.captureReferences.length
        ? existingIndex.captureReferences
        : initialCaptureReferencesFromStart(existingIndex),
      observations: await rebuildObservationLog(
        directory,
        existingIndex?.observations,
      ),
      events: Array.isArray(existingIndex?.events) ? existingIndex.events.slice(0, 200) : [],
      recoveredAt: now,
      interruptedByRestart: true,
    };
    if (completedRecomputation) {
      voyage.stopReason =
        "Signal K restarted after Logger completed; portable ZIP finalisation recovered";
      voyage.incomplete = false;
      voyage.recomputationVerified = true;
      voyage.recomputedReplay = {
        ...voyage.recomputedReplay,
        ...completedRecomputation.recomputedReplay,
        status: "complete",
        complete: true,
        incomplete: false,
        verified: true,
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
    if (
      completedRecomputation?.source === "legacy-normal-stop-evidence"
    ) {
      await writeRecomputedCompletionCheckpoint(
        voyage,
        completedRecomputation.result,
        { completedAt: completedRecomputation.completedAt },
      );
    }
    finalisation.loggerClosed = true;
    finalisation.loggerClosedAt =
      completedRecomputation?.completedAt || now;
    finalisation.recomputationVerified = Boolean(completedRecomputation);
    updateFinalisation("recovery", {
      message: completedRecomputation
        ? "Recovering completed recomputation ZIP finalisation"
        : "Packaging interrupted voyage evidence",
    });
    appendVoyageEvent(voyage, "recovered", "Voyage closed at startup after Signal K restart");
    if (voyage.recomputedReplay && !completedRecomputation) {
      await copyIncompleteRecomputedCaptureFiles(voyage, voyage.captureStop);
    } else {
      await copyCaptureFiles(voyage, voyage.captureStop);
    }
    if (!voyage.captureFiles.length && !voyage.captureReferences.length) {
      appendVoyageEvent(
        voyage,
        "capture-reference-warning",
        "No AJRM Marine Logger segments matched the recovered voyage range",
      );
    }
    await copyDrPlotFixes(voyage);
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
      captureFiles: voyage.captureFiles,
      note: completedRecomputation
        ? "Logger had already completed and verified the recomputed replay. Capture resumed only the later evidence and ZIP finalisation work."
        : "This voyage was not resumed because Signal K was stopped or restarted before normal voyage shutdown.",
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
        : `${id}: closed incomplete voyage after startup`,
    );
    logInfo(
      completedRecomputation
        ? `${id} completed ZIP finalisation recovered after startup`
        : `${id} closed as incomplete voyage after startup`,
    );
    publishState();
    return bundle;
  }

  function verifiedRecomputedCompletion(
    voyageId,
    checkpoint,
    existingIndex,
  ) {
    const candidates = [];
    if (
      checkpoint?.contract === "ajrm-marine-recomputed-completion" &&
      checkpoint?.contractVersion === 1 &&
      checkpoint?.voyageId === voyageId &&
      checkpoint?.verified === true &&
      checkpoint?.recomputationVerified === true
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
      existingIndex?.recomputationVerified === true &&
      existingIndex?.recomputedReplay?.complete === true &&
      existingIndex?.recomputedReplay?.verified === true
    ) {
      candidates.push({
        source: "completed-index",
        completedAt: existingIndex.recomputedReplay.completedAt,
        recomputedReplay: existingIndex.recomputedReplay,
        result: existingIndex.recomputedReplay.result,
      });
    }
    const legacyCompletion = legacyNormalStopCompletion(
      voyageId,
      existingIndex,
    );
    if (legacyCompletion) candidates.push(legacyCompletion);
    for (const candidate of candidates) {
      const result = candidate.result;
      try {
        validateRecomputedResultSegmentManifest(result?.resultSegments);
      } catch {
        continue;
      }
      if (
        result?.coverage?.complete !== true ||
        result?.coverage?.preparedComplete !== true ||
        result?.coverage?.lastReason !== "end of capture" ||
        result?.coverage?.resultSegmentsComplete !== true
      ) {
        continue;
      }
      return candidate;
    }
    return null;
  }

  function legacyNormalStopCompletion(voyageId, existingIndex) {
    if (
      existingIndex?.version !== "0.6.8" ||
      existingIndex?.id !== voyageId ||
      existingIndex?.incomplete !== true ||
      existingIndex?.interruptedByRestart !== true ||
      existingIndex?.captureFileMode !== "portable" ||
      existingIndex?.recomputedReplay?.kind !== "recomputed-replay"
    ) {
      return null;
    }
    const events = Array.isArray(existingIndex.events)
      ? existingIndex.events
      : [];
    const normalStop = events
      .filter(
        (event) =>
          event?.type === "stop" &&
          event?.message === "recomputed replay capture stopped" &&
          Number.isFinite(Date.parse(event?.at)),
      )
      .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0];
    const firstRecoveryAt = events
      .filter(
        (event) =>
          event?.type === "recovered" &&
          Number.isFinite(Date.parse(event?.at)),
      )
      .map((event) => Date.parse(event.at))
      .sort((left, right) => left - right)[0];
    if (
      !normalStop ||
      !Number.isFinite(firstRecoveryAt) ||
      Date.parse(normalStop.at) >= firstRecoveryAt
    ) {
      return null;
    }
    const sourceResult = existingIndex.recomputedReplay.result;
    const coverage = sourceResult?.coverage;
    const sourceManifest = sourceResult?.resultSegments;
    const coverageSegments = Array.isArray(coverage?.segments)
      ? coverage.segments
      : [];
    const resultSegments = Array.isArray(sourceManifest?.segments)
      ? sourceManifest.segments
      : [];
    if (
      sourceResult?.aborted === true ||
      sourceManifest?.aborted === true ||
      sourceManifest?.incomplete === true ||
      (Array.isArray(sourceManifest?.errors) &&
        sourceManifest.errors.length > 0) ||
      coverage?.inputComplete !== true ||
      coverage?.preparedComplete !== true ||
      coverage?.lastReason !== "end of capture" ||
      Number(coverage?.cursor) !== Number(coverage?.totalLines) ||
      Number(coverage?.replayedLines) !== Number(coverage?.replayableLines) ||
      Number(coverage?.segmentsCompleted) !== Number(coverage?.segmentsTotal) ||
      coverageSegments.length === 0 ||
      coverageSegments.some((segment) => segment?.complete !== true) ||
      resultSegments.length === 0
    ) {
      return null;
    }
    const result = {
      ...sourceResult,
      incomplete: false,
      interruptedByRestart: false,
      interruptionReason: null,
      coverage: {
        ...coverage,
        complete: true,
        resultSegmentsComplete: true,
      },
      resultSegments: {
        ...sourceManifest,
        complete: true,
      },
    };
    return {
      source: "legacy-normal-stop-evidence",
      completedAt: normalStop.at,
      recomputedReplay: {
        ...existingIndex.recomputedReplay,
        completedAt: normalStop.at,
        legacyCompletionEvidence: true,
        result,
      },
      result,
    };
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
    const query = [
      `snapshotPreset=${encodeURIComponent(snapshotPreset)}`,
    ].join("&");
    return httpJson("GET", `${options.signalKBaseUrl}/plugins/signalk-ajrm-marine-snapshot/snapshot?${query}`);
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
    const status = await getAjrmMarineLoggerStatus().catch(() => null);
    const playback =
      status?.playback && typeof status.playback === "object"
        ? status.playback
        : loggerPlayback;
    const explicitOriginalCapturedAt = normalizeIsoTimestamp(
      playback?.originalCapturedAt,
    );
    if (explicitOriginalCapturedAt) {
      return {
        timestamp: explicitOriginalCapturedAt,
        source: "logger.playback.originalCapturedAt",
      };
    }
    const explicitCursorTime = normalizeIsoTimestamp(playback?.current);
    if (explicitCursorTime) {
      return {
        timestamp: explicitCursorTime,
        source: "logger.playback.current",
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

  async function copyCaptureFiles(voyage, captureStop) {
    const capturesDir = ajrmMarineLoggerCapturesDir();
    if (voyage.recomputedReplay) {
      const manifest = validateRecomputedResultSegmentManifest(
        captureStop?.recording?.replayResult?.resultSegments,
      );
      const segments = manifest.segments;
      voyage.captureReferences = segments.map((segment) =>
        captureReference(capturesDir, segment),
      );
      const copied = [];
      for (const segment of segments) {
        const copiedName = await copyDeclaredReplayResultSegment(
          capturesDir,
          segment,
          voyage.directory,
        );
        copied.push(copiedName);
        addVoyageEvent("capture-copied", copiedName);
      }
      voyage.captureFiles = copied;
      return;
    }
    const status = voyage.captureFileMode === "reference"
      ? await getAjrmMarineLoggerStatus()
      : await waitForAjrmMarineLoggerCompression(capturesDir, voyage, captureStop);
    const segments = captureSegmentsForVoyage(status, voyage, captureStop);
    voyage.captureReferences = segments.map((segment) =>
      captureReference(capturesDir, segment),
    );
    if (voyage.captureFileMode === "reference") {
      voyage.captureFiles = [];
      addVoyageEvent(
        "capture-referenced",
        `${segments.length} AJRM Marine Logger segment${segments.length === 1 ? "" : "s"} referenced without copying`,
      );
      if (!segments.length) addVoyageEvent("capture-copy-warning", "No AJRM Marine Logger segments matched voyage range");
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
    if (!copied.length) addVoyageEvent("capture-copy-warning", "No AJRM Marine Logger segments matched voyage range");
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

  async function copyIncompleteRecomputedCaptureFiles(voyage, captureStop) {
    const capturesDir = ajrmMarineLoggerCapturesDir();
    const captureDirectory = path.join(voyage.directory, "capture");
    await fs.promises.mkdir(captureDirectory, { recursive: true });
    const existingNames = await listCaptureFileNames(captureDirectory);
    const copiedByLogicalName = new Map(
      existingNames.map((fileName) => [logicalCaptureFileName(fileName), fileName]),
    );
    const referencesByLogicalName = new Map();
    for (const reference of Array.isArray(voyage.captureReferences)
      ? voyage.captureReferences
      : []) {
      if (!isSafeCaptureFileName(reference?.fileName)) continue;
      referencesByLogicalName.set(
        logicalCaptureFileName(reference.fileName),
        reference,
      );
    }

    const replayResult =
      captureStop?.recording?.replayResult ||
      voyage.recomputedReplay?.result ||
      null;
    const declaredSegments = incompleteReplayResultSegments(
      replayResult?.resultSegments,
      voyage,
    );
    for (const segment of declaredSegments) {
      const logicalName = logicalCaptureFileName(segment.fileName);
      referencesByLogicalName.set(
        logicalName,
        captureReference(capturesDir, segment),
      );
      if (copiedByLogicalName.has(logicalName)) continue;
      const copiedName = await copyStableIncompleteReplayCandidate(
        capturesDir,
        segment.fileName,
        voyage.directory,
        Number(segment.bytes || 0),
      );
      if (copiedName) {
        copiedByLogicalName.set(logicalName, copiedName);
        appendVoyageEvent(voyage, "capture-copied", copiedName);
      } else {
        appendVoyageEvent(
          voyage,
          "capture-copy-warning",
          `Declared partial replay segment was unavailable or changed: ${segment.fileName}`,
        );
      }
    }

    const recoveredSegments = await incompleteReplayCaptureCandidates(
      capturesDir,
      voyage,
      captureStop,
      replayResult,
    );
    for (const segment of recoveredSegments) {
      const logicalName = logicalCaptureFileName(segment.fileName);
      if (!referencesByLogicalName.has(logicalName)) {
        referencesByLogicalName.set(
          logicalName,
          captureReference(capturesDir, segment),
        );
      }
      if (copiedByLogicalName.has(logicalName)) continue;
      const copiedName = await copyStableIncompleteReplayCandidate(
        capturesDir,
        segment.fileName,
        voyage.directory,
        Number(segment.bytes || 0),
      );
      if (!copiedName) {
        appendVoyageEvent(
          voyage,
          "capture-copy-warning",
          `Partial replay segment was unavailable or changed: ${segment.fileName}`,
        );
        continue;
      }
      copiedByLogicalName.set(logicalName, copiedName);
      appendVoyageEvent(voyage, "capture-copied", copiedName);
    }

    voyage.captureFiles = Array.from(copiedByLogicalName.values())
      .sort((left, right) => left.localeCompare(right));
    voyage.captureReferences = Array.from(referencesByLogicalName.values())
      .sort((left, right) =>
        String(left?.fileName || "").localeCompare(
          String(right?.fileName || ""),
        ),
      );
    voyage.recomputedReplay = {
      ...voyage.recomputedReplay,
      partialCaptureRecovery: {
        schemaVersion: 1,
        verified: false,
        declaredPartialManifestAvailable:
          Boolean(replayResult?.resultSegments) &&
          declaredSegments.length > 0,
        selectionMethod:
          declaredSegments.length > 0
            ? "finalized-declared-segments-plus-bounded-recovery"
            : "known-name-or-strict-voyage-wall-time-window",
        captureFiles: voyage.captureFiles,
      },
    };
  }

  function incompleteReplayResultSegments(manifest, voyage) {
    if (!manifest || typeof manifest !== "object") return [];
    const segments = [];
    const logicalNames = new Set();
    for (const segment of Array.isArray(manifest.segments)
      ? manifest.segments
      : []) {
      const fileName = String(segment?.fileName || "");
      if (!isSafeCaptureFileName(fileName)) {
        appendVoyageEvent(
          voyage,
          "capture-copy-warning",
          "Logger declared an unsafe partial replay segment name; it was not copied",
        );
        continue;
      }
      if (
        segment.finalized !== true ||
        segment.available !== true ||
        Number(segment.bytes || 0) <= 0 ||
        Number(segment.lines || 0) <= 0
      ) {
        appendVoyageEvent(
          voyage,
          "capture-copy-warning",
          `Logger did not finalise partial replay segment ${fileName}; it was not trusted as a declared segment`,
        );
        continue;
      }
      const logicalName = logicalCaptureFileName(fileName);
      if (logicalNames.has(logicalName)) {
        appendVoyageEvent(
          voyage,
          "capture-copy-warning",
          `Logger declared duplicate partial replay segment ${fileName}; the duplicate was ignored`,
        );
        continue;
      }
      logicalNames.add(logicalName);
      segments.push(segment);
    }
    return segments;
  }

  async function incompleteReplayCaptureCandidates(
    capturesDir,
    voyage,
    captureStop,
    replayResult,
  ) {
    const knownLogicalNames = new Set();
    const rememberKnownName = (value) => {
      const fileName = String(value || "");
      if (isSafeCaptureFileName(fileName)) {
        knownLogicalNames.add(logicalCaptureFileName(fileName));
      }
    };
    rememberKnownName(voyage.ajrmMarineLogger?.recording?.fileName);
    rememberKnownName(voyage.ajrmMarineLogger?.fileName);
    rememberKnownName(captureStop?.recording?.fileName);
    for (const reference of Array.isArray(voyage.captureReferences)
      ? voyage.captureReferences
      : []) {
      rememberKnownName(reference?.fileName);
    }
    for (const segment of Array.isArray(replayResult?.resultSegments?.segments)
      ? replayResult.resultSegments.segments
      : []) {
      rememberKnownName(segment?.fileName);
    }

    const startedAt =
      voyage.ajrmMarineLogger?.recording?.startedAt ||
      voyage.ajrmMarineLogger?.recording?.from ||
      voyage.ajrmMarineLogger?.startedAt ||
      voyage.startedAt;
    const fromMs = Date.parse(startedAt || "");
    const toMs = Date.parse(voyage.stoppedAt || "");
    const entries = await fs.promises.readdir(capturesDir, {
      withFileTypes: true,
    }).catch(() => []);
    const byLogicalName = new Map();
    for (const entry of entries) {
      if (!entry.isFile() || !isSafeCaptureFileName(entry.name)) continue;
      const logicalName = logicalCaptureFileName(entry.name);
      const fileStartedAtMs = Date.parse(
        recordingStartedAtFromFileName(entry.name),
      );
      const isKnown = knownLogicalNames.has(logicalName);
      const isStrictlyInsideVoyage =
        Number.isFinite(fromMs) &&
        Number.isFinite(toMs) &&
        Number.isFinite(fileStartedAtMs) &&
        fileStartedAtMs >= fromMs - 5000 &&
        fileStartedAtMs <= toMs + 5000;
      if (!isKnown && !isStrictlyInsideVoyage) continue;
      const fullPath = path.join(capturesDir, entry.name);
      const info = await fs.promises.stat(fullPath).catch(() => null);
      if (!info?.isFile() || info.size <= 0) continue;
      const segment = {
        fileName: entry.name,
        from: recordingStartedAtFromFileName(entry.name) || null,
        to: new Date(info.mtimeMs).toISOString(),
        bytes: info.size,
        compressed: entry.name.endsWith(".gz"),
      };
      const existing = byLogicalName.get(logicalName);
      if (!existing || shouldPreferCaptureSegment(segment, existing)) {
        byLogicalName.set(logicalName, segment);
      }
    }
    return Array.from(byLogicalName.values())
      .sort((left, right) => left.fileName.localeCompare(right.fileName));
  }

  async function copyStableIncompleteReplayCandidate(
    capturesDir,
    fileName,
    voyageDirectory,
    expectedBytes,
  ) {
    if (!isSafeCaptureFileName(fileName)) return null;
    const logicalName = logicalCaptureFileName(fileName);
    const candidateNames = fileName.endsWith(".gz")
      ? [fileName, logicalName]
      : [`${fileName}.gz`, fileName];
    for (const candidate of candidateNames) {
      if (!isSafeCaptureFileName(candidate)) continue;
      const source = path.join(capturesDir, candidate);
      const before = await fs.promises.stat(source).catch(() => null);
      if (!before?.isFile() || before.size <= 0) continue;
      if (
        Number(expectedBytes || 0) > 0 &&
        candidate === fileName &&
        before.size !== Number(expectedBytes)
      ) {
        continue;
      }
      const target = path.join(voyageDirectory, "capture", candidate);
      const existing = await fs.promises.stat(target).catch(() => null);
      if (existing?.isFile() && existing.size === before.size) return candidate;
      const temporary = `${target}.partial-${randomUUID()}`;
      try {
        await fs.promises.copyFile(source, temporary);
        const [after, copied] = await Promise.all([
          fs.promises.stat(source).catch(() => null),
          fs.promises.stat(temporary).catch(() => null),
        ]);
        if (
          !after?.isFile() ||
          !copied?.isFile() ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          copied.size !== before.size
        ) {
          await fs.promises.unlink(temporary).catch(() => {});
          continue;
        }
        await fs.promises.rename(temporary, target);
        return candidate;
      } catch (_error) {
        await fs.promises.unlink(temporary).catch(() => {});
      }
    }
    return null;
  }

  function isSafeCaptureFileName(value) {
    const fileName = String(value || "");
    return (
      fileName.length > 0 &&
      path.basename(fileName) === fileName &&
      /^capture-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.jsonl(?:\.gz)?$/i.test(
        fileName,
      )
    );
  }

  function validateRecomputedResultSegmentManifest(manifest) {
    if (!manifest || typeof manifest !== "object") {
      throw new Error("AJRM Marine Logger did not declare recomputed result segments");
    }
    const segments = Array.isArray(manifest.segments) ? manifest.segments : [];
    const exactNames = new Set();
    const logicalNames = new Set();
    for (const segment of segments) {
      const fileName = String(segment?.fileName || "");
      if (
        !fileName ||
        path.basename(fileName) !== fileName ||
        !/\.jsonl(?:\.gz)?$/i.test(fileName) ||
        segment.finalized !== true ||
        segment.available !== true ||
        Number(segment.lines || 0) <= 0 ||
        Number(segment.bytes || 0) <= 0
      ) {
        throw new Error("AJRM Marine Logger declared an invalid recomputed result segment");
      }
      const logicalName = logicalCaptureFileName(fileName);
      if (exactNames.has(fileName) || logicalNames.has(logicalName)) {
        throw new Error(`AJRM Marine Logger declared duplicate result segment ${fileName}`);
      }
      exactNames.add(fileName);
      logicalNames.add(logicalName);
    }
    if (
      manifest.complete !== true ||
      segments.length === 0 ||
      Number(manifest.segmentsTotal) !== segments.length ||
      Number(manifest.segmentsFinalized) !== segments.length ||
      Number(manifest.lines) !== segments.reduce(
        (total, segment) => total + Number(segment.lines || 0),
        0,
      ) ||
      Number(manifest.bytes) !== segments.reduce(
        (total, segment) => total + Number(segment.bytes || 0),
        0,
      )
    ) {
      throw new Error("AJRM Marine Logger result segment manifest is incomplete");
    }
    return manifest;
  }

  async function copyDeclaredReplayResultSegment(
    capturesDir,
    segment,
    voyageDirectory,
  ) {
    const target = path.join(
      voyageDirectory,
      "capture",
      segment.fileName,
    );
    const expectedBytes = Number(segment.bytes || 0);
    const existingTarget = await fs.promises.stat(target).catch(() => null);
    if (
      existingTarget?.isFile() &&
      existingTarget.size === expectedBytes
    ) {
      return segment.fileName;
    }
    const source = path.join(capturesDir, segment.fileName);
    const sourceInfo = await fs.promises.stat(source).catch(() => null);
    if (
      !sourceInfo?.isFile() ||
      sourceInfo.size <= 0 ||
      sourceInfo.size !== expectedBytes
    ) {
      throw new Error(
        `Declared recomputed result segment is missing or changed: ${segment.fileName}`,
      );
    }
    await fs.promises.copyFile(source, target);
    const targetInfo = await fs.promises.stat(target).catch(() => null);
    if (!targetInfo?.isFile() || targetInfo.size !== expectedBytes) {
      throw new Error(
        `Failed to verify copied recomputed result segment: ${segment.fileName}`,
      );
    }
    return segment.fileName;
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
    const ajrmMarineLoggerApi = getAjrmMarineLoggerApi();
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

  async function waitForAjrmMarineLoggerCompression(capturesDir, voyage, captureStop) {
    const deadline = Date.now() + options.captureCompressionWaitSeconds * 1000;
    let status = await getAjrmMarineLoggerStatus();
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
      status = await getAjrmMarineLoggerStatus();
    }
    return status;
  }

  async function getAjrmMarineLoggerStatus() {
    const ajrmMarineLoggerApi = getAjrmMarineLoggerApi();
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
      recomputedReplay: voyage.recomputedReplay || null,
      incomplete: voyage.incomplete === true,
      recomputationVerified: voyage.recomputedReplay
        ? voyage.recomputationVerified === true &&
          voyage.recomputedReplay?.verified !== false
        : null,
      aborted: voyage.aborted === true,
      interruptedByRestart: voyage.interruptedByRestart === true,
      recoveredAt: voyage.recoveredAt || null,
      ajrmMarineLogger: {
        start: voyage.ajrmMarineLogger,
        stop: voyage.captureStop,
      },
      captureFiles: voyage.captureFiles || [],
      captureReferences: voyage.captureReferences || [],
      observations: publicObservationLog(voyage.observations),
      drTrack: voyage.drTrack || null,
      drPlotFixes: voyage.drPlotFixes || null,
      captureIndex,
      events: voyage.events,
      files,
      hints: [
        "Start with index.json.",
        "Read snapshots/start and snapshots/stop before opening large capture logs.",
        `Read ${OBSERVATIONS_RELATIVE_PATH} for timestamped skipper observations; optional structured Snapshot evidence is referenced from each observation.`,
        `For a recomputed child, ${PARENT_OBSERVATIONS_RELATIVE_PATH} is lineage copied from the parent and is not counted as a child observation. Verified parent Snapshot evidence stays in the named parent voyage and lineage records contain no dangling child paths.`,
        "Use snapshot timestamps and capture metadata to locate interesting intervals.",
        "Use tracks/dr-plot-fixes.json for navigator-style timed, manual, observed, GPS-lost, and GPS-return DR plot fixes when present.",
        "Capture files may contain AJRM Marine Logger backfill followed by live records. Use captureIndex for timestamp order, overlap and duplicate guidance before scanning large logs.",
        "If captureFileMode is reference, raw AJRM Marine Logger files were not copied into the bundle; use captureReferences on this server to locate the source recordings.",
        voyage.recomputedReplay?.incomplete === true
          ? "WARNING: this recomputed replay was interrupted. It is incomplete and unverified, preserves partial evidence only, and must not be treated as proof that recalculation completed."
          : "If recomputedReplay is present, this portable bundle was captured from fresh-wall-time replay of the listed sensor source identities; use parentVoyage, playbackMode, rate, sourcePolicy and sourceFilterStats to audit it.",
      ],
    };
    const indexPath = path.join(voyage.directory, "index.json");
    await writeJson(indexPath, index);
    return index;
  }

  async function buildCaptureIndex(voyage) {
    return buildCaptureIndexForDirectory(
      voyage.directory,
      voyage.captureFiles || [],
      {
        tolerateReadErrors: voyage.incomplete === true,
      },
    );
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
      trafficProjectionSessions: {},
      trafficProjectionSequence: {},
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
          indexTrafficProjectionSequence(summary, valuePath, value.value);
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

  function trafficProjectionSequenceTotal(fileSummary, field) {
    return Object.values(fileSummary.trafficProjectionSequence || {}).reduce(
      (sum, sequenceSummary) => sum + Number(sequenceSummary[field] || 0),
      0,
    );
  }

  function indexTrafficProjectionSequence(summary, valuePath, value) {
    if (!valuePath?.startsWith?.("plugins.ajrmMarineTraffic") || !value || typeof value !== "object") {
      return;
    }
    const sessionId = value.sessionId || "unknown";
    summary.trafficProjectionSessions[sessionId] = (summary.trafficProjectionSessions[sessionId] || 0) + 1;
    if (!Number.isFinite(value.sequence)) return;
    const sequenceKey = `${valuePath}:${sessionId}`;
    const generatedAtMs = Date.parse(value.generatedAt || "");
    const state = summary.trafficProjectionSequence[sequenceKey] || {
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
    summary.trafficProjectionSequence[sequenceKey] = state;
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

  async function callAjrmMarineLogger(route, body) {
    const ajrmMarineLoggerApi = getAjrmMarineLoggerApi();
    if (ajrmMarineLoggerApi) {
      if (route === "/capture/start" && typeof ajrmMarineLoggerApi.startCapture === "function") {
        const recording = await ajrmMarineLoggerApi.startCapture(body || {});
        return { ok: true, recording };
      }
      if (route === "/capture/stop" && typeof ajrmMarineLoggerApi.stopCapture === "function") {
        const recording = await ajrmMarineLoggerApi.stopCapture("voyage capture stopped");
        return { ok: true, recording };
      }
      if (
        route === "/playback/result-capture/start" &&
        typeof ajrmMarineLoggerApi.startReplayResultCapture === "function"
      ) {
        const recording = await ajrmMarineLoggerApi.startReplayResultCapture(body || {});
        return { ok: true, recording };
      }
      if (
        route === "/playback/result-capture/stop" &&
        typeof ajrmMarineLoggerApi.stopReplayResultCapture === "function"
      ) {
        const recording = await ajrmMarineLoggerApi.stopReplayResultCapture(
          "recomputed replay voyage stopped",
        );
        return { ok: true, recording };
      }
      if (
        route === "/playback/result-capture/abort" &&
        typeof ajrmMarineLoggerApi.abortReplayResultCapture === "function"
      ) {
        const recording = await ajrmMarineLoggerApi.abortReplayResultCapture(
          body?.reason || "recomputed replay capture aborted",
        );
        return { ok: true, recording };
      }
      if (
        route === "/playback/play" &&
        typeof ajrmMarineLoggerApi.startPlayback === "function"
      ) {
        const playback = await ajrmMarineLoggerApi.startPlayback(
          body?.rate ?? 1,
        );
        return { ok: true, playback };
      }
      if (
        route === "/playback/result-capture/stop" &&
        typeof ajrmMarineLoggerApi.stopCapture === "function"
      ) {
        const recording = await ajrmMarineLoggerApi.stopCapture(
          "recomputed replay voyage stopped",
        );
        return { ok: true, recording };
      }
    }
    return httpJson("POST", `${options.signalKBaseUrl}/plugins/signalk-ajrm-marine-logger${route}`, body);
  }

  async function buildStatus() {
    refreshNavigationContextFromSelfPath();
    const ajrmMarineLoggerApi = getAjrmMarineLoggerApi();
    const loggerAlreadyClosed =
      finalisation?.state === "running" &&
      finalisation?.loggerClosed === true;
    const ajrmMarineLogger = loggerAlreadyClosed
      ? {
          ...(cachedLoggerStatus || {}),
          ok: true,
          recorderClosed: true,
          statusSource: "capture-finalisation-checkpoint",
        }
      : ajrmMarineLoggerApi?.status
        ? await ajrmMarineLoggerApi.status().catch((error) => ({
            ok: false,
            error: error.message,
          }))
        : await httpJson(
            "GET",
            `${options.signalKBaseUrl}/plugins/signalk-ajrm-marine-logger/status`,
          ).catch((error) => ({ ok: false, error: error.message }));
    if (!loggerAlreadyClosed && ajrmMarineLogger?.ok !== false) {
      cachedLoggerStatus = ajrmMarineLogger;
    }
    if (ajrmMarineLogger?.playback && typeof ajrmMarineLogger.playback === "object") {
      loggerPlayback = ajrmMarineLogger.playback;
    }
    return {
      ok: true,
      plugin: plugin.id,
      version: packageInfo.version,
      timestamp: new Date().toISOString(),
      enabled: options.enabled,
      state:
        finalisation?.state === "running"
          ? "finalising"
          : currentVoyage
            ? "recording"
            : options.enabled
              ? "watching"
              : "disabled",
      speedKnots,
      sogKnots,
      stwKnots,
      voyageState,
      loggerPlaybackActive,
      loggerPlayback,
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
      captureFileMode: options.captureFileMode,
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

  function getAjrmMarineLoggerApi() {
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
      { path: "plugins.ajrmMarineCapture.sogKnots", value: sogKnots },
      { path: "plugins.ajrmMarineCapture.stwKnots", value: stwKnots },
      { path: "plugins.ajrmMarineCapture.voyageState", value: voyageState },
      { path: "plugins.ajrmMarineCapture.loggerPlaybackActive", value: loggerPlaybackActive },
      { path: "plugins.ajrmMarineCapture.loggerPlayback", value: loggerPlayback },
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
      observationLog: publicObservationLog(voyage.observations),
      captureMode: voyage.captureMode || options.captureMode,
      captureFileMode: voyage.captureFileMode || options.captureFileMode,
      recomputedReplay: voyage.recomputedReplay || null,
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

  async function copyDrPlotFixes(voyage) {
    if (!voyage?.directory) return;
    const source = await readJson(DR_PLOTTER_FIXES_FILE);
    const allFixes = normalizeDrPlotFixes(source?.plotFixes || source?.fixes || []);
    const voyageFixes = filterDrPlotFixesForVoyage(allFixes, voyage.startedAt, voyage.stoppedAt);
    voyage.drPlotFixes = {
      fileName: DR_PLOT_FIXES_RELATIVE_PATH,
      samples: voyageFixes.length,
      sourceFile: DR_PLOTTER_FIXES_FILE,
      startedAt: voyage.startedAt || null,
      stoppedAt: voyage.stoppedAt || null,
    };
    if (!source) {
      voyage.drPlotFixes.sourceAvailable = false;
      appendVoyageEvent(voyage, "dr-plot-fixes-missing", "No AJRM Marine DR Plotter plot-fix file was available");
      return;
    }
    voyage.drPlotFixes.sourceAvailable = true;
    await fs.promises.mkdir(path.join(voyage.directory, "tracks"), { recursive: true });
    await writeJson(path.join(voyage.directory, DR_PLOT_FIXES_RELATIVE_PATH), {
      schemaVersion: 1,
      source: "AJRM Marine DR Plotter",
      voyageId: voyage.id || null,
      startedAt: voyage.startedAt || null,
      stoppedAt: voyage.stoppedAt || null,
      plotFixes: voyageFixes,
    });
    appendVoyageEvent(
      voyage,
      "dr-plot-fixes",
      `${voyageFixes.length} AJRM Marine DR Plotter fix${voyageFixes.length === 1 ? "" : "es"} copied into voyage bundle`,
    );
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

function filterDrPlotFixesForVoyage(plotFixes, startedAt, stoppedAt) {
  const startMs = Date.parse(startedAt);
  const stopMs = Date.parse(stoppedAt);
  return normalizeDrPlotFixes(plotFixes).filter((fix) => {
    const timestampMs = Date.parse(fix.timestamp);
    if (!Number.isFinite(timestampMs)) return false;
    if (Number.isFinite(startMs) && timestampMs < startMs) return false;
    if (Number.isFinite(stopMs) && timestampMs > stopMs) return false;
    return true;
  });
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

function normalizeDrPlotFixes(value) {
  return (Array.isArray(value) ? value : [])
    .map(normalizeDrPlotFix)
    .filter(Boolean)
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

function normalizeDrPlotFix(value) {
  const timestamp = normalizeIsoTimestamp(value?.timestamp);
  const position = normalizeLatLonPosition(value?.position);
  if (!timestamp || !position) return null;
  return {
    id: typeof value.id === "string" && value.id.trim() ? value.id.trim().slice(0, 80) : `plot-${timestamp}`,
    timestamp,
    automatic: value.automatic === true,
    plotType: ["manual", "timed", "gps-lost", "gps-return", "observed-fix"].includes(value.plotType) ? value.plotType : null,
    note: stringOrNull(value.note),
    position,
    trust: stringOrNull(value.trust),
    drSource: stringOrNull(value.drSource),
    uncertaintyRadiusMeters: numberOrNull(value.uncertaintyRadiusMeters),
    drGpsDependent: booleanOrNull(value.drGpsDependent),
    drLeewayStatus: stringOrNull(value.drLeewayStatus),
    drCurrentOrigin: stringOrNull(value.drCurrentOrigin),
    drHeadingSource: stringOrNull(value.drHeadingSource),
    drTrackThroughWaterSource: stringOrNull(value.drTrackThroughWaterSource),
    drSpeedThroughWaterSource: stringOrNull(value.drSpeedThroughWaterSource),
    drCurrentSource: stringOrNull(value.drCurrentSource),
    drLeewaySource: stringOrNull(value.drLeewaySource),
    integritySource: stringOrNull(value.integritySource),
    integrityAssurance: stringOrNull(value.integrityAssurance),
    integrityComparisonAvailable: booleanOrNull(
      value.integrityComparisonAvailable,
    ),
    integrityUnavailableReason: longStringOrNull(
      value.integrityUnavailableReason,
    ),
    integrityAgeSeconds: numberOrNull(value.integrityAgeSeconds),
    integrityUncertaintyRadiusMeters: numberOrNull(
      value.integrityUncertaintyRadiusMeters,
    ),
    integrityGpsDependent: booleanOrNull(value.integrityGpsDependent),
    integrityLeewayStatus: stringOrNull(value.integrityLeewayStatus),
    integrityCurrentOrigin: stringOrNull(value.integrityCurrentOrigin),
    integrityHeadingSource: stringOrNull(value.integrityHeadingSource),
    integrityTrackThroughWaterSource: stringOrNull(
      value.integrityTrackThroughWaterSource,
    ),
    integritySpeedThroughWaterSource: stringOrNull(
      value.integritySpeedThroughWaterSource,
    ),
    integrityCurrentSource: stringOrNull(value.integrityCurrentSource),
    integrityLeewaySource: stringOrNull(value.integrityLeewaySource),
    referenceKind: stringOrNull(value.referenceKind),
    referenceSource: stringOrNull(value.referenceSource),
    referenceMethod: stringOrNull(value.referenceMethod),
    referenceAgeSeconds: numberOrNull(value.referenceAgeSeconds),
    referenceUncertaintyDegrees: numberOrNull(
      value.referenceUncertaintyDegrees,
    ),
    referenceGpsDependent: booleanOrNull(value.referenceGpsDependent),
    lastTrustedFixAgeSeconds: numberOrNull(value.lastTrustedFixAgeSeconds),
    distanceFromLastTrustedFixMeters: numberOrNull(value.distanceFromLastTrustedFixMeters),
    stwMps: numberOrNull(value.stwMps),
    headingTrueDegrees: numberOrNull(value.headingTrueDegrees),
    sogMps: numberOrNull(value.sogMps),
    cogTrueDegrees: numberOrNull(value.cogTrueDegrees),
    currentDriftMps: numberOrNull(value.currentDriftMps),
    currentSetTrueDegrees: numberOrNull(value.currentSetTrueDegrees),
    resource: normalizeDrFixResource(value.resource),
  };
}

function normalizeDrFixResource(value) {
  if (!value || typeof value !== "object") return null;
  const resourceType = stringOrNull(value.resourceType);
  const feature = normalizeGeoJsonPointFeature(value.feature);
  if (!resourceType || !feature) return null;
  return { resourceType, feature };
}

function normalizeGeoJsonPointFeature(value) {
  if (!value || typeof value !== "object") return null;
  if (value.type !== "Feature") return null;
  const coordinates = Array.isArray(value.geometry?.coordinates) ? value.geometry.coordinates.map(Number) : [];
  if (value.geometry?.type !== "Point" || coordinates.length < 2) return null;
  const longitude = coordinates[0];
  const latitude = coordinates[1];
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  const properties = value.properties && typeof value.properties === "object" ? { ...value.properties } : {};
  return {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [longitude, latitude],
    },
    properties,
  };
}

function normalizeIsoTimestamp(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function normalizeLatLonPosition(value) {
  const latitude = numberOrNull(value?.latitude);
  const longitude = numberOrNull(value?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
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

async function buildCaptureIndexForDirectory(
  bundleDirectory,
  captureFiles,
  indexOptions = {},
) {
  const files = [];
  const allRecords = [];
  for (const fileName of captureFiles || []) {
    const filePath = path.join(bundleDirectory, "capture", fileName);
    let summary;
    try {
      summary = await summarizeCaptureFileForIndex(filePath, fileName);
    } catch (error) {
      if (indexOptions.tolerateReadErrors !== true) throw error;
      summary = {
        fileName,
        error: `Incomplete replay evidence could not be decoded: ${String(
          error?.message || error,
        ).slice(0, 500)}`,
        records: 0,
        duplicateRecordsInSample: 0,
        outOfOrderRecords: 0,
        firstTimestamp: null,
        lastTimestamp: null,
        contexts: {},
        sources: {},
        paths: {},
        trafficProjectionSessions: {},
        trafficProjectionSequence: {},
        sampleTimeline: [],
      };
    }
    files.push(summary);
    allRecords.push(...summary.sampleTimeline);
    delete summary.sampleTimeline;
  }
  const sortedSamples = allRecords
    .sort((left, right) => left.timestampMs - right.timestampMs || left.file.localeCompare(right.file) || left.line - right.line)
    .slice(0, 200);
  return {
    schema: "ajrm-marine-capture-index-v1",
    sortKey: "delta.updates[].timestamp, fallback capturedAt",
    files,
    sortedSample: sortedSamples.map(({ timestampMs, ...entry }) => entry),
    totals: {
      records: files.reduce((sum, file) => sum + file.records, 0),
      duplicateRecordsInSample: files.reduce((sum, file) => sum + file.duplicateRecordsInSample, 0),
      outOfOrderRecords: files.reduce((sum, file) => sum + file.outOfOrderRecords, 0),
      trafficProjectionFileOrderRewinds: files.reduce((sum, file) => sum + trafficProjectionSequenceTotalForIndex(file, "fileOrderRewinds"), 0),
      trafficProjectionSequenceRegressions: files.reduce((sum, file) => sum + trafficProjectionSequenceTotalForIndex(file, "sequenceRegressions"), 0),
    },
    notes: [
      "Raw capture files are preserved exactly as AJRM Marine Logger wrote them.",
      "Analyse by update timestamp rather than file order when backfill is present.",
      "Duplicate counts are based on exact repeated JSON lines within the bounded per-file sample.",
      "Traffic projection fileOrderRewinds mean older generatedAt records appeared after newer records, usually because of backfill or overlapping logger files. trafficProjectionSequenceRegressions are the count to investigate as possible Traffic projection sequence faults.",
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
    trafficProjectionSessions: {},
    trafficProjectionSequence: {},
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
        indexTrafficProjectionSequenceForIndex(summary, valuePath, value.value);
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

function trafficProjectionSequenceTotalForIndex(fileSummary, field) {
  return Object.values(fileSummary.trafficProjectionSequence || {}).reduce(
    (sum, sequenceSummary) => sum + Number(sequenceSummary[field] || 0),
    0,
  );
}

function indexTrafficProjectionSequenceForIndex(summary, valuePath, value) {
  if (!valuePath?.startsWith?.("plugins.ajrmMarineTraffic") || !value || typeof value !== "object") {
    return;
  }
  const sessionId = value.sessionId || "unknown";
  summary.trafficProjectionSessions[sessionId] = (summary.trafficProjectionSessions[sessionId] || 0) + 1;
  if (!Number.isFinite(value.sequence)) return;
  const sequenceKey = `${valuePath}:${sessionId}`;
  const generatedAtMs = Date.parse(value.generatedAt || "");
  const state = summary.trafficProjectionSequence[sequenceKey] || {
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
  summary.trafficProjectionSequence[sequenceKey] = state;
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
    const index = await cachedVoyageZipIndex(filePath, info);
    result.push({
      fileName: entry.name,
      bytes: info.size,
      modifiedAt: new Date(info.mtimeMs).toISOString(),
      comment: normalizeComment(index?.comment),
      startedAt: index?.startedAt || null,
      stoppedAt: index?.stoppedAt || null,
      recomputedReplay: index?.recomputedReplay || null,
      observationLog: publicObservationLog(index?.observations),
      downloadUrl: `/plugins/signalk-ajrm-marine-capture/voyages/${encodeURIComponent(entry.name)}/download`,
    });
  }
  return result.sort((left, right) => String(right.modifiedAt).localeCompare(String(left.modifiedAt)));
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

async function buildPortableDownloadBundle(
  sourceZipPath,
  fileName,
  stagingRoot = os.tmpdir(),
) {
  const index = await readVoyageZipIndex(sourceZipPath);
  if (voyageZipContainsDeclaredCaptureFiles(sourceZipPath, index)) {
    return null;
  }
  const references = Array.isArray(index?.captureReferences) ? index.captureReferences : [];
  if (!references.length) return null;
  await fs.promises.mkdir(stagingRoot, { recursive: true });
  let directory = null;
  try {
    directory = await fs.promises.mkdtemp(
      path.join(stagingRoot, PORTABLE_DOWNLOAD_DIRECTORY_PREFIX),
    );
    const workDir = path.join(directory, "bundle");
    const outputPath = path.join(directory, fileName);
    await fs.promises.mkdir(workDir, { recursive: true });
    extractZipToDirectory(sourceZipPath, workDir);
    await fs.promises.mkdir(path.join(workDir, "capture"), { recursive: true });
    const portableIndexPath = path.join(workDir, "index.json");
    const portableIndex = await readJson(portableIndexPath) || index;
    const copiedReferences = [];
    const embeddedCaptureFiles = await listPortableCaptureFiles(workDir);
    const copiedNames = new Set(embeddedCaptureFiles);
    const missingReferences = [];
    for (const reference of references) {
      const embeddedName = embeddedCaptureFiles.find(
        (candidate) =>
          logicalCaptureFileNameForDownload(candidate) ===
          logicalCaptureFileNameForDownload(reference?.fileName),
      );
      if (embeddedName) {
        const embeddedInfo = await fs.promises.stat(
          path.join(workDir, "capture", embeddedName),
        );
        copiedReferences.push({
          fileName: embeddedName,
          bytes: embeddedInfo.size,
        });
        continue;
      }
      const copied = await copyCaptureReferenceForDownload(
        reference,
        path.join(workDir, "capture"),
        copiedNames,
      );
      if (copied) copiedReferences.push(copied);
      else missingReferences.push(reference.fileName || reference.sourcePath || "unknown");
    }
    const captureFiles = await listPortableCaptureFiles(workDir);
    if (!captureFiles.length || missingReferences.length) {
      const unavailable = missingReferences.length || references.length;
      throw new Error(
        `Cannot prepare a complete portable voyage: ${unavailable} AJRM Marine Logger capture reference${unavailable === 1 ? "" : "s"} unavailable`,
      );
    }
    portableIndex.originalCaptureFileMode = portableIndex.captureFileMode || "reference";
    portableIndex.captureFileMode = "portable-download";
    portableIndex.captureFiles = captureFiles;
    portableIndex.captureIndex = await buildCaptureIndexForDirectory(workDir, captureFiles);
    reconcilePortableCaptureReferences(portableIndex, copiedReferences);
    rewritePortableDownloadEvents(portableIndex, copiedReferences, missingReferences);
    portableIndex.portableDownload = {
      createdAt: new Date().toISOString(),
      copiedCaptureFiles: captureFiles.length,
      copiedCaptureBytes: copiedReferences.reduce((sum, reference) => sum + Number(reference.bytes || 0), 0),
      missingReferences,
    };
    portableIndex.hints = [
      ...(Array.isArray(portableIndex.hints) ? portableIndex.hints.filter((hint) => !String(hint).includes("captureFileMode is reference")) : []),
      "This download was rebuilt on demand from a reference-mode voyage bundle. Copied raw AJRM Marine Logger files are in capture/ when they were still present on this server.",
    ];
    await writeJson(portableIndexPath, portableIndex);
    await writeDirectoryZip(outputPath, workDir);
    return { path: outputPath, directory };
  } catch (error) {
    if (directory) {
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

async function cleanupPortableDownloadWorkspaces(parentDirectories) {
  let removed = 0;
  for (const parentDirectory of new Set(parentDirectories.filter(Boolean))) {
    const entries = await fs.promises.readdir(parentDirectory, {
      withFileTypes: true,
    }).catch(() => []);
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        !new RegExp(
          `^${PORTABLE_DOWNLOAD_DIRECTORY_PREFIX}[A-Za-z0-9]{6}$`,
        ).test(entry.name)
      ) {
        continue;
      }
      await fs.promises.rm(path.join(parentDirectory, entry.name), {
        recursive: true,
        force: true,
      });
      removed += 1;
    }
  }
  return removed;
}

function voyageZipContainsDeclaredCaptureFiles(sourceZipPath, index) {
  const captureFiles = Array.isArray(index?.captureFiles)
    ? index.captureFiles
    : [];
  if (!captureFiles.length) return false;
  const declaredLogicalNames = new Set(
    captureFiles.map((fileName) =>
      logicalCaptureFileNameForDownload(path.basename(String(fileName || ""))),
    ),
  );
  const references = Array.isArray(index?.captureReferences)
    ? index.captureReferences
    : [];
  if (
    references.some(
      (reference) =>
        !declaredLogicalNames.has(
          logicalCaptureFileNameForDownload(reference?.fileName),
        ),
    )
  ) {
    return false;
  }
  try {
    const zip = new AdmZip(sourceZipPath);
    return captureFiles.every((fileName) => {
      const entryName = portableCaptureEntryName(fileName);
      const entry = entryName ? zip.getEntry(entryName) : null;
      return Boolean(
        entry &&
        !entry.isDirectory &&
        Number(entry.header?.size || 0) > 0,
      );
    });
  } catch {
    return false;
  }
}

function portableCaptureEntryName(fileName) {
  const normalized = String(fileName || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (
    !normalized ||
    normalized.split("/").includes("..") ||
    !/\.jsonl(?:\.gz)?$/i.test(normalized)
  ) {
    return null;
  }
  return normalized.startsWith("capture/")
    ? normalized
    : `capture/${normalized}`;
}

async function listPortableCaptureFiles(workDir) {
  const captureDirectory = path.join(workDir, "capture");
  const entries = await fs.promises.readdir(captureDirectory, {
    withFileTypes: true,
  }).catch(() => []);
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.jsonl(?:\.gz)?$/i.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function extractZipToDirectory(filePath, directory) {
  const zip = new AdmZip(filePath);
  for (const entry of zip.getEntries()) {
    if (unsafeZipEntryName(entry.entryName)) {
      throw new Error(`unsafe archive path: ${entry.entryName}`);
    }
  }
  zip.extractAllTo(directory, true);
}

function unsafeZipEntryName(entryName) {
  return path.isAbsolute(entryName) || entryName.split(/[\\/]+/).includes("..");
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

function reconcilePortableCaptureReferences(index, copiedReferences = []) {
  const summariesByLogicalName = new Map();
  for (const summary of index?.captureIndex?.files || []) {
    if (!summary?.fileName) continue;
    summariesByLogicalName.set(logicalCaptureFileNameForDownload(summary.fileName), summary);
  }
  if (!summariesByLogicalName.size || !Array.isArray(index.captureReferences)) return;
  const copiedByLogicalName = new Map(
    copiedReferences.map((reference) => [logicalCaptureFileNameForDownload(reference.fileName), reference]),
  );
  index.captureReferences = index.captureReferences.map((reference) => {
    const summary = summariesByLogicalName.get(logicalCaptureFileNameForDownload(reference?.fileName));
    if (!summary) return reference;
    const copied = copiedByLogicalName.get(logicalCaptureFileNameForDownload(summary.fileName));
    return {
      ...reference,
      fileName: summary.fileName,
      sourcePath: `capture/${summary.fileName}`,
      compressedSourcePath: "",
      from: summary.firstTimestamp || reference.from || null,
      to: summary.lastTimestamp || reference.to || null,
      compressed: summary.fileName.endsWith(".gz"),
      bytes: copied?.bytes ?? reference.bytes ?? null,
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
    if (copiedNames.has(fileName)) return { fileName, bytes: info.size };
    const targetPath = path.join(captureDirectory, fileName);
    await fs.promises.copyFile(candidate, targetPath);
    copiedNames.add(fileName);
    return { fileName, bytes: info.size };
  }
  return null;
}

function logicalCaptureFileNameForDownload(fileName) {
  return String(fileName || "").replace(/\.gz$/i, "");
}

function rewritePortableDownloadEvents(index, copiedReferences = [], missingReferences = []) {
  const copiedCount = copiedReferences.length;
  const missingCount = missingReferences.length;
  const replacementMessage = copiedCount
    ? `${copiedCount} AJRM Marine Logger segment${copiedCount === 1 ? "" : "s"} copied into portable download`
    : "AJRM Marine Logger segments could not be copied into portable download";
  const replacement = {
    at: new Date().toISOString(),
    type: copiedCount ? "capture-copied-portable-download" : "capture-copy-warning",
    message: missingCount
      ? `${replacementMessage}; ${missingCount} missing reference${missingCount === 1 ? "" : "s"}`
      : replacementMessage,
  };
  const events = Array.isArray(index.events) ? index.events : [];
  const rewritten = events.map((event) => {
    if (event?.type !== "capture-referenced") return event;
    return {
      ...event,
      type: replacement.type,
      message: replacement.message,
    };
  });
  if (!rewritten.some((event) => event?.type === replacement.type && event?.message === replacement.message)) {
    rewritten.unshift(replacement);
  }
  index.events = rewritten;
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
  buildPortableDownloadBundle,
  biteReportOverlapsVoyage,
  cleanHarbourName,
  cleanupPortableDownloadWorkspaces,
  defaultVoyageComment,
  drTrackSample,
  filterDrPlotFixesForVoyage,
  nextMovementGateState,
  normalizeDrPlotFixes,
  normalizeObservationText,
  normalizeTrafficProfile,
  parseObservationRecords,
  publicObservationLog,
  reconcilePortableCaptureReferences,
  resetMovementGateForVoyageStart,
  rewritePortableDownloadEvents,
  speedKnotsFromMps,
  writeDirectoryZip,
};
