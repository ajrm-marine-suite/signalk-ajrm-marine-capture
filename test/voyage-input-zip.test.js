"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const AdmZip = require("adm-zip");

const {
  INPUT_RELATIVE_PATH,
  canonicalInputRecord,
} = require("../plugin/canonical-voyage");
const {
  extractCanonicalInputFromZip,
} = require("../plugin/voyage-input-zip");

test("canonical input is streamed from a voyage ZIP", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-input-zip-"));
  const zipPath = path.join(root, "parent.zip");
  const targetPath = path.join(root, "input", "replay.jsonl");
  const content = `${JSON.stringify(canonicalInputRecord({
    elapsedMs: 0,
    delta: {
      updates: [{
        $source: "YDEN.2",
        values: [{ path: "navigation.speedOverGround", value: 1 }],
      }],
    },
  }))}\n`;
  const zip = new AdmZip();
  zip.addFile(INPUT_RELATIVE_PATH, Buffer.from(content));
  zip.writeZip(zipPath);
  const result = await extractCanonicalInputFromZip(zipPath, targetPath);
  assert.equal(result.entry, INPUT_RELATIVE_PATH);
  assert.equal(await fs.readFile(targetPath, "utf8"), content);
  await fs.rm(root, { recursive: true, force: true });
});

test("voyage without canonical input fails clearly", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-legacy-zip-"));
  const zipPath = path.join(root, "legacy.zip");
  const zip = new AdmZip();
  zip.addFile("index.json", Buffer.from("{}"));
  zip.writeZip(zipPath);
  await assert.rejects(
    extractCanonicalInputFromZip(zipPath, path.join(root, "replay.jsonl")),
    /required canonical input/,
  );
  await fs.rm(root, { recursive: true, force: true });
});
