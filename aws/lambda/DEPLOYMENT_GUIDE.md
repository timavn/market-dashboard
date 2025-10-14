# Step-by-Step Lambda Deployment Guide

Follow these steps to deploy the CSV processor Lambda function.

## Prerequisites
- AWS account with access to Lambda, S3, and DynamoDB
- DynamoDB tables already created: PortfolioSnapshots, Holdings, ProcessingLogs
- S3 bucket created for CSV uploads

## Step 1: Update IAM Role Permissions

1. Go to **IAM → Roles** in AWS Console
2. Find the role: `CSVPortfolioProcessor-role-XXXXX` (or similar)
3. Click **Add permissions → Attach policies**
4. Click **Create policy**
5. Click **JSON** tab
6. Copy the contents of `iam-policy.json`
7. Replace `YOUR_BUCKET_NAME` with your actual S3 bucket name
8. Click **Review policy**
9. Name it: `LambdaCSVProcessorPolicy`
10. Click **Create policy**
11. Go back to the role and attach this new policy

## Step 2: Create Deployment Package

On your local machine:

```bash
cd /Users/timsmith/Desktop/cursor/market-dashboard/aws/lambda

# Install dependencies (boto3 is included in Lambda by default, but good to have)
pip3 install -r requirements.txt -t .

# Create ZIP package
zip -r csv_processor.zip csv_processor.py
```

Note: boto3 is already available in Lambda Python runtime, so we just need the .py file.

## Step 3: Update Lambda Function Configuration

1. Go to **Lambda → Functions** in AWS Console
2. Click on **CSVPortfolioProcessor**
3. Under **Runtime settings**:
   - Click **Edit**
   - Runtime: Python 3.9
   - Handler: csv_processor.lambda_handler
   - Click **Save**

4. Under **General configuration**:
   - Click **Edit**
   - Memory: 512 MB
   - Timeout: 30 seconds
   - Click **Save**

5. Under **Environment variables**:
   - Click **Edit**
   - Add:
     - `PORTFOLIO_TABLE` = `PortfolioSnapshots`
     - `HOLDINGS_TABLE` = `Holdings`
     - `LOGS_TABLE` = `ProcessingLogs`
   - Click **Save**

## Step 4: Upload Function Code

1. In the Lambda function console, scroll to **Code source**
2. Click **Upload from → .zip file**
3. Choose `csv_processor.zip`
4. Click **Save**

## Step 5: Configure S3 Trigger

1. In your Lambda function, click **Add trigger**
2. Select **S3** from the dropdown
3. Configure:
   - **Bucket**: Select your S3 bucket
   - **Event type**: PUT
   - **Prefix**: `uploads/` (optional - only trigger for files in uploads/ folder)
   - **Suffix**: `.csv` (only trigger for CSV files)
   - Check **Recursive invocation** acknowledgment
4. Click **Add**

## Step 6: Test the Function

### Create a test CSV file

Create a file named `test-portfolio.csv` with Schwab format:

```csv
Symbol,Description,Quantity,Price,Market Value,Cost Basis Total,Gain/Loss $,Gain/Loss %,Type
AAPL,Apple Inc,100,$175.50,$17550.00,$15000.00,$2550.00,17.00%,Equity
MSFT,Microsoft Corp,50,$380.25,$19012.50,$17000.00,$2012.50,11.84%,Equity
SPY,SPDR S&P 500 ETF,75,$454.70,$34102.50,$32000.00,$2102.50,6.57%,ETFs & Closed End Funds
```

### Upload to S3

1. Go to **S3 → Buckets**
2. Open your bucket
3. Create folder `uploads/` (if you set a prefix)
4. Upload `test-portfolio.csv` to the `uploads/` folder

### Monitor the Execution

1. Go to **Lambda → Functions → CSVPortfolioProcessor**
2. Click **Monitor** tab
3. Click **View logs in CloudWatch**
4. You should see a new log stream with processing details

### Verify Data in DynamoDB

1. Go to **DynamoDB → Tables**
2. Open **PortfolioSnapshots** table
3. Click **Explore table items**
4. You should see a new snapshot with today's timestamp
5. Check **Holdings** table - should have 3 items (AAPL, MSFT, SPY)
6. Check **ProcessingLogs** table - should show SUCCESS status

## Troubleshooting

### Common Errors

**Error: "Access Denied" when reading from S3**
- Solution: Check IAM policy has s3:GetObject permission for your bucket

**Error: "Table does not exist"**
- Solution: Verify DynamoDB table names in environment variables match actual table names

**Error: "Unable to import module"**
- Solution: Ensure Handler is set to `csv_processor.lambda_handler`

**Error: "Task timed out after 3 seconds"**
- Solution: Increase timeout in General configuration (should be 30 seconds)

### View Detailed Logs

```bash
# If you have AWS CLI installed
aws logs tail /aws/lambda/CSVPortfolioProcessor --follow
```

## Next Steps

Once Lambda is working:
1. Set up API Gateway to query DynamoDB (Step 5 in main todo list)
2. Update frontend to fetch from API Gateway instead of Express server
3. Test complete pipeline with real Schwab CSV export

## Cost Estimate

With typical usage (1-2 CSV uploads per day):
- Lambda: < $0.10/month (free tier covers this)
- S3: ~$0.50/month
- DynamoDB: ~$1-2/month

Total: **~$1.50-2.50/month**
