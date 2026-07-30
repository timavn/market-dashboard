#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${INFRA_DIR}/.." && pwd)"
EXPECTED_ACCOUNT_ID="915328198276"
EXPECTED_REGION="us-west-1"
EXPECTED_ARTIFACT_BUCKET="market-dashboard-sam-artifacts-${EXPECTED_ACCOUNT_ID}-${EXPECTED_REGION}"
EXPECTED_ROLE_ARN="arn:aws:iam::${EXPECTED_ACCOUNT_ID}:role/market-dashboard-cloudformation-deployment-v2"
ADMIN_PROFILE="${MARKET_DASHBOARD_AWS_ADMIN_PROFILE:-market-dashboard-admin}"
ROLLBACK_EXPORT="${MARKET_DASHBOARD_ROLLBACK_EXPORT:-}"
TARGET_STACK_NAME="market-dashboard-readiness-v2"
BOOTSTRAP_STACK_NAME="market-dashboard-deployment-role-v2"
OWNER_TAG_VALUE="market-dashboard-readiness-v2"
ARTIFACT_PURPOSE_TAG_VALUE="sam-artifacts"
RELEASE_COMMIT="${MARKET_DASHBOARD_RELEASE_COMMIT:-}"
RELEASE_RECEIPT="${MARKET_DASHBOARD_RELEASE_RECEIPT:-}"
RELEASE_RECEIPT_KEY="${MARKET_DASHBOARD_RELEASE_RECEIPT_KEY:-}"

if [[ ! "$RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Set MARKET_DASHBOARD_RELEASE_COMMIT to the exact lowercase 40-character tested commit." >&2
  exit 1
fi
if [[ -z "$RELEASE_RECEIPT" || "$RELEASE_RECEIPT" != /* ]]; then
  echo "Set MARKET_DASHBOARD_RELEASE_RECEIPT to an absolute mode-0600 tested-release receipt." >&2
  exit 1
fi
if [[ -n "${MARKET_DASHBOARD_BUILD_VERSION:-}" && "${MARKET_DASHBOARD_BUILD_VERSION}" != "$RELEASE_COMMIT" ]]; then
  echo "MARKET_DASHBOARD_BUILD_VERSION, when set, must equal MARKET_DASHBOARD_RELEASE_COMMIT." >&2
  exit 1
fi

receipt_arguments=(
  verify
  --receipt "$RELEASE_RECEIPT"
  --expected-commit "$RELEASE_COMMIT"
)
if [[ -n "$RELEASE_RECEIPT_KEY" ]]; then
  receipt_arguments+=(--receipt-key "$RELEASE_RECEIPT_KEY")
fi
release_verification="$(
  python3 "${SCRIPT_DIR}/prepare_tested_release.py" "${receipt_arguments[@]}"
)"
packaged_template="$(
  python3 -c '
import json, sys
payload = json.load(sys.stdin)
path = payload.get("templatePath")
if not isinstance(path, str) or not path.startswith("/") or "\n" in path:
    raise SystemExit("Verified release has no safe absolute packaged template path.")
print(path)
' <<<"$release_verification"
)"
expected_template_canonical_sha="$(
  python3 -c '
import json, sys
payload = json.load(sys.stdin)
value = payload.get("templateCanonicalSha256")
if not isinstance(value, str) or len(value) != 64:
    raise SystemExit("Verified release has no canonical template checksum.")
print(value)
' <<<"$release_verification"
)"
build_version="$RELEASE_COMMIT"

if [[ "${MARKET_DASHBOARD_CF_ROLE_ARN:-}" != "$EXPECTED_ROLE_ARN" ]]; then
  echo "Set MARKET_DASHBOARD_CF_ROLE_ARN to ${EXPECTED_ROLE_ARN}." >&2
  exit 1
fi

if [[ "${MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET:-}" != "$EXPECTED_ARTIFACT_BUCKET" ]]; then
  echo "Set MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET to ${EXPECTED_ARTIFACT_BUCKET}." >&2
  exit 1
fi
if [[ "$ADMIN_PROFILE" != "market-dashboard-admin" ]]; then
  echo "Base deployment requires the market-dashboard-admin SSO profile." >&2
  exit 1
fi

for control_name in \
  GMAIL_SCHEDULE_STATE \
  HERMES_SCHEDULE_STATE \
  HERMES_QUANT_ANALYST_SCHEDULE_STATE \
  HERMES_QUANT_DEVELOPER_SCHEDULE_STATE \
  HERMES_SECURITY_SCHEDULE_STATE \
  HERMES_CLOUD_WATCHDOG_SCHEDULE_STATE \
  OPERATIONAL_ALARMS_STATE; do
  control_value="${!control_name:-DISABLED}"
  if [[ "$control_value" != "DISABLED" ]]; then
    echo "Base deployment is all-disabled; ${control_name} must be DISABLED. Use staged activation to enable controls." >&2
    exit 1
  fi
done
gmail_state="DISABLED"
analyst_state="DISABLED"
developer_state="DISABLED"
security_state="DISABLED"
alarm_state="DISABLED"
watchdog_state="DISABLED"

if [[ -z "$ROLLBACK_EXPORT" || "$ROLLBACK_EXPORT" != /* ]]; then
  echo "Set MARKET_DASHBOARD_ROLLBACK_EXPORT to an absolute verified rollback export." >&2
  exit 1
fi
ROLLBACK_EXPORT="$(
  python3 - "$ROLLBACK_EXPORT" <<'PY'
import pathlib
import sys

print(pathlib.Path(sys.argv[1]).resolve(strict=False))
PY
)"
case "$ROLLBACK_EXPORT" in
  "$REPO_DIR"|"$REPO_DIR"/*)
    echo "Rollback export must be outside the repository." >&2
    exit 1
    ;;
esac
if [[ ! -d "$ROLLBACK_EXPORT" || ! -f "$ROLLBACK_EXPORT/SHA256SUMS" ]]; then
  echo "Rollback export is missing its directory or SHA256SUMS: ${ROLLBACK_EXPORT}" >&2
  exit 1
fi
python3 - \
  "$ROLLBACK_EXPORT" \
  "$EXPECTED_ACCOUNT_ID" \
  "$EXPECTED_REGION" \
  "$TARGET_STACK_NAME" \
  "$BOOTSTRAP_STACK_NAME" <<'PY'
import json
import pathlib
import stat
import sys

directory = pathlib.Path(sys.argv[1])
expected_account, expected_region, expected_target, expected_bootstrap = sys.argv[2:]
if stat.S_IMODE(directory.stat().st_mode) & 0o077:
    raise SystemExit("Rollback export must not be accessible by group or other users.")
preflight_path = directory / "ownership-preflight.json"
if not preflight_path.is_file():
    raise SystemExit("Rollback export has no ownership-preflight.json.")
preflight = json.loads(preflight_path.read_text(encoding="utf-8"))
if preflight.get("passed") is not True or preflight.get("conflicts"):
    raise SystemExit("Rollback ownership preflight did not pass.")
expected = {
    "account": expected_account,
    "region": expected_region,
    "targetStack": expected_target,
    "bootstrapStack": expected_bootstrap,
}
for key, value in expected.items():
    if preflight.get(key) != value:
        raise SystemExit(f"Rollback export {key} does not match {value}.")
PY
(
  cd "$ROLLBACK_EXPORT"
  shasum -a 256 -c SHA256SUMS >/dev/null
) || {
  echo "Rollback export checksum verification failed." >&2
  exit 1
}

if ! command -v sam >/dev/null 2>&1; then
  echo "AWS SAM CLI is required. Install it, then rerun this command." >&2
  exit 1
fi
if ! command -v aws >/dev/null 2>&1; then
  echo "AWS CLI v2 is required. Ensure its bin directory precedes any AWS CLI v1 installation." >&2
  exit 1
fi

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

run_sam() {
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
    sam "$@"
}

if [[ ! "$(run_aws --version 2>&1)" =~ ^aws-cli/2\. ]]; then
  echo "AWS CLI v2 is required. Ensure its bin directory precedes any AWS CLI v1 installation." >&2
  exit 1
fi

profile_region="$(run_aws configure get region --profile "$ADMIN_PROFILE" 2>/dev/null || true)"
profile_account="$(run_aws configure get sso_account_id --profile "$ADMIN_PROFILE" 2>/dev/null || true)"
sso_session="$(run_aws configure get sso_session --profile "$ADMIN_PROFILE" 2>/dev/null || true)"
sso_start_url="$(run_aws configure get sso_start_url --profile "$ADMIN_PROFILE" 2>/dev/null || true)"
if [[ "$profile_region" != "$EXPECTED_REGION" || "$profile_account" != "$EXPECTED_ACCOUNT_ID" ]]; then
  echo "Profile ${ADMIN_PROFILE} must be an SSO profile for account ${EXPECTED_ACCOUNT_ID} in ${EXPECTED_REGION}." >&2
  exit 2
fi
if [[ -z "$sso_session" && -z "$sso_start_url" ]]; then
  echo "Profile ${ADMIN_PROFILE} is not configured for AWS IAM Identity Center/SSO." >&2
  exit 2
fi

identity="$(
  run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
    sts get-caller-identity --query '[Account,Arn]' --output text
)"
IFS=$'\t' read -r caller_account caller_arn <<< "$identity"
if [[ "$caller_account" != "$EXPECTED_ACCOUNT_ID" ]]; then
  echo "Refusing account ${caller_account:-unknown}; expected ${EXPECTED_ACCOUNT_ID}." >&2
  exit 2
fi
case "$caller_arn" in
  "arn:aws:sts::${EXPECTED_ACCOUNT_ID}:assumed-role/AWSReservedSSO_"*/*)
    ;;
  *)
    echo "Profile ${ADMIN_PROFILE} did not resolve to an AWS IAM Identity Center assumed role." >&2
    exit 2
    ;;
esac

run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
  s3api head-bucket \
  --bucket "$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET" \
  --expected-bucket-owner "$EXPECTED_ACCOUNT_ID"
bucket_tags="$(
  run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
    s3api get-bucket-tagging \
    --bucket "$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET" \
    --expected-bucket-owner "$EXPECTED_ACCOUNT_ID" \
    --output json
)"
python3 - "$OWNER_TAG_VALUE" "$ARTIFACT_PURPOSE_TAG_VALUE" "$bucket_tags" <<'PY'
import json
import sys

expected_owner, expected_purpose, raw_payload = sys.argv[1:]
tags = {
    str(item.get("Key")): str(item.get("Value"))
    for item in json.loads(raw_payload).get("TagSet", [])
}
if tags.get("market-dashboard:owner") != expected_owner:
    raise SystemExit("Artifact bucket ownership tag does not match.")
if tags.get("market-dashboard:purpose") != expected_purpose:
    raise SystemExit("Artifact bucket purpose tag does not match.")
PY

cd "$(dirname "$packaged_template")"
run_sam deploy \
  --template-file "$packaged_template" \
  --stack-name "$TARGET_STACK_NAME" \
  --profile "$ADMIN_PROFILE" \
  --region "$EXPECTED_REGION" \
  --role-arn "$MARKET_DASHBOARD_CF_ROLE_ARN" \
  --s3-bucket "$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET" \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    "CloudWatchdogScheduleState=${watchdog_state}" \
    "GmailScheduleState=${gmail_state}" \
    "QuantAnalystScheduleState=${analyst_state}" \
    "QuantDeveloperScheduleState=${developer_state}" \
    "SecurityScheduleState=${security_state}" \
    "OperationalAlarmsState=${alarm_state}" \
    "ReservedConcurrencyState=DISABLED" \
    "BuildVersion=${build_version}" \
  --tags \
    "market-dashboard:owner=market-dashboard-readiness-v2" \
    "market-dashboard:purpose=readiness-stack"

deployed_build_version="$(
  run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
    cloudformation describe-stacks \
    --stack-name "$TARGET_STACK_NAME" \
    --query "Stacks[0].Parameters[?ParameterKey=='BuildVersion'].ParameterValue | [0]" \
    --output text
)"
if [[ "$deployed_build_version" != "$RELEASE_COMMIT" ]]; then
  echo "CloudFormation BuildVersion ${deployed_build_version:-missing} does not match tested release ${RELEASE_COMMIT}." >&2
  exit 2
fi
deployed_template="$(
  run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
    cloudformation get-template \
    --stack-name "$TARGET_STACK_NAME" \
    --template-stage Original \
    --query TemplateBody \
    --output json
)"
deployed_template_canonical_sha="$(
  PYTHONPATH="$SCRIPT_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 -c '
import json, sys
from prepare_tested_release import canonical_template_sha256
print(canonical_template_sha256(json.load(sys.stdin)))
' <<<"$deployed_template"
)"
if [[ "$deployed_template_canonical_sha" != "$expected_template_canonical_sha" ]]; then
  echo "CloudFormation template does not match the tested immutable base template." >&2
  exit 2
fi
