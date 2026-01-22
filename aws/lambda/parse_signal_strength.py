#!/usr/bin/env python3
"""
Parse Hedgeye Signal Strength PDF using AWS Textract
Extracts added/removed stocks and full stock list (table rendered as image)
"""

import re
import boto3
import io
import PyPDF2
from datetime import datetime, timezone
from decimal import Decimal
import pdfplumber
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


def extract_signal_strength(pdf_path, s3_key=None):
    """Extract signal strength stock data using AWS Textract"""
    print(f"\n📄 Reading Signal Strength PDF: {pdf_path}")

    data = {
        'added': [],
        'removed': [],
        'stocks': []
    }
    ts = datetime.now(timezone.utc).isoformat()

    # Use pdfplumber for text extraction (added/removed on page 1)
    with pdfplumber.open(pdf_path) as pdf:
        if len(pdf.pages) >= 1:
            page1_text = pdf.pages[0].extract_text()

            # Extract added stocks (case-insensitive)
            added_match = re.search(r'Added:\s*([A-Z, ]+)', page1_text, re.IGNORECASE)
            if added_match:
                tickers = [t.strip() for t in added_match.group(1).split(',')]
                data['added'] = tickers
                print(f"   Added: {', '.join(tickers)}")

            # Extract removed stocks (case-insensitive)
            removed_match = re.search(r'Removed:\s*([A-Z, ]+)', page1_text, re.IGNORECASE)
            if removed_match:
                tickers = [t.strip() for t in removed_match.group(1).split(',')]
                data['removed'] = tickers
                print(f"   Removed: {', '.join(tickers)}")

    # Use Textract for table extraction (stock list on page 2)
    textract = boto3.client('textract', region_name='us-west-1')

    # Extract only page 2 (stock list table)
    print("   📑 Extracting page 2 from PDF...")
    pdf_subset = extract_specific_pages_as_pdf(pdf_path, [2])

    print("   🔍 Using AWS Textract to extract stock list table...")
    response = textract.analyze_document(
        Document={'Bytes': pdf_subset},
        FeatureTypes=['TABLES']
    )

    blocks = response['Blocks']
    tables = [block for block in blocks if block['BlockType'] == 'TABLE']

    print(f"   Found {len(tables)} tables in PDF")

    def get_table_data(table_block, blocks):
        """Extract rows and cells from a table block"""
        rows = []
        cells_by_row = {}

        if 'Relationships' not in table_block:
            return rows

        for relationship in table_block['Relationships']:
            if relationship['Type'] == 'CHILD':
                for cell_id in relationship['Ids']:
                    cell_block = next((b for b in blocks if b['Id'] == cell_id), None)
                    if cell_block and cell_block['BlockType'] == 'CELL':
                        row_idx = cell_block['RowIndex']
                        col_idx = cell_block['ColumnIndex']

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

        for row_idx in sorted(cells_by_row.keys()):
            row = []
            for col_idx in sorted(cells_by_row[row_idx].keys()):
                row.append(cells_by_row[row_idx][col_idx])
            rows.append(row)

        return rows

    # Process each table to find stock list table
    for table in tables:
        table_data = get_table_data(table, blocks)

        if not table_data or len(table_data) < 2:
            continue

        # Look for table with ticker symbols
        print("   📊 Found stock list table")
        for row in table_data[1:]:
            # Ticker is in column 1 (0-indexed), not column 0
            if len(row) > 1:
                ticker = row[1].strip().upper()
                # Filter out common header words
                if ticker and ticker not in ['TICKER', 'SIGNAL', 'TREND', 'STOCK', 'STOCKS', 'PAGE']:
                    # Validate it's a ticker (1-5 letters)
                    if re.match(r'^[A-Z]{1,5}$', ticker):
                        data['stocks'].append({
                            'ticker': ticker,
                            'timestamp': ts
                        })

    # Remove duplicates while preserving order
    seen = set()
    unique_stocks = []
    for stock in data['stocks']:
        if stock['ticker'] not in seen:
            seen.add(stock['ticker'])
            unique_stocks.append(stock)
    data['stocks'] = unique_stocks

    print(f"   ✅ Total stocks: {len(data['stocks'])}")
    return data


def save_to_dynamodb(data, pdf_s3_key=None, pdf_date=None):
    """Save Signal Strength data to DynamoDB"""
    if not data or not data.get('stocks'):
        print("\n❌ No data to save")
        return

    import boto3

    if not pdf_date:
        print("❌ valid pdf_date is required to save to DynamoDB")
        return

    print(f"\n💾 Saving to DynamoDB...")
    db = boto3.resource('dynamodb', region_name='us-west-1')
    date = pdf_date
    ts = datetime.now(timezone.utc).isoformat()

    # Save to HedgeyeDailySnapshot
    snap_table = db.Table('HedgeyeDailySnapshot')
    snapshot_item = {
        'date': date,
        'snapshotType': 'signal-strength',
        'stockCount': len(data['stocks']),
        'addedCount': len(data['added']),
        'removedCount': len(data['removed']),
        'data': {
            'added': data['added'],
            'removed': data['removed'],
            'stocks': [s['ticker'] for s in data['stocks']]
        },
        'scrapedAt': ts,
        'source': 'textract',
        'ttl': int(datetime.now(timezone.utc).timestamp() + (730 * 24 * 60 * 60))
    }

    if pdf_s3_key:
        snapshot_item['pdfSource'] = pdf_s3_key

    snap_table.put_item(Item=snapshot_item)
    print(f"   ✅ Saved {len(data['stocks'])} stocks ({len(data['added'])} added, {len(data['removed'])} removed)")
    print("\n🎉 SUCCESS! Signal Strength data saved.\n")


if __name__ == '__main__':
    import sys
    from pathlib import Path

    if len(sys.argv) < 2:
        print("Usage: python3 parse_signal_strength.py <path_to_pdf>")
        sys.exit(1)

    pdf_path = Path(sys.argv[1])
    if not pdf_path.exists():
        print(f"❌ File not found: {pdf_path}")
        sys.exit(1)

    print("\n" + "="*70)
    print("🚀 SIGNAL STRENGTH PARSER (AWS Textract)")
    print("="*70)

    pdf_date = extract_date_from_pdf(pdf_path)
    print(f"📅 PDF Date: {pdf_date}\n")

    data = extract_signal_strength(pdf_path)

    if data and data.get('stocks'):
        save_to_dynamodb(data, pdf_date=pdf_date)
    else:
        print("\n❌ No data extracted from PDF")
