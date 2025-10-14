# 🚨 FIX: DynamoDB Schema Mismatch Error

## Problem Analysis

**Error**: `ValidationException: The provided key element does not match the schema`

**Root Cause**: The DynamoDB tables either don't exist or have incorrect schemas that don't match what the Lambda function expects.

## ✅ Complete Fix Steps

### Step 1: Create DynamoDB Tables (CRITICAL)

**Option A: Use the Python Script (Recommended)**
```bash
cd /Users/timsmith/Desktop/cursor/market-dashboard/aws/dynamodb
python3 create_tables.py
```

**Option B: AWS Console**
1. Go to DynamoDB → Tables → Create table
2. Create these 3 tables:

**PortfolioSnapshots Table:**
- Table name: `PortfolioSnapshots`
- Partition key: `snapshotId` (String)
- Sort key: `timestamp` (String)
- Billing mode: On-demand

**Holdings Table:**
- Table name: `Holdings`  
- Partition key: `holdingId` (String)
- Billing mode: On-demand

**ProcessingLogs Table:**
- Table name: `ProcessingLogs`
- Partition key: `logId` (String)
- Billing mode: On-demand

### Step 2: Update Lambda Function Code

The Lambda function has been updated with:
- ✅ Better error handling for DynamoDB operations
- ✅ Proper Decimal to float conversion for DynamoDB
- ✅ Explicit field mapping to avoid schema issues

**Deploy the updated code:**
```bash
cd /Users/timsmith/Desktop/cursor/market-dashboard/aws/lambda
zip csv_processor.zip csv_processor.py
```

Then upload to Lambda console.

### Step 3: Update IAM Permissions

The IAM policy has been updated with the correct bucket name.

**Apply the updated policy:**
1. Go to IAM → Roles → `CSVPortfolioProcessor-role-XXXXX`
2. Click "Add permissions" → "Create inline policy"
3. Copy the contents from `aws/lambda/iam-policy.json`
4. Name it: `CSVProcessorPolicy`
5. Attach to the role

### Step 4: Test the Fix

**Create a test event in Lambda console:**
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

**Expected Results:**
- ✅ Lambda executes successfully
- ✅ PortfolioSnapshots table gets 1 new item
- ✅ Holdings table gets 5 new items (AAPL, MSFT, SPY, QQQ, TSLA)
- ✅ ProcessingLogs table shows SUCCESS status

## 🔍 Verification Steps

### Check DynamoDB Tables
1. Go to DynamoDB → Tables
2. Click on each table → "Explore table items"
3. Verify data structure matches expected format

### Check CloudWatch Logs
1. Go to CloudWatch → Log groups → `/aws/lambda/CSVPortfolioProcessor`
2. Look for successful execution logs
3. No more "ValidationException" errors

## 📊 Expected Data Structure

### PortfolioSnapshots Item:
```json
{
  "snapshotId": "20251006_204402",
  "timestamp": "2025-10-06T20:44:02.123456",
  "summary": {
    "totalValue": 115460.0,
    "totalGainLoss": 8959.0,
    "totalGainLossPercent": 8.4,
    "positionCount": 5,
    "totalCostBasis": 106501.0
  },
  "assetAllocation": {
    "Equities": 65.2,
    "ETFs": 34.8
  },
  "holdingsCount": 5
}
```

### Holdings Items (5 total):
```json
{
  "holdingId": "20251006_204402#AAPL",
  "snapshotId": "20251006_204402",
  "symbol": "AAPL",
  "description": "Apple Inc",
  "quantity": 100.0,
  "price": 175.50,
  "marketValue": 17550.00,
  "costBasis": 15000.00,
  "gainLoss": 2550.00,
  "gainLossPercent": 17.00,
  "assetType": "Equity",
  "assetClass": "Equities"
}
```

## 🚨 Troubleshooting

### Error: "Table does not exist"
**Solution**: Run the table creation script or create tables manually

### Error: "Access Denied" 
**Solution**: Update IAM permissions with the correct policy

### Error: "ValidationException" still occurs
**Solution**: 
1. Verify table partition keys are exactly:
- PortfolioSnapshots: `snapshotId` (String) + `timestamp` (String)
- Holdings: `holdingId` (String)  
- ProcessingLogs: `logId` (String)
2. Redeploy the updated Lambda function code

### Error: "Task timed out"
**Solution**: Increase Lambda timeout to 30 seconds

## 🎯 Next Steps After Fix

1. ✅ Test Lambda function with test event
2. ✅ Upload real Schwab CSV to S3
3. ✅ Set up API Gateway for data access
4. ✅ Update frontend to use API Gateway

## 💰 Cost Impact

Creating these tables with on-demand billing:
- **PortfolioSnapshots**: ~$0.25/month (1 write per day)
- **Holdings**: ~$1.00/month (5 writes per day)  
- **ProcessingLogs**: ~$0.25/month (1 write per day)

**Total**: ~$1.50/month for typical usage

## 📞 Support

If issues persist:
1. Check CloudWatch logs for detailed error messages
2. Verify all 3 tables exist and are "Active"
3. Ensure IAM permissions include all required DynamoDB actions
4. Test with the provided test CSV file first
