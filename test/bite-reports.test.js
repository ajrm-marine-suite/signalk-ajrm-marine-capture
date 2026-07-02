const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "plugin", "index.js"), "utf8");

test("Capture bundles Console BITE reports for offline debugging", () => {
  assert.match(source, /CONSOLE_BITE_REPORTS_DIRECTORY/);
  assert.match(source, /signalk-ajrm-marine-console/);
  assert.match(source, /bite-reports/);
  assert.match(source, /system", "bite-reports"/);
  assert.match(source, /await copyConsoleBiteReports\(voyage\);/);
  assert.match(source, /biteReports = \{/);
});
