#!/usr/bin/env python3
"""Fail CI when the Hermes manifest, Lambda, schedules, or alarms drift."""

from __future__ import annotations

import json
import os
import re
import sys
import unittest
from pathlib import Path
from typing import Any

import yaml


os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "infra" / "scripts"))
sys.path.insert(0, str(REPO_ROOT / "infra" / "lambdas" / "hermes_worker"))
sys.path.insert(0, str(REPO_ROOT / "infra" / "lambdas" / "gmail_ingestor"))

from render_hermes_contract import render_contract  # noqa: E402
import hermes_worker as worker  # noqa: E402
import hermes_gmail_ingestor as gmail_ingestor  # noqa: E402
import parse_hedgeye_email_html as hedgeye_parser  # noqa: E402


class CloudFormationLoader(yaml.SafeLoader):
    pass


def construct_cloudformation_tag(
    loader: CloudFormationLoader, tag_suffix: str, node: yaml.Node
) -> dict[str, Any]:
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node)
    else:
        value = loader.construct_mapping(node)
    return {"tag": tag_suffix, "value": value}


CloudFormationLoader.add_multi_constructor("!", construct_cloudformation_tag)


SCHEDULE_RESOURCES = {
    "quant-analyst": "QuantAnalystSchedule",
    "quant-developer": "QuantDeveloperSchedule",
    "security": "SecuritySchedule",
}
HEALTHY_ALARM_RESOURCES = {
    "quant-analyst": "AnalystUnhealthyAlarm",
    "quant-developer": "DeveloperUnhealthyAlarm",
    "security": "SecurityUnhealthyAlarm",
}
MISSING_ALARM_RESOURCES = {
    "quant-analyst": "AnalystHeartbeatMissingAlarm",
    "quant-developer": "DeveloperHeartbeatMissingAlarm",
    "security": "SecurityHeartbeatMissingAlarm",
}
EXACT_CAPABILITY_IDS = {
    "automation.hermes",
    "dashboard.core",
    "portfolio.live",
    "prediction.display",
    "prediction.ibkrExecution",
    "research.current",
}


def schedule_interval_minutes(expression: str) -> int:
    match = re.fullmatch(r"rate\((\d+) minutes?\)", expression)
    if match:
        return int(match.group(1))
    match = re.fullmatch(r"cron\((\S+) (\S+) \? \* MON-FRI \*\)", expression)
    if not match:
        raise AssertionError(f"Unsupported Scheduler cadence expression: {expression}")
    minute, hour = match.groups()
    if "/" in minute:
        return int(minute.rsplit("/", 1)[1])
    if hour == "*":
        return 60
    raise AssertionError(f"Cannot infer cadence from Scheduler expression: {expression}")


def dimension_value(properties: dict[str, Any], name: str) -> Any:
    return next(
        dimension["Value"]
        for dimension in properties.get("Dimensions") or []
        if dimension.get("Name") == name
    )


class HermesInfrastructureContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest_path = REPO_ROOT / "ops" / "services.json"
        cls.contract_path = (
            REPO_ROOT / "infra" / "lambdas" / "hermes_worker" / "service_contract.json"
        )
        cls.manifest = json.loads(cls.manifest_path.read_text(encoding="utf-8"))
        cls.contract = json.loads(cls.contract_path.read_text(encoding="utf-8"))
        cls.template = yaml.load(
            (REPO_ROOT / "infra" / "template.yaml").read_text(encoding="utf-8"),
            Loader=CloudFormationLoader,
        )

    def test_generated_lambda_contract_is_current(self):
        self.assertEqual(
            self.contract_path.read_text(encoding="utf-8"),
            render_contract(self.manifest_path),
            "run infra/scripts/render_hermes_contract.py after editing ops/services.json",
        )
        services = {service["id"]: service for service in self.manifest["services"]}
        for job_type, contract in self.contract["workers"].items():
            service = services[f"hermes.{job_type}"]
            self.assertEqual(contract["cadenceMinutes"], service["cadenceMinutes"])
            self.assertEqual(contract["serviceId"], service["aws"]["heartbeatServiceId"])
            self.assertEqual(contract["scheduleId"], service["aws"]["scheduleId"])

    def test_lambda_runtime_constants_come_from_generated_manifest_contract(self):
        self.assertEqual(worker.SERVICE_CONTRACT, self.contract)
        self.assertEqual(worker.ALLOWED_JOBS, frozenset(self.contract["workers"]))
        self.assertEqual(
            worker.EXPECTED_SCHEDULE_IDS,
            {
                job_type: contract["scheduleId"]
                for job_type, contract in self.contract["workers"].items()
            },
        )
        self.assertEqual(
            worker.HEARTBEAT_SERVICE_IDS,
            {
                job_type: contract["serviceId"]
                for job_type, contract in self.contract["workers"].items()
            },
        )
        self.assertEqual(worker.EXPECTED_CAPABILITY_IDS, EXACT_CAPABILITY_IDS)

    def test_sam_resource_names_and_lambda_defaults_match_manifest(self):
        resources = self.template["Resources"]
        manifest_resources = self.manifest["aws"]["resources"]
        function = resources["HermesWorkerFunction"]["Properties"]
        self.assertEqual(function["FunctionName"], manifest_resources["hermesFunction"])
        self.assertEqual(self.contract["functionName"], function["FunctionName"])
        self.assertEqual(
            resources["ServiceHeartbeatTable"]["Properties"]["TableName"],
            manifest_resources["serviceHeartbeatTable"],
        )
        self.assertEqual(
            resources["HermesInputSnapshotTable"]["Properties"]["TableName"],
            manifest_resources["hermesInputSnapshotTable"],
        )
        self.assertEqual(
            resources["ResearchEventLedgerV2"]["Properties"]["TableName"],
            manifest_resources["researchEventLedgerTable"],
        )
        self.assertEqual(
            resources["PredictionMarketCatalogV2"]["Properties"]["TableName"],
            manifest_resources["predictionCatalogTable"],
        )
        self.assertEqual(
            resources["RiskRangePublicationManifestsV2"]["Properties"]["TableName"],
            manifest_resources["riskRangeManifestTable"],
        )
        parameter_defaults = self.template["Parameters"]
        self.assertEqual(
            parameter_defaults["GmailOAuthSecretName"]["Default"],
            manifest_resources["gmailOAuthSecret"],
        )
        self.assertEqual(
            parameter_defaults["RawArtifactBucketName"]["Default"],
            manifest_resources["rawArtifactBucket"],
        )
        self.assertEqual(
            parameter_defaults["GmailLedgerTableName"]["Default"],
            manifest_resources["gmailLedgerTable"],
        )
        self.assertEqual(
            parameter_defaults["HedgeyeDailySnapshotTableName"]["Default"],
            manifest_resources["hedgeyeDailySnapshotTable"],
        )
        self.assertEqual(
            parameter_defaults["HedgeyeRiskRangesTableName"]["Default"],
            manifest_resources["riskRangeDataTable"],
        )
        self.assertEqual(
            parameter_defaults["RiskRangeHistoryTableName"]["Default"],
            manifest_resources["riskRangeHistoryTable"],
        )
        self.assertEqual(self.contract["heartbeatTable"], manifest_resources["serviceHeartbeatTable"])
        self.assertEqual(
            self.contract["inputSnapshotTable"],
            manifest_resources["hermesInputSnapshotTable"],
        )
        environment = function["Environment"]["Variables"]
        self.assertEqual(
            environment["HERMES_INPUT_SNAPSHOT_TABLE"],
            {"tag": "Ref", "value": "HermesInputSnapshotTable"},
        )
        gmail_environment = resources["GmailIngestorFunction"]["Properties"]["Environment"]["Variables"]
        self.assertEqual(
            gmail_environment["RESEARCH_EVENT_LEDGER_TABLE"],
            {"tag": "Ref", "value": "ResearchEventLedgerV2"},
        )
        self.assertEqual(
            gmail_environment["RISK_RANGE_MANIFEST_TABLE"],
            {"tag": "Ref", "value": "RiskRangePublicationManifestsV2"},
        )
        self.assertEqual(
            gmail_environment["HEDGEYE_RISK_RANGES_TABLE"],
            {"tag": "Ref", "value": "HedgeyeRiskRangesTableName"},
        )
        self.assertEqual(
            gmail_environment["RISK_RANGE_HISTORY_TABLE"],
            {"tag": "Ref", "value": "RiskRangeHistoryTableName"},
        )
        self.assertEqual(gmail_ingestor.RESEARCH_EVENT_LEDGER_TABLE, manifest_resources["researchEventLedgerTable"])
        self.assertEqual(hedgeye_parser.RISK_RANGE_MANIFEST_TABLE, manifest_resources["riskRangeManifestTable"])
        self.assertEqual(hedgeye_parser.RISK_RANGE_DATA_TABLE, manifest_resources["riskRangeDataTable"])
        self.assertEqual(hedgeye_parser.RISK_RANGE_HISTORY_TABLE, manifest_resources["riskRangeHistoryTable"])

    def test_worker_schedule_ids_expressions_cadences_and_inputs_match(self):
        resources = self.template["Resources"]
        for job_type, contract in self.contract["workers"].items():
            with self.subTest(job_type=job_type):
                schedule = resources[SCHEDULE_RESOURCES[job_type]]["Properties"]
                self.assertEqual(schedule["Name"], contract["scheduleId"])
                self.assertEqual(schedule["ScheduleExpression"], contract["scheduleExpression"])
                self.assertEqual(schedule["ScheduleExpressionTimezone"], contract["scheduleTimeZone"])
                self.assertEqual(
                    schedule_interval_minutes(schedule["ScheduleExpression"]),
                    contract["cadenceMinutes"],
                )
                self.assertEqual(
                    schedule["Target"]["Arn"],
                    {"tag": "GetAtt", "value": "HermesWorkerFunction.Arn"},
                )
                self.assertEqual(
                    schedule["Target"]["RoleArn"],
                    {"tag": "GetAtt", "value": "SchedulerInvokeRole.Arn"},
                )
                target_input = json.loads(schedule["Target"]["Input"])
                self.assertEqual(target_input, {
                    "source": "aws-scheduler",
                    "scheduleId": contract["scheduleId"],
                    "jobType": job_type,
                })

    def test_gmail_runtime_schedule_and_sam_resources_match_manifest(self):
        services = {service["id"]: service for service in self.manifest["services"]}
        contract = services["gmail.ingestion"]
        resources = self.template["Resources"]
        manifest_resources = self.manifest["aws"]["resources"]
        function = resources["GmailIngestorFunction"]["Properties"]
        schedule = resources["GmailPollSchedule"]["Properties"]

        self.assertEqual(contract["aws"]["functionName"], manifest_resources["gmailFunction"])
        self.assertEqual(function["FunctionName"], contract["aws"]["functionName"])
        self.assertEqual(contract["aws"]["scheduleId"], manifest_resources["gmailSchedule"])
        self.assertEqual(schedule["Name"], contract["aws"]["scheduleId"])
        self.assertEqual(schedule["ScheduleExpression"], contract["aws"]["scheduleExpression"])
        self.assertEqual(
            schedule_interval_minutes(schedule["ScheduleExpression"]),
            contract["cadenceMinutes"],
        )
        self.assertEqual(gmail_ingestor.GMAIL_SCHEDULE_ID, contract["aws"]["scheduleId"])
        self.assertEqual(
            gmail_ingestor.GMAIL_SERVICE_ID,
            contract["aws"]["heartbeatServiceId"],
        )
        self.assertEqual(
            self.template["Parameters"]["AlertEmail"]["Default"],
            gmail_ingestor.GMAIL_ACCOUNT,
        )
        self.assertEqual(
            schedule["Target"]["Arn"],
            {"tag": "GetAtt", "value": "GmailIngestorFunction.Arn"},
        )
        self.assertEqual(
            json.loads(schedule["Target"]["Input"]),
            {
                "source": "aws-scheduler",
                "scheduleId": contract["aws"]["scheduleId"],
                "poll": "incremental",
            },
        )

    def test_each_worker_has_missing_and_unhealthy_sns_alarms(self):
        resources = self.template["Resources"]
        for job_type, contract in self.contract["workers"].items():
            with self.subTest(job_type=job_type):
                unhealthy = resources[HEALTHY_ALARM_RESOURCES[job_type]]["Properties"]
                self.assertEqual(unhealthy["Namespace"], "MarketDashboard/Readiness")
                self.assertEqual(unhealthy["MetricName"], "Healthy")
                self.assertEqual(unhealthy["Statistic"], "Minimum")
                self.assertEqual(unhealthy["ComparisonOperator"], "LessThanThreshold")
                self.assertEqual(unhealthy["Threshold"], 1)
                self.assertEqual(unhealthy["Period"], contract["cadenceMinutes"] * 60)
                self.assertEqual(unhealthy["TreatMissingData"], "notBreaching")
                self.assertEqual(dimension_value(unhealthy, "ServiceId"), contract["serviceId"])
                self.assertEqual(
                    unhealthy["ActionsEnabled"],
                    {"tag": "If", "value": ["OperationalAlarmsEnabled", True, False]},
                )
                self.assertEqual(
                    unhealthy["AlarmActions"],
                    [{"tag": "Ref", "value": "OperationsTopic"}],
                )

                missing = resources[MISSING_ALARM_RESOURCES[job_type]]["Properties"]
                self.assertEqual(missing["MetricName"], "Heartbeat")
                self.assertEqual(dimension_value(missing, "ServiceId"), contract["serviceId"])
                self.assertEqual(
                    missing["AlarmActions"],
                    [{"tag": "Ref", "value": "OperationsTopic"}],
                )


if __name__ == "__main__":
    unittest.main()
