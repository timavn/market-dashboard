#!/usr/bin/env bash
# Smoke test: persistent sidecar status + optional SSE quote event (requires Gateway).
set -euo pipefail

SIDECAR="${IBKR_SIDECAR_URL:-http://localhost:8765}"
BACKEND="${REACT_APP_BACKEND_URL:-http://localhost:3001}"

echo "=== 1. Sidecar GET /status (stream fields) ==="
STATUS_JSON=$(curl -sf "${SIDECAR%/}/status") || {
  echo "FAIL: sidecar not reachable at ${SIDECAR}"
  exit 1
}
echo "$STATUS_JSON" | python3 -m json.tool

CONNECTED=$(echo "$STATUS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('connected', False))")
if [ "$CONNECTED" != "True" ]; then
  echo "WARN: Gateway not connected — skipping subscribe/SSE checks"
  exit 0
fi

echo ""
echo "=== 2. POST /subscribe SPY ==="
curl -sf -X POST "${SIDECAR%/}/subscribe" \
  -H 'Content-Type: application/json' \
  -d '{"instruments":[{"symbol":"SPY","secType":"STK"}]}' | python3 -m json.tool

echo ""
echo "=== 3. SSE /stream/quotes (first event, 12s timeout) ==="
timeout 12 curl -sfN "${SIDECAR%/}/stream/quotes" | head -n 5 || {
  echo "WARN: no SSE events within 12s (market may be closed or delayed)"
}

echo ""
echo "=== 4. GET /cache/quotes?symbols=SPY ==="
curl -sf "${SIDECAR%/}/cache/quotes?symbols=SPY" | python3 -m json.tool

echo ""
echo "=== 5. Express GET /api/providers/status ==="
if curl -sf "${BACKEND%/}/api/providers/status" | python3 -m json.tool; then
  echo "OK"
else
  echo "WARN: backend not reachable at ${BACKEND}"
fi

echo ""
echo "Streaming smoke test finished."
