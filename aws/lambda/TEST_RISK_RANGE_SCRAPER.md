# Testing RiskRangeScraper Lambda Function

## Prerequisites Check

Before testing, verify:

1. **Environment Variables** are set in Lambda:
   - `HEDGEYE_EMAIL` - Your Hedgeye login email
   - `HEDGEYE_PASSWORD` - Your Hedgeye login password
   - `FIRECRAWL_API_KEY` - Your Firecrawl API key (optional but recommended)
   - `RISK_RANGE_TABLE` - Should be `RiskRangeData` (default)

2. **DynamoDB Table** exists:
   - Table name: `RiskRangeData`
   - Partition key: `ticker` (String)
   - Sort key: `date` (String)

3. **IAM Permissions** for Lambda execution role:
   - `dynamodb:PutItem` on `RiskRangeData` table
   - `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents` for CloudWatch

## Testing Methods

### Method 1: AWS Console (Easiest)

1. Go to **Lambda → Functions → RiskRangeScraper**
2. Click **Test** tab
3. Click **Create new test event**
4. Use this test event:
   ```json
   {}
   ```
5. Name it: `test-risk-range-scraper`
6. Click **Save**
7. Click **Test** button
8. Wait for execution (may take 1-3 minutes)
9. Check the **Execution result** section

### Method 2: AWS CLI

```bash
# Invoke the function
aws lambda invoke \
  --function-name RiskRangeScraper \
  --region us-west-1 \
  --payload '{}' \
  response.json

# View response
cat response.json | python3 -m json.tool

# View logs
aws logs tail /aws/lambda/RiskRangeScraper --follow --region us-west-1
```

## Expected Results

### Success Response
```json
{
  "statusCode": 200,
  "body": {
    "message": "Risk range data scraped successfully",
    "timestamp": "2025-11-16T18:30:00.000Z",
    "securities_count": 8,
    "securities": ["UST30Y", "UST10Y", "UST2Y", "HYG", "LQD", "SPX", "COMPQ", "RUT"]
  }
}
```

### Error Response
```json
{
  "statusCode": 500,
  "body": {
    "message": "Error scraping risk range data",
    "error": "Error message here"
  }
}
```

## What to Check

### 1. CloudWatch Logs
- Go to **CloudWatch → Log groups → /aws/lambda/RiskRangeScraper**
- Check latest log stream
- Look for:
  - "Using Firecrawl to scrape..." or "Falling back to Playwright..."
  - "Found Risk Range Signals table..."
  - "Stored risk range data for..."
  - Any error messages

### 2. DynamoDB Data
- Go to **DynamoDB → Tables → RiskRangeData**
- Click **Explore table items**
- Check for:
  - Individual ticker records (ticker=SPX, date=2025-11-16)
  - Latest snapshot (ticker=LATEST, date=latest)

### 3. Common Issues

**Issue: "FIRECRAWL_API_KEY not set"**
- Solution: Add `FIRECRAWL_API_KEY` to Lambda environment variables
- Function will fall back to Playwright or requests

**Issue: "No risk range data scraped"**
- Check CloudWatch logs for parsing errors
- Verify Hedgeye page structure hasn't changed
- May need to update `parse_risk_range_table()` function

**Issue: "Table does not exist"**
- Solution: Create `RiskRangeData` table in DynamoDB
- See `aws/dynamodb/RISK_RANGE_TABLE.md` for schema

**Issue: "Access Denied" when writing to DynamoDB**
- Solution: Update Lambda execution role IAM permissions
- Add `dynamodb:PutItem` permission for `RiskRangeData` table

## Verification Steps

After successful execution:

1. **Check DynamoDB**:
   ```bash
   aws dynamodb get-item \
     --table-name RiskRangeData \
     --key '{"ticker":{"S":"LATEST"},"date":{"S":"latest"}}' \
     --region us-west-1
   ```

2. **Check API Endpoint**:
   - Test: `GET http://localhost:3001/api/risk-ranges`
   - Should return risk range data for all securities

3. **Check Frontend**:
   - Open Signal Strength card (SecuritiesList component)
   - LRR and HRR columns should show values (not "--")

## Next Steps After Successful Test

1. **Expand TICKER_MAPPING**: Check CloudWatch logs to see all available Hedgeye INDEX names
2. **Add more mappings**: Update `TICKER_MAPPING` in the code for all securities you want
3. **Set up EventBridge Schedule**: Automate daily runs at 5 PM EST
4. **Monitor**: Set up CloudWatch alarms for errors


