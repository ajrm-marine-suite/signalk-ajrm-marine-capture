"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");
const AdmZip = require("adm-zip");
const {
  writeDirectoryZip,
} = require("../plugin")._private;

test("streaming ZIP stores existing gzip segments without recompressing them and reports progress", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ajrm-capture-streaming-zip-"),
  );
  const source = path.join(root, "source");
  const zipPath = path.join(root, "voyage.zip");
  await fs.mkdir(path.join(source, "capture"), { recursive: true });
  await fs.writeFile(
    path.join(source, "index.json"),
    `${JSON.stringify({ id: "voyage-stream-test" })}\n`,
  );
  const gzipBytes = zlib.gzipSync(Buffer.alloc(1024 * 1024, "A"));
  await fs.writeFile(
    path.join(source, "capture", "capture-test.jsonl.gz"),
    gzipBytes,
  );
  const progress = [];

  try {
    await writeDirectoryZip(zipPath, source, {
      onProgress(value) {
        progress.push({ ...value });
      },
    });

    const zip = new AdmZip(zipPath);
    const gzipEntry = zip.getEntry("capture/capture-test.jsonl.gz");
    assert.ok(gzipEntry);
    assert.equal(gzipEntry.header.method, 0);
    assert.deepEqual(gzipEntry.getData(), gzipBytes);
    assert.equal(progress.at(-1).state, "complete");
    assert.equal(progress.at(-1).percent, 100);
    assert.equal(progress.at(-1).storedGzipEntries, 1);
    assert.equal(progress.at(-1).inputBytesProcessed, progress.at(-1).inputBytesTotal);
    assert.equal(
      await fs.stat(`${zipPath}.partial`).catch(() => null),
      null,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
