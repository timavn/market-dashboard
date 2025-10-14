# Daily Market Data Schedule

## EventBridge Rule Configuration

### Rule Details
- **Name**: `DailyMarketDataFetch`
- **Description**: Trigger market data fetch after market close
- **Schedule**: `cron(30 21 * * ? *)` (4:30 PM ET / 9:30 PM UTC)
- **Target**: Lambda function `MarketDataDailyFetcher`

### Cron Expression Breakdown
- `30 21 * * ? *`
- `30` = 30 minutes past the hour
- `21` = 9 PM UTC (4 PM EST + 5 hours = 9 PM UTC, but we want 4:30 PM EST = 9:30 PM UTC)
- `*` = Every day of month
- `*` = Every month
- `?` = Any day of week
- `*` = Every year

**Note**: Market closes at 4:00 PM ET, we fetch at 4:30 PM ET to ensure all data is available.

## AWS CLI Commands

### Create EventBridge Rule
```bash
aws events put-rule \
  --name DailyMarketDataFetch \
  --description "Daily market data fetch after market close" \
  --schedule-expression "cron(30 21 * * ? *)" \
  --state ENABLED \
  --region us-west-1
```

### Add Lambda Target
```bash
aws events put-targets \
  --rule DailyMarketDataFetch \
  --targets "Id"="1","Arn"="arn:aws:lambda:us-west-1:YOUR_ACCOUNT_ID:function:MarketDataDailyFetcher" \
  --region us-west-1
```

### Grant EventBridge Permission to Invoke Lambda
```bash
aws lambda add-permission \
  --function-name MarketDataDailyFetcher \
  --statement-id allow-eventbridge \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn "arn:aws:events:us-west-1:YOUR_ACCOUNT_ID:rule/DailyMarketDataFetch" \
  --region us-west-1
```

## AWS Console Steps

### 1. Create EventBridge Rule
1. Go to **EventBridge Console**
2. Click **Create rule**
3. **Name**: `DailyMarketDataFetch`
4. **Description**: `Daily market data fetch after market close`
5. **Rule type**: Schedule
6. **Schedule pattern**: Cron expression
7. **Cron expression**: `30 21 * * ? *`
8. Click **Next**

### 2. Add Target
1. **Target type**: AWS service
2. **Service**: Lambda function
3. **Function**: `MarketDataDailyFetcher`
4. Click **Next**

### 3. Configure Details
1. **State**: Enabled
2. Click **Create rule**

### 4. Grant Lambda Permission
1. Go to **Lambda Console** → `MarketDataDailyFetcher`
2. **Configuration** → **Permissions**
3. **Resource-based policy statements** → **Add permissions**
4. **Statement ID**: `allow-eventbridge`
5. **Principal**: `events.amazonaws.com`
6. **Source ARN**: `arn:aws:events:us-west-1:YOUR_ACCOUNT_ID:rule/DailyMarketDataFetch`
7. **Action**: `lambda:InvokeFunction`
8. Click **Save**

## Testing the Schedule

### Manual Test
```bash
# Test the Lambda function directly
aws lambda invoke \
  --function-name MarketDataDailyFetcher \
  --payload '{}' \
  --region us-west-1 \
  response.json
```

### Check EventBridge Logs
1. Go to **EventBridge Console**
2. Click on `DailyMarketDataFetch` rule
3. **Metrics** tab to see execution history
4. **CloudWatch Logs** to see Lambda execution logs

## Expected Behavior

- **Daily at 4:30 PM ET**: EventBridge triggers Lambda
- **Lambda fetches**: Market data for key symbols (SPY, QQQ, AAPL, etc.)
- **Stores data**: In DynamoDB MarketData table
- **Logs**: Success/failure in CloudWatch

## Monitoring

- **CloudWatch Logs**: `/aws/lambda/MarketDataDailyFetcher`
- **DynamoDB**: Check MarketData table for new daily entries
- **EventBridge**: Rule execution metrics
