"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");
const AdmZip = require("adm-zip");

const {
  CONVERSION_CONTRACT,
  REPORT_RELATIVE_PATH,
  convertLegacyVoyage,
  orderCaptureFiles,
} = require("../plugin/legacy-voyage-converter");
const {
  INPUT_CONTRACT,
  INPUT_RELATIVE_PATH,
  inspectCanonicalInput,
} = require("../plugin/canonical-voyage");

test("legacy converter emits only physical voyage-window input on a clamped timeline", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-legacy-converter-"));
  const source = path.join(root, "voyage-old");
  const capture = path.join(source, "capture");
  const output = path.join(root, "voyage-old-canonical.zip");
  await fs.mkdir(capture, { recursive: true });
  await fs.writeFile(path.join(source, "index.json"), `${JSON.stringify({
    id: "voyage-old",
    version: "0.6.0",
    startedAt: "2026-07-14T10:00:00.000Z",
    stoppedAt: "2026-07-14T10:00:10.000Z",
    captureFiles: ["capture-b.jsonl.gz", "capture-a.jsonl.gz"],
    captureIndex: {
      files: [
        { fileName: "capture-a.jsonl.gz", firstTimestamp: "2026-07-14T09:59:00.000Z" },
        { fileName: "capture-b.jsonl.gz", firstTimestamp: "2026-07-14T10:00:05.000Z" },
      ],
    },
  })}\n`);
  await writeGzipLines(path.join(capture, "capture-a.jsonl.gz"), [
    envelope("2026-07-14T09:59:59.000Z", "YDEN.1", "navigation.position", { latitude: 1, longitude: 2 }),
    envelope("2026-07-14T10:00:01.000Z", "YDEN.1", "navigation.position", { latitude: 3, longitude: 4 }),
    envelope("2026-07-14T10:00:03.000Z", "derived", "navigation.position", { latitude: 99, longitude: 99 }),
    envelope("2026-07-14T10:00:00.000Z", "YDEN.1", "navigation.speedOverGround", 2),
  ]);
  await writeGzipLines(path.join(capture, "capture-b.jsonl.gz"), [
    envelope("2026-07-14T10:00:05.000Z", "YDEN.1", "navigation.courseOverGroundTrue", 1),
    envelope("2026-07-14T10:00:11.000Z", "YDEN.1", "navigation.position", { latitude: 5, longitude: 6 }),
  ]);

  try {
    const result = await convertLegacyVoyage({ inputPath: source, outputPath: output });
    assert.equal(result.contract, CONVERSION_CONTRACT);
    assert.equal(result.canonicalRecords, 3);
    assert.equal(result.recordsOutsideVoyageWindow, 2);
    assert.equal(result.nonPhysicalRecordsDiscarded, 1);
    assert.equal(result.rawTimestampRegressions, 1);
    assert.equal(result.rawBackwardMs, 1000);
    assert.equal(result.durationMs, 4000);
    assert.equal(result.validation.valid, true);

    const zip = new AdmZip(output);
    const index = JSON.parse(zip.readAsText("index.json"));
    const report = JSON.parse(zip.readAsText(REPORT_RELATIVE_PATH));
    const records = zip.readAsText(INPUT_RELATIVE_PATH).trim().split("\n").map(JSON.parse);
    assert.equal(index.canonicalInput.contract, INPUT_CONTRACT);
    assert.equal(index.legacyConversion.contract, CONVERSION_CONTRACT);
    assert.equal(report.validation.nondecreasingElapsedMs, true);
    assert.deepEqual(records.map((record) => record.elapsedMs), [0, 0, 4000]);
    assert.deepEqual(
      records.flatMap((record) => record.delta.updates.flatMap((update) => update.values.map((value) => value.path))),
      ["navigation.position", "navigation.speedOverGround", "navigation.courseOverGroundTrue"],
    );
    assert.equal(records[0].delta.updates[0].timestamp, "2026-07-14T10:00:01.000Z");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("legacy converter accepts a ZIP and refuses an existing output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-legacy-converter-zip-"));
  const sourceDirectory = path.join(root, "source");
  const sourceZip = path.join(root, "source.zip");
  const outputZip = path.join(root, "converted.zip");
  await fs.mkdir(path.join(sourceDirectory, "capture"), { recursive: true });
  await fs.writeFile(path.join(sourceDirectory, "index.json"), `${JSON.stringify({
    id: "zip-voyage",
    startedAt: "2026-07-14T10:00:00.000Z",
    stoppedAt: "2026-07-14T10:00:10.000Z",
    captureFiles: ["capture.jsonl"],
  })}\n`);
  await fs.writeFile(
    path.join(sourceDirectory, "capture", "capture.jsonl"),
    `${JSON.stringify(envelope("2026-07-14T10:00:01.000Z", "YDEN.2", "navigation.headingMagnetic", 2))}\n`,
  );
  const zip = new AdmZip();
  zip.addLocalFolder(sourceDirectory);
  zip.writeZip(sourceZip);

  try {
    await convertLegacyVoyage({ inputPath: sourceZip, outputPath: outputZip });
    const extracted = path.join(root, "canonical.jsonl");
    const converted = new AdmZip(outputZip);
    await fs.writeFile(extracted, converted.readFile(INPUT_RELATIVE_PATH));
    const inspection = await inspectCanonicalInput(extracted);
    assert.equal(inspection.records, 1);
    await assert.rejects(
      convertLegacyVoyage({ inputPath: sourceZip, outputPath: outputZip }),
      /Output already exists/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("capture files use explicit indexed first timestamps when available", () => {
  assert.deepEqual(
    orderCaptureFiles(["later.jsonl.gz", "earlier.jsonl.gz"], {
      files: [
        { fileName: "earlier.jsonl.gz", firstTimestamp: "2026-07-14T10:00:00Z" },
        { fileName: "later.jsonl.gz", firstTimestamp: "2026-07-14T11:00:00Z" },
      ],
    }),
    ["earlier.jsonl.gz", "later.jsonl.gz"],
  );
});

function envelope(capturedAt, source, valuePath, value) {
  return {
    capturedAt,
    delta: {
      context: "vessels.self",
      updates: [{
        $source: source,
        source: { label: source.split(".")[0] },
        timestamp: capturedAt,
        values: [{ path: valuePath, value }],
      }],
    },
  };
}

async function writeGzipLines(filePath, records) {
  const content = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  await fs.writeFile(filePath, zlib.gzipSync(content));
}
