#!/usr/bin/env python3
"""
Parse Hedgeye Volume slide PDFs using AWS Textract and persist a structured
`snapshotType: volume` record into HedgeyeDailySnapshot.

Usage: python3 parse_volume.py <path_to_pdf>
"""

import io
import re
import sys
import boto3
import pdfplumber
from datetime import datetime, timezone
from pathlib import Path
from PyPDF2 import PdfReader, PdfWriter
from date_utils import extract_date_from_pdf


DEFAULT_FOOTNOTES = [
    "Total Market Volume = Total US exchange volume plus OTC and OTCBB trading volume for all security types. Calculated by Bloomberg.",
    "Tape A+B+C volume = total US exchange volume.",
]


def _pad2(value):
    return f"{int(value):02d}"


def _to_iso_date(year, month, day):
    return f"{int(year):04d}-{_pad2(month)}-{_pad2(day)}"


def infer_as_of_date(as_of_label, slide_date):
    """Infer the YYYY-MM-DD trading date for a slide label like 3/19."""
    if not as_of_label or not slide_date:
        return None

    month_text, day_text = as_of_label.split("/")
    month = int(month_text)
    day = int(day_text)
    slide_year, slide_month, slide_day = [int(part) for part in slide_date.split("-")]

    year = slide_year
    if month > slide_month or (month == slide_month and day > slide_day):
        year -= 1

    return _to_iso_date(year, month, day)


def extract_first_page_as_pdf_bytes(pdf_path):
    """Return the first PDF page as standalone PDF bytes for Textract."""
    output = io.BytesIO()

    with open(pdf_path, "rb") as handle:
        reader = PdfReader(handle)
        writer = PdfWriter()
        if not reader.pages:
            raise ValueError("PDF has no pages")
        writer.add_page(reader.pages[0])
        writer.write(output)

    return output.getvalue()


def get_sorted_line_blocks(blocks):
    """Sort Textract LINE blocks top-to-bottom, then left-to-right."""
    lines = [
        block for block in blocks
        if block.get("BlockType") == "LINE" and block.get("Text")
    ]

    return sorted(
        lines,
        key=lambda block: (
            round(block["Geometry"]["BoundingBox"]["Top"], 4),
            round(block["Geometry"]["BoundingBox"]["Left"], 4),
        ),
    )


def _line_center_x(block):
    bbox = block["Geometry"]["BoundingBox"]
    return bbox["Left"] + (bbox["Width"] / 2)


def _line_center_y(block):
    bbox = block["Geometry"]["BoundingBox"]
    return bbox["Top"] + (bbox["Height"] / 2)


def _normalize_text(text):
    return re.sub(r"\s+", " ", str(text or "")).strip()


def parse_metrics_from_line_blocks(line_blocks, slide_date):
    """Map percent values into the 2x4 volume grid using line geometry."""
    text_by_line = [_normalize_text(block["Text"]) for block in line_blocks]
    ordered_text = "\n".join(text_by_line)

    row_markers = {
        "totalMarket": None,
        "exchange": None,
    }

    for block in line_blocks:
        text = _normalize_text(block["Text"]).lower()

        if row_markers["totalMarket"] is None and "total market volume*" in text:
            row_markers["totalMarket"] = _line_center_y(block)
        elif row_markers["exchange"] is None and "total exchange volume" in text:
            row_markers["exchange"] = _line_center_y(block)

    if not all(row_markers.values()):
        return parse_metrics_from_ordered_text(ordered_text, slide_date)

    min_row = min(row_markers.values())
    max_row = max(row_markers.values())
    row_padding = 0.06

    percent_blocks = []
    for block in line_blocks:
        text = _normalize_text(block["Text"])
        if not re.fullmatch(r"-?\d+%", text):
            continue

        y = _line_center_y(block)
        if y < (min_row - row_padding) or y > (max_row + row_padding):
            continue

        percent_blocks.append(block)

    assigned = {
        "totalMarket": [],
        "exchange": [],
    }

    for block in percent_blocks:
        value = int(_normalize_text(block["Text"]).replace("%", ""))
        y = _line_center_y(block)

        row_key = min(row_markers, key=lambda key: abs(y - row_markers[key]))
        assigned[row_key].append((_line_center_x(block), value))

    market = [value for _, value in sorted(assigned["totalMarket"], key=lambda item: item[0])]
    exchange = [value for _, value in sorted(assigned["exchange"], key=lambda item: item[0])]

    if len(market) >= 4 and len(exchange) >= 4:
        as_of_match = re.search(r"(\d{1,2}/\d{1,2})\s+vs\.?", ordered_text, re.IGNORECASE)
        as_of_label = as_of_match.group(1) if as_of_match else None
        as_of_trading_date = infer_as_of_date(as_of_label, slide_date)
        market = market[:4]
        exchange = exchange[:4]

        return {
            "asOfLabel": as_of_label,
            "asOfTradingDate": as_of_trading_date,
            "metrics": {
                "totalMarket": {
                    "priorDay": None,
                    "avg1M": None,
                    "avg3M": None,
                    "avg1Y": None,
                    "pctPriorDay": market[0],
                    "pct1M": market[1],
                    "pct3M": market[2],
                    "pct1Y": market[3],
                },
                "exchange": {
                    "priorDay": None,
                    "avg1M": None,
                    "avg3M": None,
                    "avg1Y": None,
                    "pctPriorDay": exchange[0],
                    "pct1M": exchange[1],
                    "pct3M": exchange[2],
                    "pct1Y": exchange[3],
                },
            },
        }

    return parse_metrics_from_ordered_text(ordered_text, slide_date)


def parse_metrics_from_ordered_text(text, slide_date):
    """Fallback parser based on line order when table geometry is incomplete."""
    as_of_match = re.search(r"(\d{1,2}/\d{1,2})\s+vs\.?", text, re.IGNORECASE)
    as_of_label = as_of_match.group(1) if as_of_match else None
    as_of_trading_date = infer_as_of_date(as_of_label, slide_date)

    prior_day_index = re.search(r"Prior Day", text, re.IGNORECASE)
    if not prior_day_index:
        raise ValueError("Unable to locate Prior Day in Textract output")

    trailing_text = text[prior_day_index.start():]
    percent_matches = re.findall(r"-?\d+%", trailing_text)
    if len(percent_matches) < 8:
        raise ValueError(
            f"Unable to locate all volume percentages in Textract output (found {len(percent_matches)})"
        )

    values = [int(value.replace("%", "")) for value in percent_matches[:8]]
    total_market_prior, exchange_prior, total_market_1m, exchange_1m, total_market_3m, exchange_3m, total_market_1y, exchange_1y = values

    return {
        "asOfLabel": as_of_label,
        "asOfTradingDate": as_of_trading_date,
        "metrics": {
            "totalMarket": {
                "priorDay": None,
                "avg1M": None,
                "avg3M": None,
                "avg1Y": None,
                "pctPriorDay": total_market_prior,
                "pct1M": total_market_1m,
                "pct3M": total_market_3m,
                "pct1Y": total_market_1y,
            },
            "exchange": {
                "priorDay": None,
                "avg1M": None,
                "avg3M": None,
                "avg1Y": None,
                "pctPriorDay": exchange_prior,
                "pct1M": exchange_1m,
                "pct3M": exchange_3m,
                "pct1Y": exchange_1y,
            },
        },
    }


def extract_footnotes(pdf_path):
    """Pull the starred footnotes from the first page text."""
    try:
        with pdfplumber.open(pdf_path) as pdf:
            text = pdf.pages[0].extract_text() or ""
    except Exception:
        return DEFAULT_FOOTNOTES

    lines = [_normalize_text(line) for line in text.split("\n")]
    footnotes = []

    for line in lines:
        lowered = line.lower()
        if "total market volume =" in lowered or "tape a+b+c volume" in lowered:
            footnotes.append(line)

    return footnotes or DEFAULT_FOOTNOTES


def extract_volume_snapshot(pdf_path, s3_key=None):
    """Extract the structured Hedgeye volume snapshot from the PDF."""
    print(f"\n📄 Reading Volume PDF: {pdf_path}")

    slide_date = extract_date_from_pdf(pdf_path)
    pdf_bytes = extract_first_page_as_pdf_bytes(pdf_path)
    textract = boto3.client("textract", region_name="us-west-1")
    response = textract.analyze_document(
        Document={"Bytes": pdf_bytes},
        FeatureTypes=["TABLES"]
    )

    line_blocks = get_sorted_line_blocks(response.get("Blocks", []))
    parsed = parse_metrics_from_line_blocks(line_blocks, slide_date)

    if not parsed.get("asOfTradingDate"):
        raise ValueError("Unable to infer as-of trading date from the volume slide")

    footnotes = extract_footnotes(pdf_path)
    ts = datetime.now(timezone.utc).isoformat()

    return {
        "slideDate": slide_date,
        "uploadDate": slide_date,
        "asOfLabel": parsed["asOfLabel"],
        "asOfTradingDate": parsed["asOfTradingDate"],
        "metrics": parsed["metrics"],
        "footnotes": footnotes,
        "timestamp": ts,
        "source": "textract",
        "methodologyVersion": "hedgeye-volume-snapshot-v1",
        "pdfSource": s3_key,
    }


def upload_pdf_to_s3(pdf_path, pdf_date=None):
    """Upload the original PDF to S3 for archival."""
    print("\n☁️  Uploading PDF to S3...")

    s3 = boto3.client("s3", region_name="us-west-1")
    date = pdf_date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    time = datetime.now(timezone.utc).strftime("%H%M%S")
    s3_key = f"hedgeye-pdfs/{date}/volume-{date}-{time}.pdf"

    try:
        s3.upload_file(
            str(pdf_path),
            "market-dashboard-csv-data",
            s3_key,
            ExtraArgs={"ContentType": "application/pdf"},
        )
        print(f"   ✅ PDF uploaded: {s3_key}")
        return s3_key
    except Exception as error:
        print(f"   ⚠️  Upload failed: {error}")
        return None


def save_to_dynamodb(data, pdf_s3_key=None, pdf_date=None):
    """Save the extracted volume snapshot into HedgeyeDailySnapshot."""
    if not data:
        print("\n❌ No data to save")
        return

    if not pdf_date:
        print("❌ valid pdf_date is required to save to DynamoDB")
        return

    print("\n💾 Saving volume snapshot to DynamoDB...")
    db = boto3.resource("dynamodb", region_name="us-west-1")
    snap_table = db.Table("HedgeyeDailySnapshot")
    ts = datetime.now(timezone.utc).isoformat()

    snapshot_item = {
        "date": pdf_date,
        "snapshotType": "volume",
        "data": {
            "slideDate": data.get("slideDate"),
            "uploadDate": pdf_date,
            "asOfLabel": data.get("asOfLabel"),
            "asOfTradingDate": data.get("asOfTradingDate"),
            "metrics": data.get("metrics"),
            "footnotes": data.get("footnotes", []),
            "methodologyVersion": data.get("methodologyVersion", "hedgeye-volume-snapshot-v1"),
        },
        "scrapedAt": ts,
        "source": "textract",
        "methodologyVersion": data.get("methodologyVersion", "hedgeye-volume-snapshot-v1"),
        "ttl": int(datetime.now(timezone.utc).timestamp() + (730 * 24 * 60 * 60)),
    }

    if pdf_s3_key:
        snapshot_item["pdfSource"] = pdf_s3_key

    snap_table.put_item(Item=snapshot_item)
    print("   ✅ Saved volume snapshot to HedgeyeDailySnapshot")
    print(f"      As-of label: {data.get('asOfLabel')}")
    print(f"      As-of date:  {data.get('asOfTradingDate')}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 parse_volume.py <path_to_pdf>")
        sys.exit(1)

    pdf_path = Path(sys.argv[1])
    if not pdf_path.exists():
        print(f"❌ File not found: {pdf_path}")
        sys.exit(1)

    print("\n" + "=" * 70)
    print("🚀 HEDGEYE VOLUME PARSER")
    print("=" * 70)

    pdf_date = extract_date_from_pdf(pdf_path)
    print(f"📅 PDF Date: {pdf_date}")

    data = extract_volume_snapshot(pdf_path)
    print("\nParsed data preview:")
    print(f"  Slide date: {data.get('slideDate')}")
    print(f"  As-of:      {data.get('asOfLabel')} ({data.get('asOfTradingDate')})")
    print(f"  Market:     {data['metrics']['totalMarket']}")
    print(f"  Exchange:   {data['metrics']['exchange']}")

    pdf_s3_key = upload_pdf_to_s3(pdf_path, pdf_date)
    save_to_dynamodb(data, pdf_s3_key, pdf_date)
