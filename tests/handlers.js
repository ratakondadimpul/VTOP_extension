// VIT Bulk Material Downloader — background handler tests (no browser).
//
// Drives the REAL background.js message + download listeners with captured
// listeners and an in-memory storage.local: job lifecycle, attribution,
// stray-tab handling, SIZE_REPORT, hostile filenames, and service-worker
// restart persistence.
//
// Run: `node tests/handlers.js` (exit 0 = all pass, 1 = failure).

const fs = require("fs");
const vm = require("vm");

const EXT_DIR = __dirname + "/..";

function makeChrome() {
  const listeners = {};
  const store = {};
  const chrome = {
    __listeners: listeners,
    __store: store,
    __removed: null,
    __searchResult: [],
    runtime: { onMessage: { addListener(fn) { listeners.msg = fn; } } },
    tabs: {
      onCreated: { addListener(fn) { listeners.tabCreated = fn; } },
      remove(ids, cb) { chrome.__removed = ids; cb && cb(); },
    },
    storage: {
      local: {
        get(k, cb) { const r = {}; (Array.isArray(k) ? k : [k]).forEach((x) => { r[x] = store[x]; }); cb(r); },
        set(o, cb) { Object.assign(store, o); cb && cb(); },
      },
    },
    downloads: {
      onCreated: { addListener(fn) { listeners.created = fn; } },
      onDeterminingFilename: { addListener(fn) { listeners.filename = fn; } },
      // Honor the id filter like real chrome.downloads.search does.
      search(query, cb) {
        const all = chrome.__searchResult || [];
        const ids = query && query.id;
        cb(Array.isArray(ids) && ids.length ? all.filter((it) => ids.includes(it.id)) : all);
      },
    },
  };
  return chrome;
}

function loadBackground(chrome) {
  const sandbox = { console, crypto: require("crypto"), chrome };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(`${EXT_DIR}/background.js`, "utf8"), sandbox, { filename: "background.js" });
  return sandbox;
}

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} :: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`); }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 50));

(async () => {
  const chrome = makeChrome();
  const L = chrome.__listeners;
  loadBackground(chrome);
  const send = (m, sender) => new Promise((res) => {
    const r = L.msg(m, sender || {}, res);
    if (r !== true) res(undefined);
  });

  // --- ARM / EXTEND / DISARM lifecycle ---
  const arm = await send({ type: "ARM_CAPTURE", folderName: "MyCourse", durationMs: 60000 });
  check("arm ok + jobId", arm.ok === true && typeof arm.jobId === "string", true);
  check("arm folder sanitized", arm.folder, "MyCourse");
  const ext = await send({ type: "EXTEND_CAPTURE", durationMs: 60000, jobId: arm.jobId });
  check("extend known job ok", ext.ok, true);
  const dis1 = await send({ type: "DISARM_CAPTURE", jobId: arm.jobId });
  check("disarm known job ok", dis1.ok, true);
  const dis2 = await send({ type: "DISARM_CAPTURE", jobId: "nope" });
  check("disarm unknown job harmless", dis2.ok, true);

  // --- newest-job attribution + filename rewrite ---
  const a1 = await send({ type: "ARM_CAPTURE", folderName: "A", durationMs: 60000 });
  const a2 = await send({ type: "ARM_CAPTURE", folderName: "S/B", durationMs: 60000 });
  check("jobIds distinct", a1.jobId !== a2.jobId, true);
  L.created({ id: 11 });
  await tick();
  let s1 = null;
  L.filename({ id: 11, filename: "f.pdf" }, (s) => { s1 = s; });
  await tick();
  check("newest job wins attribution", s1 && s1.filename, "S/B/f.pdf");
  check("uniquify conflict action", s1 && s1.conflictAction, "uniquify");
  await send({ type: "DISARM_CAPTURE" }); // disarm-all fallback
  L.created({ id: 12 });
  await tick();
  let s2 = "unset";
  L.filename({ id: 12, filename: "g.pdf" }, (s) => { s2 = (s && s.filename) || "DEFAULT"; });
  await tick();
  check("after disarm-all default behavior", s2, "DEFAULT");

  // --- hostile / degenerate server filenames ---
  const a3 = await send({ type: "ARM_CAPTURE", folderName: "MyCourse", durationMs: 60000 });
  check("re-arm ok", a3.ok, true);
  for (const [label, input, want] of [
    ["dotdot neutralized", "..", "MyCourse/material"],
    ["single dot neutralized", ".", "MyCourse/material"],
    ["windows path to basename", "C:\\fakepath\\notes.pdf", "MyCourse/notes.pdf"],
    ["posix path to basename", "/tmp/x.pdf", "MyCourse/x.pdf"],
    ["surrounding whitespace trimmed", "  spaced.pdf  ", "MyCourse/spaced.pdf"],
  ]) {
    const id = 100 + label.length;
    L.created({ id });
    await tick();
    let s = null;
    L.filename({ id, filename: input }, (v) => { s = v; });
    await tick();
    check(`filename: ${label}`, s && s.filename, want);
  }

  // --- POLL_DOWNLOAD / CLOSE_STRAY_TABS ---
  L.created({ id: 201 });
  await tick();
  const poll = await send({ type: "POLL_DOWNLOAD", sinceTs: 0 });
  check("poll sees created download", poll.newDownloads >= 1, true);
  check("poll total tracked", poll.total >= 1, true);
  L.tabCreated({ id: 301 });
  L.tabCreated({ id: 302 });
  await tick();
  const closed = await send({ type: "CLOSE_STRAY_TABS", sinceTs: Date.now() - 60000 }, { tab: { id: 302 } });
  check("stray tabs closed excluding self", closed.closed, 1);
  check("stray removed ids", chrome.__removed, [301]);
  const closedNone = await send({ type: "CLOSE_STRAY_TABS", sinceTs: Date.now() + 60000 }, {});
  check("no stray tabs no-op", closedNone.closed, 0);

  // --- SIZE_REPORT (complete + interrupted mapping) ---
  chrome.__searchResult = [
    { id: 201, filename: "MyCourse/a.pdf", state: "complete", totalBytes: 1000 },
    { id: 202, filename: "MyCourse/b.pdf", state: "interrupted", totalBytes: 500 },
  ];
  // attribute both ids to a job first
  const a4 = await send({ type: "ARM_CAPTURE", folderName: "MyCourse", durationMs: 60000 });
  L.created({ id: 201 });
  L.created({ id: 202 });
  await tick();
  const rep = await send({ type: "SIZE_REPORT", jobId: a4.jobId });
  check("size report files", rep.files, [
    { name: "a.pdf", bytes: 1000, state: "complete" },
    { name: "b.pdf", bytes: 500, state: "interrupted" },
  ]);
  const repUnknown = await send({ type: "SIZE_REPORT", jobId: "ghost" });
  check("size report unknown job empty", repUnknown.files, []);

  // v1.9.1: SIZE_REPORT survives worker restart via persisted downloadJobs.
  const chromeR = makeChrome();
  chromeR.__store.downloadJobs = { 401: "jobX", 402: "jobX", 403: "other" };
  chromeR.__searchResult = [
    { id: 401, filename: "J/x.pdf", state: "complete", totalBytes: 10 },
    { id: 402, filename: "J/y.pdf", state: "complete", totalBytes: 20 },
    { id: 403, filename: "O/z.pdf", state: "complete", totalBytes: 30 },
  ];
  const LR = chromeR.__listeners;
  loadBackground(chromeR); // fresh boot: memory jobDlIds empty
  const sendR = (m, sender) => new Promise((res) => {
    const r = LR.msg(m, sender || {}, res);
    if (r !== true) res(undefined);
  });
  const repR = await sendR({ type: "SIZE_REPORT", jobId: "jobX" });
  check("size report after restart via persisted map", repR.files, [
    { name: "x.pdf", bytes: 10, state: "complete" },
    { name: "y.pdf", bytes: 20, state: "complete" },
  ]);

  // --- service-worker restart: persisted registry/attribution survive ---
  const persisted = JSON.parse(JSON.stringify(chrome.__store)); // storage.local snapshot
  const chrome2 = makeChrome();
  Object.assign(chrome2.__store, persisted);
  const L2 = chrome2.__listeners;
  loadBackground(chrome2); // fresh worker boot against persisted storage
  const send2 = (m, sender) => new Promise((res) => {
    const r = L2.msg(m, sender || {}, res);
    if (r !== true) res(undefined);
  });
  // finish the in-flight attribution entry written before the restart
  let s3 = null;
  // simulate a download created pre-restart whose determining-filename fires post-restart
  chrome2.__store.downloadJobs = { ...(chrome2.__store.downloadJobs || {}), 999: a4.jobId };
  L2.filename({ id: 999, filename: "late.pdf" }, (s) => { s3 = s; });
  await tick();
  // a4's window (60s) is still valid -> attribution must survive the restart
  check("attribution survives SW restart", s3 && s3.filename, "MyCourse/late.pdf");
  const poll2 = await send2({ type: "POLL_DOWNLOAD", sinceTs: 0 });
  check("telemetry log survives SW restart", poll2.newDownloads >= 1, true);

  // --- growth caps under soak: 250 attributions keep the map bounded ---
  const soak = await send2({ type: "ARM_CAPTURE", folderName: "Soak", durationMs: 60000 });
  check("soak arm ok", soak.ok, true);
  for (let i = 1000; i < 1250; i++) {
    L2.created({ id: i });
  }
  await tick(200);
  const mapSize = Object.keys(chrome2.__store.downloadJobs || {}).length;
  check("downloadJobs map capped at 200", mapSize <= 200, true);
  check("newest attribution retained", chrome2.__store.downloadJobs[1249], soak.jobId);

  console.log(`\nTOTAL pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
