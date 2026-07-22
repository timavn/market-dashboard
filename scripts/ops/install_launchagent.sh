#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TEMPLATE_PATH="${REPO_DIR}/ops/launchd/com.market-dashboard.stack.plist.template"
USER_ID="$(id -u)"
USER_NAME="$(id -un)"
USER_HOME="$(dscl . -read "/Users/${USER_NAME}" NFSHomeDirectory | awk '{print $2}')"
LAUNCH_AGENTS_DIR="${USER_HOME}/Library/LaunchAgents"
TARGET_PATH="${LAUNCH_AGENTS_DIR}/com.market-dashboard.stack.plist"
LOG_DIR="${USER_HOME}/Library/Logs/market-dashboard"
NODE_PATH="$(command -v node)"
NODE_REAL_PATH="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$NODE_PATH")"
PATH_VALUE="$(dirname "$NODE_PATH"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if [[ "$USER_HOME" != /* || "$LAUNCH_AGENTS_DIR" != "$USER_HOME/Library/LaunchAgents" ]]; then
  echo "Could not resolve a safe per-user LaunchAgents directory." >&2
  exit 1
fi
if [[ ! -f "$TEMPLATE_PATH" || ! -x "$NODE_PATH" ]]; then
  echo "LaunchAgent template or Node.js runtime is missing." >&2
  exit 1
fi

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

repo_xml="$(xml_escape "$REPO_DIR")"
node_xml="$(xml_escape "$NODE_PATH")"
log_xml="$(xml_escape "$LOG_DIR")"
path_xml="$(xml_escape "$PATH_VALUE")"
staged_path="$(mktemp "${TMPDIR:-/tmp}/market-dashboard-launchagent.XXXXXX.plist")"
trap 'rm -f "$staged_path"' EXIT

sed \
  -e "s|__REPO_PATH__|${repo_xml}|g" \
  -e "s|__NODE_PATH__|${node_xml}|g" \
  -e "s|__LOG_PATH__|${log_xml}|g" \
  -e "s|__PATH_VALUE__|${path_xml}|g" \
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
