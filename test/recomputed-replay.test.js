"use strict";

const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const AdmZip = require("adm-zip");

const createPlugin = require("../plugin");
const {
  INPUT_CONTRACT,
  INPUT_RELATIVE_PATH,
  RECOMPUTED_OUTPUT_RELATIVE_PATH,
  REPLAY_CONTRACT,
  canonicalInputRecord,
} = require("../plugin/canonical-voyage");
const { recomputedReplayVerification } = createPlugin._private;

test("recomputed verification requires canonical EOF and valid timing", () => {
  assert.deepEqual(
    recomputedReplayVerification(
      { timingRequired: true },
      {
        timing: { valid: false, effectiveRate: 0.12 },
        coverage: { complete: true, lastReason: "end of canonical input" },
      },
    ),
    {
      verified: false,
      failure:
        "AJRM Marine Capture measured an invalid effective replay rate of 0.12x",
    },
  );
  assert.deepEqual(
    recomputedReplayVerification(
      { timingRequired: true },
      {
        timing: { valid: true, effectiveRate: 1 },
        coverage: { complete: false, lastReason: "failed" },
      },
    ),
    {
      verified: false,
      failure: "AJRM Marine Capture did not reach canonical input EOF",
    },
  );
  assert.deepEqual(
    recomputedReplayVerification(
      { timingRequired: true },
      {
        timing: { valid: true, effectiveRate: 1 },
        coverage: {
          complete: true,
          lastReason: "end of canonical input",
        },
      },
    ),
    { verified: true, failure: null },
  );
});

test("Capture records canonical YDEN input and excludes derived updates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-canonical-record-"));
  const voyageDirectory = path.join(root, "voyages");
  const app = fakeApp();
  const routes = new Map();
  const plugin = createPlugin(app);
  plugin.registerWithRouter(routerMap(routes));
  plugin.start({
    enabled: false,
    voyageDirectory,
    captureMode: "minimal",
    deleteWorkingDirectoryAfterZip: false,
  });

  try {
    const started = await invoke(routes, "POST", "/voyage/start", {});
    assert.equal(started.statusCode, 200);
    app.signalk.emit("delta", {
      context: "vessels.self",
      updates: [
        {
          $source: "YDEN.2",
          timestamp: "2026-07-31T08:00:00.000Z",
          values: [
            { path: "navigation.position", value: { latitude: 55.8, longitude: -5.7 } },
          ],
        },
        {
          $source: "derived-data",
          timestamp: "2026-07-31T08:00:00.000Z",
          values: [{ path: "navigation.speedOverGround", value: 99 }],
        },
      ],
    });
    const stopped = await invoke(routes, "POST", "/voyage/stop", {});
    assert.equal(stopped.statusCode, 200);
    const zip = new AdmZip(stopped.body.bundle.path);
    const input = zip.readAsText(INPUT_RELATIVE_PATH).trim().split("\n");
    assert.equal(input.length, 1);
    const record = JSON.parse(input[0]);
    assert.equal(record.contract, INPUT_CONTRACT);
    assert.deepEqual(
      record.delta.updates.map((update) => update.$source),
      ["YDEN.2"],
    );
    const index = JSON.parse(zip.readAsText("index.json"));
    assert.equal(index.canonicalInput.contract, INPUT_CONTRACT);
    assert.equal(index.canonicalInput.complete, true);
    assert.equal(index.canonicalInput.records, 1);
  } finally {
    plugin.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Capture replays canonical input at fixed 1x and builds a verified child ZIP", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-merged-replay-"));
  const voyageDirectory = path.join(root, "voyages");
  await fs.mkdir(voyageDirectory, { recursive: true });
  const parentFileName = "voyage-parent.zip";
  const parentZip = new AdmZip();
  parentZip.addFile(
    "index.json",
    Buffer.from(JSON.stringify({
      id: "voyage-parent",
      startedAt: "2026-07-01T10:00:00.000Z",
      stoppedAt: "2026-07-01T10:00:04.000Z",
      canonicalInput: {
        contract: INPUT_CONTRACT,
        schemaVersion: 1,
        fileName: INPUT_RELATIVE_PATH,
        complete: true,
        records: 3,
      },
    })),
  );
  const records = [0, 2000, 4000].map((elapsedMs) =>
    canonicalInputRecord({
      elapsedMs,
      delta: {
        context: "vessels.self",
        updates: [{
          $source: "YDEN.2",
          timestamp: "2026-07-01T10:00:00.000Z",
          values: [
            { path: "navigation.datetime", value: "2026-07-01T10:00:00.000Z" },
            { path: "navigation.speedOverGround", value: 1.2 },
          ],
        }],
      },
    }),
  );
  parentZip.addFile(
    INPUT_RELATIVE_PATH,
    Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`),
  );
  parentZip.writeZip(path.join(voyageDirectory, parentFileName));

  const app = fakeApp({ echoHandledDeltas: true });
  const routes = new Map();
  const plugin = createPlugin(app);
  plugin.registerWithRouter(routerMap(routes));
  plugin.start({
    enabled: false,
    voyageDirectory,
    captureMode: "minimal",
    deleteWorkingDirectoryAfterZip: false,
  });

  try {
    const started = await invoke(routes, "POST", "/voyage/replay/start", {
      file: parentFileName,
    });
    assert.equal(started.statusCode, 200);
    assert.equal(started.body.voyage.recomputedReplay.inputContract, INPUT_CONTRACT);
    await waitFor(async () => {
      const status = await invoke(routes, "GET", "/status");
      if (status.body.playback.state === "failed") {
        throw new Error(status.body.playback.error || "Replay failed");
      }
      return status.body.playback.state === "complete";
    });
    const status = await invoke(routes, "GET", "/status");
    assert.equal(status.body.playback.contract, REPLAY_CONTRACT);
    assert.equal(status.body.playback.requestedRate, 1);
    assert.equal(status.body.playback.recordsReplayed, 3);
    assert.equal(status.body.playback.valid, true);
    assert.ok(status.body.playback.effectiveRatio >= 0.9);

    const stopped = await invoke(routes, "POST", "/voyage/replay/stop", {});
    assert.equal(stopped.statusCode, 200);
    const zip = new AdmZip(stopped.body.bundle.path);
    const index = JSON.parse(zip.readAsText("index.json"));
    assert.equal(index.incomplete, false);
    assert.equal(index.recomputationVerified, true);
    assert.equal(index.recomputedReplay.verified, true);
    assert.equal(index.recomputedReplay.inputContract, INPUT_CONTRACT);
    assert.equal(index.recomputedReplay.replayContract, REPLAY_CONTRACT);
    assert.equal(
      index.recomputedReplay.result.coverage.lastReason,
      "end of canonical input",
    );
    assert.equal(index.recomputedOutput.complete, true);
    assert.equal(index.recomputedOutput.records, 3);
    assert.ok(zip.getEntry(RECOMPUTED_OUTPUT_RELATIVE_PATH));
    const checkpoint = JSON.parse(
      zip.readAsText("system/recomputed-replay-completion.json"),
    );
    assert.equal(checkpoint.recomputationVerified, true);
  } finally {
    plugin.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("legacy voyage bundles fail clearly instead of entering compatibility playback", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-legacy-replay-"));
  const voyageDirectory = path.join(root, "voyages");
  await fs.mkdir(voyageDirectory, { recursive: true });
  const zip = new AdmZip();
  zip.addFile("index.json", Buffer.from(JSON.stringify({ id: "legacy" })));
  zip.writeZip(path.join(voyageDirectory, "legacy.zip"));
  const routes = new Map();
  const plugin = createPlugin(fakeApp());
  plugin.registerWithRouter(routerMap(routes));
  plugin.start({ enabled: false, voyageDirectory });
  try {
    const result = await invoke(routes, "POST", "/voyage/replay/start", {
      file: "legacy.zip",
    });
    assert.equal(result.statusCode, 400);
    assert.match(result.body.error, /one-off conversion/i);
  } finally {
    plugin.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("failed canonical extraction rolls back the child voyage transaction", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-broken-replay-"));
  const voyageDirectory = path.join(root, "voyages");
  await fs.mkdir(voyageDirectory, { recursive: true });
  const zip = new AdmZip();
  zip.addFile(
    "index.json",
    Buffer.from(JSON.stringify({
      id: "broken",
      canonicalInput: {
        contract: INPUT_CONTRACT,
        fileName: INPUT_RELATIVE_PATH,
      },
    })),
  );
  zip.writeZip(path.join(voyageDirectory, "broken.zip"));
  const routes = new Map();
  const plugin = createPlugin(fakeApp());
  plugin.registerWithRouter(routerMap(routes));
  plugin.start({ enabled: false, voyageDirectory });
  try {
    const result = await invoke(routes, "POST", "/voyage/replay/start", {
      file: "broken.zip",
    });
    assert.equal(result.statusCode, 400);
    assert.match(result.body.error, /canonical input/i);
    const status = await invoke(routes, "GET", "/status");
    assert.equal(status.body.currentVoyage, null);
    assert.equal(status.body.playback.state, "idle");
    const entries = await fs.readdir(voyageDirectory);
    assert.deepEqual(
      entries.filter((name) => /^voyage-\d{8}T\d{6}Z$/.test(name)),
      [],
    );
  } finally {
    plugin.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

function fakeApp({ echoHandledDeltas = false } = {}) {
  const signalk = new EventEmitter();
  return {
    signalk,
    selfId: "urn:mrn:imo:mmsi:235008635",
    getSelfPath() {
      return null;
    },
    getPath() {
      return null;
    },
    handleMessage(source, delta) {
      if (echoHandledDeltas && source === "signalk-ajrm-marine-capture") {
        signalk.emit("delta", {
          ...delta,
          $source: source,
        });
      }
    },
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

async function invoke(routes, method, route, body = {}) {
  let statusCode = 200;
  let payload;
  const handler = routes.get(`${method} ${route}`);
  assert.ok(handler, `expected route ${method} ${route}`);
  await handler(
    { body, query: {} },
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

async function waitFor(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for replay");
}
