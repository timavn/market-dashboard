#!/usr/bin/env python3
"""Replay recent immutable Hedgeye artifacts into Security Intelligence v1.

Dry-run is the default. ``--apply`` writes HTML entity events/manifests and
asynchronously dispatches PDFs to the completion-safe PDF processor.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Iterable, List
from zoneinfo import ZoneInfo

import boto3


REPO_ROOT = Path(__file__).resolve().parents[2]
GMAIL_INGESTOR_DIR = REPO_ROOT / "infra" / "lambdas" / "gmail_ingestor"
sys.path.insert(0, str(GMAIL_INGESTOR_DIR))

from parse_hedgeye_email_html import parse_html_snapshot  # noqa: E402
from research_intelligence import (  # noqa: E402
    persist_snapshot_failure,
    persist_snapshot_intelligence,
    product_ids,
)


DEFAULT_BUCKET = os.environ.get("HEDGEYE_BUCKET", "market-dashboard-csv-data")
DEFAULT_PDF_FUNCTION = os.environ.get(
    "PDF_PROCESSOR_FUNCTION_NAME",
    "market-dashboard-hedgeye-pdf-processor-v1",
)
AWS_REGION = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-west-1"))
MARKET_TIME_ZONE = ZoneInfo("America/New_York")
ONE_OFF_MARKET_CLOSURES = frozenset(
    {
        date(2001, 9, 11),
        date(2001, 9, 12),
        date(2001, 9, 13),
        date(2001, 9, 14),
        date(2004, 6, 11),
        date(2007, 1, 2),
        date(2012, 10, 29),
        date(2012, 10, 30),
        date(2018, 12, 5),
        date(2025, 1, 9),
    }
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Replay Security Intelligence from immutable S3 artifacts.",
    )
    parser.add_argument("--apply", action="store_true", help="Write projections and dispatch PDFs.")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable output.")
    parser.add_argument("--date", help="Final market date (YYYY-MM-DD); defaults to today.")
    parser.add_argument(
        "--history-days",
        type=int,
        default=5,
        choices=range(0, 6),
        metavar="0..5",
        help="Number of prior U.S. market sessions to replay (default: 5).",
    )
    parser.add_argument("--bucket", default=DEFAULT_BUCKET)
    parser.add_argument("--pdf-function", default=DEFAULT_PDF_FUNCTION)
    return parser.parse_args()


def _nth_weekday(year: int, month: int, weekday: int, occurrence: int) -> date:
    first = date(year, month, 1)
    offset = (weekday - first.weekday()) % 7
    return first + timedelta(days=offset + ((occurrence - 1) * 7))


def _last_weekday(year: int, month: int, weekday: int) -> date:
    if month == 12:
        following_month = date(year + 1, 1, 1)
    else:
        following_month = date(year, month + 1, 1)
    cursor = following_month - timedelta(days=1)
    return cursor - timedelta(days=(cursor.weekday() - weekday) % 7)


def _easter_sunday(year: int) -> date:
    """Return Gregorian Easter using the deterministic Meeus/Jones/Butcher rule."""
    a = year % 19
    b = year // 100
    c = year % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    left = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * left) // 451
    month = (h + left - 7 * m + 114) // 31
    day = ((h + left - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def _observed_fixed_holiday(
    year: int,
    month: int,
    day: int,
    *,
    saturday_observed: bool = True,
) -> date:
    holiday = date(year, month, day)
    if holiday.weekday() == 5 and saturday_observed:
        return holiday - timedelta(days=1)
    if holiday.weekday() == 6:
        return holiday + timedelta(days=1)
    return holiday


@lru_cache(maxsize=None)
def us_equity_market_holidays(year: int) -> frozenset[date]:
    """Return full-day NYSE holidays for a calendar year.

    Early-close sessions remain market days. New Year's Day is the one fixed
    holiday not observed on Friday when January 1 falls on Saturday.
    """
    holidays = {
        _observed_fixed_holiday(year, 1, 1, saturday_observed=False),
        _nth_weekday(year, 2, 0, 3),  # Washington's Birthday
        _easter_sunday(year) - timedelta(days=2),  # Good Friday
        _last_weekday(year, 5, 0),  # Memorial Day
        _observed_fixed_holiday(year, 7, 4),
        _nth_weekday(year, 9, 0, 1),  # Labor Day
        _nth_weekday(year, 11, 3, 4),  # Thanksgiving
        _observed_fixed_holiday(year, 12, 25),
    }
    if year >= 1998:
        holidays.add(_nth_weekday(year, 1, 0, 3))
    if year >= 2022:
        holidays.add(_observed_fixed_holiday(year, 6, 19))

    # An observed holiday can move across a calendar-year boundary.
    next_new_year = _observed_fixed_holiday(
        year + 1,
        1,
        1,
        saturday_observed=False,
    )
    if next_new_year.year == year:
        holidays.add(next_new_year)
    holidays.update(item for item in ONE_OFF_MARKET_CLOSURES if item.year == year)
    return frozenset(item for item in holidays if item.year == year)


def is_us_equity_market_day(value: date) -> bool:
    return value.weekday() < 5 and value not in us_equity_market_holidays(value.year)


def market_dates(final_date: str, history_days: int) -> List[str]:
    if not 0 <= history_days <= 5:
        raise ValueError("history_days must be between 0 and 5")
    cursor = date.fromisoformat(final_date)
    dates: List[str] = []
    while len(dates) <= history_days:
        if is_us_equity_market_day(cursor):
            dates.append(cursor.isoformat())
        cursor -= timedelta(days=1)
    return dates


def current_market_date(now: datetime | None = None) -> str:
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return current.astimezone(MARKET_TIME_ZONE).date().isoformat()


def replay_exit_code(results: List[Dict[str, Any]]) -> int:
    if not results:
        return 1
    return 1 if any(item.get("status") in {"error", "failed"} for item in results) else 0


def list_objects(s3: Any, bucket: str, prefix: str) -> Iterable[Dict[str, Any]]:
    continuation = None
    while True:
        response = s3.list_objects_v2(
            Bucket=bucket,
            Prefix=prefix,
            **({"ContinuationToken": continuation} if continuation else {}),
        )
        yield from response.get("Contents", [])
        continuation = response.get("NextContinuationToken")
        if not continuation:
            return


def artifact_inventory(s3: Any, bucket: str, dates: List[str]) -> List[Dict[str, Any]]:
    inventory: Dict[str, Dict[str, Any]] = {}
    for market_date in dates:
        html_prefix = f"hedgeye-email/messages/{market_date}/"
        for item in list_objects(s3, bucket, html_prefix):
            key = item["Key"]
            product = key[len(html_prefix) :].split("/", 1)[0] or "unknown"
            inventory[key] = {
                "kind": "html",
                "key": key,
                "product": product,
                "inventoryDate": market_date,
                "size": int(item.get("Size", 0)),
            }
        for product in [*product_ids(), "email-ingest"]:
            prefix = f"hedgeye-uploads/{product}/{market_date}/"
            for item in list_objects(s3, bucket, prefix):
                key = item["Key"]
                inventory[key] = {
                    "kind": "pdf",
                    "key": key,
                    "product": "unknown" if product == "email-ingest" else product,
                    "inventoryDate": market_date,
                    "size": int(item.get("Size", 0)),
                }
    return sorted(inventory.values(), key=lambda item: item["key"])


def object_metadata(s3: Any, bucket: str, key: str) -> Dict[str, str]:
    response = s3.head_object(Bucket=bucket, Key=key)
    return {
        str(name).lower(): str(value)
        for name, value in (response.get("Metadata") or {}).items()
    }


def replay_html(
    *,
    artifact: Dict[str, Any],
    bucket: str,
    s3: Any,
    dynamodb: Any,
    apply: bool,
) -> Dict[str, Any]:
    key = artifact["key"]
    response = s3.get_object(Bucket=bucket, Key=key)
    body = response["Body"].read()
    metadata = {
        str(name).lower(): str(value)
        for name, value in (response.get("Metadata") or {}).items()
    }
    content_hash = metadata.get("content-sha256") or hashlib.sha256(body).hexdigest()
    product = metadata.get("report-type") or artifact["product"]
    message_id = metadata.get("gmail-message-id") or content_hash[:32]
    received_at = datetime.strptime(
        artifact["inventoryDate"],
        "%Y-%m-%d",
    ).replace(hour=12, tzinfo=timezone.utc)
    snapshot = parse_html_snapshot(
        report_type=product,
        html_body=body.decode("utf-8", errors="replace"),
        received_at=received_at,
        s3_key=key,
        message_id=message_id,
        subject="",
    )
    if not snapshot:
        error = f"No parseable {product} snapshot"
        if apply:
            persist_snapshot_failure(
                {
                    "date": artifact["inventoryDate"],
                    "snapshotType": product,
                    "reportType": product,
                    "scrapedAt": received_at.isoformat(),
                    "publishedAt": received_at.isoformat(),
                    "gmailMessageId": message_id,
                    "htmlSource": key,
                    "data": {},
                },
                dynamodb,
                content_sha256=content_hash,
                error=error,
            )
        return {**artifact, "status": "failed", "error": error}

    event_count = (
        persist_snapshot_intelligence(
            snapshot,
            dynamodb,
            content_sha256=content_hash,
        )
        if apply
        else None
    )
    return {
        **artifact,
        "status": "indexed" if apply else "would_index",
        "snapshotDate": snapshot["date"],
        "entityEventCount": event_count,
    }


def replay_pdf(
    *,
    artifact: Dict[str, Any],
    bucket: str,
    s3: Any,
    lambda_client: Any,
    function_name: str,
    apply: bool,
) -> Dict[str, Any]:
    metadata = object_metadata(s3, bucket, artifact["key"])
    payload = {
        "source": "security-intelligence-replay",
        "bucket": bucket,
        "key": artifact["key"],
        "reportType": metadata.get("report-type") or artifact["product"],
        "messageId": metadata.get("gmail-message-id"),
        "attachmentId": metadata.get("gmail-attachment-id"),
        "contentSha256": metadata.get("content-sha256"),
        "receivedAt": f"{artifact['inventoryDate']}T12:00:00+00:00",
    }
    if apply:
        response = lambda_client.invoke(
            FunctionName=function_name,
            InvocationType="Event",
            Payload=json.dumps(payload).encode("utf-8"),
        )
        if int(response.get("StatusCode", 0)) != 202:
            raise RuntimeError(
                f"PDF dispatch returned {response.get('StatusCode')!r} for {artifact['key']}"
            )
    return {
        **artifact,
        "status": "dispatched" if apply else "would_dispatch",
    }


def main() -> int:
    args = parse_args()
    final_date = args.date or current_market_date()
    date.fromisoformat(final_date)
    dates = market_dates(final_date, args.history_days)
    session = boto3.session.Session(region_name=AWS_REGION)
    s3 = session.client("s3")
    lambda_client = session.client("lambda")
    dynamodb = session.resource("dynamodb")
    inventory = artifact_inventory(s3, args.bucket, dates)
    results = []
    for artifact in inventory:
        try:
            if artifact["kind"] == "html":
                result = replay_html(
                    artifact=artifact,
                    bucket=args.bucket,
                    s3=s3,
                    dynamodb=dynamodb,
                    apply=args.apply,
                )
            else:
                result = replay_pdf(
                    artifact=artifact,
                    bucket=args.bucket,
                    s3=s3,
                    lambda_client=lambda_client,
                    function_name=args.pdf_function,
                    apply=args.apply,
                )
        except Exception as error:
            result = {**artifact, "status": "error", "error": str(error)}
        results.append(result)

    summary = {
        "mode": "apply" if args.apply else "dry-run",
        "dates": dates,
        "artifactCount": len(results),
        "statusCounts": {
            status: sum(item["status"] == status for item in results)
            for status in sorted({item["status"] for item in results})
        },
        "results": results,
    }
    if args.json:
        print(json.dumps(summary, indent=2, sort_keys=True))
    else:
        print(
            f"{summary['mode']}: {summary['artifactCount']} artifact(s) across "
            f"{', '.join(dates)} — {summary['statusCounts']}"
        )
        for result in results:
            suffix = f": {result['error']}" if result.get("error") else ""
            print(f"{result['status']:>14}  {result['key']}{suffix}")
    return replay_exit_code(results)


if __name__ == "__main__":
    raise SystemExit(main())
