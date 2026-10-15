#!/usr/bin/env python3
"""Install and verify the dashboard's cost-only AWS notification route.

Usage (read-only by default):
  python3 infra/scripts/configure_cost_guardian.py --status
  python3 infra/scripts/configure_cost_guardian.py --configure --apply
  python3 infra/scripts/configure_cost_guardian.py --resume --apply
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Any, Dict

import boto3

try:
    from aws_profile_contract import (
        ADMIN_PROFILE,
        LOCAL_PROFILE,
        AwsProfileContractError,
        verified_session,
    )
except ModuleNotFoundError:  # pragma: no cover - direct execution fallback
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from aws_profile_contract import (  # type: ignore
        ADMIN_PROFILE,
        LOCAL_PROFILE,
        AwsProfileContractError,
        verified_session,
    )


ROOT = Path(__file__).resolve().parents[2]
REGION = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-west-1"))
ACCOUNT_ID = os.environ.get("AWS_ACCOUNT_ID", "915328198276")
BUDGET_NAME = "MarketDashboardMonthlyCostCeiling"
BUDGET_LIMIT = 50.0
WARNING_THRESHOLDS = (25.0, 45.0, 50.0)
EMAIL = "timsmithaviation@gmail.com"
OPERATIONS_TOPIC_NAME = "market-dashboard-operations-v2"
GUARDIAN_TOPIC_NAME = "market-dashboard-cost-guardian-trigger-v1"
GUARDIAN_NAME = "market-dashboard-cost-guardian-v1"
GUARDIAN_ROLE_NAME = "market-dashboard-cost-guardian-v1"
STATE_PARAMETER = "/market-dashboard/cost-guard/state"
WATCHDOG_RULE = "market-dashboard-hermes-cloud-watchdog-v1"
SCHEDULES = (
    "market-dashboard-gmail-v2-every-15m",
    "market-dashboard-hermes-quant-analyst-v2",
    "market-dashboard-hermes-quant-developer-v2",
    "market-dashboard-hermes-security-v2",
    "market-dashboard-cftc-weekday-v1",
)
FUNCTIONS = (
    "hermes-security",
    "hedgeye-pdf-processor",
    "PortfolioApiGetLatest",
    "CSVPortfolioProcessor",
    "hermes-quant-developer",
    "hermes-quant-analyst",
    "RiskRangeScraper",
    "hermes-gmail-ingestor",
    "market-dashboard-hermes-worker-v2",
    "market-dashboard-hermes-cloud-watchdog-v1",
    "market-dashboard-gmail-ingestor-v2",
    "market-dashboard-hedgeye-pdf-processor-v1",
    "market-dashboard-cftc-ingestor-v1",
)
ALARMS = (
    "market-dashboard-runtime-failure-queue-v2",
    "market-dashboard-runtime-failure-arrival-v2",
    "market-dashboard-gmail-heartbeat-missing-v2",
    "market-dashboard-gmail-unhealthy-v2",
    "market-dashboard-hermes-analyst-heartbeat-missing-v2",
    "market-dashboard-hermes-analyst-unhealthy-v2",
    "market-dashboard-hermes-developer-heartbeat-missing-v2",
    "market-dashboard-hermes-developer-unhealthy-v2",
    "market-dashboard-hermes-security-heartbeat-missing-v2",
    "market-dashboard-hermes-security-unhealthy-v2",
    "market-dashboard-hermes-cloud-watchdog-heartbeat-missing-v2",
    "market-dashboard-hermes-cloud-watchdog-unhealthy-v2",
)

MANAGED_TOPIC_POLICY_SIDS = {
    "AllowBudgetsPublish",
    "AllowCostAnomalyPublish",
}
EXPECTED_EMAIL_PROTOCOLS = {"email", "email-json"}


class NotificationCutoverBlocked(RuntimeError):
    """Stop before deleting an email endpoint that the cutover does not own."""

    def __init__(self, code: str, detail: Dict[str, Any] | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.detail = dict(detail or {})


def clients(session: Any) -> Dict[str, Any]:
    return {
        key: session.client(key)
        for key in ("budgets", "ce", "sns", "lambda", "iam", "events", "scheduler", "cloudwatch", "ssm")
    }


def topic_arn(name: str) -> str:
    return f"arn:aws:sns:{REGION}:{ACCOUNT_ID}:{name}"


def operations_topic_arn() -> str:
    return topic_arn(OPERATIONS_TOPIC_NAME)


def guardian_topic_arn() -> str:
    return topic_arn(GUARDIAN_TOPIC_NAME)


def function_arn(name: str) -> str:
    return f"arn:aws:lambda:{REGION}:{ACCOUNT_ID}:function:{name}"


def schedule_arn(name: str) -> str:
    return f"arn:aws:scheduler:{REGION}:{ACCOUNT_ID}:schedule/default/{name}"


def rule_arn() -> str:
    return f"arn:aws:events:{REGION}:{ACCOUNT_ID}:rule/{WATCHDOG_RULE}"


def describe_budget(api: Dict[str, Any]) -> Dict[str, Any]:
    return api["budgets"].describe_budget(
        AccountId=ACCOUNT_ID, BudgetName=BUDGET_NAME
    )["Budget"]


def budget_definition(current: Dict[str, Any]) -> Dict[str, Any]:
    definition = {
        "BudgetName": BUDGET_NAME,
        "BudgetLimit": {"Amount": str(BUDGET_LIMIT), "Unit": "USD"},
        "TimeUnit": "MONTHLY",
        "BudgetType": "COST",
    }
    for key in (
        "BillingViewArn",
        "CostFilters",
        "CostTypes",
        "FilterExpression",
        "Metrics",
        "TimePeriod",
    ):
        if current.get(key) is not None:
            definition[key] = current[key]
    return definition


def notifications(api: Dict[str, Any]) -> list[Dict[str, Any]]:
    items: list[Dict[str, Any]] = []
    token: str | None = None
    while True:
        request: Dict[str, Any] = {
            "AccountId": ACCOUNT_ID,
            "BudgetName": BUDGET_NAME,
            "MaxResults": 100,
        }
        if token:
            request["NextToken"] = token
        response = api["budgets"].describe_notifications_for_budget(**request)
        items.extend(response.get("Notifications") or [])
        token = response.get("NextToken")
        if not token:
            return items


def _notification_input(item: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "NotificationType": item["NotificationType"],
        "ComparisonOperator": item["ComparisonOperator"],
        "Threshold": float(item["Threshold"]),
        "ThresholdType": item.get("ThresholdType", "PERCENTAGE"),
    }


def _notification_key(item: Dict[str, Any]) -> tuple[str, str, float, str]:
    normalized = _notification_input(item)
    return (
        normalized["NotificationType"],
        normalized["ComparisonOperator"],
        normalized["Threshold"],
        normalized["ThresholdType"],
    )


def _expected_notification(threshold: float) -> Dict[str, Any]:
    return {
        "NotificationType": "ACTUAL",
        "ComparisonOperator": "GREATER_THAN",
        "Threshold": float(threshold),
        "ThresholdType": "ABSOLUTE_VALUE",
    }


def _expected_budget_subscribers(threshold: float) -> list[Dict[str, str]]:
    subscribers = [{"SubscriptionType": "EMAIL", "Address": EMAIL}]
    if float(threshold) == BUDGET_LIMIT:
        subscribers.append(
            {"SubscriptionType": "SNS", "Address": guardian_topic_arn()}
        )
    return subscribers


def _budget_subscribers(
    api: Dict[str, Any], notification: Dict[str, Any]
) -> list[Dict[str, str]]:
    items: list[Dict[str, str]] = []
    token: str | None = None
    while True:
        request: Dict[str, Any] = {
            "AccountId": ACCOUNT_ID,
            "BudgetName": BUDGET_NAME,
            "Notification": _notification_input(notification),
            "MaxResults": 100,
        }
        if token:
            request["NextToken"] = token
        response = api["budgets"].describe_subscribers_for_notification(**request)
        items.extend(response.get("Subscribers") or [])
        token = response.get("NextToken")
        if not token:
            return items


def _subscriber_key(item: Dict[str, Any]) -> tuple[str, str]:
    return str(item.get("SubscriptionType") or ""), str(item.get("Address") or "")


def _topic_subscriptions(api: Dict[str, Any], arn: str) -> list[Dict[str, Any]]:
    items: list[Dict[str, Any]] = []
    token: str | None = None
    while True:
        request: Dict[str, Any] = {"TopicArn": arn}
        if token:
            request["NextToken"] = token
        response = api["sns"].list_subscriptions_by_topic(**request)
        items.extend(response.get("Subscriptions") or [])
        token = response.get("NextToken")
        if not token:
            return items


def _default_anomaly_subscriptions(api: Dict[str, Any]) -> list[Dict[str, Any]]:
    items: list[Dict[str, Any]] = []
    token: str | None = None
    while True:
        request: Dict[str, Any] = {"MaxResults": 100}
        if token:
            request["NextPageToken"] = token
        response = api["ce"].get_anomaly_subscriptions(**request)
        items.extend(
            item
            for item in response.get("AnomalySubscriptions") or []
            if item.get("SubscriptionName") == "Default-Services-Subscription"
        )
        token = response.get("NextPageToken")
        if not token:
            return items


def _ensure_topic(api: Dict[str, Any], name: str) -> str:
    arn = api["sns"].create_topic(Name=name)["TopicArn"]
    expected = topic_arn(name)
    if arn != expected:
        raise NotificationCutoverBlocked(
            "SNS_TOPIC_ARN_MISMATCH",
            {"topicName": name},
        )
    return arn


def _reconcile_topic_policy(
    api: Dict[str, Any],
    arn: str,
    managed_statements: list[Dict[str, Any]],
) -> None:
    sns = api["sns"]
    attributes = sns.get_topic_attributes(TopicArn=arn).get("Attributes") or {}
    raw_policy = attributes.get("Policy")
    current = json.loads(raw_policy) if raw_policy else {
        "Version": "2012-10-17",
        "Statement": [],
    }
    statements = [
        item
        for item in current.get("Statement") or []
        if item.get("Sid") not in MANAGED_TOPIC_POLICY_SIDS
    ]
    current["Statement"] = statements + managed_statements
    sns.set_topic_attributes(
        TopicArn=arn,
        AttributeName="Policy",
        AttributeValue=json.dumps(current, separators=(",", ":"), sort_keys=True),
    )


def _budget_publish_statement(arn: str) -> Dict[str, Any]:
    return {
        "Sid": "AllowBudgetsPublish",
        "Effect": "Allow",
        "Principal": {"Service": "budgets.amazonaws.com"},
        "Action": "SNS:Publish",
        "Resource": arn,
        "Condition": {
            "StringEquals": {"aws:SourceAccount": ACCOUNT_ID},
            "ArnLike": {"aws:SourceArn": f"arn:aws:budgets::{ACCOUNT_ID}:*"},
        },
    }


def _anomaly_publish_statement(
    arn: str, anomaly_subscriptions: list[Dict[str, Any]]
) -> Dict[str, Any]:
    source_arns = sorted(
        str(item["SubscriptionArn"])
        for item in anomaly_subscriptions
        if item.get("SubscriptionArn")
    )
    condition: Dict[str, Any] = {
        "StringEquals": {"aws:SourceAccount": ACCOUNT_ID}
    }
    if source_arns:
        condition["ArnEquals"] = {
            "aws:SourceArn": source_arns[0] if len(source_arns) == 1 else source_arns
        }
    return {
        "Sid": "AllowCostAnomalyPublish",
        "Effect": "Allow",
        "Principal": {"Service": "costalerts.amazonaws.com"},
        "Action": "SNS:Publish",
        "Resource": arn,
        "Condition": condition,
    }


def _ensure_role(api: Dict[str, Any]) -> str:
    iam = api["iam"]
    try:
        role = iam.get_role(RoleName=GUARDIAN_ROLE_NAME)["Role"]
    except iam.exceptions.NoSuchEntityException:
        role = iam.create_role(
            RoleName=GUARDIAN_ROLE_NAME,
            AssumeRolePolicyDocument=json.dumps(
                {
                    "Version": "2012-10-17",
                    "Statement": [
                        {
                            "Effect": "Allow",
                            "Principal": {"Service": "lambda.amazonaws.com"},
                            "Action": "sts:AssumeRole",
                        }
                    ],
                }
            ),
            Description=f"Pauses market-dashboard compute at its actual ${BUDGET_LIMIT:g} monthly AWS budget threshold.",
        )["Role"]

    iam.update_role_description(
        RoleName=GUARDIAN_ROLE_NAME,
        Description=f"Pauses market-dashboard compute at its actual ${BUDGET_LIMIT:g} monthly AWS budget threshold.",
    )
    policy = {
        "Version": "2012-10-17",
        "Statement": [
            {"Effect": "Allow", "Action": ["scheduler:GetSchedule", "scheduler:UpdateSchedule"], "Resource": [schedule_arn(name) for name in SCHEDULES]},
            {"Effect": "Allow", "Action": ["events:DescribeRule", "events:DisableRule", "events:EnableRule"], "Resource": rule_arn()},
            {"Effect": "Allow", "Action": ["lambda:GetFunctionConcurrency", "lambda:PutFunctionConcurrency", "lambda:DeleteFunctionConcurrency"], "Resource": [function_arn(name) for name in FUNCTIONS]},
            {"Effect": "Allow", "Action": ["cloudwatch:DescribeAlarms", "cloudwatch:DisableAlarmActions", "cloudwatch:EnableAlarmActions"], "Resource": "*"},
            {"Effect": "Allow", "Action": ["ssm:GetParameter", "ssm:PutParameter"], "Resource": f"arn:aws:ssm:{REGION}:{ACCOUNT_ID}:parameter{STATE_PARAMETER}"},
            {
                "Effect": "Allow",
                "Action": "sns:Publish",
                "Resource": operations_topic_arn(),
            },
            {"Effect": "Allow", "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], "Resource": "*"},
        ],
    }
    iam.put_role_policy(
        RoleName=GUARDIAN_ROLE_NAME,
        PolicyName="market-dashboard-cost-guardian-runtime-v1",
        PolicyDocument=json.dumps(policy),
    )
    return role["Arn"]


def _lambda_zip() -> bytes:
    source = ROOT / "infra" / "lambdas" / "cost_guardian" / "cost_guardian.py"
    with tempfile.NamedTemporaryFile(suffix=".zip") as handle:
        with zipfile.ZipFile(handle, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.write(source, "cost_guardian.py")
        handle.flush()
        return Path(handle.name).read_bytes()


def _lambda_environment() -> Dict[str, str]:
    return {
        "COST_GUARD_BUDGET_NAME": BUDGET_NAME,
        "COST_GUARD_PAUSE_THRESHOLD": str(BUDGET_LIMIT),
        "COST_GUARD_STATE_PARAMETER": STATE_PARAMETER,
        "COST_GUARD_WATCHDOG_RULE": WATCHDOG_RULE,
        "COST_GUARD_SCHEDULE_NAMES": ",".join(SCHEDULES),
        "COST_GUARD_ALARM_NAMES": ",".join(ALARMS),
        "COST_GUARD_FUNCTION_NAMES": ",".join(FUNCTIONS),
        "HERMES_OPERATIONS_TOPIC_ARN": operations_topic_arn(),
        "COST_GUARD_TRIGGER_TOPIC_ARN": guardian_topic_arn(),
    }


def _wait_lambda_ready(lambda_api: Any) -> None:
    deadline = time.time() + 300
    while time.time() < deadline:
        configuration = lambda_api.get_function_configuration(FunctionName=GUARDIAN_NAME)
        if (
            configuration.get("State") == "Active"
            and configuration.get("LastUpdateStatus") in {None, "Successful"}
        ):
            return
        time.sleep(5)
    raise TimeoutError(f"Timed out waiting for {GUARDIAN_NAME} to finish updating")


def _ensure_lambda(api: Dict[str, Any], role_arn: str) -> str:
    lambda_api = api["lambda"]
    code = {"ZipFile": _lambda_zip()}
    try:
        lambda_api.get_function(FunctionName=GUARDIAN_NAME)
        _wait_lambda_ready(lambda_api)
        lambda_api.update_function_code(FunctionName=GUARDIAN_NAME, **code, Publish=True)
        _wait_lambda_ready(lambda_api)
        lambda_api.update_function_configuration(
            FunctionName=GUARDIAN_NAME,
            Role=role_arn,
            Runtime="python3.12",
            Handler="cost_guardian.lambda_handler",
            Description=f"Pauses dashboard compute at the actual ${BUDGET_LIMIT:g} monthly AWS budget threshold.",
            Timeout=180,
            MemorySize=256,
            Environment={"Variables": _lambda_environment()},
        )
    except lambda_api.exceptions.ResourceNotFoundException:
        lambda_api.create_function(
            FunctionName=GUARDIAN_NAME,
            Runtime="python3.12",
            Role=role_arn,
            Handler="cost_guardian.lambda_handler",
            Code=code,
            Description=f"Pauses dashboard compute at the actual ${BUDGET_LIMIT:g} monthly AWS budget threshold.",
            Timeout=180,
            MemorySize=256,
            Publish=True,
            Environment={"Variables": _lambda_environment()},
        )
    _wait_lambda_ready(lambda_api)
    return function_arn(GUARDIAN_NAME)


def _remove_lambda_permission(lambda_api: Any, statement_id: str) -> None:
    try:
        lambda_api.remove_permission(
            FunctionName=GUARDIAN_NAME,
            StatementId=statement_id,
        )
    except lambda_api.exceptions.ResourceNotFoundException:
        pass


def _ensure_guardian_subscription(api: Dict[str, Any], guardian_arn: str) -> None:
    sns = api["sns"]
    lambda_api = api["lambda"]
    trigger_arn = guardian_topic_arn()
    subscriptions = _topic_subscriptions(api, trigger_arn)
    unexpected = [
        item
        for item in subscriptions
        if item.get("Protocol") != "lambda" or item.get("Endpoint") != guardian_arn
    ]
    if unexpected:
        raise NotificationCutoverBlocked(
            "GUARDIAN_TOPIC_UNEXPECTED_SUBSCRIPTION",
            {
                "subscriptionCount": len(unexpected),
                "protocols": sorted(
                    {str(item.get("Protocol") or "unknown") for item in unexpected}
                ),
            },
        )

    matching = [
        item
        for item in subscriptions
        if item.get("Protocol") == "lambda" and item.get("Endpoint") == guardian_arn
    ]
    if not matching:
        sns.subscribe(
            TopicArn=trigger_arn,
            Protocol="lambda",
            Endpoint=guardian_arn,
            ReturnSubscriptionArn=True,
        )
    elif len(matching) > 1:
        for duplicate in matching[1:]:
            subscription_arn = duplicate.get("SubscriptionArn")
            if subscription_arn not in {None, "", "PendingConfirmation"}:
                sns.unsubscribe(SubscriptionArn=subscription_arn)

    _remove_lambda_permission(lambda_api, "AllowCostGuardianTopicInvoke")
    try:
        lambda_api.add_permission(
            FunctionName=GUARDIAN_NAME,
            StatementId="AllowCostGuardianTopicInvoke",
            Action="lambda:InvokeFunction",
            Principal="sns.amazonaws.com",
            SourceArn=trigger_arn,
        )
    except lambda_api.exceptions.ResourceConflictException:
        pass
    _remove_lambda_permission(lambda_api, "AllowOperationsTopicInvoke")


def _preflight_guardian_subscriptions(api: Dict[str, Any], guardian_arn: str) -> None:
    subscriptions = _topic_subscriptions(api, guardian_topic_arn())
    unexpected = [
        item
        for item in subscriptions
        if item.get("Protocol") != "lambda" or item.get("Endpoint") != guardian_arn
    ]
    if unexpected:
        raise NotificationCutoverBlocked(
            "GUARDIAN_TOPIC_UNEXPECTED_SUBSCRIPTION",
            {
                "subscriptionCount": len(unexpected),
                "protocols": sorted(
                    {str(item.get("Protocol") or "unknown") for item in unexpected}
                ),
            },
        )


def _preflight_operations_email_routes(api: Dict[str, Any]) -> None:
    email_routes = [
        item
        for item in _topic_subscriptions(api, operations_topic_arn())
        if item.get("Protocol") in EXPECTED_EMAIL_PROTOCOLS
    ]
    unexpected = [item for item in email_routes if item.get("Endpoint") != EMAIL]
    if unexpected:
        raise NotificationCutoverBlocked(
            "OPERATIONS_TOPIC_UNEXPECTED_EMAIL_ENDPOINT",
            {
                "unexpectedEmailSubscriptionCount": len(unexpected),
                "protocols": sorted(
                    {str(item.get("Protocol") or "unknown") for item in unexpected}
                ),
            },
        )


def _migrate_operations_subscriptions(
    api: Dict[str, Any], guardian_arn: str
) -> Dict[str, int]:
    _preflight_operations_email_routes(api)
    removed_email = 0
    removed_guardian = 0
    pending_email = 0
    for item in _topic_subscriptions(api, operations_topic_arn()):
        protocol = item.get("Protocol")
        endpoint = item.get("Endpoint")
        subscription_arn = item.get("SubscriptionArn")
        if protocol in EXPECTED_EMAIL_PROTOCOLS and endpoint == EMAIL:
            if subscription_arn in {None, "", "PendingConfirmation"}:
                pending_email += 1
            else:
                api["sns"].unsubscribe(SubscriptionArn=subscription_arn)
                removed_email += 1
        elif protocol == "lambda" and endpoint == guardian_arn:
            if subscription_arn not in {None, "", "PendingConfirmation"}:
                api["sns"].unsubscribe(SubscriptionArn=subscription_arn)
                removed_guardian += 1
    return {
        "removedEmailSubscriptions": removed_email,
        "removedLegacyGuardianSubscriptions": removed_guardian,
        "pendingEmailSubscriptions": pending_email,
    }


def _configure_budget(api: Dict[str, Any]) -> None:
    budgets = api["budgets"]
    try:
        current = describe_budget(api)
    except budgets.exceptions.NotFoundException:
        budgets.create_budget(
            AccountId=ACCOUNT_ID,
            Budget=budget_definition({}),
            NotificationsWithSubscribers=[
                {
                    "Notification": _expected_notification(threshold),
                    "Subscribers": _expected_budget_subscribers(threshold),
                }
                for threshold in WARNING_THRESHOLDS
            ],
        )
        return
    budgets.update_budget(AccountId=ACCOUNT_ID, NewBudget=budget_definition(current))
    expected = {
        _notification_key(_expected_notification(threshold)): threshold
        for threshold in WARNING_THRESHOLDS
    }
    observed = notifications(api)
    retained: Dict[tuple[str, str, float, str], Dict[str, Any]] = {}
    for item in observed:
        key = _notification_key(item)
        if key not in expected or key in retained:
            budgets.delete_notification(
                AccountId=ACCOUNT_ID,
                BudgetName=BUDGET_NAME,
                Notification=_notification_input(item),
            )
            continue
        retained[key] = item

    for key, threshold in expected.items():
        expected_subscribers = _expected_budget_subscribers(threshold)
        if key not in retained:
            budgets.create_notification(
                AccountId=ACCOUNT_ID,
                BudgetName=BUDGET_NAME,
                Notification=_expected_notification(threshold),
                Subscribers=expected_subscribers,
            )
            continue

        notification = retained[key]
        current_subscribers = _budget_subscribers(api, notification)
        current_keys = {_subscriber_key(item) for item in current_subscribers}
        expected_keys = {_subscriber_key(item) for item in expected_subscribers}
        for subscriber in current_subscribers:
            if _subscriber_key(subscriber) not in expected_keys:
                budgets.delete_subscriber(
                    AccountId=ACCOUNT_ID,
                    BudgetName=BUDGET_NAME,
                    Notification=_notification_input(notification),
                    Subscriber=subscriber,
                )
        for subscriber in expected_subscribers:
            if _subscriber_key(subscriber) not in current_keys:
                budgets.create_subscriber(
                    AccountId=ACCOUNT_ID,
                    BudgetName=BUDGET_NAME,
                    Notification=_notification_input(notification),
                    Subscriber=subscriber,
                )


def _configure_anomaly_notifications(
    api: Dict[str, Any], subscriptions: list[Dict[str, Any]]
) -> None:
    expected = [{"Address": operations_topic_arn(), "Type": "SNS"}]
    for subscription in subscriptions:
        current = [
            {"Address": item.get("Address"), "Type": item.get("Type")}
            for item in subscription.get("Subscribers") or []
        ]
        if subscription.get("Frequency") == "IMMEDIATE" and current == expected:
            continue
        api["ce"].update_anomaly_subscription(
            SubscriptionArn=subscription["SubscriptionArn"],
            Frequency="IMMEDIATE",
            Subscribers=expected,
        )


def _invoke(api: Dict[str, Any], action: str) -> Dict[str, Any]:
    response = api["lambda"].invoke(
        FunctionName=GUARDIAN_NAME,
        InvocationType="RequestResponse",
        Payload=json.dumps({"action": action}).encode("utf-8"),
    )
    payload = response.get("Payload")
    return json.loads(payload.read()) if payload else {}


def _topic_status(
    api: Dict[str, Any], arn: str, *, expected_lambda_arn: str | None = None
) -> Dict[str, Any]:
    try:
        subscriptions = _topic_subscriptions(api, arn)
    except api["sns"].exceptions.NotFoundException:
        return {
            "name": arn.rsplit(":", 1)[-1],
            "protocolCounts": {},
            "routes": [],
            "missing": True,
        }
    protocol_counts: Dict[str, int] = {}
    routes = []
    for item in subscriptions:
        protocol = str(item.get("Protocol") or "unknown")
        protocol_counts[protocol] = protocol_counts.get(protocol, 0) + 1
        endpoint = str(item.get("Endpoint") or "")
        if protocol in EXPECTED_EMAIL_PROTOCOLS:
            target = "configured-alert-email" if endpoint == EMAIL else "other-email"
        elif protocol == "lambda":
            target = (
                "cost-guardian"
                if expected_lambda_arn and endpoint == expected_lambda_arn
                else "other-lambda"
            )
        else:
            target = "internal-consumer"
        routes.append(
            {
                "protocol": protocol,
                "target": target,
                "state": (
                    "pending"
                    if item.get("SubscriptionArn")
                    in {None, "", "PendingConfirmation"}
                    else "confirmed"
                ),
            }
        )
    routes.sort(key=lambda item: (item["protocol"], item["target"], item["state"]))
    return {
        "name": arn.rsplit(":", 1)[-1],
        "protocolCounts": protocol_counts,
        "routes": routes,
    }


def _budget_status(api: Dict[str, Any], budget: Dict[str, Any]) -> Dict[str, Any]:
    rows = []
    observed_keys: set[tuple[str, str, float, str]] = set()
    expected_keys = {
        _notification_key(_expected_notification(threshold)): threshold
        for threshold in WARNING_THRESHOLDS
    }
    exact = True
    for notification in notifications(api):
        key = _notification_key(notification)
        subscribers = _budget_subscribers(api, notification)
        routes = []
        for subscriber in subscribers:
            subscriber_type, address = _subscriber_key(subscriber)
            if subscriber_type == "EMAIL":
                target = "configured-alert-email" if address == EMAIL else "other-email"
            elif subscriber_type == "SNS":
                target = (
                    "cost-guardian-trigger"
                    if address == guardian_topic_arn()
                    else "other-topic"
                )
            else:
                target = "unknown"
            routes.append({"type": subscriber_type, "target": target})
        routes.sort(key=lambda item: (item["type"], item["target"]))
        expected_threshold = expected_keys.get(key)
        expected_routes = (
            sorted(
                [
                    {
                        "type": item["SubscriptionType"],
                        "target": (
                            "configured-alert-email"
                            if item["SubscriptionType"] == "EMAIL"
                            else "cost-guardian-trigger"
                        ),
                    }
                    for item in _expected_budget_subscribers(expected_threshold)
                ],
                key=lambda item: (item["type"], item["target"]),
            )
            if expected_threshold is not None
            else []
        )
        conforms = expected_threshold is not None and routes == expected_routes
        exact = exact and conforms and key not in observed_keys
        observed_keys.add(key)
        rows.append(
            {
                "notificationType": key[0],
                "comparison": key[1],
                "threshold": key[2],
                "thresholdType": key[3],
                "state": notification.get("NotificationState"),
                "routes": routes,
                "conforms": conforms,
            }
        )
    exact = exact and observed_keys == set(expected_keys)
    limit = budget.get("BudgetLimit") or {}
    try:
        limit_amount = float(limit.get("Amount"))
    except (TypeError, ValueError):
        limit_amount = None
    definition_conforms = (
        budget.get("BudgetName") == BUDGET_NAME
        and budget.get("BudgetType") == "COST"
        and budget.get("TimeUnit") == "MONTHLY"
        and limit.get("Unit") == "USD"
        and limit_amount == BUDGET_LIMIT
    )
    rows.sort(key=lambda item: (item["notificationType"], item["threshold"]))
    return {
        "name": budget.get("BudgetName"),
        "limit": limit,
        "actual": budget.get("CalculatedSpend", {}).get("ActualSpend"),
        "forecast": budget.get("CalculatedSpend", {}).get("ForecastedSpend"),
        "notifications": rows,
        "exactMatrix": exact,
        "definitionConforms": definition_conforms,
        "conforms": exact and definition_conforms,
    }


def _anomaly_status(subscriptions: list[Dict[str, Any]]) -> Dict[str, Any]:
    rows = []
    for item in subscriptions:
        routes = []
        for subscriber in item.get("Subscribers") or []:
            route_type = str(subscriber.get("Type") or "unknown")
            address = str(subscriber.get("Address") or "")
            if route_type == "SNS" and address == operations_topic_arn():
                target = "operations-topic"
            elif route_type == "EMAIL":
                target = "email"
            else:
                target = "other"
            routes.append({"type": route_type, "target": target})
        routes.sort(key=lambda route: (route["type"], route["target"]))
        rows.append(
            {
                "name": item.get("SubscriptionName"),
                "frequency": item.get("Frequency"),
                "thresholdExpression": item.get("ThresholdExpression"),
                "routes": routes,
                "conforms": (
                    item.get("Frequency") == "IMMEDIATE"
                    and routes == [{"type": "SNS", "target": "operations-topic"}]
                ),
            }
        )
    return {
        "present": bool(rows),
        "subscriptions": rows,
        "conforms": all(item["conforms"] for item in rows),
    }


def status(api: Dict[str, Any]) -> Dict[str, Any]:
    try:
        budget = describe_budget(api)
        budget_matrix = _budget_status(api, budget)
    except api["budgets"].exceptions.NotFoundException:
        budget_matrix = {
            "name": BUDGET_NAME,
            "limit": None,
            "actual": None,
            "forecast": None,
            "notifications": [],
            "exactMatrix": False,
            "definitionConforms": False,
            "conforms": False,
            "missing": True,
        }
    state = {}
    try:
        state = json.loads(api["ssm"].get_parameter(Name=STATE_PARAMETER)["Parameter"]["Value"])
    except Exception:
        pass
    if not isinstance(state, dict):
        state = {}
    guardian_arn = function_arn(GUARDIAN_NAME)
    try:
        guardian_configuration = api["lambda"].get_function_configuration(
            FunctionName=GUARDIAN_NAME
        )
        guardian_runtime = {
            "name": GUARDIAN_NAME,
            "state": guardian_configuration.get("State"),
            "lastUpdateStatus": guardian_configuration.get("LastUpdateStatus"),
        }
    except api["lambda"].exceptions.ResourceNotFoundException:
        guardian_runtime = {
            "name": GUARDIAN_NAME,
            "state": "MISSING",
            "lastUpdateStatus": None,
        }
    operations = _topic_status(api, operations_topic_arn())
    trigger = _topic_status(
        api,
        guardian_topic_arn(),
        expected_lambda_arn=guardian_arn,
    )
    anomaly = _anomaly_status(_default_anomaly_subscriptions(api))
    operations_conforms = (
        not operations.get("missing")
        and not any(
            route["protocol"] in EXPECTED_EMAIL_PROTOCOLS
            for route in operations["routes"]
        )
    )
    trigger_conforms = trigger["routes"] == [
        {"protocol": "lambda", "target": "cost-guardian", "state": "confirmed"}
    ]
    guardian_conforms = (
        guardian_runtime["state"] == "Active"
        and guardian_runtime["lastUpdateStatus"] in {None, "Successful"}
        and state.get("status") not in {"pause-partial", "resume-partial"}
        and not state.get("errors")
        and not state.get("resumeErrors")
    )
    return {
        "conforms": (
            operations_conforms
            and trigger_conforms
            and budget_matrix["conforms"]
            and anomaly["conforms"]
            and guardian_conforms
        ),
        "topics": {
            "operations": {**operations, "conforms": operations_conforms},
            "costGuardianTrigger": {**trigger, "conforms": trigger_conforms},
        },
        "budget": budget_matrix,
        "costAnomalyDetection": anomaly,
        "guardian": {
            **guardian_runtime,
            "stateRecord": {
                "status": state.get("status"),
                "errorCount": len(state.get("errors") or []),
                "resumeErrorCount": len(state.get("resumeErrors") or []),
                "pausedAt": state.get("pausedAt"),
                "resumedAt": state.get("resumedAt"),
            },
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--status", action="store_true")
    mode.add_argument("--configure", action="store_true")
    mode.add_argument("--resume", action="store_true")
    parser.add_argument("--apply", action="store_true", help="allow resource changes")
    parser.add_argument("--read-profile", default=LOCAL_PROFILE)
    parser.add_argument(
        "--admin-profile",
        default=None,
        help=(
            f"Required for mutations and optional for complete read-only status "
            f"(must be {ADMIN_PROFILE})."
        ),
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help=f"allow resume while the current actual spend is still at/above ${BUDGET_LIMIT:g}",
    )
    args = parser.parse_args()
    mutating = bool(args.configure or args.resume)
    if mutating and not args.apply:
        parser.error("mutating cost-guardian modes require --apply")
    if mutating:
        if args.admin_profile != ADMIN_PROFILE:
            parser.error(f"mutating modes require --admin-profile {ADMIN_PROFILE}")
        profile, purpose = args.admin_profile, "admin"
    elif args.admin_profile:
        if args.admin_profile != ADMIN_PROFILE:
            parser.error(f"--admin-profile must be {ADMIN_PROFILE}")
        profile, purpose = args.admin_profile, "admin"
    else:
        if args.read_profile != LOCAL_PROFILE:
            parser.error(f"--read-profile must be {LOCAL_PROFILE}")
        profile, purpose = args.read_profile, "api"
    try:
        session = verified_session(profile, purpose=purpose, region=REGION)
    except AwsProfileContractError as error:
        parser.error(f"{error.error_code}: {error.detail}")
    api = clients(session)
    if args.status:
        print(json.dumps(status(api), indent=2, sort_keys=True, default=str))
        return 0
    if args.resume:
        current = describe_budget(api)
        try:
            actual = float(
                (current.get("CalculatedSpend") or {}).get("ActualSpend", {}).get("Amount")
                or 0
            )
        except (TypeError, ValueError):
            actual = 0
        if actual >= BUDGET_LIMIT and not args.force:
            parser.error(
                f"current actual spend is still at/above ${BUDGET_LIMIT:g}; use --force only after reviewing the bill"
            )
        print(json.dumps(_invoke(api, "resume"), indent=2, sort_keys=True))
        return 0
    if not args.configure:
        parser.error("a supported mode is required")
    try:
        _preflight_operations_email_routes(api)
        anomaly_subscriptions = _default_anomaly_subscriptions(api)
        _ensure_topic(api, GUARDIAN_TOPIC_NAME)
        _preflight_guardian_subscriptions(api, function_arn(GUARDIAN_NAME))
        _reconcile_topic_policy(
            api,
            guardian_topic_arn(),
            [_budget_publish_statement(guardian_topic_arn())],
        )
        _reconcile_topic_policy(
            api,
            operations_topic_arn(),
            (
                [
                    _anomaly_publish_statement(
                        operations_topic_arn(), anomaly_subscriptions
                    )
                ]
                if anomaly_subscriptions
                else []
            ),
        )
        role_arn = _ensure_role(api)
        guardian_arn = _ensure_lambda(api, role_arn)
        _ensure_guardian_subscription(api, guardian_arn)
        _configure_budget(api)
        _configure_anomaly_notifications(api, anomaly_subscriptions)
        migration = _migrate_operations_subscriptions(api, guardian_arn)
        result = status(api)
        result["migration"] = migration
        print(json.dumps(result, indent=2, sort_keys=True, default=str))
        return 0 if result["conforms"] else 3
    except NotificationCutoverBlocked as error:
        print(
            json.dumps(
                {"status": "blocked", "code": error.code, "detail": error.detail},
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
