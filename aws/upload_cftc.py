#!/usr/bin/env python3
"""
Upload CFTC Non-Commercial Net Long Positioning PDF
Scans local folder for the latest PDF, parses with Textract, and stores in DynamoDB.

Default folder:
  ~/Desktop/dashboard/hedgeye/cftc/

Usage:
  python3 upload_cftc.py                    # Process latest PDF in default folder
  python3 upload_cftc.py --dir /path         # Process latest PDF in custom folder
  python3 upload_cftc.py --file /path/to.pdf  # Process specific PDF file
"""

import sys
import os
import glob
import argparse
from pathlib import Path

# Add lambda dir to path so we can import the parser
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'lambda'))

from parse_cftc import extract_cftc_data, save_to_dynamodb
from date_utils import extract_date_from_pdf

# Import helper functions from parse_bitcoin_tracker for S3 upload
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'lambda'))

DEFAULT_CFTC_DIR = os.path.expanduser('~/Desktop/dashboard/hedgeye/cftc')


def find_latest_pdf(directory):
    """Find the most recently modified PDF in a directory"""
    pdf_files = glob.glob(os.path.join(directory, '*.pdf'))
    if not pdf_files:
        return None
    return max(pdf_files, key=os.path.getmtime)


def upload_pdf_to_s3(pdf_path, pdf_date=None):
    """Upload original PDF to S3 for audit trail"""
    print("\n☁️  Uploading PDF to S3...")
    
    import boto3
    from datetime import datetime, timezone
    
    s3 = boto3.client('s3', region_name='us-west-1')
    date = pdf_date if pdf_date else datetime.now(timezone.utc).strftime('%Y-%m-%d')
    time = datetime.now(timezone.utc).strftime('%H%M%S')
    
    s3_key = f"hedgeye-pdfs/{date}/cftc-positioning-{date}-{time}.pdf"
    
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


def process_cftc(cftc_dir=None, pdf_file=None):
    """Process the latest CFTC PDF"""
    print("\n" + "=" * 70)
    print("🚀 CFTC NON-COMMERCIAL NET LONG POSITIONING")
    print("=" * 70)
    
    # Determine PDF path
    if pdf_file:
        pdf_path = pdf_file
        if not os.path.isfile(pdf_path):
            print(f"❌ File not found: {pdf_path}")
            return False
    else:
        directory = cftc_dir if cftc_dir else DEFAULT_CFTC_DIR
        if not os.path.isdir(directory):
            print(f"❌ Directory not found: {directory}")
            return False
        
        pdf_path = find_latest_pdf(directory)
        if not pdf_path:
            print(f"❌ No PDF files found in {directory}")
            return False
    
    print(f"📁 PDF: {pdf_path}")
    
    # Extract date from PDF
    pdf_date = extract_date_from_pdf(pdf_path)
    if not pdf_date:
        print("❌ Could not extract date from PDF")
        return False
    print(f"📅 PDF Date: {pdf_date}")
    
    # Extract data using Textract
    data = extract_cftc_data(pdf_path)
    if not data or not data.get('metrics'):
        print("❌ Failed to extract CFTC data")
        return False
    
    # Upload PDF to S3
    pdf_s3_key = upload_pdf_to_s3(pdf_path, pdf_date)

    # Save to DynamoDB
    try:
        save_to_dynamodb(data, pdf_s3_key, pdf_date)
        print("   ✅ DynamoDB save completed")
        return True
    except Exception as e:
        print(f"   ❌ DynamoDB save failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def main():
    parser = argparse.ArgumentParser(
        description='Upload CFTC Non-Commercial Net Long Positioning PDF to AWS'
    )
    parser.add_argument('--dir', default=DEFAULT_CFTC_DIR,
                        help=f'CFTC PDF directory (default: {DEFAULT_CFTC_DIR})')
    parser.add_argument('--file', '-f',
                        help='Specific PDF file to process')
    
    args = parser.parse_args()
    
    print("\n" + "=" * 70)
    print("📋 CFTC UPLOADER")
    print("=" * 70)
    
    success = process_cftc(args.dir, args.file)
    
    # Summary
    print("\n" + "=" * 70)
    print("📊 SUMMARY")
    print("=" * 70)
    status = "✅ SUCCESS" if success else "❌ FAILED"
    print(f"   {status} - CFTC Non-Commercial Net Long Positioning")
    print()


if __name__ == '__main__':
    main()
