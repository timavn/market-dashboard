#!/usr/bin/env python3
"""Infrastructure guardrails for official CFTC positioning automation."""

from __future__ import annotations

import json
import io
import sys
import unittest
from pathlib import Path
from typing import Any

import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "infra" / "scripts"))

import activate_reliability as activation  # noqa: E402


class CloudFormationLoader(yaml.SafeLoader):
    pass


def construct_tag(loader: CloudFormationLoader, suffix: str, node: yaml.Node) -> dict[str, Any]:
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node)
    else:
        value = loader.construct_mapping(node)
    return {"tag": suffix, "value": value}


CloudFormationLoader.add_multi_constructor("!", construct_tag)


def load_yaml(path: Path) -> dict[str, Any]:
    return yaml.load(path.read_text(encoding="utf-8"), Loader=CloudFormationLoader)


def statements(function: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        statement
        for policy in function["Properties"].get("Policies", [])
        for statement in policy.get("Statement", [])
    ]


class CftcInfrastructureContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template = load_yaml(REPO_ROOT / "infra" / "template.yaml")
        cls.resources = cls.template["Resources"]

    def test_schedule_is_disabled_by_default_and_pinned_to_eastern_weekdays(self):
        parameter = self.template["Parameters"]["CftcScheduleState"]
        self.assertEqual(parameter["Default"], "DISABLED")
        self.assertEqual(set(parameter["AllowedValues"]), {"ENABLED", "DISABLED"})
        schedule = self.resources["CftcWeekdaySchedule"]["Properties"]
        self.assertEqual(schedule["Name"], "market-dashboard-cftc-weekday-v1")
        self.assertEqual(schedule["State"], {"tag": "Ref", "value": "CftcScheduleState"})
        self.assertEqual(schedule["ScheduleExpression"], "cron(15 16 ? * MON-FRI *)")
        self.assertEqual(schedule["ScheduleExpressionTimezone"], "America/New_York")
        self.assertEqual(schedule["FlexibleTimeWindow"], {"Mode": "OFF"})
        self.assertEqual(
            json.loads(schedule["Target"]["Input"]),
            {
                "source": "aws-scheduler",
                "scheduleId": "market-dashboard-cftc-weekday-v1",
                "mode": "current",
            },
        )
        self.assertEqual(
            schedule["Target"]["RetryPolicy"],
            {"MaximumEventAgeInSeconds": 900, "MaximumRetryAttempts": 0},
        )

    def test_lambda_has_single_concurrency_failure_queue_and_bounded_runtime(self):
        function = self.resources["CftcIngestorFunction"]["Properties"]
        self.assertEqual(function["FunctionName"], "market-dashboard-cftc-ingestor-v1")
        self.assertEqual(function["Handler"], "cftc_ingestor.lambda_handler")
        self.assertEqual(function["ReservedConcurrentExecutions"], 1)
        self.assertLessEqual(function["Timeout"], 120)
        self.assertEqual(function["Architectures"], ["arm64"])
        self.assertEqual(
            function["Environment"]["Variables"],
            {
                "HEDGEYE_DAILY_SNAPSHOT_TABLE": {
                    "tag": "Ref",
                    "value": "HedgeyeDailySnapshotTableName",
                },
                "SERVICE_HEARTBEAT_TABLE": {
                    "tag": "Ref",
                    "value": "ServiceHeartbeatTable",
                },
            },
        )
        self.assertEqual(function["EventInvokeConfig"]["MaximumRetryAttempts"], 0)
        destination = function["EventInvokeConfig"]["DestinationConfig"]["OnFailure"]
        self.assertEqual(destination["Type"], "SQS")
        self.assertEqual(destination["Destination"], {"tag": "GetAtt", "value": "RuntimeFailureQueue.Arn"})

    def test_lambda_iam_is_least_privilege(self):
        function = self.resources["CftcIngestorFunction"]
        by_sid = {statement["Sid"]: statement for statement in statements(function)}
        publish = by_sid["ReadAndPublishExactCftcSnapshot"]
        self.assertEqual(set(publish["Action"]), {"dynamodb:GetItem", "dynamodb:PutItem"})
        all_actions = {
            action
            for statement in by_sid.values()
            for action in (
                statement.get("Action", [])
                if isinstance(statement.get("Action", []), list)
                else [statement.get("Action")]
            )
        }
        self.assertNotIn("dynamodb:Scan", all_actions)
        self.assertNotIn("dynamodb:Query", all_actions)
        self.assertNotIn("dynamodb:UpdateItem", all_actions)
        self.assertEqual(
            by_sid["WriteCftcReadinessMetrics"]["Condition"],
            {"StringEquals": {"cloudwatch:namespace": "MarketDashboard/Readiness"}},
        )
        self.assertEqual(
            by_sid["SendCftcFailureToOperationsQueue"]["Resource"],
            {"tag": "GetAtt", "value": "RuntimeFailureQueue.Arn"},
        )

    def test_scheduler_role_can_invoke_only_owned_function_arns(self):
        role = self.resources["SchedulerInvokeRole"]["Properties"]
        invoke = role["Policies"][0]["PolicyDocument"]["Statement"][0]
        self.assertIn(
            {"tag": "GetAtt", "value": "CftcIngestorFunction.Arn"},
            invoke["Resource"],
        )
        self.assertEqual(invoke["Action"], "lambda:InvokeFunction")

    def test_activation_rollback_and_base_deployment_include_cftc_control(self):
        self.assertIn("CftcScheduleState", activation.CONTROL_PARAMETERS)
        current = {name: "DISABLED" for name in activation.CONTROL_PARAMETERS}
        current["GmailScheduleState"] = "ENABLED"
        target = activation.target_control_state("cftc", current)
        self.assertEqual(target["CftcScheduleState"], "ENABLED")
        self.assertEqual(target["GmailScheduleState"], "ENABLED")
        deploy_script = (REPO_ROOT / "infra" / "scripts" / "deploy.sh").read_text(encoding="utf-8")
        export_script = (REPO_ROOT / "infra" / "scripts" / "export_deployed_state.sh").read_text(encoding="utf-8")
        self.assertIn('"CftcScheduleState=${cftc_state}"', deploy_script)
        self.assertIn("market-dashboard-cftc-ingestor-v1", export_script)
        self.assertIn("market-dashboard-cftc-weekday-v1", export_script)

    def test_deployment_role_allowlist_contains_exact_cftc_resources(self):
        bootstrap = load_yaml(REPO_ROOT / "infra" / "bootstrap" / "deployment-role.yaml")
        serialized = json.dumps(bootstrap)
        self.assertIn("function:market-dashboard-cftc-ingestor-v1", serialized)
        self.assertIn("schedule/default/market-dashboard-cftc-weekday-v1", serialized)

    def test_activation_accepts_only_typed_read_only_and_current_write_results(self):
        dry_run_payload = {
            "ok": True,
            "result": "dry-run",
            "reportDate": "2026-08-11",
            "metricsCount": 35,
            "contentComplete": True,
            "sourceContentHash": "a" * 64,
            "snapshot": {
                "source": "cftc-public-reporting-environment",
                "calculationVersion": "cftc-combined-net-sample-z-v1",
                "data": [],
            },
        }
        parsed = activation.parse_cftc_canary_result({
            "Payload": io.BytesIO(json.dumps(dry_run_payload).encode("utf-8")),
        })
        self.assertTrue(parsed["passed"])
        write_payload = {
            **dry_run_payload,
            "result": "created",
            "snapshot": None,
        }
        write = activation.parse_cftc_write_result({
            "Payload": io.BytesIO(json.dumps(write_payload).encode("utf-8")),
        })
        self.assertEqual(write["result"], "created")
        with self.assertRaises(activation.ActivationFailure):
            activation.parse_cftc_write_result({
                "Payload": io.BytesIO(json.dumps({**write_payload, "result": "dry-run"}).encode("utf-8")),
            })


if __name__ == "__main__":
    unittest.main()
