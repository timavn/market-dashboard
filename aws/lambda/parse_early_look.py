#!/usr/bin/env python3
"""
Parse Hedgeye Early Look PDF
Extracts risk ranges from last page (OUR LEVELS section)
"""

import re
from datetime import datetime, timezone
from decimal import Decimal
import pdfplumber
from pathlib import Path
from date_utils import extract_date_from_pdf


TICKER_MAP = {
    'UST 10YR YIELD': 'UST10Y',
    'HIGH YIELD (HYG)': 'HYG',
    'SPX': 'SPX',
    'NASDAQ': 'COMPQ',
    'RUT': 'RUT',
    'TECH (XLK)': 'XLK',
    'INDUSTRIALS (XLI)': 'XLI',
    'VIX': 'VIX',
    'USD': 'DXY',
    'OIL (WTI)': 'USO',
    'GOLD': 'GLD',
    'COPPER': 'COPPER',
    'SILVER (SLV)': 'SILVER'
}


def extract_early_look(pdf_path):
    """Extract risk range data from Early Look PDF (last page - OUR LEVELS section)"""
    print(f"\n📄 Reading Early Look PDF: {pdf_path}")

    data = {}
    ts = datetime.now(timezone.utc).isoformat()

    with pdfplumber.open(pdf_path) as pdf:
        # Get last page (OUR LEVELS section)
        if len(pdf.pages) < 1:
            print("❌ PDF has no pages")
            return data

        page_idx = len(pdf.pages) - 1
        page_text = pdf.pages[page_idx].extract_text()
        lines = page_text.split('\n')

        print(f"   Reading page {page_idx + 1} of {len(pdf.pages)}\n")

        for line in lines:
            # Pattern: "UST 10yr Yield 4.10-4.22% (bearish)"
            match = re.match(r'^(.+?)\s+([\d,\.]+)-([\d,\.]+)%?\s*\((bullish|bearish|neutral)\)', line, re.IGNORECASE)
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
                    'timestamp': ts
                }
                print(f"   {ticker}: {lrr}-{hrr} ({trend})")

    return data


def save_to_dynamodb(data, pdf_s3_key=None, pdf_date=None):
    """Save Early Look data to DynamoDB"""
    if not data:
        print("\n❌ No data to save")
        return

    import boto3

    print(f"\n💾 Saving {len(data)} records to DynamoDB...")
    db = boto3.resource('dynamodb', region_name='us-west-1')
    date = pdf_date if pdf_date else datetime.now(timezone.utc).strftime('%Y-%m-%d')
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
            'timestamp': d['timestamp']
        } for t, d in data.items()},
        'scrapedAt': ts,
        'source': 'pdf',
        'ttl': int(datetime.now(timezone.utc).timestamp() + (730 * 24 * 60 * 60))
    }

    if pdf_s3_key:
        snapshot_item['pdfSource'] = pdf_s3_key

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
    save_to_dynamodb(data, pdf_date=pdf_date)
