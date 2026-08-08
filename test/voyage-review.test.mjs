import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import createPlugin, {
  _private,
} from "../plugin/voyage-review.js";

test("voyage downloads defer to Capture portable bundle builder when available", async () => {
  const source = await fs.readFile(new URL("../plugin/voyage-review.js", import.meta.url), "utf8");
  assert.match(source, /prepareCaptureVoyageDownload\(app, file\)/);
  assert.match(source, /globalThis\[AJRM_MARINE_CAPTURE_API_REGISTRY\]/);
  assert.match(source, /api\.prepareVoyageDownload\(fileName\)/);
  assert.match(source, /router\.get\("\/voyages\/:file\/download"/);
  assert.match(source, /res\.download\(captureDownload\.path, captureDownload\.fileName/);
  assert.match(source, /captureDownload\.cleanup\(\)/);
  assert.match(source, /res\.download\(voyagePath, file\)/);
});

test("download button lets the browser stream large bundles directly to disk", async () => {
  const source = await fs.readFile(new URL("../public/review/app.js", import.meta.url), "utf8");
  assert.match(source, /function downloadSelectedFile\(event\)/);
  assert.match(source, /elements\.downloadSelected\.href = downloadUrl\(fileName\)/);
  assert.match(source, /browser will stream it directly to disk/);
  const bundleDownload = source.slice(
    source.indexOf("function downloadSelectedFile"),
    source.indexOf("function analysisProgressUrl"),
  );
  assert.doesNotMatch(bundleDownload, /fetch\(/);
  assert.doesNotMatch(bundleDownload, /response\.blob\(\)/);
});

test("large voyage analysis streams ZIP entries and reports actual progress", async () => {
  const pluginSource = await fs.readFile(new URL("../plugin/voyage-review.js", import.meta.url), "utf8");
  const appSource = await fs.readFile(new URL("../public/review/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(pluginSource, /require\("adm-zip"\)/);
  assert.doesNotMatch(pluginSource, /\.getData\(\)/);
  assert.match(pluginSource, /openZipEntryStream/);
  assert.match(pluginSource, /analysis-progress/);
  assert.match(appSource, /analysisProgressUrl/);
  assert.doesNotMatch(appSource, /estimatedScanSeconds/);
});

test("exposes embedded review status and capability", async () => {
  const source = await fs.readFile(new URL("../plugin/voyage-review.js", import.meta.url), "utf8");
  assert.match(source, /voyageDirectory: options\.voyageDirectory/);
  assert.match(source, /voyageOnly: true/);
  assert.doesNotMatch(source, /title: "AJRM Marine Logger logs directory"/);
  assert.doesNotMatch(source, /title: "AJRM Marine Logger clips directory"/);
  assert.match(source, /review:\s*{\s*supported: true,\s*schemaVersion: 2/s);
  assert.match(source, /capabilities:\s*{\s*voyageOnly: true,\s*plot: true,\s*download: true,\s*review: true/s);
  assert.match(source, /streamingDownload: true/);
  assert.match(source, /streamingAnalysis: true/);
  assert.match(source, /analysisProgress: true/);
  assert.match(source, /runtimeAnalysisApi: true/);
  assert.match(source, /app\.ajrmMarineVoyageReviewApi = api/);
  assert.match(source, /async analyseVoyage\(fileName\)/);
  assert.match(source, /analyseVoyageFile\(file, options, options\.maxTrackPoints\)/);
  assert.match(source, /engineVersion: REVIEW_ENGINE_VERSION/);
});

test("registers and removes the read-only runtime analysis API", () => {
  const app = {
    handleMessage() {},
    setPluginStatus() {},
  };
  const plugin = createPlugin(app, { embedded: true });
  plugin.start({ voyageDirectory: path.join(os.tmpdir(), "ajrm-viewer-api-test") });
  assert.equal(app.ajrmMarineVoyageReviewApi.pluginId, "signalk-ajrm-marine-capture-review");
  assert.equal(typeof app.ajrmMarineVoyageReviewApi.analyseVoyage, "function");
  assert.equal(app.ajrmMarineVoyageReviewApi.status().capabilities.runtimeAnalysisApi, true);
  plugin.stop();
  assert.equal(app.ajrmMarineVoyageReviewApi, undefined);
});

test("track distance uses nautical miles", () => {
  const nm = _private.trackDistanceNm([
    { lat: 56.0, lon: -5.0, ts: "2026-06-22T00:00:00.000Z" },
    { lat: 56.00833, lon: -5.0, ts: "2026-06-22T00:10:00.000Z" },
  ]);
  assert.ok(nm > 0.49 && nm < 0.51);
});

test("prefers vessels.self over higher-volume target position samples", () => {
  const counts = new Map([
    ["vessels.target", 100],
    ["vessels.self", 10],
  ]);
  assert.equal(_private.chooseOwnContext(counts), "vessels.self");
});

test("falls back to the context with most samples when vessels.self is absent", () => {
  const counts = new Map([
    ["vessels.target.low", 4],
    ["vessels.target.high", 10],
  ]);
  assert.equal(_private.chooseOwnContext(counts), "vessels.target.high");
});

test("prefers the explicit Capture own-vessel context", () => {
  const counts = new Map([
    ["vessels.urn:mrn:imo:mmsi:235008635", 2],
    ["vessels.urn:mrn:imo:mmsi:999999999", 20],
  ]);
  assert.equal(
    _private.chooseOwnContext(counts, "vessels.urn:mrn:imo:mmsi:235008635"),
    "vessels.urn:mrn:imo:mmsi:235008635",
  );
});

test("hourly markers use nearest track point", () => {
  const markers = _private.hourlyMarkers([
    { lat: 56.0, lon: -5.0, ts: "2026-06-22T12:30:00.000Z" },
    { lat: 56.1, lon: -5.1, ts: "2026-06-22T13:02:00.000Z" },
    { lat: 56.2, lon: -5.2, ts: "2026-06-22T14:01:00.000Z" },
  ]);
  assert.equal(markers.length, 2);
  assert.equal(markers[0].label, "13:00");
  assert.equal(markers[0].lat, 56.1);
});

test("generates GPX 1.1 track with escaped metadata", () => {
  const gpx = _private.generateGpx({
    id: "voyage-&-test",
    fileName: "voyage-test.zip",
    comment: "Craobh < Oban",
    summary: {
      startedAt: "2026-06-22T12:00:00.000Z",
      stoppedAt: "2026-06-22T13:00:00.000Z",
      distanceNm: 6.25,
    },
    track: [
      { lat: 56.123456789, lon: -5.123456789, ts: "2026-06-22T12:00:00.000Z" },
      { lat: 56.223456789, lon: -5.223456789, ts: "2026-06-22T13:00:00.000Z" },
    ],
  });
  assert.match(gpx, /<gpx version="1.1"/);
  assert.match(gpx, /<name>voyage-&amp;-test<\/name>/);
  assert.match(gpx, /Craobh &lt; Oban/);
  assert.match(gpx, /<trkpt lat="56.1234568" lon="-5.1234568"><time>2026-06-22T12:00:00.000Z<\/time><\/trkpt>/);
});

test("GPX filename prefers voyage comment", () => {
  assert.equal(
    _private.defaultGpxFileName({ comment: "Craobh to Oban & back" }, "voyage-20260622.zip"),
    "Craobh-to-Oban-back.gpx",
  );
  assert.equal(
    _private.defaultGpxFileName({ comment: "" }, "voyage-20260622.zip"),
    "voyage-20260622.gpx",
  );
  assert.equal(
    _private.defaultGpxFileName({ comment: "" }, "capture-20260622T120000Z.jsonl.gz"),
    "capture-20260622T120000Z.gpx",
  );
});

test("voyage list includes comment from bundle index", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-viewer-list-"));
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-viewer-bundle-"));
  await fs.writeFile(
    path.join(bundleDir, "index.json"),
    JSON.stringify({
      comment: "Evening engine test",
      startedAt: "2026-06-22T19:57:47.000Z",
      stoppedAt: "2026-06-22T20:09:00.000Z",
      recomputedReplay: {
        kind: "recomputed-replay",
        parentVoyage: "voyage-parent.zip",
        rate: 1,
        sourcePolicy: {
          resolvedSensorSourceIds: ["YDEN.2"],
        },
        result: {
          coverage: {
            complete: true,
            preparedComplete: true,
            lastReason: "end of canonical input",
          },
          liveInputIsolation: { valid: true },
        },
      },
    }),
  );
  const zipPath = path.join(dir, "voyage-20260622T195747Z.zip");
  await writeZip(zipPath, bundleDir, ["index.json"]);

  const voyages = await _private.listVoyages(dir);
  assert.equal(voyages.length, 1);
  assert.equal(voyages[0].fileName, "voyage-20260622T195747Z.zip");
  assert.equal(voyages[0].comment, "Evening engine test");
  assert.equal(voyages[0].startedAt, "2026-06-22T19:57:47.000Z");
  assert.equal(voyages[0].stoppedAt, "2026-06-22T20:09:00.000Z");
  assert.equal(voyages[0].recomputedReplay.parentVoyage, "voyage-parent.zip");
  assert.equal(voyages[0].recomputedReplay.coverage.complete, true);
  assert.equal(voyages[0].recomputedReplay.liveInputIsolation.valid, true);
});

test("analyses current canonical-input voyage bundles without legacy capture files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-viewer-canonical-"));
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-viewer-canonical-bundle-"));
  const inputRelativePath = path.join("input", "yden-input.jsonl");
  await fs.mkdir(path.join(bundleDir, "input"), { recursive: true });
  const records = [
    captureRecord("2026-08-04T05:29:39.837Z", 56.0, -5.0, 2),
    captureRecord("2026-08-04T05:39:39.837Z", 56.00833, -5.0, 3),
  ].map((record, index) => ({
    contract: "ajrm-marine-canonical-input-v1",
    schemaVersion: 1,
    elapsedMs: index * 600_000,
    ...record,
  }));
  await fs.writeFile(
    path.join(bundleDir, inputRelativePath),
    records.map((record) => JSON.stringify(record)).join("\n"),
  );
  await fs.writeFile(
    path.join(bundleDir, "index.json"),
    JSON.stringify({
      id: "voyage-20260804T052939Z",
      version: "0.7.11",
      startedAt: "2026-08-04T05:29:39.837Z",
      stoppedAt: "2026-08-04T05:39:39.837Z",
      canonicalInput: {
        contract: "ajrm-marine-canonical-input-v1",
        schemaVersion: 1,
        fileName: "input/yden-input.jsonl",
        records: records.length,
        complete: true,
      },
    }),
  );
  const zipPath = path.join(dir, "voyage-20260804T052939Z.zip");
  await writeZip(zipPath, bundleDir, ["index.json", inputRelativePath]);

  const analysis = await _private.analyseVoyage(zipPath, { maxTrackPoints: 100 });

  assert.equal(analysis.sourceKind, "voyages");
  assert.equal(analysis.summary.trackPoints, 2);
  assert.ok(analysis.summary.distanceNm > 0.49 && analysis.summary.distanceNm < 0.51);
});

test("uses current Capture snapshots for Traffic and GPS Integrity review evidence", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-viewer-snapshot-review-"));
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-viewer-snapshot-review-bundle-"));
  const inputRelativePath = path.join("input", "yden-input.jsonl");
  const startSnapshotRelativePath = path.join("snapshots", "start.json");
  const snapshotRelativePath = path.join("snapshots", "stop.json");
  await fs.mkdir(path.join(bundleDir, "input"), { recursive: true });
  await fs.mkdir(path.join(bundleDir, "snapshots"), { recursive: true });
  const start = captureRecord("2026-08-04T09:48:10.000Z", 56.0, -5.0, 2);
  start.delta.updates[0].values.push({
    path: "environment.depth.belowTransducer",
    value: 12,
  });
  const stop = captureRecord("2026-08-04T09:54:37.000Z", 56.00833, -5.0, 3);
  const records = [start, stop].map((record, index) => ({
    contract: "ajrm-marine-canonical-input-v1",
    schemaVersion: 1,
    elapsedMs: index * 387_000,
    ...record,
  }));
  await fs.writeFile(
    path.join(bundleDir, inputRelativePath),
    records.map((record) => JSON.stringify(record)).join("\n"),
  );
  await fs.writeFile(
    path.join(bundleDir, startSnapshotRelativePath),
    JSON.stringify({
      timestamp: "2026-08-04T09:48:10.100Z",
      suiteDiagnostics: {
        ajrmMarineGpsIntegrity: {
          navigationIntegrity: {
            value: {
              timestamp: "2026-08-04T09:48:10.083Z",
              trust: "normal",
              acceptedGps: true,
              counters: {
                evaluations: 23,
                acceptedFixes: 23,
                rejectedFixes: 0,
                positionJumps: 0,
                lostFixes: 0,
                degradedSignals: 0,
                drDiscrepancies: 0,
              },
              gps: { fixValid: true, positionAgeSeconds: 0.8 },
            },
          },
        },
      },
    }),
  );
  await fs.writeFile(
    path.join(bundleDir, snapshotRelativePath),
    JSON.stringify({
      timestamp: "2026-08-04T09:54:37.100Z",
      suiteDiagnostics: {
        ajrmMarineGpsIntegrity: {
          navigationIntegrity: {
            value: {
              timestamp: "2026-08-04T09:54:37.083Z",
              trust: "normal",
              notificationState: "normal",
              acceptedGps: true,
              reasons: [],
              counters: {
                evaluations: 407,
                acceptedFixes: 407,
                rejectedFixes: 0,
                positionJumps: 0,
                lostFixes: 0,
                degradedSignals: 0,
                drDiscrepancies: 0,
              },
              gps: { fixValid: true, positionAgeSeconds: 0.9 },
              integrityDeadReckoning: {
                source: "heading-stw",
                uncertaintyRadiusMeters: 285,
                assurance: "reduced",
                comparisonAvailable: false,
                unavailableReason: "Independent current and leeway are unavailable.",
              },
            },
          },
        },
        trafficCore: {
          targets: {
            value: {
              contract: "ajrm-marine-traffic-targets",
              contractVersion: 1,
              generatedAt: "2026-08-04T09:54:37.090Z",
              targets: [
                {
                  id: "vessels.urn:mrn:imo:mmsi:235900004",
                  mmsi: "235900004",
                  name: "SIM COASTAL SUPPLY",
                  encounter: {
                    state: "warn",
                    vesselSize: "large",
                    cpa: 1910,
                    tcpa: 733,
                    targetPositionProjection: {
                      usable: true,
                      projected: true,
                      ageMs: 211,
                      projectionSeconds: 5.2,
                    },
                  },
                  freshness: { stale: false },
                },
                {
                  id: "vessels.urn:mrn:imo:mmsi:235900005",
                  mmsi: "235900005",
                  name: "SIM HARBOUR TUG",
                  encounter: {
                    state: "normal",
                    vesselSize: "medium",
                    targetPositionProjection: {
                      usable: true,
                      projected: true,
                      ageMs: 180,
                      projectionSeconds: 5.1,
                    },
                  },
                  freshness: { stale: false },
                },
              ],
            },
          },
        },
      },
    }),
  );
  await fs.writeFile(
    path.join(bundleDir, "index.json"),
    JSON.stringify({
      id: "voyage-20260804T094809Z",
      startedAt: "2026-08-04T09:48:09.387Z",
      stoppedAt: "2026-08-04T09:54:37.432Z",
      canonicalInput: {
        contract: "ajrm-marine-canonical-input-v1",
        schemaVersion: 1,
        fileName: "input/yden-input.jsonl",
        records: records.length,
        complete: true,
      },
    }),
  );
  const zipPath = path.join(dir, "voyage-20260804T094809Z.zip");
  await writeZip(zipPath, bundleDir, [
    "index.json",
    inputRelativePath,
    startSnapshotRelativePath,
    snapshotRelativePath,
  ]);

  const analysis = await _private.analyseVoyage(zipPath, { maxTrackPoints: 100 });

  assert.equal(analysis.gpsIntegrity.summary.available, true);
  assert.equal(analysis.gpsIntegrity.summary.evaluations, 384);
  assert.equal(analysis.traffic.available, true);
  assert.equal(analysis.traffic.vesselsEncountered, 2);
  assert.equal(analysis.traffic.advisories, 1);
  assert.equal(analysis.review.voyageStatus, "green");
  for (const title of [
    "No traffic alert history",
    "No GPS Integrity data",
    "Independent DR comparison unavailable",
    "Independent DR comparison not plotted",
    "No DR plot fixes bundled",
  ]) {
    assert.ok(!analysis.review.findings.some((finding) => finding.title === title));
  }
});

test("reviews report-only BITE voyages with an empty canonical input", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-viewer-bite-only-"));
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-viewer-bite-only-bundle-"));
  const inputRelativePath = path.join("input", "yden-input.jsonl");
  const biteRelativePath = path.join("system", "bite-reports", "run-all.json");
  await fs.mkdir(path.join(bundleDir, "input"), { recursive: true });
  await fs.mkdir(path.join(bundleDir, "system", "bite-reports"), { recursive: true });
  await fs.writeFile(path.join(bundleDir, inputRelativePath), "");
  await fs.writeFile(
    path.join(bundleDir, biteRelativePath),
    JSON.stringify({
      scenario: "run-all",
      title: "AJRM Marine BITE Run all",
      result: "pass",
      startedAt: "2026-08-03T20:48:54.000Z",
      finishedAt: "2026-08-03T20:53:19.000Z",
    }),
  );
  await fs.writeFile(
    path.join(bundleDir, "index.json"),
    JSON.stringify({
      id: "voyage-20260803T204848Z",
      comment: "AJRM Marine BITE Run all",
      startedAt: "2026-08-03T20:48:48.538Z",
      stoppedAt: "2026-08-03T20:53:20.409Z",
      startReason: "BITE run all",
      stopReason: "BITE run all complete",
      canonicalInput: {
        contract: "ajrm-marine-canonical-input-v1",
        schemaVersion: 1,
        fileName: "input/yden-input.jsonl",
        records: 0,
        bytes: 0,
        complete: true,
      },
    }),
  );
  const zipPath = path.join(dir, "voyage-20260803T204848Z.zip");
  await writeZip(zipPath, bundleDir, ["index.json", inputRelativePath, biteRelativePath]);

  const analysis = await _private.analyseVoyage(zipPath, { maxTrackPoints: 100 });

  assert.equal(analysis.ownContext, null);
  assert.equal(analysis.summary.trackPoints, 0);
  assert.equal(analysis.review.softwareStatus, "green");
  assert.equal(analysis.review.bite.passed, 1);
  assert.ok(analysis.review.findings.some((finding) => finding.title === "No own-vessel track"));
});

test("analyses converted canonical voyage bundles", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-viewer-reference-"));
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-viewer-reference-bundle-"));
  const logFile = path.join(dir, "capture-2026-06-22T120000Z.jsonl");
  const records = [
    captureRecord("2026-06-22T12:00:00.000Z", 56.0, -5.0, 2),
    captureRecord("2026-06-22T12:10:00.000Z", 56.00833, -5.0, 3),
  ];
  await fs.writeFile(logFile, records.map((record) => JSON.stringify(record)).join("\n"));
  await fs.writeFile(
    path.join(bundleDir, "index.json"),
    JSON.stringify({
      id: "voyage-20260622T120000Z",
      comment: "Reference voyage",
      startedAt: "2026-06-22T12:00:00.000Z",
      stoppedAt: "2026-06-22T12:10:00.000Z",
      captureFiles: [],
      captureReferences: [
        {
          fileName: path.basename(logFile),
          sourcePath: logFile,
          from: "2026-06-22T12:00:00.000Z",
          to: "2026-06-22T12:10:00.000Z",
        },
      ],
    }),
  );
  const zipPath = path.join(dir, "voyage-20260622T120000Z.zip");
  await writeZip(zipPath, bundleDir, ["index.json"]);

  const analysis = await _private.analyseVoyage(zipPath, {
    maxTrackPoints: 100,
    options: { logDirectory: dir },
  });
  assert.equal(analysis.sourceKind, "voyages");
  assert.equal(analysis.summary.trackPoints, 2);
  assert.ok(analysis.summary.distanceNm > 0.49 && analysis.summary.distanceNm < 0.51);
  assert.equal(analysis.review.schemaVersion, 2);
  assert.equal(analysis.review.softwareStatus, null);
  assert.ok(!analysis.review.findings.some((finding) => finding.category === "software"));
  assert.doesNotMatch(analysis.review.headline, /BITE|software-chain/);
  assert.match(analysis.review.headline, /Voyage data AMBER: .+/);
  assert.doesNotMatch(analysis.review.headline, /reviewed with cautions/);
  assert.ok(analysis.review.conclusion.includes("Voyage data has cautions"));
  assert.ok(analysis.review.highlights.some((highlight) => highlight.label === "Distance" && highlight.value === "0.5 NM"));
  assert.ok(analysis.review.highlights.some((highlight) => highlight.label === "Track points" && highlight.value === "2"));
});

test("recomputed child review exposes incomplete or contaminated lineage", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-viewer-recomputed-"));
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-viewer-recomputed-bundle-"));
  const logFile = path.join(dir, "capture-2026-07-27T120000Z.jsonl");
  await fs.writeFile(
    logFile,
    [
      captureRecord("2026-07-27T12:00:00.000Z", 56.0, -5.0, 2),
      captureRecord("2026-07-27T12:10:00.000Z", 56.00833, -5.0, 3),
    ].map((record) => JSON.stringify(record)).join("\n"),
  );
  await fs.writeFile(
    path.join(bundleDir, "index.json"),
    JSON.stringify({
      id: "voyage-recomputed",
      startedAt: "2026-07-27T12:00:00.000Z",
      stoppedAt: "2026-07-27T12:10:00.000Z",
      captureFiles: [],
      captureReferences: [{
        fileName: path.basename(logFile),
        sourcePath: logFile,
      }],
      recomputedReplay: {
        kind: "recomputed-replay",
        parentVoyage: "voyage-parent.zip",
        playbackMode: "sensor-only",
        rate: 1,
        sourcePolicy: {
          resolvedSensorSourceIds: ["YDEN.2", "YDEN.4"],
        },
        result: {
          coverage: {
            complete: true,
            preparedComplete: true,
            lastReason: "end of canonical input",
          },
          liveInputIsolation: {
            valid: false,
            physicalUpdatesSeen: 3,
            sources: { "YDEN.99": 3 },
          },
        },
      },
    }),
  );
  const zipPath = path.join(dir, "voyage-recomputed.zip");
  await writeZip(zipPath, bundleDir, ["index.json"]);

  const analysis = await _private.analyseVoyage(zipPath, {
    maxTrackPoints: 100,
    options: { logDirectory: dir },
  });
  assert.equal(analysis.recomputedReplay.parentVoyage, "voyage-parent.zip");
  assert.equal(analysis.recomputedReplay.coverage.complete, true);
  assert.equal(analysis.recomputedReplay.liveInputIsolation.valid, false);
  assert.equal(analysis.review.softwareStatus, "red");
  assert.ok(analysis.review.findings.some((finding) =>
    finding.title === "Live sensor contamination detected" &&
    finding.level === "red"
  ));
  assert.ok(analysis.review.highlights.some((highlight) =>
    highlight.label === "Recomputed replay" &&
    highlight.value === "live-input contamination"
  ));
});

test("verifies durable recomputed completion separately from live-input isolation", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-viewer-verified-recomputed-"));
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-viewer-verified-recomputed-bundle-"));
  const voyageId = "voyage-recomputed-verified";
  const outputRelativePath = path.join("recomputed", "output.jsonl");
  const outputContent = [
    captureRecord("2026-07-30T14:00:00.000Z", 56.0, -5.0, 2),
    captureRecord("2026-07-30T14:01:00.000Z", 56.001, -5.0, 2),
  ].map((record) => JSON.stringify(record)).join("\n");
  const output = {
    contract: "ajrm-marine-recomputed-output-v1",
    schemaVersion: 1,
    fileName: "recomputed/output.jsonl",
    records: 2,
    bytes: Buffer.byteLength(outputContent),
    writeErrors: 0,
    complete: true,
  };
  const result = {
    contract: "ajrm-marine-replay-result-v1",
    schemaVersion: 1,
    timing: { valid: true },
    coverage: {
      complete: true,
      preparedComplete: true,
      lastReason: "end of canonical input",
    },
    output,
    liveInputIsolation: {
      valid: true,
      physicalUpdatesSeen: 0,
      sources: {},
    },
  };
  const recomputedReplay = {
    kind: "recomputed-replay",
    parentVoyage: "voyage-parent.zip",
    complete: true,
    incomplete: false,
    verified: true,
    status: "complete",
    result,
  };
  await fs.mkdir(path.join(bundleDir, "recomputed"), { recursive: true });
  await fs.mkdir(path.join(bundleDir, "system"), { recursive: true });
  await fs.writeFile(path.join(bundleDir, outputRelativePath), outputContent);
  await fs.writeFile(
    path.join(bundleDir, "index.json"),
    JSON.stringify({
      id: voyageId,
      incomplete: false,
      recomputationVerified: true,
      startedAt: "2026-07-30T14:00:00.000Z",
      stoppedAt: "2026-07-30T14:01:00.000Z",
      recomputedOutput: output,
      recomputedReplay,
    }),
  );
  await fs.writeFile(
    path.join(bundleDir, "system", "recomputed-replay-completion.json"),
    JSON.stringify({
      contract: "ajrm-marine-recomputed-completion",
      contractVersion: 1,
      voyageId,
      completionConfirmed: true,
      verified: true,
      recomputationVerified: true,
      recomputedReplay,
      replayResult: result,
    }),
  );
  const zipPath = path.join(dir, `${voyageId}.zip`);
  await writeZip(zipPath, bundleDir, [
    "index.json",
    outputRelativePath,
    "system/recomputed-replay-completion.json",
  ]);

  const analysis = await _private.analyseVoyage(zipPath, {
    maxTrackPoints: 100,
    options: { logDirectory: dir },
  });
  assert.equal(analysis.replayVerification.checkpointValid, true);
  assert.equal(analysis.replayVerification.coverageComplete, true);
  assert.equal(analysis.replayVerification.outputComplete, true);
  assert.equal(analysis.replayVerification.timingValid, true);
  assert.equal(analysis.replayVerification.completionVerified, true);
  assert.equal(analysis.replayVerification.liveInputIsolationValid, true);
  assert.ok(analysis.review.findings.some((finding) =>
    finding.title === "Recomputed result packaging verified" &&
    finding.level === "green"
  ));
  assert.ok(analysis.review.findings.some((finding) =>
    finding.title === "Recomputed replay lineage verified" &&
    finding.level === "green"
  ));
});

test("summarises GPS Integrity events from captured Signal K state", async () => {
  const records = [
    captureRecord("2026-06-22T12:00:00.000Z", 56.0, -5.0, 2),
    gpsIntegrityRecord("2026-06-22T12:00:00.000Z", {
      trust: "normal",
      acceptedGps: true,
      counters: { evaluations: 1, acceptedFixes: 1, rejectedFixes: 0, positionJumps: 0, lostFixes: 0, degradedSignals: 0, drDiscrepancies: 0 },
    }),
    captureRecord("2026-06-22T12:01:00.000Z", 56.001, -5.0, 2),
    gpsIntegrityRecord("2026-06-22T12:01:00.000Z", {
      trust: "lost",
      acceptedGps: false,
      reasons: ["GPS source reports no fix."],
      gps: { fixValid: false, explicitGpsUnavailable: true, positionAgeSeconds: null },
      counters: { evaluations: 2, acceptedFixes: 1, rejectedFixes: 0, positionJumps: 0, lostFixes: 1, degradedSignals: 0, drDiscrepancies: 0 },
      operationalDeadReckoning: { position: { latitude: 56.001, longitude: -5 }, source: "heading-stw-current", uncertaintyRadiusMeters: 40, ageSeconds: 60 },
    }),
    gpsIntegrityRecord("2026-06-22T12:03:00.000Z", {
      trust: "normal",
      acceptedGps: true,
      gps: { fixValid: true, positionAgeSeconds: 0 },
      counters: { evaluations: 3, acceptedFixes: 2, rejectedFixes: 0, positionJumps: 0, lostFixes: 1, degradedSignals: 0, drDiscrepancies: 0 },
      operationalDeadReckoning: { position: { latitude: 56.003, longitude: -5 }, source: "gps-locked", uncertaintyRadiusMeters: 10, ageSeconds: 0 },
    }),
    captureRecord("2026-06-22T12:10:00.000Z", 56.00833, -5.0, 3),
    gpsIntegrityRecord("2026-06-22T12:10:00.000Z", {
      trust: "suspect",
      acceptedGps: false,
      reasons: ["Position jump implies 486.4 kn over ground."],
      counters: { evaluations: 4, acceptedFixes: 2, rejectedFixes: 1, positionJumps: 1, lostFixes: 1, degradedSignals: 0, drDiscrepancies: 1 },
      diagnostics: {
        contract: "ajrm-marine-gps-integrity-diagnostics",
        decision: { positionJumpRejected: true, drDiscrepancyActive: true },
        thresholds: { gpsLostSeconds: 15, warningDrDiscrepancyMeters: 50, alarmDrDiscrepancyMeters: 150 },
      },
      current: {
        available: false,
        source: null,
        origin: null,
        gpsDependent: null,
        driftKnots: null,
        setTrueDegrees: 0,
      },
      operationalDeadReckoning: {
        position: { latitude: 56.008, longitude: -5 },
        source: "gps-locked",
        uncertaintyRadiusMeters: 75,
        ageSeconds: 0,
        gpsDependent: true,
        leewayStatus: "unknown",
        currentOrigin: "none",
      },
      integrityDeadReckoning: {
        position: { latitude: 56.007, longitude: -5 },
        source: "heading-stw",
        uncertaintyRadiusMeters: 95,
        ageSeconds: 300,
        assurance: "reduced",
        comparisonAvailable: false,
        unavailableReason: "Independent current and leeway evidence are unavailable.",
        gpsDependent: false,
        leewayStatus: "unknown",
        currentOrigin: null,
        provenance: {
          heading: {
            source: "YDEN.4",
            method: "magnetic-heading-plus-wmm",
            gpsDependent: false,
          },
        },
      },
      integrityAssurance: {
        status: "reduced",
        comparisonAvailable: false,
        reason: "Independent current and leeway evidence are unavailable.",
        leewayStatus: "unknown",
      },
      navigationProvenance: {
        navigationReference: {
          contract: "ajrm-marine-navigation-reference",
          schemaVersion: 1,
          status: "heading",
          clockReference: {
            kind: "heading",
            source: "YDEN.4",
            method: "magnetic-heading-plus-wmm",
            ageMs: 0,
            uncertaintyRad: 0.087,
            gpsDependent: false,
          },
        },
      },
    }),
  ];
  const analysis = await analyseCanonicalRecords(records, "gps-integrity");

  assert.equal(analysis.gpsIntegrity.samples, 4);
  assert.equal(analysis.summary.gpsIntegrity.available, true);
  assert.equal(analysis.summary.gpsIntegrity.lostFixes, 1);
  assert.equal(analysis.summary.gpsIntegrity.lostPeriods, 1);
  assert.equal(analysis.summary.gpsIntegrity.totalLostSeconds, 120);
  assert.equal(analysis.summary.gpsIntegrity.positionJumps, 1);
  assert.equal(analysis.summary.gpsIntegrity.rejectedFixes, 1);
  assert.equal(analysis.summary.gpsIntegrity.drDiscrepancies, 1);
  assert.equal(analysis.summary.gpsIntegrity.maxOperationalUncertaintyMeters, 75);
  assert.equal(analysis.summary.gpsIntegrity.finalIntegrityAssurance, "reduced");
  assert.equal(analysis.summary.gpsIntegrity.finalComparisonAvailable, false);
  assert.equal(analysis.summary.gpsIntegrity.finalOperationalGpsDependent, true);
  assert.equal(analysis.summary.gpsIntegrity.finalIntegrityGpsDependent, false);
  assert.equal(
    analysis.summary.gpsIntegrity.navigationReference.clockReference.source,
    "YDEN.4",
  );
  assert.equal(analysis.gpsIntegrity.provenance.current.driftKnots, null);
  assert.equal(analysis.gpsIntegrity.provenance.current.setTrueDegrees, 0);
  assert.ok(
    !analysis.review.findings.some(
      (finding) => finding.title === "Independent DR comparison unavailable",
    ),
  );
  assert.ok(analysis.review.paragraphs.some((paragraph) =>
    paragraph.includes("independent GPS/DR comparison was unavailable")
  ));
  assert.ok(analysis.gpsIntegrity.events.some((event) => event.type === "gps-lost"));
  assert.ok(analysis.gpsIntegrity.events.some((event) => event.type === "gps-recovered"));
  assert.ok(analysis.gpsIntegrity.events.some((event) => event.type === "position-jump"));
});

test("builds English voyage review with separate software and voyage-data lights", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-viewer-review-"));
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-viewer-review-bundle-"));
  const logFile = path.join(dir, "capture-2026-06-22T120000Z.jsonl");
  const records = [
    captureRecord("2026-06-22T12:00:00.000Z", 56.0, -5.0, 2),
    gpsIntegrityRecord("2026-06-22T12:00:00.000Z", {
      trust: "normal",
      acceptedGps: true,
      counters: { evaluations: 1, acceptedFixes: 1, rejectedFixes: 0, positionJumps: 0, lostFixes: 0, degradedSignals: 0, drDiscrepancies: 0 },
    }),
    trafficProjectionRecord("2026-06-22T12:02:00.000Z", [
      trafficEvent({
        eventId: "traffic-advisory-111-1",
        label: "Traffic advisory",
        title: "HARBOUR TUG",
        mmsi: "235900001",
        message: "Traffic advisory for HARBOUR TUG.",
        vesselSize: "medium",
        cpaMeters: 150,
      }),
      trafficEvent({
        eventId: "traffic-collision-222-1",
        label: "Collision alarm",
        title: "FAST FERRY ONE",
        mmsi: "235900002",
        message: "Collision alarm for FAST FERRY ONE.",
        vesselSize: "large",
        cpaMeters: 80,
        priority: "danger",
      }),
    ]),
    trafficProjectionRecord("2026-06-22T12:03:00.000Z", [
      trafficEvent({
        eventId: "traffic-collision-222-1",
        label: "Collision alarm",
        title: "FAST FERRY ONE",
        mmsi: "235900002",
        message: "Collision alarm wording changed without changing context.",
        vesselSize: "large",
        cpaMeters: 80,
        priority: "danger",
      }),
    ]),
    trafficTargetsRecord("2026-06-22T12:03:01.000Z", [{
      encounter: {
        announcementLeadSeconds: 8,
        targetPositionProjection: {
          usable: true,
          projected: true,
          ageMs: 42000,
          projectionSeconds: 50,
          reason: "projected",
        },
      },
      freshness: { stale: false },
    }]),
    captureRecord("2026-06-22T12:10:00.000Z", 56.00833, -5.0, 3),
  ];
  await fs.writeFile(logFile, records.map((record) => JSON.stringify(record)).join("\n"));
  await fs.mkdir(path.join(bundleDir, "system", "bite-reports"), { recursive: true });
  await fs.writeFile(
    path.join(bundleDir, "system", "bite-reports", "run-all.json"),
    JSON.stringify({
      reports: [
        {
          scenario: "traffic-audio-chain",
          title: "Traffic audio chain",
          result: "fail",
          startedAt: "2026-06-22T12:02:00.000Z",
          finishedAt: "2026-06-22T12:03:00.000Z",
          summary: "Traffic audio chain failed.",
          assertions: [
            { id: "traffic-alert", pass: true },
            { id: "audio-accepted", pass: false },
          ],
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(bundleDir, "index.json"),
    JSON.stringify({
      id: "voyage-20260622T120000Z",
      comment: "Review test",
      startedAt: "2026-06-22T12:00:00.000Z",
      stoppedAt: "2026-06-22T12:10:00.000Z",
      captureFiles: [],
      captureReferences: [{ fileName: path.basename(logFile), sourcePath: logFile }],
    }),
  );
  const zipPath = path.join(dir, "voyage-20260622T120000Z.zip");
  await writeZip(zipPath, bundleDir, ["index.json", "system/bite-reports/run-all.json"]);

  const analysis = await _private.analyseVoyage(zipPath, {
    maxTrackPoints: 100,
    options: { logDirectory: dir },
  });

  assert.equal(analysis.review.softwareStatus, "red");
  assert.equal(analysis.review.voyageStatus, "green");
  assert.equal(analysis.review.bite.failed, 1);
  assert.equal(analysis.traffic.vesselsEncountered, 2);
  assert.equal(analysis.traffic.bySize.medium, 1);
  assert.equal(analysis.traffic.bySize.large, 1);
  assert.equal(analysis.traffic.advisories, 1);
  assert.equal(analysis.traffic.collisionAlerts, 1);
  assert.equal(analysis.traffic.closestCpaMeters, 80);
  assert.equal(analysis.traffic.projection.targetObservations, 1);
  assert.equal(analysis.traffic.projection.projectedPositions, 1);
  assert.equal(analysis.traffic.projection.maxMeasurementAgeSeconds, 42);
  assert.equal(analysis.traffic.projection.maxProjectionSeconds, 50);
  assert.equal(analysis.traffic.projection.maxAnnouncementLeadSeconds, 8);
  assert.match(analysis.review.headline, /Software RED, voyage data GREEN/);
  assert.match(analysis.review.headline, /software: Built-in test failure/);
  assert.doesNotMatch(analysis.review.headline, /Collision alerts recorded/);
  assert.ok(analysis.review.conclusion.includes("Software checks failed"));
  assert.ok(analysis.review.highlights.some((highlight) => highlight.label === "Traffic" && highlight.value.includes("2 vessels")));
  assert.ok(analysis.review.highlights.some((highlight) => highlight.label === "GPS Integrity" && highlight.value === "healthy"));
  assert.ok(analysis.review.paragraphs.some((paragraph) => paragraph.includes("Review test")));
  assert.ok(analysis.review.paragraphs.some((paragraph) => paragraph.includes("deliberately inject")));
  assert.ok(analysis.review.paragraphs.some((paragraph) => paragraph.includes("2 vessels encountered")));
  assert.ok(analysis.review.findings.some((finding) => finding.category === "software" && finding.level === "red"));
  assert.ok(analysis.review.findings.some((finding) => finding.title === "Traffic evidence reviewed" && finding.level === "green"));
  assert.ok(analysis.review.findings.some((finding) => finding.title === "Traffic projection evidence reviewed" && finding.level === "green"));
  assert.ok(analysis.review.findings.some((finding) => finding.category === "voyage"));
});

test("voyage review scores the latest BITE run instead of stale bundled failures", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-viewer-latest-bite-"));
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-viewer-latest-bite-bundle-"));
  const logFile = path.join(dir, "capture-2026-07-06T200000Z.jsonl");
  const records = [
    captureRecord("2026-07-06T20:19:29.000Z", 56.0, -5.0, 2),
    captureRecord("2026-07-06T20:24:01.000Z", 56.01, -5.0, 2),
  ];
  await fs.writeFile(logFile, records.map((record) => JSON.stringify(record)).join("\n"));
  await fs.mkdir(path.join(bundleDir, "system", "bite-reports"), { recursive: true });
  const biteReports = [
    [
      "2026-07-06T191000000Z-0001-old-failure.json",
      {
        scenario: "audio-output-summary",
        result: "fail",
        startedAt: "2026-07-06T19:10:00.000Z",
        finishedAt: "2026-07-06T19:10:10.000Z",
        summary: "Old audio failure.",
        assertions: [{ id: "summary-audio-completed", pass: false }],
      },
    ],
    [
      "2026-07-06T191100000Z-0002-run-all-fail.json",
      {
        scenario: "run-all",
        result: "fail",
        startedAt: "2026-07-06T19:09:00.000Z",
        finishedAt: "2026-07-06T19:11:00.000Z",
        summary: "1 of 79 BITE tests failed.",
      },
    ],
    [
      "2026-07-06T202300000Z-0003-current-check-pass.json",
      {
        scenario: "traffic-audio-chain",
        result: "pass",
        startedAt: "2026-07-06T20:23:00.000Z",
        finishedAt: "2026-07-06T20:23:10.000Z",
        summary: "Current traffic audio check passed.",
        assertions: [{ id: "audio-accepted", pass: true }],
      },
    ],
    [
      "2026-07-06T202401000Z-0004-run-all-pass.json",
      {
        scenario: "run-all",
        result: "pass",
        startedAt: "2026-07-06T20:19:22.000Z",
        finishedAt: "2026-07-06T20:24:01.000Z",
        summary: "79 BITE tests passed.",
        reports: [
          {
            scenario: "traffic-audio-chain",
            result: "pass",
            startedAt: "2026-07-06T20:23:00.000Z",
            finishedAt: "2026-07-06T20:23:10.000Z",
            summary: "Current traffic audio check passed.",
            assertions: [{ id: "audio-accepted", pass: true }],
          },
        ],
      },
    ],
  ];
  for (const [name, report] of biteReports) {
    await fs.writeFile(path.join(bundleDir, "system", "bite-reports", name), JSON.stringify(report));
  }
  await fs.writeFile(
    path.join(bundleDir, "index.json"),
    JSON.stringify({
      id: "voyage-20260706T201929Z",
      comment: "Latest BITE review",
      startedAt: "2026-07-06T20:19:29.000Z",
      stoppedAt: "2026-07-06T20:24:01.000Z",
      captureReferences: [{ fileName: path.basename(logFile), sourcePath: logFile }],
    }),
  );
  const zipPath = path.join(dir, "voyage-20260706T201929Z.zip");
  await writeZip(zipPath, bundleDir, ["index.json", ...biteReports.map(([name]) => `system/bite-reports/${name}`)]);

  const analysis = await _private.analyseVoyage(zipPath, {
    maxTrackPoints: 100,
    options: { logDirectory: dir },
  });

  assert.equal(analysis.review.softwareStatus, "green");
  assert.equal(analysis.review.bite.failed, 0);
  assert.equal(analysis.review.bite.total, 1);
  assert.equal(analysis.review.bite.passed, 1);
  assert.ok(!analysis.review.findings.some((finding) => finding.category === "software" && finding.level === "red"));
});

test("voyage review ignores BITE reports that predate the voyage window", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-viewer-stale-bite-"));
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-viewer-stale-bite-bundle-"));
  const logFile = path.join(dir, "capture-2026-07-06T204122Z.jsonl");
  const records = [
    captureRecord("2026-07-06T20:41:22.000Z", 56.0, -5.0, 2),
    captureRecord("2026-07-06T20:51:22.000Z", 56.01, -5.0, 2),
  ];
  await fs.writeFile(logFile, records.map((record) => JSON.stringify(record)).join("\n"));
  await fs.mkdir(path.join(bundleDir, "system", "bite-reports"), { recursive: true });
  await fs.writeFile(
    path.join(bundleDir, "system", "bite-reports", "2026-07-06T202401000Z-0080-run-all-pass.json"),
    JSON.stringify({
      scenario: "run-all",
      result: "pass",
      startedAt: "2026-07-06T20:19:22.000Z",
      finishedAt: "2026-07-06T20:24:01.000Z",
      summary: "79 BITE tests passed.",
      reports: [
        {
          scenario: "traffic-audio-chain",
          result: "pass",
          startedAt: "2026-07-06T20:19:30.000Z",
          finishedAt: "2026-07-06T20:19:40.000Z",
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(bundleDir, "index.json"),
    JSON.stringify({
      id: "voyage-20260706T204122Z",
      comment: "Soak Test",
      startedAt: "2026-07-06T20:41:22.000Z",
      stoppedAt: "2026-07-06T20:51:22.000Z",
      captureReferences: [{ fileName: path.basename(logFile), sourcePath: logFile }],
    }),
  );
  const zipPath = path.join(dir, "voyage-20260706T204122Z.zip");
  await writeZip(zipPath, bundleDir, [
    "index.json",
    "system/bite-reports/2026-07-06T202401000Z-0080-run-all-pass.json",
  ]);

  const analysis = await _private.analyseVoyage(zipPath, {
    maxTrackPoints: 100,
    options: { logDirectory: dir },
  });

  assert.equal(analysis.review.bite.available, false);
  assert.equal(analysis.review.softwareStatus, null);
  assert.ok(!analysis.review.paragraphs.some((paragraph) => paragraph.includes("BITE")));
  assert.ok(!analysis.review.findings.some((finding) => finding.category === "software"));
});

test("analyses bundled DR track overlay samples", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-viewer-dr-track-"));
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-viewer-dr-track-bundle-"));
  const logFile = path.join(dir, "capture-2026-06-22T120000Z.jsonl");
  const records = [
    captureRecord("2026-06-22T12:00:00.000Z", 56.0, -5.0, 2),
    captureRecord("2026-06-22T12:10:00.000Z", 56.00833, -5.0, 3),
  ];
  await fs.writeFile(logFile, records.map((record) => JSON.stringify(record)).join("\n"));
  await fs.mkdir(path.join(bundleDir, "tracks"), { recursive: true });
  await fs.writeFile(
    path.join(bundleDir, "tracks", "dr-track.jsonl"),
    [
      {
        ts: "2026-06-22T12:00:00.000Z",
        trust: "normal",
        acceptedGps: true,
        gps: { lat: 56.0, lon: -5.0 },
        operational: { lat: 56.0, lon: -5.0, source: "gps-locked" },
      },
      {
        ts: "2026-06-22T12:05:00.000Z",
        trust: "lost",
        acceptedGps: false,
        operational: { lat: 56.004, lon: -5.0, source: "heading-stw-current" },
      },
      {
        ts: "2026-06-22T12:08:00.000Z",
        trust: "normal",
        acceptedGps: true,
        gps: { lat: 56.00833, lon: -5.0 },
        operational: {
          lat: 56.00833,
          lon: -5.0,
          source: "gps-locked",
          uncertaintyRadiusMeters: null,
          gpsDependent: true,
          leewayStatus: "unknown",
          currentOrigin: "none",
        },
        integrity: {
          lat: 56.008,
          lon: -5.0,
          source: "heading-stw",
          assurance: "reduced",
          comparisonAvailable: false,
          unavailableReason: "Independent current is unavailable.",
          gpsDependent: false,
          leewayStatus: "unknown",
          currentOrigin: null,
          provenance: {
            heading: {
              source: "YDEN.4",
              method: "magnetic-heading-plus-wmm",
              uncertaintyRad: 0.087,
              gpsDependent: false,
            },
          },
        },
        integrityAssurance: {
          status: "reduced",
          comparisonAvailable: false,
          reason: "Independent current is unavailable.",
          leewayStatus: "unknown",
        },
        navigationReference: {
          contract: "ajrm-marine-navigation-reference",
          schemaVersion: 1,
          status: "heading",
          clockReference: {
            kind: "heading",
            source: "YDEN.4",
            method: "magnetic-heading-plus-wmm",
            ageMs: 250,
            uncertaintyRad: 0.087,
            gpsDependent: false,
          },
        },
      },
      {
        ts: "2026-06-22T12:10:00.000Z",
        trust: "normal",
        acceptedGps: true,
        gps: { lat: 56.00833, lon: -5.0 },
        operational: {
          lat: 56.00833,
          lon: -5.0,
          source: "gps-locked",
          gpsDependent: true,
        },
        integrity: {
          lat: 56.007,
          lon: -5.0,
          source: "heading-stw-current",
          assurance: "full",
          comparisonAvailable: true,
          gpsDependent: false,
          leewayStatus: "known",
          currentOrigin: "independent-current",
        },
        integrityAssurance: {
          status: "full",
          comparisonAvailable: true,
          leewayStatus: "known",
        },
      },
    ].map((record) => JSON.stringify(record)).join("\n"),
  );
  await fs.writeFile(
    path.join(bundleDir, "index.json"),
    JSON.stringify({
      id: "voyage-20260622T120000Z",
      startedAt: "2026-06-22T12:00:00.000Z",
      stoppedAt: "2026-06-22T12:10:00.000Z",
      captureFiles: [],
      captureReferences: [{ fileName: path.basename(logFile), sourcePath: logFile }],
      drTrack: { fileName: "tracks/dr-track.jsonl" },
    }),
  );
  const zipPath = path.join(dir, "voyage-20260622T120000Z.zip");
  await writeZip(zipPath, bundleDir, ["index.json", "tracks/dr-track.jsonl"]);

  const analysis = await _private.analyseVoyage(zipPath, {
    maxTrackPoints: 100,
    options: { logDirectory: dir },
  });
  assert.equal(analysis.drTracks.source, "bundle");
  assert.equal(analysis.track.length, 4);
  assert.equal(analysis.track[1].lat, 56.004);
  assert.equal(analysis.drTracks.operational.length, 4);
  assert.equal(analysis.drTracks.gps.length, 3);
  assert.equal(analysis.drTracks.integrity.length, 1);
  assert.equal(analysis.drTracks.integrity[0].comparisonAvailable, true);
  assert.equal(analysis.drTracks.suppressedIntegrityComparisons, 1);
  assert.equal(
    analysis.drTracks.lastSuppressedIntegrityComparison.assurance.reason,
    "Independent current is unavailable.",
  );
  assert.equal(
    analysis.drTracks.provenance.navigationReference.clockReference.source,
    "YDEN.4",
  );
  assert.equal(
    analysis.drTracks.provenance.navigationReference.clockReference.ageMs,
    250,
  );
  assert.equal(
    analysis.drTracks.provenance.operational.gpsDependent,
    true,
  );
  assert.equal(analysis.drTracks.recoveryJumps.length, 1);
  assert.ok(analysis.drTracks.recoveryJumps[0].meters > 400);
});

test("analyses multiple voyage notes and captured routes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-viewer-notes-"));
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-viewer-notes-bundle-"));
  const logFile = path.join(dir, "capture-2026-06-22T120000Z.jsonl");
  const records = [
    captureRecord("2026-06-22T12:00:00.000Z", 56.0, -5.0, 2),
    captureRecord("2026-06-22T12:10:00.000Z", 56.00833, -5.0, 3),
  ];
  await fs.writeFile(logFile, records.map((record) => JSON.stringify(record)).join("\n"));
  await fs.mkdir(path.join(bundleDir, "observations", "evidence"), { recursive: true });
  await fs.writeFile(
    path.join(bundleDir, "observations", "evidence", "note-one.json"),
    JSON.stringify({ snapshot: { self: { position: { latitude: 56.004, longitude: -5.001 } } } }),
  );
  await fs.writeFile(
    path.join(bundleDir, "observations", "observations.jsonl"),
    [
      { id: "one", recordedAt: "2026-06-22T12:05:00.000Z", text: "First note", evidence: { fileName: "observations/evidence/note-one.json" } },
      { id: "two", recordedAt: "2026-06-22T12:06:00.000Z", text: "Second note" },
    ].map(JSON.stringify).join("\n"),
  );
  await fs.writeFile(
    path.join(bundleDir, "index.json"),
    JSON.stringify({
      id: "voyage-20260622T120000Z",
      startedAt: "2026-06-22T12:00:00.000Z",
      stoppedAt: "2026-06-22T12:10:00.000Z",
      captureFiles: [],
      captureReferences: [{ fileName: path.basename(logFile), sourcePath: logFile }],
      ownContext: "vessels.self",
      routeAtStart: {
        contract: "ajrm-marine-display-active-route-v1",
        resourceId: "route-one",
        resource: {
          name: "Test route",
          feature: { type: "Feature", geometry: { type: "LineString", coordinates: [[-5, 56], [-5.1, 56.1]] } },
        },
      },
    }),
  );
  const zipPath = path.join(dir, "voyage-20260622T120000Z.zip");
  await writeZip(zipPath, bundleDir, [
    "index.json",
    "observations/observations.jsonl",
    "observations/evidence/note-one.json",
  ]);

  const analysis = await _private.analyseVoyage(zipPath, {
    maxTrackPoints: 100,
    options: { logDirectory: dir },
  });
  assert.deepEqual(analysis.observations.map((note) => note.text), ["First note", "Second note"]);
  assert.deepEqual(analysis.observations[0].position, { lat: 56.004, lon: -5.001 });
  assert.equal(analysis.routes.length, 1);
  assert.equal(analysis.routes[0].name, "Test route");
  assert.equal(analysis.routes[0].points.length, 2);
});

test("analyses a canonical voyage track", async () => {
  const records = [
    captureRecord("2026-06-22T12:00:00.000Z", 56.0, -5.0, 2),
    captureRecord("2026-06-22T12:10:00.000Z", 56.00833, -5.0, 3),
  ];
  const analysis = await analyseCanonicalRecords(records, "track");
  assert.equal(analysis.sourceKind, "voyages");
  assert.equal(analysis.summary.trackPoints, 2);
  assert.ok(analysis.summary.distanceNm > 0.49 && analysis.summary.distanceNm < 0.51);
  assert.match(analysis.gpxUrl, /\/voyages\/voyage-track\.zip\/track\.gpx$/);
});

test("analyses explicitly declared completed recomputed output", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-viewer-recomputed-"));
  const bundleDir = path.join(dir, "bundle");
  await fs.mkdir(path.join(bundleDir, "recomputed"), { recursive: true });
  const records = [
    captureRecord("2026-08-02T12:00:00.000Z", 56, -5, 2, {
      autopilotState: "standby",
      rudderAngle: -10,
    }),
    captureRecord("2026-08-02T12:01:00.000Z", 56.001, -5, 2, {
      autopilotState: "route",
      rudderAngle: 6,
    }),
  ];
  await fs.writeFile(
    path.join(bundleDir, "recomputed", "output.jsonl"),
    records.map((record) => JSON.stringify(record)).join("\n"),
  );
  await fs.writeFile(path.join(bundleDir, "index.json"), JSON.stringify({
    id: "voyage-recomputed-output",
    startedAt: "2026-08-02T12:00:00.000Z",
    stoppedAt: "2026-08-02T12:01:00.000Z",
    captureFiles: [],
    captureReferences: [],
    recomputedOutput: {
      contract: "ajrm-marine-recomputed-output-v1",
      fileName: "recomputed/output.jsonl",
      complete: true,
    },
  }));
  const zipPath = path.join(dir, "voyage-recomputed-output.zip");
  await writeZip(zipPath, bundleDir, ["index.json", "recomputed/output.jsonl"]);

  const analysis = await _private.analyseVoyage(zipPath, { maxTrackPoints: 100 });

  assert.equal(analysis.summary.trackPoints, 2);
  assert.equal(analysis.summary.rudder.sampleCount, 1);
  assert.equal(analysis.summary.rudder.excludedSampleCount, 1);
  assert.equal(analysis.summary.rudder.medianAngleDegrees, 6);
});

test("summarises engaged pilot helm bias and excludes standby TP32 positions", async () => {
  const rudderDegrees = [-12, -8, -4, 30];
  const waterCelsius = [10, 12, 14, 12];
  const records = [captureRecord(
    "2026-08-02T11:59:00.000Z",
    55.999,
    -5,
    3,
    { rudderAngle: 10, autopilotState: "standby" },
  ), ...rudderDegrees.map((rudderAngle, index) => captureRecord(
    `2026-08-02T12:0${index}:00.000Z`,
    56 + index * 0.001,
    -5,
    3,
    { rudderAngle, waterCelsius: waterCelsius[index], autopilotState: index === 3 ? "wind" : "heading" },
  ))];
  const analysis = await analyseCanonicalRecords(records, "instruments");

  assert.equal(analysis.summary.rudder.available, true);
  assert.equal(analysis.summary.rudder.sampleCount, 4);
  assert.equal(analysis.summary.rudder.observedSampleCount, 5);
  assert.equal(analysis.summary.rudder.excludedSampleCount, 1);
  assert.equal(analysis.summary.rudder.scope, "engaged-autopilot-only");
  assert.ok(Math.abs(analysis.summary.rudder.medianAngleDegrees - -6) < 1e-9);
  assert.ok(Math.abs(analysis.summary.rudder.meanAngleDegrees - 1.5) < 1e-9);
  assert.ok(Math.abs(analysis.summary.rudder.medianAbsoluteAngleDegrees - 10) < 1e-9);
  assert.equal(analysis.summary.waterTemperature.available, true);
  assert.equal(analysis.summary.waterTemperature.sampleCount, 4);
  assert.ok(Math.abs(analysis.summary.waterTemperature.averageCelsius - 12) < 1e-9);
  assert.ok(Math.abs(analysis.summary.waterTemperature.minimumCelsius - 10) < 1e-9);
  assert.ok(Math.abs(analysis.summary.waterTemperature.maximumCelsius - 14) < 1e-9);
});

test("caches plot analysis beside the voyage bundle", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-viewer-cache-"));
  const fileName = "voyage-cache.zip";
  const records = [
    captureRecord("2026-06-22T12:00:00.000Z", 56.0, -5.0, 2),
    captureRecord("2026-06-22T12:10:00.000Z", 56.00833, -5.0, 3),
  ];
  const file = await writeCanonicalVoyage(dir, fileName, records);
  const options = { voyageDirectory: dir };
  const first = await _private.analyseVoyageFile(fileName, options, 100);
  assert.equal(first.cache, undefined);
  const cachePath = _private.plotCachePath(file);
  const stat = await fs.stat(cachePath);
  assert.ok(stat.size > 0);
  const second = await _private.analyseVoyageFile(fileName, options, 100);
  assert.equal(second.cache.hit, true);
  assert.equal(second.summary.trackPoints, 2);
});

test("web app exposes voyage notes and route review without retired Plotter controls", async () => {
  const html = await fs.readFile(path.join(process.cwd(), "public", "review", "index.html"), "utf8");
  const app = await fs.readFile(path.join(process.cwd(), "public", "review", "app.js"), "utf8");
  const css = await fs.readFile(path.join(process.cwd(), "public", "review", "styles.css"), "utf8");

  assert.doesNotMatch(html, /id="toggleDrFixes"/);
  assert.match(html, /id="notesPanel"/);
  assert.match(html, /id="reviewSelected"/);
  assert.doesNotMatch(html, />Clips</);
  assert.doesNotMatch(html, />Logs</);
  assert.doesNotMatch(html, /class="file-tab/);
  assert.doesNotMatch(app, /activeKind/);
  assert.doesNotMatch(app, /fileTabs/);
  assert.doesNotMatch(app, /updateFileTabs/);
  assert.match(html, /id="reviewPanel"/);
  assert.doesNotMatch(app, /function renderDrPlotFixes/);
  assert.match(app, /function renderVoyageNotes/);
  assert.match(app, /function renderVoyageRoutes/);
  assert.match(app, /function renderReview/);
  assert.match(app, /review-conclusion/);
  assert.match(app, /review-highlights/);
  assert.match(app, /review-highlight/);
  assert.match(app, /reviewLight\("Software"/);
  assert.match(app, /reviewLight\("Voyage data"/);
  assert.match(css, /\.review-highlights/);
  assert.match(css, /\.review-highlight/);
  assert.match(app, /showSummary: false/);
  assert.match(app, /Track plotted\. Press Review/);
  assert.match(app, /if \(plot\) \{\s*clearPlottedLayers\(\);\s*plottedBounds = null;\s*elements\.centrePlot\.disabled = true;\s*\}/);
  assert.match(app, /\["DR evidence", drEvidenceSummary/);
  assert.match(app, /\["Integrity comparison", integrityAssuranceSummary/);
  assert.match(app, /\["Pilot helm bias", formatRudderSummary/);
  assert.match(app, /\["Water temperature", formatWaterTemperatureSummary/);
  assert.match(app, /function formatRudderSummary/);
  assert.match(app, /function formatWaterTemperatureSummary/);
  assert.match(app, /if \(value === false\) return "GPS-independent"/);
  assert.match(css, /\.voyage-note-marker/);
});

function captureRecord(timestamp, latitude, longitude, sogKnots, instruments = {}) {
  return {
    capturedAt: timestamp,
    delta: {
      context: "vessels.self",
      updates: [
        {
          timestamp,
          values: [
            ...(instruments.autopilotState ? [{
              path: "steering.autopilot.state",
              value: instruments.autopilotState,
            }] : []),
            {
              path: "navigation.position",
              value: { latitude, longitude },
            },
            {
              path: "navigation.speedOverGround",
              value: sogKnots / 1.9438444924406046,
            },
            ...(Number.isFinite(instruments.rudderAngle) ? [{
              path: "steering.rudderAngle",
              value: instruments.rudderAngle * Math.PI / 180,
            }] : []),
            ...(Number.isFinite(instruments.waterCelsius) ? [{
              path: "environment.water.temperature",
              value: instruments.waterCelsius + 273.15,
            }] : []),
          ],
        },
      ],
    },
  };
}

function gpsIntegrityRecord(timestamp, state) {
  return {
    capturedAt: timestamp,
    delta: {
      context: "vessels.self",
      updates: [
        {
          timestamp,
          values: [
            {
              path: "plugins.ajrmMarineGpsIntegrity.navigationIntegrity",
              value: {
                timestamp,
                gps: { fixValid: true, positionAgeSeconds: 0, ...(state.gps || {}) },
                reasons: [],
                ...state,
              },
            },
          ],
        },
      ],
    },
  };
}

function trafficProjectionRecord(timestamp, active) {
  return {
    capturedAt: timestamp,
    delta: {
      context: "vessels.self",
      updates: [
        {
          timestamp,
          values: [
            {
              path: "plugins.ajrmMarineNotifications",
              value: {
                contract: "notifications-plus-projection",
                serverTime: timestamp,
                active,
                recentActivity: [],
              },
            },
          ],
        },
      ],
    },
  };
}

function trafficTargetsRecord(timestamp, targets) {
  return {
    capturedAt: timestamp,
    delta: {
      context: "vessels.self",
      updates: [
        {
          timestamp,
          values: [
            {
              path: "plugins.ajrmMarineTraffic.targets",
              value: {
                contract: "ajrm-marine-traffic-targets",
                schemaVersion: 1,
                targets,
              },
            },
          ],
        },
      ],
    },
  };
}

function trafficEvent({ eventId, label, title, mmsi, message, vesselSize = "unknown", cpaMeters = null, tcpaSeconds = null, priority = "warning" }) {
  return {
    provider: "ajrm-marine-traffic",
    eventId,
    timestamp: "2026-06-22T12:02:00.000Z",
    priority: { level: priority, score: priority === "danger" ? 800 : 500 },
    presentation: {
      title,
      label,
      message,
      audioMessage: message,
      category: "cpa",
      facts: [],
    },
    context: {
      mmsi,
      targetContext: `vessels.urn:mrn:imo:mmsi:${mmsi}`,
      vesselSize,
      cpaMeters,
      tcpaSeconds,
    },
  };
}

async function analyseCanonicalRecords(records, name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `voyage-viewer-${name}-`));
  const fileName = `voyage-${name}.zip`;
  const zipPath = await writeCanonicalVoyage(dir, fileName, records);
  return _private.analyseVoyage(zipPath, { maxTrackPoints: 100 });
}

async function writeCanonicalVoyage(dir, fileName, records) {
  const bundleDir = path.join(dir, `${fileName}.bundle`);
  await fs.mkdir(path.join(bundleDir, "input"), { recursive: true });
  await fs.writeFile(
    path.join(bundleDir, "input", "yden-input.jsonl"),
    records.map((record) => JSON.stringify(record)).join("\n"),
  );
  await fs.writeFile(path.join(bundleDir, "index.json"), JSON.stringify({
    id: fileName.replace(/\.zip$/i, ""),
    startedAt: records[0]?.capturedAt || null,
    stoppedAt: records.at(-1)?.capturedAt || null,
    canonicalInput: {
      contract: "ajrm-marine-canonical-input-v1",
      schemaVersion: 1,
      fileName: "input/yden-input.jsonl",
      complete: true,
    },
  }));
  const zipPath = path.join(dir, fileName);
  await writeZip(zipPath, bundleDir, ["index.json", "input/yden-input.jsonl"]);
  return zipPath;
}

async function writeZip(zipPath, rootDir, relativePaths) {
  const zip = new AdmZip();
  const indexPath = path.join(rootDir, "index.json");
  let index = relativePaths.includes("index.json")
    ? JSON.parse(await fs.readFile(indexPath, "utf8"))
    : null;
  if (index && !index.canonicalInput && !index.recomputedOutput) {
    const sourcePaths = [
      ...(index.captureReferences || []).map((reference) => reference.sourcePath),
      ...(index.captureFiles || []).map((fileName) => path.join(rootDir, "capture", fileName)),
    ].filter(Boolean);
    if (sourcePaths.length) {
      const chunks = await Promise.all(sourcePaths.map((sourcePath) => fs.readFile(sourcePath)));
      const canonical = Buffer.concat(chunks.map((chunk, position) =>
        position === chunks.length - 1 || chunk.at(-1) === 10
          ? chunk
          : Buffer.concat([chunk, Buffer.from("\n")])
      ));
      zip.addFile("input/yden-input.jsonl", canonical);
      index = {
        ...index,
        canonicalInput: {
          contract: "ajrm-marine-canonical-input-v1",
          schemaVersion: 1,
          fileName: "input/yden-input.jsonl",
          bytes: canonical.length,
          complete: true,
        },
      };
    }
  }
  for (const relativePath of relativePaths) {
    const zipPathName = relativePath.split(path.sep).join("/");
    const data = relativePath === "index.json" && index
      ? Buffer.from(JSON.stringify(index))
      : await fs.readFile(path.join(rootDir, relativePath));
    zip.addFile(zipPathName, data);
  }
  zip.writeZip(zipPath);
}
