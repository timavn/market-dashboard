#!/usr/bin/env bash
# Wait for IB Gateway socket, then discover contracts and refresh dashboard ingest.
set -euo pipefail

HOST="${IB_GATEWAY_HOST:-127.0.0.1}"
PORTS="${IB_GATEWAY_PORTS:-4002 4001 7497 7496}"
SIDECAR="${IBKR_SIDECAR_URL:-http://localhost:8765}"
BACKEND="${REACT_APP_BACKEND_URL:-http://localhost:3001}"
MAX_WAIT_SEC="${MAX_WAIT_SEC:-600}"

echo "Waiting up to ${MAX_WAIT_SEC}s for IB API on ${HOST} (${PORTS})..."
start=$(date +%s)
while true; do
  for p in $PORTS; do
    if nc -z "$HOST" "$p" 2>/dev/null; then
      export IB_GATEWAY_PORT="$p"
      echo "IB API up on ${HOST}:${p}"
      echo "POST ${SIDECAR}/discover"
      curl -sf -X POST "${SIDECAR%/}/discover" | python3 -m json.tool
      echo "POST ${SIDECAR}/refresh"
      curl -sf -X POST "${SIDECAR%/}/refresh" | python3 -m json.tool
      if curl -sf "${BACKEND%/}/api/prediction-markets/refresh/ibkr" -X POST -H 'Content-Type: application/json' -d '{}' | python3 -m json.tool; then
        echo "Dashboard IBKR refresh complete."
      fi
      exit 0
    fi
  done
  if (( $(date +%s) - start >= MAX_WAIT_SEC )); then
    echo "Timed out. Start IB Gateway, log in, enable API (port 4002 paper), then run: npm run ibkr-sidecar:discover"
    exit 1
  fi
  sleep 3
done
