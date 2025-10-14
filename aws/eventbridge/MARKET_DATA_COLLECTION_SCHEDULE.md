# Market Data Collection EventBridge Schedules

## Overview

Two EventBridge rules to schedule daily market data collection and correlation calculation:

1. **Market Data Collection**: Runs at 5:00 PM EST daily
2. **Correlation Calculation**: Runs at 5:30 PM EST daily

## Schedule 1: Market Data Collection

**Rule Name**: `MarketDataCollectionSchedule`

**Schedule Expression**: `cron(0 22 * * ? *)`
- 22:00 UTC = 5:00 PM EST (6:00 PM EDT during daylight saving)
- Runs daily at market close

**Target**: Lambda function `MarketDataCollector`

**Purpose**: Collect daily market data from FRED and Yahoo Finance APIs

## Schedule 2: Correlation Calculation

**Rule Name**: `USDCorrelationCalculationSchedule`

**Schedule Expression**: `cron(30 22 * * ? *)`
- 22:30 UTC = 5:30 PM EST (6:30 PM EDT during daylight saving)
- Runs 30 minutes after data collection

**Target**: Lambda function `USDCorrelationCalculator`

**Purpose**: Calculate USD correlations using collected market data

## Creation Commands

```bash
# Create EventBridge rule for market data collection
aws events put-rule \
  --name MarketDataCollectionSchedule \
  --schedule-expression "cron(0 22 * * ? *)" \
  --description "Daily market data collection at 5:00 PM EST" \
  --region us-west-1

# Add Lambda target for market data collection
aws events put-targets \
  --rule MarketDataCollectionSchedule \
  --targets "Id"="1","Arn"="arn:aws:lambda:us-west-1:ACCOUNT_ID:function:MarketDataCollector" \
  --region us-west-1

# Create EventBridge rule for correlation calculation
aws events put-rule \
  --name USDCorrelationCalculationSchedule \
  --schedule-expression "cron(30 22 * * ? *)" \
  --description "Daily USD correlation calculation at 5:30 PM EST" \
  --region us-west-1

# Add Lambda target for correlation calculation
aws events put-targets \
  --rule USDCorrelationCalculationSchedule \
  --targets "Id"="1","Arn"="arn:aws:lambda:us-west-1:ACCOUNT_ID:PROFILE:function:USDCorrelationCalculator" \
  --region us-west-1
```

## Lambda Permissions

Each Lambda function needs permission to be invoked by EventBridge:

```bash
# Grant EventBridge permission to invoke MarketDataCollector
aws lambda add-permission \
  --function-name MarketDataCollector \
  --statement-id AllowExecutionFromEventBridge \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn arn:aws:events:us-west-1:ACCOUNT_ID:rule/MarketDataCollectionSchedule \
  --region us-west-1

# Grant EventBridge permission to invoke USDCorrelationCalculator
aws lambda add-permission \
  --function-name USDCorrelationCalculator \
  --statement-id AllowExecutionFromEventBridge \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn arn:aws:events:us-west-1:ACCOUNT_ID:rule/USDCorrelationCalculationSchedule \
  --region us-west-1
```

## Time Zone Considerations

- **EST (Eastern Standard Time)**: UTC-5 (November - March)
- **EDT (Eastern Daylight Time)**: UTC-4 (March - November)

The cron expressions use UTC time:
- 22:00 UTC = 5:00 PM EST / 6:00 PM EDT
- 22:30 UTC = 5:30 PM EST / 6:30 PM EDT

## Monitoring

Monitor the schedules in AWS Console:
- **EventBridge Console**: Rules → View execution history
- **CloudWatch Logs**: Check Lambda function logs for execution details
- **CloudWatch Metrics**: Monitor Lambda invocations and errors

## Cost

- **EventBridge**: $0.10 per million events (effectively free for daily schedules)
- **Lambda**: ~$0.10/month for daily executions
- **Total**: ~$0.10/month additional cost
