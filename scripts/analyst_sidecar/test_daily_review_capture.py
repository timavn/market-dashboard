"""A Daily Review run through the real persisted coordinator, with injected sources."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock

from test_portfolio_review_coordinator import analyst_app, verified_empty_portfolio, POSITION_COLUMNS
from analyst_review_sources import review_sources
from daily_review import BLOCK
from review_runs_v2 import ReviewCoordinatorV2, ReviewRunV2Store, public_review_run

AS_OF = "2026-11-20T21:10:00Z"
DAY = "2026-11-20"
COLUMNS = [*POSITION_COLUMNS, *(name for name in ("secType", "securityName") if name not in POSITION_COLUMNS)]


def portfolio(*, pnl=None):
    value = verified_empty_portfolio()
    value["asOf"] = AS_OF
    rows = [{"account": "U1", "symbol": "AAA", "contract": "AAA", "conId": 1, "category": "other", "secType": "STK",
             "quantity": 150, "valuationPrice": 55.0, "marketValue": 8250.0, "markState": "live", "currency": "USD"},
            {"account": "U1", "symbol": "BBB", "contract": "BBB", "conId": 2, "category": "other", "secType": "STK",
             "quantity": -100, "valuationPrice": 18.0, "marketValue": -1800.0, "markState": "live", "currency": "USD"}]
    value["data"]["positionTable"] = {"columns": COLUMNS, "rows": [[row.get(key) for key in COLUMNS] for row in rows], "rowCount": 2}
    value["data"]["accounts"] = ["U1"]
    value["data"]["accountSummaries"] = [{"account": "U1", "summary": {"NetLiquidation": {"value": 100_000}, "TotalCashValue": 93_550.0}}]
    value["data"]["pnl"] = [{"account": "U1", "observedAt": AS_OF, "pnl": pnl}] if pnl else []
    return value


def executions(*rows, **changes):
    return {"ok": True, "status": "live", "liveVerified": True, "complete": True, "from_cache": False,
            "source": "ibkr_executions", "asOf": AS_OF, "executions": list(rows), **changes}


def quote(symbol, price, previous):
    return {"symbol": symbol, "price": str(price), "previousClose": str(previous), "observedAt": "2026-11-20T21:00:00Z", "source": "yahoo"}


def sources(**changes):
    values = dict(
        portfolio_context=AsyncMock(return_value=portfolio(pnl={"dailyPnL": 1_000.0, "realizedPnL": 250.0, "unrealizedPnL": 2_000.0})),
        project_portfolio_context=analyst_app.project_portfolio_context,
        session_closes=AsyncMock(return_value=[{"ok": True, "marks": [
            {"conId": 1, "referenceClose": 50.0, "referenceCloseSessionDate": "2026-11-19"},
            {"conId": 2, "referenceClose": 18.5, "referenceCloseSessionDate": DAY,
             "previousClose": 20.0, "previousCloseSessionDate": "2026-11-19"}]}]),
        executions=AsyncMock(return_value=executions(
            {"execId": "e1", "conId": 1, "symbol": "AAA", "secType": "STK", "side": "BOT", "shares": 50, "price": 52.0,
             "executionTime": "2026-11-20T15:00:00Z", "commission": 1.0, "realizedPNL": 0.0},
            {"execId": "e2", "conId": 3, "symbol": "CCC", "secType": "STK", "side": "SLD", "shares": 100, "price": 31.0,
             "executionTime": "2026-11-20T16:00:00Z", "commission": 1.0, "realizedPNL": 250.0})),
        market_quotes=AsyncMock(return_value={"us": [quote("SPX", 6600, 6500)], "sectors": [quote("XLK", 101, 100)],
                                              "meta": {"observedAt": AS_OF}}),
        daily_history=AsyncMock(side_effect=lambda symbol, _start: {"status": "available", "provider": "yfinance", "asOf": AS_OF, "data": {"results": [
            {"date": "2026-11-19", "close": {"SPY": 650, "CCC": 30}.get(symbol, 100)}, {"date": DAY, "close": {"SPY": 660, "CCC": 31}.get(symbol, 101)}]}}),
        volatility=AsyncMock(return_value={"generatedAt": AS_OF, "VIX": {"lastPx": 20.0, "dayChangePct": -5.0, "marketSessionDate": DAY}}),
        sizing_context=AsyncMock(return_value={"bySymbol": {"AAA": {"beta": {"value": 1.2}}, "BBB": {"beta": {"value": 0.8}}}}),
        prediction_board=AsyncMock(return_value={"asOf": AS_OF, "sourceStatus": {"kalshiPositions": "ready"}, "kalshiBook": {
            "asOf": AS_OF, "account": 10_000, "cash": 9_400, "atRisk": 600, "atRiskPct": 6.0, "maxPayout": 1_500, "value": 650,
            "pnl": 50, "realized": 20, "openLines": 1, "events": 1, "unvalued": 0, "flags": [],
            "positions": [{"market": "Gold", "sectionLabel": "Metals", "side": "NO", "direction": "SHORT", "lines": [{}],
                           "cost": 600, "pct": 6.0, "value": 650, "pnl": 50, "maxPayout": 1_500,
                           "closeTime": "2026-11-27T22:00:00Z", "state": "HOLD", "tone": "none"}]}}),
        kalshi_activity=AsyncMock(return_value={"ok": True, "since": "2026-11-20T05:00:00Z", "asOf": AS_OF,
                                                "fills": {"count": 0, "bought": 0, "sold": 0, "fees": 0, "rows": []},
                                                "settlements": {"count": 0, "cost": 0, "revenue": 0, "fees": 0, "pnl": 0, "rows": []}}),
        session=lambda _as_of: {"marketDate": DAY, "phase": "post-market"},
    )
    values.update(changes)
    return analyst_app.DailyReviewSources(**values)


class DailyReviewCaptureTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="daily-review-capture-")
        self.store = ReviewRunV2Store(Path(self.temp.name) / "reviews.sqlite3")
        self.addCleanup(self.temp.cleanup)

    async def run_review(self, review_sources_value):
        async def handler(context):
            return await analyst_app._daily_review_v2_handler(context, sources=review_sources_value)

        coordinator = ReviewCoordinatorV2(self.store, {"daily-review": handler})
        self.requests = getattr(self, "requests", 0) + 1
        chat = f"daily-chat-{self.requests}"
        run = await coordinator.start(review_kind="daily-review", conversation_id=chat, session_id=chat,
                                      request_id=f"daily-request-{self.requests}")
        await coordinator.tasks[run["runId"]]
        return self.store.get(run["runId"])

    @staticmethod
    def sheet(run):
        return next(section for section in run["sections"] if section["id"] == "daily-review")["sheet"]

    async def test_a_full_capture_produces_the_sheet_and_its_report_block(self):
        run = await self.run_review(sources())
        self.assertEqual(run["state"], "succeeded", run.get("errorMessage"))
        sheet = self.sheet(run)
        self.assertEqual((sheet["marketDate"], sheet["session"]), (DAY, "post-market"))
        self.assertEqual((sheet["headline"]["dayPnl"], sheet["headline"]["basis"]), (1_000.0, "ibkr-account"))
        # AAA: 100 carried 50->55 plus 50 bought at 52; BBB short: 20->18; CCC sold at 31 against a 30 close.
        pnl = sheet["pnl"]
        self.assertAlmostEqual(pnl["positionPnl"], 500.0 + 200.0 + 100.0)
        self.assertAlmostEqual(pnl["tradingPnl"], 150.0)
        self.assertAlmostEqual(pnl["attributed"], 950.0)
        self.assertAlmostEqual(pnl["unattributed"], 50.0)
        self.assertAlmostEqual(pnl["shortPnl"], 200.0)
        self.assertEqual([row["symbol"] for row in pnl["contributors"]], ["AAA", "BBB", "CCC"])
        self.assertEqual(pnl["alphaBeta"]["status"], "available")
        self.assertEqual({row["symbol"]: row["action"] for row in sheet["trading"]["rows"]}, {"AAA": "Add", "CCC": "Exit"})
        self.assertEqual(sheet["trading"]["fillCount"], 2)
        self.assertEqual(sheet["exposure"]["rows"][0]["value"], 10_050.0)
        self.assertEqual(sheet["liquidity"]["cash"], 93_550.0)
        self.assertEqual(sheet["market"]["benchmark"]["symbol"], "SPY")
        self.assertEqual(sheet["prediction"]["openLines"], 1)
        # The first session has no earlier close capture; that gap is named, not filled.
        self.assertEqual(run["outcome"], "partial")
        self.assertTrue(any("previous close" in note for note in sheet["notes"]))
        report = public_review_run(run)["reportMarkdown"]
        block = report.split(f"```{BLOCK}\n", 1)[1].split("\n```", 1)[0]
        self.assertEqual(json.loads(block)["pnl"]["attributed"], sheet["pnl"]["attributed"])

    async def test_sources_rows_follow_the_captured_checkpoints(self):
        run = await self.run_review(sources(kalshi_activity=AsyncMock(side_effect=RuntimeError("down"))))
        items = {item["id"]: item["status"] for item in review_sources(run, self.store)["items"]}
        self.assertEqual(items["portfolio"], "ready")
        self.assertEqual(items["portfolioExecutions"], "ready")
        self.assertEqual(items["portfolioSessionCloses"], "ready")
        self.assertEqual(items["marketPrices"], "ready")
        self.assertEqual(items["predictionBoard"], "ready")
        self.assertEqual(items["kalshiActivity"], "unavailable")
        self.assertNotIn("today", self.sheet(run)["prediction"])

    async def test_unverified_fills_and_missing_closes_leave_gaps_not_guesses(self):
        run = await self.run_review(sources(
            executions=AsyncMock(return_value=executions(complete=False)),
            session_closes=AsyncMock(return_value=[RuntimeError("gateway")]),
            portfolio_context=AsyncMock(return_value=portfolio())))
        self.assertEqual(run["state"], "succeeded", run.get("errorMessage"))
        sheet = self.sheet(run)
        self.assertEqual(sheet["trading"]["status"], "unavailable")
        self.assertIsNone(sheet["headline"]["dayPnl"])
        self.assertIsNone(sheet["pnl"]["attributed"])
        self.assertEqual(sheet["pnl"]["unpriced"], ["AAA", "BBB"])
        self.assertIn("prior closes were unavailable", sheet["notes"][0])

    async def test_a_weekend_run_does_not_treat_the_current_fill_list_as_the_last_session(self):
        run = await self.run_review(sources(session=lambda _as_of: {"marketDate": DAY, "phase": "closed"}))
        sheet = self.sheet(run)
        self.assertEqual((sheet["session"], sheet["trading"]["status"], sheet["pnl"]["attributionBasis"]),
                         ("closed", "unavailable", "held-all-day"))

    async def test_an_unverified_book_or_a_failed_connection_ends_the_run(self):
        unverified = portfolio()
        unverified["liveVerified"] = False
        run = await self.run_review(sources(portfolio_context=AsyncMock(return_value=unverified)))
        self.assertEqual((run["state"], run["errorCode"]), ("failed", "LIVE_PORTFOLIO_UNAVAILABLE"))
        offline = AsyncMock(return_value={"status": "unavailable", "liveVerified": False, "errorCode": "GATEWAY_UNAVAILABLE",
                                          "data": {"connected": False}})
        portfolio_reader = AsyncMock(return_value=portfolio())
        run = await self.run_review(sources(broker_readiness=offline, portfolio_context=portfolio_reader))
        self.assertEqual(run["state"], "failed")
        self.assertIn("Daily Review", run["errorMessage"])
        portfolio_reader.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
