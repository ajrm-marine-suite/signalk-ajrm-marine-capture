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
  RECOMPUTED_OUTPUT_CONTRACT,
  RECOMPUTED_OUTPUT_RELATIVE_PATH,
  RECORDED_OUTPUT_PLAYBACK_CONTRACT,
  REPLAY_CONTRACT,
  canonicalInputRecord,
} = require("../plugin/canonical-voyage");
const { recomputedReplayVerification } = createPlugin._private;
const DR_TRACK_RELATIVE_PATH = "tracks/dr-track.jsonl";

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

test("Capture records canonical physical input and excludes derived updates", async () => {
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
          $source: "n2k-gateway.2",
          source: {
            label: "n2k-gateway",
            type: "NMEA2000",
            pgn: 129025,
            src: "2",
          },
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
      ["n2k-gateway.2"],
    );
    const index = JSON.parse(zip.readAsText("index.json"));
    assert.equal(index.canonicalInput.contract, INPUT_CONTRACT);
    assert.equal(index.canonicalInput.complete, true);
    assert.equal(index.canonicalInput.records, 1);
    assert.deepEqual(index.canonicalInput.sourceTypes, ["NMEA2000", "NMEA0183", "GPSD"]);
  } finally {
    plugin.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Capture replays canonical input at fixed 1x and automatically builds a verified child ZIP at EOF", async () => {
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

    await waitFor(async () => {
      const finalStatus = await invoke(routes, "GET", "/status");
      if (finalStatus.body.finalisation?.state === "failed") {
        throw new Error(finalStatus.body.finalisation.error || "Finalisation failed");
      }
      return finalStatus.body.finalisation?.state === "complete";
    });
    const finalStatus = await invoke(routes, "GET", "/status");
    assert.equal(finalStatus.body.currentVoyage, null);
    assert.equal(finalStatus.body.finalisation.recomputationVerified, true);
    assert.equal(
      finalStatus.body.recentEvents.some((event) =>
        event.type === "voyage-stopping" && /verified replay EOF/.test(event.message)),
      true,
    );
    const zip = new AdmZip(finalStatus.body.lastBundle.path);
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

test("non-canonical voyage bundles fail clearly instead of entering compatibility playback", async () => {
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
    assert.match(result.body.error, /required ajrm-marine-canonical-input-v1 contract/i);
  } finally {
    plugin.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("completed recorded result plays at fixed 1x without recording another voyage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-play-as-recorded-"));
  const voyageDirectory = path.join(root, "voyages");
  await fs.mkdir(voyageDirectory, { recursive: true });
  const fileName = "voyage-recorded-result.zip";
  const zip = new AdmZip();
  zip.addFile("index.json", Buffer.from(JSON.stringify({
    id: "voyage-recorded-result",
    startedAt: "2026-07-01T10:00:00.000Z",
    recomputedReplay: {
      kind: "recomputed-replay",
      originalFrom: "2026-06-01T08:00:00.000Z",
    },
    recomputedOutput: {
      contract: RECOMPUTED_OUTPUT_CONTRACT,
      schemaVersion: 1,
      fileName: RECOMPUTED_OUTPUT_RELATIVE_PATH,
      complete: true,
      records: 2,
    },
  })));
  const recordedTimestamp = "2026-07-01T10:00:00.000Z";
  const outputRecords = [0, 100].map((elapsedMs) => ({
    contract: RECOMPUTED_OUTPUT_CONTRACT,
    elapsedMs,
    delta: {
      context: "vessels.self",
      updates: [{
        $source: "signalk-ajrm-marine-traffic",
        timestamp: recordedTimestamp,
        values: [{
          path: "plugins.ajrmMarineTraffic.voyageState",
          value: { profile: "coastal", sequence: elapsedMs },
        }],
      }],
    },
  }));
  zip.addFile(
    RECOMPUTED_OUTPUT_RELATIVE_PATH,
    Buffer.from(`${outputRecords.map(JSON.stringify).join("\n")}\n`),
  );
  zip.writeZip(path.join(voyageDirectory, fileName));

  const app = fakeApp();
  const emitted = [];
  app.handleMessage = (source, delta) => emitted.push({ source, delta });
  const routes = new Map();
  const plugin = createPlugin(app);
  plugin.registerWithRouter(routerMap(routes));
  plugin.start({ enabled: false, voyageDirectory, captureMode: "minimal" });
  try {
    const before = await invoke(routes, "GET", "/status");
    const selected = before.body.voyages.find((voyage) => voyage.fileName === fileName);
    assert.equal(selected.recomputedOutput.contract, RECOMPUTED_OUTPUT_CONTRACT);
    assert.equal(selected.recomputedOutput.complete, true);

    const started = await invoke(routes, "POST", "/voyage/playback/start", { file: fileName });
    assert.equal(started.statusCode, 200);
    assert.equal(started.body.playback.mode, "recorded-output");
    assert.equal(started.body.playback.recording, false);
    await waitFor(async () => {
      const status = await invoke(routes, "GET", "/status");
      return status.body.playback.state === "complete";
    });
    const status = await invoke(routes, "GET", "/status");
    assert.equal(status.body.currentVoyage, null);
    assert.equal(status.body.lastBundle, null);
    assert.equal(status.body.playback.contract, RECORDED_OUTPUT_PLAYBACK_CONTRACT);
    assert.equal(status.body.playback.recordsReplayed, 2);
    assert.equal(status.body.playback.recording, false);
    const recordedDeltas = emitted.filter(({ delta }) =>
      delta.updates?.some((update) =>
        update.$source === "signalk-ajrm-marine-traffic",
      ),
    );
    assert.equal(recordedDeltas.length, 2);
    assert.equal(recordedDeltas[0].source, "signalk-ajrm-marine-capture");
    assert.deepEqual(
      recordedDeltas[1].delta.updates[0].values[0].value,
      { profile: "coastal", sequence: 100 },
    );
    assert.notEqual(
      recordedDeltas[0].delta.updates[0].timestamp,
      recordedTimestamp,
    );
    const files = (await fs.readdir(voyageDirectory)).filter((name) => name.endsWith(".zip"));
    assert.deepEqual(files, [fileName]);
  } finally {
    await plugin.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("recorded-result playback can be stopped without creating a voyage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-stop-recorded-output-"));
  const voyageDirectory = path.join(root, "voyages");
  await fs.mkdir(voyageDirectory, { recursive: true });
  const fileName = "voyage-long-recorded-result.zip";
  const zip = new AdmZip();
  zip.addFile("index.json", Buffer.from(JSON.stringify({
    id: "voyage-long-recorded-result",
    startedAt: "2026-07-01T10:00:00.000Z",
    recomputedOutput: {
      contract: RECOMPUTED_OUTPUT_CONTRACT,
      complete: true,
      records: 2,
    },
  })));
  zip.addFile(
    RECOMPUTED_OUTPUT_RELATIVE_PATH,
    Buffer.from(`${[0, 60_000].map((elapsedMs) => JSON.stringify({
      contract: RECOMPUTED_OUTPUT_CONTRACT,
      elapsedMs,
      delta: {
        context: "vessels.self",
        updates: [{
          $source: "signalk-ajrm-marine-traffic",
          timestamp: "2026-07-01T10:00:00.000Z",
          values: [{ path: "navigation.speedOverGround", value: 2 }],
        }],
      },
    })).join("\n")}\n`),
  );
  zip.writeZip(path.join(voyageDirectory, fileName));

  const routes = new Map();
  const plugin = createPlugin(fakeApp());
  plugin.registerWithRouter(routerMap(routes));
  plugin.start({ enabled: false, voyageDirectory, captureMode: "minimal" });
  try {
    const started = await invoke(routes, "POST", "/voyage/playback/start", {
      file: fileName,
    });
    assert.equal(started.statusCode, 200);
    const stopped = await invoke(routes, "POST", "/voyage/playback/stop", {});
    assert.equal(stopped.statusCode, 200);
    assert.equal(stopped.body.playback.state, "aborted");
    assert.equal(stopped.body.playback.recording, false);
    const status = await invoke(routes, "GET", "/status");
    assert.equal(status.body.currentVoyage, null);
    assert.equal(status.body.lastBundle, null);
    assert.deepEqual(
      (await fs.readdir(voyageDirectory)).filter((name) => name.endsWith(".zip")),
      [fileName],
    );
  } finally {
    await plugin.stop();
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

test("startup recovers an interrupted ordinary voyage and trims only a torn final record", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-startup-recovery-"));
  const voyageDirectory = path.join(root, "voyages");
  const voyageId = "voyage-20260803T190853Z";
  const workingDirectory = path.join(voyageDirectory, voyageId);
  await fs.mkdir(path.join(workingDirectory, "input"), { recursive: true });
  await fs.writeFile(
    path.join(workingDirectory, "index.json"),
    JSON.stringify({
      id: voyageId,
      startedAt: "2026-08-03T19:08:53.000Z",
      startReason: "movement detected",
      captureMode: "minimal",
      canonicalInput: {
        contract: INPUT_CONTRACT,
        schemaVersion: 1,
        fileName: INPUT_RELATIVE_PATH,
        records: 1,
        bytes: 1,
        complete: false,
        sourcePrefixes: ["YDEN"],
      },
      drTrack: {
        fileName: DR_TRACK_RELATIVE_PATH,
        samples: 1,
        writeErrors: 0,
        startedAt: "2026-08-03T19:08:53.000Z",
        stoppedAt: null,
        firstSampleAt: "2026-08-03T19:08:53.100Z",
        lastSampleAt: "2026-08-03T19:08:53.100Z",
        lastSampleKey: "stale-checkpoint",
      },
    }),
  );
  const records = [0, 1000].map((elapsedMs) =>
    canonicalInputRecord({
      elapsedMs,
      capturedAt: new Date(Date.parse("2026-08-03T19:08:53.000Z") + elapsedMs).toISOString(),
      delta: {
        context: "vessels.self",
        updates: [{
          $source: "YDEN.2",
          timestamp: "2026-08-03T19:08:53.000Z",
          values: [{ path: "navigation.speedOverGround", value: 1.2 }],
        }],
      },
    }),
  );
  const completeInput = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const tornFragment = '{"contract":"ajrm-marine-canonical-input-v1"';
  await fs.writeFile(
    path.join(workingDirectory, INPUT_RELATIVE_PATH),
    `${completeInput}${tornFragment}`,
  );
  const drSamples = [100, 500, 900].map((elapsedMs) => ({
    ts: new Date(Date.parse("2026-08-03T19:08:53.000Z") + elapsedMs).toISOString(),
    trust: "normal",
    gps: { lat: 55.8, lon: -5.7 },
  }));
  const completeDrTrack = `${drSamples.map((sample) => JSON.stringify(sample)).join("\n")}\n`;
  await fs.mkdir(path.join(workingDirectory, "tracks"), { recursive: true });
  await fs.writeFile(
    path.join(workingDirectory, DR_TRACK_RELATIVE_PATH),
    completeDrTrack,
  );

  const app = fakeApp();
  const plugin = createPlugin(app);
  plugin.start({
    enabled: false,
    voyageDirectory,
    captureMode: "minimal",
    deleteWorkingDirectoryAfterZip: false,
  });

  try {
    const zipPath = path.join(voyageDirectory, `${voyageId}.zip`);
    await waitFor(async () => fs.stat(zipPath).then(() => true, () => false));
    const zip = new AdmZip(zipPath);
    const index = JSON.parse(zip.readAsText("index.json"));
    assert.equal(index.interruptedByRestart, true);
    assert.equal(index.stoppedAt, "2026-08-03T19:08:54.000Z");
    assert.equal(index.canonicalInput.complete, true);
    assert.equal(index.canonicalInput.recoveredAfterRestart, true);
    assert.equal(index.canonicalInput.records, 2);
    assert.equal(index.canonicalInput.lastElapsedMs, 1000);
    assert.equal(index.canonicalInput.truncatedTrailingBytes, Buffer.byteLength(tornFragment));
    assert.equal(zip.readAsText(INPUT_RELATIVE_PATH), completeInput);
    assert.equal(index.drTrack.samples, 3);
    assert.equal(index.drTrack.firstSampleAt, drSamples[0].ts);
    assert.equal(index.drTrack.lastSampleAt, drSamples[2].ts);
    assert.equal(index.drTrack.stoppedAt, "2026-08-03T19:08:54.000Z");
    assert.equal(index.drTrack.recoveredAfterRestart, true);
    assert.equal(index.drTrack.invalidRecords, 0);
    assert.equal(index.drTrack.lastSampleKey, undefined);
    assert.equal(zip.readAsText(DR_TRACK_RELATIVE_PATH), completeDrTrack);
    const recovery = JSON.parse(zip.readAsText("system/recovery-status.json"));
    assert.equal(recovery.ok, true);
    assert.match(recovery.note, /recovered the complete canonical records/i);
  } finally {
    plugin.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("startup resumes ZIP finalisation from a current Capture completion checkpoint", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-checkpoint-recovery-"));
  const voyageDirectory = path.join(root, "voyages");
  const voyageId = "voyage-20260807T190000Z";
  const workingDirectory = path.join(voyageDirectory, voyageId);
  const completedAt = "2026-08-07T19:05:00.000Z";
  const output = '{"delta":{"updates":[]}}\n';
  await fs.mkdir(path.join(workingDirectory, "recomputed"), { recursive: true });
  await fs.mkdir(path.join(workingDirectory, "system"), { recursive: true });
  await fs.writeFile(
    path.join(workingDirectory, RECOMPUTED_OUTPUT_RELATIVE_PATH),
    output,
  );
  const replayResult = {
    contract: REPLAY_CONTRACT,
    schemaVersion: 1,
    timing: { valid: true, effectiveRate: 1 },
    coverage: {
      complete: true,
      preparedComplete: true,
      lastReason: "end of canonical input",
    },
    output: {
      contract: "ajrm-marine-recomputed-output-v1",
      fileName: RECOMPUTED_OUTPUT_RELATIVE_PATH,
      complete: true,
      records: 1,
      bytes: Buffer.byteLength(output),
    },
  };
  const recomputedReplay = {
    schemaVersion: 2,
    kind: "recomputed-replay",
    timingRequired: true,
    complete: true,
    verified: true,
    completedAt,
    result: replayResult,
  };
  await fs.writeFile(
    path.join(workingDirectory, "index.json"),
    JSON.stringify({
      id: voyageId,
      version: "0.7.15",
      startedAt: "2026-08-07T19:00:00.000Z",
      stoppedAt: completedAt,
      startReason: "recomputed replay",
      stopReason: "verified replay EOF",
      captureMode: "minimal",
      recomputedReplay,
      recomputedOutput: replayResult.output,
      incomplete: false,
      recomputationVerified: true,
    }),
  );
  await fs.writeFile(
    path.join(workingDirectory, "system", "recomputed-replay-completion.json"),
    JSON.stringify({
      contract: "ajrm-marine-recomputed-completion",
      contractVersion: 1,
      voyageId,
      completedAt,
      completionConfirmed: true,
      verified: true,
      recomputationVerified: true,
      recomputedReplay,
      replayResult,
    }),
  );

  const app = fakeApp();
  const plugin = createPlugin(app);
  plugin.start({
    enabled: false,
    voyageDirectory,
    captureMode: "minimal",
    deleteWorkingDirectoryAfterZip: false,
  });

  try {
    const zipPath = path.join(voyageDirectory, `${voyageId}.zip`);
    await waitFor(async () => fs.stat(zipPath).then(() => true, () => false));
    const zip = new AdmZip(zipPath);
    const index = JSON.parse(zip.readAsText("index.json"));
    assert.equal(index.incomplete, false);
    assert.equal(index.recomputationVerified, true);
    assert.equal(index.recomputedReplay.verified, true);
    assert.equal(index.recomputedReplay.packagingRecoveredAfterRestart, true);
    assert.equal(zip.readAsText(RECOMPUTED_OUTPUT_RELATIVE_PATH), output);
  } finally {
    await plugin.stop();
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
