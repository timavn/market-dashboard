#!/usr/bin/env bash
# Verify IBKR market/portfolio providers (sidecar + Express).
set -euo pipefail

SIDECAR="${IBKR_SIDECAR_URL:-http://localhost:8765}"
BACKEND="${REACT_APP_BACKEND_URL:-http://localhost:3001}"

echo "=== 1. Sidecar GET /status ==="
curl -sf "${SIDECAR%/}/status" | python3 -m json.tool || {
  echo "FAIL: sidecar not reachable. Run: npm run ibkr-sidecar"
  exit 1
}

echo ""
echo "=== 2. Sidecar GET /accounts ==="
curl -sf "${SIDECAR%/}/accounts" | python3 -m json.tool || true

echo ""
echo "=== 3. Sidecar POST /quotes (AAPL) ==="
curl -sf -X POST "${SIDECAR%/}/quotes" \
  -H 'Content-Type: application/json' \
  -d '{"instruments":[{"symbol":"AAPL","secType":"STK"}]}' | python3 -m json.tool || true

echo ""
echo "=== 4. Express GET /api/providers/status ==="
curl -sf "${BACKEND%/}/api/providers/status" | python3 -m json.tool || {
  echo "WARN: backend not reachable. Run: npm run server"
  exit 1
}

echo ""
echo "=== 5. Express GET /api/providers/dev-smoke ==="
curl -sf "${BACKEND%/}/api/providers/dev-smoke" | python3 -m json.tool || true

echo ""
echo "=== 6. Express GET /api/quotes?symbols=AAPL,SPY ==="
curl -sf "${BACKEND%/}/api/quotes?symbols=AAPL,SPY" | python3 -m json.tool || true

echo ""
echo "=== 7. Express GET /api/portfolio ==="
curl -sf "${BACKEND%/}/api/portfolio" | python3 -m json.tool | head -80 || true

echo ""
echo "OK: provider verification complete"
