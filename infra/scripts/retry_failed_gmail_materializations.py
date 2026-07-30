#!/usr/bin/env python3
"""Retry exactly the current Call, Macro Show, and Risk Range Gmail failures.

The operator cannot supply Gmail message IDs. Prepare mode derives one unique
message for each allowlisted report type from the newest genuine Scheduler
failure and writes an authenticated mode-0600 incident receipt outside the
repository. Apply mode runs after the guarded base deployment has disabled the
Gmail schedule. It re-verifies the receipt and every selected live ledger row,
then invokes the canonical Gmail Lambda with only those three IDs.

Output is deliberately limited to typed status, categories, and counts. Gmail
IDs, subjects, filenames, S3 keys, artifact bodies, and Lambda result details
are never printed.
"""

from __future__ import annotations

import argparse
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
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

import boto3
from boto3.dynamodb.conditions import Key


EXPECTED_ACCOUNT = "915328198276"
EXPECTED_REGION = "us-west-1"
EXPECTED_ADMIN_PROFILE = "market-dashboard-admin"
EXPECTED_FUNCTION = "market-dashboard-gmail-ingestor-v2"
EXPECTED_FUNCTION_ARN = (
    f"arn:aws:lambda:{EXPECTED_REGION}:{EXPECTED_ACCOUNT}:function:{EXPECTED_FUNCTION}"
)
EXPECTED_SCHEDULE = "market-dashboard-gmail-v2-every-15m"
EXPECTED_SCHEDULE_EXPRESSION = "rate(15 minutes)"
EXPECTED_SCHEDULE_INPUT = {
    "poll": "incremental",
    "scheduleId": EXPECTED_SCHEDULE,
    "source": "aws-scheduler",
}
EXPECTED_HEARTBEAT_TABLE = "MarketDashboardServiceHeartbeats"
EXPECTED_HEARTBEAT_SERVICE = "gmail:timsmithaviation@gmail.com"
EXPECTED_LEDGER_TABLE = "HermesEmailIngestLedger"
RUNTIME_STATE_MESSAGE_ID = "runtime#gmail#timsmithaviation@gmail.com"
RUNTIME_STATE_ATTACHMENT_ID = "history-cursor"
MESSAGE_QUEUE_ATTACHMENT_PREFIX = "message-queue#"
MESSAGE_QUEUE_RESUMABLE_STATUSES = frozenset(
    {"PENDING", "RETRYABLE", "COMPLETED"}
)
MESSAGE_QUEUE_TRANSIENT_RETRY_CODES = frozenset(
    {
        "GMAIL_WORK_BUDGET_EXHAUSTED",
        "GMAIL_INVOCATION_NEAR_TIMEOUT",
    }
)
EXPECTED_REPORT_TYPES = (
    "the-call",
    "the-macro-show",
    "risk-ranges",
)
EXPECTED_ERROR_CODE = "GMAIL_RESEARCH_MATERIALIZATION_ERROR"
EXPECTED_MATERIALIZATION_ATTEMPT_VERSION = (
    "gmail-materialized-v4-canonical-verification"
)
EXPECTED_MATERIALIZATION_MAX_ATTEMPTS = 3
RISK_RANGE_RETRY_ERROR_CODES = frozenset(
    {
        "RISK_RANGE_PUBLICATION_INVALID",
        "RISK_RANGE_DUPLICATE_TICKER_CONFLICT",
        "RISK_RANGE_TRANSACTION_LIMIT_EXCEEDED",
        "RISK_RANGE_TRANSACTION_WRITE_FAILED",
        "RISK_RANGE_PUBLICATION_VERIFICATION_FAILED",
        "RISK_RANGE_STALE_PUBLICATION_REJECTED",
        "RISK_RANGE_PUBLICATION_ORDER_UNVERIFIED",
    }
)
EXPECTED_FAILURE_COUNT = len(EXPECTED_REPORT_TYPES)
MAX_PREPARE_HEARTBEAT_AGE_SECONDS = 22.5 * 60
FAILURE_ROW_LOOKBACK_SECONDS = 2 * 60
FAILURE_ROW_FUTURE_TOLERANCE_SECONDS = 5
MAX_LEDGER_SCAN_PAGES = 20
LEDGER_SCAN_PAGE_LIMIT = 1000
MAX_INVOCATIONS = 5
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
RECEIPT_SCHEMA_VERSION = 1
RECEIPT_KIND = "market-dashboard-gmail-targeted-retry"
AMBIENT_CREDENTIAL_KEYS = (
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_SECURITY_TOKEN",
    "AWS_PROFILE",
    "AWS_DEFAULT_PROFILE",
    "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
)


class TargetedRetryFailure(RuntimeError):
    """A bounded operator-facing failure that contains no message content."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _private_directory(path: Path, *, label: str) -> None:
    if path.is_symlink() or not path.is_dir():
        raise TargetedRetryFailure(
            "GMAIL_INCIDENT_RECEIPT_UNSAFE",
            f"{label} must be a regular private directory.",
        )
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise TargetedRetryFailure(
            "GMAIL_INCIDENT_RECEIPT_UNSAFE",
            f"{label} must not be accessible by group or other users.",
        )


def _private_file(path: Path, *, label: str) -> None:
    if path.is_symlink() or not path.is_file():
        raise TargetedRetryFailure(
            "GMAIL_INCIDENT_RECEIPT_UNSAFE",
            f"{label} must be a regular non-symlink file.",
        )
    if stat.S_IMODE(path.stat().st_mode) != 0o600:
        raise TargetedRetryFailure(
            "GMAIL_INCIDENT_RECEIPT_UNSAFE",
            f"{label} must have mode 0600.",
        )


def _outside_repository(path: Path, *, label: str) -> Path:
    if not path.is_absolute():
        raise TargetedRetryFailure(
            "GMAIL_INCIDENT_RECEIPT_UNSAFE",
            f"{label} must use an absolute path.",
        )
    resolved = path.resolve(strict=False)
    repository = Path(__file__).resolve().parents[2]
    try:
        resolved.relative_to(repository)
    except ValueError:
        return resolved
    raise TargetedRetryFailure(
        "GMAIL_INCIDENT_RECEIPT_UNSAFE",
        f"{label} must be outside the repository.",
    )


def _load_or_create_receipt_key(path: Path, *, create: bool) -> bytes:
    path = _outside_repository(path, label="Incident receipt key")
    if not path.exists():
        if not create:
            raise TargetedRetryFailure(
                "GMAIL_INCIDENT_RECEIPT_KEY_MISSING",
                "The private incident receipt key is missing.",
            )
        _private_directory(path.parent, label="Incident receipt directory")
        descriptor = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        try:
            os.write(descriptor, secrets.token_bytes(32))
        finally:
            os.close(descriptor)
    _private_file(path, label="Incident receipt key")
    key = path.read_bytes()
    if len(key) < 32:
        raise TargetedRetryFailure(
            "GMAIL_INCIDENT_RECEIPT_KEY_INVALID",
            "The incident receipt key must contain at least 256 bits.",
        )
    return key


def _receipt_payload(receipt: Mapping[str, Any]) -> dict[str, Any]:
    return {
        str(key): value
        for key, value in receipt.items()
        if key != "authentication"
    }


def _sign_receipt(payload: Mapping[str, Any], key: bytes) -> str:
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hmac.new(key, encoded, hashlib.sha256).hexdigest()


def write_incident_receipt(
    path: Path,
    payload: Mapping[str, Any],
    *,
    key_path: Path,
) -> Path:
    path = _outside_repository(path, label="Incident receipt")
    if path.exists():
        raise TargetedRetryFailure(
            "GMAIL_INCIDENT_RECEIPT_EXISTS",
            "Refusing to overwrite an existing incident receipt.",
        )
    _private_directory(path.parent, label="Incident receipt directory")
    if path.resolve(strict=False) == key_path.resolve(strict=False):
        raise TargetedRetryFailure(
            "GMAIL_INCIDENT_RECEIPT_UNSAFE",
            "The incident receipt and key paths must be different.",
        )
    key = _load_or_create_receipt_key(key_path, create=True)
    receipt = {
        **dict(payload),
        "authentication": {
            "algorithm": "HMAC-SHA256",
            "value": _sign_receipt(payload, key),
        },
    }
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    try:
        os.write(
            descriptor,
            (
                json.dumps(receipt, indent=2, sort_keys=True) + "\n"
            ).encode("utf-8"),
        )
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    _private_file(path, label="Incident receipt")
    return path


def load_incident_receipt(path: Path, *, key_path: Path) -> dict[str, Any]:
    path = _outside_repository(path, label="Incident receipt")
    _private_directory(path.parent, label="Incident receipt directory")
    _private_file(path, label="Incident receipt")
    key = _load_or_create_receipt_key(key_path, create=False)
    try:
        receipt = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise TargetedRetryFailure(
            "GMAIL_INCIDENT_RECEIPT_INVALID",
            "The incident receipt is unreadable.",
        ) from error
    if not isinstance(receipt, Mapping):
        raise TargetedRetryFailure(
            "GMAIL_INCIDENT_RECEIPT_INVALID",
            "The incident receipt must be a JSON object.",
        )
    authentication = receipt.get("authentication")
    payload = _receipt_payload(receipt)
    expected_signature = _sign_receipt(payload, key)
    if (
        not isinstance(authentication, Mapping)
        or authentication.get("algorithm") != "HMAC-SHA256"
        or not hmac.compare_digest(
            str(authentication.get("value") or ""),
            expected_signature,
        )
    ):
        raise TargetedRetryFailure(
            "GMAIL_INCIDENT_RECEIPT_AUTHENTICATION_FAILED",
            "The incident receipt signature did not verify.",
        )
    if (
        payload.get("schemaVersion") != RECEIPT_SCHEMA_VERSION
        or payload.get("kind") != RECEIPT_KIND
        or payload.get("account") != EXPECTED_ACCOUNT
        or payload.get("region") != EXPECTED_REGION
        or payload.get("functionName") != EXPECTED_FUNCTION
        or payload.get("scheduleId") != EXPECTED_SCHEDULE
    ):
        raise TargetedRetryFailure(
            "GMAIL_INCIDENT_RECEIPT_INVALID",
            "The incident receipt contract does not match this deployment.",
        )
    failures = payload.get("failures")
    if (
        not isinstance(failures, list)
        or len(failures) != EXPECTED_FAILURE_COUNT
        or not all(
            isinstance(item, Mapping)
            and bool(str(item.get("messageId") or ""))
            and bool(str(item.get("attachmentId") or ""))
            and parse_timestamp(item.get("updatedAt")) is not None
            for item in failures
        )
        or {
            str(item.get("reportType") or "")
            for item in failures
            if isinstance(item, Mapping)
        }
        != set(EXPECTED_REPORT_TYPES)
        or len(
            {
                str(item.get("messageId") or "")
                for item in failures
                if isinstance(item, Mapping)
            }
        )
        != EXPECTED_FAILURE_COUNT
    ):
        raise TargetedRetryFailure(
            "GMAIL_INCIDENT_RECEIPT_INVALID",
            "The incident receipt does not contain the exact three-category failure set.",
        )
    return dict(payload)


def parse_timestamp(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def integer_value(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if (
        isinstance(value, Decimal)
        and value.is_finite()
        and value == value.to_integral_value()
    ):
        return int(value)
    return None


def require_admin_sso_profile(
    profile_name: str,
    *,
    config_path: Path | None = None,
    credentials_path: Path | None = None,
) -> None:
    """Require the exact SSO profile with no static-credential shadow entry."""

    if profile_name != EXPECTED_ADMIN_PROFILE:
        raise TargetedRetryFailure(
            "AWS_SSO_PROFILE_REQUIRED",
            f"Targeted retry requires {EXPECTED_ADMIN_PROFILE}.",
        )

    config = (config_path or (Path.home() / ".aws" / "config")).expanduser()
    parser = configparser.RawConfigParser()
    if not config.is_file() or not parser.read(config):
        raise TargetedRetryFailure(
            "AWS_SSO_PROFILE_REQUIRED",
            "The AWS IAM Identity Center configuration is missing.",
        )
    section_name = f"profile {profile_name}"
    if not parser.has_section(section_name):
        raise TargetedRetryFailure(
            "AWS_SSO_PROFILE_REQUIRED",
            "The administrator SSO profile is not configured.",
        )
    profile = parser[section_name]
    if profile.get("sso_account_id", "").strip() != EXPECTED_ACCOUNT:
        raise TargetedRetryFailure(
            "AWS_ACCOUNT_MISMATCH",
            f"The administrator profile must target account {EXPECTED_ACCOUNT}.",
        )
    if profile.get("region", "").strip() != EXPECTED_REGION:
        raise TargetedRetryFailure(
            "AWS_REGION_MISMATCH",
            f"The administrator profile must use {EXPECTED_REGION}.",
        )
    if not profile.get("sso_role_name", "").strip():
        raise TargetedRetryFailure(
            "AWS_SSO_PROFILE_REQUIRED",
            "The administrator profile does not configure an SSO role.",
        )
    session_name = profile.get("sso_session", "").strip()
    legacy_complete = bool(
        profile.get("sso_start_url", "").strip()
        and profile.get("sso_region", "").strip()
    )
    session_complete = False
    if session_name and parser.has_section(f"sso-session {session_name}"):
        session = parser[f"sso-session {session_name}"]
        session_complete = bool(
            session.get("sso_region", "").strip()
            and (
                session.get("sso_start_url", "").strip()
                or session.get("sso_issuer_url", "").strip()
            )
        )
    if not legacy_complete and not session_complete:
        raise TargetedRetryFailure(
            "AWS_SSO_PROFILE_REQUIRED",
            "The administrator IAM Identity Center profile is incomplete.",
        )

    credentials = (
        credentials_path or (Path.home() / ".aws" / "credentials")
    ).expanduser()
    credential_parser = configparser.RawConfigParser()
    if credentials.is_file() and credential_parser.read(credentials):
        if credential_parser.has_section(profile_name) and any(
            key.strip() for key, _value in credential_parser.items(profile_name)
        ):
            raise TargetedRetryFailure(
                "AWS_SSO_PROFILE_SHADOWED",
                (
                    "Remove the administrator entry from ~/.aws/credentials; "
                    "targeted retry accepts the SSO profile only."
                ),
            )


def validate_identity(identity: Mapping[str, Any]) -> None:
    if str(identity.get("Account") or "") != EXPECTED_ACCOUNT:
        raise TargetedRetryFailure(
            "AWS_ACCOUNT_MISMATCH",
            f"Refusing an AWS account other than {EXPECTED_ACCOUNT}.",
        )
    arn = str(identity.get("Arn") or "")
    expected_prefix = (
        f"arn:aws:sts::{EXPECTED_ACCOUNT}:assumed-role/AWSReservedSSO_"
    )
    if not arn.startswith(expected_prefix) or "/" not in arn[len(expected_prefix) :]:
        raise TargetedRetryFailure(
            "AWS_SSO_IDENTITY_REQUIRED",
            "The administrator profile did not resolve to an IAM Identity Center role.",
        )


def validate_schedule(
    schedule: Mapping[str, Any],
    *,
    expected_state: str,
) -> dict[str, Any]:
    if expected_state not in {"ENABLED", "DISABLED"}:
        raise TargetedRetryFailure(
            "GMAIL_SCHEDULE_CONTRACT_INVALID",
            "The expected Gmail schedule state is invalid.",
        )
    target = schedule.get("Target")
    if not isinstance(target, Mapping):
        target = {}
    try:
        schedule_input = json.loads(str(target.get("Input") or ""))
    except (TypeError, ValueError) as error:
        raise TargetedRetryFailure(
            "GMAIL_SCHEDULE_CONTRACT_INVALID",
            "The Gmail Scheduler input is not valid JSON.",
        ) from error
    if (
        schedule.get("Name") != EXPECTED_SCHEDULE
        or schedule.get("State") != expected_state
        or schedule.get("ScheduleExpression") != EXPECTED_SCHEDULE_EXPRESSION
        or target.get("Arn") != EXPECTED_FUNCTION_ARN
        or schedule_input != EXPECTED_SCHEDULE_INPUT
    ):
        raise TargetedRetryFailure(
            "GMAIL_SCHEDULE_CONTRACT_INVALID",
            (
                "The exact production Gmail Scheduler contract is not in "
                f"the required {expected_state} state."
            ),
        )
    return {
        "passed": True,
        "scheduleId": EXPECTED_SCHEDULE,
        "state": expected_state,
    }


def current_git_commit() -> str:
    result = subprocess.run(
        ["git", "-C", str(Path(__file__).resolve().parents[2]), "rev-parse", "HEAD"],
        check=False,
        capture_output=True,
        text=True,
    )
    commit = (result.stdout or "").strip()
    if result.returncode or COMMIT_PATTERN.fullmatch(commit) is None:
        raise TargetedRetryFailure(
            "GMAIL_RELEASE_COMMIT_UNAVAILABLE",
            "The exact local release commit could not be verified.",
        )
    return commit


def validate_function(
    configuration: Mapping[str, Any],
    *,
    expected_release_commit: str | None,
) -> dict[str, Any]:
    variables = (
        (configuration.get("Environment") or {}).get("Variables")
        if isinstance(configuration.get("Environment"), Mapping)
        else {}
    )
    if not isinstance(variables, Mapping):
        variables = {}
    release_mismatch = (
        expected_release_commit is not None
        and (
            COMMIT_PATTERN.fullmatch(expected_release_commit) is None
            or variables.get("BUILD_VERSION") != expected_release_commit
        )
    )
    if (
        configuration.get("FunctionName") != EXPECTED_FUNCTION
        or configuration.get("FunctionArn") != EXPECTED_FUNCTION_ARN
        or configuration.get("State") != "Active"
        or configuration.get("LastUpdateStatus") != "Successful"
        or release_mismatch
    ):
        raise TargetedRetryFailure(
            "GMAIL_FUNCTION_NOT_READY",
            (
                "The production Gmail Lambda is not active on the exact "
                "tested local release commit."
            ),
        )
    result = {
        "passed": True,
        "functionName": EXPECTED_FUNCTION,
    }
    if expected_release_commit is not None:
        result["buildVersion"] = expected_release_commit
    return result


def validate_failure_heartbeat_contract(
    row: Mapping[str, Any],
) -> Mapping[str, Any]:
    counts = row.get("counts")
    if not isinstance(counts, Mapping):
        counts = {}
    if (
        row.get("serviceId") != EXPECTED_HEARTBEAT_SERVICE
        or row.get("source") != "aws-lambda"
        or row.get("triggerSource") != "aws-scheduler"
        or row.get("scheduleId") != EXPECTED_SCHEDULE
        or row.get("scheduled") is not True
        or row.get("status") != "error"
        or row.get("errorCode") != EXPECTED_ERROR_CODE
        or integer_value(counts.get("errors")) != EXPECTED_FAILURE_COUNT
        or integer_value(counts.get("dropped")) != 0
    ):
        raise TargetedRetryFailure(
            "GMAIL_FAILURE_HEARTBEAT_MISMATCH",
            "The latest genuine Gmail Scheduler heartbeat is not the exact three-failure incident.",
        )
    if parse_timestamp(row.get("observedAt")) is None:
        raise TargetedRetryFailure(
            "GMAIL_FAILURE_HEARTBEAT_MISMATCH",
            "The genuine Gmail Scheduler failure has an invalid timestamp.",
        )
    return row


def validate_latest_failure_heartbeat(
    rows: Sequence[Mapping[str, Any]],
    *,
    now: datetime | None = None,
) -> Mapping[str, Any]:
    if len(rows) != 1:
        raise TargetedRetryFailure(
            "GMAIL_FAILURE_HEARTBEAT_MISSING",
            "No unique latest Gmail Scheduler heartbeat is available.",
        )
    row = validate_failure_heartbeat_contract(rows[0])
    observed_at = parse_timestamp(row.get("observedAt"))
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    age_seconds = (
        (current - observed_at).total_seconds()
        if observed_at is not None
        else None
    )
    if (
        age_seconds is None
        or age_seconds < -FAILURE_ROW_FUTURE_TOLERANCE_SECONDS
        or age_seconds > MAX_PREPARE_HEARTBEAT_AGE_SECONDS
    ):
        raise TargetedRetryFailure(
            "GMAIL_FAILURE_HEARTBEAT_STALE",
            (
                "Prepare the private incident receipt while the exact failed "
                "Scheduler heartbeat is still current."
            ),
        )
    return row


def _scan_failure_rows(
    ledger_table: Any,
    *,
    observed_at: datetime,
) -> list[Mapping[str, Any]]:
    rows: list[Mapping[str, Any]] = []
    exclusive_start_key = None
    earliest = (
        observed_at - timedelta(seconds=FAILURE_ROW_LOOKBACK_SECONDS)
    ).isoformat()
    latest = (
        observed_at
        + timedelta(seconds=FAILURE_ROW_FUTURE_TOLERANCE_SECONDS)
    ).isoformat()
    for _page_number in range(MAX_LEDGER_SCAN_PAGES):
        request: dict[str, Any] = {
            "ConsistentRead": True,
            "Limit": LEDGER_SCAN_PAGE_LIMIT,
            "ProjectionExpression": (
                "messageId, attachmentId, #status, reportType, "
                "materializationStatus, errorCode, retryable, updatedAt"
            ),
            "FilterExpression": (
                "#status = :error AND materializationStatus = :error "
                "AND errorCode = :errorCode AND retryable = :retryable "
                "AND reportType IN (:call, :macro, :risk) "
                "AND updatedAt BETWEEN :earliest AND :latest"
            ),
            "ExpressionAttributeNames": {"#status": "status"},
            "ExpressionAttributeValues": {
                ":error": "ERROR",
                ":errorCode": EXPECTED_ERROR_CODE,
                ":retryable": True,
                ":call": "the-call",
                ":macro": "the-macro-show",
                ":risk": "risk-ranges",
                ":earliest": earliest,
                ":latest": latest,
            },
        }
        if exclusive_start_key:
            request["ExclusiveStartKey"] = exclusive_start_key
        response = ledger_table.scan(**request)
        rows.extend(response.get("Items") or [])
        exclusive_start_key = response.get("LastEvaluatedKey")
        if not exclusive_start_key:
            return rows
    raise TargetedRetryFailure(
        "GMAIL_LEDGER_SCAN_LIMIT_EXCEEDED",
        "The bounded Gmail failure-ledger scan exceeded 20 pages.",
    )


def select_current_failures(
    ledger_table: Any,
    heartbeat: Mapping[str, Any],
) -> list[dict[str, Any]]:
    """Select one unique current failed message for every allowed report type."""

    observed_at = parse_timestamp(heartbeat.get("observedAt"))
    if observed_at is None:
        raise TargetedRetryFailure(
            "GMAIL_FAILURE_HEARTBEAT_MISMATCH",
            "The latest Gmail failure heartbeat has an invalid timestamp.",
        )
    selected_by_type: dict[str, dict[str, Any]] = {}
    duplicate_types: set[str] = set()
    for row in _scan_failure_rows(
        ledger_table,
        observed_at=observed_at,
    ):
        report_type = str(row.get("reportType") or "")
        if report_type not in EXPECTED_REPORT_TYPES:
            continue
        updated_at = parse_timestamp(row.get("updatedAt"))
        if updated_at is None:
            continue
        age = (observed_at - updated_at).total_seconds()
        if (
            age < -FAILURE_ROW_FUTURE_TOLERANCE_SECONDS
            or age > FAILURE_ROW_LOOKBACK_SECONDS
            or row.get("status") != "ERROR"
            or row.get("materializationStatus") != "ERROR"
            or row.get("errorCode") != EXPECTED_ERROR_CODE
            or row.get("retryable") is not True
            or not str(row.get("messageId") or "")
            or not str(row.get("attachmentId") or "")
        ):
            continue
        candidate = {
            "messageId": str(row["messageId"]),
            "attachmentId": str(row["attachmentId"]),
            "reportType": report_type,
            "updatedAt": str(row["updatedAt"]),
        }
        previous = selected_by_type.get(report_type)
        if previous and previous["messageId"] != candidate["messageId"]:
            duplicate_types.add(report_type)
        else:
            selected_by_type[report_type] = candidate

    if duplicate_types or set(selected_by_type) != set(EXPECTED_REPORT_TYPES):
        raise TargetedRetryFailure(
            "GMAIL_ACTIVE_FAILURE_SET_AMBIGUOUS",
            "The active failed-ledger rows are not exactly one message per expected category.",
        )
    selected = [selected_by_type[report_type] for report_type in EXPECTED_REPORT_TYPES]
    if len({row["messageId"] for row in selected}) != EXPECTED_FAILURE_COUNT:
        raise TargetedRetryFailure(
            "GMAIL_ACTIVE_FAILURE_SET_AMBIGUOUS",
            "The active failed-ledger rows do not identify three unique messages.",
        )
    return selected


def heartbeat_receipt_evidence(row: Mapping[str, Any]) -> dict[str, Any]:
    counts = row.get("counts")
    if not isinstance(counts, Mapping):
        counts = {}
    return {
        "serviceId": row.get("serviceId"),
        "observedAt": row.get("observedAt"),
        "source": row.get("source"),
        "triggerSource": row.get("triggerSource"),
        "scheduleId": row.get("scheduleId"),
        "scheduled": row.get("scheduled"),
        "status": row.get("status"),
        "errorCode": row.get("errorCode"),
        "counts": {
            "errors": integer_value(counts.get("errors")),
            "dropped": integer_value(counts.get("dropped")),
        },
    }


def incident_receipt_payload(
    heartbeat: Mapping[str, Any],
    selected: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    return {
        "schemaVersion": RECEIPT_SCHEMA_VERSION,
        "kind": RECEIPT_KIND,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "account": EXPECTED_ACCOUNT,
        "region": EXPECTED_REGION,
        "functionName": EXPECTED_FUNCTION,
        "scheduleId": EXPECTED_SCHEDULE,
        "heartbeat": heartbeat_receipt_evidence(heartbeat),
        "failures": [
            {
                "messageId": str(row["messageId"]),
                "attachmentId": str(row["attachmentId"]),
                "reportType": str(row["reportType"]),
                "updatedAt": str(row["updatedAt"]),
            }
            for row in selected
        ],
    }


def _is_active_receipt_failure(
    current: Mapping[str, Any],
    *,
    report_type: str,
    current_updated_at: datetime | None,
    receipt_updated_at: datetime | None,
) -> bool:
    if (
        current.get("status") != "ERROR"
        or current.get("materializationStatus") != "ERROR"
        or current.get("retryable") is not True
    ):
        return False
    error_code = current.get("errorCode")
    if error_code == EXPECTED_ERROR_CODE:
        return True
    attempt_count = integer_value(
        current.get("materializationAttemptCount")
    )
    return (
        report_type == "risk-ranges"
        and isinstance(error_code, str)
        and error_code in RISK_RANGE_RETRY_ERROR_CODES
        and current.get("materializationAttemptVersion")
        == EXPECTED_MATERIALIZATION_ATTEMPT_VERSION
        and attempt_count is not None
        and 0 < attempt_count <= EXPECTED_MATERIALIZATION_MAX_ATTEMPTS
        and current_updated_at is not None
        and receipt_updated_at is not None
        and current_updated_at > receipt_updated_at
    )


def _is_recovered_receipt_row(current: Mapping[str, Any]) -> bool:
    attempt_count = integer_value(
        current.get("materializationAttemptCount")
    )
    return (
        current.get("status") == "INDEXED"
        and current.get("materializationStatus") == "INDEXED"
        and current.get("retryable") is not True
        and not current.get("errorCode")
        and current.get("materializationAttemptVersion")
        == EXPECTED_MATERIALIZATION_ATTEMPT_VERSION
        and attempt_count is not None
        and 0 < attempt_count <= EXPECTED_MATERIALIZATION_MAX_ATTEMPTS
    )


def verify_incident_live_evidence(
    heartbeat_table: Any,
    ledger_table: Any,
    receipt: Mapping[str, Any],
) -> list[dict[str, Any]]:
    heartbeat_evidence = receipt.get("heartbeat")
    if not isinstance(heartbeat_evidence, Mapping):
        raise TargetedRetryFailure(
            "GMAIL_INCIDENT_RECEIPT_INVALID",
            "The incident receipt has no heartbeat evidence.",
        )
    observed_at = str(heartbeat_evidence.get("observedAt") or "")
    if parse_timestamp(observed_at) is None:
        raise TargetedRetryFailure(
            "GMAIL_INCIDENT_RECEIPT_INVALID",
            "The incident receipt heartbeat timestamp is invalid.",
        )
    heartbeat = heartbeat_table.get_item(
        Key={
            "serviceId": EXPECTED_HEARTBEAT_SERVICE,
            "observedAt": observed_at,
        },
        ConsistentRead=True,
    ).get("Item") or {}
    if heartbeat_receipt_evidence(heartbeat) != dict(heartbeat_evidence):
        raise TargetedRetryFailure(
            "GMAIL_INCIDENT_EVIDENCE_DRIFT",
            "The authoritative Gmail failure heartbeat no longer matches the receipt.",
        )

    selected: list[dict[str, Any]] = []
    for failure in receipt.get("failures") or []:
        if not isinstance(failure, Mapping):
            raise TargetedRetryFailure(
                "GMAIL_INCIDENT_RECEIPT_INVALID",
                "The incident receipt failure set is invalid.",
            )
        message_id = str(failure.get("messageId") or "")
        attachment_id = str(failure.get("attachmentId") or "")
        report_type = str(failure.get("reportType") or "")
        updated_at = str(failure.get("updatedAt") or "")
        if (
            not message_id
            or not attachment_id
            or report_type not in EXPECTED_REPORT_TYPES
            or parse_timestamp(updated_at) is None
        ):
            raise TargetedRetryFailure(
                "GMAIL_INCIDENT_RECEIPT_INVALID",
                "The incident receipt contains an invalid failure row.",
            )
        current = ledger_table.get_item(
            Key={
                "messageId": message_id,
                "attachmentId": attachment_id,
            },
            ConsistentRead=True,
        ).get("Item") or {}
        current_updated_at = parse_timestamp(current.get("updatedAt"))
        receipt_updated_at = parse_timestamp(updated_at)
        active_failure = _is_active_receipt_failure(
            current,
            report_type=report_type,
            current_updated_at=current_updated_at,
            receipt_updated_at=receipt_updated_at,
        )
        recovered = _is_recovered_receipt_row(current)
        if (
            current.get("messageId") != message_id
            or current.get("attachmentId") != attachment_id
            or current.get("reportType") != report_type
            or current_updated_at is None
            or receipt_updated_at is None
            or current_updated_at < receipt_updated_at
            or not (active_failure or recovered)
        ):
            raise TargetedRetryFailure(
                "GMAIL_INCIDENT_EVIDENCE_DRIFT",
                "A selected failed-ledger row no longer matches the receipt.",
            )
        selected.append(
            {
                "messageId": message_id,
                "attachmentId": attachment_id,
                "reportType": report_type,
                "updatedAt": updated_at,
                "needsRetry": active_failure,
            }
        )
    if (
        len(selected) != EXPECTED_FAILURE_COUNT
        or {row["reportType"] for row in selected}
        != set(EXPECTED_REPORT_TYPES)
        or len({row["messageId"] for row in selected})
        != EXPECTED_FAILURE_COUNT
    ):
        raise TargetedRetryFailure(
            "GMAIL_INCIDENT_RECEIPT_INVALID",
            "The incident receipt does not resolve to the exact three failures.",
        )
    return sorted(
        selected,
        key=lambda row: EXPECTED_REPORT_TYPES.index(row["reportType"]),
    )


def _runtime_has_active_work(state: Mapping[str, Any]) -> bool:
    return bool(
        state.get("status") == "IN_PROGRESS"
        or state.get("activeBatchId")
        or state.get("pendingHistoryId") is not None
        or state.get("pendingPollMode")
        or state.get("pendingForceBackfill") is True
        or (integer_value(state.get("pendingDiscoveredCount")) or 0) > 0
        or state.get("discoveryStatus")
        or state.get("discoveryBatchId")
        or state.get("discoveryCursorBefore") is not None
        or state.get("discoveryTargetHistoryId") is not None
        or state.get("discoveryPageToken") is not None
        or state.get("discoveryMode")
        or state.get("discoveryLabelId") is not None
    )


def require_idle_runtime_state(ledger_table: Any) -> None:
    state = ledger_table.get_item(
        Key={
            "messageId": RUNTIME_STATE_MESSAGE_ID,
            "attachmentId": RUNTIME_STATE_ATTACHMENT_ID,
        },
        ConsistentRead=True,
    ).get("Item") or {}
    if _runtime_has_active_work(state):
        raise TargetedRetryFailure(
            "GMAIL_RUNTIME_BUSY",
            "The Gmail ingestor has active work; targeted retry made no invocation.",
        )


def require_idle_or_exact_incident_runtime_state(
    ledger_table: Any,
    selected: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    state = ledger_table.get_item(
        Key={
            "messageId": RUNTIME_STATE_MESSAGE_ID,
            "attachmentId": RUNTIME_STATE_ATTACHMENT_ID,
        },
        ConsistentRead=True,
    ).get("Item") or {}
    busy = _runtime_has_active_work(state)
    if not busy:
        return {
            "mode": "fresh",
            "expectedMessageCount": EXPECTED_FAILURE_COUNT,
        }

    active_batch_id = str(state.get("activeBatchId") or "")
    state_matches_explicit_batch = (
        bool(active_batch_id)
        and state.get("status") == "IN_PROGRESS"
        and state.get("pendingPollMode") == "explicit"
        and state.get("pendingHistoryId") is None
        and state.get("pendingForceBackfill") is False
        and integer_value(state.get("pendingDiscoveredCount"))
        == EXPECTED_FAILURE_COUNT
        and state.get("discoveryStatus") == "COMPLETE"
        and state.get("discoveryBatchId") == active_batch_id
        and state.get("discoveryMode") == "explicit"
        and state.get("discoveryLabelId") is None
        and state.get("discoveryTargetHistoryId") is None
        and state.get("discoveryPageToken") is None
        and integer_value(state.get("discoveryNextSequence"))
        == EXPECTED_FAILURE_COUNT
    )
    if not state_matches_explicit_batch:
        raise TargetedRetryFailure(
            "GMAIL_RUNTIME_BUSY",
            "The Gmail ingestor has active work; targeted retry made no invocation.",
        )

    prefix = f"{MESSAGE_QUEUE_ATTACHMENT_PREFIX}{active_batch_id}#"
    response = ledger_table.query(
        KeyConditionExpression=(
            Key("messageId").eq(RUNTIME_STATE_MESSAGE_ID)
            & Key("attachmentId").begins_with(prefix)
        ),
        ConsistentRead=True,
        Limit=EXPECTED_FAILURE_COUNT + 1,
    )
    queue_rows = response.get("Items") or []
    selected_report_types = [
        str(row.get("reportType") or "")
        for row in selected
    ]
    selected_by_message_id = {
        str(row.get("messageId") or ""): row
        for row in selected
    }
    queue_ids = {
        str(row.get("gmailMessageId") or "")
        for row in queue_rows
    }
    rows_match_exact_incident = (
        not response.get("LastEvaluatedKey")
        and selected_report_types == list(EXPECTED_REPORT_TYPES)
        and len(selected_by_message_id) == EXPECTED_FAILURE_COUNT
        and len(queue_rows) == EXPECTED_FAILURE_COUNT
        and len(queue_ids) == EXPECTED_FAILURE_COUNT
        and queue_ids == set(selected_by_message_id)
    )
    for row in queue_rows:
        status = str(row.get("status") or "")
        attempt_count = integer_value(row.get("attemptCount"))
        message_id = str(row.get("gmailMessageId") or "")
        selected_row = selected_by_message_id.get(message_id) or {}
        report_type = str(selected_row.get("reportType") or "")
        try:
            sequence = selected_report_types.index(report_type)
        except ValueError:
            sequence = -1
        expected_attachment_id = (
            f"{prefix}p{sequence:018d}#"
            f"{hashlib.sha256(message_id.encode('utf-8')).hexdigest()[:16]}"
        )
        expected_retry_state = (
            status in {"PENDING", "RETRYABLE"}
            and selected_row.get("needsRetry") is True
        ) or (
            status == "COMPLETED"
            and selected_row.get("needsRetry") is not True
        )
        valid_attempt_count = (
            status == "PENDING"
            and attempt_count == 0
        ) or (
            status in {"RETRYABLE", "COMPLETED"}
            and attempt_count is not None
            and 0 < attempt_count <= EXPECTED_MATERIALIZATION_MAX_ATTEMPTS
        )
        error_code = row.get("errorCode")
        valid_error_state = (
            status in {"PENDING", "COMPLETED"}
            and not error_code
        ) or (
            status == "RETRYABLE"
            and isinstance(error_code, str)
            and (
                error_code == EXPECTED_ERROR_CODE
                or error_code in MESSAGE_QUEUE_TRANSIENT_RETRY_CODES
                or (
                    report_type == "risk-ranges"
                    and error_code in RISK_RANGE_RETRY_ERROR_CODES
                )
            )
        )
        rows_match_exact_incident = (
            rows_match_exact_incident
            and row.get("messageId") == RUNTIME_STATE_MESSAGE_ID
            and row.get("batchId") == active_batch_id
            and row.get("attachmentId") == expected_attachment_id
            and integer_value(row.get("sequence")) == sequence
            and status in MESSAGE_QUEUE_RESUMABLE_STATUSES
            and expected_retry_state
            and valid_attempt_count
            and valid_error_state
            and not row.get("leaseExpiresAt")
        )
    state_after = ledger_table.get_item(
        Key={
            "messageId": RUNTIME_STATE_MESSAGE_ID,
            "attachmentId": RUNTIME_STATE_ATTACHMENT_ID,
        },
        ConsistentRead=True,
    ).get("Item") or {}
    rows_match_exact_incident = (
        rows_match_exact_incident
        and state_after == state
    )
    if not rows_match_exact_incident:
        raise TargetedRetryFailure(
            "GMAIL_RUNTIME_BUSY",
            (
                "The Gmail ingestor has unrelated or ambiguous active work; "
                "targeted retry made no invocation."
            ),
        )
    active_message_count = sum(
        str(row.get("status") or "") in {"PENDING", "RETRYABLE"}
        for row in queue_rows
    )
    return {
        "mode": "resume",
        "expectedMessageCount": active_message_count,
    }


def parse_invocation_result(response: Mapping[str, Any]) -> dict[str, Any]:
    if int(response.get("StatusCode") or 0) != 200 or response.get("FunctionError"):
        raise TargetedRetryFailure(
            "GMAIL_TARGETED_RETRY_INVOCATION_FAILED",
            "The targeted Gmail Lambda invocation did not complete successfully.",
        )
    payload_stream = response.get("Payload")
    raw_payload = (
        payload_stream.read()
        if hasattr(payload_stream, "read")
        else payload_stream
    )
    if isinstance(raw_payload, bytes):
        raw_payload = raw_payload.decode("utf-8", errors="replace")
    try:
        envelope = json.loads(str(raw_payload or ""))
        body = envelope.get("body")
        body = json.loads(body) if isinstance(body, str) else body
    except (TypeError, ValueError) as error:
        raise TargetedRetryFailure(
            "GMAIL_TARGETED_RETRY_RESPONSE_INVALID",
            "The targeted Gmail Lambda returned an invalid response envelope.",
        ) from error
    if not isinstance(body, Mapping) or body.get("pollMode") != "explicit":
        raise TargetedRetryFailure(
            "GMAIL_TARGETED_RETRY_RESPONSE_INVALID",
            "The Gmail Lambda did not confirm explicit-message processing.",
        )
    status = str(body.get("status") or "").upper()
    count_fields = (
        "messageCount",
        "remainingCount",
        "storedCount",
        "skippedCount",
        "errorCount",
        "quarantinedCount",
    )
    parsed_counts = {
        field: integer_value(body.get(field))
        for field in count_fields
    }
    if any(
        value is None or value < 0
        for value in parsed_counts.values()
    ):
        raise TargetedRetryFailure(
            "GMAIL_TARGETED_RETRY_RESPONSE_INVALID",
            "The targeted Gmail Lambda returned invalid count fields.",
        )
    summary = {
        "status": status,
        **parsed_counts,
    }
    if (
        int(envelope.get("statusCode") or 0) != 200
        or summary["errorCount"] != 0
        or summary["quarantinedCount"] != 0
        or status not in {"IN_PROGRESS", "SUCCESS"}
    ):
        raise TargetedRetryFailure(
            "GMAIL_TARGETED_RETRY_MATERIALIZATION_FAILED",
            "One or more targeted Gmail materializations failed.",
        )
    if status == "IN_PROGRESS" and summary["remainingCount"] <= 0:
        raise TargetedRetryFailure(
            "GMAIL_TARGETED_RETRY_RESPONSE_INVALID",
            "The targeted retry returned an invalid in-progress checkpoint.",
        )
    if status == "SUCCESS" and summary["remainingCount"] != 0:
        raise TargetedRetryFailure(
            "GMAIL_TARGETED_RETRY_RESPONSE_INVALID",
            "The targeted retry returned an invalid successful checkpoint.",
        )
    return summary


def validate_invocation_scope(
    result: Mapping[str, Any],
    *,
    expected_message_count: int,
) -> None:
    message_count = integer_value(result.get("messageCount"))
    remaining_count = integer_value(result.get("remainingCount"))
    status = str(result.get("status") or "")
    valid = (
        expected_message_count >= 0
        and message_count is not None
        and remaining_count is not None
        and (
            (
                status == "SUCCESS"
                and message_count == expected_message_count
                and remaining_count == 0
            )
            or (
                status == "IN_PROGRESS"
                and expected_message_count > 0
                and 0 <= message_count <= expected_message_count
                and 0 < remaining_count <= expected_message_count
            )
        )
    )
    if not valid:
        raise TargetedRetryFailure(
            "GMAIL_TARGETED_RETRY_RESPONSE_INVALID",
            (
                "The targeted retry response did not match the exact "
                "currently verified durable queue scope."
            ),
        )


def verify_selected_rows_recovered(
    ledger_table: Any,
    selected: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    remaining = 0
    for row in selected:
        current = ledger_table.get_item(
            Key={
                "messageId": row["messageId"],
                "attachmentId": row["attachmentId"],
            },
            ConsistentRead=True,
        ).get("Item") or {}
        if (
            current.get("reportType") != row["reportType"]
            or not _is_recovered_receipt_row(current)
        ):
            remaining += 1
    if remaining:
        raise TargetedRetryFailure(
            "GMAIL_TARGETED_RETRY_POSTCHECK_FAILED",
            "One or more selected ledger rows remain failed after retry.",
        )
    return {
        "passed": True,
        "verifiedCount": len(selected),
        "activeFailureRowsRemaining": 0,
    }


def _validated_session(
    profile_name: str,
    *,
    session_factory: Callable[..., Any],
    config_path: Path | None = None,
    credentials_path: Path | None = None,
) -> Any:
    require_admin_sso_profile(
        profile_name,
        config_path=config_path,
        credentials_path=credentials_path,
    )
    for key in AMBIENT_CREDENTIAL_KEYS:
        os.environ.pop(key, None)
    os.environ["AWS_EC2_METADATA_DISABLED"] = "true"

    session = session_factory(
        profile_name=profile_name,
        region_name=EXPECTED_REGION,
    )
    validate_identity(session.client("sts").get_caller_identity())
    return session


def prepare_incident(
    profile_name: str,
    *,
    receipt_path: Path,
    receipt_key_path: Path,
    session_factory: Callable[..., Any] = boto3.Session,
    config_path: Path | None = None,
    credentials_path: Path | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    session = _validated_session(
        profile_name,
        session_factory=session_factory,
        config_path=config_path,
        credentials_path=credentials_path,
    )
    scheduler = session.client("scheduler")
    schedule_check = validate_schedule(
        scheduler.get_schedule(
            GroupName="default",
            Name=EXPECTED_SCHEDULE,
        ),
        expected_state="ENABLED",
    )
    lambda_client = session.client("lambda")
    function_check = validate_function(
        lambda_client.get_function_configuration(
            FunctionName=EXPECTED_FUNCTION,
        ),
        expected_release_commit=None,
    )
    dynamodb = session.resource("dynamodb")
    heartbeat_table = dynamodb.Table(EXPECTED_HEARTBEAT_TABLE)
    heartbeat_rows = (
        heartbeat_table.query(
            KeyConditionExpression=Key("serviceId").eq(
                EXPECTED_HEARTBEAT_SERVICE
            ),
            ScanIndexForward=False,
            ConsistentRead=True,
            Limit=1,
        )
        .get("Items")
        or []
    )
    heartbeat = validate_latest_failure_heartbeat(
        heartbeat_rows,
        now=now,
    )
    ledger_table = dynamodb.Table(EXPECTED_LEDGER_TABLE)
    selected = select_current_failures(ledger_table, heartbeat)
    require_idle_runtime_state(ledger_table)
    receipt = write_incident_receipt(
        receipt_path,
        incident_receipt_payload(heartbeat, selected),
        key_path=receipt_key_path,
    )
    return {
        "passed": True,
        "mode": "prepare",
        "mutation": {
            "awsPerformed": False,
            "localPrivateReceiptCreated": True,
        },
        "receiptPath": str(receipt),
        "selectedCount": len(selected),
        "categories": list(EXPECTED_REPORT_TYPES),
        "incidentObservedAt": heartbeat.get("observedAt"),
        "schedule": schedule_check,
        "function": function_check,
    }


def apply_incident(
    profile_name: str,
    *,
    receipt_path: Path,
    receipt_key_path: Path,
    session_factory: Callable[..., Any] = boto3.Session,
    config_path: Path | None = None,
    credentials_path: Path | None = None,
    release_commit: str | None = None,
) -> dict[str, Any]:
    receipt = load_incident_receipt(
        receipt_path,
        key_path=receipt_key_path,
    )
    session = _validated_session(
        profile_name,
        session_factory=session_factory,
        config_path=config_path,
        credentials_path=credentials_path,
    )
    scheduler = session.client("scheduler")
    schedule_check = validate_schedule(
        scheduler.get_schedule(
            GroupName="default",
            Name=EXPECTED_SCHEDULE,
        ),
        expected_state="DISABLED",
    )
    lambda_client = session.client("lambda")
    exact_release_commit = release_commit or current_git_commit()
    function_check = validate_function(
        lambda_client.get_function_configuration(
            FunctionName=EXPECTED_FUNCTION,
        ),
        expected_release_commit=exact_release_commit,
    )
    dynamodb = session.resource("dynamodb")
    heartbeat_table = dynamodb.Table(EXPECTED_HEARTBEAT_TABLE)
    ledger_table = dynamodb.Table(EXPECTED_LEDGER_TABLE)
    selected = verify_incident_live_evidence(
        heartbeat_table,
        ledger_table,
        receipt,
    )
    runtime_gate = require_idle_or_exact_incident_runtime_state(
        ledger_table,
        selected,
    )
    active_failure_count = sum(
        row.get("needsRetry") is True for row in selected
    )
    if (
        active_failure_count == 0
        and runtime_gate["mode"] == "fresh"
    ):
        postcheck = verify_selected_rows_recovered(
            ledger_table,
            selected,
        )
        return {
            "passed": True,
            "mode": "apply",
            "functionName": EXPECTED_FUNCTION,
            "selectedCount": len(selected),
            "activeFailureCount": 0,
            "categories": list(EXPECTED_REPORT_TYPES),
            "invocationCount": 0,
            "status": "ALREADY_RECOVERED",
            "storedCount": 0,
            "skippedCount": len(selected),
            "errorCount": 0,
            "schedule": schedule_check,
            "function": function_check,
            "verification": postcheck,
        }
    invocation_payload = json.dumps(
        {
            "messageIds": [row["messageId"] for row in selected],
            "source": "operator-targeted-retry",
        },
        separators=(",", ":"),
    ).encode("utf-8")
    totals = {"messageCount": 0, "storedCount": 0, "skippedCount": 0}
    final: dict[str, Any] | None = None
    invocation_gate = runtime_gate
    for invocation_count in range(1, MAX_INVOCATIONS + 1):
        if invocation_count > 1:
            continued_selected = verify_incident_live_evidence(
                heartbeat_table,
                ledger_table,
                receipt,
            )
            continued_gate = (
                require_idle_or_exact_incident_runtime_state(
                    ledger_table,
                    continued_selected,
                )
            )
            if (
                continued_gate["mode"] != "resume"
                or continued_gate["expectedMessageCount"] <= 0
            ):
                raise TargetedRetryFailure(
                    "GMAIL_RUNTIME_BUSY",
                    (
                        "The exact Gmail retry batch could not be "
                        "re-verified before continuation."
                    ),
                )
            invocation_gate = continued_gate
        result = parse_invocation_result(
            lambda_client.invoke(
                FunctionName=EXPECTED_FUNCTION,
                InvocationType="RequestResponse",
                Payload=invocation_payload,
            )
        )
        validate_invocation_scope(
            result,
            expected_message_count=invocation_gate[
                "expectedMessageCount"
            ],
        )
        totals["messageCount"] += result["messageCount"]
        totals["storedCount"] += result["storedCount"]
        totals["skippedCount"] += result["skippedCount"]
        if result["status"] == "SUCCESS":
            final = result
            break
    if final is None:
        raise TargetedRetryFailure(
            "GMAIL_TARGETED_RETRY_INVOCATION_LIMIT",
            "The targeted Gmail retry did not finish within five bounded invocations.",
        )
    postcheck = verify_selected_rows_recovered(ledger_table, selected)
    require_idle_runtime_state(ledger_table)
    return {
        "passed": True,
        "mode": "apply",
        "functionName": EXPECTED_FUNCTION,
        "selectedCount": len(selected),
        "activeFailureCount": active_failure_count,
        "categories": list(EXPECTED_REPORT_TYPES),
        "invocationCount": invocation_count,
        "status": "SUCCESS",
        "storedCount": totals["storedCount"],
        "skippedCount": totals["skippedCount"],
        "errorCount": 0,
        "schedule": schedule_check,
        "function": function_check,
        "verification": postcheck,
    }


def run(
    profile_name: str,
    *,
    mode: str,
    receipt_path: Path,
    receipt_key_path: Path,
    session_factory: Callable[..., Any] = boto3.Session,
    config_path: Path | None = None,
    credentials_path: Path | None = None,
    now: datetime | None = None,
    release_commit: str | None = None,
) -> dict[str, Any]:
    if mode == "prepare":
        return prepare_incident(
            profile_name,
            receipt_path=receipt_path,
            receipt_key_path=receipt_key_path,
            session_factory=session_factory,
            config_path=config_path,
            credentials_path=credentials_path,
            now=now,
        )
    if mode == "apply":
        return apply_incident(
            profile_name,
            receipt_path=receipt_path,
            receipt_key_path=receipt_key_path,
            session_factory=session_factory,
            config_path=config_path,
            credentials_path=credentials_path,
            release_commit=release_commit,
        )
    raise TargetedRetryFailure(
        "GMAIL_TARGETED_RETRY_MODE_INVALID",
        "Targeted retry mode must be prepare or apply.",
    )


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Prepare or apply the authenticated exact-three Gmail "
            "materialization incident receipt."
        )
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--prepare",
        action="store_true",
        help=(
            "Select the current exact-three incident while Gmail scheduling "
            "is enabled and write a private authenticated receipt."
        ),
    )
    mode.add_argument(
        "--apply",
        action="store_true",
        help=(
            "Apply the private incident receipt only while the guarded "
            "deployment has the Gmail schedule disabled."
        ),
    )
    parser.add_argument(
        "--receipt",
        type=Path,
        required=True,
        help="Absolute path to a mode-0600 incident receipt outside the repository.",
    )
    parser.add_argument(
        "--receipt-key",
        type=Path,
        required=True,
        help="Absolute path to the private HMAC key for the incident receipt.",
    )
    parser.add_argument(
        "--admin-profile",
        default=EXPECTED_ADMIN_PROFILE,
        help=(
            "IAM Identity Center profile "
            f"(must be {EXPECTED_ADMIN_PROFILE})."
        ),
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        print(
            json.dumps(
                run(
                    args.admin_profile,
                    mode="prepare" if args.prepare else "apply",
                    receipt_path=args.receipt,
                    receipt_key_path=args.receipt_key,
                ),
                indent=2,
                sort_keys=True,
            )
        )
        return 0
    except TargetedRetryFailure as error:
        print(
            json.dumps(
                {
                    "passed": False,
                    "error": {
                        "code": error.code,
                        "message": str(error),
                    },
                },
                indent=2,
                sort_keys=True,
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
                        "code": "GMAIL_TARGETED_RETRY_AWS_ERROR",
                        "message": (
                            "An unexpected AWS operation failed "
                            f"({type(error).__name__})."
                        ),
                    },
                },
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
