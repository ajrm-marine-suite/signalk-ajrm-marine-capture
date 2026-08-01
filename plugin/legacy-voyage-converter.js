"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const zlib = require("node:zlib");
const { ZipArchive } = require("archiver");
const yauzl = require("yauzl");

const {
  INPUT_CONTRACT,
  INPUT_RELATIVE_PATH,
  canonicalInputRecord,
  extractCanonicalInputDelta,
  inspectCanonicalInput,
  normalizeSourcePrefixes,
} = require("./canonical-voyage");

const CONVERSION_CONTRACT = "ajrm-marine-legacy-voyage-conversion-v1";
const REPORT_RELATIVE_PATH = "conversion/legacy-conversion-report.json";

async function convertLegacyVoyage({
  inputPath,
  outputPath,
  sourcePrefixes = ["YDEN"],
  convertedAt = new Date().toISOString(),
  onProgress = () => {},
}) {
  const source = path.resolve(String(inputPath || ""));
  const output = path.resolve(String(outputPath || ""));
  if (!source || !output) throw new Error("Input and output paths are required");
  if (source === output) throw new Error("Input and output paths must be different");
  if (await pathExists(output)) {
    throw new Error(`Output already exists: ${output}`);
  }

  const prefixes = normalizeSourcePrefixes(sourcePrefixes);
  await fs.promises.mkdir(path.dirname(output), { recursive: true });
  const temporaryRoot = await fs.promises.mkdtemp(
    path.join(path.dirname(output), ".ajrm-legacy-voyage-converter-"),
  );
  const bundleDirectory = path.join(temporaryRoot, "bundle");
  try {
    const sourceInfo = await fs.promises.stat(source).catch(() => null);
    if (!sourceInfo) throw new Error(`Input does not exist: ${source}`);
    if (sourceInfo.isDirectory()) {
      await copyDirectory(source, bundleDirectory);
    } else if (sourceInfo.isFile() && source.toLowerCase().endsWith(".zip")) {
      await extractZipToDirectory(source, bundleDirectory);
    } else {
      throw new Error("Input must be an extracted voyage directory or a .zip voyage bundle");
    }

    const indexPath = path.join(bundleDirectory, "index.json");
    const index = await readJson(indexPath);
    if (!index || typeof index !== "object") {
      throw new Error("Voyage bundle does not contain a valid root index.json");
    }
    if (index.canonicalInput?.contract === INPUT_CONTRACT) {
      throw new Error("Voyage already contains canonical input; conversion is not required");
    }

    const startedAtMs = parseRequiredTime(index.startedAt, "index.startedAt");
    const stoppedAtMs = parseRequiredTime(index.stoppedAt, "index.stoppedAt");
    if (stoppedAtMs < startedAtMs) {
      throw new Error("index.stoppedAt is before index.startedAt");
    }
    const captureSources = await resolveCaptureSources(index, bundleDirectory);
    if (!captureSources.length) throw new Error("Voyage declares no legacy capture files");
    const captureFiles = captureSources.map((entry) => entry.fileName);

    const canonicalPath = path.join(bundleDirectory, INPUT_RELATIVE_PATH);
    await fs.promises.mkdir(path.dirname(canonicalPath), { recursive: true });
    const outputStream = fs.createWriteStream(canonicalPath, {
      flags: "wx",
      mode: 0o600,
    });
    const hash = crypto.createHash("sha256");
    const report = createReport({
      source,
      output,
      index,
      captureFiles,
      prefixes,
      convertedAt,
      startedAtMs,
      stoppedAtMs,
    });
    let firstLogicalMs = null;
    let lastLogicalMs = null;
    let previousRawMs = null;

    try {
      for (const captureSource of captureSources) {
        const { fileName, filePath: capturePath, kind: sourceKind } = captureSource;
        const fileReport = {
          fileName,
          sourceKind,
          recordsRead: 0,
          recordsInVoyageWindow: 0,
          canonicalRecords: 0,
          malformedRecords: 0,
        };
        report.files.push(fileReport);
        await forEachLegacyRecord(capturePath, fileName, async (envelope, lineNumber) => {
          fileReport.recordsRead += 1;
          report.recordsRead += 1;
          if (!envelope || typeof envelope !== "object" || !envelope.delta) {
            fileReport.malformedRecords += 1;
            throw new Error(`${fileName}:${lineNumber} is not a legacy capture envelope`);
          }
          const rawMs = Date.parse(envelope.capturedAt || "");
          if (!Number.isFinite(rawMs)) {
            fileReport.malformedRecords += 1;
            throw new Error(`${fileName}:${lineNumber} has no valid capturedAt`);
          }
          if (rawMs < startedAtMs || rawMs > stoppedAtMs) {
            report.recordsOutsideVoyageWindow += 1;
            return;
          }
          fileReport.recordsInVoyageWindow += 1;
          report.recordsInVoyageWindow += 1;
          const inputDelta = extractCanonicalInputDelta(envelope.delta, prefixes);
          if (!inputDelta) {
            report.nonPhysicalRecordsDiscarded += 1;
            return;
          }
          if (Number.isFinite(previousRawMs) && rawMs < previousRawMs) {
            report.rawTimestampRegressions += 1;
            report.rawBackwardMs += previousRawMs - rawMs;
          }
          const logicalMs = Number.isFinite(lastLogicalMs)
            ? Math.max(lastLogicalMs, rawMs)
            : rawMs;
          if (firstLogicalMs === null) firstLogicalMs = logicalMs;
          lastLogicalMs = logicalMs;
          previousRawMs = logicalMs;
          const record = canonicalInputRecord({
            delta: inputDelta,
            elapsedMs: logicalMs - firstLogicalMs,
            capturedAt: new Date(rawMs).toISOString(),
          });
          const line = `${JSON.stringify(record)}\n`;
          await writeLine(outputStream, line);
          hash.update(line);
          fileReport.canonicalRecords += 1;
          report.canonicalRecords += 1;
          report.canonicalBytes += Buffer.byteLength(line);
          if (!report.firstCapturedAt) report.firstCapturedAt = record.capturedAt;
          report.lastCapturedAt = record.capturedAt;
          report.durationMs = record.elapsedMs;
        });
        onProgress({
          fileName,
          filesProcessed: report.files.length,
          filesTotal: captureSources.length,
          canonicalRecords: report.canonicalRecords,
        });
      }
    } finally {
      await endStream(outputStream);
    }
    if (!report.canonicalRecords) {
      throw new Error(`No ${prefixes.join(", ")} physical-input records occur inside the voyage window`);
    }

    report.rawBackwardMs = Math.round(report.rawBackwardMs);
    report.canonicalSha256 = hash.digest("hex");
    const inspection = await inspectCanonicalInput(canonicalPath);
    report.validation = {
      valid: true,
      contract: inspection.contract,
      records: inspection.records,
      durationMs: inspection.durationMs,
      nondecreasingElapsedMs: true,
    };

    index.canonicalInput = {
      contract: INPUT_CONTRACT,
      schemaVersion: 1,
      fileName: INPUT_RELATIVE_PATH,
      sourcePrefixes: prefixes,
      records: report.canonicalRecords,
      bytes: report.canonicalBytes,
      lastElapsedMs: report.durationMs,
      firstCapturedAt: report.firstCapturedAt,
      lastCapturedAt: report.lastCapturedAt,
      complete: true,
      writeErrors: 0,
      sha256: report.canonicalSha256,
      convertedFromLegacy: true,
    };
    index.legacyConversion = publicConversionSummary(report);
    index.hints = [
      ...(Array.isArray(index.hints) ? index.hints : []),
      `${INPUT_RELATIVE_PATH} was generated once from explicitly sourced legacy physical input; see ${REPORT_RELATIVE_PATH}.`,
      "Legacy envelope capturedAt values were clamped to a non-decreasing replay timeline; original delta timestamps and values were not rewritten.",
    ];
    await writeJson(indexPath, index);
    await writeJson(path.join(bundleDirectory, REPORT_RELATIVE_PATH), report);
    await writeDirectoryZip(output, bundleDirectory);
    return { ...report, outputPath: output };
  } catch (error) {
    await fs.promises.rm(`${output}.partial`, { force: true }).catch(() => {});
    throw error;
  } finally {
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
  }
}

function createReport({
  source,
  output,
  index,
  captureFiles,
  prefixes,
  convertedAt,
  startedAtMs,
  stoppedAtMs,
}) {
  return {
    contract: CONVERSION_CONTRACT,
    schemaVersion: 1,
    convertedAt,
    sourceName: path.basename(source),
    outputName: path.basename(output),
    sourceVoyageId: index.id || null,
    sourceVoyageVersion: index.version || null,
    voyageWindow: {
      from: new Date(startedAtMs).toISOString(),
      to: new Date(stoppedAtMs).toISOString(),
    },
    sourcePrefixes: prefixes,
    timing: {
      field: "legacy-envelope.capturedAt",
      rule: "file-order, clamp each backwards value to the previous logical value",
      contract: "nondecreasing-clamp-v1",
      preservesDeltaTimestamps: true,
    },
    captureFiles,
    files: [],
    recordsRead: 0,
    recordsInVoyageWindow: 0,
    recordsOutsideVoyageWindow: 0,
    nonPhysicalRecordsDiscarded: 0,
    canonicalRecords: 0,
    canonicalBytes: 0,
    rawTimestampRegressions: 0,
    rawBackwardMs: 0,
    firstCapturedAt: null,
    lastCapturedAt: null,
    durationMs: 0,
    canonicalSha256: null,
    validation: null,
  };
}

function publicConversionSummary(report) {
  return {
    contract: report.contract,
    schemaVersion: report.schemaVersion,
    convertedAt: report.convertedAt,
    reportFile: REPORT_RELATIVE_PATH,
    timing: report.timing,
    voyageWindow: report.voyageWindow,
    sourcePrefixes: report.sourcePrefixes,
    canonicalRecords: report.canonicalRecords,
    rawTimestampRegressions: report.rawTimestampRegressions,
    rawBackwardMs: report.rawBackwardMs,
    validation: report.validation,
  };
}

async function resolveCaptureSources(index, bundleDirectory) {
  const declared = Array.isArray(index.captureFiles)
    ? index.captureFiles.map((entry) => path.basename(String(entry || ""))).filter(Boolean)
    : [];
  const directory = path.join(bundleDirectory, "capture");
  if (declared.length) {
    return orderCaptureFiles(declared, index.captureIndex).map((fileName) => ({
      fileName,
      filePath: path.join(directory, fileName),
      kind: "embedded",
    }));
  }
  const embeddedEntries = await fs.promises.readdir(directory, {
    withFileTypes: true,
  }).catch(() => []);
  const embedded = embeddedEntries
    .filter((entry) => entry.isFile() && /\.jsonl(?:\.gz)?$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (embedded.length) {
    return embedded.map((fileName) => ({
      fileName,
      filePath: path.join(directory, fileName),
      kind: "embedded",
    }));
  }

  const references = Array.isArray(index.captureReferences)
    ? index.captureReferences
    : [];
  const resolved = [];
  const missing = [];
  for (const reference of references) {
    const declaredName = path.basename(String(reference?.fileName || ""));
    const candidates = [
      reference?.compressedSourcePath,
      reference?.sourcePath,
    ]
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
    let selectedPath = null;
    for (const candidate of candidates) {
      const info = await fs.promises.stat(candidate).catch(() => null);
      if (info?.isFile()) {
        selectedPath = candidate;
        break;
      }
    }
    if (!selectedPath) {
      missing.push(declaredName || candidates[0] || "unnamed capture reference");
      continue;
    }
    resolved.push({
      fileName: path.basename(selectedPath),
      filePath: selectedPath,
      kind: "declared-reference",
      fromMs: Date.parse(reference?.from || ""),
    });
  }
  if (missing.length) {
    throw new Error(
      `Missing ${missing.length} declared capture reference${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
    );
  }
  return resolved.sort((left, right) => {
    if (Number.isFinite(left.fromMs) && Number.isFinite(right.fromMs) && left.fromMs !== right.fromMs) {
      return left.fromMs - right.fromMs;
    }
    return left.fileName.localeCompare(right.fileName);
  });
}

function orderCaptureFiles(fileNames, captureIndex) {
  const indexed = new Map(
    (Array.isArray(captureIndex?.files) ? captureIndex.files : [])
      .map((entry) => [path.basename(String(entry?.fileName || "")), Date.parse(entry?.firstTimestamp || "")]),
  );
  return fileNames
    .map((fileName, position) => ({ fileName, position, firstMs: indexed.get(fileName) }))
    .sort((left, right) => {
      if (Number.isFinite(left.firstMs) && Number.isFinite(right.firstMs) && left.firstMs !== right.firstMs) {
        return left.firstMs - right.firstMs;
      }
      return left.position - right.position;
    })
    .map((entry) => entry.fileName);
}

async function forEachLegacyRecord(filePath, fileName, visitor) {
  const source = fs.createReadStream(filePath);
  const input = fileName.toLowerCase().endsWith(".gz")
    ? source.pipe(zlib.createGunzip())
    : source;
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch (_error) {
        throw new Error(`${fileName}:${lineNumber} contains invalid JSON`);
      }
      await visitor(record, lineNumber);
    }
  } finally {
    lines.close();
    input.destroy();
    source.destroy();
  }
}

async function copyDirectory(source, target) {
  await fs.promises.cp(source, target, { recursive: true, errorOnExist: true });
}

function extractZipToDirectory(zipPath, targetDirectory) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError || new Error("Unable to open voyage ZIP"));
        return;
      }
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        zip.close();
        if (error) reject(error);
        else resolve();
      };
      zip.once("error", finish);
      zip.once("end", () => finish());
      zip.on("entry", (entry) => {
        if (unsafeZipEntryName(entry.fileName)) {
          finish(new Error(`Unsafe archive path: ${entry.fileName}`));
          return;
        }
        const targetPath = path.join(targetDirectory, entry.fileName);
        if (/\/$/.test(entry.fileName)) {
          fs.promises.mkdir(targetPath, { recursive: true })
            .then(() => zip.readEntry(), finish);
          return;
        }
        fs.promises.mkdir(path.dirname(targetPath), { recursive: true })
          .then(() => new Promise((resolveEntry, rejectEntry) => {
            zip.openReadStream(entry, (streamError, input) => {
              if (streamError || !input) {
                rejectEntry(streamError || new Error(`Unable to read ${entry.fileName}`));
                return;
              }
              const output = fs.createWriteStream(targetPath, { flags: "wx", mode: 0o600 });
              input.once("error", rejectEntry);
              output.once("error", rejectEntry);
              output.once("finish", resolveEntry);
              input.pipe(output);
            });
          }))
          .then(() => zip.readEntry(), finish);
      });
      fs.promises.mkdir(targetDirectory, { recursive: true })
        .then(() => zip.readEntry(), finish);
    });
  });
}

async function writeDirectoryZip(zipPath, rootDirectory) {
  await fs.promises.mkdir(path.dirname(zipPath), { recursive: true });
  const partialPath = `${zipPath}.partial`;
  const output = fs.createWriteStream(partialPath, { flags: "wx" });
  const archive = new ZipArchive({ zlib: { level: 6 } });
  try {
    await new Promise((resolve, reject) => {
      output.once("close", resolve);
      output.once("error", reject);
      archive.once("error", reject);
      archive.pipe(output);
      archive.directory(rootDirectory, false);
      archive.finalize().catch(reject);
    });
    await fs.promises.rename(partialPath, zipPath);
  } catch (error) {
    archive.abort();
    output.destroy();
    await fs.promises.rm(partialPath, { force: true }).catch(() => {});
    throw error;
  }
}

function unsafeZipEntryName(entryName) {
  return path.isAbsolute(entryName) || entryName.split(/[\\/]+/).includes("..");
}

function parseRequiredTime(value, field) {
  const parsed = Date.parse(value || "");
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be an explicit timestamp`);
  return parsed;
}

function writeLine(stream, line) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      stream.off("drain", onDrain);
      reject(error);
    };
    const onDrain = () => {
      stream.off("error", onError);
      resolve();
    };
    stream.once("error", onError);
    if (stream.write(line)) {
      stream.off("error", onError);
      resolve();
    } else {
      stream.once("drain", onDrain);
    }
  });
}

function endStream(stream) {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

async function readJson(filePath) {
  return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "w",
    mode: 0o600,
  });
}

async function pathExists(filePath) {
  return Boolean(await fs.promises.stat(filePath).catch(() => null));
}

module.exports = {
  CONVERSION_CONTRACT,
  REPORT_RELATIVE_PATH,
  convertLegacyVoyage,
  orderCaptureFiles,
  resolveCaptureSources,
};
