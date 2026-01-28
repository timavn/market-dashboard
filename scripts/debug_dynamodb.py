import boto3
import json
import decimal
from boto3.dynamodb.conditions import Key

# Helper class to convert DynamoDB items to JSON
class DecimalEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, decimal.Decimal):
            return str(o)
        return super(DecimalEncoder, self).default(o)

def debug_performance_data():
    dynamodb = boto3.resource('dynamodb', region_name='us-west-1')
    table = dynamodb.Table('PerformanceHistory')
    
    print("Scanning PerformanceHistory table (first 5 items)...")
    try:
        response = table.scan(Limit=5)
        items = response.get('Items', [])
        
        print(f"Found {len(items)} items.")
        for item in items:
            print(json.dumps(item, cls=DecimalEncoder, indent=2))
            
            # Specific check for summary.totalValue
            if 'summary' in item:
                print(f"Date: {item.get('date')}, Summary present.")
                if 'totalValue' in item['summary']:
                    print(f"  totalValue: {item['summary']['totalValue']}")
                else:
                    print("  ERROR: totalValue MISSING in summary!")
            else:
                print(f"Date: {item.get('date')}, ERROR: Summary MISSING!")
                
    except Exception as e:
        print(f"Error scanning table: {str(e)}")

if __name__ == "__main__":
    debug_performance_data()
