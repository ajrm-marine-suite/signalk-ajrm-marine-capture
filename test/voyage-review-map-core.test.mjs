import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const normalizeNewlines = (text) => text.replace(/\r\n?/g, "\n");

test("published map core matches the pinned internal release", async () => {
  const [publishedModule, pinnedModule, publishedCss, pinnedCss] = await Promise.all([
    readFile(new URL("../public/review/ajrm-map-core.mjs", import.meta.url), "utf8"),
    readFile(new URL("../node_modules/@ajrm-marine/map-core/src/index.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/review/ajrm-map-core.css", import.meta.url), "utf8"),
    readFile(new URL("../node_modules/@ajrm-marine/map-core/styles/map-core.css", import.meta.url), "utf8"),
  ]);
  assert.equal(normalizeNewlines(publishedModule), normalizeNewlines(pinnedModule));
  assert.equal(normalizeNewlines(publishedCss), normalizeNewlines(pinnedCss));
});

test("map page uses the standard left-side controls with zoom first", async () => {
  const [html, app, css] = await Promise.all([
    readFile(new URL("../public/review/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/review/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/review/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /ajrm-map-core\.css\?v=0\.7\.3/);
  assert.match(html, /type="module" src="\.\/app\.js\?v=0\.9\.7"/);
  assert.match(html, /id="chartCycleStatus" class="ajrm-map-chart-cycle-status"[^>]+hidden/);
  assert.match(html, /<header class="topbar" hidden>/);
  assert.match(html, /id="toggleVoyages"[^>]+aria-pressed="false"/);
  assert.match(html, /class="capture-return" href="\.\.\/"[^>]*>← Capture<\/a>/);
  assert.match(html, /id="voyageDrawer" class="drawer drawer-left"/);
  assert.doesNotMatch(html, /id="voyageDrawer" class="[^"]*\bopen\b/);
  assert.match(css, /\.drawer-left\s*\{[^}]*left:\s*52px/s);
  assert.match(css, /\.voyage-list\s*\{[^}]*display:\s*flex/s);
  assert.match(css, /\.voyage-list\s*\{[^}]*height:\s*0/s);
  assert.match(css, /\.voyage-list\s*\{[^}]*overflow-y:\s*scroll/s);
  assert.match(css, /\.voyage-list\s*\{[^}]*touch-action:\s*pan-y/s);
  assert.match(css, /\.file-row\s*\{[^}]*flex:\s*0 0 auto/s);
  assert.match(await readFile(new URL("../public/review/ajrm-map-core.css", import.meta.url), "utf8"), /\.ajrm-map-actions\{display:flex;flex-direction:column;gap:10px/);
  assert.match(await readFile(new URL("../public/review/ajrm-map-core.css", import.meta.url), "utf8"), /\.ajrm-map-panel\{[^}]*overflow-x:hidden;[^}]*touch-action:pan-y/);
  assert.match(app, /L\.map\(elements\.map, \{ zoomControl: true \}\)/);
  assert.match(app, /MapCore\.createChartSelectorControl/);
  assert.match(app, /MapCore\.createChartCycleControl/);
	assert.match(app, /isEnabled:\s*\(\)\s*=>\s*map\.hasLayer\(autoChartGroup\)/);
  assert.match(app, /MapCore\.labelLeafletZoomControls\(map\)/);
  assert.match(app, /statusElement:\s*elements\.chartCycleStatus/);
  assert.match(await readFile(new URL("../public/review/ajrm-map-core.mjs", import.meta.url), "utf8"), /CHART_CYCLE_SHORTCUT_STORAGE_KEY = "chartCycleShortcut"/);
  assert.match(await readFile(new URL("../public/review/ajrm-map-core.css", import.meta.url), "utf8"), /\.ajrm-map-chart-cycle-status\{/);
  assert.match(await readFile(new URL("../public/review/ajrm-map-core.css", import.meta.url), "utf8"), /\[data-ajrm-map-help\]::after\{/);
  assert.match(await readFile(new URL("../public/review/ajrm-map-core.mjs", import.meta.url), "utf8"), /export function floatingPanelHeight/);
  assert.match(app, /MapCore\.createActionToolbarControl/);
  assert.doesNotMatch(app, /position:\s*["']topright["']/);
});
