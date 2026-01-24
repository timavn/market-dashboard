#!/usr/bin/env python3
"""
Parse Hedgeye Momo Tracker PDF using AWS Textract
Extracts tech stock momentum data from page 4 (table rendered as image)
"""

import re
import boto3
import io
import PyPDF2
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from date_utils import extract_date_from_pdf


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


def upload_pdf_to_s3(pdf_path, pdf_date=None):
    """Upload original PDF to S3 for audit trail"""
    print("\n☁️  Uploading PDF to S3...")

    s3 = boto3.client('s3', region_name='us-west-1')
    date = pdf_date if pdf_date else datetime.now(timezone.utc).strftime('%Y-%m-%d')
    time = datetime.now(timezone.utc).strftime('%H%M%S')

    s3_key = f"hedgeye-pdfs/{date}/momo-tracker-{date}-{time}.pdf"

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
        from pdf2image import convert_from_path
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
        
        s3_key = f"hedgeye-screenshots/{date}/momo-tracker-{date}-{time}.png"
        
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


def extract_momo_tracker(pdf_path, s3_key=None):
    """Extract stock data from Momo Tracker PDF using AWS Textract"""
    print(f"\n📄 Reading Momo Tracker PDF: {pdf_path}")

    data = {}
    ts = datetime.now(timezone.utc).isoformat()

    # Initialize Textract client
    textract = boto3.client('textract', region_name='us-west-1')

    # Extract only page 4 (Momo Tracker table)
    print("   📑 Extracting page 4 from PDF...")
    pdf_subset = extract_specific_pages_as_pdf(pdf_path, [4])

    print("   🔍 Using AWS Textract to extract table data...")
    response = textract.analyze_document(
        Document={'Bytes': pdf_subset},
        FeatureTypes=['TABLES']
    )

    # Parse Textract response
    blocks = response['Blocks']

    # Find all tables in the document
    tables = [block for block in blocks if block['BlockType'] == 'TABLE']

    print(f"   Found {len(tables)} tables in PDF")

    # Sort tables by vertical position (Top) to ensure we process them in visual order
    # Textract main return blocks in arbitrary order, which messes up our indexing
    if tables:
        tables.sort(key=lambda x: x['Geometry']['BoundingBox']['Top'])
        print("   ✅ Sorted tables by vertical position")

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

    # Process each table to find Momo Tracker table
    global_index = 0

    for table in tables:
        table_data = get_table_data(table, blocks)

        if not table_data or len(table_data) < 2:
            continue

        # Detect Momo Tracker table by structure (look for Buy/Sell Trade columns)
        # Or checking if row contains typical tickers (but not strictly limiting to them)
        is_momo_table = False
        
        # Heuristic: check if header has "Buy Trade" or similar, or check first few rows
        # The Momo table usually has: Ticker, Buy Trade, Sell Trade, Upside, Downside, Trend
        for row in table_data:
             if len(row) > 1:
                  if 'BUY TRADE' in str(row).upper() and 'SELL TRADE' in str(row).upper():
                       is_momo_table = True
                       break

        # Fallback: Check if first col is a known ticker
        if not is_momo_table:
            for row in table_data[1:]:
                if len(row) > 0:
                     first_cell = row[0].strip().upper()
                     if first_cell in ['MSFT', 'AAPL', 'AMZN', 'NVDA', 'TSLA']:
                          is_momo_table = True
                          break

        # Parse Momo Tracker table
        if is_momo_table:
            print("   📊 Found Momo Tracker table")
            for row in table_data[1:]:
                if len(row) >= 6:
                    try:
                        ticker = row[0].strip().upper()
                        # Skip headers
                        if ticker == 'TICKER' or ticker == 'SYMBOL' or not ticker:
                            continue

                        # Clean numbers
                        buy_str = row[1].replace(',', '').replace('$', '').strip()
                        sell_str = row[2].replace(',', '').replace('$', '').strip()
                        
                        if not buy_str or not sell_str:
                            continue

                        buy_trade = float(buy_str)
                        sell_trade = float(sell_str)
                        upside_val = row[3].replace('%', '').strip()
                        downside_val = row[4].replace('%', '').strip()
                        
                        upside = float(upside_val) if upside_val else 0.0
                        downside = float(downside_val) if downside_val else 0.0
                        
                        trend = row[5].strip().upper()

                        data[ticker] = {
                            'buyTrade': buy_trade,
                            'sellTrade': sell_trade,
                            'upside': upside,
                            'downside': downside,
                            'trend': trend,
                            'timestamp': ts,
                            'index': global_index
                        }
                        global_index += 1
                        print(f"      [{global_index}] {ticker}: Buy ${buy_trade:.0f}, Sell ${sell_trade:.0f} (↑{upside}% ↓{downside}%, {trend})")
                    except (ValueError, IndexError) as e:
                        # print(f"      ⚠️  Skipping row: {row} (error: {e})")
                        pass

    print(f"\n   ✅ Extracted {len(data)} stocks")
    return data


def save_to_dynamodb(data, pdf_s3_key=None, pdf_date=None, screenshot_s3_key=None):
    """Save Momo Tracker data to DynamoDB"""
    if not data:
        print("\n❌ No data to save")
        return

    import boto3
    
    if not pdf_date:
        print("❌ valid pdf_date is required to save to DynamoDB")
        return

    print(f"\n💾 Saving {len(data)} records to DynamoDB...")
    db = boto3.resource('dynamodb', region_name='us-west-1')
    date = pdf_date
    ts = datetime.now(timezone.utc).isoformat()

    # Save to HedgeyeDailySnapshot
    snap_table = db.Table('HedgeyeDailySnapshot')
    snapshot_item = {
        'date': date,
        'snapshotType': 'momo-tracker',
        'stockCount': len(data),
        'data': {t: {
            'buyTrade': Decimal(str(d['buyTrade'])),
            'sellTrade': Decimal(str(d['sellTrade'])),
            'upside': Decimal(str(d['upside'])),
            'downside': Decimal(str(d['downside'])),
            'trend': d['trend'],
            'timestamp': d['timestamp'],
            'index': d.get('index', 999)
        } for t, d in data.items()},
        'scrapedAt': ts,
        'source': 'textract',
        'ttl': int(datetime.now(timezone.utc).timestamp() + (730 * 24 * 60 * 60))
    }

    if pdf_s3_key:
        snapshot_item['pdfSource'] = pdf_s3_key
    if screenshot_s3_key:
        snapshot_item['screenshotS3Key'] = screenshot_s3_key

    snap_table.put_item(Item=snapshot_item)
    print(f"   ✅ Saved {len(data)} stocks")
    print("\n🎉 SUCCESS! Momo Tracker data saved.\n")


if __name__ == '__main__':
    import sys
    from pathlib import Path
    from date_utils import extract_date_from_pdf

    if len(sys.argv) < 2:
        print("Usage: python3 parse_momo_tracker.py <path_to_pdf>")
        sys.exit(1)

    pdf_path = Path(sys.argv[1])
    if not pdf_path.exists():
        print(f"❌ File not found: {pdf_path}")
        sys.exit(1)

    print("\n" + "="*70)
    print("🚀 MOMO TRACKER PARSER (AWS Textract)")
    print("="*70)

    pdf_date = extract_date_from_pdf(pdf_path)
    print(f"📅 PDF Date: {pdf_date}\n")

    data = extract_momo_tracker(pdf_path)

    if data:
        # Upload files
        pdf_s3_key = upload_pdf_to_s3(pdf_path, pdf_date)
        screenshot_s3_key = generate_screenshot(pdf_path, pdf_date)
        
        save_to_dynamodb(data, pdf_s3_key, pdf_date, screenshot_s3_key)
    else:
        print("\n❌ No data extracted from PDF")
