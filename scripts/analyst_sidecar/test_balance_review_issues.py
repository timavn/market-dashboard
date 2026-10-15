"""Balance Review findings contain only evidenced issues and verification gaps."""

import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from test_portfolio_review_coordinator import (
    analyst_app,
    verified_balance_context,
    verified_empty_portfolio,
)
from review_runs_v2 import render_balance_review


class BalanceReviewIssueTests(unittest.IsolatedAsyncioTestCase):
    async def review(self, balance, portfolio=None):
        with patch.object(analyst_app, "_checkpoint_review_source", new=AsyncMock()):
            result = await analyst_app._balance_review_v2_handler(
                None,
                balance_reader=lambda: asyncio.sleep(0, result=balance),
                portfolio_reader=lambda: asyncio.sleep(
                    0, result=portfolio if portfolio is not None else verified_empty_portfolio()
                ),
            )
        findings = next(section for section in result["sections"] if section["id"] == "exceptions")["items"]
        report = render_balance_review(result["sections"], result["outcome"])
        return result, findings, report.split("## Exceptions & Data Status", 1)[1].strip()

    async def test_healthy_review_has_no_recaps_or_routine_settlement_interest_findings(self):
        balance = verified_balance_context()
        balance["data"]["current"]["settlement"]["state"] = "pending"
        result, findings, bottom = await self.review(balance)
        self.assertEqual(result["outcome"], "ready")
        self.assertEqual(findings, [])
        self.assertEqual(bottom, "No issues detected.")

    async def test_no_borrow_shortfall_is_a_single_issue_not_an_incomplete_review(self):
        balance = verified_balance_context()
        current = balance["data"]["current"]
        current["cash"]["trimRequired"] = 1766.48
        current["buffer"].update(addLongRoom=0, trimRequired=8926.90, totalReserve=7160.42)
        result, findings, bottom = await self.review(balance)
        self.assertEqual(result["outcome"], "ready")
        self.assertEqual(findings, [
            "Cash-floor shortfall: $1,766.48 under the no-borrow policy. No buffered capacity for additional longs."
        ])
        self.assertNotIn("7,160.42", bottom)
        self.assertNotIn("8,926.90", bottom)
        self.assertNotIn("Healthy", bottom)

    async def test_existing_policy_buffer_shortfall_and_broker_margin_deficit_are_visible(self):
        balance = verified_balance_context()
        current = balance["data"]["current"]
        current["buffer"].update(addLongRoom=0, trimRequired=250)
        current["margin"].update(health="maintenance_deficit", maintenanceDeficit=125)
        _result, findings, _bottom = await self.review(balance)
        self.assertEqual(findings, [
            "Maintenance margin deficit: $125.00.",
            "Policy buffer shortfall: $250.00; no buffered capacity for additional longs.",
        ])

    async def test_verified_interest_miss_uses_its_matching_date_and_range(self):
        balance = verified_balance_context()
        interest = balance["data"]["interestStatus"]
        interest["comparison"] = {
            "status": "verified", "outcome": "miss", "valueDate": "2026-09-17",
            "actual": 4.25, "forecastLower": 1, "forecastUpper": 3,
        }
        _result, findings, _bottom = await self.review(balance)
        self.assertEqual(findings, [
            "Interest discrepancy (2026-09-17): actual $4.25 was outside the $1.00–$3.00 forecast range."
        ])
        for state in ("awaiting", "unavailable", "stale"):
            with self.subTest(state=state):
                interest["comparison"]["status"] = state
                _result, findings, _bottom = await self.review(balance)
                self.assertEqual(findings, [])

    async def test_short_cost_gap_and_forecast_failure_do_not_claim_excessive_interest(self):
        balance = verified_balance_context()
        interest = balance["data"]["interestStatus"]
        interest["stockBorrowFees"]["status"] = "unavailable"
        interest["forecast"]["status"] = "unavailable"
        result, findings, _bottom = await self.review(balance)
        self.assertEqual(result["outcome"], "partial")
        self.assertEqual(findings, [
            "Interest forecast is unavailable.",
            "Stock-borrow costs for the short positions could not be verified.",
        ])

    async def test_failed_independent_crosscheck_preserves_balance_values_without_process_recap(self):
        result, findings, bottom = await self.review(
            verified_balance_context(), {"liveVerified": False, "status": "unavailable"}
        )
        self.assertEqual(result["outcome"], "partial")
        self.assertEqual(findings, ["Verified portfolio exposure cross-check was unavailable."])
        self.assertEqual(bottom, "- Verified portfolio exposure cross-check was unavailable.")
        self.assertEqual(result["sections"][0]["current"]["margin"]["netLiquidation"], 100000)

    async def test_unavailable_live_balances_do_not_generate_financial_findings(self):
        for state in ("offline", "stale", "cache_only", "seed", "mock"):
            with self.subTest(state=state):
                balance = verified_balance_context()
                balance["liveVerified"] = False
                balance["data"]["current"]["status"] = state
                balance["data"]["current"]["cash"]["trimRequired"] = 9876
                balance["data"]["current"]["margin"].update(health="initial_deficit", initialDeficit=321)
                result, findings, bottom = await self.review(balance)
                self.assertEqual(result["outcome"], "blocked")
                self.assertEqual(result["sections"][0]["current"], {})
                self.assertEqual(findings, ["Live IBKR balance is unavailable; current values are withheld."])
                self.assertNotIn("9,876", bottom)
                self.assertNotIn("321", bottom)

    async def test_unreconciled_capacity_and_unverified_margin_cannot_generate_deficit_findings(self):
        balance = verified_balance_context()
        current = balance["data"]["current"]
        current["capacity"].update(available=False, status="unavailable")
        current["cash"]["trimRequired"] = 9876
        current["margin"].update(available=False, status="unavailable", health="initial_deficit", initialDeficit=321)
        _result, findings, _bottom = await self.review(balance)
        self.assertEqual(findings, [
            "Broker margin data is unavailable.",
            "Cash and funding capacity could not be reconciled.",
        ])

    async def test_explicit_invalid_flags_override_a_conflicting_live_verified_claim(self):
        for level in ("envelope", "current"):
            for flag in ("stale", "cacheOnly", "cached", "fromCache", "from_cache", "mock", "seeded", "synthetic", "fallback", "inferred", "portfolioDerived"):
                with self.subTest(level=level, flag=flag):
                    balance = verified_balance_context()
                    flagged = balance if level == "envelope" else balance["data"]["current"]
                    flagged[flag] = True
                    balance["data"]["current"]["cash"]["trimRequired"] = 9876
                    result, findings, _bottom = await self.review(balance)
                    self.assertEqual(result["outcome"], "blocked")
                    self.assertEqual(result["sections"][0]["current"], {})
                    self.assertEqual(findings, ["Live IBKR balance is unavailable; current values are withheld."])

    async def test_dated_verified_interest_discrepancy_survives_a_live_balance_failure(self):
        balance = verified_balance_context()
        balance["liveVerified"] = False
        balance["data"]["interestStatus"]["comparison"] = {
            "status": "verified", "outcome": "miss", "valueDate": "2026-09-17",
            "actual": 4.25, "forecastLower": 1, "forecastUpper": 3,
        }
        result, findings, _bottom = await self.review(balance)
        self.assertEqual(result["outcome"], "blocked")
        self.assertEqual(findings, [
            "Interest discrepancy (2026-09-17): actual $4.25 was outside the $1.00–$3.00 forecast range.",
            "Live IBKR balance is unavailable; current values are withheld.",
        ])

    async def test_invalid_amounts_cannot_generate_financial_findings(self):
        for value in (True, "9876", float("inf"), float("nan")):
            with self.subTest(value=value):
                balance = verified_balance_context()
                balance["data"]["current"]["cash"]["trimRequired"] = value
                _result, findings, _bottom = await self.review(balance)
                self.assertEqual(findings, [])


if __name__ == "__main__":
    unittest.main()
