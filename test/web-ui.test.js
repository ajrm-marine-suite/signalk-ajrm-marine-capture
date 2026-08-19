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

test("UI exposes one explicit player with saved-result and recapture modes", () => {
  assert.match(htmlSource, /app\.js\?v=0\.10\.13/);
  assert.match(htmlSource, /id="recordOutputsToggle"/);
  assert.match(htmlSource, /Record calculated results as well as sensor inputs/);
  assert.match(htmlSource, /id="useSavedResultsToggle"/);
  assert.match(htmlSource, /id="recaptureToggle"/);
  assert.match(htmlSource, /id="rewindPlaybackButton"/);
  assert.match(htmlSource, /id="backPlaybackButton"/);
  assert.match(htmlSource, /id="playPlaybackButton"/);
  assert.match(htmlSource, /id="pausePlaybackButton"/);
  assert.match(htmlSource, /id="stopPlaybackButton"/);
  assert.match(htmlSource, /id="forwardPlaybackButton"/);
  assert.match(htmlSource, /Use saved results/);
  assert.match(htmlSource, /Save this run as a new recaptured voyage/);
  assert.match(appSource, /"\/voyage\/player\/play"/);
  assert.match(appSource, /"\/voyage\/player\/pause"/);
  assert.match(appSource, /"\/voyage\/player\/resume"/);
  assert.match(appSource, /"\/voyage\/player\/rewind"/);
  assert.match(appSource, /"\/voyage\/player\/seek"/);
  assert.match(appSource, /"\/voyage\/playback\/stop"/);
  assert.match(appSource, /selectedBundle\?\.hasInputs === true/);
  assert.match(appSource, /selectedBundle\?\.hasSavedResults === true/);
  assert.match(appSource, /elements\.recaptureToggle\.checked/);
  assert.match(appSource, /elements\.useSavedResultsToggle\.checked = false/);
  assert.match(appSource, /playback\.state === "complete"/);
  assert.match(appSource, /playback\.valid === true/);
  assert.match(appSource, /playback\.recordsReplayed/);
  assert.match(appSource, /Single monotonic stream/);
  assert.match(appSource, /Complete · Capture streams closed/);
  assert.match(appSource, /Building ZIP · \$\{Number\(zip\.percent/);
  assert.match(htmlSource, /id="replayProgressBar"/);
  assert.match(htmlSource, /id="replayFinaliseProgressBar"/);
  assert.match(appSource, /renderTaskProgress\(elements\.replayFinaliseProgressBar/);
  assert.match(appSource, /element\.removeAttribute\("value"\)/);
  assert.match(appSource, /Recapture complete; finalising/);
  assert.match(appSource, /Complete · finalising recomputed result/);
  assert.match(htmlSource, /stopping early preserves an explicitly partial result/);
  assert.match(appSource, /Inputs only/);
  assert.match(
    appSource,
    /selectedBundle\?\.fileName \|\| latestStatus\?\.playback\?\.fileName/,
  );
  assert.match(appSource, /let replayPlayLatch = false/);
  assert.match(appSource, /if \(action === "play"\) replayPlayLatch = ok/);
  assert.match(appSource, /const busy = replayPlayLatch \|\|/);
  assert.match(appSource, /playbackPreparing[\s\S]*"Preparing…"/);
  assert.match(appSource, /Extracting and validating the voyage stream…/);
  assert.match(appSource, /playbackSeeking \? "Seeking…" : "Preparing…"/);
  assert.match(appSource, /Locating the requested voyage time…/);
  assert.match(appSource, /seekPlayback\(-300_000\)/);
  assert.match(appSource, /seekPlayback\(300_000\)/);
  assert.match(appSource, /let refreshSequence = 0/);
  assert.match(appSource, /if \(sequence < appliedRefreshSequence\) return/);
  assert.match(appSource, /Boolean\(status\.playerTransition\)/);
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
