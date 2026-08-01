#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { convertLegacyVoyage } = require("../plugin/legacy-voyage-converter");

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const outputPath = options.output || defaultOutputPath(options.input);
  const result = await convertLegacyVoyage({
    inputPath: options.input,
    outputPath,
    sourcePrefixes: options.sourcePrefixes,
    onProgress(progress) {
      process.stderr.write(
        `Converted ${progress.filesProcessed}/${progress.filesTotal} capture files; ${progress.canonicalRecords} canonical records\n`,
      );
    },
  });
  process.stdout.write(`${JSON.stringify({
    outputPath: result.outputPath,
    voyageId: result.sourceVoyageId,
    canonicalRecords: result.canonicalRecords,
    durationMs: result.durationMs,
    rawTimestampRegressions: result.rawTimestampRegressions,
    rawBackwardMs: result.rawBackwardMs,
    canonicalSha256: result.canonicalSha256,
    valid: result.validation?.valid === true,
  }, null, 2)}\n`);
}

function parseArguments(argv) {
  const result = { input: null, output: null, sourcePrefixes: ["YDEN"], help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") result.help = true;
    else if (argument === "--output" || argument === "-o") result.output = requiredValue(argv, ++index, argument);
    else if (argument === "--source-prefix") result.sourcePrefixes.push(requiredValue(argv, ++index, argument));
    else if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    else if (!result.input) result.input = argument;
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  result.sourcePrefixes = [...new Set(result.sourcePrefixes.map((entry) => entry.trim()).filter(Boolean))];
  if (!result.help && !result.input) throw new Error("A legacy voyage ZIP or directory is required");
  return result;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("-")) throw new Error(`${option} requires a value`);
  return value;
}

function defaultOutputPath(inputPath) {
  const absolute = path.resolve(inputPath);
  const extension = path.extname(absolute).toLowerCase();
  const stem = extension === ".zip" ? absolute.slice(0, -extension.length) : absolute;
  return `${stem}-canonical.zip`;
}

function usage() {
  return `Usage: node tools/convert-legacy-voyage.js <voyage.zip|directory> [options]\n\nOptions:\n  -o, --output <file>          Output ZIP (default: <input>-canonical.zip)\n      --source-prefix <prefix> Add a physical source prefix (default: YDEN)\n  -h, --help                   Show this help\n\nThe input is never modified. The output path must not already exist.\n`;
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`Conversion failed: ${error.message}\n`);
  process.exitCode = 1;
});
