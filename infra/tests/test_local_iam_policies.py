import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MANIFEST = json.loads((ROOT / "ops" / "services.json").read_text(encoding="utf-8"))


def load_policy(name):
    return json.loads((ROOT / "infra" / "iam" / name).read_text(encoding="utf-8"))


def actions(statement):
    value = statement.get("Action", [])
    return {value} if isinstance(value, str) else set(value)


class LocalIamPolicyContractTests(unittest.TestCase):
    def test_bridge_principal_is_write_only_to_the_snapshot_table(self):
        policy = load_policy("local-bridge-policy.json")
        statements = policy["Statement"]

        self.assertEqual(len(statements), 1)
        self.assertEqual(actions(statements[0]), {"dynamodb:PutItem"})
        self.assertEqual(
            {resource.rsplit("/", 1)[-1] for resource in statements[0]["Resource"]},
            {"HermesInputSnapshots", "MarketDashboardServiceHeartbeats"},
        )

    def test_api_policy_has_only_the_required_readiness_research_and_catalog_actions(self):
        policy = load_policy("local-readiness-catalog-policy.json")
        statements = {statement["Sid"]: statement for statement in policy["Statement"]}

        self.assertEqual(
            set(statements),
            {
                "ReadOwnedServiceHeartbeats",
                "ReconcilePredictionCatalogV2",
                "ReadCanonicalResearchEvents",
                "ReadPortfolioResearchIntelligence",
                "ReadExpectedRiskRangePublication",
                "ReadLambdaDiagnostics",
            },
        )
        permitted = {
            "dynamodb:GetItem",
            "dynamodb:BatchGetItem",
            "dynamodb:Query",
            "dynamodb:TransactWriteItems",
            "cloudwatch:GetMetricStatistics",
        }
        observed = set().union(*(actions(statement) for statement in statements.values()))
        self.assertEqual(observed, permitted)
        self.assertNotIn("dynamodb:Scan", observed)
        self.assertNotIn("dynamodb:PutItem", observed)

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


if __name__ == "__main__":
    unittest.main()
