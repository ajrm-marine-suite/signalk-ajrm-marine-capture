/**
 * Implements the voyage input ZIP responsibilities of the AJRM Marine Voyages Signal K server.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { pipeline } = require("node:stream/promises");
const yauzl = require("yauzl");

const {
  INPUT_RELATIVE_PATH,
  LEGACY_INPUT_RELATIVE_PATH,
  RECOMPUTED_OUTPUT_GZIP_RELATIVE_PATH,
  RECOMPUTED_OUTPUT_RELATIVE_PATH,
} = require("./canonical-voyage");

const INPUT_ENTRY_CANDIDATES = new Set([
  INPUT_RELATIVE_PATH,
  LEGACY_INPUT_RELATIVE_PATH,
]);

function extractCanonicalInputFromZip(zipPath, targetPath, options = {}) {
  return extractVoyageEntryFromZip(zipPath, targetPath, {
    candidates: INPUT_ENTRY_CANDIDATES,
    missingMessage:
      `Parent voyage does not contain the required canonical input ${INPUT_RELATIVE_PATH}`,
    readMessage: "Unable to read canonical voyage input",
    emptyMessage: "Canonical voyage input is empty",
    signal: options.signal,
  });
}

function extractRecomputedOutputFromZip(
  zipPath,
  targetPath,
  declaredPath = null,
  options = {},
) {
  const supportedPaths = [
    RECOMPUTED_OUTPUT_GZIP_RELATIVE_PATH,
    RECOMPUTED_OUTPUT_RELATIVE_PATH,
  ];
  const candidates = supportedPaths.includes(declaredPath)
    ? new Set([declaredPath])
    : new Set(supportedPaths);
  return extractVoyageEntryFromZip(zipPath, targetPath, {
    candidates,
    missingMessage:
      `Voyage does not contain a supported recorded result (${supportedPaths.join(" or ")})`,
    readMessage: "Unable to read recorded voyage result",
    emptyMessage: "Recorded voyage result is empty",
    decodeGzip: true,
    signal: options.signal,
  });
}

function extractVoyageEntryFromZip(
  zipPath,
  targetPath,
  {
    candidates,
    missingMessage,
    readMessage,
    emptyMessage,
    decodeGzip = false,
    signal = null,
  },
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error("Voyage preparation was cancelled"));
      return;
    }
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError || new Error("Unable to open parent voyage ZIP"));
        return;
      }
      let settled = false;
      let temporaryPath = null;
      const abort = () => finish(signal.reason || new Error("Voyage preparation was cancelled"));
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        zip.close();
        if (error && temporaryPath) {
          fs.promises.unlink(temporaryPath).catch(() => {});
        }
        if (error) reject(error);
        else resolve(value);
      };
      signal?.addEventListener("abort", abort, { once: true });
      zip.once("error", (error) => finish(error));
      zip.once("end", () => {
        finish(new Error(missingMessage));
      });
      zip.on("entry", (entry) => {
        if (!candidates.has(entry.fileName) || /\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        fs.promises.mkdir(path.dirname(targetPath), { recursive: true })
          .then(() => {
            zip.openReadStream(entry, (streamError, input) => {
              if (streamError || !input) {
                finish(streamError || new Error(readMessage));
                return;
              }
              temporaryPath = `${targetPath}.partial-${process.pid}-${Date.now()}`;
              const output = fs.createWriteStream(temporaryPath, {
                flags: "wx",
                mode: 0o600,
              });
              const cleanup = () =>
                fs.promises.unlink(temporaryPath).catch(() => {});
              const streams = decodeGzip && entry.fileName.endsWith(".gz")
                ? [input, zlib.createGunzip(), output]
                : [input, output];
              pipeline(...streams, signal ? { signal } : {})
                .then(() => fs.promises.rename(temporaryPath, targetPath))
                .then(() => fs.promises.stat(targetPath))
                .then((info) => {
                  if (!info.isFile() || info.size <= 0) {
                    throw new Error(emptyMessage);
                  }
                  finish(null, {
                    path: targetPath,
                    bytes: info.size,
                    entry: entry.fileName,
                  });
                })
                .catch((error) =>
                  cleanup().finally(() => finish(error)),
                );
            });
          })
          .catch((error) => finish(error));
      });
      zip.readEntry();
    });
  });
}

module.exports = {
  extractCanonicalInputFromZip,
  extractRecomputedOutputFromZip,
};
