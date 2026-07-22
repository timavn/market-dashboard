#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || "$1" != /* ]]; then
  echo "Usage: $0 /absolute/path/to/new-rollback-directory" >&2
  exit 2
fi

OUTPUT_DIR="$1"
REGION="${AWS_REGION:-us-west-1}"
FUNCTION_NAMES="${MARKET_DASHBOARD_EXPORT_FUNCTIONS:-market-dashboard-gmail-ingestor-v2,market-dashboard-hermes-worker-v2}"
SCHEDULE_NAMES="${MARKET_DASHBOARD_EXPORT_SCHEDULES:-market-dashboard-gmail-v2-every-15m,market-dashboard-hermes-quant-analyst-v2,market-dashboard-hermes-quant-developer-v2,market-dashboard-hermes-security-v2}"

if [[ -e "$OUTPUT_DIR" ]]; then
  echo "Refusing to overwrite existing rollback directory: $OUTPUT_DIR" >&2
  exit 1
fi
if ! command -v aws >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  echo "aws and curl are required." >&2
  exit 1
fi

mkdir -m 700 -p "$OUTPUT_DIR/functions" "$OUTPUT_DIR/schedules"
aws sts get-caller-identity --output json > "$OUTPUT_DIR/caller-identity.json"

IFS=',' read -r -a functions <<< "$FUNCTION_NAMES"
for function_name in "${functions[@]}"; do
  [[ -n "$function_name" ]] || continue
  function_dir="$OUTPUT_DIR/functions/$function_name"
  mkdir -m 700 -p "$function_dir"
  aws lambda get-function \
    --region "$REGION" \
    --function-name "$function_name" \
    --output json > "$function_dir/get-function.json"
  code_url="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["Code"]["Location"])' "$function_dir/get-function.json")"
  curl --fail --silent --show-error --location "$code_url" --output "$function_dir/code.zip"
  aws lambda get-function-event-invoke-config \
    --region "$REGION" \
    --function-name "$function_name" \
    --output json > "$function_dir/event-invoke-config.json" 2> "$function_dir/event-invoke-config.stderr" || true
  aws lambda get-policy \
    --region "$REGION" \
    --function-name "$function_name" \
    --output json > "$function_dir/resource-policy.json" 2> "$function_dir/resource-policy.stderr" || true
done

IFS=',' read -r -a schedules <<< "$SCHEDULE_NAMES"
for schedule_name in "${schedules[@]}"; do
  [[ -n "$schedule_name" ]] || continue
  aws scheduler get-schedule \
    --region "$REGION" \
    --name "$schedule_name" \
    --output json > "$OUTPUT_DIR/schedules/$schedule_name.json" 2> "$OUTPUT_DIR/schedules/$schedule_name.stderr" || true
done

aws cloudformation describe-stacks \
  --region "$REGION" \
  --stack-name market-dashboard-readiness-v2 \
  --output json > "$OUTPUT_DIR/cloudformation-stack.json" 2> "$OUTPUT_DIR/cloudformation-stack.stderr" || true

(
  cd "$OUTPUT_DIR"
  find . -type f ! -name SHA256SUMS -exec shasum -a 256 {} + | LC_ALL=C sort -k2 > SHA256SUMS
)
chmod -R go-rwx "$OUTPUT_DIR"
echo "Rollback artifacts exported to $OUTPUT_DIR"
