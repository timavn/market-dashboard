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

## Scraping Methods

The scraper supports three methods (in order of preference):

1. **Firecrawl** (Recommended) - Handles JavaScript rendering and authentication automatically
2. **Playwright** - Browser automation fallback
3. **Requests/BeautifulSoup** - Simple HTTP requests (may not work for JS-heavy pages)

### Firecrawl Setup (Recommended)

Firecrawl is the preferred scraping method as it handles authentication and JavaScript rendering more reliably.

1. **Get Firecrawl API Key**: Sign up at [firecrawl.dev](https://www.firecrawl.dev) and get your API key
2. **Set Environment Variable**: Add `FIRECRAWL_API_KEY` to your Lambda function's environment variables
3. **Install Package**: The `firecrawl-py` package is already in `requirements.txt`

The scraper will automatically use Firecrawl if the API key is set, otherwise it falls back to Playwright or requests.

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

Set these in Lambda function configuration:

**Required:**
- `HEDGEYE_EMAIL`: Your Hedgeye login email
- `HEDGEYE_PASSWORD`: Your Hedgeye login password

**Optional (but recommended):**
- `FIRECRAWL_API_KEY`: Your Firecrawl API key (get from [firecrawl.dev](https://www.firecrawl.dev))
  - If set, the scraper will use Firecrawl (preferred method)
  - If not set, falls back to Playwright or requests
  - Can be set via environment variable or added to `hedgeye_config.json` as `firecrawl_api_key`

**Defaults:**
- `RISK_RANGE_TABLE`: `RiskRangeData`
- `HEDGEYE_LOGIN_URL`: `https://app.hedgeye.com/users/sign_in`
- `HEDGEYE_RISK_RANGE_URL`: `https://app.hedgeye.com/feed_items/all?page=1&with_category=33-risk-range-signals`

#### Setting Firecrawl API Key

**Option 1: Environment Variable (Recommended for Lambda)**
```bash
# When deploying, set the environment variable:
export FIRECRAWL_API_KEY="fc-your-api-key-here"
./deploy.sh
```

**Option 2: Config File (For Local Testing)**
Add to `aws/lambda/hedgeye_config.json`:
```json
{
  "email": "your-email@example.com",
  "password": "your-password",
  "firecrawl_api_key": "fc-your-api-key-here"
}
```

**Option 3: AWS Console**
1. Go to Lambda → Functions → HedgeyeRiskRangeScraper
2. Configuration → Environment variables
3. Add: `FIRECRAWL_API_KEY` = `fc-your-api-key-here`
4. Save

#### Firecrawl Pricing

Firecrawl charges per API call. Check [firecrawl.dev/pricing](https://www.firecrawl.dev/pricing) for current rates. The scraper makes 1-2 API calls per execution (one for login + navigation, one for scraping the data page).

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

1. **Login**: Lambda function logs into Hedgeye using credentials
2. **Navigate**: Goes to Risk Range Signals page
3. **Parse**: Extracts table data with INDEX, BUY TRADE (LRR), SELL TRADE (HRR)
4. **Store**: Saves to DynamoDB with timestamp

### Data Storage

- **Daily Records**: One record per ticker per day for historical tracking
- **Latest Snapshot**: One record with all current risk ranges for quick API access

### Frontend Integration

- `SecuritiesList` component fetches risk ranges on mount
- Refreshes every 5 minutes
- Displays LRR/HRR in table columns
- Uses timestamps to show stale data indicators (blue dot)

## Troubleshooting

### Login Fails

- Check credentials in Lambda environment variables
- Verify Hedgeye login URL hasn't changed
- Check CloudWatch logs for specific error messages

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


