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
        'ticker': 'DTWEXBGS',  # FRED series ID for DXY
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
    Lambda function to collect daily market data from FRED and Yahoo Finance
    Scheduled to run daily at 5:00 PM EST after market close
    """
    print("Starting market data collection...")
    
    results = {
        'success': [],
        'failed': [],
        'timestamp': datetime.utcnow().isoformat()
    }
    
    for symbol, config in MARKET_SYMBOLS.items():
        try:
            print(f"Collecting data for {symbol} ({config['name']})...")
            
            if config['source'] == 'fred':
                data = fetch_fred_data(config['ticker'])
            elif config['source'] == 'yahoo':
                data = fetch_yahoo_data(config['ticker'])
            else:
                raise ValueError(f"Unknown data source: {config['source']}")
            
            if data:
                # Store in DynamoDB
                store_market_data(symbol, data)
                results['success'].append(symbol)
                print(f"Successfully collected and stored data for {symbol}")
            else:
                results['failed'].append(f"{symbol}: No data returned")
                print(f"No data returned for {symbol}")
                
        except Exception as e:
            error_msg = f"{symbol}: {str(e)}"
            results['failed'].append(error_msg)
            print(f"Error collecting data for {symbol}: {str(e)}")
    
    print(f"Collection complete. Success: {len(results['success'])}, Failed: {len(results['failed'])}")
    
    return {
        'statusCode': 200,
        'body': json.dumps(results)
    }

def fetch_fred_data(series_id):
    """
    Fetch data from Federal Reserve Economic Data (FRED) API
    """
    try:
        # FRED API endpoint (no API key required for basic usage)
        url = f"https://api.stlouisfed.org/fred/series/observations"
        params = {
            'series_id': series_id,
            'api_key': os.environ.get('FRED_API_KEY', ''),  # Optional API key
            'file_type': 'json',
            'limit': 1,
            'sort_order': 'desc'
        }
        
        response = requests.get(url, params=params, timeout=30)
        response.raise_for_status()
        
        data = response.json()
        
        if 'observations' in data and len(data['observations']) > 0:
            obs = data['observations'][0]
            if obs['value'] != '.':
                return {
                    'close': float(obs['value']),
                    'date': obs['date'],
                    'timestamp': datetime.utcnow().isoformat()
                }
        
        return None
        
    except Exception as e:
        print(f"Error fetching FRED data for {series_id}: {str(e)}")
        return None

def fetch_yahoo_data(ticker):
    """
    Fetch data from Yahoo Finance (unofficial API)
    """
    try:
        # Yahoo Finance API endpoint
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
        params = {
            'range': '1d',
            'interval': '1d',
            'includePrePost': 'false'
        }
        
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
        
        response = requests.get(url, params=params, headers=headers, timeout=30)
        response.raise_for_status()
        
        data = response.json()
        
        if 'chart' in data and 'result' in data['chart'] and len(data['chart']['result']) > 0:
            result = data['chart']['result'][0]
            meta = result.get('meta', {})
            
            if 'regularMarketPrice' in meta:
                # Get the latest trading day
                timestamps = result.get('timestamp', [])
                if timestamps:
                    latest_timestamp = timestamps[-1]
                    latest_date = datetime.fromtimestamp(latest_timestamp).strftime('%Y-%m-%d')
                    
                    return {
                        'close': float(meta['regularMarketPrice']),
                        'open': float(meta.get('regularMarketOpen', meta['regularMarketPrice'])),
                        'high': float(meta.get('regularMarketDayHigh', meta['regularMarketPrice'])),
                        'low': float(meta.get('regularMarketDayLow', meta['regularMarketPrice'])),
                        'volume': int(meta.get('regularMarketVolume', 0)),
                        'date': latest_date,
                        'timestamp': datetime.utcnow().isoformat()
                    }
        
        return None
        
    except Exception as e:
        print(f"Error fetching Yahoo data for {ticker}: {str(e)}")
        return None

def store_market_data(symbol, data):
    """
    Store market data in DynamoDB
    """
    try:
        # Convert floats to Decimal for DynamoDB compatibility
        item = {
            'symbol': symbol,
            'date': data['date'],
            'close': Decimal(str(data['close'])),
            'timestamp': data['timestamp']
        }
        
        # Add optional fields if they exist
        if 'open' in data:
            item['open'] = Decimal(str(data['open']))
        if 'high' in data:
            item['high'] = Decimal(str(data['high']))
        if 'low' in data:
            item['low'] = Decimal(str(data['low']))
        if 'volume' in data:
            item['volume'] = int(data['volume'])
        
        # Store in DynamoDB
        table.put_item(Item=item)
        print(f"Stored data for {symbol} on {data['date']}")
        
    except Exception as e:
        print(f"Error storing data for {symbol}: {str(e)}")
        raise e
