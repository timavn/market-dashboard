#!/usr/bin/env python3
"""
Parse Hedgeye Bitcoin Trend Tracker PDF using AWS Textract
Extracts crypto trading data from pages 3 and 10 (tables rendered as images)
"""

import re
import boto3
import io
import PyPDF2
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from date_utils import extract_date_from_pdf
from boto3.dynamodb.conditions import Key

try:
    from pdf2image import convert_from_path
    HAS_PDF2IMAGE = True
except ImportError:
    HAS_PDF2IMAGE = False


def extract_specific_pages_as_pdf(pdf_path, page_numbers):
    """Extract specific pages from PDF and return as bytes"""
    pdf_bytes = io.BytesIO()

    with open(pdf_path, 'rb') as file:
        pdf_reader = PyPDF2.PdfReader(file)
        pdf_writer = PyPDF2.PdfWriter()

        for page_num in page_numbers:
            if page_num - 1 < len(pdf_reader.pages):
                pdf_writer.add_page(pdf_reader.pages[page_num - 1])

        pdf_writer.write(pdf_bytes)

    return pdf_bytes.getvalue()


def convert_page_to_image_bytes(pdf_path, page_number):
    """Convert a specific PDF page to PNG bytes for Textract"""
    if not HAS_PDF2IMAGE:
        print("   ⚠️ pdf2image not installed, cannot convert to image")
        return None

    try:
        images = convert_from_path(pdf_path, first_page=page_number, last_page=page_number, dpi=200)
        if images:
            img_bytes = io.BytesIO()
            images[0].save(img_bytes, format='PNG')
            return img_bytes.getvalue()
    except Exception as e:
        print(f"   ⚠️ Error converting page {page_number} to image: {e}")

    return None



# Expected columns count for validation
# Crypto: Symbol, Price, Buy, Sell, Trend (5)
# Stock: Ticker, Price, Buy, Sell, Upside, Downside, Trend (7)


def _typed_tracker_fields(*, trend, buy_trade, sell_trade):
    """Return the canonical tracker fields, or ``None`` for an invalid row.

    The published trend is the only directional field.  In particular,
    ``sellTrade`` and ``downside`` are range/metric columns, not bearish
    signals.  Keeping this validation in the PDF parser prevents malformed
    rows from becoming executable-looking research events downstream.
    """
    normalized_trend = str(trend or "").strip().upper()
    if normalized_trend not in {"BULLISH", "BEARISH", "NEUTRAL"}:
        return None
    try:
        lrr = float(buy_trade)
        hrr = float(sell_trade)
    except (TypeError, ValueError):
        return None
    if not (lrr > 0 and hrr > 0 and lrr < hrr):
        return None
    return {
        "trade": normalized_trend,
        "lrr": lrr,
        "hrr": hrr,
        "trackerRange": {"lrr": lrr, "hrr": hrr},
    }


def upload_pdf_to_s3(pdf_path, pdf_date=None):
    """Upload original PDF to S3 for audit trail"""
    print("\n☁️  Uploading PDF to S3...")

    s3 = boto3.client('s3', region_name='us-west-1')
    date = pdf_date if pdf_date else datetime.now(timezone.utc).strftime('%Y-%m-%d')
    time = datetime.now(timezone.utc).strftime('%H%M%S')

    s3_key = f"hedgeye-pdfs/{date}/bitcoin-tracker-{date}-{time}.pdf"

    try:
        s3.upload_file(
            str(pdf_path),
            'market-dashboard-csv-data',
            s3_key,
            ExtraArgs={'ContentType': 'application/pdf'}
        )
        print(f"   ✅ PDF uploaded: {s3_key}")
        return s3_key
    except Exception as e:
        print(f"   ⚠️  Upload failed: {e}")
        return None


def generate_screenshot(pdf_path, pdf_date=None):
    """Generate screenshot from first page of PDF and upload to S3"""
    print("\n📸 Generating screenshot from PDF...")
    
    try:
        # Convert first page to image
        images = convert_from_path(str(pdf_path), first_page=1, last_page=1)
        if not images:
            print("   ❌ Failed to convert PDF to image")
            return None
            
        # Save to bytes
        img_bytes = io.BytesIO()
        images[0].save(img_bytes, format='PNG')
        img_bytes.seek(0)
        
        # Upload to S3
        s3 = boto3.client('s3', region_name='us-west-1')
        date = pdf_date if pdf_date else datetime.now(timezone.utc).strftime('%Y-%m-%d')
        time = datetime.now(timezone.utc).strftime('%H%M%S')
        
        s3_key = f"hedgeye-screenshots/{date}/bitcoin-tracker-{date}-{time}.png"
        
        s3.upload_fileobj(
            img_bytes,
            'market-dashboard-csv-data',
            s3_key,
            ExtraArgs={'ContentType': 'image/png'}
        )
        print(f"   ✅ Screenshot uploaded: {s3_key}")
        return s3_key
        
    except Exception as e:
        print(f"   ⚠️  Screenshot generation failed: {e}")
        return None


def extract_bitcoin_tracker(pdf_path, s3_key=None):
    """Extract crypto data from Bitcoin Trend Tracker PDF using AWS Textract"""
    print(f"\n📄 Reading Bitcoin Tracker PDF: {pdf_path}")

    data = {
        'cryptos': {},
        'stocks': {}
    }
    ts = datetime.now(timezone.utc).isoformat()

    # Initialize Textract client
    textract = boto3.client('textract', region_name='us-west-1')

    # Extract pages 3 and 10 (crypto and stock tables) as images
    pages_to_extract = [3, 10]
    all_tables = []

    for page_num in pages_to_extract:
        print(f"   📑 Converting page {page_num} to image...")
        page_bytes = convert_page_to_image_bytes(pdf_path, page_num)

        if not page_bytes:
            print(f"   ⚠️ Could not convert page {page_num}")
            continue

        print(f"   🔍 Using AWS Textract to extract table data from page {page_num}...")
        try:
            response = textract.analyze_document(
                Document={'Bytes': page_bytes},
                FeatureTypes=['TABLES']
            )

            # Parse Textract response
            blocks = response['Blocks']
            tables = [block for block in blocks if block['BlockType'] == 'TABLE']
            print(f"   Found {len(tables)} tables on page {page_num}")

            # Sort tables by vertical position (Top) to ensure correct order within the page
            if tables:
                tables.sort(key=lambda x: x['Geometry']['BoundingBox']['Top'])

            # Store tables with their blocks for processing
            for table in tables:
                all_tables.append({'table': table, 'blocks': blocks, 'page': page_num})
        except Exception as e:
            print(f"   ⚠️ Textract error on page {page_num}: {e}")
            continue

    tables = all_tables
    print(f"   Found {len(tables)} tables total")

    # Helper function to extract table data
    def get_table_data(table_block, blocks):
        """Extract rows and cells from a table block"""
        rows = []
        cells_by_row = {}

        # Get all cells in this table
        if 'Relationships' not in table_block:
            return rows

        for relationship in table_block['Relationships']:
            if relationship['Type'] == 'CHILD':
                for cell_id in relationship['Ids']:
                    cell_block = next((b for b in blocks if b['Id'] == cell_id), None)
                    if cell_block and cell_block['BlockType'] == 'CELL':
                        row_idx = cell_block['RowIndex']
                        col_idx = cell_block['ColumnIndex']

                        # Get cell text
                        cell_text = ''
                        if 'Relationships' in cell_block:
                            for rel in cell_block['Relationships']:
                                if rel['Type'] == 'CHILD':
                                    for word_id in rel['Ids']:
                                        word_block = next((b for b in blocks if b['Id'] == word_id), None)
                                        if word_block and word_block['BlockType'] == 'WORD':
                                            cell_text += word_block['Text'] + ' '

                        cell_text = cell_text.strip()

                        if row_idx not in cells_by_row:
                            cells_by_row[row_idx] = {}
                        cells_by_row[row_idx][col_idx] = cell_text

        # Convert to list of rows
        for row_idx in sorted(cells_by_row.keys()):
            row = []
            for col_idx in sorted(cells_by_row[row_idx].keys()):
                row.append(cells_by_row[row_idx][col_idx])
            rows.append(row)

        return rows

    # Global index counter to preserve PDF order across tables
    global_index = 0

    # Process each table to find crypto and stock tables
    for table_info in all_tables:
        table_data = get_table_data(table_info['table'], table_info['blocks'])

        if not table_data or len(table_data) < 2:
            continue

        # Check if this is the crypto table (has BTC, ETH, SOL, etc.)
        header = [cell.upper() for cell in table_data[0]]

        # Detect crypto table by presence of crypto symbols
        is_crypto_table = False
        is_stock_table = False

        for row in table_data[1:]:
            if len(row) > 0:
                first_cell = row[0].upper()
                if first_cell in ['BTC', 'ETH', 'SOL', 'AVAX', 'XRP', 'ZEC']:
                    is_crypto_table = True
                    break
                elif first_cell in ['IBIT', 'MSTR', 'MARA', 'ETHA', 'BLOK', 'COIN', 'CRCL', 'BMNR']:
                    is_stock_table = True
                    break

        # Parse crypto table
        if is_crypto_table:
            print("   📊 Found crypto table")
            for row in table_data[1:]:
                # Check for valid data row (must have proper numeric price/trades)
                if len(row) >= 5:
                    try:
                        symbol = row[0].strip().upper()
                        # Skip header repeats or empty rows
                        if symbol == 'SYMBOL' or symbol == 'TICKER' or not symbol:
                            continue

                        # Clean currency strings
                        price_str = row[1].replace(',', '').replace('$', '').strip()
                        buy_str = row[2].replace(',', '').replace('$', '').strip()
                        sell_str = row[3].replace(',', '').replace('$', '').strip()
                        
                        # Validate they are numbers
                        if not price_str or not buy_str or not sell_str:
                            continue
                            
                        price = float(price_str)
                        buy_trade = float(buy_str)
                        sell_trade = float(sell_str)
                        trend = row[4].strip().upper()
                        typed = _typed_tracker_fields(
                            trend=trend,
                            buy_trade=buy_trade,
                            sell_trade=sell_trade,
                        )
                        if typed is None:
                            continue

                        data['cryptos'][symbol] = {
                            'price': price,
                            'buyTrade': buy_trade,
                            'sellTrade': sell_trade,
                            'trend': trend,
                            **typed,
                            'timestamp': ts,
                            'index': global_index
                        }
                        global_index += 1
                        print(f"      [{global_index}] {symbol}: ${price:,.0f} (Buy: ${buy_trade:,.0f}, Sell: ${sell_trade:,.0f}, {trend})")
                    except (ValueError, IndexError) as e:
                        # print(f"      ⚠️  Skipping row: {row} (error: {e})")
                        pass

        # Parse stock table
        elif is_stock_table:
            print("   📊 Found stock table")
            for row in table_data[1:]:
                if len(row) >= 7:
                    try:
                        ticker = row[0].strip().upper()
                         # Skip header repeats
                        if ticker == 'TICKER' or ticker == 'SYMBOL' or not ticker:
                            continue

                        # Clean numbers
                        price_str = row[1].replace(',', '').replace('$', '').strip()
                        buy_str = row[2].replace(',', '').replace('$', '').strip()
                        sell_str = row[3].replace(',', '').replace('$', '').strip()
                        
                        if not price_str or not buy_str or not sell_str:
                            continue

                        price = float(price_str)
                        buy_trade = float(buy_str)
                        sell_trade = float(sell_str)
                        upside = float(row[4].replace('%', '').strip())
                        downside = float(row[5].replace('%', '').strip())
                        trend = row[6].strip().upper()
                        typed = _typed_tracker_fields(
                            trend=trend,
                            buy_trade=buy_trade,
                            sell_trade=sell_trade,
                        )
                        if typed is None:
                            continue

                        data['stocks'][ticker] = {
                            'price': price,
                            'buyTrade': buy_trade,
                            'sellTrade': sell_trade,
                            'upside': upside,
                            'downside': downside,
                            'trend': trend,
                            **typed,
                            'timestamp': ts,
                            'index': global_index
                        }
                        global_index += 1
                        print(f"      [{global_index}] {ticker}: ${price:.2f} (↑{upside}% ↓{downside}%, {trend})")
                    except (ValueError, IndexError) as e:
                        # print(f"      ⚠️  Skipping row: {row} (error: {e})")
                        pass

    print(f"\n   ✅ Extracted {len(data['cryptos'])} cryptos and {len(data['stocks'])} stocks")
    return data


def get_previous_trends(db, current_date):
    """Query DynamoDB for the most recent snapshot before current_date to get previous trends"""
    try:
        from datetime import datetime as dt, timedelta
        snap_table = db.Table('HedgeyeDailySnapshot')
        
        # Parse current date and iterate backwards to find previous snapshot
        current_dt = dt.strptime(current_date, '%Y-%m-%d')
        
        # Check up to 30 previous days for a snapshot
        for i in range(1, 31):
            prev_dt = current_dt - timedelta(days=i)
            prev_date_str = prev_dt.strftime('%Y-%m-%d')
            
            # Use get_item since date is partition key, snapshotType is sort key
            response = snap_table.get_item(
                Key={
                    'date': prev_date_str,
                    'snapshotType': 'bitcoin-trend-tracker'
                }
            )
            
            if response.get('Item'):
                prev_snapshot = response['Item']
                prev_data = prev_snapshot.get('data', {})
                prev_date = prev_snapshot.get('date', prev_date_str)
                
                # Extract trends for cryptos and stocks
                crypto_trends = {k: str(v.get('trend', 'N/A')) for k, v in prev_data.get('cryptos', {}).items()}
                stock_trends = {k: str(v.get('trend', 'N/A')) for k, v in prev_data.get('stocks', {}).items()}
                
                print(f"   📊 Found previous snapshot from {prev_date}")
                return prev_date, crypto_trends, stock_trends
        
        print("   ℹ️  No previous snapshot found within last 30 days")
        return None, {}, {}
            
    except Exception as e:
        print(f"   ⚠️  Error querying previous snapshot: {e}")
        return None, {}, {}


def detect_trend_changes(current_data, prev_crypto_trends, prev_stock_trends):
    """Compare current trends vs previous trends and return changes"""
    crypto_changes = []
    etf_changes = []
    
    # Check crypto trend changes (BTC, ETH, SOL, AVAX, XRP)
    for ticker, info in current_data.get('cryptos', {}).items():
        current_trend = info.get('trend', 'N/A')
        old_trend = prev_crypto_trends.get(ticker, 'N/A')
        
        if old_trend != 'N/A' and current_trend != old_trend:
            crypto_changes.append({
                'ticker': ticker,
                'oldTrend': old_trend,
                'newTrend': current_trend
            })
            print(f"   🔄 {ticker}: {old_trend} → {current_trend}")
    
    # Check stock/ETF trend changes (IBIT, MSTR, MARA, ETHA, BLOK, COIN, CRCL, BMNR)
    for ticker, info in current_data.get('stocks', {}).items():
        current_trend = info.get('trend', 'N/A')
        old_trend = prev_stock_trends.get(ticker, 'N/A')
        
        if old_trend != 'N/A' and current_trend != old_trend:
            etf_changes.append({
                'ticker': ticker,
                'oldTrend': old_trend,
                'newTrend': current_trend
            })
            print(f"   🔄 {ticker}: {old_trend} → {current_trend}")
    
    return crypto_changes, etf_changes


def save_to_dynamodb(data, pdf_s3_key=None, pdf_date=None, screenshot_s3_key=None):
    """Save Bitcoin Tracker data to DynamoDB"""
    if not data or (not data.get('cryptos') and not data.get('stocks')):
        print("\n❌ No data to save")
        return

    print(f"\n💾 Saving to DynamoDB...")
    db = boto3.resource('dynamodb', region_name='us-west-1')
    
    if not pdf_date:
        print("❌ valid pdf_date is required to save to DynamoDB")
        return
        
    date = pdf_date
    ts = datetime.now(timezone.utc).isoformat()

    # Get previous trends for change detection
    print("\n   🔍 Checking for trend changes...")
    prev_date, prev_crypto_trends, prev_stock_trends = get_previous_trends(db, date)
    
    # Detect trend changes
    crypto_trend_changes, etf_trend_changes = detect_trend_changes(data, prev_crypto_trends, prev_stock_trends)
    
    if crypto_trend_changes or etf_trend_changes:
        print(f"\n   📈 Found {len(crypto_trend_changes)} crypto and {len(etf_trend_changes)} ETF trend changes")
    else:
        print("   ℹ️  No trend changes detected")

    # Save to HedgeyeDailySnapshot
    snap_table = db.Table('HedgeyeDailySnapshot')
    snapshot_item = {
        'date': date,
        'snapshotType': 'bitcoin-trend-tracker',
        'cryptoCount': len(data.get('cryptos', {})),
        'stockCount': len(data.get('stocks', {})),
            'data': {
                'cryptos': {k: {
                'price': Decimal(str(v['price'])),
                'buyTrade': Decimal(str(v['buyTrade'])),
                'sellTrade': Decimal(str(v['sellTrade'])),
                'trend': v['trend'],
                'trade': v.get('trade', v['trend']),
                'lrr': Decimal(str(v.get('lrr', v['buyTrade']))),
                'hrr': Decimal(str(v.get('hrr', v['sellTrade']))),
                'trackerRange': {
                    'lrr': Decimal(str(v.get('lrr', v['buyTrade']))),
                    'hrr': Decimal(str(v.get('hrr', v['sellTrade']))),
                },
                'timestamp': v['timestamp']
            } for k, v in data.get('cryptos', {}).items()},
            'stocks': {k: {
                'price': Decimal(str(v['price'])),
                'buyTrade': Decimal(str(v['buyTrade'])),
                'sellTrade': Decimal(str(v['sellTrade'])),
                'upside': Decimal(str(v['upside'])),
                'downside': Decimal(str(v['downside'])),
                'trend': v['trend'],
                'trade': v.get('trade', v['trend']),
                'lrr': Decimal(str(v.get('lrr', v['buyTrade']))),
                'hrr': Decimal(str(v.get('hrr', v['sellTrade']))),
                'trackerRange': {
                    'lrr': Decimal(str(v.get('lrr', v['buyTrade']))),
                    'hrr': Decimal(str(v.get('hrr', v['sellTrade']))),
                },
                'timestamp': v['timestamp']
            } for k, v in data.get('stocks', {}).items()}
        },
        # Add trend changes for changelog
        'cryptoTrendChanges': crypto_trend_changes,
        'etfTrendChanges': etf_trend_changes,
        'previousDate': prev_date,
        'scrapedAt': ts,
        'source': 'textract',
        'ttl': int(datetime.now(timezone.utc).timestamp() + (730 * 24 * 60 * 60))
    }

    # Add index data to internal objects for frontend sorting
    for cat in ['cryptos', 'stocks']:
        for tick, val in snapshot_item['data'][cat].items():
             # Get original index
             orig_idx = data.get(cat, {}).get(tick, {}).get('index', 999)
             snapshot_item['data'][cat][tick]['index'] = orig_idx

    if pdf_s3_key:
        snapshot_item['pdfSource'] = pdf_s3_key
    if screenshot_s3_key:
        snapshot_item['screenshotS3Key'] = screenshot_s3_key

    snap_table.put_item(Item=snapshot_item)
    print(f"   ✅ Saved {len(data.get('cryptos', {}))} cryptos and {len(data.get('stocks', {}))} stocks")
    if crypto_trend_changes:
        print(f"   ✅ Saved {len(crypto_trend_changes)} crypto trend changes")
    if etf_trend_changes:
        print(f"   ✅ Saved {len(etf_trend_changes)} ETF trend changes")
    print("\n🎉 SUCCESS! Bitcoin Tracker data saved.\n")


if __name__ == '__main__':
    import sys

    if len(sys.argv) < 2:
        print("Usage: python3 parse_bitcoin_tracker.py <path_to_pdf>")
        sys.exit(1)

    pdf_path = Path(sys.argv[1])
    if not pdf_path.exists():
        print(f"❌ File not found: {pdf_path}")
        sys.exit(1)

    print("\n" + "="*70)
    print("🚀 BITCOIN TREND TRACKER PARSER (AWS Textract)")
    print("="*70)

    pdf_date = extract_date_from_pdf(pdf_path)
    print(f"📅 PDF Date: {pdf_date}\n")

    data = extract_bitcoin_tracker(pdf_path)

    if data and (data.get('cryptos') or data.get('stocks')):
        # Upload files
        pdf_s3_key = upload_pdf_to_s3(pdf_path, pdf_date)
        screenshot_s3_key = generate_screenshot(pdf_path, pdf_date)
        
        save_to_dynamodb(data, pdf_s3_key, pdf_date, screenshot_s3_key)
    else:
        print("\n❌ No data extracted from PDF")
