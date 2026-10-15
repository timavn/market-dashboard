#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMPLATE_PATH="${INFRA_DIR}/prediction-market-performance-ledger.yaml"
STACK_NAME="market-dashboard-prediction-performance-v1"
LOGICAL_RESOURCE_ID="PredictionMarketPerformanceLedger"
EXPECTED_ACCOUNT_ID="915328198276"
EXPECTED_REGION="us-west-1"
EXPECTED_PROFILE="market-dashboard-admin"
EXECUTION_ROLE_ARN="arn:aws:iam::${EXPECTED_ACCOUNT_ID}:role/market-dashboard-cloudformation-deployment-v2"
MODE="plan"

usage() {
  printf '%s\n' \
    "Usage: $0 [--plan | --apply]" \
    "" \
    "Creates an inspected CloudFormation change set for the dedicated" \
    "prediction-market performance ledger stack. --plan is the default."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan)
      MODE="plan"
      shift
      ;;
    --apply)
      MODE="apply"
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

identity="$(
  AWS_PAGER='' aws sts get-caller-identity \
    --profile "$EXPECTED_PROFILE" \
    --region "$EXPECTED_REGION" \
    --query '[Account,Arn]' \
    --output text
)"
IFS=$'\t' read -r caller_account caller_arn <<< "$identity"
if [[ "$caller_account" != "$EXPECTED_ACCOUNT_ID" ]]; then
  echo "Refusing AWS account ${caller_account:-unknown}; expected ${EXPECTED_ACCOUNT_ID}." >&2
  exit 2
fi
case "$caller_arn" in
  "arn:aws:sts::${EXPECTED_ACCOUNT_ID}:assumed-role/AWSReservedSSO_"*/*) ;;
  *)
    echo "The deployment profile must resolve to the configured IAM Identity Center administrator role." >&2
    exit 2
    ;;
esac

change_type="CREATE"
stack_status="$(
  AWS_PAGER='' aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --profile "$EXPECTED_PROFILE" \
    --region "$EXPECTED_REGION" \
    --query 'Stacks[0].StackStatus' \
    --output text 2>/dev/null || true
)"
if [[ -n "$stack_status" && "$stack_status" != "None" && "$stack_status" != "REVIEW_IN_PROGRESS" ]]; then
  change_type="UPDATE"
fi

change_set_name="prediction-performance-$(date -u +%Y%m%dT%H%M%SZ)-$$"
change_set_id="$(
  AWS_PAGER='' aws cloudformation create-change-set \
    --stack-name "$STACK_NAME" \
    --change-set-name "$change_set_name" \
    --change-set-type "$change_type" \
    --description "Dedicated verified prediction-contract performance ledger" \
    --template-body "file://${TEMPLATE_PATH}" \
    --role-arn "$EXECUTION_ROLE_ARN" \
    --tags \
      Key=market-dashboard:owner,Value=prediction-performance-ledger \
      Key=market-dashboard:purpose,Value=verified-contract-performance \
    --profile "$EXPECTED_PROFILE" \
    --region "$EXPECTED_REGION" \
    --query Id \
    --output text
)"

if ! AWS_PAGER='' aws cloudformation wait change-set-create-complete \
  --change-set-name "$change_set_id" \
  --stack-name "$STACK_NAME" \
  --profile "$EXPECTED_PROFILE" \
  --region "$EXPECTED_REGION"; then
  reason="$(
    AWS_PAGER='' aws cloudformation describe-change-set \
      --change-set-name "$change_set_id" \
      --stack-name "$STACK_NAME" \
      --profile "$EXPECTED_PROFILE" \
      --region "$EXPECTED_REGION" \
      --query StatusReason \
      --output text
  )"
  if [[ "$reason" == *"didn't contain changes"* ]]; then
    echo "Prediction-market performance ledger stack already matches the template."
    exit 0
  fi
  echo "Change set failed: $reason" >&2
  exit 1
fi

changes="$(
  AWS_PAGER='' aws cloudformation describe-change-set \
    --change-set-name "$change_set_id" \
    --stack-name "$STACK_NAME" \
    --profile "$EXPECTED_PROFILE" \
    --region "$EXPECTED_REGION" \
    --query Changes \
    --output json
)"
python3 - "$LOGICAL_RESOURCE_ID" "$changes" <<'PY'
import json
import sys

logical_id, raw_changes = sys.argv[1:]
changes = json.loads(raw_changes)
if not changes:
    raise SystemExit("The change set unexpectedly contains no resource changes.")
for change in changes:
    resource = change.get("ResourceChange") or {}
    if resource.get("LogicalResourceId") != logical_id:
        raise SystemExit(f"Unexpected resource in change set: {resource.get('LogicalResourceId')}")
    if resource.get("ResourceType") != "AWS::DynamoDB::Table":
        raise SystemExit(f"Unexpected resource type: {resource.get('ResourceType')}")
    if resource.get("Action") not in {"Add", "Modify"}:
        raise SystemExit(f"Unsafe resource action: {resource.get('Action')}")
    if resource.get("Replacement") == "True":
        raise SystemExit("Refusing a change set that would replace the retained ledger table.")
PY

printf '%s\n' "$changes"
if [[ "$MODE" == "plan" ]]; then
  echo "Change set ${change_set_id} is ready and has not been executed."
  exit 0
fi

AWS_PAGER='' aws cloudformation execute-change-set \
  --change-set-name "$change_set_id" \
  --stack-name "$STACK_NAME" \
  --profile "$EXPECTED_PROFILE" \
  --region "$EXPECTED_REGION"

if [[ "$change_type" == "CREATE" ]]; then
  AWS_PAGER='' aws cloudformation wait stack-create-complete \
    --stack-name "$STACK_NAME" \
    --profile "$EXPECTED_PROFILE" \
    --region "$EXPECTED_REGION"
else
  AWS_PAGER='' aws cloudformation wait stack-update-complete \
    --stack-name "$STACK_NAME" \
    --profile "$EXPECTED_PROFILE" \
    --region "$EXPECTED_REGION"
fi

AWS_PAGER='' aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --profile "$EXPECTED_PROFILE" \
  --region "$EXPECTED_REGION" \
  --query 'Stacks[0].{Status:StackStatus,Outputs:Outputs}' \
  --output json
