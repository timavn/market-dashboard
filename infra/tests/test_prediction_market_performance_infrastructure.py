import json
import pathlib
import unittest

import yaml


ROOT = pathlib.Path(__file__).resolve().parents[2]
TEMPLATE_PATH = ROOT / "infra" / "prediction-market-performance-ledger.yaml"
POLICY_PATH = ROOT / "infra" / "iam" / "local-prediction-performance-ledger-policy.json"


class PredictionMarketPerformanceInfrastructureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template = yaml.safe_load(TEMPLATE_PATH.read_text(encoding="utf-8"))

    def test_dedicated_stack_owns_one_retained_protected_table(self):
        self.assertEqual(set(self.template["Resources"]), {"PredictionMarketPerformanceLedger"})
        table = self.template["Resources"]["PredictionMarketPerformanceLedger"]
        self.assertEqual(table["Type"], "AWS::DynamoDB::Table")
        self.assertEqual(table["DeletionPolicy"], "Retain")
        self.assertEqual(table["UpdateReplacePolicy"], "Retain")
        properties = table["Properties"]
        self.assertEqual(properties["TableName"], "PredictionMarketPerformanceLedger")
        self.assertEqual(properties["BillingMode"], "PAY_PER_REQUEST")
        self.assertTrue(properties["DeletionProtectionEnabled"])
        self.assertTrue(properties["PointInTimeRecoverySpecification"]["PointInTimeRecoveryEnabled"])
        self.assertTrue(properties["SSESpecification"]["SSEEnabled"])
        self.assertEqual(
            properties["TimeToLiveSpecification"],
            {"AttributeName": "ttl", "Enabled": True},
        )

    def test_account_and_record_keys_are_exactly_scoped(self):
        properties = self.template["Resources"]["PredictionMarketPerformanceLedger"]["Properties"]
        self.assertEqual(
            properties["AttributeDefinitions"],
            [
                {"AttributeName": "accountId", "AttributeType": "S"},
                {"AttributeName": "recordKey", "AttributeType": "S"},
            ],
        )
        self.assertEqual(
            properties["KeySchema"],
            [
                {"AttributeName": "accountId", "KeyType": "HASH"},
                {"AttributeName": "recordKey", "KeyType": "RANGE"},
            ],
        )

    def test_local_runtime_policy_is_limited_to_the_ledger(self):
        policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
        self.assertEqual(policy["Version"], "2012-10-17")
        self.assertEqual(len(policy["Statement"]), 1)
        statement = policy["Statement"][0]
        self.assertEqual(statement["Sid"], "UsePredictionPerformanceLedger")
        self.assertEqual(statement["Effect"], "Allow")
        self.assertEqual(
            set(statement["Action"]),
            {
                "dynamodb:GetItem",
                "dynamodb:PutItem",
                "dynamodb:Query",
                "dynamodb:UpdateItem",
                "dynamodb:TransactWriteItems",
            },
        )
        self.assertEqual(
            statement["Resource"],
            "arn:aws:dynamodb:us-west-1:915328198276:"
            "table/PredictionMarketPerformanceLedger",
        )


if __name__ == "__main__":
    unittest.main()
