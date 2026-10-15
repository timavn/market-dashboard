import asyncio
import json
from dataclasses import replace
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

import httpx

from test_analyst_sidecar import analyst_app
from review_runs_v2 import ReviewCoordinatorV2, ReviewExecutionContext, ReviewRunV2Store, ReviewRunError, public_review_run
from test_portfolio_review_coordinator import coordinator_sources, verified_balance_context, verified_empty_portfolio, POSITION_COLUMNS

# The PCA model read is paused by default. These tests pin its behavior when re-enabled.
PCA_ENABLED = {"ANALYST_PORTFOLIO_PCA_ENABLED": "true"}


class ReviewLatencyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = ReviewRunV2Store(Path(self.temp.name) / "reviews.sqlite3")

    async def wait_for_report(self, run_id):
        async def ready():
            while not self.store.get_status(run_id)["reportAvailable"]:
                await asyncio.sleep(0.005)
            return self.store.get(run_id)
        return await asyncio.wait_for(ready(), 1)

    def broker_context(self, request_id):
        prior_id = getattr(self, "broker_run_id", None)
        if prior_id and self.store.get_status(prior_id)["state"] in {"queued", "running"}:
            self.store.update(prior_id, state="cancelled", phase="terminal", outcome="blocked")
        run, _ = self.store.create(review_kind="portfolio-review", request_id=request_id, conversation_id=request_id)
        self.broker_run_id = run["runId"]
        return ReviewExecutionContext(self.store, run["runId"], "portfolio-review")

    def daily_publication(self):
        day = "2026-08-31"
        return {"date": day, "snapshots": {"top-3-things": {
            "snapshotType": "top-3-things", "date": day, "publishedAt": f"{day}T12:00:00Z",
            "article": {"feedUrl": "https://app.hedgeye.com/feed_items/daily-recovery"},
            "data": {"items": [{"title": "Daily recovery", "body": "Exact recovered publication remains complete."}]},
        }}}

    async def test_balance_transient_delivery_retries_fresh_and_preserves_exact_partial(self):
        context = self.broker_context("balance-fresh-recovery")
        cutoff = self.store.get_status(context.run_id)["createdAt"]
        accepted = verified_balance_context()
        accepted["status"] = "partial"
        accepted["data"]["history"] = None
        first = analyst_app.BalanceContextReader._unavailable("BALANCE_HTTP_ERROR", http_status=503)
        reader = AsyncMock(side_effect=[first, asyncio.TimeoutError(), accepted])
        with patch.object(analyst_app, "BALANCE_REVIEW_RETRY_DELAY_SECONDS", 0):
            result = await analyst_app._read_retrying_balance_review_source(context, reader)
        self.assertIs(result, accepted)
        self.assertEqual(reader.await_count, 3)
        run = self.store.get(context.run_id)
        dependency = run["dependencies"]["portfolioBalance"]
        self.assertEqual(dependency["status"], "partial")
        self.assertEqual(dependency["detail"]["attemptCount"], 3)
        self.assertEqual([attempt["outcome"] for attempt in dependency["detail"]["acquisition"]["attempts"]],
                         ["unavailable", "timeout", "partial"])
        self.assertEqual(dependency["detail"]["acquisition"]["attempts"][0]["httpStatus"], 503)
        self.assertEqual(dependency["asOf"], accepted["asOf"])
        self.assertEqual(run["createdAt"], cutoff)
        self.assertEqual(self.store.read_evidence(run, "portfolioBalance"), accepted)
        # A verified partial must also return unchanged on its first attempt.
        reader = AsyncMock(return_value=accepted)
        context = self.broker_context("balance-partial-first")
        self.assertIs(await analyst_app._read_retrying_balance_review_source(context, reader), accepted)
        reader.assert_awaited_once()

    async def test_balance_retry_whitelists_delivery_failures_and_stops_at_three(self):
        failures = [
            analyst_app.BalanceContextReader._unavailable("BALANCE_HTTP_ERROR", http_status=status)
            for status in (408, 429, 500, 503, 504)
        ] + [analyst_app.BalanceContextReader._unavailable(code) for code in (
            "BALANCE_REQUEST_TIMEOUT", "BALANCE_SERVICE_UNAVAILABLE", "IBKR_BALANCE_REQUEST_TIMEOUT",
        )] + [httpx.ReadError("private-account 123456.78"), asyncio.TimeoutError()]
        for index, failure in enumerate(failures):
            with self.subTest(index=index):
                context = self.broker_context("balance-delivery-" + str(index))
                final = analyst_app.BalanceContextReader._unavailable("BALANCE_REQUEST_TIMEOUT")
                reader = AsyncMock(side_effect=[failure, final, final, verified_balance_context()])
                with patch.object(analyst_app, "BALANCE_REVIEW_RETRY_DELAY_SECONDS", 0):
                    result = await analyst_app._read_retrying_balance_review_source(context, reader)
                self.assertIs(result, final)
                self.assertEqual(reader.await_count, 3)
                run = self.store.get(context.run_id)
                self.assertEqual(run["dependencies"]["portfolioBalance"]["status"], "failed")
                self.assertEqual(self.store.read_evidence(run, "portfolioBalance"), final)
                self.assertNotIn("private-account", json.dumps(run))
                self.assertNotIn("123456.78", json.dumps(run))

    async def test_balance_account_auth_verification_and_flagged_responses_never_retry(self):
        values = [analyst_app.BalanceContextReader._unavailable("BALANCE_HTTP_ERROR", http_status=status)
                  for status in (400, 401, 403, 404)]
        values += [analyst_app.BalanceContextReader._unavailable(code, http_status=503) for code in (
            "ACCOUNT_NOT_MANAGED", "ACCOUNT_UPDATE_ACCOUNT_MISMATCH", "BALANCE_VERIFICATION_FAILED",
            "BALANCE_SNAPSHOT_CHANGED", "BALANCE_SNAPSHOT_FAILED", "BALANCE_UNAVAILABLE",
        )]
        for flag in ("cached", "cacheOnly", "fromCache", "stale", "fallback", "mock", "seeded",
                     "inferred", "synthetic", "portfolioDerived"):
            values.append({**analyst_app.BalanceContextReader._unavailable("BALANCE_HTTP_ERROR", http_status=503), flag: True})
        rejected_current = analyst_app.BalanceContextReader._unavailable("BALANCE_HTTP_ERROR", http_status=503)
        rejected_current["data"]["current"] = {"available": False, "fromCache": True}
        values += [rejected_current, {"status": "unavailable", "errorCode": "BALANCE_HTTP_ERROR"}]
        for index, value in enumerate(values):
            with self.subTest(index=index):
                context = self.broker_context("balance-permanent-" + str(index))
                reader = AsyncMock(side_effect=[value, verified_balance_context()])
                self.assertIs(await analyst_app._read_retrying_balance_review_source(context, reader), value)
                reader.assert_awaited_once()

    async def test_balance_retries_do_not_block_the_current_book_primary(self):
        release = asyncio.Event()
        retry_started = asyncio.Event()
        defaults = coordinator_sources()
        accepted = verified_balance_context()
        calls = 0

        async def balance():
            nonlocal calls
            calls += 1
            if calls < 3:
                return analyst_app.BalanceContextReader._unavailable("BALANCE_HTTP_ERROR", http_status=503)
            retry_started.set()
            await release.wait()
            return accepted

        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, replace(defaults, balance_context=balance))

        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        with patch.object(analyst_app, "BALANCE_REVIEW_RETRY_DELAY_SECONDS", 0):
            run = await coordinator.start(review_kind="portfolio-review", request_id="balance-independent-retry")
            task = coordinator.tasks[run["runId"]]
            try:
                await asyncio.wait_for(retry_started.wait(), 1)
                active = await self.wait_for_report(run["runId"])
                self.assertTrue(any(section["id"] == "exposure-risk" for section in active["sections"]))
                self.assertNotIn("portfolioBalance", active["dependencies"])
                self.assertFalse(task.done())
            finally:
                release.set()
                await task
        final = self.store.get(run["runId"])
        self.assertEqual(final["dependencies"]["portfolioBalance"]["detail"]["attemptCount"], 3)
        self.assertEqual(self.store.read_evidence(final, "portfolioBalance"), accepted)

    async def test_balance_retry_shared_budget_cancels_a_slow_second_request(self):
        context = self.broker_context("balance-total-budget")
        cleaned = asyncio.Event()
        calls = 0

        async def balance():
            nonlocal calls
            calls += 1
            if calls == 1:
                await asyncio.sleep(0.01)
                return analyst_app.BalanceContextReader._unavailable("BALANCE_HTTP_ERROR", http_status=503)
            try:
                await asyncio.Event().wait()
            finally:
                cleaned.set()

        started = asyncio.get_running_loop().time()
        with patch.object(analyst_app, "PORTFOLIO_ACCOUNT_EXPOSURE_TIMEOUT_SECONDS", 0.04), \
                patch.object(analyst_app, "BALANCE_REVIEW_RETRY_DELAY_SECONDS", 0):
            result = await analyst_app._read_retrying_balance_review_source(context, balance)
        self.assertIsInstance(result, asyncio.TimeoutError)
        self.assertEqual(calls, 2)
        self.assertTrue(cleaned.is_set())
        self.assertLess(asyncio.get_running_loop().time() - started, 0.3)
        self.assertEqual(self.store.get(context.run_id)["dependencies"]["portfolioBalance"]["status"], "failed")

    async def test_balance_stop_or_run_deadline_prevents_a_late_source_checkpoint(self):
        for terminal in ("cancelled", "expired"):
            for attempt in (1, 2, 3):
                with self.subTest(terminal=terminal, attempt=attempt):
                    context = self.broker_context(f"balance-{terminal}-{attempt}")
                    calls = 0

                    async def balance():
                        nonlocal calls
                        calls += 1
                        if calls < attempt:
                            return analyst_app.BalanceContextReader._unavailable("BALANCE_REQUEST_TIMEOUT")
                        if terminal == "cancelled":
                            self.store.update(context.run_id, state="cancelled", phase="terminal", outcome="blocked")
                        else:
                            with self.store.connect() as connection:
                                connection.execute("UPDATE analyst_review_runs_v2 SET deadline_at=? WHERE run_id=?",
                                    ((datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat(), context.run_id))
                        return verified_balance_context()

                    with patch.object(analyst_app, "BALANCE_REVIEW_RETRY_DELAY_SECONDS", 0):
                        with self.assertRaises(asyncio.CancelledError if terminal == "cancelled" else asyncio.TimeoutError):
                            await analyst_app._read_retrying_balance_review_source(context, balance)
                    self.assertEqual(calls, attempt)
                    self.assertNotIn("portfolioBalance", self.store.get_source_metadata(context.run_id)["dependencies"])

    async def test_balance_attempt_deadlines_leave_a_third_fresh_request_inside_one_budget(self):
        context = self.broker_context("balance-three-bounded-attempts")
        calls = 0
        active = 0
        cleaned = 0

        async def balance():
            nonlocal calls, active, cleaned
            calls += 1
            active += 1
            self.assertEqual(active, 1)
            try:
                if calls < 3:
                    await asyncio.Event().wait()
                return verified_balance_context()
            finally:
                active -= 1
                cleaned += 1

        started = asyncio.get_running_loop().time()
        with patch.object(analyst_app, "PORTFOLIO_ACCOUNT_EXPOSURE_TIMEOUT_SECONDS", 0.15), \
                patch.object(analyst_app, "PORTFOLIO_ACCOUNT_EXPOSURE_ATTEMPT_TIMEOUT_SECONDS", 0.02), \
                patch.object(analyst_app, "BALANCE_REVIEW_RETRY_DELAY_SECONDS", 0):
            result = await analyst_app._read_retrying_balance_review_source(context, balance)
        self.assertEqual(result["status"], "available")
        self.assertEqual((calls, active, cleaned), (3, 0, 3))
        self.assertLess(asyncio.get_running_loop().time() - started, 0.3)
        detail = self.store.get(context.run_id)["dependencies"]["portfolioBalance"]["detail"]
        self.assertEqual(detail["acquisition"]["budgetMs"], 150)
        self.assertEqual([attempt["outcome"] for attempt in detail["acquisition"]["attempts"]],
                         ["timeout", "timeout", "available"])

    async def test_daily_transient_retry_publishes_current_book_before_recovery_and_captures_exact_research(self):
        release = asyncio.Event()
        retry_started = asyncio.Event()
        accepted = self.daily_publication()
        attempts = 0

        async def daily(day):
            nonlocal attempts
            self.assertEqual(day, accepted["date"])
            attempts += 1
            if attempts < 3:
                return {"date": day, "snapshots": {}, "marketStructure": {}, "acquisitionDiagnostics": {
                    "dailyArchive": {"code": "RESEARCH_ARCHIVE_TIMEOUT", "retryable": True}}}
            retry_started.set()
            await release.wait()
            return accepted

        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, replace(coordinator_sources(), daily_research=daily))

        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        with patch.object(analyst_app, "DAILY_RESEARCH_RETRY_DELAY_SECONDS", 0.01):
            run = await coordinator.start(review_kind="portfolio-review", request_id="daily-independent-retry")
            task = coordinator.tasks[run["runId"]]
            try:
                await asyncio.wait_for(retry_started.wait(), 1)
                active = await self.wait_for_report(run["runId"])
                self.assertTrue(any(section["id"] == "exposure-risk" for section in active["sections"]))
                self.assertNotIn("dailyResearch", active["dependencies"])
                self.assertFalse(task.done())
            finally:
                release.set()
                await task
        final = self.store.get(run["runId"])
        source = final["dependencies"]["dailyResearch"]
        self.assertEqual((final["state"], source["status"], source["detail"]["attemptCount"]), ("succeeded", "partial", 3))
        self.assertEqual(len(source["detail"]["acquisition"]["attempts"]), 3)
        self.assertEqual(source["asOf"], final["createdAt"])
        self.assertEqual(self.store.read_evidence(final, "dailyResearch"), accepted)
        self.assertIn("Exact recovered publication remains complete.", final["reportMarkdown"])
        self.assertNotIn("acquisitionDiagnostics", self.store.read_evidence(final, "dailyResearch"))
        with self.assertRaises(ReviewRunError):
            self.store.merge_dependency(run["runId"], "dailyResearch", {"status": "failed"})

    async def test_daily_retry_only_accepts_transport_or_http_5xx_failures_with_at_most_three_attempts(self):
        accepted = self.daily_publication()
        request = httpx.Request("GET", "http://dashboard.test/research")
        for error in (httpx.ReadTimeout("timeout", request=request), asyncio.TimeoutError(),
                      httpx.HTTPStatusError("failed", request=request, response=httpx.Response(503, request=request))):
            with self.subTest(error=type(error).__name__):
                context = self.broker_context("daily-recovery-" + type(error).__name__)
                reader = AsyncMock(side_effect=[error, error, accepted])
                with patch.object(analyst_app, "DAILY_RESEARCH_RETRY_DELAY_SECONDS", 0):
                    result, attempts = await analyst_app._read_retrying_daily_review_source(context, reader, accepted["date"])
                self.assertIs(result, accepted)
                self.assertEqual((attempts, reader.await_count), (3, 3))
        context = self.broker_context("daily-exhausted")
        reader = AsyncMock(side_effect=httpx.ConnectError("offline", request=request))
        with patch.object(analyst_app, "DAILY_RESEARCH_RETRY_DELAY_SECONDS", 0):
            result, attempts = await analyst_app._read_retrying_daily_review_source(context, reader, accepted["date"])
        self.assertIsInstance(result, httpx.ConnectError)
        self.assertEqual((attempts, reader.await_count), (3, 3))

    async def test_daily_retry_keeps_original_capture_cutoff_when_recovery_contains_a_later_publication(self):
        evidence = self.daily_publication()
        evidence["snapshots"]["top-3-things"]["publishedAt"] = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        reader = AsyncMock(side_effect=[asyncio.TimeoutError(), evidence])
        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, replace(coordinator_sources(), daily_research=reader))
        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        with patch.object(analyst_app, "DAILY_RESEARCH_RETRY_DELAY_SECONDS", 0):
            run = await coordinator.start(review_kind="portfolio-review", request_id="daily-original-cutoff")
            await coordinator.tasks[run["runId"]]
        final = self.store.get(run["runId"])
        self.assertEqual(final["dependencies"]["dailyResearch"]["status"], "failed")
        self.assertEqual(final["dependencies"]["dailyResearch"]["asOf"], run["createdAt"])
        self.assertEqual(self.store.read_evidence(final, "dailyResearch"), evidence)
        self.assertNotIn("Exact recovered publication remains complete.", final["reportMarkdown"])
        self.assertEqual(reader.await_count, 2)
        self.assertTrue(any(section["id"] == "exposure-risk" for section in final["sections"]))

    async def test_daily_received_partial_invalid_or_absent_publications_are_never_replaced_by_retry(self):
        timeout = {"date": "2026-08-31", "acquisitionDiagnostics": {
            "dailyArchive": {"code": "RESEARCH_ARCHIVE_TIMEOUT", "retryable": True}}}
        values = [self.daily_publication(), {**timeout, "marketStructure": {"date": "2026-08-31", "data": {"signals": []}}},
                  {"date": "2026-08-31", "snapshots": {}},
                  {"date": "2026-08-31", "acquisitionDiagnostics": {"dailyArchive": {
                      "code": "RESEARCH_ARCHIVE_DATE_MISMATCH", "retryable": False}}}]
        values.extend({**timeout, flag: True} for flag in (
            "cached", "cacheOnly", "fromCache", "stale", "fallback", "mock", "seeded",
            "inferred", "synthetic", "portfolioDerived", "delayed", "refreshRetained"))
        values += [{"acquisitionDiagnostics": {"dailyArchive": {"code": code, "retryable": True}}}
                   for code in ("RESEARCH_ARCHIVE_DATE_MISMATCH", "RESEARCH_ARCHIVE_INVALID_RESPONSE")]
        values.append({"acquisitionDiagnostics": {"dailyArchive": {
            "code": "RESEARCH_ARCHIVE_UNAVAILABLE", "retryable": True, "statusCode": 403}}})
        values.append({**timeout, "snapshots": {"top-3-things": {"date": "2026-08-31", "mock": True}}})
        request = httpx.Request("GET", "http://dashboard.test/research")
        values.extend([ValueError("Invalid publication"), httpx.HTTPStatusError("Forbidden", request=request,
            response=httpx.Response(403, request=request))])
        for index, value in enumerate(values):
            with self.subTest(index=index):
                context = self.broker_context(f"daily-permanent-{index}")
                reader = AsyncMock(side_effect=value) if isinstance(value, Exception) else AsyncMock(return_value=value)
                result, attempts = await analyst_app._read_retrying_daily_review_source(context, reader, "2026-08-31")
                self.assertIs(result, value)
                self.assertEqual(attempts, 1)
                reader.assert_awaited_once()

    async def test_daily_budget_stop_and_run_deadline_prevent_late_research_checkpoints(self):
        context = self.broker_context("daily-budget")
        cleaned = asyncio.Event()
        async def slow(_day):
            try:
                await asyncio.Event().wait()
            finally:
                cleaned.set()
        with patch.object(analyst_app, "PORTFOLIO_DAILY_RESEARCH_TIMEOUT_SECONDS", 0.02):
            result, attempts = await analyst_app._read_retrying_daily_review_source(context, slow, "2026-08-31")
        self.assertIsInstance(result, asyncio.TimeoutError)
        self.assertEqual(attempts, 1)
        self.assertTrue(cleaned.is_set())
        for terminal in ("cancelled", "expired"):
            for attempt in (1, 2, 3):
                context = self.broker_context(f"daily-{terminal}-{attempt}")
                calls = 0
                async def settle_after_stop(_day):
                    nonlocal calls
                    calls += 1
                    if calls < attempt:
                        raise asyncio.TimeoutError()
                    if terminal == "cancelled":
                        self.store.update(context.run_id, state="cancelled", phase="terminal", outcome="blocked")
                    else:
                        with self.store.connect() as connection:
                            connection.execute("UPDATE analyst_review_runs_v2 SET deadline_at=? WHERE run_id=?",
                                ((datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat(), context.run_id))
                    return self.daily_publication()
                with patch.object(analyst_app, "DAILY_RESEARCH_RETRY_DELAY_SECONDS", 0):
                    with self.assertRaises(asyncio.CancelledError if terminal == "cancelled" else asyncio.TimeoutError):
                        await analyst_app._read_retrying_daily_review_source(context, settle_after_stop, "2026-08-31")
                self.assertEqual(calls, attempt)
                self.assertNotIn("dailyResearch", self.store.get_source_metadata(context.run_id)["dependencies"])

    async def test_transient_portfolio_read_retries_fresh_and_captures_only_verified_recovery(self):
        context = self.broker_context("broker-recovery")
        accepted = verified_empty_portfolio()
        reader = AsyncMock(side_effect=[asyncio.TimeoutError(), accepted])
        with patch.object(analyst_app, "BROKER_REVIEW_RETRY_DELAY_SECONDS", 0.01):
            result = await analyst_app._read_retrying_broker_review_source(context, "portfolio", reader, timeout_seconds=1)
        self.assertIs(result, accepted)
        self.assertEqual(reader.await_count, 2)
        captured = self.store.get(context.run_id)
        dependency = captured["dependencies"]["portfolio"]
        self.assertEqual(dependency["status"], "ready")
        self.assertEqual(dependency["detail"]["attemptCount"], 2)
        self.assertGreaterEqual(dependency["detail"]["elapsedMs"], 10)
        self.assertEqual(dependency["asOf"], accepted["asOf"])
        self.assertEqual(self.store.read_evidence(captured, "portfolio"), accepted)

    async def test_open_orders_retry_runs_independently_of_early_verified_portfolio_report(self):
        release = asyncio.Event()
        retry_started = asyncio.Event()
        defaults = coordinator_sources()
        accepted = {"ok": True, "complete": True, "liveVerified": True, "status": "live",
                    "source": "ibkr_all_open_orders", "from_cache": False,
                    "asOf": "2026-08-31T14:00:01Z", "orders": []}
        attempts = 0

        async def orders():
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                return {"ok": False, "complete": False, "liveVerified": False, "status": "unavailable",
                        "orders": [], "message": "Open orders unavailable"}
            retry_started.set()
            await release.wait()
            return accepted

        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, replace(defaults, open_orders=orders))

        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        with patch.object(analyst_app, "BROKER_REVIEW_RETRY_DELAY_SECONDS", 0.01):
            run = await coordinator.start(review_kind="portfolio-review", request_id="independent-orders-retry")
            task = coordinator.tasks[run["runId"]]
            try:
                await asyncio.wait_for(retry_started.wait(), 1)
                active = await self.wait_for_report(run["runId"])
                self.assertEqual(active["dependencies"]["portfolio"]["status"], "ready")
                self.assertNotIn("portfolioOpenOrders", active["dependencies"])
                self.assertTrue(any(section["id"] == "exposure-risk" for section in active["sections"]))
                self.assertFalse(task.done())
            finally:
                release.set()
                await task
        completed = self.store.get(run["runId"])
        dependency = completed["dependencies"]["portfolioOpenOrders"]
        self.assertEqual((completed["state"], dependency["status"]), ("succeeded", "ready"))
        self.assertEqual(dependency["detail"]["attemptCount"], 2)
        self.assertEqual(self.store.read_evidence(completed, "portfolioOpenOrders"), accepted)
        with self.assertRaises(ReviewRunError):
            self.store.merge_dependency(run["runId"], "portfolioOpenOrders", {"status": "failed"})
        self.assertEqual(self.store.get(run["runId"])["dependencies"]["portfolioOpenOrders"], dependency)

    async def test_broker_retry_does_not_withhold_independent_research_or_publish_failed_holdings(self):
        release = asyncio.Event()
        retry_started = asyncio.Event()
        defaults = coordinator_sources()
        attempts = 0
        day = "2026-08-31"
        research = {"date": day, "snapshots": {"top-3-things": {
            "snapshotType": "top-3-things", "date": day, "publishedAt": f"{day}T12:00:00Z",
            "article": {"feedUrl": "https://app.hedgeye.com/feed_items/retry-progress"},
            "data": {"items": [{"title": "Independent research", "body": "Verified publication remains readable during broker retry."}]},
        }}}

        async def book():
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                return {"status": "unavailable", "liveVerified": False, "freshness": "unavailable",
                        "data": {"positions": [{"symbol": "REJECTED_BOOK", "marketValue": 123456}]}}
            retry_started.set()
            await release.wait()
            return await defaults.portfolio_context()

        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, replace(defaults,
                portfolio_context=book, daily_research=AsyncMock(return_value=research)))

        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        with patch.object(analyst_app, "BROKER_REVIEW_RETRY_DELAY_SECONDS", 0.01):
            run = await coordinator.start(review_kind="portfolio-review", request_id="research-during-broker-retry")
            task = coordinator.tasks[run["runId"]]
            try:
                await asyncio.wait_for(retry_started.wait(), 1)
                active = await self.wait_for_report(run["runId"])
                self.assertIn("Verified publication remains readable", active["reportMarkdown"])
                self.assertNotIn("REJECTED_BOOK", active["reportMarkdown"])
                self.assertNotIn("portfolio", active["dependencies"])
                self.assertFalse(task.done())
            finally:
                release.set()
                await task
        completed = self.store.get(run["runId"])
        self.assertEqual(completed["dependencies"]["portfolio"]["status"], "ready")
        self.assertEqual(completed["dependencies"]["portfolio"]["detail"]["attemptCount"], 2)
        self.assertNotIn("REJECTED_BOOK", completed["reportMarkdown"])

    async def test_retry_exhaustion_retains_last_failure_and_never_uses_an_old_broker_value(self):
        context = self.broker_context("broker-retry-exhausted")
        last = {"ok": False, "complete": False, "liveVerified": False, "status": "unavailable",
                "orders": [], "message": "Fresh broker snapshot timed out"}
        reader = AsyncMock(side_effect=[{"status": "error", "orders": [{"symbol": "OLD_ORDER"}]}, last])
        with patch.object(analyst_app, "BROKER_REVIEW_RETRY_DELAY_SECONDS", 0.01):
            result = await analyst_app._read_retrying_broker_review_source(context, "portfolioOpenOrders", reader, timeout_seconds=1)
        self.assertIs(result, last)
        self.assertEqual(reader.await_count, 2)
        captured = self.store.get(context.run_id)
        dependency = captured["dependencies"]["portfolioOpenOrders"]
        self.assertEqual(dependency["status"], "failed")
        self.assertEqual(dependency["detail"]["attemptCount"], 2)
        self.assertIsNone(dependency["asOf"])
        self.assertEqual(self.store.read_evidence(captured, "portfolioOpenOrders"), last)

    async def test_explicit_invalid_broker_flags_and_nontransient_errors_are_not_retried_or_accepted(self):
        for flag in ["cached", "cacheOnly", "fromCache", "stale", "fallback", "mock", "seeded", "inferred", "delayed", "refreshRetained"]:
            with self.subTest(flag=flag):
                context = self.broker_context("invalid-broker-" + flag)
                value = {**verified_empty_portfolio(), flag: True}
                reader = AsyncMock(return_value=value)
                await analyst_app._read_retrying_broker_review_source(context, "portfolio", reader, timeout_seconds=1)
                reader.assert_awaited_once()
                self.assertEqual(self.store.get(context.run_id)["dependencies"]["portfolio"]["status"], "failed")
        context = self.broker_context("broker-programming-error")
        reader = AsyncMock(side_effect=ValueError("Invalid provider schema"))
        result = await analyst_app._read_retrying_broker_review_source(context, "portfolio", reader, timeout_seconds=1)
        self.assertIsInstance(result, ValueError)
        reader.assert_awaited_once()

    async def test_one_broker_budget_cancels_slow_reader_and_cancellation_prevents_second_attempt(self):
        context = self.broker_context("broker-budget")
        cleaned = asyncio.Event()

        async def slow():
            try:
                await asyncio.Event().wait()
            finally:
                cleaned.set()

        reader = AsyncMock(side_effect=slow)
        result = await analyst_app._read_retrying_broker_review_source(context, "portfolio", reader, timeout_seconds=0.02)
        self.assertIsInstance(result, asyncio.TimeoutError)
        self.assertTrue(cleaned.is_set())
        reader.assert_awaited_once()
        self.assertEqual(self.store.get(context.run_id)["dependencies"]["portfolio"]["status"], "failed")
        cancelled = self.broker_context("broker-cancel-before-retry")

        async def disconnect_and_stop():
            self.store.update(cancelled.run_id, state="cancelled", phase="terminal", outcome="blocked")
            return {"status": "unavailable", "liveVerified": False}

        reader = AsyncMock(side_effect=disconnect_and_stop)
        with patch.object(analyst_app, "BROKER_REVIEW_RETRY_DELAY_SECONDS", 0.01):
            with self.assertRaises(asyncio.CancelledError):
                await analyst_app._read_retrying_broker_review_source(cancelled, "portfolio", reader, timeout_seconds=1)
        reader.assert_awaited_once()
        captured = self.store.get(cancelled.run_id)
        self.assertEqual(captured["state"], "cancelled")
        self.assertNotIn("portfolio", captured["dependencies"])

    async def test_queued_review_cancellation_is_durable_without_an_in_memory_worker(self):
        run, _ = self.store.create(review_kind="balance-review", conversation_id="queued-chat", request_id="queued")
        request = AsyncMock()
        request.path_params = {"operation": "cancel-review"}
        request.json.return_value = {"runId": run["runId"], "conversationId": "queued-chat"}
        coordinator = ReviewCoordinatorV2(self.store, {})
        with patch.object(analyst_app, "review_run_v2_store", self.store), \
                patch.object(analyst_app, "review_coordinator_v2", coordinator):
            response = await analyst_app.workspace_route(request)
            replay = await analyst_app.workspace_route(request)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(replay.status_code, 200)
        cancelled = self.store.get_status(run["runId"])
        self.assertEqual((cancelled["state"], cancelled["phase"]), ("cancelled", "terminal"))
        self.assertEqual(cancelled["errorCode"], "REVIEW_CANCELLED")
        self.assertTrue(cancelled["completedAt"])

    async def test_active_review_cancellation_persists_and_cleans_pending_sources(self):
        started = asyncio.Event()
        cleaned = asyncio.Event()

        async def handler(context):
            try:
                started.set()
                await asyncio.Event().wait()
            finally:
                cleaned.set()

        coordinator = ReviewCoordinatorV2(self.store, {"balance-review": handler})
        run = await coordinator.start(review_kind="balance-review", conversation_id="active-chat", request_id="active")
        task = coordinator.tasks[run["runId"]]
        await asyncio.wait_for(started.wait(), 1)
        request = AsyncMock()
        request.path_params = {"operation": "cancel-review"}
        request.json.return_value = {"runId": run["runId"], "conversationId": "active-chat"}
        with patch.object(analyst_app, "review_run_v2_store", self.store), \
                patch.object(analyst_app, "review_coordinator_v2", coordinator):
            response = await analyst_app.workspace_route(request)
        self.assertEqual(response.status_code, 200)
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(cleaned.is_set())
        self.assertEqual(self.store.get_status(run["runId"])["state"], "cancelled")

    async def test_terminal_capture_winning_cleanup_race_remains_immutable(self):
        failure = {"code": "REVIEW_CANCELLED", "message": "Cancelled", "retryable": True}
        for terminal in ("cancelled", "succeeded", "failed"):
            with self.subTest(terminal=terminal):
                run, _ = self.store.create(review_kind="balance-review", conversation_id="race-" + terminal,
                                           request_id="race-" + terminal)
                coordinator = ReviewCoordinatorV2(self.store, {})
                update = self.store.update
                winning = []
                def terminal_wins(run_id, **changes):
                    winning.append(update(run_id, state=terminal, phase="terminal", outcome="partial",
                        reportMarkdown="Exact captured report", citations=[{"id": "original-source"}],
                        sourceFingerprints={"balance": "original-fingerprint"}, completedAt="2026-10-09T19:24:59Z",
                        errorCode="ORIGINAL_TERMINAL_STATE", diagnostics={"captured": True}))
                    return update(run_id, **changes)
                with patch.object(self.store, "update", side_effect=terminal_wins) as attempted:
                    await coordinator._fail(run["runId"], failure, diagnostics={"type": "CancelledError"}, state="cancelled")
                attempted.assert_called_once()
                self.assertEqual(self.store.get(run["runId"]), winning[0])
                await coordinator._fail(run["runId"], failure, diagnostics={"type": "RepeatedCleanup"}, state="cancelled")
                self.assertEqual(self.store.get(run["runId"]), winning[0])

    async def test_cleanup_preserves_unrelated_storage_error(self):
        run, _ = self.store.create(review_kind="balance-review", conversation_id="cleanup-storage-error",
                                   request_id="cleanup-storage-error")
        coordinator = ReviewCoordinatorV2(self.store, {})
        failure = {"code": "REVIEW_CANCELLED", "message": "Cancelled", "retryable": True}
        with patch.object(self.store, "update", side_effect=ReviewRunError("REVIEW_STORAGE_FAILURE", "Storage failure")):
            with self.assertRaises(ReviewRunError) as error:
                await coordinator._fail(run["runId"], failure, diagnostics={}, state="cancelled")
        self.assertEqual(error.exception.code, "REVIEW_STORAGE_FAILURE")
        self.assertEqual(self.store.get_status(run["runId"])["state"], "queued")

    async def test_worker_route_preserves_preaccepted_identity_without_provider_preflight(self):
        run_id = "87a9cae1-38ea-41b0-aec3-f46f2db35a24"
        request = AsyncMock()
        request.json.return_value = {"reviewKind": "balance-review", "requestId": "accepted-request",
                                     "conversationId": "accepted-chat", "sessionId": "accepted-chat", "runId": run_id}
        coordinator = AsyncMock()
        coordinator.start.return_value = {"runId": run_id, "state": "queued"}
        with patch.object(analyst_app, "review_coordinator_v2", coordinator), \
                patch.object(analyst_app, "_review_v2_feature_enabled", return_value=True), \
                patch.dict(analyst_app.runtime_state, {"reviewCoordinatorV2": {"ready": True}}), \
                patch.object(analyst_app, "_portfolio_review_dependency_health", new=AsyncMock(
                    side_effect=AssertionError("Acceptance must not wait for live providers"))):
            response = await analyst_app.start_review_v2_route(request)
        self.assertEqual(response.status_code, 202)
        self.assertEqual(json.loads(response.body)["runId"], run_id)
        coordinator.start.assert_awaited_once_with(review_kind="balance-review", request_id="accepted-request",
                                                 conversation_id="accepted-chat", session_id="accepted-chat", run_id=run_id)

    async def test_portfolio_research_and_source_checkpoints_publish_before_blocked_broker_returns(self):
        release = asyncio.Event()
        sources = coordinator_sources()
        day = "2026-08-31"
        evidence = {"date": day, "snapshots": {"top-3-things": {
            "snapshotType": "top-3-things", "date": day, "publishedAt": f"{day}T12:00:00Z",
            "article": {"feedUrl": "https://app.hedgeye.com/feed_items/progressive"},
            "data": {"items": [{"title": "Liquidity", "body": "Published liquidity evidence remains available."}]},
        }}}

        async def book():
            await release.wait()
            return await sources.portfolio_context()

        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, replace(
                sources, portfolio_context=book, daily_research=AsyncMock(return_value=evidence)))

        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        started = await coordinator.start(review_kind="portfolio-review", request_id="portfolio-progress")
        try:
            active = await self.wait_for_report(started["runId"])
            self.assertEqual((active["state"], active["phase"]), ("running", "acquiring"))
            self.assertIn("Published liquidity evidence", active["reportMarkdown"])
            self.assertNotIn("Portfolio values unavailable", active["reportMarkdown"])
            self.assertEqual(active["dependencies"]["dailyResearch"]["asOf"], active["createdAt"])
            self.assertNotIn("portfolio", active["dependencies"])
            self.assertEqual(active["dependencies"]["exactResearchDocuments"]["status"], "ready")
            self.assertTrue(active["dependencies"]["exactResearchDocuments"]["fingerprint"])
            self.assertGreaterEqual(active["dependencies"]["exactResearchDocuments"]["detail"]["elapsedMs"], 0)
            self.assertTrue(all(row["publicationDate"] == day for row in active["citations"]))
            self.assertIsNone(active["baselineAcceptedAt"])
        finally:
            release.set()
            await coordinator.tasks[started["runId"]]
        self.assertEqual(self.store.get_status(started["runId"])["state"], "succeeded")

    async def test_portfolio_book_and_held_research_publish_while_balance_and_market_are_pending(self):
        release = asyncio.Event()
        defaults = coordinator_sources()
        held_started = asyncio.Event()

        async def balance():
            await release.wait()
            return verified_balance_context()

        async def market():
            await release.wait()
            return await defaults.market_situation_context()

        async def held(symbols, day):
            held_started.set()
            return await defaults.security_intelligence_symbols(symbols, day)

        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, replace(defaults,
                balance_context=balance, market_situation_context=market, security_intelligence_symbols=held))

        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        run = await coordinator.start(review_kind="portfolio-review", request_id="independent-core")
        task = coordinator.tasks[run["runId"]]
        try:
            await asyncio.wait_for(held_started.wait(), 1)
            active = await self.wait_for_report(run["runId"])
            self.assertEqual((active["state"], active["phase"]), ("running", "acquiring"))
            self.assertTrue(any(section["id"] == "exposure-risk" for section in active["sections"]))
            self.assertNotIn("Portfolio values unavailable", active["reportMarkdown"])
            self.assertNotIn("portfolioBalance", active["dependencies"])
            self.assertNotIn("marketSituation", active["dependencies"])
            self.assertFalse(task.done())
        finally:
            release.set()
            await task
        final = self.store.get(run["runId"])
        self.assertEqual(final["state"], "succeeded")
        for name in ("portfolio", "portfolioBalance", "marketSituation", "heldResearchEvents"):
            self.assertTrue(final["dependencies"][name]["fingerprint"])

    async def test_unverified_portfolio_cannot_publish_early_while_market_is_pending(self):
        for flag in ("stale", "cacheOnly", "mock", "seeded", "offline"):
            with self.subTest(flag=flag):
                release = asyncio.Event()
                captured = asyncio.Event()
                defaults = coordinator_sources()
                book = verified_empty_portfolio()
                book[flag] = True
                if flag == "offline":
                    book["liveVerified"] = False

                async def portfolio():
                    captured.set()
                    return book

                async def market():
                    await release.wait()
                    return await defaults.market_situation_context()

                async def handler(context):
                    return await analyst_app._portfolio_review_v2_handler(context, replace(defaults,
                        portfolio_context=portfolio, market_situation_context=market))

                coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
                run = await coordinator.start(review_kind="portfolio-review", request_id=f"invalid-core-{flag}")
                task = coordinator.tasks[run["runId"]]
                try:
                    await asyncio.wait_for(captured.wait(), 1)
                    async def settled():
                        while "portfolio" not in self.store.get_source_metadata(run["runId"])["dependencies"]:
                            await asyncio.sleep(0.005)
                    await asyncio.wait_for(settled(), 1)
                    self.assertFalse(self.store.get_status(run["runId"])["reportAvailable"])
                    self.assertEqual(self.store.get_source_metadata(run["runId"])["dependencies"]["portfolio"]["status"], "failed")
                finally:
                    release.set()
                    await task

    async def test_failed_bounded_market_reader_cannot_discard_verified_core_or_supply_fallback(self):
        defaults = coordinator_sources()

        async def market():
            await asyncio.Event().wait()

        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, replace(defaults,
                market_situation_context=market))

        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        with patch.object(analyst_app, "PORTFOLIO_MARKET_CONTEXT_TIMEOUT_SECONDS", 0.05):
            run = await coordinator.start(review_kind="portfolio-review", request_id="bounded-market-failure")
            task = coordinator.tasks[run["runId"]]
            active = await self.wait_for_report(run["runId"])
            self.assertEqual(active["state"], "running")
            await task
        final = self.store.get(run["runId"])
        self.assertEqual(final["state"], "succeeded")
        self.assertTrue(final["reportMarkdown"])
        self.assertEqual(final["dependencies"]["marketSituation"]["status"], "failed")
        self.assertEqual(final["dependencies"]["marketSituation"]["errorCode"], "REVIEW_SOURCE_UNAVAILABLE")
        self.assertIsNone(self.store.read_evidence(final, "marketSituation"))
        self.assertTrue(final["dependencies"]["portfolio"]["fingerprint"])

    @patch.dict(os.environ, PCA_ENABLED)
    async def test_pca_single_saved_read_leaves_the_primary_available_and_preserves_capture_cutoff(self):
        from portfolio_pca_review import read_portfolio_pca_review
        from test_portfolio_pca_review import snapshot, envelope, HEADERS
        book = verified_empty_portfolio()
        position = {"account": "TEST", "symbol": "ABC", "quantity": 10, "marketValue": 1000,
                    "valuationPrice": 100, "category": "other", "markState": "live"}
        book["data"]["positionTable"].update(rows=[[position.get(key) for key in POSITION_COLUMNS]], rowCount=1)
        book["data"]["accountSummaries"][0]["summary"]["NetLiquidation"]["value"] = 100000
        pca = snapshot()
        pca["accountId"] = "TEST"
        release = asyncio.Event()
        read_started = asyncio.Event()
        requests = []

        async def respond(request):
            requests.append(request)
            read_started.set()
            await release.wait()
            return httpx.Response(200, json=envelope(pca), headers=HEADERS)

        async def read(base_url, account, *, diagnostics, ensure_active):
            return await read_portfolio_pca_review(base_url, account, diagnostics=diagnostics,
                ensure_active=ensure_active, transport=httpx.MockTransport(respond))

        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, replace(coordinator_sources(),
                portfolio_context=AsyncMock(return_value=book), pca_research=analyst_app._default_portfolio_pca_source))

        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        with patch.object(analyst_app, "read_portfolio_pca_review", side_effect=read):
            run = await coordinator.start(review_kind="portfolio-review", request_id="pca-independent-single-read")
            task = coordinator.tasks[run["runId"]]
            try:
                await asyncio.wait_for(read_started.wait(), 1)
                active = await self.wait_for_report(run["runId"])
                self.assertTrue(any(section["id"] == "exposure-risk" for section in active["sections"]))
                self.assertNotIn("portfolioPca", active["dependencies"])
                self.assertFalse(task.done())
            finally:
                release.set()
                await task
        captured = self.store.get(run["runId"])
        dependency = captured["dependencies"]["portfolioPca"]
        self.assertEqual(dependency["status"], "ready")
        self.assertEqual(dependency["detail"]["acquisition"]["attemptCount"], 1)
        self.assertEqual(captured["createdAt"], run["createdAt"])
        self.assertEqual(dependency["asOf"], pca["asOf"])
        self.assertEqual(self.store.read_evidence(captured, "portfolioPca"), pca)
        self.assertEqual(len(requests), 1)

    @patch.dict(os.environ, PCA_ENABLED)
    async def test_saved_pca_check_starts_with_verified_identity_before_mark_audit(self):
        from test_portfolio_pca_review import snapshot
        release_marks = asyncio.Event()
        book = verified_empty_portfolio()
        position = {"account": "TEST", "symbol": "ABC", "quantity": 10, "category": "other",
                    "markState": "unavailable"}
        book["data"]["positionTable"].update(rows=[[position.get(key) for key in POSITION_COLUMNS]], rowCount=1)
        book["data"].pop("accountSummaries")
        book["data"].pop("pnl")
        pca = snapshot()
        pca["accountId"] = "TEST"
        pca_reader = AsyncMock(return_value=pca)

        async def progressive(*, on_holdings):
            await on_holdings(book)
            await release_marks.wait()
            return book

        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, replace(coordinator_sources(),
                progressive_portfolio_context=progressive, pca_research=pca_reader))

        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        run = await coordinator.start(review_kind="portfolio-review", request_id="pca-before-marks")
        task = coordinator.tasks[run["runId"]]
        try:
            async def settled():
                while True:
                    active = self.store.get(run["runId"])
                    if (active["dependencies"].get("portfolioPca") or {}).get("fingerprint"):
                        return active
                    await asyncio.sleep(.005)
            active = await asyncio.wait_for(settled(), .5)
            self.assertEqual(active["dependencies"]["portfolioPca"]["status"], "ready")
            self.assertEqual(self.store.read_evidence(active, "portfolioPca"), pca)
            pca_reader.assert_awaited_once_with("TEST")
            self.assertEqual(active["state"], "running")
            self.assertFalse(task.done())
            self.assertNotIn("portfolioSizing", active["dependencies"])
        finally:
            release_marks.set()
            await task
        pca_reader.assert_awaited_once_with("TEST")

    @patch.dict(os.environ, PCA_ENABLED)
    async def test_hung_pca_check_settles_before_other_research_finishes(self):
        release_archive = asyncio.Event()
        pca_cancelled = asyncio.Event()
        book = verified_empty_portfolio()
        position = {"account": "TEST", "symbol": "ABC", "quantity": 10, "marketValue": 1000,
                    "valuationPrice": 100, "category": "other", "markState": "live"}
        book["data"]["positionTable"].update(rows=[[position.get(key) for key in POSITION_COLUMNS]], rowCount=1)
        book["data"]["accountSummaries"][0]["summary"]["NetLiquidation"]["value"] = 100000

        async def pca(_account):
            try:
                await asyncio.Event().wait()
            finally:
                pca_cancelled.set()

        async def slow_archive(_symbols, _day, _cutoff):
            await release_archive.wait()
            return {"scanComplete": True, "bySymbol": {}, "scope": "full-publications"}

        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, replace(coordinator_sources(),
                portfolio_context=AsyncMock(return_value=book), pca_research=pca, refresh_research=slow_archive))

        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        self.assertEqual(analyst_app.PORTFOLIO_PCA_CONTEXT_TIMEOUT_SECONDS, 1)
        with patch.object(analyst_app, "PORTFOLIO_PCA_CONTEXT_TIMEOUT_SECONDS", .03):
            run = await coordinator.start(review_kind="portfolio-review", request_id="pca-bounded-check")
            task = coordinator.tasks[run["runId"]]
            try:
                async def settled():
                    while True:
                        active = self.store.get(run["runId"])
                        if "portfolioPca" in active["dependencies"]:
                            return active
                        await asyncio.sleep(.005)
                active = await asyncio.wait_for(settled(), .5)
                self.assertEqual(active["state"], "running")
                self.assertEqual(active["dependencies"]["portfolioPca"]["status"], "failed")
                self.assertEqual(active["dependencies"]["portfolioPca"]["errorCode"], "PCA_MODEL_UNAVAILABLE")
                self.assertIsNone(self.store.read_evidence(active, "portfolioPca"))
                self.assertTrue(pca_cancelled.is_set())
                self.assertNotIn("portfolioRefreshResearch", active["dependencies"])
                self.assertFalse(task.done())
            finally:
                release_archive.set()
                await task

    @patch.dict(os.environ, PCA_ENABLED)
    async def test_pca_acquisition_stage_diagnostics_are_captured_without_changing_evidence(self):
        from test_portfolio_pca_review import snapshot
        book = verified_empty_portfolio()
        position = {"account": "TEST", "symbol": "ABC", "quantity": 10, "marketValue": 1000,
                    "valuationPrice": 100, "category": "other", "markState": "live"}
        book["data"]["positionTable"].update(rows=[[position.get(key) for key in POSITION_COLUMNS]], rowCount=1)
        book["data"]["accountSummaries"][0]["summary"]["NetLiquidation"]["value"] = 100000
        pca = snapshot()
        pca["accountId"] = "TEST"
        for outcome in ("available", "timeout"):
            with self.subTest(outcome=outcome):
                evidence = pca if outcome == "available" else {}
                safe_diagnostics = {"outcome": outcome, "attemptCount": 2, "phase": "request_headers",
                                    "eventLoopLagMaxMs": 12, "elapsedMs": 100,
                                    "attempts": [{"attempt": 1, "elapsedMs": 80}, {"attempt": 2, "elapsedMs": 20}]}

                async def read(_base_url, account, *, diagnostics, ensure_active=None):
                    self.assertEqual(account, "TEST")
                    await ensure_active()
                    diagnostics.update(safe_diagnostics)
                    return evidence

                async def handler(context):
                    return await analyst_app._portfolio_review_v2_handler(context, replace(coordinator_sources(),
                        portfolio_context=AsyncMock(return_value=book), pca_research=analyst_app._default_portfolio_pca_source))

                coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
                with patch.object(analyst_app, "read_portfolio_pca_review", side_effect=read):
                    run = await coordinator.start(review_kind="portfolio-review", request_id="pca-diagnostics-" + outcome)
                    await coordinator.tasks[run["runId"]]
                captured = self.store.get(run["runId"])
                dependency = captured["dependencies"]["portfolioPca"]
                self.assertEqual(dependency["detail"]["acquisition"], safe_diagnostics)
                self.assertGreaterEqual(dependency["detail"]["sectionValidationMs"], 0)
                self.assertEqual(dependency["status"], "ready" if outcome == "available" else "failed")
                self.assertEqual(self.store.read_evidence(captured, "portfolioPca"), evidence)
                self.assertNotIn("TEST", json.dumps(dependency["detail"]))

    @patch.dict(os.environ, PCA_ENABLED)
    async def test_independent_pca_and_directional_research_merge_before_archive_and_remain_captured(self):
        from test_portfolio_pca_review import snapshot
        from test_portfolio_position_alignment import reference, security
        release_archive = asyncio.Event()
        defaults = coordinator_sources()
        book = verified_empty_portfolio()
        position = {"account": "TEST", "symbol": "ABC", "quantity": 10, "marketValue": 1000,
                    "valuationPrice": 100, "category": "other", "markState": "live"}
        book["data"]["positionTable"].update(rows=[[position.get(key) for key in POSITION_COLUMNS]], rowCount=1)
        book["data"]["accountSummaries"][0]["summary"]["NetLiquidation"]["value"] = 100000
        pca = snapshot()
        pca["accountId"] = "TEST"
        trade = reference("trade", "BULLISH", "2026-08-31")
        intelligence = {"coverage": {"state": "complete"}, "bySymbol": {"ABC": security([trade])}}
        archive = {"scanComplete": True, "bySymbol": {}, "scope": "full-publications"}

        async def slow_archive(_symbols, _day, _cutoff):
            await release_archive.wait()
            return archive

        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, replace(defaults,
                portfolio_context=AsyncMock(return_value=book), security_intelligence_symbols=AsyncMock(return_value=intelligence),
                pca_research=AsyncMock(return_value=pca), refresh_research=slow_archive))

        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        run = await coordinator.start(review_kind="portfolio-review", request_id="independent-support")
        task = coordinator.tasks[run["runId"]]
        try:
            async def supported():
                while True:
                    active = self.store.get(run["runId"])
                    report = active.get("reportMarkdown") or ""
                    if "PCA risk" in report and "Bullish Trade" in report:
                        return active
                    await asyncio.sleep(0.005)
            active = await asyncio.wait_for(supported(), 1)
            self.assertEqual(active["state"], "running")
            self.assertNotIn("portfolioRefreshResearch", active["dependencies"])
            self.assertEqual(active["dependencies"]["portfolioPca"]["asOf"], "2026-09-18")
            self.assertEqual(self.store.read_evidence(active, "heldResearchEvents"), intelligence)
            self.assertEqual(self.store.read_evidence(active, "portfolioPca"), pca)
            self.assertTrue(any(citation.get("publicationDate") == "2026-08-31" for citation in active["citations"]))
            self.assertFalse(task.done())
        finally:
            release_archive.set()
            await task
        final = self.store.get(run["runId"])
        self.assertEqual(final["state"], "succeeded")
        self.assertEqual(self.store.read_evidence(final, "portfolioRefreshResearch"), archive)
        self.assertEqual(self.store.read_evidence(final, "heldResearchEvents"), intelligence)
        self.assertEqual(self.store.read_evidence(final, "portfolioPca"), pca)
        self.assertIn("PCA risk", final["reportMarkdown"])

    async def test_paused_pca_reads_no_model_and_keeps_a_pending_section_in_place(self):
        from portfolio_pca_review import paused_portfolio_pca_section
        from test_portfolio_position_alignment import reference, security
        release_archive = asyncio.Event()
        book = verified_empty_portfolio()
        position = {"account": "TEST", "symbol": "ABC", "quantity": 10, "marketValue": 1000,
                    "valuationPrice": 100, "category": "other", "markState": "live"}
        book["data"]["positionTable"].update(rows=[[position.get(key) for key in POSITION_COLUMNS]], rowCount=1)
        book["data"]["accountSummaries"][0]["summary"]["NetLiquidation"]["value"] = 100000
        trade = reference("trade", "BULLISH", "2026-08-31")
        intelligence = {"coverage": {"state": "complete"}, "bySymbol": {"ABC": security([trade])}}

        async def slow_archive(_symbols, _day, _cutoff):
            await release_archive.wait()
            return {"scanComplete": True, "bySymbol": {}, "scope": "full-publications"}

        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, replace(coordinator_sources(),
                portfolio_context=AsyncMock(return_value=book), security_intelligence_symbols=AsyncMock(return_value=intelligence),
                pca_research=analyst_app._default_portfolio_pca_source, refresh_research=slow_archive))

        def rollup(run):
            review = next(section for section in run["sections"] if section["id"] == "portfolio-research-review")
            return review["dailyRollup"]["sections"]

        model_read = AsyncMock()
        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        with patch.dict(os.environ), patch.object(analyst_app, "read_portfolio_pca_review", model_read), \
                patch.object(analyst_app, "build_portfolio_pca_section", wraps=analyst_app.build_portfolio_pca_section) as model_section:
            os.environ.pop("ANALYST_PORTFOLIO_PCA_ENABLED", None)
            run = await coordinator.start(review_kind="portfolio-review", request_id="paused-pca")
            task = coordinator.tasks[run["runId"]]
            try:
                async def published():
                    while "Bullish Trade" not in (self.store.get(run["runId"]).get("reportMarkdown") or ""):
                        await asyncio.sleep(0.005)
                    return self.store.get(run["runId"])
                active = await asyncio.wait_for(published(), 1)
                self.assertEqual(active["state"], "running")
                self.assertEqual(rollup(active)[0], paused_portfolio_pca_section())
                self.assertEqual(sum(section["id"] == "pca-risk" for section in rollup(active)), 1)
            finally:
                release_archive.set()
                await task
        final = self.store.get(run["runId"])
        self.assertEqual(final["state"], "succeeded")
        dependency = final["dependencies"]["portfolioPca"]
        self.assertEqual((dependency["status"], dependency["errorCode"], dependency["fingerprint"]),
                         ("pending", "SOURCE_PAUSED", None))
        self.assertIsNone(self.store.read_evidence(final, "portfolioPca"))
        self.assertEqual(rollup(final)[0], {"id": "pca-risk", "title": "PCA risk", "status": "pending",
                                            "citationIds": [], "blocks": []})
        self.assertEqual(sum(section["id"] == "pca-risk" for section in rollup(final)), 1)
        self.assertNotIn("Largest risk components", final["reportMarkdown"])
        model_read.assert_not_awaited()
        model_section.assert_not_called()

    async def test_paused_pca_stays_pending_without_a_verified_single_account_book(self):
        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, replace(coordinator_sources(),
                pca_research=AsyncMock()))

        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        with patch.dict(os.environ, {"ANALYST_PORTFOLIO_PCA_ENABLED": "false"}):
            run = await coordinator.start(review_kind="portfolio-review", request_id="paused-pca-empty-book")
            await coordinator.tasks[run["runId"]]
        final = self.store.get(run["runId"])
        self.assertEqual(final["dependencies"]["portfolioPca"]["status"], "pending")
        self.assertEqual(final["dependencies"]["portfolioPca"]["errorCode"], "SOURCE_PAUSED")
        review = next(section for section in final["sections"] if section["id"] == "portfolio-research-review")
        self.assertEqual(review["dailyRollup"]["sections"][0]["status"], "pending")

    async def test_portfolio_finalization_logs_each_phase_with_its_run(self):
        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, coordinator_sources())

        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        with self.assertLogs(analyst_app.LOGGER, level="INFO") as logs:
            run = await coordinator.start(review_kind="portfolio-review", request_id="finalization-phases")
            await coordinator.tasks[run["runId"]]
        self.assertEqual(self.store.get_status(run["runId"])["state"], "succeeded")
        phases = [line.split("phase=")[1].split()[0] for line in logs.output
                  if f"Review finalization run={run['runId']} kind=portfolio-review" in line]
        self.assertEqual(phases, ["start", "open-orders", "reconciliation", "baseline", "daily-rollup",
                                  "position-alignment", "pca", "summaries", "sections", "citations"])
        self.assertTrue(all(re.search(r"phaseMs=\d+ elapsedMs=\d+ loopLagMaxMs=[\d.]+$", line)
                            for line in logs.output if "Review finalization" in line and "phase=start" not in line))
        # Progress revisions published before finalization carry their own timings.
        progress = [index for index, line in enumerate(logs.output) if f"Review progress run={run['runId']} " in line]
        start = next(index for index, line in enumerate(logs.output)
                     if f"Review finalization run={run['runId']} kind=portfolio-review phase=start" in line)
        self.assertTrue(progress and progress[0] < start)
        self.assertTrue(all(re.search(r"sources=[\w,]+ published=(True|False) waitMs=\d+ prepareMs=\d+ publishMs=\d+ "
                                      r"loopLagMaxMs=[\d.]+$", logs.output[index]) for index in progress))
        self.assertIn("published=True", logs.output[progress[0]])

    async def test_verified_balance_is_visible_before_independent_holdings_crosscheck(self):
        release = asyncio.Event()

        async def book():
            await release.wait()
            return {"status": "unavailable", "liveVerified": False}

        async def handler(context):
            return await analyst_app._balance_review_v2_handler(context,
                balance_reader=AsyncMock(return_value=verified_balance_context()), portfolio_reader=book)

        coordinator = ReviewCoordinatorV2(self.store, {"balance-review": handler})
        started = await coordinator.start(review_kind="balance-review", request_id="balance-progress")
        try:
            active = await self.wait_for_report(started["runId"])
            self.assertEqual(active["state"], "running")
            self.assertIn("100,000", active["reportMarkdown"])
            self.assertNotIn("No issues detected", active["reportMarkdown"])
            self.assertEqual(active["dependencies"]["balance"]["status"], "ready")
            self.assertNotIn("portfolio", active["dependencies"])
        finally:
            release.set()
            await coordinator.tasks[started["runId"]]
        self.assertEqual(self.store.get_status(started["runId"])["outcome"], "partial")

    async def test_unverified_balance_cannot_publish_early_while_holdings_are_pending(self):
        for flag in ("stale", "cacheOnly", "mock", "seeded", "offline"):
            with self.subTest(flag=flag):
                release = asyncio.Event()
                captured = asyncio.Event()
                evidence = verified_balance_context()
                evidence[flag] = True
                if flag == "offline":
                    evidence["liveVerified"] = False

                async def balance():
                    captured.set()
                    return evidence

                async def book():
                    await release.wait()
                    return {"status": "unavailable", "liveVerified": False}

                async def handler(context):
                    return await analyst_app._balance_review_v2_handler(context,
                        balance_reader=balance, portfolio_reader=book)

                coordinator = ReviewCoordinatorV2(self.store, {"balance-review": handler})
                started = await coordinator.start(review_kind="balance-review", request_id=f"invalid-{flag}")
                try:
                    await asyncio.wait_for(captured.wait(), 1)
                    await asyncio.sleep(0.02)
                    self.assertFalse(self.store.get_status(started["runId"])["reportAvailable"])
                finally:
                    release.set()
                    await coordinator.tasks[started["runId"]]
                final = self.store.get(started["runId"])
                self.assertNotIn("100,000", final["reportMarkdown"])

    async def test_optional_partial_projection_cannot_discard_a_report_or_resurrect_a_cancelled_run(self):
        context = AsyncMock()
        context.run_id = "owning-review"
        context.publish_verified_sections.side_effect = ReviewRunError("REVIEW_PROGRESS_UNVERIFIED", "Early proof unavailable")
        self.assertIsNone(await analyst_app._publish_supported_progress(
            context, [{"id": "supported-section"}], [], source_names=["dailyResearch"]))
        context.publish_verified_sections.side_effect = ReviewRunError("REVIEW_IMMUTABLE", "Stopped")
        with self.assertRaises(ReviewRunError) as stopped:
            await analyst_app._publish_supported_progress(context, [{"id": "supported-section"}], [], source_names=["dailyResearch"])
        self.assertEqual(stopped.exception.code, "REVIEW_IMMUTABLE")

    async def test_date_scoped_research_advances_while_broker_capture_is_blocked(self):
        broker_release = asyncio.Event()
        research_started = asyncio.Event()
        sources = coordinator_sources()

        async def book():
            await broker_release.wait()
            return await sources.portfolio_context()

        async def universe(day):
            research_started.set()
            return await sources.security_intelligence_universe(day)

        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(
                context, replace(sources, portfolio_context=book, security_intelligence_universe=universe))

        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        started = await coordinator.start(review_kind="portfolio-review", request_id="parallel-source-test")
        try:
            await asyncio.wait_for(research_started.wait(), 1)
            self.assertEqual(self.store.get_status(started["runId"])["state"], "running")
        finally:
            broker_release.set()
            await coordinator.tasks[started["runId"]]
        self.assertEqual(self.store.get_status(started["runId"])["state"], "succeeded")

    async def test_cancelled_review_releases_its_pending_source_tasks(self):
        started_source = asyncio.Event()
        cleaned_source = asyncio.Event()
        sources = coordinator_sources()

        async def universe(_):
            started_source.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaned_source.set()

        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(
                context, replace(sources, security_intelligence_universe=universe))

        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        started = await coordinator.start(review_kind="portfolio-review", request_id="cancel-source-test")
        task = coordinator.tasks[started["runId"]]
        await asyncio.wait_for(started_source.wait(), 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(cleaned_source.is_set())
        self.assertEqual(self.store.get_status(started["runId"])["state"], "cancelled")


if __name__ == "__main__":
    unittest.main()
