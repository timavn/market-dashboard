# Clean Up DynamoDB Tables

## Option 1: Python Script (Recommended)

```bash
cd /Users/timsmith/Desktop/cursor/market-dashboard/aws
python3 cleanup-dynamodb.py
```

## Option 2: AWS CLI Commands

If you prefer AWS CLI, run these commands:

```bash
# Clear PortfolioSnapshots table
aws dynamodb scan --table-name PortfolioSnapshots --projection-expression "snapshotId,timestamp" --output json | \
jq -r '.Items[] | "\(.snapshotId.S)#\(.timestamp.S)"' | \
while read key; do
  snapshotId=$(echo $key | cut -d'#' -f1)
  timestamp=$(echo $key | cut -d'#' -f2)
  aws dynamodb delete-item --table-name PortfolioSnapshots --key "{\"snapshotId\":{\"S\":\"$snapshotId\"},\"timestamp\":{\"S\":\"$timestamp\"}}"
done

# Clear Holdings table  
aws dynamodb scan --table-name Holdings --projection-expression "holdingId" --output json | \
jq -r '.Items[] | .holdingId.S' | \
while read holdingId; do
  aws dynamodb delete-item --table-name Holdings --key "{\"holdingId\":{\"S\":\"$holdingId\"}}"
done

# Clear ProcessingLogs table
aws dynamodb scan --table-name ProcessingLogs --projection-expression "logId" --output json | \
jq -r '.Items[] | .logId.S' | \
while read logId; do
  aws dynamodb delete-item --table-name ProcessingLogs --key "{\"logId\":{\"S\":\"$logId\"}}"
done
```

## Option 3: AWS Console (Manual)

1. Go to **DynamoDB Console**
2. For each table (PortfolioSnapshots, Holdings, ProcessingLogs):
   - Click on the table name
   - Click **Actions** → **Delete table**
   - Confirm deletion
   - Recreate the table with the same schema

## After Cleanup

1. **Deploy the updated Lambda**: Upload `csv_processor_schwab_3row_fixed.zip`
2. **Upload your latest CSV**: `Individual-Positions-2025-10-09-223928.csv`
3. **Verify clean results**: Check that only today's data appears in the tables

## Expected Results After Cleanup + New Upload

- **PortfolioSnapshots**: 1 new entry with today's date
- **Holdings**: 31 holdings with real market values (not zeros)
- **ProcessingLogs**: 1 new log entry showing SUCCESS
