/**
 * Ensures every maintained runtime module begins with a concise purpose comment.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".sh"]);
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "test",
  "tests",
  "dist",
  "coverage",
  "vendor",
]);
const EXCLUDED_FILES = new Set(["protomaps-leaflet.js"]);

function maintainedModules(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(ROOT, absolute).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(entry.name) || relative === "public/assets") continue;
      maintainedModules(absolute, files);
    } else if (
      SOURCE_EXTENSIONS.has(path.extname(entry.name)) &&
      !EXCLUDED_FILES.has(entry.name)
    ) {
      files.push(absolute);
    }
  }
  return files;
}

function hasPurposeHeader(file) {
  const firstMeaningful = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .find(
      (line) =>
        line.trim() &&
        !line.startsWith("#!") &&
        !/^(['"])use strict\1;?$/.test(line.trim()),
    );
  return /^\s*(\/\/|\/\*|#(?!\!))/.test(firstMeaningful || "");
}

test("maintained runtime modules declare their purpose", () => {
  const missing = maintainedModules(ROOT)
    .filter((file) => !hasPurposeHeader(file))
    .map((file) => path.relative(ROOT, file))
    .sort();
  assert.deepEqual(missing, []);
});


function openApiDocuments(directory, documents = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) openApiDocuments(absolute, documents);
    } else if (/openapi\.json$/i.test(entry.name)) {
      documents.push(absolute);
    }
  }
  return documents;
}

test("OpenAPI documents match the package version", () => {
  const packageVersion = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  ).version;
  const mismatches = openApiDocuments(ROOT)
    .map((file) => ({
      file: path.relative(ROOT, file),
      version: JSON.parse(fs.readFileSync(file, "utf8")).info?.version,
    }))
    .filter(({ version }) => version !== packageVersion);
  assert.deepEqual(mismatches, []);
});
