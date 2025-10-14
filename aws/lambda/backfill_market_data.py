import json
import boto3
import requests
import pandas as pd
from datetime import datetime, timedelta
import time
import os
from decimal import Decimal

# Initialize AWS clients
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('MarketPriceHistory')

# Market data symbols and their data sources
MARKET_SYMBOLS = {
    'DXY': {
        'source': 'fred',
        'ticker': 'DTWEXBGS',
        'name': 'Dollar Index'
    },
    'SPX': {
        'source': 'yahoo',
        'ticker': '^GSPC',
        'name': 'S&P 500'
    },
    'GOLD': {
        'source': 'yahoo',
        'ticker': 'GC=F',
        'name': 'Gold Futures'
    },
    'BRENT': {
        'source': 'yahoo',
        'ticker': 'BZ=F',
        'name': 'Brent Oil Futures'
    },
    'CRB': {
        'source': 'yahoo',
        'ticker': '^CRB',
        'name': 'CRB Index'
    },
    'BTC': {
        'source': 'yahoo',
        'ticker': 'BTC-USD',
        'name': 'Bitcoin'
    },
    # Currency pairs
    'USDEUR': {
        'source': 'yahoo',
        'ticker': 'USDEUR=X',
        'name': 'USD/EUR'
    },
    'USDJPY': {
        'source': 'yahoo',
        'ticker': 'USDJPY=X',
        'name': 'USD/JPY'
    },
    'USDGBP': {
        'source': 'yahoo',
        'ticker': 'USDGBP=X',
        'name': 'USD/GBP'
    },
    'USDCHF': {
        'source': 'yahoo',
        'ticker': 'USDCHF=X',
        'name': 'USD/CHF'
    },
    'USDCAD': {
        'source': 'yahoo',
        'ticker': 'USDCAD=X',
        'name': 'USD/CAD'
    },
    'USDAUD': {
        'source': 'yahoo',
        'ticker': 'USDAUD=X',
        'name': 'USD/AUD'
    },
    'USDNZD': {
        'source': 'yahoo',
        'ticker': 'USDNZD=X',
        'name': 'USD/NZD'
    }
}

def lambda_handler(event, context):
    """
    One-time script to backfill 365 days of historical market data
    This should be run manually to populate initial data
    """
    print("Starting market data backfill...")
    
    results = {
        'success': [],
        'failed': [],
        'total_records': 0,
        'timestamp': datetime.utcnow().isoformat()
    }
    
    for symbol, config in MARKET_SYMBOLS.items():
        try:
            print(f"Backfilling data for {symbol} ({config['name']})...")
            
            if config['source'] == 'fred':
                records = fetch_fred_historical_data(config['ticker'], symbol, 365)
            elif config['source'] == 'yahoo':
                records = fetch_yahoo_historical_data(config['ticker'], symbol, 365)
            else:
                raise ValueError(f"Unknown data source: {config['source']}")
            
            if records:
                # Store in DynamoDB
                store_historical_data(symbol, records)
                results['success'].append(f"{symbol}: {len(records)} records")
                results['total_records'] += len(records)
                print(f"Successfully backfilled {len(records)} records for {symbol}")
            else:
                results['failed'].append(f"{symbol}: No data returned")
                print(f"No data returned for {symbol}")
                
        except Exception as e:
            error_msg = f"{symbol}: {str(e)}"
            results['failed'].append(error_msg)
            print(f"Error backfilling data for {symbol}: {str(e)}")
    
    print(f"Backfill complete. Success: {len(results['success'])}, Failed: {len(results['failed'])}, Total records: {results['total_records']}")
    
    return {
        'statusCode': 200,
        'body': json.dumps(results)
    }

def fetch_fred_historical_data(series_id, symbol, days):
    """
    Fetch historical data from FRED API
    """
    try:
        # Calculate date range
        end_date = datetime.utcnow()
        start_date = end_date - timedelta(days=days)
        
        url = f"https://api.stlouisfed.org/fred/series/observations"
        params = {
            'series_id': series_id,
            'api_key': os.environ.get('FRED_API_KEY', ''),
            'file_type': 'json',
            'observation_start': start_date.strftime('%Y-%m-%d'),
            'observation_end': end_date.strftime('%Y-%m-%d'),
            'sort_order': 'asc'
        }
        
        response = requests.get(url, params=params, timeout=30)
        response.raise_for_status()
        
        data = response.json()
        
        records = []
        if 'observations' in data:
            for obs in data['observations']:
                if obs['value'] != '.':
                    records.append({
                        'date': obs['date'],
                        'close': float(obs['value']),
                        'timestamp': datetime.utcnow().isoformat()
                    })
        
        return records
        
    except Exception as e:
        print(f"Error fetching FRED historical data for {series_id}: {str(e)}")
        return None

def fetch_yahoo_historical_data(ticker, symbol, days):
    """
    Fetch historical data from Yahoo Finance
    """
    try:
        # Calculate timestamps
        end_timestamp = int(datetime.utcnow().timestamp())
        start_timestamp = int((datetime.utcnow() - timedelta(days=days)).timestamp())
        
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
        params = {
            'period1': start_timestamp,
            'period2': end_timestamp,
            'interval': '1d',
            'includePrePost': 'false'
        }
        
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
        
        response = requests.get(url, params=params, headers=headers, timeout=30)
        response.raise_for_status()
        
        data = response.json()
        
        records = []
        if 'chart' in data and 'result' in data['chart'] and len(data['chart']['result']) > 0:
            result = data['chart']['result'][0]
            timestamps = result.get('timestamp', [])
            closes = result.get('indicators', {}).get('quote', [{}])[0].get('close', [])
            
            for i, timestamp in enumerate(timestamps):
                if i < len(closes) and closes[i] is not None:
                    date = datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d')
                    records.append({
                        'date': date,
                        'close': float(closes[i]),
                        'timestamp': datetime.utcnow().isoformat()
                    })
        
        return records
        
    except Exception as e:
        print(f"Error fetching Yahoo historical data for {ticker}: {str(e)}")
        return None

def store_historical_data(symbol, records):
    """
    Store historical data in DynamoDB
    """
    try:
        with table.batch_writer() as batch:
            for record in records:
                item = {
                    'symbol': symbol,
                    'date': record['date'],
                    'close': Decimal(str(record['close'])),
                    'timestamp': record['timestamp']
                }
                batch.put_item(Item=item)
        
        print(f"Stored {len(records)} records for {symbol}")
        
    except Exception as e:
        print(f"Error storing historical data for {symbol}: {str(e)}")
        raise e

# For local testing
if __name__ == "__main__":
    # Mock event and context for local testing
    class MockContext:
        def __init__(self):
            self.function_name = "backfill_market_data"
            self.function_version = "1"
            self.invoked_function_arn = "arn:aws:lambda:us-west-1:123456789012:function:backfill_market_data"
            self.memory_limit_in_mb = 512
            self.remaining_time_in_millis = lambda: 300000
    
    result = lambda_handler({}, MockContext())
    print(json.dumps(result, indent=2))
