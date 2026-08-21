# AJRM Marine Voyages (Capture)

> **Alpha software:** this software has not been validated for navigation or
> safety and must not be relied upon for either purpose.

AJRM Marine Capture is the single AJRM Marine voyage recorder, replay
engine, reviewer, evidence collector, and ZIP builder. It replaces AJRM Marine
Logger and includes the former Voyage Viewer.

Version `0.10.16` uses only the canonical sensor-input voyage model and removes
the retired vendor-named input path. Version `0.10.16` removes that retired input transition and aligns review/BITE contracts with the current suite. Version `0.10.15` widens Voyage Review's responsive chart-cycle banner so long
chart names remain readable. Version `0.10.14` fixes Voyage Review so the basemap-only chart-cycle step
actually removes the active automatic chart. Version `0.10.13` updates Voyage Review to shared map shell 0.7.9, including a
basemap-only step in chart cycling. Version `0.10.12` packages the Webapps icon for both Signal K consumers: the
App Store package root and installed webapp public URL. It retains replay source-time alignment and
excludes stale Signal K state emitted while a parent voyage is being prepared.
It retains streamed upload, saved-result playback, fresh calculation from
recorded inputs, and lineage-preserving recapture.

## The simple data model

Each newly recorded ordinary voyage always has one replayable input file:

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

Enable **Record calculated results as well as sensor inputs** to also write a
time-aligned Signal K result stream to:

```text
recomputed/output.jsonl.gz
```

That file is the gzip-compressed saved result stream. It is compressed while
recording, so a long result-bearing voyage does not first consume the full
uncompressed size on the Pi. The setting is stored on the Signal K server and
survives browser and Signal K restarts. Capture excludes its own status deltas,
including suffixed Signal K source IDs, so it cannot recursively record itself.
Older bundles containing uncompressed `recomputed/output.jsonl` remain
playable.

## Voyage player

The voyage list reports both **Contents** (inputs only, inputs plus saved
results, saved results only, or no playable stream) and **Integrity**
(complete, partial, or invalid).

Every voyage with complete canonical inputs can be played. The player offers
return-to-start, five-minute back/forward, play, pause, and stop controls.
Stopping leaves the voyage selected and loaded, ready to return to the start
or play again. While that voyage remains loaded, Capture reuses its prepared
temporary stream and validation result, so rewind and ±5-minute seeks do not
repeat ZIP extraction and full validation. Seeking still locates the requested
time in the disk-backed stream, but the first record at or after that time is
emitted immediately instead of waiting out any gap from the requested time.
Pausing excludes the paused interval from effective-rate validation. Both
playback modes run on the Signal K server and continue if the browser closes.

Preparation, seeking, playback, recording, and finalisation are mutually
exclusive server-side operations. A second browser cannot start a conflicting
operation while another is preparing. Stop can cancel preparation, and stale
browser status responses are ignored so an older poll cannot redraw controls
over newer player state.

### Fresh calculation

Leave **Use saved results** clear. Capture:

1. scans `input/sensor-input.jsonl` once and rejects malformed or backwards
   elapsed time;
2. replays it server-side at fixed `1x` from one monotonic scheduling anchor;
3. refreshes Signal K update timestamps and `navigation.datetime`;
4. publishes the explicit original voyage time as `replayOriginalAt`;
5. lets the currently installed Signal K plugins calculate fresh outputs; and
6. fails if scheduler lag exceeds the configured limit rather than rebasing or
   emitting a catch-up burst.

Unless recapture is enabled, these fresh results are not saved and no child
voyage is created.

The browser is only a controller and may be closed during replay.

Capture publishes the explicit replay contract at:

```text
vessels.self.plugins.ajrmMarineCapture.playback
```

Important fields include `contract`, `state`, `active`, `requestedRate`,
`recordsTotal`, `recordsReplayed`, `sourceElapsedMs`, `wallElapsedMs`,
`effectiveRatio`, `effectiveRatioEvidenceMs`,
`effectiveRatioEvidenceSufficient`, `replayOriginalAt`,
`maximumObservedLagMs`, `complete`, and `valid`. The effective-ratio threshold
is applied after ten seconds of source timing evidence; shorter replays remain
valid when they stay inside the absolute scheduler-lag limit.

### Recapture with current software

Select **Save this run as a new recaptured voyage**. This forces saved-result
playback off, replays the parent inputs through the current software, and saves
a new result stream. The child contains an exact inherited copy of the parent
canonical input, explicit parent lineage, new results, timing evidence, and
software/configuration evidence. The original ZIP is never modified.

At verified canonical input EOF, Capture automatically stops recording and
builds the ZIP. A recaptured voyage is
verified only when Capture has both:

- complete canonical-input EOF coverage; and
- valid effective timing.

Stopping before EOF produces an explicitly partial, unverified ZIP. Seeking
and return-to-start are disabled during recapture so backwards or duplicated
output cannot enter a single child result stream.

### Saved-result playback

For a voyage containing saved results, select **Use saved results** and press
Play to emit its stored compressed or legacy uncompressed result stream at
fixed `1x`.
Capture does not
open a new voyage, collect snapshots, write another result stream, or build
another ZIP.

The recorded delta values are preserved, including the recorded
`navigation.datetime`. Only each Signal K update's transport timestamp is
refreshed as it is emitted so current consumers do not reject the stored result
as stale. This option is available only when the ZIP declares a complete
`ajrm-marine-recomputed-output-v1` result. Input-only voyages automatically use
fresh calculation instead.

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
also recovers a selected saved-result stream before creating the voyage ZIP.
A torn final JSONL fragment caused by interruption
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
POST /voyage/player/play
POST /voyage/player/pause
POST /voyage/player/resume
POST /voyage/player/rewind
POST /voyage/player/seek
POST /voyage/replay/start
POST /voyage/replay/stop
POST /voyage/replay/abort
POST /voyage/playback/start
POST /voyage/playback/stop
GET  /voyage/observations
POST /voyage/observations
```

Suite plugins can use the equivalent in-process
`app.ajrmMarineCaptureApi`.

Voyage ZIPs are built as disk-backed streams and downloaded through the
browser's native streaming path rather than a whole-file JavaScript blob.
The Voyage bundles panel also has an **Upload** button. It streams a selected
AJRM voyage ZIP directly into the configured voyage directory, validates the
archive and root manifest, preserves the original filename, and selects the
newly uploaded voyage. Upload never replaces an existing file with the same
name and honours Capture's configured minimum-free-disk reserve.

## Install

```bash
cd ~/.signalk
npm install git+https://github.com/ajrm-marine-suite/signalk-ajrm-marine-capture.git#v0.10.16 --omit=dev --no-package-lock
sudo systemctl restart signalk
```

AJRM Marine Logger is retired and should not be installed alongside current
Capture. Capture 0.9 accepts only voyages declaring the current canonical input
contract; historical format conversion is deliberately outside the runtime.

Open **Review voyages** from the Capture web app to analyse completed voyages.
The review map, notes, route history, DR overlay, GPX export, and BITE review now
run inside this package at `/signalk-ajrm-marine-capture/review/`.
