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
// Iteration 2 lock-in for Iteration 1 L3/control fallback fix (content.js
// positional columns + detected control column). Headers drift beyond L1/L2
// wording ("Material Info"/"Uploaded Info"/"Action") so only L3-controls can
// match; bodies use VTOP usual order course/material/uploaded/download.
const L3HTML = `<select><option>Fall Semester - X - Y</option></select>
<table><thead><tr><th>S.No</th><th>Material Info</th><th>Uploaded Info</th><th>Action</th></tr></thead>
<tbody>
<tr><td>1</td><td>Lecture A<br>1 (Document)</td><td>CSE2001 - ProfA - 01-01-2025</td><td><a href="#" id="la">D</a></td></tr>
<tr><td>2</td><td></td><td>CSE2001 - ProfB - 02-02-2025</td><td><button id="lb">D</button></td></tr>
<tr><td>3</td><td>NoFile<br>0 (Document)</td><td>CSE2001 - ProfC - 03-03-2025</td><td></td></tr>
</tbody></table>`;
// Narrow 3-column L3: uploaded info and download control share the last
// column. Positional fallback must still resolve titles/faculty/dates and
// the detected control column must still fire.
const L3NARROWHTML = `<select><option>Fall Semester - X - Y</option></select>
<table><thead><tr><th>S.No</th><th>Material Info</th><th>Uploaded Info</th></tr></thead>
<tbody>
<tr><td>1</td><td>Lecture A<br>1 (Document)</td><td>CSE2001 - ProfA - 01-01-2025 <a href="#" id="na">D</a></td></tr>
<tr><td>2</td><td>Lecture B<br>2 (Document)</td><td>CSE2001 - ProfB - 02-02-2025 <button id="nb">D</button></td></tr>
</tbody></table>`;
// Drifted column ORDER (L2): same header wording as L2 but Download first.
// columnIndex (not position) must route course/material/uploaded/download.
const L2REORDERHTML = `<select><option>Fall Semester - X - Y</option></select>
<table><tr><th>Download File</th><th>Material Detail List</th><th>Author</th><th>Course Info</th></tr>
<tr><td><a href="#">D</a></td><td>T1<br>1 (Document)</td><td>C - F - 01-01-2025</td><td>C</td></tr>
<tr><td><button>D</button></td><td>T2<br>2 (Document)</td><td>C - G - 02-01-2025</td><td>C</td></tr></table>`;
// Iteration 3 P1: pure-drift L3 (S.No|Details|Faculty|Action) with NO
// "material"/"course detail" substring anywhere. Only the L3b drift gate
// (header synonyms + control majority + material-like rows + course signal)
// may match. Bodies use split columns (Details=title, Faculty=course-faculty-date).
const L3PUREHTML = `<select><option>Fall Semester - X - Y</option></select>
<table><thead><tr><th>S.No</th><th>Details</th><th>Faculty</th><th>Action</th></tr></thead>
<tbody>
<tr><td>1</td><td>Lecture A<br>1 (Document)</td><td>CSE2001 - ProfA - 01-01-2025</td><td><a href="#" id="pa">D</a></td></tr>
<tr><td>2</td><td>Lecture B<br>2 (Document)</td><td>CSE2001 - ProfB - 02-02-2025</td><td><button id="pb">D</button></td></tr>
</tbody></table>`;
// Iteration 3 split-column L3: date lives in Details, faculty alone in
// Faculty col ("ProfA", no dash/date). Date fallback must scan the row;
// 2-part "ProfA - date" must yield ProfA (not the date).
const L3SPLITHTML = `<select><option>Fall Semester - X - Y</option></select>
<table><thead><tr><th>S.No</th><th>Details</th><th>Faculty</th><th>Action</th></tr></thead>
<tbody>
<tr><td>1</td><td>Intro Slides<br>1 (Document)<br>01-01-2025</td><td>ProfA</td><td><a href="#" id="qa">D</a></td></tr>
<tr><td>2</td><td>Week2 Notes</td><td>ProfB - 02-02-2025</td><td><button id="qb">D</button></td></tr>
</tbody></table>`;
// Iteration 3 narrow 3-col SEPARATE ([Material, Uploaded, Action], no S.No).
// Fixed 0/1/2 misread uploaded as "D"; inference must yield 0/0/1.
const L3NARROWSEPHTML = `<select><option>Fall Semester - X - Y</option></select>
<table><thead><tr><th>Material Info</th><th>Uploaded Info</th><th>Action</th></tr></thead>
<tbody>
<tr><td>Lecture A<br>1 (Document)</td><td>CSE2001 - ProfA - 01-01-2025</td><td><a href="#" id="sa">D</a></td></tr>
<tr><td>Lecture B<br>2 (Document)</td><td>CSE2001 - ProfB - 02-02-2025</td><td><button id="sb">D</button></td></tr>
</tbody></table>`;
// Iteration 3 negatives: non-material tables must NOT match even with a
// course dropdown + download-like controls on the page (no false positives).
const NEGATTENDHTML = `<select><option>Fall Semester - X - Y</option></select>
<table><thead><tr><th>S.No</th><th>Date</th><th>Status</th><th>Action</th></tr></thead>
<tbody>
<tr><td>1</td><td>01-01-2025</td><td>Present</td><td><button>View</button></td></tr>
<tr><td>2</td><td>02-01-2025</td><td>Absent</td><td><button>View</button></td></tr>
</tbody></table>`;
const NEGGRADESHTML = `<select><option>Fall Semester - X - Y</option></select>
<table><thead><tr><th>Student</th><th>Score</th><th>Grade</th></tr></thead>
<tbody><tr><td>John</td><td>90</td><td>A</td></tr></tbody></table>`;
// Iteration 4 placeholder: "Select course" selected (valid semester option
// present but not selected) must resolve to null/invalid, not a valid course.
// Valid L1 course must still resolve (positive case preserved).
const PLACEHOLDERHTML = `<select><option selected>Select course</option><option>Fall Semester - X - Y</option></select>
<table><thead><tr><th>Course Detail</th><th>Material Detail</th><th>Uploaded By</th><th>Download</th></tr></thead><tbody>${ROWS}</tbody></table>`;
const PLACEHOLDERDASHHTML = `<select><option selected>-- Select --</option><option>Fall Semester - X - Y</option></select>
<table><thead><tr><th>Course Detail</th><th>Material Detail</th><th>Uploaded By</th><th>Download</th></tr></thead><tbody>${ROWS}</tbody></table>`;

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

  // --- L3/control fallback (Iteration 1 fix lock-in; Iteration 2 coverage) ---
  // Drifted headers (S.No/Material Info/Uploaded Info/Action) miss L1/L2, so
  // only L3-controls may match. Verifies detection, positional columns,
  // empty-title handling, control detection, faculty/date, click, narrow 3-col.
  send = await contentContext(page, L3HTML);
  st = await send({ type: 'GET_STATE' });
  check('L3 table strategy', st.tableStrategy === 'L3-controls' && st.rows.length === 3, `${st.tableStrategy} rows=${st.rows.length}`);
  check('L3 titles faculty dates controls',
    st.rows[0].title === 'Lecture A' && st.rows[0].facultyName === 'ProfA' && st.rows[0].dateText === '01-01-2025' && st.rows[0].hasDownload === true &&
    st.rows[1].facultyName === 'ProfB' && st.rows[1].dateText === '02-02-2025' && st.rows[1].hasDownload === true &&
    st.rows[2].title === 'NoFile' && st.rows[2].facultyName === 'ProfC' && st.rows[2].hasDownload === false,
    JSON.stringify(st.rows.map((r) => ({ t: r.title, f: r.facultyName, d: r.dateText, dl: r.hasDownload }))));
  check('L3 empty title handled', st.rows[1].title === '' && st.rows[1].hasDownload === true, `title=${JSON.stringify(st.rows[1].title)} hasDl=${st.rows[1].hasDownload}`);
  dg = await send({ type: 'DIAGNOSTICS' });
  check('L3 diagnostics controls', dg.ok && dg.diag.tableStrategy === 'L3-controls' && dg.diag.downloadButtons === 2,
    `strat=${dg.diag && dg.diag.tableStrategy} buttons=${dg.diag && dg.diag.downloadButtons}`);
  await page.evaluate(() => {
    window.__l3clicks = [];
    document.querySelectorAll('table a, table button').forEach((el) => el.addEventListener('click', (e) => { e.preventDefault(); window.__l3clicks.push(el.id || 'x'); }));
  });
  const l3Key = st.rows[0].key;
  const l3Res = await send({ type: 'DOWNLOAD_ROWS', keys: [l3Key] });
  const l3Clicks = await page.evaluate(() => window.__l3clicks);
  check('L3 download click fires control', l3Res.clicked === 1 && l3Clicks.length === 1 && l3Clicks[0] === 'la', `clicked=${l3Res.clicked} dom=${JSON.stringify(l3Clicks)}`);
  const l3NoKey = st.rows[2].key;
  const l3NoRes = await send({ type: 'DOWNLOAD_ROWS', keys: [l3NoKey] });
  check('L3 row without control skipped', l3NoRes.skipped === 1 && l3NoRes.skippedDetails[0].reason === 'no-control', JSON.stringify(l3NoRes.skippedDetails));
  // Narrow 3-column L3 fallback (uploaded info + control share last column).
  send = await contentContext(page, L3NARROWHTML);
  st = await send({ type: 'GET_STATE' });
  check('L3 narrow 3-col fallback', st.tableStrategy === 'L3-controls' && st.rows.length === 2 &&
    st.rows[0].title === 'Lecture A' && st.rows[1].title === 'Lecture B', `${st.tableStrategy} titles=${st.rows.map((r) => r.title).join(',')}`);
  check('L3 narrow faculty dates', st.rows[0].facultyName === 'ProfA' && st.rows[0].dateText === '01-01-2025' &&
    st.rows[1].facultyName === 'ProfB' && st.rows[1].dateText === '02-02-2025' && st.rows.every((r) => r.hasDownload === true),
    JSON.stringify(st.rows.map((r) => ({ t: r.title, f: r.facultyName, d: r.dateText }))));
  dg = await send({ type: 'DIAGNOSTICS' });
  check('L3 narrow diagnostics', dg.ok && dg.diag.downloadButtons === 2 && dg.diag.multiDocRows === 1,
    `buttons=${dg.diag && dg.diag.downloadButtons} multi=${dg.diag && dg.diag.multiDocRows}`);
  await page.evaluate(() => {
    window.__nclicks = [];
    document.querySelectorAll('table a, table button').forEach((el) => el.addEventListener('click', (e) => { e.preventDefault(); window.__nclicks.push(el.id || 'x'); }));
  });
  const nRes = await send({ type: 'DOWNLOAD_ROWS', keys: [st.rows[0].key] });
  const nClicks = await page.evaluate(() => window.__nclicks);
  check('L3 narrow click fires control', nRes.clicked === 1 && nClicks.length === 1 && nClicks[0] === 'na', `clicked=${nRes.clicked} dom=${JSON.stringify(nClicks)}`);
  // Drifted column ORDER (L2): Download first, then Material/Author/Course.
  send = await contentContext(page, L2REORDERHTML);
  st = await send({ type: 'GET_STATE' });
  check('L2 drifted column order', st.tableStrategy === 'L2-drift' && st.rows.length === 2 &&
    st.rows[0].title === 'T1' && st.rows[0].facultyName === 'F' && st.rows[0].dateText === '01-01-2025' && st.rows[0].hasDownload === true &&
    st.rows[1].title === 'T2' && st.rows[1].facultyName === 'G' && st.rows[1].hasDownload === true,
    `${st.tableStrategy} ${JSON.stringify(st.rows.map((r) => ({ t: r.title, f: r.facultyName })))}`);
  // --- Iteration 3 P1: pure-drift L3 (S.No|Details|Faculty|Action, no "material") ---
  // Previously ok=false (L3 keyword gate). L3b drift gate must match without
  // broadening to arbitrary tables (see negatives below). Preserves L1/L2.
  send = await contentContext(page, L3PUREHTML);
  st = await send({ type: 'GET_STATE' });
  check('L3 pure-drift strategy', st.tableStrategy === 'L3-controls' && st.rows.length === 2, `${st.tableStrategy} rows=${st.rows.length}`);
  check('L3 pure-drift titles faculty dates',
    st.rows[0].title === 'Lecture A' && st.rows[0].facultyName === 'ProfA' && st.rows[0].dateText === '01-01-2025' && st.rows[0].hasDownload === true &&
    st.rows[1].title === 'Lecture B' && st.rows[1].facultyName === 'ProfB' && st.rows[1].dateText === '02-02-2025' && st.rows[1].hasDownload === true,
    JSON.stringify(st.rows.map((r) => ({ t: r.title, f: r.facultyName, d: r.dateText }))));
  dg = await send({ type: 'DIAGNOSTICS' });
  check('L3 pure-drift diagnostics', dg.ok && dg.diag.tableStrategy === 'L3-controls' && dg.diag.downloadButtons === 2,
    `strat=${dg.diag && dg.diag.tableStrategy} buttons=${dg.diag && dg.diag.downloadButtons}`);
  await page.evaluate(() => {
    window.__pclicks = [];
    document.querySelectorAll('table a, table button').forEach((el) => el.addEventListener('click', (e) => { e.preventDefault(); window.__pclicks.push(el.id || 'x'); }));
  });
  const pRes = await send({ type: 'DOWNLOAD_ROWS', keys: [st.rows[0].key] });
  const pClicks = await page.evaluate(() => window.__pclicks);
  check('L3 pure-drift click fires control', pRes.clicked === 1 && pClicks.length === 1 && pClicks[0] === 'pa', `clicked=${pRes.clicked} dom=${JSON.stringify(pClicks)}`);
  // Split columns: date in Details, faculty alone; 2-part "ProfB - date" -> ProfB.
  send = await contentContext(page, L3SPLITHTML);
  st = await send({ type: 'GET_STATE' });
  check('L3 split faculty date fallback', st.tableStrategy === 'L3-controls' && st.rows.length === 2 &&
    st.rows[0].title === 'Intro Slides' && st.rows[0].facultyName === 'ProfA' && st.rows[0].dateText === '01-01-2025' &&
    st.rows[1].title === 'Week2 Notes' && st.rows[1].facultyName === 'ProfB' && st.rows[1].dateText === '02-02-2025',
    JSON.stringify(st.rows.map((r) => ({ t: r.title, f: r.facultyName, d: r.dateText }))));
  // Narrow 3-col SEPARATE: faculty must not be "D", titles/dates correct.
  send = await contentContext(page, L3NARROWSEPHTML);
  st = await send({ type: 'GET_STATE' });
  check('L3 narrow separate faculty', st.tableStrategy === 'L3-controls' && st.rows.length === 2 &&
    st.rows[0].title === 'Lecture A' && st.rows[0].facultyName === 'ProfA' && st.rows[0].dateText === '01-01-2025' && st.rows[0].hasDownload === true &&
    st.rows[1].title === 'Lecture B' && st.rows[1].facultyName === 'ProfB' && st.rows[1].dateText === '02-02-2025',
    JSON.stringify(st.rows.map((r) => ({ t: r.title, f: r.facultyName, d: r.dateText }))));
  await page.evaluate(() => {
    window.__sclicks = [];
    document.querySelectorAll('table a, table button').forEach((el) => el.addEventListener('click', (e) => { e.preventDefault(); window.__sclicks.push(el.id || 'x'); }));
  });
  const sRes = await send({ type: 'DOWNLOAD_ROWS', keys: [st.rows[0].key] });
  const sClicks = await page.evaluate(() => window.__sclicks);
  check('L3 narrow separate click', sRes.clicked === 1 && sClicks.length === 1 && sClicks[0] === 'sa', `clicked=${sRes.clicked} dom=${JSON.stringify(sClicks)}`);
  // Negatives: attendance (controls + dates, no material-like rows) and grades
  // (no controls/synonyms) must NOT be detected (no false positives).
  send = await contentContext(page, NEGATTENDHTML);
  st = await send({ type: 'GET_STATE' });
  dg = await send({ type: 'DIAGNOSTICS' });
  check('negative attendance not detected', !st.ok && !dg.diag.tableFound, `ok=${st.ok} found=${dg.diag.tableFound} strat=${dg.diag.tableStrategy}`);
  send = await contentContext(page, NEGGRADESHTML);
  st = await send({ type: 'GET_STATE' });
  dg = await send({ type: 'DIAGNOSTICS' });
  check('negative grades not detected', !st.ok && !dg.diag.tableFound, `ok=${st.ok} found=${dg.diag.tableFound}`);
  // --- Iteration 4 placeholder course (REQUIREMENTS B correctness) ---
  // "Select course" selected must NOT be treated as a valid course: ok=false,
  // courseText null, folder falls back, diagnostics reports null course.
  send = await contentContext(page, PLACEHOLDERHTML);
  st = await send({ type: 'GET_STATE' });
  dg = await send({ type: 'DIAGNOSTICS' });
  check('placeholder course rejected', !st.ok && st.courseText === null && /course|dropdown/i.test(st.error || ''),
    `ok=${st.ok} course=${JSON.stringify(st.courseText)} err=${JSON.stringify(st.error)}`);
  check('placeholder diagnostics course null', dg.diag.courseText === null && dg.diag.tableFound === true,
    `course=${JSON.stringify(dg.diag.courseText)} found=${dg.diag.tableFound}`);
  send = await contentContext(page, PLACEHOLDERDASHHTML);
  st = await send({ type: 'GET_STATE' });
  check('placeholder dashes rejected', !st.ok && st.courseText === null, `ok=${st.ok} course=${JSON.stringify(st.courseText)}`);
  send = await contentContext(page, L1HTML);
  st = await send({ type: 'GET_STATE' });
  check('valid course retained', st.ok && st.courseText === 'Fall Semester - X - Y' && st.folderNameSuggestion === 'X - Y',
    `ok=${st.ok} course=${JSON.stringify(st.courseText)} folder=${JSON.stringify(st.folderNameSuggestion)}`);

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
        sanitizeFolderPath('S/C/F'),
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
  check('sanitizeFolderPath', JSON.stringify(bg.paths) === JSON.stringify(['A', 'S/C', 'S/C/F', 'evil', 'a/b/c', 'VIT Downloads']), JSON.stringify(bg.paths));
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
  // --- Iteration 4 sweep cap boundary (REQUIREMENTS J) ---
  // SWEEP_MAX_PAGES=20 means at most 20 pages visited total (1 initial + 19
  // advances). An always-advancing mock must NOT produce a 21st visit.
  const cap = await page.evaluate(({ html, js }) => {
    document.body.innerHTML = '<div id=h></div>';
    document.getElementById('h').innerHTML = html;
    const store = { downloadHistory: {}, folderTemplate: 'course' };
    const mockCap = { ok: true, courseText: 'Fall Semester 2025-26 - ISWE204L - Operating Systems - TH', folderNameSuggestion: 'ISWE204L - Operating Systems', showingInfo: null, rows: [{ key: 'k1', title: 'A', docCount: 1, facultyName: 'F', dateText: '01-01-2025' }] };
    let adv = 0, get = 0;
    window.chrome = {
      tabs: { query: async () => [{ id: 9, url: 'https://vtop.vit.ac.in/vtop/x' }], sendMessage: (id, msg, cb) => {
        if (msg.type === 'GET_STATE') { get++; cb(mockCap); }
        else if (msg.type === 'ADVANCE_PAGE') { adv++; cb({ advanced: true, rowsOnPage: 1 }); }
        else if (msg.type === 'DIAGNOSTICS') cb({ ok: true, diag: { downloadButtons: 0, multiDocRows: 0, log: [] } });
        else cb({ clicked: 0, skipped: 0, ok: true, skippedDetails: [] });
      } },
      scripting: { executeScript: async () => {} },
      runtime: { sendMessage: async () => ({ ok: true }), onMessage: { addListener() {}, removeListener() {} } },
      storage: { local: {
        get: (k, cb) => { const o = {}; (Array.isArray(k) ? k : [k]).forEach((x) => { o[x] = store[x]; }); cb(o); },
        set: (o, cb) => { Object.assign(store, o); cb && cb(); }
      } },
      notifications: { create: () => {} }
    };
    window.eval(js);
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
    return new Promise((res) => setTimeout(async () => {
      try {
        await new Promise((rr) => setTimeout(rr, 1200));
        let a = 0, g = 0;
        const orig = window.chrome.tabs.sendMessage;
        window.chrome.tabs.sendMessage = (id, msg, cb) => {
          if (msg.type === 'ADVANCE_PAGE') a++;
          if (msg.type === 'GET_STATE') g++;
          return orig(id, msg, cb);
        };
        window.confirm = () => true;
        document.getElementById('sweepBtn').click();
        await new Promise((rr) => setTimeout(rr, 6000));
        res({ adv: a, get: g, prog: document.getElementById('progressText').textContent });
      } catch (e) { res({ error: String(e) }); }
    }, 800));
  }, { html, js });
  check('sweep respects 20-page cap', cap.adv <= 19 && (cap.adv + 1) <= 20 && /20 page\(s\) \(cap\)/.test(cap.prog || ''),
    `adv=${cap.adv} get=${cap.get} prog=${JSON.stringify(cap.prog)}`);
  const sz = await page.evaluate(() => window.summarizeSizes([
    { name: 'a.pdf', bytes: 2100000, state: 'complete' },
    { name: 'a.pdf', bytes: 2100000, state: 'complete' },
    { name: 'a.pdf', bytes: 1800000, state: 'complete' },
    { name: 'b.pdf', bytes: -1, state: 'complete' }
  ]));
  check('size report identical vs different vs unknown',
    sz.length === 2 && /identical/.test(sz[0]) && /1\.7 MB|1\.8 MB/.test(sz[0]) && /unknown/i.test(sz[1]), JSON.stringify(sz));

  // --- Iteration 2: folder preview must match sanitized save path (G) ---
  // Background sanitizeFolderPath collapses traversal/illegal chars; the popup
  // preview previously showed the raw input (Downloads/../../evil/). Display-only.
  const pv = await page.evaluate(({ html, js }) => {
    document.body.innerHTML = '<div id=h></div>';
    document.getElementById('h').innerHTML = html;
    const store = { downloadHistory: {}, folderTemplate: 'course' };
    const mockPv = { ok: true, courseText: 'Fall Semester 2025-26 - ISWE204L - Operating Systems - TH', folderNameSuggestion: 'ISWE204L - Operating Systems', showingInfo: null, rows: [] };
    window.chrome = {
      tabs: { query: async () => [{ id: 9, url: 'https://vtop.vit.ac.in/vtop/x' }], sendMessage: (id, msg, cb) => {
        if (msg.type === 'GET_STATE') cb(mockPv);
        else if (msg.type === 'DIAGNOSTICS') cb({ ok: true, diag: { downloadButtons: 0, multiDocRows: 0, log: [] } });
        else cb({ clicked: 0, skipped: 0, ok: true, skippedDetails: [] });
      } },
      scripting: { executeScript: async () => {} },
      runtime: { sendMessage: async () => ({ ok: true }), onMessage: { addListener() {}, removeListener() {} } },
      storage: { local: {
        get: (k, cb) => { const o = {}; (Array.isArray(k) ? k : [k]).forEach((x) => { o[x] = store[x]; }); cb(o); },
        set: (o, cb) => { Object.assign(store, o); cb && cb(); }
      } },
      notifications: { create: () => {} }
    };
    window.eval(js);
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
    return new Promise((res) => setTimeout(() => {
      try {
        const prev = () => document.getElementById('folderPreview').textContent;
        document.getElementById('folderTemplate').value = 'course';
        document.getElementById('folderTemplate').dispatchEvent(new Event('change'));
        document.getElementById('folderName').value = '../../evil';
        document.getElementById('folderName').dispatchEvent(new Event('input'));
        const trav = prev();
        document.getElementById('folderName').value = 'A:B?C';
        document.getElementById('folderName').dispatchEvent(new Event('input'));
        const ill = prev();
        document.getElementById('folderTemplate').value = 'semester-course';
        document.getElementById('folderTemplate').dispatchEvent(new Event('change'));
        document.getElementById('folderName').value = 'ISWE204L - Operating Systems';
        document.getElementById('folderName').dispatchEvent(new Event('input'));
        const sem = prev();
        // v1.9.0: Semester/Course/Faculty with nothing selected shows the
        // base path plus the per-faculty note (one subfolder per faculty).
        document.getElementById('folderTemplate').value = 'semester-course-faculty';
        document.getElementById('folderTemplate').dispatchEvent(new Event('change'));
        document.getElementById('folderName').value = 'ISWE204L - Operating Systems';
        document.getElementById('folderName').dispatchEvent(new Event('input'));
        const fac = prev();
        res({ trav, ill, sem, fac, fn: typeof window.sanitizeFolderPath });
      } catch (e) { res({ error: String(e) }); }
    }, 1200));
  }, { html, js });
  check('folder preview traversal sanitized', pv.trav === 'Files will save to Downloads/evil/', JSON.stringify(pv.trav));
  check('folder preview illegal chars sanitized', pv.ill === 'Files will save to Downloads/A-B-C/', JSON.stringify(pv.ill));
  check('folder preview normal path accurate', pv.sem === 'Files will save to Downloads/Fall Semester 2025-26/ISWE204L - Operating Systems/', JSON.stringify(pv.sem));
  check('folder preview faculty split note', pv.fac === 'Files will save to Downloads/Fall Semester 2025-26/ISWE204L - Operating Systems/ — one subfolder per faculty.', JSON.stringify(pv.fac));

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

  // --- Phase A3: queue controls (pause / resume / cancel / retry / safe-mode) ---
  // Fresh popup harness with delayed DOWNLOAD_ROWS + per-key fail map.
  // Fresh popup harness with delayed DOWNLOAD_ROWS + per-key fail map.
  const queueMock = {
    ok: true, courseText: 'Fall Semester 2025-26 - ISWE204L - Operating Systems - TH',
    folderNameSuggestion: 'ISWE204L - Operating Systems', showingInfo: null,
    rows: [
      { key: 'q1', title: 'Alpha', docCount: 1, facultyName: 'F', dateText: '01-01-2025' },
      { key: 'q2', title: 'Beta', docCount: 1, facultyName: 'F', dateText: '02-01-2025' },
      { key: 'q3', title: 'Gamma', docCount: 1, facultyName: 'F', dateText: '03-01-2025' }
    ]
  };
  const pc = await page.evaluate(({ html, js, mockState }) => {
    document.body.innerHTML = '<div id=h></div>';
    document.getElementById('h').innerHTML = html;
    const store = { downloadHistory: {}, folderTemplate: 'course' };
    window.__calls = [];
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    window.chrome = {
      tabs: { query: async () => [{ id: 7, url: 'https://vtop.vit.ac.in/vtop/x' }], sendMessage: (id, msg, cb) => {
        if (msg.type === 'GET_STATE') cb(mockState);
        else if (msg.type === 'DIAGNOSTICS') cb({ ok: true, diag: { downloadButtons: 3, multiDocRows: 0, log: [] } });
        else {
          const k = msg.keys[0];
          window.__calls.push(k);
          delay(700).then(() => {
            if (window.__fail && window.__fail[k]) cb({ clicked: 0, skipped: 0, ok: false, skippedDetails: [] });
            else cb({ clicked: 1, skipped: 0, ok: true, skippedDetails: [] });
          });
        }
      } },
      scripting: { executeScript: async () => {} },
      runtime: { sendMessage: async (m) => ({ ok: true, folder: 'F', jobId: 'jq' }), onMessage: { addListener() {}, removeListener() {} } },
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
        const prog = () => document.getElementById('progressText').textContent;
        // select all 3, start run 1
        document.querySelectorAll('.material-row input[type=checkbox]').forEach((cb) => { cb.checked = true; cb.dispatchEvent(new Event('change')); });
        document.getElementById('downloadBtn').click();
        await new Promise((r) => setTimeout(r, 300));
        document.getElementById('previewStartBtn').click();
        await new Promise((r) => setTimeout(r, 1200));
        document.getElementById('pauseBtn').click(); // pause mid-queue
        await new Promise((r) => setTimeout(r, 300));
        const p1 = prog();
        await new Promise((r) => setTimeout(r, 1200));
        const p2 = prog();
        o.pausedFrozen = p1 === p2 && /Paused/.test(p1);
        o.callsAtPause = window.__calls.length;
        document.getElementById('pauseBtn').click(); // resume
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 500));
          if (/^Done|^Stopped/.test(prog())) break;
        }
        o.run1 = prog();
        o.run1Calls = window.__calls.length;
        // run 2: cancel mid-queue (skip box off so history does not swallow)
        document.getElementById('skipExistingBox').checked = false;
        document.getElementById('skipExistingBox').dispatchEvent(new Event('change'));
        document.getElementById('downloadBtn').click();
        await new Promise((r) => setTimeout(r, 300));
        document.getElementById('previewStartBtn').click();
        await new Promise((r) => setTimeout(r, 900));
        document.getElementById('cancelBtn').click();
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 500));
          if (/^Done|^Stopped/.test(prog())) break;
        }
        o.run2 = prog();
        o.skips = document.getElementById('skipList').innerText.slice(0, 300);
        res(o);
      } catch (e) { res({ error: String(e) }); }
    }, 1000));
  }, { html, js, mockState: queueMock });
  check('pause freezes queue', pc.pausedFrozen === true && pc.callsAtPause <= 2, JSON.stringify({ frozen: pc.pausedFrozen, calls: pc.callsAtPause }));
  check('resume completes run', /^Done/.test(pc.run1 || '') && pc.run1Calls === 3, JSON.stringify({ run1: pc.run1, calls: pc.run1Calls }));
  check('cancel stops run + marks canceled', /^Stopped/.test(pc.run2 || '') && /canceled by you/.test(pc.skips || ''), JSON.stringify({ run2: pc.run2, skips: pc.skips }));

  // --- Phase 2 UX: search, button states, row statuses, preview upgrade ---
  // NOTE: this block runs its own queue AFTER the pause/cancel block on
  // purpose. Sequential popup harnesses share one page; a completed run
  // here perturbs the pause test's timing (deterministic fail), so the
  // pause test keeps the earlier slot. Real popups open fresh each time.
  const uxMock = {
    ok: true, courseText: 'Fall Semester 2025-26 - ISWE204L - Operating Systems - TH',
    folderNameSuggestion: 'ISWE204L - Operating Systems', showingInfo: null,
    rows: [
      { key: 'u1', title: 'Alpha Notes', docCount: 1, facultyName: 'SIVA', dateText: '16-11-2025' },
      { key: 'u2', title: 'Beta Slides', docCount: 2, facultyName: 'BALA', dateText: '06-11-2025', dupIndex: 1, dupTotal: 2 },
      { key: 'a"b||c d', title: 'Quoted', docCount: 1, facultyName: 'SIVA', dateText: '16-11-2025' }
    ]
  };
  const ux = await page.evaluate(({ html, js, mockState }) => {
    document.body.innerHTML = '<div id=h></div>';
    document.getElementById('h').innerHTML = html;
    const store = { downloadHistory: {}, folderTemplate: 'course' };
    window.__msg = null;
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    window.chrome = {
      tabs: { query: async () => [{ id: 9, url: 'https://vtop.vit.ac.in/vtop/x' }], sendMessage: (id, msg, cb) => {
        if (msg.type === 'GET_STATE') cb(mockState);
        else if (msg.type === 'GET_COURSE') cb({ ok: true, courseText: mockState.courseText });
        else if (msg.type === 'DIAGNOSTICS') cb({ ok: true, diag: { downloadButtons: 3, multiDocRows: 0, log: [] } });
        else delay(1200).then(() => cb({ clicked: 1, skipped: 0, ok: true, skippedDetails: [] }));
      } },
      scripting: { executeScript: async () => {} },
      runtime: { sendMessage: async (m) => ({ ok: true, folder: 'F', jobId: 'ju' }),
        onMessage: { addListener(fn) { window.__msg = fn; }, removeListener() {} } },
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
        const visible = () => Array.from(document.querySelectorAll('.material-row'))
          .filter((e) => e.style.display !== 'none').length;
        o.rowsTotal = document.querySelectorAll('.material-row').length;
        // search narrows to matching title/faculty
        document.getElementById('searchBox').value = 'beta';
        document.getElementById('searchBox').dispatchEvent(new Event('input'));
        o.searchBeta = visible();
        document.getElementById('searchBox').value = 'siva';
        document.getElementById('searchBox').dispatchEvent(new Event('input'));
        o.searchSiva = visible();
        document.getElementById('searchBox').value = '';
        document.getElementById('searchBox').dispatchEvent(new Event('input'));
        o.searchCleared = visible();
        // button disabled with nothing selected
        o.disabledEmpty = document.getElementById('downloadBtn').disabled;
        o.hintEmpty = document.getElementById('selectHint').textContent;
        // setRowStatus incl. hostile key (no throw, exact match)
        window.setRowStatus('u1', 'done');
        window.setRowStatus('a"b||c d', 'active');
        o.statusDone = document.querySelector('.material-row.st-done') !== null;
        o.statusNasty = (() => {
          const labs = Array.from(document.querySelectorAll('.material-row'));
          const hit = labs.filter((e) => e.classList.contains('st-active'));
          return hit.length === 1;
        })();
        window.clearRowStatus();
        o.statusCleared = document.querySelectorAll('.st-done,.st-active').length === 0;
        // preview upgrade: select dup + normal, open preview
        const boxes = document.querySelectorAll('.material-row input[type=checkbox]');
        boxes[0].checked = true; boxes[0].dispatchEvent(new Event('change'));
        boxes[1].checked = true; boxes[1].dispatchEvent(new Event('change'));
        document.getElementById('downloadBtn').click();
        await new Promise((r) => setTimeout(r, 300));
        o.previewOpen = !document.getElementById('previewOverlay').classList.contains('hidden');
        o.previewFiles = document.querySelectorAll('#previewFiles li').length;
        o.previewCollision = document.querySelectorAll('#previewFiles li.collision').length;
        o.previewFolders = document.getElementById('previewFolders').innerText;
        document.getElementById('previewCancelBtn').click();
        // live status via captured progress listener mid-run (poll for
        // registration: the staleness round-trip precedes it)
        document.getElementById('downloadBtn').click();
        await new Promise((r) => setTimeout(r, 300));
        document.getElementById('previewStartBtn').click();
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 250));
          if (typeof window.__msg === 'function') break;
        }
        window.__msg({ type: 'DOWNLOAD_PROGRESS', progress: { key: 'u2', current: 'Beta', skipped: true } });
        o.failMarked = document.querySelectorAll('.material-row.st-fail').length === 1;
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 500));
          if (/^Done|^Stopped/.test(document.getElementById('progressText').textContent)) break;
        }
        o.runDone = document.getElementById('progressText').textContent.slice(0, 40);
        res(o);
      } catch (e) { res({ error: String(e) }); }
    }, 1000));
  }, { html, js, mockState: uxMock });
  check('search narrows rows', ux.rowsTotal === 3 && ux.searchBeta === 1 && ux.searchSiva === 2 && ux.searchCleared === 3,
    JSON.stringify({ total: ux.rowsTotal, beta: ux.searchBeta, siva: ux.searchSiva, cleared: ux.searchCleared }));
  check('download disabled when empty', ux.disabledEmpty === true && /Tick materials/.test(ux.hintEmpty || ''),
    JSON.stringify({ dis: ux.disabledEmpty, hint: ux.hintEmpty }));
  check('row status markers incl hostile key', ux.statusDone && ux.statusNasty && ux.statusCleared,
    JSON.stringify({ done: ux.statusDone, nasty: ux.statusNasty, cleared: ux.statusCleared }));
  check('preview upgrade lists', ux.previewOpen && ux.previewFiles === 2 && ux.previewCollision === 1 && /2 files/.test(ux.previewFolders || ''),
    JSON.stringify({ open: ux.previewOpen, files: ux.previewFiles, coll: ux.previewCollision, folders: ux.previewFolders }));
  check('live fail status via progress', ux.failMarked === true && /^Done/.test(ux.runDone || ''),
    JSON.stringify({ fail: ux.failMarked, run: ux.runDone }));


  // Retry-skipped + safe-mode attempt counts (2 normal, 3 safe).
  const rt = await page.evaluate(({ html, js, mockState }) => {
    document.body.innerHTML = '<div id=h></div>';
    document.getElementById('h').innerHTML = html;
    const store = { downloadHistory: {}, folderTemplate: 'course' };
    window.__calls = [];
    window.__fail = { q2: true };
    window.chrome = {
      tabs: { query: async () => [{ id: 7, url: 'https://vtop.vit.ac.in/vtop/x' }], sendMessage: (id, msg, cb) => {
        if (msg.type === 'GET_STATE') cb(mockState);
        else if (msg.type === 'GET_COURSE') cb({ ok: true, courseText: mockState.courseText });
        else if (msg.type === 'DIAGNOSTICS') cb({ ok: true, diag: { downloadButtons: 3, multiDocRows: 0, log: [] } });
        else { window.__calls.push(msg.keys[0]); cb({ clicked: 0, skipped: 0, ok: false, skippedDetails: [] }); }
      } },
      scripting: { executeScript: async () => {} },
      runtime: { sendMessage: async (m) => ({ ok: true, folder: 'F', jobId: 'jr' }), onMessage: { addListener() {}, removeListener() {} } },
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
        const prog = () => document.getElementById('progressText').textContent;
        const waitDone = async () => {
          for (let i = 0; i < 40; i++) {
            await new Promise((r) => setTimeout(r, 500));
            if (/^Done|^Stopped/.test(prog())) break;
          }
        };
        const boxes = document.querySelectorAll('.material-row input[type=checkbox]');
        boxes[1].checked = true; boxes[1].dispatchEvent(new Event('change'));
        document.getElementById('downloadBtn').click();
        await new Promise((r) => setTimeout(r, 300));
        document.getElementById('previewStartBtn').click();
        await waitDone();
        o.afterFirst = window.__calls.length; // normal mode: 2 attempts
        o.retryVisible = !document.getElementById('retrySkippedBtn').classList.contains('hidden');
        document.getElementById('retrySkippedBtn').click(); // retry still failing
        await waitDone();
        o.afterRetry = window.__calls.length; // +2
        document.getElementById('safeModeBox').checked = true;
        document.getElementById('safeModeBox').dispatchEvent(new Event('change'));
        document.getElementById('downloadBtn').click();
        await new Promise((r) => setTimeout(r, 300));
        document.getElementById('previewStartBtn').click();
        await waitDone();
        o.afterSafe = window.__calls.length; // +3
        res(o);
      } catch (e) { res({ error: String(e) }); }
    }, 1000));
  }, { html, js, mockState: queueMock });
  check('normal mode retries twice', rt.afterFirst === 2, `calls=${rt.afterFirst}`);
  check('retry-skipped offered + reruns', rt.retryVisible === true && rt.afterRetry === 4, JSON.stringify({ vis: rt.retryVisible, calls: rt.afterRetry }));
  check('safe mode retries thrice', rt.afterSafe === 7, `calls=${rt.afterSafe}`);

  // --- XSS: hostile material title must render inert, text preserved ---
  // Entity-encoded markup arrives as literal text in innerText (first line
  // becomes the title) — rendering must escape it, creating no elements.
  send = await contentContext(page, `<select><option>Fall Semester - X - Y</option></select>
    <table><thead><tr><th>Course Detail</th><th>Material Detail</th><th>Uploaded By</th><th>Download</th></tr></thead>
    <tbody><tr><td>C</td><td>&lt;img src=x onerror="window.__pwned=1"&gt;<br>1 (Document)</td><td>C - F - 01-01-2025</td><td><a href="#" id="x1">D</a></td></tr></tbody></table>`);
  st = await send({ type: 'GET_STATE' });
  const hostileRow = st.rows[0];
  const xss = await page.evaluate(({ html, js, row }) => {
    document.body.innerHTML = '<div id=h></div>';
    document.getElementById('h').innerHTML = html;
    const store = { downloadHistory: {}, folderTemplate: 'course' };
    const mockX = { ok: true, courseText: 'C', folderNameSuggestion: 'C', showingInfo: null, rows: [row] };
    window.chrome = {
      tabs: { query: async () => [{ id: 7, url: 'https://vtop.vit.ac.in/vtop/x' }], sendMessage: (id, msg, cb) => {
        if (msg.type === 'GET_STATE') cb(mockX);
        else cb({ clicked: 0, skipped: 0, ok: true, skippedDetails: [] });
      } },
      scripting: { executeScript: async () => {} },
      runtime: { sendMessage: async () => ({ ok: true }), onMessage: { addListener() {}, removeListener() {} } },
      storage: { local: {
        get: (k, cb) => { const o = {}; (Array.isArray(k) ? k : [k]).forEach((x) => { o[x] = store[x]; }); cb(o); },
        set: (o, cb) => { Object.assign(store, o); cb && cb(); }
      } },
      notifications: { create: () => {} }
    };
    window.eval(js);
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
    return new Promise((res) => setTimeout(() => {
      res({
        imgs: document.querySelectorAll('#materialsList img').length,
        scripts: document.querySelectorAll('#materialsList script').length,
        titleText: (document.querySelector('#materialsList .title') || { textContent: '' }).textContent.slice(0, 60)
      });
    }, 1200));
  }, { html, js, row: hostileRow });
  check('hostile title renders inert', xss.imgs === 0 && xss.scripts === 0 && /<img/.test(xss.titleText), JSON.stringify(xss));

  // --- Stability: perpetually churning table still resolves (bounded wait) ---
  send = await contentContext(page, `<select><option>Fall Semester - X - Y</option></select>
    <div>Show <select id="len"><option value="10">10</option><option value="100">100</option></select> entries
    <input type="search">
    <table><thead><tr><th>Course Detail</th><th>Material Detail</th><th>Uploaded By</th><th>Download</th></tr></thead>
    <tbody id="tb"><tr><td>C</td><td>T1<br>1 (Document)</td><td>C - F - 01-01-2025</td><td><a href=#>D</a></td></tr></tbody></table>
    <div id="info">Showing 1 to 1 of 1 entries</div></div>`);
  await page.evaluate(() => {
    let n = 0;
    document.getElementById('len').addEventListener('change', () => {
      window.__churn = setInterval(() => {
        n++;
        document.getElementById('tb').innerHTML =
          `<tr><td>C</td><td>T1-v${n}<br>1 (Document)</td><td>C - F - 01-01-2025</td><td><a href=#>D</a></td></tr>`;
      }, 250);
    });
  });
  const t0 = Date.now();
  st = await send({ type: 'GET_STATE' });
  const elapsed = Date.now() - t0;
  await page.evaluate(() => clearInterval(window.__churn));
  check('churning table resolves bounded', st.rows.length === 1 && elapsed < 25000, `rows=${st.rows.length} elapsed=${elapsed}ms`);

  // --- Phase 3 UX: presets, faculty chips, repeated-title forecast ---
  const dmy = (daysAgo) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
  };
  const p3Mock = {
    ok: true, courseText: 'C', folderNameSuggestion: 'C', showingInfo: null,
    rows: [
      { key: 'p1', title: 'Fresh', docCount: 1, facultyName: 'SIVA', dateText: dmy(0) },
      { key: 'p2', title: 'Oldie', docCount: 1, facultyName: 'SIVA', dateText: dmy(10) },
      { key: 'p3', title: 'Undated', docCount: 1, facultyName: 'BALA', dateText: null },
      { key: 'p4', title: 'Dupe', docCount: 1, facultyName: 'BALA', dateText: dmy(40), dupIndex: 1, dupTotal: 2 },
      { key: 'p5', title: 'Dupe', docCount: 1, facultyName: 'BALA', dateText: dmy(40), dupIndex: 2, dupTotal: 2 }
    ]
  };
  const p3 = await page.evaluate(({ html, js, mockState }) => {
    document.body.innerHTML = '<div id=h></div>';
    document.getElementById('h').innerHTML = html;
    const store = { downloadHistory: {}, folderTemplate: 'course' };
    window.chrome = {
      tabs: { query: async () => [{ id: 9, url: 'https://vtop.vit.ac.in/vtop/x' }], sendMessage: (id, msg, cb) => {
        if (msg.type === 'GET_STATE') cb(mockState);
        else cb({ clicked: 0, skipped: 0, ok: true, skippedDetails: [] });
      } },
      scripting: { executeScript: async () => {} },
      runtime: { sendMessage: async () => ({ ok: true }), onMessage: { addListener() {}, removeListener() {} } },
      storage: { local: {
        get: (k, cb) => { const o = {}; (Array.isArray(k) ? k : [k]).forEach((x) => { o[x] = store[x]; }); cb(o); },
        set: (o, cb) => { Object.assign(store, o); cb && cb(); }
      } },
      notifications: { create: () => {} }
    };
    window.eval(js);
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
    return new Promise((res) => setTimeout(() => {
      const o = {};
      try {
        const visible = () => Array.from(document.querySelectorAll('.material-row'))
          .filter((e) => e.style.display !== 'none').length;
        const selCount = () => document.getElementById('downloadBtn').textContent;
        o.chips = Array.from(document.querySelectorAll('#facultyChips .chip')).map((c) => c.textContent);
        // chip filters to SIVA only
        Array.from(document.querySelectorAll('#facultyChips .chip'))
          .find((c) => c.textContent.startsWith('SIVA')).click();
        o.afterChip = { visible: visible(), filter: document.getElementById('facultyFilter').value };
        // back to All, then presets
        Array.from(document.querySelectorAll('#facultyChips .chip'))[0].click();
        document.getElementById('presetWeekBtn').click();
        o.week = selCount();
        document.getElementById('presetMonthBtn').click();
        o.month = selCount();
        document.getElementById('invertBtn').click();
        o.inverted = selCount();
        o.repeated = document.getElementById('matchCount').textContent;
        // reset restores All + clears search
        document.getElementById('searchBox').value = 'zzz';
        document.getElementById('searchBox').dispatchEvent(new Event('input'));
        document.getElementById('resetFiltersBtn').click();
        o.afterReset = { visible: visible(), filter: document.getElementById('facultyFilter').value,
          search: document.getElementById('searchBox').value };
        res(o);
      } catch (e) { res({ error: String(e) }); }
    }, 1200));
  }, { html, js, mockState: p3Mock });
  check('faculty chips filter', JSON.stringify(p3.chips) === JSON.stringify(['All', 'BALA · 3', 'SIVA · 2']) &&
    p3.afterChip.visible === 2 && p3.afterChip.filter === 'SIVA', JSON.stringify({ chips: p3.chips, after: p3.afterChip }));
  check('date presets select recent', p3.week === 'Download selected (1)' && p3.month === 'Download selected (2)',
    JSON.stringify({ week: p3.week, month: p3.month }));
  check('invert flips visible', p3.inverted === 'Download selected (3)', JSON.stringify({ inv: p3.inverted }));
  check('repeated-title forecast', /1 repeated title[^s]/.test(p3.repeated) || /1 repeated title$/.test(p3.repeated), JSON.stringify(p3.repeated));
  check('reset restores chips+search', p3.afterReset.visible === 5 && p3.afterReset.filter === '__ALL__' && p3.afterReset.search === '',
    JSON.stringify(p3.afterReset));

  // --- Phase 4 UX: coach tour, empty-filter note, diagnostics copy ---
  const p4Mock = {
    ok: true, courseText: 'C', folderNameSuggestion: 'C', showingInfo: null,
    rows: [{ key: 'c1', title: 'Only One', docCount: 1, facultyName: 'F', dateText: '01-01-2025' }]
  };
  const p4 = await page.evaluate(({ html, js, mockState }) => {
    document.body.innerHTML = '<div id=h></div>';
    document.getElementById('h').innerHTML = html;
    const store = { downloadHistory: {}, folderTemplate: 'course' };
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } },
      configurable: true
    });
    window.chrome = {
      tabs: { query: async () => [{ id: 9, url: 'https://vtop.vit.ac.in/vtop/x' }], sendMessage: (id, msg, cb) => {
        if (msg.type === 'GET_STATE') cb(mockState);
        else if (msg.type === 'DIAGNOSTICS') cb({ ok: true, diag: { downloadButtons: 1, multiDocRows: 0, log: [{ strategy: 's', detail: 'd' }] } });
        else cb({ clicked: 0, skipped: 0, ok: true, skippedDetails: [] });
      } },
      scripting: { executeScript: async () => {} },
      runtime: { getManifest: () => ({ version: '9.9.9' }),
        sendMessage: async () => ({ ok: true }), onMessage: { addListener() {}, removeListener() {} } },
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
        o.coachFirstRun = !document.getElementById('coachOverlay').classList.contains('hidden');
        document.getElementById('coachDoneBtn').click();
        await new Promise((r) => setTimeout(r, 200));
        o.coachDismissed = document.getElementById('coachOverlay').classList.contains('hidden');
        o.coachStored = store.coachSeen === true;
        // empty-filter note
        document.getElementById('searchBox').value = 'zzz-no-match';
        document.getElementById('searchBox').dispatchEvent(new Event('input'));
        o.emptyNote = document.querySelector('#materialsList .empty-note').textContent.slice(0, 40);
        document.getElementById('searchBox').value = '';
        document.getElementById('searchBox').dispatchEvent(new Event('input'));
        // diagnostics copy + tour replay
        document.getElementById('diagBtn').click();
        await new Promise((r) => setTimeout(r, 800));
        document.getElementById('diagCopyBtn').click();
        await new Promise((r) => setTimeout(r, 300));
        o.copyBtn = document.getElementById('diagCopyBtn').textContent;
        o.copiedHasCourse = /"course": "C"/.test(window.__copied || '');
        document.getElementById('diagTourBtn').click();
        o.tourReplay = !document.getElementById('coachOverlay').classList.contains('hidden');
        // dismiss, then Refresh must NOT resurrect the tour mid-session
        document.getElementById('coachDoneBtn').click();
        document.getElementById('refreshBtn').click();
        await new Promise((r) => setTimeout(r, 800));
        o.noResurrect = document.getElementById('coachOverlay').classList.contains('hidden');
        // preview Filters line reflects the search term
        document.getElementById('searchBox').value = 'only';
        document.getElementById('searchBox').dispatchEvent(new Event('input'));
        document.querySelector('.material-row input[type=checkbox]').click();
        document.getElementById('downloadBtn').click();
        await new Promise((r) => setTimeout(r, 300));
        o.previewFilters = document.getElementById('previewFilters').textContent;
        res(o);
      } catch (e) { res({ error: String(e) }); }
    }, 1200));
  }, { html, js, mockState: p4Mock });
  check('coach first-run + persist', p4.coachFirstRun === true && p4.coachDismissed === true && p4.coachStored === true,
    JSON.stringify({ first: p4.coachFirstRun, gone: p4.coachDismissed, stored: p4.coachStored }));
  check('empty-filter note', /No materials match/.test(p4.emptyNote || ''), JSON.stringify(p4.emptyNote));
  check('diagnostics copy report', p4.copyBtn === 'Copied ✓' && p4.copiedHasCourse === true,
    JSON.stringify({ btn: p4.copyBtn, course: p4.copiedHasCourse }));
  check('tour replay from diagnostics', p4.tourReplay === true, JSON.stringify(p4.tourReplay));
  check('tour not resurrected by refresh', p4.noResurrect === true, JSON.stringify(p4.noResurrect));
  check('preview filters show search', /only/.test(p4.previewFilters || ''), JSON.stringify(p4.previewFilters));

  // --- Staleness guards: GET_COURSE, changed-course abort, miss abort, load race ---
  send = await contentContext(page, L1HTML);
  const courseResp = await send({ type: 'GET_COURSE' });
  check('GET_COURSE light read', courseResp.ok === true && courseResp.courseText === 'Fall Semester - X - Y',
    JSON.stringify(courseResp));

  const staleMock = {
    ok: true, courseText: 'Course A - TH', folderNameSuggestion: 'A', showingInfo: null,
    rows: [
      { key: 's1', title: 'One', docCount: 1, facultyName: 'F', dateText: '01-01-2025' },
      { key: 's2', title: 'Two', docCount: 1, facultyName: 'F', dateText: '02-01-2025' },
      { key: 's3', title: 'Three', docCount: 1, facultyName: 'F', dateText: '03-01-2025' },
      { key: 's4', title: 'Four', docCount: 1, facultyName: 'F', dateText: '04-01-2025' },
      { key: 's5', title: 'Five', docCount: 1, facultyName: 'F', dateText: '05-01-2025' }
    ]
  };
  const st6 = await page.evaluate(({ html, js, mockState }) => {
    document.body.innerHTML = '<div id=h></div>';
    document.getElementById('h').innerHTML = html;
    const store = { downloadHistory: {}, folderTemplate: 'course' };
    window.__gets = 0;
    window.__dls = 0;
    window.__liveCourse = 'Course A - TH';
    window.chrome = {
      tabs: { query: async () => [{ id: 9, url: 'https://vtop.vit.ac.in/vtop/x' }], sendMessage: (id, msg, cb) => {
        if (msg.type === 'GET_STATE') { window.__gets++; cb(mockState); }
        else if (msg.type === 'GET_COURSE') cb({ ok: true, courseText: window.__liveCourse });
        else if (msg.type === 'DIAGNOSTICS') cb({ ok: true, diag: { downloadButtons: 5, multiDocRows: 0, log: [] } });
        else { window.__dls++; cb({ clicked: 0, skipped: 1, ok: true, skippedDetails: [{ key: msg.keys[0], title: 'T', reason: 'not-on-page' }] }); }
      } },
      scripting: { executeScript: async () => {} },
      runtime: { sendMessage: async () => ({ ok: true, folder: 'F', jobId: 'js' }),
        onMessage: { addListener() {}, removeListener() {} } },
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
        const prog = () => document.getElementById('progressText').textContent;
        const waitEnd = async () => {
          for (let i = 0; i < 40; i++) {
            await new Promise((r) => setTimeout(r, 500));
            if (/^Done|^Stopped|changed since/.test(prog())) break;
          }
        };
        // load race: two rapid refreshes collapse into one rescan
        window.__gets = 0;
        document.getElementById('refreshBtn').click();
        document.getElementById('refreshBtn').click();
        await new Promise((r) => setTimeout(r, 2500));
        o.getsAfterDoubleRefresh = window.__gets;
        // changed course aborts before firing anything
        window.__liveCourse = 'Course B - TH';
        document.querySelector('.material-row input[type=checkbox]').click();
        document.getElementById('downloadBtn').click();
        await new Promise((r) => setTimeout(r, 300));
        document.getElementById('previewStartBtn').click();
        await waitEnd();
        o.changedMsg = prog();
        o.changedSends = window.__dls;
        // same course, all missing: stops after 3, rest reported
        window.__liveCourse = 'Course A - TH';
        document.getElementById('selectAllBtn').click();
        document.getElementById('downloadBtn').click();
        await new Promise((r) => setTimeout(r, 300));
        document.getElementById('previewStartBtn').click();
        await waitEnd();
        o.abortMsg = prog();
        o.abortSends = window.__dls;
        o.abortSkips = document.getElementById('skipList').innerText;
        res(o);
      } catch (e) { res({ error: String(e) }); }
    }, 1200));
  }, { html, js, mockState: staleMock });
  check('double refresh single rescan', st6.getsAfterDoubleRefresh === 1, `gets=${st6.getsAfterDoubleRefresh}`);
  check('changed course aborts batch', /changed since/.test(st6.changedMsg || '') && st6.changedSends === 0,
    JSON.stringify({ msg: (st6.changedMsg || '').slice(0, 80), sends: st6.changedSends }));
  check('leading misses abort early', /^Stopped early/.test(st6.abortMsg || '') && st6.abortSends === 3 &&
    (st6.abortSkips.match(/not on the currently displayed/g) || []).length >= 5,
    JSON.stringify({ msg: (st6.abortMsg || '').slice(0, 60), sends: st6.abortSends }));

  // wireEvents idempotency: repeated DOMContentLoaded must not double-wire
  // buttons (one user click = one run, even if the script executed twice).
  const dw = await page.evaluate(({ html, js, mockState }) => {
    document.body.innerHTML = '<div id=h></div>';
    document.getElementById('h').innerHTML = html;
    const store = { downloadHistory: {}, folderTemplate: 'course' };
    window.__calls = [];
    window.chrome = {
      tabs: { query: async () => [{ id: 9, url: 'https://vtop.vit.ac.in/vtop/x' }], sendMessage: (id, msg, cb) => {
        if (msg.type === 'GET_STATE') cb(mockState);
        else if (msg.type === 'GET_COURSE') cb({ ok: true, courseText: mockState.courseText });
        else if (msg.type === 'DIAGNOSTICS') cb({ ok: true, diag: { downloadButtons: 1, multiDocRows: 0, log: [] } });
        else { window.__calls.push(1); cb({ clicked: 0, skipped: 0, ok: false, skippedDetails: [] }); }
      } },
      scripting: { executeScript: async () => {} },
      runtime: { sendMessage: async () => ({ ok: true, folder: 'F', jobId: 'jd' }),
        onMessage: { addListener() {}, removeListener() {} } },
      storage: { local: {
        get: (k, cb) => { const o = {}; (Array.isArray(k) ? k : [k]).forEach((x) => { o[x] = store[x]; }); cb(o); },
        set: (o, cb) => { Object.assign(store, o); cb && cb(); }
      } },
      notifications: { create: () => {} }
    };
    window.eval(js);
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
    return new Promise((res) => setTimeout(async () => {
      const o = {};
      try {
        document.querySelector('.material-row input[type=checkbox]').click();
        document.getElementById('downloadBtn').click();
        await new Promise((r) => setTimeout(r, 300));
        document.getElementById('previewStartBtn').click();
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 500));
          if (/^Done|^Stopped/.test(document.getElementById('progressText').textContent)) break;
        }
        o.calls = window.__calls.length;
        res(o);
      } catch (e) { res({ error: String(e) }); }
    }, 1200));
  }, { html, js, mockState: queueMock });
  check('triple DCL still single run', dw.calls === 2, `calls=${dw.calls}`);

  check('zero page errors', errs.length === 0, JSON.stringify(errs).slice(0, 200));
  console.log(`\nTOTAL pass=${pass} fail=${fail}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
