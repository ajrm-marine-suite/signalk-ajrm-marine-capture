/**
 * Implements the voyage review responsibilities of the AJRM Marine Voyages Signal K server.
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const zlib = require("node:zlib");
const yauzl = require("yauzl");
const packageInfo = require("../package.json");

const MPS_TO_KNOTS = 1.9438444924406046;
const METERS_TO_NM = 1 / 1852;
const DEFAULT_VOYAGE_DIRECTORY = "~/AJRMMarineLogs/voyages";
const MAX_TRACK_POINTS = 6000;
const PLOT_CACHE_SCHEMA = "ajrm-marine.plot-cache.v2";
const REVIEW_SCHEMA_VERSION = 2;
const REVIEW_ENGINE_VERSION = 17;
const CANONICAL_INPUT_CONTRACT = "ajrm-marine-canonical-input-v1";
const CANONICAL_INPUT_RELATIVE_PATH = "input/sensor-input.jsonl";
const ENGAGED_AUTOPILOT_STATES = new Set(["auto", "heading", "wind", "route"]);
const MAX_ZIP_TEXT_ENTRY_BYTES = 64 * 1024 * 1024;
const RECOMPUTED_COMPLETION_PATH = "system/recomputed-replay-completion.json";
const TRAFFIC_TARGETS_PATH = "plugins.ajrmMarineTraffic.targets";
const AJRM_MARINE_GPS_INTEGRITY_STATE_PATH = "plugins.ajrmMarineGpsIntegrity.navigationIntegrity";
const DR_TRACK_RELATIVE_PATH = "tracks/dr-track.jsonl";
const OBSERVATIONS_RELATIVE_PATH = "observations/observations.jsonl";
const AJRM_MARINE_CAPTURE_API_REGISTRY = Symbol.for("mcdonaldajr.ajrmMarineCaptureApi");
const AJRM_MARINE_VOYAGE_REVIEW_API_REGISTRY = Symbol.for("mcdonaldajr.ajrmMarineVoyageReviewApi");

module.exports = function ajrmMarineVoyageReview(app, componentOptions = {}) {
  const plugin = {};
  const embedded = componentOptions.embedded === true;
  let options = normalizeOptions({});
  const analysisProgress = new Map();

  plugin.id = componentOptions.pluginId || "signalk-ajrm-marine-capture-review";
  plugin.name = "AJRM Marine Voyage Review";
  plugin.description =
    "Maps recorded AJRM Marine Capture voyage tracks and summary statistics.";

  plugin.schema = {
    type: "object",
    properties: {
      voyageDirectory: {
        type: "string",
        title: "Voyage bundle directory",
        default: DEFAULT_VOYAGE_DIRECTORY,
      },
      maxTrackPoints: {
        type: "integer",
        title: "Maximum plotted track points",
        default: MAX_TRACK_POINTS,
        minimum: 500,
        maximum: 50000,
      },
    },
  };

  plugin.start = (pluginOptions = {}) => {
    options = normalizeOptions(pluginOptions);
    const api = {
      pluginId: plugin.id,
      version: packageInfo.version,
      status: () => statusPayload(),
      async analyseVoyage(fileName) {
        const file = safeVoyageFile(fileName);
        return analyseVoyageFile(file, options, options.maxTrackPoints);
      },
    };
    app.ajrmMarineVoyageReviewApi = api;
    globalThis[AJRM_MARINE_VOYAGE_REVIEW_API_REGISTRY] = api;
    if (!embedded) app.setPluginStatus(`Started v${packageInfo.version}`);
  };

  plugin.stop = () => {
    if (app.ajrmMarineVoyageReviewApi?.pluginId === plugin.id) {
      delete app.ajrmMarineVoyageReviewApi;
    }
    if (globalThis[AJRM_MARINE_VOYAGE_REVIEW_API_REGISTRY]?.pluginId === plugin.id) {
      delete globalThis[AJRM_MARINE_VOYAGE_REVIEW_API_REGISTRY];
    }
  };

  plugin.getOpenApi = () => require("./openApi.json");

  plugin.registerWithRouter = function registerWithRouter(router) {
    router.get("/status", (_req, res) => {
      res.json(statusPayload());
    });

    router.get("/voyages", async (_req, res) => {
      try {
        res.json({ ok: true, voyages: await listVoyages(options.voyageDirectory) });
      } catch (error) {
        app.error(`[${plugin.id}] list voyages failed: ${error.stack || error.message}`);
        res.status(500).json({ ok: false, error: error.message });
      }
    });

    router.get("/voyages/:file/analysis-progress", (req, res) => {
      try {
        const file = safeVoyageFile(req.params.file);
        res.json({
          ok: true,
          progress: analysisProgress.get(file) || idleAnalysisProgress(file),
        });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    });

    router.get("/voyages/:file/download", async (req, res) => {
      let captureDownload = null;
      try {
        const file = safeVoyageFile(req.params.file);
        captureDownload = await prepareCaptureVoyageDownload(app, file);
        if (captureDownload) {
          res.download(captureDownload.path, captureDownload.fileName, () => {
            captureDownload.cleanup().catch(() => {});
          });
          return;
        }
        const voyagePath = path.join(expandHome(options.voyageDirectory), file);
        await assertReadableFile(voyagePath);
        res.download(voyagePath, file);
      } catch (error) {
        if (captureDownload) captureDownload.cleanup().catch(() => {});
        app.error(`[${plugin.id}] download failed: ${error.stack || error.message}`);
        res.status(500).json({ ok: false, error: error.message });
      }
    });

    router.get("/charts", async (_req, res) => {
      try {
        if (!app.resourcesApi?.listResources) {
          throw new Error("Signal K resources API is not available.");
        }
        const charts = await app.resourcesApi.listResources("charts", {});
        res.json({ ok: true, charts: charts || {} });
      } catch (error) {
        app.error(`[${plugin.id}] chart resource list failed: ${error.stack || error.message}`);
        res.status(500).json({ ok: false, error: error.message });
      }
    });

    router.post("/voyages/:file/analyse", async (req, res) => {
      let progressKey = null;
      try {
        const file = safeVoyageFile(req.params.file);
        progressKey = file;
        setAnalysisProgress(analysisProgress, progressKey, {
          fileName: file,
          state: "running",
          phase: "opening",
          percent: 0,
          message: `Opening ${file}`,
        });
        const analysis = await analyseVoyageFile(file, options, options.maxTrackPoints, {
            onProgress(progress) {
              setAnalysisProgress(analysisProgress, progressKey, {
                fileName: file,
                state: "running",
                ...progress,
              });
            },
          });
        setAnalysisProgress(analysisProgress, progressKey, {
          fileName: file,
          state: "complete",
          phase: "complete",
          percent: 100,
          message: "Voyage analysis complete",
        });
        res.json({ ok: true, analysis });
      } catch (error) {
        if (progressKey) {
          setAnalysisProgress(analysisProgress, progressKey, {
            state: "failed",
            phase: "failed",
            percent: 100,
            message: error.message,
            error: error.message,
          });
        }
        app.error(`[${plugin.id}] analyse voyage failed: ${error.stack || error.message}`);
        res.status(500).json({ ok: false, error: error.message });
      }
    });

    router.get("/voyages/:file/track.gpx", async (req, res) => {
      try {
        const file = safeVoyageFile(req.params.file);
        await sendVoyageGpx(res, file, options);
      } catch (error) {
        app.error(`[${plugin.id}] GPX export failed: ${error.stack || error.message}`);
        res.status(500).json({ ok: false, error: error.message });
      }
    });

  };

  function statusPayload() {
    return {
      ok: true,
      plugin: plugin.id,
      version: packageInfo.version,
      voyageDirectory: options.voyageDirectory,
      capabilities: {
        voyageOnly: true,
        plot: true,
        download: true,
        review: true,
        streamingDownload: true,
        streamingAnalysis: true,
        analysisProgress: true,
        runtimeAnalysisApi: true,
      },
      review: {
        supported: true,
        schemaVersion: 2,
        engineVersion: REVIEW_ENGINE_VERSION,
      },
    };
  }

  return plugin;
};

async function prepareCaptureVoyageDownload(app, fileName) {
  const api = app.ajrmMarineCaptureApi || globalThis[AJRM_MARINE_CAPTURE_API_REGISTRY];
  if (!api || typeof api.prepareVoyageDownload !== "function") return null;
  try {
    return await api.prepareVoyageDownload(fileName);
  } catch (error) {
    app.error?.(`[signalk-ajrm-marine-capture] Voyage download preparation failed: ${error.stack || error.message}`);
    return null;
  }
}

function normalizeOptions(value = {}) {
  return {
    voyageDirectory: String(value.voyageDirectory || DEFAULT_VOYAGE_DIRECTORY),
    maxTrackPoints: clampInteger(value.maxTrackPoints, 500, 50000, MAX_TRACK_POINTS),
    publicBase: String(value.publicBase || "/plugins/signalk-ajrm-marine-capture/review"),
  };
}

async function listVoyages(voyageDirectory) {
  const dir = expandHome(voyageDirectory);
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const voyages = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".zip")) continue;
    const voyagePath = path.join(dir, entry.name);
    const stat = await fs.promises.stat(voyagePath);
    const index = await readVoyageIndexSummary(voyagePath);
    voyages.push({
      fileName: entry.name,
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      comment: index.comment,
      startedAt: index.startedAt,
      stoppedAt: index.stoppedAt,
      recomputedReplay: index.recomputedReplay,
    });
  }
  voyages.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  return voyages;
}

async function readVoyageIndexSummary(voyagePath) {
  try {
    const index = await readZipJson(voyagePath, "index.json");
    return {
      comment: typeof index.comment === "string" ? index.comment : "",
      startedAt: typeof index.startedAt === "string" ? index.startedAt : null,
      stoppedAt: typeof index.stoppedAt === "string" ? index.stoppedAt : null,
      recomputedReplay: summarizeRecomputedReplay(index.recomputedReplay),
    };
  } catch {
    return {
      comment: "",
      startedAt: null,
      stoppedAt: null,
      recomputedReplay: null,
    };
  }
}

function idleAnalysisProgress(fileName) {
  return {
    contract: "ajrm-marine-voyage-analysis-progress",
    contractVersion: 1,
    fileName,
    state: "idle",
    phase: "idle",
    percent: 0,
    message: "No analysis is running",
    updatedAt: new Date().toISOString(),
  };
}

function setAnalysisProgress(store, key, changes) {
  const previous = store.get(key) || {};
  store.set(key, {
    contract: "ajrm-marine-voyage-analysis-progress",
    contractVersion: 1,
    ...previous,
    ...changes,
    percent: clampProgressPercent(changes.percent ?? previous.percent),
    updatedAt: new Date().toISOString(),
  });
}

function emitAnalysisProgress(onProgress, percent, phase, message, details = {}) {
  if (typeof onProgress !== "function") return;
  onProgress({
    percent: clampProgressPercent(percent),
    phase,
    message,
    ...details,
  });
}

function clampProgressPercent(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(100, Math.max(0, Math.round(number * 10) / 10))
    : 0;
}

async function analyseVoyageFile(
  file,
  currentOptions,
  maxTrackPoints,
  { useCache = true, onProgress = null } = {},
) {
  const sourcePath = path.join(expandHome(currentOptions.voyageDirectory), file);
  const source = await sourceFingerprint(sourcePath);
  emitAnalysisProgress(onProgress, 2, "opening", `Opened ${file}`);
  if (useCache && isPlotCacheable(maxTrackPoints)) {
    const cached = await readFreshPlotCache(sourcePath, source, file, maxTrackPoints);
    if (cached) {
      emitAnalysisProgress(onProgress, 100, "complete", "Loaded cached voyage analysis", {
        cacheHit: true,
      });
      return cached;
    }
  }
  const analysis = await analyseVoyage(sourcePath, {
    maxTrackPoints,
    onProgress,
    publicBase:
      currentOptions.publicBase || "/plugins/signalk-ajrm-marine-capture/review",
  });
  if (useCache && isPlotCacheable(maxTrackPoints)) {
    emitAnalysisProgress(onProgress, 97, "caching", "Saving voyage analysis cache");
    await writePlotCache(sourcePath, source, file, maxTrackPoints, analysis);
  }
  emitAnalysisProgress(onProgress, 100, "complete", "Voyage analysis complete");
  return analysis;
}

function isPlotCacheable(maxTrackPoints) {
  const value = Number(maxTrackPoints);
  return Number.isFinite(value) && value > 0 && value <= 50000;
}

async function sourceFingerprint(sourcePath) {
  const stat = await fs.promises.stat(sourcePath);
  if (!stat.isFile()) throw new Error("Recording path is not a file.");
  return {
    fileName: path.basename(sourcePath),
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
    modifiedAt: stat.mtime.toISOString(),
  };
}

function plotCachePath(sourcePath) {
  return `${sourcePath}.ajrm-marine-plot.json`;
}

function gpxCachePath(sourcePath) {
  return `${sourcePath}.gpx`;
}

async function readFreshPlotCache(sourcePath, source, file, maxTrackPoints) {
  const cache = await readPlotCacheFile(plotCachePath(sourcePath));
  if (!cache || cache.schema !== PLOT_CACHE_SCHEMA) return null;
  if (cache.source?.fileName !== file) return null;
  if (cache.source?.bytes !== source.bytes || cache.source?.mtimeMs !== source.mtimeMs) return null;
  if (Number(cache.options?.maxTrackPoints) !== Number(maxTrackPoints)) return null;
  if (!cache.analysis || typeof cache.analysis !== "object") return null;
  if (cache.analysis.review?.schemaVersion !== REVIEW_SCHEMA_VERSION) return null;
  if (Number(cache.analysis.review?.engineVersion || 0) < REVIEW_ENGINE_VERSION) return null;
  return {
    ...cache.analysis,
    cache: { hit: true, generatedAt: cache.generatedAt || null },
  };
}

async function readPlotCacheFile(cachePath) {
  try {
    return JSON.parse(await fs.promises.readFile(cachePath, "utf8"));
  } catch {
    return null;
  }
}

async function writePlotCache(sourcePath, source, file, maxTrackPoints, analysis) {
  const cache = {
    schema: PLOT_CACHE_SCHEMA,
    generatedAt: new Date().toISOString(),
    viewerVersion: packageInfo.version,
    source: {
      fileName: file,
      bytes: source.bytes,
      mtimeMs: source.mtimeMs,
      modifiedAt: source.modifiedAt,
    },
    options: {
      maxTrackPoints: Number(maxTrackPoints),
    },
    analysis,
  };
  await writeJsonAtomic(plotCachePath(sourcePath), cache);
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tempPath, `${JSON.stringify(value)}\n`);
  await fs.promises.rename(tempPath, filePath);
}

async function sendVoyageGpx(res, file, currentOptions) {
  const sourcePath = path.join(expandHome(currentOptions.voyageDirectory), file);
  const source = await sourceFingerprint(sourcePath);
  const gpxPath = gpxCachePath(sourcePath);
  const cachedGpx = await freshSidecarPath(gpxPath, source);
  if (cachedGpx) {
    res.setHeader("Content-Type", "application/gpx+xml; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${headerSafeFileName(`${recordingFileStem(file)}.gpx`)}"`);
    fs.createReadStream(cachedGpx).pipe(res);
    return;
  }
  const analysis = await analyseVoyageFile(
    file,
    currentOptions,
    Number.MAX_SAFE_INTEGER,
    { useCache: false },
  );
  const gpx = generateGpx(analysis);
  await fs.promises.writeFile(gpxPath, gpx);
  res.setHeader("Content-Type", "application/gpx+xml; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${headerSafeFileName(defaultGpxFileName(analysis, file))}"`);
  res.send(gpx);
}

async function freshSidecarPath(sidecarPath, source) {
  const stat = await fs.promises.stat(sidecarPath).catch(() => null);
  if (!stat?.isFile()) return null;
  return stat.mtimeMs >= source.mtimeMs && stat.size > 0 ? sidecarPath : null;
}

async function analyseVoyage(
  voyagePath,
  {
    maxTrackPoints = MAX_TRACK_POINTS,
    onProgress = null,
    publicBase = "/plugins/signalk-ajrm-marine-capture/review",
  } = {},
) {
  await assertReadableFile(voyagePath);
  emitAnalysisProgress(onProgress, 3, "opening-index", "Reading voyage index");
  const index = await readZipJson(voyagePath, "index.json");
  const captureSources = await resolveVoyageDataSource(voyagePath, index);

  const completionCheckpoint = await readOptionalZipJson(
    voyagePath,
    RECOMPUTED_COMPLETION_PATH,
  );
  const replayVerification = evaluateRecomputedCompletion({
    index,
    checkpoint: completionCheckpoint,
    captureSources,
  });
  emitAnalysisProgress(
    onProgress,
    5,
    "discovering-own-vessel",
    `Scanning capture data to identify own vessel (pass 1 of 2)`,
    { pass: 1, passes: 2, segmentsTotal: captureSources.length },
  );
  const firstPass = await scanCaptureSources(captureSources, null, null, {
    onProgress(progress) {
      emitAnalysisProgress(
        onProgress,
        5 + progress.ratio * 38,
        "discovering-own-vessel",
        `Pass 1 of 2 · segment ${progress.segmentIndex + 1}/${progress.segmentsTotal}`,
        { ...progress, pass: 1, passes: 2 },
      );
    },
  });
  const ownContext = chooseOwnContext(firstPass.positionCounts, index.ownContext);
  const voyageWindow = {
    startMs: Date.parse(index.startedAt || ""),
    endMs: Date.parse(index.stoppedAt || ""),
  };
  emitAnalysisProgress(
    onProgress,
    43,
    "analysing-voyage",
    `Analysing own-vessel and suite data (pass 2 of 2)`,
    { pass: 2, passes: 2, segmentsTotal: captureSources.length },
  );
  const secondPass = await scanCaptureSources(
    captureSources,
    ownContext,
    voyageWindow,
    {
      onProgress(progress) {
        emitAnalysisProgress(
          onProgress,
          43 + progress.ratio * 42,
          "analysing-voyage",
          `Pass 2 of 2 · segment ${progress.segmentIndex + 1}/${progress.segmentsTotal}`,
          { ...progress, pass: 2, passes: 2 },
        );
      },
    },
  );
  emitAnalysisProgress(onProgress, 87, "reading-navigation-evidence", "Reading DR and navigation evidence");
  const drTracks = (await readVoyageDrTracks(voyagePath, index, maxTrackPoints)) ||
    buildDrTracks(secondPass.drTrackSamples, maxTrackPoints, "capture");
  // A completed bundle can intentionally contain only BITE/software evidence.
  // Do not promote injected or retained DR positions into an own-vessel voyage
  // track when the canonical input contains no explicit own-vessel position.
  const track = ownContext
    ? preferredVoyageTrack(sortTrack(secondPass.track), drTracks)
    : [];
  const snapshotEvidence = await readVoyageSnapshotEvidence(voyagePath);
  const observations = await readVoyageObservations(voyagePath);
  const routes = readVoyageRoutes(index);
  const gpsIntegrity = buildGpsIntegrityAnalysis([
    ...secondPass.gpsIntegritySamples,
    ...snapshotEvidence.gpsIntegritySamples,
  ]);
  const traffic = buildTrafficAnalysis(
    [
      ...secondPass.trafficNotificationSamples,
      ...snapshotEvidence.trafficAlertSamples,
    ],
    mergeTrafficProjectionMetrics(
      secondPass.trafficProjectionMetrics,
      snapshotEvidence.trafficProjectionMetrics,
    ),
    snapshotEvidence.trafficTargets,
  );
  const markers = hourlyMarkers(track);
  const summary = buildSummary(index, track, secondPass, firstPass, ownContext, gpsIntegrity, traffic);
  emitAnalysisProgress(onProgress, 91, "reading-review-evidence", "Reading BITE and completion evidence");
  const biteReports = await readVoyageBiteReports(voyagePath, index);
  const review = buildVoyageReview({
    index,
    track,
    summary,
    gpsIntegrity,
    traffic,
    drTracks,
    biteReports,
    replayVerification,
    snapshotEvidenceErrors: snapshotEvidence.errors,
  });

  emitAnalysisProgress(onProgress, 95, "building-review", "Building voyage review");
  return {
    id: index.id || path.basename(voyagePath, ".zip"),
    fileName: path.basename(voyagePath),
    sourceKind: "voyages",
    comment: index.comment || "",
    recomputedReplay: summarizeRecomputedReplay(index.recomputedReplay),
    replayVerification,
    gpxUrl: `${publicBase}/voyages/${encodeURIComponent(path.basename(voyagePath))}/track.gpx`,
    ownContext,
    summary,
    review,
    traffic,
    hourlyMarkers: markers,
    track: thinTrack(track, maxTrackPoints),
    drTracks,
    observations,
    routes,
    gpsIntegrity,
    originalTrackPoints: track.length,
  };
}

async function resolveVoyageDataSource(voyagePath, index = {}) {
  const canonicalInput = index?.canonicalInput;
  if (canonicalInput?.contract === CANONICAL_INPUT_CONTRACT) {
    const innerPath = String(
      canonicalInput.fileName || CANONICAL_INPUT_RELATIVE_PATH,
    );
    const entry = await zipEntryMetadata(voyagePath, innerPath);
    if (!entry) {
      throw new Error(
        `Voyage bundle declares ${CANONICAL_INPUT_CONTRACT}, but ${innerPath} is missing.`,
      );
    }
    return [{
      kind: "zip",
      voyagePath,
      innerPath,
      bytes: entry.uncompressedSize,
      contract: CANONICAL_INPUT_CONTRACT,
    }];
  }
  const recomputedOutput = index?.recomputedOutput || index?.recomputedReplay?.result?.output;
  const innerPath = String(recomputedOutput?.fileName || "");
  if (
    recomputedOutput?.contract === "ajrm-marine-recomputed-output-v1" &&
    recomputedOutput?.complete === true &&
    innerPath
  ) {
    const entry = await zipEntryMetadata(voyagePath, innerPath);
    if (!entry) {
      throw new Error(`Voyage bundle declares recomputed output, but ${innerPath} is missing.`);
    }
    return [{
      kind: "zip",
      voyagePath,
      innerPath,
      bytes: entry.uncompressedSize,
      contract: recomputedOutput.contract,
    }];
  }
  throw new Error(
    "Unsupported voyage bundle: expected canonical input or a complete recomputed output.",
  );
}

async function readVoyageDrTracks(voyagePath, index, maxTrackPoints) {
  const fileName = String(index?.drTrack?.fileName || DR_TRACK_RELATIVE_PATH);
  try {
    const text = await readZipEntryText(voyagePath, fileName);
    const samples = text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => normalizeDrTrackSample(JSON.parse(line)))
      .filter(Boolean);
    return buildDrTracks(samples, maxTrackPoints, "bundle");
  } catch {
    return null;
  }
}

async function scanCaptureSources(
  captureSources,
  ownContext,
  window = null,
  { onProgress = null } = {},
) {
  const result = {
    positionCounts: new Map(),
    track: [],
    drTrackSamples: [],
    gpsIntegritySamples: [],
    trafficNotificationSamples: [],
    trafficProjectionMetrics: emptyTrafficProjectionMetrics(),
    speedSamples: [],
    rudderSamples: [],
    rudderSampleCounts: { observed: 0, excluded: 0 },
    autopilotState: null,
    waterTemperatureSamples: [],
    maxSogKnots: null,
    maxApparentWindKnots: null,
    maxTrueWindKnots: null,
    minDepthMeters: null,
    sampleStart: null,
    sampleEnd: null,
  };
  const totalBytes = captureSources.reduce(
    (sum, source) => sum + Math.max(0, Number(source.bytes || 0)),
    0,
  );
  let completedBytes = 0;
  let lastProgressAt = 0;
  for (let index = 0; index < captureSources.length; index += 1) {
    const source = captureSources[index];
    await readCaptureSourceLines(
      source,
      (record) => {
        scanRecord(record, ownContext, result, window);
      },
      (sourceBytes) => {
        const now = Date.now();
        if (
          typeof onProgress !== "function" ||
          (now - lastProgressAt < 250 &&
            sourceBytes < Number(source.bytes || 0))
        ) {
          return;
        }
        lastProgressAt = now;
        const processedBytes = completedBytes + sourceBytes;
        onProgress({
          processedBytes,
          totalBytes,
          ratio: totalBytes > 0 ? Math.min(1, processedBytes / totalBytes) : 0,
          segmentIndex: index,
          segmentsTotal: captureSources.length,
          segmentName: source.innerPath || path.basename(source.path || ""),
        });
      },
    );
    completedBytes += Math.max(0, Number(source.bytes || 0));
  }
  return result;
}

async function readCaptureSourceLines(source, onRecord, onProgress = null) {
  await readCaptureLines(
    source.voyagePath,
    source.innerPath,
    onRecord,
    onProgress,
  );
}

function emptyScanResult() {
  return {
    positionCounts: new Map(),
    track: [],
    drTrackSamples: [],
    gpsIntegritySamples: [],
    trafficNotificationSamples: [],
    trafficProjectionMetrics: emptyTrafficProjectionMetrics(),
    speedSamples: [],
    rudderSamples: [],
    rudderSampleCounts: { observed: 0, excluded: 0 },
    autopilotState: null,
    waterTemperatureSamples: [],
    maxSogKnots: null,
    maxApparentWindKnots: null,
    maxTrueWindKnots: null,
    minDepthMeters: null,
    sampleStart: null,
    sampleEnd: null,
  };
}

function scanRecord(record, ownContext, result, window) {
  const delta = record?.delta || {};
  const context = String(delta.context || "");
  for (const update of delta.updates || []) {
    const timestamp = update.timestamp || record.capturedAt;
    if (ownContext && context === ownContext) {
      const stateItem = (update.values || []).find(
        (item) => String(item?.path || "") === "steering.autopilot.state",
      );
      if (stateItem) result.autopilotState = normalizeAutopilotState(stateItem.value);
    }
    for (const item of update.values || []) {
      const value = item.value;
      const valuePath = String(item.path || "");
      if (valuePath === AJRM_MARINE_GPS_INTEGRITY_STATE_PATH) {
        if (!isInsideWindow(timestamp, window)) continue;
        const sample = normalizeDrTrackSample(value, timestamp);
        if (sample) result.drTrackSamples.push(sample);
        const integritySample = normalizeGpsIntegritySample(value, timestamp);
        if (integritySample) result.gpsIntegritySamples.push(integritySample);
      } else if (isTrafficNotificationPath(valuePath)) {
        if (!isInsideWindow(timestamp, window)) continue;
        const samples = normalizeTrafficNotificationSamples(value, timestamp, valuePath);
        result.trafficNotificationSamples.push(...samples);
      } else if (valuePath === TRAFFIC_TARGETS_PATH) {
        if (!isInsideWindow(timestamp, window)) continue;
        accumulateTrafficProjectionMetrics(
          result.trafficProjectionMetrics,
          value,
          timestamp,
        );
      } else if (valuePath === "navigation.position" && isPosition(value)) {
        result.positionCounts.set(context, (result.positionCounts.get(context) || 0) + 1);
        touchSampleTimes(result, timestamp);
        if (!ownContext || context !== ownContext) continue;
        if (!isInsideWindow(timestamp, window)) continue;
        result.track.push({
          ts: timestamp,
          lat: Number(value.latitude),
          lon: Number(value.longitude),
          sogKnots: null,
        });
      } else if (ownContext && context === ownContext && valuePath === "navigation.speedOverGround") {
        if (!isInsideWindow(timestamp, window)) continue;
        const knots = metersPerSecondToKnots(value);
        if (Number.isFinite(knots)) {
          result.speedSamples.push({ ts: timestamp, knots });
          result.maxSogKnots = maxNumber(result.maxSogKnots, knots);
        }
      } else if (ownContext && context === ownContext && isWindSpeedPath(valuePath)) {
        if (!isInsideWindow(timestamp, window)) continue;
        const knots = metersPerSecondToKnots(value);
        if (!Number.isFinite(knots)) continue;
        if (valuePath.includes("speedApparent")) {
          result.maxApparentWindKnots = maxNumber(result.maxApparentWindKnots, knots);
        } else if (valuePath.includes("speedTrue")) {
          result.maxTrueWindKnots = maxNumber(result.maxTrueWindKnots, knots);
        }
      } else if (ownContext && context === ownContext && valuePath === "environment.depth.belowTransducer") {
        if (!isInsideWindow(timestamp, window)) continue;
        const meters = numberOrNull(value);
        if (Number.isFinite(meters)) {
          result.minDepthMeters =
            result.minDepthMeters == null ? meters : Math.min(result.minDepthMeters, meters);
        }
      } else if (ownContext && context === ownContext && valuePath === "steering.rudderAngle") {
        if (!isInsideWindow(timestamp, window)) continue;
        const radians = numberOrNull(value);
        if (radians !== null) {
          result.rudderSampleCounts.observed += 1;
          if (isAutopilotEngagedState(result.autopilotState)) {
            result.rudderSamples.push({
              ts: timestamp,
              degrees: signedDegreesFromRadians(radians),
              autopilotState: result.autopilotState,
            });
          } else {
            result.rudderSampleCounts.excluded += 1;
          }
        }
      } else if (ownContext && context === ownContext && valuePath === "environment.water.temperature") {
        if (!isInsideWindow(timestamp, window)) continue;
        const kelvin = numberOrNull(value);
        if (kelvin !== null) {
          result.waterTemperatureSamples.push({ ts: timestamp, celsius: kelvin - 273.15 });
        }
      }
    }
  }
}

function normalizeDrTrackSample(value, fallbackTimestamp = null) {
  const state = unwrapValue(value);
  if (!state || typeof state !== "object") return null;
  const ts = state.ts || state.timestamp || fallbackTimestamp;
  const gps = normalizeDrPoint(state.gps || state.gps?.position);
  const operational = normalizeDrPoint(
    state.operational ||
      state.operationalDeadReckoning ||
      state.deadReckoning,
  );
  const integrity = normalizeDrPoint(state.integrity || state.integrityDeadReckoning);
  if (!ts || (!gps && !operational && !integrity)) return null;
  return {
    ts,
    trust: state.trust || null,
    acceptedGps: state.acceptedGps === true,
    gps,
    operational,
    integrity,
    integrityAssurance: normalizeIntegrityAssurance(state.integrityAssurance),
    navigationReference:
      normalizeNavigationReferenceProvenance(state.navigationReference) ||
      normalizeNavigationReferenceProvenance(
        state.navigationProvenance?.navigationReference,
      ),
    reasons: Array.isArray(state.reasons) ? state.reasons.slice(0, 5) : [],
  };
}

function normalizeGpsIntegritySample(value, fallbackTimestamp = null) {
  const state = unwrapValue(value);
  if (!state || typeof state !== "object") return null;
  const ts = state.ts || state.timestamp || fallbackTimestamp;
  if (!ts) return null;
  const diagnostics = state.diagnostics && typeof state.diagnostics === "object" ? state.diagnostics : {};
  const operational = state.operationalDeadReckoning || state.deadReckoning || {};
  const integrity = state.integrityDeadReckoning || {};
  const integrityAssurance = normalizeIntegrityAssurance(state.integrityAssurance);
  const navigationReference =
    normalizeNavigationReferenceProvenance(state.navigationReference) ||
    normalizeNavigationReferenceProvenance(
      state.navigationProvenance?.navigationReference,
    );
  return {
    ts,
    trust: stringOrNull(state.trust) || "unknown",
    notificationState: stringOrNull(state.notificationState),
    acceptedGps: state.acceptedGps === true,
    reasons: Array.isArray(state.reasons) ? state.reasons.map(String).slice(0, 8) : [],
    counters: normalizeGpsIntegrityCounters(state.counters),
    gps: {
      fixValid: state.gps?.fixValid === true,
      explicitGpsUnavailable: state.gps?.explicitGpsUnavailable === true,
      positionTimestamp: stringOrNull(state.gps?.positionTimestamp),
      lastReceivedPositionTimestamp: stringOrNull(state.gps?.lastReceivedPositionTimestamp),
      positionAgeSeconds: numberOrNull(state.gps?.positionAgeSeconds),
      hdop: numberOrNull(state.gps?.hdop),
      satellites: numberOrNull(state.gps?.satellites),
    },
    current: {
      available: state.current?.available === true,
      source: stringOrNull(state.current?.source),
      providerSource: stringOrNull(state.current?.providerSource),
      origin: stringOrNull(state.current?.origin),
      gpsDependent: booleanOrNull(state.current?.gpsDependent),
      quality: stringOrNull(state.current?.quality),
      ageSeconds: numberOrNull(state.current?.ageSeconds),
      driftKnots: numberOrNull(state.current?.driftKnots),
      setTrueDegrees: numberOrNull(state.current?.setTrueDegrees),
    },
    deadReckoning: {
      operationalSource: stringOrNull(operational.source) || stringOrNull(diagnostics.deadReckoning?.operationalSource),
      operationalAgeSeconds: numberOrNull(operational.ageSeconds ?? diagnostics.deadReckoning?.operationalAgeSeconds),
      operationalUncertaintyRadiusMeters: numberOrNull(
        operational.uncertaintyRadiusMeters ?? diagnostics.deadReckoning?.operationalUncertaintyRadiusMeters,
      ),
      operationalGpsDependent: booleanOrNull(operational.gpsDependent),
      operationalLeewayStatus: stringOrNull(operational.leewayStatus),
      operationalCurrentOrigin: stringOrNull(operational.currentOrigin),
      operationalProvenance: normalizeDrProvenance(operational.provenance),
      integritySource: stringOrNull(integrity.source) || stringOrNull(diagnostics.deadReckoning?.integritySource),
      integrityAgeSeconds: numberOrNull(integrity.ageSeconds ?? diagnostics.deadReckoning?.integrityAgeSeconds),
      integrityUncertaintyRadiusMeters: numberOrNull(
        integrity.uncertaintyRadiusMeters ?? diagnostics.deadReckoning?.integrityUncertaintyRadiusMeters,
      ),
      integrityAssurance: stringOrNull(integrity.assurance) || integrityAssurance?.status || null,
      integrityComparisonAvailable:
        booleanOrNull(integrity.comparisonAvailable) ??
        integrityAssurance?.comparisonAvailable ??
        null,
      integrityUnavailableReason:
        longStringOrNull(integrity.unavailableReason) ||
        integrityAssurance?.reason ||
        null,
      integrityGpsDependent: booleanOrNull(integrity.gpsDependent),
      integrityLeewayStatus:
        stringOrNull(integrity.leewayStatus) ||
        integrityAssurance?.leewayStatus ||
        null,
      integrityCurrentOrigin: stringOrNull(integrity.currentOrigin),
      integrityProvenance: normalizeDrProvenance(integrity.provenance),
    },
    integrityAssurance,
    navigationReference,
    diagnostics: {
      contract: stringOrNull(diagnostics.contract),
      decision: diagnostics.decision && typeof diagnostics.decision === "object"
        ? {
            positionJumpRejected: diagnostics.decision.positionJumpRejected === true,
            degradedSignalActive: diagnostics.decision.degradedSignalActive === true,
            drDiscrepancyActive: diagnostics.decision.drDiscrepancyActive === true,
          }
        : null,
      thresholds: diagnostics.thresholds && typeof diagnostics.thresholds === "object"
        ? {
            gpsLostSeconds: numberOrNull(diagnostics.thresholds.gpsLostSeconds),
            maxHdop: numberOrNull(diagnostics.thresholds.maxHdop),
            minSatellites: numberOrNull(diagnostics.thresholds.minSatellites),
            warningDrDiscrepancyMeters: numberOrNull(diagnostics.thresholds.warningDrDiscrepancyMeters),
            alarmDrDiscrepancyMeters: numberOrNull(diagnostics.thresholds.alarmDrDiscrepancyMeters),
          }
        : null,
    },
  };
}

function normalizeGpsIntegrityCounters(value = {}) {
  return {
    evaluations: countOrNull(value.evaluations),
    acceptedFixes: countOrNull(value.acceptedFixes),
    rejectedFixes: countOrNull(value.rejectedFixes),
    positionJumps: countOrNull(value.positionJumps),
    lostFixes: countOrNull(value.lostFixes),
    degradedSignals: countOrNull(value.degradedSignals),
    drDiscrepancies: countOrNull(value.drDiscrepancies),
  };
}

function isTrafficNotificationPath(valuePath) {
  return valuePath === "plugins.ajrmMarineNotifications" ||
    valuePath.startsWith("notifications.") ||
    valuePath.includes(".notifications.");
}

function normalizeTrafficNotificationSamples(value, fallbackTimestamp = null, valuePath = "") {
  const unwrapped = unwrapValue(value);
  const records = [];
  if (!unwrapped || typeof unwrapped !== "object") return records;
  if (unwrapped.contract === "notifications-plus-projection") {
    for (const item of [...(unwrapped.active || []), ...(unwrapped.recentActivity || [])]) {
      const record = normalizeTrafficNotificationItem(item, fallbackTimestamp, valuePath);
      if (record) records.push(record);
    }
    return records;
  }
  const record = normalizeTrafficNotificationItem(unwrapped, fallbackTimestamp, valuePath);
  if (record) records.push(record);
  return records;
}

function normalizeTrafficNotificationItem(item, fallbackTimestamp, valuePath) {
  if (!item || typeof item !== "object") return null;
  const presentation = item.presentation && typeof item.presentation === "object" ? item.presentation : {};
  const context = item.context && typeof item.context === "object" ? item.context : {};
  const message = stringOrNull(presentation.message) ||
    stringOrNull(presentation.audioMessage) ||
    stringOrNull(item.message);
  const label = stringOrNull(presentation.label) || stringOrNull(item.label);
  const provider = stringOrNull(item.provider);
  const category = stringOrNull(presentation.category) || stringOrNull(item.category);
  if (provider && provider !== "ajrm-marine-traffic") return null;
  if (!isTrafficAlert({ provider, category })) return null;
  const eventId = stringOrNull(item.eventId) ||
    `${fallbackTimestamp || ""}:${provider || ""}:${category || ""}:${context.mmsi || context.targetContext || ""}`.slice(0, 240);
  const severity = trafficSeverity(item.priority?.level, item.state);
  if (!severity) return null;
  const size = trafficVesselSize(context.vesselSize);
  const cpaMeters = numberOrNull(context.cpaMeters);
  const announcementSchedule =
    context.announcementSchedule &&
    typeof context.announcementSchedule === "object"
      ? context.announcementSchedule
      : null;
  return {
    ts: stringOrNull(item.timestamp) || fallbackTimestamp,
    eventId,
    severity,
    label: label || (severity === "collision" ? "Collision alarm" : "Traffic advisory"),
    message: message || "",
    title: stringOrNull(presentation.title),
    mmsi: stringOrNull(context.mmsi) || extractMmsi(context.targetContext) || extractMmsi(valuePath),
    targetContext: stringOrNull(context.targetContext),
    size,
    cpaMeters,
    tcpaSeconds: numberOrNull(context.tcpaSeconds),
    announcementSchedule: announcementSchedule
      ? {
          effectiveRepeatSeconds: numberOrNull(
            announcementSchedule.effectiveRepeatSeconds,
          ),
          targetObservationAgeSeconds: numberOrNull(
            announcementSchedule.targetObservationAgeSeconds,
          ),
          targetObservationMaxAgeSeconds: numberOrNull(
            announcementSchedule.targetObservationMaxAgeSeconds,
          ),
          targetObservationRecent:
            booleanOrNull(announcementSchedule.targetObservationRecent),
          reason: stringOrNull(announcementSchedule.reason),
        }
      : null,
  };
}

function emptyTrafficProjectionMetrics() {
  return {
    available: false,
    projectionUpdates: 0,
    targetObservations: 0,
    projectedPositions: 0,
    unusablePositions: 0,
    staleTargets: 0,
    maxMeasurementAgeSeconds: null,
    maxProjectionSeconds: null,
    maxAnnouncementLeadSeconds: null,
    reasons: {},
    firstAt: null,
    lastAt: null,
  };
}

async function readVoyageSnapshotEvidence(voyagePath) {
  const entries = await listZipEntries(voyagePath);
  const snapshotEntries = entries
    .map((entry) => entry.fileName)
    .filter((fileName) =>
      /^(snapshots\/[^/]+\.json|observations\/evidence\/[^/]+\.json)$/.test(fileName),
    );
  const evidence = {
    gpsIntegritySamples: [],
    trafficAlertSamples: [],
    trafficTargets: [],
    trafficProjectionMetrics: emptyTrafficProjectionMetrics(),
    errors: [],
  };
  for (const fileName of snapshotEntries) {
    let document;
    try {
      document = await readZipJson(voyagePath, fileName);
    } catch (error) {
      evidence.errors.push({
        fileName,
        error: String(error?.message || error).slice(0, 300),
      });
      continue;
    }
    const snapshot = document?.snapshot && typeof document.snapshot === "object"
      ? document.snapshot
      : document;
    const timestamp =
      stringOrNull(snapshot?.timestamp) ||
      stringOrNull(document?.recordedAt) ||
      null;
    const suite = snapshot?.suiteDiagnostics;
    if (!suite || typeof suite !== "object") continue;

    const integrityState = unwrapValue(
      suite.ajrmMarineGpsIntegrity?.navigationIntegrity,
    );
    const integritySample = normalizeGpsIntegritySample(
      integrityState,
      timestamp,
    );
    if (integritySample) evidence.gpsIntegritySamples.push(integritySample);

    const trafficState = unwrapValue(suite.trafficCore?.targets);
    if (
      !trafficState ||
      trafficState.contract !== "ajrm-marine-traffic-targets" ||
      !Array.isArray(trafficState.targets)
    ) {
      continue;
    }
    const trafficTimestamp =
      stringOrNull(trafficState.generatedAt) || timestamp;
    accumulateTrafficProjectionMetrics(
      evidence.trafficProjectionMetrics,
      trafficState,
      trafficTimestamp,
    );
    for (const target of trafficState.targets) {
      const normalizedTarget = normalizeSnapshotTrafficTarget(
        target,
        trafficTimestamp,
      );
      if (!normalizedTarget) continue;
      evidence.trafficTargets.push(normalizedTarget.target);
      if (normalizedTarget.alert) {
        evidence.trafficAlertSamples.push(normalizedTarget.alert);
      }
    }
  }
  return evidence;
}

async function readVoyageObservations(voyagePath) {
  let text;
  try {
    text = await readZipEntryText(voyagePath, OBSERVATIONS_RELATIVE_PATH);
  } catch {
    return [];
  }
  const observations = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      observations.push({
        id: `invalid-${index + 1}`,
        recordedAt: null,
        text: "Unreadable voyage note",
        source: null,
        position: null,
        evidenceError: `Invalid JSON on line ${index + 1}`,
      });
      continue;
    }
    const evidenceFile = stringOrNull(record?.evidence?.fileName);
    let position = null;
    let evidenceError = stringOrNull(record?.evidenceError);
    if (evidenceFile) {
      try {
        const document = await readZipJson(voyagePath, evidenceFile);
        const snapshot = document?.snapshot && typeof document.snapshot === "object"
          ? document.snapshot
          : document;
        position = normalizeObservationPosition(
          snapshot?.self?.position || snapshot?.self?.navigation?.position,
        );
      } catch (error) {
        evidenceError = evidenceError || String(error?.message || error).slice(0, 300);
      }
    }
    observations.push({
      id: stringOrNull(record?.id) || `note-${index + 1}`,
      recordedAt: stringOrNull(record?.recordedAt),
      replayOriginalAt: stringOrNull(record?.replayOriginalAt),
      voyageElapsedSeconds: numberOrNull(record?.voyageElapsedSeconds),
      text: String(record?.text || "").trim().slice(0, 2000),
      source: stringOrNull(record?.source),
      position,
      evidenceError,
    });
  }
  return observations.sort((left, right) =>
    (Date.parse(left.recordedAt || "") || 0) - (Date.parse(right.recordedAt || "") || 0),
  );
}

function normalizeObservationPosition(value) {
  const latitude = numberOrNull(value?.latitude);
  const longitude = numberOrNull(value?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { lat: latitude, lon: longitude };
}

function readVoyageRoutes(index = {}) {
  const records = [];
  if (index.routeAtStart) {
    records.push({ at: index.startedAt || null, action: "active-at-start", selection: index.routeAtStart });
  }
  for (const record of Array.isArray(index.routeSelections) ? index.routeSelections : []) {
    if (record?.action === "active-at-start" && records.length) continue;
    records.push(record);
  }
  return records
    .map((record, sequence) => normalizeVoyageRoute(record, sequence))
    .filter(Boolean);
}

function normalizeVoyageRoute(record, sequence) {
  const selection = record?.selection;
  if (!selection && record?.action === "closed") {
    return {
      sequence,
      at: stringOrNull(record?.at),
      action: "closed",
      name: "Route closed",
      reversed: false,
      closed: true,
      points: [],
    };
  }
  const coordinates = selection?.resource?.feature?.geometry?.coordinates;
  if (
    selection?.contract !== "ajrm-marine-display-active-route-v1" ||
    selection?.resource?.feature?.geometry?.type !== "LineString" ||
    !Array.isArray(coordinates)
  ) return null;
  const points = coordinates
    .map((point) => ({ lon: Number(point?.[0]), lat: Number(point?.[1]) }))
    .filter((point) =>
      Number.isFinite(point.lat) && Number.isFinite(point.lon) &&
      point.lat >= -90 && point.lat <= 90 && point.lon >= -180 && point.lon <= 180,
    );
  if (points.length < 2) return null;
  return {
    sequence,
    at: stringOrNull(record?.at),
    action: stringOrNull(record?.action) || "opened",
    name:
      stringOrNull(selection?.resource?.name) ||
      stringOrNull(selection?.resourceId) ||
      "Unnamed route",
    reversed: selection?.reversed === true,
    closed: false,
    points,
  };
}

function normalizeSnapshotTrafficTarget(target, timestamp) {
  if (!target || typeof target !== "object") return null;
  const encounter = target.encounter && typeof target.encounter === "object"
    ? target.encounter
    : {};
  const mmsi = stringOrNull(target.mmsi) || extractMmsi(target.id);
  const name = stringOrNull(target.name);
  const targetContext = stringOrNull(target.id);
  const key = mmsi || targetContext || name;
  if (!key) return null;
  const size = trafficVesselSize(encounter.vesselSize);
  const state = stringOrNull(encounter.state);
  const severity = trafficSeverity(null, state);
  return {
    target: {
      key,
      name: name || "",
      mmsi: mmsi || "",
      targetContext,
      size,
    },
    alert: severity
      ? {
          ts: timestamp,
          eventId: `snapshot:${key}:${String(state).toLowerCase()}`,
          severity,
          label: severity === "collision" ? "Collision alarm" : "Traffic advisory",
          message: "",
          title: name,
          mmsi,
          targetContext,
          size,
          cpaMeters: numberOrNull(encounter.cpa),
          tcpaSeconds: numberOrNull(encounter.tcpa),
          announcementSchedule: null,
          evidenceSource: "snapshot",
        }
      : null,
  };
}

function mergeTrafficProjectionMetrics(left, right) {
  const merged = emptyTrafficProjectionMetrics();
  const sources = [left, right].filter(Boolean);
  merged.available = sources.some((source) => source.available === true);
  for (const source of sources) {
    for (const key of [
      "projectionUpdates",
      "targetObservations",
      "projectedPositions",
      "unusablePositions",
      "staleTargets",
    ]) {
      merged[key] += Number(source[key]) || 0;
    }
    merged.maxMeasurementAgeSeconds = maxNumber(
      merged.maxMeasurementAgeSeconds,
      source.maxMeasurementAgeSeconds,
    );
    merged.maxProjectionSeconds = maxNumber(
      merged.maxProjectionSeconds,
      source.maxProjectionSeconds,
    );
    merged.maxAnnouncementLeadSeconds = maxNumber(
      merged.maxAnnouncementLeadSeconds,
      source.maxAnnouncementLeadSeconds,
    );
    for (const [reason, count] of Object.entries(source.reasons || {})) {
      merged.reasons[reason] = (merged.reasons[reason] || 0) + (Number(count) || 0);
    }
    if (source.firstAt && (!merged.firstAt || source.firstAt < merged.firstAt)) {
      merged.firstAt = source.firstAt;
    }
    if (source.lastAt && (!merged.lastAt || source.lastAt > merged.lastAt)) {
      merged.lastAt = source.lastAt;
    }
  }
  return merged;
}

function accumulateTrafficProjectionMetrics(metrics, value, timestamp) {
  const projection = unwrapValue(value);
  if (!projection || typeof projection !== "object") return;
  const targets = Array.isArray(projection.targets) ? projection.targets : [];
  metrics.available = true;
  metrics.projectionUpdates += 1;
  metrics.firstAt = metrics.firstAt || timestamp || null;
  metrics.lastAt = timestamp || metrics.lastAt;
  for (const target of targets) {
    const encounter =
      target?.encounter && typeof target.encounter === "object"
        ? target.encounter
        : {};
    const positionProjection =
      encounter.targetPositionProjection &&
      typeof encounter.targetPositionProjection === "object"
        ? encounter.targetPositionProjection
        : {};
    metrics.targetObservations += 1;
    if (positionProjection.projected === true) metrics.projectedPositions += 1;
    if (positionProjection.usable === false) metrics.unusablePositions += 1;
    if (target?.freshness?.stale === true) metrics.staleTargets += 1;
    metrics.maxMeasurementAgeSeconds = maxNumber(
      metrics.maxMeasurementAgeSeconds,
      millisecondsToSeconds(positionProjection.ageMs),
    );
    metrics.maxProjectionSeconds = maxNumber(
      metrics.maxProjectionSeconds,
      numberOrNull(positionProjection.projectionSeconds),
    );
    metrics.maxAnnouncementLeadSeconds = maxNumber(
      metrics.maxAnnouncementLeadSeconds,
      numberOrNull(encounter.announcementLeadSeconds),
    );
    const reason = stringOrNull(positionProjection.reason);
    if (reason && positionProjection.usable === false) {
      metrics.reasons[reason] = (metrics.reasons[reason] || 0) + 1;
    }
  }
}

function millisecondsToSeconds(value) {
  const milliseconds = numberOrNull(value);
  return milliseconds === null ? null : milliseconds / 1000;
}

function isTrafficAlert({ provider, category }) {
  return provider === "ajrm-marine-traffic" && category === "cpa";
}

function trafficSeverity(priorityLevel, state) {
  const level = String(priorityLevel || state || "").trim().toLowerCase();
  if (["alarm", "emergency", "danger"].includes(level)) return "collision";
  if (["warn", "warning", "advisory", "alert"].includes(level)) return "advisory";
  return null;
}

function trafficVesselSize(value) {
  const size = String(value || "").trim().toLowerCase();
  return ["small", "medium", "large"].includes(size) ? size : "unknown";
}

function extractMmsi(value) {
  const text = String(value || "");
  const match = text.match(/mmsi[:/.-]?(\d{6,10})/i) || text.match(/\b(\d{9})\b/);
  return match ? match[1] : null;
}

function countOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function normalizeDrPoint(value) {
  const source = value?.position || value;
  if (!source) return null;
  const lat = numberOrNull(source.lat ?? source.latitude);
  const lon = numberOrNull(source.lon ?? source.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    lat,
    lon,
    source: stringOrNull(value?.source),
    ageSeconds: numberOrNull(value?.ageSeconds),
    uncertaintyRadiusMeters: numberOrNull(value?.uncertaintyRadiusMeters),
    gpsDependent: booleanOrNull(value?.gpsDependent),
    leewayStatus: stringOrNull(value?.leewayStatus),
    currentOrigin: stringOrNull(value?.currentOrigin),
    assurance: stringOrNull(value?.assurance),
    comparisonAvailable: booleanOrNull(value?.comparisonAvailable),
    unavailableReason: longStringOrNull(value?.unavailableReason),
    provenance: normalizeDrProvenance(value?.provenance),
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
    !value ||
    value.contract !== "ajrm-marine-navigation-reference" ||
    Number(value.schemaVersion) !== 1
  ) {
    return null;
  }
  const reference = value.clockReference;
  return {
    contract: value.contract,
    schemaVersion: 1,
    status: stringOrNull(value.status),
    clockReference:
      reference && typeof reference === "object"
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
    heading: normalizeDrEvidence(value.heading),
    trackThroughWater: normalizeDrEvidence(value.trackThroughWater),
    speedThroughWater: normalizeDrEvidence(value.speedThroughWater),
    current: normalizeDrEvidence(value.current),
    leeway: normalizeDrEvidence(value.leeway),
  };
}

function normalizeDrEvidence(value) {
  if (!value || typeof value !== "object") return null;
  return {
    source: stringOrNull(value.source),
    sourceKind: stringOrNull(value.sourceKind),
    method: stringOrNull(value.method),
    origin: stringOrNull(value.origin),
    ageMs: numberOrNull(value.ageMs),
    uncertaintyRad: numberOrNull(value.uncertaintyRad),
    gpsDependent: booleanOrNull(value.gpsDependent),
  };
}

function longStringOrNull(value) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 500)
    : null;
}

function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildDrTracks(samples, maxTrackPoints, source) {
  const sorted = (Array.isArray(samples) ? samples : [])
    .filter((sample) => sample?.ts)
    .sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));
  if (!sorted.length) return null;
  const gps = [];
  const operational = [];
  const integrity = [];
  const recoveryJumps = [];
  let suppressedIntegrityComparisons = 0;
  let lastSuppressedIntegrityComparison = null;
  let latestOperationalEvidence = null;
  let latestIntegrityEvidence = null;
  let latestIntegrityAssurance = null;
  let latestNavigationReference = null;
  let previousOperational = null;
  let previousTrust = null;
  for (const sample of sorted) {
    if (sample.gps) gps.push(drTrackPoint(sample, sample.gps));
    if (sample.operational) {
      const point = drTrackPoint(sample, sample.operational);
      operational.push(point);
      latestOperationalEvidence = drTrackEvidence(sample.operational);
      if (
        previousOperational &&
        previousTrust === "lost" &&
        sample.trust !== "lost" &&
        haversineMeters(previousOperational, point) >= 10
      ) {
        recoveryJumps.push({
          from: previousOperational,
          to: point,
          ts: sample.ts,
          meters: haversineMeters(previousOperational, point),
        });
      }
      previousOperational = point;
    }
    if (sample.integrity) {
      latestIntegrityEvidence = drTrackEvidence(sample.integrity);
      if (sample.gps && sample.trust !== "lost") {
        if (integrityComparisonExplicitlyUnavailable(sample)) {
          suppressedIntegrityComparisons += 1;
          lastSuppressedIntegrityComparison = {
            ts: sample.ts,
            integrity: drTrackEvidence(sample.integrity),
            assurance: sample.integrityAssurance || null,
          };
        } else {
          integrity.push(drTrackPoint(sample, sample.integrity));
        }
      }
    }
    if (sample.integrityAssurance) latestIntegrityAssurance = sample.integrityAssurance;
    if (sample.navigationReference) latestNavigationReference = sample.navigationReference;
    previousTrust = sample.trust;
  }
  if (gps.length < 2 && operational.length < 2 && integrity.length < 2) return null;
  return {
    source,
    samples: sorted.length,
    gps: thinTrack(gps, maxTrackPoints),
    operational: thinTrack(operational, maxTrackPoints),
    integrity: thinTrack(integrity, maxTrackPoints),
    recoveryJumps,
    suppressedIntegrityComparisons,
    lastSuppressedIntegrityComparison,
    provenance: {
      operational: latestOperationalEvidence,
      integrity: latestIntegrityEvidence,
      integrityAssurance: latestIntegrityAssurance,
      navigationReference: latestNavigationReference,
    },
    original: {
      gps: gps.length,
      operational: operational.length,
      integrity: integrity.length,
    },
  };
}

function drTrackPoint(sample, point) {
  return {
    ts: sample.ts,
    lat: point.lat,
    lon: point.lon,
    trust: sample.trust || null,
    source: point.source || null,
    ageSeconds: numberOrNull(point.ageSeconds),
    uncertaintyRadiusMeters: numberOrNull(point.uncertaintyRadiusMeters),
    gpsDependent: booleanOrNull(point.gpsDependent),
    leewayStatus: stringOrNull(point.leewayStatus),
    currentOrigin: stringOrNull(point.currentOrigin),
    assurance: stringOrNull(point.assurance),
    comparisonAvailable: booleanOrNull(point.comparisonAvailable),
    unavailableReason: longStringOrNull(point.unavailableReason),
    provenance: normalizeDrProvenance(point.provenance),
  };
}

function drTrackEvidence(point) {
  return {
    source: stringOrNull(point?.source),
    ageSeconds: numberOrNull(point?.ageSeconds),
    uncertaintyRadiusMeters: numberOrNull(point?.uncertaintyRadiusMeters),
    gpsDependent: booleanOrNull(point?.gpsDependent),
    leewayStatus: stringOrNull(point?.leewayStatus),
    currentOrigin: stringOrNull(point?.currentOrigin),
    assurance: stringOrNull(point?.assurance),
    comparisonAvailable: booleanOrNull(point?.comparisonAvailable),
    unavailableReason: longStringOrNull(point?.unavailableReason),
    provenance: normalizeDrProvenance(point?.provenance),
  };
}

function integrityComparisonExplicitlyUnavailable(sample) {
  return (
    sample?.integrity?.comparisonAvailable === false ||
    sample?.integrityAssurance?.comparisonAvailable === false
  );
}

function preferredVoyageTrack(rawTrack, drTracks) {
  const operational = Array.isArray(drTracks?.operational) ? drTracks.operational : [];
  if (drTracks?.source === "bundle" && operational.length > 1) {
    return operational.map((point) => ({
      ts: point.ts,
      lat: point.lat,
      lon: point.lon,
      sogKnots: null,
    }));
  }
  return rawTrack;
}

function chooseOwnContext(positionCounts, preferredContext = null) {
  const preferred = String(preferredContext || "").trim();
  if (preferred && positionCounts.has(preferred)) return preferred;
  if (positionCounts.has("vessels.self")) return "vessels.self";
  let selected = null;
  let selectedCount = 0;
  for (const [context, count] of positionCounts.entries()) {
    if (count > selectedCount) {
      selected = context;
      selectedCount = count;
    }
  }
  return selected;
}

function buildGpsIntegrityAnalysis(samples) {
  const sorted = (Array.isArray(samples) ? samples : [])
    .filter((sample) => sample?.ts)
    .sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));
  if (!sorted.length) {
    return {
      samples: 0,
      events: [],
      summary: {
        available: false,
      },
    };
  }

  const events = [];
  const finalCounters = voyageCounterIncrements(sorted);
  let previous = null;
  let lostStart = null;
  let lostPeriods = 0;
  let totalLostSeconds = 0;
  let longestLostSeconds = 0;
  let maxPositionAgeSeconds = null;
  let maxOperationalUncertaintyMeters = null;
  let maxIntegrityUncertaintyMeters = null;
  let integrityComparisonSamples = 0;
  let integrityComparisonUnavailableSamples = 0;

  for (const sample of sorted) {
    maxPositionAgeSeconds = maxNumber(maxPositionAgeSeconds, sample.gps?.positionAgeSeconds);
    maxOperationalUncertaintyMeters = maxNumber(
      maxOperationalUncertaintyMeters,
      sample.deadReckoning?.operationalUncertaintyRadiusMeters,
    );
    maxIntegrityUncertaintyMeters = maxNumber(
      maxIntegrityUncertaintyMeters,
      sample.deadReckoning?.integrityUncertaintyRadiusMeters,
    );
    if (sample.deadReckoning?.integrityComparisonAvailable === true) {
      integrityComparisonSamples += 1;
    } else if (sample.deadReckoning?.integrityComparisonAvailable === false) {
      integrityComparisonUnavailableSamples += 1;
    }

    const lost = isGpsLostIntegritySample(sample);
    if (lost && !lostStart) {
      lostStart = sample.ts;
      lostPeriods += 1;
      events.push(gpsIntegrityEvent(sample, "gps-lost", "GPS lost or invalid"));
    } else if (!lost && lostStart) {
      const seconds = secondsBetween(lostStart, sample.ts);
      totalLostSeconds += seconds;
      longestLostSeconds = Math.max(longestLostSeconds, seconds);
      events.push(gpsIntegrityEvent(sample, "gps-recovered", "GPS recovered"));
      lostStart = null;
    }

    const counterEvents = gpsIntegrityCounterEvents(previous, sample);
    events.push(...counterEvents);
    if (previous && sample.trust !== previous.trust) {
      events.push(gpsIntegrityEvent(sample, "trust-change", `Trust changed to ${sample.trust}`));
    }
    previous = sample;
  }

  if (lostStart) {
    const seconds = secondsBetween(lostStart, sorted[sorted.length - 1].ts);
    totalLostSeconds += seconds;
    longestLostSeconds = Math.max(longestLostSeconds, seconds);
  }

  const finalSample = sorted[sorted.length - 1];
  const finalAssurance =
    finalSample.deadReckoning?.integrityAssurance ||
    finalSample.integrityAssurance?.status ||
    null;
  const finalComparisonAvailable =
    finalSample.deadReckoning?.integrityComparisonAvailable ??
    finalSample.integrityAssurance?.comparisonAvailable ??
    null;
  const finalIntegrityReason =
    finalSample.deadReckoning?.integrityUnavailableReason ||
    finalSample.integrityAssurance?.reason ||
    null;

  return {
    samples: sorted.length,
    firstAt: sorted[0].ts,
    lastAt: sorted[sorted.length - 1].ts,
    finalTrust: finalSample.trust,
    finalNotificationState: finalSample.notificationState,
    finalCounters,
    provenance: {
      operational: {
        source: finalSample.deadReckoning?.operationalSource || null,
        gpsDependent: finalSample.deadReckoning?.operationalGpsDependent ?? null,
        leewayStatus: finalSample.deadReckoning?.operationalLeewayStatus || null,
        currentOrigin: finalSample.deadReckoning?.operationalCurrentOrigin || null,
        inputs: finalSample.deadReckoning?.operationalProvenance || null,
      },
      integrity: {
        source: finalSample.deadReckoning?.integritySource || null,
        assurance: finalAssurance,
        comparisonAvailable: finalComparisonAvailable,
        unavailableReason: finalIntegrityReason,
        gpsDependent: finalSample.deadReckoning?.integrityGpsDependent ?? null,
        leewayStatus: finalSample.deadReckoning?.integrityLeewayStatus || null,
        currentOrigin: finalSample.deadReckoning?.integrityCurrentOrigin || null,
        inputs: finalSample.deadReckoning?.integrityProvenance || null,
      },
      current: finalSample.current || null,
      navigationReference: finalSample.navigationReference || null,
    },
    events: events.slice(-250),
    summary: {
      available: true,
      samples: sorted.length,
      finalTrust: finalSample.trust,
      evaluations: finalCounters.evaluations ?? null,
      acceptedFixes: finalCounters.acceptedFixes ?? null,
      rejectedFixes: finalCounters.rejectedFixes ?? null,
      positionJumps: finalCounters.positionJumps ?? null,
      lostFixes: finalCounters.lostFixes ?? null,
      degradedSignals: finalCounters.degradedSignals ?? null,
      drDiscrepancies: finalCounters.drDiscrepancies ?? null,
      lostPeriods,
      totalLostSeconds,
      longestLostSeconds,
      maxPositionAgeSeconds,
      maxOperationalUncertaintyMeters,
      maxIntegrityUncertaintyMeters,
      finalIntegrityAssurance: finalAssurance,
      finalComparisonAvailable,
      finalIntegrityReason,
      integrityComparisonSamples,
      integrityComparisonUnavailableSamples,
      finalOperationalGpsDependent:
        finalSample.deadReckoning?.operationalGpsDependent ?? null,
      finalOperationalLeewayStatus:
        finalSample.deadReckoning?.operationalLeewayStatus || null,
      finalOperationalCurrentOrigin:
        finalSample.deadReckoning?.operationalCurrentOrigin || null,
      finalIntegrityGpsDependent:
        finalSample.deadReckoning?.integrityGpsDependent ?? null,
      finalIntegrityLeewayStatus:
        finalSample.deadReckoning?.integrityLeewayStatus || null,
      finalIntegrityCurrentOrigin:
        finalSample.deadReckoning?.integrityCurrentOrigin || null,
      navigationReference: finalSample.navigationReference || null,
      current: finalSample.current || null,
      lastReason: finalSample.reasons?.[0] || "",
    },
  };
}

function voyageCounterIncrements(samples) {
  const keys = [
    "evaluations",
    "acceptedFixes",
    "rejectedFixes",
    "positionJumps",
    "lostFixes",
    "degradedSignals",
    "drDiscrepancies",
  ];
  if (!Array.isArray(samples) || samples.length < 2) {
    return Object.fromEntries(keys.map((key) => [key, null]));
  }
  const totals = Object.fromEntries(keys.map((key) => [key, 0]));
  let previous = samples[0]?.counters || {};
  for (const sample of samples.slice(1)) {
    const current = sample?.counters || {};
    for (const key of keys) {
      const currentValue = countOrNull(current[key]);
      const previousValue = countOrNull(previous[key]);
      if (currentValue === null || previousValue === null) continue;
      totals[key] += currentValue >= previousValue
        ? currentValue - previousValue
        : currentValue;
    }
    previous = current;
  }
  return totals;
}

function isGpsLostIntegritySample(sample) {
  return sample?.trust === "lost" || sample?.gps?.fixValid === false;
}

function gpsIntegrityCounterEvents(previous, sample) {
  const previousCounters = previous?.counters || {};
  const currentCounters = sample.counters || {};
  const definitions = [
    ["lostFixes", "gps-outage", "GPS outage counted"],
    ["positionJumps", "position-jump", "GPS position jump rejected"],
    ["degradedSignals", "weak-signal", "Weak GPS signal counted"],
    ["drDiscrepancies", "dr-mismatch", "GPS/DR mismatch counted"],
    ["rejectedFixes", "rejected-fix", "GPS fix rejected"],
  ];
  return definitions
    .filter(([key]) => Number.isFinite(currentCounters[key]) && currentCounters[key] > (previousCounters[key] || 0))
    .map(([, type, label]) => gpsIntegrityEvent(sample, type, label));
}

function gpsIntegrityEvent(sample, type, label) {
  return {
    ts: sample.ts,
    type,
    label,
    trust: sample.trust,
    acceptedGps: sample.acceptedGps,
    reason: sample.reasons?.[0] || "",
    reasons: sample.reasons || [],
    counters: sample.counters || {},
    gps: sample.gps || {},
    current: sample.current || {},
    deadReckoning: sample.deadReckoning || {},
    integrityAssurance: sample.integrityAssurance || null,
    navigationReference: sample.navigationReference || null,
  };
}

function secondsBetween(start, end) {
  const startMs = Date.parse(start || "");
  const endMs = Date.parse(end || "");
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, Math.round((endMs - startMs) / 1000));
}

function sortTrack(track) {
  const sorted = track
    .filter((point) => isFinitePosition(point))
    .sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));
  const speeds = new Map();
  for (const point of sorted) {
    speeds.set(point.ts, point.sogKnots);
  }
  return sorted;
}

function buildTrafficAnalysis(
  samples = [],
  projectionMetrics = emptyTrafficProjectionMetrics(),
  targetEvidence = [],
) {
  const eventsById = new Map();
  for (const sample of samples) {
    if (!sample?.eventId) continue;
    if (!eventsById.has(sample.eventId)) {
      eventsById.set(sample.eventId, sample);
      continue;
    }
    const existing = eventsById.get(sample.eventId);
    if (!existing.message && sample.message) eventsById.set(sample.eventId, sample);
  }
  const events = [...eventsById.values()]
    .filter((event) => event.severity === "advisory" || event.severity === "collision")
    .sort((left, right) => Date.parse(left.ts || "") - Date.parse(right.ts || ""));
  const vessels = new Map();
  for (const target of targetEvidence) {
    if (!target?.key) continue;
    const existing = vessels.get(target.key) || {
      key: target.key,
      name: target.name || "",
      mmsi: target.mmsi || "",
      size: target.size || "unknown",
      advisories: 0,
      collisions: 0,
    };
    if (!existing.name && target.name) existing.name = target.name;
    if (!existing.mmsi && target.mmsi) existing.mmsi = target.mmsi;
    if (existing.size === "unknown" && target.size) existing.size = target.size;
    vessels.set(target.key, existing);
  }
  let closestCpaMeters = null;
  let closestEvent = null;
  for (const event of events) {
    const key = event.mmsi || event.title || event.targetContext || event.eventId;
    const existing = vessels.get(key) || {
      key,
      name: event.title || "",
      mmsi: event.mmsi || "",
      size: event.size || "unknown",
      advisories: 0,
      collisions: 0,
    };
    if (!existing.name && event.title) existing.name = event.title;
    if (existing.size === "unknown" && event.size) existing.size = event.size;
    if (event.severity === "collision") existing.collisions += 1;
    if (event.severity === "advisory") existing.advisories += 1;
    vessels.set(key, existing);
    if (Number.isFinite(event.cpaMeters) && (closestCpaMeters == null || event.cpaMeters < closestCpaMeters)) {
      closestCpaMeters = event.cpaMeters;
      closestEvent = event;
    }
  }
  const vesselList = [...vessels.values()];
  const bySize = {
    small: vesselList.filter((vessel) => vessel.size === "small").length,
    medium: vesselList.filter((vessel) => vessel.size === "medium").length,
    large: vesselList.filter((vessel) => vessel.size === "large").length,
    unknown: vesselList.filter((vessel) => vessel.size === "unknown").length,
  };
  const advisories = events.filter((event) => event.severity === "advisory").length;
  const collisions = events.filter((event) => event.severity === "collision").length;
  const scheduleSamples = events
    .map((event) => event.announcementSchedule)
    .filter(Boolean);
  const maximumAnnouncementObservationAgeSeconds = scheduleSamples.reduce(
    (maximum, schedule) =>
      maxNumber(maximum, schedule.targetObservationAgeSeconds),
    null,
  );
  const staleAnnouncementObservations = scheduleSamples.filter(
    (schedule) => schedule.targetObservationRecent === false,
  ).length;
  return {
    available:
      events.length > 0 ||
      vesselList.length > 0 ||
      projectionMetrics.available === true,
    events: events.length,
    notificationEvents: events.filter((event) => event.evidenceSource !== "snapshot").length,
    snapshotAlertStates: events.filter((event) => event.evidenceSource === "snapshot").length,
    advisories,
    collisionAlerts: collisions,
    vesselsEncountered: vesselList.length,
    bySize,
    closestCpaMeters,
    closestCpaEvent: closestEvent
      ? {
          ts: closestEvent.ts,
          title: closestEvent.title,
          mmsi: closestEvent.mmsi,
          severity: closestEvent.severity,
          cpaMeters: closestEvent.cpaMeters,
        }
      : null,
    vessels: vesselList.slice(0, 50),
    projection: {
      ...emptyTrafficProjectionMetrics(),
      ...(projectionMetrics || {}),
    },
    announcementFreshness: {
      available: scheduleSamples.length > 0,
      samples: scheduleSamples.length,
      maximumObservationAgeSeconds:
        maximumAnnouncementObservationAgeSeconds,
      staleObservations: staleAnnouncementObservations,
    },
  };
}

function buildSummary(index, track, ownPass, firstPass, ownContext, gpsIntegrity = null, traffic = null) {
  const startedAt = index.startedAt || track[0]?.ts || firstPass.sampleStart || null;
  const stoppedAt =
    index.stoppedAt || track[track.length - 1]?.ts || firstPass.sampleEnd || null;
  const durationSeconds =
    startedAt && stoppedAt ? Math.max(0, (Date.parse(stoppedAt) - Date.parse(startedAt)) / 1000) : 0;
  const distanceNm = trackDistanceNm(track);
  const averageSpeedKnots =
    durationSeconds > 0 ? distanceNm / (durationSeconds / 3600) : average(ownPass.speedSamples.map((s) => s.knots));

  return {
    startedAt,
    stoppedAt,
    durationSeconds,
    distanceNm,
    averageSpeedKnots,
    averageRecordedSogKnots: average(ownPass.speedSamples.map((s) => s.knots)),
    maxSogKnots: ownPass.maxSogKnots,
    maxApparentWindKnots: ownPass.maxApparentWindKnots,
    maxTrueWindKnots: ownPass.maxTrueWindKnots,
    minDepthMeters: ownPass.minDepthMeters,
    rudder: summarizeRudder(ownPass.rudderSamples, ownPass.rudderSampleCounts),
    waterTemperature: summarizeWaterTemperature(ownPass.waterTemperatureSamples),
    trackPoints: track.length,
    plottedTrackPoints: track.length,
    ownContext,
    startReason: index.startReason || "",
    stopReason: index.stopReason || "",
    snapshotCount: Number(index.snapshotCount) || 0,
    gpsIntegrity: gpsIntegrity?.summary || { available: false },
    traffic: traffic || { available: false },
  };
}

function summarizeRudder(samples = [], counts = {}) {
  const angles = samples.map((sample) => sample.degrees).filter(Number.isFinite);
  const observedSampleCount = Number(counts.observed) || angles.length;
  const excludedSampleCount = Number(counts.excluded) || 0;
  const common = {
    sampleCount: angles.length,
    observedSampleCount,
    excludedSampleCount,
    scope: "engaged-autopilot-only",
    measurementKind: "pilot-helm-position-proxy",
  };
  if (angles.length === 0) return { available: false, ...common };
  return {
    available: true,
    ...common,
    medianAngleDegrees: median(angles),
    meanAngleDegrees: average(angles),
    medianAbsoluteAngleDegrees: median(angles.map(Math.abs)),
    maximumAbsoluteAngleDegrees: angles.reduce(
      (maximum, angle) => Math.max(maximum, Math.abs(angle)),
      0,
    ),
  };
}

function normalizeAutopilotState(value) {
  const unwrapped = unwrapValue(value);
  return unwrapped == null ? "" : String(unwrapped).trim().toLowerCase();
}

function isAutopilotEngagedState(value) {
  return ENGAGED_AUTOPILOT_STATES.has(normalizeAutopilotState(value));
}

function summarizeWaterTemperature(samples = []) {
  const temperatures = samples.map((sample) => sample.celsius).filter(Number.isFinite);
  if (temperatures.length === 0) return { available: false, sampleCount: 0 };
  return {
    available: true,
    sampleCount: temperatures.length,
    averageCelsius: average(temperatures),
    minimumCelsius: temperatures.reduce(
      (minimum, temperature) => Math.min(minimum, temperature),
      Infinity,
    ),
    maximumCelsius: temperatures.reduce(
      (maximum, temperature) => Math.max(maximum, temperature),
      -Infinity,
    ),
  };
}

async function readVoyageBiteReports(voyagePath, index = {}) {
  try {
    const reports = [];
    const window = {
      startMs: Date.parse(index.startedAt || ""),
      stopMs: Date.parse(index.stoppedAt || ""),
    };
    const entries = await listZipEntries(voyagePath);
    for (const entry of entries) {
      if (/\/$/.test(entry.fileName)) continue;
      if (!/^system\/bite-reports\/.+\.json$/i.test(entry.fileName)) continue;
      const parsed = await readZipJson(voyagePath, entry.fileName);
      if (Array.isArray(parsed.reports)) {
        const parent = normalizeBiteReport(parsed, entry.fileName);
        if (biteReportOverlapsWindow(parent, window)) {
          reports.push(parent);
          for (const report of parsed.reports) reports.push(normalizeBiteReport(report, entry.fileName));
        } else {
          for (const report of parsed.reports) {
            const child = normalizeBiteReport(report, entry.fileName);
            if (biteReportOverlapsWindow(child, window)) reports.push(child);
          }
        }
      } else {
        const report = normalizeBiteReport(parsed, entry.fileName);
        if (biteReportOverlapsWindow(report, window)) reports.push(report);
      }
    }
    return reports.filter(Boolean);
  } catch {
    return [];
  }
}

function biteReportOverlapsWindow(report, window) {
  if (!report) return false;
  if (!Number.isFinite(window.startMs) || !Number.isFinite(window.stopMs)) return true;
  const fromMs = Date.parse(report.startedAt || "") || biteReportSortTime(report);
  const finishedMs = Date.parse(report.finishedAt || "");
  const toMs = Number.isFinite(finishedMs) ? finishedMs : fromMs;
  if (!Number.isFinite(fromMs)) return false;
  return toMs >= window.startMs && fromMs <= window.stopMs;
}

function normalizeBiteReport(report, source) {
  if (!report || typeof report !== "object") return null;
  const assertions = Array.isArray(report.assertions) ? report.assertions : [];
  const failedAssertions = assertions
    .filter((assertion) => assertion && assertion.pass === false)
    .map((assertion) => String(assertion.id || assertion.message || "failed assertion"));
  return {
    source,
    runId: stringOrNull(report.runId),
    scenario: stringOrNull(report.scenario) || stringOrNull(report.id) || "unknown",
    title: stringOrNull(report.title) || stringOrNull(report.name) || stringOrNull(report.scenario) || "BITE test",
    result: stringOrNull(report.result) || (report.ok === true ? "pass" : report.ok === false ? "fail" : "unknown"),
    summary: stringOrNull(report.summary),
    startedAt: stringOrNull(report.startedAt),
    finishedAt: stringOrNull(report.finishedAt),
    failedAssertions,
  };
}

function buildVoyageReview({
  index,
  track,
  summary,
  gpsIntegrity,
  traffic,
  drTracks,
  biteReports = [],
  replayVerification = null,
  snapshotEvidenceErrors = [],
}) {
  const findings = [];
  const paragraphs = [];
  const bite = summarizeBiteReports(biteReports);
  const gps = gpsIntegrity?.summary || {};
  const distance = Number.isFinite(summary.distanceNm) ? `${summary.distanceNm.toFixed(1)} NM` : "unknown distance";
  const duration = formatSecondsForReview(summary.durationSeconds);
  const comment = index.comment ? ` "${index.comment}"` : "";

  paragraphs.push(
    `Voyage${comment} covered ${distance} over ${duration}. The track contains ${summary.trackPoints || 0} own-vessel navigation positions, with an average speed of ${formatReviewNumber(summary.averageSpeedKnots, 1, " knots")}.`,
  );
  addRecomputedReplayReview(
    findings,
    paragraphs,
    index.recomputedReplay,
    replayVerification,
  );

  if (summary.minDepthMeters != null) {
    paragraphs.push(`Minimum recorded depth was ${formatReviewNumber(summary.minDepthMeters, 1, " meters")}. Maximum recorded SOG was ${formatReviewNumber(summary.maxSogKnots, 1, " knots")}.`);
  }

  if (traffic?.available) {
    const sizeParts = [];
    if (traffic.bySize?.small) sizeParts.push(`${traffic.bySize.small} small`);
    if (traffic.bySize?.medium) sizeParts.push(`${traffic.bySize.medium} medium`);
    if (traffic.bySize?.large) sizeParts.push(`${traffic.bySize.large} large`);
    if (traffic.bySize?.unknown) sizeParts.push(`${traffic.bySize.unknown} unknown size`);
    const closest = Number.isFinite(traffic.closestCpaMeters)
      ? ` Closest reported CPA was ${formatReviewDistance(traffic.closestCpaMeters)}${traffic.closestCpaEvent?.title ? ` for ${traffic.closestCpaEvent.title}` : ""}.`
      : "";
    paragraphs.push(
      `Traffic review found ${traffic.vesselsEncountered} vessel${traffic.vesselsEncountered === 1 ? "" : "s"} encountered${sizeParts.length ? ` (${sizeParts.join(", ")})` : ""}, ${traffic.advisories} advisory state${traffic.advisories === 1 ? "" : "s"}, and ${traffic.collisionAlerts} collision-alarm state${traffic.collisionAlerts === 1 ? "" : "s"}.${closest}`,
    );
    findings.push({
      category: "voyage",
      level: "green",
      title: "Traffic evidence reviewed",
      detail: `${traffic.notificationEvents || 0} notification${traffic.notificationEvents === 1 ? "" : "s"} and ${traffic.snapshotAlertStates || 0} explicit snapshot alert state${traffic.snapshotAlertStates === 1 ? "" : "s"} were found for ${traffic.vesselsEncountered} vessel${traffic.vesselsEncountered === 1 ? "" : "s"}. Alert counts are informational and do not make the voyage data amber by themselves.`,
    });
    addTrafficProjectionReview(findings, paragraphs, traffic);
  } else {
    findings.push({
      category: "voyage",
      level: "amber",
      title: "No traffic alert history",
      detail: "No AJRM Marine Traffic advisory or collision notifications were found in the recording.",
    });
  }

  if (bite.available) {
    paragraphs.push(
      "This bundle includes AJRM Marine Console BITE output. BITE scenarios deliberately inject test targets, GPS faults, and alert-chain failures so Capture review can confirm the suite detects and reports them; treat BITE failures as test evidence unless the report says the software chain itself failed to react correctly.",
    );
    if (bite.failed > 0) {
      const failedNames = bite.failedTests
        .map((test) => test.title || test.scenario)
        .filter(Boolean)
        .slice(0, 5)
        .join("; ");
      findings.push({
        category: "software",
        level: "red",
        title: "Built-in test failure",
        detail: `${bite.failed} of ${bite.total} BITE checks failed${failedNames ? `: ${failedNames}` : ""}. Do not rely on the suite until these safety-chain tests are understood.`,
      });
    } else {
      findings.push({
        category: "software",
        level: "green",
        title: "Built-in tests passed",
        detail: `${bite.passed} BITE checks were bundled and all passed.`,
      });
    }
  }

  if (gps.available) {
    paragraphs.push(
      `GPS Integrity recorded ${gps.evaluations || gps.samples || 0} evaluations. Final trust was ${reviewTrustName(gps.finalTrust)}.`,
    );
    if (gps.finalComparisonAvailable === false) {
      const assurance = gps.finalIntegrityAssurance
        ? ` (${gps.finalIntegrityAssurance} assurance)`
        : "";
      const reason = gps.finalIntegrityReason ? ` ${gps.finalIntegrityReason}` : "";
      paragraphs.push(
        `The provider explicitly reported that an independent GPS/DR comparison was unavailable${assurance}.${reason}`,
      );
    }
    const clockReference = gps.navigationReference?.clockReference;
    if (clockReference?.kind || clockReference?.source) {
      const source = clockReference.source ? ` from ${clockReference.source}` : "";
      const method = clockReference.method ? ` using ${clockReference.method}` : "";
      const dependency =
        clockReference.gpsDependent === true
          ? " GPS-dependent."
          : clockReference.gpsDependent === false
            ? " GPS-independent."
            : "";
      paragraphs.push(
        `Navigation Reference recorded ${clockReference.kind || "a clock reference"}${source}${method}.${dependency}`,
      );
    }
    addGpsReviewFindings(findings, gps);
  } else {
    findings.push({
      category: "voyage",
      level: "amber",
      title: "No GPS Integrity data",
      detail: "The voyage bundle did not include GPS Integrity state samples, so GPS outages, jumps, and GPS/DR disagreements could not be assessed.",
    });
  }

  addDrReviewFindings(findings, drTracks, gps);
  if (snapshotEvidenceErrors.length) {
    findings.push({
      category: "voyage",
      level: "amber",
      title: "Snapshot evidence unreadable",
      detail: `${snapshotEvidenceErrors.length} captured snapshot evidence file${snapshotEvidenceErrors.length === 1 ? " was" : "s were"} unreadable. Other voyage evidence was still reviewed.`,
    });
  }
  if (!summary.trackPoints) {
    findings.push({
      category: "voyage",
      level: "red",
      title: "No own-vessel track",
      detail: "No usable own-vessel GPS positions were found in the recording.",
    });
  }

  const softwareFindings = findings.filter((finding) => finding.category === "software");
  const voyageFindings = findings.filter((finding) => finding.category !== "software");
  const voyageStatus = highestReviewLevel(voyageFindings);
  const softwareStatus = softwareFindings.length ? highestReviewLevel(softwareFindings) : null;
  const status = softwareStatus
    ? highestReviewLevel([{ level: softwareStatus }, { level: voyageStatus }])
    : voyageStatus;
  const headline = reviewHeadline({
    softwareStatus,
    voyageStatus,
    status,
    softwareReasons: reviewStatusReasons(softwareFindings, softwareStatus),
    voyageReasons: reviewStatusReasons(voyageFindings, voyageStatus),
  });
  const highlights = buildReviewHighlights({
    index,
    summary,
    gps,
    traffic,
    replayVerification,
  });
  const conclusion = reviewConclusion({ status, softwareStatus, voyageStatus, softwareFindings, voyageFindings });
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    engineVersion: REVIEW_ENGINE_VERSION,
    generatedAt: new Date().toISOString(),
    status,
    softwareStatus,
    voyageStatus,
    headline,
    conclusion,
    highlights,
    paragraphs,
    findings,
    bite,
  };
}

function buildReviewHighlights({
  index,
  summary,
  gps,
  traffic,
  replayVerification = null,
}) {
  const highlights = [
    reviewHighlight("Duration", formatSecondsForReview(summary.durationSeconds), "green"),
    reviewHighlight("Distance", Number.isFinite(summary.distanceNm) ? `${summary.distanceNm.toFixed(1)} NM` : "not recorded", Number.isFinite(summary.distanceNm) ? "green" : "amber"),
    reviewHighlight("Track points", String(summary.trackPoints || 0), summary.trackPoints ? "green" : "red"),
    reviewHighlight("Average speed", formatReviewNumber(summary.averageSpeedKnots, 1, " knots"), Number.isFinite(summary.averageSpeedKnots) ? "green" : "amber"),
  ];
  if (summary.minDepthMeters != null) {
    highlights.push(reviewHighlight("Minimum depth", formatReviewNumber(summary.minDepthMeters, 1, " meters"), "green"));
  }
  if (traffic?.available) {
    highlights.push(reviewHighlight(
      "Traffic",
      `${traffic.vesselsEncountered} vessel${traffic.vesselsEncountered === 1 ? "" : "s"}, ${traffic.collisionAlerts} collision alert${traffic.collisionAlerts === 1 ? "" : "s"}`,
      "green",
    ));
  } else {
    highlights.push(reviewHighlight("Traffic", "not recorded", "amber"));
  }
  if (gps?.available) {
    const gpsIssues = (gps.lostFixes || 0) + (gps.positionJumps || 0) + (gps.rejectedFixes || 0) + (gps.drDiscrepancies || 0) + (gps.degradedSignals || 0);
    const comparisonUnavailable = gps.finalComparisonAvailable === false;
    highlights.push(reviewHighlight(
      "GPS Integrity",
      gpsIssues
        ? `${gpsIssues} issue${gpsIssues === 1 ? "" : "s"}`
        : comparisonUnavailable
          ? "fix checks clear · DR comparison unavailable"
          : "healthy",
      gpsIssues ? "amber" : "green",
    ));
  } else {
    highlights.push(reviewHighlight("GPS Integrity", "not recorded", "amber"));
  }
  if (index.interruptedByRestart || /restart/i.test(String(index.stopReason || ""))) {
    highlights.push(reviewHighlight("Recording", "recovered after restart", "green"));
  } else if (index.stopReason) {
    highlights.push(reviewHighlight("Recording", index.stopReason, "green"));
  }
  const replay = summarizeRecomputedReplay(index.recomputedReplay);
  if (replay) {
    const complete =
      replay.coverage?.complete === true &&
      replay.coverage?.preparedComplete === true &&
      replay.coverage?.lastReason === "end of canonical input";
    const isolated = replay.liveInputIsolation?.valid;
    highlights.push(reviewHighlight(
      "Recomputed replay",
      replayVerification?.checkpointExpected === true &&
      replayVerification?.completionVerified !== true
        ? "completion evidence invalid"
        : !complete
        ? "incomplete coverage"
        : isolated === false
          ? "live-input contamination"
          : isolated === true
            ? "complete and isolated"
            : "complete · isolation unverified",
      !complete ||
        isolated === false ||
        (
          replayVerification?.checkpointExpected === true &&
          replayVerification?.completionVerified !== true
        )
        ? "red"
        : isolated === true
          ? "green"
          : "amber",
    ));
  }
  return highlights;
}

function addTrafficProjectionReview(findings, paragraphs, traffic) {
  const projection = traffic?.projection || {};
  if (projection.available !== true) {
    findings.push({
      category: "voyage",
      level: "amber",
      title: "Traffic projection evidence unavailable",
      detail:
        "Traffic alerts were recorded, but the voyage does not include AJRM Marine Traffic target-projection evidence for AIS age and announcement-lag review.",
    });
    return;
  }
  paragraphs.push(
    `Traffic projection review examined ${projection.targetObservations || 0} target observations across ${projection.projectionUpdates || 0} updates. Maximum AIS measurement age was ${formatReviewNumber(projection.maxMeasurementAgeSeconds, 1, " seconds")}; maximum forward projection was ${formatReviewNumber(projection.maxProjectionSeconds, 1, " seconds")}, including up to ${formatReviewNumber(projection.maxAnnouncementLeadSeconds, 1, " seconds")} of configured announcement lead.`,
  );
  if (projection.unusablePositions || projection.staleTargets) {
    const reasons = Object.entries(projection.reasons || {})
      .sort((left, right) => right[1] - left[1])
      .slice(0, 4)
      .map(([reason, count]) => `${reason} (${count})`)
      .join(", ");
    findings.push({
      category: "voyage",
      level: "green",
      title: "Stale Traffic positions safely withheld",
      detail:
        `${projection.unusablePositions || 0} target-position calculations were withheld and ${projection.staleTargets || 0} stale target observations were recorded${reasons ? `; reasons: ${reasons}` : ""}. Withholding stale targets is the expected safe behaviour; only an alert that actually used stale evidence is treated as a caution.`,
    });
  } else {
    findings.push({
      category: "voyage",
      level: "green",
      title: "Traffic projection evidence reviewed",
      detail:
        `${projection.projectedPositions || 0} target positions were projected without a recorded stale or unusable target-position decision.`,
    });
  }
  if (traffic?.announcementFreshness?.staleObservations > 0) {
    findings.push({
      category: "voyage",
      level: "amber",
      title: "Traffic announcement used an old observation",
      detail:
        `${traffic.announcementFreshness.staleObservations} recorded traffic announcement schedule${traffic.announcementFreshness.staleObservations === 1 ? "" : "s"} marked the target observation as older than its permitted age.`,
    });
  }
}

function summarizeRecomputedReplay(value) {
  if (!value || typeof value !== "object") return null;
  if (
    value.kind !== "recomputed-replay" &&
    !value.parentVoyage &&
    !value.result
  ) {
    return null;
  }
  const result = value.result && typeof value.result === "object"
    ? value.result
    : {};
  const sourcePolicy =
    result.sourcePolicy && typeof result.sourcePolicy === "object"
      ? result.sourcePolicy
      : value.sourcePolicy && typeof value.sourcePolicy === "object"
        ? value.sourcePolicy
        : null;
  return {
    kind: "recomputed-replay",
    parentVoyage: stringOrNull(value.parentVoyage),
    playbackMode:
      stringOrNull(result.playbackMode) ||
      stringOrNull(value.playbackMode),
    rate: numberOrNull(result.rate ?? value.rate),
    completedAt: stringOrNull(value.completedAt),
    sourcePolicy,
    resolvedSensorSourceIds: Array.isArray(
      sourcePolicy?.resolvedSensorSourceIds,
    )
      ? sourcePolicy.resolvedSensorSourceIds
          .map(stringOrNull)
          .filter(Boolean)
      : [],
    sourceFilterStats:
      result.sourceFilterStats &&
      typeof result.sourceFilterStats === "object"
        ? result.sourceFilterStats
        : null,
    coverage:
      result.coverage && typeof result.coverage === "object"
        ? result.coverage
        : null,
    liveInputIsolation:
      result.liveInputIsolation &&
      typeof result.liveInputIsolation === "object"
        ? result.liveInputIsolation
        : null,
  };
}

function addRecomputedReplayReview(
  findings,
  paragraphs,
  value,
  replayVerification = null,
) {
  const replay = summarizeRecomputedReplay(value);
  if (!replay) return;
  const parent = replay.parentVoyage || "an unknown parent voyage";
  const sourceCount = replay.resolvedSensorSourceIds.length;
  paragraphs.push(
    `This is a recomputed replay child of ${parent}, using ${sourceCount} resolved sensor source${sourceCount === 1 ? "" : "s"} at ${Number.isFinite(replay.rate) ? `${replay.rate}x` : "an unrecorded rate"}.`,
  );
  if (replayVerification?.checkpointExpected === true) {
    paragraphs.push(
      replayVerification.completionVerified === true
        ? "The durable replay-completion checkpoint and recomputed output were verified against the embedded file."
        : `The replay declares durable completion, but its checkpoint or recomputed-output evidence did not validate: ${(replayVerification.issues || []).join("; ") || "unknown completion-evidence failure"}.`,
    );
    if (replayVerification.completionVerified !== true) {
      findings.push({
        category: "software",
        level: "red",
        title: "Recomputed completion evidence invalid",
        detail:
          (replayVerification.issues || []).join("; ") ||
          "The durable completion checkpoint or recomputed output could not be verified.",
      });
    } else {
      findings.push({
        category: "software",
        level: "green",
        title: "Recomputed result packaging verified",
        detail:
          "The completion checkpoint, replay result, timing evidence, and embedded recomputed output agree.",
      });
    }
  }
  const complete =
    replay.coverage?.complete === true &&
    replay.coverage?.preparedComplete === true &&
    replay.coverage?.lastReason === "end of canonical input";
  if (!complete) {
    findings.push({
      category: "software",
      level: "red",
      title: "Recomputed replay coverage incomplete",
      detail:
        "The child voyage does not prove complete pre-indexed parent coverage. Do not use it to validate recalculated navigation or alert behaviour.",
    });
    return;
  }
  if (replay.liveInputIsolation?.valid === false) {
    const count = Number(
      replay.liveInputIsolation.physicalUpdatesSeen || 0,
    );
    findings.push({
      category: "software",
      level: "red",
      title: "Live sensor contamination detected",
      detail: `${count} live physical-source update${count === 1 ? "" : "s"} were detected during recomputation. The resulting calculated data is not an isolated replay result.`,
    });
    return;
  }
  if (replay.liveInputIsolation?.valid !== true) {
    findings.push({
      category: "software",
      level: "amber",
      title: "Replay isolation not verified",
      detail:
        "Complete replay coverage was recorded, but the child does not contain an explicit valid live-input isolation result.",
    });
    return;
  }
  findings.push({
    category: "software",
    level: "green",
    title: "Recomputed replay lineage verified",
    detail:
      "The child records complete pre-indexed parent coverage and no detected live physical-source contamination.",
  });
}

function evaluateRecomputedCompletion({ index, checkpoint, captureSources }) {
  const replay = summarizeRecomputedReplay(index?.recomputedReplay);
  if (!replay) return null;
  const rawReplay =
    index.recomputedReplay && typeof index.recomputedReplay === "object"
      ? index.recomputedReplay
      : {};
  const result =
    rawReplay.result && typeof rawReplay.result === "object"
      ? rawReplay.result
      : {};
  const output = result.output || index?.recomputedOutput || {};
  const outputSource = (captureSources || []).find(
    (source) => source.innerPath === output.fileName,
  );
  const checkpointExpected =
    index.recomputationVerified !== undefined ||
    rawReplay.verified !== undefined ||
    rawReplay.status === "complete";
  const issues = [];
  const checkpointValid =
    checkpoint?.contract === "ajrm-marine-recomputed-completion" &&
    Number(checkpoint?.contractVersion) === 1 &&
    checkpoint?.voyageId === index.id &&
    checkpoint?.completionConfirmed === true &&
    checkpoint?.verified === true &&
    checkpoint?.recomputationVerified === true &&
    (checkpoint?.replayResult?.contract || checkpoint?.recomputedReplay?.result?.contract) ===
      "ajrm-marine-replay-result-v1";
  if (checkpointExpected && !checkpointValid) {
    issues.push("durable completion checkpoint missing or invalid");
  }
  const coverageComplete =
    replay.coverage?.complete === true &&
    replay.coverage?.preparedComplete === true &&
    replay.coverage?.lastReason === "end of canonical input";
  if (!coverageComplete) issues.push("replay coverage is not complete");
  const outputComplete =
    output.contract === "ajrm-marine-recomputed-output-v1" &&
    output.complete === true &&
    Number(output.writeErrors || 0) === 0 &&
    Boolean(output.fileName) &&
    Boolean(outputSource) &&
    Number(outputSource?.bytes) === Number(output.bytes);
  if (!outputComplete) {
    issues.push("recomputed output is missing, incomplete, or has a size mismatch");
  }
  const timingValid = result.timing?.valid === true;
  if (!timingValid) issues.push("replay timing is not explicitly valid");
  const indexComplete =
    index.incomplete !== true &&
    index.recomputationVerified === true &&
    rawReplay.complete === true &&
    rawReplay.incomplete !== true &&
    rawReplay.verified === true;
  if (checkpointExpected && !indexComplete) {
    issues.push("voyage index does not declare verified recomputation completion");
  }
  return {
    contract: "ajrm-marine-voyage-recomputed-verification",
    contractVersion: 1,
    checkpointExpected,
    checkpointPresent: Boolean(checkpoint),
    checkpointValid,
    coverageComplete,
    outputComplete,
    timingValid,
    completionVerified:
      (!checkpointExpected || checkpointValid) &&
      coverageComplete &&
      outputComplete &&
      timingValid &&
      (!checkpointExpected || indexComplete),
    liveInputIsolationValid: replay.liveInputIsolation?.valid ?? null,
    issues: [...new Set(issues)],
  };
}

function reviewHighlight(label, value, level = "green") {
  return { label, value, level };
}

function summarizeBiteReports(reports) {
  const latestRun = latestBiteRunAllReport(reports);
  const latestRunReports = latestRun ? biteReportsForRun(reports, latestRun) : [];
  const usefulReports = latestRunReports.length
    ? latestRunReports.filter((report) => report.scenario !== "run-all")
    : reports.filter((report) => report.scenario !== "run-all");
  const source = usefulReports.length ? dedupeBiteReports(usefulReports) : latestRun ? [latestRun] : dedupeBiteReports(reports);
  const failedTests = source.filter((report) => reviewBiteFailed(report));
  const passed = source.filter((report) => reviewBitePassed(report)).length;
  return {
    available: source.length > 0,
    total: source.length,
    passed,
    failed: failedTests.length,
    failedTests: failedTests.slice(0, 12).map((report) => ({
      scenario: report.scenario,
      title: report.title,
      summary: report.summary,
      failedAssertions: report.failedAssertions,
    })),
  };
}

function dedupeBiteReports(reports) {
  const byScenario = new Map();
  for (const report of reports) {
    const key = report.scenario || report.title || report.source || "unknown";
    const existing = byScenario.get(key);
    if (!existing || biteReportSortTime(report) >= biteReportSortTime(existing)) {
      byScenario.set(key, report);
    }
  }
  return [...byScenario.values()].sort((a, b) => biteReportSortTime(a) - biteReportSortTime(b));
}

function latestBiteRunAllReport(reports) {
  return reports
    .filter((report) => report.scenario === "run-all")
    .sort((a, b) => biteReportSortTime(b) - biteReportSortTime(a))[0] || null;
}

function biteReportsForRun(reports, runAllReport) {
  const started = Date.parse(runAllReport.startedAt || "");
  const finished = Date.parse(runAllReport.finishedAt || "");
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return [];
  return reports.filter((report) => {
    const time = biteReportSortTime(report);
    return Number.isFinite(time) && time >= started - 1000 && time <= finished + 1000;
  });
}

function biteReportSortTime(report) {
  const finished = Date.parse(report.finishedAt || "");
  if (Number.isFinite(finished)) return finished;
  const started = Date.parse(report.startedAt || "");
  if (Number.isFinite(started)) return started;
  const sourceMatch = String(report.source || "").match(/(\d{4}-\d{2}-\d{2}T\d{6})/);
  if (!sourceMatch) return 0;
  return Date.parse(sourceMatch[1].replace(/T(\d{2})(\d{2})(\d{2})/, "T$1:$2:$3"));
}

function reviewBiteFailed(report) {
  return report.result === "fail" || report.result === "failed" || report.result === "red" || report.failedAssertions.length > 0;
}

function reviewBitePassed(report) {
  return report.result === "pass" || report.result === "passed" || report.ok === true;
}

function addGpsReviewFindings(findings, gps) {
  const comparisonUnavailable = gps.finalComparisonAvailable === false;
  if (gps.lostFixes || gps.lostPeriods) {
    findings.push({
      category: "voyage",
      level: gps.longestLostSeconds > 60 || gps.totalLostSeconds > 120 ? "red" : "amber",
      title: "GPS outage detected",
      detail: `${gps.lostFixes || gps.lostPeriods} GPS outage${(gps.lostFixes || gps.lostPeriods) === 1 ? "" : "s"} were detected, totalling ${formatSecondsForReview(gps.totalLostSeconds || 0)}. Longest outage was ${formatSecondsForReview(gps.longestLostSeconds || 0)}.`,
    });
  }
  if (gps.positionJumps) {
    findings.push({
      category: "voyage",
      level: "amber",
      title: "GPS position jumps rejected",
      detail: `${gps.positionJumps} position jump${gps.positionJumps === 1 ? "" : "s"} were detected by GPS Integrity.`,
    });
  }
  if (gps.rejectedFixes) {
    findings.push({
      category: "voyage",
      level: gps.rejectedFixes > 3 ? "red" : "amber",
      title: "GPS fixes rejected",
      detail: `${gps.rejectedFixes} GPS fix${gps.rejectedFixes === 1 ? "" : "es"} were rejected before reaching the trusted navigation state.`,
    });
  }
  if (gps.drDiscrepancies) {
    findings.push({
      category: "voyage",
      level: "amber",
      title: "GPS and dead reckoning disagreed",
      detail: `${gps.drDiscrepancies} GPS/DR mismatch event${gps.drDiscrepancies === 1 ? "" : "s"} were recorded. Maximum operational DR uncertainty was ${formatReviewNumber(gps.maxOperationalUncertaintyMeters, 0, " meters")}.`,
    });
  }
  if (gps.degradedSignals) {
    findings.push({
      category: "voyage",
      level: "amber",
      title: "Weak GPS signal detected",
      detail: `${gps.degradedSignals} weak-signal event${gps.degradedSignals === 1 ? "" : "s"} were recorded.`,
    });
  }
  if (
    !gps.lostFixes &&
    !gps.positionJumps &&
    !gps.rejectedFixes &&
    !gps.drDiscrepancies &&
    !gps.degradedSignals
  ) {
    findings.push({
      category: "voyage",
      level: "green",
      title: "GPS Integrity healthy",
      detail: `No GPS outages, rejected fixes, position jumps, weak-signal events, or GPS/DR mismatches were recorded.${comparisonUnavailable ? " The optional independent DR comparison was unavailable." : ""}`,
    });
  }
}

function addDrReviewFindings(findings, drTracks, gps = {}) {
  const jumps = drTracks?.recoveryJumps || [];
  if (jumps.length) {
    const maxJump = jumps.reduce((max, jump) => Math.max(max, Number(jump.meters) || 0), 0);
    findings.push({
      category: "voyage",
      level: maxJump > 500 ? "red" : "amber",
      title: "DR recovery jump",
      detail: `${jumps.length} GPS recovery jump${jumps.length === 1 ? "" : "s"} were recorded. Largest jump was ${formatReviewNumber(maxJump, 0, " meters")}.`,
    });
  }
}

function titleCaseForReview(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function highestReviewLevel(findings) {
  if (findings.some((finding) => finding.level === "red")) return "red";
  if (findings.some((finding) => finding.level === "amber")) return "amber";
  return "green";
}

function reviewStatusReasons(findings, status) {
  if (status !== "red" && status !== "amber") return "";
  const titles = findings
    .filter((finding) => finding.level === status)
    .map((finding) => String(finding.title || "").trim())
    .filter(Boolean)
    .slice(0, 3);
  if (!titles.length) return "";
  if (titles.length === 1) return titles[0];
  if (titles.length === 2) return `${titles[0]} and ${titles[1]}`;
  return `${titles[0]}, ${titles[1]}, and ${titles[2]}`;
}

function reviewHeadline({ softwareStatus, voyageStatus, status, softwareReasons = "", voyageReasons = "" }) {
  if (!softwareStatus) {
    if (voyageStatus === "red") {
      return `Voyage data RED: ${voyageReasons || "investigate red navigation findings before relying on this voyage record"}.`;
    }
    if (voyageStatus === "amber") {
      return `Voyage data AMBER: ${voyageReasons || "reviewed with cautions"}.`;
    }
    return "Voyage data GREEN: reviewed checks look healthy.";
  }
  if (status === "red") {
    const parts = [];
    if (softwareStatus !== "green" && softwareReasons) parts.push(`software: ${softwareReasons}`);
    if (voyageStatus !== "green" && voyageReasons) parts.push(`voyage: ${voyageReasons}`);
    return `Software ${softwareStatus.toUpperCase()}, voyage data ${voyageStatus.toUpperCase()}: ${parts.join("; ") || "investigate red items before relying on this setup"}.`;
  }
  if (status === "amber") {
    const parts = [];
    if (softwareStatus !== "green" && softwareReasons) parts.push(`software: ${softwareReasons}`);
    if (voyageStatus !== "green" && voyageReasons) parts.push(`voyage: ${voyageReasons}`);
    return `Software ${softwareStatus.toUpperCase()}, voyage data ${voyageStatus.toUpperCase()}: ${parts.join("; ") || "usable review with cautions"}.`;
  }
  return "Software GREEN, voyage data GREEN: reviewed checks look healthy.";
}

function reviewConclusion({ status, softwareStatus, voyageStatus, softwareFindings, voyageFindings }) {
  if (status === "green") {
    return "Review found no software or voyage-data issues requiring action. Traffic alerts are retained as voyage history.";
  }
  const parts = [];
  if (softwareStatus === "red") {
    parts.push("Software checks failed: do not rely on this setup until the red software findings are understood.");
  } else if (softwareStatus === "amber") {
    parts.push("Software checks have cautions; review the amber software findings.");
  }
  if (voyageStatus === "red") {
    parts.push("Voyage data has red navigation findings; treat this recording as unreliable until those findings are understood.");
  } else if (voyageStatus === "amber") {
    parts.push("Voyage data has cautions; review the amber voyage findings before drawing conclusions from the recording.");
  }
  if (!parts.length) {
    const amberOrRed = [...softwareFindings, ...voyageFindings].filter((finding) => finding.level === "red" || finding.level === "amber");
    if (amberOrRed.length) parts.push("Review the amber and red findings below.");
  }
  return parts.join(" ");
}

function reviewTrustName(value) {
  return value ? String(value).replace(/[-_]+/g, " ") : "unknown";
}

function formatReviewNumber(value, digits, suffix) {
  const number = numberOrNull(value);
  if (number === null) return "not recorded";
  return `${number.toFixed(digits)}${suffix}`;
}

function formatReviewDistance(meters) {
  const value = numberOrNull(meters);
  if (value === null) return "not recorded";
  if (value < 1000) return `${Math.round(value)} meters`;
  return `${(value / 1852).toFixed(value < 3704 ? 1 : 0)} miles`;
}

function formatSecondsForReview(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  if (hours) return `${hours} h ${minutes} min`;
  if (minutes) return secs ? `${minutes} min ${secs} s` : `${minutes} min`;
  return `${secs} s`;
}

function isInsideWindow(timestamp, window) {
  if (!window) return true;
  const ts = Date.parse(timestamp || "");
  if (!Number.isFinite(ts)) return true;
  if (Number.isFinite(window.startMs) && ts < window.startMs) return false;
  if (Number.isFinite(window.endMs) && ts > window.endMs) return false;
  return true;
}

function hourlyMarkers(track) {
  if (track.length < 2) return [];
  const startMs = Date.parse(track[0].ts);
  const endMs = Date.parse(track[track.length - 1].ts);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
  let nextHour = Math.ceil(startMs / 3600000) * 3600000;
  const markers = [];
  while (nextHour <= endMs) {
    const point = nearestTrackPoint(track, nextHour);
    if (point) {
      markers.push({
        ts: new Date(nextHour).toISOString(),
        label: new Date(nextHour).toISOString().slice(11, 16),
        lat: point.lat,
        lon: point.lon,
      });
    }
    nextHour += 3600000;
  }
  return markers;
}

function nearestTrackPoint(track, targetMs) {
  let best = null;
  let bestDiff = Infinity;
  for (const point of track) {
    const diff = Math.abs(Date.parse(point.ts) - targetMs);
    if (diff < bestDiff) {
      best = point;
      bestDiff = diff;
    }
  }
  return best;
}

function thinTrack(track, maxTrackPoints) {
  if (track.length <= maxTrackPoints) return track;
  const result = [];
  const step = (track.length - 1) / (maxTrackPoints - 1);
  for (let i = 0; i < maxTrackPoints; i += 1) {
    result.push(track[Math.round(i * step)]);
  }
  return result;
}

function trackDistanceNm(track) {
  let meters = 0;
  for (let i = 1; i < track.length; i += 1) {
    meters += haversineMeters(track[i - 1], track[i]);
  }
  return meters * METERS_TO_NM;
}

function generateGpx(analysis) {
  const summary = analysis.summary || {};
  const track = Array.isArray(analysis.track) ? analysis.track : [];
  const name = analysis.id || recordingFileStem(analysis.fileName || "voyage");
  const description = [
    analysis.comment,
    summary.startedAt && summary.stoppedAt
      ? `Started ${summary.startedAt}; stopped ${summary.stoppedAt}`
      : "",
    Number.isFinite(summary.distanceNm)
      ? `Distance ${summary.distanceNm.toFixed(2)} NM`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const points = track
    .filter(isFinitePosition)
    .map(
      (point) =>
        `      <trkpt lat="${formatCoordinate(point.lat)}" lon="${formatCoordinate(point.lon)}"><time>${escapeXml(point.ts)}</time></trkpt>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="AJRM Marine Capture ${escapeXml(packageInfo.version)}" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapeXml(name)}</name>
    ${description ? `<desc>${escapeXml(description)}</desc>` : ""}
    ${summary.startedAt ? `<time>${escapeXml(summary.startedAt)}</time>` : ""}
  </metadata>
  <trk>
    <name>${escapeXml(name)}</name>
    ${description ? `<desc>${escapeXml(description)}</desc>` : ""}
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>
`;
}

function formatCoordinate(value) {
  return Number(value).toFixed(7);
}

function haversineMeters(left, right) {
  const radius = 6371000;
  const lat1 = degreesToRadians(left.lat);
  const lat2 = degreesToRadians(right.lat);
  const dLat = degreesToRadians(right.lat - left.lat);
  const dLon = degreesToRadians(right.lon - left.lon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function readZipJson(zipPath, innerPath) {
  const text = await readZipEntryText(zipPath, innerPath);
  return JSON.parse(text);
}

async function readOptionalZipJson(zipPath, innerPath) {
  try {
    return await readZipJson(zipPath, innerPath);
  } catch (error) {
    if (error?.code === "ZIP_ENTRY_NOT_FOUND") return null;
    throw error;
  }
}

async function readCaptureLines(
  zipPath,
  innerPath,
  onRecord,
  onProgress = null,
) {
  const { stream: input } = await openZipEntryStream(zipPath, innerPath);
  let processedBytes = 0;
  input.on("data", (chunk) => {
    processedBytes += chunk.length;
    if (typeof onProgress === "function") onProgress(processedBytes);
  });
  const stream = innerPath.endsWith(".gz") ? input.pipe(zlib.createGunzip()) : input;
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    onRecord(JSON.parse(line));
  }
}

async function sendGpx(res, analysis, fallbackFile) {
  const gpx = generateGpx(analysis);
  const gpxName = defaultGpxFileName(analysis, fallbackFile);
  res.setHeader("Content-Type", "application/gpx+xml; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${headerSafeFileName(gpxName)}"`);
  res.send(gpx);
}

async function readZipEntryText(zipPath, innerPath) {
  return (await readZipEntryBuffer(zipPath, innerPath)).toString("utf8");
}

async function readZipEntryBuffer(
  zipPath,
  innerPath,
  maximumBytes = MAX_ZIP_TEXT_ENTRY_BYTES,
) {
  const { stream, entry } = await openZipEntryStream(zipPath, innerPath);
  if (Number(entry.uncompressedSize) > maximumBytes) {
    stream.destroy();
    throw new Error(`zip entry is too large to buffer safely: ${innerPath}`);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > maximumBytes) {
      stream.destroy();
      throw new Error(`zip entry is too large to buffer safely: ${innerPath}`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function openZipEntryStream(zipPath, innerPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(
      zipPath,
      { lazyEntries: true, autoClose: false },
      (openError, zip) => {
        if (openError || !zip) {
          reject(openError || new Error("Unable to open voyage ZIP"));
          return;
        }
        let settled = false;
        const fail = (error) => {
          if (settled) return;
          settled = true;
          zip.close();
          reject(error);
        };
        zip.once("error", fail);
        zip.once("end", () => {
          const error = new Error(`zip entry not found: ${innerPath}`);
          error.code = "ZIP_ENTRY_NOT_FOUND";
          fail(error);
        });
        zip.on("entry", (entry) => {
          if (entry.fileName !== innerPath || /\/$/.test(entry.fileName)) {
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              fail(streamError || new Error(`Unable to read ${innerPath}`));
              return;
            }
            settled = true;
            const closeZip = () => zip.close();
            stream.once("end", closeZip);
            stream.once("close", closeZip);
            stream.once("error", closeZip);
            resolve({ stream, entry });
          });
        });
        zip.readEntry();
      },
    );
  });
}

function listZipEntries(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError || new Error("Unable to open voyage ZIP"));
        return;
      }
      const entries = [];
      zip.once("error", reject);
      zip.once("end", () => resolve(entries));
      zip.on("entry", (entry) => {
        entries.push({
          fileName: entry.fileName,
          compressedSize: Number(entry.compressedSize),
          uncompressedSize: Number(entry.uncompressedSize),
        });
        zip.readEntry();
      });
      zip.readEntry();
    });
  });
}

async function zipEntryMetadata(zipPath, innerPath) {
  const entries = await listZipEntries(zipPath);
  return entries.find((entry) => entry.fileName === innerPath) || null;
}

async function assertReadableFile(filePath) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error("Voyage path is not a file.");
}

function safeVoyageFile(value) {
  const file = path.basename(String(value || ""));
  if (!file || file !== value || !file.endsWith(".zip")) {
    throw new Error("Invalid voyage file.");
  }
  return file;
}

function expandHome(value) {
  const text = String(value || "");
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return text;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function isPosition(value) {
  const latitude = numberOrNull(value?.latitude);
  const longitude = numberOrNull(value?.longitude);
  return (
    value &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude)
  );
}

function isFinitePosition(point) {
  return Number.isFinite(point.lat) && Number.isFinite(point.lon) && point.ts;
}

function isWindSpeedPath(valuePath) {
  return (
    valuePath === "environment.wind.speedApparent" ||
    valuePath === "environment.wind.speedTrue"
  );
}

function metersPerSecondToKnots(value) {
  const number = numberOrNull(value);
  return number !== null ? number * MPS_TO_KNOTS : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function unwrapValue(value) {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "value")) {
    return value.value;
  }
  return value;
}

function maxNumber(current, next) {
  if (!Number.isFinite(next)) return current;
  return current == null ? next : Math.max(current, next);
}

function average(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function median(values) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 === 0
    ? (finite[middle - 1] + finite[middle]) / 2
    : finite[middle];
}

function signedDegreesFromRadians(value) {
  const degrees = (value * 180) / Math.PI;
  return ((degrees + 180) % 360 + 360) % 360 - 180;
}

function touchSampleTimes(result, timestamp) {
  if (!timestamp) return;
  if (!result.sampleStart || timestamp < result.sampleStart) result.sampleStart = timestamp;
  if (!result.sampleEnd || timestamp > result.sampleEnd) result.sampleEnd = timestamp;
}

function degreesToRadians(value) {
  return (value * Math.PI) / 180;
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function headerSafeFileName(value) {
  return String(value || "voyage.gpx").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function defaultGpxFileName(analysis, fallbackFile = "voyage.zip") {
  const comment = safeFileStem(analysis?.comment || "");
  const fallback = safeFileStem(recordingFileStem(fallbackFile || "voyage"));
  return `${comment || fallback || "voyage"}.gpx`;
}

function recordingFileStem(value) {
  return path.basename(String(value || "voyage")).replace(/\.(zip|jsonl|jsonl\.gz)$/i, "");
}

function safeFileStem(value) {
  return String(value || "")
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

module.exports._private = {
  analyseVoyageFile,
  analyseVoyage,
  chooseOwnContext,
  defaultGpxFileName,
  generateGpx,
  buildGpsIntegrityAnalysis,
  haversineMeters,
  hourlyMarkers,
  listVoyages,
  plotCachePath,
  thinTrack,
  trackDistanceNm,
};
