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
node tests/unit.js && node tests/handlers.js && node tests/regression.js
```

Exit code `0` = all pass, `1` = failure.

Firefox engine (needs working Firefox; blocked on machines where the
bundled Nightly refuses `-profile`, e.g. this dev Mac — see note below):

```sh
python3 -m playwright install firefox   # once
python3 tests/firefox-content.py
```

Exit code `0` = all pass, `1` = failure.

- `tests/firefox-content.py` (real Firefox engine, mock DOM): L1/L3-pure
  detection, negative-table rejection, placeholder-course rejection,
  hostile-title text parsing, 200-row parse budget (< 25 s incl. settle
  waits). NOTE: could not execute on this dev Mac — the Playwright-bundled
  Nightly exits with "Could not find profile folder" for any `-profile`
  launch (binary-level environment defect, reproduced outside Playwright).
  Expected green on CI/dev machines with working Firefox; `content.js`
  itself is engine-agnostic DOM (`querySelector`, `innerText`/`textContent`
  with fallback, no Chrome-only APIs). Covers:

- `tests/unit.js` (no browser): pure functions from the real files —
  `sanitizeFolderName/Path` (both files, 2- and 3-level caps, traversal,
  illegal chars), `resolveFolderPath` (all 3 templates), `groupKeysByFaculty`
  (+ unknown-faculty fallback), `previewFolder`, `courseTextToSemester`,
  `formatBytes`/`summarizeSizes`
- `tests/handlers.js` (no browser): real `background.js` message contracts
  (ARM/EXTEND/DISARM, newest-job attribution, `uniquify`), hostile filenames
  (`..`, `.`, absolute paths, whitespace), `POLL_DOWNLOAD`,
  `CLOSE_STRAY_TABS` (self-tab exclusion), `SIZE_REPORT` mapping, unknown-job
  no-ops, and service-worker-restart persistence (registry + telemetry
  survive; size index degrades gracefully). `SIZE_REPORT` unions the memory
  index with the persisted `downloadJobs` map, so the report survives worker
  restarts (v1.9.1, found on a live 46-file batch)
- `content.js`: L1/L2 table detection, no-table graceful path, `DIAGNOSTICS`,
  `ADVANCE_PAGE` no-next, single-click no-dupe, duplicate-injection guard,
  skip reasons, pause-proof bounded scan of churning tables, hostile-title
  inert rendering
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
- `popup.js`: terminology, history badges, folder templates (incl.
  Semester/Course/Faculty split), diagnostics
  overlay (copy report, tour replay), page sweep (no-next), per-key queue (pause/resume, cancel,
  retry-skipped, safe-mode 2-vs-3 attempts, live row statuses), per-item failures that no longer
  poison the batch, skip-existing, search, presets/invert, faculty chips,
  repeated-title forecast, preview upgrade, coach tour, empty-filter note,
  GET_COURSE staleness guard, changed-course abort, leading-miss early stop,
  serialized loads, idempotent wiring, history recording

## Live tests

Authenticated VTOP end-to-end (downloads, pagination, concurrency) cannot run
here — they need a logged-in session. See the project test reports for the
live matrix and run those flows manually after VTOP UI changes.

## Browser compatibility

- Chromium/Chrome/Edge: full suites above. Measured: 200-row table parses
  in ~2.3 s (incl. settle waits); repeat scans ~11 ms with no accumulation
  growth; `downloadJobs` map capped at 200 under 250-download soak.
- Firefox: `manifest.json` carries `browser_specific_settings.gecko`
  (id `vit-bulk-downloader@local`, min 109.0). Every `chrome.*` API used
  (`downloads` incl. `onDeterminingFilename`+`uniquify`, `storage.local`,
  `tabs`, `scripting.executeScript`, `notifications`, SW background) is
  supported in Firefox MV3; the job registry lives in `storage.local` so
  worker restarts are safe by design. One manual check remains: subdirectory
  suggestions (`Semester/Course[/Faculty]/`) must be verified in Firefox —
  if it strips relative paths, fall back to flat course folder there.
