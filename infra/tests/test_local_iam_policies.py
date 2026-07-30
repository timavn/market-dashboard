import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MANIFEST = json.loads((ROOT / "ops" / "services.json").read_text(encoding="utf-8"))
VALIDATOR_PATH = (
    ROOT / "infra" / "scripts" / "validate_local_iam_policy.py"
)
VALIDATOR_SPEC = importlib.util.spec_from_file_location(
    "validate_local_iam_policy",
    VALIDATOR_PATH,
)
assert VALIDATOR_SPEC and VALIDATOR_SPEC.loader
validator = importlib.util.module_from_spec(VALIDATOR_SPEC)
VALIDATOR_SPEC.loader.exec_module(validator)


def load_policy(name):
    return json.loads((ROOT / "infra" / "iam" / name).read_text(encoding="utf-8"))


def actions(statement):
    value = statement.get("Action", [])
    return {value} if isinstance(value, str) else set(value)


def as_list(value):
    return value if isinstance(value, list) else [value]


def policy_allows_put_item(policy, *, table, leading_key):
    for statement in policy.get("Statement", []):
        if "dynamodb:PutItem" not in actions(statement):
            continue
        resources = as_list(statement.get("Resource", []))
        if not any(resource.endswith(f"table/{table}") for resource in resources):
            continue
        condition = statement.get("Condition", {})
        allowed_keys = as_list(
            condition.get("ForAllValues:StringEquals", {}).get(
                "dynamodb:LeadingKeys",
                [],
            )
        )
        requires_key = (
            condition.get("Null", {}).get("dynamodb:LeadingKeys") == "false"
        )
        if requires_key and leading_key in allowed_keys:
            return True
    return False


class LocalIamPolicyContractTests(unittest.TestCase):
    def validate_document(self, document):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "policy.json"
            path.write_text(json.dumps(document), encoding="utf-8")
            validator.validate_policy(
                path,
                account="915328198276",
                region="us-west-1",
            )

    def test_bridge_principal_is_write_only_to_the_snapshot_table(self):
        policy = load_policy("local-bridge-policy.json")
        statements = {
            statement["Sid"]: statement for statement in policy["Statement"]
        }

        self.assertEqual(
            set(statements),
            {
                "PublishOwnedBridgeSnapshots",
                "PublishOwnedBridgeHeartbeat",
            },
        )
        self.assertTrue(
            all(actions(statement) == {"dynamodb:PutItem"} for statement in statements.values())
        )
        self.assertEqual(
            {
                statement["Resource"].rsplit("/", 1)[-1]
                for statement in statements.values()
            },
            {"HermesInputSnapshots", "MarketDashboardServiceHeartbeats"},
        )
        self.assertEqual(
            statements["PublishOwnedBridgeSnapshots"]["Condition"],
            {
                "ForAllValues:StringEquals": {
                    "dynamodb:LeadingKeys": [
                        "tim-market-dashboard#operations",
                        "tim-market-dashboard#portfolio",
                    ],
                },
                "Null": {"dynamodb:LeadingKeys": "false"},
            },
        )
        self.assertEqual(
            statements["PublishOwnedBridgeHeartbeat"]["Condition"],
            {
                "ForAllValues:StringEquals": {
                    "dynamodb:LeadingKeys": ["bridge:local-dashboard"],
                },
                "Null": {"dynamodb:LeadingKeys": "false"},
            },
        )

        for key in (
            "tim-market-dashboard#operations",
            "tim-market-dashboard#portfolio",
        ):
            self.assertTrue(
                policy_allows_put_item(
                    policy,
                    table="HermesInputSnapshots",
                    leading_key=key,
                )
            )
        for key in (
            "foreign-host#operations",
            "tim-market-dashboard#security",
            "tim-market-dashboard",
        ):
            self.assertFalse(
                policy_allows_put_item(
                    policy,
                    table="HermesInputSnapshots",
                    leading_key=key,
                )
            )

        self.assertTrue(
            policy_allows_put_item(
                policy,
                table="MarketDashboardServiceHeartbeats",
                leading_key="bridge:local-dashboard",
            )
        )
        for key in (
            "gmail:timsmithaviation@gmail.com",
            "hermes:quant-developer",
            "bridge:foreign-host",
        ):
            self.assertFalse(
                policy_allows_put_item(
                    policy,
                    table="MarketDashboardServiceHeartbeats",
                    leading_key=key,
                )
            )
        validator.validate_policy(
            ROOT / "infra" / "iam" / "local-bridge-policy.json",
            account="915328198276",
            region="us-west-1",
        )

    def test_api_policy_has_only_the_required_readiness_research_and_catalog_actions(self):
        policy = load_policy("local-readiness-catalog-policy.json")
        statements = {statement["Sid"]: statement for statement in policy["Statement"]}

        self.assertEqual(
            set(statements),
            {
                "ReadOwnedServiceHeartbeats",
                "ReadPredictionCatalogV2",
                "ReconcilePredictionCatalogV2",
                "ReadCanonicalResearchEvents",
                "ReadRtaRebuildSources",
                "WriteRtaMaterializations",
                "ReadRtaLegacyArtifacts",
                "ReadPortfolioResearchIntelligence",
                "ReadExpectedRiskRangePublication",
                "ReadLambdaDiagnostics",
            },
        )
        permitted = {
            "dynamodb:GetItem",
            "dynamodb:BatchGetItem",
            "dynamodb:Query",
            "dynamodb:Scan",
            "dynamodb:PutItem",
            "dynamodb:DeleteItem",
            "s3:GetObject",
            "s3:GetObjectVersion",
            "cloudwatch:GetMetricStatistics",
        }
        observed = set().union(*(actions(statement) for statement in statements.values()))
        self.assertEqual(observed, permitted)
        self.assertEqual(
            statements["ReconcilePredictionCatalogV2"]["Condition"],
            {
                "ForAnyValue:StringEquals": {
                    "dynamodb:EnclosingOperation": "TransactWriteItems",
                },
            },
        )
        self.assertEqual(
            statements["ReadRtaRebuildSources"]["Resource"],
            [
                "arn:aws:dynamodb:us-west-1:915328198276:"
                "table/HermesEmailIngestLedger",
                "arn:aws:dynamodb:us-west-1:915328198276:"
                "table/HedgeyeDailySnapshot",
            ],
        )
        self.assertEqual(
            statements["WriteRtaMaterializations"]["Resource"],
            "arn:aws:dynamodb:us-west-1:915328198276:"
            "table/HedgeyeDailySnapshot",
        )
        self.assertEqual(
            statements["ReadRtaLegacyArtifacts"]["Resource"],
            "arn:aws:s3:::market-dashboard-csv-data/"
            "hedgeye-email/messages/*",
        )

        research_resource = statements["ReadCanonicalResearchEvents"]["Resource"]
        self.assertTrue(
            research_resource.endswith(
                f'table/{MANIFEST["aws"]["resources"]["researchEventLedgerTable"]}'
            )
        )
        intelligence_resources = statements["ReadPortfolioResearchIntelligence"]["Resource"]
        self.assertEqual(
            {
                resource.split(":table/", 1)[-1]
                for resource in intelligence_resources
            },
            {
                MANIFEST["aws"]["resources"]["hedgeyeDailySnapshotTable"],
                MANIFEST["aws"]["resources"]["researchEntityEventsTable"],
                (
                    f'{MANIFEST["aws"]["resources"]["researchEntityEventsTable"]}'
                    '/index/marketDate-index'
                ),
                MANIFEST["aws"]["resources"]["researchProductManifestTable"],
            },
        )
        risk_resources = statements["ReadExpectedRiskRangePublication"]["Resource"]
        self.assertEqual(
            {resource.rsplit("/", 1)[-1] for resource in risk_resources},
            {
                MANIFEST["aws"]["resources"]["riskRangeManifestTable"],
                MANIFEST["aws"]["resources"]["riskRangeDataTable"],
            },
        )
        validator.validate_policy(
            ROOT / "infra" / "iam" / "local-readiness-catalog-policy.json",
            account="915328198276",
            region="us-west-1",
        )

    def test_policy_validator_allows_only_the_one_cloudwatch_wildcard(self):
        self.validate_document(
            {
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Effect": "Allow",
                        "Action": "cloudwatch:GetMetricStatistics",
                        "Resource": "*",
                    }
                ],
            }
        )
        for action in ("iam:*", "s3:GetObject", "dynamodb:Scan"):
            with self.subTest(action=action):
                with self.assertRaises(validator.PolicyValidationError):
                    self.validate_document(
                        {
                            "Version": "2012-10-17",
                            "Statement": [
                                {
                                    "Effect": "Allow",
                                    "Action": action,
                                    "Resource": "*",
                                }
                            ],
                        }
                    )

    def test_policy_validator_pins_the_only_global_s3_prefix_and_actions(self):
        exact_resource = (
            "arn:aws:s3:::market-dashboard-csv-data/"
            "hedgeye-email/messages/*"
        )
        self.validate_document(
            {
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Effect": "Allow",
                        "Action": [
                            "s3:GetObject",
                            "s3:GetObjectVersion",
                        ],
                        "Resource": exact_resource,
                    }
                ],
            }
        )
        for action, resource in (
            ("s3:PutObject", exact_resource),
            ("s3:GetObject", "arn:aws:s3:::another-bucket/*"),
        ):
            with self.subTest(action=action, resource=resource):
                with self.assertRaises(validator.PolicyValidationError):
                    self.validate_document(
                        {
                            "Version": "2012-10-17",
                            "Statement": [
                                {
                                    "Effect": "Allow",
                                    "Action": action,
                                    "Resource": resource,
                                }
                            ],
                        }
                    )


if __name__ == "__main__":
    unittest.main()
