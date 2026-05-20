#!/usr/bin/env bash
# Quick check that IB Gateway/TWS socket port is listening.
set -euo pipefail

HOST="${IB_GATEWAY_HOST:-127.0.0.1}"
PORT="${IB_GATEWAY_PORT:-4002}"

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
echo "2. Log in (paper default port 4002, live 4001)"
echo "3. Configure → Settings → API → enable ActiveX and Socket Clients"
echo "4. Add 127.0.0.1 to trusted IPs; note socket port and client ID"
echo ""
echo "Then re-run: IB_GATEWAY_PORT=${PORT} ./check_gateway.sh"
exit 1
