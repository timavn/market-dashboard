"""The compact report must preserve evidence, zero values and withholding."""

import sys
import copy
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from review_runs_v2 import render_review


class CompactReviewTests(unittest.TestCase):
    def test_balance_preserves_zero_and_observation_without_duplicate_snapshot(self):
        sections = [
            {
                "id": "account-summary",
                "current": {
                    "accountId": "TEST",
                    "currency": "USD",
                    "observedAt": "2026-09-07T01:07:33.264000Z",
                    "margin": {
                        "netLiquidation": 0,
                        "availableFunds": 85173.30,
                        "buyingPower": 340693.21,
                        "excessLiquidity": 85204.10,
                    },
                    "exposure": {"netLiquidation": 99999},
                    "buffer": {"borrowedAmount": None, "liquidBuffer": None},
                },
            },
            {"id": "exceptions", "items": ["Independent marks unavailable."]},
        ]
        text = render_review("balance-review", sections, "partial", [])
        self.assertEqual(text.count("# Balance Review"), 1)
        self.assertEqual(text.count("$85,173.30"), 1)
        self.assertIn("**Net liquidation:** $0.00", text)
        self.assertIn("**Observed:** 2026-09-07T01:07:33.264000Z", text)
        self.assertIn("**Borrowing balance:** Unavailable", text)
        self.assertIn("**Liquidity buffer:** Unavailable", text)
        self.assertIn("- Independent marks unavailable.", text)
        self.assertNotIn("99999", text)

    def test_portfolio_retains_signed_exposure_pnl_and_citations(self):
        sections = [
            {
                "id": "executive-snapshot",
                "metrics": {"netExposure": -1234.56, "grossLeverage": 1.34},
                "pnlSummary": "Daily $-12.50 / Unrealized $100.00",
            },
            {
                "id": "conflicts-changes",
                "conflicts": [
                    {
                        "holding": "TEST",
                        "state": "conflict",
                        "conflict": "Research changed",
                        "processResponse": "Review exposure",
                        "citations": [{"id": "cite_123"}],
                    }
                ],
            },
        ]
        text = render_review("portfolio-review", sections, "partial", [])
        self.assertEqual(text.count("# Portfolio Review"), 1)
        self.assertIn("**Net exposure:** $-1,234.56", text)
        self.assertIn("**Gross leverage:** 1.340×", text)
        self.assertIn("**Daily P&L:** $-12.50", text)
        self.assertIn("**Unrealized P&L:** $100.00", text)
        self.assertIn("**Sources:** cite_123", text)
        self.assertIn("**Process action:** Review exposure", text)

    def test_prediction_holdings_marks_remain_internal_for_every_quote_state(self):
        for state in ["offline", "stale", "mock", "seed", "cache_only", "live", "settled", "resolver"]:
            with self.subTest(state=state):
                sections = [
                    {
                        "id": "held-event-contracts",
                        "positions": [
                            {
                                "contract": "TEST",
                                "markState": state,
                                "valuationPrice": 0.37,
                                "marketValue": 7777,
                            }
                        ],
                    }
                ]
                original = copy.deepcopy(sections)
                text = render_review(
                    "prediction-markets-review", sections, "partial", []
                )
                self.assertNotIn("**Mark:**", text)
                self.assertNotIn("**Value:**", text)
                self.assertNotIn("0.37", text)
                self.assertNotIn("7,777", text)
                self.assertNotIn("|---", text)
                self.assertEqual(sections, original)

    def test_process_limits_and_withholding_remain_internal(self):
        sections = [
            {
                "id": "process-recommendations",
                "analysis": {
                    "markets": [
                        {
                            "label": "Gold",
                            "status": "withheld",
                            "reasons": ["Fresh funding unavailable"],
                            "candidates": [
                                {
                                    "contractId": "TEST",
                                    "side": "YES",
                                    "nativePrice": 0.4,
                                    "sizing": {"allowed": False, "contracts": 50},
                                }
                            ],
                        }
                    ]
                },
            }
        ]
        original = copy.deepcopy(sections)
        text = render_review("prediction-markets-review", sections, "partial", [])
        self.assertNotIn("5% of verified NLV", text)
        self.assertNotIn("15% of verified NLV", text)
        self.assertNotIn("Fresh funding unavailable", text)
        self.assertNotIn("Sizing withheld.", text)
        self.assertNotIn("Maximum contracts", text)
        self.assertEqual(sections, original)


if __name__ == "__main__":
    unittest.main()
