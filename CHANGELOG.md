# Changelog

## 0.9.5

- Add concise purpose headers to every maintained runtime module so its role is
  clear before reading implementation details.
- Add a regression check that prevents new source modules from being introduced
  without a module-purpose header.
- Align OpenAPI metadata with the package release and test that the versions do
  not drift apart again.
- Preserve existing runtime contracts and behaviour following a suite-wide
  maintainability and Signal K integration review.
- Update the pinned shared map shell to 0.7.1 and refresh Voyage Review asset
  cache keys.

## 0.9.4

- Detect physical NMEA 2000, NMEA 0183, and GPSD inputs from structured Signal
  K provenance instead of assuming a Yacht Devices/YDEN source prefix.
- Learn physical source IDs so later metadata-sparse updates from the same
  source remain replayable, while derived plugin updates stay isolated.
- Write new voyages to vendor-neutral `input/sensor-input.jsonl`; retain
  read/recovery support for existing `input/yden-input.jsonl` bundles.
- Treat configured input source prefixes as optional additions for unusual
  physical providers rather than as the normal or exclusive selection rule.

## 0.9.3

- Remove the retired Voyage Viewer in-process API aliases and publish review
  status only below Capture's own Signal K status namespace.
- Rename remaining review diagnostics, GPX metadata, and browser storage keys
  to describe the current Capture-owned voyage review.

## 0.8.0

- Remove the legacy-voyage converter and its installed command. Historical
  voyage repair is no longer part of the runtime package.
- Remove reference-mode portable-download rebuilding and serve current
  self-contained voyage ZIPs directly.
- Remove dead standalone Logger API/HTTP integration, Logger capture copying,
  capture-reference discovery, and raw capture indexing branches left behind
  by the 0.7 recorder/replay merger.
- Use only `~/AJRMMarineLogs/voyages`; the old CapturePlusLogs directory is no
  longer discovered implicitly.
- Simplify current voyage status and manifests around canonical input and
  recomputed output rather than obsolete capture-file modes.

## 0.7.16

- Recover a completed current-format recomputation from Capture's durable
  checkpoint by validating the canonical replay result and closed recomputed
  output, instead of requiring retired Logger result-segment fields.
- Await active-voyage preservation from the Signal K plugin `stop()` lifecycle
  hook so shutdown does not race ZIP finalisation.
- Remove the special recovery path for the pre-merge Capture 0.6.8 completion
  shape and rename remaining recovery status text from Logger to Capture.

## 0.7.15

- Document Capture as the sole current voyage recorder, replay engine,
  evidence collector, and ZIP builder, with Logger retained only for legacy
  bundle compatibility.

## 0.7.14

- Store payload inventory paths with portable ZIP separators on every platform,
  including Windows, and verify that contract in the completed-bundle test.

## 0.7.13

- Exclude the root `index.json` from its own payload inventory and declare that
  rule explicitly with the versioned `ajrm-marine-voyage-payload-inventory-v1`
  contract, preventing stale self-referential byte counts.
- Verify in tests that every declared payload exists in the completed ZIP and
  has exactly the declared uncompressed size.

## 0.7.12

- Record the explicit Signal K own-vessel context in each voyage index so
  downstream review never has to identify own vessel by sample volume.
- Remove the retired AJRM Marine DR Plotter file dependency and plot-fix bundle
  metadata; the maintained GPS Integrity DR track remains unchanged.
- Correct the packaged web-app icon path.

## 0.7.11

- Rebuild DR-track sample counts and first/last timestamps from the durable
  JSONL file when an interrupted voyage is recovered after a Signal K restart.
- Close recovered DR metadata at the recovered voyage stop time instead of
  retaining a stale in-progress checkpoint.

## 0.7.10

- Sort downloadable voyages by their recorded start time rather than ZIP file
  modification time, so startup-recovered historical bundles do not obscure a
  more recent naturally completed voyage.

## 0.7.9

- Restore automatic startup recovery for ordinary voyages interrupted by a
  Signal K restart or Pi shutdown.
- Rebuild canonical-input metadata from the durable JSONL file and package all
  complete records without depending on a browser or the retired Logger.
- Discard only a torn final JSON fragment; fail closed on internal or
  structurally invalid canonical data and retain it for inspection.

## 0.7.8

- Record the AJRM Marine Display route open at voyage start and every later
  route selection or close with monotonic voyage elapsed time.
- Restore the recorded start route during recomputed replay and apply later
  route changes at their corresponding source elapsed times.
- Keep route restoration display-only and separate from Signal K Course API or
  autopilot activation.

## 0.7.7

- Automatically stop recomputed-output recording and build the voyage ZIP as
  soon as canonical replay reaches verified EOF.
- Retain manual finalisation as a fallback after verified EOF.

## 0.7.6

- Validate actual timestamp coverage against each declared legacy capture
  reference and fail rather than silently certifying a truncated recovery.
- Add `--allow-incomplete` for deliberately creating a visibly incomplete,
  partial bundle for testing when damaged legacy tail data cannot be recovered.

## 0.7.5

- Convert lightweight legacy reference-mode bundles by reading the exact raw
  Logger paths declared in `index.captureReferences` when those files still
  exist.
- Keep converted bundles self-contained through canonical input without
  copying the much larger legacy raw capture segments into the new ZIP.

## 0.7.4

- Stage legacy voyage conversion beside the output ZIP on persistent storage,
  not in potentially RAM-backed `/tmp`, so large Pi conversions remain
  disk-backed.

## 0.7.3

- Add a one-off, non-destructive legacy voyage converter that creates the
  canonical physical-input stream required by the v0.7 replay engine.
- Restrict conversion to the explicit voyage window and physical source
  prefixes, preserve original deltas, clamp backward legacy envelope times,
  and embed a machine-readable validation and provenance report.

## 0.7.2

- Make the fixed-rate replay integration fixture long enough for effective-rate
  validation on busy CI runners and surface replay failure immediately.

## 0.7.1

- Allow the canonical replay integration test enough wall time on Windows and
  emulated armv7 CI runners without changing the replay timing contract.

## 0.7.0

- Merge AJRM Marine Logger recording and replay into Capture.
- Store exactly one canonical physical-input JSONL stream on a monotonic
  `elapsedMs` timeline.
- Replay only canonical input, server-side, at fixed `1x`; refresh Signal K
  timestamps and publish the explicit original voyage time.
- Fail on excessive scheduler lag instead of rebasing, throttling silently, or
  issuing a catch-up burst.
- Store recomputed Signal K output separately as evidence that cannot be
  replayed as input.
- Verify recomputation from canonical EOF coverage and effective timing only.
- Remove live-YDEN isolation and legacy runtime timestamp normalization.
- Treat older bundles as view/download-only unless converted once to the new
  input contract.
- Replace legacy startup reconstruction with a simple report that retains
  interrupted working directories for inspection.

## 0.6.13

- Require AJRM Marine Logger's explicit effective-rate timing result before a
  recomputed voyage can be certified.
- Preserve legacy compatibility for captures that predate the timing
  requirement while failing closed for every newly started recomputation.

## 0.6.12

- Require Logger's explicit live-input-isolation result before marking a
  completed recomputed voyage verified. A replay that reaches full input and
  result-segment coverage but fails isolation is still packaged as complete
  diagnostic evidence with a prominent unverified warning.
- Persist completion separately from verification so Signal K can resume a
  later ZIP build after restart without either losing the completed result or
  incorrectly certifying failed isolation.
- Revalidate isolation during startup recovery, including downgrading an older
  checkpoint that incorrectly claimed verification.

## 0.6.11

- Show separate replay and finalisation progress bars. Long phases without
  measurable byte progress use an indeterminate activity bar; ZIP writing uses
  the exact percentage reported by the disk-backed streaming writer.
- Keep current finalisation status separate from the previous completed bundle,
  so closing Logger or indexing evidence can no longer appear as a stale
  completed ZIP.
- Report an end-of-capture replay as complete while Logger closes its result
  recorder, and disable replay controls once finalisation has begun.
- Publish the plugin state as `finalising` throughout the finalisation
  pipeline.

## 0.6.10

- Recover the `0.6.8` normal-stop/ZIP-memory-exhaustion failure without
  mislabelling the replay incomplete. The one-time legacy migration requires a
  persisted normal replay-stop event before recovery, complete end-of-capture
  input coverage, no abort or segment errors, and internally consistent
  finalised segment totals.
- Convert accepted legacy evidence into the new durable completion checkpoint
  before streaming the ZIP, so another restart remains recoverable.

## 0.6.9

- Replace in-memory `AdmZip` voyage construction with a disk-backed streaming
  ZIP writer so large bundles are never read into RAM as a whole.
- Store existing Logger `.jsonl.gz` capture segments without recompressing
  them, reducing ZIP finalisation CPU load and temporary memory pressure.
- Publish Capture-owned ZIP phase, entry, byte, and percentage progress after
  Logger's replay-result recorder has closed, without polling that closed
  recorder.
- Persist and strictly revalidate a durable completed-replay checkpoint before
  packaging. Startup recovery now resumes later ZIP work without falsely
  marking a normally completed replay incomplete or unverified.
- Reuse already copied, exact-size result segments during recovery instead of
  requiring their original Logger source files to remain available.

## 0.6.8

- Build temporary portable-download workspaces on persistent disk rather than
  the Pi's RAM-backed `/tmp`, and clean completed, failed, interrupted, and
  crash-left workspaces.

## 0.6.7

- Run the test suite with a Node 20-compatible file glob so the advisory
  armv7/Cerbo GX job executes the tests instead of rejecting the quoted
  recursive pattern.

## 0.6.6

- Stream voyage ZIP downloads through the browser's native download path
  instead of loading the complete archive into a JavaScript `Blob`, preventing
  large bundles from exhausting browser memory before the save begins.

## 0.6.5

- Rename the early recomputed-replay action from **Cancel replay result** to
  **Interrupt replay**, making clear that it stops the run while preserving an
  incomplete, unverified evidence ZIP.
- Align confirmation, progress, failure, notification, and bundle warning
  wording with the new user-facing term.

## 0.6.4

- Restore responsive status and Voyage bundles rendering with large voyage
  archives by reading only ZIP directory/index metadata.
- Cache unchanged bundle metadata by file size and modification time instead of
  reopening every complete ZIP on each browser status poll.

## 0.6.3

- Start Logger's `1x` sensor playback automatically after arming a recomputed
  result capture, aborting and preserving an explicitly incomplete ZIP if the
  playback start request fails.
- Show replay state, exact cursor/total progress, segment coverage, last reason,
  and Logger's explicit playback error so a stalled run is distinguishable from
  a healthy real-time replay.
- Add a confirmed **Cancel replay result** action that uses Logger's dedicated
  abort contract and preserves finalised partial output in an incomplete,
  unverified ZIP rather than claiming successful recomputation.
- Recover recomputed replay working directories after Signal K restart without
  requiring Logger's lost in-memory result manifest. Copy only known or
  strictly wall-time-bounded partial capture segments and mark the bundle
  interrupted, incomplete, and unverified.

## 0.6.2

- Add a bounded timestamped voyage observation log for AJRM Marine Display and
  other suite clients, with optional AJRM Marine Snapshot evidence.
- Record wall time, voyage elapsed time, and Logger's explicit original replay
  time when available; expose append/list/status through HTTP and the shared
  in-process Capture API.
- Include observations and evidence in normal, portable, and recomputed child
  voyage ZIPs. Parent observations copied into a recomputed child are marked as
  lineage, are not counted as child observations, and refer back to parent-only
  Snapshot evidence only after verifying a safe entry exists, without emitting
  dangling child paths.
- Keep the text observation when optional Snapshot capture fails, recording a
  bounded `evidenceError` instead of rejecting the skipper's note.
- Treat the append-only observation text as committed even if a later
  `index.json` or live-status refresh fails, returning a warning instead of
  encouraging a duplicate retry.
- Complete startup recovery before starting a new voyage, and share concurrent
  start requests so a fresh working directory cannot be recovered or overwritten.

## 0.6.1

- Capture strict sensor-source replays into a new portable recomputed child
  voyage without modifying the original voyage bundle.
- Record parent lineage, source allowlist, replay coverage, isolation, timing,
  and recomputation provenance in the child manifest and compact DR evidence.
- Finalise a recomputed voyage only after all source segments have been covered
  and downstream calculators have completed their quiet-period flush.
- Disable and reject the ordinary voyage-stop path during recomputation, then
  fail closed if Logger does not confirm complete prepared coverage or Capture
  cannot copy a result segment into the child ZIP.
- Require Logger's explicit rotated-result segment manifest and copy every
  declared file by exact name and byte size; reject missing, changed,
  unfinished, or duplicate segments instead of inferring them by time range.
- Serve already-portable voyage ZIPs unchanged when their declared capture
  files are embedded, keeping repeated downloads valid after external Logger
  references have been removed.

## 0.5.29

- Rename Capture review diagnostics from legacy Engine wording to Traffic
  projection wording.

## 0.5.28

- Keep Start now and Stop now latched disabled after a successful manual
  recorder command until status confirms the voyage has actually started or
  stopped, preventing duplicate start/stop presses against stale status.

## 0.5.27

- Disable the Start/Stop recorder buttons immediately while manual start/stop
  commands are in progress, and change the button labels to Starting/Stopping
  so the skipper can see the press was accepted.
- Keep command errors visible while clearing the pending button state, instead
  of hiding them behind an immediate status refresh.

## 0.5.26

- On startup recovery, rediscover AJRM Marine Logger segments for the recovered
  voyage window instead of preserving only the initial segment reference.
- Copy only AJRM Marine Console BITE reports that overlap the voyage window, so
  later soak/real voyages do not inherit stale BITE reports from earlier tests.

## 0.5.25

- Include up to 200 AJRM Marine Console BITE report JSON files in voyage
  bundles so a full-suite BITE run is not truncated to only the last few tests.

## 0.5.24

- Expose Capture's portable voyage download builder through the in-process API
  so AJRM Marine Voyage Viewer and Logger can use the same canonical bundle
  collation routine.
- Route Capture's own download endpoint through the shared preparation helper
  to keep browser and in-process downloads identical.

## 0.5.22

- Expose automatic voyage-recording control through the in-process Capture API
  so AJRM Marine Console BITE can pause and restore auto recording around a
  controlled manual test capture.

## 0.5.21

- When AJRM Marine Console BITE Run all starts Capture while a voyage is
  already active, update the active voyage comment to the explicit BITE comment
  instead of leaving the automatic harbour departure comment in the bundle.
- Share the same comment-update helper between the web API and the in-process
  BITE API, and avoid clearing comments when a caller starts Capture without
  supplying one.

## 0.5.20

- Expose a small in-process Capture API so AJRM Marine Console BITE Run all can
  start a BITE-labelled voyage, run tests, and stop Capture without relying on
  browser/session authentication.

## 0.5.19

- Copy recent AJRM Marine Console BITE report JSON files into voyage bundles
  under `system/bite-reports/`, so Capture downloads include suite health-test
  evidence for offline debugging.

## 0.5.18

- Consume AJRM Marine Traffic's `voyageState` projection when deciding whether
  automatic voyage recording should start or stop.
- Track both SOG and STW for movement detection so Capture can continue to
  recognise passage state when GPS/SOG is unavailable.

## 0.5.17

- Replace external `zip`/`unzip` archive operations with pure JavaScript ZIP
  handling for voyage bundle creation and portable downloads.
- Remove a hard-coded `/home/pi` path from test fixtures so the Signal K plugin
  CI package validator passes.

## 0.5.16

- Add Signal K AppStore relationship metadata for the voyage debug mini-suite:
  Logger, Snapshot, and Voyage Viewer.
- Add the reusable Signal K plugin CI workflow.

## 0.5.15

- Preserve DR Plotter's resource-style navigator-fix metadata when bundling
  `tracks/dr-plot-fixes.json`, so GPS/DR/observed fix records keep their
  GeoJSON point, method, and chart-symbol fields for later analysis.

## 0.5.14

- Preserve DR Plotter GPS-return plot fixes in voyage bundles.

## 0.5.13

- Preserve DR Plotter observed-fix plot types and notes when bundling
  `tracks/dr-plot-fixes.json` into voyage downloads.

## 0.5.12

- Copy AJRM Marine DR Plotter persisted plot fixes into voyage bundles as
  `tracks/dr-plot-fixes.json`, filtered to the voyage time range and referenced
  from `index.json`.

## 0.5.11

- Remove obsolete visible app-name wording from the README history.

## 0.5.10

- Add Signal K AppStore utility category metadata.

## 0.5.9

- Rename Logger integration settings and defaults to AJRM Marine naming while retaining legacy-directory compatibility on upgraded Pis.

## 0.5.8

- Rename voyage notification identifiers and portable-download fallback names to AJRM Marine naming.

## 0.5.7

- Rename the capture index schema identifier to `ajrm-marine-capture-index-v1`.

## 0.5.6

- Generate an editable default voyage comment when the skipper has not entered one, using the current harbour name or anchorage profile plus the day of the week.

## 0.5.5

- Correct portable-download voyage metadata so copied compressed capture files are listed with their actual `.gz` filenames, compression state and file sizes.
- Rewrite portable-download events so they no longer say raw logger segments were only referenced when they have been copied into the download.

## 0.5.4

- Clear stale movement stop timers when a voyage starts, so a manual start while stationary is not immediately closed by stopped time that accumulated before the voyage began.

## 0.5.3

- Ignore AJRM Marine Logger replay movement when deciding whether to auto-start a voyage, and keep movement suppressed until a fresh non-replay speed sample arrives.

## 0.5.2

- After a manual voyage stop, inhibit automatic restart until a below-threshold speed sample is seen.

## 0.5.0

- Initial public beta release as AJRM Marine Capture.
