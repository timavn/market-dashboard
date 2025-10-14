# USD Macro Dashboard Documentation

## Overview

The USD Macro Dashboard is a comprehensive trading tool that provides real-time USD correlation analysis and currency tracking. It replaces the Global Quad Matrix in the main portfolio dashboard and serves as the primary view for daily macro trading decisions.

## Architecture

### Data Flow
```
External APIs → Lambda Functions → DynamoDB → Backend API → Frontend Components
```

### Components
1. **Data Collection**: Lambda functions collect daily market data from FRED and Yahoo Finance
2. **Data Storage**: DynamoDB tables store price history and correlation calculations
3. **API Layer**: Express.js endpoints serve data to the frontend
4. **Frontend**: React components display correlation matrix and USD proxies

## Database Schema

### MarketPriceHistory Table
- **Primary Key**: `symbol` (String) + `date` (String)
- **Attributes**: `close`, `open`, `high`, `low`, `volume`, `timestamp`
- **Purpose**: Store daily price data for correlation calculations

### USDCorrelations Table
- **Primary Key**: `calculationDate` (String)
- **Attributes**: `correlations`, `rollingStats`, `timestamp`
- **Purpose**: Store pre-calculated correlation matrix results

## API Endpoints

### GET `/api/usd/dxy`
Returns latest DXY value with change information.

**Response:**
```json
{
  "value": 97.28,
  "change": "4.44",
  "changePercent": "4.78",
  "timestamp": "2025-10-12T00:17:55.033470"
}
```

### GET `/api/usd/currency-pairs`
Returns major currency pairs (USD/EUR, USD/JPY, etc.).

**Response:**
```json
[
  {
    "pair": "USDEUR",
    "name": "USD/EUR",
    "rate": "0.9234",
    "change": "-0.0012",
    "changePercent": "-0.13%",
    "timestamp": "2025-10-12T00:17:18.322Z"
  }
]
```

### GET `/api/usd/correlations`
Returns correlation matrix and rolling statistics.

**Response:**
```json
{
  "correlations": {
    "SPX": {
      "15D": 0.32,
      "30D": 0.16,
      "90D": -0.21,
      "120D": -0.63,
      "180D": -0.42
    }
  },
  "rollingStats": {
    "SPX": {
      "high": 0.89,
      "low": -0.91,
      "percentTimePositive": 42,
      "percentTimeNegative": 58
    }
  }
}
```

### GET `/api/usd/historical/:symbol`
Returns historical price data for a specific symbol.

**Parameters:**
- `symbol`: Asset symbol (DXY, SPX, GOLD, etc.)
- `days`: Number of days (default: 30)

## Lambda Functions

### MarketDataCollector
- **Schedule**: Daily at 5:00 PM EST
- **Purpose**: Collect daily market data from FRED and Yahoo Finance
- **Data Sources**: DXY (FRED), SPX, GOLD, BRENT, CRB, BTC (Yahoo Finance)

### USDCorrelationCalculator
- **Schedule**: Daily at 5:30 PM EST
- **Purpose**: Calculate USD correlations across multiple time periods
- **Periods**: 15D, 30D, 90D, 120D, 180D trading days
- **Statistics**: 52-week rolling correlation statistics

## Frontend Components

### USDMacroDashboard
Main container component that orchestrates data fetching and display.

### USDProxies
Displays DXY value and major currency pairs in a grid layout.

### USDCorrelationMatrix
Color-coded correlation table with:
- Correlation values for multiple time periods
- 52-week rolling statistics
- Color coding: Green (positive), Red (negative), Gray (neutral)

## Color Coding System

### Correlation Values
- **Strong Positive** (>0.3): Green background
- **Weak Positive** (0.1-0.3): Light green background
- **Neutral** (-0.1-0.1): Gray background
- **Weak Negative** (-0.3 to -0.1): Yellow background
- **Medium Negative** (-0.6 to -0.3): Light red background
- **Strong Negative** (<-0.6): Red background

### Change Indicators
- **Positive**: Green text
- **Negative**: Red text
- **Neutral**: Gray text

## Data Sources

### FRED (Federal Reserve Economic Data)
- **DXY**: DTWEXBGS series
- **Rate Limit**: No limit for basic usage
- **Update Frequency**: Daily

### Yahoo Finance
- **Assets**: SPX (^GSPC), GOLD (GC=F), BRENT (BZ=F), CRB (^CRB), BTC (BTC-USD)
- **Rate Limit**: No official limit
- **Update Frequency**: Real-time during market hours

## Deployment

### Lambda Functions
```bash
cd aws/lambda
zip -r market_data_collector.zip market_data_collector.py
zip -r usd_correlation_calculator.zip usd_correlation_calculator.py

aws lambda create-function --function-name MarketDataCollector \
  --runtime python3.9 \
  --role arn:aws:iam::ACCOUNT:role/lambda-execution-role \
  --handler market_data_collector.lambda_handler \
  --zip-file fileb://market_data_collector.zip

aws lambda create-function --function-name USDCorrelationCalculator \
  --runtime python3.9 \
  --role arn:aws:iam::ACCOUNT:role/lambda-execution-role \
  --handler usd_correlation_calculator.lambda_handler \
  --zip-file fileb://usd_correlation_calculator.zip
```

### EventBridge Schedules
```bash
# Market data collection (5:00 PM EST)
aws events put-rule \
  --name MarketDataCollectionSchedule \
  --schedule-expression "cron(0 22 * * ? *)"

# Correlation calculation (5:30 PM EST)
aws events put-rule \
  --name USDCorrelationCalculationSchedule \
  --schedule-expression "cron(30 22 * * ? *)"
```

## Testing

### Test Data Population
```bash
cd aws/lambda
python3 populate_test_data.py
```

### API Testing
```bash
# Test DXY endpoint
curl http://localhost:3001/api/usd/dxy

# Test correlations endpoint
curl http://localhost:3001/api/usd/correlations

# Test currency pairs endpoint
curl http://localhost:3001/api/usd/currency-pairs
```

## Cost Estimates

### AWS Services
- **DynamoDB**: ~$1-3/month (pay-per-request)
- **Lambda**: ~$0.10/month (daily executions)
- **EventBridge**: ~$0.10/month (daily schedules)
- **Total**: ~$1-4/month additional cost

### External APIs
- **FRED**: Free (no API key required)
- **Yahoo Finance**: Free (unofficial API)
- **Total**: $0/month

## Troubleshooting

### Common Issues

1. **No Data Available**
   - Check if Lambda functions are deployed and scheduled
   - Verify DynamoDB tables exist and have data
   - Check CloudWatch logs for Lambda execution errors

2. **API Errors**
   - Verify server is running on port 3001
   - Check AWS credentials are configured
   - Ensure DynamoDB tables are accessible

3. **Frontend Not Loading**
   - Check if React app is running on port 3000
   - Verify API endpoints are accessible
   - Check browser console for JavaScript errors

### Monitoring

- **CloudWatch Logs**: Monitor Lambda function execution
- **DynamoDB Console**: Check table data and metrics
- **Browser DevTools**: Monitor API calls and errors

## Future Enhancements

1. **Real-time Updates**: WebSocket integration for live data
2. **Historical Charts**: Price charts for each asset
3. **Alert System**: Notifications for significant correlation changes
4. **Export Functionality**: CSV/PDF export of correlation data
5. **Mobile Optimization**: Enhanced mobile responsiveness

## Security Considerations

- **API Keys**: Store in environment variables, not in code
- **CORS**: Configured for localhost development
- **Rate Limiting**: Implement if using paid APIs
- **Data Validation**: Input validation on all endpoints

## Performance Optimization

- **Caching**: 5-minute TTL for API responses
- **Batch Operations**: DynamoDB batch writes for efficiency
- **Error Handling**: Graceful degradation when APIs fail
- **Loading States**: User feedback during data fetching

## Maintenance

### Daily
- Monitor Lambda function execution
- Check data freshness in DynamoDB

### Weekly
- Review correlation trends
- Verify data accuracy against external sources

### Monthly
- Update dependencies
- Review cost optimization opportunities
- Performance analysis and optimization
