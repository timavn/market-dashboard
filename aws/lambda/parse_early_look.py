#!/usr/bin/env python3
"""
Parse Hedgeye Early Look PDF
Extracts risk ranges from last page (OUR LEVELS section)
Generates S3 uploads for PDF and screenshot
"""

import re
import io
import sys
import boto3
from datetime import datetime, timezone
from decimal import Decimal
import pdfplumber
from pdf2image import convert_from_path
from pathlib import Path
from date_utils import extract_date_from_pdf


TICKER_MAP = {
    'UST 10YR YIELD': 'UST10Y',
    'HIGH YIELD (HYG)': 'HYG',
    'INVESTMENT GRADE (LQD)': 'LQD',
    'SPX': 'SPX',
    'NASDAQ': 'COMPQ',
    'RUT': 'RUT',
    'TECH (XLK)': 'XLK',
    'HEALTHCARE (XLV)': 'XLV',
    'INDUSTRIALS (XLI)': 'XLI',
    'SHANGHAI COMP': 'SSEC',
    'VIX': 'VIX',
    'USD': 'DXY',
    'OIL (WTI)': 'USO',
    'NAT GAS': 'NATGAS',
    'GOLD': 'GLD',
    'COPPER': 'COPPER',
    'SILVER (SLV)': 'SILVER'
}


def extract_early_look(pdf_path):
    """Extract risk range data from Early Look PDF (OUR LEVELS section)"""
    print(f"\n📄 Reading Early Look PDF: {pdf_path}")

    data = {}
    ts = datetime.now(timezone.utc).isoformat()

    with pdfplumber.open(pdf_path) as pdf:
        if len(pdf.pages) < 1:
            print("❌ PDF has no pages")
            return data

        # Extract text from ALL pages to handle lists spanning multiple pages
        full_text = ""
        for page in pdf.pages:
            full_text += page.extract_text() + "\n"
        
        # Find start of section
        start_idx = full_text.find('OUR LEVELS')
        if start_idx == -1:
            print("   ❌ Could not find OUR LEVELS section in PDF")
            return data
            
        # Process everything after OUR LEVELS
        section_text = full_text[start_idx:]
        lines = section_text.split('\n')

        # Counter for preserving order
        order_index = 0

        for line in lines:
            # Pattern: "UST 10yr Yield 4.10-4.22% (bearish)"
            # Improved regex to handle optional grouping/spacing issues
            match = re.match(r'^(.+?)\s+([\d,\.]+)-?([\d,\.]+)%?\s*\((bullish|bearish|neutral)\)', line, re.IGNORECASE)
            
            # Stop if we hit a footer link or unrelated section (heuristic)
            if 'http' in line.lower() and not match:
                continue
                
            if match:
                name = match.group(1).strip()
                lrr = match.group(2).replace(',', '')
                hrr = match.group(3).replace(',', '')
                trend = match.group(4).upper()

                # Map to ticker
                ticker = TICKER_MAP.get(name.upper(), name)

                data[ticker] = {
                    'lrr': float(lrr),
                    'hrr': float(hrr),
                    'trend': trend,
                    'originalName': name,
                    'timestamp': ts,
                    'index': order_index
                }
                print(f"   [{order_index}] {ticker}: {lrr}-{hrr} ({trend})")
                order_index += 1

    return data


    return data


def upload_pdf_to_s3(pdf_path, pdf_date=None):
    """Upload original PDF to S3 for audit trail"""
    print("\n☁️  Uploading PDF to S3...")

    s3 = boto3.client('s3', region_name='us-west-1')
    date = pdf_date if pdf_date else datetime.now(timezone.utc).strftime('%Y-%m-%d')
    time = datetime.now(timezone.utc).strftime('%H%M%S')

    s3_key = f"hedgeye-pdfs/{date}/early-look-{date}-{time}.pdf"

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
        
        s3_key = f"hedgeye-screenshots/{date}/early-look-{date}-{time}.png"
        
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


def save_to_dynamodb(data, pdf_s3_key=None, pdf_date=None, screenshot_s3_key=None):
    """Save Early Look data to DynamoDB"""
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
        'snapshotType': 'early-look',
        'riskRangeCount': len(data),
        'data': {t: {
            'lrr': Decimal(str(d['lrr'])),
            'hrr': Decimal(str(d['hrr'])),
            'trend': d['trend'],
            'timestamp': d['timestamp'],
            'index': d.get('index', 999)
        } for t, d in data.items()},
        'scrapedAt': ts,
        'source': 'pdf',
        'ttl': int(datetime.now(timezone.utc).timestamp() + (730 * 24 * 60 * 60))
    }

    if pdf_s3_key:
        snapshot_item['pdfSource'] = pdf_s3_key
    if screenshot_s3_key:
        snapshot_item['screenshotS3Key'] = screenshot_s3_key

    snap_table.put_item(Item=snapshot_item)
    print(f"   ✅ Saved {len(data)} risk ranges")
    print("\n🎉 SUCCESS! Early Look data saved.\n")


if __name__ == '__main__':
    import sys

    if len(sys.argv) < 2:
        print("Usage: python3 parse_early_look.py <path_to_pdf>")
        sys.exit(1)

    pdf_path = Path(sys.argv[1])
    if not pdf_path.exists():
        print(f"❌ File not found: {pdf_path}")
        sys.exit(1)

    print("\n" + "="*70)
    print("🚀 EARLY LOOK PARSER")
    print("="*70)

    pdf_date = extract_date_from_pdf(pdf_path)
    print(f"📅 PDF Date: {pdf_date}\n")

    data = extract_early_look(pdf_path)
    
    # Upload and save
    pdf_s3_key = upload_pdf_to_s3(pdf_path, pdf_date)
    screenshot_s3_key = generate_screenshot(pdf_path, pdf_date)
    
    save_to_dynamodb(data, pdf_s3_key, pdf_date, screenshot_s3_key)
