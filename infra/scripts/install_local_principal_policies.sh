#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
API_POLICY_PATH="${INFRA_DIR}/iam/local-readiness-catalog-policy.json"
BRIDGE_POLICY_PATH="${INFRA_DIR}/iam/local-bridge-policy.json"

MODE="verify"
ADMIN_PROFILE="${MARKET_DASHBOARD_AWS_ADMIN_PROFILE:-}"
ACCOUNT_ID="${MARKET_DASHBOARD_AWS_ACCOUNT_ID:-915328198276}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-west-1}}"
API_USER="${MARKET_DASHBOARD_API_IAM_USER:-market-dashboard-local}"
BRIDGE_USER="${MARKET_DASHBOARD_BRIDGE_IAM_USER:-market-dashboard-bridge}"
CREATE_BRIDGE_USER="false"

usage() {
  printf '%s\n' \
    "Usage: $0 [--verify | --apply] --admin-profile PROFILE [options]" \
    "" \
    "Install or verify the two intentionally separate least-privilege IAM policies." \
    "The dashboard API can query owned tables; the outbound bridge can only publish." \
    "" \
    "Options:" \
    "  --verify                    Read-only policy/simulation checks (default)" \
    "  --apply                     Put the inline policies, then verify them" \
    "  --admin-profile PROFILE     Administrator profile allowed to manage these users" \
    "  --account-id ID             Expected AWS account (default: ${ACCOUNT_ID})" \
    "  --region REGION             Expected AWS region (default: ${REGION})" \
    "  --api-user USER             Dashboard API IAM user (default: ${API_USER})" \
    "  --bridge-user USER          Dedicated bridge IAM user (default: ${BRIDGE_USER})" \
    "  --create-bridge-user        Create the dedicated bridge user if it is absent" \
    "  --help                      Show this help" \
    "" \
    "This script never creates access keys or edits local AWS credential files."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --verify)
      MODE="verify"
      shift
      ;;
    --apply)
      MODE="apply"
      shift
      ;;
    --admin-profile)
      ADMIN_PROFILE="${2:-}"
      shift 2
      ;;
    --account-id)
      ACCOUNT_ID="${2:-}"
      shift 2
      ;;
    --region)
      REGION="${2:-}"
      shift 2
      ;;
    --api-user)
      API_USER="${2:-}"
      shift 2
      ;;
    --bridge-user)
      BRIDGE_USER="${2:-}"
      shift 2
      ;;
    --create-bridge-user)
      CREATE_BRIDGE_USER="true"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$ADMIN_PROFILE" ]]; then
  echo "An explicit administrator profile is required via --admin-profile or MARKET_DASHBOARD_AWS_ADMIN_PROFILE." >&2
  exit 2
fi
if [[ ! "$ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
  echo "Expected a 12-digit AWS account ID, got: ${ACCOUNT_ID}" >&2
  exit 2
fi
if [[ ! "$REGION" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$ ]]; then
  echo "Invalid AWS region: ${REGION}" >&2
  exit 2
fi
if [[ ! -f "$API_POLICY_PATH" || ! -f "$BRIDGE_POLICY_PATH" ]]; then
  echo "Local IAM policy documents are missing." >&2
  exit 2
fi
if ! command -v aws >/dev/null 2>&1; then
  echo "AWS CLI is required." >&2
  exit 2
fi

CALLER_ACCOUNT="$(
  aws --profile "$ADMIN_PROFILE" --region "$REGION" sts get-caller-identity \
    --query Account --output text
)"
if [[ "$CALLER_ACCOUNT" != "$ACCOUNT_ID" ]]; then
  echo "Refusing to manage IAM in account ${CALLER_ACCOUNT}; expected ${ACCOUNT_ID}." >&2
  exit 3
fi

python3 - "$API_POLICY_PATH" "$BRIDGE_POLICY_PATH" "$ACCOUNT_ID" "$REGION" <<'PY'
import json
import pathlib
import sys

account, region = sys.argv[3], sys.argv[4]
for raw_path in sys.argv[1:3]:
    path = pathlib.Path(raw_path)
    policy = json.loads(path.read_text())
    if policy.get("Version") != "2012-10-17" or not policy.get("Statement"):
        raise SystemExit(f"{path}: invalid IAM policy document")
    for statement in policy["Statement"]:
        resources = statement.get("Resource", [])
        if isinstance(resources, str):
            resources = [resources]
        for resource in resources:
            if resource == "*":
                continue
            parts = resource.split(":")
            if len(parts) < 6 or parts[3] != region or parts[4] != account:
                raise SystemExit(
                    f"{path}: resource targets {resource}, expected account {account} in {region}"
                )
PY

ensure_user() {
  local user_name="$1"
  local may_create="$2"
  if aws --profile "$ADMIN_PROFILE" --region "$REGION" iam get-user \
      --user-name "$user_name" >/dev/null 2>&1; then
    return 0
  fi
  if [[ "$MODE" == "apply" && "$may_create" == "true" ]]; then
    aws --profile "$ADMIN_PROFILE" --region "$REGION" iam create-user \
      --user-name "$user_name" >/dev/null
    echo "Created dedicated IAM user ${user_name} (no access key was created)."
    return 0
  fi
  echo "IAM user ${user_name} does not exist." >&2
  if [[ "$may_create" != "true" ]]; then
    echo "Create a separate bridge user explicitly with --apply --create-bridge-user." >&2
  fi
  exit 4
}

install_or_check_policy() {
  local user_name="$1"
  local policy_name="$2"
  local policy_path="$3"

  if [[ "$MODE" == "apply" ]]; then
    aws --profile "$ADMIN_PROFILE" --region "$REGION" iam put-user-policy \
      --user-name "$user_name" \
      --policy-name "$policy_name" \
      --policy-document "file://${policy_path}"
    echo "Applied ${policy_name} to ${user_name}."
  fi

  aws --profile "$ADMIN_PROFILE" --region "$REGION" iam get-user-policy \
    --user-name "$user_name" \
    --policy-name "$policy_name" >/dev/null
}

simulate_statement_access() {
  local user_name="$1"
  local policy_path="$2"
  local principal_arn="arn:aws:iam::${ACCOUNT_ID}:user/${user_name}"
  local failure_count=0

  while IFS=$'\t' read -r action resource; do
    [[ -n "$action" && -n "$resource" ]] || continue
    local decision
    decision="$(
      aws --profile "$ADMIN_PROFILE" --region "$REGION" iam simulate-principal-policy \
        --policy-source-arn "$principal_arn" \
        --action-names "$action" \
        --resource-arns "$resource" \
        --query 'EvaluationResults[0].EvalDecision' \
        --output text
    )"
    if [[ "$decision" != "allowed" ]]; then
      echo "DENIED ${user_name}: ${action} on ${resource} (${decision})" >&2
      failure_count=$((failure_count + 1))
    fi
  done < <(
    python3 - "$policy_path" <<'PY'
import json
import sys

policy = json.load(open(sys.argv[1]))
for statement in policy["Statement"]:
    actions = statement["Action"]
    resources = statement["Resource"]
    if isinstance(actions, str):
        actions = [actions]
    if isinstance(resources, str):
        resources = [resources]
    for action in actions:
        for resource in resources:
            print(f"{action}\t{resource}")
PY
  )

  if [[ "$failure_count" -gt 0 ]]; then
    return 1
  fi
  echo "Verified ${user_name}: every required action/resource pair is allowed."
}

ensure_user "$API_USER" "false"
ensure_user "$BRIDGE_USER" "$CREATE_BRIDGE_USER"

install_or_check_policy \
  "$API_USER" \
  "MarketDashboardLocalReadinessCatalog" \
  "$API_POLICY_PATH"
install_or_check_policy \
  "$BRIDGE_USER" \
  "MarketDashboardLocalSnapshotBridge" \
  "$BRIDGE_POLICY_PATH"

simulate_statement_access "$API_USER" "$API_POLICY_PATH"
simulate_statement_access "$BRIDGE_USER" "$BRIDGE_POLICY_PATH"

printf '%s\n' \
  "IAM ${MODE} completed for account ${ACCOUNT_ID} in ${REGION}." \
  "Configure the API with its ${API_USER} credentials." \
  "Configure HERMES_BRIDGE_AWS_PROFILE with credentials for ${BRIDGE_USER}; do not reuse the API principal."
