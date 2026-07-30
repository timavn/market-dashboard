#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import sys
import unittest
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch


os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
sys.path.insert(
    0,
    str(Path(__file__).resolve().parents[1] / "lambdas" / "hermes_watchdog"),
)

import hermes_watchdog as watchdog


NOW = datetime(2026, 7, 27, 18, 0, tzinfo=timezone.utc)


def stack_response(**control_overrides: str) -> dict:
    controls = {name: "DISABLED" for name in watchdog.CONTROL_PARAMETERS}
    controls["CloudWatchdogScheduleState"] = "ENABLED"
    controls.update(control_overrides)
    return {
        "Stacks": [
            {
                "StackName": watchdog.STACK_NAME,
                "StackId": (
                    "arn:aws:cloudformation:us-west-1:915328198276:"
                    f"stack/{watchdog.STACK_NAME}/stack-id"
                ),
                "StackStatus": "UPDATE_COMPLETE",
                "Parameters": [
                    {"ParameterKey": name, "ParameterValue": value}
                    for name, value in sorted(controls.items())
                ],
            }
        ]
    }


def typed_heartbeat(
    service_id: str,
    schedule_id: str,
    *,
    observed_at: datetime = NOW,
    status: str = "success",
    scheduled: bool = True,
    trigger_source: str = "aws-scheduler",
) -> dict:
    return watchdog.to_dynamodb_item(
        {
            "serviceId": service_id,
            "observedAt": observed_at.isoformat(),
            "status": status,
            "source": "aws-lambda",
            "scheduled": scheduled,
            "triggerSource": trigger_source,
            "scheduleId": schedule_id,
        }
    )


class FakeCloudFormation:
    def __init__(self, response: dict | None = None, error: Exception | None = None):
        self.response = response or stack_response()
        self.error = error
        self.calls: list[dict] = []

    def describe_stacks(self, **kwargs):
        self.calls.append(deepcopy(kwargs))
        if self.error:
            raise self.error
        return deepcopy(self.response)


class FakeAwsError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class FakeScheduler:
    def __init__(self, states: dict[str, str | Exception] | None = None):
        self.states = states or {
            str(spec["name"]): "DISABLED" for spec in watchdog.SCHEDULE_SPECS
        }
        self.calls: list[dict] = []

    def get_schedule(self, **kwargs):
        self.calls.append(deepcopy(kwargs))
        name = kwargs["Name"]
        value = self.states[name]
        if isinstance(value, Exception):
            raise value
        return {"Name": name, "State": value}


class FakeCloudWatch:
    def __init__(
        self,
        values: dict[str, list[float]] | None = None,
        *,
        fail_put: bool = False,
    ):
        self.values = values or {}
        self.fail_put = fail_put
        self.get_calls: list[dict] = []
        self.put_calls: list[dict] = []

    def get_metric_data(self, **kwargs):
        self.get_calls.append(deepcopy(kwargs))
        return {
            "MetricDataResults": [
                {"Id": query["Id"], "Values": self.values.get(query["Id"], [])}
                for query in kwargs["MetricDataQueries"]
            ]
        }

    def put_metric_data(self, **kwargs):
        self.put_calls.append(deepcopy(kwargs))
        if self.fail_put:
            raise RuntimeError("metrics unavailable")
        return {}


class FakeSqs:
    def __init__(self, *, visible: int = 0, in_flight: int = 0, delayed: int = 0):
        self.attributes = {
            "ApproximateNumberOfMessages": str(visible),
            "ApproximateNumberOfMessagesNotVisible": str(in_flight),
            "ApproximateNumberOfMessagesDelayed": str(delayed),
        }
        self.calls: list[dict] = []

    def get_queue_attributes(self, **kwargs):
        self.calls.append(deepcopy(kwargs))
        return {"Attributes": deepcopy(self.attributes)}


class FakeSns:
    def __init__(self, *, fail: bool = False):
        self.calls: list[dict] = []
        self.fail = fail

    def publish(self, **kwargs):
        self.calls.append(deepcopy(kwargs))
        if self.fail:
            raise RuntimeError("sns unavailable")
        return {"MessageId": f"message-{len(self.calls)}"}


class FakeDynamo:
    def __init__(
        self,
        heartbeats: dict[str, list[dict]] | None = None,
        *,
        fail_alert_write: bool = False,
        fail_heartbeat_write: bool = False,
    ):
        self.heartbeats = heartbeats or {}
        self.fail_alert_write = fail_alert_write
        self.fail_heartbeat_write = fail_heartbeat_write
        self.queries: list[dict] = []
        self.writes: list[dict] = []
        self.alert_items: dict[str, dict] = {}

    def query(self, **kwargs):
        self.queries.append(deepcopy(kwargs))
        service_id = kwargs["ExpressionAttributeValues"][":service_id"]["S"]
        return {"Items": deepcopy(self.heartbeats.get(service_id, []))}

    def put_item(self, **kwargs):
        if kwargs["TableName"] == watchdog.ALERTS_TABLE and self.fail_alert_write:
            raise RuntimeError("alert table unavailable")
        if kwargs["TableName"] == watchdog.HEARTBEAT_TABLE and self.fail_heartbeat_write:
            raise RuntimeError("heartbeat table unavailable")
        self.writes.append(deepcopy(kwargs))
        if kwargs["TableName"] == watchdog.ALERTS_TABLE:
            item = watchdog.from_dynamodb_item(kwargs["Item"])
            self.alert_items[str(item["alertId"])] = deepcopy(kwargs["Item"])
        return {}

    def get_item(self, **kwargs):
        key = watchdog.from_dynamodb_item(kwargs["Key"])
        item = self.alert_items.get(str(key["alertId"]))
        return {"Item": deepcopy(item)} if item else {}


class WatchdogTests(unittest.TestCase):
    def test_long_alert_roots_preserve_distinct_hash_suffixes(self):
        first = watchdog.canonical_alert_root(f"{'A' * 140}-FIRST")
        second = watchdog.canonical_alert_root(f"{'A' * 140}-SECOND")
        first_token = watchdog.alert_root_token(first)
        second_token = watchdog.alert_root_token(second)

        self.assertLessEqual(len(first_token), 100)
        self.assertLessEqual(len(second_token), 100)
        self.assertNotEqual(first_token, second_token)

    def invoke(
        self,
        *,
        stack: FakeCloudFormation | None = None,
        scheduler: FakeScheduler | None = None,
        metrics: FakeCloudWatch | None = None,
        queue: FakeSqs | None = None,
        database: FakeDynamo | None = None,
        notifications: FakeSns | None = None,
        event: dict | None = None,
    ) -> tuple[dict, FakeCloudFormation, FakeScheduler, FakeCloudWatch, FakeSqs, FakeDynamo]:
        stack = stack or FakeCloudFormation()
        scheduler = scheduler or FakeScheduler()
        metrics = metrics or FakeCloudWatch()
        queue = queue or FakeSqs()
        database = database or FakeDynamo()
        notifications_enabled = notifications is not None
        notifications = notifications or FakeSns()
        event = event or {"source": "aws-events", "ruleId": watchdog.RULE_ID}
        with (
            patch.object(watchdog, "cloudformation", stack),
            patch.object(watchdog, "scheduler", scheduler),
            patch.object(watchdog, "cloudwatch", metrics),
            patch.object(watchdog, "sqs", queue),
            patch.object(watchdog, "dynamodb", database),
            patch.object(watchdog, "sns", notifications),
            patch.object(
                watchdog,
                "OPERATIONS_TOPIC_ARN",
                (
                    "arn:aws:sns:us-west-1:915328198276:"
                    "market-dashboard-operations-v2"
                    if notifications_enabled
                    else ""
                ),
            ),
            patch.object(watchdog, "FAILURE_QUEUE_URL", "https://sqs.example/failures"),
            patch.object(watchdog, "utc_now", return_value=NOW),
        ):
            result = watchdog.lambda_handler(event, None)
        return result, stack, scheduler, metrics, queue, database

    def test_disabled_controls_are_observed_but_not_failures(self):
        result, stack, schedules, metrics, queue, database = self.invoke()

        self.assertEqual(result["status"], "success")
        self.assertTrue(result["scheduled"])
        self.assertEqual(result["findingCount"], 0)
        self.assertEqual(stack.calls, [{"StackName": watchdog.STACK_NAME}])
        self.assertEqual(len(schedules.calls), 4)
        self.assertEqual(database.queries, [])
        self.assertTrue(
            all(
                item["status"] == "not-required"
                for item in result["checks"]["heartbeats"].values()
            )
        )
        self.assertTrue(
            all(
                item.get("reason") == "intentionally-disabled"
                for item in result["checks"]["schedules"].values()
            )
        )
        self.assertEqual(
            queue.calls,
            [
                {
                    "QueueUrl": "https://sqs.example/failures",
                    "AttributeNames": [
                        "ApproximateNumberOfMessages",
                        "ApproximateNumberOfMessagesNotVisible",
                        "ApproximateNumberOfMessagesDelayed",
                    ],
                }
            ],
        )

        query_metrics = {
            (
                query["MetricStat"]["Metric"]["Namespace"],
                query["MetricStat"]["Metric"]["MetricName"],
                query["MetricStat"]["Metric"]["Dimensions"][0]["Name"],
                query["MetricStat"]["Metric"]["Dimensions"][0]["Value"],
            )
            for query in metrics.get_calls[0]["MetricDataQueries"]
        }
        for spec in watchdog.FUNCTION_SPECS:
            for metric_name in ("Invocations", "Errors", "Duration"):
                self.assertIn(
                    ("AWS/Lambda", metric_name, "FunctionName", spec["name"]),
                    query_metrics,
                )
        self.assertIn(
            (
                "AWS/SQS",
                "ApproximateAgeOfOldestMessage",
                "QueueName",
                watchdog.FAILURE_QUEUE_NAME,
            ),
            query_metrics,
        )

        alert = watchdog.from_dynamodb_item(database.writes[0]["Item"])
        heartbeat = watchdog.from_dynamodb_item(
            next(
                write["Item"]
                for write in reversed(database.writes)
                if write["TableName"] == watchdog.HEARTBEAT_TABLE
            )
        )
        self.assertEqual(alert["status"], "resolved")
        self.assertEqual(heartbeat["serviceId"], watchdog.WATCHDOG_SERVICE_ID)
        self.assertEqual(heartbeat["status"], "success")
        self.assertTrue(heartbeat["scheduled"])
        self.assertEqual(metrics.put_calls[0]["Namespace"], "MarketDashboard/Readiness")

    def test_enabled_schedule_requires_exact_fresh_typed_heartbeat(self):
        gmail = watchdog.SCHEDULE_SPECS[0]
        database = FakeDynamo(
            {
                str(gmail["serviceId"]): [
                    typed_heartbeat(
                        str(gmail["serviceId"]),
                        str(gmail["name"]),
                        status="in_progress",
                    )
                ]
            }
        )
        stack = FakeCloudFormation(stack_response(GmailScheduleState="ENABLED"))
        states = {
            str(spec["name"]): (
                "ENABLED" if spec is gmail else "DISABLED"
            )
            for spec in watchdog.SCHEDULE_SPECS
        }

        result, *_rest, written_database = self.invoke(
            stack=stack,
            scheduler=FakeScheduler(states),
            database=database,
        )

        self.assertEqual(result["status"], "success")
        self.assertEqual(len(database.queries), 1)
        query = database.queries[0]
        self.assertEqual(query["TableName"], watchdog.HEARTBEAT_TABLE)
        self.assertTrue(query["ConsistentRead"])
        self.assertEqual(query["Limit"], 1)
        self.assertEqual(
            result["checks"]["heartbeats"][str(gmail["serviceId"])]["status"],
            "in_progress",
        )
        heartbeat = watchdog.from_dynamodb_item(
            next(
                write["Item"]
                for write in reversed(written_database.writes)
                if write["TableName"] == watchdog.HEARTBEAT_TABLE
            )
        )
        self.assertEqual(heartbeat["status"], "success")

    def test_schedule_state_drift_suppresses_dependent_heartbeat_failure(self):
        stack = FakeCloudFormation(stack_response(GmailScheduleState="ENABLED"))
        result, *_rest, database = self.invoke(stack=stack)

        self.assertEqual(
            [finding["errorCode"] for finding in result["findings"]],
            ["SCHEDULER_STATE_DRIFT"],
        )
        self.assertEqual(database.queries, [])
        gmail_service = str(watchdog.SCHEDULE_SPECS[0]["serviceId"])
        self.assertEqual(
            result["checks"]["heartbeats"][gmail_service]["reason"],
            "schedule-not-enabled",
        )

    def test_missing_schedule_is_a_typed_root_cause_without_heartbeat_noise(self):
        gmail = watchdog.SCHEDULE_SPECS[0]
        stack = FakeCloudFormation(stack_response(GmailScheduleState="ENABLED"))
        states = {
            str(spec["name"]): "DISABLED" for spec in watchdog.SCHEDULE_SPECS
        }
        states[str(gmail["name"])] = FakeAwsError("ResourceNotFoundException")

        result, *_rest, database = self.invoke(
            stack=stack,
            scheduler=FakeScheduler(states),
        )

        self.assertEqual(
            result["errorCode"], "SCHEDULER_RESOURCE_MISSING"
        )
        self.assertEqual(database.queries, [])
        self.assertNotIn(
            "SCHEDULED_HEARTBEAT_MISSING",
            [finding["errorCode"] for finding in result["findings"]],
        )

    def test_invalid_heartbeat_provenance_is_not_accepted_as_current_success(self):
        gmail = watchdog.SCHEDULE_SPECS[0]
        stack = FakeCloudFormation(stack_response(GmailScheduleState="ENABLED"))
        states = {
            str(spec["name"]): (
                "ENABLED" if spec is gmail else "DISABLED"
            )
            for spec in watchdog.SCHEDULE_SPECS
        }
        database = FakeDynamo(
            {
                str(gmail["serviceId"]): [
                    typed_heartbeat(
                        str(gmail["serviceId"]),
                        str(gmail["name"]),
                        scheduled=False,
                        trigger_source="manual",
                    )
                ]
            }
        )

        result, *_ = self.invoke(
            stack=stack,
            scheduler=FakeScheduler(states),
            database=database,
        )

        self.assertIn(
            "SCHEDULED_HEARTBEAT_PROVENANCE_INVALID",
            [finding["errorCode"] for finding in result["findings"]],
        )

    def test_lambda_timeout_signals_and_queue_backlog_are_typed_findings(self):
        metrics = FakeCloudWatch(
            {
                "gmail_invocations": [1],
                "gmail_errors": [1],
                "gmail_duration": [299_900],
                "queue_age": [900],
            }
        )
        result, *_rest, database = self.invoke(
            metrics=metrics,
            queue=FakeSqs(visible=69),
        )

        codes = [finding["errorCode"] for finding in result["findings"]]
        self.assertEqual(
            codes,
            [
                "GMAIL_INVOCATION_TIMEOUT",
                "RUNTIME_FAILURE_QUEUE_BACKLOG",
            ],
        )
        self.assertEqual(result["checks"]["failureQueue"]["total"], 69)
        self.assertEqual(
            result["checks"]["failureQueue"]["oldestAgeSeconds"], 900
        )
        alert = next(
            watchdog.from_dynamodb_item(write["Item"])
            for write in database.writes
            if write["TableName"] == watchdog.ALERTS_TABLE
            and watchdog.from_dynamodb_item(write["Item"]).get("details", {}).get(
                "errorCode"
            )
            == "GMAIL_INVOCATION_TIMEOUT"
        )
        heartbeat = watchdog.from_dynamodb_item(
            next(
                write["Item"]
                for write in reversed(database.writes)
                if write["TableName"] == watchdog.HEARTBEAT_TABLE
            )
        )
        self.assertEqual(alert["status"], "open")
        self.assertEqual(
            alert["dedupeKey"], "cloud-watchdog#GMAIL_INVOCATION_TIMEOUT"
        )
        self.assertEqual(
            heartbeat["errorCode"], "GMAIL_INVOCATION_TIMEOUT"
        )

    def test_stale_heartbeat_is_not_current_even_when_status_says_success(self):
        gmail = watchdog.SCHEDULE_SPECS[0]
        stack = FakeCloudFormation(stack_response(GmailScheduleState="ENABLED"))
        states = {
            str(spec["name"]): (
                "ENABLED" if spec is gmail else "DISABLED"
            )
            for spec in watchdog.SCHEDULE_SPECS
        }
        database = FakeDynamo(
            {
                str(gmail["serviceId"]): [
                    typed_heartbeat(
                        str(gmail["serviceId"]),
                        str(gmail["name"]),
                        observed_at=NOW - timedelta(days=12),
                    )
                ]
            }
        )

        result, *_ = self.invoke(
            stack=stack,
            scheduler=FakeScheduler(states),
            database=database,
        )

        self.assertIn(
            "SCHEDULED_HEARTBEAT_STALE",
            [finding["errorCode"] for finding in result["findings"]],
        )

    def test_manual_invocation_never_writes_the_authoritative_service_id(self):
        result, *_rest, database = self.invoke(event={"source": "manual"})

        self.assertFalse(result["scheduled"])
        self.assertEqual(
            result["errorCode"], "WATCHDOG_SCHEDULE_PROVENANCE_INVALID"
        )
        heartbeat = watchdog.from_dynamodb_item(
            next(
                write["Item"]
                for write in reversed(database.writes)
                if write["TableName"] == watchdog.HEARTBEAT_TABLE
            )
        )
        self.assertEqual(
            heartbeat["serviceId"], f"{watchdog.WATCHDOG_SERVICE_ID}:manual"
        )
        self.assertFalse(heartbeat["scheduled"])

    def test_rule_invocation_is_degraded_when_cloudformation_requires_disabled(self):
        stack = FakeCloudFormation(
            stack_response(CloudWatchdogScheduleState="DISABLED")
        )

        result, *_ = self.invoke(stack=stack)

        self.assertTrue(result["scheduled"])
        self.assertEqual(
            result["errorCode"], "WATCHDOG_EVENT_RULE_STATE_DRIFT"
        )

    def test_alert_write_failure_is_captured_in_the_heartbeat(self):
        database = FakeDynamo(fail_alert_write=True)
        result, *_ = self.invoke(database=database)

        self.assertEqual(result["status"], "warning")
        self.assertEqual(
            result["findings"][0]["errorCode"], "WATCHDOG_ALERT_WRITE_FAILED"
        )
        self.assertEqual(len(database.writes), 1)
        heartbeat = watchdog.from_dynamodb_item(database.writes[0]["Item"])
        self.assertEqual(
            heartbeat["errorCode"], "WATCHDOG_ALERT_WRITE_FAILED"
        )

    def test_heartbeat_write_failure_surfaces_as_a_lambda_error(self):
        with self.assertRaisesRegex(RuntimeError, "heartbeat table unavailable"):
            self.invoke(database=FakeDynamo(fail_heartbeat_write=True))

    def test_metric_write_failure_updates_typed_state_and_surfaces_lambda_error(self):
        database = FakeDynamo()
        with self.assertRaisesRegex(RuntimeError, "metrics unavailable"):
            self.invoke(
                metrics=FakeCloudWatch(fail_put=True),
                database=database,
            )

        self.assertEqual(len(database.writes), 7)
        alert = next(
            watchdog.from_dynamodb_item(write["Item"])
            for write in database.writes
            if write["TableName"] == watchdog.ALERTS_TABLE
            and watchdog.from_dynamodb_item(write["Item"]).get("details", {}).get(
                "errorCode"
            )
            == "WATCHDOG_METRIC_WRITE_FAILED"
        )
        heartbeat = watchdog.from_dynamodb_item(database.writes[-1]["Item"])
        self.assertEqual(alert["status"], "open")
        self.assertEqual(
            heartbeat["errorCode"], "WATCHDOG_METRIC_WRITE_FAILED"
        )

    def test_alert_lifecycle_deduplicates_escalates_and_resolves_owned_roots(self):
        database = FakeDynamo()
        notifications = FakeSns()
        degraded_queue = FakeSqs(visible=69)

        self.invoke(
            queue=degraded_queue,
            database=database,
            notifications=notifications,
        )
        self.invoke(
            queue=degraded_queue,
            database=database,
            notifications=notifications,
        )
        self.invoke(
            queue=degraded_queue,
            database=database,
            notifications=notifications,
        )
        self.invoke(
            queue=degraded_queue,
            database=database,
            notifications=notifications,
        )
        self.invoke(
            queue=FakeSqs(),
            database=database,
            notifications=notifications,
        )
        self.invoke(
            queue=FakeSqs(),
            database=database,
            notifications=notifications,
        )

        payloads = [json.loads(call["Message"]) for call in notifications.calls]
        self.assertEqual(
            [payload["eventType"] for payload in payloads],
            [
                "incident_opened",
                "incident_escalated",
                "incident_recovered",
            ],
        )
        self.assertTrue(
            all(
                payload["dedupeKey"]
                == "cloud-watchdog#RUNTIME_FAILURE_QUEUE_BACKLOG"
                for payload in payloads
            )
        )
        self.assertTrue(
            all(
                len(call["Message"].encode("utf-8"))
                <= watchdog.MAX_SNS_MESSAGE_BYTES
                for call in notifications.calls
            )
        )
        root_item = watchdog.from_dynamodb_item(
            database.alert_items[
                watchdog.watchdog_alert_id("RUNTIME_FAILURE_QUEUE_BACKLOG")
            ]
        )
        self.assertEqual(root_item["status"], "resolved")
        state_item = watchdog.from_dynamodb_item(
            database.alert_items[watchdog.watchdog_alert_state_id()]
        )
        self.assertEqual(state_item["activeRoots"], [])
        unresolved = [
            watchdog.from_dynamodb_item(item)
            for item in database.alert_items.values()
            if watchdog.from_dynamodb_item(item).get("status") != "resolved"
        ]
        self.assertEqual(unresolved, [])

    def test_interrupted_open_uses_exact_root_row_without_duplicate_notification(self):
        database = FakeDynamo()
        notifications = FakeSns()
        error_code = "RUNTIME_FAILURE_QUEUE_BACKLOG"
        finding = {
            "errorCode": error_code,
            "component": "sqs:runtime-failures",
            "detail": "The retained queue has 69 messages.",
        }
        topic_arn = (
            "arn:aws:sns:us-west-1:915328198276:"
            "market-dashboard-operations-v2"
        )

        with (
            patch.object(watchdog, "dynamodb", database),
            patch.object(watchdog, "sns", notifications),
            patch.object(watchdog, "OPERATIONS_TOPIC_ARN", topic_arn),
        ):
            watchdog.write_watchdog_alert_state(
                {
                    error_code: {
                        "component": finding["component"],
                        "openedAt": NOW.isoformat(),
                        "observationCount": 1,
                        "escalated": False,
                    }
                },
                known_roots={error_code},
                source_run_id="cloud-watchdog#interrupted",
                observed_at=NOW.isoformat(),
            )
            watchdog.write_watchdog_root_alert(
                error_code=error_code,
                component=finding["component"],
                message=finding["detail"],
                source_run_id="cloud-watchdog#interrupted",
                status="open",
                transition="incident_opened",
                observed_at=NOW.isoformat(),
            )
            watchdog.write_watchdog_alert([finding], observed_at=NOW)
            watchdog.write_watchdog_alert([], observed_at=NOW)

        self.assertEqual(
            [json.loads(call["Message"])["eventType"] for call in notifications.calls],
            ["incident_recovered"],
        )
        root_item = watchdog.from_dynamodb_item(
            database.alert_items[watchdog.watchdog_alert_id(error_code)]
        )
        self.assertEqual(root_item["status"], "resolved")

    def test_sns_failure_keeps_heartbeat_and_recovery_state_writable(self):
        database = FakeDynamo()
        self.invoke(
            queue=FakeSqs(visible=69),
            database=database,
            notifications=FakeSns(),
        )

        result, *_rest = self.invoke(
            queue=FakeSqs(),
            database=database,
            notifications=FakeSns(fail=True),
        )

        self.assertEqual(result["status"], "warning")
        self.assertIn(
            "WATCHDOG_SNS_NOTIFICATION_FAILED",
            [finding["errorCode"] for finding in result["findings"]],
        )
        heartbeat = watchdog.from_dynamodb_item(
            next(
                write["Item"]
                for write in reversed(database.writes)
                if write["TableName"] == watchdog.HEARTBEAT_TABLE
            )
        )
        self.assertEqual(heartbeat["status"], "warning")
        self.assertEqual(
            heartbeat["errorCode"],
            "WATCHDOG_SNS_NOTIFICATION_FAILED",
        )
        root_item = watchdog.from_dynamodb_item(
            database.alert_items[
                watchdog.watchdog_alert_id("RUNTIME_FAILURE_QUEUE_BACKLOG")
            ]
        )
        self.assertEqual(root_item["status"], "resolved")
        state_item = watchdog.from_dynamodb_item(
            database.alert_items[watchdog.watchdog_alert_state_id()]
        )
        self.assertEqual(state_item["activeRoots"], [])


if __name__ == "__main__":
    unittest.main()
