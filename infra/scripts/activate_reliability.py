#!/usr/bin/env python3
"""Safely stage and verify the Gmail/Hermes production reliability runtime.

Read-only inspection is the default. Mutating operations require both
``--apply`` and an explicit ``--admin-profile``. The rollout is intentionally
staged because a newly enabled Scheduler job must prove its own cadence before
the next stage (and, finally, alarm actions) can be enabled.

This command never reads an OAuth secret value, creates credentials, or writes
AWS configuration. The only direct runtime mutation before a schedule is
enabled is an explicit Lambda canary invocation in ``--apply`` mode.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
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


REPO_ROOT = Path(__file__).resolve().parents[2]
INFRA_DIR = REPO_ROOT / "infra"
MANIFEST_PATH = REPO_ROOT / "ops" / "services.json"
CONTRACT_PATH = INFRA_DIR / "lambdas" / "hermes_worker" / "service_contract.json"

EXPECTED_ACCOUNT = "915328198276"
EXPECTED_REGION = "us-west-1"
STACK_NAME = "market-dashboard-readiness-v2"
DEPLOYMENT_ROLE_ARN = (
    "arn:aws:iam::915328198276:role/"
    "market-dashboard-cloudformation-deployment-v2"
)
CONTROL_PARAMETERS = (
    "GmailScheduleState",
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
    "BuildVersion",
)
PHASE_ENABLES = {
    "gmail": ("GmailScheduleState",),
    "analyst": ("GmailScheduleState", "QuantAnalystScheduleState"),
    "developer": (
        "GmailScheduleState",
        "QuantAnalystScheduleState",
        "QuantDeveloperScheduleState",
    ),
    "security": (
        "GmailScheduleState",
        "QuantAnalystScheduleState",
        "QuantDeveloperScheduleState",
        "SecurityScheduleState",
    ),
    "alarms": CONTROL_PARAMETERS,
    "full": CONTROL_PARAMETERS,
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
PRIOR_WORKERS = {
    "quant-analyst": (),
    "quant-developer": ("quant-analyst",),
    "security": ("quant-analyst", "quant-developer"),
}
ALARM_NAMES = (
    "market-dashboard-runtime-failure-queue-v2",
    "market-dashboard-gmail-heartbeat-missing-v2",
    "market-dashboard-gmail-unhealthy-v2",
    "market-dashboard-hermes-analyst-heartbeat-missing-v2",
    "market-dashboard-hermes-analyst-unhealthy-v2",
    "market-dashboard-hermes-developer-heartbeat-missing-v2",
    "market-dashboard-hermes-developer-unhealthy-v2",
    "market-dashboard-hermes-security-heartbeat-missing-v2",
    "market-dashboard-hermes-security-unhealthy-v2",
)
ALARM_CONTRACTS = {
    "market-dashboard-runtime-failure-queue-v2": {
        "namespace": "AWS/SQS",
        "metric": "ApproximateNumberOfMessagesVisible",
        "statistic": "Maximum",
        "period": 300,
        "comparison": "GreaterThanOrEqualToThreshold",
        "missingData": "notBreaching",
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
    },
    "market-dashboard-gmail-unhealthy-v2": {
        "namespace": "MarketDashboard/Readiness",
        "metric": "Healthy",
        "statistic": "Minimum",
        "period": 900,
        "comparison": "LessThanThreshold",
        "serviceId": "gmail:timsmithaviation@gmail.com",
        "missingData": "notBreaching",
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
    },
    "market-dashboard-hermes-analyst-unhealthy-v2": {
        "namespace": "MarketDashboard/Readiness",
        "metric": "Healthy",
        "statistic": "Minimum",
        "period": 900,
        "comparison": "LessThanThreshold",
        "serviceId": "hermes:quant-analyst",
        "missingData": "notBreaching",
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
    },
    "market-dashboard-hermes-developer-unhealthy-v2": {
        "namespace": "MarketDashboard/Readiness",
        "metric": "Healthy",
        "statistic": "Minimum",
        "period": 900,
        "comparison": "LessThanThreshold",
        "serviceId": "hermes:quant-developer",
        "missingData": "notBreaching",
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
    },
    "market-dashboard-hermes-security-unhealthy-v2": {
        "namespace": "MarketDashboard/Readiness",
        "metric": "Healthy",
        "statistic": "Minimum",
        "period": 3600,
        "comparison": "LessThanThreshold",
        "serviceId": "hermes:security",
        "missingData": "notBreaching",
    },
}

DESERIALIZER = TypeDeserializer()
REDACTION_PATTERN = re.compile(
    r"(?i)(client_secret|refresh_token|access_token|authorization|password)"
    r"([\"'\s:=]+)([^,}\s]+)"
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


def validate_identity(identity: Mapping[str, Any], *, region: str) -> dict[str, str]:
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
        # Rollout is monotonic: no activation phase silently disables a
        # schedule or alarm action that is already on.
        target[name] = "ENABLED" if current == "ENABLED" or name in enables else "DISABLED"
    return target


def deployment_parameters(
    current_parameters: Mapping[str, str],
    controls: Mapping[str, str],
    *,
    build_version: str,
) -> dict[str, str]:
    missing = [name for name in ALL_PARAMETER_NAMES if name not in current_parameters]
    if missing:
        raise ActivationFailure(
            "STACK_PARAMETER_MISSING",
            "Cannot safely preserve every deployed parameter.",
            detail={"parameters": missing},
        )
    result = {name: str(current_parameters[name]) for name in ALL_PARAMETER_NAMES}
    result.update({name: str(value) for name, value in controls.items()})
    result["BuildVersion"] = build_version
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
        counts = row.get("counts") or {}
        if service_id.startswith("gmail:") and (
            integer_value(counts.get("errors")) != 0
            or integer_value(counts.get("dropped")) != 0
        ):
            failures.append(
                {
                    "code": "GMAIL_HEARTBEAT_DATA_ERROR",
                    "message": (
                        f"{observed}: errors={counts.get('errors', 0)}, "
                        f"dropped={counts.get('dropped', 0)}."
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


def validate_bridge_snapshot(
    snapshot: Mapping[str, Any] | None,
    *,
    expected_capabilities: set[str],
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
    capabilities = snapshot.get("capabilities")
    if not isinstance(capabilities, Mapping) or set(capabilities) != expected_capabilities:
        raise ActivationFailure(
            "SYSTEM_READINESS_CAPABILITY_CONTRACT_INVALID",
            "The bridge snapshot does not contain the exact readiness capability set.",
        )
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
    return {
        "passed": not failures,
        "name": name,
        "state": schedule.get("State"),
        "expression": schedule.get("ScheduleExpression"),
        "failures": failures,
    }


def verify_alarms(
    alarms: Sequence[Mapping[str, Any]],
    *,
    actions_enabled: bool,
    topic_arn: str,
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
                if actions_enabled
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
        if alarm.get("ActionsEnabled") is not actions_enabled:
            failures.append(
                {
                    "code": "ALARM_ACTION_STATE_MISMATCH",
                    "message": (
                        f"{name} ActionsEnabled={alarm.get('ActionsEnabled')}; "
                        f"expected {actions_enabled}."
                    ),
                }
            )
        if set(alarm.get("AlarmActions") or []) != {topic_arn}:
            failures.append(
                {
                    "code": "ALARM_ACTION_TARGET_MISMATCH",
                    "message": f"{name} alarm action is not the exact operations topic.",
                }
            )
        if set(alarm.get("OKActions") or []) != {topic_arn}:
            failures.append(
                {
                    "code": "ALARM_OK_ACTION_TARGET_MISMATCH",
                    "message": f"{name} recovery action is not the exact operations topic.",
                }
            )
    return {
        "passed": not failures,
        "actionsEnabled": actions_enabled,
        "observed": len(by_name),
        "expected": len(ALARM_NAMES),
        "failures": failures,
    }


def confirmed_operations_subscription(
    subscriptions: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    confirmed = [
        item
        for item in subscriptions
        if item.get("Protocol") in {"email", "email-json"}
        and item.get("SubscriptionArn") not in {None, "", "PendingConfirmation"}
    ]
    if not confirmed:
        raise ActivationFailure(
            "SNS_SUBSCRIPTION_UNCONFIRMED",
            "No confirmed email subscription exists on the operations topic.",
        )
    return {"passed": True, "confirmedEmailSubscriptions": len(confirmed)}


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


class AwsRuntime:
    """Narrow AWS adapter used by the activation controller."""

    def __init__(self, *, profile: str | None, region: str) -> None:
        config = Config(
            connect_timeout=5,
            read_timeout=330,
            retries={"max_attempts": 2, "mode": "standard"},
        )
        self.session = boto3.Session(profile_name=profile or None, region_name=region)
        self.region = region
        self.sts = self.session.client("sts", config=config)
        self.cloudformation = self.session.client("cloudformation", config=config)
        self.secretsmanager = self.session.client("secretsmanager", config=config)
        self.lambda_client = self.session.client("lambda", config=config)
        self.dynamodb = self.session.client("dynamodb", config=config)
        self.scheduler = self.session.client("scheduler", config=config)
        self.cloudwatch = self.session.client("cloudwatch", config=config)
        self.sns = self.session.client("sns", config=config)

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

    def secret_description(self, name: str) -> Mapping[str, Any]:
        # Deliberately metadata-only. Never call GetSecretValue here.
        return aws_call(
            "GMAIL_OAUTH_SECRET",
            lambda: self.secretsmanager.describe_secret(SecretId=name),
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

    def alarms(self) -> Sequence[Mapping[str, Any]]:
        response = aws_call(
            "ALARMS",
            lambda: self.cloudwatch.describe_alarms(AlarmNames=list(ALARM_NAMES)),
        )
        return response.get("MetricAlarms") or []

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
    ) -> None:
        self.runtime = runtime
        self.phase = phase
        self.apply = apply
        self.admin_profile = admin_profile
        self.cloudformation_role_arn = cloudformation_role_arn
        self.manifest, self.contract = manifest_contracts()
        self.resources = self.manifest["aws"]["resources"]
        self.services = {
            service["id"]: service for service in self.manifest.get("services") or []
        }
        self.stack: Mapping[str, Any] = {}
        self.parameters: dict[str, str] = {}
        self.outputs: dict[str, str] = {}

    def initialize(self) -> dict[str, Any]:
        identity = validate_identity(self.runtime.identity(), region=self.runtime.region)
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
        if not shutil.which("sam"):
            raise ActivationFailure("SAM_CLI_REQUIRED", "AWS SAM CLI is not installed.")

    def gmail_contract(self) -> Mapping[str, Any]:
        return self.services["gmail.ingestion"]

    def gmail_heartbeat(self) -> dict[str, Any]:
        service = self.gmail_contract()
        service_id = service["aws"]["heartbeatServiceId"]
        rows = self.runtime.heartbeat_rows(
            self.resources["serviceHeartbeatTable"], service_id, limit=4
        )
        return heartbeat_window(
            rows,
            service_id=service_id,
            schedule_id=service["aws"]["scheduleId"],
            required=4,
            cadence_minutes=int(service["cadenceMinutes"]),
            allowed_statuses={"success"},
        )

    def worker_heartbeat(self, worker: str) -> dict[str, Any]:
        worker_contract = self.contract["workers"][worker]
        service_id = worker_contract["serviceId"]
        rows = self.runtime.heartbeat_rows(
            self.resources["serviceHeartbeatTable"], service_id, limit=3
        )
        # A warning is still a proven, scheduled monitoring invocation. The
        # Healthy alarm carries the underlying typed capability failure.
        return heartbeat_window(
            rows,
            service_id=service_id,
            schedule_id=worker_contract["scheduleId"],
            required=3,
            cadence_minutes=int(worker_contract["cadenceMinutes"]),
            allowed_statuses={"success", "warning"},
        )

    def secret_check(self) -> dict[str, Any]:
        result = validate_secret_metadata(
            self.runtime.secret_description(self.parameters["GmailOAuthSecretName"])
        )
        return {key: value for key, value in result.items() if not key.startswith("_")}

    def function_check(self, kind: str) -> dict[str, Any]:
        resource_key = "gmailFunction" if kind == "GMAIL" else "hermesFunction"
        function_name = self.resources[resource_key]
        return validate_function_configuration(
            self.runtime.function_configuration(function_name),
            expected_name=function_name,
            kind=kind,
        )

    def function_checks(self) -> list[dict[str, Any]]:
        return [self.function_check("GMAIL"), self.function_check("HERMES")]

    def bridge_check(self) -> dict[str, Any]:
        snapshot = self.runtime.latest_snapshot(
            self.resources["hermesInputSnapshotTable"],
            self.parameters["BridgeHostId"],
        )
        return validate_bridge_snapshot(
            snapshot,
            expected_capabilities=set(self.contract["capabilityIds"]),
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
            }
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
        )

    def subscription_check(self) -> dict[str, Any]:
        return confirmed_operations_subscription(
            self.runtime.subscriptions(self.operations_topic_arn())
        )

    def require_rollout_prerequisites(self) -> list[dict[str, Any]]:
        checks: list[dict[str, Any]] = []
        if self.phase == "gmail":
            checks.append(self.secret_check())
            checks.append(self.function_check("GMAIL"))
            if self.parameters["GmailScheduleState"] == "ENABLED":
                gmail = self.gmail_heartbeat()
                require_heartbeat(gmail, "GMAIL_SCHEDULE_CANARY_FAILED")
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

        if self.phase in {"analyst", "developer", "security", "alarms", "full"}:
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
            checks.append(self.bridge_check())
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
        capture("hermesFunction", lambda: self.function_check("HERMES"))
        for specification in self.schedule_specifications(controls):
            name = str(specification["name"])
            capture(
                f"schedule:{name}",
                lambda specification=specification: self.schedule_check(specification),
            )
        capture("alarms", lambda: self.alarm_check(controls))
        if controls["OperationalAlarmsState"] == "ENABLED":
            capture("operationsSubscription", self.subscription_check)
        if controls["GmailScheduleState"] == "ENABLED":
            capture("heartbeat:gmail", self.gmail_heartbeat)
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
        role_arn = str(self.cloudformation_role_arn or "")

        steps = (
            [
                sys.executable,
                str(INFRA_DIR / "scripts" / "render_hermes_contract.py"),
                "--check",
            ],
            [
                "sam",
                "validate",
                "--lint",
                "--template-file",
                "template.yaml",
                "--region",
                EXPECTED_REGION,
                "--profile",
                self.admin_profile,
            ],
            ["sam", "build", "--template-file", "template.yaml"],
            [
                "sam",
                "deploy",
                "--config-file",
                "samconfig.toml",
                "--region",
                EXPECTED_REGION,
                "--profile",
                self.admin_profile,
                "--role-arn",
                role_arn,
                "--no-confirm-changeset",
                "--no-fail-on-empty-changeset",
                "--parameter-overrides",
                *[f"{key}={value}" for key, value in parameters.items()],
            ],
        )
        names = ("CONTRACT_CHECK", "SAM_VALIDATE", "SAM_BUILD", "SAM_DEPLOY")
        for name, command in zip(names, steps):
            completed = subprocess.run(
                command,
                cwd=INFRA_DIR,
                check=False,
                capture_output=True,
                text=True,
                env={
                    **os.environ,
                    "AWS_PROFILE": self.admin_profile,
                    "AWS_REGION": EXPECTED_REGION,
                    "AWS_DEFAULT_REGION": EXPECTED_REGION,
                },
            )
            if completed.returncode:
                diagnostic = safe_text(
                    (completed.stderr or completed.stdout or "command failed")[-1000:]
                )
                raise ActivationFailure(
                    f"{name}_FAILED",
                    f"{name} exited {completed.returncode}: {diagnostic}",
                )
        return {
            "passed": True,
            "stack": STACK_NAME,
            "buildVersion": build_version,
            "controls": {name: parameters[name] for name in CONTROL_PARAMETERS},
        }

    def run_rollout(self) -> dict[str, Any]:
        self.validate_apply_configuration()
        checks = self.require_rollout_prerequisites()
        controls = target_control_state(self.phase, self.parameters)
        previous_controls = {
            name: self.parameters[name] for name in CONTROL_PARAMETERS
        }
        report: dict[str, Any] = {
            "passed": True,
            "mode": "apply" if self.apply else "dry-run",
            "phase": self.phase,
            "currentControls": previous_controls,
            "targetControls": controls,
            "preflight": checks,
        }
        if not self.apply:
            report["mutation"] = {
                "performed": False,
                "code": "DRY_RUN_ONLY",
                "message": "Rerun with --apply and --admin-profile to mutate AWS.",
            }
            return report

        build_version = str(load_json(REPO_ROOT / "package.json")["version"])
        parameters = deployment_parameters(
            self.parameters, controls, build_version=build_version
        )
        report["deployment"] = self.deploy(parameters, build_version=build_version)

        # SAM waits for the stack update. Re-read every authoritative resource
        # instead of trusting the requested parameter values.
        self.stack = self.runtime.stack()
        validate_stack(self.stack)
        self.parameters = stack_parameters(self.stack)
        self.outputs = stack_outputs(self.stack)
        deployed_controls = {
            name: self.parameters[name] for name in CONTROL_PARAMETERS
        }
        if deployed_controls != controls:
            raise ActivationFailure(
                "STACK_CONTROL_STATE_MISMATCH",
                "CloudFormation completed but deployed controls differ from the request.",
                detail={"expected": controls, "actual": deployed_controls},
            )
        schedule_checks = self.schedule_checks(controls)
        for check in schedule_checks:
            require_check(check, "SCHEDULE_VERIFICATION_FAILED")
        alarm_check = self.alarm_check(controls)
        require_check(alarm_check, "ALARM_VERIFICATION_FAILED")
        subscription_check = (
            self.subscription_check()
            if controls["OperationalAlarmsState"] == "ENABLED"
            else {"passed": True, "notApplicable": True}
        )

        transitioned = {
            name
            for name in CONTROL_PARAMETERS
            if previous_controls.get(name) != controls.get(name)
        }
        heartbeat_checks: list[dict[str, Any]] = []
        gmail_result = self.gmail_heartbeat()
        if not gmail_result["passed"] and "GmailScheduleState" not in transitioned:
            require_heartbeat(gmail_result, "GMAIL_SCHEDULE_CANARY_FAILED")
        if not gmail_result["passed"]:
            gmail_result = {
                **gmail_result,
                "pending": True,
                "code": "GMAIL_SCHEDULE_OBSERVATION_PENDING",
            }
        heartbeat_checks.append(gmail_result)
        for worker in self.contract["workers"]:
            if controls[WORKER_PARAMETER[worker]] != "ENABLED":
                continue
            result = self.worker_heartbeat(worker)
            if not result["passed"] and WORKER_PARAMETER[worker] not in transitioned:
                require_heartbeat(
                    result,
                    f"HERMES_{worker.upper().replace('-', '_')}_SCHEDULE_CANARY_FAILED",
                )
            if not result["passed"]:
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
            "passed": True,
            "schedules": schedule_checks,
            "alarms": alarm_check,
            "operationsSubscription": subscription_check,
            "heartbeats": heartbeat_checks,
            "heartbeatWindowsPassed": heartbeat_windows_passed,
            "heartbeatObservationPending": not heartbeat_windows_passed,
            "note": (
                "A newly enabled schedule must accumulate its required 24/7 heartbeat "
                "window before the next rollout phase."
            ),
        }
        return report


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Inspect or stage the production Gmail/Hermes schedules and operational alarms. "
            "No AWS mutation occurs without --apply."
        )
    )
    parser.add_argument(
        "--phase",
        choices=("status", "gmail", "analyst", "developer", "security", "alarms", "full"),
        default="status",
        help="Rollout gate to inspect/apply (default: status).",
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
        help="Optional AWS profile for read-only status/dry-run inspection.",
    )
    parser.add_argument(
        "--cloudformation-role-arn",
        default=os.environ.get("MARKET_DASHBOARD_CF_ROLE_ARN"),
        help="Exact-account CloudFormation execution role; required with --apply.",
    )
    parser.add_argument("--region", default=EXPECTED_REGION)
    args = parser.parse_args(argv)
    if args.apply and args.phase == "status":
        parser.error("--apply requires an explicit rollout --phase.")
    if args.apply and not args.admin_profile:
        parser.error("--apply requires an explicit --admin-profile.")
    if args.region != EXPECTED_REGION:
        parser.error(f"this stack is pinned to --region {EXPECTED_REGION}.")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        profile = args.admin_profile if args.apply else (args.read_profile or args.admin_profile)
        runtime = AwsRuntime(profile=profile, region=args.region)
        controller = ActivationController(
            runtime,
            phase=args.phase,
            apply=args.apply,
            admin_profile=args.admin_profile,
            cloudformation_role_arn=args.cloudformation_role_arn,
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
