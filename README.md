# VIT Bulk Material Downloader

A Chrome extension for `vtop.vit.ac.in` course pages. It reads the course
you've selected, lets you filter that course's materials by faculty and
date, lets you tick which ones you want, then downloads all of them in one
go — automatically saved into `Downloads/<Course Name>/` instead of loose
in your main Downloads folder.

## Install (load unpacked)

1. Unzip this folder somewhere permanent (don't delete it after — Chrome
   loads the extension from these files every time).
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this folder.
5. Pin the extension (puzzle-piece icon in the toolbar → pin) so it's easy
   to click.

## How to use it

1. Log into VTOP and open **Course Page → Course Page - view**, with the
   course you want selected in the "Select Registered Course" dropdown.
2. Click the extension's icon. It automatically sets "Show entries" to
   the highest option (e.g. 100) for you — one single, one-time change,
   the same as clicking it yourself — then reads the table.
3. It auto-fills the detected course name and a suggested folder name
   (editable), and shows VTOP's own "Showing X to Y of Z entries" count so
   you know if there's more beyond what's currently visible.
4. Optionally filter by **Faculty** and **From/To date**.
5. **Nothing is selected by default.** Tick the materials you want, or
   click **Select all** to select everything currently matching your
   filter.
6. Click **Download selected**. Over 10 files triggers a confirmation
   prompt first, since that's a lot of storage/bandwidth at once.
7. Check your Downloads folder — a new subfolder named after the course
   will have every file you picked inside it.

### If there are more materials than the max "Show entries" option

That covers the vast majority of courses in one shot. If a course
genuinely has more entries than the highest available option, manually
click **Next** on the VTOP page itself, then click **Refresh** in the
popup: what you've already seen is kept, and the new page's rows get
added to it. Switching to a different course in the dropdown clears this
automatically so materials from different courses never mix.

### Why the extension only touches "Show entries" and nothing else (v1.2/v1.3)

An early version also auto-clicked Next/Previous in a loop to page through
the whole table by itself. On VTOP's live, authenticated session that
desynced the page's own UI state. Bumping "Show entries" to its max value
is a single, one-off change — the same action you'd take by hand — so it
stayed in; repeated automatic page-navigation clicking did not. The only
other thing this extension ever clicks on the real page is a Download
icon, and only for materials you've explicitly ticked.

## How the folder-saving actually works

Chrome extensions can't literally "choose a save folder" through a picker,
but they *can* rewrite the save path of any download while it's happening.
So instead of guessing how VTOP's download button works internally, this
extension:
- Arms a short capture window right before clicking anything,
- Clicks each selected material's Download button on the real page (so it
  behaves exactly like you clicking it yourself, just automated and looped),
- Catches every file Chrome saves during that window and renames its path
  to `<Course Folder>/<original file name>`.

This works regardless of whether VTOP's download is a direct link, a
JavaScript/blob download, or a form submission — as long as it results in
an actual file save, it gets redirected into the course folder.

## Things I couldn't verify without a live login (please check these)

I built this from screenshots, not the live HTML, so a couple of
behaviors are assumptions. If something doesn't work exactly right,
it's likely one of these:

1. **The Download icon might open a preview tab instead of saving a
   file.** If clicking a row's download icon opens the PDF/PPT in a new
   browser tab instead of triggering an actual "Save As" download, this
   extension has nothing to intercept, and nothing will land in the
   folder. Tell me if you see this and I'll add a step that fetches the
   file directly instead.

2. **Rows with 2+ documents ("2 (Document)") might need an extra click.**
   I assumed the single Download icon per row grabs everything for that
   material. If a row has multiple attached files and the icon only grabs
   one of them, tell me what happens when you click the "2 (Document)"
   link itself (does it expand a list with its own download links?) so I
   can add a second pass for those rows.

3. **The "Showing X to Y of Z entries" text might be worded differently.**
   That's read purely for the informational count in the popup — if it's
   missing, the popup just won't show the total, nothing else is
   affected.

If any of these come up, right-click the relevant element on the VTOP
page → **Inspect** → right-click the highlighted line in DevTools →
**Copy → Copy outerHTML**, and send that to me — I can fix the selector
logic precisely instead of guessing again.

## Files

- `manifest.json` — extension configuration (Manifest V3)
- `background.js` — intercepts downloads and redirects them into the
  course folder
- `content.js` — reads the course name and materials table from the page,
  and clicks the Download buttons you selected
- `popup.html` / `popup.css` / `popup.js` — the popup UI (filters,
  checklist, Download button)

## v1.8.0 — full-scan fix, duplicate guard, error-page-safe queue

**Partial scans fixed (e.g. 6 of 22 shown for one faculty).** Root cause:
the table wrapper search could resolve to `<body>`/`<html>`, and the
course dropdown ("Fall Semester…") then passed the Show-entries check
because "F-all" matches `/all/i` — so the extension thought "Show 10"
was already max and never expanded. Now: the wrapper prefers the
nearest container holding a real page-length select, only exact "All"
counts (never substrings), the course dropdown is explicitly excluded,
and after expanding the scan waits for the row count to stabilize
(plus a DataTables API attempt and one retry against VTOP's own
"Showing X of Z" counter). If a partial scan is still suspected, the
popup says so and suggests Refresh / manual Next.

**No duplicate downloads.** Re-clicking the same row within 30s is
ignored (`duplicate-click`), the queue dedupes keys up front, download
history + "Skip already downloaded" still applies, and the background
keeps `uniquify` so files can never overwrite each other.

**Corrupt/error files no longer interrupt the batch.** If clicking a
row opens an error page instead of downloading, the extension detects
it (no new download + stray tab), closes the stray tab automatically,
marks that row `error-page`/`no-download` (retryable via Retry
skipped, never recorded as downloaded), and continues with the next
file. Safe mode adds bigger gaps and retries as before. Every row is
isolated in try/catch — one bad file can't stall the queue.

Requires the `tabs` permission (to detect/close error tabs opened
during a batch). All 21 regression checks pass (`node
tests/regression.js`).

## v1.8.1 — no grouping by badge: every file listed individually

**"22 documents instead of 19 files" fixed.** The popup used to sum the
"N (Document)" badges and hide every row showing "0 (Document)" — but on
real VTOP pages those rows still carry a working download icon (one
file each). The badge is now display info only, never a filter: every
row with a download button is listed individually (your 19 rows → 19
files), and only rows with genuinely no download control are skipped
(`no-control`). The header counts files first ("19 files · 22
documents · …"). No grouping, no hidden rows.

## v1.8.2 — identical rows are distinct files + size report

**Same faculty + same title no longer collapses.** Five identical
"Breeding self-pollinated crops" rows used to merge into one entry (19
rows → 11 files) because the row identity was purely cell text. Keys
now carry a page signature + occurrence index (`…||pg:pg1||#3`), so
every physical row lists and downloads individually — deterministically,
so Refresh keeps selections and download history keeps matching.
Duplicate titles show "copy 2 of 5" in the list. Same-named files on
disk keep Chrome's `name (1).pdf` uniquify naming, never overwritten.

**File sizes, as asked:** VTOP shows no size column, so size is only
knowable after download — the extension now reports it then. After each
batch, a `SIZE_REPORT` collects final sizes and the popup lists them on
top, e.g. `a.pdf × 3: 2 MB × 2 identical, 1.7 MB` — equal sizes mean
almost surely the same content, different sizes prove different files
despite the same name. Unknown sizes (server sent no length) say so
instead of blocking anything. All 27 regression checks pass (`node
tests/regression.js`).

## v1.8.3 — UI reskin (no functional changes)

Token-driven restyle of the popup only: uppercase section labels,
2×2 action-button grid, segmented toggle pills, navy checked-row tint,
tabular numerals on all counts/sizes, sticky count bar on top + sticky
download bar at the bottom, visible focus rings, and a proper green
style for size-report lines. Same DOM, same logic — all 27 regression
checks pass.

**Pills fix:** the New/Skip/Safe toggles are one-line pills pinned under
the header while scrolling (they used to wrap to two lines and slide
under the sticky bar). Short labels with full-text tooltips.
