# Deploy Schwab CSV Parser Fix

## ✅ Completed Fixes

1. **Updated CSV Parser** (`csv_processor.py`):
   - Fixed footer row filtering to handle exact Schwab text: `Cash & Cash Investments`
   - Parser now correctly identifies and skips summary rows

2. **Updated IAM Policy** (`lambda-execution-role-policy.json`):
   - Added `dynamodb:Scan` permission for the `delete_all_holdings()` function
   - Added `dynamodb:DeleteItem` permission for batch deletion

3. **Created Deployment Package**:
   - `csv_processor_schwab_fixed.zip` ready for upload

## 🚀 Next Steps to Deploy

### Step 1: Update IAM Role in AWS Console

1. Go to **AWS IAM Console** → **Roles**
2. Find role: `CSVPortfolioProcessor-role-6pwanxxe`
3. Click **Add permissions** → **Attach policies**
4. Create new policy with the updated permissions from `lambda-execution-role-policy.json`
5. Or edit the existing policy to add:
   ```json
   "dynamodb:Scan",
   "dynamodb:DeleteItem"
   ```

### Step 2: Deploy Updated Lambda Function

**Option A: AWS Console**
1. Go to **AWS Lambda Console**
2. Find function: `CSVPortfolioProcessor`
3. Click **Upload from** → **.zip file**
4. Upload: `aws/lambda/csv_processor_schwab_fixed.zip`
5. Click **Save**

**Option B: AWS CLI** (if configured)
```bash
aws lambda update-function-code \
  --function-name CSVPortfolioProcessor \
  --zip-file fileb://aws/lambda/csv_processor_schwab_fixed.zip
```

### Step 3: Test with Real Schwab CSV

1. Save your Schwab CSV to the project folder as `test-schwab.csv`
2. Upload to S3 bucket: `market-dashboard-csv-data`
3. Check CloudWatch logs for successful processing
4. Verify DynamoDB tables contain all 31 holdings with correct values

## 🎯 Expected Results

After deployment:
- ✅ All 31 holdings from Schwab CSV will be parsed correctly
- ✅ Daily replacement logic will work (old holdings deleted, new ones stored)
- ✅ No more "AccessDenied" errors in CloudWatch logs
- ✅ Market values, gains/losses, and percentages will be accurate
- ✅ Frontend will display current portfolio data

## 🔍 Verification Steps

1. **Check CloudWatch Logs**:
   - Look for "Stored 31 holdings (replaced all previous)"
   - No "AccessDenied" errors

2. **Check DynamoDB Holdings Table**:
   - Should contain exactly 31 holdings
   - All market values > $0
   - Proper asset types and classes

3. **Check PortfolioSnapshots Table**:
   - New snapshot with `positionCount: 31`
   - Accurate `totalValue` and `totalGainLoss`

## 📋 Files Modified

- `aws/lambda/csv_processor.py` - Fixed footer row filtering
- `aws/lambda/csv_processor_schwab_fixed.zip` - Deployment package
- `aws/iam/lambda-execution-role-policy.json` - Added DynamoDB permissions
