#!/usr/bin/env bash
# Verify IBKR sidecar + Express provider status (run from repo root).
set -euo pipefail

SIDECAR="${IBKR_SIDECAR_URL:-http://localhost:8765}"
BACKEND="${REACT_APP_BACKEND_URL:-http://localhost:3001}"

echo "=== 1. Sidecar GET /status ==="
if ! curl -sf "${SIDECAR%/}/status" | python3 -m json.tool; then
  echo "FAIL: sidecar not reachable at ${SIDECAR}"
  echo "Start with: npm run ibkr-sidecar"
  exit 1
fi

echo ""
echo "=== 2. Sidecar POST /refresh ==="
curl -sf -X POST "${SIDECAR%/}/refresh" | python3 -m json.tool

echo ""
echo "=== 3. Express GET /api/prediction-markets/providers/status ==="
if curl -sf "${BACKEND%/}/api/prediction-markets/providers/status" | python3 -m json.tool; then
  echo "OK"
else
  echo "WARN: backend not reachable at ${BACKEND} (run npm run server)"
  exit 1
fi
