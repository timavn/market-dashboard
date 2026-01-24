#!/usr/bin/env python3
"""
Batch process Hedgeye PDFs from Downloads folder
Automatically detects PDF type and routes to appropriate processor
Can process multiple files or single file
"""

import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import pdfplumber

# Import individual processors
from parse_hedgeye_pdf import extract_all_risk_range_data as extract_risk_ranges, save_to_dynamodb as save_risk_ranges
from parse_bitcoin_tracker import extract_bitcoin_tracker, save_to_dynamodb as save_bitcoin_tracker
from parse_early_look import extract_early_look, save_to_dynamodb as save_early_look
from parse_momo_tracker import extract_momo_tracker, save_to_dynamodb as save_momo_tracker
from parse_portfolio_solutions import extract_portfolio_solutions, save_to_dynamodb as save_portfolio_solutions
from parse_signal_strength import extract_signal_strength, save_to_dynamodb as save_signal_strength
from date_utils import extract_date_from_pdf
import boto3

DOWNLOADS_DIR = Path.home() / "Desktop" / "hedgeye"

# PDF type detection patterns (based on first page content)
PDF_TYPES = {
    'risk-ranges': {
        'patterns': ['HOW TO USE RISK RANGE SIGNALS', 'BUY TRADE', 'SELL TRADE', 'BULLISH TREND', 'BEARISH TREND'],
        'title_match': 'HOW TO USE RISK RANGE SIGNALS',  # Unique text on page 1
        's3_folder': 'risk-ranges',
        'processor': 'risk_ranges'
    },
    'bitcoin-trend-tracker': {
        'patterns': ['CRYPTO QUANT', 'BTC', 'AVAX', 'BLOK', 'ZEC'],
        'title_match': 'CRYPTO QUANT',
        's3_folder': 'bitcoin-trend-tracker',
        'processor': 'bitcoin_tracker'
    },
    'early-look': {
        'patterns': ['THE BIG PICTURE', 'KEY TAKEAWAYS', 'MACRO GRIND', 'QUAD'],
        'title_match': 'THE BIG PICTURE',  # Unique text on early look
        's3_folder': 'early-look',
        'processor': 'early_look'
    },
    'momo-tracker': {
        'patterns': ['MOMO TRACKER', 'MOMENTUM TRACKER', 'HEDGEYE MOMENTUM TRACKER', 'FUNDAMENTAL SNAPSHOT', 'PERFORMANCE'],
        'title_match': 'MOMO TRACKER',
        's3_folder': 'momo-tracker',
        'processor': 'momo_tracker'
    },
    'portfolio-solutions': {
        'patterns': ['PORTFOLIO SOLUTIONS', 'ETF RE-RANK', 'TOP MOVERS', 'BOTTOM MOVERS', 'MACRO ETFS BY RANK'],
        'title_match': 'ETF RE-RANK',
        's3_folder': 'portfolio-solutions',
        'processor': 'portfolio_solutions'
    },
    'signal-strength': {
        'patterns': ['SIGNAL STRENGTH', 'STOCKS:', 'ADDED:', 'REMOVED:'],
        'title_match': 'SIGNAL STRENGTH STOCKS',
        's3_folder': 'signal-strength',
        'processor': 'signal_strength'
    }
}

# Folder mapping for explicit type enforcement
FOLDER_MAPPING = {
    'riskranges': 'risk-ranges',
    'earlylook': 'early-look',
    'bitcointracker': 'bitcoin-trend-tracker',
    'momotracker': 'momo-tracker',
    'signalstrength': 'signal-strength',
    'portfoliosolutions': 'portfolio-solutions'
}

def detect_pdf_type(pdf_path, forced_type=None):
    """Detect PDF type by scanning first page content, or use forced type"""
    print(f"🔍 Detecting type for: {pdf_path.name}")

    # If forced type (from folder) is provided, use it
    if forced_type:
        config = PDF_TYPES.get(forced_type)
        if config:
            print(f"   ✅ Using forced type: {forced_type} (from folder)")
            return forced_type, config
        else:
            print(f"   ⚠️  Unknown forced type: {forced_type}")

    try:
        with pdfplumber.open(pdf_path) as pdf:
            # Get first page text
            first_page = pdf.pages[0].extract_text().upper()

            # Try exact title match first (most reliable)
            for pdf_type, config in PDF_TYPES.items():
                if config['title_match'] in first_page:
                    print(f"   ✅ Detected: {pdf_type} (title match)")
                    return pdf_type, config

            # Fall back to pattern matching
            best_match = None
            best_score = 0

            for pdf_type, config in PDF_TYPES.items():
                matches = sum(1 for pattern in config['patterns'] if pattern in first_page)
                if matches > best_score:
                    best_score = matches
                    best_match = (pdf_type, config)

            if best_match and best_score >= 2:
                print(f"   ✅ Detected: {best_match[0]} (pattern match: {best_score} hits)")
                return best_match

            # If inside a subfolder but detection failed, still default to forced_type if available?
            # We already handled forced_type above.
            
            print(f"   ⚠️  Unknown PDF type, defaulting to 'signal-strength'")
            return 'signal-strength', PDF_TYPES['signal-strength']

    except Exception as e:
        print(f"   ❌ Error detecting type: {e}")
        return None, None

def upload_pdf_to_s3(pdf_path, pdf_type_folder):
    """Upload PDF to S3 in appropriate folder"""
    s3 = boto3.client('s3', region_name='us-west-1')
    date = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    time = datetime.now(timezone.utc).strftime('%H%M%S')

    # S3 key: hedgeye/TYPE/YYYY-MM-DD/TYPE-YYYY-MM-DD-HHMMSS.pdf
    s3_key = f"hedgeye/{pdf_type_folder}/{date}/{pdf_type_folder}-{date}-{time}.pdf"

    try:
        s3.upload_file(
            str(pdf_path),
            'market-dashboard-csv-data',
            s3_key,
            ExtraArgs={'ContentType': 'application/pdf'}
        )
        print(f"   ✅ Uploaded: s3://.../hedgeye/{pdf_type_folder}/{date}/...")
        return s3_key
    except Exception as e:
        print(f"   ❌ Upload failed: {e}")
        return None

def process_pdf(pdf_path, forced_type=None):
    """Process a single PDF file"""
    print(f"\n{'='*70}")
    print(f"📄 Processing: {pdf_path.name}")
    print('='*70)

    # Detect type
    pdf_type, config = detect_pdf_type(pdf_path, forced_type)
    if not pdf_type:
        return False

    # Extract publication date from PDF
    pdf_date = extract_date_from_pdf(pdf_path)
    print(f"   📅 PDF Date: {pdf_date}")

    # Upload to S3
    s3_key = upload_pdf_to_s3(pdf_path, config['s3_folder'])
    if not s3_key:
        return False

    # Process based on type
    if config['processor'] == 'risk_ranges':
        print("\n📊 Extracting risk range data...")
        data = extract_risk_ranges(pdf_path)
        if data:
            # Generate screenshot
            from parse_hedgeye_pdf import generate_screenshot
            screenshot_s3_key = generate_screenshot(pdf_path, pdf_date)
            
            save_risk_ranges(data, s3_key, pdf_date, screenshot_s3_key)
            return True

    elif config['processor'] == 'bitcoin_tracker':
        print("\n₿  Extracting Bitcoin Trend Tracker data...")
        data = extract_bitcoin_tracker(pdf_path, s3_key)
        if data:
            save_bitcoin_tracker(data, s3_key, pdf_date)
            return True

    elif config['processor'] == 'early_look':
        print("\n🌅 Extracting Early Look data...")
        data = extract_early_look(pdf_path)
        if data:
            save_early_look(data, s3_key, pdf_date)
            return True

    elif config['processor'] == 'momo_tracker':
        print("\n📈 Extracting Momo Tracker data...")
        data = extract_momo_tracker(pdf_path, s3_key)
        if data:
            save_momo_tracker(data, s3_key, pdf_date)
            return True

    elif config['processor'] == 'portfolio_solutions':
        print("\n💼 Extracting Portfolio Solutions data...")
        data = extract_portfolio_solutions(pdf_path, s3_key)
        if data:
            save_portfolio_solutions(data, s3_key, pdf_date)
            return True

    elif config['processor'] == 'signal_strength':
        print("\n🎯 Extracting Signal Strength data...")
        data = extract_signal_strength(pdf_path, s3_key)
        if data:
            save_signal_strength(data, s3_key, pdf_date)
            return True

    return False

def find_new_hedgeye_pdfs():
    """Find all PDFs in Downloads/hedgeye folder and subfolders from the last 7 days"""
    today = datetime.now().date()
    pdfs = [] # List of tuples (path, forced_type)

    print(f"Scanning for PDFs from the last 7 days...")

    # Helper to check if file is recent
    def is_recent(file_path):
        mtime = datetime.fromtimestamp(file_path.stat().st_mtime).date()
        days_diff = (today - mtime).days
        return 0 <= days_diff <= 7

    # 1. Check root folder (Auto-detect)
    print(f"Scanning root: {DOWNLOADS_DIR}")
    if DOWNLOADS_DIR.exists():
        for pdf_file in DOWNLOADS_DIR.glob("*.pdf"):
            if is_recent(pdf_file):
                pdfs.append((pdf_file, None))

    # 2. Check subfolders (Forced type)
    for folder_name, pdf_type in FOLDER_MAPPING.items():
        subfolder = DOWNLOADS_DIR / folder_name
        if subfolder.exists():
            print(f"Scanning subfolder: {subfolder}")
            for pdf_file in subfolder.glob("*.pdf"):
                if is_recent(pdf_file):
                    pdfs.append((pdf_file, pdf_type))

    # Sort by time
    return sorted(pdfs, key=lambda p: p[0].stat().st_mtime)

def main():
    print("\n" + "="*70)
    print("🚀 HEDGEYE BATCH PDF PROCESSOR")
    print("="*70)

    # Check if specific file provided
    if len(sys.argv) > 1:
        pdf_path = Path(sys.argv[1])
        if not pdf_path.exists():
            print(f"\n❌ File not found: {pdf_path}")
            return
        
        # Check if file is in a mapped folder to infer forced_type
        forced_type = None
        for folder_name, type_key in FOLDER_MAPPING.items():
            if folder_name in str(pdf_path):
                forced_type = type_key
                break

        pdfs = [(pdf_path, forced_type)]
        print(f"\n📋 Processing 1 file: {pdf_path.name}")
    else:
        # Find all Hedgeye PDFs from today
        pdfs = find_new_hedgeye_pdfs()
        if not pdfs:
            print(f"\n❌ No PDFs found in {DOWNLOADS_DIR} (or subfolders) from today")
            print(f"   Place files in:")
            print(f"   - {DOWNLOADS_DIR}")
            print(f"   - {DOWNLOADS_DIR}/earlylook")
            print(f"   - {DOWNLOADS_DIR}/riskranges")
            print(f"   - etc...")
            return

        print(f"\n📋 Found {len(pdfs)} Hedgeye PDF(s) from today:")
        for pdf, ftype in pdfs:
            type_label = f" (Type: {ftype})" if ftype else " (Auto-detect)"
            print(f"   • {pdf.name}{type_label}")

    # Process each PDF
    print(f"\n{'='*70}\n")
    processed = 0
    failed = 0

    for pdf, forced_type in pdfs:
        success = process_pdf(pdf, forced_type)
        if success:
            processed += 1
        else:
            failed += 1

    # Summary
    print(f"\n{'='*70}")
    print("📊 SUMMARY")
    print('='*70)
    print(f"   ✅ Processed: {processed}")
    if failed > 0:
        print(f"   ❌ Failed: {failed}")
    print("\n🎉 Done! Check your S3 bucket and dashboard.\n")

if __name__ == '__main__':
    main()
