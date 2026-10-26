#!/usr/bin/env bash
# Install (or with --uninstall, remove) the LaunchAgent that runs
# scripts/ops/nightly_backup.sh every night at 23:30 local time.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
LABEL="com.market-dashboard.nightly-backup"
TEMPLATE_PATH="${REPO_DIR}/ops/launchd/${LABEL}.plist.template"
USER_ID="$(id -u)"
USER_NAME="$(id -un)"
USER_HOME="$(dscl . -read "/Users/${USER_NAME}" NFSHomeDirectory | awk '{print $2}')"
LAUNCH_AGENTS_DIR="${USER_HOME}/Library/LaunchAgents"
TARGET_PATH="${LAUNCH_AGENTS_DIR}/${LABEL}.plist"
LOG_DIR="${USER_HOME}/Library/Logs/market-dashboard"
NODE_PATH="$(command -v node || true)"

if [[ "$USER_HOME" != /* || "$LAUNCH_AGENTS_DIR" != "$USER_HOME/Library/LaunchAgents" ]]; then
  echo "Could not resolve a safe per-user LaunchAgents directory." >&2
  exit 1
fi
if [[ -f "$TARGET_PATH" ]]; then
  existing_label="$(/usr/libexec/PlistBuddy -c 'Print :Label' "$TARGET_PATH" 2>/dev/null || true)"
  if [[ "$existing_label" != "$LABEL" ]]; then
    echo "Refusing to touch an unrelated LaunchAgent at ${TARGET_PATH}." >&2
    exit 1
  fi
fi

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/${USER_ID}" "$TARGET_PATH" >/dev/null 2>&1 || true
  rm -f "$TARGET_PATH"
  echo "Nightly backup LaunchAgent removed."
  exit 0
fi
if [[ ! -f "$TEMPLATE_PATH" || ! -f "${REPO_DIR}/scripts/ops/nightly_backup.sh" || ! -x "$NODE_PATH" ]]; then
  echo "LaunchAgent template, nightly_backup.sh, or Node.js runtime is missing." >&2
  exit 1
fi

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

repo_xml="$(xml_escape "$REPO_DIR")"
log_xml="$(xml_escape "$LOG_DIR")"
node_xml="$(xml_escape "$NODE_PATH")"
staged_path="$(mktemp "${TMPDIR:-/tmp}/market-dashboard-nightly-backup.XXXXXX.plist")"
trap 'rm -f "$staged_path"' EXIT

sed \
  -e "s|__REPO_PATH__|${repo_xml}|g" \
  -e "s|__LOG_PATH__|${log_xml}|g" \
  -e "s|__NODE_PATH__|${node_xml}|g" \
  "$TEMPLATE_PATH" > "$staged_path"

plutil -lint "$staged_path" >/dev/null
mkdir -p "$LAUNCH_AGENTS_DIR" "$LOG_DIR"
launchctl bootout "gui/${USER_ID}" "$TARGET_PATH" >/dev/null 2>&1 || true
install -m 600 "$staged_path" "$TARGET_PATH"
launchctl bootstrap "gui/${USER_ID}" "$TARGET_PATH"

echo "Nightly backup LaunchAgent installed (runs daily at 23:30)."
echo "Log: ${LOG_DIR}/nightly-backup.log"
echo "Run it now: launchctl kickstart gui/${USER_ID}/${LABEL}"
