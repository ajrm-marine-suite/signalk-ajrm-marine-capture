const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const AdmZip = require("adm-zip");
const createPlugin = require("../plugin");

const {
  buildPortableDownloadBundle,
  cleanupPortableDownloadWorkspaces,
  reconcilePortableCaptureReferences,
  rewritePortableDownloadEvents,
} = createPlugin._private;

test("already-portable download remains unchanged without external Logger files", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "ajrm-capture-portable-idempotent-"),
  );
  const sourcePath = path.join(directory, "voyage-portable.zip");
  const captureFileName = "capture-2026-07-27T12-00-00-000Z.jsonl.gz";
  const zip = new AdmZip();
  zip.addFile("index.json", Buffer.from(JSON.stringify({
    captureFileMode: "portable-download",
    captureFiles: [captureFileName],
    captureReferences: [{
      fileName: captureFileName,
      sourcePath: path.join(directory, "missing", captureFileName),
      compressedSourcePath: "",
    }],
  })));
  zip.addFile(`capture/${captureFileName}`, Buffer.from("embedded-capture"));
  zip.writeZip(sourcePath);

  const rebuilt = await buildPortableDownloadBundle(
    sourcePath,
    path.basename(sourcePath),
  );
  assert.equal(rebuilt, null);
  const preserved = new AdmZip(sourcePath);
  assert.equal(
    preserved.readAsText(`capture/${captureFileName}`),
    "embedded-capture",
  );
});

test("failed portable download preparation removes its disk-backed workspace", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "ajrm-capture-portable-failure-"),
  );
  const stagingRoot = path.join(directory, "staging");
  const sourcePath = path.join(directory, "voyage-reference.zip");
  const missingCapture = path.join(directory, "missing-capture.jsonl.gz");
  const zip = new AdmZip();
  zip.addFile("index.json", Buffer.from(JSON.stringify({
    captureFileMode: "reference",
    captureReferences: [{
      fileName: path.basename(missingCapture),
      sourcePath: missingCapture,
    }],
  })));
  zip.writeZip(sourcePath);

  await assert.rejects(
    buildPortableDownloadBundle(
      sourcePath,
      path.basename(sourcePath),
      stagingRoot,
    ),
    /Cannot prepare a complete portable voyage/,
  );
  assert.deepEqual(await fs.readdir(stagingRoot), []);
});

test("startup cleanup removes only portable download workspaces", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "ajrm-capture-portable-cleanup-"),
  );
  await fs.mkdir(
    path.join(directory, "ajrm-marine-voyage-download-A1b2C3"),
  );
  await fs.mkdir(path.join(directory, "ajrm-marine-voyage-download-not-ours"));
  await fs.mkdir(path.join(directory, "keep-me"));

  assert.equal(await cleanupPortableDownloadWorkspaces([directory]), 1);
  assert.deepEqual(
    await fs.readdir(directory),
    ["ajrm-marine-voyage-download-not-ours", "keep-me"],
  );
});

test("portable download references describe the copied compressed capture file", () => {
  const index = {
    captureReferences: [
      {
        fileName: "capture-2026-06-27T16-11-52-521Z.jsonl",
        sourcePath: path.join("~", "AJRMMarineLogs", "captures", "capture-2026-06-27T16-11-52-521Z.jsonl"),
        compressedSourcePath: path.join("~", "AJRMMarineLogs", "captures", "capture-2026-06-27T16-11-52-521Z.jsonl.gz"),
        from: "2026-06-27T16:11:52.520Z",
        to: "2026-06-27T17:11:31.952Z",
        compressed: false,
        bytes: 213175292,
      },
    ],
    captureIndex: {
      files: [
        {
          fileName: "capture-2026-06-27T16-11-52-521Z.jsonl.gz",
          firstTimestamp: "2026-06-27T16:11:52.520Z",
          lastTimestamp: "2026-06-27T17:11:31.952Z",
          records: 73026,
        },
      ],
    },
  };

  reconcilePortableCaptureReferences(index, [
    {
      fileName: "capture-2026-06-27T16-11-52-521Z.jsonl.gz",
      bytes: 35284856,
    },
  ]);

  assert.deepEqual(index.captureReferences, [
    {
      fileName: "capture-2026-06-27T16-11-52-521Z.jsonl.gz",
      sourcePath: "capture/capture-2026-06-27T16-11-52-521Z.jsonl.gz",
      compressedSourcePath: "",
      from: "2026-06-27T16:11:52.520Z",
      to: "2026-06-27T17:11:31.952Z",
      compressed: true,
      bytes: 35284856,
      records: 73026,
    },
  ]);
});

test("portable download events no longer say references were left uncopied", () => {
  const index = {
    events: [
      {
        at: "2026-06-27T17:11:32.762Z",
        type: "capture-referenced",
        message: "3 AJRM Marine Logger segments referenced without copying",
      },
    ],
  };

  rewritePortableDownloadEvents(index, [
    { fileName: "one.jsonl.gz", bytes: 10 },
    { fileName: "two.jsonl.gz", bytes: 20 },
    { fileName: "three.jsonl.gz", bytes: 30 },
  ]);

  assert.equal(index.events.length, 1);
  assert.equal(index.events[0].type, "capture-copied-portable-download");
  assert.equal(index.events[0].message, "3 AJRM Marine Logger segments copied into portable download");
});
