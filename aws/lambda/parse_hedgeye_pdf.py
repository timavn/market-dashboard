#!/usr/bin/env python3
"""
Parse Hedgeye Risk Range PDF and save to DynamoDB
Usage: python3 parse_hedgeye_pdf.py <path_to_pdf>
"""

import re
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from date_utils import extract_date_from_pdf

import boto3
import pdfplumber

TICKERS = {
    'UST30Y': 'UST30Y', 'UST10Y': 'UST10Y', 'UST2Y': 'UST2Y',
    'HYG': 'HYG', 'LQD': 'LQD', 'SPX': 'SPX', 'COMPQ': 'COMPQ',
    'RUT': 'RUT', 'NDX': 'NDX', 'DXY': 'DXY', 'GOLD': 'GLD',
    'OIL': 'USO', 'VIX': 'VIX', 'WTIC': 'USO', 'USD': 'DXY',
    'XLK': 'XLK', 'XLV': 'XLV', 'XLI': 'XLI', 'NIKK': 'NIKK',
    'DAX': 'DAX', 'SSEC': 'SSEC', 'EUR/USD': 'EUR/USD',
    'USD/YEN': 'USD/YEN', 'GBP/USD': 'GBP/USD', 'CAD/USD': 'CAD/USD',
    'BRENT': 'BRENT', 'NATGAS': 'NATGAS', 'COPPER': 'COPPER',
    'SILVER': 'SILVER', 'MSFT': 'MSFT', 'AAPL': 'AAPL', 'AMZN': 'AMZN',
    'META': 'META', 'GOOGL': 'GOOGL', 'NFLX': 'NFLX', 'TSLA': 'TSLA',
    'NVDA': 'NVDA', 'ORCL': 'ORCL', 'BITCOIN': 'BITCOIN'
}

def extract_risk_ranges(pdf_path):
    """Extract all risk range data from PDF"""
    print(f"\n📄 Reading PDF: {pdf_path}")

    with pdfplumber.open(pdf_path) as pdf:
        text = ""
        for page in pdf.pages:
            text += page.extract_text() + "\n"

    print(f"✅ Extracted {len(text)} characters\n")

    # Parse data
    data = {}
    ts = datetime.now(timezone.utc).isoformat()

    # New format pattern: "TICKER (TREND) BUY_TRADE SELL_TRADE PREV_CLOSE"
    # Example: "UST30Y (BULLISH) 4.92 4.82 4.84"
    # Example: "SPX (BULLISH) 6,861 6,984 6,921"

    # Pattern matches: TICKER (TREND) followed by 3 numbers on same line
    pattern = r'^([A-Z0-9/]+)\s+\((BULLISH|BEARISH|NEUTRAL)\)\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)'

    lines = text.split('\n')
    for line in lines:
        line = line.strip()

        # Skip lines with URLs or page numbers
        if 'http' in line.lower() or '/print' in line:
            continue

        match = re.match(pattern, line)
        if match:
            ticker = match.group(1)
            trend = match.group(2)
            buy = match.group(3).replace(',', '')
            sell = match.group(4).replace(',', '')

            mapped_ticker = TICKERS.get(ticker, ticker)

            data[mapped_ticker] = {
                'lrr': float(buy),
                'hrr': float(sell),
                'trend': trend,
                'original_name': ticker,
                'ts': ts
            }
            print(f"   {mapped_ticker}: LRR={buy}, HRR={sell} ({trend})")

    return data

def upload_pdf_to_s3(pdf_path, pdf_date=None):
    """Upload original PDF to S3 for audit trail"""
    print("\n☁️  Uploading PDF to S3...")

    s3 = boto3.client('s3', region_name='us-west-1')
    date = pdf_date if pdf_date else datetime.now(timezone.utc).strftime('%Y-%m-%d')
    time = datetime.now(timezone.utc).strftime('%H%M%S')

    s3_key = f"hedgeye-pdfs/{date}/risk-ranges-{date}-{time}.pdf"

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


def save_to_dynamodb(data, pdf_s3_key=None, pdf_date=None):
    """Save to DynamoDB"""
    if not data:
        print("\n❌ No data to save")
        return

    print(f"\n💾 Saving {len(data)} records to DynamoDB...")

    db = boto3.resource('dynamodb', region_name='us-west-1')
    date = pdf_date if pdf_date else datetime.now(timezone.utc).strftime('%Y-%m-%d')
    ts = datetime.now(timezone.utc).isoformat()

    # Individual records
    table = db.Table('HedgeyeRiskRanges')
    for ticker, d in data.items():
        item = {
            'date': date,
            'ticker': ticker,
            'lrr': Decimal(str(d['lrr'])),
            'hrr': Decimal(str(d['hrr'])),
            'trend': d['trend'],
            'updatedAt': ts,
            'source': 'hedgeye-pdf',
            'ttl': int(datetime.now(timezone.utc).timestamp() + (730 * 24 * 60 * 60))
        }
        if pdf_s3_key:
            item['pdfSource'] = pdf_s3_key
        table.put_item(Item=item)
    print(f"   ✅ {len(data)} records saved")

    # Snapshot
    snap_table = db.Table('HedgeyeDailySnapshot')
    snapshot_item = {
        'date': date,
        'snapshotType': 'risk-ranges',
        'riskRangeCount': len(data),
        'data': {t: {
            'lrr': Decimal(str(d['lrr'])),
            'hrr': Decimal(str(d['hrr'])),
            'trend': d['trend'],
            'timestamp': d['ts']
        } for t, d in data.items()},
        'scrapedAt': ts,
        'source': 'pdf',
        'ttl': int(datetime.now(timezone.utc).timestamp() + (730 * 24 * 60 * 60))
    }
    if pdf_s3_key:
        snapshot_item['pdfSource'] = pdf_s3_key
    snap_table.put_item(Item=snapshot_item)
    print(f"   ✅ Snapshot saved")

    print("\n🎉 SUCCESS! Check your dashboard.\n")

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 parse_hedgeye_pdf.py <path_to_pdf>")
        sys.exit(1)

    pdf_path = Path(sys.argv[1])

    if not pdf_path.exists():
        print(f"❌ File not found: {pdf_path}")
        sys.exit(1)

    print("\n" + "="*70)
    print("🚀 HEDGEYE PDF PARSER")
    print("="*70)

    # Extract date from PDF
    pdf_date = extract_date_from_pdf(str(pdf_path))
    if pdf_date:
        print(f"📅 Extracted date from PDF: {pdf_date}")
    else:
        pdf_date = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        print(f"📅 Using current date: {pdf_date}")

    data = extract_risk_ranges(pdf_path)
    pdf_s3_key = upload_pdf_to_s3(pdf_path, pdf_date)
    save_to_dynamodb(data, pdf_s3_key, pdf_date)
