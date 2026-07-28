"use strict";

const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const nativeFs = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
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
