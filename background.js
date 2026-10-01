// background.js
// Job: whatever mechanism VTOP uses to trigger a file save (direct link,
// JS/blob download, form POST, new-tab attachment...), Chrome will still
// fire downloads.onDeterminingFilename for it. We listen for that and,
// while "armed", rewrite the save path to "<Folder>/<originalName>" where
// <Folder> is "Course", "Semester/Course" or "Semester/Course/Faculty"
// (Phase 2 templates + v1.9.0 faculty split).
// This means we do NOT need to know VTOP's internal download mechanism -
// we just need to know WHEN a batch job is running and WHAT folder to use.

function sanitizeFolderName(name) {
  const cleaned = (name || "VIT Downloads")
    .replace(/[\\/:*?"<>|]/g, "-") // strip characters illegal in folder names
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/g, "") // Windows forbids trailing dots/spaces
    .trim();
  return cleaned || "VIT Downloads";
}

// Phase 2 (+v1.9.0 faculty split): allow up to two levels of nesting
// ("Semester/Course" or "Semester/Course/Faculty").
// Each segment is sanitized independently; "..", empty and excess segments
// are dropped so a crafted folder name can never escape Downloads/.
function sanitizeFolderPath(path) {
  const segs = String(path || "")
    .split("/")
    .map((s) => sanitizeFolderName(s))
    .filter((s) => s && s !== "." && s !== ".." && s !== "-" && s !== "VIT Downloads");
  const kept = segs.slice(0, 3);
  if (!kept.length) return "VIT Downloads";
  return kept.join("/");
}

// Phase 3: job-scoped capture. Each ARM creates a job {id, folder, until}
// kept in a registry. Every created download is attributed to the most
// recently armed still-valid job at creation time (onCreated), and
// onDeterminingFilename uses that job's folder. With a single popup this
// behaves exactly like the old global window; with concurrent jobs it
// attributes by creation order instead of last-ARM-wins for everything.
// Registry lives in storage.local so it survives service-worker restarts.

function newJobId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `job-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function pruneJobs(registry, now) {
  const out = {};
  for (const [id, job] of Object.entries(registry || {})) {
    if (job && job.folder && job.until > now) out[id] = job;
  }
  return out;
}

// v3.3: lightweight download + stray-tab telemetry for per-key verification.
// downloadLog: timestamps of downloads seen during any job (memory + persisted
// so POLL_DOWNLOAD survives service-worker restarts). strayTabs: tabs created
// while a job is active (error pages from corrupt files land here).
let downloadLog = [];
const downloadLogMemoryCap = 500;
let strayTabs = [];
const strayTabsCap = 50;
// v3.3 duplicate guard: normalized folder/basename pairs seen this session.
// Chrome's uniquify still does the actual file safety; this set exists so
// double-fired clicks are observable and never overwrite.
const seenJobFiles = new Set();

function noteDownload(ts) {
  downloadLog.push(ts);
  if (downloadLog.length > downloadLogMemoryCap) {
    downloadLog = downloadLog.slice(-downloadLogMemoryCap);
  }
  try {
    chrome.storage.local.get(["downloadLogTs"], (d) => {
      const arr = Array.isArray(d.downloadLogTs) ? d.downloadLogTs : [];
      arr.push(ts);
      chrome.storage.local.set({ downloadLogTs: arr.slice(-downloadLogMemoryCap) });
    });
  } catch (e) { /* telemetry must never break downloads */ }
}

try {
  if (chrome.tabs && chrome.tabs.onCreated) {
    chrome.tabs.onCreated.addListener((tab) => {
      try {
        chrome.storage.local.get(["jobRegistry"], (data) => {
          const now = Date.now();
          const registry = pruneJobs(data.jobRegistry, now);
          if (!Object.keys(registry).length) return; // no active job: ignore
          strayTabs.push({ tabId: tab.id, ts: now, url: tab.url || "" });
          if (strayTabs.length > strayTabsCap) strayTabs = strayTabs.slice(-strayTabsCap);
        });
      } catch (e) { /* ignore */ }
    });
  }
} catch (e) { /* tabs permission absent on old installs - verification degrades gracefully */ }

// v1.8.2: per-job download id lists for the post-batch size report.
// Which physical ids belong to a job (memory only, capped); sizes are read
// live via downloads.search in SIZE_REPORT so numbers are final.
const jobDlIds = new Map(); // jobId -> Array<downloadId>
const JOB_IDS_CAP = 500;

function trackJobDownload(jobId, dlId) {
  if (!jobDlIds.has(jobId)) jobDlIds.set(jobId, []);
  const arr = jobDlIds.get(jobId);
  if (!arr.includes(dlId)) arr.push(dlId);
  if (arr.length > JOB_IDS_CAP) arr.splice(0, arr.length - JOB_IDS_CAP);
  if (jobDlIds.size > 20) {
    const first = jobDlIds.keys().next().value;
    jobDlIds.delete(first);
  }
}

// Wait until every download id in `ids` reaches a terminal state (complete
// / interrupted), then resolve with their final DownloadItems. Bounded wait
// so the popup never hangs: returns whatever is known at the deadline.
function queryFinalItems(ids, deadlineMs = 30000) {
  return new Promise((resolve) => {
    if (!ids.length) return resolve([]);
    try {
      if (!chrome.downloads || !chrome.downloads.search) return resolve([]);
    } catch (e) {
      return resolve([]);
    }
    const start = Date.now();
    const tick = () => {
      try {
        chrome.downloads.search({ id: ids }, (items) => {
          const list = items || [];
          const terminal = list.filter((it) => it.state === "complete" || it.state === "interrupted");
          if ((list.length && terminal.length >= list.length) || Date.now() - start > deadlineMs) {
            resolve(list);
          } else {
            setTimeout(tick, 1000);
          }
        });
      } catch (e) {
        resolve([]);
      }
    };
    tick();
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "ARM_CAPTURE") {
    const folder = sanitizeFolderPath(msg.folderName);
    const durationMs = msg.durationMs || 3 * 60 * 1000; // safety auto-expiry
    const now = Date.now();
    const jobId = newJobId();
    const job = { folder, until: now + durationMs };
    chrome.storage.local.get(["jobRegistry"], (data) => {
      const registry = pruneJobs(data.jobRegistry, now);
      registry[jobId] = job;
      // activeFolder/activeJobId kept for back-compat (oldest fallback).
      chrome.storage.local.set(
        { jobRegistry: registry, activeFolder: folder, activeJobId: jobId, captureUntil: job.until },
        () => sendResponse({ ok: true, folder, jobId })
      );
    });
    return true; // async sendResponse
  }

  if (msg && msg.type === "DISARM_CAPTURE") {
    chrome.storage.local.get(["jobRegistry", "activeJobId"], (data) => {
      const now = Date.now();
      const registry = pruneJobs(data.jobRegistry, now);
      if (msg.jobId) delete registry[msg.jobId];
      else {
        // No job given: disarm everything (legacy behavior).
        for (const id of Object.keys(registry)) delete registry[id];
      }
      const patch = { jobRegistry: registry };
      if (!msg.jobId || msg.jobId === data.activeJobId) {
        patch.activeFolder = null;
        patch.activeJobId = null;
        patch.captureUntil = 0;
      }
      chrome.storage.local.set(patch, () => sendResponse({ ok: true }));
    });
    return true;
  }

  if (msg && msg.type === "EXTEND_CAPTURE") {
    chrome.storage.local.get(["jobRegistry", "activeJobId", "activeFolder"], (data) => {
      const now = Date.now();
      const registry = pruneJobs(data.jobRegistry, now);
      const targetId = msg.jobId || data.activeJobId;
      if (targetId && registry[targetId]) {
        registry[targetId].until = now + (msg.durationMs || 60000);
      }
      const patch = { jobRegistry: registry };
      if (targetId && targetId === data.activeJobId && data.activeFolder) {
        patch.captureUntil = now + (msg.durationMs || 60000);
      }
      chrome.storage.local.set(patch, () => sendResponse({ ok: true }));
    });
    return true;
  }

  // v3.3: per-key verification RPCs (best-effort; unknown to old callers).
  if (msg && msg.type === "POLL_DOWNLOAD") {
    const sinceTs = Number(msg.sinceTs || 0);
    const countSince = (arr) => (Array.isArray(arr) ? arr.filter((t) => Number(t) >= sinceTs).length : 0);
    chrome.storage.local.get(["downloadLogTs"], (data) => {
      const persisted = countSince(data.downloadLogTs);
      const memory = downloadLog.filter((t) => t >= sinceTs).length;
      sendResponse({ ok: true, newDownloads: Math.max(persisted, memory), total: downloadLog.length });
    });
    return true;
  }

  if (msg && msg.type === "CLOSE_STRAY_TABS") {
    const sinceTs = Number(msg.sinceTs || 0);
    const selfTabId = sender && sender.tab ? sender.tab.id : null;
    const candidates = strayTabs.filter((t) => t.ts >= sinceTs - 2000 && t.tabId !== selfTabId);
    strayTabs = strayTabs.filter((t) => t.ts < sinceTs - 2000);
    try {
      if (!chrome.tabs || !chrome.tabs.remove) return sendResponse({ ok: false, closed: 0 });
      const ids = candidates.map((t) => t.tabId).filter((id) => typeof id === "number");
      if (!ids.length) return sendResponse({ ok: true, closed: 0 });
      chrome.tabs.remove(ids, () => sendResponse({ ok: true, closed: ids.length }));
    } catch (e) {
      try { sendResponse({ ok: false, closed: 0 }); } catch (e2) {}
    }
    return true;
  }

  // v1.8.2: post-batch size report. Waits (bounded) for the job's downloads
  // to finish, then returns final [{ name, bytes, state }] so the popup can
  // tell byte-identical same-named files apart from different ones.
  // v1.9.1: job->id attribution ALSO comes from the persisted downloadJobs
  // map (memory jobDlIds is lost when the worker idles out mid-batch, which
  // a 46-file live run proved happens). Union of both, deduped.
  if (msg && msg.type === "SIZE_REPORT") {
    const memIds = (msg.jobId && jobDlIds.get(msg.jobId)) || [];
    chrome.storage.local.get(["downloadJobs"], (data) => {
      let storedIds = [];
      try {
        const map = (data && data.downloadJobs) || {};
        storedIds = Object.entries(map)
          .filter(([, j]) => j === msg.jobId)
          .map(([id]) => Number(id))
          .filter((id) => Number.isFinite(id));
      } catch (e) { storedIds = []; }
      const ids = Array.from(new Set([...(memIds || []), ...storedIds]));
      queryFinalItems(ids.slice(), 30000).then((items) => {
        try {
          sendResponse({
            ok: true,
            files: items.map((it) => ({
              name: String((it.filename || "").split(/[\\/]/).pop() || "file"),
              bytes: typeof it.totalBytes === "number" && it.totalBytes >= 0
                ? it.totalBytes
                : (typeof it.fileSize === "number" && it.fileSize >= 0 ? it.fileSize : -1),
              state: it.state || "unknown"
            }))
          });
        } catch (e) {
          try { sendResponse({ ok: false, files: [] }); } catch (e2) {}
        }
      });
    });
    return true;
  }
});

// Attribute each created download to the most recently armed valid job.
chrome.downloads.onCreated.addListener((item) => {
  try { noteDownload(Date.now()); } catch (e) { /* telemetry only */ }
  chrome.storage.local.get(["jobRegistry", "activeJobId"], (data) => {
    const now = Date.now();
    const registry = pruneJobs(data.jobRegistry, now);
    let pick = null;
    let pickUntil = 0;
    for (const [id, job] of Object.entries(registry)) {
      // >= so ties (same-millisecond ARMs) resolve to the newest job.
      if (job.until >= pickUntil) {
        pick = id;
        pickUntil = job.until;
      }
    }
    const jobId = pick || data.activeJobId || null;
    if (!jobId) return;
    try { trackJobDownload(jobId, item.id); } catch (e) { /* telemetry only */ }
    chrome.storage.local.get(["downloadJobs"], (d2) => {
      const map = d2.downloadJobs || {};
      map[item.id] = jobId;
      // Cap map size to avoid unbounded growth.
      const ids = Object.keys(map);
      if (ids.length > 200) {
        ids.slice(0, ids.length - 200).forEach((k) => delete map[k]);
      }
      chrome.storage.local.set({ downloadJobs: map, jobRegistry: registry });
    });
  });
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  chrome.storage.local.get(["jobRegistry", "downloadJobs", "activeFolder", "captureUntil"], (data) => {
    const now = Date.now();
    const registry = pruneJobs(data.jobRegistry, now);
    const jobId = (data.downloadJobs && data.downloadJobs[item.id]) || null;
    const job = (jobId && registry[jobId]) || null;
    const folder = (job && job.folder) || (data.activeFolder && now < (data.captureUntil || 0) ? data.activeFolder : null);

    // v1.9.1: attribution entries are KEPT (not consumed). The persisted
    // downloadJobs map is SIZE_REPORT's restart-proof job->id index; it is
    // bounded by the 200-entry cap at write time. Still persist the pruned
    // registry so expiry is honored promptly.
    if (jobId && data.downloadJobs) {
      chrome.storage.local.set({ jobRegistry: registry });
    }

    if (folder) {
      // item.filename is Chrome's best-guess filename (may include a
      // path fragment on some OSes) - keep just the base file name and
      // prefix our job folder onto it. Normalized (trimmed) so
      // double-fired clicks collapse to uniquify siblings instead of
      // ever overwriting; conflictAction uniquify guarantees no dup loss.
      // A hostile/degenerate server filename (".", "..", empty) is replaced
      // so the suggestion can never escape the course folder.
      const rawName = item.filename || item.finalUrl || "material";
      let baseName = (rawName.split(/[\\/]/).pop() || "material").trim() || "material";
      if (baseName === "." || baseName === "..") baseName = "material";
      try {
        const k = `${folder}/${baseName.toLowerCase()}`;
        seenJobFiles.add(k);
        if (seenJobFiles.size > 1000) {
          const arr = Array.from(seenJobFiles).slice(-1000);
          seenJobFiles.clear();
          arr.forEach((x) => seenJobFiles.add(x));
        }
      } catch (e) { /* dedup set is best-effort */ }
      suggest({
        filename: `${folder}/${baseName}`,
        conflictAction: "uniquify"
      });
    } else {
      suggest(); // not one of ours (or capture window expired) - default behavior
    }
  });
  return true; // tells Chrome we'll call suggest() asynchronously
});
