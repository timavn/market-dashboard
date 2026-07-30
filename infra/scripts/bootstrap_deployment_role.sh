#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${INFRA_DIR}/.." && pwd)"
TEMPLATE_PATH="${INFRA_DIR}/bootstrap/deployment-role.yaml"

EXPECTED_ACCOUNT_ID="915328198276"
EXPECTED_REGION="us-west-1"
EXPECTED_ARTIFACT_BUCKET="market-dashboard-sam-artifacts-${EXPECTED_ACCOUNT_ID}-${EXPECTED_REGION}"
BOOTSTRAP_STACK_NAME="market-dashboard-deployment-role-v2"
DEPLOYMENT_ROLE_NAME="market-dashboard-cloudformation-deployment-v2"
OWNER_TAG_VALUE="market-dashboard-readiness-v2"
PURPOSE_TAG_VALUE="cloudformation-deployment"
ARTIFACT_PURPOSE_TAG_VALUE="sam-artifacts"
ADMIN_PROFILE="market-dashboard-admin"
ROLLBACK_EXPORT="${MARKET_DASHBOARD_ROLLBACK_EXPORT:-}"

usage() {
  printf '%s\n' \
    "Usage: $0 [--admin-profile PROFILE] --rollback-export /absolute/verified/export" \
    "" \
    "Deploy the bounded CloudFormation execution role with an AWS IAM Identity Center profile." \
    "The profile defaults to market-dashboard-admin and must target account ${EXPECTED_ACCOUNT_ID}" \
    "with workload region ${EXPECTED_REGION}." \
    "" \
    "Required environment:" \
    "  MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET=${EXPECTED_ARTIFACT_BUCKET}" \
    "  MARKET_DASHBOARD_ROLLBACK_EXPORT=/absolute/verified/export (or --rollback-export)" \
    "" \
    "This command does not create an SSO profile, bucket, or long-lived credentials."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --admin-profile)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "--admin-profile requires a profile name." >&2
        exit 2
      fi
      ADMIN_PROFILE="$2"
      shift 2
      ;;
    --rollback-export)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "--rollback-export requires an absolute directory." >&2
        exit 2
      fi
      ROLLBACK_EXPORT="$2"
      shift 2
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

if ! command -v aws >/dev/null 2>&1; then
  echo "AWS CLI v2 is required." >&2
  exit 2
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

AWS_CLI_VERSION="$(run_aws --version 2>&1)" || {
  echo "Unable to determine the AWS CLI version." >&2
  exit 2
}
if [[ ! "$AWS_CLI_VERSION" =~ ^aws-cli/2\. ]]; then
  echo "AWS CLI v2 is required; found: ${AWS_CLI_VERSION}" >&2
  exit 2
fi
if [[ ! -f "$TEMPLATE_PATH" ]]; then
  echo "Deployment-role template is missing: ${TEMPLATE_PATH}" >&2
  exit 2
fi
if [[ -z "${MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET:-}" ]]; then
  echo "Set MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET to ${EXPECTED_ARTIFACT_BUCKET}." >&2
  exit 2
fi
if [[ "$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET" != "$EXPECTED_ARTIFACT_BUCKET" ]]; then
  echo "Refusing artifact bucket ${MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET}; expected ${EXPECTED_ARTIFACT_BUCKET}." >&2
  exit 2
fi
if [[ -z "$ROLLBACK_EXPORT" || "$ROLLBACK_EXPORT" != /* ]]; then
  echo "A verified absolute rollback export is required via --rollback-export or MARKET_DASHBOARD_ROLLBACK_EXPORT." >&2
  exit 2
fi
ROLLBACK_EXPORT="$(
  python3 - "$ROLLBACK_EXPORT" <<'PY'
import pathlib
import sys

print(pathlib.Path(sys.argv[1]).resolve(strict=False))
PY
)"
case "$ROLLBACK_EXPORT" in
  "$REPO_ROOT"|"$REPO_ROOT"/*)
    echo "Rollback export must be outside the repository." >&2
    exit 2
    ;;
esac
if [[ ! -d "$ROLLBACK_EXPORT" || ! -f "$ROLLBACK_EXPORT/SHA256SUMS" ]]; then
  echo "Rollback export is missing its directory or SHA256SUMS: ${ROLLBACK_EXPORT}" >&2
  exit 2
fi
python3 - \
  "$ROLLBACK_EXPORT" \
  "$EXPECTED_ACCOUNT_ID" \
  "$EXPECTED_REGION" \
  "$BOOTSTRAP_STACK_NAME" <<'PY'
import json
import pathlib
import stat
import sys

directory = pathlib.Path(sys.argv[1])
expected_account, expected_region, expected_bootstrap_stack = sys.argv[2:]
mode = stat.S_IMODE(directory.stat().st_mode)
if mode & 0o077:
    raise SystemExit("Rollback export must not be accessible by group or other users.")
preflight_path = directory / "ownership-preflight.json"
if not preflight_path.is_file():
    raise SystemExit("Rollback export has no ownership-preflight.json.")
preflight = json.loads(preflight_path.read_text(encoding="utf-8"))
if preflight.get("passed") is not True or preflight.get("conflicts"):
    raise SystemExit("Rollback ownership preflight did not pass.")
if preflight.get("account") != expected_account:
    raise SystemExit("Rollback export account does not match the deployment account.")
if preflight.get("region") != expected_region:
    raise SystemExit("Rollback export region does not match the deployment region.")
if preflight.get("bootstrapStack") != expected_bootstrap_stack:
    raise SystemExit("Rollback export names an unexpected bootstrap stack.")
PY
(
  cd "$ROLLBACK_EXPORT"
  shasum -a 256 -c SHA256SUMS >/dev/null
) || {
  echo "Rollback export checksum verification failed." >&2
  exit 2
}

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

if [[ "$PROFILE_REGION" != "$EXPECTED_REGION" ]]; then
  echo "Profile ${ADMIN_PROFILE} must set region ${EXPECTED_REGION}; found ${PROFILE_REGION:-unset}." >&2
  exit 3
fi
if [[ "$PROFILE_ACCOUNT" != "$EXPECTED_ACCOUNT_ID" ]]; then
  echo "Profile ${ADMIN_PROFILE} must target SSO account ${EXPECTED_ACCOUNT_ID}; found ${PROFILE_ACCOUNT:-unset}." >&2
  exit 3
fi
if [[ -z "$SSO_SESSION" && -z "$SSO_START_URL" ]]; then
  echo "Profile ${ADMIN_PROFILE} is not configured for AWS IAM Identity Center/SSO." >&2
  exit 3
fi
if [[ -z "$SSO_ROLE_NAME" ]]; then
  echo "Profile ${ADMIN_PROFILE} does not configure an SSO role." >&2
  exit 3
fi

IDENTITY="$(
  run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
    sts get-caller-identity --query '[Account,Arn]' --output text
)"
IFS=$'\t' read -r CALLER_ACCOUNT CALLER_ARN <<< "$IDENTITY"
if [[ "$CALLER_ACCOUNT" != "$EXPECTED_ACCOUNT_ID" ]]; then
  echo "Refusing account ${CALLER_ACCOUNT:-unknown}; expected ${EXPECTED_ACCOUNT_ID}." >&2
  exit 3
fi
case "$CALLER_ARN" in
  "arn:aws:sts::${EXPECTED_ACCOUNT_ID}:assumed-role/AWSReservedSSO_"*/*)
    ;;
  *)
    echo "Profile ${ADMIN_PROFILE} did not resolve to an AWS IAM Identity Center assumed role." >&2
    exit 3
    ;;
esac

run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
  s3api head-bucket \
  --bucket "$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET" \
  --expected-bucket-owner "$EXPECTED_ACCOUNT_ID"

BUCKET_TAGS="$(
  run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
    s3api get-bucket-tagging \
    --bucket "$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET" \
    --expected-bucket-owner "$EXPECTED_ACCOUNT_ID" \
    --output json
)"
python3 - "$OWNER_TAG_VALUE" "$ARTIFACT_PURPOSE_TAG_VALUE" "$BUCKET_TAGS" <<'PY'
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

run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
  cloudformation deploy \
  --template-file "$TEMPLATE_PATH" \
  --stack-name "$BOOTSTRAP_STACK_NAME" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    "DeploymentRoleName=${DEPLOYMENT_ROLE_NAME}" \
    "ArtifactBucketName=${MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET}" \
  --tags \
    "market-dashboard:owner=${OWNER_TAG_VALUE}" \
    "market-dashboard:purpose=${PURPOSE_TAG_VALUE}" \
  --no-fail-on-empty-changeset \
  1>&2

ROLE_ARN="$(
  run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
    cloudformation describe-stacks \
    --stack-name "$BOOTSTRAP_STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='DeploymentRoleArn'].OutputValue | [0]" \
    --output text
)"
EXPECTED_ROLE_ARN="arn:aws:iam::${EXPECTED_ACCOUNT_ID}:role/${DEPLOYMENT_ROLE_NAME}"
if [[ "$ROLE_ARN" != "$EXPECTED_ROLE_ARN" ]]; then
  echo "Bootstrap stack returned an unexpected deployment role ARN." >&2
  exit 4
fi

STACK_TAG_VALUES="$(
  run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
    cloudformation describe-stacks \
    --stack-name "$BOOTSTRAP_STACK_NAME" \
    --query "[Stacks[0].Tags[?Key=='market-dashboard:owner'].Value | [0],Stacks[0].Tags[?Key=='market-dashboard:purpose'].Value | [0]]" \
    --output text
)"
if [[ "$STACK_TAG_VALUES" != "${OWNER_TAG_VALUE}"$'\t'"${PURPOSE_TAG_VALUE}" ]]; then
  echo "Bootstrap stack ownership-tag verification failed." >&2
  exit 4
fi

ROLE_TAG_VALUES="$(
  run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
    iam list-role-tags \
    --role-name "$DEPLOYMENT_ROLE_NAME" \
    --query "[Tags[?Key=='market-dashboard:owner'].Value | [0],Tags[?Key=='market-dashboard:purpose'].Value | [0]]" \
    --output text
)"
if [[ "$ROLE_TAG_VALUES" != "${OWNER_TAG_VALUE}"$'\t'"${PURPOSE_TAG_VALUE}" ]]; then
  echo "Deployment role ownership-tag verification failed." >&2
  exit 4
fi

printf '%s\n' "$ROLE_ARN"
