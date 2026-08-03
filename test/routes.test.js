"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const createPlugin = require("../plugin");

const { normalizeRouteTimeline, sanitizeRouteSelection } = createPlugin._private;

function selection(name = "Passage") {
  return {
    contract: "ajrm-marine-display-active-route-v1",
    resourceId: "5242d307-fbe8-4c65-9059-1f9df1ee126f",
    resource: {
      name,
      distance: 1000,
      feature: {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [[-5, 56], [-5.1, 56.1]],
        },
        properties: {
          coordinatesMeta: [{ name: "Start" }, { name: "Finish" }],
        },
      },
    },
    openedAt: "2026-08-03T10:00:00.000Z",
    changedAt: "2026-08-03T10:00:00.000Z",
    revision: 1,
    reversed: false,
    source: "browser-import",
  };
}

test("Capture accepts the explicit Display route-selection contract", () => {
  const normalized = sanitizeRouteSelection(selection());
  assert.equal(normalized.resource.name, "Passage");
  assert.notEqual(normalized, selection());
  assert.equal(sanitizeRouteSelection(null), null);
  assert.throws(
    () => sanitizeRouteSelection({ contract: "unknown", resource: {} }),
    /active-route contract/,
  );
});

test("route replay timeline retains opens and closes in source elapsed order", () => {
  const timeline = normalizeRouteTimeline([
    { at: "2026-08-03T10:02:00.000Z", voyageElapsedMs: 120000, selection: null },
    { at: "2026-08-03T10:01:00.000Z", voyageElapsedMs: 60000, selection: selection() },
  ]);
  assert.equal(timeline[0].voyageElapsedMs, 60000);
  assert.equal(timeline[0].action, "opened");
  assert.equal(timeline[1].action, "closed");
  assert.equal(timeline[1].selection, null);
});

test("route replay timeline omits the start snapshot already restored separately", () => {
  const route = selection();
  const timeline = normalizeRouteTimeline([
    { voyageElapsedMs: 0, action: "active-at-start", selection: route },
    { voyageElapsedMs: 5000, action: "reversed", selection: { ...route, reversed: true } },
  ]);
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].voyageElapsedMs, 5000);
  assert.equal(timeline[0].action, "reversed");
  assert.equal(timeline[0].selection.reversed, true);
});
