# AJRM Marine Capture

> **Alpha software:** this software has not been validated for navigation or
> safety and must not be relied upon for either purpose.

AJRM Marine Capture v0.7.0 is the single AJRM Marine voyage recorder, replay
engine, evidence collector, and ZIP builder. It replaces AJRM Marine Logger.

## The simple data model

Each newly recorded ordinary voyage has one replayable file:

```text
input/yden-input.jsonl
```

Capture writes only updates with an explicit source matching a configured
physical-input prefix (default `YDEN`). Each JSONL record contains:

- contract `ajrm-marine-canonical-input-v1`;
- a non-decreasing `elapsedMs` measured from one monotonic clock;
- the explicit source identity; and
- the original input delta.

Derived plugin paths, notifications, Capture status, and metadata-free values
are not canonical input.

A recomputed child voyage writes the active Signal K result stream to:

```text
recomputed/output.jsonl
```

That file is evidence only. It is never accepted as replay input.

## Replay

Select a canonical voyage ZIP in Capture and press **Start replay result**.
Capture:

1. scans `input/yden-input.jsonl` once and rejects malformed or backwards
   elapsed time;
2. replays it server-side at fixed `1x` from one monotonic scheduling anchor;
3. refreshes Signal K update timestamps and `navigation.datetime`;
4. publishes the explicit original voyage time as `replayOriginalAt`;
5. records recomputed output in the child voyage; and
6. fails if scheduler lag exceeds the configured limit rather than rebasing or
   emitting a catch-up burst.

The browser is only a controller and may be closed during replay.

Capture publishes the explicit replay contract at:

```text
vessels.self.plugins.ajrmMarineCapture.playback
```

Important fields include `contract`, `state`, `active`, `requestedRate`,
`recordsTotal`, `recordsReplayed`, `sourceElapsedMs`, `wallElapsedMs`,
`effectiveRatio`, `replayOriginalAt`, `maximumObservedLagMs`, `complete`, and
`valid`.

After canonical input EOF, press **Stop and build ZIP**. A recomputed voyage is
verified only when Capture has both:

- complete canonical-input EOF coverage; and
- valid effective timing.

Interrupting replay produces an explicitly incomplete, unverified ZIP.

## Legacy voyages

Bundles without `ajrm-marine-canonical-input-v1` remain downloadable and
viewable but are not replayed through a runtime compatibility layer. If an old
voyage matters, convert its physical input once into the canonical JSONL
format. This keeps all legacy timestamp repair outside normal recording and
replay.

Run the one-off converter from a Capture source checkout or installed package:

```bash
npm run convert:legacy-voyage -- /path/to/voyage.zip
```

It also accepts an extracted voyage directory. The default output is a new
`*-canonical.zip`; the source is never changed and an existing output is never
overwritten. Use `--output /path/to/name.zip` to choose another destination.
Legacy reference-mode bundles are supported when every exact source path
declared in `index.captureReferences` still exists. Referenced raw segments are
read in place and are not copied into the converted ZIP.

The converter checks each referenced file's actual timestamp coverage against
the range declared in the legacy index. Truncated recovered data fails closed.
For a deliberately partial testing replay, `--allow-incomplete` creates a
bundle whose index and conversion report explicitly mark coverage incomplete;
it must not be treated as complete voyage evidence.

The converter:

- reads only the voyage window explicitly declared by `index.json`;
- retains only updates whose explicit source matches `YDEN` (additional
  physical prefixes can be supplied with `--source-prefix`);
- keeps every original delta value and embedded timestamp unchanged;
- derives `elapsedMs` from the legacy envelope `capturedAt` field in file
  order, clamping backwards timestamps to the preceding logical time; and
- adds `conversion/legacy-conversion-report.json` with record counts, timing
  regressions, the exact repair rule, validation result, and SHA-256 digest.

The converted ZIP is accepted by Capture's fixed-rate replay. Conversion is a
visible migration, not a compatibility mode used by ordinary recording or
replay. Conversion staging is disk-backed beside the requested output and is
removed when conversion finishes or fails; large bundles are not staged in
`/tmp`.

## Ordinary voyage recording

Capture can start and stop automatically from explicit motion evidence, or
manually from its web page. Diagnostic modes control Snapshot collection:

- `minimal`: canonical input and manifest;
- `voyage`: compact start/stop snapshots;
- `debug`: richer snapshots plus periodic snapshots.

Voyage bundles may also include timestamped skipper observations, optional
Snapshot evidence, GPS Integrity DR tracks, DR Plotter fixes, and Console BITE
reports.

## Storage and API

The default voyage directory is:

```text
~/AJRMMarineLogs/voyages
```

Main HTTP routes are below
`/plugins/signalk-ajrm-marine-capture`:

```text
GET  /status
GET  /voyages
POST /voyage/start
POST /voyage/stop
POST /voyage/replay/start
POST /voyage/replay/stop
POST /voyage/replay/abort
GET  /voyage/observations
POST /voyage/observations
```

Suite plugins can use the equivalent in-process
`app.ajrmMarineCaptureApi`.

Voyage ZIPs are built as disk-backed streams and downloaded through the
browser's native streaming path rather than a whole-file JavaScript blob.
