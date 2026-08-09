"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  INPUT_CONTRACT,
  RECOMPUTED_OUTPUT_CONTRACT,
  RECORDED_OUTPUT_PLAYBACK_CONTRACT,
  canonicalInputRecord,
  createRecordedOutputReplayController,
  createReplayController,
  extractCanonicalInputDelta,
  inspectCanonicalInput,
  refreshReplayDelta,
  refreshRecordedOutputDelta,
} = require("../plugin/canonical-voyage");

test("canonical input accepts a physical NMEA source and excludes derived updates", () => {
  const input = extractCanonicalInputDelta({
    context: "vessels.self",
    updates: [
      {
        $source: "n2k-gateway.2",
        source: { label: "n2k-gateway", type: "NMEA2000", pgn: 129025, src: "2" },
        timestamp: "2026-07-17T12:00:00.000Z",
        values: [{ path: "navigation.position", value: { latitude: 55, longitude: -5 } }],
      },
      {
        $source: "courseApi",
        timestamp: "2026-07-17T12:00:00.000Z",
        values: [{ path: "navigation.course.nextPoint", value: { name: "DP" } }],
      },
      {
        timestamp: "2026-07-17T12:00:00.000Z",
        values: [{ path: "navigation.course.nextPoint", value: { name: "retained" } }],
      },
    ],
  });
  assert.deepEqual(input.updates.map((update) => update.$source), ["n2k-gateway.2"]);
  assert.equal(input.updates[0].values[0].path, "navigation.position");
});

test("canonical input remembers a physical source when later metadata is sparse", () => {
  const knownPhysicalSources = new Set();
  const first = extractCanonicalInputDelta({
    updates: [{
      $source: "can-interface.17",
      source: { label: "can-interface", type: "NMEA2000", pgn: 129026, src: "17" },
      values: [{ path: "navigation.speedOverGround", value: 2 }],
    }],
  }, [], knownPhysicalSources);
  const retained = extractCanonicalInputDelta({
    updates: [{
      $source: "can-interface.17",
      values: [{ path: "navigation.courseOverGroundTrue", value: 1 }],
    }],
  }, [], knownPhysicalSources);
  assert.equal(first.updates.length, 1);
  assert.equal(retained.updates.length, 1);
  assert.equal(knownPhysicalSources.has("can-interface.17"), true);
});

test("optional prefixes add non-standard physical sources without admitting plugins", () => {
  const input = extractCanonicalInputDelta({
    updates: [
      {
        $source: "serial-gateway.port-a",
        values: [{ path: "navigation.position", value: { latitude: 55, longitude: -5 } }],
      },
      {
        $source: "courseApi",
        values: [{ path: "navigation.course.nextPoint", value: { name: "DP" } }],
      },
    ],
  }, ["serial-gateway"]);
  assert.deepEqual(input.updates.map((update) => update.$source), ["serial-gateway.port-a"]);
});

test("replay refreshes update and navigation datetime timestamps", () => {
  const record = canonicalInputRecord({
    elapsedMs: 12,
    capturedAt: "2026-07-17T12:00:00.000Z",
    delta: {
      context: "vessels.self",
      updates: [{
        $source: "YDEN.2",
        timestamp: "2026-07-17T12:00:00.000Z",
        values: [{ path: "navigation.datetime", value: "2026-07-17T12:00:00.000Z" }],
      }],
    },
  });
  const replayed = refreshReplayDelta(record, "2026-08-01T09:00:00.000Z");
  assert.equal(replayed.updates[0].timestamp, "2026-08-01T09:00:00.000Z");
  assert.equal(replayed.updates[0].values[0].value, "2026-08-01T09:00:00.000Z");
});

test("recorded-result playback preserves values while refreshing transport timestamps", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-recorded-output-"));
  const file = path.join(root, "output.jsonl");
  const recordedDatetime = "2026-07-17T12:00:00.000Z";
  const records = [0, 100].map((elapsedMs) => ({
    contract: RECOMPUTED_OUTPUT_CONTRACT,
    elapsedMs,
    delta: {
      context: "vessels.self",
      updates: [{
        $source: "signalk-ajrm-marine-traffic",
        timestamp: recordedDatetime,
        values: [
          { path: "navigation.datetime", value: recordedDatetime },
          { path: "plugins.ajrmMarineTraffic.voyageState", value: { profile: "coastal" } },
        ],
      }],
    },
  }));
  await fs.writeFile(file, `${records.map(JSON.stringify).join("\n")}\n`);
  let now = 1000;
  const emitted = [];
  const replay = createRecordedOutputReplayController({
    filePath: file,
    monotonicNowMs: () => now,
    wallClockIso: () => new Date(now).toISOString(),
    wait: (milliseconds) => { now += milliseconds; return Promise.resolve(); },
    emitDelta: (delta) => emitted.push(delta),
  });
  const result = await replay.run();
  assert.equal(result.contract, RECORDED_OUTPUT_PLAYBACK_CONTRACT);
  assert.equal(result.inputContract, RECOMPUTED_OUTPUT_CONTRACT);
  assert.equal(result.recordsReplayed, 2);
  assert.equal(result.valid, true);
  assert.equal(emitted[0].updates[0].timestamp, new Date(1000).toISOString());
  assert.equal(emitted[0].updates[0].values[0].value, recordedDatetime);
  assert.deepEqual(
    emitted[0].updates[0].values[1].value,
    { profile: "coastal" },
  );
  assert.deepEqual(
    refreshRecordedOutputDelta(records[0], "2026-08-09T12:00:00.000Z")
      .updates[0].values,
    records[0].delta.updates[0].values,
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("canonical input inspection rejects backwards elapsed time", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-canonical-input-"));
  const file = path.join(root, "input.jsonl");
  await fs.writeFile(file, [
    JSON.stringify({
      contract: INPUT_CONTRACT,
      elapsedMs: 10,
      delta: { updates: [] },
    }),
    JSON.stringify({
      contract: INPUT_CONTRACT,
      elapsedMs: 5,
      delta: { updates: [] },
    }),
  ].join("\n"));
  await assert.rejects(inspectCanonicalInput(file), /Backwards elapsedMs/);
  await fs.rm(root, { recursive: true, force: true });
});

test("fixed 1x replay uses one monotonic anchor and reports valid timing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-canonical-replay-"));
  const file = path.join(root, "input.jsonl");
  const records = [0, 100, 250].map((elapsedMs) => canonicalInputRecord({
    elapsedMs,
    delta: {
      context: "vessels.self",
      updates: [{
        $source: "YDEN.2",
        timestamp: "2026-07-17T12:00:00.000Z",
        values: [{ path: "navigation.speedOverGround", value: elapsedMs }],
      }],
    },
  }));
  await fs.writeFile(file, `${records.map(JSON.stringify).join("\n")}\n`);

  let now = 1000;
  const emitted = [];
  const replay = createReplayController({
    filePath: file,
    monotonicNowMs: () => now,
    wallClockIso: () => new Date(now).toISOString(),
    wait: (milliseconds) => {
      now += milliseconds;
      return Promise.resolve();
    },
    emitDelta(delta) {
      emitted.push(delta);
    },
  });
  const result = await replay.run();
  assert.equal(emitted.length, 3);
  assert.equal(result.state, "complete");
  assert.equal(result.valid, true);
  assert.equal(result.sourceDurationMs, 250);
  assert.equal(result.wallElapsedMs, 250);
  assert.equal(result.effectiveRatio, 1);
  await fs.rm(root, { recursive: true, force: true });
});

test("replay fails rather than rebasing after excessive scheduler lag", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-canonical-lag-"));
  const file = path.join(root, "input.jsonl");
  await fs.writeFile(file, `${JSON.stringify(canonicalInputRecord({
    elapsedMs: 0,
    delta: {
      updates: [{
        $source: "YDEN.2",
        values: [{ path: "navigation.speedOverGround", value: 1 }],
      }],
    },
  }))}\n`);
  let now = 20_000;
  const replay = createReplayController({
    filePath: file,
    maximumLagMs: 1000,
    monotonicNowMs: () => {
      const value = now;
      now += 20_000;
      return value;
    },
    emitDelta() {},
  });
  await assert.rejects(replay.run(), /fell .* behind/);
  assert.equal(replay.status().state, "failed");
  assert.equal(replay.status().valid, false);
  await fs.rm(root, { recursive: true, force: true });
});
