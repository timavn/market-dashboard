import json
import boto3
import csv
from datetime import datetime
from decimal import Decimal
import os
from io import StringIO
from urllib.parse import unquote_plus

def convert_floats_to_decimals(obj):
    """Recursively convert float values to Decimal for DynamoDB compatibility"""
    if isinstance(obj, float):
        # Convert float to string first to maintain precision, then to Decimal
        return Decimal(str(obj))
    elif isinstance(obj, dict):
        return {k: convert_floats_to_decimals(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [convert_floats_to_decimals(elem) for elem in obj]
    else:
        return obj

s3_client = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')

# DynamoDB table names from environment variables
PORTFOLIO_TABLE = os.environ.get('PORTFOLIO_TABLE', 'PortfolioSnapshots')
HOLDINGS_TABLE = os.environ.get('HOLDINGS_TABLE', 'Holdings')
LOGS_TABLE = os.environ.get('LOGS_TABLE', 'ProcessingLogs')

def lambda_handler(event, context):
    """
    Lambda function to process Schwab CSV files uploaded to S3
    Triggered by S3 PUT events
    """
    bucket = None
    key = None

    try:
        # Get bucket and key from S3 event (decode URL-encoded key)
        bucket = event['Records'][0]['s3']['bucket']['name']
        raw_key = event['Records'][0]['s3']['object']['key']
        key = unquote_plus(raw_key)

        print(f"Processing file: {bucket}/{key}")

        # Download CSV from S3 with encoding fallback
        response = s3_client.get_object(Bucket=bucket, Key=key)
        body_bytes = response['Body'].read()
        try:
            csv_content = body_bytes.decode('utf-8')
        except UnicodeDecodeError:
            csv_content = body_bytes.decode('cp1252')

        # Parse Schwab CSV
        portfolio_data = parse_schwab_csv(csv_content)

        # Store in DynamoDB
        snapshot_id = store_portfolio_snapshot(portfolio_data)
        store_holdings(snapshot_id, portfolio_data['holdings'])

        # Log successful processing
        log_processing(bucket, key, 'SUCCESS', snapshot_id)

        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': 'CSV processed successfully',
                'snapshotId': snapshot_id,
                'holdingsCount': len(portfolio_data['holdings'])
            })
        }

    except Exception as e:
        print(f"Error processing CSV: {str(e)}")
        if bucket and key:
            log_processing(bucket, key, 'FAILED', error=str(e))
        raise e


def parse_schwab_csv(csv_content):
    """
    Parse real Schwab CSV format and extract portfolio data
    Schwab CSV has: Row 1 (account info), Row 2 (blank), Row 3 (headers), Row 4+ (data)
    """
    lines = csv_content.strip().split('\n')

    # Find header row (contains "Symbol" and "Description")
    # Should be on row 3 (index 2) for Schwab format
    header_index = -1
    for i, line in enumerate(lines):
        if 'Symbol' in line and 'Description' in line:
            header_index = i
            break

    if header_index == -1:
        raise ValueError("Could not find header row in CSV")

    print(f"Found header row at index {header_index}: {lines[header_index][:100]}...")

    # Parse CSV data starting from header row
    csv_data = '\n'.join(lines[header_index:])
    reader = csv.DictReader(StringIO(csv_data))

    holdings = []
    total_value = Decimal('0')
    asset_allocation = {}

    for row in reader:
        symbol = row.get('Symbol', '').strip()
        description = row.get('Description', '').strip()

        # Debug logging for first few rows
        if len(holdings) < 3:
            print(f"Processing row: Symbol='{symbol}', Description='{description[:50]}...'")

        # Skip account totals, cash, and invalid rows
        if (not symbol or 
            symbol.startswith('Account Total') or 
            symbol == 'Totals' or
            symbol == 'Cash & Cash Investments' or
            symbol == 'Account T' or
            symbol.startswith('---') or
            description == '--'):  # Skip rows where description is just '--'
            print(f"Skipping row: Symbol='{symbol}', Description='{description}'")
            continue

        # Parse numerical values using exact Schwab column names
        quantity = parse_number(row.get('Qty (Quantity)', '0'))
        price = parse_number(row.get('Price', '0'))
        market_value = parse_number(row.get('Mkt Val (Market Value)', '0'))
        
        # Schwab doesn't provide cost basis, so we'll calculate it
        # Cost basis = Market Value - Gain/Loss
        gain_loss = parse_number(row.get('Gain $ (Gain/Loss $)', '0'))
        cost_basis = market_value - gain_loss if market_value > 0 else Decimal('0')
        
        gain_loss_pct = parse_number(row.get('Gain % (Gain/Loss %)', '0'))

        # Asset type mapping using exact Schwab column
        asset_type = row.get('Security Type', 'Unknown')
        asset_class = map_asset_type(asset_type)

        # Only include holdings with actual market value
        if market_value > 0:
            holding = {
                'symbol': symbol,
                'description': row.get('Description', '').strip(),
                'quantity': quantity,
                'price': price,
                'marketValue': market_value,
                'costBasis': cost_basis,
                'gainLoss': gain_loss,
                'gainLossPercent': gain_loss_pct,
                'assetType': asset_type,
                'assetClass': asset_class
            }

            holdings.append(holding)
            total_value += Decimal(str(market_value))

            # Aggregate asset allocation
            if asset_class in asset_allocation:
                asset_allocation[asset_class] += market_value
            else:
                asset_allocation[asset_class] = market_value

    # Calculate percentages for asset allocation
    asset_allocation_pct = {}
    if total_value > 0:
        for asset_class, value in asset_allocation.items():
            percentage = (Decimal(str(value)) / total_value) * 100
            asset_allocation_pct[asset_class] = percentage

    # Calculate summary metrics
    total_gain_loss = sum(h['gainLoss'] for h in holdings)
    total_cost_basis = sum(h['costBasis'] for h in holdings)
    total_gain_loss_pct = (total_gain_loss / total_cost_basis * 100) if total_cost_basis > 0 else Decimal('0')

    return {
        'holdings': holdings,
        'summary': {
            'totalValue': total_value,
            'totalGainLoss': total_gain_loss,
            'totalGainLossPercent': total_gain_loss_pct,
            'positionCount': len(holdings),
            'totalCostBasis': total_cost_basis
        },
        'assetAllocation': asset_allocation_pct
    }


def parse_number(value):
    """Parse dollar amounts and percentages from Schwab CSV format"""
    if not value or value == '--' or value == 'N/A':
        return Decimal('0')

    # Remove $, commas, and % signs
    cleaned = str(value).replace('$', '').replace(',', '').replace('%', '').strip()

    # Handle parentheses for negative numbers
    if cleaned.startswith('(') and cleaned.endswith(')'):
        cleaned = '-' + cleaned[1:-1]

    # Handle negative signs at the beginning
    if cleaned.startswith('-'):
        cleaned = '-' + cleaned[1:]

    try:
        return Decimal(cleaned)
    except (ValueError, Exception):
        return Decimal('0')


def map_asset_type(schwab_type):
    """Map Schwab asset types to our asset classes"""
    mapping = {
        'ETFs & Closed End Funds': 'Equities',
        'Equity': 'Equities',
        'Cash and Money Market': 'Cash',
        'Fixed Income': 'Fixed Income',
        'Options': 'Derivatives',
        'Mutual Funds': 'Equities'
    }
    return mapping.get(schwab_type, 'Other')


def store_portfolio_snapshot(portfolio_data):
    """Store portfolio snapshot in DynamoDB"""
    table = dynamodb.Table(PORTFOLIO_TABLE)

    snapshot_id = datetime.utcnow().strftime('%Y%m%d_%H%M%S')
    timestamp = datetime.utcnow().isoformat()

    # Convert all float values to Decimal for DynamoDB compatibility
    converted_summary = convert_floats_to_decimals(portfolio_data['summary'])
    converted_asset_allocation = convert_floats_to_decimals(portfolio_data['assetAllocation'])

    item = {
        'snapshotId': snapshot_id,
        'timestamp': timestamp,
        'summary': converted_summary,
        'assetAllocation': converted_asset_allocation,
        'holdingsCount': len(portfolio_data['holdings'])
    }

    try:
        table.put_item(Item=item)
        print(f"Stored portfolio snapshot: {snapshot_id}")
        return snapshot_id
    except Exception as e:
        print(f"Error storing portfolio snapshot: {str(e)}")
        raise e


def store_holdings(snapshot_id, holdings):
    """Store individual holdings in DynamoDB - replaces all previous holdings"""
    table = dynamodb.Table(HOLDINGS_TABLE)

    try:
        # First, delete all existing holdings to ensure fresh daily data
        print("Clearing previous holdings...")
        delete_all_holdings(table)
        
        # Then store new holdings
        with table.batch_writer() as batch:
            for holding in holdings:
                # Create composite holdingId as partition key
                holding_id = f"{snapshot_id}#{holding['symbol']}"

                # Convert all float values in holding to Decimal
                converted_holding = convert_floats_to_decimals(holding)

                item = {
                    'holdingId': holding_id,
                    'snapshotId': snapshot_id,
                    **converted_holding  # Use the converted holding data
                }
                batch.put_item(Item=item)

        print(f"Stored {len(holdings)} holdings (replaced all previous)")
        
    except Exception as e:
        print(f"Error storing holdings: {str(e)}")
        raise e


def delete_all_holdings(table):
    """Delete all existing holdings from the table"""
    try:
        # Scan to get all items
        response = table.scan()
        items = response.get('Items', [])
        
        if items:
            # Delete items in batches
            with table.batch_writer() as batch:
                for item in items:
                    batch.delete_item(
                        Key={'holdingId': item['holdingId']}
                    )
            print(f"Deleted {len(items)} previous holdings")
        else:
            print("No previous holdings to delete")
            
    except Exception as e:
        print(f"Warning: Could not delete previous holdings: {str(e)}")
        # Don't fail the whole function if deletion fails


def log_processing(bucket, key, status, snapshot_id=None, error=None):
    """Log processing attempt in DynamoDB"""
    try:
        table = dynamodb.Table(LOGS_TABLE)

        timestamp = datetime.utcnow().isoformat()
        item = {
            'logId': f"{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}_{key.replace('/', '_')}",
            'timestamp': timestamp,
            'bucket': bucket,
            'key': key,
            'status': status,
        }

        if snapshot_id:
            item['snapshotId'] = snapshot_id
        if error:
            item['errorMessage'] = str(error)

        table.put_item(Item=item)
        print(f"Logged processing: {status}")
    except Exception as e:
        # Don't fail the whole function if logging fails
        print(f"Warning: Could not log to ProcessingLogs: {str(e)}")


