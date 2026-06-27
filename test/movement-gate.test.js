const assert = require("node:assert/strict");
const test = require("node:test");
const createPlugin = require("../plugin");

const {
  cleanHarbourName,
  defaultVoyageComment,
  nextMovementGateState,
  normalizeTrafficProfile,
  resetMovementGateForVoyageStart,
} = createPlugin._private;

test("default voyage comment names the harbour and weekday", () => {
  assert.equal(
    defaultVoyageComment({
      startedAt: new Date("2026-06-27T10:00:00.000Z"),
      profile: "harbor",
      harbourName: "Harbour: Craobh Marina",
    }),
    "Departing Craobh Marina on Saturday",
  );
});

test("default voyage comment names anchorage when no harbour is known", () => {
  assert.equal(
    defaultVoyageComment({
      startedAt: new Date("2026-06-28T10:00:00.000Z"),
      profile: "anchor",
      harbourName: "",
    }),
    "Departing anchorage on Sunday",
  );
});

test("default voyage comment falls back to weekday only away from harbour and anchorage", () => {
  assert.equal(
    defaultVoyageComment({
      startedAt: new Date("2026-06-29T10:00:00.000Z"),
      profile: "coastal",
      harbourName: "",
    }),
    "Departing Monday",
  );
});

test("voyage comment helpers normalize harbour names and profiles", () => {
  assert.equal(cleanHarbourName("Harbor:  Oban   Bay "), "Oban Bay");
  assert.equal(normalizeTrafficProfile("Anchorage"), "anchor");
  assert.equal(normalizeTrafficProfile("Harbour"), "harbor");
});

test("manual stop inhibits automatic restart until a stationary sample is seen", () => {
  const movingWhileInhibited = nextMovementGateState({
    speedKnots: 1.7,
    movementSpeedKnots: 0.68,
    now: 1000,
    movingSinceMs: null,
    stoppedSinceMs: null,
    autoStartInhibited: true,
  });

  assert.equal(movingWhileInhibited.moving, true);
  assert.equal(movingWhileInhibited.movingSinceMs, null);
  assert.equal(movingWhileInhibited.stoppedSinceMs, null);
  assert.equal(movingWhileInhibited.autoStartInhibited, true);

  const stationary = nextMovementGateState({
    speedKnots: 0,
    movementSpeedKnots: 0.68,
    now: 2000,
    movingSinceMs: movingWhileInhibited.movingSinceMs,
    stoppedSinceMs: movingWhileInhibited.stoppedSinceMs,
    autoStartInhibited: movingWhileInhibited.autoStartInhibited,
  });

  assert.equal(stationary.moving, false);
  assert.equal(stationary.movingSinceMs, null);
  assert.equal(stationary.stoppedSinceMs, 2000);
  assert.equal(stationary.autoStartInhibited, false);

  const movingAgain = nextMovementGateState({
    speedKnots: 1.7,
    movementSpeedKnots: 0.68,
    now: 3000,
    movingSinceMs: stationary.movingSinceMs,
    stoppedSinceMs: stationary.stoppedSinceMs,
    autoStartInhibited: stationary.autoStartInhibited,
  });

  assert.equal(movingAgain.moving, true);
  assert.equal(movingAgain.movingSinceMs, 3000);
  assert.equal(movingAgain.stoppedSinceMs, null);
  assert.equal(movingAgain.autoStartInhibited, false);
});

test("logger playback suppression prevents movement autostart", () => {
  const suppressed = nextMovementGateState({
    speedKnots: 6,
    movementSpeedKnots: 0.68,
    now: 1000,
    movingSinceMs: null,
    stoppedSinceMs: null,
    autoStartInhibited: false,
    movementSuppressed: true,
  });

  assert.equal(suppressed.moving, false);
  assert.equal(suppressed.movingSinceMs, null);
  assert.equal(suppressed.stoppedSinceMs, 1000);
  assert.equal(suppressed.autoStartInhibited, false);
});

test("voyage start clears stale stopped timer from before the voyage", () => {
  const reset = resetMovementGateForVoyageStart({
    movingSinceMs: null,
    stoppedSinceMs: 1000,
    autoStartInhibited: true,
  });

  assert.equal(reset.movingSinceMs, null);
  assert.equal(reset.stoppedSinceMs, null);
  assert.equal(reset.autoStartInhibited, false);

  const firstStationarySampleAfterStart = nextMovementGateState({
    speedKnots: 0,
    movementSpeedKnots: 0.68,
    now: 61000,
    movingSinceMs: reset.movingSinceMs,
    stoppedSinceMs: reset.stoppedSinceMs,
    autoStartInhibited: reset.autoStartInhibited,
  });

  assert.equal(firstStationarySampleAfterStart.moving, false);
  assert.equal(firstStationarySampleAfterStart.movingSinceMs, null);
  assert.equal(firstStationarySampleAfterStart.stoppedSinceMs, 61000);
  assert.equal(firstStationarySampleAfterStart.autoStartInhibited, false);
});
