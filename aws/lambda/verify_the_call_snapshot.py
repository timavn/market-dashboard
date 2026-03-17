#!/usr/bin/env python3
"""
Dev-only helper to verify that HedgeyeDailySnapshot data for 'the-call'
matches what the current parse_the_call.py implementation would extract
from the archived PDF.

Usage:
  python3 verify_the_call_snapshot.py --date 2026-03-16

This will:
  1. Fetch the HedgeyeDailySnapshot item for snapshotType 'the-call'
     and the given date.
  2. Use the pdfSource field on that item to download the original PDF
     from S3.
  3. Re-run extract_the_call() against the downloaded PDF.
  4. Print a side-by-side comparison of longs/shorts/neutrals.
"""

import argparse
import os
import sys
import tempfile
from datetime import datetime, timezone

import boto3

# Ensure local imports work when running from repo root or lambda dir
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
  sys.path.insert(0, CURRENT_DIR)

from parse_the_call import extract_the_call  # noqa: E402


def fetch_snapshot(date_str):
  """Fetch HedgeyeDailySnapshot item for 'the-call' on a specific date."""
  db = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-west-1"))
  table = db.Table("HedgeyeDailySnapshot")

  resp = table.get_item(
    Key={
      "date": date_str,
      "snapshotType": "the-call",
    }
  )
  item = resp.get("Item")
  if not item:
    print(f"❌ No HedgeyeDailySnapshot item found for date={date_str}, snapshotType='the-call'")
  return item


def download_pdf_from_s3(pdf_s3_key):
  """Download the archived PDF for verification and return local path."""
  bucket = os.environ.get("HEDGEYE_S3_BUCKET", "market-dashboard-csv-data")
  s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-west-1"))

  fd, temp_path = tempfile.mkstemp(suffix=".pdf")
  os.close(fd)

  print(f"📥 Downloading PDF s3://{bucket}/{pdf_s3_key} → {temp_path}")
  s3.download_file(bucket, pdf_s3_key, temp_path)
  return temp_path


def compare_lists(label, stored, parsed):
  """Print comparison of two string lists."""
  stored_set = set(stored or [])
  parsed_set = set(parsed or [])

  only_stored = sorted(stored_set - parsed_set)
  only_parsed = sorted(parsed_set - stored_set)

  print(f"\n▶ {label}")
  print(f"   Stored ({len(stored_set)}): {', '.join(sorted(stored_set)) or '∅'}")
  print(f"   Parsed ({len(parsed_set)}): {', '.join(sorted(parsed_set)) or '∅'}")

  if not only_stored and not only_parsed:
    print("   ✅ MATCH")
  else:
    if only_stored:
      print(f"   ⚠️  Only in DynamoDB: {', '.join(only_stored)}")
    if only_parsed:
      print(f"   ⚠️  Only in parsed PDF: {', '.join(only_parsed)}")


def main():
  parser = argparse.ArgumentParser(description="Verify 'the-call' snapshot vs parser output")
  parser.add_argument(
    "--date",
    required=True,
    help="Snapshot date in YYYY-MM-DD (e.g. 2026-03-16)",
  )
  args = parser.parse_args()

  date_str = args.date
  print("=" * 70)
  print(f"VERIFYING THE CALL SNAPSHOT FOR {date_str}")
  print("=" * 70)

  item = fetch_snapshot(date_str)
  if not item:
    sys.exit(1)

  data = item.get("data") or {}
  stored_longs = data.get("longs") or []
  stored_shorts = data.get("shorts") or []
  stored_neutrals = data.get("neutrals") or []
  pdf_source = item.get("pdfSource")

  print(f"\n📄 Snapshot metadata:")
  print(f"   date:         {item.get('date')}")
  print(f"   snapshotType: {item.get('snapshotType')}")
  print(f"   scrapedAt:    {item.get('scrapedAt')}")
  print(f"   pdfSource:    {pdf_source or '∅'}")

  if not pdf_source:
    print("\n❌ pdfSource not set on snapshot item; cannot re-parse original PDF.")
    compare_lists("LONGS", stored_longs, stored_longs)
    compare_lists("SHORTS", stored_shorts, stored_shorts)
    compare_lists("NEUTRALS", stored_neutrals, stored_neutrals)
    sys.exit(1)

  temp_pdf_path = download_pdf_from_s3(pdf_source)

  try:
    parsed = extract_the_call(temp_pdf_path, s3_key=pdf_source) or {}
  finally:
    try:
      os.remove(temp_pdf_path)
    except OSError:
      pass

  parsed_longs = parsed.get("longs") or []
  parsed_shorts = parsed.get("shorts") or []
  parsed_neutrals = parsed.get("neutrals") or []

  print("\n📊 Comparison:")
  compare_lists("LONGS", stored_longs, parsed_longs)
  compare_lists("SHORTS", stored_shorts, parsed_shorts)
  compare_lists("NEUTRALS", stored_neutrals, parsed_neutrals)

  print("\nDone.")


if __name__ == "__main__":
  main()

