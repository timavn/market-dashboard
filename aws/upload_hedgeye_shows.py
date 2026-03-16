#!/usr/bin/env python3
"""
Upload Hedgeye Show Summaries (Macro Show & The Call)
Scans local folders for the latest PDF, parses positions, and stores in DynamoDB.

Default folders:
  ~/Desktop/hedgeye/macroshow/  -> The Macro Show
  ~/Desktop/hedgeye/thecall/    -> The Call @ Hedgeye

Usage:
  python3 upload_hedgeye_shows.py                  # Process both folders
  python3 upload_hedgeye_shows.py --macro-only      # Process Macro Show only
  python3 upload_hedgeye_shows.py --call-only       # Process The Call only
  python3 upload_hedgeye_shows.py --macro-dir /path  # Custom macro folder
  python3 upload_hedgeye_shows.py --call-dir /path   # Custom call folder
"""

import sys
import os
import glob
import argparse
from pathlib import Path

# Add lambda dir to path so we can import the parsers
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'lambda'))

from parse_macro_show import extract_macro_show, upload_pdf_to_s3 as upload_macro_pdf, save_to_dynamodb as save_macro
from parse_the_call import extract_the_call, upload_pdf_to_s3 as upload_call_pdf, save_to_dynamodb as save_call
from date_utils import extract_date_from_pdf


DEFAULT_MACRO_DIR = os.path.expanduser('~/Desktop/dashboard/hedgeye/macroshow')
DEFAULT_CALL_DIR = os.path.expanduser('~/Desktop/dashboard/hedgeye/thecall')


def find_latest_pdf(directory):
    """Find the most recently modified PDF in a directory"""
    pdf_files = glob.glob(os.path.join(directory, '*.pdf'))
    if not pdf_files:
        return None
    return max(pdf_files, key=os.path.getmtime)


def process_macro_show(macro_dir):
    """Process the latest Macro Show PDF"""
    print("\n" + "=" * 70)
    print("🚀 MACRO SHOW")
    print("=" * 70)

    if not os.path.isdir(macro_dir):
        print(f"❌ Directory not found: {macro_dir}")
        return False

    pdf_path = find_latest_pdf(macro_dir)
    if not pdf_path:
        print(f"❌ No PDF files found in {macro_dir}")
        return False

    print(f"📁 Latest PDF: {pdf_path}")

    pdf_date = extract_date_from_pdf(pdf_path)
    if not pdf_date:
        print("❌ Could not extract date from PDF")
        return False
    print(f"📅 PDF Date: {pdf_date}")

    data = extract_macro_show(pdf_path)
    if not data:
        print("❌ Failed to extract positions")
        return False

    pdf_s3_key = upload_macro_pdf(pdf_path, pdf_date)
    save_macro(data, pdf_s3_key, pdf_date)
    return True


def process_the_call(call_dir):
    """Process the latest The Call PDF"""
    print("\n" + "=" * 70)
    print("🚀 THE CALL @ HEDGEYE")
    print("=" * 70)

    if not os.path.isdir(call_dir):
        print(f"❌ Directory not found: {call_dir}")
        return False

    pdf_path = find_latest_pdf(call_dir)
    if not pdf_path:
        print(f"❌ No PDF files found in {call_dir}")
        return False

    print(f"📁 Latest PDF: {pdf_path}")

    pdf_date = extract_date_from_pdf(pdf_path)
    if not pdf_date:
        print("❌ Could not extract date from PDF")
        return False
    print(f"📅 PDF Date: {pdf_date}")

    data = extract_the_call(pdf_path)
    if not data:
        print("❌ Failed to extract positions")
        return False

    pdf_s3_key = upload_call_pdf(pdf_path, pdf_date)
    save_call(data, pdf_s3_key, pdf_date)
    return True


def main():
    parser = argparse.ArgumentParser(
        description='Upload Hedgeye Macro Show & The Call summaries to AWS'
    )
    parser.add_argument('--macro-dir', default=DEFAULT_MACRO_DIR,
                        help=f'Macro Show PDF directory (default: {DEFAULT_MACRO_DIR})')
    parser.add_argument('--call-dir', default=DEFAULT_CALL_DIR,
                        help=f'The Call PDF directory (default: {DEFAULT_CALL_DIR})')
    parser.add_argument('--macro-only', action='store_true',
                        help='Process Macro Show only')
    parser.add_argument('--call-only', action='store_true',
                        help='Process The Call only')

    args = parser.parse_args()

    print("\n" + "=" * 70)
    print("📋 HEDGEYE SHOW UPLOADER")
    print("=" * 70)

    results = {}

    if not args.call_only:
        results['macro'] = process_macro_show(args.macro_dir)

    if not args.macro_only:
        results['call'] = process_the_call(args.call_dir)

    # Summary
    print("\n" + "=" * 70)
    print("📊 SUMMARY")
    print("=" * 70)
    for name, success in results.items():
        status = "✅ SUCCESS" if success else "❌ FAILED"
        label = "Macro Show" if name == "macro" else "The Call"
        print(f"   {status} - {label}")
    print()


if __name__ == '__main__':
    main()
