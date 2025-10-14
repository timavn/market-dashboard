# Daily Market Data Automation Setup

## 🎯 Overview
Set up automated daily market data fetching after market close (4:30 PM ET) for portfolio calculations.

## 📋 Prerequisites
- AWS CLI configured
- DynamoDB tables created
- Lambda execution role with proper permissions

## 🚀 Step-by-Step Setup

### 1. Create DynamoDB Table
```bash
# Create MarketData table
aws dynamodb create-table \
  --table-name MarketData \
  --attribute-definitions \
    AttributeName=date,AttributeType=S \
  --key-schema \
    AttributeName=date,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-1
```

**Or use AWS Console:**
1. DynamoDB → Create table
2. Table name: `MarketData`
3. Partition key: `date` (String)
4. Create table

### 2. Create Lambda Function
```bash
# Create Lambda function
aws lambda create-function \
  --function-name MarketDataDailyFetcher \
  --runtime python3.9 \
  --role arn:aws:iam::YOUR_ACCOUNT_ID:role/CSVPortfolioProcessor-role-6pwanxxe \
  --handler market_data_daily.lambda_handler \
  --zip-file fileb://market_data_daily.zip \
  --timeout 300 \
  --memory-size 256 \
  --region us-west-1
```

**Or use AWS Console:**
1. Lambda → Create function
2. Name: `MarketDataDailyFetcher`
3. Runtime: Python 3.9
4. Role: Reuse `CSVPortfolioProcessor-role-6pwanxxe`
5. Upload: `market_data_daily.zip`
6. Handler: `market_data_daily.lambda_handler`

### 3. Set Environment Variables
```bash
# Set environment variables (optional - for real market data)
aws lambda update-function-configuration \
  --function-name MarketDataDailyFetcher \
  --environment Variables='{
    "MARKET_DATA_TABLE":"MarketData",
    "ALPHA_VANTAGE_KEY":"YOUR_ALPHA_VANTAGE_KEY",
    "POLYGON_KEY":"YOUR_POLYGON_KEY"
  }' \
  --region us-west-1
```

**Or use AWS Console:**
1. Lambda → MarketDataDailyFetcher → Configuration
2. Environment variables:
   - `MARKET_DATA_TABLE` = `MarketData`
   - `ALPHA_VANTAGE_KEY` = (your key, optional)
   - `POLYGON_KEY` = (your key, optional)

### 4. Create EventBridge Rule
```bash
# Create the rule
aws events put-rule \
  --name DailyMarketDataFetch \
  --description "Daily market data fetch after market close" \
  --schedule-expression "cron(30 21 * * ? *)" \
  --state ENABLED \
  --region us-west-1
```

**Or use AWS Console:**
1. EventBridge → Create rule
2. Name: `DailyMarketDataFetch`
3. Schedule: Cron expression `30 21 * * ? *`
4. Target: Lambda function `MarketDataDailyFetcher`

### 5. Grant Permissions
```bash
# Allow EventBridge to invoke Lambda
aws lambda add-permission \
  --function-name MarketDataDailyFetcher \
  --statement-id allow-eventbridge \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn "arn:aws:events:us-west-1:YOUR_ACCOUNT_ID:rule/DailyMarketDataFetch" \
  --region us-west-1
```

## 🧪 Testing

### Test Lambda Function
```bash
# Manual test
aws lambda invoke \
  --function-name MarketDataDailyFetcher \
  --payload '{}' \
  --region us-west-1 \
  response.json

# Check response
cat response.json
```

### Verify DynamoDB
```bash
# Check if data was stored
aws dynamodb scan \
  --table-name MarketData \
  --region us-west-1
```

## 📊 What It Does

### Daily at 4:30 PM ET:
1. **EventBridge triggers** Lambda function
2. **Lambda fetches** market data for key symbols:
   - SPY, QQQ, IWM (major indices)
   - AAPL, MSFT, GOOGL, AMZN, TSLA, NVDA (tech stocks)
   - XLF, XLE, XLK, XLV, XLI (sector ETFs)
   - VIX, DIA, EFA, EEM, GLD, SLV (volatility/commodities)
3. **Stores data** in DynamoDB MarketData table
4. **Logs results** in CloudWatch

### Data Structure:
```json
{
  "date": "2025-10-10",
  "marketData": {
    "SPY": {
      "price": 450.25,
      "change": 2.15,
      "changePercent": 0.48,
      "volume": 45000000
    }
  }
}
```

## 🔧 Configuration Options

### Market Data Sources:
1. **Alpha Vantage** (free tier, 5 calls/minute)
2. **Polygon** (premium, better data)
3. **Mock data** (for development/testing)

### Schedule Options:
- **Current**: `cron(30 21 * * ? *)` (4:30 PM ET daily)
- **Weekdays only**: `cron(30 21 ? * MON-FRI *)`
- **Different time**: Change the hour/minute in cron expression

## 📈 Next Steps

After setup:
1. **Monitor execution** in CloudWatch Logs
2. **Verify data** in DynamoDB MarketData table
3. **Integrate with portfolio** calculations
4. **Add more symbols** as needed
5. **Set up alerts** for failures

## 🚨 Troubleshooting

### Common Issues:
- **Lambda timeout**: Increase timeout to 5 minutes
- **API rate limits**: Add delays between API calls
- **Missing permissions**: Ensure Lambda role has DynamoDB access
- **Cron not working**: Check timezone (UTC vs ET)

### Monitoring:
- **CloudWatch Logs**: `/aws/lambda/MarketDataDailyFetcher`
- **EventBridge**: Rule execution metrics
- **DynamoDB**: Table item count and size
