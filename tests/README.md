# Regression tests

Mock-DOM automated tests for the real extension files. No VTOP login needed.

## Prereqs

```sh
npm i playwright-core
npx playwright install chromium
```

(playwright-core is intentionally **not** a project dependency — the shipped
extension has zero dependencies. Install it anywhere to run the suite.)

## Run

```sh
node tests/regression.js
```

Exit code `0` = all pass, `1` = failure. Covers:

- `content.js`: L1/L2 table detection, no-table graceful path, `DIAGNOSTICS`,
  `ADVANCE_PAGE` no-next, single-click no-dupe, duplicate-injection guard,
  skip reasons
- `content.js` (v1.8.0): async full-scan wait (22 rows despite same first
  row), course dropdown never treated as length select ("Fall" vs "all"),
  rapid re-click deduped as `duplicate-click`, error file reported as
  `error-page` while the rest of the batch still downloads
- `content.js` (v1.8.1): "0 (Document)" badge rows with a download icon
  are listed (`hasDownload`) and downloadable; only rows with no download
  control are skipped (`no-control`)
- `content.js` (v1.8.2): byte-identical rows stay distinct (page +
  occurrence key suffix) and every copy downloads
- `popup.js` (v1.8.2): `summarizeSizes` groups same-named files by size
  (identical vs different vs unknown)
- `background.js`: folder sanitization, nested-path safety, job registry,
  newest-job attribution, disarm-all fallback
- `popup.js`: terminology, history badges, folder templates, diagnostics
  overlay, page sweep (no-next), per-key queue, skip-existing, history
  recording

## Live tests

Authenticated VTOP end-to-end (downloads, pagination, concurrency) cannot run
here — they need a logged-in session. See the project test reports for the
live matrix and run those flows manually after VTOP UI changes.
