import asyncio
import copy
from datetime import datetime, timezone
import time
import unittest
from unittest.mock import patch

import market
from market import IbkrReader
from portfolio_capture import project_portfolio_context
from portfolio_review import portfolio_metrics


NOW = datetime(2026, 10, 7, 2, 0, tzinfo=timezone.utc)
OBSERVED = "2026-10-07T02:00:00Z"


def positions_payload():
    return {
        "ok": True, "connected": True, "status": "live", "source": "ibkr_live_session",
        "from_cache": False, "accounts": ["U1", "U2"], "positions_observed_at": OBSERVED,
        "socket_verified_at": OBSERVED,
        "positions": [
            {"account": "U1", "symbol": "AAA", "localSymbol": "AAA", "conId": 1,
             "secType": "STK", "exchange": "SMART", "currency": "USD", "position": 2,
             "avgCost": 100, "marketValue": 200, "price": 100, "pnl": 5},
            {"account": "U2", "symbol": "BBB", "localSymbol": "BBB", "conId": 2,
             "secType": "STK", "exchange": "SMART", "currency": "USD", "position": -3,
             "avgCost": 90, "marketValue": -270, "price": 90, "pnl": 5},
        ],
    }


class PortfolioHoldingsProgressTests(unittest.IsolatedAsyncioTestCase):
    async def test_verified_same_book_publishes_before_blocked_mark_audit_without_values(self):
        raw = positions_payload()
        original = copy.deepcopy(raw)
        callback_entered = asyncio.Event()
        callback_release = asyncio.Event()
        audit_entered = asyncio.Event()
        audit_release = asyncio.Event()
        calls = []
        captured = []

        async def request(path, **_kwargs):
            calls.append(path)
            if path == "/status":
                return {"connected": True, "status": "connected", "accounts": ["U1", "U2"]}
            if path == "/portfolio/live-positions":
                return raw
            if path == "/quotes":
                audit_entered.set()
                await audit_release.wait()
                return {"quotes": []}
            if path.startswith("/portfolio/live-account-summary"):
                return {"ok": True, "source": "ibkr_live_session", "observed_at": OBSERVED,
                        "summary": {"NetLiquidation": 1000, "currency": "USD"}}
            if path.startswith("/portfolio/pnl"):
                return {"ok": True, "source": "ibkr_live_session", "observed_at": OBSERVED, "pnl": {}}
            raise AssertionError(path)

        async def on_holdings(value):
            captured.append(copy.deepcopy(value))
            # Consumer mutation must never rewrite the ongoing audit's book.
            value["data"]["accounts"].append("foreign")
            value["data"]["positions"][0]["quantity"] = 999
            callback_entered.set()
            await callback_release.wait()

        task = asyncio.create_task(IbkrReader(request=request, now=lambda: NOW).portfolio_context(on_holdings=on_holdings))
        self.addAsyncCleanup(self._finish_task, task, callback_release, audit_release)
        await asyncio.wait_for(callback_entered.wait(), 1)
        # The live-positions read is the first and only gate; no /status precheck.
        self.assertEqual(calls, ["/portfolio/live-positions"])
        self.assertFalse(task.done())
        book = captured[0]
        self.assertEqual(book["asOf"], OBSERVED)
        self.assertEqual(book["data"]["accounts"], ["U1", "U2"])
        self.assertEqual([(row["account"], row["conId"], row["quantity"]) for row in book["data"]["positions"]],
                         [("U1", 1, 2), ("U2", 2, -3)])
        for row in book["data"]["positions"]:
            self.assertTrue(set(row).isdisjoint({"price", "valuationPrice", "marketValue", "avgCost", "averageCost", "costBasis", "pnl"}))
        self.assertNotIn("accountSummaries", book["data"])
        metrics = portfolio_metrics(project_portfolio_context(book))
        self.assertTrue(metrics["available"])
        self.assertFalse(metrics["exposureComplete"])
        self.assertFalse(metrics["valuationComplete"])
        self.assertIsNone(metrics["grossExposure"])
        self.assertIsNone(metrics["netExposurePctOfNlv"])
        callback_release.set()
        await asyncio.wait_for(audit_entered.wait(), 1)
        self.assertFalse(task.done())
        audit_release.set()
        result = await asyncio.wait_for(task, 1)
        self.assertEqual(raw, original)
        self.assertEqual(calls.count("/portfolio/live-positions"), 1)
        self.assertEqual(result["data"]["accounts"], ["U1", "U2"])
        self.assertEqual([(row["account"], row["quantity"]) for row in result["data"]["positions"]], [("U1", 2), ("U2", -3)])
        self.assertEqual(len(captured), 1)

    async def test_unanswered_marks_settle_inside_the_valuation_budget_and_keep_the_verified_book(self):
        # A closed session sends no ticks: every broker snapshot waits out its
        # window. The book must settle on the valuation budget, not the review's.
        raw = positions_payload()
        raw["positions"].append({
            "account": "U1", "symbol": "ES", "localSymbol": "FES_082426_7675_YES", "conId": 3,
            "secType": "FOP", "exchange": None, "currency": "USD", "lastTradeDateOrContractMonth": "20260824",
            "strike": 7675, "right": "C", "multiplier": "1", "tradingClass": "FES", "position": 10, "avgCost": 0.5,
        })
        never = asyncio.Event()
        calls = []
        published = []

        async def request(path, **kwargs):
            calls.append(path)
            if path == "/portfolio/live-positions":
                return raw
            if path == "/quotes":
                await never.wait()
            if path.startswith("/portfolio/live-account-summary"):
                return {"ok": True, "source": "ibkr_live_session", "observed_at": OBSERVED,
                        "summary": {"NetLiquidation": 1000, "currency": "USD"}}
            if path.startswith("/portfolio/pnl"):
                return {"ok": True, "source": "ibkr_live_session", "observed_at": OBSERVED, "pnl": {}}
            raise AssertionError(path)

        async def settlement(_path, **_kwargs):
            await never.wait()

        async def on_holdings(value):
            published.append(value)

        reader = IbkrReader(request=request, settlement_request=settlement, now=lambda: NOW)
        started = time.monotonic()
        with patch.object(market, "PORTFOLIO_VALUATION_BUDGET_SECONDS", 0.2):
            result = await asyncio.wait_for(reader.portfolio_context(on_holdings=on_holdings), 2)
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertEqual(len(published), 1)
        self.assertEqual((result["liveVerified"], result["freshness"], result["status"]), (True, "live", "partial"))
        rows = {row["conId"]: row for row in result["data"]["positions"]}
        self.assertEqual(set(rows), {1, 2, 3})
        for con_id in (1, 2):
            # Unanswered marks are withheld, never filled from position fields.
            self.assertIsNone(rows[con_id]["currentPrice"])
            self.assertIsNone(rows[con_id]["marketValue"])
            self.assertEqual(rows[con_id]["valuationStatus"], "unavailable")
            self.assertEqual(rows[con_id]["markUnavailableReason"], "valuation_budget_exhausted")
        self.assertEqual(rows[3]["valuationStatus"], "awaiting_official_settlement")
        # No retry pass starts once the budget cannot cover a snapshot window.
        self.assertEqual(calls.count("/quotes"), 1)
        self.assertEqual(sorted(path.split("?")[0] for path in calls if "account=" in path),
                         ["/portfolio/live-account-summary", "/portfolio/live-account-summary",
                          "/portfolio/pnl", "/portfolio/pnl"])
        self.assertEqual(len(result["data"]["pnl"]), 2)
        self.assertEqual(result["data"]["quoteCoverage"]["missingMarkCount"], 2)
        self.assertTrue(any("valuation budget" in warning and "AAA" in warning for warning in result["warnings"]))
        self.assertFalse(any("Gateway" in warning for warning in result["warnings"]))
        metrics = portfolio_metrics(project_portfolio_context(result))
        self.assertTrue(metrics["available"])
        self.assertIsNone(metrics["grossExposure"])

    @staticmethod
    async def _finish_task(task, *releases):
        for event in releases:
            event.set()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    async def test_disconnected_stale_cached_seeded_incomplete_or_foreign_book_never_calls_back(self):
        changes = [
            {"from_cache": True}, {"cached": True}, {"cachedOnly": True}, {"stale": True},
            {"seeded": True}, {"mock": True}, {"inferred": True}, {"fallback": True},
            {"metadata": {"cached": True}}, {"status": "offline"}, {"connected": False},
            {"positions_observed_at": "2026-10-07T01:58:00Z"}, {"accounts": []},
            {"positions": [{**positions_payload()["positions"][0], "account": "foreign"}]},
            {"positions": [{**positions_payload()["positions"][0], "position": None}]},
            {"positions": [{**positions_payload()["positions"][0], "from_cache": True}]},
        ]
        for change in changes:
            with self.subTest(change=change):
                callbacks = []

                async def callback(value):
                    callbacks.append(value)

                async def request(path, **_kwargs):
                    if path == "/status":
                        return {"connected": True, "status": "connected", "accounts": ["U1", "U2"]}
                    if path == "/portfolio/live-positions":
                        return {**positions_payload(), **change}
                    if path == "/quotes":
                        return {"quotes": []}
                    return {"ok": True, "source": "ibkr_live_session", "observed_at": OBSERVED, "summary": {}, "pnl": {}}

                await IbkrReader(request=request, now=lambda: NOW).portfolio_context(on_holdings=callback)
                self.assertEqual(callbacks, [])

        paths = []

        async def disconnected(path, **_kwargs):
            paths.append(path)
            return {"ok": False, "connected": False, "status": "gateway_not_authenticated",
                    "error_code": "IBKR_GATEWAY_NOT_AUTHENTICATED", "source": "unavailable", "positions": []}

        callbacks = []

        async def callback(value):
            callbacks.append(value)

        result = await IbkrReader(request=disconnected, now=lambda: NOW).portfolio_context(on_holdings=callback)
        self.assertEqual(callbacks, [])
        self.assertEqual(paths, ["/portfolio/live-positions"])
        self.assertEqual(result["errorCode"], "IBKR_HOLDINGS_UNVERIFIED")

    async def test_cancelled_publication_stops_before_quote_or_secondary_work(self):
        calls = []

        async def request(path, **_kwargs):
            calls.append(path)
            if path == "/status":
                return {"connected": True, "status": "connected", "accounts": ["U1", "U2"]}
            self.assertEqual(path, "/portfolio/live-positions")
            return positions_payload()

        async def cancelled(_value):
            raise asyncio.CancelledError()

        with self.assertRaises(asyncio.CancelledError):
            await IbkrReader(request=request, now=lambda: NOW).portfolio_context(on_holdings=cancelled)
        self.assertEqual(calls, ["/portfolio/live-positions"])


if __name__ == "__main__":
    unittest.main()
