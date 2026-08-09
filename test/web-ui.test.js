"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

test("Recorder buttons show immediate pending state while start or stop is running", () => {
  assert.match(appSource, /let pendingRecorderAction = null/);
  assert.match(appSource, /recorderCommand\("stop", "\/voyage\/stop"/);
  assert.match(appSource, /pendingRecorderAction === "stop" \? "Stopping\.\.\." : "Stop now"/);
  assert.match(appSource, /pendingRecorderAction === "start" \? "Starting\.\.\." : "Start now"/);
  assert.match(appSource, /const busy = pendingRecorderAction === "start" \|\| pendingRecorderAction === "stop"/);
  assert.match(
    appSource,
    /elements\.stopButton\.disabled =\s*busy \|\|\s*recorderActionLatch === "stop" \|\|\s*activeVoyage === false \|\|\s*recomputedActive/s,
  );
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

test("UI distinguishes algorithmic voyage reprocessing from saved-result replay", () => {
  assert.match(htmlSource, /id="startReplayCaptureButton"/);
  assert.match(htmlSource, /id="playAsRecordedButton"/);
  assert.match(htmlSource, /id="stopAsRecordedButton"/);
  assert.match(htmlSource, /id="stopReplayCaptureButton"/);
  assert.match(htmlSource, /id="interruptReplayCaptureButton"/);
  assert.match(htmlSource, />Interrupt replay<\/button>/);
  assert.match(htmlSource, /Reprocess voyage with current algorithms/);
  assert.match(htmlSource, /runs the recorded sensor inputs through the currently installed/);
  assert.match(htmlSource, /Replay saved voyage/);
  assert.match(htmlSource, /without recalculating or recording it/);
  assert.match(appSource, /"\/voyage\/replay\/start"/);
  assert.match(appSource, /"\/voyage\/playback\/start"/);
  assert.match(appSource, /"\/voyage\/playback\/stop"/);
  assert.match(appSource, /"\/voyage\/replay\/stop"/);
  assert.match(appSource, /"\/voyage\/replay\/abort"/);
  assert.match(appSource, /selectedBundle\?\.canonicalInput\?\.contract === status\.canonicalInputContract/);
  assert.match(
    appSource,
    /selectedBundle\?\.recomputedOutput\?\.contract === status\.recomputedOutputContract/,
  );
  assert.match(appSource, /playback\.state === "complete"/);
  assert.match(appSource, /playback\.valid === true/);
  assert.match(
    appSource,
    /status\.currentVoyage && status\.currentVoyage\.recomputedReplay/,
  );
  assert.match(appSource, /playback\.recordsReplayed/);
  assert.match(appSource, /Single monotonic stream/);
  assert.match(appSource, /Complete · Capture streams closed/);
  assert.match(appSource, /Building ZIP · \$\{Number\(zip\.percent/);
  assert.match(htmlSource, /id="replayProgressBar"/);
  assert.match(htmlSource, /id="replayFinaliseProgressBar"/);
  assert.match(appSource, /renderTaskProgress\(elements\.replayFinaliseProgressBar/);
  assert.match(appSource, /element\.removeAttribute\("value"\)/);
  assert.match(appSource, /Replay complete; finalising/);
  assert.match(appSource, /Complete · finalising recomputed result/);
  assert.match(appSource, /finalisationRunning \|\| !recomputedActive/);
  assert.match(htmlSource, /browser may be closed/);
  assert.match(appSource, /not a current canonical voyage/);
  assert.match(appSource, /window\.confirm/);
});

test("Voyage downloads stream through the browser without buffering the ZIP in memory", () => {
  assert.doesNotMatch(appSource, /response\.blob\(\)/);
  assert.doesNotMatch(appSource, /URL\.createObjectURL/);
  assert.doesNotMatch(appSource, /fetch\(bundle\.downloadUrl/);
  assert.match(
    appSource,
    /elements\.downloadSelectedBundle\.href = selectedBundle\.downloadUrl/,
  );
  assert.match(
    appSource,
    /The browser will stream the ZIP directly when it is ready/,
  );
  assert.match(
    appSource,
    /classList\.contains\("disabled"\)\) \{\s*event\.preventDefault\(\)/s,
  );
});
