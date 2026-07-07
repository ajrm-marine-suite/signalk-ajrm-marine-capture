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
  assert.match(appSource, /elements\.stopButton\.disabled = pendingRecorderAction === "start" \|\| pendingRecorderAction === "stop"/);
});

test("Recorder command failures keep the error visible while clearing pending state", () => {
  assert.match(appSource, /elements\.banner\.classList\.add\("error"\)/);
  assert.match(appSource, /return false/);
  assert.match(appSource, /finally \{\s*pendingRecorderAction = null;\s*renderRecorderButtons\(latestStatus \|\| \{\}\);/s);
});
