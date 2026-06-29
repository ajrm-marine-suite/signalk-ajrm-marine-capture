"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { _private } = require("../plugin");

test("filters DR Plotter fixes to the voyage time window", () => {
  const fixes = _private.filterDrPlotFixesForVoyage([
    {
      id: "before",
      timestamp: "2026-06-29T09:59:59.000Z",
      position: { latitude: 56.1, longitude: -5.1 },
      plotType: "timed",
    },
    {
      id: "lost",
      timestamp: "2026-06-29T10:00:00.000Z",
      position: { latitude: "56.2", longitude: "-5.2" },
      automatic: true,
      plotType: "gps-lost",
      trust: "lost",
      drSource: "heading-stw-current",
      distanceFromLastTrustedFixMeters: "42",
    },
    {
      id: "manual",
      timestamp: "2026-06-29T10:05:00.000Z",
      position: { latitude: 56.3, longitude: -5.3 },
      plotType: "manual",
    },
    {
      id: "after",
      timestamp: "2026-06-29T10:10:01.000Z",
      position: { latitude: 56.4, longitude: -5.4 },
    },
    {
      id: "invalid",
      timestamp: "not a date",
      position: { latitude: 56.5, longitude: -5.5 },
    },
  ], "2026-06-29T10:00:00.000Z", "2026-06-29T10:10:00.000Z");

  assert.deepEqual(fixes.map((fix) => fix.id), ["lost", "manual"]);
  assert.equal(fixes[0].plotType, "gps-lost");
  assert.equal(fixes[0].position.latitude, 56.2);
  assert.equal(fixes[0].distanceFromLastTrustedFixMeters, 42);
  assert.equal(fixes[1].plotType, "manual");
});

test("normalizes DR Plotter fixes without a voyage filter", () => {
  const fixes = _private.normalizeDrPlotFixes([
    {
      timestamp: "2026-06-29T10:05:00.000Z",
      position: { latitude: 56.3, longitude: -5.3 },
    },
    {
      timestamp: "2026-06-29T10:00:00.000Z",
      position: { latitude: 56.2, longitude: -5.2 },
    },
  ]);

  assert.equal(fixes.length, 2);
  assert.equal(fixes[0].timestamp, "2026-06-29T10:00:00.000Z");
  assert.equal(fixes[1].timestamp, "2026-06-29T10:05:00.000Z");
});
