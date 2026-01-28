
import boto3
import json

def check_tables():
    dynamodb = boto3.client('dynamodb')
    tables = dynamodb.list_tables()['TableNames']
    
    # added MarketPriceHistory
    required = ['PortfolioSnapshots', 'Holdings', 'PerformanceHistory', 'PositionPerformance', 'PerformanceMetrics', 'MarketPriceHistory']
    
    for t in required:
        if t in tables:
            print(f"✅ {t} exists")
            desc = dynamodb.describe_table(TableName=t)
            print(f"   KeySchema: {desc['Table']['KeySchema']}")
        else:
            print(f"❌ {t} MISSING")

if __name__ == "__main__":
    check_tables()
