#!/bin/bash
# UI regression run against an in-memory fake Supabase (no network, no account).
#
# Usage: tests/e2e/run.sh <source-dir> <label> [port] [scenario 1|2|3|4]
#   Copies <source-dir> (e.g. the repo, or `git archive <rev>` output), swaps
#   the Supabase client for tests/e2e/fake-supabase.js, drives the UI with
#   tests/e2e/scenario.js in headless Chromium, and writes
#   tests/e2e/runs/<label>/result.json (DB rows + rendered lists per step).
#   Compare two runs with: python3 tests/e2e/diff.py A/result.json B/result.json
#
# Needs python3 and a Chromium headless shell: set CHROME, or install one with
# `npx playwright install chromium-headless-shell`.
set -e
H="$(cd "$(dirname "$0")" && pwd)"
SRC="$1"; LABEL="$2"; PORT="${3:-8810}"; SCEN="${4:-1}"
OUT="$H/runs/$LABEL"
rm -rf "$OUT" && mkdir -p "$OUT/site"
rsync -a --exclude .git --exclude tests --exclude .vercel "$SRC/" "$OUT/site/"
mkdir -p "$OUT/site/__harness" && cp "$H"/fake-supabase.js "$H"/scenario.js "$H"/hooks.js "$OUT/site/__harness/"
python3 - "$OUT/site/index.html" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
s = s.replace("<head>", '<head>\n    <script src="./__harness/hooks.js"></script>', 1)
s, n = re.subn(r"<script>\s*window\.supabaseClient = supabase\.createClient\([\s\S]*?\);\s*</script>",
              '<script src="./__harness/fake-supabase.js"></script>', s)
assert n == 1, "client script not found"
s, n = re.subn(r"<script>\s*if \(\"serviceWorker\" in navigator\)[\s\S]*?</script>", "", s)
assert n == 1, "sw block not found"
s = s.replace("</body>", '    <script src="./__harness/scenario.js"></script>\n  </body>', 1)
open(p, "w").write(s)
PY
CH="${CHROME:-$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell 2>/dev/null | tail -1)}"
[ -x "$CH" ] || { echo "Set CHROME to a Chromium headless shell binary"; exit 1; }
(cd "$OUT/site" && exec python3 -m http.server "$PORT" >/dev/null 2>&1) & SRV=$!
sleep 1
"$CH" --user-data-dir="$OUT/profile" --window-size=1600,1000 --virtual-time-budget=120000 --dump-dom "http://localhost:$PORT/?s=$SCEN" > "$OUT/dom.html" 2>/dev/null || true
kill $SRV 2>/dev/null || true
python3 - "$OUT" <<'PY'
import re, html, json, sys
out = sys.argv[1]
s = open(out + "/dom.html").read()
m = re.search(r'<pre id="out">(.*?)</pre>', s, re.S)
if not m:
    print("NO OUTPUT"); sys.exit(1)
d = json.loads(html.unescape(m.group(1)))
json.dump(d, open(out + "/result.json", "w"), indent=1, ensure_ascii=False)
print("error:", d["error"])
print("errors:", d["errors"])
print("toasts:", d["toasts"])
print("steps:", len(d["steps"]))
PY
