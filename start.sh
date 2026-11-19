#!/usr/bin/env sh
# easyeda2KicadGuiTool launcher (macOS / Linux)
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js is not installed: https://nodejs.org/"; exit 1; }
[ -d node_modules ] || npm install --omit=dev || exit 1
node scripts/check-python.js || npm run setup || exit 1
exec node server.js
