#!/usr/bin/env python3
"""Fail-closed AWS cost guardrail invoked by the monthly budget SNS topic.

The guardrail only reacts to the named ACTUAL $50 budget notification.  It
records the exact pre-pause state, disables the owned schedules/watchdog and
alarm actions, then sets reserved concurrency to zero on dashboard-owned
functions.  It deliberately leaves data, storage, and monitoring resources
untouched so the account can be inspected and resumed safely.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, Mapping

import boto3
from botocore.exceptions import ClientError


REGION = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-west-1"))
BUDGET_NAME = os.environ.get("COST_GUARD_BUDGET_NAME", "MarketDashboardMonthlyCostCeiling")
PAUSE_THRESHOLD = float(os.environ.get("COST_GUARD_PAUSE_THRESHOLD", "50"))
STATE_PARAMETER = os.environ.get(
    "COST_GUARD_STATE_PARAMETER", "/market-dashboard/cost-guard/state"
)
OPERATIONS_TOPIC_ARN = os.environ.get("HERMES_OPERATIONS_TOPIC_ARN", "")
TRIGGER_TOPIC_ARN = os.environ.get("COST_GUARD_TRIGGER_TOPIC_ARN", "")
SCHEDULE_NAMES = tuple(
    value.strip()
    for value in os.environ.get("COST_GUARD_SCHEDULE_NAMES", "").split(",")
    if value.strip()
)
WATCHDOG_RULE_NAME = os.environ.get(
    "COST_GUARD_WATCHDOG_RULE", "market-dashboard-hermes-cloud-watchdog-v1"
)
ALARM_NAMES = tuple(
    value.strip()
    for value in os.environ.get("COST_GUARD_ALARM_NAMES", "").split(",")
    if value.strip()
)
FUNCTION_NAMES = tuple(
    value.strip()
    for value in os.environ.get("COST_GUARD_FUNCTION_NAMES", "").split(",")
    if value.strip()
)

scheduler = boto3.client("scheduler", region_name=REGION)
events = boto3.client("events", region_name=REGION)
lambda_client = boto3.client("lambda", region_name=REGION)
cloudwatch = boto3.client("cloudwatch", region_name=REGION)
ssm = boto3.client("ssm", region_name=REGION)
sns = boto3.client("sns", region_name=REGION)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _error_code(error: BaseException) -> str:
    if isinstance(error, ClientError):
        return str(error.response.get("Error", {}).get("Code") or type(error).__name__)
    return type(error).__name__


def _read_state() -> Dict[str, Any]:
    try:
        response = ssm.get_parameter(Name=STATE_PARAMETER)
        parsed = json.loads(response["Parameter"]["Value"])
        return parsed if isinstance(parsed, dict) else {}
    except ssm.exceptions.ParameterNotFound:
        return {}


def _write_state(state: Mapping[str, Any]) -> None:
    ssm.put_parameter(
        Name=STATE_PARAMETER,
        Type="String",
        Value=json.dumps(dict(state), separators=(",", ":"), sort_keys=True),
        Overwrite=True,
    )


def _schedule_snapshot(name: str) -> Dict[str, Any]:
    response = scheduler.get_schedule(Name=name)
    return {
        "state": response.get("State"),
        "description": response.get("Description"),
        "scheduleExpression": response.get("ScheduleExpression"),
        "scheduleExpressionTimezone": response.get("ScheduleExpressionTimezone"),
        "flexibleTimeWindow": response.get("FlexibleTimeWindow"),
        "target": response.get("Target"),
        "kmsKeyArn": response.get("KmsKeyArn"),
    }


def _set_schedule_state(name: str, state: str) -> None:
    if state not in {"ENABLED", "DISABLED"}:
        raise RuntimeError("schedule-snapshot-state-invalid")
    current = _schedule_snapshot(name)
    if current.get("state") == state:
        return
    params: Dict[str, Any] = {
        "Name": name,
        "State": state,
        "ScheduleExpression": current["scheduleExpression"],
        "FlexibleTimeWindow": current["flexibleTimeWindow"],
        "Target": current["target"],
    }
    for key, value in (
        ("Description", current.get("description")),
        ("ScheduleExpressionTimezone", current.get("scheduleExpressionTimezone")),
        ("KmsKeyArn", current.get("kmsKeyArn")),
    ):
        if value:
            params[key] = value
    scheduler.update_schedule(**params)


def _function_concurrency(name: str) -> Any:
    response = lambda_client.get_function_concurrency(FunctionName=name)
    return response.get("ReservedConcurrentExecutions")


def _set_function_concurrency(name: str, value: Any) -> None:
    current = _function_concurrency(name)
    if current == value:
        return
    if value is None:
        lambda_client.delete_function_concurrency(FunctionName=name)
        return
    lambda_client.put_function_concurrency(
        FunctionName=name,
        ReservedConcurrentExecutions=int(value),
    )


def _alarm_actions_enabled(name: str) -> Any:
    response = cloudwatch.describe_alarms(AlarmNames=[name])
    alarms = response.get("MetricAlarms") or []
    if len(alarms) != 1:
        raise RuntimeError("alarm-not-found")
    return bool(alarms[0].get("ActionsEnabled"))


def _set_alarm_actions(name: str, enabled: bool) -> None:
    current = _alarm_actions_enabled(name)
    if current == enabled:
        return
    if enabled:
        cloudwatch.enable_alarm_actions(AlarmNames=[name])
    else:
        cloudwatch.disable_alarm_actions(AlarmNames=[name])


def _watchdog_state() -> str:
    state = str(events.describe_rule(Name=WATCHDOG_RULE_NAME).get("State") or "")
    if state not in {"ENABLED", "DISABLED"}:
        raise RuntimeError("watchdog-state-unknown")
    return state


def _set_watchdog_state(state: str) -> None:
    current = _watchdog_state()
    if current == state:
        return
    if state == "ENABLED":
        events.enable_rule(Name=WATCHDOG_RULE_NAME)
    elif state == "DISABLED":
        events.disable_rule(Name=WATCHDOG_RULE_NAME)
    else:
        raise RuntimeError("watchdog-snapshot-state-invalid")


def _canonical_message_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value).lower())


def _plaintext_budget_message(message: str) -> Dict[str, Any] | None:
    fields: Dict[str, str] = {}
    for line in message.splitlines():
        key, separator, value = line.partition(":")
        if separator and value.strip():
            fields[_canonical_message_key(key)] = value.strip()

    budget_name = fields.get("budgetname")
    notification_type = fields.get("notificationtype") or fields.get("alerttype")
    if not notification_type and "actualamount" in fields:
        notification_type = "ACTUAL"
    threshold_text = fields.get("alertthreshold") or fields.get("threshold")
    if not budget_name or not notification_type or not threshold_text:
        return None

    # AWS Budgets' human-readable SNS message expresses an absolute threshold
    # as a currency amount (for example, "> $50.00"). Refuse percentage or
    # unlabeled numeric values so only the intended USD ceiling can pause work.
    threshold_match = re.fullmatch(
        r"\s*(?:>=|>|=)?\s*(?:USD\s*)?\$\s*([0-9]+(?:\.[0-9]+)?)\s*(?:USD)?\s*",
        threshold_text,
        flags=re.IGNORECASE,
    )
    if not threshold_match:
        return None
    return {
        "BudgetName": budget_name,
        "NotificationType": notification_type,
        "ThresholdType": "ABSOLUTE_VALUE",
        "Threshold": float(threshold_match.group(1)),
    }


def _parse_budget_message(message: Any) -> Dict[str, Any] | None:
    if isinstance(message, Mapping):
        parsed = dict(message)
    else:
        try:
            parsed = json.loads(str(message))
        except (TypeError, ValueError):
            return _plaintext_budget_message(str(message))
    if not isinstance(parsed, dict):
        return None

    canonical = {_canonical_message_key(key): value for key, value in parsed.items()}
    return {
        "BudgetName": canonical.get("budgetname"),
        "NotificationType": canonical.get("notificationtype") or canonical.get("alerttype"),
        "ThresholdType": canonical.get("thresholdtype") or canonical.get("alertthresholdtype"),
        "Threshold": canonical.get("threshold") or canonical.get("alertthreshold"),
    }


def _is_pause_notification(message: Mapping[str, Any]) -> bool:
    if str(message.get("BudgetName") or "") != BUDGET_NAME:
        return False
    if str(message.get("NotificationType") or "").upper() != "ACTUAL":
        return False
    if str(message.get("ThresholdType") or "").upper() != "ABSOLUTE_VALUE":
        return False
    try:
        threshold = float(message.get("Threshold") or 0)
    except (TypeError, ValueError):
        return False
    return threshold == PAUSE_THRESHOLD


def _publish_summary(summary: Mapping[str, Any]) -> None:
    if not OPERATIONS_TOPIC_ARN:
        return
    sns.publish(
        TopicArn=OPERATIONS_TOPIC_ARN,
        Subject="AWS cost guardian state change (internal)",
        Message=json.dumps(summary, indent=2, sort_keys=True),
    )


def _record_resource_result(
    state: Dict[str, Any],
    resource: str,
    operation: str,
    error: BaseException | None = None,
) -> None:
    state["errors"] = [
        item
        for item in state.get("errors") or []
        if not (
            item.get("resource") == resource
            and item.get("operation") == operation
        )
    ]
    if error is not None:
        state["errors"].append(
            {
                "resource": resource,
                "operation": operation,
                "error": _error_code(error),
            }
        )


def pause(reason: str, *, budget_message: Mapping[str, Any] | None = None) -> Dict[str, Any]:
    existing = _read_state()
    if existing.get("status") == "paused":
        return {
            "status": "already-paused",
            "pausedAt": existing.get("pausedAt"),
            "errorCount": len(existing.get("errors") or []),
        }

    if existing.get("status") in {"pausing", "pause-partial"}:
        state = existing
        state["status"] = "pausing"
        state.setdefault("errors", [])
        state.setdefault("schedules", {})
        state.setdefault("alarms", {})
        state.setdefault("functions", {})
    else:
        state = {
            "version": 1,
            "status": "pausing",
            "reason": reason,
            "pausedAt": _now(),
            "budgetMessage": dict(budget_message or {}),
            "schedules": {},
            "watchdogRule": None,
            "alarms": {},
            "functions": {},
            "errors": [],
        }
    # Capture every restorable value before making the first change. If the
    # invocation is interrupted, the durable `pausing` record lets a retry
    # continue without replacing a pre-pause value with an already-paused one.
    for name in SCHEDULE_NAMES:
        if name in state["schedules"]:
            continue
        try:
            state["schedules"][name] = _schedule_snapshot(name)
            _record_resource_result(state, name, "schedule")
        except Exception as error:
            _record_resource_result(state, name, "schedule", error)

    if not (state.get("watchdogRule") or {}).get("state"):
        try:
            state["watchdogRule"] = {"state": _watchdog_state()}
            _record_resource_result(state, WATCHDOG_RULE_NAME, "watchdog")
        except Exception as error:
            _record_resource_result(state, WATCHDOG_RULE_NAME, "watchdog", error)

    for name in ALARM_NAMES:
        if name in state["alarms"]:
            continue
        try:
            state["alarms"][name] = {
                "actionsEnabled": _alarm_actions_enabled(name)
            }
            _record_resource_result(state, name, "alarm")
        except Exception as error:
            _record_resource_result(state, name, "alarm", error)

    for name in FUNCTION_NAMES:
        if name in state["functions"]:
            continue
        try:
            state["functions"][name] = {
                "reservedConcurrentExecutions": _function_concurrency(name)
            }
            _record_resource_result(state, name, "concurrency")
        except Exception as error:
            _record_resource_result(state, name, "concurrency", error)

    _write_state(state)

    for name in SCHEDULE_NAMES:
        if name not in state["schedules"]:
            continue
        try:
            _set_schedule_state(name, "DISABLED")
            _record_resource_result(state, name, "schedule")
        except Exception as error:
            _record_resource_result(state, name, "schedule", error)

    if (state.get("watchdogRule") or {}).get("state"):
        try:
            _set_watchdog_state("DISABLED")
            _record_resource_result(state, WATCHDOG_RULE_NAME, "watchdog")
        except Exception as error:
            _record_resource_result(state, WATCHDOG_RULE_NAME, "watchdog", error)

    for name in ALARM_NAMES:
        if name not in state["alarms"]:
            continue
        try:
            _set_alarm_actions(name, False)
            _record_resource_result(state, name, "alarm")
        except Exception as error:
            _record_resource_result(state, name, "alarm", error)

    for name in FUNCTION_NAMES:
        if name not in state["functions"]:
            continue
        try:
            _set_function_concurrency(name, 0)
            _record_resource_result(state, name, "concurrency")
        except Exception as error:
            _record_resource_result(state, name, "concurrency", error)

    state["status"] = "pause-partial" if state["errors"] else "paused"
    state["completedAt"] = _now()
    _write_state(state)
    _publish_summary(
        {
            "event": "market-dashboard-paused",
            "status": state["status"],
            "reason": reason,
            "pausedAt": state["pausedAt"],
            "completedAt": state["completedAt"],
            "errorCount": len(state["errors"]),
            "errors": state["errors"],
            "budget": dict(budget_message or {}),
        }
    )
    return {"status": state["status"], "pausedAt": state["pausedAt"], "errors": state["errors"]}


def resume() -> Dict[str, Any]:
    state = _read_state()
    if state.get("status") == "resumed":
        return {
            "status": "already-resumed",
            "resumedAt": state.get("resumedAt"),
            "errorCount": len(state.get("resumeErrors") or []),
        }
    if state.get("status") not in {
        "paused",
        "pause-partial",
        "resuming",
        "resume-partial",
    }:
        return {"status": "not-paused", "currentStatus": state.get("status")}
    state["status"] = "resuming"
    _write_state(state)
    errors = []
    for name, snapshot in (state.get("schedules") or {}).items():
        try:
            _set_schedule_state(name, snapshot.get("state"))
        except Exception as error:
            errors.append({"resource": name, "operation": "schedule-resume", "error": _error_code(error)})
    try:
        watchdog_state = (state.get("watchdogRule") or {}).get("state")
        if watchdog_state:
            _set_watchdog_state(watchdog_state)
    except Exception as error:
        errors.append({"resource": WATCHDOG_RULE_NAME, "operation": "watchdog-resume", "error": _error_code(error)})
    for name, snapshot in (state.get("alarms") or {}).items():
        try:
            _set_alarm_actions(name, bool((snapshot or {}).get("actionsEnabled")))
        except Exception as error:
            errors.append({"resource": name, "operation": "alarm-resume", "error": _error_code(error)})
    for name, snapshot in (state.get("functions") or {}).items():
        try:
            _set_function_concurrency(
                name,
                (snapshot or {}).get("reservedConcurrentExecutions"),
            )
        except Exception as error:
            errors.append({"resource": name, "operation": "concurrency-resume", "error": _error_code(error)})
    state["status"] = "resumed" if not errors else "resume-partial"
    state["resumedAt"] = _now()
    state["resumeErrors"] = errors
    _write_state(state)
    _publish_summary(
        {
            "event": "market-dashboard-resumed",
            "status": state["status"],
            "resumedAt": state["resumedAt"],
            "errorCount": len(errors),
            "errors": errors,
        }
    )
    return {"status": state["status"], "resumedAt": state["resumedAt"], "errors": errors}


def lambda_handler(event: Mapping[str, Any] | None, context: Any) -> Dict[str, Any]:
    del context
    if (event or {}).get("action") == "resume":
        return resume()
    accepted = []
    ignored = []
    for record in (event or {}).get("Records") or []:
        sns_record = (record or {}).get("Sns") or {}
        if not TRIGGER_TOPIC_ARN or sns_record.get("TopicArn") != TRIGGER_TOPIC_ARN:
            ignored.append("unexpected-topic")
            continue
        message = _parse_budget_message(sns_record.get("Message"))
        if not message or not _is_pause_notification(message):
            ignored.append(sns_record.get("Subject") or "non-budget-notification")
            continue
        accepted.append(pause("budget-actual-threshold", budget_message=message))
    return {"status": "ok", "accepted": accepted, "ignored": ignored}
