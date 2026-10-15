"""On-demand refresh evidence stays bound to its own persisted review capture."""
from copy import deepcopy
from dataclasses import replace
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
import httpx

from test_portfolio_review_coordinator import analyst_app, coordinator_sources, verified_empty_portfolio, POSITION_COLUMNS
from portfolio_brief import build_portfolio_brief
from review_runs_v2 import ReviewCoordinatorV2, ReviewRunV2Store


class PortfolioRefreshIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="portfolio-refresh-test-")
        self.addCleanup(self.temp.cleanup)
        self.store = ReviewRunV2Store(Path(self.temp.name) / "review.sqlite3")
        self.owner = patch.object(analyst_app, "workspace_store", SimpleNamespace(dispatch=lambda *_: {"deleted": False}))
        self.owner.start()
        self.addCleanup(self.owner.stop)

    def book(self):
        value = verified_empty_portfolio()
        columns = [*POSITION_COLUMNS, "securityName", "secType"]
        position = {"account": "TEST", "symbol": "ABC", "contract": "ABC", "conId": 123,
                    "category": "stock", "secType": "STK", "securityName": "ABC Corporation",
                    "currency": "USD", "quantity": 1, "markState": "live", "marketValue": 10,
                    "valuationPrice": 10}
        value["data"]["positionTable"] = {"columns": columns, "rows": [[position.get(key) for key in columns]], "rowCount": 1}
        value["data"]["accountSummaries"][0]["summary"]["NetLiquidation"]["value"] = 100
        return value

    def archive(self):
        return {"schemaVersion": 1, "scanComplete": True, "scope": "available-source-archive",
                "marketDate": "2026-08-31", "requestedSymbols": ["ABC"],
                "manifest": {"documentCount": 3, "pages": 2, "earliestDate": "2026-01-02", "latestDate": "2026-08-31", "hash": "capture-a"},
                "coverage": {"products": [{"id": "etf-pro", "label": "ETF Pro", "status": "checked", "documentCount": 3,
                                             "earliestDate": "2026-01-02", "latestDate": "2026-08-31", "reasons": []}], "reasons": []},
                "bySymbol": {"ABC": {"references": [], "checkedProducts": ["etf-pro"]}}}

    async def capture(self, sources, request_id):
        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, sources=sources)
        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        run = await coordinator.start(review_kind="portfolio-review", conversation_id="portfolio-refresh-owner",
                                      session_id="portfolio-refresh-owner", request_id=request_id)
        await coordinator.tasks[run["runId"]]
        result = self.store.get(run["runId"])
        self.assertEqual(result["state"], "succeeded", result.get("errorMessage"))
        return result

    @staticmethod
    def report(run):
        return next(section for section in run["sections"] if section["id"] == "portfolio-refresh")["report"]

    async def test_archive_capture_covers_the_actual_book_and_saved_reports_keep_their_own_manifest(self):
        archive = self.archive()
        reader = AsyncMock(return_value=deepcopy(archive))
        sources = replace(coordinator_sources(), portfolio_context=AsyncMock(return_value=self.book()), refresh_research=reader)
        first = await self.capture(sources, "first")
        reader.assert_awaited_once_with(["ABC"], "2026-08-31", first["createdAt"])
        self.assertEqual(self.store.read_evidence(first, "portfolioRefreshResearch"), archive)
        captured = deepcopy(self.report(first))
        self.assertEqual(captured["templateVersion"], "portfolio-refresh-v1")
        self.assertEqual(len(captured["holdings"]), 1)
        reader.return_value = {**archive, "manifest": {**archive["manifest"], "hash": "capture-b", "documentCount": 4}}
        second = await self.capture(sources, "second")
        self.assertNotEqual(self.report(second)["archiveManifest"], captured["archiveManifest"])
        saved = self.store.get(first["runId"])
        self.assertEqual(self.report(saved), captured)
        with patch.object(analyst_app, "_portfolio_refresh_research", side_effect=AssertionError("Saved reports must not fetch providers")):
            brief = build_portfolio_brief(saved, analyst_app.portfolio_metrics(self.book()), {}, daily_research={})
        self.assertEqual(brief["refreshReport"], captured)
        self.assertEqual(brief["dailyRollup"]["sections"][:4], captured["sections"][:4])

    async def test_historical_book_cannot_authorize_current_actions_when_broker_refresh_failed(self):
        historical = {"verifiedAtCapture": True, "runId": "prior", "portfolio": self.book(), "balance": None}
        sources = replace(coordinator_sources(), portfolio_context=AsyncMock(return_value={"liveVerified": False, "freshness": "offline"}),
                          portfolio_reference=lambda: historical, refresh_research=AsyncMock(return_value=self.archive()))
        run = await self.capture(sources, "offline")
        report = self.report(run)
        self.assertFalse(report["available"])
        self.assertFalse(report["complete"])
        self.assertEqual(run["outcome"], "partial")

    async def test_archive_failure_retains_independent_review_evidence_without_a_complete_claim(self):
        sources = replace(coordinator_sources(), portfolio_context=AsyncMock(return_value=self.book()),
                          refresh_research=AsyncMock(side_effect=RuntimeError("Archive unavailable")))
        run = await self.capture(sources, "archive-failed")
        self.assertEqual(run["dependencies"]["portfolioRefreshResearch"]["status"], "failed")
        self.assertTrue(self.report(run)["available"])
        self.assertFalse(self.report(run)["complete"])
        self.assertEqual(run["outcome"], "partial")
        self.assertIsNotNone(self.store.read_evidence(run, "portfolio"))

    async def test_market_session_timeout_is_retryable_without_disabling_the_coordinator(self):
        sources = replace(coordinator_sources(), market_date=AsyncMock(side_effect=httpx.ReadTimeout("Session source timeout")))
        unexpected = []
        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, sources=sources)
        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler},
                                          unexpected_failure_hook=lambda *args: unexpected.append(args))
        started = await coordinator.start(review_kind="portfolio-review", conversation_id="portfolio-refresh-owner",
                                           session_id="portfolio-refresh-owner", request_id="clock-timeout")
        await coordinator.tasks[started["runId"]]
        failed = self.store.get(started["runId"])
        self.assertEqual(failed["errorCode"], "PORTFOLIO_MARKET_SESSION_UNAVAILABLE")
        self.assertTrue(failed["errorRetryable"])
        self.assertEqual(failed["dependencies"]["marketSession"]["status"], "failed")
        self.assertEqual(unexpected, [])
        sources.market_date.return_value = "2026-08-31"
        sources.market_date.side_effect = None
        recovered = await self.capture(sources, "clock-recovered")
        self.assertEqual(recovered["state"], "succeeded")


if __name__ == "__main__":
    unittest.main()
