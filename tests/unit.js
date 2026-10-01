// VIT Bulk Material Downloader — unit tests (no browser).
//
// Loads the REAL popup.js + background.js in a vm sandbox with DOM/chrome
// stubs and exercises the pure functions. Browser-DOM behavior lives in
// tests/regression.js; message/download handlers in tests/handlers.js.
//
// Run: `node tests/unit.js` (exit 0 = all pass, 1 = failure).

const fs = require("fs");
const vm = require("vm");

const EXT_DIR = __dirname + "/..";

function stubEl() {
  return {
    value: "", textContent: "", innerHTML: "",
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, appendChild() {}, click() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    style: {}, disabled: false,
  };
}

function loadPopup() {
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    document: {
      getElementById: () => stubEl(), createElement: () => stubEl(),
      addEventListener() {}, querySelectorAll: () => [],
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(`${EXT_DIR}/popup.js`, "utf8"), sandbox, { filename: "popup.js" });
  return sandbox;
}

function loadBackground() {
  const sandbox = {
    console, crypto: require("crypto"),
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      tabs: { onCreated: { addListener() {} } },
      storage: { local: { get: (k, cb) => cb({}), set: (o, cb) => cb && cb() } },
      downloads: { onCreated: { addListener() {} }, onDeterminingFilename: { addListener() {} } },
    },
  };
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

const pop = loadPopup();
const bg = loadBackground();

// --- sanitizeFolderPath: 3 levels, caps, traversal (both files agree) ---
check("popup sanitize 3-level kept", pop.sanitizeFolderPath("S/C/F"), "S/C/F");
check("popup sanitize caps at 3", pop.sanitizeFolderPath("a/b/c/d"), "a/b/c");
check("popup sanitize traversal blocked", pop.sanitizeFolderPath("S/C/../../evil"), "S/C/evil");
check("popup sanitize 2-level unchanged", pop.sanitizeFolderPath("S/C"), "S/C");
check("popup sanitize empty unchanged", pop.sanitizeFolderPath(""), "VIT Downloads");
check("popup sanitize illegal chars", pop.sanitizeFolderPath("A:B?C"), "A-B-C");
check("background sanitize 3-level kept", bg.sanitizeFolderPath("S/C/F"), "S/C/F");
check("background sanitize caps at 3", bg.sanitizeFolderPath("a/b/c/d"), "a/b/c");
check("background sanitize 2-level unchanged", bg.sanitizeFolderPath("S/C"), "S/C");
check("background sanitize traversal unchanged", bg.sanitizeFolderPath("../../evil"), "evil");

// --- resolveFolderPath: all three templates ---
vm.runInContext(`folderTemplate = "course";`, pop);
check("resolve course", pop.resolveFolderPath("MyCourse", "Sem - C - X"), "MyCourse");
vm.runInContext(`folderTemplate = "semester-course";`, pop);
check("resolve semester-course", pop.resolveFolderPath("MyCourse", "Sem - C - X"), "Sem/MyCourse");
check("resolve semester-course sem==base", pop.resolveFolderPath("Sem", "Sem - C - X"), "Sem");
vm.runInContext(`folderTemplate = "semester-course-faculty";`, pop);
check("resolve faculty", pop.resolveFolderPath("Course", "Sem - C - X", "ProfA"), "Sem/Course/ProfA");
check("resolve faculty no-faculty-arg gives base", pop.resolveFolderPath("MyCourse", "Sem - C - X"), "Sem/MyCourse");
check("resolve faculty slash flattened", pop.resolveFolderPath("Course", "Sem - C - X", "A/B"), "Sem/Course/A-B");
check("resolve faculty blank gives base", pop.resolveFolderPath("Course", "Sem - C - X", "   "), "Sem/Course");

// --- groupKeysByFaculty / distinctFaculties / previewFolder ---
vm.runInContext(
  `currentState = { courseText: "Sem - C - X", folderNameSuggestion: "C", rows: [
    { key: "k1", facultyName: "ProfA" },
    { key: "k2", facultyName: "ProfB" },
    { key: "k3", facultyName: "ProfA" },
  ] };`,
  pop
);
const g = pop.groupKeysByFaculty(["k1", "k2", "k3", "stale-key"]);
check("group ProfA", g.get("ProfA"), ["k1", "k3"]);
check("group ProfB", g.get("ProfB"), ["k2"]);
check("group unknown fallback", g.get("Unknown faculty"), ["stale-key"]);
check("group empty keys", Array.from(pop.groupKeysByFaculty([]).keys()), []);
check("distinctFaculties", pop.distinctFaculties(["k1", "k2", "k3"]), ["ProfA", "ProfB"]);
vm.runInContext(`folderTemplate = "semester-course";`, pop);
check("previewFolder non-faculty passthrough", pop.previewFolder("MyCourse"), "Sem/MyCourse");
vm.runInContext(`folderTemplate = "semester-course-faculty";`, pop);
check("previewFolder single faculty concrete", pop.previewFolder("Course", ["k1", "k3"]), "Sem/Course/ProfA");
check("previewFolder multi faculty base", pop.previewFolder("Course", ["k1", "k2"]), "Sem/Course");

// --- courseTextToSemester ---
check("semester extraction", pop.courseTextToSemester("Fall Semester 2025-26 - ISWE204L - Operating Systems - TH"), "Fall Semester 2025-26");
check("semester null-safe", pop.courseTextToSemester(null), null);

// --- formatBytes / summarizeSizes ---
check("formatBytes bytes", pop.formatBytes(512), "512 B");
check("formatBytes MB", pop.formatBytes(2100000), "2 MB");
check("formatBytes unknown", pop.formatBytes(-1), "size unknown");
check("formatBytes non-number", pop.formatBytes("x"), "size unknown");
check("summarizeSizes empty", pop.summarizeSizes([]), []);
check("summarizeSizes identical",
  pop.summarizeSizes([
    { name: "a.pdf", bytes: 2100000, state: "complete" },
    { name: "a.pdf", bytes: 2100000, state: "complete" },
  ]),
  ["a.pdf × 2: 2 MB × 2 identical"]);

console.log(`\nTOTAL pass=${pass} fail=${fail}`);
if (fail) process.exit(1);

// --- static security gate: production code must not phone home ---
// No network primitives, no eval, no remote resources. (Tests may use them.)
const prodSrc = ["popup.js", "background.js", "content.js"]
  .map((f) => fs.readFileSync(`${EXT_DIR}/${f}`, "utf8").replace(/\/\/.*$/gm, ""))
  .join("\n");
const prodHtml = fs.readFileSync(`${EXT_DIR}/popup.html`, "utf8");
let secFail = 0;
const secCheck = (name, bad) => {
  const found = bad.test(prodSrc);
  if (!found) { pass++; console.log(`PASS sec: ${name}`); }
  else { fail++; secFail++; console.log(`FAIL sec: ${name}`); }
};
secCheck("no fetch()", /fetch\s*\(/);
secCheck("no XMLHttpRequest", /XMLHttpRequest/);
secCheck("no eval()", /[^.]eval\s*\(/);
secCheck("no WebSocket", /new\s+WebSocket/);
secCheck("no externally_connectable exfil", /externally_connectable/);
if (!/src\s*=\s*"https?:|<link[^>]*href\s*=\s*"https?:/i.test(prodHtml)) { pass++; console.log("PASS sec: popup has no remote resources"); }
else { fail++; console.log("FAIL sec: popup has remote resources"); }

console.log(`\nGRAND TOTAL pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
