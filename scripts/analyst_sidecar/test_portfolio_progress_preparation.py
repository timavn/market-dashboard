"""Progress builders retain capture order while other API work can run."""
import asyncio
from copy import deepcopy
from dataclasses import replace
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import AsyncMock, patch

from review_runs_v2 import ReviewCoordinatorV2, ReviewRunV2Store, render_review
from test_portfolio_review_coordinator import analyst_app, coordinator_sources, verified_empty_portfolio


class PortfolioProgressPreparationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = ReviewRunV2Store(Path(self.temp.name) / "reviews.sqlite3")

    async def wait_until(self, predicate):
        async def ready():
            while not predicate():
                await asyncio.sleep(0.005)
        await asyncio.wait_for(ready(), 2)

    async def test_build_yields_and_new_source_cannot_replace_an_older_revision_out_of_order(self):
        entered, release_build = threading.Event(), threading.Event()
        release_daily, release_support = asyncio.Event(), asyncio.Event()
        loop_thread = threading.get_ident()
        defaults = coordinator_sources()
        book = verified_empty_portfolio()
        daily = {"date": "2026-08-31", "snapshots": {"top-3-things": {
            "snapshotType": "top-3-things", "date": "2026-08-31", "publishedAt": "2026-08-31T12:00:00Z",
            "article": {"feedUrl": "https://app.hedgeye.com/feed_items/off-loop-capture"},
            "data": {"items": [{"title": "Exact publication", "body": "Newly captured independent research."}]},
        }}}
        original_inputs = deepcopy((book, daily))
        publications = []
        original_build = analyst_app.build_daily_research_rollup
        original_publish = analyst_app._publish_supported_progress

        def blocked_first_build(*args, **kwargs):
            if "holdings" in kwargs and not entered.is_set():
                self.assertNotEqual(threading.get_ident(), loop_thread)
                entered.set()
                if not release_build.wait(3):
                    raise AssertionError("Progress builder was not released")
            return original_build(*args, **kwargs)

        async def dated_research(_day):
            await release_daily.wait()
            return daily

        async def market():
            await release_support.wait()
            return await defaults.market_situation_context()

        async def record_publish(context, sections, citations, *, source_names):
            captured = await original_publish(context, sections, citations, source_names=source_names)
            if captured:
                publications.append((deepcopy(sections), deepcopy(citations), list(source_names), captured["reportMarkdown"]))
            return captured

        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, replace(defaults,
                portfolio_context=AsyncMock(return_value=book), daily_research=dated_research,
                market_situation_context=market))

        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        with patch.object(analyst_app, "build_daily_research_rollup", side_effect=blocked_first_build), \
                patch.object(analyst_app, "_publish_supported_progress", side_effect=record_publish):
            run = await coordinator.start(review_kind="portfolio-review", request_id="ordered-build")
            task = coordinator.tasks[run["runId"]]
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, 1))
                release_daily.set()
                await self.wait_until(lambda: "dailyResearch" in self.store.get_source_metadata(run["runId"])["dependencies"])
                self.assertFalse(self.store.get_status(run["runId"])["reportAvailable"])
                self.assertFalse(task.done())
                release_build.set()
                await self.wait_until(lambda: any("Newly captured independent research." in row[3] for row in publications))
                self.assertNotIn("dailyResearch", publications[0][2])
                self.assertNotIn("Newly captured independent research.", publications[0][3])
                metrics = analyst_app.portfolio_metrics(book)
                expected_sections = [{"id": "exposure-risk", "status": "partial",
                    "metrics": {key: value for key, value in metrics.items() if key != "positions"},
                    "factorExposure": analyst_app.build_factor_exposure(metrics, {})}]
                self.assertEqual(publications[0][0], expected_sections)
                self.assertEqual(publications[0][1], [])
                self.assertEqual(publications[0][3], render_review("portfolio-review", expected_sections, "partial", []))
                self.assertTrue(any("dailyResearch" in row[2] for row in publications[1:]))
                self.assertFalse(task.done())
            finally:
                release_build.set()
                release_daily.set()
                release_support.set()
                await task
        saved = self.store.get(run["runId"])
        self.assertEqual(saved["state"], "succeeded")
        self.assertEqual(self.store.read_evidence(saved, "portfolio"), original_inputs[0])
        self.assertEqual(self.store.read_evidence(saved, "dailyResearch"), original_inputs[1])
        self.assertEqual((book, daily), original_inputs)

    async def test_cancelled_capture_cannot_publish_when_off_loop_builder_returns(self):
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        original_build = analyst_app.build_daily_research_rollup
        loop_thread = threading.get_ident()

        def blocked_build(*args, **kwargs):
            if "holdings" in kwargs:
                self.assertNotEqual(threading.get_ident(), loop_thread)
                entered.set()
                if not release.wait(3):
                    raise AssertionError("Progress builder was not released")
                finished.set()
            return original_build(*args, **kwargs)

        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, coordinator_sources())

        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        with patch.object(analyst_app, "build_daily_research_rollup", side_effect=blocked_build):
            run = await coordinator.start(review_kind="portfolio-review", request_id="stopped-build")
            task = coordinator.tasks[run["runId"]]
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, 1))
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            finally:
                release.set()
                self.assertTrue(await asyncio.to_thread(finished.wait, 1))
        saved = self.store.get_status(run["runId"])
        self.assertEqual(saved["state"], "cancelled")
        self.assertFalse(saved["reportAvailable"])
