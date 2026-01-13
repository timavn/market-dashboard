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

    # Extract pages 3 and 10 (crypto and stock tables)
    print("   📑 Extracting pages 3 and 10 from PDF...")
    pdf_subset = extract_specific_pages_as_pdf(pdf_path, [3, 10])

    if not pdf_subset:
        print("   ❌ Failed to extract PDF pages")
        return data

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

    # Process each table to find crypto and stock tables
    for table in tables:
        table_data = get_table_data(table, blocks)

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
                if len(row) >= 5:
                    try:
                        symbol = row[0].strip().upper()
                        if symbol in ['BTC', 'ETH', 'SOL', 'AVAX', 'XRP', 'ZEC']:
                            price = float(row[1].replace(',', '').replace('$', ''))
                            buy_trade = float(row[2].replace(',', '').replace('$', ''))
                            sell_trade = float(row[3].replace(',', '').replace('$', ''))
                            trend = row[4].strip().upper()

                            data['cryptos'][symbol] = {
                                'price': price,
                                'buyTrade': buy_trade,
                                'sellTrade': sell_trade,
                                'trend': trend,
                                'timestamp': ts
                            }
                            print(f"      {symbol}: ${price:,.0f} (Buy: ${buy_trade:,.0f}, Sell: ${sell_trade:,.0f}, {trend})")
                    except (ValueError, IndexError) as e:
                        print(f"      ⚠️  Skipping row: {row} (error: {e})")

        # Parse stock table
        elif is_stock_table:
            print("   📊 Found stock table")
            for row in table_data[1:]:
                if len(row) >= 7:
                    try:
                        ticker = row[0].strip().upper()
                        if ticker in ['IBIT', 'MSTR', 'MARA', 'ETHA', 'BLOK', 'COIN', 'CRCL', 'BMNR']:
                            price = float(row[1].replace(',', '').replace('$', ''))
                            buy_trade = float(row[2].replace(',', '').replace('$', ''))
                            sell_trade = float(row[3].replace(',', '').replace('$', ''))
                            upside = float(row[4].replace('%', ''))
                            downside = float(row[5].replace('%', ''))
                            trend = row[6].strip().upper()

                            data['stocks'][ticker] = {
                                'price': price,
                                'buyTrade': buy_trade,
                                'sellTrade': sell_trade,
                                'upside': upside,
                                'downside': downside,
                                'trend': trend,
                                'timestamp': ts
                            }
                            print(f"      {ticker}: ${price:.2f} (↑{upside}% ↓{downside}%, {trend})")
                    except (ValueError, IndexError) as e:
                        print(f"      ⚠️  Skipping row: {row} (error: {e})")

    print(f"\n   ✅ Extracted {len(data['cryptos'])} cryptos and {len(data['stocks'])} stocks")
    return data


def save_to_dynamodb(data, pdf_s3_key=None, pdf_date=None):
    """Save Bitcoin Tracker data to DynamoDB"""
    if not data or (not data.get('cryptos') and not data.get('stocks')):
        print("\n❌ No data to save")
        return

    print(f"\n💾 Saving to DynamoDB...")
    db = boto3.resource('dynamodb', region_name='us-west-1')
    date = pdf_date if pdf_date else datetime.now(timezone.utc).strftime('%Y-%m-%d')
    ts = datetime.now(timezone.utc).isoformat()

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
                'timestamp': v['timestamp']
            } for k, v in data.get('cryptos', {}).items()},
            'stocks': {k: {
                'price': Decimal(str(v['price'])),
                'buyTrade': Decimal(str(v['buyTrade'])),
                'sellTrade': Decimal(str(v['sellTrade'])),
                'upside': Decimal(str(v['upside'])),
                'downside': Decimal(str(v['downside'])),
                'trend': v['trend'],
                'timestamp': v['timestamp']
            } for k, v in data.get('stocks', {}).items()}
        },
        'scrapedAt': ts,
        'source': 'textract',
        'ttl': int(datetime.now(timezone.utc).timestamp() + (730 * 24 * 60 * 60))
    }

    if pdf_s3_key:
        snapshot_item['pdfSource'] = pdf_s3_key

    snap_table.put_item(Item=snapshot_item)
    print(f"   ✅ Saved {len(data.get('cryptos', {}))} cryptos and {len(data.get('stocks', {}))} stocks")
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
        save_to_dynamodb(data, pdf_date=pdf_date)
    else:
        print("\n❌ No data extracted from PDF")
