#!/usr/bin/env python3
"""
Upload Schwab Realized Gain/Loss – Lot Details CSV from the local `pl` folder to S3
so the csv-processor Lambda can ingest it (same `uploads/` prefix as other portfolio CSVs).

Default layout (matches Finder: iCloud Drive > Desktop > dashboard > performance > pl):
  ~/Desktop/dashboard/performance/pl/*GainLoss_Realized_Details*.csv
If Desktop is in iCloud, the same folder is also tried under Mobile Documents.
"""

import argparse
import os
import sys
import time
from pathlib import Path
from typing import List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "infra" / "scripts"))
from aws_profile_contract import (  # noqa: E402
    ADMIN_PROFILE,
    AwsProfileContractError,
    verified_session,
)


def _pl_dir_candidates() -> List[Path]:
    home = Path.home()
    return [
        home / "Desktop" / "dashboard" / "performance" / "pl",
        home
        / "Library"
        / "Mobile Documents"
        / "com~apple~CloudDocs"
        / "Desktop"
        / "dashboard"
        / "performance"
        / "pl",
    ]


def find_realized_csv_any_default() -> Tuple[Optional[Path], Optional[Path]]:
    """
    Find the newest *GainLoss_Realized_Details*.csv under a default pl folder.
    Returns (csv_path, pl_dir_used) or (None, None).
    """
    for pl_dir in _pl_dir_candidates():
        if not pl_dir.is_dir():
            continue
        found = find_realized_csv(pl_dir)
        if found:
            return found, pl_dir
    return None, None


def find_realized_csv(pl_dir: Path) -> Optional[Path]:
    """Return the most recently modified matching CSV in pl_dir, or None."""
    if not pl_dir.is_dir():
        return None
    matches = sorted(
        pl_dir.glob("*GainLoss_Realized_Details*.csv"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return matches[0] if matches else None


def upload_file(path: str, bucket: str = "market-dashboard-csv-data", *, session=None) -> bool:
    if not os.path.exists(path):
        print(f"File not found: {path}")
        return False

    if session is None:
        raise ValueError("An explicitly verified admin AWS session is required before uploading.")
    s3 = session.client("s3")
    filename = os.path.basename(path)
    key = f"uploads/{filename}"

    print(f"Uploading {filename} to s3://{bucket}/{key} ...")
    try:
        with open(path, "rb") as f:
            s3.put_object(Bucket=bucket, Key=key, Body=f)
        print("Upload successful")
        return True
    except Exception as e:
        print(f"Upload failed: {e}")
        return False


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Upload Realized G/L Lot Details CSV from performance/pl to S3"
    )
    parser.add_argument(
        "--file",
        help="Exact CSV path (overrides pl folder discovery)",
    )
    parser.add_argument(
        "--pl-dir",
        type=Path,
        help="Folder containing the CSV (default: auto ~/Desktop/.../pl or iCloud Desktop/.../pl, or $PERFORMANCE_PL_DIR)",
    )
    parser.add_argument(
        "--bucket",
        default="market-dashboard-csv-data",
        help="S3 bucket name",
    )
    parser.add_argument(
        "--wait-seconds",
        type=int,
        default=0,
        help="Optional sleep after upload (e.g. 5) to allow Lambda to start",
    )
    parser.add_argument(
        "--admin-profile",
        default=None,
        help=f"Required for this S3 upload (must be {ADMIN_PROFILE}).",
    )
    args = parser.parse_args()

    if args.file:
        csv_path = Path(args.file).expanduser().resolve()
    else:
        pl_dir: Optional[Path] = None
        if args.pl_dir:
            pl_dir = Path(args.pl_dir).expanduser().resolve()
        elif os.environ.get("PERFORMANCE_PL_DIR"):
            pl_dir = Path(os.environ["PERFORMANCE_PL_DIR"]).expanduser().resolve()

        if pl_dir is not None:
            found = find_realized_csv(pl_dir)
            if not found:
                print(
                    f"No *GainLoss_Realized_Details*.csv in {pl_dir}\n"
                    "Set PERFORMANCE_PL_DIR or use --file /path/to/…GainLoss_Realized_Details….csv"
                )
                return
            csv_path = found
        else:
            found, pl_dir = find_realized_csv_any_default()
            if not found or not pl_dir:
                tried = "\n  ".join(str(p) for p in _pl_dir_candidates())
                print(
                    "No *GainLoss_Realized_Details*.csv found in default pl locations:\n  "
                    f"{tried}\n"
                    "Put the CSV in performance/pl, or set PERFORMANCE_PL_DIR, or use --file."
                )
                return
            csv_path = found
        print(f"Using: {csv_path}")

    if args.admin_profile != ADMIN_PROFILE:
        parser.error(f"the upload requires --admin-profile {ADMIN_PROFILE}")
    try:
        session = verified_session(
            args.admin_profile,
            purpose="admin",
            region=os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-west-1")),
        )
    except AwsProfileContractError as error:
        parser.error(f"{error.error_code}: {error.detail}")

    if not upload_file(str(csv_path), bucket=args.bucket, session=session):
        return
    if args.wait_seconds > 0:
        print(f"Waiting {args.wait_seconds}s ...")
        time.sleep(args.wait_seconds)


if __name__ == "__main__":
    main()
