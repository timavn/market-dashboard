#!/usr/bin/env python3
"""Replay bounded Gmail quarantines against one tested immutable release.

Prepare derives the selected artifacts from the durable runtime quarantine list;
operators never provide or receive Gmail IDs. Apply requires the Gmail schedule
to be disabled, verifies the deployed build and source hashes, and invokes one
message at a time. Every write remains idempotent through the ingestor's
content/version guards.
"""

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
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

import boto3
from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError

INGESTOR_MODULE_DIR = Path(__file__).resolve().parents[1] / "lambdas" / "gmail_ingestor"
if str(INGESTOR_MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(INGESTOR_MODULE_DIR))
from research_intelligence import PARSER_VERSION as SECURITY_INTELLIGENCE_PARSER_VERSION  # noqa: E402
from hermes_gmail_ingestor import (  # noqa: E402
    MATERIALIZED_DATA_VERSION,
    OPERATOR_REPLAY_SOURCE,
    RESEARCH_PARSER_VERSION,
    _research_event_verification_hash,
    infer_report_type,
)
from prepare_tested_release import verify_release_receipt  # noqa: E402


ACCOUNT = "915328198276"
REGION = "us-west-1"
ADMIN_PROFILE = "market-dashboard-admin"
FUNCTION = "market-dashboard-gmail-ingestor-v2"
FUNCTION_ARN = f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:{FUNCTION}"
SCHEDULE = "market-dashboard-gmail-v2-every-15m"
SCHEDULE_EXPRESSION = "rate(15 minutes)"
HEARTBEAT_TABLE = "MarketDashboardServiceHeartbeats"
HEARTBEAT_SERVICE = "gmail:timsmithaviation@gmail.com"
LEDGER_TABLE = "HermesEmailIngestLedger"
EVENT_LEDGER_TABLE = "ResearchEventLedgerV2"
ENTITY_EVENTS_TABLE = "ResearchEntityEventsV1"
MANIFEST_TABLE = "ResearchProductManifestsV1"
SNAPSHOT_TABLE = "HedgeyeDailySnapshot"
RUNTIME_STATE_KEY = {"messageId": "runtime#gmail#timsmithaviation@gmail.com", "attachmentId": "history-cursor"}
CURRENT_MATERIALIZATION_VERSION = MATERIALIZED_DATA_VERSION
INCIDENT_PROFILE = "gmail-product-recovery-2026-08-17-v1"
FORCE_VERSION_REPLAY = "force-version-replay"
CANONICAL_RECONCILE = "canonical-reconcile"
EXPECTED_DISTRIBUTION = {
    ("momo-tracker", "momo-tracker", FORCE_VERSION_REPLAY): 3,
    ("crypto-quant", "bitcoin-trend-tracker", FORCE_VERSION_REPLAY): 1,
    ("signal-strength", "real-time-alert", FORCE_VERSION_REPLAY): 1,
    ("real-time-alert", "real-time-alert", FORCE_VERSION_REPLAY): 1,
    ("investing-ideas", "investing-ideas", FORCE_VERSION_REPLAY): 1,
    ("unknown", "investing-ideas", CANONICAL_RECONCILE): 1,
}
MAX_ATTEMPTS = 3
MAX_SELECTED = 8
EXPECTED_ARTIFACT_COUNT = 8
MAX_INVOCATIONS_PER_ARTIFACT = 5
MAX_HEARTBEAT_AGE_SECONDS = 45 * 60
MAX_REPLACED_ENTITY_EVENTS = 500
TRANSACT_WRITE_LIMIT = 100
RECEIPT_SCHEMA_VERSION = 3
RECEIPT_KIND = "market-dashboard-gmail-quarantine-replay"
EVENT_VERIFICATION_HASH_VERSION = "research-event-content-v1"
HEX64 = set("0123456789abcdef")


class ReplayFailure(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def parse_time(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _private_directory(path: Path) -> None:
    if path.is_symlink() or not path.is_dir() or stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise ReplayFailure("GMAIL_REPLAY_RECEIPT_UNSAFE", "Receipt directory must be private.")


def _private_file(path: Path) -> None:
    if path.is_symlink() or not path.is_file() or stat.S_IMODE(path.stat().st_mode) != 0o600:
        raise ReplayFailure("GMAIL_REPLAY_RECEIPT_UNSAFE", "Receipt and key must be mode 0600 regular files.")


def _outside_repo(path: Path) -> Path:
    if not path.is_absolute():
        raise ReplayFailure("GMAIL_REPLAY_RECEIPT_UNSAFE", "Receipt paths must be absolute.")
    resolved = path.resolve(strict=False)
    try:
        resolved.relative_to(Path(__file__).resolve().parents[2])
    except ValueError:
        return resolved
    raise ReplayFailure("GMAIL_REPLAY_RECEIPT_UNSAFE", "Receipt paths must be outside the repository.")


def load_key(path: Path, *, create: bool) -> bytes:
    path = _outside_repo(path)
    if not path.exists():
        if not create:
            raise ReplayFailure("GMAIL_REPLAY_KEY_MISSING", "The replay key is missing.")
        _private_directory(path.parent)
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(descriptor, secrets.token_bytes(32))
        finally:
            os.close(descriptor)
    _private_file(path)
    key = path.read_bytes()
    if len(key) < 32:
        raise ReplayFailure("GMAIL_REPLAY_KEY_INVALID", "The replay key is too short.")
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
        raise ReplayFailure("GMAIL_REPLAY_RECEIPT_EXISTS", "Refusing to overwrite a replay receipt.")
    _private_directory(path.parent)
    receipt = {**dict(payload), "authentication": {"algorithm": "HMAC-SHA256", "value": sign(payload, load_key(key_path, create=True))}}
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(descriptor, (json.dumps(receipt, sort_keys=True, indent=2) + "\n").encode())
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
        raise ReplayFailure("GMAIL_REPLAY_RECEIPT_INVALID", "Replay receipt JSON is invalid.") from error
    if not isinstance(receipt, Mapping):
        raise ReplayFailure("GMAIL_REPLAY_RECEIPT_INVALID", "Replay receipt must be an object.")
    payload = {key: value for key, value in receipt.items() if key != "authentication"}
    auth = receipt.get("authentication") or {}
    if auth.get("algorithm") != "HMAC-SHA256" or not hmac.compare_digest(str(auth.get("value") or ""), sign(payload, load_key(_outside_repo(key_path), create=False))):
        raise ReplayFailure("GMAIL_REPLAY_RECEIPT_AUTHENTICATION_FAILED", "Replay receipt authentication failed.")
    if payload.get("schemaVersion") != RECEIPT_SCHEMA_VERSION or payload.get("kind") != RECEIPT_KIND:
        raise ReplayFailure("GMAIL_REPLAY_RECEIPT_INVALID", "Replay receipt schema is unsupported.")
    artifacts = payload.get("artifacts")
    if (
        payload.get("incidentProfile") != INCIDENT_PROFILE
        or payload.get("account") != ACCOUNT
        or payload.get("region") != REGION
        or payload.get("functionName") != FUNCTION
        or payload.get("scheduleId") != SCHEDULE
        or payload.get("currentMaterializationVersion") != CURRENT_MATERIALIZATION_VERSION
        or not isinstance(artifacts, list)
        or len(artifacts) != EXPECTED_ARTIFACT_COUNT
    ):
        raise ReplayFailure("GMAIL_REPLAY_RECEIPT_INVALID", "Replay receipt scope is invalid.")
    distribution = Counter(
        (
            item.get("sourceReportType"),
            item.get("targetProductType"),
            item.get("expectedAction"),
        )
        for item in artifacts
        if isinstance(item, Mapping)
    )
    message_ids = [
        str(item.get("messageId") or "") if isinstance(item, Mapping) else ""
        for item in artifacts
    ]
    if (
        distribution != Counter(EXPECTED_DISTRIBUTION)
        or len(set(message_ids)) != EXPECTED_ARTIFACT_COUNT
        or any(not value for value in message_ids)
        or any(
            not isinstance(item, Mapping)
            or item.get("contentSha256") != item.get("archivedSha256")
            or len(str(item.get("contentSha256") or "")) != 64
            or int(item.get("archivedByteSize") or 0) <= 0
            for item in artifacts
        )
    ):
        raise ReplayFailure("GMAIL_REPLAY_RECEIPT_INVALID", "Replay receipt artifact evidence is invalid.")
    return dict(payload)


def require_sso_profile(profile: str) -> None:
    if profile != ADMIN_PROFILE:
        raise ReplayFailure("AWS_SSO_PROFILE_REQUIRED", f"Replay requires {ADMIN_PROFILE}.")
    config = configparser.RawConfigParser()
    config_path = Path.home() / ".aws" / "config"
    if not config_path.is_file() or not config.read(config_path):
        raise ReplayFailure("AWS_SSO_PROFILE_REQUIRED", "AWS IAM Identity Center configuration is missing.")
    section = f"profile {profile}"
    if not config.has_section(section) or config[section].get("sso_account_id") != ACCOUNT or config[section].get("region") != REGION:
        raise ReplayFailure("AWS_SSO_PROFILE_REQUIRED", "The administrator SSO profile does not target the expected account and region.")


def session_for(profile: str):
    require_sso_profile(profile)
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE"):
        os.environ.pop(key, None)
    os.environ["AWS_EC2_METADATA_DISABLED"] = "true"
    session = boto3.Session(profile_name=profile, region_name=REGION)
    identity = session.client("sts").get_caller_identity()
    if str(identity.get("Account") or "") != ACCOUNT:
        raise ReplayFailure("AWS_ACCOUNT_MISMATCH", "Replay resolved to the wrong AWS account.")
    return session


def validate_schedule(schedule: Mapping[str, Any], state: str) -> None:
    target = schedule.get("Target") or {}
    try:
        target_input = json.loads(str(target.get("Input") or ""))
    except (TypeError, ValueError) as error:
        raise ReplayFailure("GMAIL_SCHEDULE_CONTRACT_INVALID", "Gmail schedule input is invalid.") from error
    if (
        schedule.get("Name") != SCHEDULE
        or schedule.get("State") != state
        or schedule.get("ScheduleExpression") != SCHEDULE_EXPRESSION
        or target.get("Arn") != FUNCTION_ARN
        or target_input.get("scheduleId") != SCHEDULE
        or target_input.get("source") != "aws-scheduler"
        or target_input.get("poll") != "incremental"
    ):
        raise ReplayFailure("GMAIL_SCHEDULE_CONTRACT_INVALID", f"Gmail schedule is not in the required {state} state.")


def validate_function(configuration: Mapping[str, Any], expected_build: str | None = None) -> None:
    variables = ((configuration.get("Environment") or {}).get("Variables") or {})
    if configuration.get("FunctionName") != FUNCTION or configuration.get("State") != "Active" or configuration.get("LastUpdateStatus") != "Successful":
        raise ReplayFailure("GMAIL_FUNCTION_NOT_READY", "Gmail Lambda is not active and successful.")
    if expected_build and variables.get("BUILD_VERSION") != expected_build:
        raise ReplayFailure("GMAIL_BUILD_VERSION_MISMATCH", "Gmail Lambda is not running the tested release.")


def current_commit() -> str:
    result = subprocess.run(["git", "-C", str(Path(__file__).resolve().parents[2]), "rev-parse", "HEAD"], capture_output=True, text=True, check=False)
    commit = (result.stdout or "").strip()
    if len(commit) != 40 or any(char not in HEX64 for char in commit):
        raise ReplayFailure("GMAIL_RELEASE_COMMIT_UNAVAILABLE", "The local release commit could not be verified.")
    return commit


def latest_heartbeat(table: Any, now: datetime | None = None) -> Mapping[str, Any]:
    rows = table.query(KeyConditionExpression=Key("serviceId").eq(HEARTBEAT_SERVICE), ScanIndexForward=False, ConsistentRead=True, Limit=1).get("Items") or []
    if len(rows) != 1:
        raise ReplayFailure("GMAIL_HEARTBEAT_MISSING", "No unique Gmail scheduler heartbeat is available.")
    heartbeat = rows[0]
    observed = parse_time(heartbeat.get("observedAt"))
    current = now or datetime.now(timezone.utc)
    if heartbeat.get("source") != "aws-lambda" or heartbeat.get("triggerSource") != "aws-scheduler" or heartbeat.get("scheduled") is not True or heartbeat.get("scheduleId") != SCHEDULE or observed is None or abs((current - observed).total_seconds()) > MAX_HEARTBEAT_AGE_SECONDS or heartbeat.get("status") not in {"success", "warning"}:
        raise ReplayFailure("GMAIL_HEARTBEAT_NOT_CURRENT", "The Gmail poller is not currently proven by its scheduler heartbeat.")
    return heartbeat


def runtime_state(table: Any) -> Mapping[str, Any]:
    return table.get_item(Key=RUNTIME_STATE_KEY, ConsistentRead=True).get("Item") or {}


def require_idle(state: Mapping[str, Any]) -> None:
    if state.get("status") == "IN_PROGRESS" or state.get("activeBatchId") or state.get("pendingPollMode") or state.get("pendingHistoryId") is not None or state.get("discoveryStatus") == "IN_PROGRESS":
        raise ReplayFailure("GMAIL_RUNTIME_BUSY", "The Gmail ingestor has active work.")


def active_queue_message_ids(ledger: Any, state: Mapping[str, Any]) -> list[str]:
    batch_id = str(state.get("activeBatchId") or "")
    if not batch_id:
        return []
    rows = ledger.query(
        KeyConditionExpression=Key("messageId").eq(RUNTIME_STATE_KEY["messageId"]),
        ConsistentRead=True,
    ).get("Items") or []
    batch_rows = [
        row for row in rows if row.get("batchId") == batch_id
    ]
    message_ids = {
        str(row.get("gmailMessageId") or "")
        for row in batch_rows
        if row.get("status") in {"PENDING", "RETRYABLE", "IN_PROGRESS"}
        and row.get("gmailMessageId")
    }
    if (
        not message_ids
        and state.get("pendingPollMode") == "operator_replay"
        and batch_rows
        and all(
            row.get("status") in {"COMPLETED", "QUARANTINED"}
            and row.get("gmailMessageId")
            for row in batch_rows
        )
    ):
        message_ids = {
            str(row["gmailMessageId"]) for row in batch_rows
        }
    if len(message_ids) != 1:
        raise ReplayFailure(
            "GMAIL_ACTIVE_RETRY_SCOPE_INVALID",
            "The active Gmail retry does not contain exactly one message.",
        )
    return sorted(message_ids)


def incident_message_ids(ledger: Any, state: Mapping[str, Any]) -> tuple[list[str], list[str]]:
    quarantines = state.get("quarantinedMessages") or []
    if not isinstance(quarantines, list):
        raise ReplayFailure("GMAIL_QUARANTINE_SCOPE_INVALID", "Runtime quarantine evidence is invalid.")
    quarantined_ids = [
        str((item or {}).get("messageId") or "") for item in quarantines
    ]
    if (
        any(not value for value in quarantined_ids)
        or len(set(quarantined_ids)) != len(quarantined_ids)
        or any(
            (item or {}).get("errorCode") != "GMAIL_RESEARCH_MATERIALIZATION_ERROR"
            for item in quarantines
        )
    ):
        raise ReplayFailure("GMAIL_QUARANTINE_SCOPE_INVALID", "Runtime quarantine identities are invalid.")
    active_ids = active_queue_message_ids(ledger, state)
    combined = set(quarantined_ids) | set(active_ids)
    valid_shape = (
        (len(quarantined_ids) == EXPECTED_ARTIFACT_COUNT and not active_ids)
        or (
            len(quarantined_ids) == EXPECTED_ARTIFACT_COUNT - 1
            and len(active_ids) == 1
            and not (set(quarantined_ids) & set(active_ids))
        )
    )
    if not valid_shape or len(combined) != EXPECTED_ARTIFACT_COUNT:
        raise ReplayFailure(
            "GMAIL_QUARANTINE_SCOPE_INVALID",
            "Recovery requires exactly eight quarantines, or seven plus one active retry.",
        )
    return sorted(combined), active_ids


def verify_runtime_scope(
    ledger: Any,
    state: Mapping[str, Any],
    receipt: Mapping[str, Any],
) -> list[str]:
    receipt_ids = {
        str(item.get("messageId") or "") for item in receipt.get("artifacts") or []
    }
    quarantines = state.get("quarantinedMessages") or []
    if not isinstance(quarantines, list):
        raise ReplayFailure("GMAIL_REPLAY_RUNTIME_SCOPE_DRIFT", "Runtime quarantine evidence is invalid.")
    quarantine_ids = {
        str((item or {}).get("messageId") or "") for item in quarantines
    }
    active_ids = set(active_queue_message_ids(ledger, state))
    if (
        "" in quarantine_ids
        or int(state.get("quarantinedCount") or 0) != len(quarantine_ids)
        or (quarantine_ids | active_ids) - receipt_ids
    ):
        raise ReplayFailure(
            "GMAIL_REPLAY_RUNTIME_SCOPE_DRIFT",
            "The live Gmail retry/quarantine scope contains unreceipted work.",
        )
    return sorted(active_ids)


def _candidate_rows(ledger: Any, message_id: str) -> list[Mapping[str, Any]]:
    rows = ledger.query(KeyConditionExpression=Key("messageId").eq(message_id), ConsistentRead=True).get("Items") or []
    candidates = []
    for row in rows:
        digest = str(row.get("contentSha256") or "").lower()
        if (
            str(row.get("attachmentId") or "").startswith("message-body-")
            and str(row.get("mimeType") or "").lower() == "text/html"
            and row.get("status") in {"STORED", "ERROR", "INDEXED"}
            and len(digest) == 64
            and set(digest) <= HEX64
            and row.get("s3Bucket")
            and row.get("s3Key")
        ):
            candidates.append(row)
    return candidates


def _target_product_type(row: Mapping[str, Any]) -> str:
    source_type = str(row.get("reportType") or "unknown")
    inferred = infer_report_type(
        str(row.get("filename") or ""),
        str(row.get("subject") or ""),
    )
    if source_type == "crypto-quant" or inferred == "crypto-quant":
        return "bitcoin-trend-tracker"
    return inferred if inferred != "unknown" else source_type


def _market_date(row: Mapping[str, Any]) -> str:
    received_at = parse_time(row.get("receivedAt"))
    if received_at is None:
        raise ReplayFailure("GMAIL_REPLAY_EVIDENCE_INVALID", "A selected artifact has no valid receive time.")
    return received_at.date().isoformat()


def _indexed_manifest_artifact(
    manifests: Any,
    *,
    market_date: str,
    product_key: str,
    message_id: str,
    content_sha256: str,
) -> tuple[Mapping[str, Any], Mapping[str, Any]] | tuple[None, None]:
    manifest = manifests.get_item(
        Key={"marketDate": market_date, "productKey": product_key},
        ConsistentRead=True,
    ).get("Item") or {}
    artifact = next(
        (
            item
            for item in manifest.get("artifacts", [])
            if item.get("sourceMessageId") == message_id
            and item.get("contentSha256") == content_sha256
            and item.get("stage") == "indexed"
        ),
        None,
    )
    return (manifest, artifact) if artifact else (None, None)


def _archive_evidence(s3: Any, row: Mapping[str, Any]) -> dict[str, Any]:
    body = s3.get_object(Bucket=row["s3Bucket"], Key=row["s3Key"])["Body"].read(
        32 * 1024 * 1024 + 1
    )
    digest = hashlib.sha256(body).hexdigest()
    if len(body) > 32 * 1024 * 1024 or digest != row["contentSha256"]:
        raise ReplayFailure(
            "GMAIL_REPLAY_ARTIFACT_HASH_MISMATCH",
            "The immutable Gmail artifact hash did not verify.",
        )
    return {"archivedSha256": digest, "archivedByteSize": len(body)}


def select_incident_artifacts(
    ledger: Any,
    manifests: Any,
    s3: Any,
    state: Mapping[str, Any],
) -> tuple[list[dict[str, Any]], list[str]]:
    message_ids, active_ids = incident_message_ids(ledger, state)
    selected: list[dict[str, Any]] = []
    for message_id in message_ids:
        candidates = _candidate_rows(ledger, message_id)
        if len(candidates) != 1:
            raise ReplayFailure(
                "GMAIL_REPLAY_LEDGER_SCOPE_INVALID",
                "Each incident message must bind to exactly one immutable HTML row.",
            )
        row = candidates[0]
        source_type = str(row.get("reportType") or "unknown")
        target_type = _target_product_type(row)
        market_date = _market_date(row)
        manifest, indexed_artifact = _indexed_manifest_artifact(
            manifests,
            market_date=market_date,
            product_key=target_type,
            message_id=message_id,
            content_sha256=str(row["contentSha256"]),
        )
        action = (
            CANONICAL_RECONCILE
            if source_type == "unknown"
            and target_type == "investing-ideas"
            and indexed_artifact is not None
            else FORCE_VERSION_REPLAY
        )
        if action == CANONICAL_RECONCILE and row.get("status") != "STORED":
            raise ReplayFailure(
                "GMAIL_RECONCILIATION_EVIDENCE_INVALID",
                "The reconciliation-only artifact is not in its expected stored state.",
            )
        selected.append({
            "messageId": message_id,
            "attachmentId": str(row["attachmentId"]),
            "sourceReportType": source_type,
            "targetProductType": target_type,
            "expectedAction": action,
            "snapshotDate": market_date,
            "updatedAt": str(row.get("updatedAt") or ""),
            "contentSha256": str(row["contentSha256"]).lower(),
            "s3Bucket": str(row["s3Bucket"]),
            "s3Key": str(row["s3Key"]),
            "sourceStatus": str(row.get("status") or ""),
            "sourceMaterializationStatus": row.get("materializationStatus"),
            "sourceAttemptVersion": row.get("materializationAttemptVersion"),
            "sourceAttemptCount": int(row.get("materializationAttemptCount") or 0),
            "reconciliationManifestChecksum": (
                manifest.get("manifestChecksum") if manifest else None
            ),
            **_archive_evidence(s3, row),
        })
    distribution = Counter(
        (
            item["sourceReportType"],
            item["targetProductType"],
            item["expectedAction"],
        )
        for item in selected
    )
    if len(selected) != EXPECTED_ARTIFACT_COUNT or distribution != Counter(EXPECTED_DISTRIBUTION):
        raise ReplayFailure(
            "GMAIL_RECOVERY_DISTRIBUTION_INVALID",
            "The live incident does not match the fixed eight-artifact recovery profile.",
        )
    if active_ids:
        active_artifact = next(
            item for item in selected if item["messageId"] == active_ids[0]
        )
        if (
            active_artifact["sourceReportType"] != "investing-ideas"
            or active_artifact["expectedAction"] != FORCE_VERSION_REPLAY
        ):
            raise ReplayFailure(
                "GMAIL_ACTIVE_RETRY_SCOPE_INVALID",
                "The supported active retry must be the unresolved Investing Ideas artifact.",
            )
    return sorted(
        selected,
        key=lambda item: (item["expectedAction"], item["sourceReportType"], item["messageId"]),
    ), active_ids


def receipt_payload(
    heartbeat: Mapping[str, Any],
    function: Mapping[str, Any],
    state: Mapping[str, Any],
    selected: Sequence[Mapping[str, Any]],
    active_ids: Sequence[str],
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
        "currentMaterializationVersion": CURRENT_MATERIALIZATION_VERSION,
        "function": {
            "codeSha256": function.get("CodeSha256"),
            "buildVersion": variables.get("BUILD_VERSION"),
            "revisionId": function.get("RevisionId"),
            "lastModified": function.get("LastModified"),
        },
        "runtime": {
            "quarantinedCount": int(state.get("quarantinedCount") or 0),
            "activeRetryCount": len(active_ids),
            "status": state.get("status"),
        },
        "heartbeat": {key: heartbeat.get(key) for key in ("serviceId", "observedAt", "source", "triggerSource", "scheduleId", "scheduled", "status", "buildVersion")},
        "artifacts": list(selected),
    }


def verify_receipt_rows(ledger: Any, receipt: Mapping[str, Any]) -> list[dict[str, Any]]:
    artifacts = receipt.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts or len(artifacts) > MAX_SELECTED:
        raise ReplayFailure("GMAIL_REPLAY_RECEIPT_INVALID", "Replay receipt artifact scope is invalid.")
    result = []
    for selected in artifacts:
        if not isinstance(selected, Mapping):
            raise ReplayFailure("GMAIL_REPLAY_RECEIPT_INVALID", "Replay receipt contains an invalid artifact.")
        current = ledger.get_item(Key={"messageId": selected.get("messageId"), "attachmentId": selected.get("attachmentId")}, ConsistentRead=True).get("Item") or {}
        if (
            current.get("contentSha256") != selected.get("contentSha256")
            or current.get("s3Bucket") != selected.get("s3Bucket")
            or current.get("s3Key") != selected.get("s3Key")
        ):
            raise ReplayFailure("GMAIL_REPLAY_EVIDENCE_DRIFT", "An immutable Gmail artifact no longer matches the receipt.")
        action = selected.get("expectedAction")
        if action == CANONICAL_RECONCILE:
            if (
                current.get("reportType") != selected.get("sourceReportType")
                or current.get("status") != selected.get("sourceStatus")
            ):
                raise ReplayFailure(
                    "GMAIL_REPLAY_EVIDENCE_DRIFT",
                    "The reconciliation-only ledger row changed before replay.",
                )
            result.append({**dict(selected), "needsRetry": True})
            continue
        if (
            current.get("status") == "INDEXED"
            and current.get("materializationStatus") == "INDEXED"
            and current.get("materializationAttemptVersion")
            == receipt.get("currentMaterializationVersion")
            and current.get("snapshotType") == selected.get("targetProductType")
            and current.get("researchParserVersion") == RESEARCH_PARSER_VERSION
            and current.get("securityIntelligenceParserVersion")
            == SECURITY_INTELLIGENCE_PARSER_VERSION
        ):
            result.append({**dict(selected), "needsRetry": False})
            continue
        try:
            current_attempt_count = int(current.get("materializationAttemptCount") or 0)
            selected_attempt_count = int(selected.get("sourceAttemptCount") or 0)
        except (TypeError, ValueError) as error:
            raise ReplayFailure("GMAIL_REPLAY_EVIDENCE_DRIFT", "A selected quarantine has an invalid attempt count.") from error
        original_state = (
            current.get("reportType") == selected.get("sourceReportType")
            and current.get("status") == selected.get("sourceStatus")
            and current.get("materializationStatus")
            == selected.get("sourceMaterializationStatus")
            and current.get("materializationAttemptVersion")
            == selected.get("sourceAttemptVersion")
            and current_attempt_count == selected_attempt_count
        )
        retry_state = (
            current.get("status") == "ERROR"
            and current.get("materializationStatus") == "ERROR"
            and current.get("retryable") is True
            and current.get("materializationAttemptVersion")
            == receipt.get("currentMaterializationVersion")
            and 0 < current_attempt_count <= MAX_ATTEMPTS
            and current.get("reportType")
            in {selected.get("sourceReportType"), selected.get("targetProductType")}
        )
        parser_upgrade_state = (
            current.get("status") == "INDEXED"
            and current.get("materializationStatus") == "INDEXED"
            and current.get("materializationAttemptVersion")
            == receipt.get("currentMaterializationVersion")
            and current.get("snapshotType") == selected.get("targetProductType")
            and (
                current.get("researchParserVersion") != RESEARCH_PARSER_VERSION
                or current.get("securityIntelligenceParserVersion")
                != SECURITY_INTELLIGENCE_PARSER_VERSION
            )
        )
        if not (original_state or retry_state or parser_upgrade_state):
            raise ReplayFailure("GMAIL_REPLAY_EVIDENCE_DRIFT", "A selected quarantine changed before replay.")
        result.append({**dict(selected), "needsRetry": True})
    return result


def verify_artifact_hash(s3: Any, selected: Mapping[str, Any]) -> None:
    body = s3.get_object(Bucket=selected["s3Bucket"], Key=selected["s3Key"])["Body"].read(32 * 1024 * 1024 + 1)
    if (
        len(body) > 32 * 1024 * 1024
        or len(body) != int(selected.get("archivedByteSize") or 0)
        or hashlib.sha256(body).hexdigest() != selected["contentSha256"]
    ):
        raise ReplayFailure("GMAIL_REPLAY_ARTIFACT_HASH_MISMATCH", "The immutable Gmail artifact hash did not verify.")


def _query_all(table: Any, **kwargs: Any) -> list[Mapping[str, Any]]:
    items: list[Mapping[str, Any]] = []
    last_key = None
    while True:
        request = dict(kwargs)
        if last_key:
            request["ExclusiveStartKey"] = last_key
        response = table.query(**request) or {}
        items.extend(response.get("Items") or [])
        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            return items


def replace_artifact_entity_projection(
    resources: Any,
    selected: Mapping[str, Any],
) -> int:
    """Delete only the prior entity rows bound to one receipted artifact."""
    market_date = str(selected.get("snapshotDate") or "")
    source_message_id = str(selected.get("messageId") or "")
    content_sha256 = str(selected.get("contentSha256") or "")
    if (
        not re.fullmatch(r"\d{4}-\d{2}-\d{2}", market_date)
        or not source_message_id
        or not re.fullmatch(r"[0-9a-f]{64}", content_sha256)
    ):
        raise ReplayFailure(
            "GMAIL_REPLAY_ENTITY_SCOPE_INVALID",
            "Entity projection replacement evidence is invalid.",
        )

    table = resources.Table(ENTITY_EVENTS_TABLE)
    rows = [
        row
        for row in _query_all(
            table,
            IndexName="marketDate-index",
            KeyConditionExpression=Key("marketDate").eq(market_date),
        )
        if row.get("sourceMessageId") == source_message_id
        and row.get("contentSha256") == content_sha256
    ]
    if len(rows) > MAX_REPLACED_ENTITY_EVENTS:
        raise ReplayFailure(
            "GMAIL_REPLAY_ENTITY_SCOPE_INVALID",
            "Entity projection replacement exceeded its bounded scope.",
        )
    if any(not row.get("entityKey") or not row.get("eventKey") for row in rows):
        raise ReplayFailure(
            "GMAIL_REPLAY_ENTITY_SCOPE_INVALID",
            "Entity projection replacement found an invalid primary key.",
        )

    verified_rows: list[Mapping[str, Any]] = []
    for row in rows:
        current = table.get_item(
            Key={"entityKey": row["entityKey"], "eventKey": row["eventKey"]},
            ConsistentRead=True,
        ).get("Item")
        if not current:
            continue
        if (
            current.get("sourceMessageId") != source_message_id
            or current.get("contentSha256") != content_sha256
        ):
            raise ReplayFailure(
                "GMAIL_REPLAY_ENTITY_SCOPE_DRIFT",
                "An entity projection changed during replacement.",
            )
        verified_rows.append(current)
    if not verified_rows:
        return 0

    serializer = TypeSerializer()
    for offset in range(0, len(verified_rows), TRANSACT_WRITE_LIMIT):
        chunk = verified_rows[offset : offset + TRANSACT_WRITE_LIMIT]
        transaction = [
            {
                "Delete": {
                    "TableName": ENTITY_EVENTS_TABLE,
                    "Key": {
                        "entityKey": serializer.serialize(row["entityKey"]),
                        "eventKey": serializer.serialize(row["eventKey"]),
                    },
                    "ConditionExpression": (
                        "#sourceMessageId = :sourceMessageId AND "
                        "#contentSha256 = :contentSha256"
                    ),
                    "ExpressionAttributeNames": {
                        "#sourceMessageId": "sourceMessageId",
                        "#contentSha256": "contentSha256",
                    },
                    "ExpressionAttributeValues": {
                        ":sourceMessageId": serializer.serialize(source_message_id),
                        ":contentSha256": serializer.serialize(content_sha256),
                    },
                }
            }
            for row in chunk
        ]
        token_material = "|".join(
            [
                SECURITY_INTELLIGENCE_PARSER_VERSION,
                content_sha256,
                *[
                    f"{row['entityKey']}#{row['eventKey']}"
                    for row in chunk
                ],
            ]
        )
        try:
            resources.meta.client.transact_write_items(
                TransactItems=transaction,
                ClientRequestToken=hashlib.sha256(
                    token_material.encode("utf-8")
                ).hexdigest()[:36],
            )
        except ClientError as error:
            raise ReplayFailure(
                "GMAIL_REPLAY_ENTITY_REPLACEMENT_FAILED",
                "The exact entity projection transaction failed.",
            ) from error
    return len(verified_rows)


def _manifest_checksum(artifacts: Sequence[Mapping[str, Any]]) -> str:
    canonical = [
        {
            "artifactId": artifact.get("artifactId"),
            "contentSha256": artifact.get("contentSha256"),
            "stage": artifact.get("stage"),
            "eventCount": int(artifact.get("eventCount") or 0),
            "parserVersion": artifact.get("parserVersion"),
        }
        for artifact in sorted(
            artifacts,
            key=lambda item: str(item.get("artifactId") or ""),
        )
    ]
    return hashlib.sha256(
        json.dumps(canonical, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()


def _verify_event_hashes(
    resources: Any,
    *,
    product_key: str,
    message_id: str,
    content_sha256: str,
    expected_count: int,
) -> None:
    if expected_count == 0:
        return
    rows = _query_all(
        resources.Table(EVENT_LEDGER_TABLE),
        KeyConditionExpression=Key("productKey").eq(product_key),
        ConsistentRead=True,
    )
    matching = [
        row
        for row in rows
        if row.get("sourceMessageId") == message_id
        and row.get("contentHash") == content_sha256
    ]
    if len(matching) != expected_count:
        raise ReplayFailure(
            "GMAIL_REPLAY_EVENT_COUNT_MISMATCH",
            "The research event ledger count did not verify.",
        )
    for row in matching:
        event_hash = str(row.get("eventHash") or "").lower()
        if (
            len(event_hash) != 64
            or set(event_hash) - HEX64
            or row.get("verificationHashVersion") != EVENT_VERIFICATION_HASH_VERSION
            or row.get("verificationHash")
            != _research_event_verification_hash(
                str(row.get("eventType") or ""),
                row.get("payload"),
            )
        ):
            raise ReplayFailure(
                "GMAIL_REPLAY_EVENT_HASH_MISMATCH",
                "A research event hash or verification hash did not verify.",
            )


def _verify_entity_events(
    resources: Any,
    *,
    market_date: str,
    message_id: str,
    content_sha256: str,
    expected_count: int,
) -> None:
    if expected_count == 0:
        return
    rows = _query_all(
        resources.Table(ENTITY_EVENTS_TABLE),
        IndexName="marketDate-index",
        KeyConditionExpression=Key("marketDate").eq(market_date),
    )
    matching = [
        row
        for row in rows
        if row.get("sourceMessageId") == message_id
        and row.get("contentSha256") == content_sha256
    ]
    if len(matching) != expected_count:
        raise ReplayFailure(
            "GMAIL_REPLAY_ENTITY_EVENT_COUNT_MISMATCH",
            "The security-intelligence entity event count did not verify.",
        )
    for row in matching:
        if (
            not row.get("entityKey")
            or not row.get("eventKey")
            or row.get("parserVersion") != SECURITY_INTELLIGENCE_PARSER_VERSION
            or row.get("qualityStatus") != "validated"
            or (
                row.get("eventType") == "trade_signal"
                and (
                    row.get("signalValue") not in {"BULLISH", "BEARISH", "NEUTRAL"}
                    or row.get("decisionEligible") is not True
                )
            )
        ):
            raise ReplayFailure(
                "GMAIL_REPLAY_ENTITY_EVENT_INVALID",
                "A security-intelligence entity event did not verify.",
            )


def verify_materialization_contract(resources: Any, ledger_row: Mapping[str, Any]) -> None:
    """Verify the indexed ledger row is backed by immutable projections."""
    product_key = str(ledger_row.get("snapshotType") or ledger_row.get("reportType") or "")
    market_date = str(ledger_row.get("snapshotDate") or "")[:10]
    message_id = str(ledger_row.get("messageId") or "")
    content_sha256 = str(ledger_row.get("contentSha256") or "").lower()
    if not product_key or len(market_date) != 10 or not message_id or len(content_sha256) != 64:
        raise ReplayFailure("GMAIL_REPLAY_PROJECTION_EVIDENCE_MISSING", "Indexed ledger evidence is incomplete.")
    manifest = resources.Table(MANIFEST_TABLE).get_item(
        Key={"marketDate": market_date, "productKey": product_key},
        ConsistentRead=True,
    ).get("Item") or {}
    artifacts = manifest.get("artifacts") or []
    artifact = next(
        (
            item for item in artifacts
            if item.get("contentSha256") == content_sha256
            and item.get("sourceMessageId") == message_id
        ),
        None,
    )
    expected_entity_count = int(ledger_row.get("researchEntityEventCount") or 0)
    expected_event_count = int(ledger_row.get("researchEventCount") or 0)
    if (
        manifest.get("state") != "indexed"
        or manifest.get("parserVersion") != SECURITY_INTELLIGENCE_PARSER_VERSION
        or artifact is None
        or artifact.get("stage") != "indexed"
        or artifact.get("parserVersion") != SECURITY_INTELLIGENCE_PARSER_VERSION
        or int(artifact.get("eventCount") or 0) != expected_entity_count
        or manifest.get("manifestChecksum") != _manifest_checksum(artifacts)
    ):
        raise ReplayFailure(
            "GMAIL_REPLAY_MANIFEST_INVALID",
            "The product manifest did not verify for the indexed artifact.",
        )
    _verify_event_hashes(
        resources,
        product_key=product_key,
        message_id=message_id,
        content_sha256=content_sha256,
        expected_count=expected_event_count,
    )
    _verify_entity_events(
        resources,
        market_date=market_date,
        message_id=message_id,
        content_sha256=content_sha256,
        expected_count=expected_entity_count,
    )


def verify_reclassification_contract(
    resources: Any,
    selected: Mapping[str, Any],
) -> None:
    if selected.get("sourceReportType") == selected.get("targetProductType"):
        return
    manifest = resources.Table(MANIFEST_TABLE).get_item(
        Key={
            "marketDate": selected["snapshotDate"],
            "productKey": selected["sourceReportType"],
        },
        ConsistentRead=True,
    ).get("Item") or {}
    active_artifacts = manifest.get("artifacts") or []
    audits = manifest.get("reclassifiedArtifacts") or []
    matching = [
        audit
        for audit in audits
        if audit.get("artifactId") == selected["contentSha256"]
        and audit.get("contentSha256") == selected["contentSha256"]
        and audit.get("sourceProductKey") == selected["sourceReportType"]
        and audit.get("targetProductKey") == selected["targetProductType"]
    ]
    source_artifact = (matching[0].get("sourceArtifact") or {}) if len(matching) == 1 else {}
    stage_history = source_artifact.get("stageHistory") or []
    if (
        any(item.get("contentSha256") == selected["contentSha256"] for item in active_artifacts)
        or len(matching) != 1
        or source_artifact.get("contentSha256") != selected["contentSha256"]
        or source_artifact.get("sourceMessageId") != selected["messageId"]
        or source_artifact.get("stage") != "failed"
        or not source_artifact.get("error")
        or not any(item.get("stage") == "failed" for item in stage_history)
        or manifest.get("manifestChecksum") != _manifest_checksum(active_artifacts)
    ):
        raise ReplayFailure(
            "GMAIL_RECLASSIFICATION_AUDIT_INVALID",
            "The source manifest reclassification audit did not verify.",
        )


def verify_runtime_clear(ledger: Any) -> Mapping[str, Any]:
    state = runtime_state(ledger)
    if (
        state.get("status") != "READY"
        or int(state.get("quarantinedCount") or 0) != 0
        or state.get("quarantinedMessages")
        or state.get("activeBatchId")
        or state.get("pendingPollMode")
        or state.get("pendingHistoryId") is not None
        or state.get("pendingForceBackfill") is True
        or state.get("discoveryStatus") == "IN_PROGRESS"
        or state.get("errorCode")
        or state.get("errorDetail")
    ):
        raise ReplayFailure(
            "GMAIL_REPLAY_RUNTIME_NOT_CLEAR",
            "The Gmail runtime did not return to a clean ready state.",
        )
    return state


def verify_product_acceptance(
    resources: Any,
    selected: Sequence[Mapping[str, Any]],
) -> None:
    snapshots = resources.Table(SNAPSHOT_TABLE)
    by_source = {
        (item["sourceReportType"], item["snapshotDate"]): item
        for item in selected
        if item["expectedAction"] == FORCE_VERSION_REPLAY
    }
    newest_momo_date = max(
        item["snapshotDate"]
        for item in selected
        if item["sourceReportType"] == "momo-tracker"
    )
    for item in selected:
        if item["expectedAction"] != FORCE_VERSION_REPLAY:
            continue
        snapshot = snapshots.get_item(
            Key={
                "date": item["snapshotDate"],
                "snapshotType": item["targetProductType"],
            },
            ConsistentRead=True,
        ).get("Item") or {}
        if not snapshot:
            raise ReplayFailure("GMAIL_REPLAY_SNAPSHOT_MISSING", "A recovered snapshot is missing.")
        if item["sourceReportType"] == "momo-tracker":
            oracle = (snapshot.get("data") or {}).get("ORCL") or {}
            if (
                oracle.get("rangeStatus") != "outbucket"
                or oracle.get("rangeStatusDate") != "08/13"
                or oracle.get("buyTrade") is not None
                or oracle.get("sellTrade") is not None
                or oracle.get("trend") not in {"BULLISH", "BEARISH", "NEUTRAL"}
                or (
                    item["snapshotDate"] == newest_momo_date
                    and oracle.get("trend") != "BULLISH"
                )
            ):
                raise ReplayFailure("GMAIL_MOMO_ACCEPTANCE_FAILED", "Recovered MOMO outbucket evidence is invalid.")
        elif item["sourceReportType"] == "crypto-quant":
            tracker = snapshot.get("data") or {}
            rows = [
                value
                for group in (tracker.get("cryptos") or {}, tracker.get("stocks") or {})
                for value in group.values()
            ]
            if not rows or any(
                row.get("trend") not in {"BULLISH", "BEARISH", "NEUTRAL"}
                for row in rows
            ):
                raise ReplayFailure("GMAIL_CRYPTO_ACCEPTANCE_FAILED", "Recovered Crypto trends are not canonical.")
        elif item["targetProductType"] == "real-time-alert":
            alerts = (snapshot.get("data") or {}).get("alerts") or []
            expected_ticker = (
                "BJRI" if item["sourceReportType"] == "signal-strength" else "V"
            )
            if not any(
                alert.get("sourceMessageId") == item["messageId"]
                and alert.get("ticker") == expected_ticker
                for alert in alerts
            ):
                raise ReplayFailure("GMAIL_RTA_ACCEPTANCE_FAILED", "A recovered Real-Time Alert is missing.")
        elif item["sourceReportType"] == "investing-ideas":
            data = snapshot.get("data") or {}
            if (
                int(snapshot.get("positionCount") or 0) != 14
                or int(snapshot.get("longCount") or 0) != 12
                or int(snapshot.get("shortCount") or 0) != 2
                or data.get("longs")
                != [
                    "DDOG", "LLY", "CZR", "SBUX", "KMX", "TXG",
                    "PCAR", "RCL", "AMZN", "PVH", "DT", "EXPGY",
                ]
                or data.get("shorts") != ["WING", "WMT"]
            ):
                raise ReplayFailure("GMAIL_INVESTING_ACCEPTANCE_FAILED", "The recovered Investing Ideas book is incomplete.")

    if len(by_source) < 6:
        raise ReplayFailure("GMAIL_REPLAY_ACCEPTANCE_INCOMPLETE", "Recovery product evidence is incomplete.")


def invoke_one(
    lambda_client: Any,
    message_id: str,
    *,
    action: str = FORCE_VERSION_REPLAY,
) -> Mapping[str, Any]:
    payload = (
        {
            "messageIds": [message_id],
            "source": OPERATOR_REPLAY_SOURCE,
            "forceBackfill": True,
            "materializationVersion": CURRENT_MATERIALIZATION_VERSION,
        }
        if action == FORCE_VERSION_REPLAY
        else {
            "messageIds": [message_id],
            "source": "operator-targeted-reconcile",
        }
    )
    response = lambda_client.invoke(
        FunctionName=FUNCTION,
        InvocationType="RequestResponse",
        Payload=json.dumps(payload, separators=(",", ":")).encode(),
    )
    if int(response.get("StatusCode") or 0) != 200 or response.get("FunctionError"):
        raise ReplayFailure("GMAIL_REPLAY_INVOCATION_FAILED", "The Gmail Lambda invocation failed.")
    raw = response.get("Payload")
    raw = raw.read() if hasattr(raw, "read") else raw
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    try:
        envelope = json.loads(str(raw or ""))
        body = json.loads(envelope.get("body")) if isinstance(envelope.get("body"), str) else envelope.get("body")
    except (TypeError, ValueError) as error:
        raise ReplayFailure("GMAIL_REPLAY_RESPONSE_INVALID", "The Gmail Lambda response was invalid.") from error
    if (
        int(envelope.get("statusCode") or 0) != 200
        or not isinstance(body, Mapping)
        or body.get("status") not in {"SUCCESS", "ATTENTION", "IN_PROGRESS"}
        or int(body.get("errorCount") or 0) != 0
    ):
        raise ReplayFailure("GMAIL_REPLAY_MATERIALIZATION_FAILED", "A quarantined Gmail artifact did not materialize successfully.")
    return body


def invoke_until_complete(
    lambda_client: Any,
    message_id: str,
    *,
    action: str,
) -> Mapping[str, Any]:
    for _ in range(MAX_INVOCATIONS_PER_ARTIFACT):
        body = invoke_one(lambda_client, message_id, action=action)
        if (
            body.get("status") in {"SUCCESS", "ATTENTION"}
            and int(body.get("remainingCount") or 0) == 0
        ):
            return body
    raise ReplayFailure(
        "GMAIL_REPLAY_INCOMPLETE",
        "A bounded Gmail replay did not finish within its invocation limit.",
    )


def prepare(
    profile: str,
    receipt: Path,
    key: Path,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    session = session_for(profile)
    scheduler = session.client("scheduler")
    schedule = scheduler.get_schedule(GroupName="default", Name=SCHEDULE)
    validate_schedule(schedule, "ENABLED")
    lambda_client = session.client("lambda")
    function = lambda_client.get_function_configuration(FunctionName=FUNCTION)
    validate_function(function)
    dynamodb = session.resource("dynamodb")
    heartbeat = latest_heartbeat(dynamodb.Table(HEARTBEAT_TABLE), now)
    ledger = dynamodb.Table(LEDGER_TABLE)
    state = runtime_state(ledger)
    selected, active_ids = select_incident_artifacts(
        ledger,
        dynamodb.Table(MANIFEST_TABLE),
        session.client("s3"),
        state,
    )
    write_receipt(
        receipt,
        key,
        receipt_payload(heartbeat, function, state, selected, active_ids),
    )
    return {
        "passed": True,
        "mode": "prepare",
        "incidentProfile": INCIDENT_PROFILE,
        "selectedCount": len(selected),
        "forceReplayCount": sum(
            item["expectedAction"] == FORCE_VERSION_REPLAY for item in selected
        ),
        "reconciliationCount": sum(
            item["expectedAction"] == CANONICAL_RECONCILE for item in selected
        ),
        "activeRetryCount": len(active_ids),
        "receiptPath": str(receipt),
    }


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
    validate_schedule(scheduler.get_schedule(GroupName="default", Name=SCHEDULE), "DISABLED")
    lambda_client = session.client("lambda")
    expected = release_commit or current_commit()
    release = verify_release_receipt(
        release_receipt,
        expected_commit=expected,
        key_path=release_key,
        repo_root=Path(__file__).resolve().parents[2],
    )
    function = lambda_client.get_function_configuration(FunctionName=FUNCTION)
    validate_function(function, expected)
    tested_code_shas = {
        base64.b64encode(bytes.fromhex(str(item["contentSha256"]))).decode()
        for item in release.get("artifacts") or []
    }
    if function.get("CodeSha256") not in tested_code_shas:
        raise ReplayFailure(
            "GMAIL_TESTED_CODE_HASH_MISMATCH",
            "The deployed Gmail code hash is not one of the tested release artifacts.",
        )
    resources = session.resource("dynamodb")
    ledger = resources.Table(LEDGER_TABLE)
    state = runtime_state(ledger)
    active_ids = verify_runtime_scope(ledger, state, payload)
    selected = verify_receipt_rows(ledger, payload)
    s3 = session.client("s3")
    for artifact in selected:
        verify_artifact_hash(s3, artifact)

    ordered = sorted(
        selected,
        key=lambda item: (
            0 if item["messageId"] in active_ids else 1,
            2 if item["expectedAction"] == CANONICAL_RECONCILE else 1,
            item["sourceReportType"],
            item["messageId"],
        ),
    )
    invoked = 0
    skipped = 0
    replaced_entity_events = 0
    for artifact in ordered:
        if not artifact["needsRetry"]:
            current = ledger.get_item(
                Key={"messageId": artifact["messageId"], "attachmentId": artifact["attachmentId"]},
                ConsistentRead=True,
            ).get("Item") or {}
            verify_materialization_contract(resources, current)
            verify_reclassification_contract(resources, artifact)
            skipped += 1
            continue
        current_state = runtime_state(ledger)
        current_active = active_queue_message_ids(ledger, current_state)
        if current_active and current_active != [artifact["messageId"]]:
            raise ReplayFailure(
                "GMAIL_ACTIVE_RETRY_SCOPE_INVALID",
                "A different active Gmail retry appeared during recovery.",
            )
        if not current_active:
            require_idle(current_state)
        if artifact["expectedAction"] == FORCE_VERSION_REPLAY:
            replaced_entity_events += replace_artifact_entity_projection(
                resources,
                artifact,
            )
        invoke_until_complete(
            lambda_client,
            artifact["messageId"],
            action=artifact["expectedAction"],
        )
        invoked += 1
        require_idle(runtime_state(ledger))
        current = ledger.get_item(Key={"messageId": artifact["messageId"], "attachmentId": artifact["attachmentId"]}, ConsistentRead=True).get("Item") or {}
        if current.get("contentSha256") != artifact["contentSha256"]:
            raise ReplayFailure("GMAIL_REPLAY_POSTCHECK_FAILED", "A replayed artifact changed its original hash.")
        if artifact["expectedAction"] == FORCE_VERSION_REPLAY:
            if (
                current.get("status") != "INDEXED"
                or current.get("materializationStatus") != "INDEXED"
                or current.get("materializationAttemptVersion")
                != payload.get("currentMaterializationVersion")
                or current.get("snapshotType") != artifact["targetProductType"]
                or current.get("researchParserVersion") != RESEARCH_PARSER_VERSION
                or current.get("securityIntelligenceParserVersion")
                != SECURITY_INTELLIGENCE_PARSER_VERSION
            ):
                raise ReplayFailure("GMAIL_REPLAY_POSTCHECK_FAILED", "A replayed artifact did not reach the tested indexed state.")
            verify_materialization_contract(resources, current)
            verify_reclassification_contract(resources, artifact)
        else:
            manifest = resources.Table(MANIFEST_TABLE).get_item(
                Key={
                    "marketDate": artifact["snapshotDate"],
                    "productKey": artifact["targetProductType"],
                },
                ConsistentRead=True,
            ).get("Item") or {}
            if manifest.get("manifestChecksum") != artifact.get("reconciliationManifestChecksum"):
                raise ReplayFailure(
                    "GMAIL_RECONCILIATION_MANIFEST_DRIFT",
                    "The reconciliation-only manifest changed unexpectedly.",
                )

    verify_runtime_clear(ledger)
    verify_product_acceptance(resources, selected)
    return {
        "passed": True,
        "mode": "apply",
        "incidentProfile": INCIDENT_PROFILE,
        "selectedCount": len(selected),
        "invocationCount": invoked,
        "skippedCount": skipped,
        "replacedEntityEventCount": replaced_entity_events,
        "quarantinedCount": 0,
        "status": "SUCCESS",
    }


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare or apply a bounded Gmail quarantine replay.")
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
            raise ReplayFailure(
                "GMAIL_TESTED_RELEASE_RECEIPT_REQUIRED",
                "Apply requires the authenticated tested-release receipt and key.",
            )
        result = (
            prepare(args.admin_profile, args.receipt, args.receipt_key)
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
    except ReplayFailure as error:
        print(json.dumps({"passed": False, "error": {"code": error.code, "message": str(error)}}, indent=2), file=sys.stderr)
        return 2
    except Exception as error:
        print(json.dumps({"passed": False, "error": {"code": "GMAIL_REPLAY_AWS_ERROR", "message": f"Unexpected {type(error).__name__}."}}, indent=2), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
