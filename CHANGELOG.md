# Changelog

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
