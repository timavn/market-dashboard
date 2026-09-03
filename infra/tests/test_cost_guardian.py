#!/usr/bin/env python3
"""Unit tests for the fail-closed monthly cost guardian."""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock


os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "infra" / "lambdas" / "cost_guardian"))

import cost_guardian as guardian  # noqa: E402


class CostGuardianTests(unittest.TestCase):
    def test_accepts_only_exact_actual_absolute_twenty_dollar_notification(self):
        valid = {
            "BudgetName": guardian.BUDGET_NAME,
            "NotificationType": "ACTUAL",
            "ThresholdType": "ABSOLUTE_VALUE",
            "Threshold": 20,
        }
        self.assertTrue(guardian._is_pause_notification(valid))

        plaintext = "\n".join(
            (
                f"Budget Name: {guardian.BUDGET_NAME}",
                "Budget Type: Cost",
                "Budgeted Amount: $20.00",
                "Alert Threshold: > $20.00",
                "ACTUAL Amount: $20.21",
            )
        )
        parsed = guardian._parse_budget_message(plaintext)
        self.assertEqual(parsed, valid | {"Threshold": 20.0})
        self.assertTrue(guardian._is_pause_notification(parsed or {}))

        mutations = (
            {**valid, "BudgetName": "AnotherBudget"},
            {**valid, "NotificationType": "FORECASTED"},
            {**valid, "ThresholdType": "PERCENTAGE"},
            {**valid, "Threshold": 18},
        )
        for candidate in mutations:
            with self.subTest(candidate=candidate):
                self.assertFalse(guardian._is_pause_notification(candidate))

        self.assertIsNone(
            guardian._parse_budget_message(
                plaintext.replace("Alert Threshold: > $20.00", "Alert Threshold: > 20%")
            )
        )

    def test_non_budget_and_wrong_topic_events_are_ignored(self):
        trigger = "arn:aws:sns:us-west-1:915328198276:guardian"
        valid_message = json.dumps(
            {
                "BudgetName": guardian.BUDGET_NAME,
                "NotificationType": "ACTUAL",
                "ThresholdType": "ABSOLUTE_VALUE",
                "Threshold": 20,
            }
        )
        event = {
            "Records": [
                {"Sns": {"TopicArn": "arn:wrong", "Message": valid_message}},
                {
                    "Sns": {
                        "TopicArn": trigger,
                        "Message": json.dumps(
                            {
                                "BudgetName": guardian.BUDGET_NAME,
                                "NotificationType": "FORECASTED",
                                "ThresholdType": "ABSOLUTE_VALUE",
                                "Threshold": 20,
                            }
                        ),
                    }
                },
            ]
        }
        with mock.patch.object(guardian, "TRIGGER_TOPIC_ARN", trigger), mock.patch.object(
            guardian, "pause"
        ) as pause:
            result = guardian.lambda_handler(event, None)
            manual_result = guardian.lambda_handler({"action": "pause"}, None)

        pause.assert_not_called()
        self.assertEqual(result["accepted"], [])
        self.assertEqual(result["ignored"], ["unexpected-topic", "non-budget-notification"])
        self.assertEqual(manual_result, {"status": "ok", "accepted": [], "ignored": []})

    def test_exact_budget_event_on_the_dedicated_topic_invokes_pause_once(self):
        trigger = "arn:aws:sns:us-west-1:915328198276:guardian"
        event = {
            "Records": [
                {
                    "Sns": {
                        "TopicArn": trigger,
                        "Message": json.dumps(
                            {
                                "BudgetName": guardian.BUDGET_NAME,
                                "NotificationType": "ACTUAL",
                                "ThresholdType": "ABSOLUTE_VALUE",
                                "Threshold": 20,
                            }
                        ),
                    }
                }
            ]
        }
        with mock.patch.object(guardian, "TRIGGER_TOPIC_ARN", trigger), mock.patch.object(
            guardian, "pause", return_value={"status": "paused"}
        ) as pause:
            result = guardian.lambda_handler(event, None)

        self.assertEqual(result["accepted"], [{"status": "paused"}])
        pause.assert_called_once_with(
            "budget-actual-threshold",
            budget_message={
                "BudgetName": guardian.BUDGET_NAME,
                "NotificationType": "ACTUAL",
                "ThresholdType": "ABSOLUTE_VALUE",
                "Threshold": 20,
            },
        )

    def test_completed_pause_is_idempotent(self):
        with mock.patch.object(
            guardian,
            "_read_state",
            return_value={"status": "paused", "pausedAt": "then", "errors": []},
        ), mock.patch.object(guardian, "_write_state") as write_state:
            result = guardian.pause("budget-actual-threshold")
        self.assertEqual(result["status"], "already-paused")
        write_state.assert_not_called()

    def test_interrupted_pause_retries_from_the_original_snapshot(self):
        saved = {
            "version": 1,
            "status": "pausing",
            "pausedAt": "then",
            "reason": "budget-actual-threshold",
            "budgetMessage": {},
            "schedules": {"owned": {"state": "ENABLED"}},
            "watchdogRule": {"state": "DISABLED"},
            "alarms": {},
            "functions": {},
            "errors": [],
        }
        with mock.patch.object(guardian, "SCHEDULE_NAMES", ("owned",)), mock.patch.object(
            guardian, "ALARM_NAMES", ()
        ), mock.patch.object(guardian, "FUNCTION_NAMES", ()), mock.patch.object(
            guardian, "_read_state", return_value=saved
        ), mock.patch.object(
            guardian, "_schedule_snapshot"
        ) as snapshot, mock.patch.object(
            guardian, "_set_schedule_state"
        ) as set_schedule, mock.patch.object(
            guardian, "_set_watchdog_state"
        ), mock.patch.object(
            guardian, "_write_state"
        ), mock.patch.object(
            guardian, "_publish_summary"
        ):
            result = guardian.pause("budget-actual-threshold")

        self.assertEqual(result["status"], "paused")
        snapshot.assert_not_called()
        set_schedule.assert_called_once_with("owned", "DISABLED")
        self.assertEqual(saved["schedules"]["owned"]["state"], "ENABLED")

    def test_pause_partial_records_any_resource_failure(self):
        writes = []
        with mock.patch.object(guardian, "SCHEDULE_NAMES", ("missing-schedule",)), mock.patch.object(
            guardian, "ALARM_NAMES", ()
        ), mock.patch.object(guardian, "FUNCTION_NAMES", ()), mock.patch.object(
            guardian, "_read_state", return_value={}
        ), mock.patch.object(
            guardian, "_schedule_snapshot", side_effect=RuntimeError("missing")
        ), mock.patch.object(
            guardian, "_watchdog_state", return_value="DISABLED"
        ), mock.patch.object(
            guardian, "_set_watchdog_state"
        ), mock.patch.object(
            guardian, "_write_state", side_effect=lambda state: writes.append(dict(state))
        ), mock.patch.object(
            guardian, "_publish_summary"
        ):
            result = guardian.pause("budget-actual-threshold")

        self.assertEqual(result["status"], "pause-partial")
        self.assertEqual(result["errors"][0]["resource"], "missing-schedule")
        self.assertEqual(writes[-1]["status"], "pause-partial")
        self.assertEqual(len(writes[-1]["errors"]), 1)

    def test_resume_restores_each_exact_pre_pause_state(self):
        saved = {
            "status": "pause-partial",
            "schedules": {
                "was-enabled": {"state": "ENABLED"},
                "was-disabled": {"state": "DISABLED"},
            },
            "watchdogRule": {"state": "DISABLED"},
            "alarms": {
                "alarm-on": {"actionsEnabled": True},
                "alarm-off": {"actionsEnabled": False},
            },
            "functions": {
                "unreserved": {"reservedConcurrentExecutions": None},
                "reserved": {"reservedConcurrentExecutions": 3},
            },
        }
        with mock.patch.object(guardian, "_read_state", return_value=saved), mock.patch.object(
            guardian, "_set_schedule_state"
        ) as set_schedule, mock.patch.object(
            guardian, "_set_watchdog_state"
        ) as set_watchdog, mock.patch.object(
            guardian, "_set_alarm_actions"
        ) as set_alarm, mock.patch.object(
            guardian, "_set_function_concurrency"
        ) as set_concurrency, mock.patch.object(
            guardian, "_write_state"
        ), mock.patch.object(
            guardian, "_publish_summary"
        ):
            result = guardian.resume()

        self.assertEqual(result["status"], "resumed")
        set_schedule.assert_has_calls(
            [mock.call("was-enabled", "ENABLED"), mock.call("was-disabled", "DISABLED")]
        )
        set_watchdog.assert_called_once_with("DISABLED")
        set_alarm.assert_has_calls(
            [mock.call("alarm-on", True), mock.call("alarm-off", False)]
        )
        set_concurrency.assert_has_calls(
            [mock.call("unreserved", None), mock.call("reserved", 3)]
        )


if __name__ == "__main__":
    unittest.main()
