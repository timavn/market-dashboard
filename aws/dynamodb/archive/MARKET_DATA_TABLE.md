# Market Data DynamoDB Table

## Table Schema: MarketData

### Primary Key
- **Partition Key**: `date` (String) - Format: YYYY-MM-DD
- **Sort Key**: None (single item per date)

### Attributes
- `date` (String): Date of market data (YYYY-MM-DD)
- `timestamp` (String): ISO timestamp when data was fetched
- `marketData` (Map): Market data for all symbols
  - Each symbol contains: price, change, changePercent, volume, high, low, open, previousClose
- `symbolsCount` (Number): Number of symbols in the dataset

### Sample Item
```json
{
  "date": "2025-10-10",
  "timestamp": "2025-10-10T21:30:00.000Z",
  "symbolsCount": 30,
  "marketData": {
    "SPY": {
      "symbol": "SPY",
      "price": 450.25,
      "change": 2.15,
      "changePercent": 0.48,
      "volume": 45000000,
      "high": 451.50,
      "low": 448.75,
      "open": 448.10,
      "previousClose": 448.10,
      "timestamp": "2025-10-10T21:30:00.000Z"
    },
    "QQQ": {
      "symbol": "QQQ",
      "price": 380.45,
      "change": -1.25,
      "changePercent": -0.33,
      "volume": 25000000,
      "high": 382.10,
      "low": 379.80,
      "open": 381.70,
      "previousClose": 381.70,
      "timestamp": "2025-10-10T21:30:00.000Z"
    }
  }
}
```

## AWS CLI Commands to Create Table

```bash
# Create the MarketData table
aws dynamodb create-table \
  --table-name MarketData \
  --attribute-definitions \
    AttributeName=date,AttributeType=S \
  --key-schema \
    AttributeName=date,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-1
```

## AWS Console Steps

1. Go to **DynamoDB Console**
2. Click **Create table**
3. **Table name**: `MarketData`
4. **Partition key**: `date` (String)
5. **Settings**: Use default settings
6. Click **Create table**

## Usage

The table stores one record per trading day with all market data for that date. This allows for:
- Historical market data analysis
- Portfolio performance calculations
- Risk metric calculations
- Backtesting capabilities
