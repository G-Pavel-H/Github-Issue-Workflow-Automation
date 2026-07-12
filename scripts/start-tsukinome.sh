#!/usr/bin/env bash
# Start Tsukinome locally: the webhook server (npm run dev) + the smee proxy that
# forwards GitHub webhooks to it. Ctrl+C stops both.
#
# Usage:  ./scripts/start-tsukinome.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# npm does not load .env into the script env, and dev:smee needs SMEE_URL, so pull it
# from .env here (dotenv.parse handles quoting; nothing is printed).
export SMEE_URL="$(node -e "const fs=require('fs');process.stdout.write((require('dotenv').parse(fs.readFileSync('.env')).SMEE_URL||'').trim())")"
if [ -z "${SMEE_URL}" ]; then
  echo "ERROR: SMEE_URL is not set in .env" >&2
  exit 1
fi

echo "Tsukinome starting…"
echo "  smee channel : ${SMEE_URL}"
echo "  webhook path : /api/github/webhooks   (server on http://localhost:3000)"
echo "  Press Ctrl+C to stop both."
echo

# Start the smee proxy in the background; make sure it dies when this script exits.
npm run dev:smee &
SMEE_PID=$!
cleanup() { echo; echo "Stopping Tsukinome…"; kill "${SMEE_PID}" 2>/dev/null || true; }
trap cleanup INT TERM EXIT

# Run the server in the foreground (this is what Ctrl+C interrupts).
npm run dev
