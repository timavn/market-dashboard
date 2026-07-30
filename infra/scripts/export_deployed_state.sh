#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
EXPECTED_ACCOUNT_ID="915328198276"
EXPECTED_REGION="us-west-1"
EXPECTED_ADMIN_PROFILE="market-dashboard-admin"
BOOTSTRAP_STACK_NAME="market-dashboard-deployment-role-v2"
DEPLOYMENT_ROLE_NAME="market-dashboard-cloudformation-deployment-v2"
DEPLOYMENT_ROLE_POLICY_NAME="market-dashboard-readiness-deployment"
ADMIN_PROFILE="${MARKET_DASHBOARD_AWS_ADMIN_PROFILE:-market-dashboard-admin}"

usage() {
  echo "Usage: $0 [--admin-profile PROFILE] /absolute/path/to/new-rollback-directory" >&2
}

if [[ "${1:-}" == "--admin-profile" ]]; then
  if [[ $# -lt 3 || -z "${2:-}" ]]; then
    usage
    exit 2
  fi
  ADMIN_PROFILE="$2"
  shift 2
fi
if [[ $# -ne 1 || "$1" != /* ]]; then
  usage
  exit 2
fi

OUTPUT_DIR="$(
  python3 - "$1" <<'PY'
import pathlib
import sys

print(pathlib.Path(sys.argv[1]).resolve(strict=False))
PY
)"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$EXPECTED_REGION}}"
STACK_NAME="market-dashboard-readiness-v2"
CANONICAL_FUNCTION_NAMES="market-dashboard-gmail-ingestor-v2,market-dashboard-hedgeye-pdf-processor-v1,market-dashboard-hermes-worker-v2,market-dashboard-hermes-cloud-watchdog-v1"
CANONICAL_SCHEDULE_NAMES="market-dashboard-gmail-v2-every-15m,market-dashboard-hermes-quant-analyst-v2,market-dashboard-hermes-quant-developer-v2,market-dashboard-hermes-security-v2"
CANONICAL_EVENT_RULE_NAMES="market-dashboard-hermes-cloud-watchdog-v1"
merge_csv_names() {
  python3 - "$1" "$2" <<'PY'
import sys

values = []
for raw in sys.argv[1:]:
    for value in raw.split(","):
        value = value.strip()
        if value and value not in values:
            values.append(value)
print(",".join(values))
PY
}
FUNCTION_NAMES="$(
  merge_csv_names \
    "$CANONICAL_FUNCTION_NAMES" \
    "${MARKET_DASHBOARD_EXPORT_FUNCTIONS:-}"
)"
SCHEDULE_NAMES="$(
  merge_csv_names \
    "$CANONICAL_SCHEDULE_NAMES" \
    "${MARKET_DASHBOARD_EXPORT_SCHEDULES:-}"
)"
EVENT_RULE_NAMES="$(
  merge_csv_names \
    "$CANONICAL_EVENT_RULE_NAMES" \
    "${MARKET_DASHBOARD_EXPORT_EVENT_RULES:-}"
)"
TABLE_NAMES="MarketDashboardServiceHeartbeats,HermesInputSnapshots,ResearchEventLedgerV2,ResearchEntityEventsV1,ResearchProductManifestsV1,PredictionMarketCatalogV2,RiskRangePublicationManifestsV2"
EXTERNAL_TABLE_NAMES="HermesEmailIngestLedger,HedgeyeDailySnapshot,HedgeyeRiskRanges,RiskRangeData,HermesAgentRuns,HermesAlerts"
REQUIRED_EXTERNAL_TABLE_NAMES="HermesEmailIngestLedger,HedgeyeDailySnapshot"
ABSENT_STATUS=42

python3 - "$FUNCTION_NAMES" "$SCHEDULE_NAMES" "$EVENT_RULE_NAMES" <<'PY'
import re
import sys

function_names, schedule_names, event_rule_names = sys.argv[1:]
patterns = (
    ("Lambda", function_names, re.compile(r"^[A-Za-z0-9_-]{1,64}$")),
    ("Scheduler", schedule_names, re.compile(r"^[A-Za-z0-9_.-]{1,64}$")),
    ("EventBridge rule", event_rule_names, re.compile(r"^[A-Za-z0-9_.-]{1,64}$")),
)
for kind, raw_names, pattern in patterns:
    for name in raw_names.split(","):
        if name and pattern.fullmatch(name) is None:
            raise SystemExit(f"Unsafe {kind} resource name in rollback inventory.")
PY

if [[ -n "${MARKET_DASHBOARD_STACK_NAME:-}" && "$MARKET_DASHBOARD_STACK_NAME" != "$STACK_NAME" ]]; then
  echo "Rollback export is pinned to stack ${STACK_NAME}." >&2
  exit 2
fi
if [[ "$REGION" != "$EXPECTED_REGION" ]]; then
  echo "Rollback export is pinned to region ${EXPECTED_REGION}; got ${REGION}." >&2
  exit 2
fi
if [[ "$ADMIN_PROFILE" != "$EXPECTED_ADMIN_PROFILE" ]]; then
  echo "Rollback export requires the ${EXPECTED_ADMIN_PROFILE} SSO profile." >&2
  exit 2
fi

case "$OUTPUT_DIR" in
  "$REPO_ROOT"|"$REPO_ROOT"/*)
    echo "Rollback directory must be outside the repository: $REPO_ROOT" >&2
    exit 2
    ;;
esac
if [[ -e "$OUTPUT_DIR" ]]; then
  echo "Refusing to overwrite existing rollback directory: $OUTPUT_DIR" >&2
  exit 1
fi
for command_name in aws curl python3 shasum; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "${command_name} is required." >&2
    exit 1
  fi
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
    aws "$@"
}

export_aws() {
  run_aws --profile "$ADMIN_PROFILE" --region "$REGION" "$@"
}

AWS_CLI_VERSION="$(run_aws --version 2>&1)"
if [[ ! "$AWS_CLI_VERSION" =~ ^aws-cli/2\. ]]; then
  echo "AWS CLI v2 is required; found: ${AWS_CLI_VERSION}" >&2
  exit 2
fi

PROFILE_REGION="$(
  run_aws configure get region --profile "$ADMIN_PROFILE" 2>/dev/null || true
)"
PROFILE_ACCOUNT="$(
  run_aws configure get sso_account_id --profile "$ADMIN_PROFILE" 2>/dev/null || true
)"
SSO_SESSION="$(
  run_aws configure get sso_session --profile "$ADMIN_PROFILE" 2>/dev/null || true
)"
SSO_START_URL="$(
  run_aws configure get sso_start_url --profile "$ADMIN_PROFILE" 2>/dev/null || true
)"
SSO_ROLE_NAME="$(
  run_aws configure get sso_role_name --profile "$ADMIN_PROFILE" 2>/dev/null || true
)"
if [[ "$PROFILE_REGION" != "$EXPECTED_REGION" || "$PROFILE_ACCOUNT" != "$EXPECTED_ACCOUNT_ID" ]]; then
  echo "Profile ${ADMIN_PROFILE} must be an SSO profile for account ${EXPECTED_ACCOUNT_ID} in ${EXPECTED_REGION}." >&2
  exit 2
fi
if [[ -z "$SSO_ROLE_NAME" || ( -z "$SSO_SESSION" && -z "$SSO_START_URL" ) ]]; then
  echo "Profile ${ADMIN_PROFILE} is not configured for AWS IAM Identity Center/SSO." >&2
  exit 2
fi

is_safely_absent_error() {
  local service="$1"
  local operation="$2"
  local stderr_path="$3"

  python3 - "$service" "$operation" "$stderr_path" <<'PY'
import pathlib
import re
import sys

service, operation, raw_path = sys.argv[1:]
message = pathlib.Path(raw_path).read_text(encoding="utf-8", errors="replace")
match = re.search(r"An error occurred \(([^)]+)\)", message)
code = match.group(1) if match else ""

if service in {"lambda", "scheduler", "events", "dynamodb"} and code == "ResourceNotFoundException":
    raise SystemExit(0)
if service == "iam" and code == "NoSuchEntity":
    raise SystemExit(0)
if (
    service == "cloudformation"
    and operation == "describe-stacks"
    and code == "ValidationError"
    and re.search(r"\b(stack\b.*?)?\bdoes not exist\b", message, flags=re.IGNORECASE)
):
    raise SystemExit(0)
raise SystemExit(1)
PY
}

write_absent_marker() {
  local marker_path="$1"
  local service="$2"
  local operation="$3"
  local resource_name="$4"
  local stderr_path="$5"

  python3 - "$service" "$operation" "$resource_name" "$stderr_path" > "$marker_path" <<'PY'
import json
import pathlib
import re
import sys

service, operation, resource_name, raw_path = sys.argv[1:]
message = pathlib.Path(raw_path).read_text(encoding="utf-8", errors="replace").strip()
match = re.search(r"An error occurred \(([^)]+)\)", message)
json.dump(
    {
        "classification": "safely-absent",
        "service": service,
        "operation": operation,
        "resource": resource_name,
        "awsErrorCode": match.group(1) if match else None,
        "awsError": message,
    },
    sys.stdout,
    indent=2,
    sort_keys=True,
)
sys.stdout.write("\n")
PY
}

capture_aws_json() {
  local output_path="$1"
  local stderr_path="$2"
  local absent_marker_path="$3"
  local service="$4"
  local operation="$5"
  local resource_name="$6"
  shift 6

  local command_status
  if "$@" > "$output_path" 2> "$stderr_path"; then
    rm -f "$stderr_path"
    return 0
  else
    command_status=$?
  fi

  rm -f "$output_path"
  if is_safely_absent_error "$service" "$operation" "$stderr_path"; then
    write_absent_marker \
      "$absent_marker_path" \
      "$service" \
      "$operation" \
      "$resource_name" \
      "$stderr_path"
    rm -f "$stderr_path"
    echo "Recorded safely absent ${service} resource: ${resource_name}"
    return "$ABSENT_STATUS"
  fi

  echo "Rollback export failed during ${service} ${operation} for ${resource_name}." >&2
  cat "$stderr_path" >&2
  echo "AWS command exited with status ${command_status}; partial export remains private at ${OUTPUT_DIR}." >&2
  return 1
}

umask 077
mkdir -p \
  "$OUTPUT_DIR/account-inventory" \
  "$OUTPUT_DIR/functions" \
  "$OUTPUT_DIR/schedules" \
  "$OUTPUT_DIR/event-rules" \
  "$OUTPUT_DIR/tables" \
  "$OUTPUT_DIR/external-tables" \
  "$OUTPUT_DIR/bootstrap" \
  "$OUTPUT_DIR/bootstrap/deployment-role"
chmod 700 \
  "$OUTPUT_DIR" \
  "$OUTPUT_DIR/account-inventory" \
  "$OUTPUT_DIR/functions" \
  "$OUTPUT_DIR/schedules" \
  "$OUTPUT_DIR/event-rules" \
  "$OUTPUT_DIR/tables" \
  "$OUTPUT_DIR/external-tables" \
  "$OUTPUT_DIR/bootstrap" \
  "$OUTPUT_DIR/bootstrap/deployment-role"
export_aws sts get-caller-identity --output json > "$OUTPUT_DIR/caller-identity.json"
CALLER_ACCOUNT="$(
  python3 -c \
    'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["Account"])' \
    "$OUTPUT_DIR/caller-identity.json"
)"
CALLER_ARN="$(
  python3 -c \
    'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["Arn"])' \
    "$OUTPUT_DIR/caller-identity.json"
)"
if [[ "$CALLER_ACCOUNT" != "$EXPECTED_ACCOUNT_ID" ]]; then
  echo "Refusing rollback export from account ${CALLER_ACCOUNT:-unknown}; expected ${EXPECTED_ACCOUNT_ID}." >&2
  exit 2
fi
if [[ ! "$CALLER_ARN" =~ ^arn:aws:sts::${EXPECTED_ACCOUNT_ID}:assumed-role/AWSReservedSSO_[^/]+/.+$ ]]; then
  echo "Refusing rollback export with non-SSO identity: ${CALLER_ARN:-unknown}." >&2
  exit 2
fi

if ! capture_aws_json \
    "$OUTPUT_DIR/account-inventory/lambda-functions.json" \
    "$OUTPUT_DIR/account-inventory/lambda-functions.stderr" \
    "$OUTPUT_DIR/account-inventory/lambda-functions.absent.json" \
    "lambda" \
    "list-functions" \
    "$EXPECTED_ACCOUNT_ID" \
    export_aws lambda list-functions \
      --region "$REGION" \
      --page-size 50 \
      --query \
        'Functions[].{FunctionName:FunctionName,FunctionArn:FunctionArn,Runtime:Runtime,Role:Role,LastModified:LastModified,State:State,PackageType:PackageType}' \
      --output json; then
  echo "Account-wide Lambda inventory is mandatory; safely-absent is not valid for list-functions." >&2
  exit 1
fi

if ! capture_aws_json \
    "$OUTPUT_DIR/account-inventory/schedules.json" \
    "$OUTPUT_DIR/account-inventory/schedules.stderr" \
    "$OUTPUT_DIR/account-inventory/schedules.absent.json" \
    "scheduler" \
    "list-schedules" \
    "$EXPECTED_ACCOUNT_ID" \
    export_aws scheduler list-schedules \
      --region "$REGION" \
      --page-size 50 \
      --query \
        'Schedules[].{Name:Name,Arn:Arn,GroupName:GroupName,State:State,ScheduleExpression:ScheduleExpression,TargetArn:Target.Arn,Description:Description}' \
      --output json; then
  echo "Account-wide Scheduler inventory is mandatory; safely-absent is not valid for list-schedules." >&2
  exit 1
fi

if ! capture_aws_json \
    "$OUTPUT_DIR/account-inventory/event-rules.json" \
    "$OUTPUT_DIR/account-inventory/event-rules.stderr" \
    "$OUTPUT_DIR/account-inventory/event-rules.absent.json" \
    "events" \
    "list-rules" \
    "$EXPECTED_ACCOUNT_ID" \
    export_aws events list-rules \
      --region "$REGION" \
      --page-size 50 \
      --query \
        'Rules[].{Name:Name,Arn:Arn,EventBusName:EventBusName,State:State,ScheduleExpression:ScheduleExpression,Description:Description,ManagedBy:ManagedBy}' \
      --output json; then
  echo "Account-wide EventBridge Rules inventory is mandatory; safely-absent is not valid for list-rules." >&2
  exit 1
fi

IFS=',' read -r -a functions <<< "$FUNCTION_NAMES"
for function_name in "${functions[@]}"; do
  [[ -n "$function_name" ]] || continue
  function_dir="$OUTPUT_DIR/functions/$function_name"
  mkdir -m 700 -p "$function_dir"

  if capture_aws_json \
      "$function_dir/get-function.json" \
      "$function_dir/get-function.stderr" \
      "$function_dir/function.absent.json" \
      "lambda" \
      "get-function" \
      "$function_name" \
      export_aws lambda get-function \
        --region "$REGION" \
        --function-name "$function_name" \
        --output json; then
    :
  else
    capture_status=$?
    if [[ "$capture_status" -eq "$ABSENT_STATUS" ]]; then
      continue
    fi
    exit 1
  fi

  code_url="$(
    python3 -c \
      'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["Code"]["Location"])' \
      "$function_dir/get-function.json"
  )"
  curl --fail --silent --show-error --location "$code_url" --output "$function_dir/code.zip"

  if capture_aws_json \
      "$function_dir/event-invoke-config.json" \
      "$function_dir/event-invoke-config.stderr" \
      "$function_dir/event-invoke-config.absent.json" \
      "lambda" \
      "get-function-event-invoke-config" \
      "$function_name" \
      export_aws lambda get-function-event-invoke-config \
        --region "$REGION" \
        --function-name "$function_name" \
        --output json; then
    :
  else
    capture_status=$?
    [[ "$capture_status" -eq "$ABSENT_STATUS" ]] || exit 1
  fi

  if capture_aws_json \
      "$function_dir/resource-policy.json" \
      "$function_dir/resource-policy.stderr" \
      "$function_dir/resource-policy.absent.json" \
      "lambda" \
      "get-policy" \
      "$function_name" \
      export_aws lambda get-policy \
        --region "$REGION" \
        --function-name "$function_name" \
        --output json; then
    :
  else
    capture_status=$?
    [[ "$capture_status" -eq "$ABSENT_STATUS" ]] || exit 1
  fi
done

IFS=',' read -r -a schedules <<< "$SCHEDULE_NAMES"
for schedule_name in "${schedules[@]}"; do
  [[ -n "$schedule_name" ]] || continue
  if capture_aws_json \
      "$OUTPUT_DIR/schedules/$schedule_name.json" \
      "$OUTPUT_DIR/schedules/$schedule_name.stderr" \
      "$OUTPUT_DIR/schedules/$schedule_name.absent.json" \
      "scheduler" \
      "get-schedule" \
      "$schedule_name" \
      export_aws scheduler get-schedule \
        --region "$REGION" \
        --name "$schedule_name" \
        --output json; then
    :
  else
    capture_status=$?
    [[ "$capture_status" -eq "$ABSENT_STATUS" ]] || exit 1
  fi
done

if [[ -n "$EVENT_RULE_NAMES" ]]; then
  IFS=',' read -r -a event_rules <<< "$EVENT_RULE_NAMES"
  for event_rule_name in "${event_rules[@]}"; do
  [[ -n "$event_rule_name" ]] || continue
  if capture_aws_json \
      "$OUTPUT_DIR/event-rules/$event_rule_name.json" \
      "$OUTPUT_DIR/event-rules/$event_rule_name.stderr" \
      "$OUTPUT_DIR/event-rules/$event_rule_name.absent.json" \
      "events" \
      "describe-rule" \
      "$event_rule_name" \
      export_aws events describe-rule \
        --region "$REGION" \
        --name "$event_rule_name" \
        --event-bus-name default \
        --output json; then
    :
  else
    capture_status=$?
    if [[ "$capture_status" -eq "$ABSENT_STATUS" ]]; then
      continue
    fi
    exit 1
  fi

  if ! capture_aws_json \
      "$OUTPUT_DIR/event-rules/$event_rule_name.targets.json" \
      "$OUTPUT_DIR/event-rules/$event_rule_name.targets.stderr" \
      "$OUTPUT_DIR/event-rules/$event_rule_name.targets.absent.json" \
      "events" \
      "list-targets-by-rule" \
      "$event_rule_name" \
      export_aws events list-targets-by-rule \
        --region "$REGION" \
        --rule "$event_rule_name" \
        --event-bus-name default \
        --output json; then
    echo "EventBridge target inventory is mandatory for ${event_rule_name}." >&2
    exit 1
  fi

  event_rule_arn="$(
    python3 -c \
      'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["Arn"])' \
      "$OUTPUT_DIR/event-rules/$event_rule_name.json"
  )"
  if ! capture_aws_json \
      "$OUTPUT_DIR/event-rules/$event_rule_name.tags.json" \
      "$OUTPUT_DIR/event-rules/$event_rule_name.tags.stderr" \
      "$OUTPUT_DIR/event-rules/$event_rule_name.tags.absent.json" \
      "events" \
      "list-tags-for-resource" \
      "$event_rule_name" \
      export_aws events list-tags-for-resource \
        --region "$REGION" \
        --resource-arn "$event_rule_arn" \
        --output json; then
    echo "EventBridge tag inventory is mandatory for ${event_rule_name}." >&2
    exit 1
  fi
  done
fi

export_table_inventory() {
  local table_root="$1"
  local table_name="$2"
  local table_dir="$table_root/$table_name"
  local capture_status
  local table_arn
  local expected_table_arn

  mkdir -m 700 -p "$table_dir"

  if capture_aws_json \
      "$table_dir/describe-table.json" \
      "$table_dir/describe-table.stderr" \
      "$table_dir/table.absent.json" \
      "dynamodb" \
      "describe-table" \
      "$table_name" \
      export_aws dynamodb describe-table \
        --region "$REGION" \
        --table-name "$table_name" \
        --output json; then
    :
  else
    capture_status=$?
    if [[ "$capture_status" -eq "$ABSENT_STATUS" ]]; then
      return "$ABSENT_STATUS"
    fi
    return 1
  fi

  table_arn="$(
    python3 -c \
      'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["Table"]["TableArn"])' \
      "$table_dir/describe-table.json"
  )"
  expected_table_arn="arn:aws:dynamodb:${EXPECTED_REGION}:${EXPECTED_ACCOUNT_ID}:table/${table_name}"
  if [[ "$table_arn" != "$expected_table_arn" ]]; then
    echo "DynamoDB returned unexpected ARN for ${table_name}: ${table_arn}" >&2
    return 1
  fi

  if ! capture_aws_json \
      "$table_dir/time-to-live.json" \
      "$table_dir/time-to-live.stderr" \
      "$table_dir/time-to-live.absent.json" \
      "dynamodb" \
      "describe-time-to-live" \
      "$table_name" \
      export_aws dynamodb describe-time-to-live \
        --region "$REGION" \
        --table-name "$table_name" \
        --output json; then
    return 1
  fi

  if ! capture_aws_json \
      "$table_dir/continuous-backups.json" \
      "$table_dir/continuous-backups.stderr" \
      "$table_dir/continuous-backups.absent.json" \
      "dynamodb" \
      "describe-continuous-backups" \
      "$table_name" \
      export_aws dynamodb describe-continuous-backups \
        --region "$REGION" \
        --table-name "$table_name" \
        --output json; then
    return 1
  fi

  if ! capture_aws_json \
      "$table_dir/tags.json" \
      "$table_dir/tags.stderr" \
      "$table_dir/tags.absent.json" \
      "dynamodb" \
      "list-tags-of-resource" \
      "$table_name" \
      export_aws dynamodb list-tags-of-resource \
        --region "$REGION" \
        --resource-arn "$table_arn" \
        --output json; then
    return 1
  fi
  return 0
}

IFS=',' read -r -a tables <<< "$TABLE_NAMES"
for table_name in "${tables[@]}"; do
  [[ -n "$table_name" ]] || continue
  if export_table_inventory "$OUTPUT_DIR/tables" "$table_name"; then
    :
  else
    capture_status=$?
    [[ "$capture_status" -eq "$ABSENT_STATUS" ]] || exit 1
  fi
done

IFS=',' read -r -a external_tables <<< "$EXTERNAL_TABLE_NAMES"
for table_name in "${external_tables[@]}"; do
  [[ -n "$table_name" ]] || continue
  if export_table_inventory "$OUTPUT_DIR/external-tables" "$table_name"; then
    :
  else
    capture_status=$?
    [[ "$capture_status" -eq "$ABSENT_STATUS" ]] || exit 1
  fi
done

STACK_PRESENT="false"
if capture_aws_json \
    "$OUTPUT_DIR/cloudformation-stack.json" \
    "$OUTPUT_DIR/cloudformation-stack.stderr" \
    "$OUTPUT_DIR/cloudformation-stack.absent.json" \
    "cloudformation" \
    "describe-stacks" \
    "$STACK_NAME" \
    export_aws cloudformation describe-stacks \
      --region "$REGION" \
      --stack-name "$STACK_NAME" \
      --output json; then
  STACK_PRESENT="true"
else
  capture_status=$?
  [[ "$capture_status" -eq "$ABSENT_STATUS" ]] || exit 1
fi

if [[ "$STACK_PRESENT" == "true" ]]; then
  if ! capture_aws_json \
      "$OUTPUT_DIR/cloudformation-template.json" \
      "$OUTPUT_DIR/cloudformation-template.stderr" \
      "$OUTPUT_DIR/cloudformation-template.absent.json" \
      "cloudformation" \
      "get-template" \
      "$STACK_NAME" \
      export_aws cloudformation get-template \
        --region "$REGION" \
        --stack-name "$STACK_NAME" \
        --template-stage Original \
        --output json; then
    exit 1
  fi

  if ! capture_aws_json \
      "$OUTPUT_DIR/cloudformation-stack-resources.json" \
      "$OUTPUT_DIR/cloudformation-stack-resources.stderr" \
      "$OUTPUT_DIR/cloudformation-stack-resources.absent.json" \
      "cloudformation" \
      "list-stack-resources" \
      "$STACK_NAME" \
      export_aws cloudformation list-stack-resources \
        --region "$REGION" \
        --stack-name "$STACK_NAME" \
        --output json; then
    exit 1
  fi
fi

BOOTSTRAP_STACK_PRESENT="false"
if capture_aws_json \
    "$OUTPUT_DIR/bootstrap/cloudformation-stack.json" \
    "$OUTPUT_DIR/bootstrap/cloudformation-stack.stderr" \
    "$OUTPUT_DIR/bootstrap/cloudformation-stack.absent.json" \
    "cloudformation" \
    "describe-stacks" \
    "$BOOTSTRAP_STACK_NAME" \
    export_aws cloudformation describe-stacks \
      --region "$REGION" \
      --stack-name "$BOOTSTRAP_STACK_NAME" \
      --output json; then
  BOOTSTRAP_STACK_PRESENT="true"
else
  capture_status=$?
  [[ "$capture_status" -eq "$ABSENT_STATUS" ]] || exit 1
fi

if [[ "$BOOTSTRAP_STACK_PRESENT" == "true" ]]; then
  if ! capture_aws_json \
      "$OUTPUT_DIR/bootstrap/cloudformation-template.json" \
      "$OUTPUT_DIR/bootstrap/cloudformation-template.stderr" \
      "$OUTPUT_DIR/bootstrap/cloudformation-template.absent.json" \
      "cloudformation" \
      "get-template" \
      "$BOOTSTRAP_STACK_NAME" \
      export_aws cloudformation get-template \
        --region "$REGION" \
        --stack-name "$BOOTSTRAP_STACK_NAME" \
        --template-stage Original \
        --output json; then
    exit 1
  fi

  if ! capture_aws_json \
      "$OUTPUT_DIR/bootstrap/cloudformation-stack-resources.json" \
      "$OUTPUT_DIR/bootstrap/cloudformation-stack-resources.stderr" \
      "$OUTPUT_DIR/bootstrap/cloudformation-stack-resources.absent.json" \
      "cloudformation" \
      "list-stack-resources" \
      "$BOOTSTRAP_STACK_NAME" \
      export_aws cloudformation list-stack-resources \
        --region "$REGION" \
        --stack-name "$BOOTSTRAP_STACK_NAME" \
        --output json; then
    exit 1
  fi
fi

ROLE_PRESENT="false"
if capture_aws_json \
    "$OUTPUT_DIR/bootstrap/deployment-role/get-role.json" \
    "$OUTPUT_DIR/bootstrap/deployment-role/get-role.stderr" \
    "$OUTPUT_DIR/bootstrap/deployment-role/role.absent.json" \
    "iam" \
    "get-role" \
    "$DEPLOYMENT_ROLE_NAME" \
    export_aws iam get-role \
      --role-name "$DEPLOYMENT_ROLE_NAME" \
      --output json; then
  ROLE_PRESENT="true"
  ROLE_ARN="$(
    python3 -c \
      'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["Role"]["Arn"])' \
      "$OUTPUT_DIR/bootstrap/deployment-role/get-role.json"
  )"
  EXPECTED_ROLE_ARN="arn:aws:iam::${EXPECTED_ACCOUNT_ID}:role/${DEPLOYMENT_ROLE_NAME}"
  if [[ "$ROLE_ARN" != "$EXPECTED_ROLE_ARN" ]]; then
    echo "IAM returned unexpected ARN for ${DEPLOYMENT_ROLE_NAME}: ${ROLE_ARN}" >&2
    exit 1
  fi
else
  capture_status=$?
  [[ "$capture_status" -eq "$ABSENT_STATUS" ]] || exit 1
fi

if [[ "$ROLE_PRESENT" == "true" ]]; then
  if capture_aws_json \
      "$OUTPUT_DIR/bootstrap/deployment-role/inline-policy.json" \
      "$OUTPUT_DIR/bootstrap/deployment-role/inline-policy.stderr" \
      "$OUTPUT_DIR/bootstrap/deployment-role/inline-policy.absent.json" \
      "iam" \
      "get-role-policy" \
      "$DEPLOYMENT_ROLE_POLICY_NAME" \
      export_aws iam get-role-policy \
        --role-name "$DEPLOYMENT_ROLE_NAME" \
        --policy-name "$DEPLOYMENT_ROLE_POLICY_NAME" \
        --output json; then
    :
  else
    capture_status=$?
    [[ "$capture_status" -eq "$ABSENT_STATUS" ]] || exit 1
  fi

  if ! capture_aws_json \
      "$OUTPUT_DIR/bootstrap/deployment-role/inline-policy-names.json" \
      "$OUTPUT_DIR/bootstrap/deployment-role/inline-policy-names.stderr" \
      "$OUTPUT_DIR/bootstrap/deployment-role/inline-policy-names.absent.json" \
      "iam" \
      "list-role-policies" \
      "$DEPLOYMENT_ROLE_NAME" \
      export_aws iam list-role-policies \
        --role-name "$DEPLOYMENT_ROLE_NAME" \
        --output json; then
    exit 1
  fi

  if ! capture_aws_json \
      "$OUTPUT_DIR/bootstrap/deployment-role/attached-policies.json" \
      "$OUTPUT_DIR/bootstrap/deployment-role/attached-policies.stderr" \
      "$OUTPUT_DIR/bootstrap/deployment-role/attached-policies.absent.json" \
      "iam" \
      "list-attached-role-policies" \
      "$DEPLOYMENT_ROLE_NAME" \
      export_aws iam list-attached-role-policies \
        --role-name "$DEPLOYMENT_ROLE_NAME" \
        --output json; then
    exit 1
  fi

  if ! capture_aws_json \
      "$OUTPUT_DIR/bootstrap/deployment-role/role-tags.json" \
      "$OUTPUT_DIR/bootstrap/deployment-role/role-tags.stderr" \
      "$OUTPUT_DIR/bootstrap/deployment-role/role-tags.absent.json" \
      "iam" \
      "list-role-tags" \
      "$DEPLOYMENT_ROLE_NAME" \
      export_aws iam list-role-tags \
        --role-name "$DEPLOYMENT_ROLE_NAME" \
        --output json; then
    exit 1
  fi
fi

PREFLIGHT_STATUS=0
python3 - \
  "$OUTPUT_DIR" \
  "$EXPECTED_ACCOUNT_ID" \
  "$EXPECTED_REGION" \
  "$STACK_NAME" \
  "$BOOTSTRAP_STACK_NAME" \
  "$DEPLOYMENT_ROLE_NAME" \
  "$FUNCTION_NAMES" \
  "$SCHEDULE_NAMES" \
  "$EVENT_RULE_NAMES" \
  "$CANONICAL_FUNCTION_NAMES" \
  "$CANONICAL_SCHEDULE_NAMES" \
  "$CANONICAL_EVENT_RULE_NAMES" \
  "$TABLE_NAMES" \
  "$EXTERNAL_TABLE_NAMES" \
  "$REQUIRED_EXTERNAL_TABLE_NAMES" <<'PY' || PREFLIGHT_STATUS=$?
from __future__ import annotations

from datetime import datetime, timezone
import json
import pathlib
import sys

(
    output_raw,
    account,
    region,
    target_stack_name,
    bootstrap_stack_name,
    role_name,
    explicitly_exported_function_names_raw,
    explicitly_exported_schedule_names_raw,
    explicitly_exported_event_rule_names_raw,
    function_names_raw,
    schedule_names_raw,
    event_rule_names_raw,
    table_names_raw,
    external_table_names_raw,
    required_external_table_names_raw,
) = sys.argv[1:]
output = pathlib.Path(output_raw)


def load_optional(path: pathlib.Path):
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def names(raw: str) -> list[str]:
    return list(dict.fromkeys(name.strip() for name in raw.split(",") if name.strip()))


def tag_map(items) -> dict[str, str]:
    return {
        str(item.get("Key")): str(item.get("Value"))
        for item in (items or [])
        if item.get("Key") is not None
    }


def canonical_physical_id(resource_type: str, physical_id: str) -> str:
    if resource_type == "AWS::Lambda::Function" and ":function:" in physical_id:
        return physical_id.split(":function:", 1)[1].split(":", 1)[0]
    if resource_type == "AWS::Events::Rule" and ":rule/" in physical_id:
        return physical_id.split(":rule/", 1)[1].split("/", 1)[0]
    if resource_type == "AWS::Scheduler::Schedule":
        return physical_id.rstrip("/").rsplit("/", 1)[-1]
    if resource_type in {"AWS::DynamoDB::Table", "AWS::IAM::Role"}:
        return physical_id.rstrip("/").rsplit("/", 1)[-1]
    return physical_id


def owned_resources(path: pathlib.Path) -> set[tuple[str, str]]:
    payload = load_optional(path) or {}
    result = set()
    for item in payload.get("StackResourceSummaries") or []:
        if item.get("ResourceStatus") == "DELETE_COMPLETE":
            continue
        resource_type = str(item.get("ResourceType") or "")
        physical_id = str(item.get("PhysicalResourceId") or "")
        if resource_type and physical_id:
            result.add(
                (
                    resource_type,
                    canonical_physical_id(resource_type, physical_id),
                )
            )
    return result


target_owned = owned_resources(output / "cloudformation-stack-resources.json")
bootstrap_owned = owned_resources(
    output / "bootstrap" / "cloudformation-stack-resources.json"
)
target_stack_present = (output / "cloudformation-stack.json").is_file()
bootstrap_stack_present = (
    output / "bootstrap" / "cloudformation-stack.json"
).is_file()
conflicts: list[dict[str, str]] = []
checked: list[dict[str, object]] = []


def discovery_items(path: pathlib.Path, envelope_key: str) -> list[dict]:
    payload = load_optional(path)
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        items = payload.get(envelope_key)
        if isinstance(items, list):
            return [item for item in items if isinstance(item, dict)]
    conflicts.append(
        {
            "code": "INVENTORY_INCOMPLETE",
            "resourceType": "AWS::Account",
            "resource": path.name,
        }
    )
    return []


def is_relevant_discovered_name(name: str) -> bool:
    lowered = name.casefold()
    return any(
        marker in lowered
        for marker in ("market-dashboard", "gmail", "hermes", "hedgeye")
    )


discovery_specs = (
    (
        "AWS::Lambda::Function",
        discovery_items(
            output / "account-inventory" / "lambda-functions.json",
            "Functions",
        ),
        "FunctionName",
        set(names(explicitly_exported_function_names_raw)),
    ),
    (
        "AWS::Scheduler::Schedule",
        discovery_items(
            output / "account-inventory" / "schedules.json",
            "Schedules",
        ),
        "Name",
        set(names(explicitly_exported_schedule_names_raw)),
    ),
    (
        "AWS::Events::Rule",
        discovery_items(
            output / "account-inventory" / "event-rules.json",
            "Rules",
        ),
        "Name",
        set(names(explicitly_exported_event_rule_names_raw)),
    ),
)
for resource_type, items, name_key, explicitly_exported in discovery_specs:
    for item in items:
        name = str(item.get(name_key) or "")
        if not name or not is_relevant_discovered_name(name):
            continue
        was_explicitly_exported = name in explicitly_exported
        checked.append(
            {
                "resourceType": resource_type,
                "resource": name,
                "classification": "account-discovery",
                "explicitlyExported": was_explicitly_exported,
            }
        )
        if not was_explicitly_exported:
            conflicts.append(
                {
                    "code": "DISCOVERED_RESOURCE_REQUIRES_EXPLICIT_EXPORT",
                    "resourceType": resource_type,
                    "resource": name,
                }
            )

resource_specs = [
    *[
        (
            "AWS::Lambda::Function",
            name,
            output / "functions" / name / "get-function.json",
            output / "functions" / name / "function.absent.json",
        )
        for name in names(function_names_raw)
    ],
    *[
        (
            "AWS::Scheduler::Schedule",
            name,
            output / "schedules" / f"{name}.json",
            output / "schedules" / f"{name}.absent.json",
        )
        for name in names(schedule_names_raw)
    ],
    *[
        (
            "AWS::Events::Rule",
            name,
            output / "event-rules" / f"{name}.json",
            output / "event-rules" / f"{name}.absent.json",
        )
        for name in names(event_rule_names_raw)
    ],
    *[
        (
            "AWS::DynamoDB::Table",
            name,
            output / "tables" / name / "describe-table.json",
            output / "tables" / name / "table.absent.json",
        )
        for name in names(table_names_raw)
    ],
]

expected_target_resources = {
    (resource_type, name)
    for resource_type, name, _, _ in resource_specs
}
expected_target_tags = {
    "market-dashboard:owner": "market-dashboard-readiness-v2",
    "market-dashboard:purpose": "readiness-stack",
}
if target_stack_present and not (target_owned & expected_target_resources):
    conflicts.append(
        {
            "code": "INCOMPATIBLE_STACK_NAME_CONFLICT",
            "resourceType": "AWS::CloudFormation::Stack",
            "resource": target_stack_name,
        }
    )
if target_stack_present:
    target_stack = load_optional(output / "cloudformation-stack.json") or {}
    stacks = target_stack.get("Stacks") or []
    observed_target_tags = tag_map(stacks[0].get("Tags") if stacks else [])
    if any(
        observed_target_tags.get(key) != value
        for key, value in expected_target_tags.items()
    ):
        conflicts.append(
            {
                "code": "OWNERSHIP_TAG_MISMATCH",
                "resourceType": "AWS::CloudFormation::Stack",
                "resource": target_stack_name,
            }
        )

for resource_type, name, present_path, absent_path in resource_specs:
    present = present_path.is_file()
    absent = absent_path.is_file()
    if present == absent:
        conflicts.append(
            {
                "code": "INVENTORY_INCOMPLETE",
                "resourceType": resource_type,
                "resource": name,
            }
        )
        continue
    owned = (resource_type, name) in target_owned
    checked.append(
        {
            "resourceType": resource_type,
            "resource": name,
            "present": present,
            "ownedByTargetStack": owned,
        }
    )
    if present and not owned:
        conflicts.append(
            {
                "code": "EXTERNALLY_OWNED_NAME_CONFLICT",
                "resourceType": resource_type,
                "resource": name,
            }
        )

required_external_tables = set(names(required_external_table_names_raw))
for name in names(external_table_names_raw):
    present_path = output / "external-tables" / name / "describe-table.json"
    absent_path = output / "external-tables" / name / "table.absent.json"
    present = present_path.is_file()
    absent = absent_path.is_file()
    required = name in required_external_tables
    status = None
    if present:
        table_payload = load_optional(present_path) or {}
        status = (table_payload.get("Table") or {}).get("TableStatus")
    checked.append(
        {
            "resourceType": "AWS::DynamoDB::Table",
            "resource": name,
            "classification": "external-dependency",
            "present": present,
            "required": required,
            "status": status,
        }
    )
    if present == absent:
        conflicts.append(
            {
                "code": "INVENTORY_INCOMPLETE",
                "resourceType": "AWS::DynamoDB::Table",
                "resource": name,
            }
        )
    elif required and not present:
        conflicts.append(
            {
                "code": "REQUIRED_EXTERNAL_DEPENDENCY_ABSENT",
                "resourceType": "AWS::DynamoDB::Table",
                "resource": name,
            }
        )
    elif required and status != "ACTIVE":
        conflicts.append(
            {
                "code": "INCOMPATIBLE_EXTERNAL_DEPENDENCY",
                "resourceType": "AWS::DynamoDB::Table",
                "resource": name,
            }
        )

role_present = (
    output / "bootstrap" / "deployment-role" / "get-role.json"
).is_file()
role_absent = (
    output / "bootstrap" / "deployment-role" / "role.absent.json"
).is_file()
role_owned = ("AWS::IAM::Role", role_name) in bootstrap_owned
expected_bootstrap_tags = {
    "market-dashboard:owner": "market-dashboard-readiness-v2",
    "market-dashboard:purpose": "cloudformation-deployment",
}
if bootstrap_stack_present and not role_owned:
    conflicts.append(
        {
            "code": "INCOMPATIBLE_STACK_NAME_CONFLICT",
            "resourceType": "AWS::CloudFormation::Stack",
            "resource": bootstrap_stack_name,
        }
    )
if bootstrap_stack_present:
    bootstrap_stack = load_optional(
        output / "bootstrap" / "cloudformation-stack.json"
    ) or {}
    stacks = bootstrap_stack.get("Stacks") or []
    observed_stack_tags = tag_map(stacks[0].get("Tags") if stacks else [])
    if any(
        observed_stack_tags.get(key) != value
        for key, value in expected_bootstrap_tags.items()
    ):
        conflicts.append(
            {
                "code": "OWNERSHIP_TAG_MISMATCH",
                "resourceType": "AWS::CloudFormation::Stack",
                "resource": bootstrap_stack_name,
            }
        )
if role_present == role_absent:
    conflicts.append(
        {
            "code": "INVENTORY_INCOMPLETE",
            "resourceType": "AWS::IAM::Role",
            "resource": role_name,
        }
    )
elif role_present and not role_owned:
    conflicts.append(
        {
            "code": "EXTERNALLY_OWNED_NAME_CONFLICT",
            "resourceType": "AWS::IAM::Role",
            "resource": role_name,
        }
    )
if role_present:
    role_tags_payload = load_optional(
        output / "bootstrap" / "deployment-role" / "role-tags.json"
    )
    if role_tags_payload is None:
        conflicts.append(
            {
                "code": "INVENTORY_INCOMPLETE",
                "resourceType": "AWS::IAM::Role",
                "resource": role_name,
            }
        )
    else:
        observed_role_tags = tag_map(role_tags_payload.get("Tags"))
        if any(
            observed_role_tags.get(key) != value
            for key, value in expected_bootstrap_tags.items()
        ):
            conflicts.append(
                {
                    "code": "OWNERSHIP_TAG_MISMATCH",
                    "resourceType": "AWS::IAM::Role",
                    "resource": role_name,
                }
            )
checked.append(
    {
        "resourceType": "AWS::IAM::Role",
        "resource": role_name,
        "present": role_present,
        "ownedByBootstrapStack": role_owned,
    }
)

payload = {
    "schemaVersion": 1,
    "classification": "ownership-preflight",
    "passed": not conflicts,
    "account": account,
    "region": region,
    "targetStack": target_stack_name,
    "bootstrapStack": bootstrap_stack_name,
    "generatedAt": datetime.now(timezone.utc).isoformat(),
    "checked": checked,
    "conflicts": conflicts,
}
(output / "ownership-preflight.json").write_text(
    json.dumps(payload, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
if conflicts:
    for conflict in conflicts:
        print(
            f"{conflict['code']}: {conflict['resourceType']} "
            f"{conflict['resource']}",
            file=sys.stderr,
        )
    raise SystemExit(1)
PY

(
  cd "$OUTPUT_DIR"
  find . -type f ! -name SHA256SUMS -exec shasum -a 256 {} + | LC_ALL=C sort -k2 > SHA256SUMS
)
chmod -R go-rwx "$OUTPUT_DIR"
if [[ "$PREFLIGHT_STATUS" -ne 0 ]]; then
  echo "Rollback inventory found an externally owned or incomplete named-resource conflict." >&2
  echo "Verified diagnostic export remains at $OUTPUT_DIR; no deployment should proceed." >&2
  exit 1
fi
echo "Rollback artifacts exported to $OUTPUT_DIR"
