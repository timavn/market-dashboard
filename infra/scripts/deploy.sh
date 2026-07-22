#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${INFRA_DIR}/.." && pwd)"

if ! command -v sam >/dev/null 2>&1; then
  echo "AWS SAM CLI is required. Install it, then rerun this command." >&2
  exit 1
fi

if [[ -z "${MARKET_DASHBOARD_CF_ROLE_ARN:-}" ]]; then
  echo "Set MARKET_DASHBOARD_CF_ROLE_ARN to the bootstrapped CloudFormation execution role." >&2
  exit 1
fi

gmail_state="${GMAIL_SCHEDULE_STATE:-DISABLED}"
analyst_state="${HERMES_QUANT_ANALYST_SCHEDULE_STATE:-${HERMES_SCHEDULE_STATE:-DISABLED}}"
developer_state="${HERMES_QUANT_DEVELOPER_SCHEDULE_STATE:-${HERMES_SCHEDULE_STATE:-DISABLED}}"
security_state="${HERMES_SECURITY_SCHEDULE_STATE:-${HERMES_SCHEDULE_STATE:-DISABLED}}"
alarm_state="${OPERATIONAL_ALARMS_STATE:-DISABLED}"
build_version="${MARKET_DASHBOARD_BUILD_VERSION:-$(node -p "require('${REPO_DIR}/package.json').version")}"

for state in "$gmail_state" "$analyst_state" "$developer_state" "$security_state" "$alarm_state"; do
  if [[ "$state" != "ENABLED" && "$state" != "DISABLED" ]]; then
    echo "Schedule/alarm states must be ENABLED or DISABLED." >&2
    exit 1
  fi
done

python3 "${SCRIPT_DIR}/render_hermes_contract.py" --check

cd "$INFRA_DIR"
sam validate --lint --template-file template.yaml
sam build --template-file template.yaml
sam deploy \
  --config-file samconfig.toml \
  --role-arn "$MARKET_DASHBOARD_CF_ROLE_ARN" \
  --parameter-overrides \
    "GmailScheduleState=${gmail_state}" \
    "QuantAnalystScheduleState=${analyst_state}" \
    "QuantDeveloperScheduleState=${developer_state}" \
    "SecurityScheduleState=${security_state}" \
    "OperationalAlarmsState=${alarm_state}" \
    "BuildVersion=${build_version}"
