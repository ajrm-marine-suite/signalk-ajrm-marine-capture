const assert = require("node:assert/strict");
const test = require("node:test");
const createPlugin = require("../plugin");

const {
  reconcilePortableCaptureReferences,
  rewritePortableDownloadEvents,
} = createPlugin._private;

test("portable download references describe the copied compressed capture file", () => {
  const index = {
    captureReferences: [
      {
        fileName: "capture-2026-06-27T16-11-52-521Z.jsonl",
        sourcePath: "/home/pi/AJRMMarineLogs/captures/capture-2026-06-27T16-11-52-521Z.jsonl",
        compressedSourcePath: "/home/pi/AJRMMarineLogs/captures/capture-2026-06-27T16-11-52-521Z.jsonl.gz",
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
