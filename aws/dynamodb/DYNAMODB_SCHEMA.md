# DynamoDB Schema Reference

Complete reference for all DynamoDB tables used in the Market Dashboard application.

**Billing Mode**: All tables use `PAY_PER_REQUEST` (on-demand) billing mode.

**Region**: `us-west-1`

---

## Table of Contents

1. [Portfolio Data Tables](#portfolio-data-tables)
   - PortfolioSnapshots
   - Holdings
   - ProcessingLogs
2. [Performance Tracking Tables](#performance-tracking-tables)
   - PerformanceHistory
   - PositionPerformance
   - PerformanceMetrics
3. [Market Data Tables](#market-data-tables)
   - MarketData
   - MarketPriceHistory
   - USDCorrelations
4. [Hedgeye Data Tables](#hedgeye-data-tables)
   - HedgeyeDailySnapshot
   - HedgeyeRiskRanges
   - RiskRangeData
5. [User Data Tables](#user-data-tables)
   - DailyNotes
   - CalendarNotes
6. [Quick Reference](#quick-reference)
7. [Bulk Creation Commands](#bulk-creation-commands)

---

## Portfolio Data Tables

### PortfolioSnapshots

**Purpose**: Store daily portfolio summaries from Schwab CSV uploads

**Primary Key**:
- Partition Key: `snapshotId` (String) - Format: "YYYYMMDD_HHMMSS"
- Sort Key: `timestamp` (String) - ISO timestamp

**Attributes**:
- `snapshotId` (String): Unique identifier (e.g., "20250115_203000")
- `timestamp` (String): ISO timestamp when snapshot was created
- `summary` (Map): Portfolio summary metrics
  - `totalValue` (Number): Total portfolio value
  - `totalGainLoss` (Number): Total unrealized P&L
  - `totalGainLossPercent` (Number): Total unrealized P&L percentage
  - `positionCount` (Number): Number of positions
  - `totalCostBasis` (Number): Total cost basis
- `assetAllocation` (Map): Percentage allocation by asset class
- `holdingsCount` (Number): Number of holdings

**Sample Item**:
```json
{
  "snapshotId": "20250115_203000",
  "timestamp": "2025-01-15T20:30:00.000Z",
  "summary": {
    "totalValue": 115460.0,
    "totalGainLoss": 8959.0,
    "totalGainLossPercent": 8.4,
    "positionCount": 5,
    "totalCostBasis": 106501.0
  },
  "assetAllocation": {
    "Equities": 65.2,
    "ETFs": 34.8
  },
  "holdingsCount": 5
}
```

**AWS CLI Creation**:
```bash
aws dynamodb create-table \
  --table-name PortfolioSnapshots \
  --attribute-definitions \
    AttributeName=snapshotId,AttributeType=S \
    AttributeName=timestamp,AttributeType=S \
  --key-schema \
    AttributeName=snapshotId,KeyType=HASH \
    AttributeName=timestamp,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-1
```

---

### Holdings

**Purpose**: Store individual holdings for each portfolio snapshot

**Primary Key**:
- Partition Key: `holdingId` (String) - Format: "{snapshotId}#{symbol}"

**Attributes**:
- `holdingId` (String): Composite key (e.g., "20250115_203000#AAPL")
- `snapshotId` (String): Reference to PortfolioSnapshots
- `symbol` (String): Ticker symbol
- `description` (String): Security name
- `quantity` (Number): Position size
- `price` (Number): Current price
- `marketValue` (Number): Position value
- `costBasis` (Number): Cost basis
- `gainLoss` (Number): Unrealized P&L
- `gainLossPercent` (Number): Unrealized P&L percentage
- `assetType` (String): Asset type from Schwab
- `assetClass` (String): Standardized asset class

**Sample Item**:
```json
{
  "holdingId": "20250115_203000#AAPL",
  "snapshotId": "20250115_203000",
  "symbol": "AAPL",
  "description": "Apple Inc",
  "quantity": 100,
  "price": 175.50,
  "marketValue": 17550.00,
  "costBasis": 15000.00,
  "gainLoss": 2550.00,
  "gainLossPercent": 17.00,
  "assetType": "Equity",
  "assetClass": "Equities"
}
```

**AWS CLI Creation**:
```bash
aws dynamodb create-table \
  --table-name Holdings \
  --attribute-definitions \
    AttributeName=holdingId,AttributeType=S \
  --key-schema \
    AttributeName=holdingId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --global-secondary-indexes \
    '[{
      "IndexName": "snapshotId-index",
      "KeySchema": [
        {"AttributeName": "snapshotId", "KeyType": "HASH"},
        {"AttributeName": "symbol", "KeyType": "RANGE"}
      ],
      "Projection": {"ProjectionType": "ALL"}
    }]' \
  --region us-west-1
```

---

### ProcessingLogs

**Purpose**: Audit trail for CSV processing operations

**Primary Key**:
- Partition Key: `logId` (String) - Format: "{snapshotId}_{s3Key}"

**Attributes**:
- `logId` (String): Unique log identifier
- `timestamp` (String): ISO timestamp
- `bucket` (String): S3 bucket name
- `key` (String): S3 object key
- `status` (String): Processing status (SUCCESS, ERROR)
- `snapshotId` (String): Reference to created snapshot (if successful)
- `error` (String): Error message (if failed)

**Sample Item**:
```json
{
  "logId": "20250115_203000_uploads_portfolio.csv",
  "timestamp": "2025-01-15T20:30:00.000Z",
  "bucket": "market-dashboard-csv-data",
  "key": "uploads/portfolio.csv",
  "status": "SUCCESS",
  "snapshotId": "20250115_203000"
}
```

**AWS CLI Creation**:
```bash
aws dynamodb create-table \
  --table-name ProcessingLogs \
  --attribute-definitions \
    AttributeName=logId,AttributeType=S \
  --key-schema \
    AttributeName=logId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-1
```

---

## Performance Tracking Tables

### PerformanceHistory

**Purpose**: Daily portfolio performance snapshots with calculated metrics

**Primary Key**:
- Partition Key: `date` (String) - Format: "YYYY-MM-DD"

**Attributes**:
- `date` (String): Trading date
- `totalValue` (Number): Portfolio value at close
- `dailyReturn` (Number): Daily return percentage
- `cumulativeReturn` (Number): Cumulative return since inception (%)
- `snapshotId` (String): Reference to PortfolioSnapshots
- `positionCount` (Number): Number of positions held
- `timestamp` (String): ISO timestamp

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

**AWS CLI Creation**:
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

### PositionPerformance

**Purpose**: Track individual position performance over time

**Primary Key**:
- Partition Key: `symbol` (String) - Ticker symbol
- Sort Key: `date` (String) - Format: "YYYY-MM-DD"

**Global Secondary Index**: `date-index`
- Partition Key: `date` (String)
- Sort Key: `symbol` (String)
- Purpose: Query all positions for a specific date

**Attributes**:
- `symbol` (String): Ticker symbol
- `date` (String): Trading date
- `quantity` (Number): Position size
- `price` (Number): Closing price
- `marketValue` (Number): Position value
- `costBasis` (Number): Cost basis
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
  "cumulativeReturn": 17.00
}
```

**AWS CLI Creation**:
```bash
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
      "Projection": {"ProjectionType": "ALL"}
    }]' \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-1
```

---

### PerformanceMetrics

**Purpose**: Pre-calculated performance metrics (updated daily)

**Primary Key**:
- Partition Key: `metricType` (String) - "portfolio", "30d", "90d", "1y", "all"
- Sort Key: `calculationDate` (String) - Format: "YYYY-MM-DD"

**Attributes**:
- `metricType` (String): Type of metric period
- `calculationDate` (String): Date metrics calculated for
- `sharpeRatio` (Number): Annualized Sharpe ratio
- `maxDrawdown` (Number): Maximum drawdown percentage
- `volatility` (Number): Annualized volatility percentage
- `winRate` (Number): Win rate (percentage of profitable days)
- `avgDailyReturn` (Number): Average daily return
- `bestDay` (Number): Best single day return
- `worstDay` (Number): Worst single day return
- `rollingReturns` (Map): Rolling returns (30d, 90d, 180d, 1y)
- `vsBenchmark` (Map): Performance vs SPY and QQQ

**AWS CLI Creation**:
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

## Market Data Tables

### MarketData

**Purpose**: Store daily market data snapshots for all tracked symbols

**Primary Key**:
- Partition Key: `date` (String) - Format: "YYYY-MM-DD"

**Attributes**:
- `date` (String): Market data date
- `timestamp` (String): ISO timestamp when fetched
- `marketData` (Map): Market data for all symbols
- `symbolsCount` (Number): Number of symbols

**Sample Item**:
```json
{
  "date": "2025-01-15",
  "timestamp": "2025-01-15T21:30:00.000Z",
  "symbolsCount": 30,
  "marketData": {
    "SPY": {
      "symbol": "SPY",
      "price": 450.25,
      "change": 2.15,
      "changePercent": 0.48,
      "volume": 45000000,
      "high": 451.50,
      "low": 448.75
    }
  }
}
```

**AWS CLI Creation**:
```bash
aws dynamodb create-table \
  --table-name MarketData \
  --attribute-definitions \
    AttributeName=date,AttributeType=S \
  --key-schema \
    AttributeName=date,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-1
```

---

### MarketPriceHistory

**Purpose**: Store daily price data for correlation calculations

**Primary Key**:
- Partition Key: `symbol` (String) - e.g., "DXY", "SPX", "GOLD"
- Sort Key: `date` (String) - Format: "YYYY-MM-DD"

**Attributes**:
- `symbol` (String): Symbol identifier
- `date` (String): Trading date
- `close` (Number): Closing price
- `open` (Number): Opening price
- `high` (Number): Daily high
- `low` (Number): Daily low
- `volume` (Number): Trading volume (if available)
- `timestamp` (String): ISO timestamp

**Sample Item**:
```json
{
  "symbol": "DXY",
  "date": "2025-01-15",
  "close": 103.45,
  "open": 103.20,
  "high": 103.67,
  "low": 103.15
}
```

**AWS CLI Creation**:
```bash
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
```

---

### USDCorrelations

**Purpose**: Store pre-calculated USD correlation matrix results

**Primary Key**:
- Partition Key: `calculationDate` (String) - Format: "YYYY-MM-DD"

**Attributes**:
- `calculationDate` (String): Calculation date
- `correlations` (Map): Nested correlation data
- `rollingStats` (Map): 52-week rolling statistics
- `timestamp` (String): When calculation performed

**Sample Item**:
```json
{
  "calculationDate": "2025-01-15",
  "correlations": {
    "SPX": {
      "15D": 0.32,
      "30D": 0.16,
      "90D": -0.21,
      "120D": -0.63,
      "180D": -0.42
    }
  },
  "timestamp": "2025-01-15T22:30:00.000Z"
}
```

**AWS CLI Creation**:
```bash
aws dynamodb create-table \
  --table-name USDCorrelations \
  --attribute-definitions \
    AttributeName=calculationDate,AttributeType=S \
  --key-schema \
    AttributeName=calculationDate,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-1
```

---

## Hedgeye Data Tables

### HedgeyeDailySnapshot

**Purpose**: Store daily Hedgeye report snapshots (NEW - Jan 10, 2026)

**Primary Key**:
- Partition Key: `date` (String) - Format: "YYYY-MM-DD"
- Sort Key: `snapshotType` (String) - "bitcoin-trend-tracker", "early-look", "portfolio-solutions", "momo-tracker", "signal-strength"

**Attributes**:
- `date` (String): Report publication date
- `snapshotType` (String): Type of Hedgeye report
- `data` (Map): Extracted data (varies by report type)
- `pdfSource` (String): S3 key of source PDF
- `scrapedAt` (String): ISO timestamp when processed
- `source` (String): "textract" or "manual"
- `ttl` (Number): Time to live (2 years)
- `stockCount` (Number): Number of stocks (if applicable)
- `cryptoCount` (Number): Number of cryptos (if applicable)
- `rankingCount` (Number): Number of rankings (if applicable)
- `riskRangeCount` (Number): Number of risk ranges (if applicable)

**Sample Item (Bitcoin Tracker)**:
```json
{
  "date": "2026-01-09",
  "snapshotType": "bitcoin-trend-tracker",
  "cryptoCount": 6,
  "stockCount": 8,
  "data": {
    "cryptos": {
      "BTC": {
        "price": 95000,
        "buyTrade": 93000,
        "sellTrade": 103000,
        "trend": "UP"
      }
    },
    "stocks": {
      "IBIT": {
        "price": 53.45,
        "buyTrade": 51.20,
        "sellTrade": 56.80,
        "upside": 6.3,
        "downside": -4.2,
        "trend": "UP"
      }
    }
  },
  "pdfSource": "hedgeye/bitcoin-tracker-2026-01-09.pdf",
  "scrapedAt": "2026-01-10T12:00:00.000Z",
  "source": "textract",
  "ttl": 1799712000
}
```

**AWS CLI Creation**:
```bash
aws dynamodb create-table \
  --table-name HedgeyeDailySnapshot \
  --attribute-definitions \
    AttributeName=date,AttributeType=S \
    AttributeName=snapshotType,AttributeType=S \
  --key-schema \
    AttributeName=date,KeyType=HASH \
    AttributeName=snapshotType,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-1
```

---

### HedgeyeRiskRanges

**Purpose**: Store historical risk range signals (legacy table)

**Primary Key**:
- Partition Key: `date` (String) - Format: "YYYY-MM-DD"

**Attributes**:
- `date` (String): Signal date
- `riskRanges` (Map): Risk range values for tickers
- `timestamp` (String): ISO timestamp

**AWS CLI Creation**:
```bash
aws dynamodb create-table \
  --table-name HedgeyeRiskRanges \
  --attribute-definitions \
    AttributeName=date,AttributeType=S \
  --key-schema \
    AttributeName=date,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-1
```

---

### RiskRangeData

**Purpose**: Latest risk range data with historical tracking

**Primary Key**:
- Partition Key: `ticker` (String) - Ticker symbol or "LATEST"
- Sort Key: `date` (String) - Format: "YYYY-MM-DD" or "latest"

**Attributes**:
- `ticker` (String): Ticker symbol
- `date` (String): Date or "latest"
- `lrr` (Number): Low Risk Range (Buy Trade)
- `hrr` (Number): High Risk Range (Sell Trade)
- `timestamp` (String): ISO timestamp
- `source` (String): "hedgeye"
- `ttl` (Number): Time to live

**Sample Item**:
```json
{
  "ticker": "SPX",
  "date": "2025-01-15",
  "lrr": 6762.0,
  "hrr": 6914.0,
  "timestamp": "2025-01-15T22:00:00.000Z",
  "source": "hedgeye"
}
```

**AWS CLI Creation**:
```bash
aws dynamodb create-table \
  --table-name RiskRangeData \
  --attribute-definitions \
    AttributeName=ticker,AttributeType=S \
    AttributeName=date,AttributeType=S \
  --key-schema \
    AttributeName=ticker,KeyType=HASH \
    AttributeName=date,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-1
```

---

### HedgeyeProcessingLedger

**Purpose**: Idempotent Textract/Dynamo ingestion — one row per `(snapshotType, PDF SHA-256)` so bulk reruns skip duplicate payloads.

**Primary Key**:
- Partition Key: `snapshotType` (String) — same labels as `HedgeyeDailySnapshot.snapshotType`
- Sort Key: `contentSha256` (String) — hex-encoded SHA-256 of PDF bytes

**Attributes**:
- `reportDate` (String, optional): Report `YYYY-MM-DD`
- `pdfSource` (String, optional): S3 key of source PDF
- `dynamoSnapshotKey` (String, optional): Audit helper (e.g. `date#snapshotType`)
- `processedAt` (String): ISO UTC when ingestion succeeded
- `processorVersion` (String): Parser / projector version for controlled replay

See [`aws/lambda/HEDGEYE_PROCESSING_LEDGER.md`](../lambda/HEDGEYE_PROCESSING_LEDGER.md) and [`aws/lambda/hedgeye_processing_ledger.py`](../lambda/hedgeye_processing_ledger.py).

**AWS CLI Creation**:
```bash
aws dynamodb create-table \
  --table-name HedgeyeProcessingLedger \
  --attribute-definitions \
    AttributeName=snapshotType,AttributeType=S \
    AttributeName=contentSha256,AttributeType=S \
  --key-schema \
    AttributeName=snapshotType,KeyType=HASH \
    AttributeName=contentSha256,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-1
```

---

## User Data Tables

### DailyNotes

**Purpose**: Store user's daily trading notes

**Primary Key**:
- Partition Key: `date` (String) - Format: "YYYY-MM-DD"

**Attributes**:
- `date` (String): Note date
- `content` (String): Note content
- `timestamp` (String): ISO timestamp

**AWS CLI Creation**:
```bash
aws dynamodb create-table \
  --table-name DailyNotes \
  --attribute-definitions \
    AttributeName=date,AttributeType=S \
  --key-schema \
    AttributeName=date,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-1
```

---

### CalendarNotes

**Purpose**: Store user's calendar event notes

**Primary Key**:
- Partition Key: `date` (String) - Format: "YYYY-MM-DD"

**Attributes**:
- `date` (String): Event date
- `events` (List): List of calendar events
- `timestamp` (String): ISO timestamp

**AWS CLI Creation**:
```bash
aws dynamodb create-table \
  --table-name CalendarNotes \
  --attribute-definitions \
    AttributeName=date,AttributeType=S \
  --key-schema \
    AttributeName=date,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-1
```

---

## Quick Reference

| Table Name | Partition Key | Sort Key | Status |
|---|---|---|---|
| **Portfolio Data** |
| PortfolioSnapshots | snapshotId (S) | timestamp (S) | ✅ Active |
| Holdings | holdingId (S) | - | ✅ Active |
| ProcessingLogs | logId (S) | - | ✅ Active |
| **Performance Tracking** |
| PerformanceHistory | date (S) | - | ✅ Active |
| PositionPerformance | symbol (S) | date (S) | ✅ Active |
| PerformanceMetrics | metricType (S) | calculationDate (S) | ✅ Active |
| **Market Data** |
| MarketData | date (S) | - | ✅ Active |
| MarketPriceHistory | symbol (S) | date (S) | ✅ Active |
| USDCorrelations | calculationDate (S) | - | ✅ Active |
| **Hedgeye Data** |
| HedgeyeDailySnapshot | date (S) | snapshotType (S) | ✅ Active |
| HedgeyeRiskRanges | date (S) | - | ✅ Active |
| RiskRangeData | ticker (S) | date (S) | ✅ Active |
| **User Data** |
| DailyNotes | date (S) | - | ✅ Active |
| CalendarNotes | date (S) | - | ✅ Active |

**Total Tables**: 15 (all active)

---

## Bulk Creation Commands

To create all tables at once, run these commands in sequence:

```bash
# Portfolio Data Tables
aws dynamodb create-table --table-name PortfolioSnapshots --attribute-definitions AttributeName=snapshotId,AttributeType=S AttributeName=timestamp,AttributeType=S --key-schema AttributeName=snapshotId,KeyType=HASH AttributeName=timestamp,KeyType=RANGE --billing-mode PAY_PER_REQUEST --region us-west-1

aws dynamodb create-table --table-name Holdings --attribute-definitions AttributeName=holdingId,AttributeType=S --key-schema AttributeName=holdingId,KeyType=HASH --billing-mode PAY_PER_REQUEST --region us-west-1

aws dynamodb create-table --table-name ProcessingLogs --attribute-definitions AttributeName=logId,AttributeType=S --key-schema AttributeName=logId,KeyType=HASH --billing-mode PAY_PER_REQUEST --region us-west-1

# Performance Tracking Tables
aws dynamodb create-table --table-name PerformanceHistory --attribute-definitions AttributeName=date,AttributeType=S --key-schema AttributeName=date,KeyType=HASH --billing-mode PAY_PER_REQUEST --region us-west-1

aws dynamodb create-table --table-name PositionPerformance --attribute-definitions AttributeName=symbol,AttributeType=S AttributeName=date,AttributeType=S --key-schema AttributeName=symbol,KeyType=HASH AttributeName=date,KeyType=RANGE --global-secondary-indexes '[{"IndexName": "date-index", "KeySchema": [{"AttributeName": "date", "KeyType": "HASH"}, {"AttributeName": "symbol", "KeyType": "RANGE"}], "Projection": {"ProjectionType": "ALL"}}]' --billing-mode PAY_PER_REQUEST --region us-west-1

aws dynamodb create-table --table-name PerformanceMetrics --attribute-definitions AttributeName=metricType,AttributeType=S AttributeName=calculationDate,AttributeType=S --key-schema AttributeName=metricType,KeyType=HASH AttributeName=calculationDate,KeyType=RANGE --billing-mode PAY_PER_REQUEST --region us-west-1

# Market Data Tables
aws dynamodb create-table --table-name MarketData --attribute-definitions AttributeName=date,AttributeType=S --key-schema AttributeName=date,KeyType=HASH --billing-mode PAY_PER_REQUEST --region us-west-1

aws dynamodb create-table --table-name MarketPriceHistory --attribute-definitions AttributeName=symbol,AttributeType=S AttributeName=date,AttributeType=S --key-schema AttributeName=symbol,KeyType=HASH AttributeName=date,KeyType=RANGE --billing-mode PAY_PER_REQUEST --region us-west-1

aws dynamodb create-table --table-name USDCorrelations --attribute-definitions AttributeName=calculationDate,AttributeType=S --key-schema AttributeName=calculationDate,KeyType=HASH --billing-mode PAY_PER_REQUEST --region us-west-1

# Hedgeye Data Tables
aws dynamodb create-table --table-name HedgeyeDailySnapshot --attribute-definitions AttributeName=date,AttributeType=S AttributeName=snapshotType,AttributeType=S --key-schema AttributeName=date,KeyType=HASH AttributeName=snapshotType,KeyType=RANGE --billing-mode PAY_PER_REQUEST --region us-west-1

aws dynamodb create-table --table-name HedgeyeProcessingLedger --attribute-definitions AttributeName=snapshotType,AttributeType=S AttributeName=contentSha256,AttributeType=S --key-schema AttributeName=snapshotType,KeyType=HASH AttributeName=contentSha256,KeyType=RANGE --billing-mode PAY_PER_REQUEST --region us-west-1

aws dynamodb create-table --table-name HedgeyeRiskRanges --attribute-definitions AttributeName=date,AttributeType=S --key-schema AttributeName=date,KeyType=HASH --billing-mode PAY_PER_REQUEST --region us-west-1

aws dynamodb create-table --table-name RiskRangeData --attribute-definitions AttributeName=ticker,AttributeType=S AttributeName=date,AttributeType=S --key-schema AttributeName=ticker,KeyType=HASH AttributeName=date,KeyType=RANGE --billing-mode PAY_PER_REQUEST --region us-west-1

# User Data Tables
aws dynamodb create-table --table-name DailyNotes --attribute-definitions AttributeName=date,AttributeType=S --key-schema AttributeName=date,KeyType=HASH --billing-mode PAY_PER_REQUEST --region us-west-1

aws dynamodb create-table --table-name CalendarNotes --attribute-definitions AttributeName=date,AttributeType=S --key-schema AttributeName=date,KeyType=HASH --billing-mode PAY_PER_REQUEST --region us-west-1
```

---

## Cost Estimation

**Current Monthly Costs** (estimated):
- 15 tables × PAY_PER_REQUEST billing
- ~5-10GB total storage
- ~1000 reads/writes per day

**Estimated Total**: $2-5/month

All tables use on-demand pricing, so costs scale with actual usage. This is cost-effective for development and moderate production use.

---

## Troubleshooting

**Error: "Table does not exist"**
- Solution: Create the table using the AWS CLI commands above

**Error: "The provided key element does not match the schema"**
- Solution: Ensure partition/sort keys match exactly as specified in this schema

**Error: "Access Denied"**
- Solution: Check IAM permissions (see [aws/iam/IAM_SETUP_GUIDE.md](../iam/IAM_SETUP_GUIDE.md))

**Error: "ResourceInUseException: Table already exists"**
- Solution: Table already created - verify in AWS Console

---

## Data Relationships

```
PortfolioSnapshots.snapshotId
  ├─> Holdings.holdingId (composite: snapshotId#symbol)
  └─> PerformanceHistory.snapshotId

PerformanceHistory.date
  └─> PositionPerformance.date (via date-index GSI)

MarketPriceHistory (symbol + date)
  └─> USDCorrelations (calculationDate)

HedgeyeDailySnapshot.pdfSource
  └─> S3: market-dashboard-csv-data/hedgeye/*.pdf

RiskRangeData (ticker="LATEST", date="latest")
  └─> Quick access to current risk ranges
```

---

## Prediction Markets Tables

### PredictionMarkets

**Purpose**: Store all prediction market contracts (watchlist, open, closed, settled)

**Primary Key**:
- Partition Key: `contractId` (String) — UUID
- Sort Key: `createdAt` (String) — ISO timestamp

**Global Secondary Indexes**:
- `status-index`: PK `status` (S), SK `settlementDate` (S) — query by lifecycle status
- `assetClass-index`: PK `assetClass` (S), SK `settlementDate` (S) — query by asset class

**Key Attributes**:
- `contractId` (String): UUID
- `status` (String): `watchlist | planned | open | closed | settled | canceled`
- `assetClass` (String): `equities | rates | fx | commodities | crypto`
- `eventCategory` (String): e.g., `Equity Index | Rates | Inflation | Jobs | FX | Commodities | Crypto`
- `eventName` (String): Human-readable event name
- `contractQuestion` (String): Exact binary contract question
- `yesPrice`, `noPrice` (Number): Current market prices $0–$1
- `myProbability` (Number): Model probability 0–1
- `adjustedProbability` (Number): Confidence-haircut probability
- `confidenceScore` (Number): Model confidence 0–1
- `contractSide` (String): `Yes | No`
- `numContracts` (Number): Number of contracts
- `entryPrice`, `exitPrice`, `settlementValue` (Number)
- `feesPerContract`, `totalFees` (Number)
- `realizedProfit` (Number): Actual P&L after settlement
- `settlementDate` (String): YYYY-MM-DD
- `sizingMethod` (String): `fixed_dollar | fixed_pct | fractional_kelly | conservative_kelly | manual`
- `correlationGroup` (String): Macro theme grouping
- `journal` (Map): Structured bet journal fields
- `tags` (List): String tags
- `createdAt`, `updatedAt` (String): ISO timestamps

**AWS CLI Creation**:
```bash
aws dynamodb create-table \
  --table-name PredictionMarkets \
  --attribute-definitions \
    AttributeName=contractId,AttributeType=S \
    AttributeName=createdAt,AttributeType=S \
    AttributeName=status,AttributeType=S \
    AttributeName=settlementDate,AttributeType=S \
    AttributeName=assetClass,AttributeType=S \
  --key-schema \
    AttributeName=contractId,KeyType=HASH \
    AttributeName=createdAt,KeyType=RANGE \
  --global-secondary-indexes \
    '[
      {"IndexName":"status-index","KeySchema":[{"AttributeName":"status","KeyType":"HASH"},{"AttributeName":"settlementDate","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}},
      {"IndexName":"assetClass-index","KeySchema":[{"AttributeName":"assetClass","KeyType":"HASH"},{"AttributeName":"settlementDate","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}
    ]' \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-1
```

---

### PredictionMarketSettings

**Purpose**: Single-row settings store for prediction markets module configuration

**Primary Key**:
- Partition Key: `settingKey` (String) — always `"global"`

**Key Attributes**:
- `portfolioEquity` (Number): Total portfolio equity for sizing calculations
- `minNetEdge` (Number): Minimum net edge to qualify for trade recommendation
- `defaultFeePerContract` (Number): Default fee per contract in $
- `defaultSlippageBuffer` (Number): Slippage buffer per contract
- `modelErrorBuffer` (Number): Model error buffer
- `maxRiskPerBet` (Number): Max dollar risk per single bet
- `maxRiskPerDay` (Number): Max daily prediction market risk
- `maxPmRiskPct` (Number): Max PM risk as fraction of portfolio equity
- `maxRiskByAssetClass` (Map): Per-asset-class risk caps
- `kellyMultiplier` (Number): Fractional Kelly multiplier (e.g., 0.25)
- `defaultConfidenceHaircut` (Number): Default confidence multiplier 0–1
- `maxOpenRisk` (Number): Max total open risk cap
- `sizingMode` (String): Default sizing mode
- `updatedAt` (String): ISO timestamp

**AWS CLI Creation**:
```bash
aws dynamodb create-table \
  --table-name PredictionMarketSettings \
  --attribute-definitions AttributeName=settingKey,AttributeType=S \
  --key-schema AttributeName=settingKey,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-1
```

---

### FinancialPredictionEvents

**Purpose**: Cached normalized prediction-market catalog from Kalshi (scheduled ingest) and IBKR (local refresh)

**Primary Key**:
- Partition Key: `eventId` (String) — `{venue}#{api_raw_id}`
- Sort Key: `updatedAt` (String) — ISO timestamp of ingest row

**Global Secondary Indexes**:
- `comparisonGroupId-index`: PK `comparisonGroupId` (S), SK `event_date` (S)
- `venue-status-index`: PK `venue` (S), SK `status` (S)

**Key Attributes**:
- `eventId`, `updatedAt`, `venue`, `status`, `comparisonGroupId`, `event_date`
- `payload` (Map): Full normalized event object (see `src/services/predictionMarketsIngest/`)

**Meta row**: `eventId` = `INGEST_META#global` — last ingest timestamp and counts

**AWS CLI Creation**:
```bash
aws dynamodb create-table \
  --table-name FinancialPredictionEvents \
  --attribute-definitions \
    AttributeName=eventId,AttributeType=S \
    AttributeName=updatedAt,AttributeType=S \
    AttributeName=comparisonGroupId,AttributeType=S \
    AttributeName=event_date,AttributeType=S \
    AttributeName=venue,AttributeType=S \
    AttributeName=status,AttributeType=S \
  --key-schema \
    AttributeName=eventId,KeyType=HASH \
    AttributeName=updatedAt,KeyType=RANGE \
  --global-secondary-indexes \
    '[
      {"IndexName":"comparisonGroupId-index","KeySchema":[{"AttributeName":"comparisonGroupId","KeyType":"HASH"},{"AttributeName":"event_date","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}},
      {"IndexName":"venue-status-index","KeySchema":[{"AttributeName":"venue","KeyType":"HASH"},{"AttributeName":"status","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}
    ]' \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-1
```

---

**Last Updated**: May 15, 2026

**Note**: This consolidated schema replaces the following individual documentation files:
- CREATE_TABLES.md
- MARKET_DATA_TABLE.md
- USD_MARKET_TABLES.md
- RISK_RANGE_TABLE.md
- PERFORMANCE_TABLES.md
