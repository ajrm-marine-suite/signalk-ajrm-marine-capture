# AJRM Marine Capture

> **Alpha Release disclaimer:** This software is Alpha Release and has not been tested in live environments and must not be relied upon for navigation or safety. The Authors do not accept any responsibility for loss or damage as a result of using this software.

AJRM Marine Capture is a Signal K voyage recorder and diagnostic bundle orchestrator
for AJRM Marine suite testing and real sailing review.

Version `0.6.12` separates completed replay coverage from recomputation
verification. Capture now requires Logger's explicit valid live-input
isolation result before marking a child voyage verified. Completed but
unisolated results are still packaged with a prominent unverified warning, and
their completion checkpoint remains recoverable if Signal K restarts during
the later ZIP build.

Version `0.6.11` adds separate replay and finalisation progress bars to the
Capture page. Logger closing, evidence collection, and indexing show an
indeterminate activity bar; ZIP construction switches to exact file, byte, and
percentage progress. The current finalisation is kept separate from the
previous completed bundle, so a long-running stage cannot display stale
completion details or misleading replay controls.

Version `0.6.10` builds voyage ZIPs as disk-backed streams. Existing compressed
Logger `.jsonl.gz` segments are stored directly in the ZIP without a second
compression pass, avoiding a whole-voyage memory copy and unnecessary Pi CPU
work. Once Logger has closed a recomputed recording, Capture writes a durable
completion checkpoint and reports ZIP phase, file, byte, and percentage
progress independently of Logger. If Signal K restarts during that later
packaging phase, recovery verifies the checkpoint and completed segment
manifest, resumes ZIP creation, and preserves the voyage as complete and
verified. It can also salvage the specific `0.6.8` failure mode using the
persisted normal-stop event plus complete input coverage and an internally
consistent finalised-segment manifest; it will not apply that migration to an
actually interrupted or aborted replay.

Version `0.6.8` builds temporary portable voyage downloads in a private,
disk-backed folder beside the voyage store instead of the Pi's RAM-backed
`/tmp`. Completed transfers, interrupted browser transfers, and failed builds
remove their workspace; Capture startup also removes precisely named remnants
left by an earlier crash, including legacy workspaces in `/tmp`.

Version `0.6.4` keeps the Capture status page and its Voyage bundles panel
responsive with large archives by reading and caching only ZIP index metadata.

It watches own-vessel movement, starts AJRM Marine Logger when the vessel gets underway,
takes AJRM Marine Snapshot diagnostics according to the selected voyage mode, stops recording
when the vessel has stopped, and writes an indexed voyage bundle for later
analysis, replay, and debugging.

## Timestamped voyage observations

AJRM Marine Display can append skipper observations to the active voyage
through Capture. Each observation records:

- bounded plain text (maximum 2,000 characters);
- the wall-clock recording time and elapsed voyage time;
- Logger's explicit original replay timestamp when one is available; and
- optional structured AJRM Marine Snapshot evidence using the `debug` preset.

Snapshot evidence is useful when reporting a transient display or calculation
problem, but it is not allowed to lose the text note: if Snapshot is
unavailable, Capture saves the observation with a bounded `evidenceError`.

The HTTP contract is:

```text
GET  /plugins/signalk-ajrm-marine-capture/voyage/observations
POST /plugins/signalk-ajrm-marine-capture/voyage/observations
```

The POST body is:

```json
{
  "text": "Turn indicator remained after the target sent null ROT.",
  "includeSnapshot": true,
  "source": "ajrm-marine-display"
}
```

An active voyage is required. Suite plugins can use the equivalent
`app.ajrmMarineCaptureApi.appendObservation(...)` method and inspect
`observationCapabilities` from `app.ajrmMarineCaptureApi.status()`.

The ZIP contains child observations at
`observations/observations.jsonl`; optional evidence files live below
`observations/evidence/`. `index.json` records the count, evidence count and
time range. Portable download rebuilding preserves those files.

During a recomputed replay, observations entered while testing belong to the
new child voyage and carry the explicit original Logger cursor time when
available. If the parent has an observation log, Capture copies it to
`observations/parent-observations.jsonl` as lineage only. Parent records are
never counted or presented as child observations. Snapshot paths in the
lineage copy are rewritten as unavailable in the child, with an explicit
reference back to a safe evidence entry that Capture verified exists in the
parent voyage. The evidence itself remains authoritative in the parent ZIP and
no dangling child evidence path is emitted.

## Recomputed voyage replay

Capture can explicitly record a new portable child voyage while AJRM Marine
Logger replays only sensor-origin updates from a parent voyage:

1. Disable or disconnect current live sensor feeds, then restart Signal K to
   clear retained calculator state. Leave the applications whose calculations
   are under test enabled. This is important: Logger can quarantine and report
   detected live physical-source deltas in the child log, but cannot stop them
   influencing calculations elsewhere in Signal K.
2. In Logger select a parent voyage and **Sensor sources only (recompute)**.
3. Confirm Logger's resolved exact physical source IDs. Its default `YDEN`
   prefix is resolved from the recording and supports both short and long YDEN
   source identities; optional exact IDs can be added for other hardware.
4. In Capture press **Start replay result** once. Capture starts a dedicated
   Logger result recording with zero rolling-buffer backfill, forces portable
   capture-file handling for the child voyage, and immediately starts Logger's
   sensor replay at `1x`. There is no second Play step, so an armed recorder
   cannot sit idle collecting unrelated calculator chatter.
5. Watch Capture's Logger state, cursor/total progress, segment coverage, last
   reason, and any explicit playback error. The workflow enforces `1x` and
   forces every pre-indexed voyage segment even when ordinary auto-play-next is
   off. Capture trusts Logger's cumulative `coverage.complete` contract and
   prevents finalisation until every replay segment has completed.
6. After Logger reaches the end, press **Stop and build ZIP**. Logger allows a
   three-second quiet-period calculation flush, extended by each late output
   and bounded to fifteen seconds, before the ZIP is finalised. Logger then
   declares every rotated result file in `resultSegments`; Capture verifies and
   copies every declared file by exact name and byte size. Logger then closes;
   Capture's own finalisation status continues to show ZIP percentage, files,
   input bytes, output bytes, and the current entry until packaging completes.

The result contains the replayed sensor inputs and newly recalculated live
outputs. Its `index.json` includes `recomputedReplay` metadata with the parent
voyage, playback mode, rate, source catalogue, configured selection rule,
resolved exact source IDs, filter counts, original recording range,
cursor/completeness coverage, and live-input isolation/contamination result.
The coverage cannot be complete if a rotated result segment is missing,
changed, unfinished, or duplicated.
Ordinary live capture, automatic voyage capture, and standard replay remain
unchanged.

Normal **Stop now** is disabled during this workflow. Only **Stop and build
ZIP** can finalise the child, and it fails closed unless Logger confirms
complete pre-indexed coverage, completes the calculation quiet period, and
Capture copies every segment in Logger's result manifest into the ZIP.

If Logger stops or reports an error before complete coverage, use **Interrupt
replay**. After confirmation, Logger aborts and finalises its partial
result segments without a calculation quiet-period wait. Capture preserves
those segments in a ZIP explicitly marked `incomplete`, `verified: false`, and
`aborted`; it never promotes that ZIP to a completed recomputation result. If
Signal K restarts during a recomputed replay, startup recovery similarly copies
only exact known or strictly wall-time-bounded partial Logger segments and
marks the recovered ZIP interrupted, incomplete, and unverified.

A restart after Logger has already completed normally is handled differently.
Capture records that verified completion before beginning the potentially long
ZIP build. Startup recovery revalidates the completion checkpoint and copied
segment manifest, resumes packaging from disk, and does not relabel the voyage
as interrupted or incomplete merely because Signal K restarted during ZIP
creation or a later download build.

Portable download preparation is idempotent: if a voyage ZIP already contains
every declared `captureFiles` entry, Capture serves that ZIP unchanged and does
not depend on the original Logger files still being present.

The Capture web app downloads voyage ZIPs through the browser's native
same-origin download path. Large bundles are streamed directly instead of
being loaded into a JavaScript `Blob`, avoiding a second full-size copy in
browser memory on iPhone, iPad, and desktop browsers. Reference-mode bundles
may still take time to start because Capture must first build the portable ZIP.
That temporary assembly uses disk storage and is removed after the transfer;
it cannot consume the Pi's RAM disk.

The child bundle's compact DR track and copied DR Plotter fixes retain
operational/integrity assurance, comparison availability, GPS dependence,
leeway/current origin, and Navigation Reference provenance. Missing numeric
evidence remains `null`, not a fabricated zero.

Version `0.5.18` uses AJRM Marine Traffic's `voyageState` projection plus both
speed over ground and speed through water when deciding whether automatic
voyage recording should start or stop. This avoids treating lost GPS/SOG as
proof that the vessel is stationary.

Version `0.5.12` copies AJRM Marine DR Plotter's persisted navigator plot fixes
into voyage bundles as `tracks/dr-plot-fixes.json`, filtered to the voyage time
range and referenced from `index.json`.

Version `0.5.3` ignores AJRM Marine Logger replay movement for automatic voyage
start, so replaying an old log does not create a new voyage recording.

Version `0.5.2` prevents automatic recording from immediately restarting after
a manual stop. Capture now waits until it has seen a below-threshold speed sample
before arming automatic start again.

Version `0.5.1` persists the web app's **Enable automatic voyage recording**
toggle to the Signal K plugin configuration file, so the setting survives Signal
K and Pi restarts.

Version `0.1.31` writes a compact `tracks/dr-track.jsonl` file into each active
voyage bundle when AJRM Marine GPS Integrity is publishing navigation integrity
state. The track records GPS, operational DR, IDR, trust state, uncertainty, and
warning reasons so Voyage Viewer can display DR error and GPS recovery jumps.

Version `0.1.30` treats null/blank `navigation.speedOverGround` as unavailable, not as numeric zero, so Capture distinguishes lost GPS/SOG from a real stationary 0.0 kn.

Version `0.1.29` clears the displayed/autostart SOG when
`navigation.speedOverGround` is nulled or invalid, so stale GPS-derived movement
does not start a new voyage after GPS is switched off.

Version `0.1.22` rebuilds reference-mode voyage downloads on demand, copying
referenced AJRM Marine Logger files into the temporary zip when they are still
present on the server.

Version `0.1.21` de-duplicates AJRM Marine Logger references when the same capture
segment is visible as both a stale `.jsonl` name and its completed `.jsonl.gz`
name, preferring the compressed segment metadata.

Version `0.1.20` makes reference-mode voyage capture the default and stops
waiting for AJRM Marine Logger compression by default. Portable bundles remain
available as an explicit setting when self-contained zip files matter more than
fast UPS shutdown.

Version `0.1.19` writes explicit journal breadcrumbs when AJRM Marine Pi Controller shutdown
intent starts voyage shutdown and when startup recovery closes an incomplete
voyage.

Version `0.1.18` listens for AJRM Marine Pi Controller shutdown/reboot intent and starts
closing the active voyage before the power command runs. Startup recovery still
closes any voyage folder left incomplete by a hard restart.

Version `0.1.17` closes incomplete `voyage-*` working folders at startup instead
of resuming them after a Signal K restart. Recovered bundles are marked with
`interruptedByRestart` and include `system/recovery-status.json`.

Version `0.1.15` adds explicit voyage diagnostic modes and recording file
handling. `Voyage` mode is the default: it records raw Signal K data and keeps
compact start/stop snapshots. `Debug` mode adds richer and periodic snapshots.
`Minimal` mode records raw Signal K data and the manifest only. Reference mode
records source segment paths in `index.json` without duplicating raw logs in the
zip. Portable mode can be selected to copy matching AJRM Marine Logger segments
into the bundle.

Version `0.1.16` requests AJRM Marine Snapshot's named `voyage` and `debug` presets so
Snapshot owns the detailed diagnostic contents and Capture only chooses the
voyage mode.

Version `0.1.14` aligns the voyage bundle browser with AJRM Marine Logger and
Voyage Viewer: select one bundle in the list, then use the shared Download or
Delete buttons above the list.

Version `0.1.12` publishes voyage start/stop notifications as explicit
low-priority, non-preempting Notifications Plus events with short audio expiry
so they cannot interrupt or trail behind collision alerts.

Version `0.1.11` separates harmless Traffic projection file-order rewinds caused
by AJRM Marine Logger backfill/overlap from true Traffic projection sequence regressions in
`index.json`.

Version `0.1.10` adds capture-order indexing to voyage bundles so backfilled
AJRM Marine Logger records can be analysed by timestamp before opening large raw
logs.

Version `0.1.9` updates the user-facing name to **AJRM Marine Capture** while
keeping package id, route names, and `ajrmMarineCapture` Signal K paths stable for
compatibility.

Version `0.1.8` uses AJRM Marine Snapshot's in-process API when available, avoiding
local HTTPS/admin authentication failures during unattended voyage recording.

Version `0.1.7` updated the visible voyage-capture app name and avoids
duplicating the same AJRM Marine Logger segment in `index.json` when AJRM Marine
Logger reports both a plain recording name and the completed `.jsonl.gz` file.

For compatibility, the npm package, plugin id, HTTP route, and Signal K paths
remain `signalk-ajrm-marine-capture` / `ajrmMarineCapture` for now. The plugin
publishes its own state under:

```text
vessels.self.plugins.ajrmMarineCapture.*
```

It also publishes speakable Signal K notifications when voyage recording starts
and stops:

```text
vessels.self.notifications.plugins.ajrmMarineCapture.<voyage-id>.start
vessels.self.notifications.plugins.ajrmMarineCapture.<voyage-id>.stop
```

Those notifications use `method: ["visual", "sound"]`, so AJRM Marine Audio can
announce them through the normal notification pipeline.


## Public Beta

Voyage capture and diagnostic bundle builder for AJRM Marine Suite testing.

AJRM Marine Capture is authored and maintained by Anthony McDonald, with
assistance from William McAusland. It builds on the Signal K project and the
work of Signal K plugin authors.

Development assistance: OpenAI Codex helped with code generation, refactoring, and automated testing during the beta development cycle.
## License and commercial use

This software is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). You may use, study, share, and modify it under that licence. If you modify it and make it available to users over a network, the corresponding source code must also be made available under the AGPL.

Commercial licensing is available by arrangement for organisations that want different terms.
