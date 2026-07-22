#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 /absolute/path/to/oauth-secret.json" >&2
  exit 64
fi

credential_file="$1"
if [[ ! -f "$credential_file" ]]; then
  echo "Credential file does not exist: $credential_file" >&2
  exit 66
fi

python3 - "$credential_file" <<'PY'
import json
import os
import stat
import sys

path = sys.argv[1]
mode = stat.S_IMODE(os.stat(path).st_mode)
if mode & 0o077:
    raise SystemExit("Credential file must not be readable or writable by group/other (run chmod 600).")
with open(path, encoding="utf-8") as handle:
    value = json.load(handle)
missing = [key for key in ("client_id", "client_secret", "refresh_token") if not value.get(key)]
if missing:
    raise SystemExit("Credential JSON is missing: " + ", ".join(missing))
if value.get("scope") not in (None, "https://www.googleapis.com/auth/gmail.readonly"):
    raise SystemExit("Only the Gmail read-only scope is permitted.")
PY

secret_name="${GMAIL_OAUTH_SECRET_NAME:-hermes/gmail/oauth}"
region="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-west-1}}"
version_token="gmail-v2-$(date -u +%Y%m%dT%H%M%SZ)"

# put-secret-value creates a new immutable version and atomically moves
# AWSCURRENT. The ingestor's version circuit breaker notices this immediately.
aws secretsmanager put-secret-value \
  --region "$region" \
  --secret-id "$secret_name" \
  --client-request-token "$version_token" \
  --secret-string "file://${credential_file}" \
  --version-stages AWSCURRENT \
  --query '{ARN:ARN,VersionId:VersionId,VersionStages:VersionStages}' \
  --output json
