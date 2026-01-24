import boto3
from datetime import datetime, timezone

def cleanup():
    db = boto3.resource('dynamodb', region_name='us-west-1')
    table = db.Table('HedgeyeDailySnapshot')
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    
    print(f"Checking for empty snapshot on {today}...")
    
    try:
        response = table.get_item(Key={'date': today, 'snapshotType': 'risk-ranges'})
        if 'Item' in response:
            item = response['Item']
            count = item.get('riskRangeCount', 0)
            print(f"Found item: count={count}")
            
            if count == 0:
                print("Deleting empty snapshot...")
                table.delete_item(Key={'date': today, 'snapshotType': 'risk-ranges'})
                print("✅ Deleted.")
            else:
                print("Item has data, leaving it alone.")
        else:
            print("No snapshot found for today.")
            
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    cleanup()
