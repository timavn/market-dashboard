import json
import boto3
import csv
from datetime import datetime, timedelta
from decimal import Decimal
import os
from io import StringIO
from urllib.parse import unquote_plus
import re

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
PERFORMANCE_TABLE = os.environ.get('PERFORMANCE_TABLE', 'PerformanceHistory')
POSITION_PERFORMANCE_TABLE = os.environ.get('POSITION_PERFORMANCE_TABLE', 'PositionPerformance')

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

        # Extract date from filename
        trading_date = extract_date_from_filename(key)
        if not trading_date:
            # Fallback: use upload timestamp (assume previous day if after market close)
            upload_time = datetime.utcnow()
            # If after 4:30 PM ET (8:30 PM UTC), use today, else use yesterday
            if upload_time.hour >= 20:
                trading_date = upload_time.strftime('%Y-%m-%d')
            else:
                trading_date = (upload_time - timedelta(days=1)).strftime('%Y-%m-%d')
            print(f"Could not extract date from filename, using: {trading_date}")

        # Check if it's a Transactions CSV or Positions CSV
        if is_transactions_csv(csv_content):
            print("Detected Transactions CSV format")
            transactions = parse_schwab_transactions_csv(csv_content)
            process_transaction_history(transactions)
            store_transactions(transactions)
            message = f"Processed {len(transactions)} transactions"
            snapshot_id = "transactions_" + datetime.utcnow().strftime('%Y%m%d_%H%M%S')
        else:
            # Parse Schwab Positions CSV
            print("Detected Positions CSV format")
            portfolio_data = parse_schwab_csv(csv_content)

            # Store in DynamoDB
            snapshot_id = store_portfolio_snapshot(portfolio_data)
            store_holdings(snapshot_id, portfolio_data['holdings'])

            # Store performance data
            store_performance_data(trading_date, portfolio_data, snapshot_id)
            store_position_performance_data(trading_date, portfolio_data['holdings'])
            message = 'Portfolio snapshot processed successfully'

        # Log successful processing
        log_processing(bucket, key, 'SUCCESS', snapshot_id)

        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': message,
                'snapshotId': snapshot_id
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
    account_total_from_csv = None  # Will store Account Total if found in CSV
    
    # Initialize counters
    long_count = 0
    short_count = 0

    for row in reader:
        symbol = row.get('Symbol', '').strip()
        description = row.get('Description', '').strip()

        # Debug logging for first few rows
        if len(holdings) < 3:
            print(f"Processing row: Symbol='{symbol}', Description='{description[:50]}...'")

        # Check for Account Total row first (use this as the authoritative total)
        if symbol.startswith('Account Total'):
            account_total_from_csv = parse_number(row.get('Mkt Val (Market Value)', '0'))
            if account_total_from_csv > 0:
                print(f"Found Account Total in CSV: ${account_total_from_csv}")
            continue
        
        # Skip other summary rows
        if (not symbol or 
            symbol == 'Totals' or
            symbol == 'Account T' or
            symbol.startswith('---') or
            description == '--'):  # Skip rows where description is just '--'
            print(f"Skipping row: Symbol='{symbol}', Description='{description}'")
            continue

        # Handle "Cash & Cash Investments" row (this is additional cash, not a security)
        if symbol == 'Cash & Cash Investments':
            cash_value = parse_number(row.get('Mkt Val (Market Value)', '0'))
            if cash_value > 0:
                print(f"Found additional cash: ${cash_value}")
                # Add to total but don't create a holding
                total_value += cash_value
                
                # FIXED: Add to asset allocation
                if 'Cash' in asset_allocation:
                    asset_allocation['Cash'] += cash_value
                else:
                    asset_allocation['Cash'] = cash_value
            continue

        # Parse numerical values using exact Schwab column names
        quantity = parse_number(row.get('Qty (Quantity)', '0'))
        price = parse_number(row.get('Price', '0'))
        market_value = parse_number(row.get('Mkt Val (Market Value)', '0'))
        
        # Schwab doesn't provide cost basis, so we'll calculate it
        # Cost basis = Market Value - Gain/Loss
        gain_loss = parse_number(row.get('Gain $ (Gain/Loss $)', '0'))
        cost_basis = abs(market_value) - gain_loss if market_value != 0 else Decimal('0')
        
        gain_loss_pct = parse_number(row.get('Gain % (Gain/Loss %)', '0'))

        # Asset type mapping using exact Schwab column
        asset_type = row.get('Security Type', 'Unknown')
        asset_class = map_asset_type(asset_type)

        # Include holdings with actual market value (both longs and shorts)
        # IMPORTANT: Use actual market_value (not abs) so shorts subtract correctly
        if market_value != 0:
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
            # FIXED: Use actual market_value (not abs) so shorts subtract from total
            total_value += market_value
            
            # Count Long/Short positions
            if market_value > 0:
                long_count += 1
            elif market_value < 0:
                short_count += 1

            # Aggregate asset allocation
            if asset_class in asset_allocation:
                asset_allocation[asset_class] += abs(market_value)
            else:
                asset_allocation[asset_class] = abs(market_value)

    # Calculate percentages for asset allocation
    asset_allocation_pct = {}
    if total_value > 0:
        for asset_class, value in asset_allocation.items():
            percentage = (Decimal(str(value)) / total_value) * 100
            asset_allocation_pct[asset_class] = percentage

    # Use Account Total from CSV if available (most accurate), otherwise use calculated total
    final_total_value = account_total_from_csv if account_total_from_csv else total_value
    if account_total_from_csv:
        print(f"Using Account Total from CSV: ${final_total_value} (calculated was ${total_value})")
    else:
        print(f"Using calculated total: ${final_total_value}")

    # Calculate summary metrics
    total_gain_loss = sum(h['gainLoss'] for h in holdings)
    total_cost_basis = sum(abs(h['costBasis']) for h in holdings)
    total_gain_loss_pct = (total_gain_loss / total_cost_basis * 100) if total_cost_basis > 0 else Decimal('0')

    return {
        'holdings': holdings,
        'summary': {
            'totalValue': final_total_value,
            'totalGainLoss': total_gain_loss,
            'totalGainLossPercent': total_gain_loss_pct,
            'positionCount': len(holdings),
            'longCount': long_count,
            'shortCount': short_count,
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

    # Handle parentheses for negative numbers (accounting notation)
    if cleaned.startswith('(') and cleaned.endswith(')'):
        cleaned = '-' + cleaned[1:-1]

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
        'holdingsCount': len(portfolio_data['holdings']),
        'longCount': portfolio_data['summary'].get('longCount', 0),
        'shortCount': portfolio_data['summary'].get('shortCount', 0)
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


def extract_date_from_filename(filename):
    """
    Extract date from filename
    Supports formats:
    - portfolio_2025-01-15.csv
    - 2025-01-15.csv
    - statement_2025-01-15.csv
    """
    date_pattern = r'(\d{4}-\d{2}-\d{2})'
    match = re.search(date_pattern, filename)
    if match:
        date_str = match.group(1)
        # Validate date format
        try:
            datetime.strptime(date_str, '%Y-%m-%d')
            return date_str
        except ValueError:
            print(f"Invalid date format extracted: {date_str}")
            return None
    return None


def get_previous_day_value(trading_date):
    """Get previous trading day's portfolio value"""
    try:
        table = dynamodb.Table(PERFORMANCE_TABLE)
        
        # Convert date string to datetime for calculation
        date_obj = datetime.strptime(trading_date, '%Y-%m-%d')
        
        # Try previous days (skip weekends)
        for days_back in range(1, 8):
            prev_date = (date_obj - timedelta(days=days_back)).strftime('%Y-%m-%d')
            response = table.get_item(Key={'date': prev_date})
            
            if 'Item' in response:
                return response['Item'].get('totalValue', Decimal('0'))
        
        return None
    except Exception as e:
        print(f"Error getting previous day value: {str(e)}")
        return None


def calculate_daily_return(current_value, previous_value):
    """Calculate daily return percentage"""
    if not previous_value or previous_value == 0:
        return Decimal('0')
    
    return ((current_value - previous_value) / previous_value) * 100


def get_cumulative_return(trading_date, current_value):
    """Calculate cumulative return since inception (first record)"""
    try:
        table = dynamodb.Table(PERFORMANCE_TABLE)
        
        # Scan to find earliest date (excluding current date if it exists)
        response = table.scan()
        items = response.get('Items', [])
        
        # Filter out current date to avoid comparing to itself
        items = [item for item in items if item['date'] != trading_date]
        
        if not items:
            # First record - no cumulative return yet
            return Decimal('0')
        
        # Find earliest date
        earliest_item = min(items, key=lambda x: x['date'])
        initial_value = earliest_item.get('totalValue', current_value)
        
        if initial_value == 0 or initial_value is None:
            return Decimal('0')
        
        return ((current_value - initial_value) / initial_value) * 100
    except Exception as e:
        print(f"Error calculating cumulative return: {str(e)}")
        return Decimal('0')


def store_performance_data(trading_date, portfolio_data, snapshot_id):
    """Store performance snapshot in PerformanceHistory table"""
    try:
        table = dynamodb.Table(PERFORMANCE_TABLE)
        
        current_value = portfolio_data['summary']['totalValue']
        previous_value = get_previous_day_value(trading_date)
        daily_return = calculate_daily_return(current_value, previous_value) if previous_value else Decimal('0')
        cumulative_return = get_cumulative_return(trading_date, current_value)
        
        item = {
            'date': trading_date,
            'totalValue': convert_floats_to_decimals(current_value),
            'dailyReturn': convert_floats_to_decimals(daily_return),
            'cumulativeReturn': convert_floats_to_decimals(cumulative_return),
            'snapshotId': snapshot_id,
            'positionCount': portfolio_data['summary']['positionCount'],
            'timestamp': datetime.utcnow().isoformat()
        }
        
        # Replace if exists (duplicate date handling)
        table.put_item(Item=item)
        print(f"Stored performance data for {trading_date}: daily return = {daily_return}%, cumulative = {cumulative_return}%")
        
    except Exception as e:
        print(f"Error storing performance data: {str(e)}")
        # Don't fail the whole function if performance storage fails
        pass

def store_transactions(transactions):
    """Store individual transactions in Transactions table"""
    try:
        table_name = os.environ.get('TRANSACTIONS_TABLE', 'Transactions')
        table = dynamodb.Table(table_name)
        
        with table.batch_writer() as batch:
            for t in transactions:
                # Create a unique ID for the transaction if one doesn't exist
                # Use date + symbol + action + quantity to be reasonably unique
                # or just use a random ID if we want to be safe, but deterministic is better for idempotency
                
                # Format: Date#Timestamp or just Date for sorting
                date = t['date']
                symbol = t['symbol']
                action = t['action']
                qty = str(t['quantity'])
                price = str(t['price'])
                
                # Generate SK: Date#Action#Quantity (Simple deduplication key)
                # We add a hash to ensure uniqueness
                import hashlib
                raw_id = f"{date}_{symbol}_{action}_{qty}_{price}"
                tx_hash = hashlib.md5(raw_id.encode()).hexdigest()[:8]
                sort_key = f"{date}#{tx_hash}"
                
                item = {
                    'symbol': symbol,
                    'sk': sort_key, # GSI usually needed for querying by Key
                    'date': date,
                    'action': action,
                    'quantity': convert_floats_to_decimals(t['quantity']),
                    'price': convert_floats_to_decimals(t['price']),
                    'amount': convert_floats_to_decimals(t['amount']),
                    'description': t.get('description', ''),
                    'timestamp': datetime.utcnow().isoformat()
                }
                
                batch.put_item(Item=item)
                
        print(f"Stored {len(transactions)} transactions in {table_name}")
        
    except Exception as e:
        print(f"Error storing transactions: {str(e)}")
        # Don't fail the whole function
        pass


def get_previous_position_data(symbol, trading_date):
    """Get previous day's position data for a symbol"""
    try:
        table = dynamodb.Table(POSITION_PERFORMANCE_TABLE)
        
        # Query by symbol, get most recent date before trading_date
        response = table.query(
            KeyConditionExpression='symbol = :symbol',
            ExpressionAttributeValues={':symbol': symbol},
            ScanIndexForward=False  # Descending order
        )
        
        items = response.get('Items', [])
        # Filter to only dates before trading_date and sort
        previous_items = [item for item in items if item['date'] < trading_date]
        if previous_items:
            # Return most recent
            return max(previous_items, key=lambda x: x['date'])
        
        return None
    except Exception as e:
        print(f"Error getting previous position data for {symbol}: {str(e)}")
        return None


def store_position_performance_data(trading_date, holdings):
    """Store position-level performance data"""
    try:
        table = dynamodb.Table(POSITION_PERFORMANCE_TABLE)
        
        with table.batch_writer() as batch:
            for holding in holdings:
                symbol = holding['symbol']
                current_value = holding['marketValue']
                current_price = holding['price']
                
                # Get previous day's data
                prev_data = get_previous_position_data(symbol, trading_date)
                
                # Calculate daily return
                if prev_data and prev_data.get('price', 0) > 0:
                    prev_price = prev_data['price']
                    daily_return = ((current_price - prev_price) / prev_price) * 100
                else:
                    daily_return = Decimal('0')
                
                # Calculate cumulative return (since first held)
                # Try to find the first occurrence of this position
                if prev_data:
                    # Use previous cumulative return as base, or calculate from cost basis
                    prev_cumulative = prev_data.get('cumulativeReturn', Decimal('0'))
                    # If we have previous data, we can calculate based on price change
                    if prev_data.get('price', 0) > 0:
                        # Calculate from first cost basis
                        first_cost_basis = prev_data.get('costBasis', holding['costBasis'])
                        if first_cost_basis and first_cost_basis > 0:
                            cumulative_return = ((current_value - first_cost_basis) / first_cost_basis) * 100
                        else:
                            cumulative_return = holding.get('gainLossPercent', Decimal('0'))
                    else:
                        cumulative_return = holding.get('gainLossPercent', Decimal('0'))
                else:
                    # First time seeing this position - use gain/loss percent
                    cumulative_return = holding.get('gainLossPercent', Decimal('0'))
                
                item = {
                    'symbol': symbol,
                    'date': trading_date,
                    'quantity': convert_floats_to_decimals(holding['quantity']),
                    'price': convert_floats_to_decimals(holding['price']),
                    'marketValue': convert_floats_to_decimals(holding['marketValue']),
                    'costBasis': convert_floats_to_decimals(holding['costBasis']),
                    'gainLoss': convert_floats_to_decimals(holding['gainLoss']),
                    'gainLossPercent': convert_floats_to_decimals(holding['gainLossPercent']),
                    'dailyReturn': convert_floats_to_decimals(daily_return),
                    'cumulativeReturn': convert_floats_to_decimals(cumulative_return),
                    'timestamp': datetime.utcnow().isoformat()
                }
                
                batch.put_item(Item=item)
        
        print(f"Stored position performance data for {len(holdings)} positions")
        
    except Exception as e:
        print(f"Error storing position performance data: {str(e)}")
        # Don't fail the whole function if position performance storage fails
        pass


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


def is_transactions_csv(csv_content):
    """Check if CSV content looks like a transactions export"""
    first_lines = csv_content.strip().split('\n')[:5]
    for line in first_lines:
        if '"Action"' in line and '"Date"' in line:
            return True
        if 'Action' in line and 'Date' in line and 'Symbol' in line:
            return True
    return False


def parse_schwab_transactions_csv(csv_content):
    """
    Parse Schwab Transactions CSV
    Expected format: "Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"
    """
    lines = csv_content.strip().split('\n')
    header_index = -1
    for i, line in enumerate(lines):
        if '"Date"' in line and '"Action"' in line and '"Symbol"' in line:
            header_index = i
            break
            
    if header_index == -1:
         # Try without quotes
        for i, line in enumerate(lines):
            if 'Date' in line and 'Action' in line and 'Symbol' in line:
                header_index = i
                break
                
    if header_index == -1:
        raise ValueError("Could not find Transactions header row")

    csv_data = '\n'.join(lines[header_index:])
    reader = csv.DictReader(StringIO(csv_data))
    
    transactions = []
    
    for row in reader:
        try:
            date_str = row.get('Date', '').split(' as of')[0].strip() # Handle "12/23/2025 as of ..."
            try:
                date = datetime.strptime(date_str, '%m/%d/%Y').strftime('%Y-%m-%d')
            except ValueError:
                print(f"Skipping invalid date: {date_str}")
                continue

            action = row.get('Action', '').strip()
            symbol = row.get('Symbol', '').strip()
            qty_str = row.get('Quantity', '0')
            description = row.get('Description', '').strip()
            price_str = row.get('Price', '0')
            amount_str = row.get('Amount', '0')
            
            # Skip empty or summary rows
            if not date or action == '':
                continue
                
            qty = parse_number(qty_str)
            price = parse_number(price_str)
            amount = parse_number(amount_str) # Net amount (includes fees)
            
            transactions.append({
                'date': date,
                'action': action,
                'symbol': symbol,
                'description': description,
                'quantity': qty,
                'price': price,
                'amount': amount,
                'type': 'transaction'
            })
        except Exception as e:
            print(f"Error parsing transaction row: {row} - {e}")
            continue
            
    # Sort by date ascending
    transactions.sort(key=lambda x: x['date'])
    return transactions


def get_current_portfolio_state():
    """Get current holdings and cash from DynamoDB"""
    try:
        # Get latest snapshot
        table = dynamodb.Table(PORTFOLIO_TABLE)
        response = table.scan() # Inefficient but works for now, needs GSI
        items = response.get('Items', [])
        if not items:
            return None, None
            
        latest_snapshot = max(items, key=lambda x: x['timestamp'])
        snapshot_id = latest_snapshot['snapshotId']
        
        # Get holdings for snapshot
        holdings_table = dynamodb.Table(HOLDINGS_TABLE) # Need to filter by snapshotId
        # Since we don't have GSI yet, we scan and filter (inefficient!)
        # TODO: Use GSI
        resp = holdings_table.scan()
        all_holdings = resp.get('Items', [])
        current_holdings = [h for h in all_holdings if h.get('snapshotId') == snapshot_id]
        
        # Convert list to dict: symbol -> quantity
        holdings_map = {}
        for h in current_holdings:
            holdings_map[h['symbol']] = Decimal(str(h['quantity']))
            
        # Get cash from asset allocation
        cash = Decimal('0')
        aa = latest_snapshot.get('assetAllocation', {})
        if 'Cash' in aa:
            cash = Decimal(str(aa['Cash']))
            
        return holdings_map, cash, snapshot_id
    except Exception as e:
        print(f"Error getting portfolio state: {e}")
        return {}, Decimal('0'), None


def get_historical_prices(symbol):
    """
    Fetch YTD historical prices for a symbol
    Returns dict: { 'YYYY-MM-DD': Decimal(price) }
    """
    try:
        # Check DynamoDB first
        table = dynamodb.Table(os.environ.get('MARKET_DATA_TABLE', 'MarketPriceHistory'))
        response = table.query(
            KeyConditionExpression='symbol = :symbol',
            ExpressionAttributeValues={':symbol': symbol}
        )
        items = response.get('Items', [])
        
        prices = {}
        for item in items:
            date_str = item.get('date')
            price = item.get('close') or item.get('price')
            if date_str and price:
                prices[date_str] = Decimal(str(price))
                
        # If we have recent data, return it
        if prices:
             # Logic to check if we have enough data (e.g. YTD)
             # For now, just return what we have.
             # If missing, we might want to fallback to API.
             return prices
             
        # Fallback to Yahoo Finance (simplified)
        # Note: In production, consider using a dedicated market data lambda or service
        print(f"Fetching history for {symbol} from external source...")
        try:
            import requests
            import time
            
            # Yahoo Finance "Chart" API
            # period1 = start of year (approx timestamp)
            # period2 = now
            current_yr = datetime.utcnow().year
            start_ts = int(datetime(current_yr, 1, 1).timestamp())
            end_ts = int(datetime.utcnow().timestamp())
            
            url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
            params = {
                'period1': start_ts,
                'period2': end_ts,
                'interval': '1d'
            }
            
            headers = {'User-Agent': 'Mozilla/5.0'}
            resp = requests.get(url, params=params, headers=headers, timeout=5)
            data = resp.json()
            
            if 'chart' in data and 'result' in data['chart']:
                res = data['chart']['result'][0]
                timestamps = res['timestamp']
                quotes = res['indicators']['quote'][0]['close']
                
                for i, ts in enumerate(timestamps):
                    if quotes[i] is not None:
                        d = datetime.fromtimestamp(ts).strftime('%Y-%m-%d')
                        prices[d] = Decimal(str(quotes[i]))
                        
                # Cache to DynamoDB (batch write later?)
        except Exception as e:
            print(f"Error fetching from Yahoo: {e}")
            
        return prices
    except Exception as e:
        print(f"Error fetching history for {symbol}: {e}")
        return {}

def process_transaction_history(transactions):
    """
    Reconstruct portfolio history from transactions
    Backwards reconstruction approach:
    1. Start with Current Holdings (Today)
    2. Iterate backwards through transactions
    3. Calculate daily value and store
    """
    print(f"Processing {len(transactions)} transactions for history reconstruction")
    
    # 1. Get Current State
    current_holdings, current_cash, snapshot_id = get_current_portfolio_state()
    if snapshot_id is None:
        print("No current portfolio snapshot found. Cannot reconstruct history.")
        return False
        
    print(f"Starting reconstruction from snapshot {snapshot_id}")
    print(f"Current Cash: ${current_cash}")
    print(f"Current Holdings: {len(current_holdings)} symbols")
    
    # 2. Identify all symbols needed
    all_symbols = set(current_holdings.keys())
    for t in transactions:
        all_symbols.add(t['symbol'])
        
    print(f"Fetching price history for {len(all_symbols)} symbols...")
    price_cache = {}
    for sym in all_symbols:
        price_cache[sym] = get_historical_prices(sym)
        
    # Helper to get price
    def get_price(sym, date):
        if sym in price_cache and date in price_cache[sym]:
            return price_cache[sym][date]
        return Decimal('0') # Default to 0? Or previous close?
    
    # Group transactions by date
    trans_by_date = {}
    for t in transactions:
        d = t['date']
        if d not in trans_by_date:
            trans_by_date[d] = []
        trans_by_date[d].append(t)
        
    # Get all dates from earliest transaction to today
    sorted_dates = sorted(trans_by_date.keys())
    if not sorted_dates:
        return False
        
    start_date = sorted_dates[0]
    end_date = datetime.utcnow().strftime('%Y-%m-%d')
    
    # Iterate BACKWARDS from today to start_date
    current_date = datetime.strptime(end_date, '%Y-%m-%d')
    target_date = datetime.strptime(start_date, '%Y-%m-%d')
    
    # Simulation state (starting at TODAY)
    sim_holdings = current_holdings.copy()
    sim_cash = current_cash
    
    # Pass 1: Reconstruct Positions (Backward)
    history_map = {} # { date: { holdings: {}, cash: val } }
    
    print("Pass 1: Reconstructing positions backwards...")
    while current_date >= target_date:
        date_str = current_date.strftime('%Y-%m-%d')
        
        # Save state for this day (representing End of Day)
        history_map[date_str] = {
            'holdings': sim_holdings.copy(),
            'cash': sim_cash
        }
        
        # Reverse Transactions to get PREVIOUS day's end state
        if date_str in trans_by_date:
            day_trans = trans_by_date[date_str]
            for t in day_trans:
                action = t['action'].lower()
                qty = Decimal(str(t['quantity']))
                amt = Decimal(str(t['amount']))
                sym = t['symbol']
                
                if 'buy' in action:
                    sim_holdings[sym] = sim_holdings.get(sym, Decimal('0')) - qty
                    sim_cash += amt 
                elif 'sell' in action:
                    sim_holdings[sym] = sim_holdings.get(sym, Decimal('0')) + qty
                    sim_cash -= amt
                elif 'div' in action or 'interest' in action:
                    sim_cash -= amt
                elif 'deposit' in action:
                    sim_cash -= amt
                elif 'withdrawal' in action:
                    sim_cash += abs(amt)
                    
        current_date -= timedelta(days=1)
        
    print(f"Reconstructed history for {len(history_map)} days.")
    
    # Pass 2: Calculate Performance (Forward)
    print("Pass 2: Calculating performance forward...")
    forward_dates = sorted(history_map.keys())
    
    prev_total_value = None
    
    for date_str in forward_dates:
        state = history_map[date_str]
        daily_cash = state['cash']
        daily_holdings_map = state['holdings']
        
        daily_equity = daily_cash
        daily_positions = []
        
        for symbol, qty in daily_holdings_map.items():
            if qty != 0:
                price = get_price(symbol, date_str)
                mkt_val = qty * price
                daily_equity += mkt_val
                
                # We need extensive fields for the standard store function or custom logic?
                # The 'store_position_performance_data' function calculates returns.
                # So we just pass the basic data
                daily_positions.append({
                    'symbol': symbol,
                    'quantity': qty,
                    'price': price,
                    'marketValue': mkt_val,
                    'description': '', # Optional
                    'costBasis': Decimal('0'), # Hard to reconstruct without FIFO/LIFO logic
                    'gainLoss': Decimal('0'),
                    'gainLossPercent': Decimal('0')
                })
        
        # Determine Snapshot ID (use recon + date)
        recon_id = f"recon_{date_str}"
        
        # Store Daily Performance (Portfolio Level)
        # Check prev value for simplistic return calc (optional, as store_performance_data does it too)
        store_performance_data(date_str, {
            'summary': {
                'totalValue': daily_equity,
                'positionCount': len(daily_positions)
            }
        }, recon_id)
        
        # Store Position Performance (Security Level)
        if daily_positions:
             store_position_performance_data(date_str, daily_positions)
        
    return True


