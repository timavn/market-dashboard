# DynamoDB Table Creation Guide

## 🚨 **CRITICAL: Create These Tables First**

Before your Lambda function can work, you MUST create the DynamoDB tables with the correct schemas.

## Table Schemas

### 1. PortfolioSnapshots Table
- **Table Name**: `PortfolioSnapshots`
- **Partition Key**: `snapshotId` (String)
- **Sort Key**: `timestamp` (String)
- **Billing Mode**: On-demand

### 2. Holdings Table  
- **Table Name**: `Holdings`
- **Partition Key**: `holdingId` (String)
- **No Sort Key**
- **Billing Mode**: On-demand

### 3. ProcessingLogs Table
- **Table Name**: `ProcessingLogs`
- **Partition Key**: `logId` (String)
- **No Sort Key**
- **Billing Mode**: On-demand

## Step-by-Step Creation

### Option 1: AWS Console (Recommended)

1. **Go to DynamoDB Console**
   - Navigate to AWS Console → DynamoDB → Tables
   - Click "Create table"

2. **Create PortfolioSnapshots Table**
   - Table name: `PortfolioSnapshots`
   - Partition key: `snapshotId` (String)
   - Sort key: `timestamp` (String)
   - Click "Create table"

3. **Create Holdings Table**
   - Table name: `Holdings`
   - Partition key: `holdingId` (String)
   - Click "Create table"

4. **Create ProcessingLogs Table**
   - Table name: `ProcessingLogs`
   - Partition key: `logId` (String)
   - Click "Create table"

### Option 2: AWS CLI

```bash
# Create PortfolioSnapshots table
aws dynamodb create-table \
    --table-name PortfolioSnapshots \
    --attribute-definitions AttributeName=snapshotId,AttributeType=S AttributeName=timestamp,AttributeType=S \
    --key-schema AttributeName=snapshotId,KeyType=HASH AttributeName=timestamp,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST

# Create Holdings table
aws dynamodb create-table \
    --table-name Holdings \
    --attribute-definitions AttributeName=holdingId,AttributeType=S \
    --key-schema AttributeName=holdingId,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST

# Create ProcessingLogs table
aws dynamodb create-table \
    --table-name ProcessingLogs \
    --attribute-definitions AttributeName=logId,AttributeType=S \
    --key-schema AttributeName=logId,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST
```

## Verification

After creating the tables, verify they exist:

1. Go to DynamoDB → Tables
2. You should see all three tables: `PortfolioSnapshots`, `Holdings`, `ProcessingLogs`
3. Each table should show "Active" status

## Expected Data Structure

### PortfolioSnapshots Table Items:
```json
{
  "snapshotId": "20251006_204402",
  "timestamp": "2025-10-06T20:44:02.123456",
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

### Holdings Table Items:
```json
{
  "holdingId": "20251006_204402#AAPL",
  "snapshotId": "20251006_204402",
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

### ProcessingLogs Table Items:
```json
{
  "logId": "20251006_204402_uploads_test-portfolio.csv",
  "timestamp": "2025-10-06T20:44:02.123456",
  "bucket": "market-dashboard-csv-data",
  "key": "uploads/test-portfolio.csv",
  "status": "SUCCESS",
  "snapshotId": "20251006_204402"
}
```

## Next Steps

Once tables are created:
1. Update your Lambda function code (if needed)
2. Test the Lambda function
3. Upload a test CSV to S3
4. Verify data appears in the tables

## Troubleshooting

**Error: "Table does not exist"**
- Solution: Create the missing table using the steps above

**Error: "The provided key element does not match the schema"**
- Solution: Ensure table partition keys match exactly:
  - PortfolioSnapshots: `snapshotId` (String)
  - Holdings: `holdingId` (String)  
  - ProcessingLogs: `logId` (String)

**Error: "Access Denied"**
- Solution: Update IAM permissions (see IAM_SETUP_GUIDE.md)
