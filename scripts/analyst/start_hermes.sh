#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANALYST_BIN="${ANALYST_BIN:-/Users/timsmith/.local/bin/analyst}"

"$SCRIPT_DIR/setup_profile.sh"
if [[ -z "${ANALYST_SERVICE_TOKEN:-}" || -z "${HERMES_DASHBOARD_SESSION_TOKEN:-}" ]]; then
  echo "ANALYST_SERVICE_TOKEN and HERMES_DASHBOARD_SESSION_TOKEN are required." >&2
  exit 1
fi
# Hermes resolves MCP headers inside the isolated profile's secret scope.
# Its process environment alone is insufficient when profile multiplexing is active.
python3 "$SCRIPT_DIR/sync_runtime_secrets.py"
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:9121 -sTCP:LISTEN >/dev/null 2>&1; then
  LISTENER_PID="$(lsof -nP -t -iTCP:9121 -sTCP:LISTEN 2>/dev/null | head -n 1)"
  LISTENER_COMMAND="$(ps -p "$LISTENER_PID" -o command= 2>/dev/null || true)"
  STATUS_JSON="$(curl -sf --max-time 5 "http://127.0.0.1:9121/api/status" 2>/dev/null || true)"
  if [[ "$LISTENER_COMMAND" == *"hermes"* && "$LISTENER_COMMAND" == *"serve"* ]] \
    && command -v jq >/dev/null 2>&1 \
    && jq -e \
      --arg home "${ANALYST_HERMES_HOME:-/Users/timsmith/.hermes/profiles/analyst}" \
      '.hermes_home == $home and (.config_path | endswith("/profiles/analyst/config.yaml"))' \
      >/dev/null 2>&1 <<<"$STATUS_JSON"; then
    echo "The Analyst Hermes gateway is already responsive on http://127.0.0.1:9121."
    exit 0
  fi
  echo "ERROR: Port 9121 is occupied but is not owned by the isolated Analyst Hermes profile." >&2
  exit 1
fi

export HERMES_TUI_TOOLSETS="market-dashboard-analyst,analyst-skill-reader"
# The response guard needs verified tool-completion events; the workspace UI
# chooses which progress to display independently.
export HERMES_TUI_TOOL_PROGRESS="all"
export HERMES_SESSION_PLATFORM="api_server"
exec "$ANALYST_BIN" serve --isolated --skip-build --open-profile analyst --host 127.0.0.1 --port 9121
