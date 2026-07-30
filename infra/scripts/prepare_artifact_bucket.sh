#!/usr/bin/env bash
set -euo pipefail

EXPECTED_ACCOUNT_ID="915328198276"
EXPECTED_REGION="us-west-1"
EXPECTED_ARTIFACT_BUCKET="market-dashboard-sam-artifacts-${EXPECTED_ACCOUNT_ID}-${EXPECTED_REGION}"
ADMIN_PROFILE="market-dashboard-admin"
OWNER_TAG_VALUE="market-dashboard-readiness-v2"
PURPOSE_TAG_VALUE="sam-artifacts"
TAGGING_CONFIGURATION='{"TagSet":[{"Key":"market-dashboard:owner","Value":"market-dashboard-readiness-v2"},{"Key":"market-dashboard:purpose","Value":"sam-artifacts"}]}'
LIFECYCLE_CONFIGURATION='{"Rules":[{"ID":"MarketDashboardSamArtifactsRetention","Status":"Enabled","Filter":{},"Expiration":{"Days":90},"NoncurrentVersionExpiration":{"NoncurrentDays":30},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}}]}'
EXPECTED_LIFECYCLE_SUMMARY=$'1\tMarketDashboardSamArtifactsRetention\tEnabled\t90\t30\t7\t0'

usage() {
  printf '%s\n' \
    "Usage: $0 [--admin-profile PROFILE]" \
    "" \
    "Create or validate the private SAM artifact bucket using a short-lived AWS" \
    "IAM Identity Center/SSO administrator profile. The profile defaults to" \
    "market-dashboard-admin and must target account ${EXPECTED_ACCOUNT_ID} in" \
    "${EXPECTED_REGION}." \
    "" \
    "Required environment:" \
    "  MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET=${EXPECTED_ARTIFACT_BUCKET}" \
    "" \
    "Retention: current objects 90 days, noncurrent versions 30 days, and" \
    "incomplete multipart uploads 7 days. Existing conflicting lifecycle" \
    "configuration is never replaced."
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

if [[ -z "${MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET:-}" ]]; then
  echo "Set MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET to ${EXPECTED_ARTIFACT_BUCKET}." >&2
  exit 2
fi
if [[ "$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET" != "$EXPECTED_ARTIFACT_BUCKET" ]]; then
  echo "Refusing artifact bucket ${MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET}; expected ${EXPECTED_ARTIFACT_BUCKET}." >&2
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

ERROR_FILE="$(mktemp "${TMPDIR:-/tmp}/market-dashboard-artifact-bucket.XXXXXX")"
cleanup() {
  rm -f "$ERROR_FILE"
}
trap cleanup EXIT

BUCKET_EXISTS=true
if run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
  s3api head-bucket \
  --bucket "$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET" \
  --expected-bucket-owner "$EXPECTED_ACCOUNT_ID" \
  >/dev/null 2>"$ERROR_FILE"; then
  :
else
  HEAD_STATUS=$?
  HEAD_ERROR="$(<"$ERROR_FILE")"
  case "$HEAD_ERROR" in
    *"(404)"*|*"Status Code: 404"*|*"(NoSuchBucket)"*)
      BUCKET_EXISTS=false
      ;;
    *)
      echo "Unable to establish that artifact bucket ${MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET} is absent; refusing to create it." >&2
      if [[ -n "$HEAD_ERROR" ]]; then
        printf '%s\n' "$HEAD_ERROR" >&2
      else
        echo "HeadBucket failed with status ${HEAD_STATUS} and no authoritative not-found response." >&2
      fi
      exit 4
      ;;
  esac
fi

if [[ "$BUCKET_EXISTS" == false ]]; then
  run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
    s3api create-bucket \
    --bucket "$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET" \
    --object-ownership BucketOwnerEnforced \
    --create-bucket-configuration "LocationConstraint=${EXPECTED_REGION}" \
    >/dev/null
  run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
    s3api put-bucket-tagging \
    --bucket "$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET" \
    --expected-bucket-owner "$EXPECTED_ACCOUNT_ID" \
    --tagging "$TAGGING_CONFIGURATION" \
    >/dev/null
fi

# HeadBucket with ExpectedBucketOwner is the authoritative ownership check. Run it
# again after creation so a namespace race cannot result in configuring another
# account's bucket.
run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
  s3api head-bucket \
  --bucket "$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET" \
  --expected-bucket-owner "$EXPECTED_ACCOUNT_ID" \
  >/dev/null

if BUCKET_TAGS="$(
  run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
    s3api get-bucket-tagging \
    --bucket "$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET" \
    --expected-bucket-owner "$EXPECTED_ACCOUNT_ID" \
    --output json \
    2>"$ERROR_FILE"
)"; then
  :
else
  TAG_STATUS=$?
  TAG_ERROR="$(<"$ERROR_FILE")"
  echo "Artifact bucket has no verifiable Market Dashboard ownership tags; refusing to configure it." >&2
  if [[ -n "$TAG_ERROR" ]]; then
    printf '%s\n' "$TAG_ERROR" >&2
  else
    echo "GetBucketTagging failed with status ${TAG_STATUS}." >&2
  fi
  exit 4
fi
if ! python3 - "$OWNER_TAG_VALUE" "$PURPOSE_TAG_VALUE" "$BUCKET_TAGS" <<'PY'
import json
import sys

expected_owner, expected_purpose, raw_payload = sys.argv[1:]
payload = json.loads(raw_payload)
tags = {
    str(item.get("Key")): str(item.get("Value"))
    for item in payload.get("TagSet", [])
}
if tags.get("market-dashboard:owner") != expected_owner:
    raise SystemExit(1)
if tags.get("market-dashboard:purpose") != expected_purpose:
    raise SystemExit(1)
PY
then
  echo "Artifact bucket ownership tags are missing or incompatible; refusing to configure it." >&2
  exit 4
fi

BUCKET_REGION="$(
  run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
    s3api get-bucket-location \
    --bucket "$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET" \
    --expected-bucket-owner "$EXPECTED_ACCOUNT_ID" \
    --query LocationConstraint \
    --output text
)"
if [[ "$BUCKET_REGION" != "$EXPECTED_REGION" ]]; then
  echo "Artifact bucket is in ${BUCKET_REGION:-an unknown region}; expected ${EXPECTED_REGION}. No controls were changed." >&2
  exit 4
fi

LIFECYCLE_PRESENT=true
if LIFECYCLE_SUMMARY="$(
  run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
    s3api get-bucket-lifecycle-configuration \
    --bucket "$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET" \
    --expected-bucket-owner "$EXPECTED_ACCOUNT_ID" \
    --query '[length(Rules),Rules[0].ID,Rules[0].Status,Rules[0].Expiration.Days,Rules[0].NoncurrentVersionExpiration.NoncurrentDays,Rules[0].AbortIncompleteMultipartUpload.DaysAfterInitiation,length(keys(Rules[0].Filter))]' \
    --output text \
    2>"$ERROR_FILE"
)"; then
  if [[ "$LIFECYCLE_SUMMARY" != "$EXPECTED_LIFECYCLE_SUMMARY" ]]; then
    echo "Artifact bucket has a conflicting lifecycle configuration; refusing to replace it." >&2
    exit 4
  fi
else
  LIFECYCLE_STATUS=$?
  LIFECYCLE_ERROR="$(<"$ERROR_FILE")"
  case "$LIFECYCLE_ERROR" in
    *"(NoSuchLifecycleConfiguration)"*)
      LIFECYCLE_PRESENT=false
      ;;
    *)
      echo "Unable to inspect the artifact bucket lifecycle; no controls were changed." >&2
      if [[ -n "$LIFECYCLE_ERROR" ]]; then
        printf '%s\n' "$LIFECYCLE_ERROR" >&2
      else
        echo "GetBucketLifecycleConfiguration failed with status ${LIFECYCLE_STATUS}." >&2
      fi
      exit 4
      ;;
  esac
fi

run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
  s3api put-public-access-block \
  --bucket "$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET" \
  --expected-bucket-owner "$EXPECTED_ACCOUNT_ID" \
  --public-access-block-configuration \
    'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'

run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
  s3api put-bucket-ownership-controls \
  --bucket "$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET" \
  --expected-bucket-owner "$EXPECTED_ACCOUNT_ID" \
  --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'

run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
  s3api put-bucket-encryption \
  --bucket "$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET" \
  --expected-bucket-owner "$EXPECTED_ACCOUNT_ID" \
  --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
  s3api put-bucket-versioning \
  --bucket "$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET" \
  --expected-bucket-owner "$EXPECTED_ACCOUNT_ID" \
  --versioning-configuration 'Status=Enabled'

if [[ "$LIFECYCLE_PRESENT" == false ]]; then
  run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
    s3api put-bucket-lifecycle-configuration \
    --bucket "$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET" \
    --expected-bucket-owner "$EXPECTED_ACCOUNT_ID" \
    --lifecycle-configuration "$LIFECYCLE_CONFIGURATION"
fi

PUBLIC_ACCESS_BLOCK="$(
  run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
    s3api get-public-access-block \
    --bucket "$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET" \
    --expected-bucket-owner "$EXPECTED_ACCOUNT_ID" \
    --query '[PublicAccessBlockConfiguration.BlockPublicAcls,PublicAccessBlockConfiguration.IgnorePublicAcls,PublicAccessBlockConfiguration.BlockPublicPolicy,PublicAccessBlockConfiguration.RestrictPublicBuckets]' \
    --output text
)"
if [[ "$PUBLIC_ACCESS_BLOCK" != $'True\tTrue\tTrue\tTrue' ]]; then
  echo "Artifact bucket public-access-block verification failed." >&2
  exit 5
fi

OBJECT_OWNERSHIP="$(
  run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
    s3api get-bucket-ownership-controls \
    --bucket "$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET" \
    --expected-bucket-owner "$EXPECTED_ACCOUNT_ID" \
    --query 'OwnershipControls.Rules[0].ObjectOwnership' \
    --output text
)"
if [[ "$OBJECT_OWNERSHIP" != "BucketOwnerEnforced" ]]; then
  echo "Artifact bucket ownership-controls verification failed." >&2
  exit 5
fi

ENCRYPTION="$(
  run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
    s3api get-bucket-encryption \
    --bucket "$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET" \
    --expected-bucket-owner "$EXPECTED_ACCOUNT_ID" \
    --query '[length(ServerSideEncryptionConfiguration.Rules),ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm]' \
    --output text
)"
if [[ "$ENCRYPTION" != $'1\tAES256' ]]; then
  echo "Artifact bucket default-encryption verification failed." >&2
  exit 5
fi

VERSIONING="$(
  run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
    s3api get-bucket-versioning \
    --bucket "$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET" \
    --expected-bucket-owner "$EXPECTED_ACCOUNT_ID" \
    --query Status \
    --output text
)"
if [[ "$VERSIONING" != "Enabled" ]]; then
  echo "Artifact bucket versioning verification failed." >&2
  exit 5
fi

VERIFIED_LIFECYCLE_SUMMARY="$(
  run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
    s3api get-bucket-lifecycle-configuration \
    --bucket "$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET" \
    --expected-bucket-owner "$EXPECTED_ACCOUNT_ID" \
    --query '[length(Rules),Rules[0].ID,Rules[0].Status,Rules[0].Expiration.Days,Rules[0].NoncurrentVersionExpiration.NoncurrentDays,Rules[0].AbortIncompleteMultipartUpload.DaysAfterInitiation,length(keys(Rules[0].Filter))]' \
    --output text
)"
if [[ "$VERIFIED_LIFECYCLE_SUMMARY" != "$EXPECTED_LIFECYCLE_SUMMARY" ]]; then
  echo "Artifact bucket lifecycle verification failed." >&2
  exit 5
fi

run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
  s3api head-bucket \
  --bucket "$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET" \
  --expected-bucket-owner "$EXPECTED_ACCOUNT_ID" \
  >/dev/null

printf 'Artifact bucket ready: %s\n' "$MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET"
