#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TEMPLATE_PATH="${REPO_DIR}/ops/launchd/com.market-dashboard.stack.plist.template"
AWS_PREFLIGHT_PATH="${REPO_DIR}/scripts/ops/aws_profile_preflight.js"
USER_ID="$(id -u)"
USER_NAME="$(id -un)"
USER_HOME="$(dscl . -read "/Users/${USER_NAME}" NFSHomeDirectory | awk '{print $2}')"
LAUNCH_AGENTS_DIR="${USER_HOME}/Library/LaunchAgents"
TARGET_PATH="${LAUNCH_AGENTS_DIR}/com.market-dashboard.stack.plist"
LOG_DIR="${USER_HOME}/Library/Logs/market-dashboard"
NODE_PATH="$(command -v node)"
NODE_REAL_PATH="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$NODE_PATH")"
PATH_VALUE="$(dirname "$NODE_PATH"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
LEGACY_HERMES_MODE="${LEGACY_HERMES_MODE:-shadow}"
BRIDGE_AWS_PROFILE="${HERMES_BRIDGE_AWS_PROFILE:-market-dashboard-bridge}"
API_AWS_PROFILE="market-dashboard-local"
BRIDGE_ENABLED="${HERMES_BRIDGE_ENABLED:-false}"
OPERATIONS_BRIDGE_ENABLED="${HERMES_OPERATIONS_BRIDGE_ENABLED:-${BRIDGE_ENABLED}}"
PORTFOLIO_BRIDGE_ENABLED="${HERMES_PORTFOLIO_BRIDGE_ENABLED:-${BRIDGE_ENABLED}}"
if [[ "${READINESS_CONTROLLER_MODE+x}" == "x" ]]; then
  CONTROLLER_MODE="${READINESS_CONTROLLER_MODE}"
else
  CONTROLLER_MODE="${HERMES_RELIABILITY_CONTROLLER_MODE:-shadow}"
fi
if [[ "${READINESS_CONTROLLER_ENABLED_ACTIONS+x}" == "x" ]]; then
  CONTROLLER_ENABLED_ACTIONS="${READINESS_CONTROLLER_ENABLED_ACTIONS}"
else
  CONTROLLER_ENABLED_ACTIONS="${HERMES_RELIABILITY_ENABLED_ACTIONS:-}"
fi
LOCAL_NOTIFICATIONS="${MARKET_DASHBOARD_LOCAL_NOTIFICATIONS:-true}"
case "$(printf '%s' "$LEGACY_HERMES_MODE" | tr '[:upper:]' '[:lower:]')" in
  shadow)
    LEGACY_HERMES_MODE="shadow"
    ;;
  read-only)
    LEGACY_HERMES_MODE="read-only"
    ;;
  *)
    echo "LEGACY_HERMES_MODE must be shadow or read-only." >&2
    exit 1
    ;;
esac
case "$(printf '%s' "$BRIDGE_ENABLED" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on|enabled)
    BRIDGE_ENABLED="true"
    ;;
  0|false|no|off|disabled|'')
    BRIDGE_ENABLED="false"
    ;;
  *)
    echo "HERMES_BRIDGE_ENABLED must be a boolean value." >&2
    exit 1
    ;;
esac
normalize_bridge_partition() {
  local variable_name="$1"
  local raw_value="$2"
  case "$(printf '%s' "$raw_value" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on|enabled)
      printf 'true'
      ;;
    0|false|no|off|disabled|'')
      printf 'false'
      ;;
    *)
      echo "${variable_name} must be a boolean value." >&2
      exit 1
      ;;
  esac
}
OPERATIONS_BRIDGE_ENABLED="$(
  normalize_bridge_partition HERMES_OPERATIONS_BRIDGE_ENABLED "$OPERATIONS_BRIDGE_ENABLED"
)"
PORTFOLIO_BRIDGE_ENABLED="$(
  normalize_bridge_partition HERMES_PORTFOLIO_BRIDGE_ENABLED "$PORTFOLIO_BRIDGE_ENABLED"
)"
case "$(printf '%s' "$CONTROLLER_MODE" | tr '[:upper:]' '[:lower:]')" in
  active)
    CONTROLLER_MODE="active"
    ;;
  shadow|'')
    CONTROLLER_MODE="shadow"
    ;;
  *)
    echo "READINESS_CONTROLLER_MODE must be shadow or active." >&2
    exit 1
    ;;
esac
if [[ -n "$CONTROLLER_ENABLED_ACTIONS" ]]; then
  if [[ ! "$CONTROLLER_ENABLED_ACTIONS" =~ ^[a-z][a-z0-9-]*(,[a-z][a-z0-9-]*)*$ ]]; then
    echo "READINESS_CONTROLLER_ENABLED_ACTIONS must be a comma-separated list of exact action IDs." >&2
    exit 1
  fi
  IFS=',' read -r -a controller_action_ids <<< "$CONTROLLER_ENABLED_ACTIONS"
  for controller_action_id in "${controller_action_ids[@]}"; do
    case "$controller_action_id" in
      start-local-stack|restart-local-stack|restart-ibkr-sidecar|rebuild-sidecar-runtime|retry-gmail-poll|rebuild-research-projections|reconcile-prediction-catalog|prune-dashboard-logs)
        ;;
      *)
        echo "Unknown readiness controller action ID: ${controller_action_id}" >&2
        exit 1
        ;;
    esac
  done
fi
if [[ "$OPERATIONS_BRIDGE_ENABLED" == "false" && "$PORTFOLIO_BRIDGE_ENABLED" == "false" ]]; then
  # Disabled mode must not depend on, validate, or persist a bridge profile.
  # In particular, ignore any stale shell value that could corrupt plist
  # rendering through the sed replacement below.
  BRIDGE_AWS_PROFILE=""
fi
case "$(printf '%s' "$LOCAL_NOTIFICATIONS" | tr '[:upper:]' '[:lower:]')" in
  0|false|no|off|disabled)
    LOCAL_NOTIFICATIONS="false"
    ;;
  *)
    LOCAL_NOTIFICATIONS="true"
    ;;
esac

if [[ "$USER_HOME" != /* || "$LAUNCH_AGENTS_DIR" != "$USER_HOME/Library/LaunchAgents" ]]; then
  echo "Could not resolve a safe per-user LaunchAgents directory." >&2
  exit 1
fi
if [[ ! -f "$TEMPLATE_PATH" || ! -f "$AWS_PREFLIGHT_PATH" || ! -x "$NODE_PATH" ]]; then
  echo "LaunchAgent template or Node.js runtime is missing." >&2
  exit 1
fi
if [[ "$OPERATIONS_BRIDGE_ENABLED" == "true" || "$PORTFOLIO_BRIDGE_ENABLED" == "true" ]] \
    && [[ -z "${BRIDGE_AWS_PROFILE//[[:space:]]/}" ]]; then
  echo "HERMES_BRIDGE_AWS_PROFILE must name the dedicated outbound bridge profile." >&2
  exit 1
fi
if [[ "$OPERATIONS_BRIDGE_ENABLED" == "true" || "$PORTFOLIO_BRIDGE_ENABLED" == "true" ]] \
    && [[ ! "$BRIDGE_AWS_PROFILE" =~ ^[A-Za-z0-9_+=,.@-]+$ ]]; then
  echo "HERMES_BRIDGE_AWS_PROFILE contains unsupported characters." >&2
  exit 1
fi
if [[ "$OPERATIONS_BRIDGE_ENABLED" == "true" || "$PORTFOLIO_BRIDGE_ENABLED" == "true" ]] \
    && [[ "$BRIDGE_AWS_PROFILE" != "market-dashboard-bridge" ]]; then
  echo "HERMES_BRIDGE_AWS_PROFILE must be the dedicated market-dashboard-bridge profile." >&2
  exit 1
fi

# Validate identities before rendering a plist, stopping a process, or changing
# launchd state. The preflight resolves named profiles through AWS CLI, rejects
# copied session tokens, and emits no credential or caller-identity values.
"$NODE_PATH" "$AWS_PREFLIGHT_PATH" \
  --purpose api \
  --profile "$API_AWS_PROFILE"
if [[ "$OPERATIONS_BRIDGE_ENABLED" == "true" || "$PORTFOLIO_BRIDGE_ENABLED" == "true" ]]; then
  "$NODE_PATH" "$AWS_PREFLIGHT_PATH" \
    --purpose bridge \
    --profile "$BRIDGE_AWS_PROFILE"
fi

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

repo_xml="$(xml_escape "$REPO_DIR")"
node_xml="$(xml_escape "$NODE_PATH")"
log_xml="$(xml_escape "$LOG_DIR")"
path_xml="$(xml_escape "$PATH_VALUE")"
legacy_hermes_mode_xml="$(xml_escape "$LEGACY_HERMES_MODE")"
bridge_profile_xml="$(xml_escape "$BRIDGE_AWS_PROFILE")"
bridge_enabled_xml="$(xml_escape "$BRIDGE_ENABLED")"
operations_bridge_enabled_xml="$(xml_escape "$OPERATIONS_BRIDGE_ENABLED")"
portfolio_bridge_enabled_xml="$(xml_escape "$PORTFOLIO_BRIDGE_ENABLED")"
controller_mode_xml="$(xml_escape "$CONTROLLER_MODE")"
controller_enabled_actions_xml="$(xml_escape "$CONTROLLER_ENABLED_ACTIONS")"
local_notifications_xml="$(xml_escape "$LOCAL_NOTIFICATIONS")"
staged_path="$(mktemp "${TMPDIR:-/tmp}/market-dashboard-launchagent.XXXXXX.plist")"
trap 'rm -f "$staged_path"' EXIT

sed \
  -e "s|__REPO_PATH__|${repo_xml}|g" \
  -e "s|__NODE_PATH__|${node_xml}|g" \
  -e "s|__LOG_PATH__|${log_xml}|g" \
  -e "s|__PATH_VALUE__|${path_xml}|g" \
  -e "s|__LEGACY_HERMES_MODE__|${legacy_hermes_mode_xml}|g" \
  -e "s|__HERMES_BRIDGE_AWS_PROFILE__|${bridge_profile_xml}|g" \
  -e "s|__HERMES_BRIDGE_ENABLED__|${bridge_enabled_xml}|g" \
  -e "s|__HERMES_OPERATIONS_BRIDGE_ENABLED__|${operations_bridge_enabled_xml}|g" \
  -e "s|__HERMES_PORTFOLIO_BRIDGE_ENABLED__|${portfolio_bridge_enabled_xml}|g" \
  -e "s|__HERMES_CONTROLLER_MODE__|${controller_mode_xml}|g" \
  -e "s|__HERMES_CONTROLLER_ENABLED_ACTIONS__|${controller_enabled_actions_xml}|g" \
  -e "s|__LOCAL_NOTIFICATIONS__|${local_notifications_xml}|g" \
  "$TEMPLATE_PATH" > "$staged_path"

plutil -lint "$staged_path" >/dev/null
mkdir -p "$LAUNCH_AGENTS_DIR" "$LOG_DIR"

if [[ -f "$TARGET_PATH" ]]; then
  existing_label="$(/usr/libexec/PlistBuddy -c 'Print :Label' "$TARGET_PATH" 2>/dev/null || true)"
  if [[ "$existing_label" != "com.market-dashboard.stack" ]]; then
    echo "Refusing to overwrite an unrelated LaunchAgent at ${TARGET_PATH}." >&2
    exit 1
  fi
  cp -p "$TARGET_PATH" "${TARGET_PATH}.previous-$(date -u +%Y%m%dT%H%M%SZ)"
fi

# Stop only the processes already proven to belong to this repository before
# transferring supervision to launchd. Unknown listeners remain untouched.
"$NODE_PATH" "$REPO_DIR/scripts/dev-stack/cli.js" stop || true
launchctl bootout "gui/${USER_ID}" "$TARGET_PATH" >/dev/null 2>&1 || true
install -m 600 "$staged_path" "$TARGET_PATH"
launchctl bootstrap "gui/${USER_ID}" "$TARGET_PATH"
launchctl kickstart -k "gui/${USER_ID}/com.market-dashboard.stack"

for _attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 2 http://127.0.0.1:3001/api/health >/dev/null 2>&1 \
      && curl -fsS --max-time 2 http://127.0.0.1:3000/ >/dev/null 2>&1; then
    echo "LaunchAgent installed and the API/UI are healthy."
    launchctl print "gui/${USER_ID}/com.market-dashboard.stack" | sed -n '1,35p'
    exit 0
  fi
  sleep 2
done

echo "LaunchAgent loaded, but API/UI did not become healthy in 20 seconds." >&2
echo "Inspect ${LOG_DIR}/launchd.stderr.log and run npm run dev:doctor." >&2
if [[ "$REPO_DIR" == "$USER_HOME/Desktop/"* \
    || "$REPO_DIR" == "$USER_HOME/Documents/"* \
    || "$REPO_DIR" == "$USER_HOME/Downloads/"* ]]; then
  echo "This repository is inside a macOS protected folder." >&2
  echo "Grant Files & Folders/Desktop access (or Full Disk Access) to ${NODE_REAL_PATH}, then rerun this installer; alternatively move the repository outside Desktop/Documents/Downloads." >&2
fi
# Do not leave a launchd process wedged on a protected-folder authorization
# boundary. The generated plist remains installed for a safe retry after the
# operator grants access.
launchctl bootout "gui/${USER_ID}" "$TARGET_PATH" >/dev/null 2>&1 || true
"$NODE_PATH" "$REPO_DIR/scripts/dev-stack/cli.js" start --detach || true
exit 2
