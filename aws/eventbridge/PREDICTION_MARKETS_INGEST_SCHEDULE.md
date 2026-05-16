# Prediction Markets Ingest EventBridge Schedule

## Overview

Scheduled ingest for Kalshi financial/macro markets into DynamoDB `FinancialPredictionEvents`.
IBKR/ForecastEx/CME refresh is **not** scheduled — use local Express `POST /api/prediction-markets/refresh/ibkr` with Client Portal Gateway.

## Schedule

**Rule Name**: `PredictionMarketsIngestSchedule`

**Schedule Expression**: `cron(*/10 14-22 ? * MON-FRI *)`
- Every 10 minutes, 14:00–22:00 UTC (covers US equity session hours)
- Weekdays only

**Target**: Lambda `PredictionMarketsIngest`

## Environment (Lambda)

| Variable | Description |
|----------|-------------|
| `KALSHI_API_KEY_ID` | From Secrets Manager |
| `KALSHI_PRIVATE_KEY_PEM` | RSA private key PEM |
| `KALSHI_API_BASE_URL` | `https://external-api.kalshi.com/trade-api/v2` |
| `FINANCIAL_PREDICTION_EVENTS_TABLE` | `FinancialPredictionEvents` |
| `IBKR_INGEST_ENABLED` | `false` |
| `AWS_REGION` | `us-west-1` |
| `FRED_API_KEY` | Optional, for reference sidecar |

## Deploy commands

```bash
cd aws/lambda/prediction_markets_ingest
zip -r function.zip index.js ../../../src/services/predictionMarketsIngest

aws lambda create-function \
  --function-name PredictionMarketsIngest \
  --runtime nodejs20.x \
  --handler index.handler \
  --role arn:aws:iam::ACCOUNT_ID:role/lambda-dynamodb-role \
  --zip-file fileb://function.zip \
  --timeout 120 \
  --memory-size 512 \
  --environment "Variables={FINANCIAL_PREDICTION_EVENTS_TABLE=FinancialPredictionEvents,IBKR_INGEST_ENABLED=false}" \
  --region us-west-1

aws events put-rule \
  --name PredictionMarketsIngestSchedule \
  --schedule-expression "cron(*/10 14-22 ? * MON-FRI *)" \
  --description "Kalshi financial prediction markets ingest" \
  --region us-west-1
```

## Secrets Manager

Store JSON secret `market-dashboard/kalshi`:

```json
{
  "KALSHI_API_KEY_ID": "...",
  "KALSHI_PRIVATE_KEY_PEM": "-----BEGIN PRIVATE KEY-----\n..."
}
```

Map into Lambda environment at deploy time or via Secrets extension.
