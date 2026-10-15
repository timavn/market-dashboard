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

    def test_schedule_is_disabled_by_default_and_runs_daily_at_1531_eastern(self):
        parameter = self.template["Parameters"]["CftcScheduleState"]
        self.assertEqual(parameter["Default"], "DISABLED")
        self.assertEqual(set(parameter["AllowedValues"]), {"ENABLED", "DISABLED"})
        schedule = self.resources["CftcWeekdaySchedule"]["Properties"]
        self.assertEqual(schedule["Name"], "market-dashboard-cftc-weekday-v1")
        self.assertEqual(schedule["State"], {"tag": "Ref", "value": "CftcScheduleState"})
        self.assertEqual(schedule["ScheduleExpression"], "cron(31 15 * * ? *)")
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

    def test_operations_manifest_matches_daily_cftc_schedule_including_weekends(self):
        manifest = json.loads((REPO_ROOT / "ops" / "services.json").read_text(encoding="utf-8"))
        service = next(item for item in manifest["services"] if item["id"] == "cftc.official-ingestion")
        schedule = self.resources["CftcWeekdaySchedule"]["Properties"]
        self.assertEqual(service["cadenceMinutes"], 1440)
        self.assertEqual(service["aws"]["scheduleId"], schedule["Name"])
        self.assertEqual(service["aws"]["scheduleExpression"], schedule["ScheduleExpression"])
        self.assertEqual(service["aws"]["scheduleTimeZone"], schedule["ScheduleExpressionTimezone"])
        self.assertEqual(service["scheduleWindow"], {
            "timeZone": "America/New_York", "weekdays": False, "startHour": 15, "endHour": 16,
        })

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

    def test_dedicated_scheduler_role_can_invoke_only_cftc(self):
        role = self.resources["CftcSchedulerInvokeRole"]["Properties"]
        self.assertNotIn("RoleName", role)
        self.assertEqual(role["AssumeRolePolicyDocument"]["Statement"], [{
            "Effect": "Allow",
            "Principal": {"Service": "scheduler.amazonaws.com"},
            "Action": "sts:AssumeRole",
        }])
        invoke = role["Policies"][0]["PolicyDocument"]["Statement"][0]
        self.assertEqual(
            {"tag": "GetAtt", "value": "CftcIngestorFunction.Arn"},
            invoke["Resource"],
        )
        self.assertEqual(invoke["Action"], "lambda:InvokeFunction")
        self.assertEqual(
            self.resources["CftcWeekdaySchedule"]["Properties"]["Target"]["RoleArn"],
            {"tag": "GetAtt", "value": "CftcSchedulerInvokeRole.Arn"},
        )
        shared_invoke = self.resources["SchedulerInvokeRole"]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"][0]
        self.assertNotIn({"tag": "GetAtt", "value": "CftcIngestorFunction.Arn"}, shared_invoke["Resource"])

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
                "schemaVersion": "cftc-positioning-v2",
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
        }, expected_contract=parsed)
        self.assertEqual(write["result"], "created")
        with self.assertRaises(activation.ActivationFailure):
            activation.parse_cftc_write_result({
                "Payload": io.BytesIO(json.dumps({**write_payload, "result": "dry-run"}).encode("utf-8")),
            }, expected_contract=parsed)

    def test_activation_recognizes_exact_cftc_versions_and_returns_observed_count(self):
        pairs = [
            ("cftc-positioning-v2", "cftc-combined-net-sample-z-v1", 35),
            ("cftc-positioning-v2", "cftc-combined-net-sample-z-v1", 37),
            ("cftc-positioning-v3", "cftc-combined-net-sample-z-v2", 39),
        ]
        for schema, calculation, count in pairs:
            with self.subTest(schema=schema, count=count):
                payload = {
                    "ok": True, "result": "dry-run", "reportDate": "2026-09-08",
                    "metricsCount": count, "contentComplete": True,
                    "sourceContentHash": "a" * 64,
                    "schemaVersion": schema, "calculationVersion": calculation,
                    "snapshot": {"source": "cftc-public-reporting-environment",
                                 "schemaVersion": schema, "calculationVersion": calculation},
                }
                parsed = activation.parse_cftc_canary_result({"Payload": json.dumps(payload)})
                self.assertEqual(parsed["metricsCount"], count)
                self.assertEqual(parsed["schemaVersion"], schema)
                payload["result"] = "revised"
                payload["snapshot"] = None
                written = activation.parse_cftc_write_result({"Payload": json.dumps(payload)}, expected_contract=parsed)
                self.assertEqual(written["metricsCount"], count)
                self.assertEqual(written["calculationVersion"], calculation)

    def test_activation_rejects_unknown_or_crossed_cftc_version_count_contracts(self):
        invalid = [
            ("cftc-positioning-v3", "cftc-combined-net-sample-z-v1", 39),
            ("cftc-positioning-v2", "cftc-combined-net-sample-z-v2", 37),
            ("cftc-positioning-v3", "cftc-combined-net-sample-z-v2", 37),
            ("cftc-positioning-v2", "cftc-combined-net-sample-z-v1", 39),
            ("cftc-positioning-v3", "cftc-combined-net-sample-z-v2", 39.5),
            (None, "cftc-combined-net-sample-z-v1", 35),
            ([], "cftc-combined-net-sample-z-v1", 35),
        ]
        for schema, calculation, count in invalid:
            with self.subTest(schema=schema, count=count):
                payload = {
                    "ok": True, "result": "dry-run", "reportDate": "2026-09-08",
                    "metricsCount": count, "sourceContentHash": "a" * 64,
                    "schemaVersion": schema, "calculationVersion": calculation,
                    "snapshot": {"source": "cftc-public-reporting-environment",
                                 "schemaVersion": schema, "calculationVersion": calculation},
                }
                with self.assertRaises(activation.ActivationFailure):
                    activation.parse_cftc_canary_result({"Payload": json.dumps(payload)})
                payload["result"] = "created"
                with self.assertRaises(activation.ActivationFailure):
                    activation.parse_cftc_write_result({"Payload": json.dumps(payload)})

    def test_legacy_write_without_versions_requires_previously_verified_canary(self):
        payload = {"ok": True, "result": "created", "reportDate": "2026-09-08",
                   "metricsCount": 37, "sourceContentHash": "a" * 64}
        with self.assertRaises(activation.ActivationFailure):
            activation.parse_cftc_write_result({"Payload": json.dumps(payload)})
        expected = {"schemaVersion": "cftc-positioning-v2",
                    "calculationVersion": "cftc-combined-net-sample-z-v1", "metricsCount": 37}
        self.assertTrue(activation.parse_cftc_write_result({"Payload": json.dumps(payload)}, expected_contract=expected)["passed"])
        expected["metricsCount"] = 35
        with self.assertRaises(activation.ActivationFailure):
            activation.parse_cftc_write_result({"Payload": json.dumps(payload)}, expected_contract=expected)

    def test_canary_compares_raw_z_scores_at_published_precision(self):
        fixture_rows = {
            "2026-04-28": [("13874A", -96215, 7946, 0.771234, 0.1541),
                           ("088691", 91574, -3924, -1.33123, -0.9167),
                           ("124603", -2284, 706, 0.0813, -0.1387)],
            "2026-08-11": [("13874A", 25427, 32375, 2.4232, 1.6157)],
        }

        class Runtime:
            def invoke(self, _function, event):
                report_date = event.get("targetReportDate", "2026-09-08")
                rows = [{"cftcContractMarketCode": code, "latest": latest, "wwChg": weekly,
                         "zScore1Y": one_year, "zScore3Y": three_year}
                        for code, latest, weekly, one_year, three_year in fixture_rows.get(report_date, [])]
                return {"Payload": json.dumps({
                    "ok": True, "result": "dry-run", "reportDate": report_date,
                    "metricsCount": 39, "contentComplete": True, "sourceContentHash": "a" * 64,
                    "snapshot": {"source": "cftc-public-reporting-environment",
                                 "schemaVersion": "cftc-positioning-v3",
                                 "calculationVersion": "cftc-combined-net-sample-z-v2", "data": rows},
                })}

        controller = object.__new__(activation.ActivationController)
        controller.runtime = Runtime()
        controller.resources = {"cftcFunction": "test-only"}
        result = controller.canary_cftc()
        self.assertTrue(result["passed"])
        self.assertEqual(result["metricsCount"], 39)
        self.assertEqual(len(result["parityFixtures"]), 2)


if __name__ == "__main__":
    unittest.main()
