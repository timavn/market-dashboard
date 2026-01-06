# Performance Tracking DynamoDB Tables

## Overview

Three DynamoDB tables store portfolio performance data for comprehensive tracking and analytics.

---

## Table 1: PerformanceHistory

**Purpose**: Store daily portfolio performance snapshots with calculated metrics

**Table Name**: `PerformanceHistory`

**Primary Key**:
- Partition Key: `date` (String) - Format: "YYYY-MM-DD"

**Attributes**:
- `date` (String): Trading date (YYYY-MM-DD)
- `totalValue` (Number): Portfolio value at market close
- `dailyReturn` (Number): Daily return percentage
- `cumulativeReturn` (Number): Cumulative return since inception (%)
- `snapshotId` (String): Reference to PortfolioSnapshots table
- `positionCount` (Number): Number of positions held
- `timestamp` (String): ISO timestamp when record was created

**Sample Item**:
```json
{
  "date": "2025-01-15",
  "totalValue": 115460.00,
  "dailyReturn": 0.85,
  "cumulativeReturn": 8.40,
  "snapshotId": "20250115_203000",
  "positionCount": 5,
  "timestamp": "2025-01-15T20:30:00.000Z"
}
```

**Query Pattern**: 
- Get all dates: `scan()` then sort by date
- Get specific date: `get_item(date="2025-01-15")`
- Get date range: `scan()` with filter expression

**AWS CLI Creation Command**:
```bash
aws dynamodb create-table \
  --table-name PerformanceHistory \
  --attribute-definitions \
    AttributeName=date,AttributeType=S \
  --key-schema \
    AttributeName=date,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-1
```

---

## Table 2: PositionPerformance

**Purpose**: Track individual position performance over time

**Table Name**: `PositionPerformance`

**Primary Key**:
- Partition Key: `symbol` (String) - Security ticker
- Sort Key: `date` (String) - Format: "YYYY-MM-DD"

**Global Secondary Index (GSI)**: `date-index`
- Partition Key: `date` (String)
- Sort Key: `symbol` (String)
- Purpose: Query all positions for a specific date

**Attributes**:
- `symbol` (String): Security ticker symbol
- `date` (String): Trading date (YYYY-MM-DD)
- `quantity` (Number): Position size (shares/contracts)
- `price` (Number): Closing price
- `marketValue` (Number): Position value (quantity × price)
- `costBasis` (Number): Cost basis for this position
- `gainLoss` (Number): Unrealized P&L
- `gainLossPercent` (Number): Unrealized P&L percentage
- `dailyReturn` (Number): Daily return for this position (%)
- `cumulativeReturn` (Number): Cumulative return since first held (%)

**Sample Item**:
```json
{
  "symbol": "AAPL",
  "date": "2025-01-15",
  "quantity": 100,
  "price": 175.50,
  "marketValue": 17550.00,
  "costBasis": 15000.00,
  "gainLoss": 2550.00,
  "gainLossPercent": 17.00,
  "dailyReturn": 1.25,
  "cumulativeReturn": 17.00,
  "timestamp": "2025-01-15T20:30:00.000Z"
}
```

**Query Patterns**:
- Get all dates for a symbol: `query(symbol="AAPL")`
- Get all symbols for a date: `query(date="2025-01-15")` using GSI
- Get symbol history: `query(symbol="AAPL", date between start and end)`

**AWS CLI Creation Commands**:
```bash
# Create main table
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
```

---

## Table 3: PerformanceMetrics

**Purpose**: Store pre-calculated performance metrics (updated daily)

**Table Name**: `PerformanceMetrics`

**Primary Key**:
- Partition Key: `metricType` (String) - e.g., "portfolio", "30d", "90d", "1y", "all"
- Sort Key: `calculationDate` (String) - Format: "YYYY-MM-DD"

**Attributes**:
- `metricType` (String): Type of metric period ("portfolio", "30d", "90d", "1y", "all")
- `calculationDate` (String): Date metrics were calculated for (YYYY-MM-DD)
- `sharpeRatio` (Number): Annualized Sharpe ratio
- `maxDrawdown` (Number): Maximum drawdown percentage
- `volatility` (Number): Annualized volatility percentage
- `winRate` (Number): Win rate (percentage of profitable days)
- `avgDailyReturn` (Number): Average daily return percentage
- `bestDay` (Number): Best single day return percentage
- `worstDay` (Number): Worst single day return percentage
- `rollingReturns` (Map): Rolling returns for different periods
  - `30d` (Number): 30-day return
  - `90d` (Number): 90-day return
  - `180d` (Number): 180-day return
  - `1y` (Number): 1-year return
- `vsBenchmark` (Map): Performance vs benchmarks
  - `SPY` (Map): Comparison to SPY
    - `return` (Number): Return difference
    - `alpha` (Number): Alpha (excess return)
    - `beta` (Number): Beta (correlation-adjusted)
  - `QQQ` (Map): Comparison to QQQ (same structure)
- `timestamp` (String): When metrics were calculated

**Sample Item**:
```json
{
  "metricType": "all",
  "calculationDate": "2025-01-15",
  "sharpeRatio": 1.85,
  "maxDrawdown": -5.2,
  "volatility": 12.5,
  "winRate": 58.3,
  "avgDailyReturn": 0.15,
  "bestDay": 3.2,
  "worstDay": -2.1,
  "rollingReturns": {
    "30d": 4.2,
    "90d": 12.5,
    "180d": 18.3,
    "1y": 25.7
  },
  "vsBenchmark": {
    "SPY": {
      "return": 2.5,
      "alpha": 1.8,
      "beta": 0.95
    },
    "QQQ": {
      "return": -1.2,
      "alpha": 0.5,
      "beta": 1.05
    }
  },
  "timestamp": "2025-01-15T21:00:00.000Z"
}
```

**Query Pattern**: 
- Get latest metrics for a period: `query(metricType="all")` then sort by calculationDate descending, take first
- Get metrics for specific date: `query(metricType="all", calculationDate="2025-01-15")`

**AWS CLI Creation Command**:
```bash
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

---

## Usage Notes

- All monetary values stored as Decimal type in DynamoDB (converted from float)
- Date format: YYYY-MM-DD (ISO 8601 date format)
- Performance calculations use standard hedge fund formulas
- Tables use PAY_PER_REQUEST billing mode for cost efficiency
- Consider adding TTL (Time To Live) for old data if needed for archival

## Data Relationships

- `PerformanceHistory.date` → `PortfolioSnapshots.snapshotId` (via snapshotId field)
- `PositionPerformance.symbol` + `PositionPerformance.date` → Links to holdings
- `PerformanceMetrics.calculationDate` → Calculated from `PerformanceHistory` data

