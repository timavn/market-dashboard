# USD Market Data DynamoDB Tables

## Table 1: MarketPriceHistory

**Purpose**: Store daily price data for correlation calculations

**Table Name**: `MarketPriceHistory`

**Primary Key**:
- Partition Key: `symbol` (String) - e.g., "DXY", "SPX", "GOLD", "BRENT", "CRB", "BTC"
- Sort Key: `date` (String) - Format: "YYYY-MM-DD"

**Attributes**:
- `close` (Number) - Closing price
- `open` (Number) - Opening price  
- `high` (Number) - Daily high
- `low` (Number) - Daily low
- `volume` (Number) - Trading volume (if available)
- `timestamp` (String) - ISO timestamp when data was collected

**Sample Items**:
```json
{
  "symbol": "DXY",
  "date": "2025-10-11",
  "close": 103.45,
  "open": 103.20,
  "high": 103.67,
  "low": 103.15,
  "timestamp": "2025-10-11T22:00:00.000Z"
}
```

## Table 2: USDCorrelations

**Purpose**: Store pre-calculated correlation matrix results

**Table Name**: `USDCorrelations`

**Primary Key**:
- Partition Key: `calculationDate` (String) - Format: "YYYY-MM-DD"

**Attributes**:
- `correlations` (Map) - Nested structure with all correlation data
- `rollingStats` (Map) - 52-week rolling statistics
- `timestamp` (String) - When calculation was performed

**Sample Item**:
```json
{
  "calculationDate": "2025-10-11",
  "correlations": {
    "SPX": {
      "15D": 0.32,
      "30D": 0.16,
      "90D": -0.21,
      "120D": -0.63,
      "180D": -0.42
    },
    "GOLD": {
      "15D": 0.64,
      "30D": 0.40,
      "90D": -0.12,
      "120D": -0.39,
      "180D": -0.82
    }
  },
  "rollingStats": {
    "SPX": {
      "high": 0.89,
      "low": -0.91,
      "percentTimePositive": 42,
      "percentTimeNegative": 58
    }
  },
  "timestamp": "2025-10-11T22:30:00.000Z"
}
```

## Creation Commands

```bash
# Create MarketPriceHistory table
aws dynamodb create-table \
  --table-name MarketPriceHistory \
  --attribute-definitions \
    AttributeName=symbol,AttributeType=S \
    AttributeName=date,AttributeType=S \
  --key-schema \
    AttributeName=symbol,KeyType=HASH \
    AttributeName=date,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-1

# Create USDCorrelations table  
aws dynamodb create-table \
  --table-name USDCorrelations \
  --attribute-definitions \
    AttributeName=calculationDate,AttributeType=S \
  --key-schema \
    AttributeName=calculationDate,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-1
```

## Cost Estimates

- **MarketPriceHistory**: ~$1-2/month (365 days × 6 symbols × 2 years = ~4,380 items)
- **USDCorrelations**: ~$0.10/month (365 items per year)
- **Total**: ~$1-3/month additional cost
