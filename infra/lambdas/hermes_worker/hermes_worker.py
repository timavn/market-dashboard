#!/usr/bin/env python3
"""Consolidated, fail-closed Hermes monitoring worker.

The worker consumes only snapshots published outbound by the local dashboard
bridge.  It does not call localhost, IB Gateway, or a public dashboard URL.
Portfolio-aware work is rejected unless the newest snapshot is fresh and
explicitly verified as live IBKR data.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, Iterable, Mapping, Optional, Tuple

import boto3
from boto3.dynamodb.conditions import Key
from botocore.config import Config


def load_service_contract() -> Dict[str, Any]:
    contract_path = Path(__file__).with_name("service_contract.json")
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    if contract.get("version") != 1 or not isinstance(contract.get("workers"), dict):
        raise RuntimeError("Bundled Hermes service contract is missing or unsupported.")
    if not contract.get("capabilityIds"):
        raise RuntimeError("Bundled Hermes capability contract is empty.")
    return contract


SERVICE_CONTRACT = load_service_contract()
JOB_CONTRACTS = SERVICE_CONTRACT["workers"]
AWS_REGION = os.environ.get(
    "AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", SERVICE_CONTRACT["awsRegion"])
)
SNAPSHOT_TABLE = os.environ.get(
    "HERMES_INPUT_SNAPSHOT_TABLE", SERVICE_CONTRACT["inputSnapshotTable"]
)
HEARTBEAT_TABLE = os.environ.get(
    "SERVICE_HEARTBEAT_TABLE", SERVICE_CONTRACT["heartbeatTable"]
)
RUNS_TABLE = os.environ.get("HERMES_AGENT_RUNS_TABLE", "HermesAgentRuns")
ALERTS_TABLE = os.environ.get("HERMES_ALERTS_TABLE", "HermesAlerts")
OPERATIONS_TOPIC_ARN = os.environ.get("HERMES_OPERATIONS_TOPIC_ARN", "")
HOST_ID = os.environ.get("HERMES_BRIDGE_HOST_ID", "tim-market-dashboard")
OPERATIONS_HOST_ID = f"{HOST_ID}#operations"
PORTFOLIO_HOST_ID = f"{HOST_ID}#portfolio"
BUILD_VERSION = os.environ.get("BUILD_VERSION", "development")
MAX_SNAPSHOT_AGE_SECONDS = int(os.environ.get("HERMES_MAX_SNAPSHOT_AGE_SECONDS", "180"))
MAX_CLOCK_SKEW_SECONDS = int(os.environ.get("HERMES_MAX_CLOCK_SKEW_SECONDS", "30"))
HEARTBEAT_TTL_DAYS = int(os.environ.get("SERVICE_HEARTBEAT_TTL_DAYS", "90"))
RUN_TTL_DAYS = int(os.environ.get("HERMES_RUN_TTL_DAYS", "365"))
WORKER_MODE = str(os.environ.get("HERMES_WORKER_MODE", "active")).strip().lower()
if WORKER_MODE not in {"active", "retired"}:
    raise RuntimeError("HERMES_WORKER_MODE must be active or retired.")
ALERT_ESCALATION_OBSERVATIONS = max(
    2, int(os.environ.get("HERMES_ALERT_ESCALATION_OBSERVATIONS", "3"))
)
MAX_ACTIVE_ALERT_ROOTS = 32
MAX_KNOWN_ALERT_ROOTS = 64
MAX_SNS_MESSAGE_BYTES = 4096

ALLOWED_JOBS = frozenset(JOB_CONTRACTS)
EXPECTED_SCHEDULE_IDS = {
    job_type: contract["scheduleId"] for job_type, contract in JOB_CONTRACTS.items()
}
HEARTBEAT_SERVICE_IDS = {
    job_type: contract["serviceId"] for job_type, contract in JOB_CONTRACTS.items()
}
EXPECTED_CAPABILITY_IDS = frozenset(SERVICE_CONTRACT["capabilityIds"])
SECURITY_RELEVANT_CHECK_IDS = frozenset({"dashboard.runtime"})
SECURITY_RELEVANT_ERROR_CODES = frozenset(
    {
        "DASHBOARD_CODE_VERSION_DRIFT",
        "DASHBOARD_RUNTIME_MISMATCH",
        "DASHBOARD_SUPERVISOR_CODE_DRIFT",
        "GMAIL_AUTH_REQUIRED",
        "GMAIL_HEARTBEAT_FUTURE_TIMESTAMP",
        "GMAIL_OAUTH_CLIENT_DISABLED",
        "GMAIL_SCHEDULER_PROVENANCE_INVALID",
    }
)
OPERATIONS_RUNTIME_HOST_HASH = re.compile(r"^[0-9a-f]{12}$")
PROHIBITED_PROVENANCE = re.compile(
    r"(?:^|[\s;,_-])(stale|offline|cache(?:d)?|mock|seed(?:ed)?|synthetic|"
    r"fallback|inferred|portfolio[-_ ]derived|frozen|delayed|historical)(?:$|[\s;,_-])",
    re.IGNORECASE,
)

dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)
cloudwatch = boto3.client("cloudwatch", region_name=AWS_REGION)
sns = boto3.client(
    "sns",
    region_name=AWS_REGION,
    config=Config(
        connect_timeout=3,
        read_timeout=10,
        retries={"max_attempts": 2, "mode": "standard"},
        tcp_keepalive=True,
    ),
)


class SnapshotRejected(RuntimeError):
    """An expected fail-closed rejection that should not be retried."""

    def __init__(self, error_code: str, message: str) -> None:
        super().__init__(message)
        self.error_code = error_code


class DependencyBlocked(RuntimeError):
    """The worker is healthy but cannot run without a verified live dependency."""

    def __init__(self, error_code: str, message: str, *, blocked_by: str) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.blocked_by = blocked_by


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_timestamp(value: Any) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def seconds_old(value: Any, *, now: Optional[datetime] = None) -> Optional[float]:
    observed = parse_timestamp(value)
    if not observed:
        return None
    current = now or utc_now()
    return (current - observed).total_seconds()


def age_is_fresh(age: Optional[float]) -> bool:
    return (
        age is not None
        and age >= -MAX_CLOCK_SKEW_SECONDS
        and age <= MAX_SNAPSHOT_AGE_SECONDS
    )


def to_dynamodb(value: Any) -> Any:
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, list):
        return [to_dynamodb(item) for item in value]
    if isinstance(value, dict):
        return {key: to_dynamodb(item) for key, item in value.items()}
    return value


def latest_input_snapshot(job_type: str = "quant-analyst") -> Optional[Dict[str, Any]]:
    partition_id = (
        PORTFOLIO_HOST_ID if job_type == "quant-analyst" else OPERATIONS_HOST_ID
    )
    response = dynamodb.Table(SNAPSHOT_TABLE).query(
        KeyConditionExpression=Key("hostId").eq(partition_id),
        ScanIndexForward=False,
        Limit=1,
        ConsistentRead=True,
    )
    items = response.get("Items") or []
    return items[0] if items else None


def _provenance_values(snapshot: Dict[str, Any]) -> Iterable[str]:
    portfolio = snapshot.get("portfolio") or {}
    yield str(snapshot.get("source") or "")
    yield str(portfolio.get("source") or "")
    yield str(portfolio.get("positionSource") or "")
    yield str(portfolio.get("priceSource") or "")
    for position in portfolio.get("positions") or []:
        if not isinstance(position, dict):
            continue
        yield str(position.get("positionSource") or "")
        yield str(position.get("priceSource") or "")


def _contains_portfolio_fields(value: Any) -> bool:
    if isinstance(value, dict):
        prohibited_keys = {"portfolio", "positions", "accountId", "accountRef", "accounts"}
        return bool(prohibited_keys.intersection(value)) or any(
            _contains_portfolio_fields(item) for item in value.values()
        )
    if isinstance(value, list):
        return any(_contains_portfolio_fields(item) for item in value)
    return False


def validate_snapshot(
    snapshot: Optional[Dict[str, Any]], job_type: str = "quant-analyst"
) -> Dict[str, Any]:
    if not snapshot:
        raise SnapshotRejected("HERMES_INPUT_MISSING", "No outbound dashboard snapshot is available.")

    if snapshot.get("source") != "local-outbound-bridge":
        raise SnapshotRejected(
            "HERMES_INPUT_UNTRUSTED_SOURCE",
            "Newest input did not originate from the owned local outbound bridge.",
        )
    expected_type = "portfolio" if job_type == "quant-analyst" else "operations"
    expected_host_id = (
        PORTFOLIO_HOST_ID if job_type == "quant-analyst" else OPERATIONS_HOST_ID
    )
    if (
        snapshot.get("schemaVersion") != 2
        or snapshot.get("snapshotType") != expected_type
        or snapshot.get("hostId") != expected_host_id
    ):
        raise SnapshotRejected(
            "HERMES_INPUT_PARTITION_INVALID",
            f"{job_type} requires the versioned {expected_type} telemetry partition.",
        )

    captured_age = seconds_old(snapshot.get("capturedAt"))
    if not age_is_fresh(captured_age):
        raise SnapshotRejected(
            "HERMES_INPUT_STALE",
            f"Newest outbound snapshot is older than {MAX_SNAPSHOT_AGE_SECONDS} seconds.",
        )

    if snapshot.get("bridgeStatus") == "blocked" and job_type == "quant-analyst":
        raise DependencyBlocked(
            str(snapshot.get("errorCode") or "PORTFOLIO_CAPABILITY_BLOCKED"),
            str(snapshot.get("detail") or "Verified live portfolio input is unavailable."),
            blocked_by=str(snapshot.get("blockedBy") or "portfolio.live"),
        )

    if snapshot.get("bridgeStatus") != "ready":
        raise SnapshotRejected(
            str(snapshot.get("errorCode") or "HERMES_BRIDGE_DEGRADED"),
            str(snapshot.get("detail") or "Local outbound bridge did not verify its inputs."),
        )

    capabilities = snapshot.get("capabilities")
    if job_type != "quant-analyst":
        if _contains_portfolio_fields(snapshot):
            raise SnapshotRejected(
                "OPERATIONS_TELEMETRY_CONTAINS_PORTFOLIO",
                "Operations telemetry must not contain positions or portfolio payloads.",
            )
        runtime = snapshot.get("runtime")
        hostname_hash = runtime.get("hostnameHash") if isinstance(runtime, dict) else None
        node_version = runtime.get("node") if isinstance(runtime, dict) else None
        platform = runtime.get("platform") if isinstance(runtime, dict) else None
        if (
            not isinstance(hostname_hash, str)
            or not OPERATIONS_RUNTIME_HOST_HASH.fullmatch(hostname_hash)
            or not isinstance(node_version, str)
            or not node_version.strip()
            or len(node_version) > 64
            or not isinstance(platform, str)
            or not platform.strip()
            or len(platform) > 64
        ):
            raise SnapshotRejected(
                "OPERATIONS_RUNTIME_INVALID",
                "Operations telemetry does not contain valid bounded runtime provenance.",
            )
        return snapshot

    gateway = snapshot.get("gateway") or {}
    if gateway.get("connected") is not True:
        raise SnapshotRejected("IBKR_GATEWAY_DISCONNECTED", "IB Gateway was not connected at capture time.")
    socket_age = seconds_old(gateway.get("socketVerifiedAt"))
    if not age_is_fresh(socket_age):
        raise SnapshotRejected(
            "IBKR_SOCKET_VERIFICATION_STALE",
            f"IBKR socket verification is missing or older than {MAX_SNAPSHOT_AGE_SECONDS} seconds.",
        )

    if not isinstance(capabilities, dict) or set(capabilities) != {"portfolio.live"}:
        raise SnapshotRejected(
            "SYSTEM_READINESS_CAPABILITY_CONTRACT_INVALID",
            "Portfolio telemetry does not contain its exact live-portfolio capability contract.",
        )
    portfolio_capability = capabilities.get("portfolio.live")
    if not isinstance(portfolio_capability, dict):
        raise SnapshotRejected(
            "PORTFOLIO_CAPABILITY_MISSING",
            "The snapshot omitted the portfolio.live capability gate.",
        )
    if (
        portfolio_capability.get("ready") is not True
        or portfolio_capability.get("status") not in {"pass", "ready"}
    ):
        raise SnapshotRejected(
            str(portfolio_capability.get("errorCode") or "PORTFOLIO_CAPABILITY_BLOCKED"),
            "The portfolio.live capability gate is not ready.",
        )

    portfolio = snapshot.get("portfolio") or {}
    if portfolio.get("verified") is not True or portfolio.get("source") != "ibkr_live":
        raise SnapshotRejected(
            "PORTFOLIO_NOT_VERIFIED_LIVE",
            "Portfolio input was not explicitly verified as live IBKR data.",
        )
    if portfolio.get("accountsVerified") is not True:
        raise SnapshotRejected(
            "IBKR_ACCOUNTS_UNVERIFIED",
            "The snapshot did not contain verified managed-account coverage.",
        )

    observed_age = seconds_old(portfolio.get("observedAt"))
    if not age_is_fresh(observed_age):
        raise SnapshotRejected(
            "PORTFOLIO_SNAPSHOT_STALE",
            f"Portfolio observation is older than {MAX_SNAPSHOT_AGE_SECONDS} seconds.",
        )

    blocked_values = [value for value in _provenance_values(snapshot) if PROHIBITED_PROVENANCE.search(value)]
    if blocked_values:
        raise SnapshotRejected(
            "PROHIBITED_DATA_PROVENANCE",
            "The snapshot contains stale, cached, synthetic, inferred, or fallback provenance.",
        )

    positions = portfolio.get("positions")
    if not isinstance(positions, list):
        raise SnapshotRejected("PORTFOLIO_SCHEMA_INVALID", "Portfolio positions must be an array.")
    return snapshot


def write_heartbeat(
    job_type: str,
    *,
    started_at: str,
    status: str,
    trigger_source: str,
    schedule_id: Optional[str],
    error_code: Optional[str] = None,
    detail: Optional[str] = None,
    counts: Optional[Dict[str, int]] = None,
    blocked_by: Optional[str] = None,
) -> None:
    observed = utc_now()
    scheduled = (
        trigger_source == "aws-scheduler"
        and schedule_id == EXPECTED_SCHEDULE_IDS.get(job_type)
    )
    scheduled_service_id = HEARTBEAT_SERVICE_IDS[job_type]
    service_id = scheduled_service_id if scheduled else f"{scheduled_service_id}:manual"
    item: Dict[str, Any] = {
        "serviceId": service_id,
        "observedAt": observed.isoformat(),
        "startedAt": started_at,
        "finishedAt": observed.isoformat(),
        "status": status,
        "source": "aws-lambda",
        "triggerSource": trigger_source or "unknown",
        "scheduleId": schedule_id,
        "scheduled": scheduled,
        "buildVersion": BUILD_VERSION,
        "counts": counts or {},
        "ttl": int(observed.timestamp() + HEARTBEAT_TTL_DAYS * 86400),
    }
    if error_code:
        item["errorCode"] = error_code
    if detail:
        item["detail"] = detail[:500]
    if blocked_by:
        item["blockedBy"] = blocked_by[:120]
    dynamodb.Table(HEARTBEAT_TABLE).put_item(Item=to_dynamodb(item))
    cloudwatch.put_metric_data(
        Namespace="MarketDashboard/Readiness",
        MetricData=[
            {
                "MetricName": "Heartbeat",
                "Dimensions": [{"Name": "ServiceId", "Value": service_id}],
                "Timestamp": observed,
                "Value": 1,
                "Unit": "Count",
            },
            {
                "MetricName": "Healthy",
                "Dimensions": [{"Name": "ServiceId", "Value": service_id}],
                "Timestamp": observed,
                "Value": 1 if status == "success" else 0,
                "Unit": "Count",
            },
        ],
    )


def write_run(
    job_type: str,
    *,
    started_at: str,
    status: str,
    summary: str,
    severity: str,
    metadata: Dict[str, Any],
) -> Dict[str, Any]:
    finished = utc_now()
    item = {
        "worker": job_type,
        "startedAt": started_at,
        "finishedAt": finished.isoformat(),
        "status": status,
        "summary": summary[:500],
        "severity": severity,
        "triggerType": "schedule",
        "source": "aws-lambda",
        "buildVersion": BUILD_VERSION,
        "runId": f"{job_type}#{started_at}",
        "runDate": started_at[:10],
        "updatedAt": finished.isoformat(),
        "metadata": metadata,
        "ttl": int(finished.timestamp() + RUN_TTL_DAYS * 86400),
    }
    dynamodb.Table(RUNS_TABLE).put_item(Item=to_dynamodb(item))
    return item


def canonical_alert_root(error_code: Any) -> str:
    raw = str(error_code or "UNKNOWN_ROOT_CAUSE").strip().upper()
    raw = re.sub(r"\s+", "_", raw) or "UNKNOWN_ROOT_CAUSE"
    if len(raw) > 120:
        digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12].upper()
        raw = f"{raw[:100]}_{digest}"
    return raw


def alert_root_token(error_code: str) -> str:
    normalized = re.sub(r"[^A-Z0-9_-]+", "_", error_code).strip("_")
    normalized = normalized or "UNKNOWN_ROOT_CAUSE"
    if normalized != error_code or len(normalized) > 100:
        digest = hashlib.sha256(error_code.encode("utf-8")).hexdigest()[:12].upper()
        normalized = f"{normalized[:87]}_{digest}"
    return normalized


def alert_id(job_type: str, error_code: str) -> str:
    return f"{job_type}#runtime-health#{alert_root_token(error_code)}"


def alert_state_id(job_type: str) -> str:
    return f"{job_type}#runtime-health#STATE"


def read_alert_state(job_type: str) -> Dict[str, Any]:
    response = dynamodb.Table(ALERTS_TABLE).get_item(
        Key={"alertId": alert_state_id(job_type)},
        ConsistentRead=True,
    )
    item = response.get("Item") or {}
    active: Dict[str, Dict[str, Any]] = {}
    for entry in item.get("activeRoots") or []:
        if not isinstance(entry, dict):
            continue
        error_code = canonical_alert_root(entry.get("errorCode"))
        active[error_code] = {
            "errorCode": error_code,
            "openedAt": str(entry.get("openedAt") or item.get("updatedAt") or ""),
            "observationCount": max(1, int(entry.get("observationCount") or 1)),
            "escalated": entry.get("escalated") is True,
        }
    known = {
        canonical_alert_root(error_code)
        for error_code in item.get("knownRoots") or []
        if error_code
    }
    known.update(active)
    return {"active": active, "known": known}


def read_root_alert(job_type: str, error_code: str) -> Optional[Dict[str, Any]]:
    response = dynamodb.Table(ALERTS_TABLE).get_item(
        Key={"alertId": alert_id(job_type, error_code)},
        ConsistentRead=True,
    )
    item = response.get("Item")
    return item if isinstance(item, dict) else None


def write_alert_state(
    job_type: str,
    active_roots: Mapping[str, Mapping[str, Any]],
    *,
    known_roots: Iterable[str],
    source_run_id: str,
    observed_at: str,
    notification_failures: Optional[list[Mapping[str, str]]] = None,
) -> None:
    item = {
        "alertId": alert_state_id(job_type),
        "worker": job_type,
        "severity": "info",
        "status": "resolved",
        "type": "runtime-health-state",
        "dedupeKey": f"{job_type}#runtime-health-state",
        "title": f"{job_type} runtime-health lifecycle state",
        "message": f"{len(active_roots)} active root cause(s) are tracked.",
        "sourceRunId": source_run_id,
        "channels": ["dashboard"],
        "details": {
            "hostId": HOST_ID,
            "stateVersion": 2,
            "notificationFailures": list(notification_failures or [])[:MAX_ACTIVE_ALERT_ROOTS],
        },
        "knownRoots": sorted(set(known_roots)),
        "activeRoots": [
            {
                "errorCode": error_code,
                "openedAt": entry.get("openedAt") or observed_at,
                "observationCount": int(entry.get("observationCount") or 1),
                "escalated": entry.get("escalated") is True,
            }
            for error_code, entry in sorted(active_roots.items())
        ],
        "createdAt": observed_at,
        "updatedAt": observed_at,
        "resolvedAt": observed_at,
    }
    dynamodb.Table(ALERTS_TABLE).put_item(Item=to_dynamodb(item))


def write_root_alert(
    job_type: str,
    *,
    error_code: str,
    message: str,
    source_run_id: str,
    status: str,
    transition: str,
    observed_at: str,
    opened_at: Optional[str] = None,
    observation_count: int = 1,
) -> None:
    resolved = status == "resolved"
    item = {
        "alertId": alert_id(job_type, error_code),
        "worker": job_type,
        "severity": "info" if resolved else "warning",
        "status": status,
        "type": "runtime-health",
        "dedupeKey": f"{job_type}#{error_code}",
        "title": (
            f"{job_type} monitoring recovered"
            if resolved
            else f"{job_type} monitoring degraded"
        ),
        "message": message[:500],
        "recommendedAction": (
            None
            if resolved
            else "Run npm run morning and resolve the named readiness root cause."
        ),
        "sourceRunId": source_run_id,
        "channels": ["dashboard", "sns"],
        "details": {
            "errorCode": error_code,
            "hostId": HOST_ID,
            "transition": transition,
            "observationCount": observation_count,
        },
        "createdAt": opened_at or observed_at,
        "updatedAt": observed_at,
    }
    if resolved:
        item["resolvedAt"] = observed_at
    elif transition == "incident_escalated":
        item["escalatedAt"] = observed_at
    dynamodb.Table(ALERTS_TABLE).put_item(Item=item)


def publish_lifecycle_notification(
    *,
    service: str,
    error_code: str,
    event_type: str,
    message: str,
    source_run_id: str,
    observed_at: str,
) -> bool:
    if not OPERATIONS_TOPIC_ARN:
        return False
    payload = {
        "schemaVersion": 1,
        "eventType": event_type,
        "dedupeKey": f"{service}#{error_code}",
        "service": service,
        "rootCause": error_code,
        "observedAt": observed_at,
        "sourceRunId": source_run_id,
        "message": str(message)[:1000],
    }
    encoded = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    if len(encoded.encode("utf-8")) > MAX_SNS_MESSAGE_BYTES:
        payload["message"] = str(message)[:256]
        encoded = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    if len(encoded.encode("utf-8")) > MAX_SNS_MESSAGE_BYTES:
        raise RuntimeError("Hermes lifecycle notification exceeded its bounded SNS payload.")
    subject = re.sub(
        r"[\r\n]+",
        " ",
        f"Hermes {event_type.replace('_', ' ')}: {service} {error_code}",
    )[:100]
    sns.publish(
        TopicArn=OPERATIONS_TOPIC_ARN,
        Subject=subject,
        Message=encoded,
        MessageAttributes={
            "eventType": {"DataType": "String", "StringValue": event_type},
            "dedupeKey": {
                "DataType": "String",
                "StringValue": f"{service}#{error_code}"[:256],
            },
        },
    )
    return True


def try_publish_lifecycle_notification(**kwargs: Any) -> Optional[Dict[str, str]]:
    try:
        publish_lifecycle_notification(**kwargs)
        return None
    except Exception as error:
        return {
            "eventType": str(kwargs.get("event_type") or "unknown"),
            "errorCode": str(kwargs.get("error_code") or "UNKNOWN_ROOT_CAUSE"),
            "notificationError": type(error).__name__,
        }


def reconcile_alert_lifecycle(
    job_type: str,
    findings: Iterable[Mapping[str, Any]],
    *,
    source_run_id: str,
) -> Dict[str, Any]:
    observed_at = utc_now().isoformat()
    current: Dict[str, Mapping[str, Any]] = {}
    for finding in findings:
        error_code = canonical_alert_root(finding.get("errorCode"))
        current.setdefault(error_code, finding)
    if len(current) > MAX_ACTIVE_ALERT_ROOTS:
        raise RuntimeError(
            f"Hermes alert root count {len(current)} exceeds the bounded "
            f"limit of {MAX_ACTIVE_ALERT_ROOTS}."
        )

    state = read_alert_state(job_type)
    previous_known = set(state["known"])
    preflight_known = previous_known | set(current)
    if len(preflight_known) > MAX_KNOWN_ALERT_ROOTS:
        raise RuntimeError(
            f"Hermes known alert root count {len(preflight_known)} exceeds the "
            f"bounded limit of {MAX_KNOWN_ALERT_ROOTS}."
        )
    # Persist the desired roots before changing any root row. If execution is
    # interrupted, the next invocation can recover every transition through
    # exact-key reads without scanning the shared alert table.
    write_alert_state(
        job_type,
        {
            error_code: {
                "openedAt": observed_at,
                "observationCount": 1,
                "escalated": False,
            }
            for error_code in current
        },
        known_roots=preflight_known,
        source_run_id=source_run_id,
        observed_at=observed_at,
    )

    next_active: Dict[str, Dict[str, Any]] = {}
    transitions: list[Dict[str, str]] = []
    notification_failures: list[Dict[str, str]] = []

    for error_code, finding in current.items():
        detail = str(finding.get("detail") or "Readiness root cause is active.")[:500]
        root_item = read_root_alert(job_type, error_code)
        if not root_item or root_item.get("status") != "open":
            event_type = (
                "circuit_opened"
                if "CIRCUIT_OPEN" in error_code
                else "incident_opened"
            )
            write_root_alert(
                job_type,
                error_code=error_code,
                message=detail,
                source_run_id=source_run_id,
                status="open",
                transition=event_type,
                observed_at=observed_at,
            )
            # Opening is dashboard-only. Publication begins only after the root
            # survives the bounded escalation observation count.
            transitions.append({"eventType": event_type, "errorCode": error_code})
            next_active[error_code] = {
                "openedAt": observed_at,
                "observationCount": 1,
                "escalated": False,
            }
            continue

        root_details = (
            root_item.get("details")
            if isinstance(root_item.get("details"), dict)
            else {}
        )
        observation_count = int(root_details.get("observationCount") or 1) + 1
        escalated = bool(
            root_item.get("escalatedAt")
            or root_details.get("transition") == "incident_escalated"
        )
        opened_at = str(root_item.get("createdAt") or observed_at)
        if observation_count >= ALERT_ESCALATION_OBSERVATIONS and not escalated:
            write_root_alert(
                job_type,
                error_code=error_code,
                message=detail,
                source_run_id=source_run_id,
                status="open",
                transition="incident_escalated",
                observed_at=observed_at,
                opened_at=opened_at,
                observation_count=observation_count,
            )
            notification_failure = try_publish_lifecycle_notification(
                service=job_type,
                error_code=error_code,
                event_type="incident_escalated",
                message=detail,
                source_run_id=source_run_id,
                observed_at=observed_at,
            )
            if notification_failure:
                notification_failures.append(notification_failure)
            transitions.append(
                {"eventType": "incident_escalated", "errorCode": error_code}
            )
            escalated = True
        elif not escalated:
            write_root_alert(
                job_type,
                error_code=error_code,
                message=detail,
                source_run_id=source_run_id,
                status="open",
                transition=str(root_details.get("transition") or "incident_opened"),
                observed_at=observed_at,
                opened_at=opened_at,
                observation_count=observation_count,
            )
        next_active[error_code] = {
            "openedAt": opened_at,
            "observationCount": observation_count,
            "escalated": escalated,
        }

    for error_code in preflight_known:
        if error_code in current:
            continue
        root_item = read_root_alert(job_type, error_code)
        if not root_item or root_item.get("status") != "open":
            continue
        root_details = (
            root_item.get("details")
            if isinstance(root_item.get("details"), dict)
            else {}
        )
        message = f"{job_type} recovered from root cause {error_code}."
        write_root_alert(
            job_type,
            error_code=error_code,
            message=message,
            source_run_id=source_run_id,
            status="resolved",
            transition="incident_recovered",
            observed_at=observed_at,
            opened_at=str(root_item.get("createdAt") or observed_at),
            observation_count=int(root_details.get("observationCount") or 1),
        )
        was_escalated = bool(
            root_item.get("escalatedAt")
            or root_details.get("transition") == "incident_escalated"
        )
        if was_escalated:
            notification_failure = try_publish_lifecycle_notification(
                service=job_type,
                error_code=error_code,
                event_type="incident_recovered",
                message=message,
                source_run_id=source_run_id,
                observed_at=observed_at,
            )
            if notification_failure:
                notification_failures.append(notification_failure)
        transitions.append(
            {"eventType": "incident_recovered", "errorCode": error_code}
        )

    write_alert_state(
        job_type,
        next_active,
        known_roots=set(current),
        source_run_id=source_run_id,
        observed_at=observed_at,
        notification_failures=notification_failures,
    )
    return {
        "activeRoots": sorted(next_active),
        "transitions": transitions,
        "notificationFailures": notification_failures,
    }


def degraded_capability_findings(snapshot: Dict[str, Any]) -> list[Dict[str, str]]:
    capabilities = snapshot.get("capabilities") or {}
    findings = []
    for capability_id, capability in sorted(capabilities.items()):
        if not isinstance(capability, dict):
            findings.append(
                {
                    "capabilityId": capability_id,
                    "status": "invalid",
                    "errorCode": "CAPABILITY_STATUS_INVALID",
                    "detail": "Capability status is not an object.",
                }
            )
            continue
        status = str(capability.get("status") or "unknown").lower()
        ready = capability.get("ready")
        if status in {"pass", "ready"} and ready is not False:
            continue
        normalized_id = re.sub(r"[^A-Z0-9]+", "_", capability_id.upper()).strip("_")
        findings.append(
            {
                "capabilityId": capability_id,
                "status": status,
                "errorCode": str(
                    capability.get("errorCode")
                    or capability.get("code")
                    or f"{normalized_id}_DEGRADED"
                ),
                "detail": str(
                    capability.get("detail")
                    or capability.get("message")
                    or capability.get("reason")
                    or "Capability is not ready."
                )[:300],
            }
        )
    return findings


def security_root_cause_findings(snapshot: Dict[str, Any]) -> list[Dict[str, str]]:
    findings = []
    for cause in snapshot.get("rootCauses") or []:
        if not isinstance(cause, dict):
            continue
        error_code = str(cause.get("errorCode") or cause.get("id") or "").strip()
        if not error_code:
            continue
        affected = [
            str(check_id)
            for check_id in cause.get("affectedCheckIds") or []
            if check_id
        ]
        relevant_check_id = next(
            (
                check_id
                for check_id in affected
                if check_id in SECURITY_RELEVANT_CHECK_IDS
            ),
            None,
        )
        if (
            error_code.upper() not in SECURITY_RELEVANT_ERROR_CODES
            and relevant_check_id is None
        ):
            continue
        findings.append(
            {
                "capabilityId": str(
                    relevant_check_id
                    or (affected[0] if affected else cause.get("checkId"))
                    or "security.runtime"
                ),
                "status": str(cause.get("status") or "failed"),
                "errorCode": error_code,
                "detail": str(
                    cause.get("summary") or "A security-relevant root cause is active."
                )[:300],
            }
        )
    return findings


def build_result(
    job_type: str, snapshot: Dict[str, Any]
) -> Tuple[str, Dict[str, Any], list[Dict[str, str]]]:
    portfolio = snapshot.get("portfolio") or {}
    positions = portfolio.get("positions") or []
    if job_type == "quant-analyst":
        findings = degraded_capability_findings(snapshot)
    elif job_type == "security":
        findings = security_root_cause_findings(snapshot)
    else:
        findings = []
    unavailable = [finding["capabilityId"] for finding in findings]

    if job_type == "quant-analyst":
        summary = (
            f"Verified {len(positions)} live IBKR position"
            f"{'s' if len(positions) != 1 else ''}; "
            + (
                f"found {len(findings)} degraded readiness capability gate(s)."
                if findings
                else "monitoring completed without synthetic suggestions."
            )
        )
        detail = {
            "positionCount": len(positions),
            "accountCount": int(portfolio.get("accountCount") or 0),
            "portfolioObservedAt": portfolio.get("observedAt"),
            "suggestions": [],
            "degradedCapabilities": findings,
        }
    elif job_type == "quant-developer":
        summary = "Dashboard operations snapshot and runtime provenance are available."
        detail = {"degradedCapabilities": findings}
    else:
        summary = (
            "Runtime provenance and authentication boundaries are healthy."
            if not unavailable
            else f"Security review found {len(unavailable)} relevant condition(s)."
        )
        detail = {
            "securityFindingCount": len(findings),
            "degradedCapabilities": findings,
        }
    return summary, detail, findings


def lambda_handler(event: Optional[Dict[str, Any]], context: Any) -> Dict[str, Any]:
    event = event or {}
    if WORKER_MODE == "retired":
        return {
            "status": "RETIRED",
            "errorCode": "LEGACY_HERMES_RETIRED",
            "message": (
                "Legacy Hermes workers are retained for rollback but all "
                "worker-owned writes are disabled."
            ),
            "writesPerformed": False,
        }
    job_type = str(event.get("jobType") or event.get("worker") or "").strip()
    if job_type not in ALLOWED_JOBS:
        raise ValueError(f"Unsupported Hermes jobType: {job_type or '<missing>'}")
    trigger_source = str(event.get("source") or "manual").strip()
    schedule_id = str(event.get("scheduleId") or "").strip() or None

    started_at = utc_now().isoformat()
    try:
        snapshot = validate_snapshot(latest_input_snapshot(job_type), job_type)
        summary, detail, findings = build_result(job_type, snapshot)
        is_degraded = len(findings) > 0
        finding_codes = [finding["errorCode"] for finding in findings]
        run = write_run(
            job_type,
            started_at=started_at,
            status="warning" if is_degraded else "succeeded",
            summary=summary,
            severity="warning" if is_degraded else "info",
            metadata={
                **detail,
                "snapshotCapturedAt": snapshot.get("capturedAt"),
                "snapshotBuildVersion": snapshot.get("buildVersion"),
            },
        )
        lifecycle = reconcile_alert_lifecycle(
            job_type,
            (
                {
                    **finding,
                    "detail": (
                        f"{finding['capabilityId']}: {finding['errorCode']} "
                        f"({finding['detail']})"
                    ),
                }
                for finding in findings
            ),
            source_run_id=run["runId"],
        )
        notification_failures = lifecycle["notificationFailures"]
        if notification_failures:
            is_degraded = True
            finding_codes = [
                *finding_codes,
                "HERMES_ALERT_SNS_PUBLISH_FAILED",
            ]
            detail = {
                **detail,
                "alertNotificationFailures": notification_failures,
            }
            run = write_run(
                job_type,
                started_at=started_at,
                status="warning",
                summary=f"{summary} Alert notification delivery was degraded.",
                severity="warning",
                metadata={
                    **detail,
                    "snapshotCapturedAt": snapshot.get("capturedAt"),
                    "snapshotBuildVersion": snapshot.get("buildVersion"),
                },
            )
        heartbeat_details = [
            f"{finding['capabilityId']}={finding['errorCode']}"
            for finding in findings
        ]
        if notification_failures:
            heartbeat_details.append("alerts=HERMES_ALERT_SNS_PUBLISH_FAILED")
        write_heartbeat(
            job_type,
            started_at=started_at,
            status="warning" if is_degraded else "success",
            trigger_source=trigger_source,
            schedule_id=schedule_id,
            error_code=(
                finding_codes[0]
                if len(finding_codes) == 1
                else "SYSTEM_CAPABILITIES_DEGRADED" if is_degraded else None
            ),
            detail="; ".join(heartbeat_details) if is_degraded else None,
            counts={"positions": len((snapshot.get("portfolio") or {}).get("positions") or [])},
        )
        return {
            "statusCode": 200,
            "body": json.dumps(
                {
                    "status": "DEGRADED" if is_degraded else "SUCCESS",
                    "runId": run["runId"],
                    "errorCodes": finding_codes,
                }
            ),
        }
    except DependencyBlocked as error:
        run = write_run(
            job_type,
            started_at=started_at,
            status="blocked",
            summary=str(error),
            severity="warning",
            metadata={
                "errorCode": error.error_code,
                "blockedBy": error.blocked_by,
                "suggestions": [],
            },
        )
        # The schedule and worker completed normally; the dependency owns the
        # incident. Resolve any older worker-owned finding instead of opening a
        # duplicate Hermes alert.
        reconcile_alert_lifecycle(
            job_type,
            [],
            source_run_id=run["runId"],
        )
        write_heartbeat(
            job_type,
            started_at=started_at,
            status="blocked",
            trigger_source=trigger_source,
            schedule_id=schedule_id,
            error_code=error.error_code,
            detail=str(error),
            counts={"positions": 0},
            blocked_by=error.blocked_by,
        )
        return {
            "statusCode": 200,
            "body": json.dumps(
                {
                    "status": "BLOCKED",
                    "errorCode": error.error_code,
                    "blockedBy": error.blocked_by,
                }
            ),
        }
    except SnapshotRejected as error:
        run = write_run(
            job_type,
            started_at=started_at,
            status="failed",
            summary=str(error),
            severity="warning",
            metadata={"errorCode": error.error_code, "suggestions": []},
        )
        reconcile_alert_lifecycle(
            job_type,
            [
                {
                    "errorCode": error.error_code,
                    "detail": str(error),
                }
            ],
            source_run_id=run["runId"],
        )
        write_heartbeat(
            job_type,
            started_at=started_at,
            status="error",
            trigger_source=trigger_source,
            schedule_id=schedule_id,
            error_code=error.error_code,
            detail=str(error),
        )
        # Expected input degradation is recorded, not retried. Unexpected runtime
        # exceptions are raised below and flow to the async failure queue.
        return {
            "statusCode": 200,
            "body": json.dumps({"status": "REJECTED", "errorCode": error.error_code}),
        }
    except Exception as error:
        try:
            write_heartbeat(
                job_type,
                started_at=started_at,
                status="error",
                trigger_source=trigger_source,
                schedule_id=schedule_id,
                error_code="HERMES_RUNTIME_ERROR",
                detail=f"{type(error).__name__}: {str(error)[:350]}",
            )
        except Exception:
            pass
        raise


if __name__ == "__main__":
    print(json.dumps(lambda_handler({"jobType": "quant-developer"}, None), indent=2))
