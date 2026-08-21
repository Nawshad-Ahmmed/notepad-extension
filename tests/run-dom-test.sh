#!/bin/sh
# Runs the DOM sanitizer test in real Chromium (the Node suites stub the DOM away).
set -e
dir=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
cp "$dir/../markdown.js" "$dir/sanitizer.dom.html" "$tmp/"
chromium --headless --disable-gpu --no-sandbox --user-data-dir="$tmp/prof" \
  --dump-dom "file://$tmp/sanitizer.dom.html" 2>/dev/null \
| python3 -c "import html,re,sys; m=re.search(r'<div id=\"log\">(.*?)</div>', sys.stdin.read(), re.S); print(html.unescape(m.group(1)) if m else 'NO LOG')"
rm -rf "$tmp"
