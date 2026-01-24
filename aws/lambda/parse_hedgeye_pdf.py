#!/usr/bin/env python3
"""
Parse Hedgeye Risk Range PDF and save to DynamoDB
Enhanced to extract: TREND Changes, Full Names, Prev Close, and OutBucket
Usage: python3 parse_hedgeye_pdf.py <path_to_pdf>
"""

import re
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from date_utils import extract_date_from_pdf

import boto3
import boto3
import pdfplumber
from pdf2image import convert_from_path
import io

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


def extract_trend_changes(text):
    """Extract the TREND Changes section from top of PDF"""
    changes = []
    
    # Pattern: "TICKER changed from OLD to NEW [and ...]"
    pattern = r'([A-Z0-9/]+)\s+changed from\s+(BULLISH|BEARISH|NEUTRAL)\s+to\s+(BULLISH|BEARISH|NEUTRAL)(.*?)(?=\n|$)'
    
    for match in re.finditer(pattern, text):
        ticker = match.group(1)
        old_trend = match.group(2)
        new_trend = match.group(3)
        note_raw = match.group(4).strip() if match.group(4) else None
        
        # Clean up note
        note = None
        if note_raw:
            # Simplify OutBucket note
            if 'outbucket' in note_raw.lower():
                note = 'outbucket'
            elif note_raw.startswith(' and '):
                note = note_raw[5:]  # Remove " and "
            else:
                note = note_raw
        
        # Map ticker if needed
        mapped_ticker = TICKERS.get(ticker, ticker)
        
        changes.append({
            'ticker': mapped_ticker,
            'oldTrend': old_trend,
            'newTrend': new_trend,
            'note': note
        })
        
        print(f"   TREND CHANGE: {mapped_ticker} {old_trend} → {new_trend}")
    
    return changes


def extract_outbucket(text):
    """Extract #OutBucket section from PDF"""
    outbucket = []
    
    # Find the #OutBucket section
    outbucket_start = text.find('#OUTBUCKET')
    if outbucket_start == -1:
        outbucket_start = text.find('#OutBucket')
    
    if outbucket_start == -1:
        return outbucket
    
    outbucket_section = text[outbucket_start:]
    
    # Pattern: [•] Name (TICKER) - TREND (DATE)
    # Example: Aerospace & Defense ETF (ITA) = BULLISH (8/22/2024)
    pattern = r'(?:•\s+)?(.+?)\s+\(([A-Z]+)\)\s+[=\-]\s+(BULLISH|BEARISH|NEUTRAL)\s+\((\d{1,2}/\d{1,2}/\d{4})\)'
    
    for match in re.finditer(pattern, outbucket_section):
        name = match.group(1).strip()
        ticker = match.group(2)
        trend = match.group(3)
        date = match.group(4)
        
        # Map ticker if needed
        mapped_ticker = TICKERS.get(ticker, ticker)
        
        outbucket.append({
            'ticker': mapped_ticker,
            'name': name,
            'trend': trend,
            'dateRemoved': date
        })
        
        print(f"   OUTBUCKET: {name} ({mapped_ticker}) - {trend} - {date}")
    
    return outbucket


def extract_risk_ranges_enhanced(text):
    """Enhanced extraction with ticker names and prev close"""
    data = {}
    ts = datetime.now(timezone.utc).isoformat()
    
    # Multi-line pattern to capture:
    # Line 1: TICKER (TREND) BUY SELL PREV
    # Line 2: Full Name (optional)
    
    lines = text.split('\n')
    i = 0
    
    while i < len(lines):
        line = lines[i].strip()
        
        # Skip URLs and empty lines
        if 'http' in line.lower() or '/print' in line or not line:
            i += 1
            continue
        
        # Pattern for main data line: TICKER (TREND) BUY SELL PREV
        pattern = r'^([A-Z0-9/]+)\s+\((BULLISH|BEARISH|NEUTRAL)\)\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)$'
        match = re.match(pattern, line)
        
        if match:
            ticker = match.group(1)
            trend = match.group(2)
            buy = match.group(3).replace(',', '')
            sell = match.group(4).replace(',', '')
            prev = match.group(5).replace(',', '')
            
            # Look ahead for the name on next line
            name = None
            if i + 1 < len(lines):
                next_line = lines[i + 1].strip()
                # Name line doesn't start with a ticker pattern or number
                if (next_line and 
                    not re.match(r'^[A-Z0-9/]+\s+\(', next_line) and 
                    not re.match(r'^\d+', next_line) and
                    'http' not in next_line.lower() and
                    len(next_line) > 2):
                    name = next_line
                    i += 1  # Skip the name line in next iteration
            
            # Map ticker if needed
            mapped_ticker = TICKERS.get(ticker, ticker)
            
            data[mapped_ticker] = {
                'ticker': mapped_ticker,
                'name': name,
                'trend': trend,
                'buyTrade': float(buy),
                'sellTrade': float(sell),
                'prevClose': float(prev),
                'originalName': ticker,
                'ts': ts,
                'index': len(data)  # Track order from PDF
            }
            
            name_display = f" - {name}" if name else ""
            print(f"   {mapped_ticker}: {buy}/{sell} (Prev: {prev}, {trend}){name_display}")
        
        i += 1
    
    return data


def extract_all_risk_range_data(pdf_path):
    """Extract all three sections from Risk Ranges PDF"""
    print(f"\n📄 Reading Risk Ranges PDF: {pdf_path}")
    
    with pdfplumber.open(pdf_path) as pdf:
        text = ""
        for page in pdf.pages:
            text += page.extract_text() + "\n"
    
    print(f"✅ Extracted {len(text)} characters\n")
    
    # Extract all sections
    print("📊 Extracting TREND Changes...")
    trend_changes = extract_trend_changes(text)
    
    print("\n📊 Extracting Risk Ranges...")
    risk_ranges = extract_risk_ranges_enhanced(text)
    
    print("\n📊 Extracting OutBucket...")
    outbucket = extract_outbucket(text)
    
    print(f"\n✅ Extraction Complete:")
    print(f"   Trend Changes: {len(trend_changes)}")
    print(f"   Risk Ranges: {len(risk_ranges)}")
    print(f"   OutBucket: {len(outbucket)}")
    
    return {
        'trendChanges': trend_changes,
        'riskRanges': risk_ranges,
        'outbucket': outbucket
    }


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
        
        s3_key = f"hedgeye-screenshots/{date}/risk-ranges-{date}-{time}.png"
        
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
    """Save enhanced data to DynamoDB"""
    if not data or not data.get('riskRanges'):
        print("\n❌ No data to save")
        return

    print(f"\n💾 Saving to DynamoDB...")

    db = boto3.resource('dynamodb', region_name='us-west-1')
    date = pdf_date if pdf_date else datetime.now(timezone.utc).strftime('%Y-%m-%d')
    ts = datetime.now(timezone.utc).isoformat()

    # Save individual risk ranges (with enhanced data)
    table = db.Table('HedgeyeRiskRanges')
    for ticker, d in data['riskRanges'].items():
        item = {
            'date': date,
            'ticker': ticker,
            'name': d.get('name'),
            'lrr': Decimal(str(d['buyTrade'])),
            'hrr': Decimal(str(d['sellTrade'])),
            'prevClose': Decimal(str(d.get('prevClose', 0))),
            'trend': d['trend'],
            'updatedAt': ts,
            'source': 'hedgeye-pdf',
            'ttl': int(datetime.now(timezone.utc).timestamp() + (730 * 24 * 60 * 60))
        }
        if pdf_s3_key:
            item['pdfSource'] = pdf_s3_key
        table.put_item(Item=item)
    
    print(f"   ✅ {len(data['riskRanges'])} risk ranges saved")

    # Save snapshot with all sections
    snap_table = db.Table('HedgeyeDailySnapshot')
    snapshot_item = {
        'date': date,
        'snapshotType': 'risk-ranges',
        'riskRangeCount': len(data['riskRanges']),
        
        # TREND Changes section
        'trendChanges': [{
            'ticker': tc['ticker'],
            'oldTrend': tc['oldTrend'],
            'newTrend': tc['newTrend'],
            'note': tc.get('note')
        } for tc in data['trendChanges']],
        
        # Enhanced risk ranges data
        'data': {t: {
            'name': d.get('name'),
            'lrr': Decimal(str(d['buyTrade'])),
            'hrr': Decimal(str(d['sellTrade'])),
            'prevClose': Decimal(str(d.get('prevClose', 0))),
            'trend': d['trend'],
            'timestamp': d['ts'],
            'index': d.get('index', 0)
        } for t, d in data['riskRanges'].items()},
        
        # OutBucket section
        'outbucket': [{
            'ticker': ob['ticker'],
            'name': ob['name'],
            'trend': ob['trend'],
            'dateRemoved': ob['dateRemoved']
        } for ob in data['outbucket']],
        
        'scrapedAt': ts,
        'source': 'pdf',
        'ttl': int(datetime.now(timezone.utc).timestamp() + (730 * 24 * 60 * 60))
    }
    if pdf_s3_key:
        snapshot_item['pdfSource'] = pdf_s3_key
    if screenshot_s3_key:
        snapshot_item['screenshotS3Key'] = screenshot_s3_key
    snap_table.put_item(Item=snapshot_item)
    print(f"   ✅ Snapshot saved ({len(data['trendChanges'])} changes, {len(data['outbucket'])} outbucket)")

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
    print("🚀 ENHANCED HEDGEYE RISK RANGES PARSER")
    print("="*70)

    # Extract date from PDF
    pdf_date = extract_date_from_pdf(str(pdf_path))
    if pdf_date:
        print(f"📅 Extracted date from PDF: {pdf_date}")
    else:
        pdf_date = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        print(f"📅 Using current date: {pdf_date}")

    # Extract all data
    data = extract_all_risk_range_data(pdf_path)
    
    # Upload and save
    pdf_s3_key = upload_pdf_to_s3(pdf_path, pdf_date)
    screenshot_s3_key = generate_screenshot(pdf_path, pdf_date)
    save_to_dynamodb(data, pdf_s3_key, pdf_date, screenshot_s3_key)
