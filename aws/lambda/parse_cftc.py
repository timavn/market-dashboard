#!/usr/bin/env python3
"""
Parse Hedgeye CFTC Non-Commercial Net Long Positioning PDF using AWS Textract
"""

import os
import sys
import boto3
import io
import re
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from date_utils import extract_date_from_pdf

def parse_number(text):
    if not text:
        return None
    text = text.replace(',', '').replace('(', '-').replace(')', '').replace('X', '').replace('%', '').strip()
    try:
        return float(text)
    except ValueError:
        return None

def extract_cftc_data(pdf_path):
    print(f"\n📄 Reading CFTC PDF: {pdf_path}")
    
    with open(pdf_path, 'rb') as file:
        pdf_bytes = file.read()
        
    textract = boto3.client('textract', region_name='us-west-1')
    print("   📑 Calling AWS Textract analyze_document...")
    response = textract.analyze_document(
        Document={'Bytes': pdf_bytes},
        FeatureTypes=['TABLES']
    )
    
    blocks = response['Blocks']
    tables = [b for b in blocks if b['BlockType'] == 'TABLE']
    print(f"   Found {len(tables)} tables")
    
    # Helper to extract rows
    def get_table_rows(table_block, blocks):
        rows = []
        cells_by_row = {}
        if 'Relationships' not in table_block:
            return rows
        for rel in table_block['Relationships']:
            if rel['Type'] == 'CHILD':
                for cell_id in rel['Ids']:
                    cell_block = next((b for b in blocks if b['Id'] == cell_id), None)
                    if cell_block and cell_block['BlockType'] == 'CELL':
                        row_idx = cell_block['RowIndex']
                        col_idx = cell_block['ColumnIndex']
                        cell_text = ''
                        if 'Relationships' in cell_block:
                            for r in cell_block['Relationships']:
                                if r['Type'] == 'CHILD':
                                    for word_id in r['Ids']:
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

    data_rows = []
    current_category = "UNKNOWN"
    
    for table in tables:
        rows = get_table_rows(table, blocks)
        for row in rows:
            # Skip header rows
            if not row or any('METRIC' in c.upper() for c in row if c):
                continue
                
            # Clean up the row and handle potentially merged first column
            cleaned_row = [c.strip() for c in row if c]
            if not cleaned_row:
                continue
                
            # If the first item is a known category, update current category
            first_val = cleaned_row[0].upper()
            if first_val in ['EQUITIES', 'RATES', 'CURRENCIES', 'COMMODITIES']:
                current_category = first_val
                # If the row just contained the category name (merged cell representation), skip processing as data
                if len(cleaned_row) < 3:
                    continue
                # Shift columns over because Textract might have included category in col 0
                cleaned_row = cleaned_row[1:]
                
            # We expect columns roughly matching: Metric, Latest, WW Chg, 3M Ave, 6M Ave, 1Y Ave, Max, Min, 1Y Z, 3Y Z
            # But textract sometimes shifts things. Let's find the metric name.
            if len(cleaned_row) < 5:
                continue
                
            metric_name = cleaned_row[0]
            
            # Simple heuristic to check if it's a valid metric row: column 1 should be parseable as a number
            latest_val = parse_number(cleaned_row[1])
            if latest_val is None:
                continue
                
            # Extract data mapping indices safely
            ww_chg = parse_number(cleaned_row[2]) if len(cleaned_row) > 2 else None
            # Find Z-scores (last two columns usually)
            z3y = parse_number(cleaned_row[-1]) if len(cleaned_row) > 3 else None
            z1y = parse_number(cleaned_row[-2]) if len(cleaned_row) > 4 else None
            
            data_rows.append({
                'category': current_category,
                'metric': metric_name,
                'latest': latest_val,
                'wwChg': ww_chg,
                'zScore1Y': z1y,
                'zScore3Y': z3y
            })
            
    print(f"   ✅ Extracted {len(data_rows)} CFTC metrics")
    return {'metrics': data_rows}

def save_to_dynamodb(data, pdf_s3_key=None, pdf_date=None):
    if not data or not data.get('metrics'):
        print("\n❌ No data to save")
        return

    if not pdf_date:
        print("❌ valid pdf_date is required to save to DynamoDB")
        return

    print(f"\n💾 Saving to DynamoDB...")
    db = boto3.resource('dynamodb', region_name='us-west-1')
    ts = datetime.now(timezone.utc).isoformat()

    snap_table = db.Table('HedgeyeDailySnapshot')
    
    # Store numerical values as Decimal
    def float_to_dec(f):
        if f is None: return None
        return Decimal(str(f))
        
    metrics_to_save = []
    for m in data['metrics']:
        metrics_to_save.append({
            'category': m['category'],
            'metric': m['metric'],
            'latest': float_to_dec(m['latest']),
            'wwChg': float_to_dec(m['wwChg']),
            'zScore1Y': float_to_dec(m['zScore1Y']),
            'zScore3Y': float_to_dec(m['zScore3Y']),
        })

    snapshot_item = {
        'date': pdf_date,
        'snapshotType': 'cftc-positioning',
        'metricsCount': len(metrics_to_save),
        'data': metrics_to_save,
        'scrapedAt': ts,
        'source': 'textract',
        'ttl': int(datetime.now(timezone.utc).timestamp() + (730 * 24 * 60 * 60))
    }

    if pdf_s3_key:
        snapshot_item['pdfSource'] = pdf_s3_key

    snap_table.put_item(Item=snapshot_item)
    print(f"   ✅ Saved {len(metrics_to_save)} metrics")
    print("\n🎉 SUCCESS! CFTC data saved.\n")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 parse_cftc.py <path_to_pdf>")
        sys.exit(1)

    pdf_path = Path(sys.argv[1])
    if not pdf_path.exists():
        print(f"❌ File not found: {pdf_path}")
        sys.exit(1)

    print("\n" + "="*70)
    print("🚀 CFTC NET LONG PARSER (AWS Textract)")
    print("="*70)

    pdf_date = extract_date_from_pdf(str(pdf_path))
    if not pdf_date:
        pdf_date = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        print(f"📅 Using fallback date: {pdf_date}")
    else:
        print(f"📅 PDF Date: {pdf_date}\n")

    data = extract_cftc_data(pdf_path)

    if data and data.get('metrics'):
        save_to_dynamodb(data, pdf_date=pdf_date)
    else:
        print("\n❌ No data extracted from PDF")
