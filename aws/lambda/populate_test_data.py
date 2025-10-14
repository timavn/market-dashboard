import json
import boto3
import random
from datetime import datetime, timedelta
from decimal import Decimal

# Initialize AWS clients
dynamodb = boto3.resource('dynamodb')
price_table = dynamodb.Table('MarketPriceHistory')
correlation_table = dynamodb.Table('USDCorrelations')

def lambda_handler(event, context):
    """
    Populate test data for USD Macro Dashboard
    This creates sample data for testing the frontend
    """
    print("Populating test data...")
    
    # Generate sample price data for the last 30 days
    symbols = ['DXY', 'SPX', 'GOLD', 'BRENT', 'CRB', 'BTC']
    base_prices = {
        'DXY': 103.0,
        'SPX': 4500.0,
        'GOLD': 2000.0,
        'BRENT': 80.0,
        'CRB': 280.0,
        'BTC': 45000.0
    }
    
    # Generate 30 days of price data
    for symbol in symbols:
        base_price = base_prices[symbol]
        current_price = base_price
        
        for i in range(30):
            date = (datetime.utcnow() - timedelta(days=29-i)).strftime('%Y-%m-%d')
            
            # Add some random variation
            change_percent = random.uniform(-0.05, 0.05)  # ±5% daily change
            current_price = current_price * (1 + change_percent)
            
            item = {
                'symbol': symbol,
                'date': date,
                'close': Decimal(str(round(current_price, 2))),
                'timestamp': datetime.utcnow().isoformat()
            }
            
            price_table.put_item(Item=item)
            print(f"Added {symbol} data for {date}: {current_price:.2f}")
    
    # Generate sample correlation data
    today = datetime.utcnow().strftime('%Y-%m-%d')
    
    # Sample correlation data matching the reference image
    correlations = {
        'SPX': {
            '15D': Decimal('0.32'),
            '30D': Decimal('0.16'),
            '90D': Decimal('-0.21'),
            '120D': Decimal('-0.63'),
            '180D': Decimal('-0.42')
        },
        'GOLD': {
            '15D': Decimal('0.64'),
            '30D': Decimal('0.40'),
            '90D': Decimal('-0.12'),
            '120D': Decimal('-0.39'),
            '180D': Decimal('-0.82')
        },
        'BRENT': {
            '15D': Decimal('-0.04'),
            '30D': Decimal('-0.10'),
            '90D': Decimal('0.29'),
            '120D': Decimal('-0.26'),
            '180D': Decimal('0.53')
        },
        'CRB': {
            '15D': Decimal('-0.57'),
            '30D': Decimal('-0.43'),
            '90D': Decimal('-0.04'),
            '120D': Decimal('-0.26'),
            '180D': Decimal('-0.55')
        },
        'BTC': {
            '15D': Decimal('0.36'),
            '30D': Decimal('0.20'),
            '90D': Decimal('0.06'),
            '120D': Decimal('-0.47'),
            '180D': Decimal('-0.67')
        }
    }
    
    rolling_stats = {
        'SPX': {
            'high': Decimal('0.89'),
            'low': Decimal('-0.91'),
            'percentTimePositive': 42,
            'percentTimeNegative': 58
        },
        'GOLD': {
            'high': Decimal('0.40'),
            'low': Decimal('-0.94'),
            'percentTimePositive': 12,
            'percentTimeNegative': 88
        },
        'BRENT': {
            'high': Decimal('0.90'),
            'low': Decimal('-0.65'),
            'percentTimePositive': 76,
            'percentTimeNegative': 24
        },
        'CRB': {
            'high': Decimal('0.59'),
            'low': Decimal('-0.84'),
            'percentTimePositive': 43,
            'percentTimeNegative': 57
        },
        'BTC': {
            'high': Decimal('0.97'),
            'low': Decimal('-0.58'),
            'percentTimePositive': 51,
            'percentTimeNegative': 49
        }
    }
    
    correlation_item = {
        'calculationDate': today,
        'correlations': correlations,
        'rollingStats': rolling_stats,
        'timestamp': datetime.utcnow().isoformat()
    }
    
    correlation_table.put_item(Item=correlation_item)
    print(f"Added correlation data for {today}")
    
    return {
        'statusCode': 200,
        'body': json.dumps({
            'message': 'Test data populated successfully',
            'price_records': len(symbols) * 30,
            'correlation_date': today,
            'timestamp': datetime.utcnow().isoformat()
        })
    }

# For local testing
if __name__ == "__main__":
    class MockContext:
        def __init__(self):
            self.function_name = "populate_test_data"
            self.function_version = "1"
            self.invoked_function_arn = "arn:aws:lambda:us-west-1:123456789012:function:populate_test_data"
            self.memory_limit_in_mb = 512
            self.remaining_time_in_millis = lambda: 300000
    
    result = lambda_handler({}, MockContext())
    print(json.dumps(result, indent=2))
