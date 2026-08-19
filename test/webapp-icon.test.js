/** Verifies that Signal K can serve the Webapps catalogue icon. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("appIcon resolves inside the served public directory", () => {
  const packageInfo = require("../package.json");
  const iconUrl = packageInfo.signalk?.appIcon;
  assert.match(iconUrl, /^\.\/[A-Za-z0-9._-]+$/);
  const iconPath = path.join(__dirname, "..", "public", iconUrl.slice(2));
  assert.ok(fs.statSync(iconPath).size > 0, `${iconPath} must be a non-empty file`);
});
