#!/usr/bin/env bash
# Quick check that IB Gateway/TWS socket port is listening.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$ROOT/../.." && pwd)"

if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
fi

HOST="${IB_GATEWAY_HOST:-127.0.0.1}"
DETECTED="$("$ROOT/detect_gateway_port.sh" 2>/dev/null || true)"
PORT="${DETECTED:-${IB_GATEWAY_PORT:-4002}}"

if command -v nc >/dev/null 2>&1; then
  if nc -z "$HOST" "$PORT" 2>/dev/null; then
    echo "OK: IB API socket reachable at ${HOST}:${PORT}"
    exit 0
  fi
else
  if (echo >/dev/tcp/"$HOST"/"$PORT") 2>/dev/null; then
    echo "OK: IB API socket reachable at ${HOST}:${PORT}"
    exit 0
  fi
fi

echo "IB Gateway/TWS is not listening on ${HOST}:${PORT}."
echo ""
echo "1. Install IB Gateway from Interactive Brokers"
echo "2. Log in (live port 4001, paper port 4002)"
echo "3. Configure → Settings → API → enable ActiveX and Socket Clients"
echo "4. Add 127.0.0.1 to trusted IPs; note socket port and client ID"
echo ""
echo "Tried auto-detect ports: 4001, 4002, 7497, 7496"
echo "Set IB_GATEWAY_PORT in .env or re-run after Gateway login."
exit 1
