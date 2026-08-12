/**
 * Verifies streamed voyage transfer validation and no-overwrite behaviour.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");
const AdmZip = require("adm-zip");
const createPlugin = require("../plugin");

const { storeUploadedVoyage } = createPlugin._private;

function voyageZip(entries = {}) {
  const zip = new AdmZip();
  zip.addFile("index.json", Buffer.from(JSON.stringify({
    schemaVersion: 1,
    id: "voyage-20260812T120000Z",
    ...entries.index,
  })));
  zip.addFile(
    "input/sensor-input.jsonl",
    Buffer.from(entries.input || '{"contract":"ajrm-marine-canonical-input-v1","elapsedMs":0}\n'),
  );
  return zip.toBuffer();
}

test("streams a valid AJRM voyage ZIP into the voyage directory", async (context) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ajrm-upload-"));
  context.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const buffer = voyageZip();
  const result = await storeUploadedVoyage({
    input: Readable.from(buffer),
    fileName: "voyage-20260812T120000Z.zip",
    voyageDirectory: directory,
    maximumBytes: buffer.length + 1,
  });
  assert.equal(result.bytes, buffer.length);
  assert.equal(result.index.id, "voyage-20260812T120000Z");
  assert.deepEqual(
    await fs.promises.readFile(path.join(directory, result.fileName)),
    buffer,
  );
});

test("does not overwrite an existing voyage", async (context) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ajrm-upload-"));
  context.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const fileName = "voyage-20260812T120000Z.zip";
  await fs.promises.writeFile(path.join(directory, fileName), "original");
  await assert.rejects(
    storeUploadedVoyage({
      input: Readable.from(voyageZip()),
      fileName,
      voyageDirectory: directory,
    }),
    (error) => error.statusCode === 409 && /not overwritten/.test(error.message),
  );
  assert.equal(await fs.promises.readFile(path.join(directory, fileName), "utf8"), "original");
});

test("rejects non-voyage ZIPs and removes partial uploads", async (context) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ajrm-upload-"));
  context.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const zip = new AdmZip();
  zip.addFile("notes.txt", Buffer.from("not a voyage"));
  await assert.rejects(
    storeUploadedVoyage({
      input: Readable.from(zip.toBuffer()),
      fileName: "voyage-invalid.zip",
      voyageDirectory: directory,
    }),
    /root index\.json is missing/,
  );
  assert.deepEqual(await fs.promises.readdir(directory), []);
});

test("stops a streamed upload at its disk allowance", async (context) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ajrm-upload-"));
  context.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    storeUploadedVoyage({
      input: Readable.from(voyageZip()),
      fileName: "voyage-too-large.zip",
      voyageDirectory: directory,
      maximumBytes: 10,
    }),
    (error) => error.statusCode === 413,
  );
  assert.deepEqual(await fs.promises.readdir(directory), []);
});

test("browser exposes voyage upload with progress feedback", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.match(html, /id="uploadVoyageBundle"/);
  assert.match(html, /accept="\.zip,application\/zip"/);
  assert.match(app, /XMLHttpRequest/);
  assert.match(app, /request\.upload\.addEventListener\("progress"/);
  assert.match(app, /\/voyages\/upload\?file=/);
});
