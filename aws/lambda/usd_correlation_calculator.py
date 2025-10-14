import json
import boto3
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from decimal import Decimal
import os

# Initialize AWS clients
dynamodb = boto3.resource('dynamodb')
price_table = dynamodb.Table('MarketPriceHistory')
correlation_table = dynamodb.Table('USDCorrelations')

# Correlation periods in trading days
CORRELATION_PERIODS = [15, 30, 90, 120, 180]

# Assets to correlate with USD (DXY)
CORRELATION_ASSETS = ['SPX', 'BRENT', 'CRB', 'GOLD', 'BTC']

def lambda_handler(event, context):
    """
    Lambda function to calculate USD correlations across multiple time periods
    Scheduled to run daily at 5:30 PM EST after market data collection
    """
    print("Starting USD correlation calculation...")
    
    try:
        # Get today's date
        today = datetime.utcnow().strftime('%Y-%m-%d')
        
        # Fetch historical price data for DXY (USD proxy)
        dxy_data = fetch_price_history('DXY', 365)  # Get 1 year of data
        
        if not dxy_data or len(dxy_data) < 180:
            raise ValueError("Insufficient DXY data for correlation calculation")
        
        # Calculate correlations for each asset
        correlations = {}
        rolling_stats = {}
        
        for asset in CORRELATION_ASSETS:
            print(f"Calculating correlations for {asset}...")
            
            # Fetch historical data for the asset
            asset_data = fetch_price_history(asset, 365)
            
            if not asset_data or len(asset_data) < 180:
                print(f"Insufficient data for {asset}, skipping...")
                continue
            
            # Align data by date and calculate correlations
            aligned_data = align_price_data(dxy_data, asset_data)
            
            if len(aligned_data) < 180:
                print(f"Insufficient aligned data for {asset}, skipping...")
                continue
            
            # Calculate correlations for each period
            asset_correlations = {}
            for period in CORRELATION_PERIODS:
                if len(aligned_data) >= period:
                    correlation = calculate_correlation(aligned_data, period)
                    asset_correlations[str(period) + 'D'] = round(correlation, 2)
                else:
                    asset_correlations[str(period) + 'D'] = None
            
            correlations[asset] = asset_correlations
            
            # Calculate 52-week rolling 30-day correlation statistics
            rolling_stats[asset] = calculate_rolling_stats(aligned_data)
        
        # Store results in DynamoDB
        store_correlation_results(today, correlations, rolling_stats)
        
        print(f"Successfully calculated correlations for {len(correlations)} assets")
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': 'Correlation calculation completed successfully',
                'assets_processed': list(correlations.keys()),
                'calculation_date': today
            })
        }
        
    except Exception as e:
        print(f"Error in correlation calculation: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': str(e),
                'message': 'Correlation calculation failed'
            })
        }

def fetch_price_history(symbol, days):
    """
    Fetch historical price data from DynamoDB
    """
    try:
        # Calculate start date
        end_date = datetime.utcnow()
        start_date = end_date - timedelta(days=days)
        
        # Query DynamoDB for historical data
        response = price_table.query(
            KeyConditionExpression='symbol = :symbol AND #date BETWEEN :start_date AND :end_date',
            ExpressionAttributeNames={'#date': 'date'},
            ExpressionAttributeValues={
                ':symbol': symbol,
                ':start_date': start_date.strftime('%Y-%m-%d'),
                ':end_date': end_date.strftime('%Y-%m-%d')
            },
            ScanIndexForward=True  # Sort by date ascending
        )
        
        # Convert to list of price data
        price_data = []
        for item in response['Items']:
            price_data.append({
                'date': item['date'],
                'close': float(item['close'])
            })
        
        return price_data
        
    except Exception as e:
        print(f"Error fetching price history for {symbol}: {str(e)}")
        return None

def align_price_data(dxy_data, asset_data):
    """
    Align DXY and asset price data by date
    """
    # Create date-indexed dictionaries
    dxy_dict = {item['date']: item['close'] for item in dxy_data}
    asset_dict = {item['date']: item['close'] for item in asset_data}
    
    # Find common dates
    common_dates = set(dxy_dict.keys()) & set(asset_dict.keys())
    common_dates = sorted(list(common_dates))
    
    # Create aligned data
    aligned_data = []
    for date in common_dates:
        aligned_data.append({
            'date': date,
            'dxy': dxy_dict[date],
            'asset': asset_dict[date]
        })
    
    return aligned_data

def calculate_correlation(aligned_data, period):
    """
    Calculate Pearson correlation coefficient for the last N trading days
    """
    if len(aligned_data) < period:
        return None
    
    # Get the last N days of data
    recent_data = aligned_data[-period:]
    
    # Extract price arrays
    dxy_prices = [item['dxy'] for item in recent_data]
    asset_prices = [item['asset'] for item in recent_data]
    
    # Calculate correlation coefficient
    correlation = np.corrcoef(dxy_prices, asset_prices)[0, 1]
    
    return correlation

def calculate_rolling_stats(aligned_data):
    """
    Calculate 52-week rolling 30-day correlation statistics
    """
    if len(aligned_data) < 30:
        return {
            'high': None,
            'low': None,
            'percentTimePositive': None,
            'percentTimeNegative': None
        }
    
    # Calculate rolling 30-day correlations
    rolling_correlations = []
    
    for i in range(30, len(aligned_data) + 1):
        window_data = aligned_data[i-30:i]
        correlation = calculate_correlation(window_data, 30)
        if correlation is not None:
            rolling_correlations.append(correlation)
    
    if not rolling_correlations:
        return {
            'high': None,
            'low': None,
            'percentTimePositive': None,
            'percentTimeNegative': None
        }
    
    # Calculate statistics
    high = max(rolling_correlations)
    low = min(rolling_correlations)
    
    positive_count = sum(1 for corr in rolling_correlations if corr > 0)
    negative_count = len(rolling_correlations) - positive_count
    
    percent_positive = round((positive_count / len(rolling_correlations)) * 100)
    percent_negative = round((negative_count / len(rolling_correlations)) * 100)
    
    return {
        'high': round(high, 2),
        'low': round(low, 2),
        'percentTimePositive': percent_positive,
        'percentTimeNegative': percent_negative
    }

def store_correlation_results(calculation_date, correlations, rolling_stats):
    """
    Store correlation results in DynamoDB
    """
    try:
        # Convert to DynamoDB-compatible format
        item = {
            'calculationDate': calculation_date,
            'correlations': convert_to_dynamodb_map(correlations),
            'rollingStats': convert_to_dynamodb_map(rolling_stats),
            'timestamp': datetime.utcnow().isoformat()
        }
        
        # Store in DynamoDB
        correlation_table.put_item(Item=item)
        print(f"Stored correlation results for {calculation_date}")
        
    except Exception as e:
        print(f"Error storing correlation results: {str(e)}")
        raise e

def convert_to_dynamodb_map(data):
    """
    Convert nested dictionaries to DynamoDB-compatible format
    """
    if isinstance(data, dict):
        result = {}
        for key, value in data.items():
            if isinstance(value, (int, float)):
                result[key] = Decimal(str(value))
            elif isinstance(value, dict):
                result[key] = convert_to_dynamodb_map(value)
            else:
                result[key] = value
        return result
    else:
        return data
