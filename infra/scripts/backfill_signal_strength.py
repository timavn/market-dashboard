#!/usr/bin/env python3
"""Prepare and apply the bounded Signal Strength Gmail replay.

Hedgeye moved Signal Strength to an HTML table with ADDING/REMOVING lines on
2026-09-25 and added a separate "Signal Strength Shorts" email on 2026-10-15.
Editions imported before the parser fix kept only the stock count; every
Shorts edition was quarantined. Prepare parses each archived edition since
the format change with the tested parser, records the membership it must
produce, and writes an authenticated private receipt. Apply runs against the
deployed tested release while the Gmail schedule is disabled, replays at most
eight messages per invocation, and verifies every day's long and short books
against the receipt.

Signal Strength Shorts is its own product (snapshot type
``signal-strength-shorts``). Editions materialized before the split kept the
short book under the long row's ``data.shorts``; replaying them moves it to
its own row, and apply retires the short editions from the long row.

Receipt, session, schedule, release and invocation guards are shared with the
Top 3 Things replay.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from boto3.dynamodb.conditions import Attr

import backfill_top_three_things as shared
# Importing the shared replay also puts the Gmail ingestor modules on sys.path.
from backfill_top_three_things import (
    ACCOUNT,
    FUNCTION,
    LEDGER_TABLE,
    OPERATOR_BATCH_SIZE,
    REGION,
    SCHEDULE,
    SNAPSHOT_TABLE,
    TopThreeBackfillFailure,
    current_commit,
    invoke_batch_until_complete,
    load_key,
    parse_time,
    read_verified_artifact,
    require_idle_runtime,
    session_for,
    sign,
    validate_function,
    validate_schedule,
    verified_release_code_hashes,
    write_receipt,
)
from hermes_gmail_ingestor import (  # noqa: E402
    MATERIALIZED_DATA_VERSION,
    RESEARCH_PARSER_VERSION,
    infer_report_type,
)
from parse_hedgeye_email_html import parse_html_snapshot  # noqa: E402
from prepare_tested_release import verify_release_receipt  # noqa: E402
from research_intelligence import PARSER_VERSION as SECURITY_PARSER_VERSION  # noqa: E402


FORMAT_CHANGE_DATE = "2026-09-25"
MAX_SCAN_PAGES = 30
SCAN_PAGE_LIMIT = 1000
MAX_EDITIONS = 120
RECEIPT_SCHEMA_VERSION = 1
RECEIPT_KIND = "market-dashboard-signal-strength-backfill"
INCIDENT_PROFILE = "signal-strength-shorts-product-v1"
ALLOWED_SOURCE_STATUSES = frozenset({"INDEXED", "STORED", "ERROR"})
HEX64 = re.compile(r"^[0-9a-f]{64}$")
DATE = re.compile(r"^20\d{2}-\d{2}-\d{2}$")
MESSAGE_ID = re.compile(r"^[0-9a-f]{16,32}$")
SIDES = ("long", "short")
SNAPSHOT_TYPES = {"long": "signal-strength", "short": "signal-strength-shorts"}
SIDE_BY_SNAPSHOT_TYPE = {value: key for key, value in SNAPSHOT_TYPES.items()}


class SignalStrengthBackfillFailure(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _translated(error: TopThreeBackfillFailure) -> SignalStrengthBackfillFailure:
    """Shared guards name the Top 3 replay; report them as this replay's own."""
    return SignalStrengthBackfillFailure(
        error.code.replace("TOP_THREE_", "SIGNAL_STRENGTH_"),
        str(error).replace("Top 3 Things", "Signal Strength").replace("Top 3", "Signal Strength"),
    )


def edition_book(snapshot: Mapping[str, Any]) -> tuple[str, Mapping[str, Any], int]:
    side = SIDE_BY_SNAPSHOT_TYPE.get(str(snapshot.get("snapshotType") or ""), "long")
    return side, snapshot.get("data") or {}, int(snapshot.get("stockCount") or 0)


def scan_candidate_rows(ledger: Any, start_date: str) -> list[Mapping[str, Any]]:
    condition = (
        Attr("attachmentId").begins_with("message-body-")
        & Attr("subject").contains("Signal Strength")
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
        raise SignalStrengthBackfillFailure(
            "SIGNAL_STRENGTH_LEDGER_SCAN_LIMIT",
            "The bounded ledger scan did not complete.",
        )
    candidates = []
    for row in rows:
        received_at = parse_time(row.get("receivedAt") or row.get("createdAt"))
        if (
            received_at is None
            or received_at.date().isoformat() < start_date
            or str(row.get("mimeType") or "").lower() != "text/html"
            or row.get("status") not in ALLOWED_SOURCE_STATUSES
            or not row.get("s3Bucket")
            or not row.get("s3Key")
            or not HEX64.fullmatch(str(row.get("contentSha256") or "").lower())
            # Real-Time Alerts that mention a Signal Strength stock are
            # their own product.
            or infer_report_type(
                str(row.get("filename") or ""),
                str(row.get("subject") or ""),
            )
            not in SIDE_BY_SNAPSHOT_TYPE
        ):
            continue
        candidates.append(row)
    return candidates


def parsed_edition(s3: Any, row: Mapping[str, Any]) -> dict[str, Any] | None:
    """Return the edition's expected book, or None for a non-list notice."""
    received_at = parse_time(row.get("receivedAt") or row.get("createdAt"))
    if received_at is None:
        raise SignalStrengthBackfillFailure(
            "SIGNAL_STRENGTH_LEDGER_EVIDENCE_INVALID",
            "A Signal Strength candidate has no valid receipt time.",
        )
    try:
        body = read_verified_artifact(s3, row)
    except TopThreeBackfillFailure as error:
        raise _translated(error) from error
    snapshot = parse_html_snapshot(
        report_type=infer_report_type(str(row.get("filename") or ""), str(row.get("subject") or "")),
        html_body=body.decode("utf-8", errors="replace"),
        received_at=received_at,
        s3_key=str(row["s3Key"]),
        message_id=str(row["messageId"]),
        subject=str(row.get("subject") or ""),
    )
    if not snapshot:
        # e.g. the 2026-09-25 "New Dashboard is LIVE" announcement.
        return None
    side, book, count = edition_book(snapshot)
    stocks = book.get("stocks") or []
    if (
        not DATE.fullmatch(str(snapshot.get("date") or ""))
        or count <= 0
        or len(stocks) != count
        or book.get("membershipComplete") is not True
    ):
        raise SignalStrengthBackfillFailure(
            "SIGNAL_STRENGTH_PARSE_INCOMPLETE",
            f"A {side} edition did not yield its full published membership.",
        )
    return {
        "messageId": str(row["messageId"]),
        "attachmentId": str(row["attachmentId"]),
        "snapshotDate": str(snapshot["date"]),
        "receivedAt": received_at.isoformat(),
        "side": side,
        "stockCount": count,
        "membershipSha256": hashlib.sha256(
            ",".join(str(stock.get("ticker")) for stock in stocks).encode("utf-8")
        ).hexdigest(),
        "sourceStatus": str(row.get("status") or ""),
        "sourceReportType": str(row.get("reportType") or "unknown"),
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


def expected_books(editions: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Each day's books are its latest long and latest short editions."""
    days: dict[str, dict[str, Any]] = {}
    for edition in sorted(editions, key=lambda item: (item["receivedAt"], item["messageId"])):
        day = days.setdefault(edition["snapshotDate"], {"date": edition["snapshotDate"]})
        sources = [*(day.get(edition["side"]) or {}).get("sourceMessageIds", []), edition["messageId"]]
        day[edition["side"]] = {
            "messageId": edition["messageId"],
            "stockCount": edition["stockCount"],
            "membershipSha256": edition["membershipSha256"],
            "sourceMessageIds": sources,
        }
    return [days[date] for date in sorted(days)]


def receipt_payload(
    function: Mapping[str, Any],
    start_date: str,
    editions: Sequence[Mapping[str, Any]],
    skipped: Sequence[str],
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
        "securityIntelligenceParserVersion": SECURITY_PARSER_VERSION,
        "sourceFunction": {
            "buildVersion": variables.get("BUILD_VERSION"),
            "codeSha256": function.get("CodeSha256"),
        },
        "startDate": start_date,
        "editions": list(editions),
        "days": expected_books(editions),
        "skippedNonListMessageIds": list(skipped),
    }


def validate_receipt_payload(payload: Mapping[str, Any]) -> None:
    editions = payload.get("editions")
    days = payload.get("days")
    if (
        payload.get("schemaVersion") != RECEIPT_SCHEMA_VERSION
        or payload.get("kind") != RECEIPT_KIND
        or payload.get("incidentProfile") != INCIDENT_PROFILE
        or payload.get("account") != ACCOUNT
        or payload.get("region") != REGION
        or payload.get("functionName") != FUNCTION
        or payload.get("scheduleId") != SCHEDULE
        or payload.get("materializationVersion") != MATERIALIZED_DATA_VERSION
        or payload.get("securityIntelligenceParserVersion") != SECURITY_PARSER_VERSION
        or not DATE.fullmatch(str(payload.get("startDate") or ""))
        or not isinstance(editions, list)
        or not 1 <= len(editions) <= MAX_EDITIONS
        or not isinstance(days, list)
    ):
        raise SignalStrengthBackfillFailure(
            "SIGNAL_STRENGTH_RECEIPT_INVALID",
            "Receipt scope is invalid.",
        )
    message_ids = [str(item.get("messageId") or "") for item in editions]
    if (
        len(set(message_ids)) != len(message_ids)
        or any(not MESSAGE_ID.fullmatch(value) for value in message_ids)
        or any(
            item.get("side") not in SIDES
            or int(item.get("stockCount") or 0) <= 0
            or not HEX64.fullmatch(str(item.get("contentSha256") or ""))
            or not HEX64.fullmatch(str(item.get("membershipSha256") or ""))
            or int(item.get("archivedByteSize") or 0) <= 0
            or str(item.get("snapshotDate") or "") < payload["startDate"]
            for item in editions
        )
        or days != expected_books(editions)
    ):
        raise SignalStrengthBackfillFailure(
            "SIGNAL_STRENGTH_RECEIPT_INVALID",
            "Receipt edition evidence is invalid.",
        )


def load_receipt(path: Path, key_path: Path) -> dict[str, Any]:
    try:
        path = shared._outside_repo(path)
        shared._private_file(path)
        receipt = json.loads(path.read_text(encoding="utf-8"))
        payload = {key: value for key, value in receipt.items() if key != "authentication"}
        expected = sign(payload, load_key(shared._outside_repo(key_path), create=False))
    except TopThreeBackfillFailure as error:
        raise _translated(error) from error
    except (OSError, TypeError, ValueError) as error:
        raise SignalStrengthBackfillFailure(
            "SIGNAL_STRENGTH_RECEIPT_INVALID",
            "Receipt JSON is invalid.",
        ) from error
    authentication = receipt.get("authentication") or {}
    if (
        authentication.get("algorithm") != "HMAC-SHA256"
        or not hmac.compare_digest(str(authentication.get("value") or ""), expected)
    ):
        raise SignalStrengthBackfillFailure(
            "SIGNAL_STRENGTH_RECEIPT_AUTHENTICATION_FAILED",
            "Receipt authentication failed.",
        )
    validate_receipt_payload(payload)
    return payload


def prepare(
    profile: str,
    receipt: Path,
    key: Path,
    *,
    start_date: str = FORMAT_CHANGE_DATE,
) -> dict[str, Any]:
    if not DATE.fullmatch(start_date) or start_date < FORMAT_CHANGE_DATE:
        raise SignalStrengthBackfillFailure(
            "SIGNAL_STRENGTH_SCOPE_INVALID",
            f"The replay starts at the format change ({FORMAT_CHANGE_DATE}) or later.",
        )
    session = session_for(profile)
    validate_schedule(
        session.client("scheduler").get_schedule(GroupName="default", Name=SCHEDULE),
        "ENABLED",
    )
    function = session.client("lambda").get_function_configuration(FunctionName=FUNCTION)
    validate_function(function)
    ledger = session.resource("dynamodb").Table(LEDGER_TABLE)
    require_idle_runtime(ledger)
    s3 = session.client("s3")
    editions, skipped = [], []
    for row in scan_candidate_rows(ledger, start_date):
        edition = parsed_edition(s3, row)
        if edition is None:
            skipped.append(str(row["messageId"]))
        else:
            editions.append(edition)
    if not editions or len(editions) > MAX_EDITIONS:
        raise SignalStrengthBackfillFailure(
            "SIGNAL_STRENGTH_SCOPE_INVALID",
            "The ledger did not yield a bounded set of Signal Strength editions.",
        )
    editions.sort(key=lambda item: (item["receivedAt"], item["messageId"]))
    write_receipt(receipt, key, receipt_payload(function, start_date, editions, skipped))
    days = expected_books(editions)
    return {
        "passed": True,
        "mode": "prepare",
        "incidentProfile": INCIDENT_PROFILE,
        "startDate": start_date,
        "editionCount": len(editions),
        "longEditionCount": sum(item["side"] == "long" for item in editions),
        "shortEditionCount": sum(item["side"] == "short" for item in editions),
        "skippedNonListCount": len(skipped),
        "dayCount": len(days),
        "operatorBatchCount": (len(editions) + OPERATOR_BATCH_SIZE - 1) // OPERATOR_BATCH_SIZE,
        "receiptPath": str(receipt),
    }


def needs_replay(ledger: Any, s3: Any, edition: Mapping[str, Any]) -> bool:
    current = ledger.get_item(
        Key={"messageId": edition["messageId"], "attachmentId": edition["attachmentId"]},
        ConsistentRead=True,
    ).get("Item") or {}
    if not (
        current.get("contentSha256") == edition.get("contentSha256")
        and current.get("s3Bucket") == edition.get("s3Bucket")
        and current.get("s3Key") == edition.get("s3Key")
        and hashlib.sha256(str(current.get("subject") or "").encode("utf-8")).hexdigest()
        == edition.get("subjectSha256")
    ):
        raise SignalStrengthBackfillFailure(
            "SIGNAL_STRENGTH_LEDGER_EVIDENCE_DRIFT",
            "A selected immutable ledger row changed before replay.",
        )
    try:
        body = read_verified_artifact(s3, current)
    except TopThreeBackfillFailure as error:
        raise _translated(error) from error
    if len(body) != int(edition.get("archivedByteSize") or 0):
        raise SignalStrengthBackfillFailure(
            "SIGNAL_STRENGTH_ARTIFACT_HASH_MISMATCH",
            "A selected artifact changed size before replay.",
        )
    if (
        current.get("status") == "INDEXED"
        and current.get("materializationStatus") == "INDEXED"
        and current.get("materializationAttemptVersion") == MATERIALIZED_DATA_VERSION
        and current.get("snapshotType") == SNAPSHOT_TYPES[edition["side"]]
        and current.get("researchParserVersion") == RESEARCH_PARSER_VERSION
        and current.get("securityIntelligenceParserVersion") == SECURITY_PARSER_VERSION
    ):
        return False
    if not (
        current.get("status") == edition.get("sourceStatus")
        and current.get("reportType") == edition.get("sourceReportType")
        and current.get("snapshotType") == edition.get("sourceSnapshotType")
        and current.get("materializationStatus") == edition.get("sourceMaterializationStatus")
        and current.get("materializationAttemptVersion") == edition.get("sourceAttemptVersion")
        and str(current.get("updatedAt") or "") == edition.get("sourceUpdatedAt")
    ):
        raise SignalStrengthBackfillFailure(
            "SIGNAL_STRENGTH_LEDGER_EVIDENCE_DRIFT",
            "A selected ledger row no longer matches the prepared replay state.",
        )
    return True


def retire_legacy_short_sources(snapshots: Any, days: Sequence[Mapping[str, Any]]) -> int:
    """Drop the short editions a pre-split long row still names as sources.

    Replaying a long edition replaces the row's book but keeps every source it
    had named, including the short edition that now has its own row.
    """
    retired = 0
    for day in days:
        short_sources = set((day.get("short") or {}).get("sourceMessageIds") or [])
        if not short_sources or not day.get("long"):
            continue
        key = {"date": day["date"], "snapshotType": SNAPSHOT_TYPES["long"]}
        row = snapshots.get_item(Key=key, ConsistentRead=True).get("Item") or {}
        sources = list(row.get("sourceMessageIds") or [])
        kept = [source for source in sources if source not in short_sources]
        if kept == sources:
            continue
        snapshots.update_item(
            Key=key,
            UpdateExpression="SET sourceMessageIds = :kept",
            ConditionExpression="dataVersion = :version AND sourceMessageIds = :sources",
            ExpressionAttributeValues={
                ":kept": kept,
                ":sources": sources,
                ":version": row.get("dataVersion"),
            },
        )
        retired += 1
    return retired


def verify_snapshots(snapshots: Any, days: Sequence[Mapping[str, Any]]) -> None:
    for day in days:
        for side in SIDES:
            expected = day.get(side)
            if expected is None:
                continue
            snapshot = snapshots.get_item(
                Key={"date": day["date"], "snapshotType": SNAPSHOT_TYPES[side]},
                ConsistentRead=True,
            ).get("Item") or {}
            book = snapshot.get("data") or {}
            stocks = book.get("stocks") or []
            if (
                int(snapshot.get("stockCount") or 0) != expected["stockCount"]
                or len(stocks) != expected["stockCount"]
                or book.get("membershipComplete") is not True
                or hashlib.sha256(
                    ",".join(str(stock.get("ticker")) for stock in stocks).encode("utf-8")
                ).hexdigest()
                != expected["membershipSha256"]
                # A pre-split row must not keep the short book beside the long.
                or "shorts" in book
                or "shortCount" in snapshot
            ):
                raise SignalStrengthBackfillFailure(
                    "SIGNAL_STRENGTH_SNAPSHOT_VERIFICATION_FAILED",
                    f"The {day['date']} {side} book does not match its latest edition.",
                )
            if (
                set(snapshot.get("sourceMessageIds") or []) != set(expected["sourceMessageIds"])
                or not str(snapshot.get("dataVersion") or "").startswith(f"{MATERIALIZED_DATA_VERSION}:")
            ):
                raise SignalStrengthBackfillFailure(
                    "SIGNAL_STRENGTH_SNAPSHOT_VERIFICATION_FAILED",
                    f"The {day['date']} {side} snapshot does not name exactly its own editions.",
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
    validate_schedule(
        session.client("scheduler").get_schedule(GroupName="default", Name=SCHEDULE),
        "DISABLED",
    )
    expected_commit = release_commit or current_commit()
    release = verify_release_receipt(
        release_receipt,
        expected_commit=expected_commit,
        key_path=release_key,
        repo_root=shared.REPO_ROOT,
    )
    lambda_client = session.client("lambda")
    function = lambda_client.get_function_configuration(FunctionName=FUNCTION)
    validate_function(function, expected_build=expected_commit)
    if function.get("CodeSha256") not in verified_release_code_hashes(release):
        raise SignalStrengthBackfillFailure(
            "SIGNAL_STRENGTH_TESTED_CODE_HASH_MISMATCH",
            "The deployed Gmail code hash is not part of the tested release.",
        )
    ledger = session.resource("dynamodb").Table(LEDGER_TABLE)
    require_idle_runtime(ledger)
    s3 = session.client("s3")
    editions = list(payload["editions"])
    pending = [edition for edition in editions if needs_replay(ledger, s3, edition)]
    invocation_count = batch_count = 0
    for offset in range(0, len(pending), OPERATOR_BATCH_SIZE):
        batch = pending[offset : offset + OPERATOR_BATCH_SIZE]
        invocation_count += invoke_batch_until_complete(
            lambda_client,
            [edition["messageId"] for edition in batch],
        )
        batch_count += 1
        require_idle_runtime(ledger)
    for edition in editions:
        if needs_replay(ledger, s3, edition):
            raise SignalStrengthBackfillFailure(
                "SIGNAL_STRENGTH_REPLAY_POSTCHECK_FAILED",
                "A selected ledger row did not reach the tested Signal Strength state.",
            )
    snapshots = session.resource("dynamodb").Table(SNAPSHOT_TABLE)
    retired = retire_legacy_short_sources(snapshots, payload["days"])
    verify_snapshots(snapshots, payload["days"])
    require_idle_runtime(ledger)
    return {
        "passed": True,
        "mode": "apply",
        "incidentProfile": INCIDENT_PROFILE,
        "editionCount": len(editions),
        "replayedCount": len(pending),
        "skippedCount": len(editions) - len(pending),
        "verifiedDayCount": len(payload["days"]),
        "retiredLegacyShortSourceCount": retired,
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
    parser.add_argument("--admin-profile", default=shared.ADMIN_PROFILE)
    parser.add_argument("--start-date", default=FORMAT_CHANGE_DATE)
    parser.add_argument("--release-commit")
    parser.add_argument("--release-receipt", type=Path)
    parser.add_argument("--release-key", type=Path)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.apply and (args.release_receipt is None or args.release_key is None):
            raise SignalStrengthBackfillFailure(
                "SIGNAL_STRENGTH_TESTED_RELEASE_RECEIPT_REQUIRED",
                "Apply requires the tested-release receipt and key.",
            )
        try:
            result = (
                prepare(args.admin_profile, args.receipt, args.receipt_key, start_date=args.start_date)
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
        except TopThreeBackfillFailure as error:
            raise _translated(error) from error
        print(json.dumps(result, sort_keys=True, indent=2))
        return 0
    except SignalStrengthBackfillFailure as error:
        print(
            json.dumps({"passed": False, "error": {"code": error.code, "message": str(error)}}, indent=2),
            file=sys.stderr,
        )
        return 2
    except Exception as error:
        print(
            json.dumps(
                {
                    "passed": False,
                    "error": {
                        "code": "SIGNAL_STRENGTH_BACKFILL_AWS_ERROR",
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
