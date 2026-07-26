#!/usr/bin/env python3
"""Safety and contract tests for the staged reliability activation command."""

from __future__ import annotations

import io
import json
import os
import sys
import unittest
from contextlib import redirect_stderr
from datetime import datetime, timedelta, timezone
from pathlib import Path


os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "infra" / "scripts"))

import activate_reliability as activation  # noqa: E402


def heartbeat(
    service_id: str,
    schedule_id: str,
    observed_at: datetime,
    *,
    status: str = "success",
) -> dict:
    return {
        "serviceId": service_id,
        "observedAt": observed_at.isoformat(),
        "status": status,
        "source": "aws-lambda",
        "triggerSource": "aws-scheduler",
        "scheduleId": schedule_id,
        "scheduled": True,
        "counts": {"errors": 0, "dropped": 0},
    }


class ReliabilityActivationTests(unittest.TestCase):
    def test_apply_requires_explicit_phase_and_admin_profile(self):
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                activation.parse_args(["--apply"])
            with self.assertRaises(SystemExit):
                activation.parse_args(["--apply", "--phase", "gmail"])
        parsed = activation.parse_args(
            [
                "--apply",
                "--phase",
                "gmail",
                "--admin-profile",
                "production-admin",
            ]
        )
        self.assertTrue(parsed.apply)
        self.assertEqual(parsed.admin_profile, "production-admin")

    def test_region_is_pinned(self):
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                activation.parse_args(["--region", "us-east-1"])

    def test_target_state_is_monotonic_and_explicit(self):
        current = {name: "DISABLED" for name in activation.CONTROL_PARAMETERS}
        current["QuantDeveloperScheduleState"] = "ENABLED"
        target = activation.target_control_state("analyst", current)
        self.assertEqual(
            target,
            {
                "GmailScheduleState": "ENABLED",
                "QuantAnalystScheduleState": "ENABLED",
                "QuantDeveloperScheduleState": "ENABLED",
                "SecurityScheduleState": "DISABLED",
                "OperationalAlarmsState": "DISABLED",
            },
        )

    def test_deployment_preserves_every_non_control_parameter(self):
        current = {name: f"value-{name}" for name in activation.ALL_PARAMETER_NAMES}
        for name in activation.CONTROL_PARAMETERS:
            current[name] = "DISABLED"
        controls = activation.target_control_state("full", current)
        result = activation.deployment_parameters(
            current, controls, build_version="9.9.9"
        )
        self.assertEqual(set(result), set(activation.ALL_PARAMETER_NAMES))
        self.assertEqual(result["AlertEmail"], current["AlertEmail"])
        self.assertEqual(result["BridgeHostId"], current["BridgeHostId"])
        self.assertEqual(result["BuildVersion"], "9.9.9")
        self.assertTrue(
            all(result[name] == "ENABLED" for name in activation.CONTROL_PARAMETERS)
        )

    def test_disabled_gmail_dry_run_never_invokes_canary(self):
        controller = object.__new__(activation.ActivationController)
        controller.phase = "gmail"
        controller.apply = False
        controller.parameters = {"GmailScheduleState": "DISABLED"}
        controller.secret_check = lambda: {"passed": True}
        controller.function_check = lambda kind: {"passed": True, "kind": kind}

        def forbidden_canary():
            self.fail("dry-run invoked the Gmail Lambda")

        controller.canary_gmail = forbidden_canary
        checks = controller.require_rollout_prerequisites()
        self.assertEqual(checks[-1]["code"], "GMAIL_OAUTH_CANARY_WILL_RUN")
        self.assertTrue(checks[-1]["pendingApply"])

    def test_apply_configuration_is_validated_before_any_canary(self):
        controller = object.__new__(activation.ActivationController)
        controller.apply = True
        controller.admin_profile = "production-admin"
        controller.cloudformation_role_arn = None

        def forbidden_preflight():
            self.fail("canary preflight ran before mutation configuration validation")

        controller.require_rollout_prerequisites = forbidden_preflight
        with self.assertRaises(activation.ActivationFailure) as raised:
            controller.run_rollout()
        self.assertEqual(raised.exception.code, "CLOUDFORMATION_ROLE_REQUIRED")

    def test_24_7_heartbeat_window_accepts_weekend_cadence(self):
        now = datetime(2026, 7, 25, 18, 0, tzinfo=timezone.utc)  # Saturday
        rows = [
            heartbeat("hermes:quant-analyst", "analyst-schedule", now - timedelta(minutes=15 * index))
            for index in range(3)
        ]
        result = activation.heartbeat_window(
            rows,
            service_id="hermes:quant-analyst",
            schedule_id="analyst-schedule",
            required=3,
            cadence_minutes=15,
            allowed_statuses={"success", "warning"},
            now=now,
        )
        self.assertTrue(result["passed"], result)

    def test_24_7_heartbeat_window_rejects_off_hour_gap(self):
        now = datetime(2026, 7, 25, 18, 0, tzinfo=timezone.utc)
        rows = [
            heartbeat("hermes:security", "security-schedule", now),
            heartbeat(
                "hermes:security",
                "security-schedule",
                now - timedelta(hours=1),
            ),
            heartbeat(
                "hermes:security",
                "security-schedule",
                now - timedelta(hours=13),
            ),
        ]
        result = activation.heartbeat_window(
            rows,
            service_id="hermes:security",
            schedule_id="security-schedule",
            required=3,
            cadence_minutes=60,
            allowed_statuses={"success", "warning"},
            now=now,
        )
        self.assertFalse(result["passed"])
        self.assertIn(
            "HEARTBEAT_CADENCE_INVALID",
            {failure["code"] for failure in result["failures"]},
        )

    def test_gmail_canary_response_exposes_only_counts(self):
        response = {
            "Payload": io.BytesIO(
                json.dumps(
                    {
                        "statusCode": 200,
                        "body": json.dumps(
                            {
                                "status": "SUCCESS",
                                "messageCount": 1,
                                "storedCount": 1,
                                "results": [
                                    {
                                        "subject": "private subject",
                                        "sender": "private@example.com",
                                    }
                                ],
                            }
                        ),
                    }
                ).encode()
            )
        }
        result = activation.parse_lambda_result(
            response, kind="GMAIL", accepted_statuses={"SUCCESS"}
        )
        self.assertEqual(
            result,
            {
                "status": "SUCCESS",
                "messageCount": 1,
                "storedCount": 1,
                "skippedCount": 0,
                "errorCount": 0,
                "errorCodes": [],
            },
        )
        self.assertNotIn("private subject", json.dumps(result))

    def test_gmail_auth_failure_keeps_typed_code(self):
        response = {
            "Payload": io.BytesIO(
                json.dumps(
                    {
                        "statusCode": 200,
                        "body": json.dumps(
                            {
                                "status": "AUTH_REQUIRED",
                                "errorCode": "GMAIL_AUTH_REQUIRED",
                            }
                        ),
                    }
                ).encode()
            )
        }
        with self.assertRaises(activation.ActivationFailure) as raised:
            activation.parse_lambda_result(
                response, kind="GMAIL", accepted_statuses={"SUCCESS"}
            )
        self.assertEqual(raised.exception.code, "GMAIL_AUTH_REQUIRED")

    def test_alarm_verification_requires_failure_and_recovery_actions(self):
        topic = (
            "arn:aws:sns:us-west-1:915328198276:"
            "market-dashboard-operations-v2"
        )
        alarms = []
        for name in activation.ALARM_NAMES:
            contract = activation.ALARM_CONTRACTS[name]
            alarm = {
                "AlarmName": name,
                "Namespace": contract["namespace"],
                "MetricName": contract["metric"],
                "Statistic": contract["statistic"],
                "ComparisonOperator": contract["comparison"],
                "Period": contract["period"],
                "EvaluationPeriods": 1,
                "Threshold": 1,
                "TreatMissingData": contract.get(
                    "missingData", contract.get("missingDataWhenEnabled")
                ),
                "ActionsEnabled": True,
                "AlarmActions": [topic],
                "OKActions": [topic],
            }
            if contract.get("serviceId"):
                alarm["Dimensions"] = [
                    {"Name": "ServiceId", "Value": contract["serviceId"]}
                ]
            alarms.append(alarm)
        self.assertTrue(
            activation.verify_alarms(
                alarms, actions_enabled=True, topic_arn=topic
            )["passed"]
        )
        alarms[0]["OKActions"] = []
        result = activation.verify_alarms(
            alarms, actions_enabled=True, topic_arn=topic
        )
        self.assertFalse(result["passed"])
        self.assertEqual(
            result["failures"][0]["code"], "ALARM_OK_ACTION_TARGET_MISMATCH"
        )

    def test_script_has_no_secret_read_or_access_key_creation_call(self):
        source = (
            REPO_ROOT / "infra" / "scripts" / "activate_reliability.py"
        ).read_text(encoding="utf-8")
        self.assertNotIn(".get_secret_value(", source)
        self.assertNotIn(".create_access_key(", source)
        self.assertNotIn(".put_secret_value(", source)


if __name__ == "__main__":
    unittest.main()
