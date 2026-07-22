#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
USER_ID="$(id -u)"
USER_NAME="$(id -un)"
USER_HOME="$(dscl . -read "/Users/${USER_NAME}" NFSHomeDirectory | awk '{print $2}')"
LEGACY_PATH="${USER_HOME}/Library/LaunchAgents/com.hedgeye.riskrange.scraper.plist"
ARCHIVE_DIR="${USER_HOME}/Library/LaunchAgents/market-dashboard-retired"

if [[ "$USER_HOME" != /* || "$LEGACY_PATH" != "$USER_HOME/Library/LaunchAgents/com.hedgeye.riskrange.scraper.plist" ]]; then
  echo "Could not resolve the expected legacy LaunchAgent path safely." >&2
  exit 1
fi

# Retirement is intentionally gated on the four-poll Gmail observation window.
"${REPO_DIR}/infra/scripts/verify_rollout.py" --phase gmail >/dev/null

if [[ ! -f "$LEGACY_PATH" ]]; then
  echo "Legacy Risk Range LaunchAgent is already absent."
  exit 0
fi

legacy_label="$(/usr/libexec/PlistBuddy -c 'Print :Label' "$LEGACY_PATH" 2>/dev/null || true)"
if [[ "$legacy_label" != "com.hedgeye.riskrange.scraper" ]]; then
  echo "Refusing to retire a plist whose label does not match the known legacy job." >&2
  exit 1
fi

launchctl bootout "gui/${USER_ID}" "$LEGACY_PATH" >/dev/null 2>&1 || true
mkdir -p "$ARCHIVE_DIR"
archive_path="${ARCHIVE_DIR}/com.hedgeye.riskrange.scraper.$(date -u +%Y%m%dT%H%M%SZ).plist"
mv "$LEGACY_PATH" "$archive_path"
echo "Legacy scraper unloaded and archived at ${archive_path}. It can be restored from that file."
