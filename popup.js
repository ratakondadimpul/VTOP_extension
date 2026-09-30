let currentState = null;
let selectedKeys = new Set();
let lastCourseText = null;
const LARGE_BATCH_THRESHOLD = 10;

// Phase 2: local download history + folder template.
// downloadHistory: Map rowKey -> { course, folder, title, ts }.
// Row keys embed course/faculty/date/title/docCount, so re-downloads of the
// same VTOP material match even across popup sessions.
let downloadedKeys = new Map();
let showOnlyNew = false;
let skipExisting = true;
let folderTemplate = "course"; // "course" | "semester-course"
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
  const data = await storageGet(["downloadHistory", "folderTemplate", "safeMode"]);
  const hist = data.downloadHistory;
  if (hist && typeof hist === "object") {
    downloadedKeys = new Map(Object.entries(hist));
  }
  if (data.folderTemplate === "semester-course" || data.folderTemplate === "course") {
    folderTemplate = data.folderTemplate;
  }
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
function resolveFolderPath(courseFolder, courseText) {
  const base = (courseFolder || "").trim() || (currentState && currentState.folderNameSuggestion) || "VIT Downloads";
  if (folderTemplate === "semester-course") {
    const sem = courseTextToSemester(courseText || (currentState && currentState.courseText));
    if (sem && sem !== base) return `${sem}/${base}`;
  }
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
  preview.textContent = `Files will save to Downloads/${resolveFolderPath(courseFolder)}/`;
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
  showLoading("Setting \"Show entries\" to the max and reading the table…");
  const tab = await getActiveVtopTab();
  if (!tab) {
    showError("Open your VTOP Course Page tab (vtop.vit.ac.in) first, with a course selected, then reopen this popup.");
    return;
  }

  let response = await sendMessageToTab(tab.id, { type: "GET_STATE" });
  if (!response) {
    await ensureContentScript(tab.id);
    response = await sendMessageToTab(tab.id, { type: "GET_STATE" });
  }

  if (!response || !response.ok) {
    showError(
      (response && response.error) ||
        "Couldn't read the course or materials table on this page. Make sure the Course Materials table is visible, then click Retry."
    );
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
  return { faculty, from, to };
}

function rowMatchesFilters(row, filters) {
  // v1.8.1: list every row that has a download control. The "N (Document)"
  // badge is unreliable ("0 (Document)" rows usually hold one real file),
  // so it is display info only - never a filter. Explicit false keeps
  // backward compatibility with states saved before hasDownload existed.
  if (row.hasDownload === false) return false;
  if (filters.faculty !== "__ALL__" && row.facultyName !== filters.faculty) return false;
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

  renderList();
}

function renderList() {
  const filters = getFilters();
  const container = el("materialsList");
  container.innerHTML = "";

  const visibleRows = currentState.rows.filter((r) => r.hasDownload !== false);
  const matching = visibleRows.filter((r) => rowMatchesFilters(r, filters));
  const matchingDocs = matching.reduce((sum, r) => sum + (r.docCount || 0), 0);
  const newCount = matching.filter((r) => !downloadedKeys.has(r.key)).length;

  // Terminology: one table row = one file = one download action.
  // docCount = VTOP's own "N (Document)" badge (unreliable, info only).
  el("matchCount").textContent =
    `${matching.length} file${matching.length === 1 ? "" : "s"} · ${matchingDocs} document${matchingDocs === 1 ? "" : "s"} · ${newCount} new`;

  if (!visibleRows.length) {
    container.innerHTML = '<div class="empty-note">No downloadable materials found in this course yet.</div>';
    updateSelectedCount();
    return;
  }

  visibleRows.forEach((row) => {
    const matches = rowMatchesFilters(row, filters);
    const wrap = document.createElement("label");
    wrap.className = "material-row";
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
  el("downloadBtn").disabled = running;
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
// Best-effort: any failure just leaves the normal summary in place.
async function fetchAndRenderSizeReport(jobId) {
  if (!jobId) return;
  const prev = el("progressText").textContent;
  try {
    el("progressText").textContent = `${prev} Checking file sizes…`;
    const resp = await Promise.race([
      chrome.runtime.sendMessage({ type: "SIZE_REPORT", jobId }),
      new Promise((res) => setTimeout(() => res(null), 40000))
    ]);
    const lines = summarizeSizes(resp && resp.files);
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

function filterSummary() {  const faculty = el("facultyFilter").value;
  const fromVal = el("dateFrom").value;
  const toVal = el("dateTo").value;
  const parts = [];
  parts.push(faculty === "__ALL__" ? "All faculty" : faculty);
  if (fromVal || toVal) parts.push(`${fromVal || "…"} → ${toVal || "…"}`);
  else parts.push("Any date");
  return parts.join(" · ");
}

function showPreview(folderName, keys) {
  const byKey = new Map(currentState.rows.map((r) => [r.key, r]));
  const docs = keys.reduce((sum, k) => sum + ((byKey.get(k) || {}).docCount || 0), 0);
  el("previewCourse").textContent = currentState.courseText;
  el("previewFilters").textContent = filterSummary();
  el("previewCount").textContent = `${keys.length} file${keys.length === 1 ? "" : "s"} · ${docs} document${docs === 1 ? "" : "s"}`;
  el("previewDest").textContent = `Downloads/${folderName}/`;
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
  const folderName = resolveFolderPath(courseFolder);
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
  renderProgress(0, keys.length, "Preparing…", 0);

  const armDuration = Math.max(keys.length * 2400 + 30000, 60000) * (safeMode ? 2 : 1);
  const armResp = await chrome.runtime
    .sendMessage({ type: "ARM_CAPTURE", folderName, durationMs: armDuration })
    .catch(() => null);
  queueJobId = (armResp && armResp.jobId) || null;
  const finishedJobId = queueJobId; // finally-block nulls queueJobId; report needs it

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
  try {
    for (const key of keys) {
      if (queueCancel) {
        canceledCount++;
        aggregate.skippedDetails.push({ key, title: titleForKey(key), reason: "canceled" });
        aggregate.skipped++;
        continue;
      }
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
        aggregate.ok = false;
        aggregate.skippedDetails.push({ key, title: titleForKey(key), reason: "failed" });
        aggregate.skipped++;
        continue;
      }
      aggregate.clicked += one.clicked || 0;
      aggregate.skipped += one.skipped || 0;
      if (Array.isArray(one.skippedDetails)) aggregate.skippedDetails.push(...one.skippedDetails);
      else if (one.skipped) aggregate.skippedDetails.push({ key, title: titleForKey(key), reason: "skipped" });
      if (!one.skipped) recordKeys.push(key);
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
    try {
      const p = chrome.runtime.sendMessage({ type: "DISARM_CAPTURE", jobId: queueJobId });
      if (p && typeof p.catch === "function") await p.catch(() => {});
      else if (p && typeof p.then === "function") await p;
    } catch (e) {
      // SW unavailable or popup closing - capture auto-expires via timestamp
    }
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
    await fetchAndRenderSizeReport(finishedJobId);
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
      `${result.canceledCount ? "Stopped" : "Done"} — ${result.clicked} download${result.clicked === 1 ? "" : "s"} saved to Downloads/${folderName}/` + skipNote
    );
    notifyDownloadComplete({ folderName, clicked: result.clicked, skipped: totalSkipped });
    // Phase 2+3: record items the queue marked done (per-item, not batch).
    await recordDownloads(
      recordKeys.map((k) => ({ key: k, course: currentState.courseText, folder: folderName, title: titleForKey(k) }))
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
    setProgress("Something went wrong triggering the downloads. Click Refresh and try again.");
    notifyDownloadComplete({ folderName, clicked: 0, skipped: keys.length + alreadySkipped.length });
  }
}

function wireEvents() {
  el("retryBtn").addEventListener("click", loadState);
  el("refreshBtn").addEventListener("click", loadState);
  el("facultyFilter").addEventListener("change", renderList);
  el("dateFrom").addEventListener("change", renderList);
  el("dateTo").addEventListener("change", renderList);
  el("resetFiltersBtn").addEventListener("click", () => {
    el("facultyFilter").value = "__ALL__";
    el("dateFrom").value = "";
    el("dateTo").value = "";
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
  el("previewCancelBtn").addEventListener("click", hidePreview);
  el("previewStartBtn").addEventListener("click", startDownload);
  el("previewOverlay").addEventListener("click", (e) => {
    if (e.target === el("previewOverlay")) hidePreview();
  });
  el("folderName").addEventListener("input", updateFolderPreview);
  el("folderTemplate").addEventListener("change", async () => {
    folderTemplate = el("folderTemplate").value === "semester-course" ? "semester-course" : "course";
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
