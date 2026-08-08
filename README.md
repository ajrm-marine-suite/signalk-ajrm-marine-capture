# AJRM Marine Voyages (Capture)

> **Alpha software:** this software has not been validated for navigation or
> safety and must not be relied upon for either purpose.

AJRM Marine Capture is the single AJRM Marine voyage recorder, replay
engine, reviewer, evidence collector, and ZIP builder. It replaces AJRM Marine
Logger and includes the former Voyage Viewer.

## The simple data model

Each newly recorded ordinary voyage has one replayable file:

```text
input/sensor-input.jsonl
```

Capture writes only explicitly sourced physical inputs. Standard NMEA 2000,
NMEA 0183, and GPSD provenance is recognized automatically, regardless of the
gateway manufacturer or Signal K source label. Optional source prefixes are
available only for physical inputs that do not publish standard provenance.
Each JSONL record contains:

- contract `ajrm-marine-canonical-input-v1`;
- a non-decreasing `elapsedMs` measured from one monotonic clock;
- the explicit source identity; and
- the original input delta.

Once a structured physical source has been seen, later updates carrying the
same source ID remain eligible even if their retained metadata is sparse.
Derived plugin paths, notifications, Capture status, and unattributed values
are not canonical input.

A recomputed child voyage writes the active Signal K result stream to:

```text
recomputed/output.jsonl
```

That file is evidence only. It is never accepted as replay input.

## Replay

Select a canonical voyage ZIP in Capture and press **Start replay result**.
Capture:

1. scans `input/sensor-input.jsonl` once and rejects malformed or backwards
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

At verified canonical input EOF, Capture automatically stops recording and
builds the ZIP. **Finalise now** remains available as a fallback after verified
EOF. A recomputed voyage is
verified only when Capture has both:

- complete canonical-input EOF coverage; and
- valid effective timing.

Interrupting replay produces an explicitly incomplete, unverified ZIP.

## Ordinary voyage recording

Capture can start and stop automatically from explicit motion evidence, or
manually from its web page. Diagnostic modes control Snapshot collection:

- `minimal`: canonical input and manifest;
- `voyage`: compact start/stop snapshots;
- `debug`: richer snapshots plus periodic snapshots.

Voyage bundles may also include timestamped skipper observations, optional
Snapshot evidence, GPS Integrity DR tracks, and Console BITE reports.
The root `index.json` declares a versioned payload inventory in `files`.
`index.json` itself is explicitly excluded because a manifest cannot reliably
declare its own final byte size and modification time; every listed payload is
checked against the completed ZIP in Capture's tests.

If Signal K or the Pi stops before a voyage has been finalised, Capture
automatically recovers the unzipped voyage working directory on its next
start. It validates the canonical input from disk, rebuilds its metadata and
creates the voyage ZIP. A torn final JSONL fragment caused by interruption
during a write is discarded; complete records are retained, while corruption
anywhere else fails closed and leaves the working directory for inspection.
Waiting for the completed ZIP before an intentional shutdown is still the
preferred clean-stop procedure.

When AJRM Marine Display is installed, Capture also records the explicit route
that is open at voyage start and subsequent route open, reverse, save and close
events with voyage elapsed time. Recomputed replay asks Display to restore the
start route and then applies those route changes at their original source
times. Route snapshots are voyage metadata; they do not activate the Signal K
Course API or control an autopilot.

## Storage and API

The default voyage directory is relative to the Signal K user's home directory:

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

## Install

```bash
cd ~/.signalk
npm install git+https://github.com/ajrm-marine-suite/signalk-ajrm-marine-capture.git#v0.9.2 --omit=dev --no-package-lock
sudo systemctl restart signalk
```

AJRM Marine Logger is retired and should not be installed alongside current
Capture. Capture 0.9 accepts only voyages declaring the current canonical input
contract; historical format conversion is deliberately outside the runtime.

Open **Review voyages** from the Capture web app to analyse completed voyages.
The review map, notes, route history, DR overlay, GPX export, and BITE review now
run inside this package at `/signalk-ajrm-marine-capture/review/`.
