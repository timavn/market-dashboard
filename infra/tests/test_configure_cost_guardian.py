#!/usr/bin/env python3
"""Contract tests for the cost-only AWS notification reconciler."""

from __future__ import annotations

import json
import os
import sys
import unittest
from copy import deepcopy
from pathlib import Path


os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "infra" / "scripts"))

import configure_cost_guardian as configure  # noqa: E402


class FakeNotFound(Exception):
    pass


class FakeBudgetExceptions:
    NotFoundException = FakeNotFound


class FakeBudgets:
    exceptions = FakeBudgetExceptions()

    def __init__(self, entries=None, *, missing=False):
        self.missing = missing
        self.budget = {
            "BudgetName": configure.BUDGET_NAME,
            "BudgetLimit": {"Amount": "30", "Unit": "USD"},
            "BudgetType": "COST",
            "TimeUnit": "MONTHLY",
            "CostTypes": {"IncludeTax": True},
        }
        self.entries = deepcopy(entries or [])
        self.calls = []

    def describe_budget(self, **kwargs):
        if self.missing:
            raise FakeNotFound()
        return {"Budget": deepcopy(self.budget)}

    def update_budget(self, **kwargs):
        self.calls.append(("update_budget", deepcopy(kwargs)))
        self.budget.update(deepcopy(kwargs["NewBudget"]))

    def create_budget(self, **kwargs):
        self.calls.append(("create_budget", deepcopy(kwargs)))
        self.missing = False
        self.budget = deepcopy(kwargs["Budget"])
        self.entries = [
            {
                "notification": deepcopy(item["Notification"]),
                "subscribers": deepcopy(item["Subscribers"]),
            }
            for item in kwargs["NotificationsWithSubscribers"]
        ]

    def describe_notifications_for_budget(self, **kwargs):
        return {"Notifications": [deepcopy(item["notification"]) for item in self.entries]}

    def describe_subscribers_for_notification(self, **kwargs):
        key = configure._notification_key(kwargs["Notification"])
        for item in self.entries:
            if configure._notification_key(item["notification"]) == key:
                return {"Subscribers": deepcopy(item["subscribers"])}
        raise AssertionError(f"notification not found: {key}")

    def delete_notification(self, **kwargs):
        self.calls.append(("delete_notification", deepcopy(kwargs)))
        key = configure._notification_key(kwargs["Notification"])
        self.entries = [
            item
            for item in self.entries
            if configure._notification_key(item["notification"]) != key
        ]

    def create_notification(self, **kwargs):
        self.calls.append(("create_notification", deepcopy(kwargs)))
        self.entries.append(
            {
                "notification": deepcopy(kwargs["Notification"]),
                "subscribers": deepcopy(kwargs["Subscribers"]),
            }
        )

    def delete_subscriber(self, **kwargs):
        self.calls.append(("delete_subscriber", deepcopy(kwargs)))
        key = configure._notification_key(kwargs["Notification"])
        subscriber_key = configure._subscriber_key(kwargs["Subscriber"])
        for item in self.entries:
            if configure._notification_key(item["notification"]) == key:
                item["subscribers"] = [
                    subscriber
                    for subscriber in item["subscribers"]
                    if configure._subscriber_key(subscriber) != subscriber_key
                ]

    def create_subscriber(self, **kwargs):
        self.calls.append(("create_subscriber", deepcopy(kwargs)))
        key = configure._notification_key(kwargs["Notification"])
        for item in self.entries:
            if configure._notification_key(item["notification"]) == key:
                item["subscribers"].append(deepcopy(kwargs["Subscriber"]))


class FakeSnsExceptions:
    NotFoundException = FakeNotFound


class FakeSns:
    exceptions = FakeSnsExceptions()

    def __init__(self, subscriptions):
        self.subscriptions = subscriptions
        self.unsubscribed = []

    def list_subscriptions_by_topic(self, **kwargs):
        return {"Subscriptions": deepcopy(self.subscriptions.get(kwargs["TopicArn"], []))}

    def unsubscribe(self, **kwargs):
        self.unsubscribed.append(kwargs["SubscriptionArn"])


class FakeCe:
    def __init__(self):
        self.calls = []

    def update_anomaly_subscription(self, **kwargs):
        self.calls.append(deepcopy(kwargs))


def notification(threshold, *, kind="ACTUAL"):
    return {
        "NotificationType": kind,
        "ComparisonOperator": "GREATER_THAN",
        "Threshold": float(threshold),
        "ThresholdType": "ABSOLUTE_VALUE",
    }


class ConfigureCostGuardianTests(unittest.TestCase):
    def test_budget_subscriber_matrix_and_reconciliation_are_exact_and_idempotent(self):
        email = {"SubscriptionType": "EMAIL", "Address": configure.EMAIL}
        entries = [
            {
                "notification": notification(10),
                "subscribers": [
                    email,
                    {"SubscriptionType": "SNS", "Address": configure.operations_topic_arn()},
                ],
            },
            {
                "notification": notification(18),
                "subscribers": [
                    email,
                    {"SubscriptionType": "EMAIL", "Address": "unexpected@example.com"},
                ],
            },
            {"notification": notification(20), "subscribers": [email]},
            {
                "notification": notification(15, kind="FORECASTED"),
                "subscribers": [email],
            },
        ]
        budgets = FakeBudgets(entries)
        api = {"budgets": budgets}

        configure._configure_budget(api)
        first_mutations = [name for name, _ in budgets.calls if name != "update_budget"]
        self.assertEqual(
            sorted(first_mutations),
            ["create_subscriber", "delete_notification", "delete_subscriber", "delete_subscriber"],
        )
        status = configure._budget_status(api, budgets.budget)
        self.assertTrue(status["conforms"])
        self.assertEqual(
            [
                (row["threshold"], [route["type"] for route in row["routes"]])
                for row in status["notifications"]
            ],
            [(10.0, ["EMAIL"]), (18.0, ["EMAIL"]), (20.0, ["EMAIL", "SNS"])],
        )

        configure._configure_budget(api)
        second_mutations = [name for name, _ in budgets.calls if name != "update_budget"]
        self.assertEqual(second_mutations, first_mutations)

    def test_missing_budget_is_created_with_exact_matrix(self):
        budgets = FakeBudgets(missing=True)
        configure._configure_budget({"budgets": budgets})
        create_calls = [kwargs for name, kwargs in budgets.calls if name == "create_budget"]
        self.assertEqual(len(create_calls), 1)
        self.assertTrue(configure._budget_status({"budgets": budgets}, budgets.budget)["conforms"])

    def test_operations_migration_removes_owned_email_and_legacy_guardian_only(self):
        operations_arn = configure.operations_topic_arn()
        guardian_arn = configure.function_arn(configure.GUARDIAN_NAME)
        sns = FakeSns(
            {
                operations_arn: [
                    {
                        "Protocol": "email",
                        "Endpoint": configure.EMAIL,
                        "SubscriptionArn": "email-confirmed",
                    },
                    {
                        "Protocol": "email-json",
                        "Endpoint": configure.EMAIL,
                        "SubscriptionArn": "PendingConfirmation",
                    },
                    {
                        "Protocol": "lambda",
                        "Endpoint": guardian_arn,
                        "SubscriptionArn": "legacy-lambda",
                    },
                    {
                        "Protocol": "sqs",
                        "Endpoint": "internal-queue",
                        "SubscriptionArn": "internal-sqs",
                    },
                ]
            }
        )
        result = configure._migrate_operations_subscriptions({"sns": sns}, guardian_arn)
        self.assertEqual(sns.unsubscribed, ["email-confirmed", "legacy-lambda"])
        self.assertEqual(
            result,
            {
                "removedEmailSubscriptions": 1,
                "removedLegacyGuardianSubscriptions": 1,
                "pendingEmailSubscriptions": 1,
            },
        )

    def test_unexpected_operations_email_blocks_without_deleting_anything(self):
        sns = FakeSns(
            {
                configure.operations_topic_arn(): [
                    {
                        "Protocol": "email",
                        "Endpoint": "someone-else@example.com",
                        "SubscriptionArn": "unexpected-email",
                    }
                ]
            }
        )
        with self.assertRaises(configure.NotificationCutoverBlocked) as raised:
            configure._migrate_operations_subscriptions(
                {"sns": sns}, configure.function_arn(configure.GUARDIAN_NAME)
            )
        self.assertEqual(raised.exception.code, "OPERATIONS_TOPIC_UNEXPECTED_EMAIL_ENDPOINT")
        self.assertEqual(sns.unsubscribed, [])

    def test_anomaly_route_preserves_threshold_expression_and_uses_no_email(self):
        ce = FakeCe()
        threshold = {
            "Dimensions": {"Key": "ANOMALY_TOTAL_IMPACT_ABSOLUTE", "Values": ["5"]}
        }
        configure._configure_anomaly_notifications(
            {"ce": ce},
            [
                {
                    "SubscriptionArn": "anomaly-arn",
                    "SubscriptionName": "Default-Services-Subscription",
                    "Frequency": "DAILY",
                    "ThresholdExpression": threshold,
                    "Subscribers": [{"Type": "EMAIL", "Address": configure.EMAIL}],
                }
            ],
        )
        self.assertEqual(
            ce.calls,
            [
                {
                    "SubscriptionArn": "anomaly-arn",
                    "Frequency": "IMMEDIATE",
                    "Subscribers": [
                        {"Address": configure.operations_topic_arn(), "Type": "SNS"}
                    ],
                }
            ],
        )
        self.assertNotIn("ThresholdExpression", ce.calls[0])

    def test_sanitized_topic_status_never_returns_an_email_address(self):
        arn = configure.operations_topic_arn()
        sns = FakeSns(
            {
                arn: [
                    {
                        "Protocol": "email",
                        "Endpoint": configure.EMAIL,
                        "SubscriptionArn": "confirmed",
                    }
                ]
            }
        )
        result = configure._topic_status({"sns": sns}, arn)
        self.assertNotIn(configure.EMAIL, json.dumps(result))
        self.assertEqual(result["routes"][0]["target"], "configured-alert-email")


if __name__ == "__main__":
    unittest.main()
