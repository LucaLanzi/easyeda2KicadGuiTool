#!/usr/bin/env sh
# easyeda2KicadGuiTool launcher (macOS / Linux)
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || {
  echo "Node.js 18+ is not installed. Install it (e.g. 'nvm install --lts') and run 'make install'."
  exit 1
}
[ -d node_modules ] || npm install --no-fund --no-audit || exit 1
node scripts/check-python.js || node scripts/install.js || exit 1
exec node server.js "$@"
