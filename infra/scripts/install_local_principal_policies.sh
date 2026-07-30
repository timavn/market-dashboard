#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
API_POLICY_PATH="${INFRA_DIR}/iam/local-readiness-catalog-policy.json"
BRIDGE_POLICY_PATH="${INFRA_DIR}/iam/local-bridge-policy.json"
POLICY_VALIDATOR="${SCRIPT_DIR}/validate_local_iam_policy.py"
REQUIRED_ACCOUNT_ID="915328198276"
REQUIRED_REGION="us-west-1"

MODE="verify"
SCOPE="both"
ADMIN_PROFILE="${MARKET_DASHBOARD_AWS_ADMIN_PROFILE:-}"
ACCOUNT_ID="${MARKET_DASHBOARD_AWS_ACCOUNT_ID:-${REQUIRED_ACCOUNT_ID}}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-${REQUIRED_REGION}}}"
API_USER="${MARKET_DASHBOARD_API_IAM_USER:-market-dashboard-local}"
BRIDGE_USER="${MARKET_DASHBOARD_BRIDGE_IAM_USER:-market-dashboard-bridge}"
CREATE_BRIDGE_USER="false"
REMOVE_LEGACY_HEARTBEAT_POLICY="false"
LEGACY_HEARTBEAT_POLICY_NAME="MarketDashboardServiceHeartbeatsQuery"
API_POLICY_NAME="MarketDashboardLocalReadinessCatalog"
API_POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${API_POLICY_NAME}"
API_POLICY_OWNER_TAG="market-dashboard-readiness-v2"
API_POLICY_PURPOSE_TAG="local-readiness-catalog"

usage() {
  printf '%s\n' \
    "Usage: $0 [--verify | --apply] --admin-profile PROFILE [options]" \
    "" \
    "Install or verify the two intentionally separate least-privilege IAM policies." \
    "The dashboard API can query owned tables; the outbound bridge can only publish." \
    "" \
    "Options:" \
    "  --verify                    Read-only policy/simulation checks (default)" \
    "  --apply                     Install the policies, then verify them" \
    "  --scope api|bridge|both      Principals to manage (default: both)" \
    "  --admin-profile PROFILE     Administrator profile allowed to manage these users" \
    "  --account-id ID             Expected AWS account (default: ${ACCOUNT_ID})" \
    "  --region REGION             Expected AWS region (default: ${REGION})" \
    "  --api-user USER             Dashboard API IAM user (default: ${API_USER})" \
    "  --bridge-user USER          Dedicated bridge IAM user (default: ${BRIDGE_USER})" \
    "  --create-bridge-user        Create the dedicated bridge user if it is absent" \
    "  --remove-legacy-heartbeat-policy" \
    "                              After complete API verification, remove the exact obsolete policy" \
    "  --help                      Show this help" \
    "" \
    "The API catalog uses a tagged customer-managed policy because the exact" \
    "catalog plus the legacy inline grant exceeds AWS's aggregate inline-policy quota." \
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
    --scope)
      SCOPE="${2:-}"
      shift 2
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
    --remove-legacy-heartbeat-policy)
      REMOVE_LEGACY_HEARTBEAT_POLICY="true"
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
if [[ "$ADMIN_PROFILE" != "market-dashboard-admin" ]]; then
  echo "This rollout requires the exact market-dashboard-admin SSO profile." >&2
  exit 2
fi
if [[ "$SCOPE" != "api" && "$SCOPE" != "bridge" && "$SCOPE" != "both" ]]; then
  echo "Invalid scope: ${SCOPE}. Expected api, bridge, or both." >&2
  exit 2
fi
if [[ "$REMOVE_LEGACY_HEARTBEAT_POLICY" == "true" && ( "$MODE" != "apply" || "$SCOPE" != "api" ) ]]; then
  echo "--remove-legacy-heartbeat-policy requires --apply --scope api." >&2
  exit 2
fi
if [[ ! "$ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
  echo "Expected a 12-digit AWS account ID, got: ${ACCOUNT_ID}" >&2
  exit 2
fi
if [[ "$ACCOUNT_ID" != "$REQUIRED_ACCOUNT_ID" ]]; then
  echo "Refusing account ${ACCOUNT_ID}; this installer is pinned to ${REQUIRED_ACCOUNT_ID}." >&2
  exit 2
fi
if [[ ! "$REGION" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$ ]]; then
  echo "Invalid AWS region: ${REGION}" >&2
  exit 2
fi
if [[ "$REGION" != "$REQUIRED_REGION" ]]; then
  echo "Refusing region ${REGION}; this installer is pinned to ${REQUIRED_REGION}." >&2
  exit 2
fi
if [[ "$SCOPE" != "bridge" && ! -f "$API_POLICY_PATH" ]]; then
  echo "Dashboard API IAM policy document is missing: ${API_POLICY_PATH}" >&2
  exit 2
fi
if [[ "$SCOPE" != "api" && ! -f "$BRIDGE_POLICY_PATH" ]]; then
  echo "Bridge IAM policy document is missing: ${BRIDGE_POLICY_PATH}" >&2
  exit 2
fi
if ! command -v aws >/dev/null 2>&1; then
  echo "AWS CLI v2 is required." >&2
  exit 2
fi

sanitized_aws() {
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
    aws "$@"
}

admin_aws() {
  sanitized_aws --profile "$ADMIN_PROFILE" --region "$REGION" "$@"
}

AWS_CLI_VERSION="$(sanitized_aws --version 2>&1)"
if [[ ! "$AWS_CLI_VERSION" =~ ^aws-cli/2\. ]]; then
  echo "AWS CLI v2 is required; found: ${AWS_CLI_VERSION}" >&2
  exit 2
fi

PROFILE_REGION="$(
  sanitized_aws configure get region --profile "$ADMIN_PROFILE" 2>/dev/null || true
)"
PROFILE_ACCOUNT="$(
  sanitized_aws configure get sso_account_id --profile "$ADMIN_PROFILE" 2>/dev/null || true
)"
SSO_SESSION="$(
  sanitized_aws configure get sso_session --profile "$ADMIN_PROFILE" 2>/dev/null || true
)"
SSO_START_URL="$(
  sanitized_aws configure get sso_start_url --profile "$ADMIN_PROFILE" 2>/dev/null || true
)"
SSO_ROLE_NAME="$(
  sanitized_aws configure get sso_role_name --profile "$ADMIN_PROFILE" 2>/dev/null || true
)"
if [[ "$PROFILE_ACCOUNT" != "$ACCOUNT_ID" ]]; then
  echo "AWS profile ${ADMIN_PROFILE} must set sso_account_id=${ACCOUNT_ID}." >&2
  exit 2
fi
if [[ "$PROFILE_REGION" != "$REGION" ]]; then
  echo "AWS profile ${ADMIN_PROFILE} must set region=${REGION}." >&2
  exit 2
fi
if [[ -z "$SSO_ROLE_NAME" || ( -z "$SSO_SESSION" && -z "$SSO_START_URL" ) ]]; then
  echo "AWS profile ${ADMIN_PROFILE} is not a complete IAM Identity Center profile." >&2
  exit 2
fi

CALLER_IDENTITY="$(admin_aws sts get-caller-identity --output json)"
CALLER_ACCOUNT="$(
  python3 -c 'import json,sys; print(json.load(sys.stdin)["Account"])' \
    <<< "$CALLER_IDENTITY"
)"
CALLER_ARN="$(
  python3 -c 'import json,sys; print(json.load(sys.stdin)["Arn"])' \
    <<< "$CALLER_IDENTITY"
)"
if [[ "$CALLER_ACCOUNT" != "$ACCOUNT_ID" ]]; then
  echo "Refusing to manage IAM in account ${CALLER_ACCOUNT}; expected ${ACCOUNT_ID}." >&2
  exit 3
fi
if [[ ! "$CALLER_ARN" =~ ^arn:aws:sts::${ACCOUNT_ID}:assumed-role/AWSReservedSSO_[^/]+/.+$ ]]; then
  echo "Refusing non-SSO administrator identity: ${CALLER_ARN}" >&2
  exit 3
fi

POLICY_PATHS=()
if [[ "$SCOPE" != "bridge" ]]; then
  POLICY_PATHS+=("$API_POLICY_PATH")
fi
if [[ "$SCOPE" != "api" ]]; then
  POLICY_PATHS+=("$BRIDGE_POLICY_PATH")
fi

python3 "$POLICY_VALIDATOR" \
  --account "$ACCOUNT_ID" \
  --region "$REGION" \
  "${POLICY_PATHS[@]}"

ensure_user() {
  local user_name="$1"
  local may_create="$2"
  if admin_aws iam get-user \
      --user-name "$user_name" >/dev/null 2>&1; then
    return 0
  fi
  if [[ "$MODE" == "apply" && "$may_create" == "true" ]]; then
    admin_aws iam create-user \
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

managed_policy_document_matches() {
  local policy_path="$1"
  local installed_payload="$2"
  python3 - "$policy_path" "$installed_payload" <<'PY'
import json
import pathlib
import sys
import urllib.parse

local_path, raw_payload = sys.argv[1:]
expected = json.loads(pathlib.Path(local_path).read_text(encoding="utf-8"))
response = json.loads(raw_payload)
version = response.get("PolicyVersion") or {}
installed = version.get("Document")
if isinstance(installed, str):
    try:
        installed = json.loads(urllib.parse.unquote(installed))
    except (json.JSONDecodeError, TypeError):
        raise SystemExit(1)
if not isinstance(installed, dict):
    raise SystemExit(1)

def canonical(value):
    if isinstance(value, dict):
        return {key: canonical(item) for key, item in sorted(value.items())}
    if isinstance(value, list):
        normalized = [canonical(item) for item in value]
        return sorted(
            normalized,
            key=lambda item: json.dumps(item, sort_keys=True, separators=(",", ":")),
        )
    return value

raise SystemExit(0 if canonical(installed) == canonical(expected) else 1)
PY
}

validate_managed_policy_version_metadata() {
  local installed_payload="$1"
  local expected_version_id="$2"
  python3 - "$installed_payload" "$expected_version_id" <<'PY'
import json
import sys

raw_payload, expected_version_id = sys.argv[1:]
version = (json.loads(raw_payload).get("PolicyVersion") or {})
if version.get("VersionId") != expected_version_id:
    raise SystemExit("Managed API policy returned an unexpected version ID.")
if version.get("IsDefaultVersion") is not True:
    raise SystemExit("Managed API policy version is not marked as default.")
PY
}

validate_managed_policy_tags() {
  local policy_arn="$1"
  local tags_payload
  tags_payload="$(
    admin_aws iam list-policy-tags \
      --policy-arn "$policy_arn" \
      --output json
  )"
  python3 - \
    "$API_POLICY_OWNER_TAG" \
    "$API_POLICY_PURPOSE_TAG" \
    "$tags_payload" <<'PY'
import json
import sys

expected_owner, expected_purpose, raw_payload = sys.argv[1:]
tags = {
    str(item.get("Key")): str(item.get("Value"))
    for item in json.loads(raw_payload).get("Tags", [])
}
expected = {
    "market-dashboard:owner": expected_owner,
    "market-dashboard:purpose": expected_purpose,
}
if tags != expected:
    raise SystemExit("Managed API policy tags do not exactly match ownership metadata.")
PY
}

validate_managed_policy_entities() {
  local policy_arn="$1"
  local expected_user="$2"
  local require_attachment="$3"
  local entities_payload

  entities_payload="$(
    admin_aws iam list-entities-for-policy \
      --policy-arn "$policy_arn" \
      --output json
  )"
  python3 - \
    "$expected_user" \
    "$require_attachment" \
    "$entities_payload" <<'PY'
import json
import sys

expected_user, require_attachment_raw, raw_payload = sys.argv[1:]
require_attachment = require_attachment_raw == "true"
payload = json.loads(raw_payload)
groups = payload.get("PolicyGroups") or []
roles = payload.get("PolicyRoles") or []
users = payload.get("PolicyUsers") or []
user_names = {
    str(item.get("UserName"))
    for item in users
    if item.get("UserName") is not None
}
if groups or roles or (user_names - {expected_user}):
    raise SystemExit(
        "Managed API policy is attached to an unexpected IAM entity."
    )
if require_attachment and user_names != {expected_user}:
    raise SystemExit(
        "Managed API policy is not attached exclusively to the expected API user."
    )
PY
}

install_or_check_api_managed_policy() {
  local user_name="$1"
  local policy_path="$2"
  local policy_error
  local policy_payload
  local default_version_id
  local version_payload
  local version_count
  local created_version_payload
  local created_version_id

  policy_error="$(mktemp)"
  chmod 600 "$policy_error"
  if policy_payload="$(
      admin_aws iam get-policy \
        --policy-arn "$API_POLICY_ARN" \
        --output json \
        2> "$policy_error"
    )"; then
    :
  else
    if ! grep -q "NoSuchEntity" "$policy_error"; then
      echo "Could not inspect managed API policy ${API_POLICY_NAME}." >&2
      cat "$policy_error" >&2
      rm -f "$policy_error"
      return 1
    fi
    if [[ "$MODE" != "apply" ]]; then
      echo "Managed API policy ${API_POLICY_NAME} does not exist." >&2
      rm -f "$policy_error"
      return 1
    fi
    admin_aws iam create-policy \
      --policy-name "$API_POLICY_NAME" \
      --description "Least-privilege local readiness catalog and canonical research reads." \
      --policy-document "file://${policy_path}" \
      --tags \
        "Key=market-dashboard:owner,Value=${API_POLICY_OWNER_TAG}" \
        "Key=market-dashboard:purpose,Value=${API_POLICY_PURPOSE_TAG}" \
      > /dev/null
    policy_payload="$(
      admin_aws iam get-policy \
        --policy-arn "$API_POLICY_ARN" \
        --output json
    )"
    echo "Created tagged managed API policy ${API_POLICY_NAME}."
  fi
  rm -f "$policy_error"

  python3 - "$API_POLICY_NAME" "$API_POLICY_ARN" "$policy_payload" <<'PY'
import json
import sys

expected_name, expected_arn, raw_payload = sys.argv[1:]
policy = json.loads(raw_payload).get("Policy") or {}
if policy.get("PolicyName") != expected_name or policy.get("Arn") != expected_arn:
    raise SystemExit("AWS returned an unexpected managed API policy.")
if policy.get("Path") != "/":
    raise SystemExit("Managed API policy has an unexpected IAM path.")
if int(policy.get("PermissionsBoundaryUsageCount") or 0) != 0:
    raise SystemExit("Managed API policy is used as a permissions boundary.")
PY
  validate_managed_policy_tags "$API_POLICY_ARN"
  validate_managed_policy_entities "$API_POLICY_ARN" "$user_name" "false"

  default_version_id="$(
    python3 -c \
      'import json,sys; print(json.load(sys.stdin)["Policy"]["DefaultVersionId"])' \
      <<< "$policy_payload"
  )"
  version_payload="$(
    admin_aws iam get-policy-version \
      --policy-arn "$API_POLICY_ARN" \
      --version-id "$default_version_id" \
      --output json
  )"
  validate_managed_policy_version_metadata \
    "$version_payload" \
    "$default_version_id"

  if ! managed_policy_document_matches \
      "$policy_path" \
      "$version_payload"; then
    if [[ "$MODE" != "apply" ]]; then
      echo "Managed API policy ${API_POLICY_NAME} differs from the complete local policy ${policy_path}." >&2
      return 1
    fi
    version_count="$(
      admin_aws iam list-policy-versions \
        --policy-arn "$API_POLICY_ARN" \
        --output json |
      python3 -c '
import json
import sys

versions = json.load(sys.stdin).get("Versions", [])
print(len(versions))
'
    )"
    if [[ "$version_count" -ge 5 ]]; then
      echo "Managed API policy has five versions; refusing to discard rollback history." >&2
      return 1
    fi
    created_version_payload="$(
      admin_aws iam create-policy-version \
        --policy-arn "$API_POLICY_ARN" \
        --policy-document "file://${policy_path}" \
        --set-as-default \
        --output json
    )"
    created_version_id="$(
      python3 -c \
        'import json,sys; print(json.load(sys.stdin)["PolicyVersion"]["VersionId"])' \
        <<< "$created_version_payload"
    )"
    policy_payload="$(
      admin_aws iam get-policy \
        --policy-arn "$API_POLICY_ARN" \
        --output json
    )"
    default_version_id="$(
      python3 -c \
        'import json,sys; print(json.load(sys.stdin)["Policy"]["DefaultVersionId"])' \
        <<< "$policy_payload"
    )"
    if [[ "$default_version_id" != "$created_version_id" ]]; then
      echo "Managed API policy did not select the newly created default version." >&2
      return 1
    fi
    version_payload="$(
      admin_aws iam get-policy-version \
        --policy-arn "$API_POLICY_ARN" \
        --version-id "$default_version_id" \
        --output json
    )"
    validate_managed_policy_version_metadata \
      "$version_payload" \
      "$default_version_id"
    echo "Updated ${API_POLICY_NAME} with a new default policy version."
  fi
  if ! managed_policy_document_matches \
      "$policy_path" \
      "$version_payload"; then
    echo "Managed API policy ${API_POLICY_NAME} did not match after installation." >&2
    return 1
  fi

  if [[ "$MODE" == "apply" ]]; then
    admin_aws iam attach-user-policy \
      --user-name "$user_name" \
      --policy-arn "$API_POLICY_ARN"
  fi
  admin_aws iam list-attached-user-policies \
    --user-name "$user_name" \
    --output json |
    python3 -c '
import json
import sys

expected_arn, user_name = sys.argv[1:]
attached = json.load(sys.stdin).get("AttachedPolicies", [])
if not any(
    item.get("PolicyArn") == expected_arn
    and item.get("PolicyName") == "MarketDashboardLocalReadinessCatalog"
    for item in attached
):
    raise SystemExit(
        f"Managed API policy is not attached to {user_name}."
    )
' "$API_POLICY_ARN" "$user_name"
  validate_managed_policy_entities "$API_POLICY_ARN" "$user_name" "true"
  echo "Matched and attached ${API_POLICY_NAME} on ${user_name}."
}

ensure_api_inline_policy_absent() {
  local user_name="$1"
  local error_path

  error_path="$(mktemp)"
  chmod 600 "$error_path"
  if admin_aws iam get-user-policy \
      --user-name "$user_name" \
      --policy-name "$API_POLICY_NAME" \
      > /dev/null 2> "$error_path"; then
    if [[ "$MODE" != "apply" ]]; then
      echo "Obsolete inline ${API_POLICY_NAME} still exists on ${user_name}." >&2
      rm -f "$error_path"
      return 1
    fi
    admin_aws iam delete-user-policy \
      --user-name "$user_name" \
      --policy-name "$API_POLICY_NAME"
  elif ! grep -q "NoSuchEntity" "$error_path"; then
    echo "Could not inspect obsolete inline ${API_POLICY_NAME} on ${user_name}." >&2
    cat "$error_path" >&2
    rm -f "$error_path"
    return 1
  fi

  if admin_aws iam get-user-policy \
      --user-name "$user_name" \
      --policy-name "$API_POLICY_NAME" \
      > /dev/null 2> "$error_path"; then
    echo "Obsolete inline ${API_POLICY_NAME} still exists on ${user_name}." >&2
    rm -f "$error_path"
    return 1
  fi
  if ! grep -q "NoSuchEntity" "$error_path"; then
    echo "Could not verify inline ${API_POLICY_NAME} absence on ${user_name}." >&2
    cat "$error_path" >&2
    rm -f "$error_path"
    return 1
  fi
  rm -f "$error_path"
}

install_or_check_policy() {
  local user_name="$1"
  local policy_name="$2"
  local policy_path="$3"

  if [[ "$MODE" == "apply" ]]; then
    admin_aws iam put-user-policy \
      --user-name "$user_name" \
      --policy-name "$policy_name" \
      --policy-document "file://${policy_path}"
    echo "Applied ${policy_name} to ${user_name}."
  fi

  admin_aws iam get-user-policy \
    --user-name "$user_name" \
    --policy-name "$policy_name" \
    --output json |
    python3 -c '
import json
import pathlib
import sys
import urllib.parse

local_path, user_name, policy_name = sys.argv[1:]
expected = json.loads(pathlib.Path(local_path).read_text(encoding="utf-8"))
response = json.load(sys.stdin)
installed = response.get("PolicyDocument")
if isinstance(installed, str):
    try:
        installed = json.loads(urllib.parse.unquote(installed))
    except (json.JSONDecodeError, TypeError) as error:
        raise SystemExit(
            f"Installed inline policy {policy_name} on {user_name} is not valid JSON: {error}"
        )
if not isinstance(installed, dict):
    raise SystemExit(
        f"Installed inline policy {policy_name} on {user_name} has no policy document."
    )

def canonical(value):
    if isinstance(value, dict):
        return {key: canonical(item) for key, item in sorted(value.items())}
    if isinstance(value, list):
        normalized = [canonical(item) for item in value]
        return sorted(
            normalized,
            key=lambda item: json.dumps(item, sort_keys=True, separators=(",", ":")),
        )
    return value

if canonical(installed) != canonical(expected):
    raise SystemExit(
        f"Installed inline policy {policy_name} on {user_name} differs from "
        f"the complete local policy {local_path}."
    )
' "$policy_path" "$user_name" "$policy_name"
  echo "Matched ${policy_name} on ${user_name} to the complete local policy."
}

simulate_statement_access() {
  local user_name="$1"
  local policy_path="$2"
  local principal_arn="arn:aws:iam::${ACCOUNT_ID}:user/${user_name}"
  local failure_count=0

  while IFS=$'\x1f' read -r action resource enclosing_operation leading_keys; do
    [[ -n "$action" && -n "$resource" ]] || continue
    local decision
    local -a context_entries=()
    if [[ -n "$enclosing_operation" ]]; then
      context_entries+=(
        "ContextKeyName=dynamodb:EnclosingOperation,ContextKeyValues=${enclosing_operation},ContextKeyType=string"
      )
    fi
    if [[ -n "$leading_keys" ]]; then
      context_entries+=(
        "ContextKeyName=dynamodb:LeadingKeys,ContextKeyValues=${leading_keys},ContextKeyType=stringList"
      )
    fi
    if [[ "${#context_entries[@]}" -gt 0 ]]; then
      decision="$(
        admin_aws iam simulate-principal-policy \
          --policy-source-arn "$principal_arn" \
          --action-names "$action" \
          --resource-arns "$resource" \
          --context-entries "${context_entries[@]}" \
          --query 'EvaluationResults[0].EvalDecision' \
          --output text
      )"
    else
      decision="$(
        admin_aws iam simulate-principal-policy \
          --policy-source-arn "$principal_arn" \
          --action-names "$action" \
          --resource-arns "$resource" \
          --query 'EvaluationResults[0].EvalDecision' \
          --output text
      )"
    fi
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
    condition = statement.get("Condition") or {}
    enclosing = (
        condition.get("ForAnyValue:StringEquals", {})
        .get("dynamodb:EnclosingOperation", "")
    )
    if isinstance(enclosing, list):
        enclosing = enclosing[0] if len(enclosing) == 1 else ""
    leading_keys = (
        condition.get("ForAllValues:StringEquals", {})
        .get("dynamodb:LeadingKeys", [])
    )
    if isinstance(leading_keys, str):
        leading_keys = [leading_keys]
    if not isinstance(leading_keys, list):
        leading_keys = []
    if any(
        not isinstance(value, str)
        or not value
        or "," in value
        or "\x1f" in value
        for value in leading_keys
    ):
        raise SystemExit(
            "dynamodb:LeadingKeys must be nonempty comma-safe strings for simulation."
        )
    rendered_leading_keys = ",".join(leading_keys)
    for action in actions:
        for resource in resources:
            print(
                "\x1f".join(
                    [action, resource, enclosing, rendered_leading_keys]
                )
            )
PY
  )

  if [[ "$failure_count" -gt 0 ]]; then
    return 1
  fi
  echo "Verified ${user_name}: every required action/resource pair is allowed."
}

remove_legacy_heartbeat_policy() {
  local user_name="$1"
  local delete_error
  local verify_error

  delete_error="$(mktemp)"
  verify_error="$(mktemp)"
  chmod 600 "$delete_error" "$verify_error"
  if ! admin_aws iam delete-user-policy \
      --user-name "$user_name" \
      --policy-name "$LEGACY_HEARTBEAT_POLICY_NAME" \
      > /dev/null 2> "$delete_error"; then
    if ! grep -q "NoSuchEntity" "$delete_error"; then
      echo "Failed to remove ${LEGACY_HEARTBEAT_POLICY_NAME} from ${user_name}." >&2
      cat "$delete_error" >&2
      rm -f "$delete_error" "$verify_error"
      return 1
    fi
  fi

  if admin_aws iam get-user-policy \
      --user-name "$user_name" \
      --policy-name "$LEGACY_HEARTBEAT_POLICY_NAME" \
      > /dev/null 2> "$verify_error"; then
    echo "Legacy policy ${LEGACY_HEARTBEAT_POLICY_NAME} still exists on ${user_name}." >&2
    rm -f "$delete_error" "$verify_error"
    return 1
  fi
  if ! grep -q "NoSuchEntity" "$verify_error"; then
    echo "Could not verify removal of ${LEGACY_HEARTBEAT_POLICY_NAME} from ${user_name}." >&2
    cat "$verify_error" >&2
    rm -f "$delete_error" "$verify_error"
    return 1
  fi

  rm -f "$delete_error" "$verify_error"
  echo "Removed and verified absent ${LEGACY_HEARTBEAT_POLICY_NAME} on ${user_name}."
}

if [[ "$SCOPE" != "bridge" ]]; then
  ensure_user "$API_USER" "false"
  install_or_check_api_managed_policy \
    "$API_USER" \
    "$API_POLICY_PATH"
  simulate_statement_access "$API_USER" "$API_POLICY_PATH"
  ensure_api_inline_policy_absent "$API_USER"
  if [[ "$REMOVE_LEGACY_HEARTBEAT_POLICY" == "true" ]]; then
    remove_legacy_heartbeat_policy "$API_USER"
  fi
  if [[ "$MODE" == "apply" ]]; then
    simulate_statement_access "$API_USER" "$API_POLICY_PATH"
  fi
fi

if [[ "$SCOPE" != "api" ]]; then
  ensure_user "$BRIDGE_USER" "$CREATE_BRIDGE_USER"
  install_or_check_policy \
    "$BRIDGE_USER" \
    "MarketDashboardLocalSnapshotBridge" \
    "$BRIDGE_POLICY_PATH"
  simulate_statement_access "$BRIDGE_USER" "$BRIDGE_POLICY_PATH"
fi

echo "IAM ${MODE} completed for ${SCOPE} scope in account ${ACCOUNT_ID} (${REGION})."
if [[ "$SCOPE" != "bridge" ]]; then
  echo "Configure the API with its ${API_USER} credentials."
fi
if [[ "$SCOPE" != "api" ]]; then
  echo "Configure HERMES_BRIDGE_AWS_PROFILE with credentials for ${BRIDGE_USER}; do not reuse the API principal."
fi
