# Hedgeye Risk Range Scraper EventBridge Schedule

## Overview

EventBridge rule to schedule daily scraping of Hedgeye Risk Range Signals (LRR/HRR) after market close.

## Schedule Configuration

**Rule Name**: `HedgeyeRiskRangeScraperSchedule`

**Schedule Expression**: `cron(0 22 * * ? *)`
- 22:00 UTC = 5:00 PM EST (6:00 PM EDT during daylight saving)
- Runs daily at market close (market closes at 4:00 PM ET, we scrape at 5:00 PM ET to ensure data is available)

**Target**: Lambda function `HedgeyeRiskRangeScraper`

**Purpose**: Scrape LRR (Buy Trade) and HRR (Sell Trade) values from Hedgeye Risk Range Signals page and store in DynamoDB

## Prerequisites

1. **DynamoDB Table**: `RiskRangeData` table must be created
   ```bash
   aws dynamodb create-table \
     --table-name RiskRangeData \
     --attribute-definitions \
       AttributeName=ticker,AttributeType=S \
       AttributeName=date,AttributeType=S \
     --key-schema \
       AttributeName=ticker,KeyType=HASH \
       AttributeName=date,KeyType=RANGE \
     --billing-mode PAY_PER_REQUEST \
     --region us-west-1
   ```

2. **Lambda Function**: `HedgeyeRiskRangeScraper` must be deployed
   - See deployment instructions below

3. **Environment Variables**: Lambda must have these environment variables set:
   - `HEDGEYE_EMAIL`: Your Hedgeye login email
   - `HEDGEYE_PASSWORD`: Your Hedgeye login password
   - `RISK_RANGE_TABLE`: `RiskRangeData` (default)
   - `HEDGEYE_LOGIN_URL`: `https://app.hedgeye.com/users/sign_in` (default)
   - `HEDGEYE_RISK_RANGE_URL`: `https://app.hedgeye.com/feed_items/all?page=1&with_category=33-risk-range-signals` (default)

## Lambda Deployment

### 1. Install Dependencies

```bash
cd aws/lambda
pip install -r requirements.txt -t .
```

### 2. Install Playwright (Optional but Recommended)

If the page requires JavaScript rendering:

```bash
pip install playwright
playwright install chromium
```

**Note**: Playwright requires additional setup for Lambda. You may need to use a Lambda layer or container image. For simpler setup, the scraper will try requests first.

### 3. Create Deployment Package

```bash
# Zip the function and dependencies
zip -r hedgeye_risk_range_scraper.zip hedgeye_risk_range_scraper.py *.pyc -x "*.pyc" __pycache__/*
# If using requests only (no playwright), this should be sufficient
```

### 4. Create Lambda Function

```bash
aws lambda create-function \
  --function-name HedgeyeRiskRangeScraper \
  --runtime python3.11 \
  --role arn:aws:iam::YOUR_ACCOUNT_ID:role/lambda-execution-role \
  --handler hedgeye_risk_range_scraper.lambda_handler \
  --zip-file fileb://hedgeye_risk_range_scraper.zip \
  --timeout 300 \
  --memory-size 512 \
  --environment Variables='{
    "HEDGEYE_EMAIL":"your-email@example.com",
    "HEDGEYE_PASSWORD":"your-password",
    "RISK_RANGE_TABLE":"RiskRangeData"
  }' \
  --region us-west-1
```

### 5. Update Function (for updates)

```bash
aws lambda update-function-code \
  --function-name HedgeyeRiskRangeScraper \
  --zip-file fileb://hedgeye_risk_range_scraper.zip \
  --region us-west-1
```

## AWS CLI Commands

### Create EventBridge Rule

```bash
aws events put-rule \
  --name HedgeyeRiskRangeScraperSchedule \
  --schedule-expression "cron(0 22 * * ? *)" \
  --description "Daily Hedgeye Risk Range scraper at 5:00 PM EST" \
  --state ENABLED \
  --region us-west-1
```

### Add Lambda Target

```bash
aws events put-targets \
  --rule HedgeyeRiskRangeScraperSchedule \
  --targets "Id"="1","Arn"="arn:aws:lambda:us-west-1:YOUR_ACCOUNT_ID:function:HedgeyeRiskRangeScraper" \
  --region us-west-1
```

### Grant EventBridge Permission to Invoke Lambda

```bash
aws lambda add-permission \
  --function-name HedgeyeRiskRangeScraper \
  --statement-id allow-eventbridge-hedgeye-scraper \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn "arn:aws:events:us-west-1:YOUR_ACCOUNT_ID:rule/HedgeyeRiskRangeScraperSchedule" \
  --region us-west-1
```

## AWS Console Steps

### 1. Create EventBridge Rule

1. Go to **EventBridge Console**
2. Click **Create rule**
3. **Name**: `HedgeyeRiskRangeScraperSchedule`
4. **Description**: `Daily Hedgeye Risk Range scraper at 5:00 PM EST`
5. **Rule type**: Schedule
6. **Schedule pattern**: Cron expression
7. **Cron expression**: `0 22 * * ? *`
8. Click **Next**

### 2. Add Target

1. **Target type**: AWS service
2. **Service**: Lambda function
3. **Function**: `HedgeyeRiskRangeScraper`
4. Click **Next**

### 3. Configure Details

1. **State**: Enabled
2. Click **Create rule**

### 4. Set Lambda Environment Variables

1. Go to **Lambda Console**
2. Select `HedgeyeRiskRangeScraper`
3. Go to **Configuration** → **Environment variables**
4. Add:
   - `HEDGEYE_EMAIL`: Your email
   - `HEDGEYE_PASSWORD`: Your password
   - `RISK_RANGE_TABLE`: `RiskRangeData`

## Testing

### Manual Lambda Invocation

```bash
aws lambda invoke \
  --function-name HedgeyeRiskRangeScraper \
  --payload '{}' \
  response.json \
  --region us-west-1

cat response.json
```

### Check DynamoDB

```bash
aws dynamodb get-item \
  --table-name RiskRangeData \
  --key '{"ticker":{"S":"LATEST"},"date":{"S":"latest"}}' \
  --region us-west-1
```

## Troubleshooting

### Common Issues

1. **Login fails**: Check credentials in environment variables
2. **Table not found**: Ensure `RiskRangeData` table exists
3. **Timeout**: Increase Lambda timeout (max 15 minutes)
4. **Memory issues**: Increase Lambda memory (512MB recommended)
5. **Playwright not working**: The scraper will fall back to requests/BeautifulSoup

### CloudWatch Logs

View logs:
```bash
aws logs tail /aws/lambda/HedgeyeRiskRangeScraper --follow --region us-west-1
```

## Security Notes

- **Never commit credentials to git**
- Store credentials in AWS Secrets Manager or Lambda environment variables
- Use IAM roles with least privilege
- Consider using AWS Secrets Manager for password storage:
  ```bash
  aws secretsmanager create-secret \
    --name hedgeye-credentials \
    --secret-string '{"email":"your-email","password":"your-password"}' \
    --region us-west-1
  ```

Then update Lambda to read from Secrets Manager instead of environment variables.

