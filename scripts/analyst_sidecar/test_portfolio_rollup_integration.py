"""Prior-session accounting through the real persisted review coordinator."""
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from test_portfolio_review_coordinator import analyst_app, coordinator_sources, verified_empty_portfolio, POSITION_COLUMNS
from review_runs_v2 import ReviewCoordinatorV2, ReviewRunV2Store
from portfolio_capture import project_portfolio_context


class PortfolioRollupIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="portfolio-rollup-integration-")
        self.store = ReviewRunV2Store(Path(self.temp.name) / "reviews.sqlite3")
        self.deleted = set()
        self.workspace = patch.object(analyst_app, "workspace_store", SimpleNamespace(
            dispatch=lambda action, payload: {"deleted": payload["conversationId"] in self.deleted},
        ))
        self.workspace.start()
        self.addCleanup(self.workspace.stop)
        self.addCleanup(self.temp.cleanup)
        self.reference_time = datetime(2026, 10, 8, 21, 0, tzinfo=timezone.utc)

    def timestamp(self, days=0, seconds=0):
        return (self.reference_time + timedelta(days=days, seconds=seconds)).isoformat().replace("+00:00", "Z")

    def portfolio(self, value, *, account="ACCOUNT-A", days=0, seconds=0):
        portfolio = verified_empty_portfolio()
        portfolio["asOf"] = self.timestamp(days, seconds)
        row = {"account": account, "symbol": "ABC", "category": "other", "secType": "STK",
               "quantity": 10, "marketValue": value, "valuationPrice": value / 10,
               "markState": "live", "currency": "USD"}
        columns = [*POSITION_COLUMNS, "secType"]
        portfolio["data"]["positionTable"] = {"columns": columns, "rows": [[row.get(key) for key in columns]], "rowCount": 1}
        portfolio["data"]["accountSummaries"] = [{"account": account, "summary": {"NetLiquidation": {"value": 1000}}}]
        return portfolio

    async def run_review(self, conversation_id, value, *, account="ACCOUNT-A", days=0, seconds=0, balance=None):
        sources = replace(coordinator_sources(), portfolio_context=AsyncMock(
            return_value=self.portfolio(value, account=account, days=days, seconds=seconds)))
        if balance:
            sources = replace(sources, balance_context=AsyncMock(return_value=balance))

        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, sources=sources)

        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        # Each independent capture was persisted on its own observation day.
        # A later backfill with a claimed earlier source time is not equivalent.
        capture_clock = self.reference_time + timedelta(days=days, seconds=seconds + 1)
        with (patch("review_runs_v2.utc_now_iso", return_value=self.timestamp(days, seconds + 1)),
              patch("review_runs_v2.datetime", wraps=datetime) as store_clock,
              patch.object(analyst_app, "datetime", wraps=datetime) as handler_clock):
            store_clock.now.return_value = capture_clock
            handler_clock.now.return_value = capture_clock
            run = await coordinator.start(review_kind="portfolio-review", conversation_id=conversation_id,
                                          session_id=conversation_id or "", request_id=f"capture:{days}:{seconds}")
            await coordinator.tasks[run["runId"]]
        saved = self.store.get(run["runId"])
        self.assertEqual(saved["state"], "succeeded", saved.get("errorMessage"))
        return saved

    @staticmethod
    def comparison(run):
        return next(section for section in run["sections"] if section["id"] == "changes-since-prior")["comparison"]

    async def test_first_review_in_new_daily_conversation_compares_yesterdays_capture(self):
        previous = await self.run_review("portfolio-yesterday", 300, days=-1)
        current = await self.run_review("portfolio-today", 600)
        self.assertNotEqual(previous["conversationId"], current["conversationId"])
        comparison = self.comparison(current)
        self.assertEqual(comparison["status"], "available")
        self.assertEqual(comparison["baselineAsOf"], self.timestamp(-1))
        self.assertEqual(comparison["metrics"]["grossExposure"], {"previous": 300, "current": 600})
        self.assertEqual(comparison["metrics"]["grossLeverage"], {"previous": .3, "current": .6})
        self.assertEqual(comparison["baselineSessionDate"], "2026-10-07")
        self.assertEqual(comparison["baselineSessionCloseAt"], "2026-10-07T20:00:00Z")
        self.assertEqual(comparison["baselineSource"]["runId"], previous["runId"])
        risk = next(section for section in current["sections"] if section["id"] == "exposure-risk")
        self.assertEqual(risk["factorExposure"]["rows"], [{"label": "Stocks & ETFs", "longPct": 60,
                                                          "shortPct": 0, "netPct": 60}])

    def test_close_capture_stays_a_holdings_reference_after_the_review_shell_is_deleted(self):
        deleted = analyst_app._portfolio_reference_conversation_deleted
        with patch.object(analyst_app.workspace_store, "dispatch", return_value={"deleted": True}) as dispatch:
            self.assertFalse(deleted("review:portfolio-review"))
            dispatch.assert_not_called()
            self.assertTrue(deleted("deleted-chat"))

    async def test_headless_close_capture_is_the_next_sessions_baseline_including_friday_for_monday(self):
        # Hermes's 4:30 PM ET capture has no conversation (the review shell id).
        thursday = await self.run_review(None, 300)
        self.assertEqual(thursday["conversationId"], "review:portfolio-review")
        friday = await self.run_review(None, 450, days=1)
        friday_review = await self.run_review("friday-chat", 500, days=1, seconds=-3600 * 6)
        self.assertEqual(self.comparison(friday_review)["baselineSource"]["runId"], thursday["runId"])
        monday = await self.run_review("monday-chat", 600, days=4, seconds=-3600 * 5)
        comparison = self.comparison(monday)
        self.assertEqual(comparison["status"], "available")
        self.assertEqual(comparison["baselineSessionDate"], "2026-10-09")
        self.assertEqual(comparison["baselineSource"]["runId"], friday["runId"])
        self.assertEqual(comparison["metrics"]["grossExposure"], {"previous": 450, "current": 600})

    async def test_deleted_or_archived_chat_does_not_discard_verified_closing_accounting(self):
        await self.run_review("older-day", 100, days=-4)
        await self.run_review("other-account", 200, account="ACCOUNT-B", days=-1, seconds=-1800)
        deleted = await self.run_review("deleted-prior", 300, days=-1)
        self.deleted.add("deleted-prior")
        await self.run_review("archived-prior", 400, days=-1, seconds=1800)
        self.store.archive_conversation("archived-prior")
        current = await self.run_review("new-day", 500)
        comparison = self.comparison(current)
        self.assertEqual(comparison["status"], "available")
        self.assertEqual(comparison["baselineAsOf"], self.timestamp(-1))
        self.assertEqual(comparison["metrics"]["grossExposure"]["previous"], 300)
        self.assertEqual(comparison["baselineSource"]["runId"], deleted["runId"])
        self.assertIn("deleted-prior", self.deleted)
        self.assertFalse(self.store.has_conversation("archived-prior"))

    async def test_prior_capture_completed_after_review_cutoff_is_not_comparable(self):
        await self.run_review("older-day", 100, days=-2)
        overlapping = await self.run_review("completed-later", 200, days=-1)
        with self.store.connect() as connection:
            connection.execute("UPDATE analyst_review_runs_v2 SET completed_at=? WHERE run_id=?",
                               (self.timestamp(1), overlapping["runId"]))
        current = await self.run_review("current-review", 300)
        comparison = self.comparison(current)
        self.assertEqual(comparison["status"], "unavailable")
        self.assertEqual(comparison["metrics"], {})

    async def test_comparison_unavailable_when_all_prior_captures_are_other_accounts(self):
        await self.run_review("prior-other-book", 200, account="ACCOUNT-B", days=-1)
        current = await self.run_review("current-book", 400)
        comparison = self.comparison(current)
        self.assertEqual(comparison["status"], "unavailable")
        self.assertEqual(comparison["metrics"], {})
        self.assertIsNone(comparison["baselineAsOf"])
        self.assertEqual(comparison["baselineSessionDate"], "2026-10-07")

    async def test_same_day_and_prior_intraday_reviews_do_not_replace_the_close(self):
        await self.run_review("intraday-yesterday", 100, days=-1, seconds=-7200)
        closing = await self.run_review("closing-yesterday", 300, days=-1)
        await self.run_review("later-evening", 500, days=-1, seconds=7200)
        await self.run_review("same-day", 900, seconds=-3600)
        current = await self.run_review("current", 600)
        self.assertEqual(self.comparison(current)["metrics"]["grossExposure"]["previous"], 300)
        self.assertEqual(self.comparison(current)["baselineSource"]["runId"], closing["runId"])

    async def test_saved_legacy_comparison_reprojects_only_original_immutable_account_evidence(self):
        previous = await self.run_review("close", 300, days=-1)
        current = await self.run_review("current", 600)
        with self.store.connect() as connection:
            row = connection.execute("SELECT sections_json, report_markdown FROM analyst_review_runs_v2 WHERE run_id=?", (current["runId"],)).fetchone()
        sections = json.loads(row[0])
        next(section for section in sections if section["id"] == "changes-since-prior")["comparison"] = {"status": "unavailable", "metrics": {}, "baselineAsOf": None}
        with self.store.connect() as connection:
            connection.execute("UPDATE analyst_review_runs_v2 SET sections_json=? WHERE run_id=?", (json.dumps(sections), current["runId"]))
        self.deleted.add("close")
        reread = self.store.get(current["runId"])
        self.assertEqual(self.comparison(reread)["metrics"]["grossExposure"], {"previous": 300, "current": 600})
        self.assertEqual(self.comparison(reread)["baselineSource"]["runId"], previous["runId"])
        with self.store.connect() as connection:
            raw = connection.execute("SELECT sections_json, report_markdown FROM analyst_review_runs_v2 WHERE run_id=?", (current["runId"],)).fetchone()
        self.assertEqual(raw[0], json.dumps(sections))
        self.assertEqual(raw[1], row[1])

    async def test_later_backfilled_evidence_cannot_populate_an_earlier_saved_review(self):
        previous = await self.run_review("close", 300, days=-1)
        current = await self.run_review("current", 600)
        with self.store.connect() as connection:
            connection.execute("UPDATE analyst_review_evidence_v2 SET created_at=? WHERE fingerprint=?", (self.timestamp(1), previous["dependencies"]["portfolio"]["fingerprint"]))
        reread = self.store.get(current["runId"])
        self.assertEqual(self.comparison(reread)["status"], "unavailable")
        self.assertEqual(self.comparison(reread)["metrics"], {})

    async def test_saved_baseline_survives_more_than_500_later_unrelated_reviews(self):
        previous = await self.run_review("close", 300, days=-1)
        current = await self.run_review("current", 600)
        with self.store.connect() as connection:
            columns = [row[1] for row in connection.execute("PRAGMA table_info(analyst_review_runs_v2)")]
            template = dict(connection.execute("SELECT * FROM analyst_review_runs_v2 WHERE run_id=?", (current["runId"],)).fetchone())
            later = [{**template, "run_id": f"future-{i}", "session_id": f"future-{i}", "request_id": f"future-{i}", "review_kind": "prediction-markets-review",
                      "created_at": self.timestamp(1), "updated_at": self.timestamp(1), "completed_at": self.timestamp(1)} for i in range(501)]
            connection.executemany(f"INSERT INTO analyst_review_runs_v2 ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})",
                                   [[row[key] for key in columns] for row in later])
        self.assertEqual(self.comparison(self.store.get(current["runId"]))["baselineSource"]["runId"], previous["runId"])
        # Legacy saved reports with no explicit source binding share the same
        # exact-session historical query and must retain the repair too.
        sections = template["sections_json"]
        legacy = json.loads(sections)
        next(section for section in legacy if section["id"] == "changes-since-prior")["comparison"] = {"status": "unavailable", "metrics": {}}
        with self.store.connect() as connection:
            connection.execute("UPDATE analyst_review_runs_v2 SET sections_json=? WHERE run_id=?", (json.dumps(legacy), current["runId"]))
        self.assertEqual(self.comparison(self.store.get(current["runId"]))["baselineSource"]["runId"], previous["runId"])

    async def test_warm_saved_brief_invalidates_comparison_when_prior_hash_is_rejected(self):
        previous = await self.run_review("close", 300, days=-1)
        current = await self.run_review("current", 600)
        first_identity, first = self.store.get_compact_portfolio_brief(current["runId"], project_portfolio_context)
        self.assertEqual(first["comparison"]["metrics"]["grossExposure"], {"previous": 300, "current": 600})
        with self.store.connect() as connection:
            connection.execute("UPDATE analyst_review_evidence_v2 SET payload_json='{}' WHERE fingerprint=?", (previous["dependencies"]["portfolio"]["fingerprint"],))
        after_identity, after = self.store.get_compact_portfolio_brief(current["runId"], project_portfolio_context)
        self.assertNotEqual(first_identity["reportRevision"], after_identity["reportRevision"])
        self.assertEqual(after["comparison"]["status"], "unavailable")
        self.assertEqual(after["comparison"]["metrics"], {})

    def balance(self, gross, net, *, days=0):
        at = self.timestamp(days, 0.5)
        return {"status": "partial", "liveVerified": True, "freshness": "live_with_dated_verified_history", "asOf": at,
                "data": {"current": {"available": True, "status": "live", "source": "ibkr_live_session", "fromCache": False,
                "accountId": "ACCOUNT-A", "currency": "USD", "observedAt": at, "socketVerifiedAt": at,
                "accountValuesObservedAt": at, "freshness": {"status": "fresh"},
                "exposure": {"available": True, "status": "live", "source": "ibkr_live_session", "currency": "USD",
                             "netLiquidation": 1000, "longMarketValue": (gross + net) / 2,
                             "shortMarketValue": (gross - net) / 2, "grossMarketValue": gross, "netMarketValue": net}}}}

    async def test_complete_broker_account_exposure_does_not_need_to_equal_sum_of_quote_marks(self):
        await self.run_review("close", 20, days=-1, balance=self.balance(1100, 100, days=-1))
        current = await self.run_review("current", 40, balance=self.balance(1200, 200))
        comparison = self.comparison(current)
        self.assertEqual(comparison["status"], "available")
        self.assertEqual(comparison["baselineAsOf"], self.timestamp(-1, .5))
        self.assertEqual(comparison["metrics"]["grossExposure"], {"previous": 1100, "current": 1200})
        self.assertEqual(comparison["metrics"]["netExposure"], {"previous": 100, "current": 200})
        _, brief = self.store.get_compact_portfolio_brief(current["runId"], project_portfolio_context)
        self.assertEqual(brief["comparison"]["metrics"], comparison["metrics"])

    async def test_account_exposure_is_captured_independently_of_partial_position_quotes(self):
        book = self.portfolio(10)
        book["data"]["positionTable"]["rows"][0][POSITION_COLUMNS.index("markState")] = "unavailable"
        at = book["asOf"]
        balance = {"status": "partial", "liveVerified": True,
                   "freshness": "live_with_dated_verified_history", "asOf": at,
                   "data": {"current": {
                       "available": True, "status": "live", "source": "ibkr_live_session",
                       "fromCache": False, "accountId": "ACCOUNT-A", "currency": "USD",
                       "observedAt": at, "socketVerifiedAt": at, "accountValuesObservedAt": at,
                       "freshness": {"status": "fresh"},
                       "exposure": {"available": True, "status": "live", "source": "ibkr_live_session",
                                    "currency": "USD", "netLiquidation": 1000,
                                    "longMarketValue": 600, "shortMarketValue": 500,
                                    "grossMarketValue": 1100, "netMarketValue": 100}}}}
        sources = replace(coordinator_sources(), portfolio_context=AsyncMock(return_value=book),
                          balance_context=AsyncMock(return_value=balance))

        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, sources=sources)

        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        run = await coordinator.start(review_kind="portfolio-review", conversation_id="account-exposure",
                                      session_id="account-exposure", request_id="capture")
        await coordinator.tasks[run["runId"]]
        saved = self.store.get(run["runId"])
        self.assertEqual(saved["state"], "succeeded", saved.get("errorMessage"))
        self.assertEqual(self.store.read_evidence(saved, "portfolioBalance"), balance)
        metrics = next(section for section in saved["sections"] if section["id"] == "exposure-risk")["metrics"]
        self.assertEqual(metrics["grossExposure"], 1100)
        self.assertEqual(metrics["shortMarketValue"], -500)
        self.assertEqual(metrics["netExposure"], 100)
        self.assertFalse(metrics["valuationComplete"])
        self.assertTrue(metrics["exposureComplete"])
        self.assertEqual(self.store.read_evidence(saved, "portfolio"), book)


if __name__ == "__main__":
    unittest.main()
