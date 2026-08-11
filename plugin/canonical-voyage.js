/**
 * Implements the canonical voyage responsibilities of the AJRM Marine Voyages Signal K server.
 */

"use strict";

const fs = require("node:fs");
const readline = require("node:readline");
const { performance } = require("node:perf_hooks");

const INPUT_CONTRACT = "ajrm-marine-canonical-input-v1";
const REPLAY_CONTRACT = "ajrm-marine-monotonic-replay-v1";
const RECOMPUTED_OUTPUT_CONTRACT = "ajrm-marine-recomputed-output-v1";
const RECORDED_OUTPUT_PLAYBACK_CONTRACT =
  "ajrm-marine-recorded-output-playback-v1";
const INPUT_RELATIVE_PATH = "input/sensor-input.jsonl";
const LEGACY_INPUT_RELATIVE_PATH = "input/yden-input.jsonl";
const RECOMPUTED_OUTPUT_RELATIVE_PATH = "recomputed/output.jsonl";
const RECOMPUTED_OUTPUT_GZIP_RELATIVE_PATH = "recomputed/output.jsonl.gz";
const PHYSICAL_SOURCE_TYPES = new Set(["NMEA2000", "NMEA0183", "GPSD"]);

function sourceLabel(delta, update) {
  return String(
    update?.$source ||
      update?.source?.label ||
      delta?.$source ||
      delta?.source?.label ||
      "",
  ).trim();
}

function normalizeSourcePrefixes(value) {
  const prefixes = Array.isArray(value) ? value : [];
  const clean = prefixes
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  return [...new Set(clean)];
}

function sourceMatchesPrefix(source, prefixes) {
  return prefixes.some(
    (prefix) => source === prefix || source.startsWith(`${prefix}.`),
  );
}

function sourceDetails(delta, update) {
  const source = update?.source && typeof update.source === "object"
    ? update.source
    : delta?.source && typeof delta.source === "object"
      ? delta.source
      : null;
  return {
    label: sourceLabel(delta, update),
    type: String(source?.type || "").trim().toUpperCase(),
  };
}

function extractCanonicalInputDelta(
  delta,
  sourcePrefixes = [],
  knownPhysicalSources = new Set(),
) {
  if (!delta || typeof delta !== "object") return null;
  const prefixes = normalizeSourcePrefixes(sourcePrefixes);
  const updates = [];
  for (const update of Array.isArray(delta.updates) ? delta.updates : []) {
    const source = sourceDetails(delta, update);
    if (!source.label) continue;
    const structuredPhysicalSource = PHYSICAL_SOURCE_TYPES.has(source.type);
    if (structuredPhysicalSource) knownPhysicalSources.add(source.label);
    const explicitlyAllowed = sourceMatchesPrefix(source.label, prefixes);
    if (
      !structuredPhysicalSource &&
      !knownPhysicalSources.has(source.label) &&
      !explicitlyAllowed
    ) continue;
    const values = Array.isArray(update.values)
      ? update.values.filter(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            typeof entry.path === "string" &&
            entry.path.length > 0,
        )
      : [];
    if (!values.length) continue;
    updates.push({
      ...structuredClone(update),
      $source: source.label,
      values: structuredClone(values),
    });
  }
  if (!updates.length) return null;
  return {
    context: delta.context || "vessels.self",
    updates,
  };
}

function canonicalInputRecord({
  delta,
  elapsedMs,
  capturedAt = new Date().toISOString(),
}) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new Error("Canonical input elapsedMs must be a non-negative number");
  }
  if (!delta || !Array.isArray(delta.updates) || !delta.updates.length) {
    throw new Error("Canonical input record requires at least one update");
  }
  return {
    contract: INPUT_CONTRACT,
    schemaVersion: 1,
    elapsedMs: Math.round(elapsedMs),
    capturedAt,
    delta,
  };
}

function refreshReplayDelta(record, emittedAt = new Date().toISOString()) {
  if (record?.contract !== INPUT_CONTRACT) {
    throw new Error(`Unsupported voyage input contract: ${record?.contract || "missing"}`);
  }
  const delta = structuredClone(record.delta);
  delta.updates = (delta.updates || []).map((update) => ({
    ...update,
    timestamp: emittedAt,
    values: (update.values || []).map((entry) =>
      entry.path === "navigation.datetime"
        ? { ...entry, value: emittedAt }
        : entry,
    ),
  }));
  return delta;
}

function refreshRecordedOutputDelta(record, emittedAt = new Date().toISOString()) {
  if (record?.contract !== RECOMPUTED_OUTPUT_CONTRACT) {
    throw new Error(
      `Unsupported recorded output contract: ${record?.contract || "missing"}`,
    );
  }
  const delta = structuredClone(record.delta);
  delta.updates = (delta.updates || []).map((update) => ({
    ...update,
    timestamp: emittedAt,
  }));
  return delta;
}

async function inspectCanonicalInput(filePath) {
  return inspectReplayFile(filePath, {
    contract: INPUT_CONTRACT,
    emptyMessage: "Voyage contains no canonical physical sensor input records",
  });
}

async function inspectRecordedOutput(filePath) {
  return inspectReplayFile(filePath, {
    contract: RECOMPUTED_OUTPUT_CONTRACT,
    emptyMessage: "Voyage contains no recorded result records",
  });
}

async function inspectReplayFile(filePath, { contract, emptyMessage }) {
  let records = 0;
  let firstElapsedMs = null;
  let lastElapsedMs = null;
  let previousElapsedMs = null;
  await forEachJsonLine(filePath, (record, lineNumber) => {
    validateReplayRecord(record, lineNumber, previousElapsedMs, contract);
    const elapsedMs = Number(record.elapsedMs);
    if (firstElapsedMs === null) firstElapsedMs = elapsedMs;
    lastElapsedMs = elapsedMs;
    previousElapsedMs = elapsedMs;
    records += 1;
  });
  if (!records) throw new Error(emptyMessage);
  return {
    contract,
    records,
    firstElapsedMs,
    lastElapsedMs,
    durationMs: Math.max(0, lastElapsedMs - firstElapsedMs),
  };
}

function createReplayController({
  filePath,
  emitDelta,
  maximumLagMs = 10_000,
  minimumEffectiveRatio = 0.9,
  monotonicNowMs = () => performance.now(),
  wallClockIso = () => new Date().toISOString(),
  wait = defaultWait,
  onStatus = () => {},
  startAtMs = 0,
  preparedInput = null,
  onPrepared = () => {},
}) {
  return createTimedReplayController({
    filePath,
    emitDelta,
    maximumLagMs,
    minimumEffectiveRatio,
    monotonicNowMs,
    wallClockIso,
    wait,
    onStatus,
    startAtMs,
    preparedInput,
    onPrepared,
    inputContract: INPUT_CONTRACT,
    replayContract: REPLAY_CONTRACT,
    inspect: inspectCanonicalInput,
    refreshDelta: refreshReplayDelta,
  });
}

function createRecordedOutputReplayController(options) {
  return createTimedReplayController({
    ...options,
    inputContract: RECOMPUTED_OUTPUT_CONTRACT,
    replayContract: RECORDED_OUTPUT_PLAYBACK_CONTRACT,
    inspect: inspectRecordedOutput,
    refreshDelta: refreshRecordedOutputDelta,
  });
}

function createTimedReplayController({
  filePath,
  emitDelta,
  maximumLagMs = 10_000,
  minimumEffectiveRatio = 0.9,
  monotonicNowMs = () => performance.now(),
  wallClockIso = () => new Date().toISOString(),
  wait = defaultWait,
  onStatus = () => {},
  inputContract,
  replayContract,
  inspect,
  refreshDelta,
  startAtMs = 0,
  preparedInput = null,
  onPrepared = () => {},
}) {
  if (typeof emitDelta !== "function") {
    throw new Error("Replay controller requires emitDelta");
  }
  let cancelled = false;
  let cancelReason = null;
  let activeWait = null;
  let paused = false;
  let pauseStartedMs = null;
  let totalPausedMs = 0;
  let resumeWait = null;
  const status = {
    contract: replayContract,
    inputContract,
    state: "preparing",
    active: false,
    playing: false,
    paused: false,
    complete: false,
    valid: null,
    requestedRate: 1,
    filePath,
    recordsTotal: 0,
    recordsReplayed: 0,
    sourceDurationMs: 0,
    sourceElapsedMs: 0,
    wallElapsedMs: 0,
    effectiveRate: null,
    effectiveRatio: null,
    minimumEffectiveRatio,
    maximumLagMs,
    maximumObservedLagMs: 0,
    startedAt: null,
    completedAt: null,
    lastEmittedAt: null,
    error: null,
  };

  function publish(changes = {}) {
    Object.assign(status, changes);
    onStatus({ ...status });
  }

  async function run() {
    try {
      const input = preparedInput || await inspect(filePath);
      onPrepared({ ...input });
      publish({
        state: "ready",
        recordsTotal: input.records,
        sourceDurationMs: input.durationMs,
      });
      if (cancelled) throw cancelledError(cancelReason);

      const startedAt = wallClockIso();
      const requestedStartMs = Math.min(
        input.durationMs,
        Math.max(0, Number(startAtMs) || 0),
      );
      let startedPacingMs = requestedStartMs > 0 ? null : monotonicNowMs();
      let pacingSourceStartMs = requestedStartMs;
      let previousElapsedMs = null;
      publish({
        state: requestedStartMs > 0 ? "seeking" : "replaying",
        active: requestedStartMs === 0,
        playing: requestedStartMs === 0,
        paused: false,
        startedAt,
        sourceElapsedMs: requestedStartMs,
      });

      await forEachJsonLine(filePath, async (record, lineNumber) => {
        if (cancelled) throw cancelledError(cancelReason);
        await waitWhilePaused();
        validateReplayRecord(record, lineNumber, previousElapsedMs, inputContract);
        previousElapsedMs = Number(record.elapsedMs);
        const sourceElapsedMs =
          Number(record.elapsedMs) - Number(input.firstElapsedMs);
        if (sourceElapsedMs < requestedStartMs) {
          status.recordsReplayed += 1;
          return;
        }
        if (startedPacingMs === null) {
          startedPacingMs = monotonicNowMs();
          pacingSourceStartMs = sourceElapsedMs;
          publish({
            state: "replaying",
            active: true,
            playing: true,
            recordsReplayed: status.recordsReplayed,
            sourceElapsedMs,
          });
        }
        let deadlineMs =
          startedPacingMs + totalPausedMs + sourceElapsedMs - pacingSourceStartMs;
        let lagMs = monotonicNowMs() - deadlineMs;
        while (lagMs < 0) {
          activeWait = wait(-lagMs);
          await activeWait;
          activeWait = null;
          if (cancelled) throw cancelledError(cancelReason);
          await waitWhilePaused();
          deadlineMs =
            startedPacingMs + totalPausedMs + sourceElapsedMs - pacingSourceStartMs;
          lagMs = monotonicNowMs() - deadlineMs;
        }
        status.maximumObservedLagMs = Math.max(
          status.maximumObservedLagMs,
          Math.max(0, lagMs),
        );
        if (lagMs > maximumLagMs) {
          throw new Error(
            `Replay fell ${Math.round(lagMs)} ms behind its monotonic schedule`,
          );
        }
        const emittedAt = wallClockIso();
        await emitDelta(refreshDelta(record, emittedAt), record);
        const wallElapsedMs = activeWallElapsedMs(startedPacingMs);
        const effectiveRate =
          wallElapsedMs > 0
            ? Math.max(0, sourceElapsedMs - pacingSourceStartMs) / wallElapsedMs
            : 1;
        publish({
          recordsReplayed: status.recordsReplayed + 1,
          sourceElapsedMs,
          wallElapsedMs: Math.round(wallElapsedMs),
          effectiveRate: round4(effectiveRate),
          effectiveRatio: round4(effectiveRate),
          lastEmittedAt: emittedAt,
        });
      });

      const completedPacingMs = monotonicNowMs();
      if (startedPacingMs === null) startedPacingMs = completedPacingMs;
      const wallElapsedMs = Math.max(
        0,
        completedPacingMs - startedPacingMs - totalPausedMs,
      );
      const effectiveRate =
        wallElapsedMs > 0
          ? Math.max(0, input.durationMs - pacingSourceStartMs) / wallElapsedMs
          : 1;
      const valid = effectiveRate >= minimumEffectiveRatio;
      publish({
        state: valid ? "complete" : "failed",
        active: false,
        playing: false,
        paused: false,
        complete: true,
        valid,
        wallElapsedMs: Math.round(wallElapsedMs),
        sourceElapsedMs: input.durationMs,
        effectiveRate: round4(effectiveRate),
        effectiveRatio: round4(effectiveRate),
        completedAt: wallClockIso(),
        error: valid
          ? null
          : `Effective replay ratio ${round4(effectiveRate)} is below ${minimumEffectiveRatio}`,
      });
      return { ...status };
    } catch (error) {
      const wasCancelled = error?.code === "AJRM_REPLAY_CANCELLED";
      publish({
        state: wasCancelled ? "aborted" : "failed",
        active: false,
        playing: false,
        paused: false,
        complete: false,
        valid: false,
        completedAt: wallClockIso(),
        error: error.message,
      });
      if (!wasCancelled) throw error;
      return { ...status };
    }
  }

  function cancel(reason = "Replay interrupted") {
    cancelled = true;
    cancelReason = String(reason || "Replay interrupted");
    if (activeWait && typeof activeWait.cancel === "function") {
      activeWait.cancel();
    }
    resumeWait?.();
    resumeWait = null;
  }

  function pause() {
    if (cancelled || !status.active || paused) return { ...status };
    paused = true;
    pauseStartedMs = monotonicNowMs();
    if (activeWait && typeof activeWait.cancel === "function") activeWait.cancel();
    publish({ state: "paused", paused: true, playing: false });
    return { ...status };
  }

  function resume() {
    if (cancelled || !status.active || !paused) return { ...status };
    const now = monotonicNowMs();
    totalPausedMs += Math.max(0, now - pauseStartedMs);
    pauseStartedMs = null;
    paused = false;
    publish({ state: "replaying", paused: false, playing: true });
    resumeWait?.();
    resumeWait = null;
    return { ...status };
  }

  async function waitWhilePaused() {
    while (paused && !cancelled) {
      await new Promise((resolve) => {
        resumeWait = resolve;
      });
    }
    if (cancelled) throw cancelledError(cancelReason);
  }

  function activeWallElapsedMs(startedPacingMs) {
    const currentPauseMs = paused && pauseStartedMs !== null
      ? Math.max(0, monotonicNowMs() - pauseStartedMs)
      : 0;
    return Math.max(
      0,
      monotonicNowMs() - startedPacingMs - totalPausedMs - currentPauseMs,
    );
  }

  return {
    run,
    cancel,
    pause,
    resume,
    status() {
      return { ...status };
    },
  };
}

function validateReplayRecord(record, lineNumber, previousElapsedMs, contract) {
  if (record?.contract !== contract) {
    throw new Error(
      `Unsupported input contract on line ${lineNumber}: ${record?.contract || "missing"}`,
    );
  }
  const elapsedMs = Number(record.elapsedMs);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new Error(`Invalid elapsedMs on line ${lineNumber}`);
  }
  if (
    Number.isFinite(previousElapsedMs) &&
    elapsedMs < Number(previousElapsedMs)
  ) {
    throw new Error(`Backwards elapsedMs on line ${lineNumber}`);
  }
  if (!record.delta || !Array.isArray(record.delta.updates)) {
    throw new Error(`Missing delta updates on line ${lineNumber}`);
  }
}

async function forEachJsonLine(filePath, visitor) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch (_error) {
        throw new Error(`Invalid JSON on line ${lineNumber}`);
      }
      await visitor(record, lineNumber);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

function defaultWait(milliseconds) {
  let timer = null;
  let resolveWait;
  const promise = new Promise((resolve) => {
    resolveWait = resolve;
    timer = setTimeout(resolve, Math.max(0, milliseconds));
  });
  promise.cancel = () => {
    clearTimeout(timer);
    resolveWait();
  };
  return promise;
}

function cancelledError(reason) {
  const error = new Error(reason || "Replay interrupted");
  error.code = "AJRM_REPLAY_CANCELLED";
  return error;
}

function round4(value) {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : null;
}

module.exports = {
  INPUT_CONTRACT,
  INPUT_RELATIVE_PATH,
  LEGACY_INPUT_RELATIVE_PATH,
  PHYSICAL_SOURCE_TYPES,
  RECOMPUTED_OUTPUT_RELATIVE_PATH,
  RECOMPUTED_OUTPUT_GZIP_RELATIVE_PATH,
  RECOMPUTED_OUTPUT_CONTRACT,
  RECORDED_OUTPUT_PLAYBACK_CONTRACT,
  REPLAY_CONTRACT,
  canonicalInputRecord,
  createReplayController,
  createRecordedOutputReplayController,
  extractCanonicalInputDelta,
  inspectCanonicalInput,
  inspectRecordedOutput,
  normalizeSourcePrefixes,
  refreshReplayDelta,
  refreshRecordedOutputDelta,
  sourceLabel,
  sourceDetails,
};
