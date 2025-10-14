# Complete AWS Setup Checklist

Follow this checklist to get your Schwab portfolio integration working end-to-end.

## Prerequisites ✅ (Already Done)
- [x] DynamoDB tables created (PortfolioSnapshots, Holdings, ProcessingLogs)
- [x] S3 bucket created
- [x] Lambda function shell created (CSVPortfolioProcessor)
- [x] Lambda code written (csv_processor.py)

## Setup Steps

### 1️⃣ IAM Permissions (5 min) ✅ COMPLETED
**Guide:** `aws/iam/QUICK_START.md`

- [x] Open Lambda function in AWS Console
- [x] Go to Configuration → Permissions
- [x] Click on execution role
- [x] Add inline policy (copy JSON from QUICK_START.md)
- [x] Replace `YOUR_BUCKET_NAME` with `market-dashboard-csv-data`
- [x] Create policy (`CSVProcessorPolicy`)

### 2️⃣ Upload Lambda Code (3 min) ✅ COMPLETED
**Guide:** `aws/lambda/DEPLOYMENT_GUIDE.md`

```bash
cd aws/lambda
zip csv_processor.zip csv_processor.py
```

- [x] Create ZIP file
- [x] Go to Lambda → Code source
- [x] Upload from → .zip file
- [x] Upload csv_processor.zip

### 3️⃣ Configure Lambda Settings (2 min) ✅ COMPLETED

- [x] Runtime settings → Edit
  - Handler: `csv_processor.lambda_handler`
  - Runtime: Python 3.9
- [x] General configuration → Edit
  - Memory: 512 MB
  - Timeout: 30 seconds
- [x] Environment variables → Edit
  - `PORTFOLIO_TABLE` = `PortfolioSnapshots`
  - `HOLDINGS_TABLE` = `Holdings`
  - `LOGS_TABLE` = `ProcessingLogs`

### 4️⃣ Add S3 Trigger (2 min) ✅ COMPLETED
**Guide:** `aws/S3_TRIGGER_SETUP.md`

- [x] Click Add trigger
- [x] Select S3
- [x] Choose your bucket (`market-dashboard-csv-data`)
- [x] Event type: PUT
- [x] Prefix: `uploads/`
- [x] Suffix: `.csv`
- [x] Add trigger

### 5️⃣ Test with Sample CSV (5 min) ⏳ IN PROGRESS

Test file created: `test-portfolio.csv` (5 holdings: AAPL, MSFT, SPY, QQQ, TSLA)

**Lambda Test Event Configured:**
```json
{
  "Records": [{
    "s3": {
      "bucket": {"name": "market-dashboard-csv-data"},
      "object": {"key": "uploads/test-portfolio.csv"}
    }
  }]
}
```

- [x] Create test CSV file
- [x] Upload to S3: `s3://market-dashboard-csv-data/uploads/test-portfolio.csv`
- [x] Create Lambda test event
- [ ] **RUN TEST EVENT** ← START HERE TOMORROW
- [ ] Check Lambda logs in CloudWatch for success
- [ ] Verify data in DynamoDB:
  - [ ] PortfolioSnapshots has new snapshot entry
  - [ ] Holdings has 5 entries (AAPL, MSFT, SPY, QQQ, TSLA)
  - [ ] ProcessingLogs shows SUCCESS status

### 6️⃣ Set Up API Gateway (15 min)
**Status:** Guide to be created next

- [ ] Create REST API
- [ ] Create resources and methods
- [ ] Connect to DynamoDB
- [ ] Deploy API
- [ ] Get API endpoint URL

### 7️⃣ Update Frontend (10 min)

- [ ] Update API endpoints in frontend
- [ ] Replace mock data with API calls
- [ ] Test dashboard with real data

## Verification

After setup is complete, you should be able to:

1. ✅ Upload Schwab CSV to S3
2. ✅ Lambda automatically processes it
3. ✅ Data appears in DynamoDB
4. ✅ Dashboard fetches and displays portfolio data
5. ✅ No more zeroed values!

## Current Progress (Updated: October 3, 2025)

- ✅ Step 1: IAM Permissions (COMPLETED)
- ✅ Step 2: Lambda Code (COMPLETED)
- ✅ Step 3: Lambda Config (COMPLETED)
- ✅ Step 4: S3 Trigger (COMPLETED)
- ⏳ Step 5: Testing (IN PROGRESS - Lambda test event ready, needs execution)
- ⏳ Step 6: API Gateway (Next - pending Lambda test success)
- ⏳ Step 7: Frontend (Final step)

## Time Estimate

- **Core Setup**: ~20-30 minutes (Steps 1-5)
- **Full Integration**: ~45-60 minutes (Steps 1-7)

## Support

- Detailed IAM guide: `aws/iam/IAM_SETUP_GUIDE.md`
- Lambda deployment: `aws/lambda/DEPLOYMENT_GUIDE.md`
- S3 trigger setup: `aws/S3_TRIGGER_SETUP.md`

## What You'll Have After This

```
Schwab CSV → S3 Upload → Lambda Process → DynamoDB Store → API Gateway → Dashboard Display
```

A fully automated portfolio tracking system that updates whenever you upload a new Schwab CSV export!
