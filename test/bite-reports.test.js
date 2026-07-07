const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const createPlugin = require("../plugin");

const source = fs.readFileSync(path.join(__dirname, "..", "plugin", "index.js"), "utf8");
const {
  biteReportOverlapsVoyage,
} = createPlugin._private;

test("Capture bundles voyage-window Console BITE reports for offline debugging", () => {
  assert.match(source, /CONSOLE_BITE_REPORTS_DIRECTORY/);
  assert.match(source, /signalk-ajrm-marine-console/);
  assert.match(source, /bite-reports/);
  assert.match(source, /system", "bite-reports"/);
  assert.match(source, /await copyConsoleBiteReports\(voyage\);/);
  assert.match(source, /biteReportOverlapsVoyage\(voyage, report, name\)/);
  assert.match(source, /biteReports = \{/);
  assert.match(source, /bite-reports-none/);
});

test("startup recovery rediscovers logger segments for interrupted voyages", () => {
  assert.match(source, /async function closeIncompleteVoyageDirectory/);
  assert.match(source, /await copyCaptureFiles\(voyage, voyage\.captureStop\);/);
  assert.match(source, /No AJRM Marine Logger segments matched the recovered voyage range/);
});

test("BITE report filtering includes only reports that overlap the voyage", () => {
  const voyage = {
    startedAt: "2026-07-06T20:41:22.000Z",
    stoppedAt: "2026-07-07T04:15:50.000Z",
  };

  assert.equal(
    biteReportOverlapsVoyage(voyage, {
      scenario: "run-all",
      startedAt: "2026-07-06T20:19:22.000Z",
      finishedAt: "2026-07-06T20:24:01.000Z",
    }),
    false,
  );
  assert.equal(
    biteReportOverlapsVoyage(voyage, {
      scenario: "run-all",
      startedAt: "2026-07-06T20:40:00.000Z",
      finishedAt: "2026-07-06T20:45:00.000Z",
    }),
    true,
  );
  assert.equal(
    biteReportOverlapsVoyage(voyage, {
      scenario: "run-all",
      reports: [
        { startedAt: "2026-07-06T20:40:00.000Z", finishedAt: "2026-07-06T20:45:00.000Z" },
      ],
    }),
    true,
  );
});

test("Capture exposes an in-process API for Console BITE orchestration", () => {
  assert.match(source, /AJRM_MARINE_CAPTURE_API_REGISTRY/);
  assert.match(source, /exposeCaptureApi\(\)/);
  assert.match(source, /app\.ajrmMarineCaptureApi = api/);
  assert.match(source, /globalThis\[AJRM_MARINE_CAPTURE_API_REGISTRY\] = api/);
  assert.match(source, /async setAutomaticRecordingEnabled\(enabled\)/);
  assert.match(source, /await setAutomaticRecordingEnabled\(enabled\)/);
  assert.match(source, /async start\(\{ comment, reason = "BITE run all" \} = \{\}\)/);
  assert.match(source, /async stop\(\{ reason = "BITE run all complete"/);
  assert.match(source, /async prepareVoyageDownload\(fileName\)/);
  assert.match(source, /return prepareVoyageDownload\(fileName\)/);
  assert.match(source, /await setVoyageComment\(comment\)/);
  assert.match(source, /async function setVoyageComment\(value\)/);
  assert.match(source, /currentVoyage\.comment = comment/);
});
