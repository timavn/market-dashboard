# Deploy 3-Row Header Fix for Schwab CSV

## ✅ Updated Lambda Script

The Lambda script now properly handles Schwab's 3-row header format:
- **Row 1**: Account info (`"Positions for account Individual ...197 as of 08:29 PM ET, 2025/10/06"`)
- **Row 2**: Blank row
- **Row 3**: Column headers (`Symbol,Description,Qty (Quantity),Price,...`)
- **Row 4+**: Actual holdings data

## 🔧 Key Changes Made

1. **Enhanced Header Detection**: Added debug logging to show which row contains the headers
2. **Improved Row Filtering**: Better handling of footer rows (`Cash & Cash Investments`, `Account Total`)
3. **Debug Logging**: Added logging for first few rows to help troubleshoot parsing

## 🚀 Deploy Updated Lambda

### Step 1: Upload to AWS Lambda Console

1. Go to **AWS Lambda Console**
2. Find function: `CSVPortfolioProcessor`
3. Click **Upload from** → **.zip file**
4. Upload: `aws/lambda/csv_processor_schwab_3row_fixed.zip`
5. Click **Save**

### Step 2: Test with Your Schwab CSV

1. Save your Schwab CSV as `test-schwab.csv` in your project folder
2. Upload to S3 bucket: `market-dashboard-csv-data`
3. Check CloudWatch logs for:
   - `Found header row at index 2: Symbol,Description,Qty (Quantity)...`
   - `Processing row: Symbol='EFIR', Description='EGPI FIRECREEK INC'...`
   - `Stored 31 holdings (replaced all previous)`

## 🎯 Expected Results

After deployment:
- ✅ Header detection will find row 3 (index 2) as the header row
- ✅ All 31 holdings will be parsed correctly
- ✅ Footer rows (`Cash & Cash Investments`, `Account Total`) will be skipped
- ✅ Daily replacement logic will work (old holdings deleted, new ones stored)
- ✅ No more AccessDenied errors (IAM permissions fixed)

## 📋 Files Ready for Deployment

- `aws/lambda/csv_processor_schwab_3row_fixed.zip` - Updated Lambda package
- IAM permissions already updated in AWS Console

## 🔍 Verification Steps

1. **Check CloudWatch Logs**:
   - Look for "Found header row at index 2"
   - Look for "Processing row" messages for first few holdings
   - Look for "Stored 31 holdings (replaced all previous)"

2. **Check DynamoDB Holdings Table**:
   - Should contain exactly 31 holdings
   - All market values > $0
   - Proper symbols like EFIR, AAAU, BDRY, etc.

Ready to deploy and test! 🚀
