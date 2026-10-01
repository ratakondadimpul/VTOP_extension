let currentState = null;
let selectedKeys = new Set();
let lastCourseText = null;
// loadState serialization: concurrent loads (auto-load + Retry racing)
// must not interleave scans and desync rows from selection/DOM.
let loadRunning = false;
let loadSeq = 0;
const LARGE_BATCH_THRESHOLD = 10;

// Phase 2: local download history + folder template.
// downloadHistory: Map rowKey -> { course, folder, title, ts }.
// Row keys embed course/faculty/date/title/docCount, so re-downloads of the
// same VTOP material match even across popup sessions.
let downloadedKeys = new Map();
let showOnlyNew = false;
let skipExisting = true;
let folderTemplate = "course"; // "course" | "semester-course" | "semester-course-faculty"
let coachSeen = false; // first-run tour; persisted in storage.local
let coachShownThisSession = false; // never resurrect via Refresh mid-session
let lastDiagReport = null; // last diagnostics payload, for Copy report
const HISTORY_LIMIT = 2000;

const el = (id) => document.getElementById(id);

function storageGet(keys) {
  return new Promise((resolve) => {
    try {
      if (!chrome.storage || !chrome.storage.local) return resolve({});
      chrome.storage.local.get(keys, (data) => resolve(data || {}));
    } catch (e) {
      resolve({});
    }
  });
}

function storageSet(obj) {
  return new Promise((resolve) => {
    try {
      if (!chrome.storage || !chrome.storage.local) return resolve();
      chrome.storage.local.set(obj, () => resolve());
    } catch (e) {
      resolve();
    }
  });
}

async function loadPhase2State() {
  const data = await storageGet(["downloadHistory", "folderTemplate", "safeMode", "coachSeen"]);
  const hist = data.downloadHistory;
  if (hist && typeof hist === "object") {
    downloadedKeys = new Map(Object.entries(hist));
  }
  if (data.folderTemplate === "course" || data.folderTemplate === "semester-course" || data.folderTemplate === "semester-course-faculty") {
    folderTemplate = data.folderTemplate;
  }
  coachSeen = data.coachSeen === true;
  const tmpl = el("folderTemplate");
  if (tmpl) tmpl.value = folderTemplate;
  const skipBox = el("skipExistingBox");
  if (skipBox) skipBox.checked = skipExisting;
  const safeBox = el("safeModeBox");
  safeMode = data.safeMode === true;
  if (safeBox) safeBox.checked = safeMode;
  const newBox = el("newOnlyFilter");
  if (newBox) newBox.checked = showOnlyNew;
}

async function recordDownloads(entries) {
  // entries: [{ key, course, folder, title }]
  if (!entries.length) return;
  const now = Date.now();
  entries.forEach((e) => {
    downloadedKeys.set(e.key, { course: e.course, folder: e.folder, title: e.title, ts: now });
  });
  // Prune oldest beyond HISTORY_LIMIT.
  if (downloadedKeys.size > HISTORY_LIMIT) {
    const sorted = Array.from(downloadedKeys.entries()).sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
    const drop = sorted.slice(0, downloadedKeys.size - HISTORY_LIMIT);
    drop.forEach(([k]) => downloadedKeys.delete(k));
  }
  await storageSet({ downloadHistory: Object.fromEntries(downloadedKeys) });
}

// "Fall Semester 2025-26 - ISWE204L - ..." -> "Fall Semester 2025-26".
function courseTextToSemester(text) {
  if (!text) return null;
  const first = String(text).split(" - ")[0];
  const normed = (first || "").replace(/\s+/g, " ").trim();
  return normed || null;
}

// Folder input holds the course folder; the template decides the full path.
// Preview sanitization mirrors background.js sanitizeFolderPath exactly so the
// preview shows where Chrome will actually save (invalid chars stripped,
// traversal collapsed, capped at 2 levels). ARM folderName itself is still
// sanitized authoritatively in the background; this is display-only.
function sanitizeFolderName(name) {
  const cleaned = (name || "VIT Downloads")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/g, "")
    .trim();
  return cleaned || "VIT Downloads";
}

function sanitizeFolderPath(path) {
  const segs = String(path || "")
    .split("/")
    .map((s) => sanitizeFolderName(s))
    .filter((s) => s && s !== "." && s !== ".." && s !== "-" && s !== "VIT Downloads");
  // Cap at 3 levels ("Semester/Course/Faculty"). Traversal/empty/excess
  // segments are dropped so a crafted name can never escape Downloads/.
  const kept = segs.slice(0, 3);
  if (!kept.length) return "VIT Downloads";
  return kept.join("/");
}

function resolveFolderPath(courseFolder, courseText, facultyName) {
  const base = (courseFolder || "").trim() || (currentState && currentState.folderNameSuggestion) || "VIT Downloads";
  const sem = courseTextToSemester(courseText || (currentState && currentState.courseText));
  if (folderTemplate === "semester-course-faculty") {
    // No faculty passed (e.g. preview with nothing selected): base path only.
    // Grouping (groupKeysByFaculty) always supplies a concrete faculty string.
    if (sem && sem !== base) {
      // Flatten "/" inside the faculty name: sanitizeFolderPath splits on
      // "/" first, so an unflattened "A/B" would become an extra level.
      const fac = (facultyName || "").replace(/\//g, "-").replace(/\s+/g, " ").trim();
      if (fac && fac !== base) return `${sem}/${base}/${fac}`;
      return `${sem}/${base}`;
    }
    return base;
  }
  if (folderTemplate === "semester-course") {
    if (sem && sem !== base) return `${sem}/${base}`;
  }
  return base;
}

// Semester/Course/Faculty template: one subfolder per faculty, so a batch
// spanning several faculty splits into one download group each. Pure
// function of currentState (no DOM) for testability.
function groupKeysByFaculty(keys) {
  const byKey = new Map(((currentState && currentState.rows) || []).map((r) => [r.key, r]));
  const groups = new Map();
  for (const k of keys || []) {
    const row = byKey.get(k);
    const fac = ((row && row.facultyName) || "").replace(/\s+/g, " ").trim() || "Unknown faculty";
    if (!groups.has(fac)) groups.set(fac, []);
    groups.get(fac).push(k);
  }
  return groups;
}

function distinctFaculties(keys) {
  return Array.from(groupKeysByFaculty(keys).keys());
}

// Display folder for preview/progress text. Single faculty -> concrete path;
// mixed/empty selection -> base path (callers add the per-faculty note).
function previewFolder(courseFolder, keys) {
  const base = resolveFolderPath(courseFolder);
  if (folderTemplate !== "semester-course-faculty") return base;
  const facs = distinctFaculties(keys);
  if (facs.length === 1) return resolveFolderPath(courseFolder, undefined, facs[0]);
  return base;
}

function updateFolderPreview() {
  const preview = el("folderPreview");
  if (!preview) return;
  const courseFolder = el("folderName").value.trim() || (currentState && currentState.folderNameSuggestion) || "";
  if (!courseFolder && !currentState) {
    preview.textContent = "";
    return;
  }
  let dest = previewFolder(courseFolder, Array.from(selectedKeys));
  try { dest = sanitizeFolderPath(dest); } catch (e) { /* preview falls back to raw path */ }
  if (folderTemplate === "semester-course-faculty" && distinctFaculties(Array.from(selectedKeys)).length !== 1) {
    preview.textContent = `Files will save to Downloads/${dest}/ — one subfolder per faculty.`;
    return;
  }
  preview.textContent = `Files will save to Downloads/${dest}/`;
}

function showLoading(text) {
  el("loadingState").classList.remove("hidden");
  el("loadingState").querySelector("p").textContent =
    text || "Looking for the course materials table…";
  el("errorState").classList.add("hidden");
  el("readyState").classList.add("hidden");
}

function showError(message) {
  el("loadingState").classList.add("hidden");
  el("errorState").classList.remove("hidden");
  el("readyState").classList.add("hidden");
  el("errorText").textContent = message;
}

function showReady() {
  el("loadingState").classList.add("hidden");
  el("errorState").classList.add("hidden");
  el("readyState").classList.remove("hidden");
  // First-run tour: once per profile AND once per popup session, so Refresh
  // never resurrects it mid-session.
  if (!coachSeen && !coachShownThisSession) {
    coachShownThisSession = true;
    el("coachOverlay").classList.remove("hidden");
  }
}

function hideCoach() {
  el("coachOverlay").classList.add("hidden");
  coachSeen = true;
  storageSet({ coachSeen: true });
}

async function getActiveVtopTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes("vtop.vit.ac.in")) return null;
  return tab;
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(response);
    });
  });
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (e) {
    // already injected, or not permitted - GET_STATE call will tell us
  }
}

async function loadState() {
  // Serialize: a second load (double-clicked Retry, auto-load + manual
  // retry racing) must not interleave scans and desync rows/selection.
  if (loadRunning) return;
  loadRunning = true;
  const mySeq = ++loadSeq;
  const alive = () => mySeq === loadSeq && loadRunning;
  showLoading("Setting \"Show entries\" to the max and reading the table…");
  const tab = await getActiveVtopTab();
  if (!alive()) return;
  if (!tab) {
    showError("Open your VTOP Course Page tab (vtop.vit.ac.in) first, with a course selected, then reopen this popup.");
    loadRunning = false;
    return;
  }

  let response = await sendMessageToTab(tab.id, { type: "GET_STATE" });
  if (!alive()) return;
  if (!response) {
    await ensureContentScript(tab.id);
    if (!alive()) return;
    response = await sendMessageToTab(tab.id, { type: "GET_STATE" });
  }
  if (!alive()) return;

  if (!response || !response.ok) {
    showError(
      (response && response.error) ||
        "Couldn't read the course or materials table on this page. Make sure the Course Materials table is visible, then click Retry."
    );
    loadRunning = false;
    return;
  }

  currentState = response;
  currentState._tabId = tab.id;

  if (response.courseText !== lastCourseText) {
    selectedKeys = new Set(); // different course - start selection fresh
    lastCourseText = response.courseText;
    currentState._isNewCourse = true;
  } else {
    // Same course: drop selections for keys that no longer exist (rare),
    // keep the rest so a Refresh doesn't lose your picks.
    const validKeys = new Set(response.rows.map((r) => r.key));
    selectedKeys = new Set(Array.from(selectedKeys).filter((k) => validKeys.has(k)));
    currentState._isNewCourse = false;
  }

  loadRunning = false;
  renderReady();
}

function uniqueFaculty(rows) {
  const names = Array.from(new Set(rows.map((r) => r.facultyName).filter(Boolean)));
  names.sort();
  return names;
}

function parseDmy(text) {
  if (!text) return null;
  const m = text.match(/(\d{2})-(\d{2})-(\d{4})/);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

function getFilters() {
  const faculty = el("facultyFilter").value;
  const fromVal = el("dateFrom").value;
  const toVal = el("dateTo").value;
  const from = fromVal ? new Date(fromVal + "T00:00:00") : null;
  const to = toVal ? new Date(toVal + "T23:59:59") : null;
  const searchBox = el("searchBox");
  const search = searchBox ? searchBox.value.trim().toLowerCase() : "";
  return { faculty, from, to, search };
}

function rowMatchesFilters(row, filters) {
  // v1.8.1: list every row that has a download control. The "N (Document)"
  // badge is unreliable ("0 (Document)" rows usually hold one real file),
  // so it is display info only - never a filter. Explicit false keeps
  // backward compatibility with states saved before hasDownload existed.
  if (row.hasDownload === false) return false;
  if (filters.faculty !== "__ALL__" && row.facultyName !== filters.faculty) return false;
  if (filters.search) {
    const hay = `${row.title || ""} ${row.facultyName || ""}`.toLowerCase();
    if (!hay.includes(filters.search)) return false;
  }
  const rowDate = parseDmy(row.dateText);
  if (filters.from && rowDate && rowDate < filters.from) return false;
  if (filters.to && rowDate && rowDate > filters.to) return false;
  if (showOnlyNew && downloadedKeys.has(row.key)) return false;
  return true;
}

function renderReady() {
  showReady();
  // Preserve user edits across Refresh for the same course. Only reset to
  // defaults on first load or when the course actually changed.
  const isNewCourse = currentState._isNewCourse !== false;
  const prevFaculty = el("facultyFilter").value || "__ALL__";
  const prevFolder = el("folderName").value;

  el("courseText").textContent = currentState.courseText;
  if (isNewCourse || !prevFolder) {
    el("folderName").value = currentState.folderNameSuggestion;
  }
  updateFolderPreview();

  const scanNote = el("scanNote");
  const seen = currentState.rows.length;
  const info = currentState.showingInfo;
  const scanDetail = currentState.scanDetail;
  if (info && info.total > seen) {
    scanNote.textContent = `VTOP reports ${info.total} total entries — you've seen ${seen} so far (currently showing ${info.from}–${info.to}). Set "Show entries" higher or click Next on the page itself, then hit Refresh here to add the rest.`;
  } else if (info) {
    scanNote.textContent = `All ${info.total} entries for this course are visible on the current page.`;
  } else {
    scanNote.textContent = `${seen} row(s) read from the current page.`;
  }
  if (scanDetail && scanDetail.warning) {
    scanNote.textContent += ` Note: ${scanDetail.warning} — try Refresh once more; if it persists, page Next manually.`;
  }

  const facultySelect = el("facultyFilter");
  const facultyNames = uniqueFaculty(currentState.rows);
  facultySelect.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = "__ALL__";
  allOpt.textContent = "All faculty";
  facultySelect.appendChild(allOpt);
  facultyNames.forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    facultySelect.appendChild(opt);
  });
  // Restore previous faculty selection if it still exists; otherwise All.
  // Date inputs are not rebuilt, so they already persist.
  if (!isNewCourse && prevFaculty && (prevFaculty === "__ALL__" || facultyNames.includes(prevFaculty))) {
    facultySelect.value = prevFaculty;
  }
  renderChips(facultyNames);

  renderList();
}

// Faculty quick chips: All + top faculties by row count. Single-select,
// mirrors the dropdown (same filter path, same tests).
function renderChips(facultyNames) {
  const box = el("facultyChips");
  if (!box) return;
  box.innerHTML = "";
  const counts = new Map();
  for (const r of currentState.rows) {
    const f = r.facultyName || "Unknown faculty";
    counts.set(f, (counts.get(f) || 0) + 1);
  }
  const top = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => name);
  const current = el("facultyFilter").value || "__ALL__";
  const mk = (value, label) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = label;
    b.setAttribute("aria-pressed", value === current ? "true" : "false");
    b.addEventListener("click", () => {
      el("facultyFilter").value = value;
      renderChips(facultyNames);
      renderList();
    });
    box.appendChild(b);
  };
  mk("__ALL__", "All");
  // Keep dropdown-only faculties reachable: chips show the top 5, the
  // dropdown still lists everything.
  for (const name of top) mk(name, `${name} · ${counts.get(name)}`);
}

function renderList() {
  const filters = getFilters();
  const container = el("materialsList");
  container.innerHTML = "";

  const visibleRows = currentState.rows.filter((r) => r.hasDownload !== false);
  const matching = visibleRows.filter((r) => rowMatchesFilters(r, filters));
  const matchingDocs = matching.reduce((sum, r) => sum + (r.docCount || 0), 0);
  const newCount = matching.filter((r) => !downloadedKeys.has(r.key)).length;
  // Repeated-title groups among matches: same title usually means
  // same-named files on disk → Chrome saves numbered copies.
  const dupGroups = new Set();
  for (const r of matching) {
    if ((r.dupTotal || 0) > 1) dupGroups.add([r.title, r.facultyName, r.dateText].join("||"));
  }

  // Terminology: one table row = one file = one download action.
  // docCount = VTOP's own "N (Document)" badge (unreliable, info only).
  el("matchCount").textContent =
    `${matching.length} file${matching.length === 1 ? "" : "s"} · ${matchingDocs} document${matchingDocs === 1 ? "" : "s"} · ${newCount} new` +
    (dupGroups.size ? ` · ${dupGroups.size} repeated title${dupGroups.size === 1 ? "" : "s"}` : "");

  if (!visibleRows.length) {
    container.innerHTML = '<div class="empty-note">No downloadable materials found in this course yet.</div>';
    updateSelectedCount();
    return;
  }
  if (!matching.length) {
    container.innerHTML = '<div class="empty-note">No materials match these filters. Try widening the dates or clearing the search.</div>';
    updateSelectedCount();
    return;
  }

  visibleRows.forEach((row) => {
    const matches = rowMatchesFilters(row, filters);
    const wrap = document.createElement("label");
    wrap.className = "material-row";
    try { wrap.dataset.key = row.key; } catch (e) { /* status hooks are best-effort */ }
    if (!matches) wrap.style.display = "none";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selectedKeys.has(row.key);
    cb.addEventListener("change", () => {
      if (cb.checked) selectedKeys.add(row.key);
      else selectedKeys.delete(row.key);
      updateSelectedCount();
    });

    const textWrap = document.createElement("div");
    const already = downloadedKeys.has(row.key);
    const docsBit = (row.docCount || 0) > 0 ? ` · ${row.docCount} document${row.docCount === 1 ? "" : "s"}` : "";
    // v1.8.2: identical title+faculty+date rows are distinct files — label
    // which copy this is so the 5 "Breeding self-pollinated" entries differ.
    const copyBit = (row.dupTotal || 0) > 1 ? ` · copy ${row.dupIndex} of ${row.dupTotal}` : "";
    textWrap.innerHTML = `
      <div class="title">${escapeHtml(row.title)}${already ? '<span class="dl-badge">✓ downloaded</span>' : ""}</div>
      <div class="meta">${escapeHtml(row.facultyName || "Unknown faculty")} · ${escapeHtml(row.dateText || "no date")}${docsBit}${copyBit} · 1 download</div>
    `;

    wrap.appendChild(cb);
    wrap.appendChild(textWrap);
    container.appendChild(wrap);
  });

  updateSelectedCount();
}

function updateSelectedCount() {
  const n = selectedKeys.size;
  el("downloadBtn").textContent = n ? `Download selected (${n})` : "Download selected";
  el("downloadBtn").disabled = queueRunning || n === 0;
  const hint = el("selectHint");
  if (hint) hint.textContent = n === 0 ? "Tick materials above to enable download." : "";
}

// Selection presets operate on currently visible (filter-matching) rows.
// Date presets compare calendar days; undated rows are left alone.
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function selectRecent(days) {
  if (!currentState) return;
  const filters = getFilters();
  const cutoff = startOfToday();
  cutoff.setDate(cutoff.getDate() - (days - 1));
  currentState.rows.filter((r) => rowMatchesFilters(r, filters)).forEach((r) => {
    const d = parseDmy(r.dateText);
    if (d && d >= cutoff) selectedKeys.add(r.key);
  });
  renderList();
}

function invertVisible() {
  if (!currentState) return;
  const filters = getFilters();
  currentState.rows.filter((r) => rowMatchesFilters(r, filters)).forEach((r) => {
    if (selectedKeys.has(r.key)) selectedKeys.delete(r.key);
    else selectedKeys.add(r.key);
  });
  renderList();
}

// Live per-file queue status markers (st-active/st-done/st-fail/st-skip).
// Row keys embed arbitrary VTOP text, so lookup uses CSS.escape.
function rowLabelForKey(key) {
  try {
    const list = document.querySelectorAll(".material-row");
    for (const lab of list) {
      if (lab.dataset && lab.dataset.key === key) return lab;
    }
  } catch (e) { /* fall through to selector */ }
  try {
    return document.querySelector(`.material-row[data-key="${CSS.escape(key)}"]`);
  } catch (e) {
    return null;
  }
}

function setRowStatus(key, status) {
  const lab = rowLabelForKey(key);
  if (!lab) return;
  lab.classList.remove("st-active", "st-done", "st-fail", "st-skip");
  if (status) lab.classList.add(`st-${status}`);
}

function clearRowStatus() {
  document.querySelectorAll(".material-row.st-active,.material-row.st-done,.material-row.st-fail,.material-row.st-skip")
    .forEach((lab) => lab.classList.remove("st-active", "st-done", "st-fail", "st-skip"));
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str == null ? "" : String(str);
  return d.innerHTML;
}

// v1.8.2: human sizes + same-name grouping for the post-batch report.
// Pure function (no DOM) so regression tests can call it directly.
function formatBytes(n) {
  if (typeof n !== "number" || n < 0) return "size unknown";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[u]}`;
}

// entries: [{ name, bytes, state }] -> ["a.pdf × 3: 2 MB × 3 identical", ...].
// Same-named files with equal sizes are almost surely the same content;
// different sizes prove different content despite the same name.
function summarizeSizes(entries) {
  const groups = new Map();
  for (const e of entries || []) {
    const name = e && e.name ? String(e.name) : "file";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(e);
  }
  const lines = [];
  for (const [name, list] of groups) {
    const done = list.filter((e) => e.state === "complete");
    const bad = list.length - done.length;
    const known = done.map((e) => e.bytes).filter((b) => typeof b === "number" && b >= 0);
    const unknown = done.length - known.length;
    let detail;
    if (!done.length) {
      detail = "no completed downloads";
    } else if (known.length && known.every((b) => b === known[0])) {
      detail = `${formatBytes(known[0])} × ${known.length} identical` + (unknown ? ` + ${unknown} unknown` : "");
    } else {
      const counts = new Map();
      known.forEach((b) => counts.set(b, (counts.get(b) || 0) + 1));
      const parts = [];
      for (const [b, c] of counts) parts.push(`${formatBytes(b)}${c > 1 ? ` × ${c} identical` : ""}`);
      if (unknown) parts.push(`${unknown} unknown size`);
      detail = parts.join(", ");
    }
    lines.push(`${name} × ${list.length}: ${detail}${bad ? ` (${bad} not completed)` : ""}`);
  }
  return lines;
}

function setProgress(text) {
  el("progressText").textContent = text;
}

function resetProgressUI() {
  el("progressBarWrap").classList.add("hidden");
  el("progressBar").style.width = "0%";
  el("progressCounts").textContent = "";
  el("skipList").innerHTML = "";
}

function updateQueueButtons() {
  const running = queueRunning;
  el("queueBtns").classList.toggle("hidden", !running);
  el("pauseBtn").textContent = queuePaused ? "Resume" : "Pause";
  el("downloadBtn").disabled = running || selectedKeys.size === 0;
  el("downloadBtn").classList.toggle("loading", running);
}

function renderProgress(done, total, current, skippedCount) {
  const barWrap = el("progressBarWrap");
  const bar = el("progressBar");
  barWrap.classList.remove("hidden");
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  bar.style.width = `${pct}%`;
  const completed = done - skippedCount;
  const remaining = Math.max(total - done, 0);
  el("progressCounts").textContent =
    `✓ Completed: ${completed} · ↓ Remaining: ${remaining} · ✕ Skipped: ${skippedCount}`;
  setProgress(`Current: ${current} (${done}/${total})`);
}

function reasonText(reason) {
  if (reason === "not-on-page") return "not on the currently displayed VTOP page — click Next on VTOP, hit Refresh, and retry";
  if (reason === "no-control") return "no download button in that row — nothing to download";
  if (reason === "no-docs") return "row has no attached documents (legacy check)";
  if (reason === "failed") return "trigger failed — use Retry skipped to try again";
  if (reason === "canceled") return "canceled by you before it started";
  if (reason === "already-downloaded") return "already downloaded before — uncheck “Skip already downloaded” to fetch again";
  if (reason === "duplicate-click") return "duplicate click ignored — file already triggered (no double download)";
  if (reason === "error-page") return "opened an error page instead of downloading — closed automatically, retry later or download manually";
  if (reason === "no-download") return "click finished but no file arrived — skipped so the rest could continue, use Retry skipped";
  return "skipped";
}

function renderSkipList(details) {
  const list = el("skipList");
  list.innerHTML = "";
  (details || []).slice(0, 20).forEach((d) => {
    const li = document.createElement("li");
    li.textContent = `${d.title || "(unknown item)"} — ${reasonText(d.reason)}`;
    list.appendChild(li);
  });
  if ((details || []).length > 20) {
    const li = document.createElement("li");
    li.textContent = `…and ${details.length - 20} more.`;
    list.appendChild(li);
  }
}

// v1.8.2: prepend post-batch file-size lines above the skip details.
function renderSizeLines(lines) {
  const list = el("skipList");
  if (!list || !lines || !lines.length) return;
  const frag = document.createDocumentFragment();
  lines.forEach((t) => {
    const li = document.createElement("li");
    li.className = "ok";
    li.textContent = `Size — ${t}`;
    frag.appendChild(li);
  });
  list.insertBefore(frag, list.firstChild);
}

// v1.8.2: ask the background for final file sizes (the only point where
// sizes are knowable) and render the identical-vs-different report.
// v1.9.0: one job per faculty group — query each and merge. Best-effort: any
// failure just leaves the normal summary in place.
async function fetchAndRenderSizeReport(jobIds) {
  const ids = Array.isArray(jobIds) ? jobIds : (jobIds ? [jobIds] : []);
  if (!ids.length) return;
  const prev = el("progressText").textContent;
  try {
    el("progressText").textContent = `${prev} Checking file sizes…`;
    const all = [];
    for (const jobId of ids) {
      const resp = await Promise.race([
        chrome.runtime.sendMessage({ type: "SIZE_REPORT", jobId }),
        new Promise((res) => setTimeout(() => res(null), 40000))
      ]);
      if (resp && Array.isArray(resp.files)) all.push(...resp.files);
    }
    const lines = summarizeSizes(all);
    renderSizeLines(lines);
    el("progressText").textContent = lines.length ? `${prev} · ${lines.length} file size${lines.length === 1 ? "" : "s"} checked` : prev;
  } catch (e) {
    try { el("progressText").textContent = prev; } catch (e2) {}
  }
}

function titleForKey(key) {
  if (!currentState) return "(unknown item)";
  const row = currentState.rows.find((r) => r.key === key);
  return row ? row.title : "(unknown item)";
}

// Staleness guard: cheap live read of the VTOP course dropdown (no table
// scan). Returns undefined when unreachable so old content scripts never
// block a batch.
async function liveCourseText() {
  try {
    const resp = await sendMessageToTab(currentState._tabId, { type: "GET_COURSE" });
    if (!resp) return undefined;
    return resp.courseText || null;
  } catch (e) {
    return undefined;
  }
}

// Phase 4: copyable diagnostics report for bug reports. Clipboard API
// first, hidden-textarea fallback; honest feedback either way.
async function copyDiagReport() {
  const btn = el("diagCopyBtn");
  const say = (t) => { btn.textContent = t; };
  const text = lastDiagReport || "diagnostics unavailable";
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      say("Copied ✓");
      setTimeout(() => say("Copy report"), 2000);
      return;
    }
    throw new Error("no clipboard API");
  } catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      say(ok ? "Copied ✓" : "Copy failed");
    } catch (e2) {
      say("Copy failed");
    }
    setTimeout(() => say("Copy report"), 2000);
  }
}

// Phase 4: read-only self check. Never clicks VTOP controls.
async function runDiagnostics() {
  const list = el("diagList");
  list.innerHTML = "";
  const add = (ok, text, level) => {
    const li = document.createElement("li");
    li.className = ok ? "ok" : level || "bad";
    li.textContent = `${ok ? "✓" : "✕"} ${text}`;
    list.appendChild(li);
  };
  el("diagOverlay").classList.remove("hidden");

  const tab = await getActiveVtopTab();
  add(!!tab, tab ? `VTOP tab detected (${tab.url.slice(0, 60)}…)` : "No VTOP tab — open your Course Page first");
  if (!tab) return;

  let state = await sendMessageToTab(tab.id, { type: "GET_STATE" });
  if (!state) {
    await ensureContentScript(tab.id);
    state = await sendMessageToTab(tab.id, { type: "GET_STATE" });
  }
  add(!!(state && state.courseText), state && state.courseText ? `Course detected: ${state.courseText.slice(0, 70)}` : "Course dropdown not readable");
  add(!!(state && state.rows && state.rows.length), state && state.rows ? `${state.rows.length} material rows parsed` : "Materials table not found");
  if (state && state.tableStrategy && state.tableStrategy !== "L1-strict") {
    add(false, `Table matched via fallback ${state.tableStrategy} — VTOP markup may have changed`, "warn");
  }
  if (state && state.multiDocRows) {
    add(true, `${state.multiDocRows} multi-document row(s) — one download action each`);
  }

  let diag = null;
  try {
    diag = await sendMessageToTab(tab.id, { type: "DIAGNOSTICS" });
  } catch (e) {
    diag = null;
  }
  if (diag && diag.ok) {
    add(diag.diag.downloadButtons > 0, `${diag.diag.downloadButtons} download control(s) on this page`);
    (diag.diag.log || []).forEach((entry) => {
      const li = document.createElement("li");
      li.className = "warn";
      li.textContent = `· ${entry.strategy} — ${entry.detail}`;
      list.appendChild(li);
    });
  } else {
    add(false, "Content-script diagnostics unavailable");
  }

  let bgOk = false;
  try {
    const r = await chrome.runtime.sendMessage({ type: "EXTEND_CAPTURE", durationMs: 1000 });
    bgOk = !!(r && r.ok);
  } catch (e) {
    bgOk = false;
  }
  add(bgOk, bgOk ? "Background worker reachable (capture channel ok)" : "Background worker unreachable");
  add(true, `Extension v${chrome.runtime.getManifest ? chrome.runtime.getManifest().version : "?"}`);
  try {
    lastDiagReport = JSON.stringify({
      extension: (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || "?",
      url: (tab && tab.url) || null,
      course: (state && state.courseText) || null,
      rows: (state && state.rows && state.rows.length) || 0,
      tableStrategy: (state && state.tableStrategy) || null,
      downloadButtons: (diag && diag.diag && diag.diag.downloadButtons) || 0,
      log: ((diag && diag.diag && diag.diag.log) || []).map((e) => `${e.strategy} — ${e.detail}`),
      at: new Date().toISOString()
    }, null, 2);
  } catch (e) {
    lastDiagReport = null;
  }
}

// Phase 4: experimental verified page sweep. One Next per ADVANCE_PAGE,
// verified changed render each step, same-course guard, hard cap.
// Aborts (keeping everything collected so far) on ANY anomaly.
const SWEEP_MAX_PAGES = 20;

async function collectAllPages() {
  if (!currentState || queueRunning) return;
  const tab = await getActiveVtopTab();
  if (!tab) {
    setProgress("Open your VTOP Course Page tab first.");
    return;
  }
  const proceed = confirm(
    "Experimental: this walks VTOP pages by clicking Next once per page and verifies each step. It stops automatically on any anomaly. Continue?"
  );
  if (!proceed) return;

  showLoading("Sweeping pages — verifying each step…");
  const startCourse = currentState.courseText;
  let pages = 1;
  let lastReason = "done";
  for (;;) {
    // Iteration 4 cap guard (REQUIREMENTS J): SWEEP_MAX_PAGES=20 means at
    // most 20 pages visited total (1 initial + 19 advances). Check BEFORE
    // clicking Next so the 21st page is never visited. The post-increment
    // pages> check below remains as a backstop.
    if (pages >= SWEEP_MAX_PAGES) {
      lastReason = "cap";
      break;
    }
    let adv = null;
    try {
      adv = await sendMessageToTab(tab.id, { type: "ADVANCE_PAGE" });
    } catch (e) {
      adv = null;
    }
    if (!adv || !adv.advanced) {
      lastReason = (adv && adv.reason) || "no_response";
      break;
    }
    pages++;
    if (pages > SWEEP_MAX_PAGES) {
      lastReason = "cap";
      break;
    }
    const st = await sendMessageToTab(tab.id, { type: "GET_STATE" });
    if (!st || !st.ok || st.courseText !== startCourse) {
      lastReason = "course_changed";
      break;
    }
    currentState = st;
    currentState._tabId = tab.id;
    currentState._isNewCourse = false;
  }
  // Final refresh to render everything accumulated (content-side Map kept it).
  await loadState();
  if (lastReason !== "no_next" && lastReason !== "done") {
    setProgress(`Sweep stopped after ${pages} page(s) (${lastReason}) — everything collected so far is kept.`);
  }
}

function filterSummary() {
  const faculty = el("facultyFilter").value;
  const fromVal = el("dateFrom").value;
  const toVal = el("dateTo").value;
  const searchBox = el("searchBox");
  const search = searchBox ? searchBox.value.trim() : "";
  const parts = [];
  parts.push(faculty === "__ALL__" ? "All faculty" : faculty);
  if (fromVal || toVal) parts.push(`${fromVal || "…"} → ${toVal || "…"}`);
  else parts.push("Any date");
  if (search) parts.push(`“${search}”`);
  return parts.join(" · ");
}

function showPreview(folderName, keys) {
  const byKey = new Map(currentState.rows.map((r) => [r.key, r]));
  const docs = keys.reduce((sum, k) => sum + ((byKey.get(k) || {}).docCount || 0), 0);
  el("previewCourse").textContent = currentState.courseText;
  el("previewFilters").textContent = filterSummary();
  el("previewCount").textContent = `${keys.length} file${keys.length === 1 ? "" : "s"} · ${docs} document${docs === 1 ? "" : "s"}`;
  el("previewDest").textContent = `Downloads/${folderName}/`;
  // Per-faculty destination breakdown (faculty template splits the batch).
  const foldersEl = el("previewFolders");
  foldersEl.innerHTML = "";
  const dests = new Map();
  if (folderTemplate === "semester-course-faculty") {
    for (const k of keys) {
      const row = byKey.get(k);
      const fac = ((row && row.facultyName) || "").trim() || "Unknown faculty";
      dests.set(fac, (dests.get(fac) || 0) + 1);
    }
  } else {
    dests.set(null, keys.length);
  }
  for (const [fac, n] of dests) {
    const li = document.createElement("li");
    li.textContent = fac
      ? `${n} file${n === 1 ? "" : "s"} → Downloads/${resolveFolderPath(el("folderName").value.trim() || currentState.folderNameSuggestion, undefined, fac)}/`
      : `${n} file${n === 1 ? "" : "s"} → Downloads/${folderName}/`;
    foldersEl.appendChild(li);
  }
  // File sample (first 8) + same-title collision forecast. Server filenames
  // are unknowable pre-download, so collisions are estimated from duplicate
  // titles — same title usually means same-named files → name (1) siblings.
  const filesEl = el("previewFiles");
  filesEl.innerHTML = "";
  keys.slice(0, 8).forEach((k) => {
    const row = byKey.get(k) || {};
    const li = document.createElement("li");
    const dup = (row.dupTotal || 0) > 1;
    li.textContent = (row.title || "(unknown item)") + (dup ? ` — same title ×${row.dupTotal}, expect numbered copies` : "");
    if (dup) li.className = "collision";
    filesEl.appendChild(li);
  });
  if (keys.length > 8) {
    const li = document.createElement("li");
    li.className = "more";
    li.textContent = `…and ${keys.length - 8} more.`;
    filesEl.appendChild(li);
  }
  const warn = el("previewWarning");
  if (keys.length > LARGE_BATCH_THRESHOLD) {
    warn.textContent = `You're about to start ${keys.length} downloads at once — that's a lot of storage/bandwidth. You can close this popup; downloads continue in the background.`;
    warn.classList.remove("hidden");
  } else {
    warn.textContent = "";
    warn.classList.add("hidden");
  }
  el("previewOverlay").classList.remove("hidden");
}

function hidePreview() {
  el("previewOverlay").classList.add("hidden");
}

function notifyDownloadComplete({ folderName, clicked, skipped }) {
  try {
    if (!chrome.notifications || !chrome.notifications.create) return;
    const total = clicked + skipped;
    const ok = skipped === 0;
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon48.png",
      title: ok ? "Download complete" : "Download finished with skipped items",
      message: ok
        ? `${clicked}/${total} downloaded · ${folderName}`
        : `${clicked}/${total} downloaded · ${skipped} skipped · ${folderName}`
    });
  } catch (e) {
    // notifications are best-effort; popup text remains the source of truth
  }
}

async function handleDownload() {
  if (!currentState) return;
  const keys = Array.from(selectedKeys);

  if (!keys.length) {
    setProgress("Select at least one material first.");
    return;
  }

  const courseFolder = el("folderName").value.trim() || currentState.folderNameSuggestion;
  const folderName = previewFolder(courseFolder, keys);
  resetProgressUI();
  showPreview(folderName, keys);
}

// Phase 3: download queue state.
let queueRunning = false;
let queuePaused = false;
let queueCancel = false;
let queueJobId = null;
let lastSkippedKeys = [];
let safeMode = false;
let eventsWired = false;
const MAX_ATTEMPTS = 3;

const queueSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startDownload() {
  hidePreview();
  if (!currentState || queueRunning) return;
  const courseFolder = el("folderName").value.trim() || currentState.folderNameSuggestion;
  const folderName = resolveFolderPath(courseFolder);
  // v3.3: dedupe keys up-front so double-ticked/retried rows never fire twice.
  let keys = Array.from(new Set(Array.from(selectedKeys)));

  if (!keys.length) {
    setProgress("Select at least one material first.");
    return;
  }

  // Phase 2: skip previously downloaded items when the box is checked.
  // They are reported with reason "already-downloaded", never sent to VTOP.
  let alreadySkipped = [];
  if (skipExisting) {
    alreadySkipped = keys.filter((k) => downloadedKeys.has(k));
    keys = keys.filter((k) => !downloadedKeys.has(k));
    alreadySkipped.forEach((k) => setRowStatus(k, "skip"));
    if (!keys.length) {
      setProgress(
        `All ${alreadySkipped.length} selected item${alreadySkipped.length === 1 ? " was" : "s were"} already downloaded. Uncheck “Skip already downloaded” to fetch again.`
      );
      renderSkipList(
        alreadySkipped.map((k) => ({ key: k, title: titleForKey(k), reason: "already-downloaded" }))
      );
      return;
    }
  }

  el("downloadBtn").disabled = true;
  resetProgressUI();
  clearRowStatus();

  // Staleness guard: refuse to fire 74 ghost clicks when the VTOP course
  // changed (or paged away) underneath the scanned state. Aborts ONLY on
  // positive evidence (a different non-empty course string) — an unknown
  // answer never blocks a batch; the leading-miss abort backstops the rest.
  const liveCourse = await liveCourseText();
  if (typeof liveCourse === "string" && liveCourse && liveCourse !== currentState.courseText) {
    setProgress(
      "The course on the VTOP page changed since this list was read — click Refresh to rescan, then select again. Nothing was downloaded."
    );
    renderSkipList([]);
    el("downloadBtn").disabled = false;
    updateSelectedCount();
    return;
  }

  renderProgress(0, keys.length, "Preparing…", 0);

  const armDuration = Math.max(keys.length * 2400 + 30000, 60000) * (safeMode ? 2 : 1);
  // v1.9.0: faculty template splits the batch into one folder group per
  // faculty. Flattened into an ordered queue; the loop re-ARMs whenever the
  // target folder changes (single-group batches ARM exactly once, as before).
  let plan = [{ folder: folderName, keys }];
  if (folderTemplate === "semester-course-faculty") {
    plan = Array.from(groupKeysByFaculty(keys), ([fac, ks]) => ({
      folder: resolveFolderPath(courseFolder, undefined, fac),
      keys: ks,
    }));
  }
  const queue = [];
  for (const entry of plan) for (const key of entry.keys) queue.push({ key, folder: entry.folder });
  const finishedJobIds = []; // every job ARM'd this run; each gets a size report
  let armedFolder = null;
  const armFor = async (folder) => {
    const armResp = await chrome.runtime
      .sendMessage({ type: "ARM_CAPTURE", folderName: folder, durationMs: armDuration })
      .catch(() => null);
    queueJobId = (armResp && armResp.jobId) || null;
    if (queueJobId) finishedJobIds.push(queueJobId);
    armedFolder = folder;
  };
  const disarmCurrent = async () => {
    try {
      const p = chrome.runtime.sendMessage({ type: "DISARM_CAPTURE", jobId: queueJobId });
      if (p && typeof p.catch === "function") await p.catch(() => {});
      else if (p && typeof p.then === "function") await p;
    } catch (e) {
      // SW unavailable or popup closing - capture auto-expires via timestamp
    }
    queueJobId = null;
    armedFolder = null;
  };

  // Keep-alive for large batches: refresh capture expiry every 20s while the
  // content script works through the queue. Uses the existing EXTEND_CAPTURE
  // handler (previously dead code). Always cleared below.
  const keepAlive = setInterval(() => {
    try {
      const p = chrome.runtime.sendMessage({ type: "EXTEND_CAPTURE", durationMs: 30000, jobId: queueJobId });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (e) {
      // messaging unavailable (popup closing) - interval is cleared in finally
    }
  }, 20000);

  // Phase 3: sequential queue. One key per DOWNLOAD_ROWS message so pause,
  // cancel, retry and per-item progress stay precise. Aggregates into the
  // same `result` shape the summary block below already understands.
  const gapMs = safeMode ? 2000 : 600;
  queueRunning = true;
  queuePaused = false;
  queueCancel = false;
  lastSkippedKeys = [];
  el("retrySkippedBtn").classList.add("hidden");
  updateQueueButtons();

  let doneEvents = 0;
  const totalItems = keys.length + alreadySkipped.length;
  const progressListener = (msg) => {
    if (msg && msg.type === "DOWNLOAD_PROGRESS") {
      const p = msg.progress;
      doneEvents++;
      renderQueueProgress(p.current, doneEvents, totalItems);
      if (p && p.key) setRowStatus(p.key, p.skipped ? "fail" : "done");
    }
  };
  chrome.runtime.onMessage.addListener(progressListener);

  const renderQueueProgress = (current, done, total) => {
    renderProgress(done, total, current, 0);
  };
  renderProgress(0, totalItems, "Preparing…", 0);

  let aggregate = { ok: true, clicked: 0, skipped: 0, skippedDetails: [] };
  let canceledCount = 0;
  const recordKeys = [];
  let result = null;
  let batchAborted = null; // set when the page clearly moved on (mass misses)
  let leadingMisses = 0;
  try {
    for (let qi = 0; qi < queue.length; qi++) {
      const item = queue[qi];
      const key = item.key;
      if (queueCancel) {
        canceledCount++;
        aggregate.skippedDetails.push({ key, title: titleForKey(key), reason: "canceled" });
        aggregate.skipped++;
        setRowStatus(key, null); // back to neutral; skip list explains why
        continue;
      }
      if (item.folder !== armedFolder) {
        if (armedFolder) await disarmCurrent();
        await armFor(item.folder);
      }
      setRowStatus(key, "active");
      while (queuePaused && !queueCancel) {
        setProgress(`Paused — ${titleForKey(key)} waiting…`);
        await queueSleep(400);
      }
      if (queueCancel) {
        canceledCount++;
        aggregate.skippedDetails.push({ key, title: titleForKey(key), reason: "canceled" });
        aggregate.skipped++;
        continue;
      }
      let one = null;
      let attempts = 0;
      const maxTries = safeMode ? MAX_ATTEMPTS : 2;
      while (attempts < maxTries) {
        attempts++;
        try {
          one = await sendMessageToTab(currentState._tabId, { type: "DOWNLOAD_ROWS", keys: [key] });
        } catch (e) {
          one = null;
        }
        if (one && one.ok) break;
        if (!queueCancel && attempts < maxTries) await queueSleep(gapMs);
      }
      if (!one || !one.ok) {
        // Per-item transport failure: isolated, retryable, must not poison
        // the whole batch (other keys already downloaded stay recorded and
        // the run still reports Done with details + Retry skipped).
        aggregate.skippedDetails.push({ key, title: titleForKey(key), reason: "failed" });
        aggregate.skipped++;
        continue;
      }
      aggregate.clicked += one.clicked || 0;
      aggregate.skipped += one.skipped || 0;
      if (Array.isArray(one.skippedDetails)) aggregate.skippedDetails.push(...one.skippedDetails);
      else if (one.skipped) aggregate.skippedDetails.push({ key, title: titleForKey(key), reason: "skipped" });
      if (!one.skipped) recordKeys.push({ key, folder: item.folder });
      // Early abort: three leading not-on-page misses with zero downloads
      // means the page moved on (course switched, table repaged) — firing
      // the remaining clicks is pure waste. Report the rest the same way.
      const missedHere = (one.skippedDetails || []).some((d) => d.reason === "not-on-page");
      if (missedHere && aggregate.clicked === 0) {
        leadingMisses++;
        if (leadingMisses >= 3) {
          batchAborted = "none of the selected files are on this VTOP page — the course may have changed. Click Refresh to rescan, then retry.";
          for (let ri = qi + 1; ri < queue.length; ri++) {
            const rk = queue[ri].key;
            aggregate.skippedDetails.push({ key: rk, title: titleForKey(rk), reason: "not-on-page" });
            aggregate.skipped++;
          }
          break;
        }
      } else if (!missedHere) {
        leadingMisses = 0;
      }
      await queueSleep(gapMs);
    }
    // Include canceled count in the progress footer via failed-style note.
    aggregate.canceledCount = canceledCount;
    result = aggregate;
  } finally {
    clearInterval(keepAlive);
    try {
      chrome.runtime.onMessage.removeListener(progressListener);
    } catch (e) {
      // ignore - popup tearing down
    }
    if (armedFolder) await disarmCurrent();
    queueRunning = false;
    queueJobId = null;
    updateQueueButtons();
  }

  if (result && result.ok) {
    const details = Array.isArray(result.skippedDetails) ? result.skippedDetails : [];
    const alreadyDetails = alreadySkipped.map((k) => ({ key: k, title: titleForKey(k), reason: "already-downloaded" }));
    const allDetails = details.concat(alreadyDetails);
    const totalSkipped = result.skipped + alreadySkipped.length;
    renderProgress(keys.length + alreadySkipped.length, keys.length + alreadySkipped.length, "Finished", totalSkipped);
    renderSkipList(allDetails);
    await fetchAndRenderSizeReport(finishedJobIds);
    let skipNote = ".";
    if (totalSkipped) {
      const noControl = allDetails.filter((d) => d.reason === "no-control").length;
      const notOnPage = allDetails.filter((d) => d.reason === "not-on-page").length;
      const already = allDetails.filter((d) => d.reason === "already-downloaded").length;
      const failed = allDetails.filter((d) => d.reason === "failed").length;
      const canceled = allDetails.filter((d) => d.reason === "canceled").length;
      const errorPage = allDetails.filter((d) => d.reason === "error-page").length;
      const noDownload = allDetails.filter((d) => d.reason === "no-download").length;
      const dupClick = allDetails.filter((d) => d.reason === "duplicate-click").length;
      const parts = [];
      if (notOnPage) parts.push(`${notOnPage} not on the currently displayed page`);
      if (noControl) parts.push(`${noControl} with no download control found`);
      if (already) parts.push(`${already} already downloaded before`);
      if (failed) parts.push(`${failed} failed`);
      if (canceled) parts.push(`${canceled} canceled`);
      if (errorPage) parts.push(`${errorPage} error page(s) skipped safely`);
      if (noDownload) parts.push(`${noDownload} with no file received`);
      if (dupClick) parts.push(`${dupClick} duplicate click(s) ignored`);
      const remainder = totalSkipped - noControl - notOnPage - already - failed - canceled - errorPage - noDownload - dupClick;
      if (remainder > 0) parts.push(`${remainder} skipped`);
      skipNote = ` (${parts.join("; ")} — see details above.)`;
    }
    setProgress(
      (batchAborted ? `Stopped early — ${batchAborted} ` : `${result.canceledCount ? "Stopped" : "Done"} — `) +
      `${result.clicked} download${result.clicked === 1 ? "" : "s"} saved to Downloads/${folderName}/` +
      (folderTemplate === "semester-course-faculty" ? " (one subfolder per faculty)" : "") + skipNote
    );
    notifyDownloadComplete({ folderName, clicked: result.clicked, skipped: totalSkipped });
    // Phase 2+3: record items the queue marked done (per-item, not batch).
    // v1.9.0: folder is per group, so history re-download matching stays exact.
    await recordDownloads(
      recordKeys.map(({ key, folder }) => ({ key, course: currentState.courseText, folder, title: titleForKey(key) }))
    );
    // Phase 3: offer retry for content-skipped items (not already-downloaded
    // or duplicate-clicks, which already fired).
    lastSkippedKeys = details
      .filter((d) => d.reason !== "already-downloaded" && d.reason !== "duplicate-click")
      .map((d) => d.key);
    if (lastSkippedKeys.length) {
      el("retrySkippedBtn").classList.remove("hidden");
      el("retrySkippedBtn").textContent = `Retry skipped (${lastSkippedKeys.length})`;
    }
    renderList(); // refresh ✓ downloaded badges
  } else {
    setProgress("Something went wrong triggering the downloads. Click Refresh and try again — or open Diagnostics and copy the report if it keeps failing.");
    notifyDownloadComplete({ folderName, clicked: 0, skipped: keys.length + alreadySkipped.length });
  }
}

function wireEvents() {
  // Idempotent: a second registration (double-executed script, repeated
  // DOMContentLoaded) must never double-fire queue actions.
  if (eventsWired) return;
  eventsWired = true;
  el("retryBtn").addEventListener("click", loadState);
  el("refreshBtn").addEventListener("click", loadState);
  el("facultyFilter").addEventListener("change", renderList);
  el("dateFrom").addEventListener("change", renderList);
  el("dateTo").addEventListener("change", renderList);
  el("searchBox").addEventListener("input", renderList);
  el("resetFiltersBtn").addEventListener("click", () => {
    el("facultyFilter").value = "__ALL__";
    el("dateFrom").value = "";
    el("dateTo").value = "";
    el("searchBox").value = "";
    renderChips(uniqueFaculty(currentState.rows));
    renderList();
  });
  el("selectAllBtn").addEventListener("click", () => {
    const filters = getFilters();
    currentState.rows.filter((r) => rowMatchesFilters(r, filters)).forEach((r) => selectedKeys.add(r.key));
    renderList();
  });
  el("selectNoneBtn").addEventListener("click", () => {
    const filters = getFilters();
    currentState.rows.filter((r) => rowMatchesFilters(r, filters)).forEach((r) => selectedKeys.delete(r.key));
    renderList();
  });
  el("downloadBtn").addEventListener("click", handleDownload);
  el("presetWeekBtn").addEventListener("click", () => selectRecent(7));
  el("presetMonthBtn").addEventListener("click", () => selectRecent(30));
  el("invertBtn").addEventListener("click", invertVisible);
  el("previewCancelBtn").addEventListener("click", hidePreview);
  el("previewStartBtn").addEventListener("click", startDownload);
  el("previewOverlay").addEventListener("click", (e) => {
    if (e.target === el("previewOverlay")) hidePreview();
  });
  el("folderName").addEventListener("input", updateFolderPreview);
  el("folderTemplate").addEventListener("change", async () => {
    const v = el("folderTemplate").value;
    folderTemplate = v === "semester-course-faculty" ? "semester-course-faculty" : (v === "semester-course" ? "semester-course" : "course");
    await storageSet({ folderTemplate });
    updateFolderPreview();
  });
  el("newOnlyFilter").addEventListener("change", () => {
    showOnlyNew = el("newOnlyFilter").checked;
    renderList();
  });
  el("skipExistingBox").addEventListener("change", () => {
    skipExisting = el("skipExistingBox").checked;
  });
  el("diagBtn").addEventListener("click", runDiagnostics);
  el("diagCloseBtn").addEventListener("click", () => el("diagOverlay").classList.add("hidden"));
  el("diagCopyBtn").addEventListener("click", copyDiagReport);
  el("diagTourBtn").addEventListener("click", () => {
    el("diagOverlay").classList.add("hidden");
    el("coachOverlay").classList.remove("hidden");
  });
  el("coachDoneBtn").addEventListener("click", hideCoach);
  el("diagOverlay").addEventListener("click", (e) => {
    if (e.target === el("diagOverlay")) el("diagOverlay").classList.add("hidden");
  });
  el("sweepBtn").addEventListener("click", collectAllPages);
  el("safeModeBox").addEventListener("change", async () => {
    safeMode = el("safeModeBox").checked;
    await storageSet({ safeMode });
  });
  el("pauseBtn").addEventListener("click", () => {
    if (!queueRunning) return;
    queuePaused = !queuePaused;
    updateQueueButtons();
  });
  el("cancelBtn").addEventListener("click", () => {
    if (!queueRunning) return;
    queueCancel = true;
    queuePaused = false;
    setProgress("Canceling — finishing the current item…");
  });
  el("retrySkippedBtn").addEventListener("click", async () => {
    if (queueRunning || !lastSkippedKeys.length || !currentState) return;
    selectedKeys = new Set(lastSkippedKeys.filter((k) => currentState.rows.some((r) => r.key === k)));
    renderList();
    hidePreview();
    // Run the queue directly on the skipped keys (no second preview).
    // Skip-existing is paused so they are not swallowed.
    const keep = skipExisting;
    skipExisting = false;
    try {
      await startDownload();
    } finally {
      skipExisting = keep;
      el("skipExistingBox").checked = keep;
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  wireEvents();
  await loadPhase2State();
  loadState();
});
