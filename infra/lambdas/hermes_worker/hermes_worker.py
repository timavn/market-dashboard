#!/usr/bin/env python3
"""Consolidated, fail-closed Hermes monitoring worker.

The worker consumes only snapshots published outbound by the local dashboard
bridge.  It does not call localhost, IB Gateway, or a public dashboard URL.
Portfolio-aware work is rejected unless the newest snapshot is fresh and
explicitly verified as live IBKR data.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Tuple

import boto3
from boto3.dynamodb.conditions import Key


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
HOST_ID = os.environ.get("HERMES_BRIDGE_HOST_ID", "tim-market-dashboard")
BUILD_VERSION = os.environ.get("BUILD_VERSION", "development")
MAX_SNAPSHOT_AGE_SECONDS = int(os.environ.get("HERMES_MAX_SNAPSHOT_AGE_SECONDS", "180"))
MAX_CLOCK_SKEW_SECONDS = int(os.environ.get("HERMES_MAX_CLOCK_SKEW_SECONDS", "30"))
HEARTBEAT_TTL_DAYS = int(os.environ.get("SERVICE_HEARTBEAT_TTL_DAYS", "90"))
RUN_TTL_DAYS = int(os.environ.get("HERMES_RUN_TTL_DAYS", "365"))

ALLOWED_JOBS = frozenset(JOB_CONTRACTS)
EXPECTED_SCHEDULE_IDS = {
    job_type: contract["scheduleId"] for job_type, contract in JOB_CONTRACTS.items()
}
HEARTBEAT_SERVICE_IDS = {
    job_type: contract["serviceId"] for job_type, contract in JOB_CONTRACTS.items()
}
EXPECTED_CAPABILITY_IDS = frozenset(SERVICE_CONTRACT["capabilityIds"])
PROHIBITED_PROVENANCE = re.compile(
    r"(?:^|[\s;,_-])(stale|offline|cache(?:d)?|mock|seed(?:ed)?|synthetic|"
    r"fallback|inferred|portfolio[-_ ]derived|frozen|delayed|historical)(?:$|[\s;,_-])",
    re.IGNORECASE,
)

dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)
cloudwatch = boto3.client("cloudwatch", region_name=AWS_REGION)


class SnapshotRejected(RuntimeError):
    """An expected fail-closed rejection that should not be retried."""

    def __init__(self, error_code: str, message: str) -> None:
        super().__init__(message)
        self.error_code = error_code


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


def latest_input_snapshot() -> Optional[Dict[str, Any]]:
    response = dynamodb.Table(SNAPSHOT_TABLE).query(
        KeyConditionExpression=Key("hostId").eq(HOST_ID),
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


def validate_snapshot(snapshot: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not snapshot:
        raise SnapshotRejected("HERMES_INPUT_MISSING", "No outbound dashboard snapshot is available.")

    if snapshot.get("source") != "local-outbound-bridge":
        raise SnapshotRejected(
            "HERMES_INPUT_UNTRUSTED_SOURCE",
            "Newest input did not originate from the owned local outbound bridge.",
        )

    captured_age = seconds_old(snapshot.get("capturedAt"))
    if not age_is_fresh(captured_age):
        raise SnapshotRejected(
            "HERMES_INPUT_STALE",
            f"Newest outbound snapshot is older than {MAX_SNAPSHOT_AGE_SECONDS} seconds.",
        )

    if snapshot.get("bridgeStatus") != "ready":
        raise SnapshotRejected(
            str(snapshot.get("errorCode") or "HERMES_BRIDGE_DEGRADED"),
            str(snapshot.get("detail") or "Local outbound bridge did not verify its inputs."),
        )

    gateway = snapshot.get("gateway") or {}
    if gateway.get("connected") is not True:
        raise SnapshotRejected("IBKR_GATEWAY_DISCONNECTED", "IB Gateway was not connected at capture time.")
    socket_age = seconds_old(gateway.get("socketVerifiedAt"))
    if not age_is_fresh(socket_age):
        raise SnapshotRejected(
            "IBKR_SOCKET_VERIFICATION_STALE",
            f"IBKR socket verification is missing or older than {MAX_SNAPSHOT_AGE_SECONDS} seconds.",
        )

    capabilities = snapshot.get("capabilities")
    if not isinstance(capabilities, dict) or set(capabilities) != EXPECTED_CAPABILITY_IDS:
        raise SnapshotRejected(
            "SYSTEM_READINESS_CAPABILITY_CONTRACT_INVALID",
            "The snapshot does not contain the exact system-readiness capability contract.",
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


def write_deduplicated_alert(
    job_type: str,
    *,
    error_code: str,
    message: str,
    source_run_id: str,
) -> None:
    now = utc_now().isoformat()
    item = {
        "alertId": f"{job_type}#input#{error_code}",
        "worker": job_type,
        "severity": "warning",
        "status": "open",
        "type": "input-readiness",
        "dedupeKey": error_code,
        "title": f"{job_type} input unavailable",
        "message": message[:500],
        "recommendedAction": "Run npm run morning and resolve the named readiness root cause.",
        "sourceRunId": source_run_id,
        "channels": ["dashboard", "sns"],
        "details": {"errorCode": error_code, "hostId": HOST_ID},
        "createdAt": now,
        "updatedAt": now,
    }
    dynamodb.Table(ALERTS_TABLE).put_item(Item=item)


def build_result(job_type: str, snapshot: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
    portfolio = snapshot["portfolio"]
    positions = portfolio.get("positions") or []
    capabilities = snapshot.get("capabilities") or {}
    unavailable = sorted(
        capability_id
        for capability_id, capability in capabilities.items()
        if isinstance(capability, dict) and capability.get("status") not in {"pass", "ready"}
    )

    if job_type == "quant-analyst":
        summary = (
            f"Verified {len(positions)} live IBKR position"
            f"{'s' if len(positions) != 1 else ''}; monitoring completed without synthetic suggestions."
        )
        detail = {
            "positionCount": len(positions),
            "accountCount": int(portfolio.get("accountCount") or 0),
            "portfolioObservedAt": portfolio.get("observedAt"),
            "suggestions": [],
        }
    elif job_type == "quant-developer":
        summary = (
            "Dashboard snapshot is operational."
            if not unavailable
            else f"Dashboard snapshot has {len(unavailable)} degraded capability gate(s)."
        )
        detail = {"degradedCapabilities": unavailable}
    else:
        manual_actions = snapshot.get("manualActions") or []
        summary = (
            "Runtime provenance and authentication boundaries are healthy."
            if not manual_actions
            else f"Security review found {len(manual_actions)} manual operator action(s)."
        )
        detail = {"manualActionCount": len(manual_actions)}
    return summary, detail


def lambda_handler(event: Optional[Dict[str, Any]], context: Any) -> Dict[str, Any]:
    event = event or {}
    job_type = str(event.get("jobType") or event.get("worker") or "").strip()
    if job_type not in ALLOWED_JOBS:
        raise ValueError(f"Unsupported Hermes jobType: {job_type or '<missing>'}")
    trigger_source = str(event.get("source") or "manual").strip()
    schedule_id = str(event.get("scheduleId") or "").strip() or None

    started_at = utc_now().isoformat()
    try:
        snapshot = validate_snapshot(latest_input_snapshot())
        summary, detail = build_result(job_type, snapshot)
        run = write_run(
            job_type,
            started_at=started_at,
            status="succeeded",
            summary=summary,
            severity="info",
            metadata={
                **detail,
                "snapshotCapturedAt": snapshot.get("capturedAt"),
                "snapshotBuildVersion": snapshot.get("buildVersion"),
            },
        )
        write_heartbeat(
            job_type,
            started_at=started_at,
            status="success",
            trigger_source=trigger_source,
            schedule_id=schedule_id,
            counts={"positions": len(snapshot["portfolio"].get("positions") or [])},
        )
        return {"statusCode": 200, "body": json.dumps({"status": "SUCCESS", "runId": run["runId"]})}
    except SnapshotRejected as error:
        run = write_run(
            job_type,
            started_at=started_at,
            status="failed",
            summary=str(error),
            severity="warning",
            metadata={"errorCode": error.error_code, "suggestions": []},
        )
        write_deduplicated_alert(
            job_type,
            error_code=error.error_code,
            message=str(error),
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
