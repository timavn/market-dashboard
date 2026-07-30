#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
EXPECTED_ACCOUNT_ID="915328198276"
EXPECTED_REGION="us-west-1"
EXPECTED_SECRET_NAME="hermes/gmail/oauth"
ADMIN_PROFILE="${MARKET_DASHBOARD_AWS_ADMIN_PROFILE:-market-dashboard-admin}"

usage() {
  echo "Usage: $0 [--admin-profile PROFILE] /absolute/path/to/oauth-secret.json" >&2
}

if [[ "${1:-}" == "--admin-profile" ]]; then
  if [[ $# -lt 3 || -z "${2:-}" ]]; then
    usage
    exit 64
  fi
  ADMIN_PROFILE="$2"
  shift 2
fi
if [[ $# -ne 1 || "$1" != /* ]]; then
  usage
  exit 64
fi

credential_file="$1"
if [[ ! -f "$credential_file" ]]; then
  echo "Credential file does not exist: $credential_file" >&2
  exit 66
fi
credential_file="$(realpath "$credential_file")"
case "$credential_file" in
  "$REPO_ROOT"|"$REPO_ROOT"/*)
    echo "Credential file must be stored outside the repository." >&2
    exit 66
    ;;
esac

python3 - "$credential_file" <<'PY'
import json
import os
import stat
import sys

path = sys.argv[1]
mode = stat.S_IMODE(os.stat(path).st_mode)
if mode != 0o600:
    raise SystemExit("Credential file mode must be exactly 0600 (run chmod 600).")
with open(path, encoding="utf-8") as handle:
    value = json.load(handle)
missing = [
    key
    for key in ("client_id", "client_secret", "refresh_token", "user_id", "scope")
    if not value.get(key)
]
if missing:
    raise SystemExit("Credential JSON is missing: " + ", ".join(missing))
if value.get("scope") != "https://www.googleapis.com/auth/gmail.readonly":
    raise SystemExit("Only the Gmail read-only scope is permitted.")
if value.get("user_id") != "me":
    raise SystemExit('Gmail OAuth user_id must be "me".')
PY

secret_name="${GMAIL_OAUTH_SECRET_NAME:-$EXPECTED_SECRET_NAME}"
if [[ "$secret_name" != "$EXPECTED_SECRET_NAME" ]]; then
  echo "Refusing Gmail secret name ${secret_name}; expected ${EXPECTED_SECRET_NAME}." >&2
  exit 64
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

if ! command -v aws >/dev/null 2>&1 || [[ ! "$(run_aws --version 2>&1)" =~ ^aws-cli/2\. ]]; then
  echo "AWS CLI v2 is required." >&2
  exit 69
fi

profile_region="$(run_aws configure get region --profile "$ADMIN_PROFILE" 2>/dev/null || true)"
profile_account="$(run_aws configure get sso_account_id --profile "$ADMIN_PROFILE" 2>/dev/null || true)"
sso_session="$(run_aws configure get sso_session --profile "$ADMIN_PROFILE" 2>/dev/null || true)"
sso_start_url="$(run_aws configure get sso_start_url --profile "$ADMIN_PROFILE" 2>/dev/null || true)"
if [[ "$profile_region" != "$EXPECTED_REGION" || "$profile_account" != "$EXPECTED_ACCOUNT_ID" ]]; then
  echo "Profile ${ADMIN_PROFILE} must be an SSO profile for account ${EXPECTED_ACCOUNT_ID} in ${EXPECTED_REGION}." >&2
  exit 69
fi
if [[ -z "$sso_session" && -z "$sso_start_url" ]]; then
  echo "Profile ${ADMIN_PROFILE} is not configured for AWS IAM Identity Center/SSO." >&2
  exit 69
fi

identity="$(
  run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
    sts get-caller-identity --query '[Account,Arn]' --output text
)"
IFS=$'\t' read -r caller_account caller_arn <<< "$identity"
if [[ "$caller_account" != "$EXPECTED_ACCOUNT_ID" ]]; then
  echo "Refusing account ${caller_account:-unknown}; expected ${EXPECTED_ACCOUNT_ID}." >&2
  exit 69
fi
case "$caller_arn" in
  "arn:aws:sts::${EXPECTED_ACCOUNT_ID}:assumed-role/AWSReservedSSO_"*/*)
    ;;
  *)
    echo "Profile ${ADMIN_PROFILE} did not resolve to an AWS IAM Identity Center assumed role." >&2
    exit 69
    ;;
esac

version_token="$(
  python3 -c 'import uuid; print("gmail-v2-" + str(uuid.uuid4()))'
)"
describe_stderr="$(mktemp "${TMPDIR:-/tmp}/market-dashboard-gmail-secret.XXXXXX.stderr")"
trap 'rm -f "$describe_stderr"' EXIT

if run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
    secretsmanager describe-secret \
    --secret-id "$secret_name" \
    --output json >/dev/null 2>"$describe_stderr"; then
  secret_exists="true"
elif grep -q 'ResourceNotFoundException' "$describe_stderr"; then
  secret_exists="false"
else
  echo "Unable to validate ${secret_name}; refusing to create or update it." >&2
  cat "$describe_stderr" >&2
  exit 69
fi

if [[ "$secret_exists" == "true" ]]; then
  # A new immutable version atomically moves AWSCURRENT. The ingestor's
  # authentication circuit breaker notices this version change immediately.
  run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
    secretsmanager put-secret-value \
    --secret-id "$secret_name" \
    --client-request-token "$version_token" \
    --secret-string "file://${credential_file}" \
    --version-stages AWSCURRENT \
    --query '{ARN:ARN,VersionId:VersionId,VersionStages:VersionStages}' \
    --output json
else
  run_aws --profile "$ADMIN_PROFILE" --region "$EXPECTED_REGION" \
    secretsmanager create-secret \
    --name "$secret_name" \
    --description "Read-only Gmail OAuth for Market Dashboard ingestion" \
    --client-request-token "$version_token" \
    --secret-string "file://${credential_file}" \
    --query '{ARN:ARN,Name:Name,VersionId:VersionId}' \
    --output json
fi
