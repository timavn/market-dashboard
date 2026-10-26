#!/usr/bin/env bash
# Verify IBKR sidecar + Express backend health (run from repo root).
set -euo pipefail

SIDECAR="${IBKR_SIDECAR_URL:-http://localhost:8765}"
BACKEND="${REACT_APP_BACKEND_URL:-http://localhost:3001}"

echo "=== 1. Sidecar GET /status ==="
LIVEZ_RAW=$(curl -sf --max-time 2 "${SIDECAR%/}/livez") || {
  echo "FAIL: sidecar not responsive at ${SIDECAR}"
  echo "If nothing is listening, start with: npm run ibkr-sidecar"
  echo "If :8765 is occupied, restart it with: pkill -f 'uvicorn app:app' && npm run ibkr-sidecar"
  exit 1
}
echo "$LIVEZ_RAW" | python3 -m json.tool

echo ""
echo "=== 1a. Sidecar GET /status ==="
STATUS_RAW=$(curl -sf --max-time 5 "${SIDECAR%/}/status") || {
  echo "FAIL: sidecar is alive but /status did not respond."
  echo "Recommended action: pkill -f 'uvicorn app:app' && npm run ibkr-sidecar"
  exit 1
}
echo "$STATUS_RAW" | python3 -m json.tool

echo ""
echo "=== 1b. Persistent stream metadata ==="
echo "$STATUS_RAW" | python3 -c "
import json, sys
d = json.load(sys.stdin)
s = d.get('stream') or {}
print('  connected:', d.get('connected'))
print('  persistent:', s.get('persistent'))
print('  active_subscriptions:', s.get('active_subscriptions'))
print('  last_tick_at:', s.get('last_tick_at'))
"

echo ""
echo "=== 2. Sidecar GET /status ==="
curl -sf --max-time 10 "${SIDECAR%/}/status" | python3 -m json.tool

echo ""
echo "=== 3. Express GET /api/health ==="
if curl -sf --max-time 12 "${BACKEND%/}/api/health" | python3 -m json.tool; then
  echo "OK"
else
  echo "WARN: backend not reachable at ${BACKEND} (run npm run server)"
  exit 1
fi
