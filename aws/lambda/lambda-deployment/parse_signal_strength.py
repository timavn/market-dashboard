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


def _table_header_key(value):
    """Normalize a Textract cell header without depending on line wrapping."""
    return re.sub(r"[^a-z0-9%]+", " ", str(value or "").lower()).strip()


def _signal_strength_column_map(rows):
    """Return the source column indexes for the fields the reader exposes."""
    for row in rows[:4]:
        columns = {}
        for index, value in enumerate(row):
            header = _table_header_key(value)
            if "days on" in header:
                columns["daysOn"] = index
            elif header == "ticker" or header.startswith("ticker "):
                columns["ticker"] = index
            elif "since initial signal" in header or ("since" in header and "signal" in header):
                columns["percentChangeSinceSignal"] = index
        if "ticker" in columns and ("daysOn" in columns or "percentChangeSinceSignal" in columns):
            return columns
    return {"daysOn": 0, "ticker": 1, "percentChangeSinceSignal": 5}


def _parse_days_on(value):
    match = re.search(r"-?\d+", str(value or "").replace(",", ""))
    return int(match.group(0)) if match else None


def _parse_percent_change(value):
    match = re.search(r"[-+]?\d+(?:\.\d+)?", str(value or "").replace(",", ""))
    return Decimal(match.group(0)) if match else None


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
        'stocks': [],
        'reportedStockCount': None,
        'membershipComplete': False,
    }
    ts = datetime.now(timezone.utc).isoformat()

    # Use pdfplumber for text extraction (added/removed on page 1) and get page count
    num_pages = 0
    with pdfplumber.open(pdf_path) as pdf:
        num_pages = len(pdf.pages)
        if num_pages >= 1:
            page1_text = pdf.pages[0].extract_text() or ""
            count_match = re.search(
                r"Signal Strength Stocks:\s*(\d+)\s+Stocks",
                page1_text or "",
                re.IGNORECASE,
            )
            if count_match:
                data['reportedStockCount'] = int(count_match.group(1))
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
                if table_rows:
                    columns = _signal_strength_column_map(table_rows)
                    all_rows.extend((row, columns) for row in table_rows)

        except Exception as e:
            print(f"   ⚠️ Error processing page {page_num}: {e}")

    # Process all collected rows to find stocks
    print(f"   📊 Processing {len(all_rows)} total rows from all pages...")
    for row, columns in all_rows:
        ticker_index = columns.get("ticker")
        if ticker_index is None or ticker_index >= len(row):
            continue
        ticker = str(row[ticker_index] or "").strip().upper()
        if ticker in {'TICKER', 'SIGNAL', 'TREND', 'STOCK', 'STOCKS', 'PAGE', 'SYMBOL'}:
            continue
        if not re.match(r'^[A-Z]{1,5}(\.[A-Z])?$', ticker):
            continue

        stock = {"ticker": ticker}
        days_index = columns.get("daysOn")
        percent_index = columns.get("percentChangeSinceSignal")
        if days_index is not None and days_index < len(row):
            days_on = _parse_days_on(row[days_index])
            if days_on is not None:
                stock["daysOn"] = days_on
        if percent_index is not None and percent_index < len(row):
            percent_change = _parse_percent_change(row[percent_index])
            if percent_change is not None:
                stock["percentChangeSinceSignal"] = percent_change
        data['stocks'].append(stock)

    # Remove duplicates while preserving order
    seen = set()
    unique_stocks = []
    for stock in data['stocks']:
        if stock['ticker'] not in seen:
            seen.add(stock['ticker'])
            unique_stocks.append(stock)
    data['stocks'] = unique_stocks
    data['membershipComplete'] = (
        data['reportedStockCount'] is not None
        and len(data['stocks']) == data['reportedStockCount']
    )

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
        'stockCount': data.get('reportedStockCount') or len(data['stocks']),
        'addedCount': len(data['added']),
        'removedCount': len(data['removed']),
        'data': {
            'added': data['added'],
            'removed': data['removed'],
            'stocks': data['stocks'],
            'membershipComplete': data.get('membershipComplete') is True,
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
