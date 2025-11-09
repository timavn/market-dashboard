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
# Expanded to include all 111 securities from securities universe
MARKET_SYMBOLS = {
    'AAPL': {'source': 'yahoo', 'ticker': 'AAPL', 'name': 'Apple Inc.'},
    'AMZN': {'source': 'yahoo', 'ticker': 'AMZN', 'name': 'Amazon Inc.'},
    'AVAX': {'source': 'yahoo', 'ticker': 'AVAX-USD', 'name': 'Avalanche'},
    'BITCOIN': {'source': 'yahoo', 'ticker': 'BTC-USD', 'name': 'Bitcoin Spot Price'},
    'BKLN': {'source': 'yahoo', 'ticker': 'BKLN', 'name': 'Corporate Senior Loans (BKLN)'},
    'BLOK': {'source': 'yahoo', 'ticker': 'BLOK', 'name': 'Amplify Transformational Data Sharing ETF'},
    'BMNR': {'source': 'yahoo', 'ticker': 'BMNR', 'name': 'BMNR'},
    'BNDX': {'source': 'yahoo', 'ticker': 'BNDX', 'name': 'International Bonds ex-U.S. (BNDX)'},
    'BRENT': {'source': 'yahoo', 'ticker': 'BZ=F', 'name': 'Brent Crude Oil Continuous Contract'},
    'BTC': {'source': 'yahoo', 'ticker': 'BTC-USD', 'name': 'Bitcoin'},
    'CAD/USD': {'source': 'yahoo', 'ticker': 'CADUSD=X', 'name': 'Canadian Dollar to U.S. Dollar'},
    'COIN': {'source': 'yahoo', 'ticker': 'COIN', 'name': 'Coinbase Global Inc.'},
    'COMPQ': {'source': 'yahoo', 'ticker': '^IXIC', 'name': 'NASDAQ Composite'},
    'COPPER': {'source': 'yahoo', 'ticker': 'HG=F', 'name': 'Copper Continuous Contract'},
    'CRCL': {'source': 'yahoo', 'ticker': 'CRCL', 'name': 'Crypto Currency Corp.'},
    'CWB': {'source': 'yahoo', 'ticker': 'CWB', 'name': 'U.S. Convertible Liquid Bond Securities (CWB)'},
    'DAX': {'source': 'yahoo', 'ticker': '^GDAXI', 'name': 'German DAX Composite'},
    'EMB': {'source': 'yahoo', 'ticker': 'EMB', 'name': 'Emerging Markets USD Bonds (EMB)'},
    'EMXC': {'source': 'yahoo', 'ticker': 'EMXC', 'name': 'Emerging Markets ex-China (EMXC)'},
    'ETH': {'source': 'yahoo', 'ticker': 'ETH-USD', 'name': 'Ethereum'},
    'ETHA': {'source': 'yahoo', 'ticker': 'ETHA', 'name': 'Etherea Capital Corp.'},
    'EUR/USD': {'source': 'yahoo', 'ticker': 'EURUSD=X', 'name': 'Euro to U.S. Dollar'},
    'EWA': {'source': 'yahoo', 'ticker': 'EWA', 'name': 'Australia (EWA)'},
    'EWC': {'source': 'yahoo', 'ticker': 'EWC', 'name': 'Canada (EWC)'},
    'EWG': {'source': 'yahoo', 'ticker': 'EWG', 'name': 'Germany (EWG)'},
    'EWH': {'source': 'yahoo', 'ticker': 'EWH', 'name': 'Hong Kong (EWH)'},
    'EWJ': {'source': 'yahoo', 'ticker': 'EWJ', 'name': 'Japan (EWJ)'},
    'EWQ': {'source': 'yahoo', 'ticker': 'EWQ', 'name': 'France (EWQ)'},
    'EWS': {'source': 'yahoo', 'ticker': 'EWS', 'name': 'Singapore (EWS)'},
    'EWU': {'source': 'yahoo', 'ticker': 'EWU', 'name': 'United Kingdom (EWU)'},
    'EWW': {'source': 'yahoo', 'ticker': 'EWW', 'name': 'Mexico (EWW)'},
    'EWY': {'source': 'yahoo', 'ticker': 'EWY', 'name': 'South Korea (EWY)'},
    'EWZ': {'source': 'yahoo', 'ticker': 'EWZ', 'name': 'Brazil (EWZ)'},
    'EZA': {'source': 'yahoo', 'ticker': 'EZA', 'name': 'South Africa (EZA)'},
    'FXB': {'source': 'yahoo', 'ticker': 'FXB', 'name': 'British Pound (FXB)'},
    'FXE': {'source': 'yahoo', 'ticker': 'FXE', 'name': 'Euro (FXE)'},
    'FXF': {'source': 'yahoo', 'ticker': 'FXF', 'name': 'Swiss Franc (FXF)'},
    'FXI': {'source': 'yahoo', 'ticker': 'FXI', 'name': 'China (FXI)'},
    'FXY': {'source': 'yahoo', 'ticker': 'FXY', 'name': 'Japanese Yen (FXY)'},
    'GBP/USD': {'source': 'yahoo', 'ticker': 'GBPUSD=X', 'name': 'British Pound to U.S. Dollar'},
    'GDX': {'source': 'yahoo', 'ticker': 'GDX', 'name': 'Gold Miners (GDX)'},
    'GLD': {'source': 'yahoo', 'ticker': 'GLD', 'name': 'Gold (GLD)'},
    'GOLD': {'source': 'yahoo', 'ticker': 'GC=F', 'name': 'Gold Spot Price'},
    'GOOGL': {'source': 'yahoo', 'ticker': 'GOOGL', 'name': 'Alphabet Inc.'},
    'HEFA': {'source': 'yahoo', 'ticker': 'HEFA', 'name': 'Currency Hedged Equities ex. U.S. & Canada (HEFA)'},
    'HYG': {'source': 'yahoo', 'ticker': 'HYG', 'name': 'High Yield Corporate Bonds (HYG)'},
    'IBIT': {'source': 'yahoo', 'ticker': 'IBIT', 'name': 'iShares Bitcoin Trust'},
    'IEF': {'source': 'yahoo', 'ticker': 'IEF', 'name': '7-10 Year U.S. Treasuries (IEF)'},
    'IGOV': {'source': 'yahoo', 'ticker': 'IGOV', 'name': 'International Treasury Bonds ex-U.S. (IGOV)'},
    'ILF': {'source': 'yahoo', 'ticker': 'ILF', 'name': 'Latin America Large-Cap Equities (ILF)'},
    'INDA': {'source': 'yahoo', 'ticker': 'INDA', 'name': 'India (INDA)'},
    'ITA': {'source': 'yahoo', 'ticker': 'ITA', 'name': 'U.S. Defense & Aerospace Sector (ITA)'},
    'ITB': {'source': 'yahoo', 'ticker': 'ITB', 'name': 'U.S. Housing Sector (ITB)'},
    'IWM': {'source': 'yahoo', 'ticker': 'IWM', 'name': 'Russell 2000 (IWM)'},
    'LQD': {'source': 'yahoo', 'ticker': 'LQD', 'name': 'Investment Grade Corporate Bonds (LQD)'},
    'MARA': {'source': 'yahoo', 'ticker': 'MARA', 'name': 'Marathon Digital Holdings'},
    'MBB': {'source': 'yahoo', 'ticker': 'MBB', 'name': 'U.S. Mortgage-Backed Bonds (MBB)'},
    'META': {'source': 'yahoo', 'ticker': 'META', 'name': 'Meta Platforms Inc.'},
    'MLPX': {'source': 'yahoo', 'ticker': 'MLPX', 'name': 'MLPs & Energy Infrastructure (MLPX)'},
    'MSFT': {'source': 'yahoo', 'ticker': 'MSFT', 'name': 'Microsoft Corp.'},
    'MSTR': {'source': 'yahoo', 'ticker': 'MSTR', 'name': 'MicroStrategy Inc.'},
    'MTUM': {'source': 'yahoo', 'ticker': 'MTUM', 'name': 'U.S. Momentum (MTUM)'},
    'NATGAS': {'source': 'yahoo', 'ticker': 'NG=F', 'name': 'Natural Gas Continuous Contract'},
    'NFLX': {'source': 'yahoo', 'ticker': 'NFLX', 'name': 'Netflix Inc.'},
    'NIKK': {'source': 'yahoo', 'ticker': '^N225', 'name': 'Nikkei 225 Index'},
    'NVDA': {'source': 'yahoo', 'ticker': 'NVDA', 'name': 'NVIDIA Corporation'},
    'ORCL': {'source': 'yahoo', 'ticker': 'ORCL', 'name': 'Oracle Corporation'},
    'PDBC': {'source': 'yahoo', 'ticker': 'PDBC', 'name': 'GSCI Commodities Index (PDBC)'},
    'PFF': {'source': 'yahoo', 'ticker': 'PFF', 'name': 'U.S. Preferred and Income Securities (PFF)'},
    'QQQ': {'source': 'yahoo', 'ticker': 'QQQ', 'name': 'Nasdaq 100 (QQQ)'},
    'RIOT': {'source': 'yahoo', 'ticker': 'RIOT', 'name': 'Riot Platforms Inc.'},
    'RSP': {'source': 'yahoo', 'ticker': 'RSP', 'name': 'Equal Weight S&P 500 (RSP)'},
    'RUT': {'source': 'yahoo', 'ticker': '^RUT', 'name': 'Russell 2000'},
    'SHY': {'source': 'yahoo', 'ticker': 'SHY', 'name': '1-3 Year U.S. Treasuries (SHY)'},
    'SILVER': {'source': 'yahoo', 'ticker': 'SI=F', 'name': 'Silver Spot Price'},
    'SLV': {'source': 'yahoo', 'ticker': 'SLV', 'name': 'Silver (SLV)'},
    'SMH': {'source': 'yahoo', 'ticker': 'SMH', 'name': 'Semiconductors (SMH)'},
    'SOL': {'source': 'yahoo', 'ticker': 'SOL-USD', 'name': 'Solana'},
    'SPX': {'source': 'yahoo', 'ticker': '^GSPC', 'name': 'S&P 500'},
    'SPY': {'source': 'yahoo', 'ticker': 'SPY', 'name': 'S&P 500 (SPY)'},
    'SSEC': {'source': 'yahoo', 'ticker': '000001.SS', 'name': 'Shanghai Composite'},
    'TIP': {'source': 'yahoo', 'ticker': 'TIP', 'name': 'Inflation-Protected U.S. Treasuries (TIP)'},
    'TLT': {'source': 'yahoo', 'ticker': 'TLT', 'name': '20+ Year U.S. Treasuries (TLT)'},
    'TSLA': {'source': 'yahoo', 'ticker': 'TSLA', 'name': 'Tesla Inc.'},
    'URA': {'source': 'yahoo', 'ticker': 'URA', 'name': 'Uranium Miners (URA)'},
    'USD': {'source': 'yahoo', 'ticker': 'DX-Y.NYB', 'name': 'U.S. Dollar Index'},
    'USD/YEN': {'source': 'yahoo', 'ticker': 'JPY=X', 'name': 'U.S. Dollar to Japanese Yen'},
    'USMV': {'source': 'yahoo', 'ticker': 'USMV', 'name': 'U.S. Lower Volatility (USMV)'},
    'UST10Y': {'source': 'fred', 'ticker': 'DGS10', 'name': '10-Year U.S. Treasury Yield'},
    'UST2Y': {'source': 'fred', 'ticker': 'DGS2', 'name': '2-Year U.S. Treasury Yield'},
    'UST30Y': {'source': 'fred', 'ticker': 'DGS30', 'name': '30-Year U.S. Treasury Yield'},
    'UUP': {'source': 'yahoo', 'ticker': 'UUP', 'name': 'U.S. Dollar (UUP)'},
    'VGK': {'source': 'yahoo', 'ticker': 'VGK', 'name': 'Eurozone (VGK)'},
    'VIX': {'source': 'yahoo', 'ticker': '^VIX', 'name': 'Volatility Index'},
    'VT': {'source': 'yahoo', 'ticker': 'VT', 'name': 'Global All Cap Equities (VT)'},
    'VYMI': {'source': 'yahoo', 'ticker': 'VYMI', 'name': 'Global Dividend Yield Equities ex-U.S. (VYMI)'},
    'WTIC': {'source': 'yahoo', 'ticker': 'CL=F', 'name': 'Light Crude Oil Continuous Contract'},
    'XLB': {'source': 'yahoo', 'ticker': 'XLB', 'name': 'U.S. Basic Materials Sector (XLB)'},
    'XLC': {'source': 'yahoo', 'ticker': 'XLC', 'name': 'U.S. Communications Sector (XLC)'},
    'XLE': {'source': 'yahoo', 'ticker': 'XLE', 'name': 'U.S. Energy Sectory (XLE)'},
    'XLF': {'source': 'yahoo', 'ticker': 'XLF', 'name': 'U.S. Financials Sector (XLF)'},
    'XLI': {'source': 'yahoo', 'ticker': 'XLI', 'name': 'U.S. Industrials Sector (XLI)'},
    'XLK': {'source': 'yahoo', 'ticker': 'XLK', 'name': 'U.S. Technology Sector (XLK)'},
    'XLP': {'source': 'yahoo', 'ticker': 'XLP', 'name': 'U.S. Consumer Staples Sector (XLP)'},
    'XLRE': {'source': 'yahoo', 'ticker': 'XLRE', 'name': 'U.S. Real Estate Sector (XLRE)'},
    'XLU': {'source': 'yahoo', 'ticker': 'XLU', 'name': 'U.S. Utilities Sector (XLU)'},
    'XLV': {'source': 'yahoo', 'ticker': 'XLV', 'name': 'U.S. Healthcare Sector (XLV)'},
    'XLY': {'source': 'yahoo', 'ticker': 'XLY', 'name': 'U.S. Consumer Discretionary Sector (XLY)'},
    'XME': {'source': 'yahoo', 'ticker': 'XME', 'name': 'Metals & Mining (XME)'},
    'XOP': {'source': 'yahoo', 'ticker': 'XOP', 'name': 'U.S. Oil & Gas Exploration & Production (XOP)'},
    'XRP': {'source': 'yahoo', 'ticker': 'XRP-USD', 'name': 'Ripple'}
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
