#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HERMES_BIN="${HERMES_BIN:-/Users/timsmith/.local/bin/hermes}"
ANALYST_HOME="${ANALYST_HERMES_HOME:-/Users/timsmith/.hermes/profiles/analyst}"
DEFAULT_HERMES_HOME="${DEFAULT_HERMES_HOME:-/Users/timsmith/.hermes}"

if [[ ! -x "$HERMES_BIN" ]]; then
  echo "Hermes was not found at $HERMES_BIN" >&2
  exit 1
fi

if [[ ! -d "$ANALYST_HOME" ]]; then
  "$HERMES_BIN" profile create analyst --no-skills \
    --description "Cited Hedgeye research and read-only portfolio analysis for the market dashboard."
fi

install -m 600 "$REPO_ROOT/config/analyst/config.yaml" "$ANALYST_HOME/config.yaml"
mkdir -p "$ANALYST_HOME/scripts"
install -m 700 "$REPO_ROOT/scripts/hermes/momo_roster_precheck.py" \
  "$ANALYST_HOME/scripts/market_dashboard_momo_roster.py"
python3 "$SCRIPT_DIR/sync_profile_assets.py" \
  --source "$REPO_ROOT/config/analyst" --target "$ANALYST_HOME" \
  --retire skills/the-analyst \
  --retire skills/portfolio-refresh \
  --retire skills/portfolio-cross-verification \
  --retire skills/autonomous-ai-agents/hermes-agent \
  --archive-root "$DEFAULT_HERMES_HOME/backups/analyst-retired-skills"

# Always let the installed Hermes version advance the managed template through
# its own schema ladder before the profile is served. EOF answers any optional
# credential prompts with the safe default (skip); required Analyst credentials
# are managed separately in auth.json and the launch environment.
"$HERMES_BIN" -p analyst config migrate </dev/null >/dev/null
RESOLVED_CONFIG_PATH="$("$HERMES_BIN" -p analyst config path)"
if [[ "$RESOLVED_CONFIG_PATH" != "$ANALYST_HOME/config.yaml" ]]; then
  echo "Hermes resolved the wrong Analyst profile config: $RESOLVED_CONFIG_PATH" >&2
  exit 1
fi
if [[ "$("$HERMES_BIN" -p analyst config get display.tool_progress)" != "off" ]]; then
  echo "Hermes did not accept display.tool_progress=off for the Analyst profile." >&2
  exit 1
fi

# Earlier dashboard gateways pinned Luna inside saved session metadata. Keep
# their historical model and captured messages, while future resumes inherit
# this Analyst profile's current model, reasoning, and service tier.
python3 "$SCRIPT_DIR/migrate_session_models.py" \
  --profile-home "$ANALYST_HOME" \
  --backup-root "$DEFAULT_HERMES_HOME/backups/analyst-session-models"

# Reuse an already-configured Nous login only when the isolated profile has no
# usable Nous token of its own. The credential stays outside Git and is copied
# with private permissions; Hermes manages refresh/rotation from that point.
DEFAULT_AUTH_FILE="$DEFAULT_HERMES_HOME/auth.json"
ANALYST_AUTH_FILE="$ANALYST_HOME/auth.json"
if command -v jq >/dev/null 2>&1 \
  && [[ -f "$DEFAULT_AUTH_FILE" ]] \
  && jq -e '.providers.nous | (.access_token // .refresh_token // "") | length > 0' "$DEFAULT_AUTH_FILE" >/dev/null 2>&1 \
  && ! jq -e '.providers.nous | (.access_token // .refresh_token // "") | length > 0' "$ANALYST_AUTH_FILE" >/dev/null 2>&1; then
  install -m 600 "$DEFAULT_AUTH_FILE" "$ANALYST_AUTH_FILE"
fi

echo "The Analyst profile is configured at $ANALYST_HOME"
echo "Runtime tool boundary: market-dashboard-analyst + read-only skill readers"
