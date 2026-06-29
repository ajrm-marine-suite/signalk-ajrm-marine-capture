# Changelog

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
