// content.js
// Runs on vtop.vit.ac.in/vtop/*.
//
// v1.3: the ONLY site control this script touches automatically is the
// "Show entries" dropdown - it bumps it to the max option once per scan,
// the same way you'd click it by hand, then reads whatever renders.
// It never clicks Next/Previous or navigates pages itself; an earlier
// version did that (repeatedly, in a loop) and it desynced VTOP's live
// authenticated session. So multi-page courses still need you to click
// Next yourself and hit Refresh - see README.

// Idempotent injection guard: manifest auto-inject + popup fallback
// scripting.executeScript can otherwise run this file twice in the same
// frame. Everything below lives inside an IIFE so a duplicate run only
// re-declares function-scoped bindings (no global clobbering, no duplicate
// const SyntaxError) and returns here before touching state or listeners.
(function () {
if (window.__vitBulkDownloaderInjected) {
  console.warn("VIT Bulk Downloader: duplicate content-script injection skipped.");
  return;
}
window.__vitBulkDownloaderInjected = true;

function cellText(cell) {
  // innerText preserves <br> line breaks for first-line title split, but is
  // empty when layout is hidden/backgrounded. Fall back to textContent so
  // parsing still works in background tabs.
  const t = (cell && (cell.innerText || cell.textContent)) || "";
  return norm(t);
}

function norm(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

// ---- Course dropdown -------------------------------------------------
function findCourseDropdown() {
  const selects = Array.from(document.querySelectorAll("select"));
  for (const sel of selects) {
    const opts = Array.from(sel.options || []);
    if (opts.some((o) => /semester/i.test(o.text) && o.text.includes(" - "))) {
      diagNote("course:L1-semester", `${opts.length} options`);
      return sel;
    }
  }
  // L2 fallback: the select with the most dash-separated options.
  let best = null;
  let bestCount = 0;
  for (const sel of selects) {
    const opts = Array.from(sel.options || []);
    const dashed = opts.filter((o) => (o.text || "").includes(" - ")).length;
    if (opts.length >= 3 && dashed > bestCount) {
      best = sel;
      bestCount = dashed;
    }
  }
  if (best) diagNote("course:L2-dashed", `${bestCount} dashed options`);
  else diagNote("course:none", `${selects.length} selects scanned`);
  return best;
}

function getSelectedCourseText() {
  const sel = findCourseDropdown();
  if (sel && sel.selectedIndex >= 0) {
    return norm(sel.options[sel.selectedIndex].text);
  }
  return null;
}

function courseTextToFolderName(text) {
  if (!text) return "VIT Downloads";
  const parts = text.split(" - ").map(norm).filter(Boolean);
  if (parts.length >= 3) return `${parts[1]} - ${parts[2]}`;
  return text;
}

// ---- Materials table (layered detection) --------------------------------
// L1 (strict): thead/first-row headers contain all four known labels.
// L2 (header drift): any table whose text contains "material detail" and
//   "download" — first-row cells become the header row.
// L3 (controls): table with download-like controls in one column across
//   most body rows plus material/course text. Never touches the page.
const REQUIRED_HEADERS = ["course detail", "material detail", "uploaded by", "download"];

const diagLog = [];
function diagNote(strategy, detail) {
  diagLog.push({ strategy, detail: String(detail || "").slice(0, 120), ts: Date.now() });
  if (diagLog.length > 30) diagLog.shift();
}

function headersFrom(cells) {
  return cells.map((c) => norm(c.textContent).toLowerCase());
}

function findMaterialsTable() {
  const tables = Array.from(document.querySelectorAll("table"));
  // L1
  for (const table of tables) {
    const headerCells = Array.from(table.querySelectorAll("thead th, tr:first-child th, tr:first-child td"));
    const headerText = headersFrom(headerCells);
    const hasAll = REQUIRED_HEADERS.every((h) => headerText.some((t) => t.includes(h)));
    if (hasAll) {
      diagNote("table:L1-strict", `${headerCells.length} headers`);
      return { table, headerText, strategy: "L1-strict" };
    }
  }
  // L2
  for (const table of tables) {
    const text = (table.textContent || "").toLowerCase();
    if (text.includes("material detail") && text.includes("download")) {
      const firstRow = table.querySelector("tr");
      const cells = firstRow ? Array.from(firstRow.querySelectorAll("th, td")) : [];
      const headerText = headersFrom(cells);
      if (columnIndex(headerText, "material detail") >= 0 && columnIndex(headerText, "download") >= 0) {
        diagNote("table:L2-drift", "header wording changed?");
        return { table, headerText, strategy: "L2-drift" };
      }
    }
  }
  // L3
  for (const table of tables) {
    const text = (table.textContent || "").toLowerCase();
    if (!/material|course detail/.test(text)) continue;
    const bodyRows = Array.from(table.querySelectorAll("tbody tr")).filter(
      (tr) => tr.querySelectorAll("td").length > 0
    );
    if (bodyRows.length < 1) continue;
    const colCount = bodyRows[0].querySelectorAll("td").length;
    for (let c = 0; c < colCount; c++) {
      const withControl = bodyRows.filter((tr) => {
        const cell = tr.querySelectorAll("td")[c];
        return cell && cell.querySelector("a, button, input[type='button'], input[type='submit'], [onclick], [role='button']");
      }).length;
      if (withControl >= Math.max(1, Math.ceil(bodyRows.length / 2))) {
        const headerRow = table.querySelector("thead tr") || table.querySelector("tr");
        const headerText = headersFrom(headerRow ? Array.from(headerRow.querySelectorAll("th, td")) : []);
        diagNote("table:L3-controls", `col ${c} has controls in ${withControl}/${bodyRows.length} rows`);
        return { table, headerText, strategy: "L3-controls" };
      }
    }
  }
  diagNote("table:none", `${tables.length} tables scanned`);
  return null;
}

function columnIndex(headerText, needle) {
  return headerText.findIndex((t) => t.includes(needle));
}

function findTableWrapper(table) {
  // v3.3: the old climb matched <body>/<html> on pages whose global text
  // contains both "entries" and "search" (VTOP chrome + injected script text
  // both qualify), so the length-select search then hit the COURSE dropdown
  // first. Now prefer the NEAREST ancestor that actually contains a
  // length-like select; fall back to the nearest entries+search match.
  let node = table.parentElement;
  let hops = 0;
  let entriesMatch = null;
  const near = table.parentElement;
  if (near && near.querySelector && near.querySelector("select")) return near;
  while (node && hops < 8) {
    const text = node.textContent || "";
    if (/entries/i.test(text) && /search/i.test(text)) {
      if (!entriesMatch) entriesMatch = node;
      if (node.querySelector) {
        const sels = Array.from(node.querySelectorAll("select"));
        if (sels.some(isLengthLikeSelect)) return node;
      }
    }
    node = node.parentElement;
    hops++;
  }
  return entriesMatch || table.parentElement || document;
}

// A select is course-like when its options read like course names, never
// like page lengths. This explicitly excludes the "Fall Semester - ..."  dropdown:
// "Fall" contains the substring "all", which used to fool the /all/i test.
function isCourseLikeSelect(sel) {
  const opts = Array.from(sel.options || []);
  if (!opts.length) return false;
  if (opts.some((o) => /semester/i.test(o.text || ""))) return true;
  const dashed = opts.filter((o) => (o.text || "").includes(" - ")).length;
  return opts.length >= 2 && dashed >= 2;
}

// Length-like: 2+ options, every option numeric-valued or exactly "All".
// Exact match (not substring) so "Fall Semester" can never qualify.
function isLengthLikeSelect(sel) {
  if (isCourseLikeSelect(sel)) return false;
  const opts = Array.from(sel.options || []);
  if (opts.length < 2) return false;
  return opts.every((o) => {
    const v = (o.value || "").trim();
    const t = (o.text || "").trim();
    return /^-?\d+$/.test(v) || /^\s*all\s*$/i.test(t);
  });
}

// Purely informational - reads DataTables' own "Showing 1 to 8 of 8
// entries" text if present. Never clicks or changes anything.
function readShowingInfo(wrapper) {
  const text = norm(wrapper.textContent || "");
  const m = text.match(/showing\s+(\d+)\s+to\s+(\d+)\s+of\s+(\d+)\s+entries/i);
  if (!m) return null;
  return { from: Number(m[1]), to: Number(m[2]), total: Number(m[3]) };
}

function extractDate(text) {
  const m = text.match(/(\d{2})-(\d{2})-(\d{4})/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return new Date(Number(yyyy), Number(mm) - 1, Number(dd));
}

function extractFacultyName(text) {
  const firstLine = norm(text.split("\n")[0]);
  const parts = firstLine.split(" - ").map(norm).filter(Boolean);
  if (parts.length >= 3) return parts.slice(1, -1).join(" - ");
  if (parts.length === 2) return parts[1];
  return firstLine;
}

function findClickable(cell) {
  if (!cell) return null;
  // Prefer a real download control inside the cell. Also accept the cell
  // itself ONLY if it carries its own click affordance (e.g. <td onclick>).
  // Never return a plain <td>: clicking it can sort DataTables or select the
  // row and would be miscounted as a successful download trigger.
  const inner = cell.querySelector("a, button, input[type='button'], input[type='submit'], [onclick], [role='button'], svg, i");
  if (inner) return inner;
  try {
    if (cell.hasAttribute && cell.hasAttribute("onclick")) return cell;
    if (cell.matches && cell.matches("a, button, input[type='button'], input[type='submit'], [role='button']")) return cell;
  } catch (e) {
    // matches() may throw on odd elements - fall through to null
  }
  return null;
}

function rowKey(r) {
  // Base identity from full normalized cell texts (not just derived
  // title/faculty) so distinct materials rarely collide. Physically distinct
  // rows with byte-identical cells still share this base - assignRowKeys()
  // below appends page + occurrence suffixes so every row stays distinct.
  return [r.courseDetail, r.title, r.facultyName, r.dateText, r.docCount, r.fullMaterial || "", r.uploadedByNorm || ""].join("||");
}

// v1.8.2: same faculty + same title + same date rows are DIFFERENT files and
// must never collapse. Suffix each row's key with page signature (stable for
// the same rendered page, distinct across manual Next pages) and occurrence
// index in DOM order. Deterministic: re-scanning the same page yields the
// same keys, so Refresh keeps selections and download history keeps matching.
function pageSignature(wrapper) {
  try {
    const info = wrapper ? readShowingInfo(wrapper) : null;
    // Single rendered page (everything visible): constant signature, so keys
    // survive new uploads shifting totals. Multi-page: from-to per page.
    if (info && info.to < info.total) return `pg${info.from}-${info.to}`;
  } catch (e) { /* fall through to pg1 */ }
  return "pg1";
}

function assignRowKeys(rows, sig) {
  const counts = new Map();
  for (const r of rows) {
    const base = r.baseKey || r.key;
    r.baseKey = base;
    const n = (counts.get(base) || 0) + 1;
    counts.set(base, n);
    r.occIndex = n;
    r.key = `${base}||pg:${sig}||#${n}`;
  }
  return rows;
}

// Parses whatever page of the table is CURRENTLY rendered - nothing more.
function parseCurrentPage(table, headerText) {
  const idxCourseDetail = columnIndex(headerText, "course detail");
  const idxMaterialDetail = columnIndex(headerText, "material detail");
  const idxUploadedBy = columnIndex(headerText, "uploaded by");
  const idxDownload = columnIndex(headerText, "download");

  const bodyRows = Array.from(table.querySelectorAll("tbody tr")).filter(
    (tr) => tr.querySelectorAll("td").length > 0
  );

  return bodyRows.map((tr) => {
    const cells = Array.from(tr.querySelectorAll("td"));
    const materialRaw = (cells[idxMaterialDetail] && (cells[idxMaterialDetail].innerText || cells[idxMaterialDetail].textContent)) || "";
    const uploadedByRaw = (cells[idxUploadedBy] && (cells[idxUploadedBy].innerText || cells[idxUploadedBy].textContent)) || "";
    const materialCellText = norm(materialRaw);
    const uploadedByText = norm(uploadedByRaw);
    const docMatch = materialCellText.match(/(\d+)\s*\(Document/i);
    const docCount = docMatch ? Number(docMatch[1]) : 0;
    // Split raw (pre-norm) on newlines so <br>-separated titles keep first line.
    const titleLine = norm((materialRaw.split("\n")[0] || materialCellText).trim());

    const row = {
      courseDetail: cellText(cells[idxCourseDetail]),
      title: titleLine,
      docCount,
      facultyName: extractFacultyName(uploadedByRaw),
      date: extractDate(uploadedByText),
      dateText: (uploadedByText.match(/\d{2}-\d{2}-\d{4}/) || [null])[0],
      fullMaterial: materialCellText,
      uploadedByNorm: uploadedByText,
      downloadCell: cells[idxDownload] || null
    };
    // v1.8.1: the "N (Document)" badge is unreliable - rows showing
    // "0 (Document)" often still have a working download icon (one file).
    // Gate on the actual download control, never on the badge number.
    try {
      row.hasDownload = !!findClickable(row.downloadCell);
    } catch (e) {
      row.hasDownload = !!row.downloadCell;
    }
    row.key = rowKey(row);
    return row;
  });
}

function findLengthSelect(wrapper) {
  const courseSel = (() => { try { return findCourseDropdown(); } catch (e) { return null; } })();
  const selects = Array.from(wrapper.querySelectorAll("select")).filter((s) => s !== courseSel);
  for (const sel of selects) {
    if (isLengthLikeSelect(sel)) return sel;
  }
  // Scored fallback: some VTOP pages render values with spaces/empty option
  // values. Still never accept course-like selects.
  let best = null;
  let bestScore = 0;
  for (const sel of selects) {
    if (isCourseLikeSelect(sel)) continue;
    const opts = Array.from(sel.options || []);
    if (!opts.length) continue;
    const score = opts.filter((o) => /^-?\d+$/.test((o.value || "").trim()) || /^\d+/.test((o.text || "").trim()) || /^\s*all\s*$/i.test(o.text)).length;
    if (score >= 2 && score > bestScore) {
      best = sel;
      bestScore = score;
    }
  }
  return best;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rowSignature(table, wrapper) {
  const rows = table.querySelectorAll("tbody tr");
  let count = 0;
  for (const tr of rows) {
    if (tr.querySelectorAll("td").length > 0) count++;
  }
  const firstRow = table.querySelector("tbody tr");
  const first = norm(firstRow ? (firstRow.innerText || firstRow.textContent) : "");
  const info = wrapper ? readShowingInfo(wrapper) : null;
  return `${count}|${first.slice(0, 80)}|${info ? `${info.from}-${info.to}-${info.total}` : "noinfo"}`;
}

// v3.3: condition-based wait. The old waitForRedraw only watched first-row
// text for 2s, so expanding 10->100 where the first rows are identical (or a
// slow server-side reload) parsed too early -> partial scans like 6 of 22.
// Now wait until row count + showing-info + first row are STABLE.
async function waitForTableStable(table, wrapper, timeoutMs = 9000) {
  const start = Date.now();
  let lastSig = rowSignature(table, wrapper);
  let stableSince = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(150);
    // Table may have been re-rendered by DataTables; guard detached nodes.
    if (!table.isConnected) return false;
    const sig = rowSignature(table, wrapper);
    if (sig !== lastSig) {
      lastSig = sig;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 800) {
      return true;
    }
  }
  return Date.now() - stableSince >= 800;
}

async function waitForRedraw(table, previousFirstRowText, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(120);
    const firstRow = table.querySelector("tbody tr");
    const text = norm(firstRow ? firstRow.textContent : "");
    if (text !== previousFirstRowText) return true;
  }
  return false;
}

// The ONLY automated interaction with the site's own controls: picking
// the largest "Show entries" option, once, the same way you'd do it by
// hand (set the value, fire a real "change" event). This does NOT click
// Next/Previous or navigate pages - repeated page-navigation clicks are
// what previously desynced the live page, so that part stays manual
// (see README "Why this changed").
async function ensureMaxPageLength(table, wrapper) {
  const detail = { expanded: false, before: 0, after: 0, warning: null };
  const lengthSelect = findLengthSelect(wrapper);
  if (!lengthSelect) return detail;

  const opts = Array.from(lengthSelect.options);
  let best = opts.find((o) => /^\s*all\s*$/i.test(o.text) || (o.value || "").trim() === "-1");
  if (!best) {
    best = opts.reduce((max, o) => {
      const v = parseInt(o.value, 10);
      const maxV = parseInt(max.value, 10);
      return v > maxV ? o : max;
    }, opts[0]);
  }
  detail.before = table.querySelectorAll("tbody tr").length;
  if (!best || lengthSelect.value === best.value) {
    detail.after = table.querySelectorAll("tbody tr").length;
    return detail;
  }

  lengthSelect.value = best.value;
  try {
    lengthSelect.dispatchEvent(new Event("change", { bubbles: true }));
  } catch (e) { /* fall through to input event */ }
  try {
    lengthSelect.dispatchEvent(new Event("input", { bubbles: true }));
  } catch (e) { /* older pages may reject Event ctor - change already fired */ }
  // Best-effort DataTables API path for server-side tables.
  try {
    const $ = window.jQuery || window.$;
    if ($ && $.fn && $.fn.dataTable) {
      const api = $(table).DataTable();
      if (api && api.page && api.page.len) {
        const v = (best.value || "").trim() === "-1" || /^\s*all\s*$/i.test(best.text) ? -1 : parseInt(best.value, 10);
        api.page.len(v).draw(false);
      }
    }
  } catch (e) {
    // DOM change event above is the supported path; API is opportunistic.
  }
  detail.expanded = true;
  // Minimum settle: server-side tables need a moment before the reload even
  // starts changing the DOM. Without this, a stability check alone returns
  // early (table looks "stable" while the async fetch is still in flight) -
  // the exact 6-of-22 partial-scan bug.
  await sleep(1300);
  await waitForTableStable(table, wrapper, 9000);
  detail.after = table.querySelectorAll("tbody tr").length;

  // Retry once if VTOP's own counter says more rows exist than we parsed.
  try {
    const info = wrapper ? readShowingInfo(wrapper) : null;
    if (info && info.total > detail.after) {
      await sleep(1500);
      detail.after = table.querySelectorAll("tbody tr").length;
      if (info.total > detail.after) {
        detail.warning = `partial-scan-risk: showing ${detail.after} of ${info.total}`;
        diagNote("scan:partial-risk", detail.warning);
      }
    }
  } catch (e) {
    // informational only - never break the scan
  }
  return detail;
}

// Rows accumulate across GET_STATE calls for the SAME course, so that if
// you manually page through the table on the live site and hit Refresh
// after each page, everything you've seen gets kept together. Switching
// to a different course clears this automatically.
let accumulated = new Map(); // key -> row
let accumulatedCourseText = null;

async function getState() {
  const courseText = getSelectedCourseText();

  if (courseText !== accumulatedCourseText) {
    accumulated = new Map();
    accumulatedCourseText = courseText;
  }

  const found = findMaterialsTable();
  if (!found) {
    return {
      ok: false,
      courseText,
      rows: [],
      error: "Couldn't find the Course Materials table on this page. Make sure it's visible, then click Retry."
    };
  }

  const { table, headerText, strategy } = found;
  const wrapper = findTableWrapper(table);

  const scanDetail = await ensureMaxPageLength(table, wrapper);

  const showingInfo = readShowingInfo(wrapper);

  const currentPageRows = parseCurrentPage(table, headerText);
  assignRowKeys(currentPageRows, pageSignature(wrapper));
  currentPageRows.forEach((r) => accumulated.set(r.key, r));

  const rows = Array.from(accumulated.values());
  const multiDocRows = rows.filter((r) => r.docCount > 1).length;

  // Display disambiguator for same title+faculty+date groups ("copy 2 of 5").
  // Groups follow accumulated insertion order, so labels are deterministic.
  const dupGroups = new Map();
  for (const r of rows) {
    const g = [r.title, r.facultyName, r.dateText].join("||");
    if (!dupGroups.has(g)) dupGroups.set(g, []);
    dupGroups.get(g).push(r);
  }
  for (const list of dupGroups.values()) {
    list.forEach((r, i) => {
      r.dupIndex = list.length > 1 ? i + 1 : 0;
      r.dupTotal = list.length > 1 ? list.length : 0;
    });
  }

  return {
    ok: !!(courseText && rows.length),
    courseText,
    folderNameSuggestion: courseTextToFolderName(courseText),
    showingInfo, // {from, to, total} straight from the page's own text, or null
    seenSoFar: rows.length,
    tableStrategy: strategy || null,
    multiDocRows,
    scanDetail: scanDetail || null,
    rows: rows.map((r) => ({
      key: r.key,
      title: r.title,
      docCount: r.docCount,
      hasDownload: r.hasDownload !== false,
      dupIndex: r.dupIndex || 0,
      dupTotal: r.dupTotal || 0,
      facultyName: r.facultyName,
      dateText: r.dateText
    })),
    error:
      !courseText && !rows.length
        ? "Couldn't find the course dropdown or the materials table on this page. Make sure you're on the Course Page with a course selected."
        : !courseText
        ? "Found the materials table but couldn't read the selected course from the dropdown."
        : null
  };
}

// v3.3 duplicate guard: ignore re-clicks of the same row within 30s.
// Double-fire used to produce file.pdf + file (1).pdf pairs.
const recentClicks = new Map(); // key -> timestamp ms
const DUPLICATE_WINDOW_MS = 30000;

// Best-effort background RPC with timeout. Old background workers (or test
// mocks without the new handlers) resolve undefined -> caller falls back to
// legacy behavior instead of breaking. Supports both callback-style and
// promise-style (MV3) sendMessage.
function bgRequest(type, payload) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (v) => { if (!done) { done = true; if (timer) clearTimeout(timer); resolve(v); } };
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) return finish(null);
      timer = setTimeout(() => finish(null), 1200);
      const ret = chrome.runtime.sendMessage({ type, ...(payload || {}) }, (resp) => {
        if (chrome.runtime && chrome.runtime.lastError) return finish(null);
        finish(resp == null ? null : resp);
      });
      if (ret && typeof ret.then === "function") {
        ret.then((resp) => finish(resp == null ? null : resp), () => finish(null));
      }
    } catch (e) {
      finish(null);
    }
  });
}

// Only clicks Download icons for rows that are actually present on the
// CURRENTLY rendered page - never navigates anywhere itself. Anything
// selected that isn't currently on screen is reported back as skipped so
// the popup can tell you to go to that page and try again.
//
// v3.3 resilience: every key is isolated in try/catch and ALWAYS continues
// to the next key. A corrupt/error file that opens an error page instead of
// downloading is detected (no new download + page/table disturbed or stray
// tab signal), reported as error-page/no-download, and never blocks the rest.
async function downloadRows(keys, onProgress) {
  const found = findMaterialsTable();
  let clicked = 0;
  let skipped = 0;
  const skippedDetails = [];
  const total = keys.length;

  if (!found) {
    return { clicked: 0, skipped: total, ok: false, error: "no_table", skippedDetails };
  }

  const { table, headerText } = found;
  const liveRows = parseCurrentPage(table, headerText);
  assignRowKeys(liveRows, pageSignature(findTableWrapper(table)));
  const liveByKey = new Map(liveRows.map((r) => [r.key, r]));

  const reportSkip = (key, title, reason) => {
    skipped++;
    skippedDetails.push({ key, title, reason });
    onProgress && onProgress({ done: clicked + skipped, total, current: title, skipped: true });
  };

  for (const key of keys) {
    let row = null;
    try {
      row = liveByKey.get(key);
    } catch (e) {
      reportSkip(key, "(unknown item)", "failed");
      continue;
    }
    if (!row) {
      reportSkip(key, "(not on this page right now)", "not-on-page");
      continue;
    }
    // v1.8.1: gate on the download control, NOT the "N (Document)" badge.
    // Badge "0 (Document)" rows usually still carry one real file.
    const el = findClickable(row.downloadCell);
    if (!row.downloadCell || !el) {
      reportSkip(key, row.title, "no-control");
      continue;
    }
    // Duplicate-click guard (Fix B).
    try {
      const last = recentClicks.get(key) || 0;
      if (Date.now() - last < DUPLICATE_WINDOW_MS) {
        reportSkip(key, row.title, "duplicate-click");
        continue;
      }
    } catch (e) { /* map failure must never block downloads */ }
    const startTs = Date.now();
    let pollBefore = null;
    try {
      const p = await bgRequest("POLL_DOWNLOAD", { sinceTs: 0 });
      if (p && typeof p.total === "number") pollBefore = p.total;
    } catch (e) { pollBefore = null; }
    try {
      el.scrollIntoView({ block: "center" });
      // Single trusted click only. A previous version also dispatched a
      // synthetic MouseEvent here, which fired VTOP handlers twice and
      // produced file.pdf + file (1).pdf duplicates.
      el.click();
      recentClicks.set(key, Date.now());
    } catch (e) {
      reportSkip(key, row.title, "failed");
      continue;
    }
    // Adaptive settle: safe-mode callers send keys one-by-one with bigger
    // popup gaps; keep content settle short so queues stay fast.
    await sleep(900);
    try {
      // 1) Same-tab navigation check: error files sometimes replace the
      // course page itself. If our table is gone, do NOT count a download.
      const stillThere = findMaterialsTable();
      if (!stillThere) {
        try { await bgRequest("CLOSE_STRAY_TABS", { sinceTs: startTs }); } catch (e) {}
        reportSkip(key, row.title, "error-page");
        continue;
      }
      // 2) Download + stray-tab check via background (null = old worker).
      const poll = await bgRequest("POLL_DOWNLOAD", { sinceTs: startTs });
      const newDownloads = poll && typeof poll.newDownloads === "number" ? poll.newDownloads : null;
      if (newDownloads === 0) {
        const closed = await bgRequest("CLOSE_STRAY_TABS", { sinceTs: startTs });
        const closedCount = closed && typeof closed.closed === "number" ? closed.closed : 0;
        if (closedCount > 0) {
          reportSkip(key, row.title, "error-page");
          continue;
        }
        // No download yet but also no stray tab seen: VTOP can be slow.
        // Give it one more short window before calling it missing, then
        // mark no-download (retryable) instead of fake success.
        await sleep(1200);
        const poll2 = await bgRequest("POLL_DOWNLOAD", { sinceTs: startTs });
        const retry = poll2 && typeof poll2.newDownloads === "number" ? poll2.newDownloads : null;
        if (retry === 0) {
          try { await bgRequest("CLOSE_STRAY_TABS", { sinceTs: startTs }); } catch (e) {}
          reportSkip(key, row.title, "no-download");
          continue;
        }
      }
    } catch (e) {
      // Verification is best-effort; on any verifier failure fall through
      // to legacy counted-click so slow/odd pages still download.
    }
    clicked++;
    onProgress && onProgress({ done: clicked + skipped, total, current: row.title, skipped: false });
  }

  return { clicked, skipped, ok: true, skippedDetails };
}

// Single verified page-advance for the experimental "all pages" flow.
// Clicks Next AT MOST once, then verifies the table actually changed
// (first-row key differs). Any anomaly -> { advanced: false } and the
// popup aborts the sweep. Never loops by itself.
async function advancePageOnce() {
  const courseBefore = getSelectedCourseText();
  const found = findMaterialsTable();
  if (!found) return { advanced: false, reason: "no_table" };
  const { table, headerText } = found;
  const beforeRows = parseCurrentPage(table, headerText);
  if (!beforeRows.length) return { advanced: false, reason: "no_rows" };
  const beforeKey = beforeRows[0].key;

  const wrapper = findTableWrapper(table);
  const scope = wrapper && wrapper.querySelectorAll ? wrapper : document;
  const candidates = Array.from(
    scope.querySelectorAll(
      ".dataTables_paginate .paginate_button.next, a.paginate_button.next, button.paginate_button.next, [id$='Next'], [aria-label='Next']"
    )
  );
  const next = candidates.find((b) => {
    try {
      if (b.disabled) return false;
      if (b.classList && (b.classList.contains("disabled") || b.classList.contains("paginate_button_disabled"))) return false;
      if (b.getAttribute && b.getAttribute("aria-disabled") === "true") return false;
      const style = window.getComputedStyle ? window.getComputedStyle(b) : null;
      if (style && (style.display === "none" || style.visibility === "hidden")) return false;
      return true;
    } catch (e) {
      return false;
    }
  });
  if (!next) return { advanced: false, reason: "no_next" };

  try {
    next.scrollIntoView({ block: "nearest" });
    next.click();
  } catch (e) {
    return { advanced: false, reason: "click_failed" };
  }

  const start = Date.now();
  while (Date.now() - start < 5000) {
    await sleep(250);
    if (getSelectedCourseText() !== courseBefore) {
      return { advanced: false, reason: "course_changed" };
    }
    const again = findMaterialsTable();
    if (!again) return { advanced: false, reason: "table_gone" };
    const live = parseCurrentPage(again.table, again.headerText);
    if (live.length && live[0].key !== beforeKey) {
      return { advanced: true, rowsOnPage: live.length };
    }
  }
  return { advanced: false, reason: "no_change" };
}

// Read-only self check for the Diagnostics screen. Never clicks anything
// except nothing at all: pure DOM inspection.
function runDiagnostics() {
  const selects = Array.from(document.querySelectorAll("select"));
  const tables = Array.from(document.querySelectorAll("table"));
  const found = findMaterialsTable();
  let downloadButtons = 0;
  let multiDoc = 0;
  if (found) {
    const bodyRows = Array.from(found.table.querySelectorAll("tbody tr")).filter(
      (tr) => tr.querySelectorAll("td").length > 0
    );
    bodyRows.forEach((tr) => {
      if (tr.querySelector("a, button, input[type='button'], input[type='submit'], [onclick], [role='button']")) {
        downloadButtons++;
      }
    });
    const idx = columnIndex(found.headerText, "material detail");
    if (idx >= 0) {
      bodyRows.forEach((tr) => {
        const cell = tr.querySelectorAll("td")[idx];
        // innerText first: textContent concatenates across <br> ("T1"+"1 (Document)"
        // becomes "T11 (Document)" and inflates the count).
        const txt = norm((cell && (cell.innerText || cell.textContent)) || "");
        const m = txt.match(/(\d+)\s*\(Document/i);
        if (m && Number(m[1]) > 1) multiDoc++;
      });
    }
  }
  return {
    url: location.href,
    selects: selects.length,
    tables: tables.length,
    tableFound: !!found,
    tableStrategy: (found && found.strategy) || null,
    courseText: getSelectedCourseText(),
    downloadButtons,
    multiDocRows: multiDoc,
    log: diagLog.slice(-12)
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "GET_STATE") {
    getState().then(sendResponse);
    return true; // async
  }

  if (msg && msg.type === "DOWNLOAD_ROWS") {
    downloadRows(msg.keys, (progress) => {
      chrome.runtime.sendMessage({ type: "DOWNLOAD_PROGRESS", progress });
    }).then((result) => sendResponse(result));
    return true; // async
  }

  if (msg && msg.type === "ADVANCE_PAGE") {
    advancePageOnce().then(sendResponse);
    return true; // async
  }

  if (msg && msg.type === "DIAGNOSTICS") {
    try {
      sendResponse({ ok: true, diag: runDiagnostics() });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
    return false;
  }
});
})(); // end idempotent IIFE
