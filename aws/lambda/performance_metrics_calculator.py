import json
import boto3
from datetime import datetime, timedelta
from decimal import Decimal
import os
from statistics import mean, stdev
import math

dynamodb = boto3.resource('dynamodb')

PERFORMANCE_TABLE = os.environ.get('PERFORMANCE_TABLE', 'PerformanceHistory')
METRICS_TABLE = os.environ.get('METRICS_TABLE', 'PerformanceMetrics')

def lambda_handler(event, context):
    """
    Calculate and store performance metrics
    Can be triggered by EventBridge (daily) or called after CSV upload
    """
    try:
        calculation_date = event.get('date') or datetime.utcnow().strftime('%Y-%m-%d')
        
        # Calculate metrics for different periods
        periods = ['all', '1y', '90d', '30d']
        
        for period in periods:
            metrics = calculate_performance_metrics(period, calculation_date)
            if metrics:
                store_metrics(period, calculation_date, metrics)
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': 'Performance metrics calculated successfully',
                'calculationDate': calculation_date
            })
        }
    except Exception as e:
        print(f"Error calculating performance metrics: {str(e)}")
        raise e


def get_performance_history(period='all'):
    """Get performance history for specified period"""
    try:
        table = dynamodb.Table(PERFORMANCE_TABLE)
        result = table.scan()
        items = result.get('Items', [])
        
        if not items:
            return []
        
        # Sort by date
        items.sort(key=lambda x: x['date'])
        
        # Filter by period
        if period != 'all':
            cutoff_date = datetime.utcnow() - timedelta(days=int(period.replace('d', '').replace('y', '')) * (365 if 'y' in period else 1))
            cutoff_str = cutoff_date.strftime('%Y-%m-%d')
            items = [item for item in items if item['date'] >= cutoff_str]
        
        return items
    except Exception as e:
        print(f"Error getting performance history: {str(e)}")
        return []


def calculate_sharpe_ratio(returns, risk_free_rate=0.02):
    """Calculate annualized Sharpe ratio"""
    if not returns or len(returns) < 2:
        return Decimal('0')
    
    # Convert to float for calculation
    returns_float = [float(r) for r in returns]
    avg_return = mean(returns_float)
    
    if len(returns_float) < 2:
        return Decimal('0')
    
    std_dev = stdev(returns_float)
    if std_dev == 0:
        return Decimal('0')
    
    # Annualize (assuming 252 trading days)
    annual_return = avg_return * 252
    annual_std = std_dev * math.sqrt(252)
    
    if annual_std == 0:
        return Decimal('0')
    
    sharpe = (annual_return - risk_free_rate) / annual_std
    return Decimal(str(sharpe))


def calculate_max_drawdown(values):
    """Calculate maximum drawdown percentage"""
    if not values or len(values) < 2:
        return Decimal('0')
    
    values_float = [float(v) for v in values]
    peak = values_float[0]
    max_dd = Decimal('0')
    
    for value in values_float:
        if value > peak:
            peak = value
        if peak > 0:
            drawdown = ((value - peak) / peak) * 100
            if drawdown < max_dd:
                max_dd = Decimal(str(drawdown))
    
    return max_dd


def calculate_volatility(returns):
    """Calculate annualized volatility"""
    if not returns or len(returns) < 2:
        return Decimal('0')
    
    returns_float = [float(r) for r in returns]
    std_dev = stdev(returns_float)
    
    # Annualize (assuming 252 trading days)
    annual_vol = std_dev * math.sqrt(252) * 100
    return Decimal(str(annual_vol))


def calculate_win_rate(returns):
    """Calculate win rate (percentage of positive days)"""
    if not returns:
        return Decimal('0')
    
    positive_days = sum(1 for r in returns if float(r) > 0)
    win_rate = (positive_days / len(returns)) * 100
    return Decimal(str(win_rate))


def calculate_rolling_returns(dates, values, periods=[30, 90, 180, 365]):
    """Calculate rolling returns for different periods"""
    if not dates or not values or len(dates) != len(values):
        return {}
    
    rolling = {}
    values_float = [float(v) for v in values]
    
    for period in periods:
        if len(values_float) >= period:
            start_value = values_float[0]
            end_value = values_float[-1]
            if start_value > 0:
                return_pct = ((end_value - start_value) / start_value) * 100
                rolling[f'{period}d'] = Decimal(str(return_pct))
            else:
                rolling[f'{period}d'] = Decimal('0')
        else:
            # Use available data
            if len(values_float) > 1 and values_float[0] > 0:
                return_pct = ((values_float[-1] - values_float[0]) / values_float[0]) * 100
                rolling[f'{period}d'] = Decimal(str(return_pct))
            else:
                rolling[f'{period}d'] = Decimal('0')
    
    return rolling


def calculate_vs_benchmark(portfolio_returns, benchmark_returns):
    """Calculate performance vs benchmark (simplified - would need actual benchmark data)"""
    # This is a placeholder - would need to fetch benchmark data from MarketData table
    # For now, return empty structure
    return {}


def calculate_performance_metrics(period, calculation_date):
    """Calculate all performance metrics for a period"""
    history = get_performance_history(period)
    
    if not history:
        return None
    
    # Extract data
    dates = [item['date'] for item in history]
    values = [item['totalValue'] for item in history]
    returns = [item['dailyReturn'] for item in history]
    
    # Calculate metrics
    sharpe_ratio = calculate_sharpe_ratio(returns)
    max_drawdown = calculate_max_drawdown(values)
    volatility = calculate_volatility(returns)
    win_rate = calculate_win_rate(returns)
    
    # Average daily return
    if returns:
        avg_daily_return = Decimal(str(mean([float(r) for r in returns])))
    else:
        avg_daily_return = Decimal('0')
    
    # Best and worst day
    if returns:
        returns_float = [float(r) for r in returns]
        best_day = Decimal(str(max(returns_float)))
        worst_day = Decimal(str(min(returns_float)))
    else:
        best_day = Decimal('0')
        worst_day = Decimal('0')
    
    # Rolling returns
    rolling_returns = calculate_rolling_returns(dates, values)
    
    # Benchmark comparison (placeholder)
    vs_benchmark = calculate_vs_benchmark(returns, [])
    
    return {
        'sharpeRatio': sharpe_ratio,
        'maxDrawdown': max_drawdown,
        'volatility': volatility,
        'winRate': win_rate,
        'avgDailyReturn': avg_daily_return,
        'bestDay': best_day,
        'worstDay': worst_day,
        'rollingReturns': rolling_returns,
        'vsBenchmark': vs_benchmark
    }


def store_metrics(metric_type, calculation_date, metrics):
    """Store calculated metrics in DynamoDB"""
    try:
        table = dynamodb.Table(METRICS_TABLE)
        
        item = {
            'metricType': metric_type,
            'calculationDate': calculation_date,
            'sharpeRatio': metrics['sharpeRatio'],
            'maxDrawdown': metrics['maxDrawdown'],
            'volatility': metrics['volatility'],
            'winRate': metrics['winRate'],
            'avgDailyReturn': metrics['avgDailyReturn'],
            'bestDay': metrics['bestDay'],
            'worstDay': metrics['worstDay'],
            'rollingReturns': metrics['rollingReturns'],
            'vsBenchmark': metrics['vsBenchmark'],
            'timestamp': datetime.utcnow().isoformat()
        }
        
        table.put_item(Item=item)
        print(f"Stored metrics for {metric_type} on {calculation_date}")
    except Exception as e:
        print(f"Error storing metrics: {str(e)}")
        raise e

