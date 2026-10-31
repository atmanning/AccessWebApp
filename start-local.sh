#!/usr/bin/env bash
# Starts Access Web on this computer and opens it in your browser (macOS / Linux).
# Press Ctrl+C to stop it. See docs/INSTALL-LOCAL.md.
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f server/dist/server/src/index.js || ! -f web/dist/index.html ]]; then
  echo "Access Web hasn't been built yet. In this folder run:"
  echo "    npm ci && npm run build && npm run build:exporter"
  exit 1
fi
command -v node >/dev/null || { echo "Node.js isn't installed. See docs/INSTALL-LOCAL.md."; exit 1; }

export NODE_ENV=production
export SECURE_COOKIES=false                       # plain http on this computer
export PORT="${PORT:-3000}"
export HOST="${HOST:-127.0.0.1}"                  # 0.0.0.0 to share on your network
export ALLOW_PRIVATE_DB_HOSTS="${ALLOW_PRIVATE_DB_HOSTS:-true}"
export DATA_DIR="${DATA_DIR:-$PWD/data}"

command -v java >/dev/null || echo "Note: Java isn't installed, so Access .accdb import and export won't work."
[[ -f exporter/target/access-exporter.jar ]] || echo "Note: the Access exporter isn't built (npm run build:exporter)."

url="http://localhost:$PORT"
echo "Starting Access Web on $url  (data folder: $DATA_DIR)"
( sleep 3
  if [[ "$(uname)" == Darwin ]]; then open "$url"; elif command -v xdg-open >/dev/null; then xdg-open "$url" >/dev/null 2>&1 || true; fi ) &
exec node server/dist/server/src/index.js
