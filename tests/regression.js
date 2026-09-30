// VIT Bulk Material Downloader — automated regression suite (mock-DOM).
//
// Runs the REAL extension files (content.js, background.js, popup.js) in
// headless Chromium against tests/mock-vtop.html. No VTOP login required.
//
// Prereqs: `npm i playwright-core` then `npx playwright install chromium`
// Run: `node tests/regression.js`
// Exit code: 0 = all pass, 1 = failure.

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const EXT_DIR = __dirname + '/..';
const MOCK = 'file://' + path.join(__dirname, 'mock-vtop.html');

let pass = 0, fail = 0;
function check(name, cond, evidence) {
  if (cond) { pass++; console.log(`PASS ${name} :: ${evidence || ''}`); }
  else { fail++; console.log(`FAIL ${name} :: ${evidence || ''}`); }
}

async function contentContext(page, html) {
  await page.goto('about:blank');
  if (html) await page.setContent(html);
  else await page.goto(MOCK);
  await page.evaluate(() => {
    delete window.__vitBulkDownloaderInjected;
    window.__ls = null;
    window.__listenerCalls = 0;
    window.__progress = [];
    window.chrome = {
      runtime: {
        onMessage: { addListener(fn) { window.__listenerCalls++; window.__ls = fn; } },
        sendMessage(m) { if (m && m.type === 'DOWNLOAD_PROGRESS') window.__progress.push(m.progress); }
      }
    };
    window.__send = (msg) => new Promise((resolve) => {
      const r = window.__ls(msg, {}, resolve);
      if (r !== true) resolve(undefined);
    });
  });
  await page.addScriptTag({ content: fs.readFileSync(path.join(EXT_DIR, 'content.js'), 'utf8') });
  return (msg) => page.evaluate((m) => window.__send(m), msg);
}

const ROWS = '<tr><td>C</td><td>T1<br>1 (Document)</td><td>F - G - 01-01-2025</td><td><a href=#>D</a></td></tr>'
  + '<tr><td>C</td><td>T2<br>2 (Document)</td><td>F - G - 02-01-2025</td><td><button>D</button></td></tr>';
const L1HTML = `<select><option>Fall Semester - X - Y</option></select>
<table><thead><tr><th>Course Detail</th><th>Material Detail</th><th>Uploaded By</th><th>Download</th></tr></thead><tbody>${ROWS}</tbody></table>`;
const L2HTML = `<select><option>Fall Semester - X - Y</option></select>
<table><tr><th>Course Info</th><th>Material Detail List</th><th>Author</th><th>Download File</th></tr>${ROWS}</table>`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext()).newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));

  // --- content: L1 + diagnostics + advance + guards (focused L1 fixture) ---
  let send = await contentContext(page, L1HTML);
  let st = await send({ type: 'GET_STATE' });
  check('L1 table strategy', st.tableStrategy === 'L1-strict', st.tableStrategy);
  check('L1 rows + multiDocRows', st.rows.length >= 2 && st.multiDocRows === 1, `rows=${st.rows.length} multi=${st.multiDocRows}`);
  let dg = await send({ type: 'DIAGNOSTICS' });
  check('DIAGNOSTICS buttons/multi', dg.ok && dg.diag.downloadButtons >= 2 && dg.diag.multiDocRows === 1,
    `buttons=${dg.diag && dg.diag.downloadButtons} multi=${dg.diag && dg.diag.multiDocRows}`);
  const adv = await send({ type: 'ADVANCE_PAGE' });
  check('ADVANCE_PAGE no-next', adv.advanced === false && adv.reason === 'no_next', JSON.stringify(adv));

  // single click + duplicate injection + skip reasons (mock fixture)
  await page.evaluate(() => {
    window.__clicks = [];
    document.querySelectorAll('.dl, button, table a').forEach((el, i) => el.addEventListener('click', () => window.__clicks.push(i)));
    window.__progress = [];
  });
  const dl = await send({ type: 'DOWNLOAD_ROWS', keys: [st.rows[0].key] });
  const clicks = await page.evaluate(() => window.__clicks);
  check('single-click no-dupe', dl.clicked === 1 && clicks.length === 1, `clicked=${dl.clicked} dom=${clicks.length}`);
  const before = await page.evaluate(() => window.__listenerCalls);
  await page.addScriptTag({ content: fs.readFileSync(path.join(EXT_DIR, 'content.js'), 'utf8') });
  const after = await page.evaluate(() => window.__listenerCalls);
  check('duplicate injection safe', before === after, `${before}->${after}`);
  const sk = await send({ type: 'DOWNLOAD_ROWS', keys: ['nope'] });
  check('skip not-on-page', sk.skipped === 1 && sk.skippedDetails[0].reason === 'not-on-page', JSON.stringify(sk.skippedDetails));

  // --- L2 fallback + no-table ---
  send = await contentContext(page, L2HTML);
  st = await send({ type: 'GET_STATE' });
  check('L2 drift fallback', st.tableStrategy === 'L2-drift' && st.rows.length === 2, st.tableStrategy);
  send = await contentContext(page, '<p>hello</p>');
  st = await send({ type: 'GET_STATE' });
  dg = await send({ type: 'DIAGNOSTICS' });
  check('no-table graceful', !st.ok && dg.ok && !dg.diag.tableFound, 'ok=false, diag found=false');

  // --- background: sanitize, path, jobs ---
  const bg = await page.evaluate((src) => {
    const store = {};
    const listeners = {};
    window.chrome = {
      runtime: { onMessage: { addListener(fn) { listeners.msg = fn; } } },
      storage: { local: {
        set(o, cb) { Object.assign(store, o); cb && cb(); },
        get(k, cb) { const r = {}; (Array.isArray(k) ? k : [k]).forEach((x) => { r[x] = store[x]; }); cb(r); }
      } },
      downloads: {
        onDeterminingFilename: { addListener(fn) { listeners.fn = fn; } },
        onCreated: { addListener(fn) { listeners.created = fn; } }
      }
    };
    window.eval(src);
    const sendBg = (m) => new Promise((res) => listeners.msg(m, {}, res));
    return (async () => {
      const o = {};
      o.paths = [
        sanitizeFolderPath('A'),
        sanitizeFolderPath('S/C'),
        sanitizeFolderPath('../../evil'),
        sanitizeFolderPath('a/b/c'),
        sanitizeFolderPath('')
      ];
      const a1 = await sendBg({ type: 'ARM_CAPTURE', folderName: 'A', durationMs: 60000 });
      const a2 = await sendBg({ type: 'ARM_CAPTURE', folderName: 'S/B', durationMs: 60000 });
      o.jobs = !!a1.jobId && !!a2.jobId && a1.jobId !== a2.jobId;
      listeners.created({ id: 1 });
      await new Promise((r) => setTimeout(r, 30));
      let s1 = null;
      listeners.fn({ id: 1, filename: 'f.pdf' }, (s) => { s1 = s; });
      await new Promise((r) => setTimeout(r, 30));
      o.attr = s1 && s1.filename;
      await sendBg({ type: 'DISARM_CAPTURE' });
      let s2 = 'unset';
      listeners.fn({ id: 2, filename: 'g.pdf' }, (s) => { s2 = (s && s.filename) || 'DEFAULT'; });
      await new Promise(r => setTimeout(r, 30));
      o.afterAll = s2;
      return o;
    })();
  }, fs.readFileSync(path.join(EXT_DIR, 'background.js'), 'utf8'));
  check('sanitizeFolderPath', JSON.stringify(bg.paths) === JSON.stringify(['A', 'S/C', 'evil', 'a/b', 'VIT Downloads']), JSON.stringify(bg.paths));
  check('job registry + attribution', bg.jobs && bg.attr === 'S/B/f.pdf' && bg.afterAll === 'DEFAULT', `attr=${bg.attr} afterAll=${bg.afterAll}`);

  // --- popup: render + terminology + preview + queue + history ---
  const html = fs.readFileSync(path.join(EXT_DIR, 'popup.html'), 'utf8');
  const js = fs.readFileSync(path.join(EXT_DIR, 'popup.js'), 'utf8');
  const mockState = {
    ok: true, courseText: 'Fall Semester 2025-26 - ISWE204L - Operating Systems - TH',
    folderNameSuggestion: 'ISWE204L - Operating Systems', showingInfo: null,
    rows: [
      { key: 'k1', title: 'BIOS', docCount: 1, facultyName: 'SIVA', dateText: '16-11-2025' },
      { key: 'k2', title: 'IPC', docCount: 5, facultyName: 'SIVA', dateText: '16-11-2025' },
      { key: 'k3', title: 'DMA', docCount: 2, facultyName: 'BALA', dateText: '06-11-2025' }
    ]
  };
  const r = await page.evaluate(({ html, js, mockState }) => {
    document.body.innerHTML = '<div id=h></div>';
    document.getElementById('h').innerHTML = html;
    const store = { downloadHistory: { k1: { course: 'c', folder: 'f', title: 'BIOS', ts: 1 } }, folderTemplate: 'semester-course' };
    const sent = [];
    window.chrome = {
      tabs: { query: async () => [{ id: 9, url: 'https://vtop.vit.ac.in/vtop/x' }], sendMessage: (id, msg, cb) => {
        if (msg.type === 'GET_STATE') cb(mockState);
        else if (msg.type === 'DIAGNOSTICS') cb({ ok: true, diag: { downloadButtons: 2, multiDocRows: 1, log: [] } });
        else { sent.push(msg.keys.slice()); cb({ clicked: 1, skipped: 0, ok: true, skippedDetails: [] }); }
      } },
      scripting: { executeScript: async () => {} },
      runtime: { sendMessage: async (m) => ({ ok: true, folder: 'F', jobId: 'j1' }), onMessage: { addListener() {}, removeListener() {} } },
      storage: { local: {
        get: (k, cb) => { const o = {}; (Array.isArray(k) ? k : [k]).forEach((x) => { o[x] = store[x]; }); cb(o); },
        set: (o, cb) => { Object.assign(store, o); cb && cb(); }
      } },
      notifications: { create: () => {} }
    };
    window.eval(js);
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
    return new Promise((res) => setTimeout(async () => {
      const o = {};
      try {
        o.match = document.getElementById('matchCount').textContent;
        o.badge = document.querySelectorAll('.dl-badge').length;
        o.tmpl = document.getElementById('folderTemplate').value;
        // diagnostics overlay
        document.getElementById('diagBtn').click();
        await new Promise((r) => setTimeout(r, 500));
        o.diagVisible = !document.getElementById('diagOverlay').classList.contains('hidden');
        o.diagItems = document.querySelectorAll('#diagList li').length;
        document.getElementById('diagCloseBtn').click();
        // sweep on single-page mock -> stops at no_next, keeps rows
        window.confirm = () => true;
        document.getElementById('sweepBtn').click();
        await new Promise((r) => setTimeout(r, 2500));
        o.rowsAfterSweep = document.querySelectorAll('.material-row').length;
        // queue: select k2+k3 (k1 already downloaded + skipExisting on)
        document.querySelectorAll('.material-row input[type=checkbox]').forEach((cb, i) => { if (i > 0) cb.click(); });
        document.getElementById('downloadBtn').click();
        await new Promise((r) => setTimeout(r, 300));
        document.getElementById('previewStartBtn').click();
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 500));
          if (/^Done|^Stopped/.test(document.getElementById('progressText').textContent)) break;
        }
        o.sentBatches = sent.map((s) => s.join(','));
        o.done = document.getElementById('progressText').textContent;
        o.badgesAfter = document.querySelectorAll('.dl-badge').length;
        o.storeKeys = Object.keys(store.downloadHistory).sort().join(',');
        res(o);
      } catch (e) { res({ error: String(e) }); }
    }, 1000));
  }, { html, js, mockState });
  check('popup terminology+history+template', /2 new/.test(r.match) && r.badge === 1 && r.tmpl === 'semester-course', JSON.stringify({ match: r.match, badge: r.badge, tmpl: r.tmpl }));
  check('diagnostics overlay', r.diagVisible && r.diagItems >= 4, `items=${r.diagItems}`);
  check('sweep keeps rows (no-next)', r.rowsAfterSweep === 3, `rows=${r.rowsAfterSweep}`);
  check('queue per-key + skip-existing', JSON.stringify(r.sentBatches) === JSON.stringify(['k2', 'k3']), JSON.stringify(r.sentBatches));
  check('history recorded + badges', r.storeKeys === 'k1,k2,k3' && r.badgesAfter === 3, `keys=${r.storeKeys} badges=${r.badgesAfter}`);
  const sz = await page.evaluate(() => window.summarizeSizes([
    { name: 'a.pdf', bytes: 2100000, state: 'complete' },
    { name: 'a.pdf', bytes: 2100000, state: 'complete' },
    { name: 'a.pdf', bytes: 1800000, state: 'complete' },
    { name: 'b.pdf', bytes: -1, state: 'complete' }
  ]));
  check('size report identical vs different vs unknown',
    sz.length === 2 && /identical/.test(sz[0]) && /1\.7 MB|1\.8 MB/.test(sz[0]) && /unknown/i.test(sz[1]), JSON.stringify(sz));

  // --- v1.8.0: full-scan + duplicate guard + error-page resilience ---
  // A: async server-side reload (full rows arrive 1200ms after Show->100,
  // first row unchanged). Old code parsed too early -> 6 of 22.
  send = await contentContext(page, `<select><option>Fall Semester - X - Y</option></select>
    <div>Show <select id="len"><option value="10">10</option><option value="100">100</option></select> entries
    <input type="search">
    <table><thead><tr><th>Course Detail</th><th>Material Detail</th><th>Uploaded By</th><th>Download</th></tr></thead>
    <tbody id="tb"></tbody></table><div id="info"></div></div>
    <script>window.__mkRows=(n)=>Array.from({length:n},(_,i)=>'<tr><td>C</td><td>T'+i+'<br>1 (Document)</td><td>C - ProfA - 01-01-2025</td><td><a href=#>D</a></td></tr>').join('');</script>`);
  await page.evaluate(() => {
    document.getElementById('tb').innerHTML = window.__mkRows(6);
    document.getElementById('info').textContent = 'Showing 1 to 6 of 22 entries';
    document.getElementById('len').addEventListener('change', () => {
      setTimeout(() => {
        document.getElementById('tb').innerHTML = window.__mkRows(22);
        document.getElementById('info').textContent = 'Showing 1 to 22 of 22 entries';
      }, 1200);
    });
  });
  st = await send({ type: 'GET_STATE' });
  check('full scan waits for async reload', st.rows.length === 22, `rows=${st.rows.length}`);

  // A2: course dropdown ("Fall Semester...") must never be mistaken for the
  // Show-entries select, even when the wrapper scope is wide. "Fall"
  // contains the substring "all" - exact-match only.
  send = await contentContext(page, `<select><option>Fall Semester - X - Y</option></select>
    <div>Show <select id="len2"><option value="10">10</option><option value="25" selected>25</option></select> entries
    <input type="search">
    <table><thead><tr><th>Course Detail</th><th>Material Detail</th><th>Uploaded By</th><th>Download</th></tr></thead>
    <tbody><tr><td>C</td><td>T1<br>1 (Document)</td><td>C - F - 01-01-2025</td><td><a href=#>D</a></td></tr></tbody></table>
    <div>Showing 1 to 1 of 1 entries</div></div>`);
  st = await send({ type: 'GET_STATE' });
  check('course dropdown ignored as length select', st.ok && st.rows.length === 1, `rows=${st.rows.length}`);

  // B: rapid re-click of the same key -> single DOM click + duplicate-click.
  send = await contentContext(page, L1HTML);
  st = await send({ type: 'GET_STATE' });
  await page.evaluate(() => {
    window.__clicks = [];
    document.querySelectorAll('table a, table button').forEach((el, i) => el.addEventListener('click', () => window.__clicks.push(i)));
  });
  await send({ type: 'DOWNLOAD_ROWS', keys: [st.rows[0].key] });
  const dup2 = await send({ type: 'DOWNLOAD_ROWS', keys: [st.rows[0].key] });
  const clicks2 = await page.evaluate(() => window.__clicks);
  check('duplicate-click guard', clicks2.length === 1 && dup2.skipped === 1 && dup2.skippedDetails[0].reason === 'duplicate-click',
    `dom=${clicks2.length} reason=${dup2.skippedDetails[0] && dup2.skippedDetails[0].reason}`);

  // C: error file (no download + stray tab) is skipped with reason and the
  // next file in the same batch still downloads - queue never interrupts.
  send = await contentContext(page, `<select><option>Fall Semester - X - Y</option></select>
    <table><thead><tr><th>Course Detail</th><th>Material Detail</th><th>Uploaded By</th><th>Download</th></tr></thead>
    <tbody>
    <tr><td>C</td><td>BADFILE<br>1 (Document)</td><td>C - F - 01-01-2025</td><td><a href="#" id="bad">D</a></td></tr>
    <tr><td>C</td><td>GOODFILE<br>1 (Document)</td><td>C - F - 02-01-2025</td><td><a href="#" id="good">D</a></td></tr>
    </tbody></table>`);
  await page.evaluate(() => {
    window.__good = 0;
    document.getElementById('bad').addEventListener('click', (e) => e.preventDefault());
    document.getElementById('good').addEventListener('click', (e) => { e.preventDefault(); window.__good++; });
    // Bg mock: downloads appear only after the good file is clicked, a stray
    // tab only while the bad file is pending.
    window.chrome.runtime.sendMessage = (m) => {
      if (m && m.type === 'POLL_DOWNLOAD') return Promise.resolve({ ok: true, newDownloads: window.__good > 0 ? 1 : 0, total: window.__good });
      if (m && m.type === 'CLOSE_STRAY_TABS') return Promise.resolve({ ok: true, closed: window.__good > 0 ? 0 : 1 });
      if (m && m.type === 'DOWNLOAD_PROGRESS') return undefined;
      return Promise.resolve(null);
    };
  });
  st = await send({ type: 'GET_STATE' });
  const badKey = st.rows.find((x) => x.title === 'BADFILE').key;
  const goodKey = st.rows.find((x) => x.title === 'GOODFILE').key;
  const resC = await send({ type: 'DOWNLOAD_ROWS', keys: [badKey, goodKey] });
  const goodClicks = await page.evaluate(() => window.__good);
  check('error-page skipped, queue continues', resC.clicked === 1 && resC.skipped === 1 && goodClicks === 1 &&
    /error-page|no-download/.test(resC.skippedDetails[0].reason), JSON.stringify(resC.skippedDetails));

  // D: "0 (Document)" badge rows WITH a download icon are real files -
  // list them individually and download them. Only rows with NO download
  // control are excluded.
  send = await contentContext(page, `<select><option>Fall Semester - X - Y</option></select>
    <table><thead><tr><th>Course Detail</th><th>Material Detail</th><th>Uploaded By</th><th>Download</th></tr></thead>
    <tbody>
    <tr><td>C</td><td>ZeroBadge<br>0 (Document)</td><td>C - F - 01-01-2025</td><td><a href="#" id="z">D</a></td></tr>
    <tr><td>C</td><td>EmptyRow<br>0 (Document)</td><td>C - F - 02-01-2025</td><td></td></tr>
    <tr><td>C</td><td>FiveDocs<br>5 (Document)</td><td>C - F - 03-01-2025</td><td><button id="f">D</button></td></tr>
    </tbody></table>`);
  await page.evaluate(() => {
    window.__zc = 0; window.__fc = 0;
    document.getElementById('z').addEventListener('click', (e) => { e.preventDefault(); window.__zc++; });
    document.getElementById('f').addEventListener('click', (e) => { e.preventDefault(); window.__fc++; });
  });
  st = await send({ type: 'GET_STATE' });
  const withDl = st.rows.filter((x) => x.hasDownload);
  check('zero-badge rows listed when download icon exists', st.rows.length === 3 && withDl.length === 2,
    `rows=${st.rows.length} withDl=${withDl.length}`);
  const zKey = st.rows.find((x) => x.title === 'ZeroBadge').key;
  const noCtrlKey = st.rows.find((x) => x.title === 'EmptyRow').key;
  const zRes = await send({ type: 'DOWNLOAD_ROWS', keys: [zKey] });
  const zc = await page.evaluate(() => window.__zc);
  const eRes = await send({ type: 'DOWNLOAD_ROWS', keys: [noCtrlKey] });
  check('zero-badge file downloads on click', zRes.clicked === 1 && zc === 1, `clicked=${zRes.clicked} dom=${zc}`);
  check('row without control still skipped', eRes.skipped === 1 && eRes.skippedDetails[0].reason === 'no-control',
    JSON.stringify(eRes.skippedDetails));

  // E (v1.8.2): byte-identical rows are still distinct files - every
  // physical row lists individually and every click fires.
  send = await contentContext(page, `<select><option>Fall Semester - X - Y</option></select>
    <table><thead><tr><th>Course Detail</th><th>Material Detail</th><th>Uploaded By</th><th>Download</th></tr></thead>
    <tbody>${'<tr><td>C</td><td>Same Title<br>0 (Document)</td><td>C - F - 01-01-2025</td><td><a href="#" class="sd">D</a></td></tr>'.repeat(5)}</tbody></table>`);
  await page.evaluate(() => {
    window.__sd = 0;
    document.querySelectorAll('.sd').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); window.__sd++; }));
  });
  st = await send({ type: 'GET_STATE' });
  const uniqKeys = new Set(st.rows.map((x) => x.key));
  check('identical rows stay distinct', st.rows.length === 5 && uniqKeys.size === 5, `rows=${st.rows.length} uniq=${uniqKeys.size}`);
  const allRes = await send({ type: 'DOWNLOAD_ROWS', keys: st.rows.map((x) => x.key) });
  const sd = await page.evaluate(() => window.__sd);
  check('all identical-row copies download', allRes.clicked === 5 && sd === 5, `clicked=${allRes.clicked} dom=${sd}`);

  check('zero page errors', errs.length === 0, JSON.stringify(errs).slice(0, 200));
  console.log(`\nTOTAL pass=${pass} fail=${fail}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
