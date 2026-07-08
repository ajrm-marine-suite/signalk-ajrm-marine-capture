"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

test("Recorder buttons show immediate pending state while start or stop is running", () => {
  assert.match(appSource, /let pendingRecorderAction = null/);
  assert.match(appSource, /recorderCommand\("stop", "\/voyage\/stop"/);
  assert.match(appSource, /pendingRecorderAction === "stop" \? "Stopping\.\.\." : "Stop now"/);
  assert.match(appSource, /pendingRecorderAction === "start" \? "Starting\.\.\." : "Start now"/);
  assert.match(appSource, /const busy = pendingRecorderAction === "start" \|\| pendingRecorderAction === "stop"/);
  assert.match(appSource, /elements\.stopButton\.disabled = busy \|\| recorderActionLatch === "stop" \|\| activeVoyage === false/);
});

test("Recorder buttons stay latched until status confirms the voyage state changed", () => {
  assert.match(appSource, /let recorderActionLatch = null/);
  assert.match(appSource, /recorderActionLatch = ok \? action : null/);
  assert.match(appSource, /if \(recorderActionLatch === "start" && activeVoyage === true\) recorderActionLatch = null/);
  assert.match(appSource, /if \(recorderActionLatch === "stop" && activeVoyage === false\) recorderActionLatch = null/);
  assert.match(appSource, /elements\.startButton\.disabled = busy \|\| recorderActionLatch === "start" \|\| activeVoyage === true/);
});

test("Recorder command failures keep the error visible while clearing pending state", () => {
  assert.match(appSource, /elements\.banner\.classList\.add\("error"\)/);
  assert.match(appSource, /return false/);
  assert.match(appSource, /finally \{\s*pendingRecorderAction = null;\s*renderRecorderButtons\(latestStatus \|\| \{\}\);/s);
});
