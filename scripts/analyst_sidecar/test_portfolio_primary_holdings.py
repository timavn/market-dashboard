import os as _isolation_os
import tempfile as _isolation_tempfile

# Importing app opens its stores and fails in-flight reviews; never touch the live data directory.
_APP_DATA_DIR = _isolation_tempfile.TemporaryDirectory(prefix="analyst-portfolio-primary-holdings-test-")
_isolation_os.environ.setdefault("ANALYST_DATA_DIR", _APP_DATA_DIR.name)
_isolation_os.environ.setdefault("ANALYST_TEXTRACT_FALLBACK", "false")

import asyncio
from copy import deepcopy
from dataclasses import replace
from pathlib import Path
import tempfile
import unittest

from test_portfolio_review_coordinator import coordinator_sources, verified_empty_portfolio, POSITION_COLUMNS
import app as analyst_app
from review_runs_v2 import ReviewCoordinatorV2, ReviewRunV2Store


def captured_book(*, valued=False):
    book = verified_empty_portfolio()
    book["status"] = "available" if valued else "partial"
    position = {"account": "TEST", "symbol": "XYZ", "conId": 1,
                "category": "equity", "currency": "USD", "quantity": 2,
                "markState": "live" if valued else "unavailable",
                "valuationPrice": 100 if valued else None,
                "marketValue": 200 if valued else None}
    book["data"] = {"positionTable": {"columns": POSITION_COLUMNS,
                     "rows": [[position.get(key) for key in POSITION_COLUMNS]], "rowCount": 1},
                     "accountSummaries": [], "pnl": []}
    return book


class PrimaryHoldingsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.store = ReviewRunV2Store(Path(temp.name) / "reviews.sqlite3")

    async def wait_for_primary(self, run_id):
        async def ready():
            while True:
                run = self.store.get(run_id)
                if any(section.get("id") == "exposure-risk" for section in run["sections"]):
                    return run
                await asyncio.sleep(0.005)
        return await asyncio.wait_for(ready(), 1)

    async def test_exact_verified_holdings_publish_before_marks_and_finish_with_original_audit(self):
        release = asyncio.Event()
        audit_started = asyncio.Event()
        early, final = captured_book(), captured_book(valued=True)
        received = []

        async def progressive(*, on_holdings):
            await on_holdings(early)
            audit_started.set()
            await release.wait()
            return final

        async def held(symbols, day):
            received.append(symbols)
            return await defaults.security_intelligence_symbols(symbols, day)

        defaults = coordinator_sources()
        sources = replace(defaults, progressive_portfolio_context=progressive,
                          security_intelligence_symbols=held)

        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, sources)

        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        run = await coordinator.start(review_kind="portfolio-review", request_id="fast-exact-book")
        task = coordinator.tasks[run["runId"]]
        try:
            await asyncio.wait_for(audit_started.wait(), 1)
            primary = await self.wait_for_primary(run["runId"])
            metrics = next(s["metrics"] for s in primary["sections"] if s["id"] == "exposure-risk")
            self.assertTrue(metrics["available"])
            self.assertEqual(metrics["positionCount"], 1)
            self.assertFalse(metrics["valuationComplete"])
            self.assertIsNone(metrics["grossExposure"])
            self.assertIsNone(metrics["netExposure"])
            self.assertEqual(self.store.read_evidence(primary, "portfolio"), early)
            self.assertFalse(task.done())
            self.assertIn(["XYZ"], received)
        finally:
            release.set()
            await task
        completed = self.store.get(run["runId"])
        self.assertEqual(completed["state"], "succeeded")
        self.assertEqual(self.store.read_evidence(completed, "portfolio"), final)
        metrics = next(s["metrics"] for s in completed["sections"] if s["id"] == "exposure-risk")
        self.assertTrue(metrics["valuationComplete"])
        self.assertEqual(metrics["grossExposure"], 200)

    async def test_unverified_primary_never_creates_usable_book_or_report(self):
        for flag in ("cached", "cacheOnly", "stale", "mock", "seeded", "inferred"):
            with self.subTest(flag=flag):
                release, callback_finished = asyncio.Event(), asyncio.Event()
                rejected = {**deepcopy(captured_book()), flag: True}

                async def progressive(*, on_holdings):
                    await on_holdings(rejected)
                    callback_finished.set()
                    await release.wait()
                    return verified_empty_portfolio()

                async def handler(context):
                    return await analyst_app._portfolio_review_v2_handler(context,
                        replace(coordinator_sources(), progressive_portfolio_context=progressive))

                coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
                run = await coordinator.start(review_kind="portfolio-review", request_id="reject-primary-" + flag)
                task = coordinator.tasks[run["runId"]]
                try:
                    await asyncio.wait_for(callback_finished.wait(), 1)
                    active = self.store.get(run["runId"])
                    self.assertNotIn("portfolio", active["dependencies"])
                    self.assertFalse(any(s.get("id") == "exposure-risk" for s in active["sections"]))
                finally:
                    release.set()
                    await task

    async def test_cancelled_audit_cannot_replace_or_reopen_the_captured_primary(self):
        release, audit_started = asyncio.Event(), asyncio.Event()

        async def progressive(*, on_holdings):
            await on_holdings(captured_book())
            audit_started.set()
            await release.wait()
            return captured_book(valued=True)

        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context,
                replace(coordinator_sources(), progressive_portfolio_context=progressive))

        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        run = await coordinator.start(review_kind="portfolio-review", request_id="cancel-fast-primary")
        task = coordinator.tasks[run["runId"]]
        await asyncio.wait_for(audit_started.wait(), 1)
        primary = await self.wait_for_primary(run["runId"])
        self.store.update(run["runId"], state="cancelled", phase="terminal", outcome="blocked")
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        release.set()
        terminal = self.store.get(run["runId"])
        self.assertEqual(terminal["state"], "cancelled")
        self.assertEqual(terminal["reportRevision"], primary["reportRevision"])
        self.assertEqual(self.store.read_evidence(terminal, "portfolio"), captured_book())
