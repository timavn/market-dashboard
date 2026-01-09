# Hedgeye Risk Range Automation Setup Guide

## Overview

This automation system scrapes LRR (Low Risk Range / Buy Trade) and HRR (High Risk Range / Sell Trade) values from Hedgeye's Risk Range Signals page daily after market close and updates your dashboard.

## Architecture

```
Hedgeye Website → Lambda Scraper → DynamoDB → API Endpoint → Frontend Dashboard
     (5 PM ET)      (EventBridge)   (Storage)    (server.js)    (SecuritiesList)
```

## Components

1. **Lambda Function**: `hedgeye_risk_range_scraper.py` - Scrapes Hedgeye website
2. **DynamoDB Table**: `RiskRangeData` - Stores LRR/HRR values
3. **API Endpoint**: `/api/risk-ranges` - Serves data to frontend
4. **Frontend**: `SecuritiesList.jsx` - Displays LRR/HRR in securities table
5. **EventBridge Schedule**: Runs daily at 5:00 PM EST

## Scraping Method

The local scraper uses **Playwright with cookies** extracted after manual login. This is the simplest and most reliable approach:

1. **Manual Login**: Log into Hedgeye in Chrome each morning (~7 EST)
2. **Extract Cookies**: Run `extract_hedgeye_cookies.py` to save cookies
3. **Automated Scraping**: Scraper uses cookies to navigate and extract data

**Note**: For Lambda/cloud deployment, you may need to adapt this approach or use a different authentication method.

## Quick Start

### Step 1: Create DynamoDB Table

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

### Step 2: Deploy Lambda Function

```bash
cd aws/lambda

# Install dependencies
pip install -r requirements.txt -t .

# Create deployment package (requests/BeautifulSoup only - simpler)
zip -r hedgeye_risk_range_scraper.zip hedgeye_risk_range_scraper.py *.py -x "*.pyc" __pycache__/*

# Create Lambda function
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
    "RISK_RANGE_TABLE":"RiskRangeData",
    "FIRECRAWL_API_KEY":"fc-your-api-key-here"
  }' \
  --region us-west-1
```

### Step 3: Create EventBridge Schedule

```bash
# Create rule
aws events put-rule \
  --name HedgeyeRiskRangeScraperSchedule \
  --schedule-expression "cron(0 22 * * ? *)" \
  --description "Daily Hedgeye Risk Range scraper at 5:00 PM EST" \
  --state ENABLED \
  --region us-west-1

# Add Lambda target
aws events put-targets \
  --rule HedgeyeRiskRangeScraperSchedule \
  --targets "Id"="1","Arn"="arn:aws:lambda:us-west-1:YOUR_ACCOUNT_ID:function:HedgeyeRiskRangeScraper" \
  --region us-west-1

# Grant permission
aws lambda add-permission \
  --function-name HedgeyeRiskRangeScraper \
  --statement-id allow-eventbridge-hedgeye-scraper \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn "arn:aws:events:us-west-1:YOUR_ACCOUNT_ID:rule/HedgeyeRiskRangeScraperSchedule" \
  --region us-west-1
```

### Step 4: Test Manually

```bash
# Invoke Lambda manually
aws lambda invoke \
  --function-name HedgeyeRiskRangeScraper \
  --payload '{}' \
  response.json \
  --region us-west-1

# Check results
cat response.json

# Verify data in DynamoDB
aws dynamodb get-item \
  --table-name RiskRangeData \
  --key '{"ticker":{"S":"LATEST"},"date":{"S":"latest"}}' \
  --region us-west-1
```

## Configuration

### Environment Variables

For local scraping, no environment variables are needed. Cookies are extracted manually and stored in `hedgeye_cookies.json`.

For Lambda/cloud deployment, you would need to adapt the approach:
- Store cookies in AWS Secrets Manager or Parameter Store
- Update the scraper to load cookies from the secret store
- Or use a different authentication method suitable for serverless

**Defaults:**
- `RISK_RANGE_TABLE`: `HedgeyeRiskRanges` (or `RiskRangeData` for legacy)
- `HEDGEYE_RISK_RANGE_URL`: `https://app.hedgeye.com/feed_items/all?page=1&with_category=33-risk-range-signals`

### Ticker Mapping

The scraper maps Hedgeye INDEX names to your ticker symbols. Update `TICKER_MAPPING` in `hedgeye_risk_range_scraper.py` to add more mappings:

```python
TICKER_MAPPING = {
    'UST30Y': 'UST30Y',
    'UST10Y': 'UST10Y',
    'UST2Y': 'UST2Y',
    'HYG': 'HYG',
    'LQD': 'LQD',
    'SPX': 'SPX',
    'COMPQ': 'COMPQ',
    'RUT': 'RUT',
    # Add more as needed
}
```

## How It Works

### Scraping Process

1. **Manual Login**: User logs into Hedgeye in Chrome each morning (~7 EST)
2. **Extract Cookies**: Run `extract_hedgeye_cookies.py` to save cookies
3. **Navigate**: Scraper uses cookies to navigate to Risk Range Signals page
4. **Parse**: Extracts table data with INDEX, BUY TRADE (LRR), SELL TRADE (HRR)
5. **Store**: Saves to DynamoDB with timestamp

### Data Storage

- **Daily Records**: One record per ticker per day for historical tracking
- **Latest Snapshot**: One record with all current risk ranges for quick API access

### Frontend Integration

- `SecuritiesList` component fetches risk ranges on mount
- Refreshes every 5 minutes
- Displays LRR/HRR in table columns
- Uses timestamps to show stale data indicators (blue dot)

## Troubleshooting

### Cookies Expired

- Log into Hedgeye again in Chrome
- Run `python3 extract_hedgeye_cookies.py` to refresh cookies
- Re-run the scraper

### No Data Scraped

- Verify the Risk Range Signals page structure hasn't changed
- Check if page requires JavaScript (may need Playwright)
- Review CloudWatch logs for parsing errors

### Frontend Not Showing Data

- Check API endpoint: `GET /api/risk-ranges`
- Verify DynamoDB has data: Check `LATEST` record
- Check browser console for errors
- Verify ticker mapping matches your securities list

### Lambda Timeout

- Increase timeout (max 15 minutes)
- Increase memory (512MB recommended)
- Check if page is slow to load

## Security Best Practices

1. **Use AWS Secrets Manager** instead of environment variables:
   ```bash
   aws secretsmanager create-secret \
     --name hedgeye-credentials \
     --secret-string '{"email":"your-email","password":"your-password"}' \
     --region us-west-1
   ```

2. **Update Lambda** to read from Secrets Manager:
   ```python
   import boto3
   import json
   
   secrets_client = boto3.client('secretsmanager')
   secret = secrets_client.get_secret_value(SecretId='hedgeye-credentials')
   credentials = json.loads(secret['SecretString'])
   HEDGEYE_EMAIL = credentials['email']
   HEDGEYE_PASSWORD = credentials['password']
   ```

3. **IAM Roles**: Use least privilege IAM roles
4. **VPC**: Consider running Lambda in VPC if needed

## Monitoring

### CloudWatch Logs

```bash
aws logs tail /aws/lambda/HedgeyeRiskRangeScraper --follow --region us-west-1
```

### CloudWatch Metrics

- Invocations
- Errors
- Duration
- Throttles

### Alarms

Set up CloudWatch alarms for:
- Lambda errors
- Lambda timeouts
- Missing data in DynamoDB

## Maintenance

### Updating Ticker Mappings

1. Edit `TICKER_MAPPING` in `hedgeye_risk_range_scraper.py`
2. Update Lambda function code
3. Test manually before next scheduled run

### Handling Website Changes

If Hedgeye changes their website structure:

1. Check CloudWatch logs for parsing errors
2. Update `parse_risk_range_table()` function
3. Test with manual Lambda invocation
4. Deploy updated code

## Cost Estimation

- **Lambda**: ~$0.20/month (1 invocation/day, 2 min runtime, 512MB)
- **DynamoDB**: ~$0.25/month (PAY_PER_REQUEST, minimal reads/writes)
- **EventBridge**: Free tier covers this use case
- **Total**: ~$0.45/month

## Support

For issues or questions:
1. Check CloudWatch logs
2. Review this documentation
3. Test Lambda manually
4. Verify DynamoDB data exists


