#!/usr/bin/env python3
"""Read-only post-cutover verification for legacy Hermes consolidation."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from boto3.dynamodb.types import TypeDeserializer

from aws_profile_contract import (
    ADMIN_PROFILE,
    AwsProfileContractError,
    verified_session,
)


EXPECTED_ACCOUNT = "915328198276"
EXPECTED_REGION = "us-west-1"
REPO_ROOT = Path(__file__).resolve().parents[2]
STACK_NAME = "market-dashboard-readiness-v2"
HEARTBEAT_TABLE = "MarketDashboardServiceHeartbeats"
RUNS_TABLE = "HermesAgentRuns"
WORKERS = {
    "quant-analyst": {
        "control": "QuantAnalystScheduleState",
        "schedule": "market-dashboard-hermes-quant-analyst-v2",
        "serviceId": "hermes:quant-analyst",
        "alarm": "market-dashboard-hermes-analyst-heartbeat-missing-v2",
    },
    "quant-developer": {
        "control": "QuantDeveloperScheduleState",
        "schedule": "market-dashboard-hermes-quant-developer-v2",
        "serviceId": "hermes:quant-developer",
        "alarm": "market-dashboard-hermes-developer-heartbeat-missing-v2",
    },
    "security": {
        "control": "SecurityScheduleState",
        "schedule": "market-dashboard-hermes-security-v2",
        "serviceId": "hermes:security",
        "alarm": "market-dashboard-hermes-security-heartbeat-missing-v2",
    },
}
GMAIL_SCHEDULE = "market-dashboard-gmail-v2-every-15m"
GMAIL_SERVICE_ID = "gmail:timsmithaviation@gmail.com"
WATCHDOG_RULE = "market-dashboard-hermes-cloud-watchdog-v1"
WATCHDOG_SERVICE_ID = "hermes:cloud-watchdog"
WORKER_FUNCTION = "market-dashboard-hermes-worker-v2"
MIN_QUIET_MINUTES = 75
DESERIALIZER = TypeDeserializer()


class VerificationFailure(RuntimeError):
    def __init__(self, code: str, message: str, *, detail: Any = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail

    def as_dict(self) -> dict[str, Any]:
        result = {"code": self.code, "message": self.message}
        if self.detail is not None:
            result["detail"] = self.detail
        return result


def parse_timestamp(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def plain_item(item: Mapping[str, Any]) -> dict[str, Any]:
    return {key: DESERIALIZER.deserialize(value) for key, value in item.items()}


def read_repository_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file() or path.is_symlink():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def valid_scheduler_heartbeat(
    rows: Sequence[Mapping[str, Any]],
    *,
    service_id: str,
    schedule_id: str,
    after: datetime,
) -> bool:
    return any(
        row.get("serviceId") == service_id
        and row.get("source") == "aws-lambda"
        and row.get("triggerSource") == "aws-scheduler"
        and row.get("scheduleId") == schedule_id
        and row.get("scheduled") is True
        and row.get("status") == "success"
        and (parse_timestamp(row.get("observedAt")) or datetime.min.replace(tzinfo=timezone.utc))
        > after
        for row in rows
    )


def valid_watchdog_heartbeat(
    rows: Sequence[Mapping[str, Any]],
    *,
    after: datetime,
) -> bool:
    return any(
        row.get("serviceId") == WATCHDOG_SERVICE_ID
        and row.get("source") == "aws-lambda"
        and row.get("triggerSource") == "aws-events"
        and row.get("ruleId") == WATCHDOG_RULE
        and row.get("scheduled") is True
        and row.get("status") == "success"
        and (parse_timestamp(row.get("observedAt")) or datetime.min.replace(tzinfo=timezone.utc))
        > after
        for row in rows
    )


def evaluate_evidence(
    evidence: Mapping[str, Any],
    *,
    cutover_at: datetime,
    now: datetime,
) -> dict[str, Any]:
    failures: list[dict[str, Any]] = []

    def fail(code: str, message: str, detail: Any = None) -> None:
        item: dict[str, Any] = {"code": code, "message": message}
        if detail is not None:
            item["detail"] = detail
        failures.append(item)

    quiet_minutes = (now - cutover_at).total_seconds() / 60
    if quiet_minutes < MIN_QUIET_MINUTES:
        fail(
            "CONSOLIDATION_QUIET_WINDOW_INCOMPLETE",
            f"Only {quiet_minutes:.1f} of {MIN_QUIET_MINUTES} required minutes elapsed.",
        )

    expected_controls = {
        "CloudWatchdogScheduleState": "ENABLED",
        "GmailScheduleState": "ENABLED",
        "QuantAnalystScheduleState": "DISABLED",
        "QuantDeveloperScheduleState": "DISABLED",
        "SecurityScheduleState": "DISABLED",
        "OperationalAlarmsState": "ENABLED",
    }
    controls = evidence.get("controls") or {}
    if any(controls.get(key) != value for key, value in expected_controls.items()):
        fail(
            "CONSOLIDATED_CONTROL_STATE_MISMATCH",
            "CloudFormation controls do not match the exact consolidated phase.",
            {"expected": expected_controls, "actual": controls},
        )

    schedules = evidence.get("schedules") or {}
    for worker, spec in WORKERS.items():
        if schedules.get(spec["schedule"]) != "DISABLED":
            fail(
                "RETIRED_WORKER_SCHEDULE_ENABLED",
                f"{worker} is not disabled.",
            )
        if (evidence.get("workerHeartbeats") or {}).get(worker):
            fail(
                "RETIRED_WORKER_HEARTBEAT_OBSERVED",
                f"{worker} emitted a heartbeat after cutover.",
            )
        if (evidence.get("workerRuns") or {}).get(worker):
            fail(
                "RETIRED_WORKER_RUN_OBSERVED",
                f"{worker} wrote a run after cutover.",
            )
    if schedules.get(GMAIL_SCHEDULE) != "ENABLED":
        fail("GMAIL_SCHEDULE_DISABLED", "Gmail ingestion is not enabled.")
    if evidence.get("watchdogRuleState") != "ENABLED":
        fail("WATCHDOG_RULE_DISABLED", "The cloud watchdog rule is not enabled.")
    if evidence.get("workerFunctionMode") != "retired":
        fail(
            "WORKER_WRITE_GUARD_INACTIVE",
            "The retained worker Lambda is not in retired/no-write mode.",
        )

    if not valid_scheduler_heartbeat(
        evidence.get("gmailHeartbeats") or [],
        service_id=GMAIL_SERVICE_ID,
        schedule_id=GMAIL_SCHEDULE,
        after=cutover_at,
    ):
        fail(
            "GMAIL_POST_CUTOVER_HEARTBEAT_MISSING",
            "No fresh successful Gmail Scheduler heartbeat exists after cutover.",
        )
    if not valid_watchdog_heartbeat(
        evidence.get("watchdogHeartbeats") or [],
        after=cutover_at,
    ):
        fail(
            "WATCHDOG_POST_CUTOVER_HEARTBEAT_MISSING",
            "No fresh successful watchdog EventBridge heartbeat exists after cutover.",
        )

    worker_alarms = evidence.get("workerAlarms") or {}
    expected_alarm_names = {spec["alarm"] for spec in WORKERS.values()}
    missing_alarms = expected_alarm_names - set(worker_alarms)
    if missing_alarms:
        fail(
            "RETIRED_WORKER_ALARM_MISSING",
            "One or more retained worker alarms could not be verified.",
            sorted(missing_alarms),
        )
    for name, alarm in worker_alarms.items():
        if alarm.get("ActionsEnabled") is not False or alarm.get("TreatMissingData") != "notBreaching":
            fail(
                "RETIRED_WORKER_ALARM_ACTIVE",
                f"{name} can still alarm for an intentionally disabled worker.",
            )

    local = evidence.get("local") or {}
    if local.get("legacyReadOnly") is not True:
        fail(
            "LEGACY_HERMES_MODE_NOT_READ_ONLY",
            "The local API did not confirm read-only legacy mode.",
        )
    if local.get("navigationConsolidated") is not True:
        fail(
            "ANALYST_NAVIGATION_NOT_CONSOLIDATED",
            "The dashboard is not configured for the single Analyst navigation entry.",
        )
    forbidden_fields = set(local.get("workflowFields") or []).intersection(
        {"hermesDirector", "hermesWorkers", "hermesAlerts", "hermesTables"}
    )
    if forbidden_fields:
        fail(
            "WORKFLOW_STATUS_EXPOSES_RETIRED_FIELDS",
            "Workflow status still exposes retired worker fields.",
            sorted(forbidden_fields),
        )
    readiness_ids = set(local.get("readinessCheckIds") or [])
    forbidden_ids = {
        "dashboard.hermes-bridge",
        "hermes.quant-analyst",
        "hermes.quant-developer",
        "hermes.security",
        "hermes.status",
        "hermes.controller",
    }
    if readiness_ids.intersection(forbidden_ids):
        fail(
            "READINESS_EXPOSES_RETIRED_CHECKS",
            "System Readiness still contains retired worker or bridge identities.",
            sorted(readiness_ids.intersection(forbidden_ids)),
        )
    for required_id in ("analyst.runtime", "readiness.controller"):
        if required_id not in readiness_ids:
            fail(
                "READINESS_CHECK_MISSING",
                f"System Readiness is missing {required_id}.",
            )
    bridge = local.get("bridge") or {}
    if not (
        bridge.get("intentionallyDisabled") is True
        and bridge.get("discoveryVerified") is True
        and bridge.get("status") == "disabled"
        and not bridge.get("pid")
    ):
        fail(
            "LOCAL_BRIDGE_NOT_VERIFIABLY_DISABLED",
            "The supervisor did not prove the bridge is intentionally disabled and idle.",
            bridge,
        )
    if local.get("legacyMutationStatus") != 410:
        fail(
            "LEGACY_MUTATION_NOT_RETIRED",
            "A legacy worker mutation endpoint did not return HTTP 410.",
        )

    return {
        "passed": not failures,
        "checkedAt": now.isoformat(),
        "cutoverAt": cutover_at.isoformat(),
        "quietMinutes": quiet_minutes,
        "failures": failures,
    }


def request_json(url: str, *, method: str = "GET", payload: Any = None) -> tuple[int, Any]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={"Accept": "application/json", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=150) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(raw)
        except ValueError:
            parsed = {"error": raw[:500]}
        return error.code, parsed


def query_after(client: Any, *, table: str, key: str, value: str, range_key: str, after: datetime) -> list[dict[str, Any]]:
    response = client.query(
        TableName=table,
        KeyConditionExpression="#partition = :partition AND #range > :after",
        ExpressionAttributeNames={"#partition": key, "#range": range_key},
        ExpressionAttributeValues={
            ":partition": {"S": value},
            ":after": {"S": after.isoformat()},
        },
        ConsistentRead=True,
    )
    return [plain_item(item) for item in response.get("Items") or []]


def collect_evidence(session: Any, *, cutover_at: datetime, base_url: str) -> dict[str, Any]:
    cloudformation = session.client("cloudformation")
    scheduler = session.client("scheduler")
    events = session.client("events")
    dynamodb = session.client("dynamodb")
    lambda_client = session.client("lambda")
    cloudwatch = session.client("cloudwatch")

    stack = cloudformation.describe_stacks(StackName=STACK_NAME)["Stacks"][0]
    controls = {
        item["ParameterKey"]: item.get("ParameterValue")
        for item in stack.get("Parameters") or []
    }
    schedules = {
        name: scheduler.get_schedule(GroupName="default", Name=name).get("State")
        for name in [GMAIL_SCHEDULE, *[spec["schedule"] for spec in WORKERS.values()]]
    }
    worker_heartbeats = {
        worker: query_after(
            dynamodb,
            table=HEARTBEAT_TABLE,
            key="serviceId",
            value=spec["serviceId"],
            range_key="observedAt",
            after=cutover_at,
        )
        for worker, spec in WORKERS.items()
    }
    worker_runs = {
        worker: query_after(
            dynamodb,
            table=RUNS_TABLE,
            key="worker",
            value=worker,
            range_key="startedAt",
            after=cutover_at,
        )
        for worker in WORKERS
    }
    gmail_heartbeats = query_after(
        dynamodb,
        table=HEARTBEAT_TABLE,
        key="serviceId",
        value=GMAIL_SERVICE_ID,
        range_key="observedAt",
        after=cutover_at,
    )
    watchdog_heartbeats = query_after(
        dynamodb,
        table=HEARTBEAT_TABLE,
        key="serviceId",
        value=WATCHDOG_SERVICE_ID,
        range_key="observedAt",
        after=cutover_at,
    )
    worker_mode = (
        lambda_client.get_function_configuration(FunctionName=WORKER_FUNCTION)
        .get("Environment", {})
        .get("Variables", {})
        .get("HERMES_WORKER_MODE")
    )
    alarm_names = [spec["alarm"] for spec in WORKERS.values()]
    alarms = cloudwatch.describe_alarms(AlarmNames=alarm_names).get("MetricAlarms") or []

    director_status, director = request_json(f"{base_url}/api/hermes/director/status")
    workflow_status, workflow = request_json(f"{base_url}/api/workflow-status")
    readiness_status, readiness = request_json(
        f"{base_url}/api/system-readiness?refresh=true"
    )
    mutation_status, _mutation = request_json(
        f"{base_url}/api/hermes/director/command",
        method="POST",
        payload={"command": "status"},
    )
    if any(status != 200 for status in (director_status, workflow_status, readiness_status)):
        raise VerificationFailure(
            "LOCAL_VERIFICATION_UNAVAILABLE",
            "One or more local verification APIs did not return HTTP 200.",
            detail={
                "director": director_status,
                "workflow": workflow_status,
                "readiness": readiness_status,
            },
        )
    state_path = Path.home() / "Library/Application Support/market-dashboard/dev-stack.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    repository_env = read_repository_env(REPO_ROOT / ".env")
    readiness_ids = [
        check.get("id")
        for group in readiness.get("groups") or []
        for check in group.get("checks") or []
    ]
    return {
        "controls": controls,
        "schedules": schedules,
        "watchdogRuleState": events.describe_rule(Name=WATCHDOG_RULE).get("State"),
        "workerHeartbeats": worker_heartbeats,
        "workerRuns": worker_runs,
        "gmailHeartbeats": gmail_heartbeats,
        "watchdogHeartbeats": watchdog_heartbeats,
        "workerFunctionMode": worker_mode,
        "workerAlarms": {alarm["AlarmName"]: alarm for alarm in alarms},
        "local": {
            "legacyReadOnly": director.get("readOnly") is True,
            "navigationConsolidated": (
                repository_env.get("REACT_APP_ANALYST_SHADOW_MODE", "true").lower()
                == "false"
            ),
            "workflowFields": sorted(workflow),
            "readinessCheckIds": readiness_ids,
            "bridge": (state.get("children") or {}).get("bridge") or {},
            "legacyMutationStatus": mutation_status,
        },
    }


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cutover-at", required=True, help="Exact ISO cutover timestamp.")
    parser.add_argument("--admin-profile", default=ADMIN_PROFILE)
    parser.add_argument("--region", default=EXPECTED_REGION)
    parser.add_argument("--base-url", default="http://127.0.0.1:3001")
    args = parser.parse_args(argv)
    if args.admin_profile != ADMIN_PROFILE:
        parser.error(f"--admin-profile must be {ADMIN_PROFILE}")
    if args.region != EXPECTED_REGION:
        parser.error(f"--region must be {EXPECTED_REGION}")
    if parse_timestamp(args.cutover_at) is None:
        parser.error("--cutover-at must be an ISO timestamp")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        session = verified_session(
            args.admin_profile,
            purpose="admin",
            region=args.region,
        )
        cutover_at = parse_timestamp(args.cutover_at)
        assert cutover_at is not None
        evidence = collect_evidence(
            session,
            cutover_at=cutover_at,
            base_url=args.base_url.rstrip("/"),
        )
        report = evaluate_evidence(
            evidence,
            cutover_at=cutover_at,
            now=datetime.now(timezone.utc),
        )
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0 if report["passed"] else 2
    except AwsProfileContractError as error:
        failure = VerificationFailure(error.error_code, error.detail)
    except VerificationFailure as error:
        failure = error
    except Exception as error:
        failure = VerificationFailure(
            "CONSOLIDATION_VERIFICATION_FAILED",
            str(error)[:500],
        )
    print(json.dumps({"passed": False, "error": failure.as_dict()}, indent=2), file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
