"use strict";

const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const nativeFs = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const AdmZip = require("adm-zip");
const createPlugin = require("../plugin");

test("voyage starts wait for startup recovery and concurrent callers share one start", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ajrm-capture-startup-recovery-"),
  );
  const voyageDirectory = path.join(root, "voyages");
  const loggerDirectory = path.join(root, "logger");
  const routes = new Map();
  const originalReaddir = nativeFs.promises.readdir;
  const originalMkdir = nativeFs.promises.mkdir;
  let releaseRecovery;
  let releaseVoyageMkdir;
  let signalRecoveryEntered;
  let signalVoyageMkdirEntered;
  const recoveryGate = new Promise((resolve) => {
    releaseRecovery = resolve;
  });
  const voyageMkdirGate = new Promise((resolve) => {
    releaseVoyageMkdir = resolve;
  });
  const recoveryEntered = new Promise((resolve) => {
    signalRecoveryEntered = resolve;
  });
  const voyageMkdirEntered = new Promise((resolve) => {
    signalVoyageMkdirEntered = resolve;
  });
  let recoveryIntercepted = false;
  let snapshotMkdirCalls = 0;
  let startCaptureCalls = 0;
  let stopCaptureCalls = 0;
  let firstStartRequest = null;
  let secondStartRequest = null;
  let plugin = null;

  nativeFs.promises.readdir = async function delayedRecoveryReaddir(
    target,
    options,
  ) {
    if (
      !recoveryIntercepted &&
      path.resolve(String(target)) === path.resolve(voyageDirectory) &&
      options?.withFileTypes === true
    ) {
      recoveryIntercepted = true;
      signalRecoveryEntered();
      await recoveryGate;
    }
    return originalReaddir.call(this, target, options);
  };
  nativeFs.promises.mkdir = async function delayedFirstVoyageMkdir(
    target,
    options,
  ) {
    const resolvedTarget = path.resolve(String(target));
    const voyageRoot = path.dirname(path.dirname(resolvedTarget));
    if (
      path.basename(resolvedTarget) === "snapshots" &&
      voyageRoot === path.resolve(voyageDirectory) &&
      /^voyage-\d{8}T\d{6}Z$/.test(path.basename(path.dirname(resolvedTarget)))
    ) {
      snapshotMkdirCalls += 1;
      signalVoyageMkdirEntered();
      await voyageMkdirGate;
    }
    return originalMkdir.call(this, target, options);
  };

  try {
    const app = fakeApp({
      async status() {
        return { ok: true, playback: { loaded: false }, captures: [] };
      },
      paths() {
        return { captures: path.join(loggerDirectory, "captures") };
      },
      async startCapture() {
        startCaptureCalls += 1;
        const startedAt = new Date().toISOString();
        return {
          active: true,
          fileName: "capture-startup-test.jsonl",
          startedAt,
          from: startedAt,
        };
      },
      async stopCapture() {
        stopCaptureCalls += 1;
        return {
          active: false,
          fileName: "capture-startup-test.jsonl",
          to: new Date().toISOString(),
        };
      },
    });
    plugin = createPlugin(app);
    plugin.registerWithRouter(routerMap(routes));
    plugin.start({
      enabled: false,
      voyageDirectory,
      ajrmMarineLoggerLogDirectory: loggerDirectory,
      captureMode: "minimal",
      captureFileMode: "reference",
      deleteWorkingDirectoryAfterZip: true,
    });
    await recoveryEntered;

    firstStartRequest = invoke(routes, "POST", "/voyage/start", {
      comment: "Startup recovery gate test",
    });
    const mkdirCallsBeforeRecoveryFinished = snapshotMkdirCalls;

    releaseRecovery();
    await voyageMkdirEntered;

    secondStartRequest = invoke(routes, "POST", "/voyage/start", {
      comment: "Concurrent caller must share the first start",
    });
    await new Promise((resolve) => setImmediate(resolve));
    const mkdirCallsWhileFirstStartWasBlocked = snapshotMkdirCalls;

    releaseVoyageMkdir();
    const [firstStarted, secondStarted] = await Promise.all([
      firstStartRequest,
      secondStartRequest,
    ]);
    const stopped = await invoke(routes, "POST", "/voyage/stop", {});

    assert.equal(
      mkdirCallsBeforeRecoveryFinished,
      0,
      "a voyage directory must not be created until startup recovery has finished",
    );
    assert.equal(
      mkdirCallsWhileFirstStartWasBlocked,
      1,
      "concurrent callers must share the in-flight voyage start",
    );
    assert.equal(firstStarted.statusCode, 200);
    assert.equal(secondStarted.statusCode, 200);
    assert.equal(firstStarted.body.voyage.id, secondStarted.body.voyage.id);
    assert.equal(startCaptureCalls, 1);
    assert.equal(stopped.statusCode, 200);
    assert.equal(stopCaptureCalls, 1);
  } finally {
    releaseRecovery();
    releaseVoyageMkdir();
    await Promise.allSettled(
      [firstStartRequest, secondStartRequest].filter(Boolean),
    );
    plugin?.stop();
    nativeFs.promises.readdir = originalReaddir;
    nativeFs.promises.mkdir = originalMkdir;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("startup recovery preserves only bounded partial recomputed segments and marks the ZIP unverified", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ajrm-capture-recomputed-recovery-"),
  );
  const voyageDirectory = path.join(root, "voyages");
  const loggerDirectory = path.join(root, "logger");
  const capturesDirectory = path.join(loggerDirectory, "captures");
  await fs.mkdir(voyageDirectory, { recursive: true });
  await fs.mkdir(capturesDirectory, { recursive: true });
  const now = new Date();
  const voyageStartedAt = new Date(now.getTime() - 2 * 60 * 1000);
  const voyageId = `voyage-${voyageStartedAt.toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")}`;
  const workingDirectory = path.join(voyageDirectory, voyageId);
  await fs.mkdir(path.join(workingDirectory, "capture"), { recursive: true });
  const firstFileName = captureName(voyageStartedAt);
  const rotatedFileName = captureName(
    new Date(voyageStartedAt.getTime() + 60 * 1000),
  );
  const corruptPartialFileName = `${captureName(
    new Date(voyageStartedAt.getTime() + 90 * 1000),
  )}.gz`;
  const beforeFileName = captureName(
    new Date(voyageStartedAt.getTime() - 10 * 60 * 1000),
  );
  const futureFileName = captureName(
    new Date(now.getTime() + 10 * 60 * 1000),
  );
  for (const [fileName, capturedAt] of [
    [firstFileName, voyageStartedAt],
    [rotatedFileName, new Date(voyageStartedAt.getTime() + 60 * 1000)],
    [beforeFileName, new Date(voyageStartedAt.getTime() - 10 * 60 * 1000)],
    [futureFileName, new Date(now.getTime() + 10 * 60 * 1000)],
  ]) {
    await fs.writeFile(
      path.join(capturesDirectory, fileName),
      `${JSON.stringify({
        capturedAt: capturedAt.toISOString(),
        originalCapturedAt: "2026-07-16T09:04:12.000Z",
        replayRole: "sensor-input",
        delta: {
          context: "vessels.self",
          updates: [{
            $source: "YDEN.2",
            timestamp: capturedAt.toISOString(),
            values: [{
              path: "navigation.speedOverGround",
              value: 2,
            }],
          }],
        },
      })}\n`,
    );
  }
  await fs.writeFile(
    path.join(capturesDirectory, corruptPartialFileName),
    Buffer.from("not a valid gzip stream"),
  );
  await fs.writeFile(
    path.join(workingDirectory, "index.json"),
    `${JSON.stringify({
      id: voyageId,
      startedAt: voyageStartedAt.toISOString(),
      startReason: "recomputed replay",
      captureMode: "minimal",
      captureFileMode: "portable",
      comment: "Interrupted recomputation",
      recomputedReplay: {
        schemaVersion: 1,
        kind: "recomputed-replay",
        parentVoyage: "voyage-parent.zip",
        playbackMode: "sensor-only",
        rate: 1,
        sourcePolicy: {
          id: "strict-recorded-sensor-source-allowlist-v1",
          resolvedSensorSourceIds: ["YDEN.2"],
        },
      },
      ajrmMarineLogger: {
        start: {
          ok: true,
          recording: {
            active: true,
            kind: "recomputed-replay",
            fileName: firstFileName,
            startedAt: voyageStartedAt.toISOString(),
            from: voyageStartedAt.toISOString(),
          },
        },
      },
      captureReferences: [],
      observations: {
        schemaVersion: 1,
        fileName: "observations/observations.jsonl",
        count: 0,
      },
      events: [],
    }, null, 2)}\n`,
  );

  const app = fakeApp({
    async status() {
      return { ok: true, playback: { loaded: false }, captures: [] };
    },
    paths() {
      return { captures: capturesDirectory };
    },
  });
  const plugin = createPlugin(app);
  plugin.start({
    enabled: false,
    voyageDirectory,
    ajrmMarineLoggerLogDirectory: loggerDirectory,
    captureMode: "minimal",
    captureFileMode: "reference",
    deleteWorkingDirectoryAfterZip: true,
  });

  try {
    const zipPath = path.join(voyageDirectory, `${voyageId}.zip`);
    await waitForFile(zipPath);
    const zip = new AdmZip(zipPath);
    const index = JSON.parse(zip.readAsText("index.json"));
    assert.equal(index.interruptedByRestart, true);
    assert.equal(index.incomplete, true);
    assert.equal(index.recomputationVerified, false);
    assert.equal(index.aborted, false);
    assert.equal(index.recomputedReplay.incomplete, true);
    assert.equal(index.recomputedReplay.verified, false);
    assert.equal(index.recomputedReplay.interruptedByRestart, true);
    assert.equal(index.recomputedReplay.result.coverage.complete, false);
    assert.equal(
      index.recomputedReplay.result.resultSegments.complete,
      false,
    );
    assert.equal(
      index.recomputedReplay.partialCaptureRecovery.verified,
      false,
    );
    assert.equal(
      index.recomputedReplay.partialCaptureRecovery.selectionMethod,
      "known-name-or-strict-voyage-wall-time-window",
    );
    assert.deepEqual(index.captureFiles, [
      corruptPartialFileName,
      firstFileName,
      rotatedFileName,
    ].sort());
    assert.match(
      index.captureIndex.files.find(
        (file) => file.fileName === corruptPartialFileName,
      ).error,
      /could not be decoded/i,
    );
    assert.ok(zip.getEntry(`capture/${firstFileName}`));
    assert.ok(zip.getEntry(`capture/${rotatedFileName}`));
    assert.ok(zip.getEntry(`capture/${corruptPartialFileName}`));
    assert.equal(zip.getEntry(`capture/${beforeFileName}`), null);
    assert.equal(zip.getEntry(`capture/${futureFileName}`), null);
    const recoveryStatus = JSON.parse(
      zip.readAsText("system/recovery-status.json"),
    );
    assert.equal(recoveryStatus.incomplete, true);
    assert.equal(recoveryStatus.recomputationVerified, false);
  } finally {
    plugin.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

function captureName(date) {
  return `capture-${date.toISOString().replace(/[:.]/g, "-")}.jsonl`;
}

async function waitForFile(filePath) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const info = await fs.stat(filePath).catch(() => null);
    if (info?.isFile()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

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
