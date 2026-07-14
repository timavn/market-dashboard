#!/usr/bin/env bash
# Start IBKR sidecar (requires IB Gateway or TWS with socket API enabled).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$ROOT/../.." && pwd)"
cd "$ROOT"

OVERRIDE_IB_GATEWAY_HOST="${IB_GATEWAY_HOST:-}"
OVERRIDE_IB_GATEWAY_PORT="${IB_GATEWAY_PORT:-}"
OVERRIDE_IB_GATEWAY_CLIENT_ID="${IB_GATEWAY_CLIENT_ID:-}"

# Load repo .env so IB_GATEWAY_* matches Express (sidecar does not use dotenv).
if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
fi

[[ -n "$OVERRIDE_IB_GATEWAY_HOST" ]] && export IB_GATEWAY_HOST="$OVERRIDE_IB_GATEWAY_HOST"
[[ -n "$OVERRIDE_IB_GATEWAY_PORT" ]] && export IB_GATEWAY_PORT="$OVERRIDE_IB_GATEWAY_PORT"
[[ -n "$OVERRIDE_IB_GATEWAY_CLIENT_ID" ]] && export IB_GATEWAY_CLIENT_ID="$OVERRIDE_IB_GATEWAY_CLIENT_ID"

export IB_GATEWAY_HOST="${IB_GATEWAY_HOST:-127.0.0.1}"
export IB_GATEWAY_CLIENT_ID="${IB_GATEWAY_CLIENT_ID:-17}"
export PYDANTIC_DISABLE_PLUGINS="${PYDANTIC_DISABLE_PLUGINS:-1}"

DETECTED="$("$ROOT/detect_gateway_port.sh" 2>/dev/null || true)"
export IB_GATEWAY_PORT="${DETECTED:-${IB_GATEWAY_PORT:-4002}}"

if command -v lsof >/dev/null 2>&1 && lsof -i :8765 -sTCP:LISTEN >/dev/null 2>&1; then
  if command -v curl >/dev/null 2>&1 && curl -sf --max-time 2 "http://127.0.0.1:8765/livez" >/dev/null 2>&1; then
    echo "IBKR sidecar is already running and responsive on :8765."
    echo "Open status: http://127.0.0.1:8765/status"
    exit 0
  fi
  echo "ERROR: Port :8765 is occupied, but the IBKR sidecar did not answer /livez."
  echo "The existing sidecar is likely wedged or outdated."
  echo "Restart it with: pkill -f 'uvicorn app:app' && npm run ibkr-sidecar"
  echo "Inspect it with: lsof -i :8765"
  exit 1
fi

if [[ ! -d .venv ]]; then
  echo "Creating Python venv..."
  python3 -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate

if python - <<'PY' >/dev/null 2>&1
import fastapi
import ib_insync
import uvicorn
PY
then
  echo "IBKR sidecar Python dependencies already available."
else
  pip install -q -r requirements.txt
fi

echo "IBKR sidecar → http://127.0.0.1:8765 (Gateway ${IB_GATEWAY_HOST}:${IB_GATEWAY_PORT}, clientId ${IB_GATEWAY_CLIENT_ID})"
exec uvicorn app:app --host 127.0.0.1 --port 8765 --loop asyncio
