#!/usr/bin/env python3
"""Fail CI when the Hermes manifest, Lambda, schedules, or alarms drift."""

from __future__ import annotations

import json
import os
import re
import sys
import unittest
from fnmatch import fnmatchcase
from pathlib import Path
from typing import Any

import yaml


os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "infra" / "scripts"))
sys.path.insert(0, str(REPO_ROOT / "infra" / "lambdas" / "hermes_worker"))
sys.path.insert(0, str(REPO_ROOT / "infra" / "lambdas" / "hermes_watchdog"))
sys.path.insert(0, str(REPO_ROOT / "infra" / "lambdas" / "gmail_ingestor"))

from render_hermes_contract import render_contract  # noqa: E402
import hermes_worker as worker  # noqa: E402
import hermes_watchdog as watchdog  # noqa: E402
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
    match = re.fullmatch(r"cron\((\S+) (\S+) \? \* \* \*\)", expression)
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


def policy_statements(function_properties: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        statement
        for policy in function_properties.get("Policies") or []
        if isinstance(policy, dict)
        for statement in policy.get("Statement") or []
    ]


def statement_actions(statement: dict[str, Any]) -> set[str]:
    value = statement.get("Action") or []
    return {value} if isinstance(value, str) else set(value)


def statement_for_action(
    function_properties: dict[str, Any],
    action: str,
) -> dict[str, Any]:
    return next(
        statement
        for statement in policy_statements(function_properties)
        if action in statement_actions(statement)
    )


def condition_allows_leading_key(
    statement: dict[str, Any],
    leading_key: str,
) -> bool:
    condition = statement.get("Condition") or {}
    if condition.get("Null", {}).get("dynamodb:LeadingKeys") != "false":
        return False
    exact = condition.get("ForAllValues:StringEquals", {}).get(
        "dynamodb:LeadingKeys",
        [],
    )
    exact_values = exact if isinstance(exact, list) else [exact]
    patterns = condition.get("ForAllValues:StringLike", {}).get(
        "dynamodb:LeadingKeys",
        [],
    )
    pattern_values = patterns if isinstance(patterns, list) else [patterns]
    return leading_key in exact_values or any(
        fnmatchcase(leading_key, pattern) for pattern in pattern_values
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

    def test_reserved_concurrency_is_opt_in_and_omitted_by_default(self):
        self.assertEqual(
            self.template["Parameters"]["ReservedConcurrencyState"],
            {
                "Type": "String",
                "Default": "DISABLED",
                "AllowedValues": ["ENABLED", "DISABLED"],
                "Description": (
                    "Opt in only after the account concurrency quota can preserve "
                    "ten unreserved executions."
                ),
            },
        )
        self.assertEqual(
            self.template["Conditions"]["ReservedConcurrencyEnabled"],
            {
                "tag": "Equals",
                "value": [
                    {"tag": "Ref", "value": "ReservedConcurrencyState"},
                    "ENABLED",
                ],
            },
        )
        expected = {
            "GmailIngestorFunction": 1,
            "HedgeyePdfProcessorFunction": 2,
            "HermesWorkerFunction": 3,
        }
        for logical_id, concurrency in expected.items():
            with self.subTest(logical_id=logical_id):
                self.assertEqual(
                    self.template["Resources"][logical_id]["Properties"][
                        "ReservedConcurrentExecutions"
                    ],
                    {
                        "tag": "If",
                        "value": [
                            "ReservedConcurrencyEnabled",
                            concurrency,
                            {"tag": "Ref", "value": "AWS::NoValue"},
                        ],
                    },
                )

    def test_worker_alert_lifecycle_is_key_scoped_and_publishes_only_to_operations(self):
        function = self.template["Resources"]["HermesWorkerFunction"]["Properties"]
        environment = function["Environment"]["Variables"]
        self.assertEqual(
            environment["HERMES_OPERATIONS_TOPIC_ARN"],
            {"tag": "Ref", "value": "OperationsTopic"},
        )
        statements = {
            statement.get("Sid"): statement
            for statement in policy_statements(function)
            if statement.get("Sid")
        }
        alerts = statements["ManageOwnedHermesAlerts"]
        self.assertEqual(
            statement_actions(alerts),
            {"dynamodb:GetItem", "dynamodb:PutItem"},
        )
        self.assertEqual(
            alerts["Condition"],
            {
                "ForAllValues:StringLike": {
                    "dynamodb:LeadingKeys": [
                        "quant-analyst#runtime-health#*",
                        "quant-developer#runtime-health#*",
                        "security#runtime-health#*",
                    ],
                },
                "Null": {"dynamodb:LeadingKeys": "false"},
            },
        )
        for owned_key in (
            "quant-analyst#runtime-health#PORTFOLIO_STALE",
            "quant-developer#runtime-health#STATE",
            "security#runtime-health#AUTH_REQUIRED",
        ):
            self.assertTrue(condition_allows_leading_key(alerts, owned_key))
        for foreign_key in (
            "gmail#runtime-health#AUTH_REQUIRED",
            "cloud-watchdog#runtime-health#STATE",
            "quant-developer#deployment#FAILED",
        ):
            self.assertFalse(condition_allows_leading_key(alerts, foreign_key))

        publish = statements["PublishHermesAlertLifecycle"]
        self.assertEqual(statement_actions(publish), {"sns:Publish"})
        self.assertEqual(
            publish["Resource"],
            {"tag": "Ref", "value": "OperationsTopic"},
        )

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

    def test_worker_schedules_are_continuous_when_missing_heartbeat_alarms_enable(self):
        services = {service["id"]: service for service in self.manifest["services"]}
        resources = self.template["Resources"]
        for job_type, resource_name in SCHEDULE_RESOURCES.items():
            with self.subTest(job_type=job_type):
                service = services[f"hermes.{job_type}"]
                window = service["scheduleWindow"]
                self.assertFalse(window["weekdays"])
                self.assertEqual(window["startHour"], 0)
                self.assertEqual(window["endHour"], 24)
                schedule = resources[resource_name]["Properties"]
                self.assertIn("runs 24/7", schedule["Description"])
                self.assertRegex(
                    schedule["ScheduleExpression"],
                    r"^cron\(\S+ \* \? \* \* \*\)$",
                )

    def test_cloud_watchdog_is_independent_staged_and_read_only(self):
        resources = self.template["Resources"]
        function = resources["HermesCloudWatchdogFunction"]["Properties"]
        rule = resources["HermesCloudWatchdogRule"]
        permission = resources["HermesCloudWatchdogInvokePermission"]["Properties"]

        self.assertEqual(
            self.template["Parameters"]["CloudWatchdogScheduleState"],
            {
                "Type": "String",
                "Default": "DISABLED",
                "AllowedValues": ["ENABLED", "DISABLED"],
                "Description": (
                    "Enable the independent read-only watchdog only through "
                    "staged activation."
                ),
            },
        )
        self.assertEqual(
            function["FunctionName"],
            "market-dashboard-hermes-cloud-watchdog-v1",
        )
        self.assertEqual(function["CodeUri"], "lambdas/hermes_watchdog/")
        self.assertEqual(function["Handler"], "hermes_watchdog.lambda_handler")
        self.assertEqual(function["Timeout"], 120)
        self.assertEqual(function["Architectures"], ["arm64"])
        self.assertNotIn("ReservedConcurrentExecutions", function)

        self.assertEqual(rule["Type"], "AWS::Events::Rule")
        self.assertEqual(
            rule["Properties"],
            {
                "Name": "market-dashboard-hermes-cloud-watchdog-v1",
                "Description": (
                    "Independent five-minute read-only cloud reliability watchdog."
                ),
                "ScheduleExpression": "rate(5 minutes)",
                "State": {
                    "tag": "Ref",
                    "value": "CloudWatchdogScheduleState",
                },
                "Targets": [
                    {
                        "Arn": {
                            "tag": "GetAtt",
                            "value": "HermesCloudWatchdogFunction.Arn",
                        },
                        "Id": "hermes-cloud-watchdog",
                        "Input": (
                            '{"source":"aws-events","ruleId":'
                            '"market-dashboard-hermes-cloud-watchdog-v1"}'
                        ),
                        "RetryPolicy": {
                            "MaximumEventAgeInSeconds": 300,
                            "MaximumRetryAttempts": 0,
                        },
                    }
                ],
            },
        )
        self.assertEqual(
            permission,
            {
                "Action": "lambda:InvokeFunction",
                "FunctionName": {
                    "tag": "Ref",
                    "value": "HermesCloudWatchdogFunction",
                },
                "Principal": "events.amazonaws.com",
                "SourceArn": {
                    "tag": "GetAtt",
                    "value": "HermesCloudWatchdogRule.Arn",
                },
            },
        )

        environment = function["Environment"]["Variables"]
        self.assertEqual(environment["WATCHDOG_STACK_NAME"], watchdog.STACK_NAME)
        self.assertEqual(environment["WATCHDOG_RULE_ID"], watchdog.RULE_ID)
        self.assertEqual(
            environment["WATCHDOG_SERVICE_ID"], watchdog.WATCHDOG_SERVICE_ID
        )
        self.assertEqual(
            environment["HERMES_OPERATIONS_TOPIC_ARN"],
            {"tag": "Ref", "value": "OperationsTopic"},
        )
        self.assertEqual(
            environment["RUNTIME_FAILURE_QUEUE_URL"],
            {"tag": "Ref", "value": "RuntimeFailureQueue"},
        )
        self.assertEqual(
            environment["RUNTIME_FAILURE_QUEUE_NAME"],
            {"tag": "GetAtt", "value": "RuntimeFailureQueue.QueueName"},
        )
        for spec in watchdog.SCHEDULE_SPECS:
            self.assertIn(spec["name"], environment.values())
            self.assertIn(spec["serviceId"], environment.values())
        for spec in watchdog.FUNCTION_SPECS:
            if spec["key"] == "watchdog":
                self.assertEqual(
                    environment["WATCHDOG_FUNCTION_NAME"], spec["name"]
                )

        statements = policy_statements(function)
        actions = {
            action
            for statement in statements
            for action in statement_actions(statement)
        }
        self.assertEqual(
            actions,
            {
                "cloudformation:DescribeStacks",
                "scheduler:GetSchedule",
                "dynamodb:GetItem",
                "dynamodb:Query",
                "dynamodb:PutItem",
                "sqs:GetQueueAttributes",
                "cloudwatch:GetMetricData",
                "cloudwatch:PutMetricData",
                "sns:Publish",
            },
        )
        self.assertTrue(
            actions.isdisjoint(
                {
                    "cloudformation:UpdateStack",
                    "cloudformation:CreateChangeSet",
                    "scheduler:UpdateSchedule",
                    "scheduler:CreateSchedule",
                    "iam:PutRolePolicy",
                    "iam:PassRole",
                    "lambda:InvokeFunction",
                    "lambda:UpdateFunctionCode",
                    "sqs:ReceiveMessage",
                    "sqs:DeleteMessage",
                    "sqs:SendMessage",
                }
            )
        )

        stack_read = statement_for_action(function, "cloudformation:DescribeStacks")
        self.assertEqual(
            stack_read["Resource"],
            {
                "tag": "Sub",
                "value": (
                    "arn:${AWS::Partition}:cloudformation:${AWS::Region}:"
                    "${AWS::AccountId}:stack/market-dashboard-readiness-v2/*"
                ),
            },
        )
        schedule_read = statement_for_action(function, "scheduler:GetSchedule")
        self.assertEqual(
            {
                item["value"]
                for item in schedule_read["Resource"]
                if item.get("tag") == "Sub"
            },
            {
                (
                    "arn:${AWS::Partition}:scheduler:${AWS::Region}:"
                    "${AWS::AccountId}:schedule/default/"
                    f"{spec['name']}"
                )
                for spec in watchdog.SCHEDULE_SPECS
            },
        )
        queue_read = statement_for_action(function, "sqs:GetQueueAttributes")
        self.assertEqual(
            queue_read["Resource"],
            {"tag": "GetAtt", "value": "RuntimeFailureQueue.Arn"},
        )
        heartbeat_read = statement_for_action(function, "dynamodb:Query")
        self.assertEqual(
            heartbeat_read["Resource"],
            {"tag": "GetAtt", "value": "ServiceHeartbeatTable.Arn"},
        )
        statements_by_sid = {
            statement["Sid"]: statement
            for statement in policy_statements(function)
            if "Sid" in statement
        }
        heartbeat_write = statements_by_sid["WriteTypedWatchdogHeartbeat"]
        alert_write = statements_by_sid["WriteOwnedWatchdogAlerts"]
        alert_publish = statements_by_sid["PublishWatchdogAlertLifecycle"]
        self.assertEqual(
            heartbeat_write["Resource"],
            {"tag": "GetAtt", "value": "ServiceHeartbeatTable.Arn"},
        )
        self.assertEqual(
            heartbeat_write["Condition"],
            {
                "ForAllValues:StringEquals": {
                    "dynamodb:LeadingKeys": ["hermes:cloud-watchdog"],
                },
                "Null": {"dynamodb:LeadingKeys": "false"},
            },
        )
        self.assertEqual(
            alert_write["Resource"],
            {
                "tag": "Sub",
                "value": (
                    "arn:${AWS::Partition}:dynamodb:${AWS::Region}:"
                    "${AWS::AccountId}:table/${HermesAlertsTableName}"
                ),
            },
        )
        self.assertEqual(
            alert_write["Condition"],
            {
                "ForAllValues:StringLike": {
                    "dynamodb:LeadingKeys": [
                        "cloud-watchdog#runtime-health#*",
                    ],
                },
                "Null": {"dynamodb:LeadingKeys": "false"},
            },
        )
        self.assertEqual(
            statement_actions(alert_write),
            {"dynamodb:GetItem", "dynamodb:PutItem"},
        )
        self.assertTrue(
            condition_allows_leading_key(
                heartbeat_write,
                "hermes:cloud-watchdog",
            )
        )
        for foreign_service_id in (
            "gmail:timsmithaviation@gmail.com",
            "hermes:quant-developer",
            "hermes:cloud-watchdog:manual",
        ):
            self.assertFalse(
                condition_allows_leading_key(
                    heartbeat_write,
                    foreign_service_id,
                )
            )
        self.assertTrue(
            condition_allows_leading_key(
                alert_write,
                "cloud-watchdog#runtime-health#GMAIL_INVOCATION_TIMEOUT",
            )
        )
        for foreign_alert_id in (
            "quant-developer#runtime-health#HERMES_HEARTBEAT_MISSING",
            "cloud-watchdog#deployment#FAILED",
            "foreign-host#runtime-health#FAILED",
        ):
            self.assertFalse(
                condition_allows_leading_key(
                    alert_write,
                    foreign_alert_id,
                )
            )
        self.assertEqual(statement_actions(alert_publish), {"sns:Publish"})
        self.assertEqual(
            alert_publish["Resource"],
            {"tag": "Ref", "value": "OperationsTopic"},
        )
        metric_write = statement_for_action(function, "cloudwatch:PutMetricData")
        self.assertEqual(metric_write["Resource"], "*")
        self.assertEqual(
            metric_write["Condition"],
            {
                "StringEquals": {
                    "cloudwatch:namespace": "MarketDashboard/Readiness"
                }
            },
        )

    def test_cloud_watchdog_alarms_default_to_no_actions(self):
        resources = self.template["Resources"]
        expected = {
            "CloudWatchdogHeartbeatMissingAlarm": ("Heartbeat", 600),
            "CloudWatchdogUnhealthyAlarm": ("Healthy", 300),
        }
        for logical_id, (metric_name, period) in expected.items():
            with self.subTest(logical_id=logical_id):
                properties = resources[logical_id]["Properties"]
                self.assertEqual(
                    properties["ActionsEnabled"],
                    (
                        {
                            "tag": "If",
                            "value": ["OperationalAlarmsEnabled", True, False],
                        }
                        if logical_id == "CloudWatchdogHeartbeatMissingAlarm"
                        else False
                    ),
                )
                self.assertEqual(
                    properties["Namespace"], "MarketDashboard/Readiness"
                )
                self.assertEqual(properties["MetricName"], metric_name)
                self.assertEqual(properties["Period"], period)
                self.assertEqual(
                    dimension_value(properties, "ServiceId"),
                    watchdog.WATCHDOG_SERVICE_ID,
                )
                self.assertEqual(
                    properties.get("AlarmActions"),
                    (
                        [{"tag": "Ref", "value": "OperationsTopic"}]
                        if logical_id == "CloudWatchdogHeartbeatMissingAlarm"
                        else None
                    ),
                )
                self.assertNotIn("OKActions", properties)

        self.assertEqual(
            resources["CloudWatchdogHeartbeatMissingAlarm"]["Properties"][
                "TreatMissingData"
            ],
            {
                "tag": "If",
                "value": [
                    "OperationalAlarmsEnabled",
                    "breaching",
                    "notBreaching",
                ],
            },
        )
        self.assertEqual(
            resources["CloudWatchdogUnhealthyAlarm"]["Properties"][
                "TreatMissingData"
            ],
            "notBreaching",
        )

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
        self.assertNotIn(
            "Subscription",
            resources["OperationsTopic"]["Properties"],
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

    def test_security_intelligence_tables_are_durable_and_match_manifest(self):
        resources = self.template["Resources"]
        manifest_resources = self.manifest["aws"]["resources"]
        entity_table = resources["ResearchEntityEventsV1"]
        product_table = resources["ResearchProductManifestsV1"]

        self.assertEqual(
            entity_table["Properties"]["TableName"],
            manifest_resources["researchEntityEventsTable"],
        )
        self.assertEqual(
            product_table["Properties"]["TableName"],
            manifest_resources["researchProductManifestTable"],
        )
        self.assertEqual(
            entity_table["Properties"]["KeySchema"],
            [
                {"AttributeName": "entityKey", "KeyType": "HASH"},
                {"AttributeName": "eventKey", "KeyType": "RANGE"},
            ],
        )
        self.assertEqual(
            entity_table["Properties"]["GlobalSecondaryIndexes"],
            [
                {
                    "IndexName": "marketDate-index",
                    "KeySchema": [
                        {"AttributeName": "marketDate", "KeyType": "HASH"},
                        {"AttributeName": "dateEventKey", "KeyType": "RANGE"},
                    ],
                    "Projection": {"ProjectionType": "ALL"},
                },
            ],
        )
        self.assertEqual(
            product_table["Properties"]["KeySchema"],
            [
                {"AttributeName": "marketDate", "KeyType": "HASH"},
                {"AttributeName": "productKey", "KeyType": "RANGE"},
            ],
        )
        for table in (entity_table, product_table):
            with self.subTest(table=table["Properties"]["TableName"]):
                self.assertEqual(table["DeletionPolicy"], "Retain")
                self.assertEqual(table["UpdateReplacePolicy"], "Retain")
                self.assertTrue(
                    table["Properties"]["PointInTimeRecoverySpecification"][
                        "PointInTimeRecoveryEnabled"
                    ]
                )
                self.assertTrue(table["Properties"]["SSESpecification"]["SSEEnabled"])

    def test_pdf_processor_has_completion_safe_runtime_and_least_privilege_access(self):
        resources = self.template["Resources"]
        gmail = resources["GmailIngestorFunction"]["Properties"]
        processor = resources["HedgeyePdfProcessorFunction"]["Properties"]
        worker = resources["HermesWorkerFunction"]["Properties"]
        queue = resources["RuntimeFailureQueue"]["Properties"]
        manifest_resources = self.manifest["aws"]["resources"]

        self.assertNotIn("Architectures", self.template["Globals"]["Function"])
        self.assertEqual(gmail["Architectures"], ["arm64"])
        self.assertEqual(processor["Handler"], "hedgeye_pdf_processor_lambda.lambda_handler")
        self.assertEqual(processor["CodeUri"], "../aws/lambda/")
        self.assertEqual(processor["Architectures"], ["x86_64"])
        self.assertEqual(worker["Architectures"], ["arm64"])
        makefile = (REPO_ROOT / "aws" / "lambda" / "Makefile").read_text()
        self.assertIn("--platform manylinux2014_x86_64", makefile)
        self.assertIn("--python-version 3.12", makefile)
        self.assertIn("--abi cp312", makefile)
        self.assertIn("--only-binary=:all:", makefile)
        self.assertEqual(processor["Timeout"], 900)
        self.assertEqual(
            processor["Environment"]["Variables"],
            {
                "HERMES_LEDGER_TABLE": {"tag": "Ref", "value": "GmailLedgerTableName"},
                "HEDGEYE_DAILY_SNAPSHOT_TABLE": {
                    "tag": "Ref",
                    "value": "HedgeyeDailySnapshotTableName",
                },
                "RESEARCH_ENTITY_EVENTS_TABLE": {
                    "tag": "Ref",
                    "value": "ResearchEntityEventsV1",
                },
                "RESEARCH_PRODUCT_MANIFEST_TABLE": {
                    "tag": "Ref",
                    "value": "ResearchProductManifestsV1",
                },
            },
        )
        self.assertEqual(
            gmail["Environment"]["Variables"]["PDF_PROCESSOR_FUNCTION_NAME"],
            {"tag": "Ref", "value": "HedgeyePdfProcessorFunction"},
        )

        invoke = statement_for_action(gmail, "lambda:InvokeFunction")
        self.assertEqual(
            invoke["Resource"],
            {"tag": "GetAtt", "value": "HedgeyePdfProcessorFunction.Arn"},
        )
        gmail_textract = statement_for_action(gmail, "textract:AnalyzeDocument")
        self.assertEqual(gmail_textract["Resource"], "*")
        textract = statement_for_action(processor, "textract:AnalyzeDocument")
        self.assertEqual(textract["Resource"], "*")
        snapshot_access = statement_for_action(processor, "dynamodb:UpdateItem")
        self.assertEqual(
            set(json.dumps(resource, sort_keys=True) for resource in snapshot_access["Resource"]),
            {
                json.dumps(
                    {
                        "tag": "Sub",
                        "value": (
                            "arn:${AWS::Partition}:dynamodb:${AWS::Region}:"
                            "${AWS::AccountId}:table/${GmailLedgerTableName}"
                        ),
                    },
                    sort_keys=True,
                ),
                json.dumps(
                    {"tag": "GetAtt", "value": "ResearchEntityEventsV1.Arn"},
                    sort_keys=True,
                ),
                json.dumps(
                    {"tag": "GetAtt", "value": "ResearchProductManifestsV1.Arn"},
                    sort_keys=True,
                ),
                json.dumps(
                    {
                        "tag": "Sub",
                        "value": (
                            "arn:${AWS::Partition}:dynamodb:${AWS::Region}:"
                            "${AWS::AccountId}:table/${HedgeyeDailySnapshotTableName}"
                        ),
                    },
                    sort_keys=True,
                ),
            },
        )
        self.assertEqual(
            manifest_resources["researchEntityEventsTable"],
            resources["ResearchEntityEventsV1"]["Properties"]["TableName"],
        )
        self.assertEqual(
            manifest_resources["researchProductManifestTable"],
            resources["ResearchProductManifestsV1"]["Properties"]["TableName"],
        )
        for function in (gmail, processor):
            dynamodb_resources = [
                resource
                for statement in policy_statements(function)
                if any(action.startswith("dynamodb:") for action in statement_actions(statement))
                for resource in (
                    statement["Resource"]
                    if isinstance(statement.get("Resource"), list)
                    else [statement.get("Resource")]
                )
            ]
            self.assertFalse(
                any("/index/" in json.dumps(resource) for resource in dynamodb_resources),
                "write-only ingestion functions do not need GSI permissions",
            )

        self.assertEqual(
            processor["EventInvokeConfig"],
            {
                "MaximumEventAgeInSeconds": 3600,
                "MaximumRetryAttempts": 2,
                "DestinationConfig": {
                    "OnFailure": {
                        "Type": "SQS",
                        "Destination": {
                            "tag": "GetAtt",
                            "value": "RuntimeFailureQueue.Arn",
                        },
                    },
                },
            },
        )
        for function in (gmail, processor):
            with self.subTest(function=function["FunctionName"]):
                self.assertEqual(
                    function["EventInvokeConfig"]["DestinationConfig"]["OnFailure"],
                    {
                        "Type": "SQS",
                        "Destination": {
                            "tag": "GetAtt",
                            "value": "RuntimeFailureQueue.Arn",
                        },
                    },
                )
                send = statement_for_action(function, "sqs:SendMessage")
                self.assertEqual(
                    send["Resource"],
                    {"tag": "GetAtt", "value": "RuntimeFailureQueue.Arn"},
                )
        self.assertEqual(queue["MessageRetentionPeriod"], 1209600)
        self.assertTrue(queue["SqsManagedSseEnabled"])

        outputs = self.template["Outputs"]
        self.assertEqual(
            outputs["HedgeyePdfProcessorFunctionName"]["Value"],
            {"tag": "Ref", "value": "HedgeyePdfProcessorFunction"},
        )
        self.assertEqual(
            outputs["ResearchEntityEventsTableName"]["Value"],
            {"tag": "Ref", "value": "ResearchEntityEventsV1"},
        )
        self.assertEqual(
            outputs["ResearchProductManifestsTableName"]["Value"],
            {"tag": "Ref", "value": "ResearchProductManifestsV1"},
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
                    False,
                )
                self.assertNotIn("AlarmActions", unhealthy)
                self.assertNotIn("OKActions", unhealthy)

                missing = resources[MISSING_ALARM_RESOURCES[job_type]]["Properties"]
                self.assertEqual(missing["MetricName"], "Heartbeat")
                self.assertEqual(
                    missing["Period"],
                    contract["cadenceMinutes"] * 2 * 60,
                )
                self.assertEqual(missing["EvaluationPeriods"], 1)
                self.assertEqual(missing["Threshold"], 1)
                self.assertEqual(
                    missing["TreatMissingData"],
                    {
                        "tag": "If",
                        "value": [
                            "OperationalAlarmsEnabled",
                            "breaching",
                            "notBreaching",
                        ],
                    },
                )
                self.assertEqual(dimension_value(missing, "ServiceId"), contract["serviceId"])
                self.assertEqual(
                    missing["AlarmActions"],
                    [{"tag": "Ref", "value": "OperationsTopic"}],
                )
                self.assertNotIn("OKActions", missing)


if __name__ == "__main__":
    unittest.main()
