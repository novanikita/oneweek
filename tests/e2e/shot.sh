#!/bin/bash
# Screenshot a site prepared by run.sh (reuses tests/e2e/runs/<label>/site).
# Usage: tests/e2e/shot.sh <label> <out.png> <width> <height> [query, e.g. "s=5&focus=day"]
set -e
H="$(cd "$(dirname "$0")" && pwd)"
LABEL="$1"; OUTPNG="$2"; W="$3"; HT="$4"; Q="${5:-s=5}"
SITE="$H/runs/$LABEL/site"
[ -d "$SITE" ] || { echo "run tests/e2e/run.sh first to build $SITE"; exit 1; }
cp "$H"/fake-supabase.js "$H"/scenario.js "$H"/hooks.js "$SITE/__harness/"
CH="${CHROME:-$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell 2>/dev/null | tail -1)}"
PORT=$((8900 + RANDOM % 90))
(cd "$SITE" && exec python3 -m http.server "$PORT" >/dev/null 2>&1) & SRV=$!
sleep 1
PROFILE="$(mktemp -d)"
"$CH" --user-data-dir="$PROFILE" --hide-scrollbars --window-size="$W,$HT" --virtual-time-budget=30000 \
  --screenshot="$OUTPNG" "http://localhost:$PORT/?$Q" >/dev/null 2>&1 || true
kill $SRV 2>/dev/null || true
rm -rf "$PROFILE"
echo "$OUTPNG"
