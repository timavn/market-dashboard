#!/usr/bin/env python3
"""
Parse Hedgeye 'The Call @ Hedgeye' Summary PDF
Extracts LONGS/SHORTS from the HEDGEYE POSITIONS section

Usage: python3 parse_the_call.py <path_to_pdf>
"""

import re
import sys
import boto3
from datetime import datetime, timezone
from pathlib import Path
from date_utils import extract_date_from_pdf


def _extract_section_text(text, label, stop_labels):
    """Extract free-form text under a section label until the next known label."""
    stop_pattern = "|".join(re.escape(item) for item in stop_labels)
    pattern = rf"{re.escape(label)}\s*[:\-]\s*(.+?)(?=\n\s*(?:{stop_pattern})\b|$)"
    match = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
    return match.group(1).strip() if match else ""


def _extract_symbols(raw_text):
    """Extract robust symbol-like entries from mixed free-form position text."""
    if not raw_text:
        return []

    ignored_tokens = {
        "LONG", "LONGS", "SHORT", "SHORTS", "BULLISH", "BEARISH",
        "TOP", "POSITIONING", "MAIN", "SUMMARY", "NEUTRAL"
    }

    normalized_text = re.sub(r"\s*\([^)]*\)", "", raw_text)
    items = []
    for chunk in re.split(r"[;,\n]+", normalized_text):
        cleaned = chunk.strip().strip(".:")
        if not cleaned:
            continue

        slash_parts = [part.strip() for part in cleaned.split("/") if part.strip()]
        if len(slash_parts) > 1:
            right = slash_parts[-1]
            if re.fullmatch(r"[A-Z0-9]{2,8}", right):
                items.append(right)
                continue

        explicit_symbols = re.findall(r"\b[A-Z]{2,8}\b", cleaned)
        if explicit_symbols:
            items.extend(token for token in explicit_symbols if token not in ignored_tokens)
            continue

        fallback_words = re.findall(r"[A-Za-z]+", cleaned)
        if fallback_words:
            candidate = fallback_words[0].upper()
            if candidate not in ignored_tokens:
                items.append(candidate)

    return list(dict.fromkeys(items))


def extract_the_call(pdf_path, s3_key=None):
    """Extract LONGS/SHORTS positions from The Call summary PDF"""
    import pdfplumber

    print(f"\n📄 Reading The Call PDF: {pdf_path}")

    ts = datetime.now(timezone.utc).isoformat()
    longs = []
    shorts = []
    neutrals = []

    with pdfplumber.open(pdf_path) as pdf:
        if len(pdf.pages) < 1:
            print("❌ PDF has no pages")
            return None

        # Only need first page for the positions box
        text = pdf.pages[0].extract_text() or ""

        # Also check page 2 in case positions span pages
        if len(pdf.pages) > 1:
            text += "\n" + (pdf.pages[1].extract_text() or "")

    # Extract LONGS tickers - pattern: "LONGS: AVO, CZR, MGM, CCL, ULTA, BLDR, META"
    longs_raw = _extract_section_text(
        text,
        "LONGS",
        ["SHORTS", "NEUTRAL", "TOP", "Positioning", "CLICK", "MAIN SUMMARY"]
    )
    if longs_raw:
        longs = _extract_symbols(longs_raw)
        print(f"   LONGS: {', '.join(longs)}")
    else:
        print("   ⚠️  Could not find LONGS section")

    # Extract SHORTS tickers - pattern: "SHORTS: ADBE"
    shorts_raw = _extract_section_text(
        text,
        "SHORTS",
        ["NEUTRAL", "TOP", "Positioning", "CLICK", "MAIN SUMMARY"]
    )
    if shorts_raw:
        shorts = _extract_symbols(shorts_raw)
        print(f"   SHORTS: {', '.join(shorts)}")
    else:
        print("   ⚠️  Could not find SHORTS section")

    neutral_raw = _extract_section_text(
        text,
        "NEUTRAL",
        ["TOP", "Positioning", "CLICK", "MAIN SUMMARY"]
    )
    if neutral_raw:
        neutrals = _extract_symbols(neutral_raw)
        print(f"   NEUTRAL: {', '.join(neutrals)}")
    else:
        print("   ⚠️  Could not find NEUTRAL section")

    if not longs and not shorts and not neutrals:
        print("❌ No positions extracted")
        return None

    return {
        'longs': longs,
        'shorts': shorts,
        'neutrals': neutrals,
        'timestamp': ts,
        'source': 'the-call-pdf'
    }


def upload_pdf_to_s3(pdf_path, pdf_date=None):
    """Upload original PDF to S3 for archival"""
    print("\n☁️  Uploading PDF to S3...")

    s3 = boto3.client('s3', region_name='us-west-1')
    date = pdf_date or datetime.now(timezone.utc).strftime('%Y-%m-%d')
    time = datetime.now(timezone.utc).strftime('%H%M%S')

    s3_key = f"hedgeye-pdfs/{date}/the-call-{date}-{time}.pdf"

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
    """Save The Call positions to DynamoDB HedgeyeDailySnapshot"""
    if not data:
        print("\n❌ No data to save")
        return

    if not pdf_date:
        print("❌ valid pdf_date is required to save to DynamoDB")
        return

    longs = data.get('longs', [])
    shorts = data.get('shorts', [])
    neutrals = data.get('neutrals', [])
    total = len(longs) + len(shorts) + len(neutrals)

    print(f"\n💾 Saving {total} positions to DynamoDB (longs: {len(longs)}, shorts: {len(shorts)}, neutrals: {len(neutrals)})...")

    db = boto3.resource('dynamodb', region_name='us-west-1')
    ts = datetime.now(timezone.utc).isoformat()

    snap_table = db.Table('HedgeyeDailySnapshot')
    snapshot_item = {
        'date': pdf_date,
        'snapshotType': 'the-call',
        'data': {
            'longs': longs,
            'shorts': shorts,
            'neutrals': neutrals
        },
        'positionCount': total,
        'scrapedAt': ts,
        'source': 'pdf',
        'ttl': int(datetime.now(timezone.utc).timestamp() + (730 * 24 * 60 * 60))
    }

    if pdf_s3_key:
        snapshot_item['pdfSource'] = pdf_s3_key

    snap_table.put_item(Item=snapshot_item)
    print(f"   ✅ Saved to HedgeyeDailySnapshot (the-call)")
    print(f"      Longs:  {', '.join(longs)}")
    print(f"      Shorts: {', '.join(shorts)}")
    print(f"      Neutral: {', '.join(neutrals)}")
    print("\n🎉 SUCCESS! The Call data saved.\n")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 parse_the_call.py <path_to_pdf>")
        sys.exit(1)

    pdf_path = Path(sys.argv[1])
    if not pdf_path.exists():
        print(f"❌ File not found: {pdf_path}")
        sys.exit(1)

    print("\n" + "=" * 70)
    print("🚀 THE CALL PARSER")
    print("=" * 70)

    pdf_date = extract_date_from_pdf(pdf_path)
    print(f"📅 PDF Date: {pdf_date}\n")

    data = extract_the_call(pdf_path)

    pdf_s3_key = upload_pdf_to_s3(pdf_path, pdf_date)
    save_to_dynamodb(data, pdf_s3_key, pdf_date)
