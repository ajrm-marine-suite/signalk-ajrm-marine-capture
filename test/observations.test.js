"use strict";

const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const AdmZip = require("adm-zip");
const createPlugin = require("../plugin");

test("active-voyage observations retain timestamps and optional Snapshot evidence in the ZIP", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ajrm-capture-observations-"),
  );
  const voyageDirectory = path.join(root, "voyages");
  const loggerDirectory = path.join(root, "logger");
  const startedAt = new Date().toISOString();
  let snapshotFailure = false;
  const app = fakeApp({
    loggerApi: {
      async status() {
        return { ok: true, playback: { loaded: false }, captures: [] };
      },
      paths() {
        return { captures: path.join(loggerDirectory, "captures") };
      },
      async startCapture() {
        return {
          active: true,
          fileName: "capture-test.jsonl",
          startedAt,
          from: startedAt,
        };
      },
      async stopCapture() {
        return {
          active: false,
          fileName: "capture-test.jsonl",
          startedAt,
          from: startedAt,
          to: new Date().toISOString(),
        };
      },
    },
    snapshotApi: {
      async snapshot(options) {
        assert.equal(options.snapshotPreset, "debug");
        if (snapshotFailure) throw new Error("Snapshot deliberately unavailable");
        return {
          timestamp: new Date().toISOString(),
          self: {
            position: { latitude: 55.8, longitude: -5.7 },
          },
        };
      },
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
    const beforeStart = await invoke(
      routes,
      "POST",
      "/voyage/observations",
      { text: "No voyage yet" },
    );
    assert.equal(beforeStart.statusCode, 400);
    assert.match(beforeStart.body.error, /start a voyage/i);

    const started = await invoke(routes, "POST", "/voyage/start", {
      comment: "Observation API test",
    });
    assert.equal(started.statusCode, 200);

    const registryApi =
      globalThis[Symbol.for("mcdonaldajr.ajrmMarineCaptureApi")];
    assert.equal(typeof registryApi.appendObservation, "function");
    assert.equal(typeof registryApi.observations, "function");
    const captureStatus = await registryApi.status();
    assert.equal(captureStatus.observationCapabilities.available, true);
    assert.equal(
      captureStatus.observationCapabilities.snapshotAvailable,
      true,
    );
    assert.equal(captureStatus.currentVoyage.id, started.body.voyage.id);

    const first = await invoke(
      routes,
      "POST",
      "/voyage/observations",
      {
        text: "Turn indicator remained after the target sent null ROT.",
        includeSnapshot: true,
        source: "ajrm-marine-display",
      },
    );
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.observation.source, "ajrm-marine-display");
    assert.equal(first.body.observation.evidence.requested, true);
    assert.equal(first.body.observation.evidence.captured, true);
    assert.equal(first.body.observation.evidenceError, null);
    assert.equal(first.body.observation.replayOriginalAt, null);
    assert.ok(first.body.observation.recordedAt);
    assert.ok(first.body.observation.voyageElapsedSeconds >= 0);

    snapshotFailure = true;
    const second = await registryApi.appendObservation({
      text: "Depth call-out still visible.",
      includeSnapshot: true,
      source: "ajrm-marine-display",
    });
    assert.equal(second.evidence.requested, true);
    assert.equal(second.evidence.captured, false);
    assert.match(second.evidenceError, /deliberately unavailable/i);

    const oversized = await invoke(
      routes,
      "POST",
      "/voyage/observations",
      { text: "x".repeat(2001) },
    );
    assert.equal(oversized.statusCode, 400);
    assert.match(oversized.body.error, /2000 characters or fewer/i);

    const listed = await invoke(
      routes,
      "GET",
      "/voyage/observations",
      null,
      { limit: "10" },
    );
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.body.active, true);
    assert.equal(listed.body.observationLog.count, 2);
    assert.equal(listed.body.observationLog.evidenceCount, 1);
    assert.equal(listed.body.observationLog.evidenceErrorCount, 1);
    assert.equal(listed.body.observations.length, 2);
    assert.equal(listed.body.observations[0].text, second.text);

    const activeDirectory = path.join(
      voyageDirectory,
      started.body.voyage.id,
    );
    const indexPath = path.join(activeDirectory, "index.json");
    await fs.rm(indexPath);
    await fs.mkdir(indexPath);
    const committedWithWarning = await registryApi.appendObservation({
      text: "The note must remain successful after an index refresh failure.",
      includeSnapshot: false,
      source: "ajrm-marine-display",
    });
    assert.match(committedWithWarning.postCommitWarning, /index\.json/);
    const committedLines = (await fs.readFile(
      path.join(activeDirectory, "observations", "observations.jsonl"),
      "utf8",
    ))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(committedLines.length, 3);
    assert.equal(
      committedLines.at(-1).text,
      "The note must remain successful after an index refresh failure.",
    );
    await fs.rm(indexPath, { recursive: true });

    const stopped = await invoke(routes, "POST", "/voyage/stop", {});
    assert.equal(stopped.statusCode, 200);
    const zip = new AdmZip(stopped.body.bundle.path);
    const index = JSON.parse(zip.readAsText("index.json"));
    assert.equal(index.ownContext, "vessels.urn:mrn:imo:mmsi:235008635");
    assert.equal(index.observations.count, 3);
    assert.equal(index.observations.evidenceCount, 1);
    assert.equal(index.observations.evidenceErrorCount, 1);
    const observationLines = zip
      .readAsText("observations/observations.jsonl")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(observationLines.length, 3);
    assert.equal(observationLines[1].evidenceError, second.evidenceError);
    assert.ok(
      zip.getEntry(observationLines[0].evidence.fileName),
      "Snapshot evidence referenced by the first observation must be portable",
    );
  } finally {
    plugin.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

function fakeApp({ loggerApi, snapshotApi }) {
  return {
    signalk: new EventEmitter(),
    ajrmMarineLoggerApi: loggerApi,
    ajrmMarineSnapshotApi: snapshotApi,
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

async function invoke(routes, method, route, body, query = {}) {
  let statusCode = 200;
  let payload;
  const handler = routes.get(`${method} ${route}`);
  assert.ok(handler, `expected route ${method} ${route}`);
  await handler(
    { body, query },
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
