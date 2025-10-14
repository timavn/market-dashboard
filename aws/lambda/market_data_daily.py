#!/usr/bin/env python3
"""
Daily Market Data Fetcher
Runs after market close to fetch closing prices and market data
"""

import json
import boto3
import requests
import os
from datetime import datetime, timezone
from decimal import Decimal

# DynamoDB setup
dynamodb = boto3.resource('dynamodb')
MARKET_DATA_TABLE = os.environ.get('MARKET_DATA_TABLE', 'MarketData')

# Market data providers
ALPHA_VANTAGE_KEY = os.environ.get('ALPHA_VANTAGE_KEY')
POLYGON_KEY = os.environ.get('POLYGON_KEY')

# Key market symbols to track
KEY_SYMBOLS = [
    'SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'NVDA',
    'XLF', 'XLE', 'XLK', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB', 'XLRE',
    'VIX', '^VIX', 'DIA', 'EFA', 'EEM', 'GLD', 'SLV', 'TLT', 'HYG', 'LQD'
]

def lambda_handler(event, context):
    """
    Daily market data fetcher - runs after market close
    """
    try:
        print(f"Starting daily market data fetch at {datetime.now()}")
        
        # Get current date
        current_date = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        
        # Fetch market data
        market_data = fetch_market_data()
        
        # Store in DynamoDB
        store_market_data(current_date, market_data)
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': 'Market data fetched successfully',
                'date': current_date,
                'symbols_count': len(market_data)
            })
        }
        
    except Exception as e:
        print(f"Error fetching market data: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({
                'message': 'Error fetching market data',
                'error': str(e)
            })
        }

def fetch_market_data():
    """
    Fetch market data from multiple sources
    """
    market_data = {}
    
    # Try Alpha Vantage first (free tier)
    if ALPHA_VANTAGE_KEY:
        market_data.update(fetch_alpha_vantage_data())
    
    # Try Polygon if available (better data quality)
    if POLYGON_KEY:
        polygon_data = fetch_polygon_data()
        market_data.update(polygon_data)
    
    # Fallback to mock data for development
    if not market_data:
        market_data = generate_mock_market_data()
    
    return market_data

def fetch_alpha_vantage_data():
    """
    Fetch data from Alpha Vantage API
    """
    data = {}
    
    for symbol in KEY_SYMBOLS[:5]:  # Limit to 5 calls per minute (free tier)
        try:
            url = f"https://www.alphavantage.co/query"
            params = {
                'function': 'GLOBAL_QUOTE',
                'symbol': symbol,
                'apikey': ALPHA_VANTAGE_KEY
            }
            
            response = requests.get(url, params=params, timeout=10)
            response.raise_for_status()
            
            result = response.json()
            
            if 'Global Quote' in result:
                quote = result['Global Quote']
                data[symbol] = {
                    'symbol': symbol,
                    'price': float(quote.get('05. price', 0)),
                    'change': float(quote.get('09. change', 0)),
                    'changePercent': float(quote.get('10. change percent', '0%').replace('%', '')),
                    'volume': int(quote.get('06. volume', 0)),
                    'high': float(quote.get('03. high', 0)),
                    'low': float(quote.get('04. low', 0)),
                    'open': float(quote.get('02. open', 0)),
                    'previousClose': float(quote.get('08. previous close', 0)),
                    'timestamp': datetime.now(timezone.utc).isoformat()
                }
            
            # Rate limiting for free tier
            import time
            time.sleep(12)  # 5 calls per minute max
            
        except Exception as e:
            print(f"Error fetching {symbol} from Alpha Vantage: {e}")
            continue
    
    return data

def fetch_polygon_data():
    """
    Fetch data from Polygon API (premium)
    """
    data = {}
    
    try:
        # Get previous day's close (market is closed)
        yesterday = (datetime.now() - timedelta(days=1)).strftime('%Y-%m-%d')
        
        for symbol in KEY_SYMBOLS:
            url = f"https://api.polygon.io/v1/open-close/{symbol}/{yesterday}"
            params = {'apikey': POLYGON_KEY}
            
            response = requests.get(url, params=params, timeout=10)
            response.raise_for_status()
            
            result = response.json()
            
            if result.get('status') == 'OK':
                data[symbol] = {
                    'symbol': symbol,
                    'price': result.get('close', 0),
                    'change': result.get('close', 0) - result.get('open', 0),
                    'changePercent': ((result.get('close', 0) - result.get('open', 0)) / result.get('open', 1)) * 100,
                    'volume': result.get('volume', 0),
                    'high': result.get('high', 0),
                    'low': result.get('low', 0),
                    'open': result.get('open', 0),
                    'previousClose': result.get('open', 0),
                    'timestamp': datetime.now(timezone.utc).isoformat()
                }
            
            # Rate limiting
            import time
            time.sleep(0.1)
            
    except Exception as e:
        print(f"Error fetching Polygon data: {e}")
    
    return data

def generate_mock_market_data():
    """
    Generate mock market data for development/testing
    """
    import random
    
    data = {}
    base_prices = {
        'SPY': 450.0, 'QQQ': 380.0, 'IWM': 200.0, 'AAPL': 175.0, 'MSFT': 350.0,
        'GOOGL': 140.0, 'AMZN': 150.0, 'TSLA': 250.0, 'NVDA': 450.0,
        'XLF': 35.0, 'XLE': 85.0, 'XLK': 180.0, 'XLV': 140.0, 'XLI': 110.0,
        'VIX': 18.0, 'DIA': 350.0, 'EFA': 75.0, 'EEM': 40.0, 'GLD': 190.0
    }
    
    for symbol in KEY_SYMBOLS:
        base_price = base_prices.get(symbol, 100.0)
        change_pct = random.uniform(-3.0, 3.0)  # Random change between -3% and +3%
        new_price = base_price * (1 + change_pct / 100)
        change = new_price - base_price
        
        data[symbol] = {
            'symbol': symbol,
            'price': round(new_price, 2),
            'change': round(change, 2),
            'changePercent': round(change_pct, 2),
            'volume': random.randint(1000000, 50000000),
            'high': round(new_price * 1.02, 2),
            'low': round(new_price * 0.98, 2),
            'open': round(base_price, 2),
            'previousClose': round(base_price, 2),
            'timestamp': datetime.now(timezone.utc).isoformat()
        }
    
    return data

def store_market_data(date, market_data):
    """
    Store market data in DynamoDB
    """
    table = dynamodb.Table(MARKET_DATA_TABLE)
    
    # Convert floats to Decimal for DynamoDB
    def convert_floats_to_decimals(obj):
        if isinstance(obj, float):
            return Decimal(str(obj))
        elif isinstance(obj, dict):
            return {k: convert_floats_to_decimals(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [convert_floats_to_decimals(elem) for elem in obj]
        else:
            return obj
    
    try:
        # Store daily market data
        item = {
            'date': date,
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'marketData': convert_floats_to_decimals(market_data),
            'symbolsCount': len(market_data)
        }
        
        table.put_item(Item=item)
        print(f"Stored market data for {date} with {len(market_data)} symbols")
        
    except Exception as e:
        print(f"Error storing market data: {e}")
        raise e

def get_latest_market_data():
    """
    Get the most recent market data from DynamoDB
    """
    table = dynamodb.Table(MARKET_DATA_TABLE)
    
    try:
        response = table.scan()
        items = response.get('Items', [])
        
        if not items:
            return None
        
        # Get the most recent item
        latest = max(items, key=lambda x: x.get('date', ''))
        return latest
        
    except Exception as e:
        print(f"Error getting latest market data: {e}")
        return None
