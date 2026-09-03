#!/usr/bin/env python3
"""Safely stage and verify the Gmail/Hermes production reliability runtime.

Read-only inspection is the default. Mutating operations require both
``--apply`` and an explicit ``--admin-profile``. The rollout is intentionally
staged because a newly enabled Scheduler job must prove its own cadence before
the next stage (and, finally, alarm actions) can be enabled.

The ``disabled`` apply-only recovery phase skips runtime prerequisites and
forces every schedule and alarm control off. Any failure after a successful
rollout deployment triggers the same fail-closed deployment automatically.

This command never reads an OAuth secret value, creates credentials, or writes
AWS configuration. The only direct runtime mutation before a schedule is
enabled is an explicit Lambda canary invocation in ``--apply`` mode.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import stat
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

import boto3
from boto3.dynamodb.types import TypeDeserializer
from botocore.config import Config
from botocore.exceptions import (
    BotoCoreError,
    ClientError,
    NoCredentialsError,
    ProfileNotFound,
)
from prepare_tested_release import (
    DEFAULT_KEY_PATH as DEFAULT_RELEASE_RECEIPT_KEY,
    ReleaseReceiptError,
    canonical_template_sha256,
    require_commit,
    verify_release_receipt,
)
from aws_profile_contract import (
    ADMIN_PROFILE as EXPECTED_ADMIN_PROFILE,
    LOCAL_PROFILE as DEFAULT_READ_PROFILE,
    AwsProfileContractError,
    verified_session,
)


REPO_ROOT = Path(__file__).resolve().parents[2]
INFRA_DIR = REPO_ROOT / "infra"
MANIFEST_PATH = REPO_ROOT / "ops" / "services.json"
CONTRACT_PATH = INFRA_DIR / "lambdas" / "hermes_worker" / "service_contract.json"
DEFAULT_ANALYST_SHADOW_ACCEPTANCE = (
    REPO_ROOT / "docs" / "THE_ANALYST_SHADOW_ACCEPTANCE.md"
)

EXPECTED_ACCOUNT = "915328198276"
EXPECTED_REGION = "us-west-1"
EXPECTED_ARTIFACT_BUCKET = (
    f"market-dashboard-sam-artifacts-{EXPECTED_ACCOUNT}-{EXPECTED_REGION}"
)
STACK_NAME = "market-dashboard-readiness-v2"
BOOTSTRAP_STACK_NAME = "market-dashboard-deployment-role-v2"
DEPLOYMENT_ROLE_ARN = (
    "arn:aws:iam::915328198276:role/"
    "market-dashboard-cloudformation-deployment-v2"
)
CONTROL_PARAMETERS = (
    "CloudWatchdogScheduleState",
    "GmailScheduleState",
    "CftcScheduleState",
    "QuantAnalystScheduleState",
    "QuantDeveloperScheduleState",
    "SecurityScheduleState",
    "OperationalAlarmsState",
)
ALL_PARAMETER_NAMES = (
    *CONTROL_PARAMETERS,
    "AlertEmail",
    "GmailOAuthSecretName",
    "RawArtifactBucketName",
    "GmailLedgerTableName",
    "HedgeyeDailySnapshotTableName",
    "HedgeyeRiskRangesTableName",
    "RiskRangeHistoryTableName",
    "HermesAgentRunsTableName",
    "HermesAlertsTableName",
    "BridgeHostId",
    "ReservedConcurrencyState",
    "BuildVersion",
)
PHASE_ENABLES = {
    "disabled": (),
    "cftc": ("CftcScheduleState",),
    "developer": (
        "CloudWatchdogScheduleState",
        "QuantDeveloperScheduleState",
    ),
    "gmail": (
        "CloudWatchdogScheduleState",
        "GmailScheduleState",
        "QuantDeveloperScheduleState",
    ),
    "security": (
        "CloudWatchdogScheduleState",
        "GmailScheduleState",
        "QuantDeveloperScheduleState",
        "SecurityScheduleState",
    ),
    "analyst": (
        "CloudWatchdogScheduleState",
        "GmailScheduleState",
        "QuantAnalystScheduleState",
        "QuantDeveloperScheduleState",
        "SecurityScheduleState",
    ),
    "consolidated": (
        "CloudWatchdogScheduleState",
        "GmailScheduleState",
        "OperationalAlarmsState",
    ),
    "alarms": CONTROL_PARAMETERS,
    "full": CONTROL_PARAMETERS,
}
PENDING_HEARTBEAT_FAILURE_CODES = {
    "HEARTBEAT_COUNT_INSUFFICIENT",
    "HEARTBEAT_CADENCE_INVALID",
    "HEARTBEAT_STALE",
}
WORKER_PHASES = {
    "analyst": "quant-analyst",
    "developer": "quant-developer",
    "security": "security",
}
WORKER_PARAMETER = {
    "quant-analyst": "QuantAnalystScheduleState",
    "quant-developer": "QuantDeveloperScheduleState",
    "security": "SecurityScheduleState",
}
WORKER_HEARTBEAT_REQUIRED = {
    "quant-analyst": 3,
    "quant-developer": 1,
    "security": 1,
}
PRIOR_WORKERS = {
    "quant-developer": (),
    "security": ("quant-developer",),
    "quant-analyst": ("quant-developer", "security"),
}
ALARM_NAMES = (
    "market-dashboard-runtime-failure-queue-v2",
    "market-dashboard-runtime-failure-arrival-v2",
    "market-dashboard-gmail-heartbeat-missing-v2",
    "market-dashboard-gmail-unhealthy-v2",
    "market-dashboard-hermes-analyst-heartbeat-missing-v2",
    "market-dashboard-hermes-analyst-unhealthy-v2",
    "market-dashboard-hermes-developer-heartbeat-missing-v2",
    "market-dashboard-hermes-developer-unhealthy-v2",
    "market-dashboard-hermes-security-heartbeat-missing-v2",
    "market-dashboard-hermes-security-unhealthy-v2",
    "market-dashboard-hermes-cloud-watchdog-heartbeat-missing-v2",
    "market-dashboard-hermes-cloud-watchdog-unhealthy-v2",
)
ALARM_CONTRACTS = {
    "market-dashboard-runtime-failure-queue-v2": {
        "namespace": "AWS/SQS",
        "metric": "ApproximateNumberOfMessagesVisible",
        "statistic": "Maximum",
        "period": 300,
        "comparison": "GreaterThanOrEqualToThreshold",
        "missingData": "notBreaching",
        "notify": False,
    },
    "market-dashboard-runtime-failure-arrival-v2": {
        "namespace": "AWS/SQS",
        "metric": "NumberOfMessagesSent",
        "statistic": "Sum",
        "period": 300,
        "comparison": "GreaterThanOrEqualToThreshold",
        "missingData": "notBreaching",
        "notify": True,
    },
    "market-dashboard-gmail-heartbeat-missing-v2": {
        "namespace": "MarketDashboard/Readiness",
        "metric": "Heartbeat",
        "statistic": "Sum",
        "period": 1800,
        "comparison": "LessThanThreshold",
        "serviceId": "gmail:timsmithaviation@gmail.com",
        "missingDataWhenEnabled": "breaching",
        "missingDataWhenDisabled": "notBreaching",
        "notify": True,
    },
    "market-dashboard-gmail-unhealthy-v2": {
        "namespace": "MarketDashboard/Readiness",
        "metric": "Healthy",
        "statistic": "Minimum",
        "period": 900,
        "comparison": "LessThanThreshold",
        "serviceId": "gmail:timsmithaviation@gmail.com",
        "missingData": "notBreaching",
        "notify": False,
    },
    "market-dashboard-hermes-analyst-heartbeat-missing-v2": {
        "namespace": "MarketDashboard/Readiness",
        "metric": "Heartbeat",
        "statistic": "Sum",
        "period": 1800,
        "comparison": "LessThanThreshold",
        "serviceId": "hermes:quant-analyst",
        "missingDataWhenEnabled": "breaching",
        "missingDataWhenDisabled": "notBreaching",
        "scheduleParameter": "QuantAnalystScheduleState",
        "notify": True,
    },
    "market-dashboard-hermes-analyst-unhealthy-v2": {
        "namespace": "MarketDashboard/Readiness",
        "metric": "Healthy",
        "statistic": "Minimum",
        "period": 900,
        "comparison": "LessThanThreshold",
        "serviceId": "hermes:quant-analyst",
        "missingData": "notBreaching",
        "notify": False,
    },
    "market-dashboard-hermes-developer-heartbeat-missing-v2": {
        "namespace": "MarketDashboard/Readiness",
        "metric": "Heartbeat",
        "statistic": "Sum",
        "period": 1800,
        "comparison": "LessThanThreshold",
        "serviceId": "hermes:quant-developer",
        "missingDataWhenEnabled": "breaching",
        "missingDataWhenDisabled": "notBreaching",
        "scheduleParameter": "QuantDeveloperScheduleState",
        "notify": True,
    },
    "market-dashboard-hermes-developer-unhealthy-v2": {
        "namespace": "MarketDashboard/Readiness",
        "metric": "Healthy",
        "statistic": "Minimum",
        "period": 900,
        "comparison": "LessThanThreshold",
        "serviceId": "hermes:quant-developer",
        "missingData": "notBreaching",
        "notify": False,
    },
    "market-dashboard-hermes-security-heartbeat-missing-v2": {
        "namespace": "MarketDashboard/Readiness",
        "metric": "Heartbeat",
        "statistic": "Sum",
        "period": 7200,
        "comparison": "LessThanThreshold",
        "serviceId": "hermes:security",
        "missingDataWhenEnabled": "breaching",
        "missingDataWhenDisabled": "notBreaching",
        "scheduleParameter": "SecurityScheduleState",
        "notify": True,
    },
    "market-dashboard-hermes-security-unhealthy-v2": {
        "namespace": "MarketDashboard/Readiness",
        "metric": "Healthy",
        "statistic": "Minimum",
        "period": 3600,
        "comparison": "LessThanThreshold",
        "serviceId": "hermes:security",
        "missingData": "notBreaching",
        "notify": False,
    },
    "market-dashboard-hermes-cloud-watchdog-heartbeat-missing-v2": {
        "namespace": "MarketDashboard/Readiness",
        "metric": "Heartbeat",
        "statistic": "Sum",
        "period": 600,
        "comparison": "LessThanThreshold",
        "serviceId": "hermes:cloud-watchdog",
        "missingDataWhenEnabled": "breaching",
        "missingDataWhenDisabled": "notBreaching",
        "notify": True,
    },
    "market-dashboard-hermes-cloud-watchdog-unhealthy-v2": {
        "namespace": "MarketDashboard/Readiness",
        "metric": "Healthy",
        "statistic": "Minimum",
        "period": 300,
        "comparison": "LessThanThreshold",
        "serviceId": "hermes:cloud-watchdog",
        "missingData": "notBreaching",
        "notify": False,
    },
}

DESERIALIZER = TypeDeserializer()
REDACTION_PATTERN = re.compile(
    r"(?i)(client_secret|refresh_token|access_token|authorization|password)"
    r"([\"'\s:=]+)([^,}\s]+)"
)
REQUIRED_SHADOW_RUNS = (
    "Brief me now #1",
    "Brief me now #2",
    "Brief me now #3",
    "Brief me now #4",
    "Brief me now #5",
    "Historical research search",
    "Compare research with portfolio",
    "Market history / chart question",
)


class ActivationFailure(RuntimeError):
    """A bounded, typed operator-facing rollout failure."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        detail: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = dict(detail or {})

    def as_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.detail:
            result["detail"] = self.detail
        return result


def verify_rollback_export(raw_path: str | os.PathLike[str] | None) -> dict[str, Any]:
    """Verify the private, complete ownership-preflight export required by apply."""

    if not raw_path:
        raise ActivationFailure(
            "ROLLBACK_EXPORT_REQUIRED",
            "--apply requires --rollback-export or "
            "MARKET_DASHBOARD_ROLLBACK_EXPORT.",
        )
    candidate = Path(raw_path)
    if not candidate.is_absolute():
        raise ActivationFailure(
            "ROLLBACK_EXPORT_INVALID",
            "Rollback export path must be absolute.",
        )
    rollback = candidate.resolve(strict=False)
    try:
        rollback.relative_to(REPO_ROOT)
    except ValueError:
        pass
    else:
        raise ActivationFailure(
            "ROLLBACK_EXPORT_INVALID",
            "Rollback export must be outside the repository.",
        )
    if not rollback.is_dir() or rollback.is_symlink():
        raise ActivationFailure(
            "ROLLBACK_EXPORT_INVALID",
            "Rollback export directory is missing or unsafe.",
        )
    if stat.S_IMODE(rollback.stat().st_mode) & 0o077:
        raise ActivationFailure(
            "ROLLBACK_EXPORT_INVALID",
            "Rollback export must not be accessible by group or other users.",
        )

    manifest_path = rollback / "SHA256SUMS"
    if not manifest_path.is_file() or manifest_path.is_symlink():
        raise ActivationFailure(
            "ROLLBACK_EXPORT_INVALID",
            "Rollback export has no regular SHA256SUMS manifest.",
        )
    expected: dict[Path, str] = {}
    for line_number, raw_line in enumerate(
        manifest_path.read_text(encoding="utf-8").splitlines(),
        start=1,
    ):
        match = re.fullmatch(r"([0-9a-fA-F]{64})  (\./.+)", raw_line)
        if match is None:
            raise ActivationFailure(
                "ROLLBACK_EXPORT_INVALID",
                f"Invalid rollback checksum entry on line {line_number}.",
            )
        relative = Path(match.group(2))
        if relative.is_absolute() or ".." in relative.parts:
            raise ActivationFailure(
                "ROLLBACK_EXPORT_INVALID",
                "Rollback checksum path escapes the export.",
            )
        artifact = (rollback / relative).resolve(strict=False)
        try:
            artifact.relative_to(rollback)
        except ValueError as error:
            raise ActivationFailure(
                "ROLLBACK_EXPORT_INVALID",
                "Rollback checksum path escapes the export.",
            ) from error
        if artifact in expected:
            raise ActivationFailure(
                "ROLLBACK_EXPORT_INVALID",
                "Rollback checksum manifest contains a duplicate path.",
            )
        expected[artifact] = match.group(1).lower()

    actual = {
        path.resolve(strict=False)
        for path in rollback.rglob("*")
        if path.is_file() and path.name != "SHA256SUMS"
    }
    if set(expected) != actual:
        raise ActivationFailure(
            "ROLLBACK_EXPORT_INVALID",
            "Rollback checksum manifest does not cover exactly every artifact.",
        )
    for artifact, expected_digest in expected.items():
        if artifact.is_symlink() or not artifact.is_file():
            raise ActivationFailure(
                "ROLLBACK_EXPORT_INVALID",
                "Rollback export contains an unsafe artifact.",
            )
        observed = hashlib.sha256(artifact.read_bytes()).hexdigest()
        if observed != expected_digest:
            raise ActivationFailure(
                "ROLLBACK_EXPORT_CHECKSUM_MISMATCH",
                f"Rollback checksum mismatch for {artifact.name}.",
            )

    preflight_path = rollback / "ownership-preflight.json"
    if preflight_path.resolve(strict=False) not in expected:
        raise ActivationFailure(
            "ROLLBACK_EXPORT_INVALID",
            "Rollback preflight is not covered by the checksum manifest.",
        )
    try:
        preflight = json.loads(preflight_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ActivationFailure(
            "ROLLBACK_EXPORT_INVALID",
            "Rollback ownership preflight is unreadable.",
        ) from error
    if preflight.get("passed") is not True or preflight.get("conflicts"):
        raise ActivationFailure(
            "ROLLBACK_OWNERSHIP_PREFLIGHT_FAILED",
            "Rollback ownership preflight did not pass.",
        )
    required = {
        "account": EXPECTED_ACCOUNT,
        "region": EXPECTED_REGION,
        "targetStack": STACK_NAME,
        "bootstrapStack": BOOTSTRAP_STACK_NAME,
    }
    for key, value in required.items():
        if preflight.get(key) != value:
            raise ActivationFailure(
                "ROLLBACK_EXPORT_INVALID",
                f"Rollback preflight has an unexpected {key}.",
            )
    return {
        "passed": True,
        "path": str(rollback),
        "artifactCount": len(expected),
    }


def exported_control_state(raw_path: str | os.PathLike[str]) -> dict[str, str]:
    stack_path = Path(raw_path) / "cloudformation-stack.json"
    try:
        payload = json.loads(stack_path.read_text(encoding="utf-8"))
        stacks = payload.get("Stacks") or []
        parameters = stack_parameters(stacks[0]) if len(stacks) == 1 else {}
    except (OSError, ValueError, TypeError, IndexError) as error:
        raise ActivationFailure(
            "ROLLBACK_CONTROL_STATE_INVALID",
            "The rollback export does not contain one readable stack parameter set.",
        ) from error
    controls = {name: parameters.get(name) for name in CONTROL_PARAMETERS}
    # A rollback export captured before the official CFTC resource was first
    # deployed has no CftcScheduleState. Its only safe equivalent is disabled.
    if controls.get("CftcScheduleState") is None:
        controls["CftcScheduleState"] = "DISABLED"
    if any(value not in {"ENABLED", "DISABLED"} for value in controls.values()):
        raise ActivationFailure(
            "ROLLBACK_CONTROL_STATE_INVALID",
            "The rollback export contains an invalid or missing control state.",
            detail={"controls": controls},
        )
    return {name: str(value) for name, value in controls.items()}


def safe_text(value: Any, limit: int = 500) -> str:
    """Bound diagnostics and redact credential-shaped values."""

    text = str(value or "unknown").replace("\r", " ").replace("\n", " ")
    return REDACTION_PATTERN.sub(r"\1\2[REDACTED]", text)[:limit]


def typed_code(value: Any, fallback: str) -> str:
    candidate = re.sub(r"[^A-Z0-9_]+", "_", str(value or "").upper()).strip("_")
    return candidate[:100] if candidate else fallback


def integer_value(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def numeric_value(value: Any, default: float = 0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def exact_integer(value: Any) -> int | None:
    """Accept only lossless DynamoDB-style integer values."""
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


def parse_timestamp(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def verify_analyst_shadow_acceptance(
    raw_path: str | os.PathLike[str] | None,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Require the explicit seven-day Analyst acceptance log before cutover."""

    path = Path(raw_path or DEFAULT_ANALYST_SHADOW_ACCEPTANCE)
    if not path.is_file() or path.is_symlink():
        raise ActivationFailure(
            "ANALYST_SHADOW_ACCEPTANCE_MISSING",
            "The Analyst shadow acceptance log is missing or unsafe.",
        )
    contents = path.read_text(encoding="utf-8")
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)

    def field(label: str) -> str:
        match = re.search(
            rf"^{re.escape(label)}:\s*(.+?)\s*$",
            contents,
            flags=re.MULTILINE,
        )
        value = str(match.group(1) if match else "").strip()
        if not value or value.startswith("_"):
            raise ActivationFailure(
                "ANALYST_SHADOW_ACCEPTANCE_INCOMPLETE",
                f"{label} is not complete in the Analyst shadow log.",
            )
        return value

    started_at = parse_timestamp(field("Shadow start"))
    eligible_at = parse_timestamp(field("Earliest eligible cutover date"))
    if started_at is None or eligible_at is None:
        raise ActivationFailure(
            "ANALYST_SHADOW_ACCEPTANCE_DATE_INVALID",
            "The shadow start and earliest cutover date must be ISO dates or timestamps.",
        )
    if (current.date() - started_at.date()).days < 7 or current < eligible_at:
        raise ActivationFailure(
            "ANALYST_SHADOW_WINDOW_INCOMPLETE",
            "The mandatory seven-calendar-day Analyst shadow window has not elapsed.",
            detail={
                "shadowStart": started_at.isoformat(),
                "earliestEligibleAt": eligible_at.isoformat(),
                "checkedAt": current.isoformat(),
            },
        )

    observed_runs: dict[str, list[str]] = {}
    for line in contents.splitlines():
        if not line.lstrip().startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) >= 5 and cells[1] in REQUIRED_SHADOW_RUNS:
            observed_runs[cells[1]] = cells
    missing_runs = [name for name in REQUIRED_SHADOW_RUNS if name not in observed_runs]
    incomplete_runs = []
    for name, cells in observed_runs.items():
        evidence = cells[0:5]
        if any(not value or value.startswith("_") for value in evidence):
            incomplete_runs.append(name)
            continue
        normalized_result = cells[2].lower()
        if not normalized_result.startswith(("pass", "success", "accepted", "ok", "✅")):
            incomplete_runs.append(name)
    if missing_runs or incomplete_runs:
        raise ActivationFailure(
            "ANALYST_SHADOW_RUNS_INCOMPLETE",
            "Every required Analyst shadow run must have passing evidence.",
            detail={"missing": missing_runs, "incomplete": incomplete_runs},
        )

    checkbox_values = re.findall(
        r"^- \[([ xX])\] ",
        contents,
        flags=re.MULTILINE,
    )
    if len(checkbox_values) < 11 or any(value.lower() != "x" for value in checkbox_values):
        raise ActivationFailure(
            "ANALYST_SHADOW_CHECKLIST_INCOMPLETE",
            "Every Analyst shadow acceptance checkbox must pass before cutover.",
            detail={
                "checked": sum(value.lower() == "x" for value in checkbox_values),
                "total": len(checkbox_values),
            },
        )

    decision = field("Decision").lower()
    decision_at = parse_timestamp(field("Decision date"))
    reviewed_by = field("Evidence reviewed by")
    retention_end = parse_timestamp(field("30-day rollback-retention end date"))
    if (
        decision not in {"approved", "pass", "accepted"}
        or decision_at is None
        or decision_at > current
    ):
        raise ActivationFailure(
            "ANALYST_SHADOW_DECISION_NOT_APPROVED",
            "The shadow acceptance decision must be explicitly approved and dated no later than cutover.",
        )
    if retention_end is None or (retention_end.date() - current.date()).days < 30:
        raise ActivationFailure(
            "ANALYST_ROLLBACK_RETENTION_INVALID",
            "The rollback-retention end date must preserve at least 30 calendar days after cutover.",
        )

    return {
        "passed": True,
        "path": str(path.resolve()),
        "sha256": hashlib.sha256(contents.encode("utf-8")).hexdigest(),
        "shadowStart": started_at.isoformat(),
        "earliestEligibleAt": eligible_at.isoformat(),
        "decisionAt": decision_at.isoformat(),
        "rollbackRetentionEndsAt": retention_end.isoformat(),
        "reviewedBy": reviewed_by,
        "requiredRunCount": len(REQUIRED_SHADOW_RUNS),
        "acceptanceCheckCount": len(checkbox_values),
    }


def minutes_old(value: Any, *, now: datetime | None = None) -> float | None:
    parsed = parse_timestamp(value)
    if not parsed:
        return None
    current = now or datetime.now(timezone.utc)
    return (current - parsed).total_seconds() / 60


def as_plain_item(item: Mapping[str, Any]) -> dict[str, Any]:
    return {key: DESERIALIZER.deserialize(value) for key, value in item.items()}


def json_default(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime):
        return value.isoformat()
    raise TypeError(type(value).__name__)


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def manifest_contracts() -> tuple[dict[str, Any], dict[str, Any]]:
    manifest = load_json(MANIFEST_PATH)
    contract = load_json(CONTRACT_PATH)
    return manifest, contract


def normalize_aws_error(prefix: str, error: Exception) -> ActivationFailure:
    if isinstance(error, ClientError):
        raw_code = str(error.response.get("Error", {}).get("Code") or "CLIENT_ERROR")
        upper = re.sub(r"[^A-Z0-9]+", "_", raw_code.upper()).strip("_")
        if "ACCESSDENIED" in upper or "UNAUTHORIZED" in upper:
            suffix = "ACCESS_DENIED"
        elif "NOTFOUND" in upper or "NO_SUCH" in upper:
            suffix = "NOT_FOUND"
        elif "THROTTL" in upper:
            suffix = "THROTTLED"
        else:
            suffix = upper or "CLIENT_ERROR"
        message = error.response.get("Error", {}).get("Message") or raw_code
        return ActivationFailure(
            f"{prefix}_{suffix}",
            safe_text(message),
            detail={"awsErrorCode": raw_code},
        )
    if isinstance(error, ProfileNotFound):
        return ActivationFailure("AWS_PROFILE_UNAVAILABLE", safe_text(error))
    if isinstance(error, (NoCredentialsError, BotoCoreError)):
        return ActivationFailure(f"{prefix}_AWS_CLIENT_ERROR", safe_text(error))
    return ActivationFailure(f"{prefix}_UNEXPECTED", safe_text(error))


def aws_call(prefix: str, callback: Callable[[], Any]) -> Any:
    try:
        return callback()
    except ActivationFailure:
        raise
    except Exception as error:
        raise normalize_aws_error(prefix, error) from None


def validate_identity(
    identity: Mapping[str, Any],
    *,
    region: str,
    require_sso: bool = False,
) -> dict[str, str]:
    account = str(identity.get("Account") or "")
    arn = str(identity.get("Arn") or "")
    if account != EXPECTED_ACCOUNT:
        raise ActivationFailure(
            "AWS_ACCOUNT_MISMATCH",
            f"Refusing account {account or '<unknown>'}; expected {EXPECTED_ACCOUNT}.",
        )
    if region != EXPECTED_REGION:
        raise ActivationFailure(
            "AWS_REGION_MISMATCH",
            f"Refusing region {region}; expected {EXPECTED_REGION}.",
        )
    if f"::{EXPECTED_ACCOUNT}:" not in arn:
        raise ActivationFailure(
            "AWS_IDENTITY_INVALID",
            "STS returned an identity ARN outside the expected account.",
        )
    if require_sso and not arn.startswith(
        f"arn:aws:sts::{EXPECTED_ACCOUNT}:assumed-role/AWSReservedSSO_"
    ):
        raise ActivationFailure(
            "AWS_SSO_IDENTITY_REQUIRED",
            "Apply mode requires an AWS IAM Identity Center/SSO assumed role.",
        )
    return {"account": account, "arn": arn, "region": region}


def stack_parameters(stack: Mapping[str, Any]) -> dict[str, str]:
    return {
        str(item["ParameterKey"]): str(item.get("ParameterValue") or "")
        for item in stack.get("Parameters") or []
        if item.get("ParameterKey")
    }


def stack_outputs(stack: Mapping[str, Any]) -> dict[str, str]:
    return {
        str(item["OutputKey"]): str(item.get("OutputValue") or "")
        for item in stack.get("Outputs") or []
        if item.get("OutputKey")
    }


def validate_stack(stack: Mapping[str, Any]) -> None:
    stack_id = str(stack.get("StackId") or "")
    expected_prefix = (
        f"arn:aws:cloudformation:{EXPECTED_REGION}:{EXPECTED_ACCOUNT}:stack/{STACK_NAME}/"
    )
    if not stack_id.startswith(expected_prefix):
        raise ActivationFailure(
            "STACK_ID_MISMATCH",
            "CloudFormation returned a stack outside the exact account, region, or name.",
        )
    status = str(stack.get("StackStatus") or "")
    if status not in {"CREATE_COMPLETE", "UPDATE_COMPLETE"}:
        raise ActivationFailure(
            "STACK_NOT_READY",
            f"{STACK_NAME} is {status or 'UNKNOWN'}, not CREATE_COMPLETE/UPDATE_COMPLETE.",
        )
    missing = [name for name in ALL_PARAMETER_NAMES if name not in stack_parameters(stack)]
    if missing:
        raise ActivationFailure(
            "STACK_PARAMETER_MISSING",
            "The deployed stack is missing required explicit parameters.",
            detail={"parameters": missing},
        )


def target_control_state(
    phase: str, current_parameters: Mapping[str, str]
) -> dict[str, str]:
    target: dict[str, str] = {}
    enables = set(PHASE_ENABLES.get(phase, ()))
    for name in CONTROL_PARAMETERS:
        current = str(current_parameters.get(name) or "DISABLED")
        if current not in {"ENABLED", "DISABLED"}:
            raise ActivationFailure(
                "STACK_CONTROL_STATE_INVALID",
                f"{name} has unsupported state {current}.",
            )
        if phase == "cftc":
            target[name] = "ENABLED" if name == "CftcScheduleState" else current
            continue
        # CFTC activation is an independent official-data rollout. Existing
        # Hermes/Gmail stages must not be changed just to enable it, and the
        # older phases must not silently disable it after activation.
        if name == "CftcScheduleState":
            if phase in {"cftc", "alarms", "full"}:
                target[name] = "ENABLED"
            elif phase == "disabled":
                target[name] = "DISABLED"
            else:
                target[name] = current
            continue
        # Every legacy phase is an exact, fail-closed desired state. This prevents a
        # later-stage schedule or alarm from surviving an earlier recovery
        # phase and makes the Developer -> Gmail -> Security -> Analyst order
        # auditable from CloudFormation parameters.
        target[name] = "ENABLED" if name in enables else "DISABLED"
    return target


def heartbeat_observation_pending(result: Mapping[str, Any]) -> bool:
    """Return true only for an incomplete, otherwise non-failing new window."""

    failures = result.get("failures") or []
    return bool(failures) and all(
        str(failure.get("code") or "") in PENDING_HEARTBEAT_FAILURE_CODES
        for failure in failures
    )


def heartbeats_after_watermark(
    rows: Sequence[Mapping[str, Any]],
    observed_after: Any | None,
) -> list[Mapping[str, Any]]:
    """Exclude heartbeat rows that existed before a schedule was enabled."""

    if observed_after is None:
        return list(rows)
    watermark = parse_timestamp(observed_after)
    if watermark is None:
        raise ActivationFailure(
            "HEARTBEAT_WATERMARK_INVALID",
            "The pre-enable heartbeat watermark is missing or invalid.",
        )
    filtered: list[Mapping[str, Any]] = []
    for row in rows:
        observed_at = parse_timestamp(row.get("observedAt"))
        # Preserve malformed rows so the heartbeat validator can fail closed.
        if observed_at is None or observed_at > watermark:
            filtered.append(row)
    return filtered


def deployment_parameters(
    current_parameters: Mapping[str, str],
    controls: Mapping[str, str],
    *,
    build_version: str,
) -> dict[str, str]:
    try:
        release_commit = require_commit(build_version)
    except ReleaseReceiptError as error:
        raise ActivationFailure(
            "TESTED_RELEASE_COMMIT_INVALID",
            str(error),
        ) from error
    missing = [name for name in ALL_PARAMETER_NAMES if name not in current_parameters]
    if missing:
        raise ActivationFailure(
            "STACK_PARAMETER_MISSING",
            "Cannot safely preserve every deployed parameter.",
            detail={"parameters": missing},
        )
    if str(current_parameters["BuildVersion"]) != release_commit:
        raise ActivationFailure(
            "STACK_BUILD_VERSION_MISMATCH",
            (
                "Staged activation may only preserve the already deployed "
                f"tested release {release_commit}."
            ),
            detail={
                "expected": release_commit,
                "actual": str(current_parameters["BuildVersion"]),
            },
        )
    result = {name: str(current_parameters[name]) for name in ALL_PARAMETER_NAMES}
    result.update({name: str(value) for name, value in controls.items()})
    result["BuildVersion"] = release_commit
    for name, value in result.items():
        if not value or any(character in value for character in "\r\n"):
            raise ActivationFailure(
                "STACK_PARAMETER_INVALID",
                f"{name} is empty or contains a newline.",
            )
    return result


def heartbeat_window(
    rows: Sequence[Mapping[str, Any]],
    *,
    service_id: str,
    schedule_id: str,
    required: int,
    cadence_minutes: int,
    allowed_statuses: Iterable[str],
    now: datetime | None = None,
) -> dict[str, Any]:
    """Validate a consecutive 24/7 Scheduler heartbeat window."""

    allowed = set(allowed_statuses)
    selected = list(rows[:required])
    failures: list[dict[str, str]] = []
    if len(selected) < required:
        failures.append(
            {
                "code": "HEARTBEAT_COUNT_INSUFFICIENT",
                "message": f"Expected {required}, found {len(selected)}.",
            }
        )
    for row in selected:
        observed = str(row.get("observedAt") or "")
        if row.get("status") not in allowed:
            failures.append(
                {
                    "code": "HEARTBEAT_STATUS_UNHEALTHY",
                    "message": f"{observed}: status={row.get('status') or 'missing'}.",
                }
            )
        if (
            row.get("serviceId") != service_id
            or row.get("source") != "aws-lambda"
            or row.get("triggerSource") != "aws-scheduler"
            or row.get("scheduleId") != schedule_id
            or row.get("scheduled") is not True
        ):
            failures.append(
                {
                    "code": "HEARTBEAT_PROVENANCE_INVALID",
                    "message": f"{observed}: heartbeat was not emitted by the exact Scheduler job.",
                }
            )
        counts = row.get("counts")
        if isinstance(counts, Mapping):
            gmail_errors = exact_integer(counts.get("errors"))
            gmail_dropped = exact_integer(counts.get("dropped"))
        else:
            gmail_errors = None
            gmail_dropped = None
        if service_id.startswith("gmail:") and (
            gmail_errors != 0 or gmail_dropped != 0
        ):
            failures.append(
                {
                    "code": "GMAIL_HEARTBEAT_DATA_ERROR",
                    "message": (
                        f"{observed}: errors={gmail_errors}, "
                        f"dropped={gmail_dropped}."
                    ),
                }
            )

    ordered = sorted(
        selected,
        key=lambda row: parse_timestamp(row.get("observedAt"))
        or datetime.min.replace(tzinfo=timezone.utc),
    )
    minimum_gap = cadence_minutes * 0.5
    maximum_gap = cadence_minutes * 1.5
    for earlier, later in zip(ordered, ordered[1:]):
        earlier_at = parse_timestamp(earlier.get("observedAt"))
        later_at = parse_timestamp(later.get("observedAt"))
        if not earlier_at or not later_at:
            failures.append(
                {
                    "code": "HEARTBEAT_TIMESTAMP_INVALID",
                    "message": "A heartbeat has an invalid observedAt timestamp.",
                }
            )
            continue
        gap = (later_at - earlier_at).total_seconds() / 60
        if gap < minimum_gap or gap > maximum_gap:
            failures.append(
                {
                    "code": "HEARTBEAT_CADENCE_INVALID",
                    "message": (
                        f"Observed {gap:.1f}m gap; expected {minimum_gap:.1f}-"
                        f"{maximum_gap:.1f}m for a 24/7 {cadence_minutes}m schedule."
                    ),
                }
            )

    latest_at = selected[0].get("observedAt") if selected else None
    age = minutes_old(latest_at, now=now)
    if age is None or age < -1 or age > maximum_gap:
        failures.append(
            {
                "code": "HEARTBEAT_STALE",
                "message": (
                    "Latest heartbeat timestamp is missing/invalid."
                    if age is None
                    else f"Latest heartbeat is {age:.1f}m old; limit is {maximum_gap:.1f}m."
                ),
            }
        )

    warnings = [
        {
            "observedAt": row.get("observedAt"),
            "status": row.get("status"),
            "errorCode": typed_code(row.get("errorCode"), "UNSPECIFIED_WARNING"),
        }
        for row in selected
        if row.get("status") == "warning" or row.get("errorCode")
    ]
    return {
        "passed": not failures,
        "serviceId": service_id,
        "required": required,
        "observed": len(selected),
        "latestAt": latest_at,
        "failures": failures,
        "warnings": warnings,
    }


def event_rule_heartbeat(
    rows: Sequence[Mapping[str, Any]],
    *,
    service_id: str,
    rule_id: str,
    max_age_minutes: float = 10,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Verify one fresh, healthy heartbeat from an exact EventBridge rule."""

    selected = list(rows[:1])
    failures: list[dict[str, str]] = []
    if len(selected) != 1:
        failures.append(
            {
                "code": "HEARTBEAT_COUNT_INSUFFICIENT",
                "message": "Expected one cloud-watchdog heartbeat.",
            }
        )
    if selected:
        row = selected[0]
        observed = str(row.get("observedAt") or "")
        if row.get("status") != "success":
            failures.append(
                {
                    "code": "HEARTBEAT_STATUS_UNHEALTHY",
                    "message": f"{observed}: status={row.get('status') or 'missing'}.",
                }
            )
        if (
            row.get("serviceId") != service_id
            or row.get("source") != "aws-lambda"
            or row.get("triggerSource") != "aws-events"
            or row.get("ruleId") != rule_id
            or row.get("scheduled") is not True
        ):
            failures.append(
                {
                    "code": "HEARTBEAT_PROVENANCE_INVALID",
                    "message": (
                        f"{observed}: heartbeat was not emitted by the exact "
                        "cloud-watchdog EventBridge rule."
                    ),
                }
            )
    latest_at = selected[0].get("observedAt") if selected else None
    age = minutes_old(latest_at, now=now)
    if age is None or age < -1 or age > max_age_minutes:
        failures.append(
            {
                "code": "HEARTBEAT_STALE",
                "message": (
                    "Latest cloud-watchdog heartbeat is missing or invalid."
                    if age is None
                    else (
                        f"Latest cloud-watchdog heartbeat is {age:.1f}m old; "
                        f"limit is {max_age_minutes:.1f}m."
                    )
                ),
            }
        )
    return {
        "passed": not failures,
        "serviceId": service_id,
        "required": 1,
        "observed": len(selected),
        "latestAt": latest_at,
        "failures": failures,
        "warnings": [],
    }


def require_heartbeat(result: Mapping[str, Any], code: str) -> None:
    if result.get("passed"):
        return
    failures = result.get("failures") or []
    first = failures[0] if failures else {}
    raise ActivationFailure(
        code,
        str(first.get("message") or "The required Scheduler heartbeat window did not pass."),
        detail={
            "serviceId": result.get("serviceId"),
            "latestAt": result.get("latestAt"),
            "failures": failures,
        },
    )


def parse_lambda_result(
    response: Mapping[str, Any],
    *,
    kind: str,
    accepted_statuses: set[str],
) -> dict[str, Any]:
    if response.get("FunctionError"):
        raise ActivationFailure(
            f"{kind}_CANARY_RUNTIME_ERROR",
            "Lambda returned FunctionError during the activation canary.",
        )
    payload_stream = response.get("Payload")
    raw_payload = payload_stream.read() if hasattr(payload_stream, "read") else payload_stream
    try:
        encoded = (
            (raw_payload or b"{}").decode()
            if isinstance(raw_payload, bytes)
            else raw_payload
        )
        outer = json.loads(encoded)
        body = outer.get("body") if isinstance(outer, dict) else None
        inner = json.loads(body) if isinstance(body, str) else (body or {})
    except (TypeError, ValueError, UnicodeError, json.JSONDecodeError):
        raise ActivationFailure(
            f"{kind}_CANARY_RESPONSE_INVALID",
            "Lambda canary returned an invalid response envelope.",
        ) from None
    if not isinstance(inner, Mapping):
        raise ActivationFailure(
            f"{kind}_CANARY_RESPONSE_INVALID",
            "Lambda canary body is not an object.",
        )
    status = str(inner.get("status") or "").upper()
    error_code = typed_code(inner.get("errorCode"), "")
    error_codes = [
        typed_code(value, "UNSPECIFIED_WARNING")
        for value in inner.get("errorCodes") or []
        if value
    ]
    if status not in accepted_statuses:
        if kind == "GMAIL" and status == "AUTH_REQUIRED":
            code = error_code or "GMAIL_AUTH_REQUIRED"
        elif kind == "GMAIL" and status == "PARTIAL_ERROR":
            code = "GMAIL_CANARY_PARTIAL_ERROR"
        elif kind.startswith("HERMES") and status == "REJECTED":
            code = error_code or f"{kind}_CANARY_REJECTED"
        else:
            code = error_code or f"{kind}_CANARY_FAILED"
        raise ActivationFailure(
            code,
            f"{kind} canary returned {status or 'UNKNOWN'}.",
        )
    return {
        "status": status,
        "messageCount": integer_value(inner.get("messageCount")),
        "storedCount": integer_value(inner.get("storedCount")),
        "skippedCount": integer_value(inner.get("skippedCount")),
        "errorCount": integer_value(inner.get("errorCount")),
        "errorCodes": error_codes,
    }


def parse_cftc_canary_result(response: Mapping[str, Any]) -> dict[str, Any]:
    """Validate the read-only official CFTC calculation response."""
    if response.get("FunctionError"):
        raise ActivationFailure(
            "CFTC_CANARY_RUNTIME_ERROR",
            "The official CFTC Lambda returned FunctionError during its read-only canary.",
        )
    payload_stream = response.get("Payload")
    raw_payload = payload_stream.read() if hasattr(payload_stream, "read") else payload_stream
    try:
        encoded = raw_payload.decode() if isinstance(raw_payload, bytes) else raw_payload
        result = json.loads(encoded or "{}")
    except (TypeError, ValueError, UnicodeError, json.JSONDecodeError):
        raise ActivationFailure(
            "CFTC_CANARY_RESPONSE_INVALID",
            "The official CFTC Lambda returned an invalid read-only response.",
        ) from None
    if (
        not isinstance(result, Mapping)
        or result.get("ok") is not True
        or result.get("result") != "dry-run"
        or integer_value(result.get("metricsCount")) != 35
        or not re.fullmatch(r"[a-f0-9]{64}", str(result.get("sourceContentHash") or ""))
        or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(result.get("reportDate") or ""))
        or not isinstance(result.get("snapshot"), Mapping)
        or result["snapshot"].get("source") != "cftc-public-reporting-environment"
        or result["snapshot"].get("calculationVersion") != "cftc-combined-net-sample-z-v1"
    ):
        raise ActivationFailure(
            "CFTC_CANARY_RESPONSE_INVALID",
            "The official CFTC read-only calculation did not satisfy the snapshot contract.",
        )
    return {
        "passed": True,
        "result": "dry-run",
        "reportDate": result["reportDate"],
        "metricsCount": 35,
        "contentComplete": result.get("contentComplete") is True,
        "sourceContentHash": result["sourceContentHash"],
        "_snapshot": result["snapshot"],
    }


def parse_cftc_write_result(response: Mapping[str, Any]) -> dict[str, Any]:
    if response.get("FunctionError"):
        raise ActivationFailure(
            "CFTC_CURRENT_WRITE_FAILED",
            "The one-time official CFTC current write returned FunctionError.",
        )
    payload_stream = response.get("Payload")
    raw_payload = payload_stream.read() if hasattr(payload_stream, "read") else payload_stream
    try:
        encoded = raw_payload.decode() if isinstance(raw_payload, bytes) else raw_payload
        result = json.loads(encoded or "{}")
    except (TypeError, ValueError, UnicodeError, json.JSONDecodeError):
        raise ActivationFailure(
            "CFTC_CURRENT_WRITE_RESPONSE_INVALID",
            "The one-time official CFTC current write returned invalid JSON.",
        ) from None
    if (
        not isinstance(result, Mapping)
        or result.get("ok") is not True
        or result.get("result") not in {"created", "unchanged", "revised"}
        or integer_value(result.get("metricsCount")) != 35
        or not re.fullmatch(r"[a-f0-9]{64}", str(result.get("sourceContentHash") or ""))
    ):
        raise ActivationFailure(
            "CFTC_CURRENT_WRITE_RESPONSE_INVALID",
            "The one-time official CFTC current write did not satisfy the snapshot contract.",
        )
    return {
        "passed": True,
        "result": result["result"],
        "reportDate": result.get("reportDate"),
        "metricsCount": 35,
        "contentComplete": result.get("contentComplete") is True,
        "sourceContentHash": result["sourceContentHash"],
    }


def validate_bridge_snapshot(
    snapshot: Mapping[str, Any] | None,
    *,
    expected_capabilities: set[str],
    snapshot_type: str = "operations",
    max_age_minutes: float = 3,
    now: datetime | None = None,
) -> dict[str, Any]:
    if not snapshot:
        raise ActivationFailure(
            "HERMES_INPUT_MISSING",
            "No outbound Hermes bridge snapshot exists for the configured host.",
        )
    age = minutes_old(snapshot.get("capturedAt"), now=now)
    if age is None or age < -0.5 or age > max_age_minutes:
        raise ActivationFailure(
            "HERMES_INPUT_STALE",
            "The newest outbound bridge snapshot is not fresh enough for a canary.",
            detail={"capturedAt": snapshot.get("capturedAt"), "ageMinutes": age},
        )
    if (
        snapshot.get("source") != "local-outbound-bridge"
        or snapshot.get("bridgeStatus") != "ready"
    ):
        raise ActivationFailure(
            typed_code(snapshot.get("errorCode"), "HERMES_BRIDGE_DEGRADED"),
            safe_text(snapshot.get("detail") or "The outbound bridge is not ready."),
        )
    if (
        snapshot.get("schemaVersion") != 2
        or snapshot.get("snapshotType") != snapshot_type
    ):
        raise ActivationFailure(
            "HERMES_INPUT_PARTITION_INVALID",
            f"Expected versioned {snapshot_type} bridge telemetry.",
        )
    capabilities = snapshot.get("capabilities")
    required_capabilities = (
        {"portfolio.live"} if snapshot_type == "portfolio" else expected_capabilities
    )
    if not isinstance(capabilities, Mapping) or set(capabilities) != required_capabilities:
        raise ActivationFailure(
            "SYSTEM_READINESS_CAPABILITY_CONTRACT_INVALID",
            "The bridge snapshot does not contain the exact readiness capability set.",
        )
    if snapshot_type == "operations":
        if "portfolio" in snapshot or "positions" in snapshot:
            raise ActivationFailure(
                "OPERATIONS_TELEMETRY_CONTAINS_PORTFOLIO",
                "Operations bridge telemetry must not contain portfolio data.",
            )
        return {
            "passed": True,
            "capturedAt": snapshot.get("capturedAt"),
            "ageMinutes": age,
            "bridgeStatus": "ready",
            "snapshotType": "operations",
        }
    portfolio_capability = capabilities.get("portfolio.live") or {}
    if (
        portfolio_capability.get("ready") is not True
        or portfolio_capability.get("status") not in {"pass", "ready"}
    ):
        raise ActivationFailure(
            typed_code(
                portfolio_capability.get("errorCode"),
                "PORTFOLIO_CAPABILITY_BLOCKED",
            ),
            "The live portfolio gate is not ready for a Hermes canary.",
        )
    portfolio = snapshot.get("portfolio") or {}
    gateway = snapshot.get("gateway") or {}
    if (
        portfolio.get("verified") is not True
        or portfolio.get("source") != "ibkr_live"
        or portfolio.get("accountsVerified") is not True
        or gateway.get("connected") is not True
    ):
        raise ActivationFailure(
            "PORTFOLIO_NOT_VERIFIED_LIVE",
            "The bridge snapshot does not contain a verified live IBKR session.",
        )
    return {
        "passed": True,
        "capturedAt": snapshot.get("capturedAt"),
        "ageMinutes": age,
        "bridgeStatus": "ready",
        "snapshotType": "portfolio",
    }


def validate_secret_metadata(description: Mapping[str, Any]) -> dict[str, Any]:
    if description.get("DeletedDate"):
        raise ActivationFailure(
            "GMAIL_OAUTH_SECRET_PENDING_DELETION",
            "The Gmail OAuth secret is pending deletion.",
        )
    versions = description.get("VersionIdsToStages") or {}
    current_versions = [
        version_id
        for version_id, stages in versions.items()
        if "AWSCURRENT" in (stages or [])
    ]
    if len(current_versions) != 1:
        raise ActivationFailure(
            "GMAIL_OAUTH_SECRET_CURRENT_VERSION_INVALID",
            f"Expected one AWSCURRENT version, found {len(current_versions)}.",
        )
    return {"passed": True, "currentVersionPresent": True, "_versionId": current_versions[0]}


def validate_function_configuration(
    configuration: Mapping[str, Any], *, expected_name: str, kind: str
) -> dict[str, Any]:
    if configuration.get("FunctionName") != expected_name:
        raise ActivationFailure(
            f"{kind}_FUNCTION_NAME_MISMATCH",
            f"Expected Lambda {expected_name}.",
        )
    if configuration.get("State") != "Active":
        raise ActivationFailure(
            f"{kind}_FUNCTION_NOT_ACTIVE",
            f"{expected_name} is {configuration.get('State') or 'UNKNOWN'}.",
        )
    if configuration.get("LastUpdateStatus") not in {None, "Successful"}:
        raise ActivationFailure(
            f"{kind}_FUNCTION_UPDATE_FAILED",
            f"{expected_name} last update is {configuration.get('LastUpdateStatus')}.",
        )
    return {"passed": True, "functionName": expected_name, "state": "Active"}


def verify_schedule(
    schedule: Mapping[str, Any],
    *,
    name: str,
    expected_state: str,
    expression: str,
    target_function_name: str,
    expected_input: Mapping[str, Any],
    timezone_name: str | None = None,
) -> dict[str, Any]:
    failures: list[dict[str, str]] = []
    if schedule.get("Name") != name:
        failures.append({"code": "SCHEDULE_NAME_MISMATCH", "message": f"Expected {name}."})
    if schedule.get("State") != expected_state:
        failures.append(
            {
                "code": "SCHEDULE_STATE_MISMATCH",
                "message": f"{name} is {schedule.get('State')}, expected {expected_state}.",
            }
        )
    if schedule.get("ScheduleExpression") != expression:
        failures.append(
            {
                "code": "SCHEDULE_EXPRESSION_MISMATCH",
                "message": f"{name} cadence does not match the checked-in contract.",
            }
        )
    if timezone_name and schedule.get("ScheduleExpressionTimezone") != timezone_name:
        failures.append(
            {
                "code": "SCHEDULE_TIMEZONE_MISMATCH",
                "message": f"{name} timezone does not match the checked-in contract.",
            }
        )
    target = schedule.get("Target") or {}
    expected_arn = (
        f"arn:aws:lambda:{EXPECTED_REGION}:{EXPECTED_ACCOUNT}:function:{target_function_name}"
    )
    if target.get("Arn") != expected_arn:
        failures.append(
            {
                "code": "SCHEDULE_TARGET_MISMATCH",
                "message": f"{name} does not target the exact owned Lambda.",
            }
        )
    role_arn = str(target.get("RoleArn") or "")
    if not role_arn.startswith(f"arn:aws:iam::{EXPECTED_ACCOUNT}:role/"):
        failures.append(
            {
                "code": "SCHEDULE_ROLE_MISMATCH",
                "message": f"{name} invoke role is outside the expected account.",
            }
        )
    try:
        actual_input = json.loads(target.get("Input") or "{}")
    except (TypeError, ValueError, json.JSONDecodeError):
        actual_input = None
    if actual_input != dict(expected_input):
        failures.append(
            {
                "code": "SCHEDULE_INPUT_MISMATCH",
                "message": f"{name} input does not match the exact canary provenance contract.",
            }
        )
    retry_policy = target.get("RetryPolicy") or {}
    if (
        integer_value(retry_policy.get("MaximumEventAgeInSeconds")) != 900
        or integer_value(retry_policy.get("MaximumRetryAttempts")) != 0
    ):
        failures.append(
            {
                "code": "SCHEDULE_RETRY_POLICY_MISMATCH",
                "message": f"{name} must use a 900-second event age and zero retries.",
            }
        )
    return {
        "passed": not failures,
        "name": name,
        "state": schedule.get("State"),
        "expression": schedule.get("ScheduleExpression"),
        "failures": failures,
    }

def verify_watchdog_rule(
    rule: Mapping[str, Any],
    *,
    expected_state: str,
) -> dict[str, Any]:
    expected_name = "market-dashboard-hermes-cloud-watchdog-v1"
    failures: list[dict[str, str]] = []
    if rule.get("Name") != expected_name:
        failures.append({
            "code": "WATCHDOG_RULE_NAME_MISMATCH",
            "message": f"Expected EventBridge rule {expected_name}.",
        })
    if rule.get("State") != expected_state:
        failures.append({
            "code": "WATCHDOG_RULE_STATE_MISMATCH",
            "message": (
                f"{expected_name} is {rule.get('State')}, expected {expected_state}."
            ),
        })
    if rule.get("ScheduleExpression") != "rate(5 minutes)":
        failures.append({
            "code": "WATCHDOG_RULE_CADENCE_MISMATCH",
            "message": "The watchdog EventBridge rule is not on its five-minute cadence.",
        })
    return {
        "passed": not failures,
        "name": expected_name,
        "state": rule.get("State"),
        "failures": failures,
    }


def verify_alarms(
    alarms: Sequence[Mapping[str, Any]],
    *,
    actions_enabled: bool,
    topic_arn: str,
    controls: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    by_name = {str(alarm.get("AlarmName")): alarm for alarm in alarms}
    failures: list[dict[str, str]] = []
    for name in ALARM_NAMES:
        alarm = by_name.get(name)
        if not alarm:
            failures.append(
                {"code": "ALARM_MISSING", "message": f"{name} does not exist."}
            )
            continue
        contract = ALARM_CONTRACTS[name]
        schedule_parameter = contract.get("scheduleParameter")
        alarm_actions_enabled = actions_enabled and (
            not schedule_parameter
            or controls is None
            or controls.get(str(schedule_parameter)) == "ENABLED"
        )
        if (
            alarm.get("Namespace") != contract["namespace"]
            or alarm.get("MetricName") != contract["metric"]
            or alarm.get("Statistic") != contract["statistic"]
            or alarm.get("ComparisonOperator") != contract["comparison"]
        ):
            failures.append(
                {
                    "code": "ALARM_METRIC_CONTRACT_MISMATCH",
                    "message": f"{name} metric/statistic/comparison drifted from its contract.",
                }
            )
        if (
            integer_value(alarm.get("Period")) != contract["period"]
            or integer_value(alarm.get("EvaluationPeriods")) != 1
            or numeric_value(alarm.get("Threshold")) != 1.0
        ):
            failures.append(
                {
                    "code": "ALARM_CADENCE_WINDOW_MISMATCH",
                    "message": f"{name} no longer evaluates its exact cadence window.",
                }
            )
        expected_missing_data = contract.get("missingData")
        if not expected_missing_data:
            expected_missing_data = contract[
                "missingDataWhenEnabled"
                if alarm_actions_enabled
                else "missingDataWhenDisabled"
            ]
        if alarm.get("TreatMissingData") != expected_missing_data:
            failures.append(
                {
                    "code": "ALARM_MISSING_DATA_POLICY_MISMATCH",
                    "message": (
                        f"{name} TreatMissingData={alarm.get('TreatMissingData')}; "
                        f"expected {expected_missing_data}."
                    ),
                }
            )
        service_id = contract.get("serviceId")
        if service_id:
            dimensions = {
                str(item.get("Name")): item.get("Value")
                for item in alarm.get("Dimensions") or []
            }
            if dimensions.get("ServiceId") != service_id:
                failures.append(
                    {
                        "code": "ALARM_SERVICE_DIMENSION_MISMATCH",
                        "message": f"{name} does not monitor {service_id}.",
                    }
                )
        expected_actions_enabled = (
            alarm_actions_enabled if contract.get("notify") else False
        )
        if alarm.get("ActionsEnabled") is not expected_actions_enabled:
            failures.append(
                {
                    "code": "ALARM_ACTION_STATE_MISMATCH",
                    "message": (
                        f"{name} ActionsEnabled={alarm.get('ActionsEnabled')}; "
                        f"expected {expected_actions_enabled}."
                    ),
                }
            )
        expected_alarm_actions = {topic_arn} if contract.get("notify") else set()
        if set(alarm.get("AlarmActions") or []) != expected_alarm_actions:
            failures.append(
                {
                    "code": "ALARM_ACTION_TARGET_MISMATCH",
                    "message": f"{name} alarm action does not match its notification policy.",
                }
            )
        if set(alarm.get("OKActions") or []) != set():
            failures.append(
                {
                    "code": "ALARM_OK_ACTION_TARGET_MISMATCH",
                    "message": f"{name} must not publish an OK recovery transition.",
                }
            )
    return {
        "passed": not failures,
        "actionsEnabled": actions_enabled,
        "observed": len(by_name),
        "expected": len(ALARM_NAMES),
        "failures": failures,
    }


def internal_only_operations_subscription(
    subscriptions: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    email_routes = [
        item
        for item in subscriptions
        if item.get("Protocol") in {"email", "email-json"}
    ]
    if email_routes:
        raise ActivationFailure(
            "SNS_OPERATIONAL_EMAIL_ROUTE_PRESENT",
            "The operations topic must not have email or email-json subscriptions.",
            detail={
                "emailSubscriptionCount": len(email_routes),
                "pendingEmailSubscriptionCount": sum(
                    1
                    for item in email_routes
                    if item.get("SubscriptionArn")
                    in {None, "", "PendingConfirmation"}
                ),
            },
        )
    protocols: dict[str, int] = {}
    for item in subscriptions:
        protocol = str(item.get("Protocol") or "unknown")
        protocols[protocol] = protocols.get(protocol, 0) + 1
    return {
        "passed": True,
        "emailSubscriptionCount": 0,
        "protocolCounts": protocols,
    }


def require_check(result: Mapping[str, Any], fallback_code: str) -> None:
    if result.get("passed"):
        return
    failures = result.get("failures") or []
    first = failures[0] if failures else {}
    raise ActivationFailure(
        str(first.get("code") or fallback_code),
        str(first.get("message") or "Verification failed."),
        detail={"failures": failures},
    )


def validate_artifact_bucket_ownership(
    response: Mapping[str, Any],
) -> dict[str, Any]:
    tags = {
        str(item.get("Key")): str(item.get("Value"))
        for item in response.get("TagSet") or []
    }
    expected = {
        "market-dashboard:owner": "market-dashboard-readiness-v2",
        "market-dashboard:purpose": "sam-artifacts",
    }
    if any(tags.get(key) != value for key, value in expected.items()):
        raise ActivationFailure(
            "ARTIFACT_BUCKET_OWNERSHIP_MISMATCH",
            "SAM artifact bucket ownership tags are missing or incompatible.",
        )
    return {"passed": True, "bucket": EXPECTED_ARTIFACT_BUCKET}


class AwsRuntime:
    """Narrow AWS adapter used by the activation controller."""

    def __init__(self, *, profile: str | None, region: str, session: Any | None = None) -> None:
        config = Config(
            connect_timeout=5,
            read_timeout=330,
            retries={"max_attempts": 2, "mode": "standard"},
        )
        self.session = session or boto3.Session(profile_name=profile or None, region_name=region)
        self.region = region
        self.sts = self.session.client("sts", config=config)
        self.cloudformation = self.session.client("cloudformation", config=config)
        self.secretsmanager = self.session.client("secretsmanager", config=config)
        self.lambda_client = self.session.client("lambda", config=config)
        self.dynamodb = self.session.client("dynamodb", config=config)
        self.scheduler = self.session.client("scheduler", config=config)
        self.events = self.session.client("events", config=config)
        self.cloudwatch = self.session.client("cloudwatch", config=config)
        self.sns = self.session.client("sns", config=config)
        self.s3 = self.session.client("s3", config=config)

    def identity(self) -> Mapping[str, Any]:
        return aws_call("STS", lambda: self.sts.get_caller_identity())

    def stack(self) -> Mapping[str, Any]:
        response = aws_call(
            "STACK",
            lambda: self.cloudformation.describe_stacks(StackName=STACK_NAME),
        )
        stacks = response.get("Stacks") or []
        if len(stacks) != 1:
            raise ActivationFailure(
                "STACK_NOT_FOUND",
                f"Expected exactly one {STACK_NAME} stack, found {len(stacks)}.",
            )
        return stacks[0]

    def stack_template(self) -> Mapping[str, Any]:
        return aws_call(
            "STACK_TEMPLATE",
            lambda: self.cloudformation.get_template(
                StackName=STACK_NAME,
                TemplateStage="Original",
            ),
        )

    def secret_description(self, name: str) -> Mapping[str, Any]:
        # Deliberately metadata-only. Never call GetSecretValue here.
        return aws_call(
            "GMAIL_OAUTH_SECRET",
            lambda: self.secretsmanager.describe_secret(SecretId=name),
        )

    def artifact_bucket_tags(self) -> Mapping[str, Any]:
        return aws_call(
            "SAM_ARTIFACT_BUCKET_TAGS",
            lambda: self.s3.get_bucket_tagging(
                Bucket=EXPECTED_ARTIFACT_BUCKET,
                ExpectedBucketOwner=EXPECTED_ACCOUNT,
            ),
        )

    def release_artifact(self, artifact: Mapping[str, str]) -> Mapping[str, Any]:
        return aws_call(
            "RELEASE_ARTIFACT",
            lambda: self.s3.get_object(
                Bucket=artifact["bucket"],
                Key=artifact["key"],
                VersionId=artifact["versionId"],
                ExpectedBucketOwner=EXPECTED_ACCOUNT,
            ),
        )

    def function_configuration(self, name: str) -> Mapping[str, Any]:
        return aws_call(
            "LAMBDA_CONFIGURATION",
            lambda: self.lambda_client.get_function_configuration(FunctionName=name),
        )

    def invoke(self, name: str, event: Mapping[str, Any]) -> Mapping[str, Any]:
        return aws_call(
            "LAMBDA_INVOKE",
            lambda: self.lambda_client.invoke(
                FunctionName=name,
                InvocationType="RequestResponse",
                Payload=json.dumps(dict(event), separators=(",", ":")).encode(),
            ),
        )

    def heartbeat_rows(
        self, table_name: str, service_id: str, *, limit: int
    ) -> list[dict[str, Any]]:
        response = aws_call(
            "HEARTBEAT_QUERY",
            lambda: self.dynamodb.query(
                TableName=table_name,
                KeyConditionExpression="serviceId = :service_id",
                ExpressionAttributeValues={":service_id": {"S": service_id}},
                ScanIndexForward=False,
                ConsistentRead=True,
                Limit=limit,
            ),
        )
        return [as_plain_item(item) for item in response.get("Items") or []]

    def latest_snapshot(
        self, table_name: str, host_id: str
    ) -> Mapping[str, Any] | None:
        response = aws_call(
            "HERMES_INPUT_QUERY",
            lambda: self.dynamodb.query(
                TableName=table_name,
                KeyConditionExpression="hostId = :host_id",
                ExpressionAttributeValues={":host_id": {"S": host_id}},
                ScanIndexForward=False,
                ConsistentRead=True,
                Limit=1,
            ),
        )
        items = response.get("Items") or []
        return as_plain_item(items[0]) if items else None

    def schedule(self, name: str) -> Mapping[str, Any]:
        return aws_call(
            "SCHEDULE",
            lambda: self.scheduler.get_schedule(GroupName="default", Name=name),
        )

    def disable_schedule(
        self,
        name: str,
        current: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        required = ("ScheduleExpression", "FlexibleTimeWindow", "Target")
        missing = [key for key in required if key not in current]
        if missing:
            raise ActivationFailure(
                "SCHEDULE_DISABLE_INPUT_INCOMPLETE",
                f"Cannot safely disable {name}; its current definition is incomplete.",
                detail={"schedule": name, "missing": missing},
            )
        request: dict[str, Any] = {
            "GroupName": "default",
            "Name": name,
            "State": "DISABLED",
        }
        for key in (
            "ActionAfterCompletion",
            "Description",
            "EndDate",
            "FlexibleTimeWindow",
            "KmsKeyArn",
            "ScheduleExpression",
            "ScheduleExpressionTimezone",
            "StartDate",
            "Target",
        ):
            if key in current:
                request[key] = current[key]
        return aws_call(
            "SCHEDULE_DISABLE",
            lambda: self.scheduler.update_schedule(**request),
        )

    def watchdog_rule(self) -> Mapping[str, Any]:
        return aws_call(
            "WATCHDOG_RULE",
            lambda: self.events.describe_rule(
                Name="market-dashboard-hermes-cloud-watchdog-v1",
            ),
        )

    def disable_watchdog_rule(self) -> Mapping[str, Any]:
        return aws_call(
            "WATCHDOG_RULE_DISABLE",
            lambda: self.events.disable_rule(
                Name="market-dashboard-hermes-cloud-watchdog-v1",
            ),
        )

    def alarms(self) -> Sequence[Mapping[str, Any]]:
        response = aws_call(
            "ALARMS",
            lambda: self.cloudwatch.describe_alarms(AlarmNames=list(ALARM_NAMES)),
        )
        return response.get("MetricAlarms") or []

    def disable_alarm_actions(self, alarm_names: Sequence[str]) -> Mapping[str, Any]:
        names = [name for name in alarm_names if name in ALARM_NAMES]
        if not names:
            return {}
        return aws_call(
            "ALARM_ACTIONS_DISABLE",
            lambda: self.cloudwatch.disable_alarm_actions(AlarmNames=names),
        )

    def subscriptions(self, topic_arn: str) -> Sequence[Mapping[str, Any]]:
        items: list[Mapping[str, Any]] = []
        token: str | None = None
        while True:
            kwargs = {"TopicArn": topic_arn}
            if token:
                kwargs["NextToken"] = token
            response = aws_call(
                "SNS_SUBSCRIPTIONS",
                lambda kwargs=kwargs: self.sns.list_subscriptions_by_topic(**kwargs),
            )
            items.extend(response.get("Subscriptions") or [])
            token = response.get("NextToken")
            if not token:
                return items


class ActivationController:
    def __init__(
        self,
        runtime: AwsRuntime,
        *,
        phase: str,
        apply: bool,
        admin_profile: str | None,
        cloudformation_role_arn: str | None,
        rollback_export: str | os.PathLike[str] | None = None,
        release_receipt: str | os.PathLike[str] | None = None,
        release_receipt_key: str | os.PathLike[str] | None = None,
        shadow_acceptance: str | os.PathLike[str] | None = None,
        auth_probe_only: bool = False,
    ) -> None:
        self.runtime = runtime
        self.phase = phase
        self.apply = apply
        self.admin_profile = admin_profile
        self.cloudformation_role_arn = cloudformation_role_arn
        self.rollback_export = rollback_export
        self.release_receipt = release_receipt
        self.release_receipt_key = release_receipt_key
        self.shadow_acceptance = shadow_acceptance
        self.auth_probe_only = auth_probe_only
        self.rollback_verification: dict[str, Any] | None = None
        self.release_verification: dict[str, Any] | None = None
        self.manifest, self.contract = manifest_contracts()
        self.resources = self.manifest["aws"]["resources"]
        self.services = {
            service["id"]: service for service in self.manifest.get("services") or []
        }
        self.stack: Mapping[str, Any] = {}
        self.parameters: dict[str, str] = {}
        self.outputs: dict[str, str] = {}

    def initialize(self) -> dict[str, Any]:
        identity = validate_identity(
            self.runtime.identity(),
            region=self.runtime.region,
            require_sso=self.apply,
        )
        self.stack = self.runtime.stack()
        validate_stack(self.stack)
        self.parameters = stack_parameters(self.stack)
        self.outputs = stack_outputs(self.stack)
        return identity

    def validate_apply_configuration(self) -> None:
        if not self.apply:
            return
        if not self.admin_profile:
            raise ActivationFailure(
                "ADMIN_PROFILE_REQUIRED",
                "--apply requires an explicit --admin-profile.",
            )
        if str(self.cloudformation_role_arn or "") != DEPLOYMENT_ROLE_ARN:
            raise ActivationFailure(
                "CLOUDFORMATION_ROLE_REQUIRED",
                f"--apply requires {DEPLOYMENT_ROLE_ARN}.",
            )
        artifact_bucket = os.environ.get("MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET")
        if artifact_bucket != EXPECTED_ARTIFACT_BUCKET:
            raise ActivationFailure(
                "SAM_ARTIFACT_BUCKET_REQUIRED",
                (
                    "--apply requires "
                    "MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET="
                    f"{EXPECTED_ARTIFACT_BUCKET}."
                ),
            )
        if getattr(self, "rollback_verification", None) is None:
            self.rollback_verification = verify_rollback_export(
                getattr(self, "rollback_export", None)
            )
        if getattr(self, "phase", None) == "consolidated":
            self.shadow_acceptance_verification = verify_analyst_shadow_acceptance(
                getattr(self, "shadow_acceptance", None)
            )
        if getattr(self, "phase", None) == "rollback":
            self.rollback_controls = exported_control_state(
                self.rollback_verification["path"]
            )
        validate_artifact_bucket_ownership(
            self.runtime.artifact_bucket_tags()
        )
        if getattr(self, "auth_probe_only", False):
            return
        if not shutil.which("sam"):
            raise ActivationFailure("SAM_CLI_REQUIRED", "AWS SAM CLI is not installed.")
        if getattr(self, "release_verification", None) is None:
            raw_receipt = getattr(self, "release_receipt", None)
            if not raw_receipt:
                raise ActivationFailure(
                    "TESTED_RELEASE_RECEIPT_REQUIRED",
                    (
                        "--apply requires --release-receipt or "
                        "MARKET_DASHBOARD_RELEASE_RECEIPT."
                    ),
                )
            current_build = str(self.parameters.get("BuildVersion") or "")
            try:
                release_commit = require_commit(current_build)
                verification_kwargs: dict[str, Any] = {
                    "expected_commit": release_commit,
                    "repo_root": REPO_ROOT,
                }
                receipt_key = getattr(self, "release_receipt_key", None)
                if receipt_key:
                    verification_kwargs["key_path"] = receipt_key
                self.release_verification = verify_release_receipt(
                    raw_receipt,
                    **verification_kwargs,
                )
            except ReleaseReceiptError as error:
                raise ActivationFailure(
                    "TESTED_RELEASE_RECEIPT_INVALID",
                    str(error),
                    detail={"receiptErrorCode": error.code},
                ) from error
        self.verify_deployed_tested_release()

    def verify_deployed_tested_release(self) -> dict[str, Any]:
        release = getattr(self, "release_verification", None)
        if not isinstance(release, Mapping):
            raise ActivationFailure(
                "TESTED_RELEASE_RECEIPT_REQUIRED",
                "No verified tested release is available for staged activation.",
            )
        expected_commit = str(release["releaseCommit"])
        actual_commit = str(self.parameters.get("BuildVersion") or "")
        if actual_commit != expected_commit:
            raise ActivationFailure(
                "STACK_BUILD_VERSION_MISMATCH",
                "CloudFormation BuildVersion does not match the tested release.",
                detail={"expected": expected_commit, "actual": actual_commit},
            )
        template_response = self.runtime.stack_template()
        template_body = template_response.get("TemplateBody")
        try:
            deployed_template_sha = canonical_template_sha256(template_body)
        except ReleaseReceiptError as error:
            raise ActivationFailure(
                "STACK_TEMPLATE_INVALID",
                str(error),
            ) from error
        if deployed_template_sha != release["templateCanonicalSha256"]:
            raise ActivationFailure(
                "STACK_TESTED_TEMPLATE_MISMATCH",
                "The deployed CloudFormation template is not the tested base template.",
                detail={
                    "expected": release["templateCanonicalSha256"],
                    "actual": deployed_template_sha,
                },
            )
        immutable_objects = [
            ("template", release.get("templateObject")),
            *[
                ("artifact", artifact)
                for artifact in release.get("artifacts") or []
            ],
        ]
        for object_kind, artifact in immutable_objects:
            if not isinstance(artifact, Mapping):
                raise ActivationFailure(
                    "TESTED_RELEASE_OBJECT_EVIDENCE_MISSING",
                    f"Tested release has no immutable {object_kind} evidence.",
                )
            response = self.runtime.release_artifact(artifact)
            if str(response.get("VersionId") or "") != artifact["versionId"]:
                raise ActivationFailure(
                    "TESTED_RELEASE_ARTIFACT_VERSION_MISMATCH",
                    "A tested SAM artifact version could not be verified in S3.",
                    detail={
                        "bucket": artifact["bucket"],
                        "key": artifact["key"],
                        "expectedVersionId": artifact["versionId"],
                        "actualVersionId": response.get("VersionId"),
                    },
                )
            body_stream = response.get("Body")
            body = body_stream.read() if hasattr(body_stream, "read") else body_stream
            if (
                not isinstance(body, bytes)
                or len(body) != int(artifact["contentLength"])
                or hashlib.sha256(body).hexdigest()
                != artifact["contentSha256"]
            ):
                raise ActivationFailure(
                    "TESTED_RELEASE_ARTIFACT_CHECKSUM_MISMATCH",
                    (
                        f"The immutable SAM {object_kind} no longer matches "
                        "the tested receipt."
                    ),
                    detail={
                        "bucket": artifact["bucket"],
                        "key": artifact["key"],
                        "versionId": artifact["versionId"],
                    },
                )
        return {
            "passed": True,
            "releaseCommit": expected_commit,
            "templateCanonicalSha256": deployed_template_sha,
            "artifactCount": len(release.get("artifacts") or []),
            "templateVersionId": release["templateObject"]["versionId"],
        }

    def gmail_contract(self) -> Mapping[str, Any]:
        return self.services["gmail.ingestion"]

    def cftc_contract(self) -> Mapping[str, Any]:
        return self.services["cftc.official-ingestion"]

    def cftc_heartbeat(self) -> dict[str, Any]:
        contract = self.cftc_contract()
        service_id = contract["aws"]["heartbeatServiceId"]
        rows = self.runtime.heartbeat_rows(
            self.resources["serviceHeartbeatTable"], service_id, limit=1
        )
        latest = rows[0] if rows else None
        latest_at = latest.get("observedAt") if latest else None
        age = minutes_old(latest_at)
        failures: list[dict[str, str]] = []
        if not latest:
            failures.append({
                "code": "HEARTBEAT_COUNT_INSUFFICIENT",
                "message": "No scheduled official CFTC heartbeat exists.",
            })
        elif (
            latest.get("status") != "success"
            or latest.get("scheduleId") != contract["aws"]["scheduleId"]
            or latest.get("scheduled") is not True
        ):
            failures.append({
                "code": "HEARTBEAT_PROVENANCE_INVALID",
                "message": "The latest CFTC heartbeat is not a successful Scheduler invocation.",
            })
        if age is None or age < -5 or age > int(contract["readinessMaxAgeMinutes"]):
            failures.append({
                "code": "HEARTBEAT_STALE",
                "message": "The latest scheduled CFTC heartbeat is outside its readiness window.",
            })
        return {
            "passed": not failures,
            "serviceId": service_id,
            "required": 1,
            "observed": len(rows),
            "latestAt": latest_at,
            "failures": failures,
            "warnings": [],
        }

    def gmail_heartbeat(
        self, *, observed_after: Any | None = None
    ) -> dict[str, Any]:
        service = self.gmail_contract()
        service_id = service["aws"]["heartbeatServiceId"]
        rows = self.runtime.heartbeat_rows(
            self.resources["serviceHeartbeatTable"], service_id, limit=4
        )
        rows = heartbeats_after_watermark(rows, observed_after)
        return heartbeat_window(
            rows,
            service_id=service_id,
            schedule_id=service["aws"]["scheduleId"],
            required=4,
            cadence_minutes=int(service["cadenceMinutes"]),
            allowed_statuses={"success"},
        )

    def worker_heartbeat(
        self, worker: str, *, observed_after: Any | None = None
    ) -> dict[str, Any]:
        worker_contract = self.contract["workers"][worker]
        service_id = worker_contract["serviceId"]
        required = WORKER_HEARTBEAT_REQUIRED[worker]
        rows = self.runtime.heartbeat_rows(
            self.resources["serviceHeartbeatTable"], service_id, limit=required
        )
        rows = heartbeats_after_watermark(rows, observed_after)
        # A warning is still a proven, scheduled monitoring invocation. The
        # Healthy alarm carries the underlying typed capability failure.
        return heartbeat_window(
            rows,
            service_id=service_id,
            schedule_id=worker_contract["scheduleId"],
            required=required,
            cadence_minutes=int(worker_contract["cadenceMinutes"]),
            allowed_statuses={"success", "warning"},
        )

    def cloud_watchdog_heartbeat(self) -> dict[str, Any]:
        service_id = "hermes:cloud-watchdog"
        rule_id = "market-dashboard-hermes-cloud-watchdog-v1"
        rows = self.runtime.heartbeat_rows(
            self.resources["serviceHeartbeatTable"], service_id, limit=1
        )
        return event_rule_heartbeat(
            rows,
            service_id=service_id,
            rule_id=rule_id,
        )

    def secret_check(self) -> dict[str, Any]:
        result = validate_secret_metadata(
            self.runtime.secret_description(self.parameters["GmailOAuthSecretName"])
        )
        return {key: value for key, value in result.items() if not key.startswith("_")}

    def function_check(self, kind: str) -> dict[str, Any]:
        resource_key = {
            "GMAIL": "gmailFunction",
            "CFTC": "cftcFunction",
            "HERMES": "hermesFunction",
        }[kind]
        function_name = self.resources[resource_key]
        return validate_function_configuration(
            self.runtime.function_configuration(function_name),
            expected_name=function_name,
            kind=kind,
        )

    def function_checks(self) -> list[dict[str, Any]]:
        return [
            self.function_check("GMAIL"),
            self.function_check("CFTC"),
            self.function_check("HERMES"),
        ]

    def bridge_check(self, worker: str = "quant-developer") -> dict[str, Any]:
        snapshot_type = "portfolio" if worker == "quant-analyst" else "operations"
        snapshot = self.runtime.latest_snapshot(
            self.resources["hermesInputSnapshotTable"],
            f"{self.parameters['BridgeHostId']}#{snapshot_type}",
        )
        return validate_bridge_snapshot(
            snapshot,
            expected_capabilities=set(self.contract["capabilityIds"]),
            snapshot_type=snapshot_type,
        )

    def canary_gmail(self) -> dict[str, Any]:
        response = self.runtime.invoke(
            self.resources["gmailFunction"],
            {
                "source": "activation-canary",
                "scheduleId": "market-dashboard-gmail-v2-activation-canary",
                "authProbeOnly": True,
                "forceAuthProbe": True,
            },
        )
        result = parse_lambda_result(
            response, kind="GMAIL", accepted_statuses={"SUCCESS"}
        )
        if result["errorCount"]:
            raise ActivationFailure(
                "GMAIL_CANARY_PARTIAL_ERROR",
                f"Gmail canary reported {result['errorCount']} processing error(s).",
            )
        return {"passed": True, **result}

    def canary_cftc(self) -> dict[str, Any]:
        fixture_expectations = {
            "2026-04-28": {
                "13874A": (-96215, 7946, 0.77, 0.15),
                "088691": (91574, -3924, -1.33, -0.92),
                "124603": (-2284, 706, 0.08, -0.14),
            },
            "2026-08-11": {
                "13874A": (25427, 32375, 2.42, 1.62),
            },
        }
        fixtures: list[dict[str, Any]] = []
        for report_date, expected_rows in fixture_expectations.items():
            response = self.runtime.invoke(
                self.resources["cftcFunction"],
                {
                    "source": "activation-canary",
                    "scheduleId": "market-dashboard-cftc-weekday-v1-activation-canary",
                    "targetReportDate": report_date,
                    "dryRun": True,
                    "write": False,
                },
            )
            parsed = parse_cftc_canary_result(response)
            rows = {
                str(row.get("cftcContractMarketCode") or ""): row
                for row in parsed["_snapshot"].get("data") or []
                if isinstance(row, Mapping)
            }
            for code, expected in expected_rows.items():
                row = rows.get(code) or {}
                actual = (
                    integer_value(row.get("latest")),
                    integer_value(row.get("wwChg")),
                    numeric_value(row.get("zScore1Y")),
                    numeric_value(row.get("zScore3Y")),
                )
                if actual != expected:
                    raise ActivationFailure(
                        "CFTC_PARITY_FIXTURE_MISMATCH",
                        f"Official CFTC parity fixture {report_date}/{code} did not match.",
                        detail={"reportDate": report_date, "contractCode": code},
                    )
            if parsed["contentComplete"] is not True:
                raise ActivationFailure(
                    "CFTC_PARITY_FIXTURE_INCOMPLETE",
                    f"Official CFTC parity fixture {report_date} is incomplete.",
                )
            fixtures.append({
                "reportDate": report_date,
                "passed": True,
                "sourceContentHash": parsed["sourceContentHash"],
            })

        current = parse_cftc_canary_result(self.runtime.invoke(
            self.resources["cftcFunction"],
            {
                "source": "activation-canary",
                "scheduleId": "market-dashboard-cftc-weekday-v1-activation-canary",
                "dryRun": True,
                "write": False,
            },
        ))
        return {
            "passed": True,
            "result": "dry-run",
            "reportDate": current["reportDate"],
            "metricsCount": current["metricsCount"],
            "contentComplete": current["contentComplete"],
            "sourceContentHash": current["sourceContentHash"],
            "parityFixtures": fixtures,
        }

    def write_current_cftc(self) -> dict[str, Any]:
        return parse_cftc_write_result(self.runtime.invoke(
            self.resources["cftcFunction"],
            {
                "source": "activation-rollout",
                "scheduleId": "market-dashboard-cftc-weekday-v1-activation-write",
                "write": True,
            },
        ))

    def canary_worker(self, worker: str) -> dict[str, Any]:
        contract = self.contract["workers"][worker]
        response = self.runtime.invoke(
            self.resources["hermesFunction"],
            {
                "source": "activation-canary",
                "scheduleId": f"{contract['scheduleId']}-activation-canary",
                "jobType": worker,
            },
        )
        result = parse_lambda_result(
            response,
            kind=f"HERMES_{worker.upper().replace('-', '_')}",
            accepted_statuses={"SUCCESS", "DEGRADED"},
        )
        return {"passed": True, "worker": worker, **result}

    def schedule_specifications(
        self, controls: Mapping[str, str]
    ) -> list[dict[str, Any]]:
        gmail = self.gmail_contract()
        cftc = self.cftc_contract()
        specifications = [
            {
                "name": gmail["aws"]["scheduleId"],
                "expected_state": controls["GmailScheduleState"],
                "expression": gmail["aws"]["scheduleExpression"],
                "target_function_name": self.resources["gmailFunction"],
                "expected_input": {
                    "source": "aws-scheduler",
                    "scheduleId": gmail["aws"]["scheduleId"],
                    "poll": "incremental",
                },
            },
            {
                "name": cftc["aws"]["scheduleId"],
                "expected_state": controls["CftcScheduleState"],
                "expression": cftc["aws"]["scheduleExpression"],
                "timezone_name": cftc["aws"]["scheduleTimeZone"],
                "target_function_name": self.resources["cftcFunction"],
                "expected_input": {
                    "source": "aws-scheduler",
                    "scheduleId": cftc["aws"]["scheduleId"],
                    "mode": "current",
                },
            },
        ]
        for worker, contract in self.contract["workers"].items():
            specifications.append(
                {
                    "name": contract["scheduleId"],
                    "expected_state": controls[WORKER_PARAMETER[worker]],
                    "expression": contract["scheduleExpression"],
                    "timezone_name": contract["scheduleTimeZone"],
                    "target_function_name": self.resources["hermesFunction"],
                    "expected_input": {
                        "source": "aws-scheduler",
                        "scheduleId": contract["scheduleId"],
                        "jobType": worker,
                    },
                }
            )
        return specifications

    def schedule_check(self, specification: Mapping[str, Any]) -> dict[str, Any]:
        return verify_schedule(
            self.runtime.schedule(str(specification["name"])),
            **dict(specification),
        )

    def schedule_checks(self, controls: Mapping[str, str]) -> list[dict[str, Any]]:
        return [
            self.schedule_check(specification)
            for specification in self.schedule_specifications(controls)
        ]

    def watchdog_rule_check(self, controls: Mapping[str, str]) -> dict[str, Any]:
        return verify_watchdog_rule(
            self.runtime.watchdog_rule(),
            expected_state=controls["CloudWatchdogScheduleState"],
        )

    def operations_topic_arn(self) -> str:
        topic_arn = self.outputs.get("OperationsTopicArn")
        expected_topic = (
            f"arn:aws:sns:{EXPECTED_REGION}:{EXPECTED_ACCOUNT}:market-dashboard-operations-v2"
        )
        if topic_arn != expected_topic:
            raise ActivationFailure(
                "OPERATIONS_TOPIC_MISMATCH",
                "Stack output does not identify the exact owned operations topic.",
            )
        return str(topic_arn)

    def alarm_check(self, controls: Mapping[str, str]) -> dict[str, Any]:
        topic_arn = self.operations_topic_arn()
        return verify_alarms(
            self.runtime.alarms(),
            actions_enabled=controls["OperationalAlarmsState"] == "ENABLED",
            topic_arn=topic_arn,
            controls=controls,
        )

    def subscription_check(self) -> dict[str, Any]:
        return internal_only_operations_subscription(
            self.runtime.subscriptions(self.operations_topic_arn())
        )

    def require_rollout_prerequisites(self) -> list[dict[str, Any]]:
        checks: list[dict[str, Any]] = []
        if self.phase == "disabled":
            # Emergency recovery is intentionally independent of OAuth,
            # Lambda, bridge, subscription, and heartbeat health. Its only
            # purpose is to force every runtime control off.
            return checks
        if self.phase == "consolidated":
            required_enabled = (
                "CloudWatchdogScheduleState",
                "GmailScheduleState",
            )
            disabled = [
                name
                for name in required_enabled
                if self.parameters.get(name) != "ENABLED"
            ]
            if disabled:
                raise ActivationFailure(
                    "CONSOLIDATED_PREREQUISITE_DISABLED",
                    (
                        "Consolidation requires Gmail ingestion and the cloud "
                        "watchdog to already be enabled."
                    ),
                    detail={"controls": disabled},
                )
            gmail_schedule = self.schedule_specifications(self.parameters)[0]
            gmail_schedule_check = self.schedule_check(gmail_schedule)
            require_check(
                gmail_schedule_check,
                "GMAIL_SCHEDULE_CANARY_FAILED",
            )
            checks.append(gmail_schedule_check)
            watchdog_rule = self.watchdog_rule_check(self.parameters)
            require_check(
                watchdog_rule,
                "CLOUD_WATCHDOG_RULE_UNHEALTHY",
            )
            checks.append(watchdog_rule)
            checks.append(self.secret_check())
            checks.append(self.function_check("GMAIL"))
            gmail = self.gmail_heartbeat()
            require_heartbeat(gmail, "GMAIL_SCHEDULE_CANARY_FAILED")
            checks.append(gmail)
            watchdog = self.cloud_watchdog_heartbeat()
            require_heartbeat(
                watchdog,
                "CLOUD_WATCHDOG_HEARTBEAT_UNHEALTHY",
            )
            checks.append(watchdog)
            checks.append(self.subscription_check())
            return checks
        if self.phase == "rollback":
            controls = getattr(self, "rollback_controls", None)
            if not isinstance(controls, Mapping):
                raise ActivationFailure(
                    "ROLLBACK_CONTROL_STATE_INVALID",
                    "Verified rollback controls were not loaded.",
                )
            if controls.get("GmailScheduleState") == "ENABLED":
                checks.append(self.secret_check())
                checks.append(self.function_check("GMAIL"))
            if controls.get("CftcScheduleState") == "ENABLED":
                checks.append(self.function_check("CFTC"))
            enabled_workers = [
                worker
                for worker, parameter in WORKER_PARAMETER.items()
                if controls.get(parameter) == "ENABLED"
            ]
            if enabled_workers:
                checks.append(self.function_check("HERMES"))
                if "quant-analyst" in enabled_workers:
                    checks.append(self.bridge_check("quant-analyst"))
                if any(worker != "quant-analyst" for worker in enabled_workers):
                    checks.append(self.bridge_check("quant-developer"))
            if controls.get("OperationalAlarmsState") == "ENABLED":
                checks.append(self.subscription_check())
            return checks
        if self.phase == "cftc":
            checks.append(self.function_check("CFTC"))
            if self.parameters["CftcScheduleState"] == "ENABLED":
                heartbeat = self.cftc_heartbeat()
                require_heartbeat(heartbeat, "CFTC_SCHEDULE_CANARY_FAILED")
                checks.append(heartbeat)
            if self.apply:
                checks.append(self.canary_cftc())
                if self.parameters["CftcScheduleState"] == "DISABLED":
                    checks.append(self.write_current_cftc())
            else:
                checks.append({
                    "passed": True,
                    "pendingApply": True,
                    "code": "CFTC_READ_ONLY_CANARY_WILL_RUN",
                    "message": (
                        "Apply mode will invoke one read-only official CFTC calculation "
                        "before enabling its schedule."
                    ),
                })
            return checks
        if self.phase == "gmail":
            if not getattr(self, "auth_probe_only", False):
                developer = self.worker_heartbeat("quant-developer")
                require_heartbeat(
                    developer,
                    "HERMES_QUANT_DEVELOPER_SCHEDULE_CANARY_FAILED",
                )
                checks.append(developer)
                checks.append(self.bridge_check("quant-developer"))
            checks.append(self.secret_check())
            checks.append(self.function_check("GMAIL"))
            if getattr(self, "auth_probe_only", False):
                checks.append(self.canary_gmail())
            elif self.parameters["GmailScheduleState"] == "ENABLED":
                if self.apply:
                    # An apply rerun is the post-cutover verification/recovery
                    # path. Defer the heartbeat read until after the exact
                    # control resources are re-read so any failure is covered
                    # by the all-disabled compensating deployment.
                    checks.append(
                        {
                            "passed": True,
                            "verificationDeferred": True,
                            "code": "GMAIL_HEARTBEAT_VERIFICATION_DEFERRED",
                            "message": (
                                "The exact four-heartbeat Scheduler gate will "
                                "run inside post-deploy compensation coverage."
                            ),
                        }
                    )
                else:
                    gmail = self.gmail_heartbeat()
                    require_heartbeat(
                        gmail,
                        "GMAIL_SCHEDULE_CANARY_FAILED",
                    )
                    checks.append(gmail)
            elif self.apply:
                checks.append(self.canary_gmail())
            else:
                checks.append(
                    {
                        "passed": True,
                        "pendingApply": True,
                        "code": "GMAIL_OAUTH_CANARY_WILL_RUN",
                        "message": (
                            "Apply mode will invoke one bounded OAuth/Gmail profile canary "
                            "before enabling the Gmail schedule."
                        ),
                    }
                )
            return checks

        if self.phase == "developer":
            checks.append(self.function_check("HERMES"))

        if self.phase in {"analyst", "security", "alarms", "full"}:
            checks.append(self.secret_check())
            checks.extend(self.function_checks())
            gmail = self.gmail_heartbeat()
            require_heartbeat(gmail, "GMAIL_SCHEDULE_CANARY_FAILED")
            checks.append(gmail)

        if self.phase in {"analyst", "developer", "security"}:
            worker = WORKER_PHASES[self.phase]
            for prior in PRIOR_WORKERS[worker]:
                result = self.worker_heartbeat(prior)
                require_heartbeat(
                    result,
                    f"HERMES_{prior.upper().replace('-', '_')}_SCHEDULE_CANARY_FAILED",
                )
                checks.append(result)
            checks.append(self.bridge_check(worker))
            if self.parameters[WORKER_PARAMETER[worker]] == "ENABLED":
                result = self.worker_heartbeat(worker)
                require_heartbeat(
                    result,
                    f"HERMES_{worker.upper().replace('-', '_')}_SCHEDULE_CANARY_FAILED",
                )
                checks.append(result)
            elif self.apply:
                checks.append(self.canary_worker(worker))
            else:
                checks.append(
                    {
                        "passed": True,
                        "pendingApply": True,
                        "worker": worker,
                        "code": "HERMES_RUNTIME_CANARY_WILL_RUN",
                        "message": (
                            f"Apply mode will invoke one {worker} runtime canary before "
                            "enabling its schedule."
                        ),
                    }
                )

        if self.phase in {"alarms", "full"}:
            for worker in self.contract["workers"]:
                result = self.worker_heartbeat(worker)
                require_heartbeat(
                    result,
                    f"HERMES_{worker.upper().replace('-', '_')}_SCHEDULE_CANARY_FAILED",
                )
                checks.append(result)
            checks.append(self.subscription_check())
        return checks

    def status(self) -> dict[str, Any]:
        controls = {
            name: self.parameters[name] for name in CONTROL_PARAMETERS
        }
        checks: list[dict[str, Any]] = []

        def capture(name: str, callback: Callable[[], Mapping[str, Any]]) -> None:
            try:
                checks.append({"name": name, **dict(callback())})
            except ActivationFailure as failure:
                checks.append({"name": name, "passed": False, "error": failure.as_dict()})

        capture("gmailOAuthSecretMetadata", self.secret_check)
        capture("gmailFunction", lambda: self.function_check("GMAIL"))
        capture("cftcFunction", lambda: self.function_check("CFTC"))
        capture("hermesFunction", lambda: self.function_check("HERMES"))
        for specification in self.schedule_specifications(controls):
            name = str(specification["name"])
            capture(
                f"schedule:{name}",
                lambda specification=specification: self.schedule_check(specification),
            )
        capture("event-rule:cloud-watchdog", lambda: self.watchdog_rule_check(controls))
        capture("alarms", lambda: self.alarm_check(controls))
        capture("operationsSubscription", self.subscription_check)
        if controls["GmailScheduleState"] == "ENABLED":
            capture("heartbeat:gmail", self.gmail_heartbeat)
        if controls["CftcScheduleState"] == "ENABLED":
            capture("heartbeat:cftc", self.cftc_heartbeat)
        for worker in self.contract["workers"]:
            if controls[WORKER_PARAMETER[worker]] == "ENABLED":
                capture(
                    f"heartbeat:{worker}",
                    lambda worker=worker: self.worker_heartbeat(worker),
                )
        return {
            "passed": all(check.get("passed") for check in checks),
            "mode": "read-only",
            "phase": "status",
            "stack": {
                "name": STACK_NAME,
                "status": self.stack.get("StackStatus"),
                "controls": controls,
            },
            "checks": checks,
        }

    def deploy(
        self, parameters: Mapping[str, str], *, build_version: str
    ) -> dict[str, Any]:
        self.validate_apply_configuration()
        release = getattr(self, "release_verification", None) or {}
        release_commit = str(release.get("releaseCommit") or "")
        if build_version != release_commit:
            raise ActivationFailure(
                "TESTED_RELEASE_COMMIT_MISMATCH",
                "Deployment BuildVersion must equal the verified tested-release commit.",
            )
        missing = [name for name in ALL_PARAMETER_NAMES if name not in parameters]
        if missing:
            raise ActivationFailure(
                "STACK_PARAMETER_MISSING",
                "Activation deployment omitted existing stack parameters.",
                detail={"parameters": missing},
            )
        changed_non_controls = {
            name: {
                "current": str(self.parameters.get(name) or ""),
                "requested": str(parameters.get(name) or ""),
            }
            for name in ALL_PARAMETER_NAMES
            if name not in CONTROL_PARAMETERS
            and str(parameters.get(name) or "")
            != str(self.parameters.get(name) or "")
        }
        if changed_non_controls:
            raise ActivationFailure(
                "ACTIVATION_NON_CONTROL_PARAMETER_CHANGE",
                "Staged activation may change control parameters only.",
                detail={"changes": changed_non_controls},
            )
        role_arn = str(self.cloudformation_role_arn or "")
        artifact_bucket = os.environ["MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET"]
        command = [
            "sam",
            "deploy",
            "--template-file",
            str(release["templatePath"]),
            "--stack-name",
            STACK_NAME,
            "--region",
            EXPECTED_REGION,
            "--profile",
            self.admin_profile,
            "--role-arn",
            role_arn,
            "--s3-bucket",
            artifact_bucket,
            "--capabilities",
            "CAPABILITY_IAM",
            "CAPABILITY_NAMED_IAM",
            "--no-confirm-changeset",
            "--no-fail-on-empty-changeset",
            "--parameter-overrides",
            *[f"{key}={value}" for key, value in parameters.items()],
            "--tags",
            "market-dashboard:owner=market-dashboard-readiness-v2",
            "market-dashboard:purpose=readiness-stack",
        ]
        subprocess_environment = {
            key: value
            for key, value in os.environ.items()
            if key
            not in {
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
            }
        }
        subprocess_environment.update(
            {
                "AWS_PROFILE": str(self.admin_profile),
                "AWS_DEFAULT_PROFILE": str(self.admin_profile),
                "AWS_REGION": EXPECTED_REGION,
                "AWS_DEFAULT_REGION": EXPECTED_REGION,
                "AWS_PAGER": "",
                "AWS_CLI_AUTO_PROMPT": "off",
                "AWS_EC2_METADATA_DISABLED": "true",
            }
        )
        completed = subprocess.run(
            command,
            cwd=Path(str(release["templatePath"])).parent,
            check=False,
            capture_output=True,
            text=True,
            env=subprocess_environment,
        )
        if completed.returncode:
            diagnostic = safe_text(
                (completed.stderr or completed.stdout or "command failed")[-1000:]
            )
            raise ActivationFailure(
                "SAM_DEPLOY_FAILED",
                f"SAM_DEPLOY exited {completed.returncode}: {diagnostic}",
            )
        return {
            "passed": True,
            "stack": STACK_NAME,
            "buildVersion": build_version,
            "testedReleaseReceipt": release["receiptPath"],
            "templateSha256": release["templateSha256"],
            "controls": {name: parameters[name] for name in CONTROL_PARAMETERS},
        }

    def verify_post_deploy_controls(
        self, expected_controls: Mapping[str, str]
    ) -> dict[str, Any]:
        """Re-read and verify all authoritative control resources."""

        self.stack = self.runtime.stack()
        validate_stack(self.stack)
        self.parameters = stack_parameters(self.stack)
        self.outputs = stack_outputs(self.stack)
        deployed_controls = {
            name: self.parameters[name] for name in CONTROL_PARAMETERS
        }
        if deployed_controls != dict(expected_controls):
            raise ActivationFailure(
                "STACK_CONTROL_STATE_MISMATCH",
                "CloudFormation completed but deployed controls differ from the request.",
                detail={
                    "expected": dict(expected_controls),
                    "actual": deployed_controls,
                },
            )
        release_check = self.verify_deployed_tested_release()

        schedule_checks = self.schedule_checks(expected_controls)
        for check in schedule_checks:
            require_check(check, "SCHEDULE_VERIFICATION_FAILED")
        watchdog_rule_check = self.watchdog_rule_check(expected_controls)
        require_check(watchdog_rule_check, "WATCHDOG_RULE_VERIFICATION_FAILED")
        alarm_check = self.alarm_check(expected_controls)
        require_check(alarm_check, "ALARM_VERIFICATION_FAILED")
        subscription_check = self.subscription_check()
        return {
            "passed": True,
            "controls": deployed_controls,
            "testedRelease": release_check,
            "schedules": schedule_checks,
            "watchdogRule": watchdog_rule_check,
            "alarms": alarm_check,
            "operationsSubscription": subscription_check,
        }

    def repair_all_controls_disabled(self) -> dict[str, Any]:
        """Best-effort repair of every exact owned control without enabling one."""

        disabled_controls = {
            name: "DISABLED" for name in CONTROL_PARAMETERS
        }
        repaired_schedules: list[str] = []
        failures: list[dict[str, Any]] = []

        def record_failure(
            resource_type: str,
            name: str,
            error: Exception,
        ) -> None:
            failure = (
                error
                if isinstance(error, ActivationFailure)
                else ActivationFailure(
                    "CONTROL_DISABLE_UNEXPECTED",
                    safe_text(error),
                )
            )
            failures.append(
                {
                    "resourceType": resource_type,
                    "name": name,
                    "error": failure.as_dict(),
                }
            )

        try:
            specifications = self.schedule_specifications(disabled_controls)
        except Exception as error:
            record_failure("schedule-catalog", "owned-schedules", error)
            specifications = []

        for specification in specifications:
            name = str(specification["name"])
            try:
                current = self.runtime.schedule(name)
                if str(current.get("State") or "").upper() != "DISABLED":
                    self.runtime.disable_schedule(name, current)
                    repaired_schedules.append(name)
            except Exception as error:
                record_failure("schedule", name, error)

        watchdog_repaired = False
        try:
            watchdog = self.runtime.watchdog_rule()
            watchdog_needs_disable = (
                str(watchdog.get("State") or "").upper() != "DISABLED"
            )
        except Exception:
            # DisableRule is itself idempotent, exact-name, and safer than
            # leaving the rule potentially enabled after a failed read.
            watchdog_needs_disable = True
        if watchdog_needs_disable:
            try:
                self.runtime.disable_watchdog_rule()
                watchdog_repaired = True
            except Exception as error:
                record_failure(
                    "event-rule",
                    "market-dashboard-hermes-cloud-watchdog-v1",
                    error,
                )

        try:
            alarm_names = [
                str(alarm.get("AlarmName") or "")
                for alarm in self.runtime.alarms()
                if alarm.get("ActionsEnabled") is True
                and str(alarm.get("AlarmName") or "") in ALARM_NAMES
            ]
        except Exception:
            # DisableAlarmActions is idempotent. If the read failed, attempt
            # every exact allowlisted alarm independently and let the final
            # authoritative verification decide the outcome.
            alarm_names = list(ALARM_NAMES)
        disabled_alarm_names: list[str] = []
        for alarm_name in alarm_names:
            try:
                self.runtime.disable_alarm_actions([alarm_name])
                disabled_alarm_names.append(alarm_name)
            except Exception as error:
                record_failure("alarm", alarm_name, error)

        return {
            "passed": not failures,
            "performed": bool(
                repaired_schedules
                or watchdog_repaired
                or disabled_alarm_names
            ),
            "schedulesDisabled": repaired_schedules,
            "watchdogRuleDisabled": watchdog_repaired,
            "alarmActionsDisabled": disabled_alarm_names,
            "failures": failures,
        }

    def compensate_all_controls_disabled(
        self,
        *,
        parameter_source: Mapping[str, str],
        build_version: str,
    ) -> dict[str, Any]:
        """Deploy and authoritatively verify the fail-closed control state."""

        disabled_controls = {
            name: "DISABLED" for name in CONTROL_PARAMETERS
        }
        result: dict[str, Any] = {
            "attempted": True,
            "succeeded": False,
            "deploymentSucceeded": False,
            "verificationSucceeded": False,
            "targetControls": disabled_controls,
        }
        deployment_failure: ActivationFailure | None = None
        try:
            parameters = deployment_parameters(
                parameter_source,
                disabled_controls,
                build_version=build_version,
            )
            result["deployment"] = self.deploy(
                parameters,
                build_version=build_version,
            )
            result["deploymentSucceeded"] = True
        except Exception as error:
            deployment_failure = (
                error
                if isinstance(error, ActivationFailure)
                else ActivationFailure(
                    "COMPENSATING_DEPLOY_UNEXPECTED",
                    safe_text(error),
                )
            )
            result["deploymentFailure"] = deployment_failure.as_dict()

        try:
            result["driftRepair"] = self.repair_all_controls_disabled()
        except Exception as error:
            repair_failure = (
                error
                if isinstance(error, ActivationFailure)
                else ActivationFailure(
                    "COMPENSATING_REPAIR_UNEXPECTED",
                    safe_text(error),
                )
            )
            result["driftRepair"] = {
                "passed": False,
                "performed": False,
                "failures": [
                    {
                        "resourceType": "control-repair",
                        "name": "owned-controls",
                        "error": repair_failure.as_dict(),
                    }
                ],
            }

        try:
            result["verification"] = self.verify_post_deploy_controls(
                disabled_controls
            )
            result["verificationSucceeded"] = True
            result["succeeded"] = True
        except Exception as error:
            verification_failure = (
                error
                if isinstance(error, ActivationFailure)
                else ActivationFailure(
                    "COMPENSATING_VERIFY_UNEXPECTED",
                    safe_text(error),
                )
            )
            result["verificationFailure"] = verification_failure.as_dict()
            result["failure"] = (
                deployment_failure or verification_failure
            ).as_dict()
        if not result["succeeded"] and "failure" not in result:
            result["failure"] = (
                deployment_failure
                or ActivationFailure(
                    "COMPENSATING_RECOVERY_UNVERIFIED",
                    "The compensating recovery was not authoritatively verified.",
                )
            ).as_dict()
        return result

    def run_rollout(self) -> dict[str, Any]:
        self.validate_apply_configuration()
        checks = self.require_rollout_prerequisites()
        previous_controls = {
            name: self.parameters[name] for name in CONTROL_PARAMETERS
        }
        if getattr(self, "auth_probe_only", False):
            return {
                "passed": True,
                "mode": "auth-probe-only",
                "phase": self.phase,
                "currentControls": previous_controls,
                "targetControls": previous_controls,
                "preflight": checks,
                "rollbackExport": getattr(
                    self, "rollback_verification", None
                ),
                "mutation": {
                    "performed": False,
                    "code": "AUTH_PROBE_ONLY",
                    "message": (
                        "The bounded Gmail OAuth/profile canary passed; no "
                        "schedule, alarm, or stack control was changed."
                    ),
                },
            }
        controls = (
            dict(self.rollback_controls)
            if self.phase == "rollback"
            else target_control_state(self.phase, self.parameters)
        )
        report: dict[str, Any] = {
            "passed": True,
            "mode": "apply" if self.apply else "dry-run",
            "phase": self.phase,
            "currentControls": previous_controls,
            "targetControls": controls,
            "preflight": checks,
        }
        if self.apply:
            report["rollbackExport"] = getattr(
                self, "rollback_verification", None
            )
            if self.phase == "consolidated":
                report["shadowAcceptance"] = getattr(
                    self, "shadow_acceptance_verification", None
                )
            if self.phase == "rollback":
                report["rollbackControlsSource"] = self.rollback_verification["path"]
        if not self.apply:
            report["mutation"] = {
                "performed": False,
                "code": "DRY_RUN_ONLY",
                "message": "Rerun with --apply and --admin-profile to mutate AWS.",
            }
            return report

        release = getattr(self, "release_verification", None)
        if not isinstance(release, Mapping):
            raise ActivationFailure(
                "TESTED_RELEASE_RECEIPT_REQUIRED",
                "Staged activation has no verified tested release.",
            )
        build_version = str(release["releaseCommit"])
        report["testedRelease"] = {
            "releaseCommit": build_version,
            "receiptPath": release["receiptPath"],
            "templateSha256": release["templateSha256"],
            "artifactCount": len(release.get("artifacts") or []),
        }
        compensation_parameter_source = dict(self.parameters)
        parameters = deployment_parameters(
            self.parameters, controls, build_version=build_version
        )
        transitioned = {
            name
            for name in CONTROL_PARAMETERS
            if previous_controls.get(name) != controls.get(name)
        }
        pre_enable_watermark = datetime.now(timezone.utc)
        heartbeat_watermarks = {
            name: pre_enable_watermark
            for name in transitioned
            if controls.get(name) == "ENABLED"
            and (
                name == "GmailScheduleState"
                or name == "CftcScheduleState"
                or name in WORKER_PARAMETER.values()
            )
        }
        initial_deployment_succeeded = False
        try:
            report["deployment"] = self.deploy(
                parameters,
                build_version=build_version,
            )
            initial_deployment_succeeded = True
            if all(value == "DISABLED" for value in controls.values()):
                report["driftRepair"] = self.repair_all_controls_disabled()
            # SAM waits for the stack update. Re-read every authoritative
            # resource instead of trusting the requested parameter values.
            control_verification = self.verify_post_deploy_controls(controls)

            heartbeat_checks: list[dict[str, Any]] = []
            if controls["GmailScheduleState"] == "ENABLED":
                newly_enabled = "GmailScheduleState" in heartbeat_watermarks
                gmail_result = (
                    self.gmail_heartbeat(
                        observed_after=heartbeat_watermarks[
                            "GmailScheduleState"
                        ]
                    )
                    if newly_enabled
                    else self.gmail_heartbeat()
                )
                if not gmail_result["passed"]:
                    if not (
                        newly_enabled
                        and heartbeat_observation_pending(gmail_result)
                    ):
                        require_heartbeat(
                            gmail_result,
                            "GMAIL_SCHEDULE_CANARY_FAILED",
                        )
                    gmail_result = {
                        **gmail_result,
                        "pending": True,
                        "code": "GMAIL_SCHEDULE_OBSERVATION_PENDING",
                    }
                heartbeat_checks.append(gmail_result)

            if controls["CftcScheduleState"] == "ENABLED":
                newly_enabled = "CftcScheduleState" in heartbeat_watermarks
                if newly_enabled:
                    cftc_result = {
                        "passed": False,
                        "pending": True,
                        "code": "CFTC_SCHEDULE_OBSERVATION_PENDING",
                        "serviceId": "cftc:official-positioning",
                        "message": (
                            "The official CFTC schedule is enabled; its first weekday "
                            "4:15 PM Eastern heartbeat is pending."
                        ),
                    }
                else:
                    cftc_result = self.cftc_heartbeat()
                    require_heartbeat(cftc_result, "CFTC_SCHEDULE_CANARY_FAILED")
                heartbeat_checks.append(cftc_result)

            if self.phase == "consolidated":
                watchdog_result = self.cloud_watchdog_heartbeat()
                require_heartbeat(
                    watchdog_result,
                    "CLOUD_WATCHDOG_HEARTBEAT_UNHEALTHY",
                )
                heartbeat_checks.append(watchdog_result)

            for worker in self.contract["workers"]:
                parameter_name = WORKER_PARAMETER[worker]
                if controls[parameter_name] != "ENABLED":
                    continue
                newly_enabled = parameter_name in heartbeat_watermarks
                result = (
                    self.worker_heartbeat(
                        worker,
                        observed_after=heartbeat_watermarks[parameter_name],
                    )
                    if newly_enabled
                    else self.worker_heartbeat(worker)
                )
                if not result["passed"]:
                    if not (
                        newly_enabled and heartbeat_observation_pending(result)
                    ):
                        require_heartbeat(
                            result,
                            (
                                f"HERMES_{worker.upper().replace('-', '_')}"
                                "_SCHEDULE_CANARY_FAILED"
                            ),
                        )
                    result = {
                        **result,
                        "pending": True,
                        "code": "HERMES_SCHEDULE_OBSERVATION_PENDING",
                    }
                heartbeat_checks.append(result)

            heartbeat_windows_passed = all(
                result.get("passed") for result in heartbeat_checks
            )
            report["verification"] = {
                **control_verification,
                "heartbeats": heartbeat_checks,
                "heartbeatWindowsPassed": heartbeat_windows_passed,
                "heartbeatObservationPending": not heartbeat_windows_passed,
                "note": (
                    (
                        "A newly enabled schedule must accumulate its required 24/7 "
                        "heartbeat window before the next rollout phase."
                    )
                    if heartbeat_checks
                    else (
                        "All controls are disabled; heartbeat verification is "
                        "intentionally not applicable."
                    )
                ),
            }
        except Exception as error:
            rollout_failure = (
                error
                if isinstance(error, ActivationFailure)
                else ActivationFailure(
                    (
                        "POST_DEPLOY_VERIFICATION_UNEXPECTED"
                        if initial_deployment_succeeded
                        else "ROLLOUT_DEPLOYMENT_UNEXPECTED"
                    ),
                    safe_text(error),
                )
            )
            if self.phase == "disabled":
                # The recovery phase already targets the fail-closed state.
                # Never recursively invoke itself. Always attempt every direct
                # disable even if SAM failed or only partially applied, then
                # make a separate authoritative verification attempt.
                if "driftRepair" not in report:
                    try:
                        report["driftRepair"] = (
                            self.repair_all_controls_disabled()
                        )
                    except Exception as repair_error:
                        repair_failure = (
                            repair_error
                            if isinstance(repair_error, ActivationFailure)
                            else ActivationFailure(
                                "DISABLED_REPAIR_UNEXPECTED",
                                safe_text(repair_error),
                            )
                        )
                        report["driftRepair"] = {
                            "passed": False,
                            "performed": False,
                            "failures": [
                                {
                                    "resourceType": "control-repair",
                                    "name": "owned-controls",
                                    "error": repair_failure.as_dict(),
                                }
                            ],
                        }
                disabled_verification: dict[str, Any]
                try:
                    disabled_verification = (
                        self.verify_post_deploy_controls(controls)
                    )
                    controls_verified_disabled = True
                except Exception as verification_error:
                    verification_failure = (
                        verification_error
                        if isinstance(verification_error, ActivationFailure)
                        else ActivationFailure(
                            "DISABLED_VERIFY_UNEXPECTED",
                            safe_text(verification_error),
                        )
                    )
                    disabled_verification = {
                        "passed": False,
                        "error": verification_failure.as_dict(),
                    }
                    controls_verified_disabled = False
                raise ActivationFailure(
                    rollout_failure.code,
                    rollout_failure.message,
                    detail={
                        "failure": rollout_failure.as_dict(),
                        "driftRepair": report["driftRepair"],
                        "controlsVerifiedDisabled": (
                            controls_verified_disabled
                        ),
                        "verification": disabled_verification,
                    },
                ) from None
            compensation = self.compensate_all_controls_disabled(
                parameter_source=compensation_parameter_source,
                build_version=build_version,
            )
            if compensation["succeeded"]:
                outcome = (
                    "A compensating deployment was verified with every control "
                    "DISABLED."
                )
            else:
                outcome = (
                    "The compensating deployment could not be verified; treat "
                    "all controls as potentially enabled until manually checked."
                )
            wrapper_code = (
                "POST_DEPLOY_VERIFICATION_FAILED"
                if initial_deployment_succeeded
                else "ROLLOUT_DEPLOYMENT_FAILED"
            )
            initial_deployment = report.get("deployment")
            detail: dict[str, Any] = {
                "initialDeploymentSucceeded": initial_deployment_succeeded,
                (
                    "verificationFailure"
                    if initial_deployment_succeeded
                    else "deploymentFailure"
                ): rollout_failure.as_dict(),
                "compensation": compensation,
            }
            if initial_deployment is not None:
                detail["initialDeployment"] = initial_deployment
            raise ActivationFailure(
                wrapper_code,
                f"{rollout_failure.message} {outcome}",
                detail=detail,
            ) from None
        return report


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Inspect or stage production ingestion, legacy worker schedules, and operational alarms. "
            "No AWS mutation occurs without --apply."
        )
    )
    parser.add_argument(
        "--phase",
        choices=(
            "status",
            "disabled",
            "cftc",
            "developer",
            "gmail",
            "security",
            "analyst",
            "consolidated",
            "rollback",
            "alarms",
            "full",
        ),
        default="status",
        help=(
            "Rollout gate to inspect/apply; cftc independently enables the "
            "official weekday feed after a read-only calculation canary; consolidated retains Gmail, the "
            "cloud watchdog, and alarms while retiring all worker schedules; "
            "disabled is the apply-only all-controls-off recovery phase "
            "(default: status)."
        ),
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Run the bounded canary/deployment for the selected phase.",
    )
    parser.add_argument(
        "--admin-profile",
        help="Explicit AWS administrator/operator profile; required with --apply.",
    )
    parser.add_argument(
        "--read-profile",
        default=DEFAULT_READ_PROFILE,
        help=f"AWS profile for read-only status/dry-run inspection (must be {DEFAULT_READ_PROFILE}).",
    )
    parser.add_argument(
        "--cloudformation-role-arn",
        default=os.environ.get("MARKET_DASHBOARD_CF_ROLE_ARN"),
        help="Exact-account CloudFormation execution role; required with --apply.",
    )
    parser.add_argument(
        "--rollback-export",
        default=os.environ.get("MARKET_DASHBOARD_ROLLBACK_EXPORT"),
        help=(
            "Absolute verified predeployment rollback export; required with "
            "--apply."
        ),
    )
    parser.add_argument(
        "--release-receipt",
        default=os.environ.get("MARKET_DASHBOARD_RELEASE_RECEIPT"),
        help=(
            "Absolute mode-0600 tested-release receipt used by base deployment; "
            "required for every stack-changing apply phase."
        ),
    )
    parser.add_argument(
        "--release-receipt-key",
        default=os.environ.get(
            "MARKET_DASHBOARD_RELEASE_RECEIPT_KEY",
            str(DEFAULT_RELEASE_RECEIPT_KEY),
        ),
        help="Private HMAC key used to authenticate the tested-release receipt.",
    )
    parser.add_argument(
        "--shadow-acceptance",
        default=os.environ.get(
            "MARKET_DASHBOARD_ANALYST_SHADOW_ACCEPTANCE",
            str(DEFAULT_ANALYST_SHADOW_ACCEPTANCE),
        ),
        help=(
            "Completed Analyst shadow acceptance log; mandatory for the "
            "consolidated apply phase."
        ),
    )
    parser.add_argument(
        "--auth-probe-only",
        action="store_true",
        help=(
            "For --phase gmail --apply, run only the bounded OAuth/profile "
            "canary and do not deploy or change controls."
        ),
    )
    parser.add_argument("--region", default=EXPECTED_REGION)
    args = parser.parse_args(argv)
    if args.apply and args.phase == "status":
        parser.error("--apply requires an explicit rollout --phase.")
    if args.phase == "disabled" and not args.apply:
        parser.error("--phase disabled is an apply-only recovery command.")
    if args.phase == "rollback" and not args.apply:
        parser.error("--phase rollback is an apply-only recovery command.")
    if args.apply and args.admin_profile != EXPECTED_ADMIN_PROFILE:
        parser.error(f"--apply requires --admin-profile {EXPECTED_ADMIN_PROFILE}.")
    if not args.apply and args.admin_profile:
        parser.error("--admin-profile is only valid with --apply.")
    if not args.apply and args.read_profile != DEFAULT_READ_PROFILE:
        parser.error(f"--read-profile must be {DEFAULT_READ_PROFILE}.")
    if args.apply and not args.rollback_export:
        parser.error(
            "--apply requires --rollback-export or "
            "MARKET_DASHBOARD_ROLLBACK_EXPORT."
        )
    if args.auth_probe_only and (not args.apply or args.phase != "gmail"):
        parser.error("--auth-probe-only requires --phase gmail --apply.")
    if args.apply and not args.auth_probe_only and not args.release_receipt:
        parser.error(
            "--apply requires --release-receipt or "
            "MARKET_DASHBOARD_RELEASE_RECEIPT."
        )
    if args.region != EXPECTED_REGION:
        parser.error(f"this stack is pinned to --region {EXPECTED_REGION}.")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        profile = args.admin_profile if args.apply else (args.read_profile or DEFAULT_READ_PROFILE)
        try:
            session = verified_session(
                profile,
                purpose="admin" if args.apply else "api",
                region=args.region,
            )
        except AwsProfileContractError as error:
            raise ActivationFailure(error.error_code, error.detail) from None
        runtime = AwsRuntime(profile=profile, region=args.region, session=session)
        controller = ActivationController(
            runtime,
            phase=args.phase,
            apply=args.apply,
            admin_profile=args.admin_profile,
            cloudformation_role_arn=args.cloudformation_role_arn,
            rollback_export=args.rollback_export,
            release_receipt=args.release_receipt,
            release_receipt_key=args.release_receipt_key,
            shadow_acceptance=args.shadow_acceptance,
            auth_probe_only=args.auth_probe_only,
        )
        identity = controller.initialize()
        report = (
            controller.status()
            if args.phase == "status"
            else controller.run_rollout()
        )
        report["identity"] = identity
        print(json.dumps(report, indent=2, default=json_default))
        return 0 if report.get("passed") else 2
    except ActivationFailure as failure:
        print(
            json.dumps(
                {"passed": False, "error": failure.as_dict()},
                indent=2,
                default=json_default,
            ),
            file=sys.stderr,
        )
        return 2
    except (ProfileNotFound, NoCredentialsError, BotoCoreError) as error:
        failure = normalize_aws_error("AWS", error)
        print(
            json.dumps({"passed": False, "error": failure.as_dict()}, indent=2),
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    sys.exit(main())
