#!/usr/bin/env bash
# Start IBKR sidecar (requires IB Gateway or TWS with socket API enabled).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

export IB_GATEWAY_HOST="${IB_GATEWAY_HOST:-127.0.0.1}"
export IB_GATEWAY_PORT="${IB_GATEWAY_PORT:-4002}"
export IB_GATEWAY_CLIENT_ID="${IB_GATEWAY_CLIENT_ID:-17}"

if [[ ! -d .venv ]]; then
  echo "Creating Python venv..."
  python3 -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate
pip install -q -r requirements.txt

echo "IBKR sidecar → http://127.0.0.1:8765 (Gateway ${IB_GATEWAY_HOST}:${IB_GATEWAY_PORT}, clientId ${IB_GATEWAY_CLIENT_ID})"
exec uvicorn app:app --host 127.0.0.1 --port 8765 --loop asyncio
