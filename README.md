# AJRM Marine Capture

AJRM Marine Capture is a Signal K voyage recorder and diagnostic bundle orchestrator
for AJRM Marine suite testing and real sailing review.

It watches own-vessel movement, starts AJRM Marine Logger when the vessel gets underway,
takes AJRM Marine Snapshot diagnostics according to the selected voyage mode, stops recording
when the vessel has stopped, and writes an indexed voyage bundle for later
analysis, replay, and debugging.

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

Development assistance: OpenAI Codex helped with code generation, refactoring, and automated testing during the beta development cycle.
## License and commercial use

This software is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). You may use, study, share, and modify it under that licence. If you modify it and make it available to users over a network, the corresponding source code must also be made available under the AGPL.

Commercial licensing is available by arrangement for organisations that want different terms.

