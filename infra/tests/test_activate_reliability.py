#!/usr/bin/env python3
"""Safety and contract tests for the staged reliability activation command."""

from __future__ import annotations

import io
import hashlib
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from unittest import mock


os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "infra" / "scripts"))

import activate_reliability as activation  # noqa: E402


TEST_RELEASE_COMMIT = "a" * 40


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
    def rollout_controller(self, phase: str = "gmail"):
        controller = object.__new__(activation.ActivationController)
        controller.phase = phase
        controller.apply = True
        controller.parameters = {
            name: f"value-{name}" for name in activation.ALL_PARAMETER_NAMES
        }
        for name in activation.CONTROL_PARAMETERS:
            controller.parameters[name] = "DISABLED"
        controller.parameters["BuildVersion"] = TEST_RELEASE_COMMIT
        controller.release_verification = {
            "releaseCommit": TEST_RELEASE_COMMIT,
            "receiptPath": "/private/tested-release-receipt.json",
            "templatePath": "/private/packaged-template.yaml",
            "templateSha256": "b" * 64,
            "templateCanonicalSha256": "c" * 64,
            "artifacts": [],
        }
        controller.contract = {"workers": {}}
        controller.validate_apply_configuration = lambda: None
        controller.require_rollout_prerequisites = lambda: []
        controller.repair_all_controls_disabled = lambda: {
            "passed": True,
            "performed": False,
            "schedulesDisabled": [],
            "watchdogRuleDisabled": False,
            "alarmActionsDisabled": [],
            "failures": [],
        }
        return controller

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
                "--rollback-export",
                "/tmp/verified-rollback",
                "--release-receipt",
                "/tmp/tested-release-receipt.json",
            ]
        )
        self.assertTrue(parsed.apply)
        self.assertEqual(parsed.admin_profile, "production-admin")

    def test_region_is_pinned(self):
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                activation.parse_args(["--region", "us-east-1"])

    def test_disabled_recovery_phase_is_apply_only(self):
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                activation.parse_args(["--phase", "disabled"])
        parsed = activation.parse_args(
            [
                "--phase",
                "disabled",
                "--apply",
                "--admin-profile",
                "market-dashboard-admin",
                "--rollback-export",
                "/tmp/verified-rollback",
                "--release-receipt",
                "/tmp/tested-release-receipt.json",
            ]
        )
        self.assertTrue(parsed.apply)
        self.assertEqual(parsed.phase, "disabled")

    def test_auth_probe_only_requires_gmail_apply(self):
        invalid = (
            ["--phase", "gmail", "--auth-probe-only"],
            [
                "--phase",
                "disabled",
                "--apply",
                "--admin-profile",
                "market-dashboard-admin",
                "--rollback-export",
                "/tmp/verified-rollback",
                "--auth-probe-only",
            ],
        )
        for arguments in invalid:
            with self.subTest(arguments=arguments), redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    activation.parse_args(arguments)
        parsed = activation.parse_args(
            [
                "--phase",
                "gmail",
                "--apply",
                "--admin-profile",
                "market-dashboard-admin",
                "--rollback-export",
                "/tmp/verified-rollback",
                "--auth-probe-only",
            ]
        )
        self.assertTrue(parsed.auth_probe_only)

    def test_analyst_target_is_exact_and_includes_every_prior_stage(self):
        current = {name: "DISABLED" for name in activation.CONTROL_PARAMETERS}
        current["QuantDeveloperScheduleState"] = "ENABLED"
        target = activation.target_control_state("analyst", current)
        self.assertEqual(
            target,
            {
                "CloudWatchdogScheduleState": "ENABLED",
                "GmailScheduleState": "ENABLED",
                "QuantAnalystScheduleState": "ENABLED",
                "QuantDeveloperScheduleState": "ENABLED",
                "SecurityScheduleState": "ENABLED",
                "OperationalAlarmsState": "DISABLED",
            },
        )

    def test_gmail_phase_keeps_developer_and_disables_later_controls(self):
        current = {
            name: "ENABLED" for name in activation.CONTROL_PARAMETERS
        }
        target = activation.target_control_state("gmail", current)
        self.assertEqual(
            target,
            {
                "CloudWatchdogScheduleState": "ENABLED",
                "GmailScheduleState": "ENABLED",
                "QuantAnalystScheduleState": "DISABLED",
                "QuantDeveloperScheduleState": "ENABLED",
                "SecurityScheduleState": "DISABLED",
                "OperationalAlarmsState": "DISABLED",
            },
        )

    def test_disabled_phase_forces_every_control_off(self):
        current = {
            name: "ENABLED" for name in activation.CONTROL_PARAMETERS
        }
        self.assertEqual(
            activation.target_control_state("disabled", current),
            {
                name: "DISABLED" for name in activation.CONTROL_PARAMETERS
            },
        )

    def test_operations_bridge_canary_does_not_require_portfolio(self):
        now = datetime(2026, 7, 27, 20, tzinfo=timezone.utc)
        capabilities = {
            capability_id: {"status": "ready", "ready": True}
            for capability_id in {
                "automation.hermes",
                "dashboard.core",
                "portfolio.live",
                "prediction.display",
                "prediction.ibkrExecution",
                "research.current",
            }
        }
        result = activation.validate_bridge_snapshot(
            {
                "hostId": "tim-market-dashboard#operations",
                "schemaVersion": 2,
                "snapshotType": "operations",
                "capturedAt": now.isoformat(),
                "source": "local-outbound-bridge",
                "bridgeStatus": "ready",
                "capabilities": capabilities,
                "rootCauses": [],
            },
            expected_capabilities=set(capabilities),
            now=now,
        )
        self.assertEqual(result["snapshotType"], "operations")

    def test_portfolio_bridge_canary_still_requires_verified_live_ibkr(self):
        now = datetime(2026, 7, 27, 20, tzinfo=timezone.utc)
        with self.assertRaises(activation.ActivationFailure) as caught:
            activation.validate_bridge_snapshot(
                {
                    "hostId": "tim-market-dashboard#portfolio",
                    "schemaVersion": 2,
                    "snapshotType": "portfolio",
                    "capturedAt": now.isoformat(),
                    "source": "local-outbound-bridge",
                    "bridgeStatus": "ready",
                    "capabilities": {
                        "portfolio.live": {"status": "ready", "ready": True}
                    },
                    "portfolio": {
                        "verified": False,
                        "source": "unavailable",
                        "accountsVerified": False,
                    },
                    "gateway": {"connected": False},
                },
                expected_capabilities={"portfolio.live"},
                snapshot_type="portfolio",
                now=now,
            )
        self.assertEqual(caught.exception.code, "PORTFOLIO_NOT_VERIFIED_LIVE")

    def test_disabled_recovery_has_no_runtime_or_heartbeat_prerequisites(self):
        controller = object.__new__(activation.ActivationController)
        controller.phase = "disabled"
        for name in (
            "secret_check",
            "function_check",
            "gmail_heartbeat",
            "worker_heartbeat",
            "bridge_check",
            "subscription_check",
        ):
            setattr(
                controller,
                name,
                lambda name=name: self.fail(
                    f"disabled recovery unexpectedly called {name}"
                ),
            )
        self.assertEqual(controller.require_rollout_prerequisites(), [])

    def test_heartbeat_pending_accepts_only_incomplete_observation_windows(self):
        self.assertTrue(
            activation.heartbeat_observation_pending(
                {
                    "passed": False,
                    "failures": [
                        {"code": "HEARTBEAT_COUNT_INSUFFICIENT"},
                        {"code": "HEARTBEAT_STALE"},
                    ],
                }
            )
        )
        self.assertFalse(
            activation.heartbeat_observation_pending(
                {
                    "passed": False,
                    "failures": [
                        {"code": "HEARTBEAT_COUNT_INSUFFICIENT"},
                        {"code": "HEARTBEAT_STATUS_UNHEALTHY"},
                    ],
                }
            )
        )

    def test_deployment_preserves_every_non_control_parameter(self):
        current = {name: f"value-{name}" for name in activation.ALL_PARAMETER_NAMES}
        for name in activation.CONTROL_PARAMETERS:
            current[name] = "DISABLED"
        current["BuildVersion"] = TEST_RELEASE_COMMIT
        controls = activation.target_control_state("full", current)
        result = activation.deployment_parameters(
            current, controls, build_version=TEST_RELEASE_COMMIT
        )
        self.assertEqual(set(result), set(activation.ALL_PARAMETER_NAMES))
        self.assertEqual(result["AlertEmail"], current["AlertEmail"])
        self.assertEqual(result["BridgeHostId"], current["BridgeHostId"])
        self.assertEqual(result["BuildVersion"], TEST_RELEASE_COMMIT)
        self.assertTrue(
            all(result[name] == "ENABLED" for name in activation.CONTROL_PARAMETERS)
        )

    def test_activation_rejects_a_different_deployed_build_version(self):
        current = {
            name: f"value-{name}"
            for name in activation.ALL_PARAMETER_NAMES
        }
        for name in activation.CONTROL_PARAMETERS:
            current[name] = "DISABLED"
        current["BuildVersion"] = "b" * 40
        with self.assertRaises(activation.ActivationFailure) as caught:
            activation.deployment_parameters(
                current,
                activation.target_control_state("developer", current),
                build_version=TEST_RELEASE_COMMIT,
            )
        self.assertEqual(
            caught.exception.code,
            "STACK_BUILD_VERSION_MISMATCH",
        )

    def test_deployed_release_verifies_build_template_and_s3_versions(self):
        artifact_body = b"tested-artifact"
        template_object_body = b"tested-template-object"
        template = {
            "Parameters": {"BuildVersion": {"Type": "String"}},
            "Resources": {
                "Worker": {
                    "Type": "AWS::Serverless::Function",
                    "Properties": {
                        "CodeUri": {
                            "Bucket": activation.EXPECTED_ARTIFACT_BUCKET,
                            "Key": "tested-releases/code.zip",
                            "Version": "version-1",
                        }
                    },
                }
            },
        }
        controller = object.__new__(activation.ActivationController)
        controller.parameters = {"BuildVersion": TEST_RELEASE_COMMIT}
        controller.release_verification = {
            "releaseCommit": TEST_RELEASE_COMMIT,
            "templateCanonicalSha256": (
                activation.canonical_template_sha256(template)
            ),
            "templateObject": {
                "bucket": activation.EXPECTED_ARTIFACT_BUCKET,
                "key": "tested-releases/template.yaml",
                "versionId": "template-version-1",
                "contentSha256": hashlib.sha256(
                    template_object_body
                ).hexdigest(),
                "contentLength": len(template_object_body),
            },
            "artifacts": [
                {
                    "bucket": activation.EXPECTED_ARTIFACT_BUCKET,
                    "key": "tested-releases/code.zip",
                    "versionId": "version-1",
                    "contentSha256": hashlib.sha256(
                        artifact_body
                    ).hexdigest(),
                    "contentLength": len(artifact_body),
                }
            ],
        }
        controller.runtime = type(
            "Runtime",
            (),
            {
                "stack_template": staticmethod(
                    lambda: {"TemplateBody": template}
                ),
                "release_artifact": staticmethod(
                    lambda item: (
                        {
                            "VersionId": "template-version-1",
                            "Body": io.BytesIO(template_object_body),
                        }
                        if item["key"].endswith("template.yaml")
                        else {
                            "VersionId": "version-1",
                            "Body": io.BytesIO(artifact_body),
                        }
                    )
                ),
            },
        )()

        result = controller.verify_deployed_tested_release()

        self.assertTrue(result["passed"])
        self.assertEqual(result["releaseCommit"], TEST_RELEASE_COMMIT)
        self.assertEqual(result["artifactCount"], 1)

    def test_staged_deploy_rejects_non_control_parameter_changes(self):
        controller = self.rollout_controller("developer")
        controller.validate_apply_configuration = lambda: None
        controller.admin_profile = "market-dashboard-admin"
        controller.cloudformation_role_arn = activation.DEPLOYMENT_ROLE_ARN
        parameters = dict(controller.parameters)
        parameters["AlertEmail"] = "different@example.com"
        with self.assertRaises(activation.ActivationFailure) as caught:
            controller.deploy(
                parameters,
                build_version=TEST_RELEASE_COMMIT,
            )
        self.assertEqual(
            caught.exception.code,
            "ACTIVATION_NON_CONTROL_PARAMETER_CHANGE",
        )

    def test_disabled_recovery_deploys_off_state_and_skips_heartbeats(self):
        controller = self.rollout_controller("disabled")
        for name in activation.CONTROL_PARAMETERS:
            controller.parameters[name] = "ENABLED"
        deployments = []
        controller.deploy = lambda parameters, **_: deployments.append(
            {
                name: parameters[name]
                for name in activation.CONTROL_PARAMETERS
            }
        ) or {"passed": True}
        controller.verify_post_deploy_controls = lambda controls: {
            "passed": True,
            "controls": dict(controls),
            "schedules": [],
            "alarms": {"passed": True},
            "operationsSubscription": {
                "passed": True,
                "notApplicable": True,
            },
        }
        controller.gmail_heartbeat = lambda: self.fail(
            "recovery queried Gmail heartbeat state"
        )

        report = controller.run_rollout()

        self.assertTrue(report["passed"])
        self.assertEqual(
            deployments,
            [
                {
                    name: "DISABLED"
                    for name in activation.CONTROL_PARAMETERS
                }
            ],
        )
        self.assertEqual(report["verification"]["heartbeats"], [])
        self.assertTrue(report["verification"]["heartbeatWindowsPassed"])
        self.assertFalse(
            report["verification"]["heartbeatObservationPending"]
        )
        self.assertFalse(report["driftRepair"]["performed"])

    def test_disabled_recovery_repairs_external_control_drift_before_verify(self):
        controller = self.rollout_controller("disabled")
        events = []
        controller.deploy = lambda *_args, **_kwargs: events.append(
            "deploy"
        ) or {"passed": True}
        controller.repair_all_controls_disabled = lambda: events.append(
            "repair"
        ) or {
            "passed": True,
            "performed": True,
            "schedulesDisabled": ["market-dashboard-hermes-quant-developer-v2"],
            "watchdogRuleDisabled": False,
            "alarmActionsDisabled": [],
            "failures": [],
        }
        controller.verify_post_deploy_controls = lambda _controls: events.append(
            "verify"
        ) or {
            "passed": True,
            "controls": {
                name: "DISABLED" for name in activation.CONTROL_PARAMETERS
            },
            "schedules": [],
            "alarms": {"passed": True},
            "operationsSubscription": {
                "passed": True,
                "notApplicable": True,
            },
        }

        report = controller.run_rollout()

        self.assertEqual(events, ["deploy", "repair", "verify"])
        self.assertTrue(report["driftRepair"]["performed"])

    def test_schedule_disable_preserves_the_complete_owned_definition(self):
        calls = []
        runtime = object.__new__(activation.AwsRuntime)
        runtime.scheduler = type(
            "Scheduler",
            (),
            {
                "update_schedule": staticmethod(
                    lambda **request: calls.append(request) or {}
                )
            },
        )()
        current = {
            "Name": "market-dashboard-hermes-quant-developer-v2",
            "State": "ENABLED",
            "ScheduleExpression": "cron(5/15 * ? * * *)",
            "ScheduleExpressionTimezone": "America/New_York",
            "ActionAfterCompletion": "NONE",
            "Description": "Developer schedule",
            "StartDate": "2026-07-01T00:00:00Z",
            "EndDate": "2027-07-01T00:00:00Z",
            "FlexibleTimeWindow": {"Mode": "OFF"},
            "KmsKeyArn": "arn:aws:kms:us-west-1:915328198276:key/example",
            "Target": {
                "Arn": "arn:aws:lambda:us-west-1:915328198276:function:test",
                "RoleArn": "arn:aws:iam::915328198276:role/test",
                "Input": "{}",
                "RetryPolicy": {"MaximumRetryAttempts": 2},
            },
        }

        runtime.disable_schedule(current["Name"], current)

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["State"], "DISABLED")
        self.assertEqual(
            calls[0]["ScheduleExpression"],
            current["ScheduleExpression"],
        )
        self.assertEqual(calls[0]["Target"], current["Target"])
        self.assertEqual(calls[0]["FlexibleTimeWindow"], {"Mode": "OFF"})
        for key in (
            "ActionAfterCompletion",
            "Description",
            "StartDate",
            "EndDate",
            "KmsKeyArn",
            "ScheduleExpressionTimezone",
        ):
            self.assertEqual(calls[0][key], current[key])

    def test_disabled_repair_isolates_failures_and_attempts_later_controls(self):
        controller = object.__new__(activation.ActivationController)
        controller.schedule_specifications = lambda _controls: [
            {"name": "gmail"},
            {"name": "developer"},
            {"name": "security"},
        ]
        events = []

        class Runtime:
            def schedule(self, name):
                events.append(("read-schedule", name))
                if name == "gmail":
                    raise activation.ActivationFailure(
                        "SCHEDULE_READ_FAILED",
                        "Synthetic read failure.",
                    )
                return {
                    "State": "ENABLED" if name == "developer" else "DISABLED"
                }

            def disable_schedule(self, name, _current):
                events.append(("disable-schedule", name))

            def watchdog_rule(self):
                raise activation.ActivationFailure(
                    "WATCHDOG_READ_FAILED",
                    "Synthetic read failure.",
                )

            def disable_watchdog_rule(self):
                events.append(("disable-watchdog",))

            def alarms(self):
                raise activation.ActivationFailure(
                    "ALARM_READ_FAILED",
                    "Synthetic read failure.",
                )

            def disable_alarm_actions(self, names):
                events.append(("disable-alarm", names[0]))

        controller.runtime = Runtime()

        result = controller.repair_all_controls_disabled()

        self.assertFalse(result["passed"])
        self.assertEqual(
            [failure["name"] for failure in result["failures"]],
            ["gmail"],
        )
        self.assertIn(("disable-schedule", "developer"), events)
        self.assertIn(("disable-watchdog",), events)
        self.assertEqual(
            {
                event[1]
                for event in events
                if event[0] == "disable-alarm"
            },
            set(activation.ALARM_NAMES),
        )

    def test_post_deploy_verification_failure_compensates_to_disabled(self):
        controller = self.rollout_controller()
        deployments = []

        def deploy(parameters, **_):
            controls = {
                name: parameters[name]
                for name in activation.CONTROL_PARAMETERS
            }
            deployments.append(controls)
            return {"passed": True, "controls": controls}

        def verify(controls):
            if controls["GmailScheduleState"] == "ENABLED":
                raise activation.ActivationFailure(
                    "SCHEDULE_STATE_MISMATCH",
                    "Gmail schedule verification failed.",
                )
            return {
                "passed": True,
                "controls": dict(controls),
                "schedules": [],
                "alarms": {"passed": True},
                "operationsSubscription": {
                    "passed": True,
                    "notApplicable": True,
                },
            }

        controller.deploy = deploy
        controller.verify_post_deploy_controls = verify

        with self.assertRaises(activation.ActivationFailure) as raised:
            controller.run_rollout()

        self.assertEqual(
            raised.exception.code,
            "POST_DEPLOY_VERIFICATION_FAILED",
        )
        self.assertEqual(deployments[0]["GmailScheduleState"], "ENABLED")
        self.assertTrue(
            all(
                state == "DISABLED"
                for state in deployments[1].values()
            )
        )
        compensation = raised.exception.detail["compensation"]
        self.assertTrue(
            raised.exception.detail["initialDeploymentSucceeded"]
        )
        self.assertTrue(compensation["succeeded"])
        self.assertTrue(compensation["deploymentSucceeded"])
        self.assertTrue(compensation["verificationSucceeded"])
        self.assertEqual(
            raised.exception.detail["verificationFailure"]["code"],
            "SCHEDULE_STATE_MISMATCH",
        )

    def test_initial_activation_deploy_failure_attempts_disabled_compensation(self):
        controller = self.rollout_controller()
        deployments = []

        def deploy(parameters, **_):
            controls = {
                name: parameters[name]
                for name in activation.CONTROL_PARAMETERS
            }
            deployments.append(controls)
            if len(deployments) == 1:
                raise activation.ActivationFailure(
                    "SAM_DEPLOY_FAILED",
                    "Initial activation deploy may have partially updated.",
                )
            return {"passed": True, "controls": controls}

        controller.deploy = deploy
        controller.verify_post_deploy_controls = lambda controls: {
            "passed": True,
            "controls": dict(controls),
            "schedules": [],
            "alarms": {"passed": True},
            "operationsSubscription": {
                "passed": True,
                "notApplicable": True,
            },
        }

        with self.assertRaises(activation.ActivationFailure) as raised:
            controller.run_rollout()

        self.assertEqual(
            raised.exception.code,
            "ROLLOUT_DEPLOYMENT_FAILED",
        )
        self.assertFalse(
            raised.exception.detail["initialDeploymentSucceeded"]
        )
        self.assertEqual(
            raised.exception.detail["deploymentFailure"]["code"],
            "SAM_DEPLOY_FAILED",
        )
        self.assertNotIn("initialDeployment", raised.exception.detail)
        self.assertEqual(len(deployments), 2)
        self.assertEqual(deployments[0]["GmailScheduleState"], "ENABLED")
        self.assertTrue(
            all(
                state == "DISABLED"
                for state in deployments[1].values()
            )
        )
        self.assertTrue(
            raised.exception.detail["compensation"]["succeeded"]
        )

    def test_disabled_recovery_failure_does_not_recursively_compensate(self):
        controller = self.rollout_controller("disabled")
        deployment_count = 0

        def deploy(_parameters, **_):
            nonlocal deployment_count
            deployment_count += 1
            raise activation.ActivationFailure(
                "SAM_DEPLOY_FAILED",
                "Disabled recovery deployment failed.",
            )

        controller.deploy = deploy
        controller.repair_all_controls_disabled = lambda: {
            "passed": True,
            "performed": True,
            "schedulesDisabled": ["gmail"],
            "watchdogRuleDisabled": True,
            "alarmActionsDisabled": [],
            "failures": [],
        }
        controller.verify_post_deploy_controls = lambda _controls: {
            "passed": True,
        }
        with self.assertRaises(activation.ActivationFailure) as raised:
            controller.run_rollout()

        self.assertEqual(raised.exception.code, "SAM_DEPLOY_FAILED")
        self.assertEqual(deployment_count, 1)
        self.assertTrue(
            raised.exception.detail["controlsVerifiedDisabled"]
        )

    def test_failed_compensation_is_explicitly_reported(self):
        controller = self.rollout_controller()
        deployment_count = 0

        def deploy(_parameters, **_):
            nonlocal deployment_count
            deployment_count += 1
            if deployment_count == 2:
                raise activation.ActivationFailure(
                    "SAM_DEPLOY_FAILED",
                    "Recovery deployment failed.",
                )
            return {"passed": True}

        controller.deploy = deploy
        controller.verify_post_deploy_controls = lambda _controls: (
            _ for _ in ()
        ).throw(
            activation.ActivationFailure(
                "ALARM_ACTION_STATE_MISMATCH",
                "Alarm verification failed.",
            )
        )

        with self.assertRaises(activation.ActivationFailure) as raised:
            controller.run_rollout()

        compensation = raised.exception.detail["compensation"]
        self.assertFalse(compensation["succeeded"])
        self.assertFalse(compensation["deploymentSucceeded"])
        self.assertFalse(compensation["verificationSucceeded"])
        self.assertEqual(
            compensation["failure"]["code"],
            "SAM_DEPLOY_FAILED",
        )
        self.assertIn(
            "potentially enabled",
            raised.exception.message,
        )

    def test_new_gmail_schedule_can_wait_for_an_incomplete_window(self):
        controller = self.rollout_controller()
        deployments = []
        watermarks = []
        service_id = "gmail:test@example.com"
        schedule_id = "gmail-schedule"
        historical_error = heartbeat(
            service_id,
            schedule_id,
            datetime.now(timezone.utc) - timedelta(hours=1),
            status="error",
        )
        controller.deploy = lambda parameters, **_: deployments.append(
            dict(parameters)
        ) or {"passed": True}
        controller.verify_post_deploy_controls = lambda controls: {
            "passed": True,
            "controls": dict(controls),
            "schedules": [],
            "alarms": {"passed": True},
            "operationsSubscription": {
                "passed": True,
                "notApplicable": True,
            },
        }

        def gmail_heartbeat(*, observed_after):
            watermarks.append(observed_after)
            return activation.heartbeat_window(
                activation.heartbeats_after_watermark(
                    [historical_error],
                    observed_after,
                ),
                service_id=service_id,
                schedule_id=schedule_id,
                required=4,
                cadence_minutes=15,
                allowed_statuses={"success"},
            )

        controller.gmail_heartbeat = gmail_heartbeat

        report = controller.run_rollout()

        self.assertEqual(len(deployments), 1)
        self.assertEqual(len(watermarks), 1)
        self.assertIsNotNone(activation.parse_timestamp(watermarks[0]))
        self.assertTrue(report["verification"]["heartbeatObservationPending"])
        self.assertEqual(
            report["verification"]["heartbeats"][0]["code"],
            "GMAIL_SCHEDULE_OBSERVATION_PENDING",
        )

    def test_existing_gmail_apply_defers_heartbeat_into_compensation_coverage(self):
        controller = object.__new__(activation.ActivationController)
        controller.phase = "gmail"
        controller.apply = True
        controller.auth_probe_only = False
        controller.parameters = {"GmailScheduleState": "ENABLED"}
        controller.secret_check = lambda: {"passed": True, "kind": "secret"}
        controller.function_check = lambda kind: {
            "passed": True,
            "kind": kind,
        }
        controller.worker_heartbeat = lambda worker: {
            "passed": True,
            "worker": worker,
        }
        controller.bridge_check = lambda worker: {
            "passed": True,
            "worker": worker,
        }
        controller.gmail_heartbeat = lambda: self.fail(
            "apply preflight read the heartbeat outside compensation coverage"
        )
        controller.canary_gmail = lambda: self.fail(
            "existing Gmail schedule unexpectedly invoked the OAuth canary"
        )

        checks = controller.require_rollout_prerequisites()

        self.assertEqual(
            checks[-1]["code"],
            "GMAIL_HEARTBEAT_VERIFICATION_DEFERRED",
        )
        self.assertTrue(checks[-1]["verificationDeferred"])

    def test_existing_gmail_incomplete_window_compensates_to_disabled(self):
        controller = self.rollout_controller()
        controller.parameters["GmailScheduleState"] = "ENABLED"
        deployments = []
        controller.deploy = lambda parameters, **_: deployments.append(
            {
                name: parameters[name]
                for name in activation.CONTROL_PARAMETERS
            }
        ) or {"passed": True}
        controller.verify_post_deploy_controls = lambda controls: {
            "passed": True,
            "controls": dict(controls),
            "schedules": [],
            "alarms": {"passed": True},
            "operationsSubscription": {
                "passed": True,
                "notApplicable": True,
            },
        }
        controller.gmail_heartbeat = lambda: {
            "passed": False,
            "serviceId": "gmail:test@example.com",
            "latestAt": None,
            "failures": [
                {"code": "HEARTBEAT_COUNT_INSUFFICIENT"},
                {"code": "HEARTBEAT_STALE"},
            ],
        }

        with self.assertRaises(activation.ActivationFailure) as raised:
            controller.run_rollout()

        self.assertEqual(
            raised.exception.detail["verificationFailure"]["code"],
            "GMAIL_SCHEDULE_CANARY_FAILED",
        )
        self.assertEqual(len(deployments), 2)
        self.assertEqual(deployments[0]["GmailScheduleState"], "ENABLED")
        self.assertTrue(
            all(
                state == "DISABLED"
                for state in deployments[-1].values()
            )
        )
        self.assertTrue(
            raised.exception.detail["compensation"]["succeeded"]
        )

    def test_existing_gmail_apply_accepts_only_a_complete_heartbeat_window(self):
        controller = self.rollout_controller()
        controller.parameters["GmailScheduleState"] = "ENABLED"
        deployments = []
        controller.deploy = lambda parameters, **_: deployments.append(
            {
                name: parameters[name]
                for name in activation.CONTROL_PARAMETERS
            }
        ) or {"passed": True}
        controller.verify_post_deploy_controls = lambda controls: {
            "passed": True,
            "controls": dict(controls),
            "schedules": [],
            "alarms": {"passed": True},
            "operationsSubscription": {
                "passed": True,
                "notApplicable": True,
            },
        }
        controller.gmail_heartbeat = lambda: {
            "passed": True,
            "serviceId": "gmail:test@example.com",
            "latestAt": "2026-07-26T00:00:00+00:00",
            "required": 4,
            "observed": 4,
            "failures": [],
        }

        report = controller.run_rollout()

        self.assertEqual(len(deployments), 1)
        self.assertTrue(report["verification"]["heartbeatWindowsPassed"])
        self.assertFalse(
            report["verification"]["heartbeatObservationPending"]
        )

    def test_new_gmail_unhealthy_heartbeat_triggers_compensation(self):
        controller = self.rollout_controller()
        deployments = []
        watermarks = []
        controller.deploy = lambda parameters, **_: deployments.append(
            {
                name: parameters[name]
                for name in activation.CONTROL_PARAMETERS
            }
        ) or {"passed": True}
        controller.verify_post_deploy_controls = lambda controls: {
            "passed": True,
            "controls": dict(controls),
            "schedules": [],
            "alarms": {"passed": True},
            "operationsSubscription": {
                "passed": True,
                "notApplicable": True,
            },
        }

        def gmail_heartbeat(*, observed_after):
            watermarks.append(observed_after)
            observed_at = datetime.now(timezone.utc)
            service_id = "gmail:test@example.com"
            schedule_id = "gmail-schedule"
            return activation.heartbeat_window(
                activation.heartbeats_after_watermark(
                    [
                        heartbeat(
                            service_id,
                            schedule_id,
                            observed_at,
                            status="error",
                        )
                    ],
                    observed_after,
                ),
                service_id=service_id,
                schedule_id=schedule_id,
                required=4,
                cadence_minutes=15,
                allowed_statuses={"success"},
                now=observed_at,
            )

        controller.gmail_heartbeat = gmail_heartbeat

        with self.assertRaises(activation.ActivationFailure) as raised:
            controller.run_rollout()

        self.assertEqual(
            raised.exception.detail["verificationFailure"]["code"],
            "GMAIL_SCHEDULE_CANARY_FAILED",
        )
        self.assertEqual(len(watermarks), 1)
        self.assertIsNotNone(activation.parse_timestamp(watermarks[0]))
        self.assertEqual(len(deployments), 2)
        self.assertTrue(
            all(
                state == "DISABLED"
                for state in deployments[-1].values()
            )
        )
        self.assertTrue(
            raised.exception.detail["compensation"]["succeeded"]
        )

    def test_disabled_gmail_dry_run_never_invokes_canary(self):
        controller = object.__new__(activation.ActivationController)
        controller.phase = "gmail"
        controller.apply = False
        controller.parameters = {"GmailScheduleState": "DISABLED"}
        controller.secret_check = lambda: {"passed": True}
        controller.function_check = lambda kind: {"passed": True, "kind": kind}
        controller.worker_heartbeat = lambda worker: {
            "passed": True,
            "worker": worker,
        }
        controller.bridge_check = lambda worker: {
            "passed": True,
            "worker": worker,
        }

        def forbidden_canary():
            self.fail("dry-run invoked the Gmail Lambda")

        controller.canary_gmail = forbidden_canary
        checks = controller.require_rollout_prerequisites()
        self.assertEqual(checks[-1]["code"], "GMAIL_OAUTH_CANARY_WILL_RUN")
        self.assertTrue(checks[-1]["pendingApply"])

    def test_auth_probe_only_invokes_bounded_canary_without_deploying(self):
        controller = self.rollout_controller("gmail")
        controller.auth_probe_only = True
        controller.rollback_verification = {
            "passed": True,
            "path": "/tmp/verified-rollback",
        }
        controller.require_rollout_prerequisites = lambda: [
            {"passed": True, "status": "SUCCESS"}
        ]
        controller.deploy = lambda *_args, **_kwargs: self.fail(
            "auth-probe-only deployed the stack"
        )

        report = controller.run_rollout()

        self.assertTrue(report["passed"])
        self.assertEqual(report["mode"], "auth-probe-only")
        self.assertEqual(report["mutation"]["code"], "AUTH_PROBE_ONLY")
        self.assertFalse(report["mutation"]["performed"])
        self.assertEqual(
            report["currentControls"],
            report["targetControls"],
        )

    def test_auth_probe_only_prerequisites_always_run_the_gmail_canary(self):
        controller = object.__new__(activation.ActivationController)
        controller.phase = "gmail"
        controller.apply = True
        controller.auth_probe_only = True
        controller.parameters = {"GmailScheduleState": "ENABLED"}
        controller.secret_check = lambda: {"passed": True, "kind": "secret"}
        controller.function_check = lambda kind: {"passed": True, "kind": kind}
        controller.gmail_heartbeat = lambda: self.fail(
            "auth-probe-only used heartbeat instead of OAuth canary"
        )
        controller.canary_gmail = lambda: {
            "passed": True,
            "status": "SUCCESS",
        }

        checks = controller.require_rollout_prerequisites()

        self.assertEqual(checks[-1]["status"], "SUCCESS")

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

    def test_apply_requires_exact_artifact_bucket_before_any_canary(self):
        controller = object.__new__(activation.ActivationController)
        controller.apply = True
        controller.admin_profile = "market-dashboard-admin"
        controller.cloudformation_role_arn = activation.DEPLOYMENT_ROLE_ARN
        controller.rollback_verification = {"passed": True}
        controller.release_verification = {
            "releaseCommit": TEST_RELEASE_COMMIT,
            "receiptPath": "/private/tested-release-receipt.json",
            "templatePath": "/private/packaged-template.yaml",
            "templateSha256": "b" * 64,
            "templateCanonicalSha256": "c" * 64,
            "artifacts": [],
        }
        controller.parameters = {
            name: f"value-{name}"
            for name in activation.ALL_PARAMETER_NAMES
        }
        for name in activation.CONTROL_PARAMETERS:
            controller.parameters[name] = "DISABLED"
        controller.parameters["BuildVersion"] = TEST_RELEASE_COMMIT
        controller.verify_deployed_tested_release = lambda: {"passed": True}
        controller.runtime = type(
            "Runtime",
            (),
            {
                "artifact_bucket_tags": staticmethod(
                    lambda: {
                        "TagSet": [
                            {
                                "Key": "market-dashboard:owner",
                                "Value": "market-dashboard-readiness-v2",
                            },
                            {
                                "Key": "market-dashboard:purpose",
                                "Value": "sam-artifacts",
                            },
                        ]
                    }
                )
            },
        )()

        def forbidden_preflight():
            self.fail("canary preflight ran before artifact-bucket validation")

        controller.require_rollout_prerequisites = forbidden_preflight
        for environment in (
            {},
            {"MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET": "wrong-bucket"},
        ):
            with self.subTest(environment=environment):
                with (
                    mock.patch.dict(os.environ, environment, clear=True),
                    mock.patch.object(
                        activation.shutil, "which", return_value="/opt/homebrew/bin/sam"
                    ),
                    self.assertRaises(activation.ActivationFailure) as raised,
                ):
                    controller.run_rollout()
                self.assertEqual(
                    raised.exception.code, "SAM_ARTIFACT_BUCKET_REQUIRED"
                )

    def test_apply_requires_verified_rollback_export_before_any_canary(self):
        controller = object.__new__(activation.ActivationController)
        controller.apply = True
        controller.admin_profile = "market-dashboard-admin"
        controller.cloudformation_role_arn = activation.DEPLOYMENT_ROLE_ARN
        controller.rollback_export = None
        controller.rollback_verification = None
        controller.auth_probe_only = False
        controller.require_rollout_prerequisites = lambda: self.fail(
            "canary ran before rollback-export verification"
        )

        with (
            mock.patch.dict(
                os.environ,
                {
                    "MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET": (
                        activation.EXPECTED_ARTIFACT_BUCKET
                    )
                },
                clear=True,
            ),
            self.assertRaises(activation.ActivationFailure) as raised,
        ):
            controller.run_rollout()
        self.assertEqual(raised.exception.code, "ROLLBACK_EXPORT_REQUIRED")

    def test_rollback_export_verifier_checks_preflight_and_every_checksum(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            rollback = Path(temp_dir) / "rollback"
            rollback.mkdir(mode=0o700)
            preflight = rollback / "ownership-preflight.json"
            preflight.write_text(
                json.dumps(
                    {
                        "passed": True,
                        "conflicts": [],
                        "account": activation.EXPECTED_ACCOUNT,
                        "region": activation.EXPECTED_REGION,
                        "targetStack": activation.STACK_NAME,
                        "bootstrapStack": activation.BOOTSTRAP_STACK_NAME,
                    },
                    sort_keys=True,
                )
                + "\n",
                encoding="utf-8",
            )
            digest = hashlib.sha256(preflight.read_bytes()).hexdigest()
            (rollback / "SHA256SUMS").write_text(
                f"{digest}  ./ownership-preflight.json\n",
                encoding="utf-8",
            )

            result = activation.verify_rollback_export(rollback)
            self.assertTrue(result["passed"])
            self.assertEqual(result["artifactCount"], 1)

            preflight.write_text("{}\n", encoding="utf-8")
            with self.assertRaises(activation.ActivationFailure) as raised:
                activation.verify_rollback_export(rollback)
            self.assertEqual(
                raised.exception.code,
                "ROLLBACK_EXPORT_CHECKSUM_MISMATCH",
            )

    def test_read_only_identity_can_use_local_iam_but_apply_requires_sso(self):
        iam_identity = {
            "Account": activation.EXPECTED_ACCOUNT,
            "Arn": (
                f"arn:aws:iam::{activation.EXPECTED_ACCOUNT}:"
                "user/market-dashboard-local"
            ),
        }
        read_only = activation.validate_identity(
            iam_identity,
            region=activation.EXPECTED_REGION,
        )
        self.assertEqual(read_only["arn"], iam_identity["Arn"])

        with self.assertRaises(activation.ActivationFailure) as raised:
            activation.validate_identity(
                iam_identity,
                region=activation.EXPECTED_REGION,
                require_sso=True,
            )
        self.assertEqual(raised.exception.code, "AWS_SSO_IDENTITY_REQUIRED")

        sso_identity = {
            "Account": activation.EXPECTED_ACCOUNT,
            "Arn": (
                f"arn:aws:sts::{activation.EXPECTED_ACCOUNT}:assumed-role/"
                "AWSReservedSSO_AdministratorAccess_deadbeef/user@example.com"
            ),
        }
        applied = activation.validate_identity(
            sso_identity,
            region=activation.EXPECTED_REGION,
            require_sso=True,
        )
        self.assertEqual(applied["arn"], sso_identity["Arn"])

    def test_apply_controller_rejects_non_sso_identity_before_stack_access(self):
        class Runtime:
            region = activation.EXPECTED_REGION
            stack_accessed = False

            @staticmethod
            def identity():
                return {
                    "Account": activation.EXPECTED_ACCOUNT,
                    "Arn": (
                        f"arn:aws:iam::{activation.EXPECTED_ACCOUNT}:"
                        "user/permanent-admin"
                    ),
                }

            def stack(self):
                self.stack_accessed = True
                raise AssertionError("stack lookup followed a rejected apply identity")

        runtime = Runtime()
        controller = object.__new__(activation.ActivationController)
        controller.runtime = runtime
        controller.apply = True

        with self.assertRaises(activation.ActivationFailure) as raised:
            controller.initialize()

        self.assertEqual(raised.exception.code, "AWS_SSO_IDENTITY_REQUIRED")
        self.assertFalse(runtime.stack_accessed)

    def test_deploy_passes_exact_bucket_and_clears_ambient_credentials(self):
        controller = object.__new__(activation.ActivationController)
        controller.apply = True
        controller.admin_profile = "market-dashboard-admin"
        controller.cloudformation_role_arn = activation.DEPLOYMENT_ROLE_ARN
        controller.rollback_verification = {"passed": True}
        controller.release_verification = {
            "releaseCommit": TEST_RELEASE_COMMIT,
            "receiptPath": "/private/tested-release-receipt.json",
            "templatePath": "/private/packaged-template.yaml",
            "templateSha256": "b" * 64,
            "templateCanonicalSha256": "c" * 64,
            "artifacts": [],
        }
        controller.parameters = {
            name: f"value-{name}"
            for name in activation.ALL_PARAMETER_NAMES
        }
        for name in activation.CONTROL_PARAMETERS:
            controller.parameters[name] = "DISABLED"
        controller.parameters["BuildVersion"] = TEST_RELEASE_COMMIT
        controller.verify_deployed_tested_release = lambda: {"passed": True}
        controller.runtime = type(
            "Runtime",
            (),
            {
                "artifact_bucket_tags": staticmethod(
                    lambda: {
                        "TagSet": [
                            {
                                "Key": "market-dashboard:owner",
                                "Value": "market-dashboard-readiness-v2",
                            },
                            {
                                "Key": "market-dashboard:purpose",
                                "Value": "sam-artifacts",
                            },
                        ]
                    }
                )
            },
        )()
        parameters = dict(controller.parameters)
        poisoned_environment = {
            "MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET": (
                activation.EXPECTED_ARTIFACT_BUCKET
            ),
            "AWS_ACCESS_KEY_ID": "must-not-leak",
            "AWS_SECRET_ACCESS_KEY": "must-not-leak",
            "AWS_SESSION_TOKEN": "must-not-leak",
            "AWS_SECURITY_TOKEN": "must-not-leak",
            "AWS_PROFILE": "wrong-profile",
            "AWS_DEFAULT_PROFILE": "wrong-default-profile",
            "AWS_ROLE_ARN": "must-not-leak",
            "AWS_ROLE_SESSION_NAME": "must-not-leak",
            "AWS_WEB_IDENTITY_TOKEN_FILE": "/tmp/must-not-leak",
            "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI": "/must-not-leak",
            "AWS_CONTAINER_CREDENTIALS_FULL_URI": "http://example.test",
            "AWS_CONTAINER_AUTHORIZATION_TOKEN": "must-not-leak",
            "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE": "/tmp/must-not-leak",
            "AWS_SHARED_CREDENTIALS_FILE": "/tmp/must-not-leak",
            "AWS_CONFIG_FILE": "/tmp/must-not-leak",
        }
        completed = activation.subprocess.CompletedProcess(
            args=[], returncode=0, stdout="", stderr=""
        )

        with (
            mock.patch.dict(os.environ, poisoned_environment, clear=True),
            mock.patch.object(
                activation.shutil, "which", return_value="/opt/homebrew/bin/sam"
            ),
            mock.patch.object(
                activation.subprocess,
                "run",
                return_value=completed,
            ) as run,
        ):
            result = controller.deploy(
                parameters,
                build_version=TEST_RELEASE_COMMIT,
            )

        self.assertTrue(result["passed"])
        deploy_command = run.call_args_list[-1].args[0]
        self.assertEqual(len(run.call_args_list), 1)
        self.assertEqual(deploy_command[:2], ["sam", "deploy"])
        self.assertIn("--s3-bucket", deploy_command)
        bucket_index = deploy_command.index("--s3-bucket")
        self.assertEqual(
            deploy_command[bucket_index + 1],
            activation.EXPECTED_ARTIFACT_BUCKET,
        )
        self.assertIn("--template-file", deploy_command)
        self.assertEqual(
            deploy_command[deploy_command.index("--template-file") + 1],
            "/private/packaged-template.yaml",
        )
        self.assertNotIn("build", deploy_command)
        self.assertNotIn("package", deploy_command)
        self.assertNotIn("--config-file", deploy_command)
        self.assertEqual(
            run.call_args.kwargs["cwd"],
            Path("/private"),
        )
        self.assertIn("CAPABILITY_IAM", deploy_command)
        self.assertIn("CAPABILITY_NAMED_IAM", deploy_command)
        for invocation in run.call_args_list:
            environment = invocation.kwargs["env"]
            for variable in (
                "AWS_ACCESS_KEY_ID",
                "AWS_SECRET_ACCESS_KEY",
                "AWS_SESSION_TOKEN",
                "AWS_SECURITY_TOKEN",
                "AWS_ROLE_ARN",
                "AWS_ROLE_SESSION_NAME",
                "AWS_WEB_IDENTITY_TOKEN_FILE",
                "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
                "AWS_CONTAINER_CREDENTIALS_FULL_URI",
                "AWS_CONTAINER_AUTHORIZATION_TOKEN",
                "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
                "AWS_SHARED_CREDENTIALS_FILE",
                "AWS_CONFIG_FILE",
            ):
                self.assertNotIn(variable, environment)
            self.assertEqual(
                environment["AWS_PROFILE"], "market-dashboard-admin"
            )
            self.assertEqual(
                environment["AWS_DEFAULT_PROFILE"], "market-dashboard-admin"
            )
            self.assertEqual(environment["AWS_EC2_METADATA_DISABLED"], "true")
        self.assertIn("--stack-name", deploy_command)
        self.assertEqual(
            deploy_command[deploy_command.index("--stack-name") + 1],
            activation.STACK_NAME,
        )
        self.assertIn(
            "market-dashboard:owner=market-dashboard-readiness-v2",
            deploy_command,
        )
        self.assertIn(
            "market-dashboard:purpose=readiness-stack",
            deploy_command,
        )

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

    def test_pre_enable_watermark_ignores_only_historical_failures(self):
        now = datetime.now(timezone.utc)
        service_id = "gmail:test@example.com"
        schedule_id = "gmail-schedule"
        watermark = now - timedelta(minutes=1)
        historical_error = heartbeat(
            service_id,
            schedule_id,
            now - timedelta(hours=1),
            status="error",
        )

        historical_result = activation.heartbeat_window(
            activation.heartbeats_after_watermark(
                [historical_error],
                watermark,
            ),
            service_id=service_id,
            schedule_id=schedule_id,
            required=4,
            cadence_minutes=15,
            allowed_statuses={"success"},
            now=now,
        )

        self.assertFalse(historical_result["passed"])
        self.assertTrue(
            activation.heartbeat_observation_pending(historical_result)
        )

        new_error = heartbeat(
            service_id,
            schedule_id,
            now,
            status="error",
        )
        new_result = activation.heartbeat_window(
            activation.heartbeats_after_watermark(
                [new_error, historical_error],
                watermark,
            ),
            service_id=service_id,
            schedule_id=schedule_id,
            required=4,
            cadence_minutes=15,
            allowed_statuses={"success"},
            now=now,
        )

        self.assertFalse(new_result["passed"])
        self.assertFalse(activation.heartbeat_observation_pending(new_result))
        self.assertIn(
            "HEARTBEAT_STATUS_UNHEALTHY",
            {failure["code"] for failure in new_result["failures"]},
        )

    def test_worker_heartbeat_gate_requires_one_developer_and_security_run(self):
        now = datetime.now(timezone.utc)
        contracts = {
            "quant-developer": {
                "serviceId": "hermes:quant-developer",
                "scheduleId": "developer-schedule",
                "cadenceMinutes": 15,
            },
            "security": {
                "serviceId": "hermes:security",
                "scheduleId": "security-schedule",
                "cadenceMinutes": 60,
            },
            "quant-analyst": {
                "serviceId": "hermes:quant-analyst",
                "scheduleId": "analyst-schedule",
                "cadenceMinutes": 15,
            },
        }
        rows = {
            contract["serviceId"]: [
                heartbeat(
                    contract["serviceId"],
                    contract["scheduleId"],
                    now,
                )
            ]
            for contract in contracts.values()
        }

        class Runtime:
            def __init__(self):
                self.limits = {}

            def heartbeat_rows(self, _table, service_id, *, limit):
                self.limits[service_id] = limit
                return rows[service_id][:limit]

        controller = object.__new__(activation.ActivationController)
        controller.contract = {"workers": contracts}
        controller.resources = {"serviceHeartbeatTable": "heartbeat-table"}
        controller.runtime = Runtime()

        developer = controller.worker_heartbeat("quant-developer")
        security = controller.worker_heartbeat("security")
        analyst = controller.worker_heartbeat("quant-analyst")

        self.assertTrue(developer["passed"], developer)
        self.assertEqual(developer["required"], 1)
        self.assertTrue(security["passed"], security)
        self.assertEqual(security["required"], 1)
        self.assertFalse(analyst["passed"])
        self.assertEqual(analyst["required"], 3)
        self.assertEqual(
            controller.runtime.limits,
            {
                "hermes:quant-developer": 1,
                "hermes:security": 1,
                "hermes:quant-analyst": 3,
            },
        )

    def test_gmail_heartbeat_window_rejects_missing_structural_counts(self):
        now = datetime(2026, 7, 25, 18, 0, tzinfo=timezone.utc)
        rows = [
            heartbeat(
                "gmail:timsmithaviation@gmail.com",
                "market-dashboard-gmail-v2-every-15m",
                now - timedelta(minutes=15 * index),
            )
            for index in range(4)
        ]
        rows[1].pop("counts")

        result = activation.heartbeat_window(
            rows,
            service_id="gmail:timsmithaviation@gmail.com",
            schedule_id="market-dashboard-gmail-v2-every-15m",
            required=4,
            cadence_minutes=15,
            allowed_statuses={"success"},
            now=now,
        )

        self.assertFalse(result["passed"])
        self.assertIn(
            "GMAIL_HEARTBEAT_DATA_ERROR",
            {failure["code"] for failure in result["failures"]},
        )

    def test_gmail_heartbeat_window_rejects_lossy_or_coerced_counts(self):
        now = datetime(2026, 7, 25, 18, 0, tzinfo=timezone.utc)
        rows = [
            heartbeat(
                "gmail:timsmithaviation@gmail.com",
                "market-dashboard-gmail-v2-every-15m",
                now - timedelta(minutes=15 * index),
            )
            for index in range(4)
        ]
        rows[1]["counts"]["errors"] = Decimal("0.5")
        rows[2]["counts"]["dropped"] = "0"

        result = activation.heartbeat_window(
            rows,
            service_id="gmail:timsmithaviation@gmail.com",
            schedule_id="market-dashboard-gmail-v2-every-15m",
            required=4,
            cadence_minutes=15,
            allowed_statuses={"success"},
            now=now,
        )

        self.assertFalse(result["passed"])
        self.assertEqual(
            sum(
                failure["code"] == "GMAIL_HEARTBEAT_DATA_ERROR"
                for failure in result["failures"]
            ),
            2,
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
