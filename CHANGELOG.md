# Changelog

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
