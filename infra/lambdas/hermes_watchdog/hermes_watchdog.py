#!/usr/bin/env python3
"""Independent, read-only cloud control-plane watchdog.

The watchdog observes the deployed CloudFormation controls, EventBridge
Scheduler state, Lambda telemetry, the runtime-failure queue, and typed
scheduled heartbeats. It never changes schedules, IAM, deployments, queues,
or application data. Its only writes are typed watchdog heartbeats,
deduplicated alert lifecycle rows, bounded SNS notifications, and readiness
metrics.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, Mapping, Optional

import boto3
from boto3.dynamodb.types import TypeDeserializer, TypeSerializer
from botocore.config import Config


AWS_REGION = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-west-1"))
BUILD_VERSION = os.environ.get("BUILD_VERSION", "development")
STACK_NAME = os.environ.get("WATCHDOG_STACK_NAME", "market-dashboard-readiness-v2")
RULE_ID = os.environ.get(
    "WATCHDOG_RULE_ID", "market-dashboard-hermes-cloud-watchdog-v1"
)
WATCHDOG_SERVICE_ID = os.environ.get(
    "WATCHDOG_SERVICE_ID", "hermes:cloud-watchdog"
)
HEARTBEAT_TABLE = os.environ.get(
    "SERVICE_HEARTBEAT_TABLE", "MarketDashboardServiceHeartbeats"
)
ALERTS_TABLE = os.environ.get("HERMES_ALERTS_TABLE", "HermesAlerts")
OPERATIONS_TOPIC_ARN = os.environ.get("HERMES_OPERATIONS_TOPIC_ARN", "")
FAILURE_QUEUE_URL = os.environ.get("RUNTIME_FAILURE_QUEUE_URL", "")
FAILURE_QUEUE_NAME = os.environ.get(
    "RUNTIME_FAILURE_QUEUE_NAME", "market-dashboard-runtime-failures-v2"
)
HEARTBEAT_TTL_DAYS = int(os.environ.get("SERVICE_HEARTBEAT_TTL_DAYS", "90"))
METRIC_LOOKBACK_MINUTES = int(os.environ.get("WATCHDOG_METRIC_LOOKBACK_MINUTES", "20"))
MAX_CLOCK_SKEW_SECONDS = int(os.environ.get("WATCHDOG_MAX_CLOCK_SKEW_SECONDS", "300"))
ALERT_ESCALATION_OBSERVATIONS = max(
    2, int(os.environ.get("HERMES_ALERT_ESCALATION_OBSERVATIONS", "3"))
)
MAX_ACTIVE_ALERT_ROOTS = 32
MAX_KNOWN_ALERT_ROOTS = 64
MAX_SNS_MESSAGE_BYTES = 4096


SCHEDULE_SPECS = (
    {
        "controlParameter": "GmailScheduleState",
        "name": os.environ.get(
            "GMAIL_SCHEDULE_ID", "market-dashboard-gmail-v2-every-15m"
        ),
        "serviceId": os.environ.get(
            "GMAIL_HEARTBEAT_SERVICE_ID", "gmail:timsmithaviation@gmail.com"
        ),
        "cadenceMinutes": 15,
    },
    {
        "controlParameter": "QuantAnalystScheduleState",
        "name": os.environ.get(
            "QUANT_ANALYST_SCHEDULE_ID",
            "market-dashboard-hermes-quant-analyst-v2",
        ),
        "serviceId": os.environ.get(
            "QUANT_ANALYST_HEARTBEAT_SERVICE_ID", "hermes:quant-analyst"
        ),
        "cadenceMinutes": 15,
    },
    {
        "controlParameter": "QuantDeveloperScheduleState",
        "name": os.environ.get(
            "QUANT_DEVELOPER_SCHEDULE_ID",
            "market-dashboard-hermes-quant-developer-v2",
        ),
        "serviceId": os.environ.get(
            "QUANT_DEVELOPER_HEARTBEAT_SERVICE_ID", "hermes:quant-developer"
        ),
        "cadenceMinutes": 15,
    },
    {
        "controlParameter": "SecurityScheduleState",
        "name": os.environ.get(
            "SECURITY_SCHEDULE_ID", "market-dashboard-hermes-security-v2"
        ),
        "serviceId": os.environ.get(
            "SECURITY_HEARTBEAT_SERVICE_ID", "hermes:security"
        ),
        "cadenceMinutes": 60,
    },
)

FUNCTION_SPECS = (
    {
        "key": "gmail",
        "name": os.environ.get(
            "GMAIL_FUNCTION_NAME", "market-dashboard-gmail-ingestor-v2"
        ),
        "timeoutMs": 300_000,
    },
    {
        "key": "pdf",
        "name": os.environ.get(
            "PDF_PROCESSOR_FUNCTION_NAME",
            "market-dashboard-hedgeye-pdf-processor-v1",
        ),
        "timeoutMs": 900_000,
    },
    {
        "key": "hermes",
        "name": os.environ.get(
            "HERMES_WORKER_FUNCTION_NAME", "market-dashboard-hermes-worker-v2"
        ),
        "timeoutMs": 60_000,
    },
    {
        "key": "watchdog",
        "name": os.environ.get(
            "WATCHDOG_FUNCTION_NAME", "market-dashboard-hermes-cloud-watchdog-v1"
        ),
        "timeoutMs": 120_000,
    },
)

CONTROL_PARAMETERS = frozenset(
    {
        *(spec["controlParameter"] for spec in SCHEDULE_SPECS),
        "CloudWatchdogScheduleState",
        "OperationalAlarmsState",
        "ReservedConcurrencyState",
    }
)
STABLE_STACK_STATUSES = frozenset({"CREATE_COMPLETE", "UPDATE_COMPLETE"})
HEALTHY_HEARTBEAT_STATUSES = frozenset({"success", "in_progress"})


CLIENT_CONFIG = Config(
    connect_timeout=3,
    read_timeout=10,
    retries={"max_attempts": 2, "mode": "standard"},
    tcp_keepalive=True,
)
cloudformation = boto3.client(
    "cloudformation", region_name=AWS_REGION, config=CLIENT_CONFIG
)
scheduler = boto3.client("scheduler", region_name=AWS_REGION, config=CLIENT_CONFIG)
cloudwatch = boto3.client("cloudwatch", region_name=AWS_REGION, config=CLIENT_CONFIG)
sqs = boto3.client("sqs", region_name=AWS_REGION, config=CLIENT_CONFIG)
dynamodb = boto3.client("dynamodb", region_name=AWS_REGION, config=CLIENT_CONFIG)
sns = boto3.client("sns", region_name=AWS_REGION, config=CLIENT_CONFIG)
serializer = TypeSerializer()
deserializer = TypeDeserializer()


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


def to_dynamodb_item(item: Mapping[str, Any]) -> Dict[str, Any]:
    return {key: serializer.serialize(value) for key, value in item.items()}


def from_dynamodb_item(item: Mapping[str, Any]) -> Dict[str, Any]:
    return {key: deserializer.deserialize(value) for key, value in item.items()}


def _error_code(error: Exception) -> str:
    response = getattr(error, "response", None)
    if isinstance(response, Mapping):
        details = response.get("Error")
        if isinstance(details, Mapping) and details.get("Code"):
            return str(details["Code"])
    return type(error).__name__


def add_finding(
    findings: list[Dict[str, str]],
    code: str,
    detail: str,
    *,
    component: str,
) -> None:
    if any(
        finding["errorCode"] == code and finding["component"] == component
        for finding in findings
    ):
        return
    findings.append(
        {
            "errorCode": code,
            "component": component,
            "detail": detail[:500],
        }
    )


def inspect_stack(findings: list[Dict[str, str]]) -> Dict[str, Any]:
    try:
        response = cloudformation.describe_stacks(StackName=STACK_NAME)
    except Exception as error:  # AWS failures become typed watchdog findings.
        add_finding(
            findings,
            "CLOUDFORMATION_CONTROL_READ_FAILED",
            f"Could not read the exact readiness stack ({_error_code(error)}).",
            component="cloudformation",
        )
        return {"name": STACK_NAME, "status": "unavailable", "controls": {}}

    stacks = response.get("Stacks") or []
    if len(stacks) != 1:
        add_finding(
            findings,
            "CLOUDFORMATION_STACK_CARDINALITY_INVALID",
            f"Expected exactly one readiness stack, found {len(stacks)}.",
            component="cloudformation",
        )
        return {"name": STACK_NAME, "status": "invalid", "controls": {}}

    stack = stacks[0]
    stack_name = str(stack.get("StackName") or "")
    stack_id = str(stack.get("StackId") or "")
    status = str(stack.get("StackStatus") or "UNKNOWN")
    expected_stack_path = f":stack/{STACK_NAME}/"
    if stack_name != STACK_NAME or expected_stack_path not in stack_id:
        add_finding(
            findings,
            "CLOUDFORMATION_STACK_IDENTITY_INVALID",
            "CloudFormation returned a stack outside the exact configured name.",
            component="cloudformation",
        )
    if status not in STABLE_STACK_STATUSES:
        add_finding(
            findings,
            "CLOUDFORMATION_STACK_NOT_STABLE",
            f"The readiness stack is {status}, not CREATE_COMPLETE or UPDATE_COMPLETE.",
            component="cloudformation",
        )

    all_parameters = {
        str(parameter.get("ParameterKey")): str(parameter.get("ParameterValue"))
        for parameter in stack.get("Parameters") or []
        if parameter.get("ParameterKey")
    }
    controls: Dict[str, str] = {}
    for name in sorted(CONTROL_PARAMETERS):
        value = all_parameters.get(name)
        if value not in {"ENABLED", "DISABLED"}:
            add_finding(
                findings,
                "CLOUDFORMATION_CONTROL_INVALID",
                f"{name} is missing or is not ENABLED/DISABLED.",
                component=f"cloudformation:{name}",
            )
            continue
        controls[name] = value

    return {
        "name": STACK_NAME,
        "stackId": stack_id,
        "status": status,
        "controls": controls,
    }


def inspect_schedules(
    controls: Mapping[str, str],
    findings: list[Dict[str, str]],
) -> Dict[str, Dict[str, Any]]:
    states: Dict[str, Dict[str, Any]] = {}
    for spec in SCHEDULE_SPECS:
        name = str(spec["name"])
        desired = controls.get(str(spec["controlParameter"]))
        try:
            response = scheduler.get_schedule(GroupName="default", Name=name)
        except Exception as error:
            code = _error_code(error)
            finding_code = (
                "SCHEDULER_RESOURCE_MISSING"
                if code == "ResourceNotFoundException"
                else "SCHEDULER_STATE_READ_FAILED"
            )
            add_finding(
                findings,
                finding_code,
                f"Could not read Scheduler state for {name} ({code}).",
                component=f"scheduler:{name}",
            )
            states[name] = {
                "desired": desired or "UNKNOWN",
                "actual": "MISSING" if finding_code.endswith("MISSING") else "UNAVAILABLE",
                "heartbeatRequired": False,
            }
            continue

        actual = str(response.get("State") or "UNKNOWN")
        state = {
            "desired": desired or "UNKNOWN",
            "actual": actual,
            "heartbeatRequired": desired == "ENABLED" and actual == "ENABLED",
        }
        states[name] = state
        if desired and actual != desired:
            add_finding(
                findings,
                "SCHEDULER_STATE_DRIFT",
                f"{name} is {actual}; CloudFormation requires {desired}.",
                component=f"scheduler:{name}",
            )
        elif desired == "DISABLED":
            state["reason"] = "intentionally-disabled"
    return states


def inspect_heartbeats(
    schedules: Mapping[str, Mapping[str, Any]],
    findings: list[Dict[str, str]],
    *,
    now: datetime,
) -> Dict[str, Dict[str, Any]]:
    results: Dict[str, Dict[str, Any]] = {}
    for spec in SCHEDULE_SPECS:
        name = str(spec["name"])
        state = schedules.get(name) or {}
        service_id = str(spec["serviceId"])
        if not state.get("heartbeatRequired"):
            results[service_id] = {
                "required": False,
                "status": "not-required",
                "reason": state.get("reason") or "schedule-not-enabled",
            }
            continue

        try:
            response = dynamodb.query(
                TableName=HEARTBEAT_TABLE,
                KeyConditionExpression="serviceId = :service_id",
                ExpressionAttributeValues={":service_id": {"S": service_id}},
                ScanIndexForward=False,
                ConsistentRead=True,
                Limit=1,
            )
        except Exception as error:
            add_finding(
                findings,
                "SCHEDULED_HEARTBEAT_READ_FAILED",
                f"Could not read the latest heartbeat for {service_id} ({_error_code(error)}).",
                component=f"heartbeat:{service_id}",
            )
            results[service_id] = {"required": True, "status": "unavailable"}
            continue

        rows = response.get("Items") or []
        if not rows:
            add_finding(
                findings,
                "SCHEDULED_HEARTBEAT_MISSING",
                f"No typed Scheduler heartbeat exists for enabled service {service_id}.",
                component=f"heartbeat:{service_id}",
            )
            results[service_id] = {"required": True, "status": "missing"}
            continue

        heartbeat = from_dynamodb_item(rows[0])
        observed = parse_timestamp(heartbeat.get("observedAt"))
        age_seconds = (now - observed).total_seconds() if observed else None
        max_age_seconds = (int(spec["cadenceMinutes"]) * 2 + 5) * 60
        result = {
            "required": True,
            "status": heartbeat.get("status"),
            "observedAt": heartbeat.get("observedAt"),
            "ageSeconds": age_seconds,
            "errorCode": heartbeat.get("errorCode"),
        }
        results[service_id] = result

        provenance_valid = (
            heartbeat.get("serviceId") == service_id
            and heartbeat.get("source") == "aws-lambda"
            and heartbeat.get("scheduled") is True
            and heartbeat.get("triggerSource") == "aws-scheduler"
            and heartbeat.get("scheduleId") == name
        )
        if not provenance_valid:
            add_finding(
                findings,
                "SCHEDULED_HEARTBEAT_PROVENANCE_INVALID",
                f"The latest {service_id} heartbeat was not emitted by exact schedule {name}.",
                component=f"heartbeat:{service_id}",
            )
            continue
        if (
            age_seconds is None
            or age_seconds < -MAX_CLOCK_SKEW_SECONDS
            or age_seconds > max_age_seconds
        ):
            add_finding(
                findings,
                "SCHEDULED_HEARTBEAT_STALE",
                f"The latest {service_id} heartbeat is missing, future-dated, or older than "
                f"{max_age_seconds} seconds.",
                component=f"heartbeat:{service_id}",
            )
            continue
        # The worker owns readiness/root-cause publications. Re-emitting its
        # heartbeat error code from this watchdog created duplicate incidents.
        # The watchdog remains responsible for missing, stale, and provenance
        # failures above; the dashboard retains the worker status here.
    return results


def _metric_query(
    query_id: str,
    namespace: str,
    metric_name: str,
    dimension_name: str,
    dimension_value: str,
    statistic: str,
) -> Dict[str, Any]:
    return {
        "Id": query_id,
        "MetricStat": {
            "Metric": {
                "Namespace": namespace,
                "MetricName": metric_name,
                "Dimensions": [{"Name": dimension_name, "Value": dimension_value}],
            },
            "Period": 300,
            "Stat": statistic,
        },
        "ReturnData": True,
    }


def inspect_cloudwatch_metrics(
    findings: list[Dict[str, str]],
    *,
    now: datetime,
    controls: Optional[Mapping[str, str]] = None,
) -> tuple[Dict[str, Dict[str, Any]], Optional[float]]:
    worker_controls = (
        "QuantAnalystScheduleState",
        "QuantDeveloperScheduleState",
        "SecurityScheduleState",
    )
    worker_function_retired = bool(controls) and all(
        controls.get(name) == "DISABLED" for name in worker_controls
    )
    queries: list[Dict[str, Any]] = []
    for spec in FUNCTION_SPECS:
        key = str(spec["key"])
        name = str(spec["name"])
        queries.extend(
            (
                _metric_query(
                    f"{key}_invocations",
                    "AWS/Lambda",
                    "Invocations",
                    "FunctionName",
                    name,
                    "Sum",
                ),
                _metric_query(
                    f"{key}_errors",
                    "AWS/Lambda",
                    "Errors",
                    "FunctionName",
                    name,
                    "Sum",
                ),
                _metric_query(
                    f"{key}_duration",
                    "AWS/Lambda",
                    "Duration",
                    "FunctionName",
                    name,
                    "Maximum",
                ),
            )
        )
    queries.append(
        _metric_query(
            "queue_age",
            "AWS/SQS",
            "ApproximateAgeOfOldestMessage",
            "QueueName",
            FAILURE_QUEUE_NAME,
            "Maximum",
        )
    )

    try:
        response = cloudwatch.get_metric_data(
            MetricDataQueries=queries,
            StartTime=now - timedelta(minutes=METRIC_LOOKBACK_MINUTES),
            EndTime=now,
            ScanBy="TimestampDescending",
        )
    except Exception as error:
        add_finding(
            findings,
            "CLOUDWATCH_TELEMETRY_READ_FAILED",
            f"Could not read Lambda or queue metrics ({_error_code(error)}).",
            component="cloudwatch",
        )
        return {
            str(spec["name"]): {"status": "unavailable"} for spec in FUNCTION_SPECS
        }, None

    values_by_id: Dict[str, list[float]] = {}
    for result in response.get("MetricDataResults") or []:
        values_by_id[str(result.get("Id"))] = [
            float(value) for value in result.get("Values") or []
        ]

    functions: Dict[str, Dict[str, Any]] = {}
    for spec in FUNCTION_SPECS:
        key = str(spec["key"])
        name = str(spec["name"])
        invocations = sum(values_by_id.get(f"{key}_invocations", []))
        errors = sum(values_by_id.get(f"{key}_errors", []))
        duration_values = values_by_id.get(f"{key}_duration", [])
        max_duration = max(duration_values) if duration_values else None
        function = {
            "invocations": invocations,
            "errors": errors,
            "maximumDurationMs": max_duration,
            "timeoutMs": int(spec["timeoutMs"]),
        }
        if key == "hermes" and worker_function_retired:
            function.update(
                {
                    "status": "retired",
                    "invocationExpected": False,
                    "reason": "all-worker-schedules-intentionally-disabled",
                }
            )
            functions[name] = function
            continue
        functions[name] = function
        near_timeout = (
            max_duration is not None
            and max_duration >= int(spec["timeoutMs"]) * 0.95
        )
        if errors > 0 and near_timeout:
            timeout_code = (
                "GMAIL_INVOCATION_TIMEOUT"
                if key == "gmail"
                else "LAMBDA_INVOCATION_TIMEOUT"
            )
            add_finding(
                findings,
                timeout_code,
                f"{name} reported {errors:g} error(s) and a {max_duration:g} ms "
                f"maximum duration against its {int(spec['timeoutMs'])} ms timeout.",
                component=f"lambda:{name}",
            )
        elif errors > 0:
            add_finding(
                findings,
                "LAMBDA_INVOCATION_ERRORS",
                f"{name} reported {errors:g} Lambda error(s) in the last "
                f"{METRIC_LOOKBACK_MINUTES} minutes.",
                component=f"lambda:{name}",
            )
        elif near_timeout:
            near_timeout_code = (
                "GMAIL_INVOCATION_NEAR_TIMEOUT"
                if key == "gmail"
                else "LAMBDA_DURATION_NEAR_TIMEOUT"
            )
            add_finding(
                findings,
                near_timeout_code,
                f"{name} maximum duration was {max_duration:g} ms against a "
                f"{int(spec['timeoutMs'])} ms timeout.",
                component=f"lambda:{name}",
            )

    queue_age_values = values_by_id.get("queue_age", [])
    queue_age = max(queue_age_values) if queue_age_values else None
    return functions, queue_age


def inspect_failure_queue(
    findings: list[Dict[str, str]],
    *,
    oldest_age_seconds: Optional[float],
) -> Dict[str, Any]:
    if not FAILURE_QUEUE_URL:
        add_finding(
            findings,
            "RUNTIME_FAILURE_QUEUE_CONFIGURATION_MISSING",
            "The watchdog does not have the exact runtime-failure queue URL.",
            component="sqs",
        )
        return {"status": "unavailable", "oldestAgeSeconds": oldest_age_seconds}

    try:
        response = sqs.get_queue_attributes(
            QueueUrl=FAILURE_QUEUE_URL,
            AttributeNames=[
                "ApproximateNumberOfMessages",
                "ApproximateNumberOfMessagesNotVisible",
                "ApproximateNumberOfMessagesDelayed",
            ],
        )
    except Exception as error:
        add_finding(
            findings,
            "RUNTIME_FAILURE_QUEUE_READ_FAILED",
            f"Could not read runtime-failure queue depth ({_error_code(error)}).",
            component="sqs",
        )
        return {"status": "unavailable", "oldestAgeSeconds": oldest_age_seconds}

    attributes = response.get("Attributes") or {}
    visible = int(attributes.get("ApproximateNumberOfMessages") or 0)
    in_flight = int(attributes.get("ApproximateNumberOfMessagesNotVisible") or 0)
    delayed = int(attributes.get("ApproximateNumberOfMessagesDelayed") or 0)
    total = visible + in_flight + delayed
    normalized_age = (
        oldest_age_seconds
        if oldest_age_seconds is not None
        else 0.0 if total == 0 else None
    )
    result = {
        "status": "backlog" if total else "empty",
        "visible": visible,
        "inFlight": in_flight,
        "delayed": delayed,
        "total": total,
        "oldestAgeSeconds": normalized_age,
    }
    if total:
        age_detail = (
            f"{normalized_age:g} seconds"
            if normalized_age is not None
            else "unavailable"
        )
        add_finding(
            findings,
            "RUNTIME_FAILURE_QUEUE_BACKLOG",
            f"The runtime-failure queue contains {total} message(s); oldest age is "
            f"{age_detail}.",
            component="sqs",
        )
    return result


def write_watchdog_metrics(
    *,
    service_id: str,
    healthy: bool,
    finding_count: int,
    queue: Mapping[str, Any],
    observed_at: datetime,
) -> None:
    metric_data = [
        {
            "MetricName": "Heartbeat",
            "Dimensions": [{"Name": "ServiceId", "Value": service_id}],
            "Timestamp": observed_at,
            "Value": 1,
            "Unit": "Count",
        },
        {
            "MetricName": "Healthy",
            "Dimensions": [{"Name": "ServiceId", "Value": service_id}],
            "Timestamp": observed_at,
            "Value": 1 if healthy else 0,
            "Unit": "Count",
        },
        {
            "MetricName": "WatchdogFindingCount",
            "Dimensions": [{"Name": "ServiceId", "Value": service_id}],
            "Timestamp": observed_at,
            "Value": finding_count,
            "Unit": "Count",
        },
        {
            "MetricName": "RuntimeFailureQueueDepth",
            "Dimensions": [{"Name": "ServiceId", "Value": service_id}],
            "Timestamp": observed_at,
            "Value": int(queue.get("total") or 0),
            "Unit": "Count",
        },
    ]
    oldest_age = queue.get("oldestAgeSeconds")
    if oldest_age is not None:
        metric_data.append(
            {
                "MetricName": "RuntimeFailureQueueOldestAgeSeconds",
                "Dimensions": [{"Name": "ServiceId", "Value": service_id}],
                "Timestamp": observed_at,
                "Value": float(oldest_age),
                "Unit": "Seconds",
            }
        )
    cloudwatch.put_metric_data(
        Namespace="MarketDashboard/Readiness",
        MetricData=metric_data,
    )


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


def watchdog_alert_id(error_code: str) -> str:
    return f"cloud-watchdog#runtime-health#{alert_root_token(error_code)}"


def watchdog_alert_state_id() -> str:
    return "cloud-watchdog#runtime-health#STATE"


def read_watchdog_alert_state() -> Dict[str, Any]:
    response = dynamodb.get_item(
        TableName=ALERTS_TABLE,
        Key=to_dynamodb_item({"alertId": watchdog_alert_state_id()}),
        ConsistentRead=True,
    )
    raw_item = response.get("Item")
    item = from_dynamodb_item(raw_item) if raw_item else {}
    active: Dict[str, Dict[str, Any]] = {}
    for entry in item.get("activeRoots") or []:
        if not isinstance(entry, Mapping):
            continue
        error_code = canonical_alert_root(entry.get("errorCode"))
        active[error_code] = {
            "errorCode": error_code,
            "component": str(entry.get("component") or "watchdog"),
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


def read_watchdog_root_alert(error_code: str) -> Optional[Dict[str, Any]]:
    response = dynamodb.get_item(
        TableName=ALERTS_TABLE,
        Key=to_dynamodb_item({"alertId": watchdog_alert_id(error_code)}),
        ConsistentRead=True,
    )
    raw_item = response.get("Item")
    return from_dynamodb_item(raw_item) if raw_item else None


def write_watchdog_alert_state(
    active_roots: Mapping[str, Mapping[str, Any]],
    *,
    known_roots: Iterable[str],
    source_run_id: str,
    observed_at: str,
    notification_failures: Optional[list[Mapping[str, str]]] = None,
) -> None:
    item = {
        "alertId": watchdog_alert_state_id(),
        "worker": "cloud-watchdog",
        "severity": "info",
        "status": "resolved",
        "type": "cloud-control-health-state",
        "dedupeKey": "cloud-watchdog#runtime-health-state",
        "title": "Cloud watchdog alert lifecycle state",
        "message": f"{len(active_roots)} active root cause(s) are tracked.",
        "sourceRunId": source_run_id,
        "channels": ["dashboard"],
        "details": {
            "stateVersion": 2,
            "notificationFailures": list(notification_failures or [])[:MAX_ACTIVE_ALERT_ROOTS],
        },
        "knownRoots": sorted(set(known_roots)),
        "activeRoots": [
            {
                "errorCode": error_code,
                "component": str(entry.get("component") or "watchdog"),
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
    dynamodb.put_item(
        TableName=ALERTS_TABLE,
        Item=to_dynamodb_item(item),
    )


def write_watchdog_root_alert(
    *,
    error_code: str,
    component: str,
    message: str,
    source_run_id: str,
    status: str,
    transition: str,
    observed_at: str,
    opened_at: Optional[str] = None,
    observation_count: int = 1,
) -> None:
    resolved = status == "resolved"
    item: Dict[str, Any] = {
        "alertId": watchdog_alert_id(error_code),
        "worker": "cloud-watchdog",
        "severity": "info" if resolved else "warning",
        "status": status,
        "type": "cloud-control-health",
        "dedupeKey": f"cloud-watchdog#{error_code}",
        "title": (
            "Cloud reliability watchdog recovered"
            if resolved
            else "Cloud reliability watchdog detected degraded controls"
        ),
        "message": message[:1000],
        "recommendedAction": (
            None
            if resolved
            else "Inspect the named control-plane root cause; mutation remains operator-approved."
        ),
        "sourceRunId": source_run_id,
        "channels": ["dashboard", "sns"],
        "details": {
            "errorCode": error_code,
            "component": component,
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
    dynamodb.put_item(
        TableName=ALERTS_TABLE,
        Item=to_dynamodb_item(item),
    )


def publish_lifecycle_notification(
    *,
    error_code: str,
    event_type: str,
    message: str,
    source_run_id: str,
    observed_at: str,
) -> bool:
    if not OPERATIONS_TOPIC_ARN:
        return False
    service = "cloud-watchdog"
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
        raise RuntimeError("Watchdog lifecycle notification exceeded its bounded SNS payload.")
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


def write_watchdog_alert(
    findings: Iterable[Mapping[str, str]],
    *,
    observed_at: datetime,
) -> Dict[str, Any]:
    current: Dict[str, Mapping[str, str]] = {}
    for finding in findings:
        error_code = canonical_alert_root(finding.get("errorCode"))
        current.setdefault(error_code, finding)
    if len(current) > MAX_ACTIVE_ALERT_ROOTS:
        raise RuntimeError(
            f"Watchdog alert root count {len(current)} exceeds the bounded "
            f"limit of {MAX_ACTIVE_ALERT_ROOTS}."
        )

    now = observed_at.isoformat()
    source_run_id = f"cloud-watchdog#{now}"
    state = read_watchdog_alert_state()
    previous_known = set(state["known"])
    preflight_known = previous_known | set(current)
    if len(preflight_known) > MAX_KNOWN_ALERT_ROOTS:
        raise RuntimeError(
            f"Watchdog known alert root count {len(preflight_known)} exceeds "
            f"the bounded limit of {MAX_KNOWN_ALERT_ROOTS}."
        )
    write_watchdog_alert_state(
        {
            error_code: {
                "component": str(finding.get("component") or "watchdog"),
                "openedAt": now,
                "observationCount": 1,
                "escalated": False,
            }
            for error_code, finding in current.items()
        },
        known_roots=preflight_known,
        source_run_id=source_run_id,
        observed_at=now,
    )

    next_active: Dict[str, Dict[str, Any]] = {}
    transitions: list[Dict[str, str]] = []
    notification_failures: list[Dict[str, str]] = []

    for error_code, finding in current.items():
        component = str(finding.get("component") or "watchdog")[:200]
        detail = str(finding.get("detail") or "Cloud control root cause is active.")[:500]
        message = f"{component}: {error_code} ({detail})"
        root_item = read_watchdog_root_alert(error_code)
        if not root_item or root_item.get("status") != "open":
            event_type = (
                "circuit_opened"
                if "CIRCUIT_OPEN" in error_code
                else "incident_opened"
            )
            write_watchdog_root_alert(
                error_code=error_code,
                component=component,
                message=message,
                source_run_id=source_run_id,
                status="open",
                transition=event_type,
                observed_at=now,
            )
            # Opening is dashboard-only. Publication begins after escalation.
            transitions.append({"eventType": event_type, "errorCode": error_code})
            next_active[error_code] = {
                "component": component,
                "openedAt": now,
                "observationCount": 1,
                "escalated": False,
            }
            continue

        root_details = (
            root_item.get("details")
            if isinstance(root_item.get("details"), Mapping)
            else {}
        )
        observation_count = int(root_details.get("observationCount") or 1) + 1
        escalated = bool(
            root_item.get("escalatedAt")
            or root_details.get("transition") == "incident_escalated"
        )
        opened_at = str(root_item.get("createdAt") or now)
        if observation_count >= ALERT_ESCALATION_OBSERVATIONS and not escalated:
            write_watchdog_root_alert(
                error_code=error_code,
                component=component,
                message=message,
                source_run_id=source_run_id,
                status="open",
                transition="incident_escalated",
                observed_at=now,
                opened_at=opened_at,
                observation_count=observation_count,
            )
            notification_failure = try_publish_lifecycle_notification(
                error_code=error_code,
                event_type="incident_escalated",
                message=message,
                source_run_id=source_run_id,
                observed_at=now,
            )
            if notification_failure:
                notification_failures.append(notification_failure)
            transitions.append(
                {"eventType": "incident_escalated", "errorCode": error_code}
            )
            escalated = True
        elif not escalated:
            write_watchdog_root_alert(
                error_code=error_code,
                component=component,
                message=message,
                source_run_id=source_run_id,
                status="open",
                transition=str(root_details.get("transition") or "incident_opened"),
                observed_at=now,
                opened_at=opened_at,
                observation_count=observation_count,
            )
        next_active[error_code] = {
            "component": component,
            "openedAt": opened_at,
            "observationCount": observation_count,
            "escalated": escalated,
        }

    for error_code in preflight_known:
        if error_code in current:
            continue
        root_item = read_watchdog_root_alert(error_code)
        if not root_item or root_item.get("status") != "open":
            continue
        root_details = (
            root_item.get("details")
            if isinstance(root_item.get("details"), Mapping)
            else {}
        )
        component = str(root_details.get("component") or "watchdog")
        message = f"{component} recovered from root cause {error_code}."
        write_watchdog_root_alert(
            error_code=error_code,
            component=component,
            message=message,
            source_run_id=source_run_id,
            status="resolved",
            transition="incident_recovered",
            observed_at=now,
            opened_at=str(root_item.get("createdAt") or now),
            observation_count=int(root_details.get("observationCount") or 1),
        )
        was_escalated = bool(
            root_item.get("escalatedAt")
            or root_details.get("transition") == "incident_escalated"
        )
        if was_escalated:
            notification_failure = try_publish_lifecycle_notification(
                error_code=error_code,
                event_type="incident_recovered",
                message=message,
                source_run_id=source_run_id,
                observed_at=now,
            )
            if notification_failure:
                notification_failures.append(notification_failure)
        transitions.append(
            {"eventType": "incident_recovered", "errorCode": error_code}
        )

    write_watchdog_alert_state(
        next_active,
        known_roots=set(current),
        source_run_id=source_run_id,
        observed_at=now,
        notification_failures=notification_failures,
    )
    return {
        "activeRoots": sorted(next_active),
        "transitions": transitions,
        "notificationFailures": notification_failures,
    }


def write_watchdog_heartbeat(
    *,
    started_at: str,
    observed_at: datetime,
    service_id: str,
    scheduled: bool,
    trigger_source: str,
    rule_id: Optional[str],
    findings: list[Mapping[str, str]],
    checks: Mapping[str, Any],
) -> None:
    item: Dict[str, Any] = {
        "serviceId": service_id,
        "observedAt": observed_at.isoformat(),
        "startedAt": started_at,
        "finishedAt": observed_at.isoformat(),
        "status": "success" if not findings else "warning",
        "source": "aws-lambda",
        "triggerSource": trigger_source,
        "ruleId": rule_id,
        "scheduled": scheduled,
        "buildVersion": BUILD_VERSION,
        "counts": {
            "findings": len(findings),
            "schedules": len(checks.get("schedules") or {}),
            "functions": len(checks.get("functions") or {}),
            "queueDepth": int((checks.get("failureQueue") or {}).get("total") or 0),
        },
        "findings": findings[:20],
        "ttl": int(observed_at.timestamp() + HEARTBEAT_TTL_DAYS * 86400),
    }
    if findings:
        item["errorCode"] = findings[0]["errorCode"]
        item["detail"] = findings[0]["detail"]
    dynamodb.put_item(
        TableName=HEARTBEAT_TABLE,
        Item=to_dynamodb_item(item),
    )


def lambda_handler(event: Optional[Dict[str, Any]], context: Any) -> Dict[str, Any]:
    del context
    event = event or {}
    started = utc_now()
    started_at = started.isoformat()
    trigger_source = str(event.get("source") or "manual")
    rule_id = str(event.get("ruleId") or "") or None
    scheduled = trigger_source == "aws-events" and rule_id == RULE_ID
    service_id = WATCHDOG_SERVICE_ID if scheduled else f"{WATCHDOG_SERVICE_ID}:manual"
    findings: list[Dict[str, str]] = []

    stack = inspect_stack(findings)
    watchdog_desired = (stack.get("controls") or {}).get(
        "CloudWatchdogScheduleState"
    )
    if scheduled and watchdog_desired != "ENABLED":
        add_finding(
            findings,
            "WATCHDOG_EVENT_RULE_STATE_DRIFT",
            "The watchdog was invoked by its rule while CloudFormation requires it disabled.",
            component=f"events:{RULE_ID}",
        )
    elif not scheduled and watchdog_desired == "ENABLED":
        add_finding(
            findings,
            "WATCHDOG_SCHEDULE_PROVENANCE_INVALID",
            "CloudFormation requires the watchdog rule enabled, but this invocation was not from it.",
            component=f"events:{RULE_ID}",
        )
    schedules = inspect_schedules(stack.get("controls") or {}, findings)
    heartbeats = inspect_heartbeats(schedules, findings, now=started)
    functions, oldest_age = inspect_cloudwatch_metrics(
        findings,
        now=started,
        controls=stack.get("controls") or {},
    )
    failure_queue = inspect_failure_queue(
        findings, oldest_age_seconds=oldest_age
    )
    checks = {
        "stack": stack,
        "schedules": schedules,
        "heartbeats": heartbeats,
        "functions": functions,
        "failureQueue": failure_queue,
    }

    lifecycle: Dict[str, Any] = {"notificationFailures": []}
    try:
        lifecycle = write_watchdog_alert(findings, observed_at=started)
    except Exception as error:
        add_finding(
            findings,
            "WATCHDOG_ALERT_WRITE_FAILED",
            f"Could not persist the watchdog alert ({_error_code(error)}).",
            component="watchdog",
        )
    if lifecycle["notificationFailures"]:
        add_finding(
            findings,
            "WATCHDOG_SNS_NOTIFICATION_FAILED",
            "One or more bounded operations notifications could not be published.",
            component="sns",
        )

    # Persist the typed heartbeat before emitting its corresponding metric.
    # A DynamoDB failure therefore cannot produce a false-positive heartbeat
    # metric; the independent missing-heartbeat alarm remains the final path.
    finished = utc_now()
    write_watchdog_heartbeat(
        started_at=started_at,
        observed_at=finished,
        service_id=service_id,
        scheduled=scheduled,
        trigger_source=trigger_source,
        rule_id=rule_id,
        findings=findings,
        checks=checks,
    )

    try:
        write_watchdog_metrics(
            service_id=service_id,
            healthy=not findings,
            finding_count=len(findings),
            queue=failure_queue,
            observed_at=finished,
        )
    except Exception as error:
        add_finding(
            findings,
            "WATCHDOG_METRIC_WRITE_FAILED",
            f"Could not publish watchdog metrics ({_error_code(error)}).",
            component="watchdog",
        )
        # Update the same heartbeat row with the metric-write failure. The
        # invocation then fails so native Lambda Errors provide another
        # independent signal even though custom metrics were unavailable.
        try:
            write_watchdog_alert(findings, observed_at=finished)
        except Exception as alert_error:
            add_finding(
                findings,
                "WATCHDOG_ALERT_WRITE_FAILED",
                f"Could not persist the watchdog alert ({_error_code(alert_error)}).",
                component="watchdog",
            )
        write_watchdog_heartbeat(
            started_at=started_at,
            observed_at=finished,
            service_id=service_id,
            scheduled=scheduled,
            trigger_source=trigger_source,
            rule_id=rule_id,
            findings=findings,
            checks=checks,
        )
        raise

    return {
        "status": "success" if not findings else "warning",
        "scheduled": scheduled,
        "serviceId": service_id,
        "errorCode": findings[0]["errorCode"] if findings else None,
        "findingCount": len(findings),
        "findings": findings,
        "checks": checks,
    }
