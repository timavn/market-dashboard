#!/usr/bin/env bash
set -euo pipefail

SIDECAR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SIDECAR_DIR"

export PYDANTIC_DISABLE_PLUGINS="${PYDANTIC_DISABLE_PLUGINS:-1}"
export MARKET_DASHBOARD_API_BASE="${MARKET_DASHBOARD_API_BASE:-http://127.0.0.1:3001}"
export IBKR_SIDECAR_URL="${IBKR_SIDECAR_URL:-http://127.0.0.1:8765}"
export ANALYST_RESEARCH_BUCKET="${ANALYST_RESEARCH_BUCKET:-market-dashboard-csv-data}"
# Paused by the user: these sources show as Pending until set to "true".
export ANALYST_PORTFOLIO_PCA_ENABLED="${ANALYST_PORTFOLIO_PCA_ENABLED:-false}"
export ANALYST_ALPHA_ARCHIVE_SCAN_ENABLED="${ANALYST_ALPHA_ARCHIVE_SCAN_ENABLED:-false}"

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:6951 -sTCP:LISTEN >/dev/null 2>&1; then
  if curl -sf --max-time 2 "http://127.0.0.1:6951/healthz" >/dev/null 2>&1; then
    echo "The Analyst sidecar is already responsive on http://127.0.0.1:6951."
    exit 0
  fi
  echo "ERROR: Port 6951 is occupied but /healthz did not respond." >&2
  exit 1
fi

if [[ ! -x "$SIDECAR_DIR/.venv/bin/python" ]]; then
  "$SIDECAR_DIR/rebuild_venv.sh"
fi

exec "$SIDECAR_DIR/.venv/bin/python" -m uvicorn app:app --host 127.0.0.1 --port 6951 --loop asyncio
