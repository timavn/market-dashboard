#!/usr/bin/env python3
"""Prepare and apply the bounded ten-date Top 3 Things Gmail replay."""

from __future__ import annotations

import argparse
import base64
import configparser
import hashlib
import hmac
import json
import os
import re
import secrets
import stat
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

import boto3
from boto3.dynamodb.conditions import Attr


REPO_ROOT = Path(__file__).resolve().parents[2]
INGESTOR_MODULE_DIR = REPO_ROOT / "infra" / "lambdas" / "gmail_ingestor"
if str(INGESTOR_MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(INGESTOR_MODULE_DIR))

from hermes_gmail_ingestor import (  # noqa: E402
    MATERIALIZED_DATA_VERSION,
    OPERATOR_REPLAY_SOURCE,
    RESEARCH_PARSER_VERSION,
    infer_report_type,
)
from parse_hedgeye_email_html import parse_html_snapshot  # noqa: E402
from prepare_tested_release import verify_release_receipt  # noqa: E402
from research_intelligence import PARSER_VERSION as SECURITY_PARSER_VERSION  # noqa: E402


ACCOUNT = "915328198276"
REGION = "us-west-1"
ADMIN_PROFILE = "market-dashboard-admin"
FUNCTION = "market-dashboard-gmail-ingestor-v2"
FUNCTION_ARN = f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:{FUNCTION}"
SCHEDULE = "market-dashboard-gmail-v2-every-15m"
SCHEDULE_EXPRESSION = "rate(15 minutes)"
LEDGER_TABLE = "HermesEmailIngestLedger"
SNAPSHOT_TABLE = "HedgeyeDailySnapshot"
RUNTIME_STATE_KEY = {
    "messageId": "runtime#gmail#timsmithaviation@gmail.com",
    "attachmentId": "history-cursor",
}
ARCHIVE_URL = "http://127.0.0.1:3001/api/hedgeye/tldr/archive"
VISIBLE_DATE_COUNT = 10
OPERATOR_BATCH_SIZE = 8
MAX_SCAN_PAGES = 20
SCAN_PAGE_LIMIT = 1000
MAX_ARTIFACT_BYTES = 4 * 1024 * 1024
MAX_INVOCATIONS_PER_BATCH = 5
RECEIPT_SCHEMA_VERSION = 1
RECEIPT_KIND = "market-dashboard-top-three-visible-backfill"
INCIDENT_PROFILE = "top-three-visible-10-v1"
ALLOWED_SOURCE_STATUSES = frozenset({"INDEXED", "STORED", "UNSUPPORTED"})
HEX64 = re.compile(r"^[0-9a-f]{64}$")
DATE = re.compile(r"^20\d{2}-\d{2}-\d{2}$")


class TopThreeBackfillFailure(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def parse_time(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def json_default(value: Any) -> str:
    if isinstance(value, Decimal):
        return str(value)
    raise TypeError(f"Cannot encode {type(value).__name__}")


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            default=json_default,
        ).encode("utf-8")
    ).hexdigest()


def _private_directory(path: Path) -> None:
    if (
        path.is_symlink()
        or not path.is_dir()
        or stat.S_IMODE(path.stat().st_mode) & 0o077
    ):
        raise TopThreeBackfillFailure(
            "TOP_THREE_RECEIPT_UNSAFE",
            "Receipt directory must be private.",
        )


def _private_file(path: Path) -> None:
    if (
        path.is_symlink()
        or not path.is_file()
        or stat.S_IMODE(path.stat().st_mode) != 0o600
    ):
        raise TopThreeBackfillFailure(
            "TOP_THREE_RECEIPT_UNSAFE",
            "Receipt and key must be mode-0600 regular files.",
        )


def _outside_repo(path: Path) -> Path:
    if not path.is_absolute():
        raise TopThreeBackfillFailure(
            "TOP_THREE_RECEIPT_UNSAFE",
            "Receipt paths must be absolute.",
        )
    resolved = path.resolve(strict=False)
    try:
        resolved.relative_to(REPO_ROOT)
    except ValueError:
        return resolved
    raise TopThreeBackfillFailure(
        "TOP_THREE_RECEIPT_UNSAFE",
        "Receipt paths must be outside the repository.",
    )


def load_key(path: Path, *, create: bool) -> bytes:
    path = _outside_repo(path)
    if not path.exists():
        if not create:
            raise TopThreeBackfillFailure(
                "TOP_THREE_RECEIPT_KEY_MISSING",
                "The private receipt key is missing.",
            )
        _private_directory(path.parent)
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(descriptor, secrets.token_bytes(32))
        finally:
            os.close(descriptor)
    _private_file(path)
    key = path.read_bytes()
    if len(key) < 32:
        raise TopThreeBackfillFailure(
            "TOP_THREE_RECEIPT_KEY_INVALID",
            "The receipt key must contain at least 256 bits.",
        )
    return key


def sign(payload: Mapping[str, Any], key: bytes) -> str:
    return hmac.new(
        key,
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode(),
        hashlib.sha256,
    ).hexdigest()


def write_receipt(path: Path, key_path: Path, payload: Mapping[str, Any]) -> Path:
    path = _outside_repo(path)
    key_path = _outside_repo(key_path)
    if path.exists():
        raise TopThreeBackfillFailure(
            "TOP_THREE_RECEIPT_EXISTS",
            "Refusing to overwrite an existing receipt.",
        )
    _private_directory(path.parent)
    if path.resolve(strict=False) == key_path.resolve(strict=False):
        raise TopThreeBackfillFailure(
            "TOP_THREE_RECEIPT_UNSAFE",
            "Receipt and key paths must differ.",
        )
    receipt = {
        **dict(payload),
        "authentication": {
            "algorithm": "HMAC-SHA256",
            "value": sign(payload, load_key(key_path, create=True)),
        },
    }
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(
            descriptor,
            (json.dumps(receipt, sort_keys=True, indent=2) + "\n").encode(),
        )
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    _private_file(path)
    return path


def load_receipt(path: Path, key_path: Path) -> dict[str, Any]:
    path = _outside_repo(path)
    _private_file(path)
    try:
        receipt = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, TypeError, ValueError) as error:
        raise TopThreeBackfillFailure(
            "TOP_THREE_RECEIPT_INVALID",
            "Receipt JSON is invalid.",
        ) from error
    payload = {
        key: value for key, value in receipt.items() if key != "authentication"
    }
    authentication = receipt.get("authentication") or {}
    if (
        authentication.get("algorithm") != "HMAC-SHA256"
        or not hmac.compare_digest(
            str(authentication.get("value") or ""),
            sign(payload, load_key(_outside_repo(key_path), create=False)),
        )
    ):
        raise TopThreeBackfillFailure(
            "TOP_THREE_RECEIPT_AUTHENTICATION_FAILED",
            "Receipt authentication failed.",
        )
    validate_receipt_payload(payload)
    return payload


def validate_receipt_payload(payload: Mapping[str, Any]) -> None:
    dates = payload.get("visibleDates")
    artifacts = payload.get("artifacts")
    macro_snapshots = payload.get("macroSnapshots")
    if (
        payload.get("schemaVersion") != RECEIPT_SCHEMA_VERSION
        or payload.get("kind") != RECEIPT_KIND
        or payload.get("incidentProfile") != INCIDENT_PROFILE
        or payload.get("account") != ACCOUNT
        or payload.get("region") != REGION
        or payload.get("functionName") != FUNCTION
        or payload.get("scheduleId") != SCHEDULE
        or payload.get("materializationVersion") != MATERIALIZED_DATA_VERSION
        or not isinstance(dates, list)
        or len(dates) != VISIBLE_DATE_COUNT
        or len(set(dates)) != VISIBLE_DATE_COUNT
        or any(not DATE.fullmatch(str(value)) for value in dates)
        or not isinstance(artifacts, list)
        or len(artifacts) != VISIBLE_DATE_COUNT
        or not isinstance(macro_snapshots, list)
        or len(macro_snapshots) != VISIBLE_DATE_COUNT
    ):
        raise TopThreeBackfillFailure(
            "TOP_THREE_RECEIPT_INVALID",
            "Receipt scope is invalid.",
        )
    artifact_dates = {str(item.get("snapshotDate") or "") for item in artifacts}
    message_ids = [str(item.get("messageId") or "") for item in artifacts]
    if (
        artifact_dates != set(dates)
        or len(set(message_ids)) != VISIBLE_DATE_COUNT
        or any(not re.fullmatch(r"[0-9a-f]{16,32}", value) for value in message_ids)
        or any(
            item.get("targetProductType") != "top-3-things"
            or not HEX64.fullmatch(str(item.get("contentSha256") or ""))
            or int(item.get("archivedByteSize") or 0) <= 0
            for item in artifacts
        )
        or {str(item.get("date") or "") for item in macro_snapshots} != set(dates)
        or any(
            not HEX64.fullmatch(str(item.get("fingerprint") or ""))
            for item in macro_snapshots
        )
    ):
        raise TopThreeBackfillFailure(
            "TOP_THREE_RECEIPT_INVALID",
            "Receipt artifact evidence is invalid.",
        )


def require_sso_profile(profile: str) -> None:
    if profile != ADMIN_PROFILE:
        raise TopThreeBackfillFailure(
            "AWS_SSO_PROFILE_REQUIRED",
            f"Top 3 backfill requires {ADMIN_PROFILE}.",
        )
    config = configparser.RawConfigParser()
    config_path = Path.home() / ".aws" / "config"
    section = f"profile {profile}"
    if (
        not config_path.is_file()
        or not config.read(config_path)
        or not config.has_section(section)
        or config[section].get("sso_account_id") != ACCOUNT
        or config[section].get("region") != REGION
    ):
        raise TopThreeBackfillFailure(
            "AWS_SSO_PROFILE_REQUIRED",
            "The administrator SSO profile is not pinned to the expected account and region.",
        )


def session_for(profile: str) -> Any:
    require_sso_profile(profile)
    for key in (
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_SECURITY_TOKEN",
        "AWS_PROFILE",
        "AWS_DEFAULT_PROFILE",
        "AWS_CONFIG_FILE",
        "AWS_SHARED_CREDENTIALS_FILE",
    ):
        os.environ.pop(key, None)
    os.environ["AWS_EC2_METADATA_DISABLED"] = "true"
    session = boto3.Session(profile_name=profile, region_name=REGION)
    if str(session.client("sts").get_caller_identity().get("Account") or "") != ACCOUNT:
        raise TopThreeBackfillFailure(
            "AWS_ACCOUNT_MISMATCH",
            "Top 3 backfill resolved to the wrong AWS account.",
        )
    return session


def validate_schedule(schedule: Mapping[str, Any], required_state: str) -> None:
    target = schedule.get("Target") or {}
    try:
        target_input = json.loads(str(target.get("Input") or ""))
    except (TypeError, ValueError) as error:
        raise TopThreeBackfillFailure(
            "GMAIL_SCHEDULE_CONTRACT_INVALID",
            "Gmail schedule input is invalid.",
        ) from error
    if (
        schedule.get("Name") != SCHEDULE
        or schedule.get("State") != required_state
        or schedule.get("ScheduleExpression") != SCHEDULE_EXPRESSION
        or target.get("Arn") != FUNCTION_ARN
        or target_input.get("scheduleId") != SCHEDULE
        or target_input.get("source") != "aws-scheduler"
        or target_input.get("poll") != "incremental"
    ):
        raise TopThreeBackfillFailure(
            "GMAIL_SCHEDULE_CONTRACT_INVALID",
            f"Gmail schedule is not in the required {required_state} state.",
        )


def validate_function(
    configuration: Mapping[str, Any],
    *,
    expected_build: str | None = None,
) -> None:
    variables = ((configuration.get("Environment") or {}).get("Variables") or {})
    if (
        configuration.get("FunctionName") != FUNCTION
        or configuration.get("State") != "Active"
        or configuration.get("LastUpdateStatus") != "Successful"
    ):
        raise TopThreeBackfillFailure(
            "GMAIL_FUNCTION_NOT_READY",
            "Gmail Lambda is not active and successful.",
        )
    if expected_build and variables.get("BUILD_VERSION") != expected_build:
        raise TopThreeBackfillFailure(
            "GMAIL_BUILD_VERSION_MISMATCH",
            "Gmail Lambda is not running the tested Top 3 release.",
        )


def current_commit() -> str:
    result = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=False,
    )
    commit = (result.stdout or "").strip()
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise TopThreeBackfillFailure(
            "GMAIL_RELEASE_COMMIT_UNAVAILABLE",
            "The local release commit could not be verified.",
        )
    return commit


def runtime_state(ledger: Any) -> Mapping[str, Any]:
    return ledger.get_item(
        Key=RUNTIME_STATE_KEY,
        ConsistentRead=True,
    ).get("Item") or {}


def require_idle_runtime(ledger: Any) -> Mapping[str, Any]:
    state = runtime_state(ledger)
    if (
        state.get("status") == "IN_PROGRESS"
        or state.get("activeBatchId")
        or state.get("pendingPollMode")
        or state.get("pendingHistoryId") is not None
        or state.get("pendingForceBackfill") is True
        or state.get("discoveryStatus") == "IN_PROGRESS"
    ):
        raise TopThreeBackfillFailure(
            "GMAIL_RUNTIME_BUSY",
            "The Gmail ingestor has active work.",
        )
    return state


def load_visible_dates(url: str = ARCHIVE_URL) -> list[str]:
    if url != ARCHIVE_URL:
        raise TopThreeBackfillFailure(
            "TOP_THREE_ARCHIVE_URL_INVALID",
            "The archive source must be the canonical loopback endpoint.",
        )
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            payload = json.load(response)
    except Exception as error:
        raise TopThreeBackfillFailure(
            "TOP_THREE_ARCHIVE_UNAVAILABLE",
            "The local TL;DR archive could not be read.",
        ) from error
    rows = payload.get("dates") if isinstance(payload, Mapping) else None
    dates = [
        str(row.get("date") or "")
        for row in (rows or [])[:VISIBLE_DATE_COUNT]
        if isinstance(row, Mapping)
    ]
    if (
        len(dates) != VISIBLE_DATE_COUNT
        or len(set(dates)) != VISIBLE_DATE_COUNT
        or any(not DATE.fullmatch(value) for value in dates)
    ):
        raise TopThreeBackfillFailure(
            "TOP_THREE_ARCHIVE_SCOPE_INVALID",
            "The TL;DR archive does not expose exactly ten valid visible dates.",
        )
    return dates


def scan_candidate_rows(ledger: Any, visible_dates: Sequence[str]) -> list[Mapping[str, Any]]:
    condition = (
        Attr("attachmentId").begins_with("message-body-")
        & (
            Attr("subject").contains("Top 3 Things")
            | Attr("subject").contains("Top Three Things")
        )
    )
    rows: list[Mapping[str, Any]] = []
    last_key = None
    for _ in range(MAX_SCAN_PAGES):
        request: dict[str, Any] = {
            "FilterExpression": condition,
            "ConsistentRead": True,
            "Limit": SCAN_PAGE_LIMIT,
        }
        if last_key:
            request["ExclusiveStartKey"] = last_key
        response = ledger.scan(**request) or {}
        rows.extend(response.get("Items") or [])
        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            break
    if last_key:
        raise TopThreeBackfillFailure(
            "TOP_THREE_LEDGER_SCAN_LIMIT",
            "The bounded ledger scan did not complete.",
        )
    visible = set(visible_dates)
    candidates = []
    for row in rows:
        received_at = parse_time(row.get("receivedAt") or row.get("createdAt"))
        if (
            received_at is None
            or received_at.date().isoformat() not in visible
            or str(row.get("mimeType") or "").lower() != "text/html"
            or row.get("status") not in ALLOWED_SOURCE_STATUSES
            or not row.get("s3Bucket")
            or not row.get("s3Key")
            or not HEX64.fullmatch(str(row.get("contentSha256") or "").lower())
            or infer_report_type(
                str(row.get("filename") or ""),
                str(row.get("subject") or ""),
            )
            != "top-3-things"
        ):
            continue
        candidates.append(row)
    return candidates


def read_verified_artifact(s3: Any, row: Mapping[str, Any]) -> bytes:
    body = s3.get_object(Bucket=row["s3Bucket"], Key=row["s3Key"])["Body"].read(
        MAX_ARTIFACT_BYTES + 1
    )
    expected = str(row.get("contentSha256") or "").lower()
    if (
        len(body) > MAX_ARTIFACT_BYTES
        or hashlib.sha256(body).hexdigest() != expected
        or (
            row.get("byteSize") is not None
            and int(row.get("byteSize") or 0) != len(body)
        )
    ):
        raise TopThreeBackfillFailure(
            "TOP_THREE_ARTIFACT_HASH_MISMATCH",
            "An immutable Top 3 artifact did not match its ledger evidence.",
        )
    return body


def validate_top_three_snapshot(snapshot: Mapping[str, Any], expected_date: str) -> None:
    items = (snapshot.get("data") or {}).get("items") or []
    if (
        snapshot.get("snapshotType") != "top-3-things"
        or snapshot.get("date") != expected_date
        or int(snapshot.get("itemCount") or 0) != 3
        or len(items) != 3
        or [item.get("rank") for item in items] != [1, 2, 3]
        or any(
            not str(item.get("title") or "").strip()
            or not str(item.get("body") or "").strip()
            for item in items
        )
    ):
        raise TopThreeBackfillFailure(
            "TOP_THREE_PARSE_INVALID",
            "A selected publication did not produce exactly three ranked items.",
        )


def parsed_candidate(s3: Any, row: Mapping[str, Any]) -> dict[str, Any]:
    received_at = parse_time(row.get("receivedAt") or row.get("createdAt"))
    if received_at is None:
        raise TopThreeBackfillFailure(
            "TOP_THREE_LEDGER_EVIDENCE_INVALID",
            "A Top 3 candidate has no valid receipt time.",
        )
    body = read_verified_artifact(s3, row)
    snapshot = parse_html_snapshot(
        report_type="top-3-things",
        html_body=body.decode("utf-8", errors="replace"),
        received_at=received_at,
        s3_key=str(row["s3Key"]),
        message_id=str(row["messageId"]),
        subject=str(row.get("subject") or ""),
    )
    validate_top_three_snapshot(snapshot or {}, received_at.date().isoformat())
    return {
        "messageId": str(row["messageId"]),
        "attachmentId": str(row["attachmentId"]),
        "snapshotDate": str(snapshot["date"]),
        "receivedAt": received_at.isoformat(),
        "sourceReportType": str(row.get("reportType") or "unknown"),
        "targetProductType": "top-3-things",
        "sourceStatus": str(row.get("status") or ""),
        "sourceSnapshotType": row.get("snapshotType"),
        "sourceMaterializationStatus": row.get("materializationStatus"),
        "sourceAttemptVersion": row.get("materializationAttemptVersion"),
        "sourceUpdatedAt": str(row.get("updatedAt") or ""),
        "contentSha256": str(row["contentSha256"]).lower(),
        "archivedByteSize": len(body),
        "s3Bucket": str(row["s3Bucket"]),
        "s3Key": str(row["s3Key"]),
        "subjectSha256": hashlib.sha256(
            str(row.get("subject") or "").encode("utf-8")
        ).hexdigest(),
    }


def select_latest_artifacts(
    s3: Any,
    rows: Sequence[Mapping[str, Any]],
    visible_dates: Sequence[str],
) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {
        date: [] for date in visible_dates
    }
    for row in rows:
        try:
            candidate = parsed_candidate(s3, row)
        except TopThreeBackfillFailure as error:
            if error.code == "TOP_THREE_PARSE_INVALID":
                continue
            raise
        if candidate["snapshotDate"] in grouped:
            grouped[candidate["snapshotDate"]].append(candidate)
    missing = [date for date, candidates in grouped.items() if not candidates]
    if missing:
        raise TopThreeBackfillFailure(
            "TOP_THREE_DATE_MISSING",
            "No valid Top 3 publication was found for: " + ", ".join(missing),
        )
    selected = [
        max(
            grouped[date],
            key=lambda item: (item["receivedAt"], item["messageId"]),
        )
        for date in visible_dates
    ]
    if len({item["messageId"] for item in selected}) != len(visible_dates):
        raise TopThreeBackfillFailure(
            "TOP_THREE_SELECTION_INVALID",
            "Top 3 selection reused a Gmail message across visible dates.",
        )
    return selected


def macro_snapshot_fingerprint(snapshot: Mapping[str, Any]) -> str:
    return canonical_hash(
        {
            "date": snapshot.get("date"),
            "snapshotType": snapshot.get("snapshotType"),
            "reportType": snapshot.get("reportType"),
            "gmailMessageId": snapshot.get("gmailMessageId"),
            "htmlSource": snapshot.get("htmlSource"),
            "headline": (snapshot.get("article") or {}).get("headline"),
        }
    )


def capture_macro_snapshots(
    snapshots: Any,
    selected: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    result = []
    for artifact in selected:
        date = artifact["snapshotDate"]
        snapshot = snapshots.get_item(
            Key={"date": date, "snapshotType": "the-macro-show"},
            ConsistentRead=True,
        ).get("Item") or {}
        headline = str((snapshot.get("article") or {}).get("headline") or "")
        if (
            snapshot.get("snapshotType") != "the-macro-show"
            or snapshot.get("reportType") != "the-macro-show"
            or not re.search(r"Summary Notes\s*&\s*Replay", headline, re.IGNORECASE)
            or snapshot.get("gmailMessageId") == artifact["messageId"]
        ):
            raise TopThreeBackfillFailure(
                "TOP_THREE_MACRO_SUMMARY_MISSING",
                "A visible date is not protected by a separate Macro Show Summary edition.",
            )
        result.append(
            {
                "date": date,
                "sourceMessageId": snapshot.get("gmailMessageId"),
                "fingerprint": macro_snapshot_fingerprint(snapshot),
            }
        )
    return result


def verify_macro_snapshots(
    snapshots: Any,
    evidence: Sequence[Mapping[str, Any]],
) -> None:
    for expected in evidence:
        snapshot = snapshots.get_item(
            Key={
                "date": expected["date"],
                "snapshotType": "the-macro-show",
            },
            ConsistentRead=True,
        ).get("Item") or {}
        if (
            snapshot.get("gmailMessageId") != expected.get("sourceMessageId")
            or macro_snapshot_fingerprint(snapshot) != expected.get("fingerprint")
        ):
            raise TopThreeBackfillFailure(
                "TOP_THREE_MACRO_SUMMARY_DRIFT",
                "A protected Macro Show Summary edition changed or disappeared.",
            )


def receipt_payload(
    function: Mapping[str, Any],
    visible_dates: Sequence[str],
    artifacts: Sequence[Mapping[str, Any]],
    macro_snapshots: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    variables = ((function.get("Environment") or {}).get("Variables") or {})
    return {
        "schemaVersion": RECEIPT_SCHEMA_VERSION,
        "kind": RECEIPT_KIND,
        "incidentProfile": INCIDENT_PROFILE,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "account": ACCOUNT,
        "region": REGION,
        "functionName": FUNCTION,
        "scheduleId": SCHEDULE,
        "materializationVersion": MATERIALIZED_DATA_VERSION,
        "sourceFunction": {
            "buildVersion": variables.get("BUILD_VERSION"),
            "codeSha256": function.get("CodeSha256"),
        },
        "visibleDates": list(visible_dates),
        "artifacts": list(artifacts),
        "macroSnapshots": list(macro_snapshots),
    }


def prepare(
    profile: str,
    receipt: Path,
    key: Path,
    *,
    archive_loader: Callable[[], list[str]] = load_visible_dates,
) -> dict[str, Any]:
    session = session_for(profile)
    scheduler = session.client("scheduler")
    validate_schedule(
        scheduler.get_schedule(GroupName="default", Name=SCHEDULE),
        "ENABLED",
    )
    lambda_client = session.client("lambda")
    function = lambda_client.get_function_configuration(FunctionName=FUNCTION)
    validate_function(function)
    visible_dates = archive_loader()
    resources = session.resource("dynamodb")
    ledger = resources.Table(LEDGER_TABLE)
    require_idle_runtime(ledger)
    rows = scan_candidate_rows(ledger, visible_dates)
    selected = select_latest_artifacts(
        session.client("s3"),
        rows,
        visible_dates,
    )
    macro_snapshots = capture_macro_snapshots(
        resources.Table(SNAPSHOT_TABLE),
        selected,
    )
    write_receipt(
        receipt,
        key,
        receipt_payload(function, visible_dates, selected, macro_snapshots),
    )
    return {
        "passed": True,
        "mode": "prepare",
        "incidentProfile": INCIDENT_PROFILE,
        "visibleDateCount": len(visible_dates),
        "selectedCount": len(selected),
        "operatorBatchCount": (
            len(selected) + OPERATOR_BATCH_SIZE - 1
        ) // OPERATOR_BATCH_SIZE,
        "receiptPath": str(receipt),
    }


def verified_release_code_hashes(release: Mapping[str, Any]) -> set[str]:
    return {
        base64.b64encode(bytes.fromhex(str(item["contentSha256"]))).decode()
        for item in release.get("artifacts") or []
        if HEX64.fullmatch(str(item.get("contentSha256") or ""))
    }


def verify_current_artifact(
    ledger: Any,
    s3: Any,
    selected: Mapping[str, Any],
) -> bool:
    current = ledger.get_item(
        Key={
            "messageId": selected["messageId"],
            "attachmentId": selected["attachmentId"],
        },
        ConsistentRead=True,
    ).get("Item") or {}
    immutable_matches = (
        current.get("contentSha256") == selected.get("contentSha256")
        and current.get("s3Bucket") == selected.get("s3Bucket")
        and current.get("s3Key") == selected.get("s3Key")
        and hashlib.sha256(
            str(current.get("subject") or "").encode("utf-8")
        ).hexdigest()
        == selected.get("subjectSha256")
    )
    if not immutable_matches:
        raise TopThreeBackfillFailure(
            "TOP_THREE_LEDGER_EVIDENCE_DRIFT",
            "A selected immutable ledger row changed before replay.",
        )
    body = read_verified_artifact(s3, current)
    if len(body) != int(selected.get("archivedByteSize") or 0):
        raise TopThreeBackfillFailure(
            "TOP_THREE_ARTIFACT_HASH_MISMATCH",
            "A selected artifact changed size before replay.",
        )
    already_indexed = (
        current.get("status") == "INDEXED"
        and current.get("materializationStatus") == "INDEXED"
        and current.get("materializationAttemptVersion")
        == MATERIALIZED_DATA_VERSION
        and current.get("reportType") == "top-3-things"
        and current.get("snapshotType") == "top-3-things"
        and current.get("researchParserVersion") == RESEARCH_PARSER_VERSION
        and current.get("securityIntelligenceParserVersion")
        == SECURITY_PARSER_VERSION
    )
    if already_indexed:
        return False
    original_matches = (
        current.get("status") == selected.get("sourceStatus")
        and current.get("reportType") == selected.get("sourceReportType")
        and current.get("snapshotType") == selected.get("sourceSnapshotType")
        and current.get("materializationStatus")
        == selected.get("sourceMaterializationStatus")
        and current.get("materializationAttemptVersion")
        == selected.get("sourceAttemptVersion")
        and str(current.get("updatedAt") or "") == selected.get("sourceUpdatedAt")
    )
    if not original_matches:
        raise TopThreeBackfillFailure(
            "TOP_THREE_LEDGER_EVIDENCE_DRIFT",
            "A selected ledger row no longer matches the prepared replay state.",
        )
    return True


def parse_invocation_response(response: Mapping[str, Any]) -> Mapping[str, Any]:
    if int(response.get("StatusCode") or 0) != 200 or response.get("FunctionError"):
        raise TopThreeBackfillFailure(
            "TOP_THREE_REPLAY_INVOCATION_FAILED",
            "The Gmail Lambda invocation failed.",
        )
    raw = response.get("Payload")
    raw = raw.read() if hasattr(raw, "read") else raw
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    try:
        envelope = json.loads(str(raw or ""))
        body = (
            json.loads(envelope.get("body"))
            if isinstance(envelope.get("body"), str)
            else envelope.get("body")
        )
    except (TypeError, ValueError) as error:
        raise TopThreeBackfillFailure(
            "TOP_THREE_REPLAY_RESPONSE_INVALID",
            "The Gmail Lambda response was invalid.",
        ) from error
    if (
        int(envelope.get("statusCode") or 0) != 200
        or not isinstance(body, Mapping)
        or body.get("status") not in {"SUCCESS", "ATTENTION", "IN_PROGRESS"}
        or int(body.get("errorCount") or 0) != 0
        or body.get("pollMode") not in {"operator_replay", None}
    ):
        raise TopThreeBackfillFailure(
            "TOP_THREE_REPLAY_MATERIALIZATION_FAILED",
            "A Top 3 replay batch did not materialize successfully.",
        )
    return body


def invoke_batch_until_complete(
    lambda_client: Any,
    message_ids: Sequence[str],
) -> int:
    if not 1 <= len(message_ids) <= OPERATOR_BATCH_SIZE:
        raise TopThreeBackfillFailure(
            "TOP_THREE_REPLAY_BATCH_INVALID",
            "Operator replay batch size is outside the bounded contract.",
        )
    event = {
        "source": OPERATOR_REPLAY_SOURCE,
        "messageIds": list(message_ids),
        "forceBackfill": True,
        "materializationVersion": MATERIALIZED_DATA_VERSION,
    }
    for attempt in range(1, MAX_INVOCATIONS_PER_BATCH + 1):
        body = parse_invocation_response(
            lambda_client.invoke(
                FunctionName=FUNCTION,
                InvocationType="RequestResponse",
                Payload=json.dumps(event, separators=(",", ":")).encode(),
            )
        )
        if (
            body.get("status") in {"SUCCESS", "ATTENTION"}
            and int(body.get("remainingCount") or 0) == 0
        ):
            return attempt
    raise TopThreeBackfillFailure(
        "TOP_THREE_REPLAY_INCOMPLETE",
        "A Top 3 replay batch did not finish within its invocation limit.",
    )


def verify_top_three_snapshots(
    snapshots: Any,
    selected: Sequence[Mapping[str, Any]],
) -> None:
    for artifact in selected:
        snapshot = snapshots.get_item(
            Key={
                "date": artifact["snapshotDate"],
                "snapshotType": "top-3-things",
            },
            ConsistentRead=True,
        ).get("Item") or {}
        validate_top_three_snapshot(snapshot, artifact["snapshotDate"])
        if (
            snapshot.get("gmailMessageId") != artifact["messageId"]
            or artifact["messageId"] not in (snapshot.get("sourceMessageIds") or [])
            or not str(snapshot.get("dataVersion") or "").startswith(
                f"{MATERIALIZED_DATA_VERSION}:"
            )
        ):
            raise TopThreeBackfillFailure(
                "TOP_THREE_SNAPSHOT_VERIFICATION_FAILED",
                "A materialized Top 3 snapshot did not match its selected source.",
            )


def apply(
    profile: str,
    receipt: Path,
    key: Path,
    *,
    release_receipt: Path,
    release_key: Path,
    release_commit: str | None = None,
) -> dict[str, Any]:
    payload = load_receipt(receipt, key)
    session = session_for(profile)
    scheduler = session.client("scheduler")
    validate_schedule(
        scheduler.get_schedule(GroupName="default", Name=SCHEDULE),
        "DISABLED",
    )
    expected_commit = release_commit or current_commit()
    release = verify_release_receipt(
        release_receipt,
        expected_commit=expected_commit,
        key_path=release_key,
        repo_root=REPO_ROOT,
    )
    lambda_client = session.client("lambda")
    function = lambda_client.get_function_configuration(FunctionName=FUNCTION)
    validate_function(function, expected_build=expected_commit)
    if function.get("CodeSha256") not in verified_release_code_hashes(release):
        raise TopThreeBackfillFailure(
            "TOP_THREE_TESTED_CODE_HASH_MISMATCH",
            "The deployed Gmail code hash is not part of the tested release.",
        )
    resources = session.resource("dynamodb")
    ledger = resources.Table(LEDGER_TABLE)
    require_idle_runtime(ledger)
    snapshots = resources.Table(SNAPSHOT_TABLE)
    verify_macro_snapshots(snapshots, payload["macroSnapshots"])
    s3 = session.client("s3")
    selected = list(payload["artifacts"])
    needs_replay = [
        artifact
        for artifact in selected
        if verify_current_artifact(ledger, s3, artifact)
    ]
    ordered = sorted(
        needs_replay,
        key=lambda item: (item["receivedAt"], item["messageId"]),
    )
    invocation_count = 0
    batch_count = 0
    for offset in range(0, len(ordered), OPERATOR_BATCH_SIZE):
        batch = ordered[offset : offset + OPERATOR_BATCH_SIZE]
        invocation_count += invoke_batch_until_complete(
            lambda_client,
            [item["messageId"] for item in batch],
        )
        batch_count += 1
        require_idle_runtime(ledger)
    for artifact in selected:
        if verify_current_artifact(ledger, s3, artifact):
            raise TopThreeBackfillFailure(
                "TOP_THREE_REPLAY_POSTCHECK_FAILED",
                "A selected ledger row did not reach the tested Top 3 state.",
            )
    verify_top_three_snapshots(snapshots, selected)
    verify_macro_snapshots(snapshots, payload["macroSnapshots"])
    require_idle_runtime(ledger)
    return {
        "passed": True,
        "mode": "apply",
        "incidentProfile": INCIDENT_PROFILE,
        "selectedCount": len(selected),
        "replayedCount": len(needs_replay),
        "skippedCount": len(selected) - len(needs_replay),
        "operatorBatchCount": batch_count,
        "invocationCount": invocation_count,
        "status": "SUCCESS",
    }


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--prepare", action="store_true")
    mode.add_argument("--apply", action="store_true")
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--receipt-key", type=Path, required=True)
    parser.add_argument("--admin-profile", default=ADMIN_PROFILE)
    parser.add_argument("--release-commit")
    parser.add_argument("--release-receipt", type=Path)
    parser.add_argument("--release-key", type=Path)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.apply and (args.release_receipt is None or args.release_key is None):
            raise TopThreeBackfillFailure(
                "TOP_THREE_TESTED_RELEASE_RECEIPT_REQUIRED",
                "Apply requires the tested-release receipt and key.",
            )
        result = (
            prepare(
                args.admin_profile,
                args.receipt,
                args.receipt_key,
            )
            if args.prepare
            else apply(
                args.admin_profile,
                args.receipt,
                args.receipt_key,
                release_receipt=args.release_receipt,
                release_key=args.release_key,
                release_commit=args.release_commit,
            )
        )
        print(json.dumps(result, sort_keys=True, indent=2))
        return 0
    except TopThreeBackfillFailure as error:
        print(
            json.dumps(
                {
                    "passed": False,
                    "error": {"code": error.code, "message": str(error)},
                },
                indent=2,
            ),
            file=sys.stderr,
        )
        return 2
    except Exception as error:
        print(
            json.dumps(
                {
                    "passed": False,
                    "error": {
                        "code": "TOP_THREE_BACKFILL_AWS_ERROR",
                        "message": f"Unexpected {type(error).__name__}.",
                    },
                },
                indent=2,
            ),
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
