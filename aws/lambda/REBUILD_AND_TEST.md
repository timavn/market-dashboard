# Rebuild and Test RiskRangeScraper Lambda

## Problem
The Lambda function is getting a 403 Forbidden error because:
1. **Firecrawl package is not installed** - The zip file was created without `firecrawl-py`
2. **Firecrawl may not handle login forms** - Firecrawl is designed for public pages or pages with cookies, not login forms

## Solution

### Step 1: Rebuild the Package with Dependencies

Run the rebuild script:

```bash
cd aws/lambda
./rebuild-risk-range-scraper.sh
```

This will:
- Install all dependencies including `firecrawl-py`
- Create a new `hedgeye_risk_range_scraper.zip` file
- Show you the file size and upload instructions

### Step 2: Upload to S3 and Update Lambda

If the package is >50MB, upload to S3 first:

```bash
aws s3 cp hedgeye_risk_range_scraper.zip s3://risk-range-scraper/hedgeye_risk_range_scraper.zip
```

Then update Lambda:

```bash
aws lambda update-function-code \
  --function-name RiskRangeScraper \
  --s3-bucket risk-range-scraper \
  --s3-key hedgeye_risk_range_scraper.zip
```

### Step 3: Test the Function

Test the function:

```bash
aws lambda invoke \
  --function-name RiskRangeScraper \
  --payload '{}' \
  response.json

cat response.json
```

## Expected Behavior

After rebuilding with Firecrawl installed:

1. **If Firecrawl works**: You should see `✓ Firecrawl package is available` in the logs
2. **If Firecrawl can't handle login**: It will fall back to Playwright (if installed) or requests
3. **If all methods fail**: Check CloudWatch logs for detailed error messages

## Alternative: Use Playwright Instead

If Firecrawl doesn't work for authenticated pages, we can:
1. Remove Firecrawl dependency
2. Use Playwright (which handles login forms better)
3. Rebuild the package with Playwright

Let me know if you want to try this approach!


