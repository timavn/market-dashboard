#!/usr/bin/env python3
"""
Read Schwab Realized G/L Lot Details from performance/pl and write to DynamoDB
RealizedGainLoss (same as Lambda csv_processor). Use when S3/Lambda is not in the path.

  AWS_REGION=us-west-1 python3 scripts/ingest_realized_to_dynamodb.py
  python3 scripts/ingest_realized_to_dynamodb.py --file /path/to/...csv
"""
import os
import sys
from pathlib import Path

# Lambda module path
_LAMBDA = Path(__file__).resolve().parent.parent / "aws" / "lambda"
sys.path.insert(0, str(_LAMBDA))

import csv_processor  # noqa: E402


def _pl_dirs():
    h = Path.home()
    return [
        h / "Desktop" / "dashboard" / "performance" / "pl",
        h
        / "Library"
        / "Mobile Documents"
        / "com~apple~CloudDocs"
        / "Desktop"
        / "dashboard"
        / "performance"
        / "pl",
    ]


def find_csv():
    for d in _pl_dirs():
        if not d.is_dir():
            continue
        found = sorted(
            d.glob("*GainLoss_Realized_Details*.csv"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        if found:
            return found[0]
    return None


def main():
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--file", type=Path, help="CSV path (default: newest in performance/pl)")
    args = p.parse_args()

    os.environ.setdefault("AWS_REGION", "us-west-1")

    path = args.file
    if path:
        path = path.expanduser().resolve()
    else:
        path = find_csv()
    if not path or not path.is_file():
        print("No CSV found. Use --file or place *GainLoss_Realized_Details*.csv in dashboard/performance/pl")
        return 1

    print(f"Reading {path}")
    content = path.read_text(encoding="utf-8", errors="replace")
    if not csv_processor.is_schwab_realized_lot_details_csv(content):
        print("File does not look like Schwab Realized G/L Lot Details")
        return 1
    lots = csv_processor.parse_schwab_realized_lot_details_csv(content)
    print(f"Parsed {len(lots)} lots, writing to {csv_processor.REALIZED_GAIN_LOSS_TABLE} ...")
    csv_processor.store_realized_gain_loss_lots(lots)
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
