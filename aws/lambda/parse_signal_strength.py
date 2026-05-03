#!/usr/bin/env python3
"""
Parse Hedgeye Signal Strength PDF using AWS Textract
Extracts added/removed stocks and full stock list (table rendered as image)
"""

import os
import re
import boto3
import io
import PyPDF2
from datetime import datetime, timezone
from decimal import Decimal
import pdfplumber
from pathlib import Path
from date_utils import extract_date_from_pdf
from signal_strength_pages import infer_signal_strength_textract_pages


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

    # Use pdfplumber for text extraction (added/removed on page 1) and get page count
    num_pages = 0
    with pdfplumber.open(pdf_path) as pdf:
        num_pages = len(pdf.pages)
        if num_pages >= 1:
            page1_text = pdf.pages[0].extract_text()
            lines = page1_text.split('\n')
            
            # Robust line-by-line parsing for Added/Removed
            capture_added = False
            capture_removed = False
            added_text = []
            removed_text = []
            
            for line in lines:
                clean_line = line.strip()
                
                # Check for start of sections
                if clean_line.lower().startswith('added:'):
                    capture_added = True
                    capture_removed = False
                    # Remove "Added:" label from the first line
                    content = clean_line[6:].strip()
                    if content:
                        added_text.append(content)
                    continue
                
                if clean_line.lower().startswith('removed:'):
                    capture_removed = True
                    capture_added = False
                    # Remove "Removed:" label from the first line
                    content = clean_line[8:].strip()
                    if content:
                        removed_text.append(content)
                    continue
                
                # Capture content if we are in a section
                # Stop capturing if we hit a likely non-list line (e.g. date, empty, or other header)
                if capture_added:
                    # Heuristic: if it looks like a list of tickers (UPPERCASE, comma)
                    if not clean_line:
                        capture_added = False
                    elif re.match(r'^[A-Z, ]+$', clean_line):
                        added_text.append(clean_line)
                    else:
                        capture_added = False
                        
                if capture_removed:
                    if not clean_line:
                        capture_removed = False
                    elif re.match(r'^[A-Z, ]+$', clean_line):
                        removed_text.append(clean_line)
                    else:
                        capture_removed = False

            # Process captured text
            if added_text:
                full_added = ' '.join(added_text)
                tickers = [t.strip() for t in full_added.split(',') if t.strip()]
                data['added'] = tickers
                print(f"   Added: {', '.join(tickers)}")

            if removed_text:
                full_removed = ' '.join(removed_text)
                tickers = [t.strip() for t in full_removed.split(',') if t.strip()]
                data['removed'] = tickers
                print(f"   Removed: {', '.join(tickers)}")

    naive_pages = os.environ.get('SIGNAL_STRENGTH_NAIVE_TEXTRACT', '').lower() in (
        '1',
        'true',
        'yes',
    )
    if naive_pages:
        page_nums = list(range(2, num_pages + 1))
        print('   ⚙️ SIGNAL_STRENGTH_NAIVE_TEXTRACT: scanning all pages 2..N')
    else:
        meta = infer_signal_strength_textract_pages(pdf_path)
        page_nums = meta['textract_pages']
        saved = meta['naive_calls'] - meta['textract_calls']
        print(
            f"   ⚙️ Signal Strength Textract pages (heuristic): {page_nums[0]}-{page_nums[-1]}"
            if page_nums
            else '   ⚙️ Signal Strength Textract pages (heuristic): none'
        )
        if saved > 0:
            print(f"      (~{saved} fewer AnalyzeDocument calls vs naive)")
        if num_pages >= 2 and not page_nums:
            page_nums = list(range(2, num_pages + 1))
            print('   ⚠️ Heuristic returned no pages; falling back to all pages 2..N')

    # Use Textract for table extraction (stock list from page 2 onwards)
    textract = boto3.client('textract', region_name='us-west-1')

    # Iterate selected pages individually — sync API only processes the FIRST page of each PDF blob
    all_rows = []

    for page_num in page_nums:
        print(f"   📑 Extracting page {page_num} from PDF...")
        try:
            # Extract single page
            page_bytes = extract_specific_pages_as_pdf(pdf_path, [page_num])
            
            # Analyze single page
            response = textract.analyze_document(
                Document={'Bytes': page_bytes},
                FeatureTypes=['TABLES']
            )
            
            blocks = response['Blocks']
            tables = [block for block in blocks if block['BlockType'] == 'TABLE']
            print(f"      Found {len(tables)} tables on page {page_num}")
            
            # Helper to extract rows inside the loop
            def get_page_rows(table_block, blocks):
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

            for table in tables:
                table_rows = get_page_rows(table, blocks)
                # Filter rows relevant to stock list (skip headers if repeated, but we handle that later)
                # Just collect all rows for now
                if table_rows:
                    all_rows.extend(table_rows)

        except Exception as e:
            print(f"   ⚠️ Error processing page {page_num}: {e}")

    # Process all collected rows to find stocks
    print(f"   📊 Processing {len(all_rows)} total rows from all pages...")
    for row in all_rows:
        # Ticker is usually in column 1 (0-indexed), checking length
        if len(row) > 1:
            ticker = row[len(row) > 1 and 1 or 0].strip().upper() # Ticker is usually 2nd column
            
            # Robust check: sometimes Ticker is 1st col if format shifts? 
            # In code history it was row[1]. adhering to that but being careful.
            if len(row) >= 2:
                ticker = row[1].strip().upper()
            else:
                continue

            # Filter out common header words
            if ticker and ticker not in ['TICKER', 'SIGNAL', 'TREND', 'STOCK', 'STOCKS', 'PAGE', 'SYMBOL']:
                # Validate it's a ticker (1-5 letters, maybe dot)
                if re.match(r'^[A-Z]{1,5}(\.[A-Z])?$', ticker):
                    # Extract Strength/Signal if available (usually next col?)
                    # Data model only stores ticker primarily, but let's just make sure we capture the ticker
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
