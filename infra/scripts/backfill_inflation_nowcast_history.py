#!/usr/bin/env python3
"""Validate and persist the canonical Hedgeye CPI nowcast history backfill."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, List, Optional

import boto3
from botocore.exceptions import ClientError

try:
    from aws_profile_contract import ADMIN_PROFILE, AwsProfileContractError, verified_session
except ModuleNotFoundError:  # pragma: no cover - direct spec imports in focused tests
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from aws_profile_contract import ADMIN_PROFILE, AwsProfileContractError, verified_session


DEFAULT_MANIFEST = (
    Path(__file__).resolve().parents[2]
    / "data"
    / "hedgeye"
    / "inflation-nowcast"
    / "backfill-2025-07_2026-07.json"
)
DEFAULT_TABLE = "HedgeyeDailySnapshot"
DEFAULT_REGION = "us-west-1"
MONTH_ID = re.compile(r"^20\d{2}-(0[1-9]|1[0-2])$")


def parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def load_manifest(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle, parse_float=Decimal)


def validate_manifest(manifest: Dict[str, Any]) -> List[Dict[str, Any]]:
    if manifest.get("schemaVersion") != "inflation-nowcast-history-v1":
        raise ValueError("Unsupported inflation history manifest schema")
    if manifest.get("snapshotType") != "inflation-nowcast":
        raise ValueError("Backfill manifest has the wrong snapshot type")
    forecasts = manifest.get("forecasts")
    if not isinstance(forecasts, list) or not forecasts:
        raise ValueError("Backfill manifest contains no forecasts")
    seen = set()
    for forecast in forecasts:
        report_month = str(forecast.get("reportMonth") or "")
        if not MONTH_ID.fullmatch(report_month) or report_month in seen:
            raise ValueError(f"Invalid or duplicate report month: {report_month}")
        seen.add(report_month)
        release_at = parse_iso(forecast.get("releaseAt"))
        if not release_at:
            raise ValueError(f"{report_month} is missing a release cutoff")
        scenarios = forecast.get("scenarios") or {}
        try:
            upper = Decimal(str(scenarios["upper"]))
            base = Decimal(str(scenarios["base"]))
            lower = Decimal(str(scenarios["lower"]))
        except (KeyError, ValueError) as error:
            raise ValueError(f"{report_month} has incomplete scenarios") from error
        if not all(value.is_finite() for value in (upper, base, lower)):
            raise ValueError(f"{report_month} has non-finite scenarios")
        if not lower < base < upper:
            raise ValueError(f"{report_month} scenarios are not ordered")
        published_at = parse_iso(forecast.get("publishedAt"))
        user_confirmed = str(forecast.get("selectionBasis") or "").startswith(
            "user_confirmed"
        )
        if user_confirmed:
            artifact = (forecast.get("source") or {}).get("artifact") or {}
            if not re.fullmatch(r"[0-9a-f]{64}", str(artifact.get("sha256") or "")):
                raise ValueError(f"{report_month} manual source is missing its SHA-256")
        elif not published_at or published_at >= release_at:
            raise ValueError(f"{report_month} was not published strictly before release")
    return forecasts


def parse_manual_artifacts(values: List[str]) -> Dict[str, Path]:
    result: Dict[str, Path] = {}
    for value in values:
        report_month, separator, path_value = value.partition("=")
        if not separator or not MONTH_ID.fullmatch(report_month):
            raise ValueError("Manual artifacts must use YYYY-MM=/absolute/path.png")
        path = Path(path_value).expanduser().resolve()
        if not path.is_file():
            raise ValueError(f"Manual artifact does not exist: {path}")
        result[report_month] = path
    return result


def verify_manual_artifacts(
    forecasts: List[Dict[str, Any]],
    supplied_paths: Dict[str, Path],
) -> None:
    expected = {
        forecast["reportMonth"]: (forecast.get("source") or {}).get("artifact")
        for forecast in forecasts
        if str(forecast.get("selectionBasis") or "").startswith("user_confirmed")
    }
    if set(supplied_paths) != set(expected):
        raise ValueError(
            "Every user-confirmed month must have exactly one --manual-artifact"
        )
    for report_month, path in supplied_paths.items():
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != expected[report_month]["sha256"]:
            raise ValueError(f"Manual artifact hash mismatch for {report_month}")


def upload_manual_artifacts(
    forecasts: List[Dict[str, Any]],
    supplied_paths: Dict[str, Path],
    *,
    bucket: str,
    region: str,
    session: Any,
) -> None:
    client = session.client("s3", region_name=region)
    by_month = {forecast["reportMonth"]: forecast for forecast in forecasts}
    for report_month, path in supplied_paths.items():
        artifact = by_month[report_month]["source"]["artifact"]
        digest = artifact["sha256"]
        key = (
            f"hedgeye-email/messages/manual-inflation-nowcast/"
            f"{report_month}/{digest}.png"
        )
        try:
            client.put_object(
                Bucket=bucket,
                Key=key,
                Body=path.read_bytes(),
                ContentType="image/png",
                Metadata={
                    "sha256": digest,
                    "report-month": report_month,
                    "source-kind": "user-confirmed-chart",
                },
                IfNoneMatch="*",
            )
        except ClientError as error:
            status = (error.response or {}).get("ResponseMetadata", {}).get(
                "HTTPStatusCode"
            )
            if status != 412:
                raise
            existing = client.head_object(Bucket=bucket, Key=key)
            if (existing.get("Metadata") or {}).get("sha256") != digest:
                raise ValueError(f"Existing manual artifact differs for {report_month}")
        artifact.update({"bucket": bucket, "key": key})


def build_snapshot(manifest: Dict[str, Any]) -> Dict[str, Any]:
    forecasts = deepcopy(manifest["forecasts"])
    latest = max(forecasts, key=lambda forecast: forecast["reportMonth"])
    source_ids = [
        forecast.get("source", {}).get("messageId")
        for forecast in forecasts
        if forecast.get("source", {}).get("messageId")
    ]
    scenarios = latest["scenarios"]
    captured_at = datetime.now(timezone.utc).isoformat()
    canonical_manifest = deepcopy(manifest)
    for forecast in canonical_manifest.get("forecasts") or []:
        artifact = (forecast.get("source") or {}).get("artifact") or {}
        artifact.pop("bucket", None)
        artifact.pop("key", None)
    canonical = json.dumps(
        canonical_manifest,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return {
        "date": manifest["captureDate"],
        "snapshotType": "inflation-nowcast",
        "reportType": "inflation-nowcast",
        "scrapedAt": captured_at,
        "publishedAt": latest["publishedAt"],
        "source": "canonical-history-backfill",
        "sourceKind": "manual-history-backfill",
        "sourceProduct": "hedgeye-macro-pro",
        "sourcePriority": 20,
        "sourceMessageIds": source_ids,
        "itemCount": 3,
        "forecastCount": len(forecasts),
        "parserVersion": "inflation-nowcast-history-v1",
        "contentHash": hashlib.sha256(canonical).hexdigest(),
        "data": {
            "metric": manifest["metric"],
            "forecastMonth": latest["forecastMonth"],
            "reportMonth": latest["reportMonth"],
            "releaseDate": latest["releaseAt"][:10],
            "releaseAt": latest["releaseAt"],
            "scenarios": [
                {"key": "upside", "label": "Upside", "value": scenarios["upper"]},
                {"key": "base", "label": "Base Case", "value": scenarios["base"]},
                {"key": "downside", "label": "Downside", "value": scenarios["lower"]},
            ],
            "forecasts": forecasts,
        },
        "ttl": int(time.time() + (730 * 24 * 60 * 60)),
    }


def persist_snapshot(snapshot: Dict[str, Any], *, table_name: str, region: str, session: Any) -> str:
    table = session.resource("dynamodb", region_name=region).Table(table_name)
    try:
        table.put_item(
            Item=snapshot,
            ConditionExpression=(
                "attribute_not_exists(#date) AND attribute_not_exists(#snapshotType)"
            ),
            ExpressionAttributeNames={
                "#date": "date",
                "#snapshotType": "snapshotType",
            },
        )
        return "written"
    except ClientError as error:
        if (error.response or {}).get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise
    existing = table.get_item(
        Key={"date": snapshot["date"], "snapshotType": snapshot["snapshotType"]},
        ConsistentRead=True,
    ).get("Item")
    if existing and existing.get("contentHash") == snapshot.get("contentHash"):
        manual_artifacts = [
            (forecast.get("source") or {}).get("artifact") or {}
            for forecast in snapshot.get("data", {}).get("forecasts") or []
            if str(forecast.get("selectionBasis") or "").startswith("user_confirmed")
        ]
        has_durable_artifacts = bool(manual_artifacts) and all(
            artifact.get("bucket") and artifact.get("key")
            for artifact in manual_artifacts
        )
        if has_durable_artifacts and existing.get("data") != snapshot.get("data"):
            table.update_item(
                Key={
                    "date": snapshot["date"],
                    "snapshotType": snapshot["snapshotType"],
                },
                UpdateExpression="SET #data = :data, #scrapedAt = :scrapedAt",
                ConditionExpression="#contentHash = :contentHash",
                ExpressionAttributeNames={
                    "#data": "data",
                    "#scrapedAt": "scrapedAt",
                    "#contentHash": "contentHash",
                },
                ExpressionAttributeValues={
                    ":data": snapshot["data"],
                    ":scrapedAt": snapshot["scrapedAt"],
                    ":contentHash": snapshot["contentHash"],
                },
            )
            return "artifact-provenance-enriched"
        return "already-present"
    raise RuntimeError(
        "A different inflation-nowcast snapshot already occupies the capture date"
    )


def json_default(value: Any):
    if isinstance(value, Decimal):
        return float(value)
    raise TypeError(f"Cannot serialize {type(value).__name__}")


def main() -> int:
    argument_parser = argparse.ArgumentParser(description=__doc__)
    argument_parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    argument_parser.add_argument("--table", default=DEFAULT_TABLE)
    argument_parser.add_argument("--region", default=DEFAULT_REGION)
    argument_parser.add_argument(
        "--manual-artifact",
        action="append",
        default=[],
        metavar="YYYY-MM=/absolute/path.png",
    )
    argument_parser.add_argument("--artifact-bucket")
    argument_parser.add_argument("--write", action="store_true")
    argument_parser.add_argument(
        "--admin-profile",
        default=None,
        help=f"Required for --write or --artifact-bucket (must be {ADMIN_PROFILE}).",
    )
    args = argument_parser.parse_args()

    manifest = load_manifest(args.manifest.resolve())
    forecasts = validate_manifest(manifest)
    supplied_paths = parse_manual_artifacts(args.manual_artifact)
    verify_manual_artifacts(forecasts, supplied_paths)
    needs_write = bool(args.write or args.artifact_bucket)
    session = None
    if needs_write:
        if args.admin_profile != ADMIN_PROFILE:
            argument_parser.error(f"--write/--artifact-bucket requires --admin-profile {ADMIN_PROFILE}")
        try:
            session = verified_session(args.admin_profile, purpose="admin", region=args.region)
        except AwsProfileContractError as error:
            argument_parser.error(f"{error.error_code}: {error.detail}")
    if args.artifact_bucket:
        upload_manual_artifacts(
            forecasts,
            supplied_paths,
            bucket=args.artifact_bucket,
            region=args.region,
            session=session,
        )
    snapshot = build_snapshot(manifest)
    result = (
        persist_snapshot(snapshot, table_name=args.table, region=args.region, session=session)
        if args.write
        else "dry-run"
    )
    print(
        json.dumps(
            {
                "result": result,
                "date": snapshot["date"],
                "snapshotType": snapshot["snapshotType"],
                "forecastCount": snapshot["forecastCount"],
                "contentHash": snapshot["contentHash"],
            },
            default=json_default,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
