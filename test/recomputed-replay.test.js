"use strict";

const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const AdmZip = require("adm-zip");
const createPlugin = require("../plugin");

test("recomputed replay start and stop builds a portable child voyage with audit metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-capture-replay-"));
  const voyageDirectory = path.join(root, "voyages");
  const loggerDirectory = path.join(root, "logger");
  const capturesDirectory = path.join(loggerDirectory, "captures");
  await fs.mkdir(capturesDirectory, { recursive: true });
  const now = new Date();
  const from = new Date(now.getTime() - 1000).toISOString();
  const to = new Date(now.getTime() + 60000).toISOString();
  const captureFileNames = [
    "capture-2026-07-27T12-00-00-000Z.jsonl",
    "capture-2026-07-27T13-00-00-000Z.jsonl",
    "capture-2026-07-27T14-00-00-000Z.jsonl",
  ];
  const captureContents = new Map();
  const resultSegments = [];
  for (const [index, captureFileName] of captureFileNames.entries()) {
    const capturedAt = new Date(now.getTime() + index * 60 * 60 * 1000).toISOString();
    const content = `${JSON.stringify({
      capturedAt,
      originalCapturedAt: `2026-07-16T${String(9 + index).padStart(2, "0")}:04:12.000Z`,
      replayRole: "sensor-input",
      delta: {
        context: "vessels.self",
        updates: [{
          $source: "YDEN.2",
          timestamp: capturedAt,
          values: [{ path: "navigation.position", value: { latitude: 55.8, longitude: -5.7 } }],
        }],
      },
    })}\n`;
    captureContents.set(captureFileName, content);
    await fs.writeFile(path.join(capturesDirectory, captureFileName), content);
    resultSegments.push({
      index,
      fileName: captureFileName,
      startedAt: capturedAt,
      from: capturedAt,
      to: capturedAt,
      lines: 1,
      bytes: Buffer.byteLength(content),
      compressed: false,
      finalized: true,
      available: true,
      error: null,
    });
  }
  const captureFileName = captureFileNames.at(-1);

  const recording = {
    active: true,
    fileName: captureFileName,
    startedAt: from,
    from,
    to,
    lines: resultSegments.length,
    bytes: resultSegments.reduce((total, segment) => total + segment.bytes, 0),
    kind: "recomputed-replay",
    backfillMinutes: 0,
    backfilled: 0,
    replayResult: {
      schemaVersion: 1,
      kind: "recomputed-replay",
      parentVoyage: "voyage-20260716T090451Z.zip",
      playbackMode: "sensor-sources",
      rate: 1,
      sourcePolicy: {
        id: "strict-recorded-sensor-source-allowlist-v1",
        selectionRule: "exact-or-prefix-catalog-resolution",
        sensorSourcePrefixes: ["YDEN"],
        explicitSensorSourceIds: [],
        resolvedSensorSourceIds: ["YDEN.2"],
        sensorSourceIds: ["YDEN.2"],
      },
      sourceFilterStats: {
        valuesSeen: 2,
        valuesSent: 1,
        valuesExcluded: 1,
      },
      coverage: {
        complete: true,
        inputComplete: true,
        resultSegmentsComplete: true,
        preparedComplete: true,
        startCursor: 0,
        cursor: 2,
        totalLines: 2,
        lastReason: "end of capture",
        originalCapturedAt: "2026-07-16T09:04:13.000Z",
      },
      resultSegments: {
        schemaVersion: 1,
        complete: true,
        segmentsTotal: resultSegments.length,
        segmentsFinalized: resultSegments.length,
        lines: resultSegments.length,
        bytes: resultSegments.reduce((total, segment) => total + segment.bytes, 0),
        from: resultSegments[0].from,
        to: resultSegments.at(-1).to,
        errors: [],
        segments: resultSegments,
      },
    },
  };
  const loggerStatus = {
    ok: true,
    playback: {
      loaded: true,
      active: false,
      mode: "sensor-sources",
      replayMode: "sensor-only",
      fileName: "capture-2026-07-16T09-04-11-907Z.jsonl",
      displayFileName: "voyage-20260716T090451Z.zip / capture-2026-07-16T09-04-11-907Z.jsonl",
      sourceKind: "voyages",
      voyageFileName: "voyage-20260716T090451Z.zip",
      voyageStartedAt: "2026-07-16T09:04:51.000Z",
      captureFrom: "2026-07-16T08:34:51.000Z",
      captureTo: "2026-07-16T10:27:00.000Z",
      current: "2026-07-16T08:57:51.000Z",
      cursor: 0,
      startCursor: 0,
      totalLines: 2,
      lastReason: "loaded",
      coverage: {
        complete: false,
        preparedComplete: true,
        startCursor: 0,
        cursor: 0,
        totalLines: 2,
        segmentsTotal: 2,
        segmentsCompleted: 0,
      },
      rate: 1,
      sourcePolicy: {
        id: "strict-recorded-sensor-source-allowlist-v1",
        selectionRule: "exact-or-prefix-catalog-resolution",
        sensorSourcePrefixes: ["YDEN"],
        explicitSensorSourceIds: [],
        resolvedSensorSourceIds: ["YDEN.2"],
        sensorSourceIds: ["YDEN.2"],
      },
      sourceCatalog: {
        "YDEN.2": { updates: 10, values: 20 },
        "derived-data": { updates: 8, values: 8 },
      },
      sourceFilterStats: {
        valuesSeen: 0,
        valuesSent: 0,
        valuesExcluded: 0,
      },
    },
    captures: [{
      fileName: captureFileName,
      from,
      to,
      bytes: resultSegments.at(-1).bytes,
      compressed: false,
    }],
  };
  let replayCaptureStarted = false;
  let replayCaptureStopShouldFail = false;
  const app = fakeApp({
    async status() {
      return loggerStatus;
    },
    paths() {
      return { captures: capturesDirectory };
    },
    async startReplayResultCapture(metadata) {
      replayCaptureStarted = true;
      assert.equal(metadata.parentVoyage, "voyage-20260716T090451Z.zip");
      assert.equal(metadata.requestedBy, "signalk-ajrm-marine-capture");
      return recording;
    },
    async stopReplayResultCapture() {
      if (replayCaptureStopShouldFail) {
        throw new Error("simulated Logger finalisation failure");
      }
      return { ...recording, active: false };
    },
  });
  const routes = new Map();
  const plugin = createPlugin(app);
  plugin.registerWithRouter(routerMap(routes));
  plugin.start({
    enabled: false,
    voyageDirectory,
    ajrmMarineLoggerLogDirectory: loggerDirectory,
    captureMode: "minimal",
    captureFileMode: "reference",
    deleteWorkingDirectoryAfterZip: true,
  });

  try {
    loggerStatus.playback.rate = 2;
    const rejectedFastStart = await invoke(
      routes,
      "POST",
      "/voyage/replay/start",
      {},
    );
    assert.equal(rejectedFastStart.statusCode, 400);
    assert.match(rejectedFastStart.body.error, /select 1x/i);
    loggerStatus.playback.rate = 1;

    const started = await invoke(routes, "POST", "/voyage/replay/start", {});
    assert.equal(started.statusCode, 200);
    assert.equal(replayCaptureStarted, true);
    assert.equal(started.body.voyage.captureFileMode, "portable");
    assert.equal(
      started.body.voyage.recomputedReplay.parentVoyage,
      "voyage-20260716T090451Z.zip",
    );
    const rejectedOrdinaryStop = await invoke(
      routes,
      "POST",
      "/voyage/stop",
      {},
    );
    assert.equal(rejectedOrdinaryStop.statusCode, 400);
    assert.match(rejectedOrdinaryStop.body.error, /stop and build zip/i);

    loggerStatus.playback.active = true;
    loggerStatus.playback.cursor = 1;
    loggerStatus.playback.coverage.cursor = 1;
    loggerStatus.playback.coverage.segmentsCompleted = 1;
    const rejectedEarlyStop = await invoke(
      routes,
      "POST",
      "/voyage/replay/stop",
      {},
    );
    assert.equal(rejectedEarlyStop.statusCode, 400);
    assert.match(rejectedEarlyStop.body.error, /reach the end/i);
    loggerStatus.playback.active = false;
    loggerStatus.playback.cursor = 2;
    loggerStatus.playback.coverage.cursor = 2;
    loggerStatus.playback.coverage.segmentsCompleted = 2;
    const rejectedIncompleteCoverage = await invoke(
      routes,
      "POST",
      "/voyage/replay/stop",
      {},
    );
    assert.equal(rejectedIncompleteCoverage.statusCode, 400);
    assert.match(rejectedIncompleteCoverage.body.error, /reach the end/i);
    loggerStatus.playback.coverage.complete = true;
    loggerStatus.playback.lastReason = "end of capture";

    replayCaptureStopShouldFail = true;
    const rejectedLoggerFailure = await invoke(
      routes,
      "POST",
      "/voyage/replay/stop",
      {},
    );
    assert.equal(rejectedLoggerFailure.statusCode, 400);
    assert.match(rejectedLoggerFailure.body.error, /simulated Logger/i);
    replayCaptureStopShouldFail = false;

    await fs.unlink(path.join(capturesDirectory, captureFileNames[0]));
    const rejectedMissingRotatedSegment = await invoke(
      routes,
      "POST",
      "/voyage/replay/stop",
      {},
    );
    assert.equal(rejectedMissingRotatedSegment.statusCode, 400);
    assert.match(
      rejectedMissingRotatedSegment.body.error,
      /missing or changed/i,
    );
    await fs.writeFile(
      path.join(capturesDirectory, captureFileNames[0]),
      captureContents.get(captureFileNames[0]),
    );

    const stopped = await invoke(routes, "POST", "/voyage/replay/stop", {});
    assert.equal(stopped.statusCode, 200);
    assert.equal(stopped.body.bundle.format, "zip");
    const zip = new AdmZip(stopped.body.bundle.path);
    const index = JSON.parse(zip.readAsText("index.json"));
    assert.equal(index.captureFileMode, "portable");
    assert.equal(index.recomputedReplay.kind, "recomputed-replay");
    assert.equal(index.recomputedReplay.parentVoyage, "voyage-20260716T090451Z.zip");
    assert.equal(index.recomputedReplay.playbackMode, "sensor-only");
    assert.equal(index.recomputedReplay.rate, 1);
    assert.equal(index.recomputedReplay.liveInputIsolationRequired, true);
    assert.deepEqual(
      index.recomputedReplay.sourcePolicy.resolvedSensorSourceIds,
      ["YDEN.2"],
    );
    assert.equal(index.recomputedReplay.result.sourceFilterStats.valuesExcluded, 1);
    assert.equal(index.recomputedReplay.result.coverage.complete, true);
    assert.deepEqual(index.captureFiles, captureFileNames);
    assert.deepEqual(
      index.recomputedReplay.result.resultSegments.segments.map(
        (segment) => segment.fileName,
      ),
      captureFileNames,
    );
    for (const declaredFileName of captureFileNames) {
      assert.ok(
        zip.getEntry(`capture/${declaredFileName}`),
        `portable child ZIP must include declared rotated segment ${declaredFileName}`,
      );
    }
  } finally {
    plugin.stop();
  }
});

function fakeApp(loggerApi) {
  return {
    signalk: new EventEmitter(),
    ajrmMarineLoggerApi: loggerApi,
    selfId: "urn:mrn:imo:mmsi:235008635",
    getSelfPath() {
      return null;
    },
    getPath() {
      return null;
    },
    handleMessage() {},
    setPluginStatus() {},
    debug() {},
    error() {},
  };
}

function routerMap(routes) {
  return {
    get(route, handler) {
      routes.set(`GET ${route}`, handler);
    },
    post(route, handler) {
      routes.set(`POST ${route}`, handler);
    },
  };
}

async function invoke(routes, method, route, body) {
  let statusCode = 200;
  let payload;
  const handler = routes.get(`${method} ${route}`);
  assert.ok(handler, `expected route ${method} ${route}`);
  await handler(
    { body },
    {
      status(code) {
        statusCode = code;
        return this;
      },
      json(value) {
        payload = value;
      },
    },
  );
  return { statusCode, body: payload };
}
