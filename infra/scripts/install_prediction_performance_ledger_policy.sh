#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
POLICY_PATH="${INFRA_DIR}/iam/local-prediction-performance-ledger-policy.json"
VALIDATOR_PATH="${SCRIPT_DIR}/validate_local_iam_policy.py"
ACCOUNT_ID="915328198276"
REGION="us-west-1"
ADMIN_PROFILE="market-dashboard-admin"
USER_NAME="market-dashboard-local"
POLICY_NAME="MarketDashboardPredictionPerformanceLedger"
POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${POLICY_NAME}"
TABLE_ARN="arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/PredictionMarketPerformanceLedger"
OWNER_TAG="market-dashboard-prediction-performance-v1"
PURPOSE_TAG="local-ledger-access"
MODE="verify"

usage() {
  printf '%s\n' "Usage: $0 [--verify | --apply]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --verify) MODE="verify"; shift ;;
    --apply) MODE="apply"; shift ;;
    --help|-h) usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

run_aws() {
  env \
    -u AWS_ACCESS_KEY_ID \
    -u AWS_SECRET_ACCESS_KEY \
    -u AWS_SESSION_TOKEN \
    -u AWS_SECURITY_TOKEN \
    -u AWS_PROFILE \
    -u AWS_DEFAULT_PROFILE \
    -u AWS_ROLE_ARN \
    -u AWS_ROLE_SESSION_NAME \
    -u AWS_WEB_IDENTITY_TOKEN_FILE \
    -u AWS_CONTAINER_CREDENTIALS_RELATIVE_URI \
    -u AWS_CONTAINER_CREDENTIALS_FULL_URI \
    -u AWS_CONTAINER_AUTHORIZATION_TOKEN \
    -u AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE \
    -u AWS_SHARED_CREDENTIALS_FILE \
    -u AWS_CONFIG_FILE \
    AWS_EC2_METADATA_DISABLED=true \
    AWS_PAGER="" \
    AWS_CLI_AUTO_PROMPT=off \
    aws --profile "$ADMIN_PROFILE" --region "$REGION" "$@"
}

identity="$(run_aws sts get-caller-identity --query '[Account,Arn]' --output text)"
IFS=$'\t' read -r caller_account caller_arn <<< "$identity"
if [[ "$caller_account" != "$ACCOUNT_ID" ]]; then
  echo "Refusing account ${caller_account:-unknown}; expected ${ACCOUNT_ID}." >&2
  exit 2
fi
case "$caller_arn" in
  "arn:aws:sts::${ACCOUNT_ID}:assumed-role/AWSReservedSSO_"*/*) ;;
  *)
    echo "The administrator profile must resolve to an IAM Identity Center role." >&2
    exit 2
    ;;
esac

python3 "$VALIDATOR_PATH" --account "$ACCOUNT_ID" --region "$REGION" "$POLICY_PATH"
table_state="$(
  run_aws dynamodb describe-table \
    --table-name PredictionMarketPerformanceLedger \
    --query 'Table.[TableStatus,DeletionProtectionEnabled]' \
    --output text
)"
if [[ "$table_state" != "ACTIVE"$'\t'"True" ]]; then
  echo "Ledger table is not active and deletion-protected." >&2
  exit 3
fi
run_aws iam get-user --user-name "$USER_NAME" >/dev/null

policy_exists="true"
if ! run_aws iam get-policy --policy-arn "$POLICY_ARN" >/dev/null 2>&1; then
  policy_exists="false"
fi
if [[ "$policy_exists" == "false" ]]; then
  if [[ "$MODE" != "apply" ]]; then
    echo "Managed policy ${POLICY_NAME} does not exist." >&2
    exit 3
  fi
  run_aws iam create-policy \
    --policy-name "$POLICY_NAME" \
    --description "Least-privilege local API access to the verified prediction performance ledger" \
    --policy-document "file://${POLICY_PATH}" \
    --tags \
      "Key=market-dashboard:owner,Value=${OWNER_TAG}" \
      "Key=market-dashboard:purpose,Value=${PURPOSE_TAG}" >/dev/null
fi

default_version="$(
  run_aws iam get-policy \
    --policy-arn "$POLICY_ARN" \
    --query 'Policy.DefaultVersionId' \
    --output text
)"
installed_document="$(
  run_aws iam get-policy-version \
    --policy-arn "$POLICY_ARN" \
    --version-id "$default_version" \
    --query 'PolicyVersion.Document' \
    --output json
)"
documents_match() {
  python3 - "$POLICY_PATH" "$installed_document" <<'PY'
import json
import pathlib
import sys
import urllib.parse

expected = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
installed = json.loads(sys.argv[2])
if isinstance(installed, str):
    installed = json.loads(urllib.parse.unquote(installed))

def canonical(value):
    if isinstance(value, dict):
        return {key: canonical(item) for key, item in sorted(value.items())}
    if isinstance(value, list):
        return sorted(
            (canonical(item) for item in value),
            key=lambda item: json.dumps(item, sort_keys=True, separators=(",", ":")),
        )
    return value

raise SystemExit(0 if canonical(expected) == canonical(installed) else 1)
PY
}

if ! documents_match; then
  if [[ "$MODE" != "apply" ]]; then
    echo "Managed policy ${POLICY_NAME} does not match ${POLICY_PATH}." >&2
    exit 3
  fi
  version_count="$(
    run_aws iam list-policy-versions \
      --policy-arn "$POLICY_ARN" \
      --query 'length(Versions)' \
      --output text
  )"
  if [[ "$version_count" -ge 5 ]]; then
    oldest_version="$(
      run_aws iam list-policy-versions \
        --policy-arn "$POLICY_ARN" \
        --query 'sort_by(Versions[?IsDefaultVersion==`false`], &CreateDate)[0].VersionId' \
        --output text
    )"
    run_aws iam delete-policy-version \
      --policy-arn "$POLICY_ARN" \
      --version-id "$oldest_version"
  fi
  run_aws iam create-policy-version \
    --policy-arn "$POLICY_ARN" \
    --policy-document "file://${POLICY_PATH}" \
    --set-as-default >/dev/null
fi

if [[ "$MODE" == "apply" ]]; then
  run_aws iam attach-user-policy \
    --user-name "$USER_NAME" \
    --policy-arn "$POLICY_ARN"
fi

tags="$(run_aws iam list-policy-tags --policy-arn "$POLICY_ARN" --output json)"
entities="$(run_aws iam list-entities-for-policy --policy-arn "$POLICY_ARN" --output json)"
python3 - "$OWNER_TAG" "$PURPOSE_TAG" "$USER_NAME" "$tags" "$entities" <<'PY'
import json
import sys

owner, purpose, user, raw_tags, raw_entities = sys.argv[1:]
tags = {item["Key"]: item["Value"] for item in json.loads(raw_tags).get("Tags", [])}
if tags != {
    "market-dashboard:owner": owner,
    "market-dashboard:purpose": purpose,
}:
    raise SystemExit("Managed policy ownership tags do not match.")
entities = json.loads(raw_entities)
users = {item["UserName"] for item in entities.get("PolicyUsers", [])}
if users != {user} or entities.get("PolicyGroups") or entities.get("PolicyRoles"):
    raise SystemExit("Managed policy is not attached exclusively to the local API user.")
PY

item_simulation="$(
  run_aws iam simulate-principal-policy \
    --policy-source-arn "arn:aws:iam::${ACCOUNT_ID}:user/${USER_NAME}" \
    --action-names \
      dynamodb:GetItem \
      dynamodb:PutItem \
      dynamodb:Query \
      dynamodb:UpdateItem \
      dynamodb:DeleteItem \
      dynamodb:Scan \
    --resource-arns "$TABLE_ARN" \
    --query 'EvaluationResults[].{Action:EvalActionName,Decision:EvalDecision}' \
    --output json
)"
transaction_simulation="$(
  run_aws iam simulate-principal-policy \
    --policy-source-arn "arn:aws:iam::${ACCOUNT_ID}:user/${USER_NAME}" \
    --action-names dynamodb:TransactWriteItems \
    --resource-arns "$TABLE_ARN" \
    --query 'EvaluationResults[].{Action:EvalActionName,Decision:EvalDecision}' \
    --output json
)"
python3 - "$item_simulation" "$transaction_simulation" <<'PY'
import json
import sys

results = {
    item["Action"]: item["Decision"]
    for raw_payload in sys.argv[1:]
    for item in json.loads(raw_payload)
}
allowed = {
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:Query",
    "dynamodb:UpdateItem",
    "dynamodb:TransactWriteItems",
}
for action, decision in results.items():
    expected = "allowed" if action in allowed else "implicitDeny"
    if decision != expected:
        raise SystemExit(f"Unexpected simulation result for {action}: {decision}")
PY

echo "Prediction performance ledger IAM ${MODE} passed for ${USER_NAME}."
