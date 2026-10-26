#!/usr/bin/env bash

set -euo pipefail

REGION="${AWS_REGION:-us-west-1}"
TARGET_DATE="${1:-$(python3 -c 'from datetime import datetime, timedelta, timezone; print((datetime.now(timezone.utc)-timedelta(days=1)).date())')}"
NEXT_DATE="$(python3 -c 'from datetime import date, timedelta; import sys; print(date.fromisoformat(sys.argv[1]) + timedelta(days=1))' "$TARGET_DATE")"
START_TIME="${TARGET_DATE}T00:00:00Z"
END_TIME="${NEXT_DATE}T00:00:00Z"

S3_USAGE_JSON="$(aws ce get-cost-and-usage \
  --time-period "Start=${TARGET_DATE},End=${NEXT_DATE}" \
  --granularity DAILY \
  --metrics UsageQuantity \
  --filter '{"Dimensions":{"Key":"SERVICE","Values":["Amazon Simple Storage Service"]}}' \
  --group-by Type=DIMENSION,Key=USAGE_TYPE \
  --output json)"

# S3 GET/HEAD and similar reads are billed in the Tier 2 request usage type.
S3_TIER2_REQUESTS="$(printf '%s' "$S3_USAGE_JSON" | jq '[.ResultsByTime[].Groups[] | select(.Keys[0] | endswith("Requests-Tier2")) | (.Metrics.UsageQuantity.Amount | tonumber)] | add // 0')"

DDB_TABLES=(
  CalendarNotes DailyNotes HedgeyeCallNotes HedgeyeDailySnapshot HedgeyeMacroNotes
  HedgeyeRiskRanges HedgeyeSignalStrength HermesAgentRuns HermesAlerts
  HermesEmailIngestLedger HermesInputSnapshots ResearchEventLedgerV2 Holdings MarketPriceHistory PerformanceHistory
  PerformanceMetrics PortfolioSnapshots PositionPerformance
  ProcessingLogs RealizedGainLoss RiskRangeData USDCorrelations
)

DDB_READ_UNITS=0
for table in "${DDB_TABLES[@]}"; do
  value="$(aws cloudwatch get-metric-statistics \
    --namespace AWS/DynamoDB \
    --metric-name ConsumedReadCapacityUnits \
    --dimensions "Name=TableName,Value=${table}" \
    --start-time "$START_TIME" \
    --end-time "$END_TIME" \
    --period 86400 \
    --statistics Sum \
    --region "$REGION" \
    --query 'sum(Datapoints[].Sum)' \
    --output text)"
  if [[ "$value" != "None" && -n "$value" ]]; then
    DDB_READ_UNITS="$(jq -n --argjson total "$DDB_READ_UNITS" --argjson value "$value" '$total + $value')"
  fi
done

lambda_metric() {
  local metric_name="$1"
  aws cloudwatch get-metric-statistics \
    --namespace AWS/Lambda \
    --metric-name "$metric_name" \
    --dimensions Name=FunctionName,Value=market-dashboard-gmail-ingestor-v2 \
    --start-time "$START_TIME" \
    --end-time "$END_TIME" \
    --period 86400 \
    --statistics Sum \
    --region "$REGION" \
    --query 'sum(Datapoints[].Sum)' \
    --output text
}

GMAIL_INVOCATIONS="$(lambda_metric Invocations)"
GMAIL_ERRORS="$(lambda_metric Errors)"
[[ "$GMAIL_INVOCATIONS" == "None" || -z "$GMAIL_INVOCATIONS" ]] && GMAIL_INVOCATIONS=0
[[ "$GMAIL_ERRORS" == "None" || -z "$GMAIL_ERRORS" ]] && GMAIL_ERRORS=0

GMAIL_SCHEDULE_JSON="$(aws scheduler get-schedule \
  --name market-dashboard-gmail-v2-every-15m \
  --region "$REGION" \
  --output json)"
GMAIL_SCHEDULER_STATE="$(printf '%s' "$GMAIL_SCHEDULE_JSON" | jq -r '.State // "UNKNOWN"')"
GMAIL_RETRIES="$(printf '%s' "$GMAIL_SCHEDULE_JSON" | jq -r '.Target.RetryPolicy.MaximumRetryAttempts // 0')"
GUARDIAN_STATE="$(aws lambda get-function-configuration \
  --function-name market-dashboard-cost-guardian-v1 \
  --region "$REGION" \
  --query 'State' \
  --output text 2>/dev/null || printf '%s' UNKNOWN)"
ADMIN_PROFILE="${AWS_ADMIN_PROFILE:-market-dashboard-admin}"
COST_ROUTE_JSON="$(python3 infra/scripts/configure_cost_guardian.py \
  --status \
  --admin-profile "$ADMIN_PROFILE")"
COST_ROUTE_CONFORMS="$(printf '%s' "$COST_ROUTE_JSON" | jq '.conforms')"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUDGET_READ_STATUS="available"
BUDGET_THRESHOLDS=null
if budget_thresholds="$(aws budgets describe-notifications-for-budget \
  --account-id "$ACCOUNT_ID" \
  --budget-name MarketDashboardMonthlyCostCeiling \
  --query 'sort_by(Notifications,&Threshold)[].Threshold' \
  --output json 2>/dev/null)"; then
  BUDGET_THRESHOLDS="$budget_thresholds"
else
  # AWS Budgets uses the billing-level budgets:ViewBudget permission. The
  # least-privilege dashboard identity intentionally does not need that access;
  # metric acceptance checks must still run after the root credential is gone.
  BUDGET_READ_STATUS="not-authorized-for-dashboard-identity"
fi
ANOMALY_THRESHOLDS="$(aws ce get-anomaly-subscriptions \
  --query 'AnomalySubscriptions[?SubscriptionName==`Default-Services-Subscription`]|[0].ThresholdExpression' \
  --output json)"

PASS="$(jq -n \
  --argjson s3 "$S3_TIER2_REQUESTS" \
  --argjson ddb "$DDB_READ_UNITS" \
  --argjson invocations "$GMAIL_INVOCATIONS" \
  --argjson errors "$GMAIL_ERRORS" \
  --argjson retries "$GMAIL_RETRIES" \
  --argjson budget "$BUDGET_THRESHOLDS" \
  --argjson costRoute "$COST_ROUTE_CONFORMS" \
  --arg schedulerState "$GMAIL_SCHEDULER_STATE" \
  --arg guardianState "$GUARDIAN_STATE" \
  '$s3 < 500 and $ddb < 100000 and $invocations <= 100 and $errors == 0 and $retries == 0 and ($schedulerState == "ENABLED" or $schedulerState == "DISABLED") and $guardianState == "Active" and $budget == [25,45,50] and $costRoute')"

jq -n \
  --arg date "$TARGET_DATE" \
  --argjson s3Tier2Requests "$S3_TIER2_REQUESTS" \
  --argjson ddbConsumedReadUnits "$DDB_READ_UNITS" \
  --argjson gmailInvocations "$GMAIL_INVOCATIONS" \
  --argjson gmailErrors "$GMAIL_ERRORS" \
  --argjson gmailMaximumRetryAttempts "$GMAIL_RETRIES" \
  --arg gmailSchedulerState "$GMAIL_SCHEDULER_STATE" \
  --arg guardianState "$GUARDIAN_STATE" \
  --argjson budgetThresholds "$BUDGET_THRESHOLDS" \
  --arg budgetReadStatus "$BUDGET_READ_STATUS" \
  --argjson anomalyThresholdExpression "$ANOMALY_THRESHOLDS" \
  --argjson costRoute "$COST_ROUTE_JSON" \
  --argjson pass "$PASS" \
  '{
    date: $date,
    acceptance: {
      s3Tier2Requests: {actual: $s3Tier2Requests, target: "<500"},
      dynamodbConsumedReadUnits: {actual: $ddbConsumedReadUnits, target: "<100000"},
      gmailLambdaInvocations: {actual: $gmailInvocations, target: "<=100"},
      gmailLambdaErrors: {actual: $gmailErrors, target: 0},
      scheduledMaximumRetryAttempts: {actual: $gmailMaximumRetryAttempts, target: 0},
      gmailSchedulerState: {actual: $gmailSchedulerState, target: "ENABLED or intentional DISABLED"},
      costGuardianState: {actual: $guardianState, target: "Active"},
      costOnlyNotificationRoute: {actual: $costRoute.conforms, target: true}
    },
    controls: {
      monthlyBudgetAlertThresholdsUsd: $budgetThresholds,
      monthlyBudgetReadStatus: $budgetReadStatus,
      anomalyThresholdExpression: $anomalyThresholdExpression,
      notificationRoute: $costRoute
    },
    pass: $pass,
    note: "The $50 monthly AWS budget is a protective pause trigger, not a hard billing cap; delayed billing data and retained resources can result in additional charges. Cost Explorer data can lag by up to a day; rerun if the selected date is incomplete. Textract content-hash deduplication is verified by Lambda tests and ledger records, not inferred from aggregate invocation counts."
  }'

[[ "$PASS" == "true" ]]
