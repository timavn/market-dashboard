#!/usr/bin/env python3
"""
Parse Hedgeye Portfolio Solutions PDF using AWS Textract
Extracts ETF rankings and movers from pages 1-2 (tables rendered as images)
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


def extract_portfolio_solutions(pdf_path, s3_key=None):
    """Extract ETF ranking data from Portfolio Solutions PDF using AWS Textract"""
    print(f"\n📄 Reading Portfolio Solutions PDF: {pdf_path}")

    data = {
        'topMovers': {'weekly': [], 'monthly': []},
        'bottomMovers': {'weekly': [], 'monthly': []},
        'rankings': []
    }
    ts = datetime.now(timezone.utc).isoformat()

    # Use pdfplumber for text extraction (movers on page 1)
    with pdfplumber.open(pdf_path) as pdf:
        if len(pdf.pages) >= 1:
            page1_text = pdf.pages[0].extract_text()

            # 1. Weekly Top Movers
            week_top_match = re.search(r'Top Movers:(.*?)(Bottom Movers:|$)', page1_text, re.DOTALL | re.IGNORECASE)
            if week_top_match:
                section_text = week_top_match.group(1)
                print(f"   [DEBUG] Weekly Top Section (first 100 chars): {section_text.strip()[:100]}...")
                
                # Robust regex: 2-6 chars ticker, optional space, (+, optional space, digits)
                items = re.findall(r'([A-Z]{2,6})\s*\(\+\s*(\d+)\)', section_text)
                for ticker, change in items:
                    data['topMovers']['weekly'].append({'ticker': ticker, 'change': int(change)})
                if items:
                    print(f"   1-Week Top: {', '.join([f'{t} (+{c})' for t, c in items])}")
                else:
                    print("   [WARN] No items found in Weekly Top Movers section")

            # 2. Weekly Bottom Movers
            week_bottom_match = re.search(r'Bottom Movers:(.*?)(1-MONTH|$)', page1_text, re.DOTALL | re.IGNORECASE)
            if week_bottom_match:
                section_text = week_bottom_match.group(1)
                print(f"   [DEBUG] Weekly Bottom Section (first 100 chars): {section_text.strip()[:100]}...")
                
                # Robust regex: Handle minus sign, en-dash, em-dash, hyphen, optional spaces
                # Captures the number as group 2
                # \u2013 is en-dash, \u2014 is em-dash, \u2212 is minus sign
                items = re.findall(r'([A-Z]{2,6})\s*\([−–—-]?\s*(\d+)\)', section_text)
                for ticker, change in items:
                    # Make negative since it's bottom movers
                    data['bottomMovers']['weekly'].append({'ticker': ticker, 'change': -int(change)})
                if items:
                    print(f"   1-Week Bottom: {', '.join([f'{t} (-{c})' for t, c in items])}")
                else:
                    print("   [WARN] No items found in Weekly Bottom Movers section")

            # 3. Monthly Top Movers
            month_top_match = re.search(r'1-MONTH RE-RANK.*?Top Movers:(.*?)(Bottom Movers:|$)', page1_text, re.DOTALL | re.IGNORECASE)
            if month_top_match:
                section_text = month_top_match.group(1)
                print(f"   [DEBUG] Monthly Top Section (first 100 chars): {section_text.strip()[:100]}...")
                
                items = re.findall(r'([A-Z]{2,6})\s*\(\+\s*(\d+)\)', section_text)
                for ticker, change in items:
                    data['topMovers']['monthly'].append({'ticker': ticker, 'change': int(change)})
                if items:
                    print(f"   1-Month Top: {', '.join([f'{t} (+{c})' for t, c in items])}")

            month_bottom_match = re.search(r'1-MONTH RE-RANK.*?Bottom Movers:(.*?)(Below are|$)', page1_text, re.DOTALL | re.IGNORECASE)
            if month_bottom_match:
                section_text = month_bottom_match.group(1)
                print(f"   [DEBUG] Monthly Bottom Section (first 100 chars): {section_text.strip()[:100]}...")
                
                # Robust regex: Handle minus sign, en-dash, em-dash, hyphen, optional spaces
                # \u2013 is en-dash, \u2014 is em-dash, \u2212 is minus sign
                items = re.findall(r'([A-Z]{2,6})\s*\([−–—-]?\s*(\d+)\)', section_text)
                for ticker, change in items:
                    # Make negative since it's bottom movers
                    data['bottomMovers']['monthly'].append({'ticker': ticker, 'change': -int(change)})
                if items:
                    print(f"   1-Month Bottom: {', '.join([f'{t} (-{c})' for t, c in items])}")

    # Use Textract for table extraction (rankings on page 2)
    textract = boto3.client('textract', region_name='us-west-1')

    # Extract only page 2 (ranking table)
    print("   📑 Extracting page 2 from PDF...")
    pdf_subset = extract_specific_pages_as_pdf(pdf_path, [2])

    print("   🔍 Using AWS Textract to extract ranking table...")
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

    # Find ranking table (look for "RANK" or "TICKER" header)
    for table in tables:
        table_data = get_table_data(table, blocks)

        if not table_data or len(table_data) < 3:
            continue

        # Check if this is the ranking table (Row 1 should have RANK/TICKER)
        if len(table_data) > 1:
            header = [cell.upper() for cell in table_data[1]]
        else:
            header = [cell.upper() for cell in table_data[0]]

        if 'RANK' in ' '.join(header) or 'TICKER' in ' '.join(header):
            print("   📊 Found ranking table")
            # Skip both Row 0 (sub-header) and Row 1 (header), start at Row 2
            for row in table_data[2:]:
                if len(row) >= 8:
                    try:
                        rank = int(row[0])
                        ticker = row[1].strip().upper()
                        
                        week_ago = row[2] if len(row) > 2 else '-'
                        month_ago = row[3] if len(row) > 3 else '-'
                        date_added = row[4] if len(row) > 4 and row[4] != '-' else None
                        asset_class = row[5] if len(row) > 5 else None
                        
                        # We are replacing weights with history columns in the UI, but we still parse them if available
                        min_size = int(row[6].replace('%', '')) if len(row) > 6 else 0
                        max_size = int(row[7].replace('%', '')) if len(row) > 7 else 0

                        data['rankings'].append({
                            'rank': rank,
                            'ticker': ticker,
                            'weekAgo': week_ago,
                            'monthAgo': month_ago,
                            'dateAdded': date_added,
                            'assetClass': asset_class,
                            'minSize': min_size,
                            'maxSize': max_size,
                            'timestamp': ts
                        })
                    except (ValueError, IndexError) as e:
                        print(f"      ⚠️  Skipping row: {row} (error: {e})")

    print(f"\n   ✅ Extracted {len(data['rankings'])} ETF rankings")
    return data


def save_to_dynamodb(data, pdf_s3_key=None, pdf_date=None):
    """Save Portfolio Solutions data to DynamoDB"""
    if not data or not data.get('rankings'):
        print("\n❌ No data to save")
        return

    import boto3

    print(f"\n💾 Saving to DynamoDB...")
    db = boto3.resource('dynamodb', region_name='us-west-1')
    date = pdf_date if pdf_date else datetime.now(timezone.utc).strftime('%Y-%m-%d')
    ts = datetime.now(timezone.utc).isoformat()

    # Save to HedgeyeDailySnapshot
    snap_table = db.Table('HedgeyeDailySnapshot')
    snapshot_item = {
        'date': date,
        'snapshotType': 'portfolio-solutions',
        'rankingCount': len(data['rankings']),
        'data': {
            'topMovers': data['topMovers'],
            'bottomMovers': data['bottomMovers'],
            'rankings': [{
                'rank': r['rank'],
                'ticker': r['ticker'],
                'weekAgo': r.get('weekAgo'),
                'monthAgo': r.get('monthAgo'),
                'dateAdded': r['dateAdded'],
                'assetClass': r['assetClass'],
                'minSize': r['minSize'],
                'maxSize': r['maxSize'],
                'timestamp': r['timestamp']
            } for r in data['rankings']]
        },
        'scrapedAt': ts,
        'source': 'textract',
        'ttl': int(datetime.now(timezone.utc).timestamp() + (730 * 24 * 60 * 60))
    }

    if pdf_s3_key:
        snapshot_item['pdfSource'] = pdf_s3_key

    snap_table.put_item(Item=snapshot_item)
    print(f"   ✅ Saved {len(data['rankings'])} ETF rankings")
    print("\n🎉 SUCCESS! Portfolio Solutions data saved.\n")


if __name__ == '__main__':
    import sys
    from pathlib import Path
    from date_utils import extract_date_from_pdf

    if len(sys.argv) < 2:
        print("Usage: python3 parse_portfolio_solutions.py <path_to_pdf>")
        sys.exit(1)

    pdf_path = Path(sys.argv[1])
    if not pdf_path.exists():
        print(f"❌ File not found: {pdf_path}")
        sys.exit(1)

    print("\n" + "="*70)
    print("🚀 PORTFOLIO SOLUTIONS PARSER (AWS Textract)")
    print("="*70)

    pdf_date = extract_date_from_pdf(pdf_path)
    print(f"📅 PDF Date: {pdf_date}\n")

    data = extract_portfolio_solutions(pdf_path)

    if data and data.get('rankings'):
        save_to_dynamodb(data, pdf_date=pdf_date)
    else:
        print("\n❌ No data extracted from PDF")
