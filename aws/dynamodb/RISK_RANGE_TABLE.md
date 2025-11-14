# Risk Range Data DynamoDB Table

## Table Schema: RiskRangeData

### Primary Key
- **Partition Key**: `ticker` (String) - Security ticker symbol
- **Sort Key**: `date` (String) - Format: YYYY-MM-DD or "latest" for current snapshot

### Attributes
- `ticker` (String): Security ticker symbol (e.g., "SPX", "UST10Y")
- `date` (String): Date of risk range data (YYYY-MM-DD) or "latest" for current snapshot
- `lrr` (Number): Low Risk Range (Buy Trade) value from Hedgeye
- `hrr` (Number): High Risk Range (Sell Trade) value from Hedgeye
- `timestamp` (String): ISO timestamp when data was scraped
- `source` (String): Data source (default: "hedgeye")
- `ttl` (Number): Time to live in Unix timestamp format (for automatic cleanup)

### Sample Items

#### Daily Record
```json
{
  "ticker": "SPX",
  "date": "2025-01-15",
  "lrr": 6762.0,
  "hrr": 6914.0,
  "timestamp": "2025-01-15T22:00:00.000Z",
  "source": "hedgeye",
  "ttl": 1735689600
}
```

#### Latest Snapshot (for quick access)
```json
{
  "ticker": "LATEST",
  "date": "latest",
  "data": {
    "SPX": {
      "lrr": 6762.0,
      "hrr": 6914.0,
      "timestamp": "2025-01-15T22:00:00.000Z"
    },
    "UST10Y": {
      "lrr": 4.14,
      "hrr": 4.02,
      "timestamp": "2025-01-15T22:00:00.000Z"
    }
  },
  "timestamp": "2025-01-15T22:00:00.000Z",
  "ttl": 1735689600
}
```

## AWS CLI Commands to Create Table

```bash
# Create the RiskRangeData table
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

## AWS Console Steps

1. Go to **DynamoDB Console**
2. Click **Create table**
3. **Table name**: `RiskRangeData`
4. **Partition key**: `ticker` (String)
5. **Sort key**: `date` (String)
6. **Settings**: Use default settings
7. Click **Create table**

## Query Patterns

### Get latest risk range for a specific ticker
```python
response = table.query(
    KeyConditionExpression=Key('ticker').eq('SPX') & Key('date').eq('latest')
)
```

### Get all risk ranges for a date
```python
response = table.query(
    IndexName='date-index',  # If GSI is created
    KeyConditionExpression=Key('date').eq('2025-01-15')
)
```

### Get latest snapshot (all securities)
```python
response = table.get_item(
    Key={
        'ticker': 'LATEST',
        'date': 'latest'
    }
)
```

## Usage

The table stores:
- **Daily records**: One record per ticker per day for historical tracking
- **Latest snapshot**: One record with all current risk ranges for quick access

This allows for:
- Historical risk range analysis
- Quick access to current LRR/HRR values
- Portfolio risk calculations
- Signal strength calculations

