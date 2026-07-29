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
  await fs.mkdir(voyageDirectory, { recursive: true });
  const parentObservation = {
    schemaVersion: 1,
    id: "observation-parent",
    voyageId: "voyage-20260716T090451Z",
    recordedAt: "2026-07-16T09:30:00.000Z",
    voyageElapsedSeconds: 1509,
    replayOriginalAt: null,
    replayOriginalAtSource: null,
    source: "ajrm-marine-display",
    text: "Parent voyage observation",
    evidence: {
      requested: true,
      captured: true,
      fileName: "observations/evidence/parent-snapshot.json",
      snapshotPreset: "debug",
    },
    evidenceError: null,
  };
  const unsafeParentObservation = {
    ...parentObservation,
    id: "observation-parent-unsafe",
    recordedAt: "2026-07-16T09:31:00.000Z",
    text: "Parent observation with an unsafe evidence reference",
    evidence: {
      ...parentObservation.evidence,
      fileName: "../outside-parent-snapshot.json",
    },
  };
  const parentZip = new AdmZip();
  parentZip.addFile(
    "index.json",
    Buffer.from(
      JSON.stringify({
        id: "voyage-20260716T090451Z",
        observations: {
          schemaVersion: 1,
          fileName: "observations/observations.jsonl",
          count: 2,
        },
      }),
    ),
  );
  parentZip.addFile(
    "observations/observations.jsonl",
    Buffer.from(
      `${JSON.stringify(parentObservation)}\n${JSON.stringify(unsafeParentObservation)}\n`,
    ),
  );
  parentZip.addFile(
    "observations/evidence/parent-snapshot.json",
    Buffer.from(
      `${JSON.stringify({ schemaVersion: 1, observationId: "observation-parent" })}\n`,
    ),
  );
  parentZip.writeZip(
    path.join(voyageDirectory, "voyage-20260716T090451Z.zip"),
  );
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
      originalCapturedAt: "2026-07-16T08:57:51.000Z",
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
  let replayPlaybackStarted = false;
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
      loggerStatus.playback.resultCapture = { active: true };
      assert.equal(metadata.parentVoyage, "voyage-20260716T090451Z.zip");
      assert.equal(metadata.requestedBy, "signalk-ajrm-marine-capture");
      return recording;
    },
    async startPlayback(rate) {
      replayPlaybackStarted = true;
      assert.equal(rate, 1);
      loggerStatus.playback.active = true;
      loggerStatus.playback.lastReason = "playing";
      return loggerStatus.playback;
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
    assert.equal(replayPlaybackStarted, true);
    assert.equal(started.body.voyage.captureFileMode, "portable");
    assert.equal(
      started.body.voyage.recomputedReplay.parentVoyage,
      "voyage-20260716T090451Z.zip",
    );
    const captureApi =
      globalThis[Symbol.for("mcdonaldajr.ajrmMarineCaptureApi")];
    const observation = await captureApi.appendObservation({
      text: "Child replay observation",
      source: "ajrm-marine-display",
    });
    assert.equal(
      observation.replayOriginalAt,
      "2026-07-16T08:57:51.000Z",
    );
    assert.equal(
      observation.replayOriginalAtSource,
      "logger.playback.originalCapturedAt",
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

    loggerStatus.playback.lastError = {
      message: "simulated asynchronous playback failure",
      cursor: 2,
    };
    const rejectedPlaybackFailure = await invoke(
      routes,
      "POST",
      "/voyage/replay/stop",
      {},
    );
    assert.equal(rejectedPlaybackFailure.statusCode, 400);
    assert.match(rejectedPlaybackFailure.body.error, /playback failed/i);
    loggerStatus.playback.lastError = null;

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
    assert.equal(index.observations.count, 1);
    assert.equal(index.observations.parentLog.count, 2);
    assert.equal(index.observations.parentLog.lineageOnly, true);
    assert.equal(
      index.observations.parentLog.evidenceAvailableInParentCount,
      1,
    );
    const parentLineage = zip
      .readAsText("observations/parent-observations.jsonl")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(parentLineage[0].evidence.captured, false);
    assert.equal(parentLineage[0].evidence.fileName, null);
    assert.deepEqual(parentLineage[0].lineage, {
      parentVoyage: "voyage-20260716T090451Z.zip",
      lineageOnly: true,
      parentEvidenceAvailable: true,
      parentEvidenceFileName:
        "observations/evidence/parent-snapshot.json",
      parentEvidenceUnavailableReason: null,
    });
    assert.equal(parentLineage[1].evidence.captured, false);
    assert.equal(parentLineage[1].evidence.fileName, null);
    assert.deepEqual(parentLineage[1].lineage, {
      parentVoyage: "voyage-20260716T090451Z.zip",
      lineageOnly: true,
      parentEvidenceAvailable: false,
      parentEvidenceFileName: null,
      parentEvidenceUnavailableReason:
        "Parent observation referenced missing or unsafe Snapshot evidence",
    });
    assert.equal(
      zip.getEntry("observations/evidence/parent-snapshot.json"),
      null,
      "parent evidence must not appear as a dangling child evidence path",
    );
    assert.match(
      zip.readAsText("observations/observations.jsonl"),
      /Child replay observation/,
    );
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

test("interrupted recomputed replay preserves finalised partial output as incomplete and unverified", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ajrm-capture-replay-abort-"),
  );
  const voyageDirectory = path.join(root, "voyages");
  const loggerDirectory = path.join(root, "logger");
  const capturesDirectory = path.join(loggerDirectory, "captures");
  await fs.mkdir(capturesDirectory, { recursive: true });
  await fs.mkdir(voyageDirectory, { recursive: true });
  const startedAt = new Date();
  const partialFileName =
    `capture-${startedAt.toISOString().replace(/[:.]/g, "-")}.jsonl`;
  const partialContent = `${JSON.stringify({
    capturedAt: startedAt.toISOString(),
    originalCapturedAt: "2026-07-16T09:04:12.000Z",
    replayRole: "sensor-input",
    delta: {
      context: "vessels.self",
      updates: [{
        $source: "YDEN.2",
        timestamp: startedAt.toISOString(),
        values: [{
          path: "navigation.position",
          value: { latitude: 55.8, longitude: -5.7 },
        }],
      }],
    },
  })}\n`;
  await fs.writeFile(
    path.join(capturesDirectory, partialFileName),
    partialContent,
  );
  const sourcePolicy = {
    id: "strict-recorded-sensor-source-allowlist-v1",
    resolvedSensorSourceIds: ["YDEN.2"],
    sensorSourceIds: ["YDEN.2"],
  };
  const loggerStatus = {
    ok: true,
    playback: {
      loaded: true,
      active: false,
      paused: false,
      mode: "sensor-sources",
      replayMode: "sensor-only",
      rate: 1,
      cursor: 0,
      startCursor: 0,
      totalLines: 100,
      lastReason: "loaded",
      fileName: "capture-parent.jsonl",
      displayFileName: "voyage-parent.zip / capture-parent.jsonl",
      voyageFileName: "voyage-parent.zip",
      sourcePolicy,
      sourceCatalog: { "YDEN.2": { updates: 100, values: 100 } },
      coverage: {
        complete: false,
        preparedComplete: true,
        cursor: 0,
        startCursor: 0,
        totalLines: 100,
        segmentsCompleted: 0,
        segmentsTotal: 1,
      },
    },
    captures: [],
  };
  let playbackStartCalls = 0;
  let abortCalls = 0;
  const partialSegment = {
    index: 0,
    fileName: partialFileName,
    startedAt: startedAt.toISOString(),
    from: startedAt.toISOString(),
    to: startedAt.toISOString(),
    lines: 1,
    bytes: Buffer.byteLength(partialContent),
    compressed: false,
    finalized: true,
    available: true,
    error: null,
  };
  const replayResult = {
    schemaVersion: 1,
    kind: "recomputed-replay",
    parentVoyage: "voyage-parent.zip",
    playbackMode: "sensor-only",
    rate: 1,
    sourcePolicy,
    aborted: true,
    incomplete: true,
    abortReason: "user interrupted recomputed replay",
    coverage: {
      complete: false,
      preparedComplete: true,
      cursor: 12,
      totalLines: 100,
      lastReason: "playback error",
    },
    resultSegments: {
      schemaVersion: 1,
      complete: false,
      segmentsTotal: 1,
      segmentsFinalized: 1,
      lines: 1,
      bytes: Buffer.byteLength(partialContent),
      segments: [partialSegment],
    },
  };
  const app = fakeApp({
    async status() {
      return loggerStatus;
    },
    paths() {
      return { captures: capturesDirectory };
    },
    async startReplayResultCapture() {
      return {
        active: true,
        kind: "recomputed-replay",
        fileName: partialFileName,
        startedAt: startedAt.toISOString(),
      };
    },
    async startPlayback(rate) {
      playbackStartCalls += 1;
      assert.equal(rate, 1);
      loggerStatus.playback.active = true;
      loggerStatus.playback.lastReason = "playing";
      return loggerStatus.playback;
    },
    async abortReplayResultCapture(reason) {
      abortCalls += 1;
      assert.equal(reason, "user interrupted recomputed replay");
      loggerStatus.playback.active = false;
      loggerStatus.playback.lastReason = "aborted";
      return {
        active: false,
        kind: "recomputed-replay",
        fileName: partialFileName,
        replayResult,
      };
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
    const started = await invoke(routes, "POST", "/voyage/replay/start", {});
    assert.equal(started.statusCode, 200);
    assert.equal(playbackStartCalls, 1);
    const aborted = await invoke(routes, "POST", "/voyage/replay/abort", {
      reason: "user interrupted recomputed replay",
    });
    assert.equal(aborted.statusCode, 200);
    assert.equal(abortCalls, 1);
    assert.equal(aborted.body.bundle.format, "zip");

    const zip = new AdmZip(aborted.body.bundle.path);
    const index = JSON.parse(zip.readAsText("index.json"));
    assert.equal(index.incomplete, true);
    assert.equal(index.recomputationVerified, false);
    assert.equal(index.aborted, true);
    assert.equal(index.interruptedByRestart, false);
    assert.equal(index.recomputedReplay.status, "incomplete");
    assert.equal(index.recomputedReplay.complete, false);
    assert.equal(index.recomputedReplay.incomplete, true);
    assert.equal(index.recomputedReplay.verified, false);
    assert.equal(index.recomputedReplay.aborted, true);
    assert.equal(index.recomputedReplay.result.coverage.complete, false);
    assert.equal(index.recomputedReplay.result.resultSegments.complete, false);
    assert.deepEqual(index.captureFiles, [partialFileName]);
    assert.ok(zip.getEntry(`capture/${partialFileName}`));
    assert.match(
      index.hints.join("\n"),
      /incomplete and unverified/i,
    );
    assert.equal(
      JSON.parse(zip.readAsText("system/replay-abort-status.json")).verified,
      false,
    );
  } finally {
    plugin.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("automatic playback start failure aborts the armed result capture and saves an incomplete ZIP", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ajrm-capture-replay-start-failure-"),
  );
  const voyageDirectory = path.join(root, "voyages");
  const loggerDirectory = path.join(root, "logger");
  const capturesDirectory = path.join(loggerDirectory, "captures");
  await fs.mkdir(capturesDirectory, { recursive: true });
  await fs.mkdir(voyageDirectory, { recursive: true });
  const sourcePolicy = {
    id: "strict-recorded-sensor-source-allowlist-v1",
    resolvedSensorSourceIds: ["YDEN.2"],
    sensorSourceIds: ["YDEN.2"],
  };
  const loggerStatus = {
    ok: true,
    playback: {
      loaded: true,
      active: false,
      paused: false,
      mode: "sensor-sources",
      replayMode: "sensor-only",
      rate: 1,
      cursor: 0,
      startCursor: 0,
      totalLines: 10,
      lastReason: "loaded",
      fileName: "capture-parent.jsonl",
      displayFileName: "voyage-parent.zip / capture-parent.jsonl",
      voyageFileName: "voyage-parent.zip",
      sourcePolicy,
      sourceCatalog: {},
      coverage: {
        complete: false,
        preparedComplete: true,
        cursor: 0,
        startCursor: 0,
        totalLines: 10,
      },
    },
    captures: [],
  };
  let abortCalls = 0;
  const app = fakeApp({
    async status() {
      return loggerStatus;
    },
    paths() {
      return { captures: capturesDirectory };
    },
    async startReplayResultCapture() {
      return {
        active: true,
        kind: "recomputed-replay",
        fileName: "capture-2026-07-28T10-00-00-000Z.jsonl",
        startedAt: new Date().toISOString(),
      };
    },
    async startPlayback() {
      throw new Error("simulated playback start failure");
    },
    async abortReplayResultCapture(reason) {
      abortCalls += 1;
      assert.match(reason, /playback failed to start/i);
      return {
        active: false,
        kind: "recomputed-replay",
        replayResult: {
          schemaVersion: 1,
          kind: "recomputed-replay",
          aborted: true,
          incomplete: true,
          abortReason: reason,
          coverage: {
            complete: false,
            preparedComplete: true,
            cursor: 0,
            totalLines: 10,
          },
          resultSegments: {
            schemaVersion: 1,
            complete: false,
            segmentsTotal: 0,
            segmentsFinalized: 0,
            lines: 0,
            bytes: 0,
            segments: [],
          },
        },
      };
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
    const started = await invoke(routes, "POST", "/voyage/replay/start", {});
    assert.equal(started.statusCode, 400);
    assert.match(started.body.error, /saved as incomplete, unverified ZIP/i);
    assert.equal(abortCalls, 1);
    const zipNames = (await fs.readdir(voyageDirectory))
      .filter((name) => name.endsWith(".zip"));
    assert.equal(zipNames.length, 1);
    const index = JSON.parse(
      new AdmZip(path.join(voyageDirectory, zipNames[0])).readAsText(
        "index.json",
      ),
    );
    assert.equal(index.incomplete, true);
    assert.equal(index.recomputationVerified, false);
    assert.equal(index.recomputedReplay.result.coverage.complete, false);
    const status = await invoke(routes, "GET", "/status");
    assert.equal(status.body.currentVoyage, null);
  } finally {
    plugin.stop();
    await fs.rm(root, { recursive: true, force: true });
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
