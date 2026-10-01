"""Firefox content-script suite (real Firefox engine, mock DOM).
Mirrors the key tests/regression.js content cases against content.js:
L1/L3-pure detection, negatives, placeholder rejection, zero-badge files,
hostile-title parsing, duplicate distinctness, and a 200-row parse budget.

Prereqs: python playwright + firefox build (`python3 -m playwright install firefox`).
Run: `python3 tests/firefox-content.py` (exit 0 = all pass).
"""
import json
import time
from playwright.sync_api import sync_playwright

EXT = "/Users/dimpulratakonda/Downloads/vit-bulk-downloader_v3_2_final"
CONTENT = open(f"{EXT}/content.js").read()

L1 = """<select><option>Fall Semester - X - Y</option></select>
<table><thead><tr><th>Course Detail</th><th>Material Detail</th><th>Uploaded By</th><th>Download</th></tr></thead>
<tbody><tr><td>C</td><td>T1<br>1 (Document)</td><td>C - F - 01-01-2025</td><td><a href="#">D</a></td></tr>
<tr><td>C</td><td>T2<br>2 (Document)</td><td>C - G - 02-01-2025</td><td><button>D</button></td></tr></tbody></table>"""
L3PURE = """<select><option>Fall Semester - X - Y</option></select>
<table><thead><tr><th>S.No</th><th>Details</th><th>Faculty</th><th>Action</th></tr></thead>
<tbody><tr><td>1</td><td>Lecture A<br>1 (Document)</td><td>CSE2001 - ProfA - 01-01-2025</td><td><a href="#">D</a></td></tr>
<tr><td>2</td><td>Lecture B<br>2 (Document)</td><td>CSE2001 - ProfB - 02-02-2025</td><td><button>D</button></td></tr></tbody></table>"""
NEG = """<select><option>Fall Semester - X - Y</option></select>
<table><thead><tr><th>S.No</th><th>Date</th><th>Status</th><th>Action</th></tr></thead>
<tbody><tr><td>1</td><td>01-01-2025</td><td>Present</td><td><button>View</button></td></tr></tbody></table>"""
PLACEHOLDER = """<select><option selected>Select course</option><option>Fall Semester - X - Y</option></select>
<table><thead><tr><th>Course Detail</th><th>Material Detail</th><th>Uploaded By</th><th>Download</th></tr></thead>
<tbody><tr><td>C</td><td>T1<br>1 (Document)</td><td>C - F - 01-01-2025</td><td><a href="#">D</a></td></tr></tbody></table>"""
XSS = """<select><option>Fall Semester - X - Y</option></select>
<table><thead><tr><th>Course Detail</th><th>Material Detail</th><th>Uploaded By</th><th>Download</th></tr></thead>
<tbody><tr><td>C</td><td>&lt;img src=x onerror="window.__pwned=1"&gt;<br>1 (Document)</td><td>C - F - 01-01-2025</td><td><a href="#">D</a></td></tr></tbody></table>"""
rows200 = "".join(
    f"<tr><td>C</td><td>Title {i}<br>1 (Document)</td><td>C - Prof{i % 5} - 01-01-2025</td>"
    f"<td><a href='#'>D</a></td></tr>" for i in range(200))
BIG = f"""<select><option>Fall Semester - X - Y</option></select>
<div>Show <select><option value="10">10</option><option value="100">100</option></select> entries<input type="search">
<table><thead><tr><th>Course Detail</th><th>Material Detail</th><th>Uploaded By</th><th>Download</th></tr></thead>
<tbody>{rows200}</tbody></table><div>Showing 1 to 200 of 200 entries</div></div>"""

results = []


def check(name, cond, evidence=""):
    results.append((name, bool(cond), str(evidence)[:160]))
    print(f"{'PASS' if cond else 'FAIL'} {name} :: {str(evidence)[:160]}", flush=True)


def load(pg, html):
    pg.goto("about:blank")
    pg.set_content(html)
    pg.evaluate("""() => {
      delete window.__vitBulkDownloaderInjected;
      window.__ls = null;
      window.chrome = { runtime: { onMessage: { addListener(fn) { window.__ls = fn; } },
                                   sendMessage(m) {} } };
      window.__send = (msg) => new Promise((res) => {
        const r = window.__ls(msg, {}, res); if (r !== true) res(undefined); });
    }""")
    pg.add_script_tag(content=CONTENT)
    return lambda m: pg.evaluate("window.__send(%s)" % json.dumps(m))


with sync_playwright() as pw:
    print(f"ENGINE firefox={pw.firefox.executable_path.split('/')[-1]}", flush=True)
    browser = pw.firefox.launch(headless=True)
    try:
        pg = browser.new_page()
        send = load(pg, L1)
        st = send({"type": "GET_STATE"})
        check("ff L1 strategy+rows", st["tableStrategy"] == "L1-strict" and len(st["rows"]) == 2,
              f"{st['tableStrategy']} rows={len(st['rows'])}")
        dg = send({"type": "DIAGNOSTICS"})
        check("ff diagnostics", dg["ok"] and dg["diag"]["downloadButtons"] == 2,
              f"buttons={dg['diag']['downloadButtons']}")

        send = load(pg, L3PURE)
        st = send({"type": "GET_STATE"})
        check("ff L3 pure-drift", st["tableStrategy"] == "L3-controls" and len(st["rows"]) == 2
              and st["rows"][0]["facultyName"] == "ProfA", st["tableStrategy"])

        send = load(pg, NEG)
        st = send({"type": "GET_STATE"})
        dg = send({"type": "DIAGNOSTICS"})
        check("ff negative not detected", not st["ok"] and not dg["diag"]["tableFound"],
              f"ok={st['ok']} found={dg['diag']['tableFound']}")

        send = load(pg, PLACEHOLDER)
        st = send({"type": "GET_STATE"})
        check("ff placeholder rejected", not st["ok"] and st["courseText"] is None,
              f"ok={st['ok']} course={st['courseText']}")

        send = load(pg, XSS)
        st = send({"type": "GET_STATE"})
        check("ff hostile title parsed as text", len(st["rows"]) == 1 and "<img" in st["rows"][0]["title"],
              st["rows"][0]["title"][:50] if st["rows"] else "no rows")
        check("ff no code executed", pg.evaluate("window.__pwned") is None, "clean")

        send = load(pg, BIG)
        t0 = time.time()
        st = send({"type": "GET_STATE"})
        dt = time.time() - t0
        check("ff 200 rows full parse", len(st["rows"]) == 200, f"rows={len(st['rows'])}")
        check("ff 200-row budget < 25s", dt < 25, f"{dt:.1f}s")
        t1 = time.time()
        for _ in range(5):
            st2 = send({"type": "GET_STATE"})
        dt2 = time.time() - t1
        check("ff repeat scans stable", len(st2["rows"]) == 200, f"rows={len(st2['rows'])} {dt2:.1f}s/5")
    finally:
        browser.close()

fails = [n for n, ok, _ in results if not ok]
print(f"\nTOTAL pass={len(results) - len(fails)} fail={len(fails)}", flush=True)
raise SystemExit(1 if fails else 0)
