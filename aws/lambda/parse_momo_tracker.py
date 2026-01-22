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

    # Expected Momo Tracker stocks
    EXPECTED_TICKERS = ['MSFT', 'AAPL', 'AMZN', 'META', 'GOOGL', 'NFLX', 'TSLA', 'NVDA', 'ORCL']

    # Process each table to find Momo Tracker table
    for table in tables:
        table_data = get_table_data(table, blocks)

        if not table_data or len(table_data) < 2:
            continue

        # Detect Momo Tracker table by presence of expected tickers
        is_momo_table = False
        for row in table_data[1:]:
            if len(row) > 0:
                first_cell = row[0].strip().upper()
                if first_cell in EXPECTED_TICKERS:
                    is_momo_table = True
                    break

        # Parse Momo Tracker table
        if is_momo_table:
            print("   📊 Found Momo Tracker table")
            for row in table_data[1:]:
                if len(row) >= 6:
                    try:
                        ticker = row[0].strip().upper()
                        if ticker in EXPECTED_TICKERS:
                            buy_trade = float(row[1].replace(',', '').replace('$', ''))
                            sell_trade = float(row[2].replace(',', '').replace('$', ''))
                            upside = float(row[3].replace('%', ''))
                            downside = float(row[4].replace('%', ''))
                            trend = row[5].strip().upper()

                            data[ticker] = {
                                'buyTrade': buy_trade,
                                'sellTrade': sell_trade,
                                'upside': upside,
                                'downside': downside,
                                'trend': trend,
                                'timestamp': ts
                            }
                            print(f"      {ticker}: Buy ${buy_trade:.0f}, Sell ${sell_trade:.0f} (↑{upside}% ↓{downside}%, {trend})")
                    except (ValueError, IndexError) as e:
                        print(f"      ⚠️  Skipping row: {row} (error: {e})")

    print(f"\n   ✅ Extracted {len(data)} stocks")
    return data


def save_to_dynamodb(data, pdf_s3_key=None, pdf_date=None):
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
            'timestamp': d['timestamp']
        } for t, d in data.items()},
        'scrapedAt': ts,
        'source': 'textract',
        'ttl': int(datetime.now(timezone.utc).timestamp() + (730 * 24 * 60 * 60))
    }

    if pdf_s3_key:
        snapshot_item['pdfSource'] = pdf_s3_key

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
        save_to_dynamodb(data, pdf_date=pdf_date)
    else:
        print("\n❌ No data extracted from PDF")
