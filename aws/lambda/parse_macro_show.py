#!/usr/bin/env python3
"""
Parse Hedgeye Macro Show Summary PDF
Extracts BULLISH/BEARISH positions from the TL;DR section
Maps BULLISH -> longs, BEARISH -> shorts for dashboard consistency

Usage: python3 parse_macro_show.py <path_to_pdf>
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


def _split_exact_items(raw_text):
    """Split section text into human-readable position items, preserving wording."""
    if not raw_text:
        return []

    # Preserve actual newlines; only normalize spaces/tabs.
    normalized_text = re.sub(r"[ \t]+", " ", raw_text).strip()
    if not normalized_text:
        return []

    # Some extracted PDFs contain literal "\n" sequences in words (e.g. "Germa\ny").
    # Repair those when they clearly appear inside words; treat remaining "\n" as delimiters.
    normalized_text = re.sub(r"(?<=[A-Za-z])\\n(?=[A-Za-z])", "n", normalized_text)
    normalized_text = re.sub(r"(?<=[A-Za-z])\\n(?=\s|$|[;:,.])", "n", normalized_text)
    normalized_text = normalized_text.replace("\\n", "\n")

    # Macro Show typically uses semicolons; fall back to commas/newlines when needed.
    if ";" in normalized_text:
        chunks = [part.strip() for part in normalized_text.split(";")]
    else:
        chunks = [part.strip() for part in re.split(r"[,\n]+", normalized_text)]

    items = []
    for chunk in chunks:
        cleaned = chunk.strip()
        if not cleaned:
            continue

        # Remove bullet prefixing and trailing punctuation while preserving inner text.
        cleaned = re.sub(r"^[•\-]+\s*", "", cleaned).strip().strip(" .;:")
        if not cleaned:
            continue

        items.append(cleaned)

    # De-duplicate while preserving order.
    return list(dict.fromkeys(items))


def _extract_main_summary(text):
    match = re.search(
        r"MAIN SUMMARY\s*:?\s*(.+?)(?=\n\s*(?:CLICK|Watch|Disclaimer|Copyright)\b|$)",
        text,
        re.IGNORECASE | re.DOTALL,
    )
    return re.sub(r"\s+", " ", match.group(1)).strip()[:40000] if match else ""


def extract_macro_show(pdf_path, s3_key=None):
    """Extract BULLISH/BEARISH positions from Macro Show summary PDF"""
    import pdfplumber

    print(f"\n📄 Reading Macro Show PDF: {pdf_path}")

    ts = datetime.now(timezone.utc).isoformat()
    longs = []
    shorts = []
    neutrals = []

    with pdfplumber.open(pdf_path) as pdf:
        if len(pdf.pages) < 1:
            print("❌ PDF has no pages")
            return None

        # Only need first page for the TL;DR section
        text = pdf.pages[0].extract_text() or ""

        # Also check page 2 in case TL;DR spans pages
        if len(pdf.pages) > 1:
            text += "\n" + (pdf.pages[1].extract_text() or "")

    # Extract BULLISH tickers
    bullish_raw = _extract_section_text(
        text,
        "BULLISH",
        ["BEARISH", "The summary", "CLICK", "MAIN SUMMARY", "TOP-LINE SETUP"]
    )
    if bullish_raw:
        longs = _split_exact_items(bullish_raw)
        print(f"   BULLISH (longs): {', '.join(longs)}")
    else:
        print("   ⚠️  Could not find BULLISH section")

    # Extract BEARISH tickers
    bearish_raw = _extract_section_text(
        text,
        "BEARISH",
        ["The summary", "CLICK", "MAIN SUMMARY", "TOP-LINE SETUP"]
    )
    if bearish_raw:
        shorts = _split_exact_items(bearish_raw)
        print(f"   BEARISH (shorts): {', '.join(shorts)}")
    else:
        print("   ⚠️  Could not find BEARISH section")

    neutral_raw = _extract_section_text(
        text,
        "NEUTRAL",
        ["The summary", "CLICK", "MAIN SUMMARY", "TOP-LINE SETUP"]
    )
    if neutral_raw:
        neutrals = _split_exact_items(neutral_raw)
        print(f"   NEUTRAL: {', '.join(neutrals)}")
    else:
        print("   ℹ️  No NEUTRAL section found")

    if not longs and not shorts and not neutrals:
        print("❌ No positions extracted")
        return None

    return {
        'longs': longs,
        'shorts': shorts,
        'neutrals': neutrals,
        'rawLongsText': bullish_raw,
        'rawShortsText': bearish_raw,
        'rawNeutralText': neutral_raw,
        'summary': _extract_main_summary(text),
        'bodyText': text[:40000],
        'timestamp': ts,
        'source': 'macro-show-pdf'
    }


def upload_pdf_to_s3(pdf_path, pdf_date=None):
    """Upload original PDF to S3 for archival"""
    print("\n☁️  Uploading PDF to S3...")

    s3 = boto3.client('s3', region_name='us-west-1')
    date = pdf_date or datetime.now(timezone.utc).strftime('%Y-%m-%d')
    time = datetime.now(timezone.utc).strftime('%H%M%S')

    s3_key = f"hedgeye-pdfs/{date}/macro-show-{date}-{time}.pdf"

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
    """Save Macro Show positions to DynamoDB HedgeyeDailySnapshot"""
    if not data:
        print("\n❌ No data to save")
        return

    if not pdf_date:
        print("❌ valid pdf_date is required to save to DynamoDB")
        return

    longs = data.get('longs', [])
    shorts = data.get('shorts', [])
    neutrals = data.get('neutrals', [])
    raw_longs_text = data.get('rawLongsText', '')
    raw_shorts_text = data.get('rawShortsText', '')
    raw_neutral_text = data.get('rawNeutralText', '')
    summary = data.get('summary', '')
    body_text = data.get('bodyText', '')
    total = len(longs) + len(shorts) + len(neutrals)

    print(f"\n💾 Saving {total} positions to DynamoDB (longs: {len(longs)}, shorts: {len(shorts)}, neutrals: {len(neutrals)})...")

    db = boto3.resource('dynamodb', region_name='us-west-1')
    ts = datetime.now(timezone.utc).isoformat()

    snap_table = db.Table('HedgeyeDailySnapshot')
    snapshot_item = {
        'date': pdf_date,
        'snapshotType': 'the-macro-show',
        'data': {
            'longs': longs,
            'shorts': shorts,
            'neutrals': neutrals,
            'rawLongsText': raw_longs_text,
            'rawShortsText': raw_shorts_text,
            'rawNeutralText': raw_neutral_text
        },
        'positionCount': total,
        'scrapedAt': ts,
        'source': 'pdf',
        'ttl': int(datetime.now(timezone.utc).timestamp() + (730 * 24 * 60 * 60))
    }
    snapshot_item['article'] = {
        'summary': summary,
        'bodyText': body_text,
    }

    if pdf_s3_key:
        snapshot_item['pdfSource'] = pdf_s3_key

    snap_table.put_item(Item=snapshot_item)
    print(f"   ✅ Saved to HedgeyeDailySnapshot (the-macro-show)")
    print(f"      Longs:  {', '.join(longs)}")
    print(f"      Shorts: {', '.join(shorts)}")
    print(f"      Neutral: {', '.join(neutrals)}")
    print("\n🎉 SUCCESS! Macro Show data saved.\n")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 parse_macro_show.py <path_to_pdf>")
        sys.exit(1)

    pdf_path = Path(sys.argv[1])
    if not pdf_path.exists():
        print(f"❌ File not found: {pdf_path}")
        sys.exit(1)

    print("\n" + "=" * 70)
    print("🚀 MACRO SHOW PARSER")
    print("=" * 70)

    pdf_date = extract_date_from_pdf(pdf_path)
    print(f"📅 PDF Date: {pdf_date}\n")

    data = extract_macro_show(pdf_path)

    pdf_s3_key = upload_pdf_to_s3(pdf_path, pdf_date)
    save_to_dynamodb(data, pdf_s3_key, pdf_date)
