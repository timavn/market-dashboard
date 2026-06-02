#!/usr/bin/env bash
# Resolve IB Gateway/TWS socket port: prefer IB_GATEWAY_PORT if reachable, else auto-detect.
set -euo pipefail

HOST="${IB_GATEWAY_HOST:-127.0.0.1}"
PREFERRED="${IB_GATEWAY_PORT:-}"

_port_open() {
  local port="$1"
  if command -v nc >/dev/null 2>&1; then
    nc -z "$HOST" "$port" 2>/dev/null
    return
  fi
  (echo >/dev/tcp/"$HOST"/"$port") 2>/dev/null
}

if [[ -n "$PREFERRED" ]] && _port_open "$PREFERRED"; then
  echo "$PREFERRED"
  exit 0
fi

for port in 4001 4002 7497 7496; do
  if [[ -n "$PREFERRED" && "$port" == "$PREFERRED" ]]; then
    continue
  fi
  if _port_open "$port"; then
    echo "$port"
    exit 0
  fi
done

if [[ -n "$PREFERRED" ]]; then
  echo "$PREFERRED"
  exit 0
fi

echo "4002"
exit 1
