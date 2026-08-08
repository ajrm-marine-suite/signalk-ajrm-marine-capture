/**
 * Implements the voyage input ZIP responsibilities of the AJRM Marine Voyages Signal K server.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const yauzl = require("yauzl");

const {
  INPUT_RELATIVE_PATH,
  LEGACY_INPUT_RELATIVE_PATH,
} = require("./canonical-voyage");

const INPUT_ENTRY_CANDIDATES = new Set([
  INPUT_RELATIVE_PATH,
  LEGACY_INPUT_RELATIVE_PATH,
]);

function extractCanonicalInputFromZip(zipPath, targetPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError || new Error("Unable to open parent voyage ZIP"));
        return;
      }
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        zip.close();
        if (error) reject(error);
        else resolve(value);
      };
      zip.once("error", (error) => finish(error));
      zip.once("end", () => {
        finish(
          new Error(
            `Parent voyage does not contain the required canonical input ${INPUT_RELATIVE_PATH}`,
          ),
        );
      });
      zip.on("entry", (entry) => {
        if (!INPUT_ENTRY_CANDIDATES.has(entry.fileName) || /\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        fs.promises.mkdir(path.dirname(targetPath), { recursive: true })
          .then(() => {
            zip.openReadStream(entry, (streamError, input) => {
              if (streamError || !input) {
                finish(streamError || new Error("Unable to read canonical voyage input"));
                return;
              }
              const temporaryPath = `${targetPath}.partial-${process.pid}-${Date.now()}`;
              const output = fs.createWriteStream(temporaryPath, {
                flags: "wx",
                mode: 0o600,
              });
              const cleanup = () =>
                fs.promises.unlink(temporaryPath).catch(() => {});
              input.once("error", (error) => {
                output.destroy();
                cleanup().finally(() => finish(error));
              });
              output.once("error", (error) => {
                input.destroy();
                cleanup().finally(() => finish(error));
              });
              output.once("finish", () => {
                fs.promises.rename(temporaryPath, targetPath)
                  .then(() =>
                    fs.promises.stat(targetPath),
                  )
                  .then((info) => {
                    if (!info.isFile() || info.size <= 0) {
                      throw new Error("Canonical voyage input is empty");
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
              input.pipe(output);
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
};
