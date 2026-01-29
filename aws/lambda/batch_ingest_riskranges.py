#!/usr/bin/env python3
"""
Batch ingest Risk Range PDFs from a directory.
"""

import sys
import os
from pathlib import Path
from datetime import datetime, timezone
import parse_hedgeye_pdf
from date_utils import extract_date_from_pdf

def batch_process(directory_path):
    directory = Path(directory_path)
    if not directory.exists():
        print(f"❌ Directory not found: {directory}")
        return

    files = sorted(list(directory.glob("*.pdf")))
    print(f"Found {len(files)} PDF files in {directory}")

    success_count = 0
    fail_count = 0

    for i, pdf_path in enumerate(files):
        print(f"\n[{i+1}/{len(files)}] Processing {pdf_path.name}...")
        try:
            # logic from parse_hedgeye_pdf main block
            pdf_date = extract_date_from_pdf(str(pdf_path))
            if pdf_date:
                print(f"   📅 Extracted date: {pdf_date}")
            else:
                print("   ⚠️ Could not extract date, skipping to avoid data corruption.")
                fail_count += 1
                continue

            # Extract
            data = parse_hedgeye_pdf.extract_all_risk_range_data(pdf_path)
            
            # Upload (optional, but good for consistency)
            # pdf_s3_key = parse_hedgeye_pdf.upload_pdf_to_s3(pdf_path, pdf_date)
            # screenshot_s3_key = parse_hedgeye_pdf.generate_screenshot(pdf_path, pdf_date)
            # Skipping S3 upload for speed/cost if just backfilling data, implies user has them locally.
            # But user said "uploaded all risk ranges to the folder", so maybe we should upload to S3 too?
            # Let's do it to be safe and complete.
            
            pdf_s3_key = parse_hedgeye_pdf.upload_pdf_to_s3(pdf_path, pdf_date)
            screenshot_s3_key = parse_hedgeye_pdf.generate_screenshot(pdf_path, pdf_date)

            # Save
            parse_hedgeye_pdf.save_to_dynamodb(data, pdf_s3_key, pdf_date, screenshot_s3_key)
            success_count += 1

        except Exception as e:
            print(f"   ❌ Error processing {pdf_path.name}: {e}")
            fail_count += 1

    print(f"\nBatch processing complete. Success: {success_count}, Failed: {fail_count}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 batch_ingest_riskranges.py <directory_path>")
        # Default to the path found earlier if no arg provided
        default_path = "/Users/timsmith/Desktop/dashboard/hedgeye/riskranges"
        if Path(default_path).exists():
             print(f"Using default path: {default_path}")
             batch_process(default_path)
        else:
             sys.exit(1)
    else:
        batch_process(sys.argv[1])
