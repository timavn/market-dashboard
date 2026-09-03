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
    build_entity_events,
    persist_snapshot_failure,
    persist_snapshot_intelligence,
    product_ids,
)


DEFAULT_BUCKET = os.environ.get("HEDGEYE_BUCKET", "market-dashboard-csv-data")
DEFAULT_PDF_FUNCTION = os.environ.get(
    "PDF_PROCESSOR_FUNCTION_NAME",
    "market-dashboard-hedgeye-pdf-processor-v1",
)
AWS_REGION = "us-west-1"
EXPECTED_AWS_ACCOUNT_ID = "915328198276"
DEFAULT_READ_PROFILE = "market-dashboard-local"
REQUIRED_ADMIN_PROFILE = "market-dashboard-admin"
PROFILE_ENVIRONMENT_KEYS = ("AWS_PROFILE", "AWS_DEFAULT_PROFILE")
PROFILE_OVERRIDE_ENVIRONMENT_KEYS = (
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
)
STATIC_CREDENTIAL_ENVIRONMENT_KEYS = (
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_SECURITY_TOKEN",
    "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
)
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
    parser.add_argument(
        "--product",
        action="append",
        dest="products",
        help="Replay only this registered product; repeat for multiple products.",
    )
    parser.add_argument("--bucket", default=DEFAULT_BUCKET)
    parser.add_argument("--pdf-function", default=DEFAULT_PDF_FUNCTION)
    parser.add_argument(
        "--read-profile",
        default=DEFAULT_READ_PROFILE,
        help=f"Explicit read profile for dry-run inventory and artifacts (default: {DEFAULT_READ_PROFILE}).",
    )
    parser.add_argument(
        "--admin-profile",
        default=None,
        help=f"Required explicit admin profile for --apply (must be {REQUIRED_ADMIN_PROFILE}).",
    )
    return parser.parse_args()


class ProfileValidationError(RuntimeError):
    """Safe, typed failure raised before any replay write client is created."""

    def __init__(self, error_code: str, detail: str):
        super().__init__(detail)
        self.error_code = error_code
        self.detail = detail


def validate_profile_environment(profile: str, *, apply: bool, environment: Dict[str, str] | None = None) -> None:
    """Reject ambient credentials that could silently override the named profile."""
    environment = os.environ if environment is None else environment
    ambient_profiles = [
        str(environment.get(key) or "").strip()
        for key in PROFILE_ENVIRONMENT_KEYS
        if str(environment.get(key) or "").strip()
    ]
    if any(value != profile for value in ambient_profiles):
        raise ProfileValidationError(
            "AWS_PROFILE_ENVIRONMENT_OVERRIDE",
            "The replay found an ambient AWS profile override; clear it and retry with the explicit repository profile.",
        )
    if any(str(environment.get(key) or "").strip() for key in PROFILE_OVERRIDE_ENVIRONMENT_KEYS):
        raise ProfileValidationError(
            "AWS_PROFILE_ENVIRONMENT_OVERRIDE",
            "The replay found an AWS config or credentials file override; clear it and retry with the explicit repository profile.",
        )
    if any(str(environment.get(key) or "").strip() for key in STATIC_CREDENTIAL_ENVIRONMENT_KEYS):
        raise ProfileValidationError(
            "AWS_PROFILE_STATIC_SESSION_REJECTED" if apply else "AWS_PROFILE_ENVIRONMENT_OVERRIDE",
            "The replay found ambient AWS credentials; clear them and use the explicit repository profile provider.",
        )


def validate_profile_arguments(args: argparse.Namespace, *, environment: Dict[str, str] | None = None) -> str:
    """Select the only permitted read or write profile before constructing AWS clients."""
    read_profile = str(args.read_profile or "").strip()
    if read_profile != DEFAULT_READ_PROFILE:
        raise ProfileValidationError(
            "AWS_PROFILE_NAME_INVALID",
            f"Security Intelligence dry-run reads must use {DEFAULT_READ_PROFILE}.",
        )
    if args.apply:
        admin_profile = str(args.admin_profile or "").strip()
        if admin_profile != REQUIRED_ADMIN_PROFILE:
            raise ProfileValidationError(
                "AWS_ADMIN_PROFILE_REQUIRED",
                f"--apply requires --admin-profile {REQUIRED_ADMIN_PROFILE}.",
            )
        validate_profile_environment(admin_profile, apply=True, environment=environment)
        return admin_profile
    if args.admin_profile not in (None, ""):
        raise ProfileValidationError(
            "AWS_ADMIN_PROFILE_APPLY_ONLY",
            "--admin-profile is only valid with --apply; dry-run uses the explicit local read profile.",
        )
    validate_profile_environment(read_profile, apply=False, environment=environment)
    return read_profile


def approved_identity(identity: Dict[str, Any], profile: str, *, apply: bool) -> bool:
    if not isinstance(identity, dict) or str(identity.get("Account") or "") != EXPECTED_AWS_ACCOUNT_ID:
        return False
    arn = str(identity.get("Arn") or "")
    if apply:
        return arn.startswith(f"arn:aws:sts::{EXPECTED_AWS_ACCOUNT_ID}:assumed-role/")
    return arn == f"arn:aws:iam::{EXPECTED_AWS_ACCOUNT_ID}:user/{profile}"


def create_verified_session(profile: str, *, apply: bool) -> Any:
    """Create an explicit profile session and verify its principal before write clients."""
    try:
        session = boto3.session.Session(profile_name=profile, region_name=AWS_REGION)
        identity = session.client("sts").get_caller_identity()
    except Exception as error:  # boto3 exception types vary across CLI/SSO versions.
        diagnostic = str(error)
        lowered = diagnostic.lower()
        if apply and any(token in lowered for token in (
            "token has expired",
            "expired",
            "sso session",
            "unauthorizedssotoken",
            "tokenretrieval",
        )):
            raise ProfileValidationError(
                "AWS_ADMIN_LOGIN_REQUIRED",
                "The approved administrator SSO session is expired or unavailable; refresh it before applying the replay.",
            ) from None
        if "accessdenied" in lowered or "not authorized" in lowered or "unauthorizedoperation" in lowered:
            raise ProfileValidationError(
                "AWS_AUTHORIZATION_DENIED",
                "The AWS principal is authenticated but is not authorized to verify or apply this operation.",
            ) from None
        raise ProfileValidationError(
            "AWS_PROFILE_UNUSABLE",
            "The explicit AWS profile could not be verified.",
        ) from None
    if not approved_identity(identity, profile, apply=apply):
        raise ProfileValidationError(
            "AWS_PROFILE_WRONG_PRINCIPAL",
            "The explicit AWS profile resolved to an unapproved AWS principal.",
        )
    return session


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


def normalized_investing_ideas(snapshot: Dict[str, Any]) -> Dict[str, Any] | None:
    """Return compact, machine-readable evidence for replay verification."""
    if str(snapshot.get("snapshotType") or "").lower() != "investing-ideas":
        return None
    data = snapshot.get("data") if isinstance(snapshot.get("data"), dict) else {}
    positions = data.get("positions") if isinstance(data.get("positions"), list) else []
    if not positions:
        positions = [
            {"ticker": ticker, "side": "Long"}
            for ticker in data.get("longs") or []
        ] + [
            {"ticker": ticker, "side": "Short"}
            for ticker in data.get("shorts") or []
        ]
    normalized = []
    for position in positions:
        if not isinstance(position, dict):
            continue
        side = str(position.get("side") or position.get("position") or "").strip().title()
        normalized.append({
            "ticker": str(position.get("ticker") or "").strip().upper(),
            "side": side,
            "bias": "BULLISH" if side == "Long" else "BEARISH" if side == "Short" else None,
            "previousClose": position.get("prevClose"),
            "lrr": position.get("lrr"),
            "hrr": position.get("hrr"),
        })
    return {
        "positionCount": len(normalized),
        "longs": [item["ticker"] for item in normalized if item["side"] == "Long"],
        "shorts": [item["ticker"] for item in normalized if item["side"] == "Short"],
        "positions": normalized,
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

    events = build_entity_events(snapshot, content_sha256=content_hash)
    event_count = (
        persist_snapshot_intelligence(
            snapshot,
            dynamodb,
            content_sha256=content_hash,
        )
        if apply
        else len(events)
    )
    result = {
        **artifact,
        "status": "indexed" if apply else "would_index",
        "snapshotDate": snapshot["date"],
        "entityEventCount": event_count,
        "contentSha256": content_hash,
    }
    evidence = normalized_investing_ideas(snapshot)
    if evidence is not None:
        result["normalizedInvestingIdeas"] = evidence
    return result


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
    try:
        selected_profile = validate_profile_arguments(args)
        session = create_verified_session(selected_profile, apply=args.apply)
    except ProfileValidationError as error:
        summary = {
            "mode": "apply" if args.apply else "dry-run",
            "dates": dates,
            "products": sorted({
                str(product).strip().lower()
                for product in (args.products or [])
                if str(product).strip()
            }),
            "status": "blocked",
            "errorCode": error.error_code,
            "error": error.detail,
        }
        if args.json:
            print(json.dumps(summary, indent=2, sort_keys=True))
        else:
            print(f"{summary['mode']} blocked ({error.error_code}): {error.detail}")
        return 2

    s3 = session.client("s3")
    lambda_client = session.client("lambda")
    dynamodb = session.resource("dynamodb")
    inventory = artifact_inventory(s3, args.bucket, dates)
    selected_products = {
        str(product).strip().lower()
        for product in (args.products or [])
        if str(product).strip()
    }
    if selected_products:
        inventory = [
            artifact
            for artifact in inventory
            if str(artifact.get("product") or "").strip().lower() in selected_products
        ]
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
        "awsProfile": selected_profile,
        "dates": dates,
        "products": sorted(selected_products),
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
