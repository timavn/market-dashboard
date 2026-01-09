# Performance Tracking System - Testing Guide

## Prerequisites

1. AWS CLI configured with appropriate credentials
2. DynamoDB tables created (see below)
3. Lambda function deployed with updated code
4. Local development server running

---

## Step 1: Create DynamoDB Tables

Run these commands to create the required tables:

```bash
# Navigate to project directory
cd /Users/timsmith/Desktop/cursor/market-dashboard

# Create PerformanceHistory table
aws dynamodb create-table \
  --table-name PerformanceHistory \
  --attribute-definitions \
    AttributeName=date,AttributeType=S \
  --key-schema \
    AttributeName=date,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-1

# Create PositionPerformance table with GSI
aws dynamodb create-table \
  --table-name PositionPerformance \
  --attribute-definitions \
    AttributeName=symbol,AttributeType=S \
    AttributeName=date,AttributeType=S \
  --key-schema \
    AttributeName=symbol,KeyType=HASH \
    AttributeName=date,KeyType=RANGE \
  --global-secondary-indexes \
    '[{
      "IndexName": "date-index",
      "KeySchema": [
        {"AttributeName": "date", "KeyType": "HASH"},
        {"AttributeName": "symbol", "KeyType": "RANGE"}
      ],
      "Projection": {"ProjectionType": "ALL"},
      "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5}
    }]' \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-1

# Create PerformanceMetrics table
aws dynamodb create-table \
  --table-name PerformanceMetrics \
  --attribute-definitions \
    AttributeName=metricType,AttributeType=S \
    AttributeName=calculationDate,AttributeType=S \
  --key-schema \
    AttributeName=metricType,KeyType=HASH \
    AttributeName=calculationDate,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-1
```

**Verify tables were created:**
```bash
aws dynamodb list-tables --region us-west-1
```

You should see:
- `PerformanceHistory`
- `PositionPerformance`
- `PerformanceMetrics`

---

## Step 2: Deploy Updated Lambda Function

### Option A: Using existing deployment script
```bash
cd aws/lambda
./deploy.sh csv_processor
```

### Option B: Manual deployment
```bash
cd aws/lambda

# Zip the function (if not already done)
zip -r csv_processor.zip csv_processor.py

# Update Lambda function code
aws lambda update-function-code \
  --function-name csv-processor \
  --zip-file fileb://csv_processor.zip \
  --region us-west-1
```

**Verify Lambda has correct environment variables:**
```bash
aws lambda get-function-configuration \
  --function-name csv-processor \
  --region us-west-1
```

Ensure these environment variables are set:
- `PERFORMANCE_TABLE=PerformanceHistory`
- `POSITION_PERFORMANCE_TABLE=PositionPerformance`

---

## Step 3: Prepare Test CSV Files

### Create test CSV files with dates in filenames

**Format 1: `portfolio_YYYY-MM-DD.csv`**
```bash
# Example: portfolio_2025-01-15.csv
```

**Format 2: `YYYY-MM-DD.csv`**
```bash
# Example: 2025-01-15.csv
```

**Format 3: `statement_YYYY-MM-DD.csv`**
```bash
# Example: statement_2025-01-15.csv
```

### Test CSV Content

Use your existing Schwab CSV format. The Lambda will:
1. Extract date from filename
2. Parse portfolio data
3. Calculate daily returns (vs previous day)
4. Store in performance tables

**Important:** For the first upload, there won't be a previous day, so daily return will be 0%. For subsequent uploads, it will calculate the difference.

---

## Step 4: Upload Test CSV to S3

```bash
# Upload with date in filename
aws s3 cp test-portfolio.csv s3://market-dashboard-csv-data/uploads/portfolio_2025-01-15.csv

# Or upload multiple days (simulate daily uploads)
aws s3 cp test-portfolio.csv s3://market-dashboard-csv-data/uploads/portfolio_2025-01-14.csv
aws s3 cp test-portfolio.csv s3://market-dashboard-csv-data/uploads/portfolio_2025-01-15.csv
aws s3 cp test-portfolio.csv s3://market-dashboard-csv-data/uploads/portfolio_2025-01-16.csv
```

**Note:** Modify the portfolio values in each CSV to see different returns, or use the same file to test with 0% daily returns.

---

## Step 5: Check Lambda Execution

### View Lambda logs
```bash
aws logs tail /aws/lambda/csv-processor --follow --region us-west-1
```

**Look for:**
- `Processing file: market-dashboard-csv-data/uploads/portfolio_2025-01-15.csv`
- `Extracted date from filename: 2025-01-15`
- `Stored performance data for 2025-01-15: daily return = X%, cumulative = Y%`
- `Stored position performance data for N positions`

### Check for errors
If you see errors about missing tables, verify table names match exactly.

---

## Step 6: Verify Data in DynamoDB

### Check PerformanceHistory
```bash
aws dynamodb scan \
  --table-name PerformanceHistory \
  --region us-west-1 \
  --max-items 10
```

**Expected output:**
```json
{
  "Items": [
    {
      "date": {"S": "2025-01-15"},
      "totalValue": {"N": "115460.00"},
      "dailyReturn": {"N": "0.85"},
      "cumulativeReturn": {"N": "8.40"},
      "snapshotId": {"S": "20250115_203000"},
      "positionCount": {"N": "5"},
      "timestamp": {"S": "2025-01-15T20:30:00.000Z"}
    }
  ]
}
```

### Check PositionPerformance
```bash
aws dynamodb scan \
  --table-name PositionPerformance \
  --region us-west-1 \
  --max-items 5
```

### Check PerformanceMetrics (may be empty initially)
```bash
aws dynamodb scan \
  --table-name PerformanceMetrics \
  --region us-west-1
```

**Note:** Metrics table will be empty until you run the metrics calculator Lambda or it calculates automatically.

---

## Step 7: Test Backend API Endpoints

### Start the backend server
```bash
cd /Users/timsmith/Desktop/cursor/market-dashboard
npm run server
```

Server should start on `http://localhost:3001`

### Test endpoints using curl or browser

#### 1. Get Performance History
```bash
curl http://localhost:3001/api/performance/history
```

**Expected response:**
```json
{
  "dates": ["2025-01-14", "2025-01-15", "2025-01-16"],
  "values": [115000, 115460, 116000],
  "returns": [0, 0.40, 0.47],
  "cumulativeReturns": [0, 0.40, 0.87],
  "data": [...]
}
```

#### 2. Get Performance Metrics
```bash
curl http://localhost:3001/api/performance/metrics?period=all
```

**Expected response:**
```json
{
  "sharpeRatio": 0,
  "maxDrawdown": 0,
  "volatility": 0,
  "winRate": 0,
  "avgDailyReturn": 0,
  "bestDay": 0,
  "worstDay": 0,
  "rollingReturns": {},
  "vsBenchmark": {},
  "calculationDate": null
}
```

**Note:** Metrics will be 0/null until you have multiple days of data and run the metrics calculator.

#### 3. Get Equity Curve
```bash
curl http://localhost:3001/api/performance/equity-curve
```

**Expected response:**
```json
{
  "dates": ["2025-01-14", "2025-01-15", "2025-01-16"],
  "values": [115000, 115460, 116000],
  "drawdowns": [0, 0, 0],
  "returns": [0, 0.40, 0.47],
  "cumulativeReturns": [0, 0.40, 0.87]
}
```

#### 4. Get Benchmark Comparison
```bash
curl "http://localhost:3001/api/performance/benchmark-comparison?benchmarks=SPY,QQQ"
```

#### 5. Get Position Performance
```bash
curl "http://localhost:3001/api/performance/positions?symbol=AAPL"
```

---

## Step 8: Test Frontend

### Start React development server
```bash
npm start
```

App should open at `http://localhost:3000`

### Navigate to Performance Tracking

1. **Open the dashboard**
2. **Click the Performance Tracking button** (stock chart icon in the left sidebar)
3. **Verify the page loads** with:
   - Key metrics cards at the top
   - Equity curve chart
   - Performance vs benchmarks chart
   - Other visualizations

### Expected Behavior

**If no data:**
- Shows message: "No performance data available. Upload a portfolio statement..."
- All metrics show "N/A"

**If data exists:**
- Metrics cards show calculated values
- Charts display data
- Period selector works (30d, 90d, 1y, All)

### Test Period Selector
- Click period dropdown
- Select different periods
- Verify data updates (if you have enough historical data)

---

## Step 9: Test Date Extraction

### Test different filename formats

Upload CSVs with different naming patterns:

```bash
# Format 1: portfolio_YYYY-MM-DD.csv
aws s3 cp test.csv s3://market-dashboard-csv-data/uploads/portfolio_2025-01-20.csv

# Format 2: YYYY-MM-DD.csv
aws s3 cp test.csv s3://market-dashboard-csv-data/uploads/2025-01-21.csv

# Format 3: statement_YYYY-MM-DD.csv
aws s3 cp test.csv s3://market-dashboard-csv-data/uploads/statement_2025-01-22.csv
```

**Check Lambda logs** to verify date extraction:
```
Extracted date from filename: 2025-01-20
Extracted date from filename: 2025-01-21
Extracted date from filename: 2025-01-22
```

---

## Step 10: Test Duplicate Date Handling

### Upload same date twice
```bash
# First upload
aws s3 cp test1.csv s3://market-dashboard-csv-data/uploads/portfolio_2025-01-25.csv

# Second upload (should replace first)
aws s3 cp test2.csv s3://market-dashboard-csv-data/uploads/portfolio_2025-01-25.csv
```

**Verify:**
- Only one record exists in PerformanceHistory for that date
- Latest upload's data is stored (replaced previous)

```bash
aws dynamodb get-item \
  --table-name PerformanceHistory \
  --key '{"date": {"S": "2025-01-25"}}' \
  --region us-west-1
```

---

## Step 11: Test Metrics Calculation (Optional)

### Run metrics calculator Lambda

If you've deployed the metrics calculator Lambda:

```bash
# Invoke manually
aws lambda invoke \
  --function-name performance-metrics-calculator \
  --payload '{"date": "2025-01-15"}' \
  --region us-west-1 \
  response.json

cat response.json
```

**Or trigger via EventBridge** (if configured):
- Metrics will calculate automatically after each CSV upload
- Or on a daily schedule

---

## Troubleshooting

### Issue: "Table does not exist"
**Solution:** Verify table names match exactly (case-sensitive)
```bash
aws dynamodb list-tables --region us-west-1
```

### Issue: "Date not extracted from filename"
**Solution:** Check filename format matches one of the supported patterns:
- `portfolio_YYYY-MM-DD.csv`
- `YYYY-MM-DD.csv`
- `statement_YYYY-MM-DD.csv`

### Issue: "Daily return is always 0%"
**Solution:** 
- First upload will always be 0% (no previous day)
- Ensure you upload multiple days with dates in sequence
- Check that previous day's data exists in PerformanceHistory

### Issue: "Metrics show 0 or N/A"
**Solution:**
- Metrics require multiple days of data
- Run the metrics calculator Lambda
- Or wait for automatic calculation

### Issue: "Frontend shows no data"
**Solution:**
- Check browser console for errors
- Verify backend server is running on port 3001
- Check API endpoints return data using curl
- Verify CORS is configured correctly

### Issue: "Charts not rendering"
**Solution:**
- Check browser console for JavaScript errors
- Verify Recharts is installed: `npm list recharts`
- Check that data format matches expected structure

---

## Quick Test Checklist

- [ ] DynamoDB tables created
- [ ] Lambda function deployed
- [ ] CSV uploaded with date in filename
- [ ] Lambda processed successfully (check logs)
- [ ] Data visible in DynamoDB
- [ ] Backend API returns data
- [ ] Frontend page loads
- [ ] Charts display correctly
- [ ] Period selector works
- [ ] Multiple days of data uploaded
- [ ] Metrics calculated (if applicable)

---

## Next Steps After Testing

1. **Set up EventBridge schedule** for daily metrics calculation
2. **Configure S3 bucket** for automatic CSV processing
3. **Set up monitoring** for Lambda execution
4. **Add alerts** for processing failures
5. **Backfill historical data** if needed (upload past statements)

---

## Sample Test Data

To test with realistic data, modify your CSV to have different portfolio values:

**Day 1 (2025-01-15):** Total Value = $100,000
**Day 2 (2025-01-16):** Total Value = $100,500 (0.5% gain)
**Day 3 (2025-01-17):** Total Value = $99,800 (-0.7% loss)

This will show:
- Daily returns: 0%, 0.5%, -0.7%
- Cumulative returns: 0%, 0.5%, -0.2%
- Drawdowns calculated correctly
- Win rate: 33% (1 positive day out of 3)



