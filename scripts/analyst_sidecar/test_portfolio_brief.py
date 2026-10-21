import os as _isolation_os
import tempfile as _isolation_tempfile

# Importing app opens its stores and fails in-flight reviews; never touch the live data directory.
_APP_DATA_DIR = _isolation_tempfile.TemporaryDirectory(prefix="analyst-portfolio-brief-test-")
_isolation_os.environ.setdefault("ANALYST_DATA_DIR", _APP_DATA_DIR.name)
_isolation_os.environ.setdefault("ANALYST_TEXTRACT_FALLBACK", "false")

import copy
import asyncio
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

from portfolio_brief import attach_portfolio_briefs, build_portfolio_brief, build_captured_portfolio_brief, compact_portfolio_brief, captured_review_citation, context_takeaways, rule_holdings, latest_verified_portfolio, quad_outlook, captured_security_name
from portfolio_sizing import PortfolioSizingReader, verified_sizing_inputs


def intelligence():
    return {"coverage": {"state": "complete"}, "bySymbol": {"IGV": {
        "decision": {"trade": {"status": "available", "value": "BULLISH", "sourceId": "etf-pro"},
                     "trend": {"status": "available", "value": "NEUTRAL", "sourceId": "risk-ranges"}},
        "directReferences": [{"kind": "primary_risk_range", "productId": "risk-ranges", "marketDate": "2026-09-04", "publishedAt": "2026-09-04T14:30:00Z", "qualityStatus": "indexed", "matchType": "direct", "value": {"trend": "NEUTRAL", "lrr": 100, "hrr": 110}}],
        "history": [{"directReferences": [{"kind": "historical_risk_range", "value": {"trend": "BULLISH"}, "qualityStatus": "indexed", "matchType": "direct", "publishedAt": "2026-09-03T14:30:00Z"}]}],
    }}}


def metrics():
    return {"available": True, "observedAt": "2026-09-04T20:05:00Z", "netLiquidation": 100000,
            "grossExposure": 200000, "positions": [{"symbol": "IGV", "quantity": 10, "marketValue": 4000, "category": "other", "markState": "live", "valuationPrice": 100}]}


class PortfolioBriefProgressTests(unittest.IsolatedAsyncioTestCase):
    @patch.dict(_isolation_os.environ, {"ANALYST_PORTFOLIO_PCA_ENABLED": "true"})
    async def test_verified_book_replaces_warmed_research_only_brief_before_archive_and_pca_finish(self):
        import app as analyst_app
        from review_runs_v2 import ReviewCoordinatorV2, ReviewRunV2Store
        from portfolio_capture import project_portfolio_context
        from test_portfolio_review_coordinator import coordinator_sources, verified_balance_context
        from test_portfolio_review import live_portfolio, position

        release_book = asyncio.Event()
        release_supports = asyncio.Event()
        sources = coordinator_sources()
        book = live_portfolio([position("IGV", 10, "live", 100)], nlv=1000)
        day = "2026-08-31"
        research = {"date": day, "snapshots": {"top-3-things": {
            "snapshotType": "top-3-things", "date": day, "publishedAt": f"{day}T12:00:00Z",
            "article": {"feedUrl": "https://app.hedgeye.com/feed_items/first-book"},
            "data": {"items": [{"title": "Liquidity", "body": "Captured liquidity research before the book settles."}]},
        }}}

        async def broker():
            await release_book.wait()
            return book

        async def archive(*_):
            await release_supports.wait()
            return {"scanComplete": True, "bySymbol": {}, "scope": "full-publications"}

        async def pca(*_):
            await release_supports.wait()
            return {"status": "unavailable"}

        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, replace(
                sources, portfolio_context=broker, daily_research=AsyncMock(return_value=research),
                balance_context=AsyncMock(return_value=verified_balance_context()),
                refresh_research=archive, pca_research=pca, project_portfolio_context=project_portfolio_context))

        with tempfile.TemporaryDirectory() as directory:
            store = ReviewRunV2Store(Path(directory) / "reviews.sqlite3")
            coordinator = ReviewCoordinatorV2(store, {"portfolio-review": handler})
            accepted = await coordinator.start(review_kind="portfolio-review", conversation_id="progress-chat", request_id="first-book")
            task = coordinator.tasks[accepted["runId"]]

            def compact():
                run = store.get(accepted["runId"])
                conversation = {"id": "progress-chat", "kind": "portfolio-review", "messages": [
                    {"id": "same-post", "role": "assistant", "reviewRunId": run["runId"], "text": run["reportMarkdown"] or ""}]}
                return attach_portfolio_briefs(conversation, store, project_portfolio_context, compact=True)["messages"][0]["portfolioBrief"]

            async def wait_for(predicate):
                while not predicate(store.get(accepted["runId"])):
                    await asyncio.sleep(0.005)

            try:
                await asyncio.wait_for(wait_for(lambda run: bool(run.get("reportMarkdown"))), 2)
                initial = compact()
                self.assertFalse(initial["available"])
                self.assertTrue(initial["dailyRollup"]["sections"])
                release_book.set()
                await asyncio.wait_for(wait_for(lambda run: any(section["id"] == "exposure-risk" for section in run["sections"])), 2)
                active = store.get(accepted["runId"])
                self.assertEqual(active["state"], "running")
                for name in ("portfolio", "portfolioBalance"):
                    self.assertEqual(active["dependencies"][name]["status"], "ready")
                    self.assertTrue(active["dependencies"][name]["fingerprint"])
                verified = compact()
                self.assertTrue(verified["available"])
                self.assertTrue(verified["metrics"])
                self.assertEqual(verified["asOf"], book["asOf"])
                self.assertNotEqual(verified["reportRevision"], initial["reportRevision"])
                self.assertEqual(len(verified["holdings"]), 1)
                self.assertFalse(task.done(), "the first usable book must not wait for archive/PCA")
                self.assertNotIn("portfolioRefreshResearch", active["dependencies"])
                self.assertNotIn("portfolioPca", active["dependencies"])
            finally:
                release_book.set()
                release_supports.set()
                await task

    @patch.dict(_isolation_os.environ, {"ANALYST_PORTFOLIO_PCA_ENABLED": "true"})
    async def test_research_only_view_built_after_the_verified_book_is_never_published_over_it(self):
        import threading
        import app as analyst_app
        from review_runs_v2 import ReviewCoordinatorV2, ReviewRunV2Store
        from portfolio_capture import project_portfolio_context
        from test_portfolio_review_coordinator import coordinator_sources, verified_balance_context
        from test_portfolio_review import live_portfolio, position

        release_book = asyncio.Event()
        release_supports = asyncio.Event()
        build_started, release_build, build_finished = threading.Event(), threading.Event(), threading.Event()
        build = analyst_app.build_daily_research_rollup
        day = "2026-08-31"
        research = {"date": day, "snapshots": {"top-3-things": {
            "snapshotType": "top-3-things", "date": day, "publishedAt": f"{day}T12:00:00Z",
            "article": {"feedUrl": "https://app.hedgeye.com/feed_items/late-view"},
            "data": {"items": [{"title": "Liquidity", "body": "Captured liquidity research before the book settles."}]},
        }}}
        published = []
        publish = analyst_app._publish_supported_progress

        def research_only_build_waits(*args, **kwargs):
            if "holdings" in kwargs or build_started.is_set():
                return build(*args, **kwargs)
            # The research-only view is still being built off the loop when
            # the verified book arrives and publishes its own revision.
            build_started.set()
            release_build.wait(5)
            try:
                return build(*args, **kwargs)
            finally:
                build_finished.set()

        async def record_publish(*args, **kwargs):
            published.append(kwargs.get("source_names"))
            return await publish(*args, **kwargs)

        async def broker():
            await release_book.wait()
            return live_portfolio([position("IGV", 10, "live", 100)], nlv=1000)

        async def supports(*_):
            await release_supports.wait()
            return {"status": "unavailable"}

        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, replace(
                coordinator_sources(), portfolio_context=broker, daily_research=AsyncMock(return_value=research),
                balance_context=AsyncMock(return_value=verified_balance_context()),
                refresh_research=supports, pca_research=supports, project_portfolio_context=project_portfolio_context))

        def holdings_published(run):
            return any(section["id"] == "exposure-risk" for section in run.get("sections") or [])

        with tempfile.TemporaryDirectory() as directory, \
                patch.object(analyst_app, "build_daily_research_rollup", new=research_only_build_waits), \
                patch.object(analyst_app, "_publish_supported_progress", new=record_publish):
            store = ReviewRunV2Store(Path(directory) / "reviews.sqlite3")
            coordinator = ReviewCoordinatorV2(store, {"portfolio-review": handler})
            accepted = await coordinator.start(review_kind="portfolio-review", conversation_id="late-view", request_id="late-view")
            task = coordinator.tasks[accepted["runId"]]

            async def wait_for(predicate):
                while not predicate():
                    await asyncio.sleep(0.005)

            try:
                await asyncio.wait_for(wait_for(build_started.is_set), 2)
                release_book.set()
                await asyncio.wait_for(wait_for(lambda: holdings_published(store.get(accepted["runId"]))), 2)
                release_build.set()
                await asyncio.wait_for(wait_for(build_finished.is_set), 2)
                await asyncio.sleep(0.1)
                self.assertNotIn(["dailyResearch"], published)
                active = store.get(accepted["runId"])
                self.assertEqual(active["state"], "running")
                self.assertTrue(holdings_published(active))
            finally:
                release_book.set()
                release_build.set()
                release_supports.set()
                await task

    async def test_paused_pca_section_is_pending_from_the_research_only_brief_onward(self):
        import app as analyst_app
        from portfolio_pca_review import paused_portfolio_pca_section
        from review_runs_v2 import ReviewCoordinatorV2, ReviewRunV2Store
        from portfolio_capture import project_portfolio_context
        from test_portfolio_review_coordinator import coordinator_sources, verified_balance_context
        from test_portfolio_review import live_portfolio, position

        release_book = asyncio.Event()
        book = live_portfolio([position("IGV", 10, "live", 100)], nlv=1000)
        day = "2026-08-31"
        research = {"date": day, "snapshots": {"top-3-things": {
            "snapshotType": "top-3-things", "date": day, "publishedAt": f"{day}T12:00:00Z",
            "article": {"feedUrl": "https://app.hedgeye.com/feed_items/paused-pca"},
            "data": {"items": [{"title": "Liquidity", "body": "Captured liquidity research before the book settles."}]},
        }}}
        pca = AsyncMock()

        async def broker():
            await release_book.wait()
            return book

        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, replace(
                coordinator_sources(), portfolio_context=broker, daily_research=AsyncMock(return_value=research),
                balance_context=AsyncMock(return_value=verified_balance_context()),
                pca_research=pca, project_portfolio_context=project_portfolio_context))

        def captured_rollup(run):
            review = next((section for section in run["sections"] if section["id"] == "portfolio-research-review"), {})
            return (review.get("dailyRollup") or {}).get("sections") or []

        with tempfile.TemporaryDirectory() as directory, patch.dict(_isolation_os.environ):
            _isolation_os.environ.pop("ANALYST_PORTFOLIO_PCA_ENABLED", None)
            store = ReviewRunV2Store(Path(directory) / "reviews.sqlite3")
            coordinator = ReviewCoordinatorV2(store, {"portfolio-review": handler})
            accepted = await coordinator.start(review_kind="portfolio-review", conversation_id="paused-chat", request_id="paused-pca")
            task = coordinator.tasks[accepted["runId"]]

            async def wait_for(predicate):
                while not predicate(store.get(accepted["runId"])):
                    await asyncio.sleep(0.005)

            try:
                await asyncio.wait_for(wait_for(lambda run: bool(run.get("reportMarkdown"))), 2)
                initial = store.get(accepted["runId"])
                self.assertEqual(captured_rollup(initial)[0], paused_portfolio_pca_section())
                self.assertEqual(initial["dependencies"]["portfolioPca"]["status"], "pending")
                conversation = {"id": "paused-chat", "kind": "portfolio-review", "messages": [
                    {"id": "same-post", "role": "assistant", "reviewRunId": initial["runId"], "text": initial["reportMarkdown"]}]}
                brief = attach_portfolio_briefs(conversation, store, project_portfolio_context, compact=True)["messages"][0]["portfolioBrief"]
                self.assertEqual(brief["dailyRollup"]["sections"][0], paused_portfolio_pca_section())
                release_book.set()
                await asyncio.wait_for(wait_for(lambda run: any(section["id"] == "exposure-risk" for section in run["sections"])), 2)
                self.assertEqual(captured_rollup(store.get(accepted["runId"]))[0], paused_portfolio_pca_section())
            finally:
                release_book.set()
                await task
            final = store.get(accepted["runId"])
        self.assertEqual(final["state"], "succeeded")
        self.assertEqual([section["id"] for section in captured_rollup(final)].count("pca-risk"), 1)
        self.assertEqual(captured_rollup(final)[0], paused_portfolio_pca_section())
        self.assertEqual(final["dependencies"]["portfolioPca"]["errorCode"], "SOURCE_PAUSED")
        pca.assert_not_awaited()


class PortfolioBriefTests(unittest.TestCase):
    def test_compact_preserves_primary_readings_and_exact_citation_identity(self):
        source = {"id": "cite_saved", "product": "risk-ranges", "publicationDate": "2026-09-04",
                  "title": "Original publication", "excerpt": "Large captured evidence", "sourceEvidence": {"original": 123}}
        blocks = [{"type": "table", "columns": ["Ticker", "Security", "Reading"],
                   "rows": [{"cells": ["IGV", "Captured security", "Bullish"], "cellTitles": ["", "Full security name", ""],
                             "citationIds": [source["id"]], "cellCitationIds": [[], [], [source["id"]]]}]}]
        full = {"version": 1, "runId": "capture", "reportRevision": "original-revision",
                "metrics": {"grossExposure": 200000}, "holdings": [{"holding": "IGV", "weightPct": 4.0}],
                "dailyRollup": {"version": 1, "sections": [{"id": "readings", "title": "Readings", "blocks": blocks}],
                                "citations": [source]}, "citations": [source],
                "refreshReport": {"sections": [{"id": "readings", "blocks": blocks}]}}
        compact = compact_portfolio_brief(full)
        self.assertEqual(compact["metrics"], full["metrics"])
        self.assertEqual(compact["holdings"], full["holdings"])
        self.assertEqual(compact["dailyRollup"]["sections"], full["dailyRollup"]["sections"])
        self.assertEqual(compact["reportRevision"], full["reportRevision"])
        self.assertNotIn("refreshReport", compact)
        self.assertNotIn("citations", compact["dailyRollup"])
        self.assertFalse(compact["citations"][0]["evidenceIncluded"])
        self.assertNotIn("excerpt", compact["citations"][0])
        self.assertNotIn("sourceEvidence", compact["citations"][0])
        self.assertEqual(full["citations"][0], source)

    def test_progressive_compact_post_uses_captured_book_and_lazy_old_post_evidence(self):
        from test_portfolio_review import live_portfolio, position
        runs = {identifier: {"runId": identifier, "state": "running" if identifier == "new" else "succeeded",
                            "reportRevision": identifier, "conversationId": "conversation", "reviewKind": "portfolio-review",
                            "sections": [], "citations": []} for identifier in ("old", "new")}
        sources = {identifier: {"id": "cite_shared", "product": "risk-ranges", "publicationDate": "2026-09-04",
                                "excerpt": f"Evidence from {identifier} capture"} for identifier in runs}
        store = Mock()
        store.get.side_effect = runs.get
        store.read_evidence.side_effect = lambda run, name: live_portfolio([position("IGV", 10, "live", 100)]) if name == "portfolio" else {}
        original = {"id": "conversation", "kind": "portfolio-review", "messages": [
            {"id": identifier + "-post", "role": "assistant", "text": "Original Markdown " + identifier,
             "reviewRunId": identifier, "citations": [sources[identifier]]} for identifier in runs]}
        compact = attach_portfolio_briefs(copy.deepcopy(original), store, lambda value: value, compact=True)
        for post in compact["messages"]:
            self.assertTrue(post["portfolioBrief"]["available"])
            self.assertEqual(post["portfolioBrief"]["metrics"]["grossExposure"], 100)
            self.assertEqual(post["text"], "")
            self.assertFalse(post["reportTextIncluded"])
            ref = post["citations"][0]
            self.assertEqual(ref["captureConversationId"], "conversation")
            self.assertEqual(ref["captureMessageId"], post["id"])
        selected = captured_review_citation(original, store, lambda value: value, "old-post", "cite_shared")
        self.assertEqual(selected, sources["old"])
        self.assertIsNone(captured_review_citation(original, store, lambda value: value, "missing-post", "cite_shared"))
        self.assertIsNone(captured_review_citation(original, store, lambda value: value, "old-post", "missing-citation"))
        self.assertEqual(original["messages"][0]["text"], "Original Markdown old")
        full = attach_portfolio_briefs(copy.deepcopy(original), store, lambda value: value)
        self.assertEqual(full["messages"][0]["text"], "Original Markdown old")
        self.assertNotIn("reportTextIncluded", full["messages"][0])

    def test_scoped_compact_hydrates_one_exact_capture_and_preserves_omitted_post_identity(self):
        runs = {str(index): {"runId": str(index), "state": "running" if index == 4 else "succeeded",
                             "conversationId": "conversation", "reviewKind": "portfolio-review"} for index in range(5)}
        briefs = {identifier: {"available": True, "runId": identifier, "reportRevision": "revision-" + identifier,
                               "metrics": {"grossExposure": int(identifier) + 100}, "holdings": [],
                               "dailyRollup": {"version": 1, "sections": [{"id": "reading", "title": identifier}]},
                               "citations": [{"id": "cite_shared", "product": "risk-ranges", "publicationDate": "2026-09-04",
                                              "excerpt": "Exact evidence " + identifier}]} for identifier in runs}
        hydrated = []

        class Store:
            def find_report_run_ids(self, _conversation_id, _reports):
                return {}

            def get_status(self, identifier):
                return runs.get(identifier)

            def get_portfolio_brief(self, identifier, _projector):
                hydrated.append(identifier)
                return runs[identifier], copy.deepcopy(briefs[identifier])

        original = {"id": "conversation", "kind": "portfolio-review", "messages": [
            {"id": "post-" + identifier, "role": "assistant", "text": "Saved Markdown " + identifier,
             "reviewRunId": identifier, "turn_id": "turn-" + identifier, "state": "reviewing" if identifier == "4" else "complete",
             "created_at": "2026-09-04T14:00:00Z", "citations": briefs[identifier]["citations"]} for identifier in runs]}
        original["messages"] += [{"id": "followup", "role": "assistant", "text": "Ordinary follow-up", "state": "complete"},
                                 {"id": "failed", "role": "assistant", "text": "Refresh interrupted", "state": "failed", "reviewRunId": "4"}]
        latest = attach_portfolio_briefs(copy.deepcopy(original), Store(), lambda value: value, compact=True, brief_scope="latest")
        self.assertEqual(hydrated, ["4"])
        self.assertTrue(latest["messages"][4]["reviewBodyIncluded"])
        self.assertEqual(latest["messages"][4]["portfolioBrief"]["metrics"], briefs["4"]["metrics"])
        self.assertEqual(latest["messages"][4]["portfolioBrief"]["reportRevision"], "revision-4")
        for index in range(4):
            omitted = latest["messages"][index]
            self.assertFalse(omitted["reviewBodyIncluded"])
            for field in ("text", "portfolioBrief", "citations"):
                self.assertNotIn(field, omitted)
            for field in ("id", "reviewRunId", "turn_id", "state", "created_at"):
                self.assertEqual(omitted[field], original["messages"][index][field])
        self.assertEqual(latest["messages"][5:], original["messages"][5:])
        hydrated.clear()
        selected = attach_portfolio_briefs(copy.deepcopy(original), Store(), lambda value: value, compact=True, brief_message_id="post-1")
        self.assertEqual(hydrated, ["1"])
        self.assertEqual(selected["messages"][1]["portfolioBrief"]["reportRevision"], "revision-1")
        self.assertEqual(selected["messages"][1]["portfolioBrief"]["metrics"], briefs["1"]["metrics"])
        self.assertEqual(selected["messages"][1]["portfolioBrief"]["citations"][0]["captureMessageId"], "post-1")
        self.assertEqual(original["messages"][1]["text"], "Saved Markdown 1")

    def test_exact_compact_selector_rejects_unknown_foreign_and_nonreview_posts_before_hydration(self):
        store = Mock()
        store.get.return_value = {"runId": "foreign", "state": "succeeded", "conversationId": "other",
                                  "reviewKind": "portfolio-review"}
        store.find_report_run_ids.return_value = {}
        conversation = {"id": "conversation", "kind": "portfolio-review", "messages": [
            {"id": "foreign-post", "role": "assistant", "text": "Foreign report", "reviewRunId": "foreign"},
            {"id": "ordinary", "role": "assistant", "text": "Ordinary follow-up"}]}
        for identifier in ("missing", "foreign-post", "ordinary"):
            with self.assertRaises(KeyError):
                attach_portfolio_briefs(copy.deepcopy(conversation), store, lambda value: value,
                                        compact=True, brief_message_id=identifier)
        store.read_evidence.assert_not_called()
        with self.assertRaises(ValueError):
            attach_portfolio_briefs(copy.deepcopy(conversation), store, lambda value: value,
                                    compact=True, brief_scope="latest", brief_message_id="foreign-post")
        with self.assertRaises(ValueError):
            attach_portfolio_briefs(copy.deepcopy(conversation), store, lambda value: value, compact=True, brief_scope="all")
        with self.assertRaises(KeyError):
            attach_portfolio_briefs({**conversation, "kind": "chat"}, store, lambda value: value,
                                    compact=True, brief_message_id="foreign-post")

    def test_saved_brief_memo_reuses_only_verified_unchanged_capture(self):
        from portfolio_capture import project_portfolio_context
        from review_runs_v2 import ReviewRunV2Store
        from test_portfolio_review import live_portfolio, position
        with tempfile.TemporaryDirectory() as directory:
            store = ReviewRunV2Store(Path(directory) / "reviews.sqlite3")
            run, _ = store.create(review_kind="portfolio-review", conversation_id="conversation", request_id="saved")
            fingerprint, _ = store.store_evidence("portfolio", live_portfolio([position("IGV", 10, "live", 100)]))
            store.update(run["runId"], state="running", sourceFingerprints={"portfolio": fingerprint}, reportMarkdown="First primary report")
            with patch("portfolio_brief.build_captured_portfolio_brief", wraps=build_captured_portfolio_brief) as build:
                first_identity, first = store.get_portfolio_brief(run["runId"], project_portfolio_context)
                self.assertTrue(first["available"])
                first["metrics"]["grossExposure"] = -1
                _, reopened = store.get_portfolio_brief(run["runId"], project_portfolio_context)
                self.assertEqual(reopened["metrics"]["grossExposure"], 100)
                self.assertEqual(build.call_count, 1, "reopening must not rebuild the saved presentation")
                store.update(run["runId"], reportMarkdown="Second progressive report")
                second_identity, second = store.get_portfolio_brief(run["runId"], project_portfolio_context)
                self.assertNotEqual(second_identity["reportRevision"], first_identity["reportRevision"])
                self.assertEqual(second["metrics"]["grossExposure"], 100)
                self.assertEqual(build.call_count, 2)
                # Warm reads still verify the exact persisted payload bytes.
                with store.connect() as connection:
                    connection.execute("UPDATE analyst_review_evidence_v2 SET payload_json='{}' WHERE fingerprint=?", (fingerprint,))
                rejected_identity, rejected = store.get_portfolio_brief(run["runId"], project_portfolio_context)
                self.assertNotEqual(rejected_identity["reportRevision"], second_identity["reportRevision"])
                self.assertEqual(rejected["reportRevision"], rejected_identity["reportRevision"])
                self.assertFalse(rejected["available"])
                self.assertEqual(rejected["metrics"], {})
                self.assertEqual(build.call_count, 3)
                # A failed attempt keeps presenting the partial revision it had
                # already published (deadline failures keep their report); an
                # attempt that failed before publishing one stays hidden.
                store.update(run["runId"], state="failed")
                failed_identity, failed = store.get_portfolio_brief(run["runId"], project_portfolio_context)
                self.assertEqual(failed_identity["state"], "failed")
                self.assertEqual(failed_identity["reportRevision"], rejected_identity["reportRevision"])
                self.assertEqual(failed, rejected)
                unpublished, _ = store.create(review_kind="portfolio-review", conversation_id="conversation", request_id="unpublished")
                store.update(unpublished["runId"], state="failed")
                self.assertIsNone(store.get_portfolio_brief(unpublished["runId"], project_portfolio_context))

    def test_failed_attempt_keeps_its_published_partial_brief_with_one_status_line(self):
        from portfolio_capture import project_portfolio_context
        from review_runs_v2 import ReviewRunV2Store
        from test_portfolio_review import live_portfolio, position
        status = ("Review interrupted: the server deadline passed before every source finished. "
                  "Refresh to retry with fresh evidence.")
        one_line = ("Review interrupted: The review did not finish within its server deadline. "
                    "Open today’s review to retry with fresh evidence.")
        with tempfile.TemporaryDirectory() as directory:
            store = ReviewRunV2Store(Path(directory) / "reviews.sqlite3")

            def attempt(request, state, report=None):
                run, _ = store.create(review_kind="portfolio-review", conversation_id="conversation", request_id=request)
                fingerprint, _ = store.store_evidence("portfolio", live_portfolio([position("IGV", 10, "live", 100)]))
                store.update(run["runId"], state="running", sourceFingerprints={"portfolio": fingerprint},
                             **({"reportMarkdown": report} if report else {}))
                store.update(run["runId"], state=state, phase="terminal", outcome="blocked",
                             errorCode="REVIEW_DEADLINE_EXCEEDED")
                return run["runId"]

            partial = attempt("partial", "failed", "# Published partial\n")
            unpublished = attempt("unpublished", "failed")
            stopped = attempt("stopped", "cancelled", "# Stopped partial\n")
            original = {"id": "conversation", "kind": "portfolio-review", "messages": [
                {"id": "stopped-post", "role": "assistant", "state": "interrupted", "reviewRunId": stopped,
                 "text": "# Stopped partial", "citations": []},
                {"id": "unpublished-post", "role": "assistant", "state": "failed", "reviewRunId": unpublished,
                 "text": one_line, "citations": []},
                {"id": "partial-post", "role": "assistant", "state": "failed", "reviewRunId": partial,
                 "text": "# Published partial\n\n" + status, "citations": []}]}

            full = attach_portfolio_briefs(copy.deepcopy(original), store, project_portfolio_context)["messages"]
            self.assertTrue(full[2]["portfolioBrief"]["available"])
            self.assertEqual(full[2]["portfolioBrief"]["metrics"]["grossExposure"], 100)
            self.assertEqual(full[2]["reviewStatusLine"], status)
            self.assertEqual(full[2]["text"], original["messages"][2]["text"])
            # No published revision, or a Stop: today's presentation is unchanged.
            self.assertEqual(full[:2], original["messages"][:2])

            for selection in ({"brief_scope": "latest"}, {"brief_message_id": "partial-post"}):
                with self.subTest(selection=selection):
                    compact = attach_portfolio_briefs(copy.deepcopy(original), store, project_portfolio_context,
                                                      compact=True, **selection)["messages"]
                    self.assertTrue(compact[2]["reviewBodyIncluded"])
                    self.assertTrue(compact[2]["portfolioBrief"]["available"])
                    self.assertEqual(compact[2]["reviewStatusLine"], status)
                    self.assertEqual(compact[2]["text"], "")
                    self.assertEqual(compact[:2], original["messages"][:2])
            for identifier in ("stopped-post", "unpublished-post"):
                with self.assertRaises(KeyError):
                    attach_portfolio_briefs(copy.deepcopy(original), store, project_portfolio_context,
                                            compact=True, brief_message_id=identifier)

    def test_deadline_after_published_progress_keeps_the_same_workspace_post_and_partial_brief(self):
        from portfolio_capture import project_portfolio_context
        from review_runs_v2 import ReviewRunV2Store
        from test_portfolio_review import live_portfolio, position
        from workspace import WorkspaceStore
        status = ("Review interrupted: the server deadline passed before every source finished. "
                  "Refresh to retry with fresh evidence.")
        with tempfile.TemporaryDirectory() as directory:
            store = ReviewRunV2Store(Path(directory) / "reviews.sqlite3")
            workspace = WorkspaceStore(Path(directory) / "workspace.sqlite3")
            cid = workspace.dispatch("daily", {"kind": "portfolio-review", "date": "2026-10-09",
                                               "title": "Portfolio Review"})["conversation"]["id"]
            run, _ = store.create(review_kind="portfolio-review", conversation_id=cid, request_id="deadline")
            run_id = run["runId"]
            accepted = workspace.dispatch("accept", {"conversationId": cid, "requestId": "daily-turn:" + run_id,
                                                     "text": "Run review", "internalPrompt": True, "reviewPostId": run_id})
            workspace.dispatch("setting", {"key": "daily-run:" + cid, "value": {"runId": run_id, "turnId": accepted["turn"]["id"]}})
            workspace.dispatch("setting", {"key": f"review-post:{cid}:{run_id}", "value": {"runId": run_id}})
            fingerprint, _ = store.store_evidence("portfolio", live_portfolio([position("IGV", 10, "live", 100)]))
            published = store.update(run_id, state="running", sourceFingerprints={"portfolio": fingerprint},
                                     reportMarkdown="# Published partial\n")
            workspace.dispatch("frame", {"turnId": accepted["turn"]["id"], "type": "progress", "runId": run_id,
                                         "text": published["reportMarkdown"], "citations": [],
                                         "reportRevision": published["reportRevision"]})
            store.update(run_id, state="failed", phase="terminal", outcome="blocked", errorCode="REVIEW_DEADLINE_EXCEEDED")
            workspace.dispatch("frame", {"turnId": accepted["turn"]["id"], "type": "failed", "citations": [],
                                         "text": "Review interrupted: The review did not finish within its server deadline.",
                                         "partialStatus": status})
            conversation = workspace.dispatch("get", {"conversationId": cid})["conversation"]
            [post] = [message for message in conversation["messages"] if message["role"] == "assistant"]
            self.assertEqual(post["text"], "# Published partial\n\n" + status)
            projected = attach_portfolio_briefs(conversation, store, project_portfolio_context,
                                                compact=True, brief_scope="latest")
            [post] = [message for message in projected["messages"] if message["role"] == "assistant"]
            self.assertEqual((post["reviewRunId"], post["reviewState"]), (run_id, "failed"))
            self.assertTrue(post["reviewBodyIncluded"])
            self.assertTrue(post["portfolioBrief"]["available"])
            self.assertEqual(post["portfolioBrief"]["metrics"]["grossExposure"], 100)
            self.assertEqual(post["reviewStatusLine"], status)
            # The saved capture itself is untouched by the failure and its display.
            self.assertEqual(store.get(run_id)["reportMarkdown"], "# Published partial\n")
            self.assertEqual(store.get(run_id)["reportRevision"], published["reportRevision"])

    def test_custom_projectors_never_borrow_another_projectors_cached_metrics(self):
        from portfolio_capture import project_portfolio_context
        from review_runs_v2 import ReviewRunV2Store
        from test_portfolio_review import live_portfolio, position
        with tempfile.TemporaryDirectory() as directory:
            store = ReviewRunV2Store(Path(directory) / "reviews.sqlite3")
            run, _ = store.create(review_kind="portfolio-review", conversation_id="conversation", request_id="custom")
            fingerprint, _ = store.store_evidence("portfolio", live_portfolio([position("IGV", 10, "live", 100)]))
            store.update(run["runId"], state="running", sourceFingerprints={"portfolio": fingerprint})
            store.get_compact_portfolio_brief(run["runId"], project_portfolio_context)
            _, first = store.get_compact_portfolio_brief(run["runId"], lambda value: project_portfolio_context(value))
            _, second = store.get_compact_portfolio_brief(run["runId"], lambda _value: {})
            self.assertTrue(first["available"])
            self.assertEqual(first["metrics"]["grossExposure"], 100)
            self.assertFalse(second["available"])
            self.assertEqual(second["metrics"], {})
            self.assertEqual(len(store._portfolio_brief_projections), 1, "only the canonical projector may retain a memo")

    def test_compact_cache_retains_exact_primary_and_cold_alignment_is_built_once(self):
        from portfolio_capture import project_portfolio_context
        from portfolio_position_alignment import build_position_alignment_sections
        from review_runs_v2 import ReviewRunV2Store
        from test_position_alignment_integration import capture, intelligence as captured_intelligence, rollup, CUTOFF

        with tempfile.TemporaryDirectory() as directory:
            store = ReviewRunV2Store(Path(directory) / "reviews.sqlite3")
            run, _ = store.create(review_kind="portfolio-review", conversation_id="conversation", request_id="compact")
            evidence = {"portfolio": capture(), "heldResearchEvents": captured_intelligence(),
                        "dailyResearch": {"date": CUTOFF[:10], "snapshots": {}}}
            names = ("portfolio", "portfolioBalance", "portfolioReference", "heldResearchEvents", "portfolioSizing", "portfolioOpenOrders", "dailyResearch")
            for name in names:
                evidence.setdefault(name, {"captureSource": name})
                evidence[name]["rawCapturePadding"] = "x" * 32768
            fingerprints = {name: store.store_evidence(name, value)[0] for name, value in evidence.items()}
            store.update(run["runId"], state="succeeded", sections=[{"id": "portfolio-research-review", "dailyRollup": rollup()}],
                         sourceFingerprints=fingerprints,
                         dependencies={name: {"fingerprint": value, "asOf": CUTOFF, "status": "ready"} for name, value in fingerprints.items()})
            # The old path hydrates the export and then builds the full brief.
            expected = compact_portfolio_brief(build_captured_portfolio_brief(store.get(run["runId"]), evidence, project_portfolio_context))
            store._saved_prediction_projections.clear()
            with patch("portfolio_position_alignment.build_position_alignment_sections", wraps=build_position_alignment_sections) as alignment:
                identity, actual = store.get_compact_portfolio_brief(run["runId"], project_portfolio_context)
            expected["reportRevision"] = identity["reportRevision"]
            self.assertEqual(actual, expected)
            self.assertEqual(alignment.call_count, 1, "one verified alignment feeds both export hydration and compact primary")
            self.assertTrue(actual["available"])
            self.assertTrue(actual["citations"])
            self.assertNotIn("rawCapturePadding", str(list(store._portfolio_brief_projections.values())))

            statements = []
            connect = store.connect
            def observed_connect():
                connection = connect()
                connection.set_trace_callback(statements.append)
                return connection
            conversation = {"id": "conversation", "kind": "portfolio-review", "messages": [
                {"id": "post", "role": "assistant", "state": "complete", "reviewRunId": run["runId"], "text": "Stored original"}]}
            with patch.object(store, "connect", side_effect=observed_connect), \
                    patch.object(store, "_decode_saved_evidence_payload", side_effect=AssertionError("Warm compact read decoded a blob")), \
                    patch("portfolio_brief.build_captured_portfolio_brief", side_effect=AssertionError("Warm compact read rebuilt primary")), \
                    patch("portfolio_brief.deepcopy", side_effect=AssertionError("Owned compact primary was copied twice")):
                attached = attach_portfolio_briefs(copy.deepcopy(conversation), store, project_portfolio_context, compact=True, brief_scope="latest")
            self.assertEqual(len([statement for statement in statements if "SELECT payload_json" in statement]), len(names))
            first = attached["messages"][0]["portfolioBrief"]
            first["metrics"]["grossExposure"] = -1
            first["dailyRollup"]["sections"].clear()
            _, reopened = store.get_compact_portfolio_brief(run["runId"], project_portfolio_context)
            self.assertEqual(reopened, actual)

            with store.connect() as connection:
                connection.execute("UPDATE analyst_review_evidence_v2 SET payload_json=payload_json || ' ' WHERE source_name='heldResearchEvents'")
            rejected_identity, rejected = store.get_compact_portfolio_brief(run["runId"], project_portfolio_context)
            self.assertNotEqual(rejected_identity["reportRevision"], identity["reportRevision"])
            self.assertTrue(rejected["available"], "rejected research must not discard independent verified book metrics")
            self.assertFalse(rejected["coverageComplete"])
            with store.connect() as connection:
                connection.execute("UPDATE analyst_review_evidence_v2 SET payload_json='{}' WHERE source_name='portfolio'")
            _, unavailable = store.get_compact_portfolio_brief(run["runId"], project_portfolio_context)
            self.assertFalse(unavailable["available"])
            self.assertEqual(unavailable["metrics"], {})
            for index in range(6):
                next_run, _ = store.create(review_kind="portfolio-review", conversation_id="conversation", request_id=f"bounded-{index}")
                store.update(next_run["runId"], state="succeeded", sourceFingerprints=fingerprints)
                store.get_compact_portfolio_brief(next_run["runId"], project_portfolio_context)
            self.assertEqual(len(store._portfolio_brief_projections), 4)

    def test_duplicate_compact_posts_have_independent_primary_and_exact_citation_bindings(self):
        source = {"id": "cite_captured", "product": "risk-ranges", "publicationDate": "2026-09-04", "excerpt": "Exact evidence"}
        class Store:
            def get_compact_portfolio_brief(self, identifier, _projector):
                return ({"runId": identifier, "state": "succeeded", "conversationId": "conversation", "reviewKind": "portfolio-review"},
                        {"presentation": "compact", "available": True, "metrics": {"grossExposure": 123},
                         "citations": [{**source, "evidenceIncluded": False}]})
        conversation = {"id": "conversation", "kind": "portfolio-review", "messages": [
            {"id": f"post-{index}", "role": "assistant", "reviewRunId": "same-run", "text": "Captured original"} for index in range(2)]}
        attached = attach_portfolio_briefs(conversation, Store(), lambda value: value, compact=True)
        first, second = [message["portfolioBrief"] for message in attached["messages"]]
        self.assertEqual(first["citations"][0]["captureMessageId"], "post-0")
        self.assertEqual(second["citations"][0]["captureMessageId"], "post-1")
        first["metrics"]["grossExposure"] = -1
        first["citations"][0]["publicationDate"] = "Changed in one post"
        self.assertEqual(second["metrics"]["grossExposure"], 123)
        self.assertEqual(second["citations"][0]["publicationDate"], source["publicationDate"])

    def test_holding_names_come_only_from_captured_identity(self):
        book = metrics()
        book["positions"][0].update(conId=123, longName="  iShares   Expanded Tech-Software Sector ETF ")
        row = rule_holdings(book, intelligence())[0]
        self.assertEqual(row["securityName"], "iShares Expanded Tech-Software Sector ETF")
        self.assertEqual(row["conId"], 123)
        self.assertIsNone(captured_security_name({"symbol": "IGV", "description": "IGV"}))
        self.assertIsNone(captured_security_name({"symbol": "IGV", "name": {"unexpected": "value"}}))
        captured = intelligence()
        captured["bySymbol"]["IGV"]["securityName"] = "Name from captured research identity"
        self.assertEqual(rule_holdings(metrics(), captured)[0]["securityName"], "Name from captured research identity")
        self.assertIsNone(rule_holdings(metrics(), intelligence())[0]["securityName"])

    def test_saved_pca_section_survives_daily_research_reprojection(self):
        pca = {"id": "pca-risk", "title": "PCA risk", "asOf": "2026-09-17", "snapshotId": "original-capture",
               "blocks": [{"type": "paragraph", "text": "Captured portfolio · Sep 17, 2026", "citationIds": []}]}
        run = {"runId": "pca", "state": "succeeded", "createdAt": "2026-09-18T15:00:00Z",
               "sections": [{"id": "portfolio-research-review", "dailyRollup": {"version": 1, "sections": [pca]}}]}
        brief = build_portfolio_brief(run, metrics(), {}, daily_research={"date": "2026-09-18", "snapshots": {}})
        self.assertEqual(brief["dailyRollup"]["sections"][0], pca)

    def test_saved_rollup_fixes_storage_aliases_from_its_own_captured_publication(self):
        run = {"runId": "gold", "state": "succeeded", "createdAt": "2026-09-18T15:00:00Z",
               "sections": [{"id": "portfolio-research-review", "dailyRollup": {"version": 1, "sections": []}}]}
        def snapshot(day, low):
            return {"date": day, "publishedAt": f"{day}T12:00:00Z", "data": [{"ticker": "GLD", "originalName": "Gold Spot Price", "lrr": low, "hrr": 4400, "trend": "NEUTRAL"}]}
        evidence = {"date": "2026-09-18", "snapshots": {"risk-ranges": snapshot("2026-09-18", 4250)},
                    "previousSnapshots": {"risk-ranges": snapshot("2026-09-17", 4240)}}
        brief = build_portfolio_brief(run, metrics(), {}, daily_research=evidence)
        cells = [row["cells"] for section in brief["dailyRollup"]["sections"] for block in section["blocks"]
                 if block["type"] == "table" for row in block["rows"]]
        self.assertTrue(any(row[:2] == ["—", "Gold Spot Price"] for row in cells))
        self.assertFalse(any(row[0] == "GLD" for row in cells))
        self.assertEqual(evidence["snapshots"]["risk-ranges"]["data"][0]["ticker"], "GLD")

    def test_saved_structure_metrics_rebuild_from_original_capture_and_cutoff(self):
        from review_runs_v2 import ReviewRunV2Store

        chart = "a" * 64
        metric_source = {"chartId": chart, "chartDate": "2026-06-03",
                         "extractionBasis": "labeled-chart-ocr",
                         "parserVersion": "market-structure-chart-metrics-v3"}
        publication = {"snapshotType": "market-structure", "date": "2026-06-04",
                       "publishedAt": "2026-06-04T12:00:00Z",
                       "schemaVersion": "market-structure-v4", "contentComplete": True,
                       "article": {"bodyText": "Gamma exposure remains Neutral.",
                                   "feedUrl": "https://app.hedgeye.com/feed_items/12345"},
                       "data": {"signals": [{"label": "SPX Gamma Exposure", "value": "Neutral"}],
                                "charts": [{"id": chart, "sha256": chart}],
                                "chartMetrics": {
                                    "spxGammaVolatilityThrottle": {**metric_source, "gammaThrottle": .12,
                                                                    "tenDayRealizedVolatility": 10.71},
                                    "spxProbableVolatilityGamma": {**metric_source, "zeroGamma": 7649,
                                                                   "lowerPvBand": 7492, "upperPvBand": 7734,
                                                                   "strikesInPlay": [7500, 7550, 7600, 7650, 7700]}}}}
        captured = {"date": "2026-06-04", "marketStructure": publication,
                    "snapshots": {"top-3-things": {
                        "date": "2026-06-04", "publishedAt": "2026-06-04T18:00:00Z",
                        "data": {"items": [{"title": "Later publication", "body": "Outside the original cutoff."}]}}}}
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "reviews.sqlite3"
            store = ReviewRunV2Store(database)
            run, _ = store.create(review_kind="portfolio-review", conversation_id="conversation", request_id="original")
            fingerprint, _ = store.store_evidence("dailyResearch", captured)
            saved = store.update(run["runId"], state="succeeded",
                                 sourceFingerprints={"dailyResearch": fingerprint},
                                 dependencies={"dailyResearch": {"status": "ready", "asOf": "2026-06-04T17:00:00Z"}},
                                 reportMarkdown="Original saved review",
                                 sections=[{"id": "portfolio-research-review", "dailyRollup": {"version": 1, "sections": []}}])
            # A newer publication in the same durable store must not change the
            # older post's readings, dates, citation, or acquisition cutoff.
            later = copy.deepcopy(captured)
            later["date"] = later["marketStructure"]["date"] = "2026-06-05"
            later["marketStructure"]["publishedAt"] = "2026-06-05T12:00:00Z"
            later["marketStructure"]["data"]["chartMetrics"]["spxGammaVolatilityThrottle"].update(
                gammaThrottle=.99, chartDate="2026-06-04")
            store.store_evidence("dailyResearch", later)
            reopened = ReviewRunV2Store(database)
            conversation = {"id": "conversation", "kind": "portfolio-review", "messages": [
                {"role": "assistant", "text": saved["reportMarkdown"], "reviewRunId": saved["runId"]}]}
            message = attach_portfolio_briefs(conversation, reopened, lambda value: value)["messages"][0]
            rollup = message["portfolioBrief"]["dailyRollup"]
            section = next(row for row in rollup["sections"] if row["id"] == "market-structure")
            cells = [row["cells"] for block in section["blocks"] if block["type"] == "table" for row in block["rows"]]
            displayed = str(section)
            self.assertTrue(any("0.12" in row for row in cells))
            self.assertTrue(any("7,649" in row for row in cells))
            self.assertIn("10.71", displayed)
            self.assertIn("7,492", displayed)
            self.assertIn("7,734", displayed)
            self.assertIn("Jun 3, 2026", displayed)
            self.assertIn("Jun 4, 2026", displayed)
            self.assertNotIn("0.99", displayed)
            self.assertNotIn("Outside the original cutoff", str(rollup))
            citation = next(row for row in rollup["citations"] if row["product"] == "market-structure")
            self.assertEqual(citation["publicationDate"], "2026-06-04")
            self.assertIn("0.12", citation["excerpt"])
            self.assertIn("Jun 3, 2026", citation["excerpt"])
            self.assertEqual(message["text"], "Original saved review")
            self.assertEqual(reopened.read_evidence(saved, "dailyResearch"), captured)
            self.assertEqual(reopened.get(saved["runId"]), saved)

    def test_identical_posts_attach_their_own_run_and_never_guess_an_ambiguous_legacy_post(self):
        older = {"runId": "older", "state": "succeeded", "reportMarkdown": "# Portfolio Review",
                 "conversationId": "review", "reviewKind": "portfolio-review",
                 "sections": [{"id": "portfolio-research-review", "dailyRollup": {"version": 1, "sections": [{"title": "Original research"}]}}]}
        newer = {**older, "runId": "newer", "sections": []}
        store = Mock()
        store.get.side_effect = lambda identifier: {"older": older, "newer": newer}.get(identifier)
        store.find_report_run_ids.return_value = {"# Portfolio Review": ["older", "newer"]}
        store.read_evidence.return_value = {}
        conversation = {"id": "review", "kind": "portfolio-review", "messages": [
            {"role": "assistant", "text": "# Portfolio Review", "reviewRunId": "older"},
            {"role": "assistant", "text": "# Portfolio Review", "reviewRunId": "newer"},
            {"role": "assistant", "text": "# Portfolio Review"}]}
        restored = attach_portfolio_briefs(conversation, store, lambda value: value)["messages"]
        self.assertEqual(restored[0]["portfolioBrief"]["runId"], "older")
        self.assertEqual(restored[0]["portfolioBrief"]["dailyRollup"]["sections"][0]["title"], "Original research")
        self.assertEqual(restored[1]["portfolioBrief"]["runId"], "newer")
        self.assertNotIn("portfolioBrief", restored[2])
        store.list_for_conversation.assert_not_called()
        self.assertEqual([call.args[0] for call in store.get.call_args_list], ["older", "newer"])

    def test_bound_posts_read_only_their_own_runs_and_reuse_each_brief_within_the_response(self):
        run = {"runId": "visible", "state": "succeeded", "reportMarkdown": "Captured report", "sections": [],
               "conversationId": "conversation", "reviewKind": "portfolio-review"}
        unrelated = {**run, "runId": "forged", "conversationId": "another-conversation"}
        store = Mock()
        store.get.side_effect = lambda identifier: {"visible": run, "forged": unrelated}.get(identifier)
        store.read_evidence.return_value = {}
        conversation = {"id": "conversation", "kind": "portfolio-review", "messages": [
            {"role": "assistant", "text": "Captured report", "reviewRunId": "visible"},
            {"role": "assistant", "text": "Captured report", "reviewRunId": "visible"},
            {"role": "assistant", "text": "Forged report", "reviewRunId": "forged"},
            {"role": "user", "text": "Unrelated user text"}]}
        restored = attach_portfolio_briefs(conversation, store, lambda value: value)["messages"]
        self.assertEqual([call.args[0] for call in store.get.call_args_list], ["visible", "forged"])
        store.list_for_conversation.assert_not_called()
        store.find_report_run_ids.assert_not_called()
        self.assertEqual(restored[0]["portfolioBrief"], restored[1]["portfolioBrief"])
        restored[0]["portfolioBrief"]["metrics"]["changed"] = True
        self.assertNotIn("changed", restored[1]["portfolioBrief"]["metrics"])
        self.assertNotIn("portfolioBrief", restored[2])
        self.assertTrue(all(call.args[0]["runId"] == "visible" for call in store.read_evidence.call_args_list))
        source_names = [call.args[1] for call in store.read_evidence.call_args_list]
        self.assertEqual(len(source_names), len(set(source_names)))

    def test_quad_scenarios_need_explicit_cited_forward_looking_research(self):
        def docs(text):
            return {"products": [{"product": "the-call", "publicationDate": "2026-09-04", "excerpts": [{"excerpt": text, "citation": {"id": "call", "publicationDate": "2026-09-04"}}]}]}
        outlook = quad_outlook(docs("The U.S. economy is expected to shift from Quad 2 to Quad 3."))
        self.assertEqual((outlook["from"], outlook["to"], outlook["status"]), (2, 3, "scenario"))
        self.assertEqual(quad_outlook(docs("Inflation Nowcast raises the probability of back-to-back Monthly Quad 2s."))["to"], 2)
        self.assertIsNone(quad_outlook(docs("For example, in July we expected Quad 4.")))
        self.assertIsNone(quad_outlook(docs("China is expected to shift from Quad 2 to Quad 3.")))
        self.assertIsNone(quad_outlook(docs("VIEW LARGER IMAGE Quad 2 shift")))
        self.assertIsNone(quad_outlook(docs("July Quad 4 weakness improved; September's setup is shifting toward inflation.")))
        outlook = quad_outlook(docs("The initial September Quad 1 setup is now more likely to be Quad 2, with October also likely Quad 2."))
        self.assertEqual((outlook["from"], outlook["to"]), (1, 2))

    def test_historical_research_uses_only_verified_undeleted_captures(self):
        valid = {"runId": "older", "conversationId": "kept", "reviewKind": "portfolio-review", "state": "succeeded", "completedAt": "2026-09-02T21:25:00Z",
                 "dependencies": {"portfolio": {"status": "ready", "asOf": "2026-09-02T21:24:00Z", "detail": {"liveVerified": True}}}}
        removed = {**valid, "runId": "deleted", "conversationId": "deleted"}
        offline = {**valid, "runId": "offline", "dependencies": {"portfolio": {"status": "failed"}}}
        store = Mock()
        store.list_portfolio_reference_candidates.return_value = [removed, offline, valid]
        store.read_evidence.return_value = {"liveVerified": True, "freshness": "live", "asOf": "2026-09-02T21:24:00Z"}
        result = latest_verified_portfolio(store, lambda cid: cid == "deleted")
        # Lightweight candidate rows only: hydrating 500 full reports stalled
        # a failed review's finalization for many seconds.
        store.list_recent.assert_not_called()
        self.assertEqual(result["runId"], "older")
        self.assertTrue(result["verifiedAtCapture"])
        store.read_evidence.return_value["freshness"] = "cache-only"
        self.assertIsNone(latest_verified_portfolio(store, lambda cid: cid == "deleted"))

    def test_partial_valuation_keeps_the_latest_verified_historical_book(self):
        def run(name, day, status="partial", verified=True):
            return {"runId": name, "conversationId": name, "reviewKind": "portfolio-review", "state": "succeeded",
                    "completedAt": f"2026-09-{day:02d}T21:25:00Z", "dependencies": {"portfolio": {
                        "status": status, "asOf": f"2026-09-{day:02d}T21:24:00Z", "detail": {"liveVerified": verified}}}}
        latest = run("latest", 4)
        store = Mock()
        store.list_portfolio_reference_candidates.return_value = [run("older", 2, "ready"), latest, run("unverified", 5, verified=False), run("deleted", 6)]
        portfolio = {"status": "partial", "liveVerified": True, "freshness": "live", "asOf": "2026-09-04T21:24:00Z"}
        balance = {"asOf": "2026-09-04T21:24:00Z", "capture": "original-balance"}
        store.read_evidence.side_effect = lambda _, source: {"portfolio": portfolio, "portfolioBalance": balance}.get(source)
        result = latest_verified_portfolio(store, lambda cid: cid == "deleted")
        self.assertEqual(result["runId"], "latest")
        self.assertEqual(result["asOf"], "2026-09-04T21:24:00Z")
        self.assertEqual(result["balance"], balance)
        self.assertEqual(store.read_evidence.call_args_list, [((latest, "portfolio"),), ((latest, "portfolioBalance"),)])

    def test_nlv_weights_independent_signals_and_verified_previous_values(self):
        rows = rule_holdings(metrics(), intelligence())
        self.assertEqual(rows[0]["weightPct"], 4)
        self.assertEqual(rows[0]["priorSignals"]["trend"], "BULLISH")
        self.assertIsNone(rows[0]["priorSignals"]["trade"])
        self.assertEqual(rows[0]["sources"]["trend"]["publishedAt"], "2026-09-04T14:30:00Z")
        self.assertEqual(rows[0]["sizingInputs"], {})
        unavailable = metrics()
        unavailable["positions"][0]["markState"] = "unavailable"
        self.assertIsNone(rule_holdings(unavailable, intelligence())[0]["weightPct"])
        unavailable["available"] = False
        self.assertEqual(rule_holdings(unavailable, intelligence()), [])

    def test_product_listing_does_not_become_a_trade_display_or_rule_signal(self):
        data = intelligence()
        security = data['bySymbol']['IGV']
        security['decision']['trade'] = {'status': 'unavailable', 'value': None}
        security['directReferences'].append({'kind': 'portfolio_solutions_rank', 'productId': 'portfolio-solutions',
            'qualityStatus': 'indexed', 'matchType': 'direct', 'value': 12, 'marketDate': '2026-09-04'})
        result = rule_holdings(metrics(), data)[0]
        self.assertIsNone(result['trade'])
        self.assertEqual(result['trend'], 'NEUTRAL')
        self.assertEqual(result['signalContext']['trade']['status'], 'unavailable')
        self.assertIsNone(result['signalContext']['trade']['value'])
        self.assertNotIn('source', result['signalContext']['trade'])
        self.assertEqual(result['signalContext']['trend']['status'], 'published')
        security['decision']['trade']['status'] = 'conflict'
        self.assertEqual(rule_holdings(metrics(), data)[0]['signalContext']['trade']['status'], 'conflict')
        security['decision']['trade']['status'] = 'unavailable'
        security['directReferences'][-1]['qualityStatus'] = 'failed'
        self.assertEqual(rule_holdings(metrics(), data)[0]['signalContext']['trade']['status'], 'unavailable')

    def test_retained_trade_is_dated_captured_research_and_never_a_current_rule_input(self):
        data = intelligence()
        security = data["bySymbol"]["IGV"]
        security["decision"]["trade"] = {"status": "unavailable", "value": None}
        retained = {"status": "historical", "qualityStatus": "indexed", "value": "BEARISH", "sourceTicker": "IGV",
            "sourceId": "early-look", "sourceLabel": "Early Look", "sourceDate": "2026-09-03", "publishedAt": "2026-09-03T12:00:00Z",
            "sourceUrl": "https://app.hedgeye.com/feed_items/123", "referenceOnly": True, "executable": False, "currentDecisionEligible": False,
            "signalProvenance": {"field": "trade", "method": "explicit-statement", "sourceField": "article.bodyText", "sourceText": "IGV Trade is Bearish."}}
        security["lastVerifiedDecision"] = {"trade": retained}
        original = copy.deepcopy(data)
        row = rule_holdings(metrics(), data)[0]
        display = row["researchSignals"]["trade"]
        self.assertIsNone(row["trade"])
        self.assertEqual(row["reasonCode"], "TRADE_UNAVAILABLE")
        self.assertEqual(display["value"], "BEARISH")
        self.assertEqual(display["status"], "historical")
        self.assertFalse(display["currentDecisionEligible"])
        self.assertEqual(display["source"]["publishedAt"], "2026-09-03T12:00:00Z")
        self.assertEqual(display["source"]["citation"]["sourceUri"], retained["sourceUrl"])
        self.assertEqual(display["source"]["citation"]["publicationDate"], "2026-09-03")
        self.assertEqual(data, original)
        for patch in ({"signalProvenance": None}, {"sourceTicker": "XLK"}, {"qualityStatus": "failed"},
                      {"referenceOnly": False}, {"currentDecisionEligible": True}, {"sourceDate": "2026-09-05"},
                      {"sourceUrl": None}, {"stale": True}, {"mock": True}, {"cacheOnly": True}):
            security["lastVerifiedDecision"]["trade"] = {**retained, **patch}
            self.assertEqual(rule_holdings(metrics(), data)[0]["researchSignals"], {}, patch)
        security["lastVerifiedDecision"]["trade"] = retained
        security["decision"]["trade"] = {"status": "conflict", "value": None}
        self.assertEqual(rule_holdings(metrics(), data)[0]["researchSignals"], {})

    def test_stop_evidence_is_attached_to_the_exact_dated_holdings(self):
        from test_portfolio_stops import metrics as stop_metrics, order, snapshot
        book = stop_metrics()
        run = {'runId': 'stop-review', 'state': 'succeeded'}
        result = build_portfolio_brief(run, book, {}, open_orders=snapshot([order()]))
        self.assertEqual(result['holdings'][0]['stopCheck']['status'], 'covered')
        self.assertEqual(result['stopCoverage']['asOf'], book['observedAt'])
        result = build_portfolio_brief(run, book, {})
        self.assertEqual(result['holdings'][0]['stopCheck']['status'], 'unavailable')

    def test_summary_rejects_raw_macro_excerpts_and_caps_explicit_cited_facts(self):
        facts = [{"topic": topic, "text": text, "citationId": "cite_test"} for topic, text in [
            ("USD", "Dollar growth keyword in a newsletter"), ("breadth", "VIEW LARGER IMAGE"),
            ("gammaRegime", '{"apiUrl":"example"}'), ("liquidity", "Copyright © private@example.com"),
            ("breadth", "improving"), ("gammaRegime", "positive"), ("liquidity", "tightening"), ("cta", "long")]]
        result = context_takeaways(facts, True)
        self.assertEqual(len(result), 3)
        self.assertEqual(result[0]["text"], "Equity exposure — market breadth: improving")
        self.assertEqual(context_takeaways(facts, False), [])

    def test_saved_report_projection_keeps_the_archive_immutable(self):
        position = {**metrics()["positions"][0], "securityName": "Captured security name", "conId": 123}
        columns = list(position)
        portfolio = {"liveVerified": True, "freshness": "live", "asOf": "2026-09-04T20:05:00Z", "data": {
            "positionTable": {"columns": columns, "rows": [[position[key] for key in columns]], "rowCount": 1},
            "accountSummaries": [{"NetLiquidation": 100000}],
        }}
        run = {"runId": "run", "state": "succeeded", "reportMarkdown": "Original raw report", "sections": [],
               "conversationId": "conversation", "reviewKind": "portfolio-review"}
        original = copy.deepcopy(run)
        store = Mock()
        store.find_report_run_ids.return_value = {run["reportMarkdown"]: [run["runId"]]}
        store.get.return_value = run
        store.read_evidence.side_effect = lambda _, source: {"portfolio": portfolio, "heldResearchEvents": intelligence()}.get(source)
        conversation = {"id": "conversation", "kind": "portfolio-review", "messages": [{"role": "assistant", "text": run["reportMarkdown"]}]}
        result = attach_portfolio_briefs(conversation, store, lambda value: value)
        self.assertEqual(result["messages"][0]["portfolioBrief"]["holdings"][0]["weightPct"], 4)
        self.assertEqual(result["messages"][0]["portfolioBrief"]["holdings"][0]["securityName"], "Captured security name")
        self.assertEqual(result["messages"][0]["portfolioBrief"]["holdings"][0]["conId"], 123)
        self.assertEqual(run, original)
        self.assertEqual(result["messages"][0]["text"], run["reportMarkdown"])
        self.assertEqual(store.method_calls[0][0], "find_report_run_ids")
        store.list_for_conversation.assert_not_called()

    def test_legacy_partial_book_does_not_republish_a_position_subtotal_as_exposure(self):
        from test_portfolio_review import live_portfolio, position
        portfolio = live_portfolio([
            position("IGV", 10, "live", 8000),
            position("SJM", 10, "unavailable"),
        ], nlv=175487.03)
        run = {"runId": "legacy", "state": "succeeded", "reportMarkdown": "Original saved review", "sections": [
            {"id": "exposure-risk", "factorExposure": {"status": "partial", "coveragePct": 100,
             "rows": [{"label": "Stocks & ETFs", "longPct": 4.56, "shortPct": 0, "netPct": 4.56}]}}],
               "conversationId": "conversation", "reviewKind": "portfolio-review"}
        store = Mock()
        store.get.return_value = run
        store.read_evidence.side_effect = lambda _, source: {"portfolio": portfolio}.get(source)
        conversation = {"id": "conversation", "kind": "portfolio-review", "messages": [
            {"role": "assistant", "text": run["reportMarkdown"], "reviewRunId": run["runId"]}]}
        result = attach_portfolio_briefs(conversation, store, lambda value: value)
        brief = result["messages"][0]["portfolioBrief"]
        self.assertTrue(brief["available"])
        self.assertEqual(brief["metrics"]["netLiquidation"], 175487.03)
        for key in ("grossExposure", "netExposure", "longMarketValue", "shortMarketValue", "grossLeverage", "netExposurePctOfNlv"):
            self.assertIsNone(brief["metrics"][key], key)
        self.assertEqual(len(brief["holdings"]), 2)
        self.assertEqual(brief["factorExposure"]["status"], "unavailable")
        self.assertEqual(brief["factorExposure"]["rows"], [])
        self.assertEqual(result["messages"][0]["text"], "Original saved review")

    def test_captured_account_totals_survive_archive_reopen_without_newer_balance(self):
        from review_runs_v2 import ReviewRunV2Store
        from test_portfolio_review import live_portfolio, position, verified_account_balance
        portfolio = live_portfolio([
            position("IGV", 10, "live", 8000),
            position("SJM", 10, "unavailable"),
        ], nlv=175487.03)
        balance = verified_account_balance()
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "reviews.sqlite3"
            store = ReviewRunV2Store(database)
            run, _ = store.create(review_kind="portfolio-review", conversation_id="conversation", request_id="original")
            fingerprints = {name: store.store_evidence(name, evidence)[0] for name, evidence in (
                ("portfolio", portfolio), ("portfolioBalance", balance))}
            saved = store.update(run["runId"], state="succeeded", sourceFingerprints=fingerprints,
                                 reportMarkdown="Original saved review", sections=[])
            # A later account capture in the same evidence store must not
            # replace the earlier report's content-addressed accounting.
            later_balance = verified_account_balance("2026-09-01T14:00:02Z")
            later_balance["data"]["current"]["exposure"]["netLiquidation"] = 999999
            store.store_evidence("portfolioBalance", later_balance)
            reopened = ReviewRunV2Store(database)
            conversation = {"id": "conversation", "kind": "portfolio-review", "messages": [
                {"role": "assistant", "text": saved["reportMarkdown"], "reviewRunId": saved["runId"]}]}
            brief = attach_portfolio_briefs(conversation, reopened, lambda value: value)["messages"][0]["portfolioBrief"]
            self.assertFalse(brief["metrics"]["valuationComplete"])
            self.assertTrue(brief["metrics"]["exposureComplete"])
            self.assertEqual(brief["metrics"]["netLiquidation"], 175487.03)
            self.assertEqual(brief["metrics"]["grossExposure"], 211185.06)
            self.assertEqual(brief["metrics"]["shortMarketValue"], -97075.93)
            self.assertEqual(brief["metrics"]["exposureBasis"], "broker_account")
            self.assertEqual(brief["metrics"]["exposureObservedAt"], balance["asOf"])
            self.assertEqual(reopened.read_evidence(saved, "portfolioBalance"), balance)
            self.assertEqual(reopened.get(saved["runId"]), saved)

    def test_historical_reference_keeps_its_original_account_balance(self):
        from test_portfolio_review import live_portfolio, position, verified_account_balance
        reference = {"verifiedAtCapture": True,
                     "portfolio": live_portfolio([position("IGV", 10, "unavailable")]),
                     "balance": verified_account_balance()}
        run = {"runId": "historical", "state": "succeeded", "reportMarkdown": "Historical review", "sections": [],
               "conversationId": "conversation", "reviewKind": "portfolio-review"}
        store = Mock()
        store.get.return_value = run
        store.read_evidence.side_effect = lambda _, source: {
            "portfolio": {"liveVerified": False, "freshness": "unavailable"},
            "portfolioBalance": verified_account_balance("2026-09-01T14:00:02Z"),
            "portfolioReference": reference,
        }.get(source)
        conversation = {"id": "conversation", "kind": "portfolio-review", "messages": [
            {"role": "assistant", "text": run["reportMarkdown"], "reviewRunId": run["runId"]}]}
        brief = attach_portfolio_briefs(conversation, store, lambda value: value)["messages"][0]["portfolioBrief"]
        self.assertEqual(brief["metrics"]["grossExposure"], 211185.06)
        self.assertEqual(brief["metrics"]["exposureObservedAt"], reference["balance"]["asOf"])

    def test_unavailable_book_reason_comes_from_the_captured_gateway_verdict(self):
        def reason(dependencies):
            run = {"runId": "run", "state": "succeeded", "dependencies": dependencies}
            return build_portfolio_brief(run, {"available": False, "positions": []}, {})["unavailableReason"]

        connected = {"status": "ready", "detail": {"liveVerified": True}}
        # The Gateway verified connected and only the valuation step failed.
        self.assertEqual(reason({"ibGateway": connected, "portfolio": {
            "status": "failed", "errorCode": "REVIEW_SOURCE_UNAVAILABLE"}}), "prices_unverified")
        self.assertEqual(reason({"ibGateway": connected, "portfolio": {
            "status": "failed", "errorCode": "IBKR_HOLDINGS_TIMEOUT"}}), "holdings_unverified")
        self.assertEqual(reason({"ibGateway": {"status": "failed", "errorCode": "IBKR_GATEWAY_NOT_CONNECTED",
                                               "detail": {"liveVerified": False}}}), "gateway_disconnected")
        self.assertEqual(reason({"ibGateway": {"status": "failed", "errorCode": "IBKR_GATEWAY_READINESS_TIMEOUT",
                                               "detail": {"liveVerified": False}}}), "gateway_unverified")
        # Captures saved before the verdict existed keep their presentation.
        self.assertIsNone(reason({"portfolio": {"status": "failed"}}))
        available = build_portfolio_brief({"runId": "run", "state": "succeeded", "dependencies": {"ibGateway": connected}},
                                          metrics(), intelligence())
        self.assertTrue(available["available"])
        self.assertIsNone(available["unavailableReason"])

    def test_failed_or_unverified_snapshots_do_not_expose_values(self):
        brief = build_portfolio_brief({"runId": "failed", "state": "failed"}, metrics(), intelligence())
        self.assertFalse(brief["available"])
        self.assertEqual(brief["metrics"], {})
        self.assertEqual(brief["holdings"], [])


def reference_payload(symbols=("IGV",), now=None):
    from portfolio_sizing import SOURCE
    now = now or datetime.now(timezone.utc)
    close = (now.date() - timedelta(days=3)).isoformat()
    def metric(value, observations):
        return {"value": value, "observations": observations, "asOf": close, "source": SOURCE, "status": "available"}
    return {"source": SOURCE, "status": "available", "historicalOnly": True, "executable": False,
        "completedSession": {"expectedAsOf": close},
        "rows": {symbol: {"symbol": symbol, "source": SOURCE, "status": "available", "historicalOnly": True,
            "executable": False, "instrumentType": "ETF", "asOf": close,
            "beta": metric(1.2, 252), "atr14": metric(1, 14), "referencePrice": metric(100, 1),
            "provenance": {"provider": "Yahoo Finance", "dataset": "chart", "interval": "1d", "adjustedCloseRequired": True,
                "security": {"requestedSymbol": symbol, "fetchedAt": now.isoformat()},
                "benchmark": {"symbol": "SPY", "fetchedAt": now.isoformat()}}} for symbol in symbols}}


class VerifiedSizingInputsTests(unittest.TestCase):
    def test_completed_overseas_session_is_separate_from_us_holiday(self):
        now = datetime(2026, 9, 7, 22, tzinfo=timezone.utc)
        data = reference_payload(now=now)
        row = data['rows']['IGV']
        row['asOf'] = row['referencePrice']['asOf'] = row['atr14']['asOf'] = '2026-09-07'
        row['referencePrice']['timestamp'] = '2026-09-07T08:00:00Z'
        row['provenance']['security'].update(exchangeTimezone='Europe/London', regularSession={
            'start': datetime(2026, 9, 7, 8, tzinfo=timezone.utc).timestamp(),
            'end': datetime(2026, 9, 7, 16, 30, tzinfo=timezone.utc).timestamp()})
        self.assertIsNotNone(verified_sizing_inputs(data, 'IGV', now)['referencePrice'])
        row['provenance']['security']['regularSession']['end'] = now.timestamp() + 3600
        self.assertEqual(verified_sizing_inputs(data, 'IGV', now), {})

    def test_completed_session_metrics_use_independent_dates_and_sources(self):
        now = datetime(2026, 9, 7, 22, tzinfo=timezone.utc)
        data = reference_payload(now=now)
        result = verified_sizing_inputs(data, "IGV", now)
        self.assertEqual(result["beta"]["value"], 1.2)
        self.assertEqual(result["referencePrice"]["asOf"], "2026-09-04")
        self.assertFalse(result["executable"])
        data["rows"]["IGV"]["beta"]["observations"] = 125
        self.assertIsNone(verified_sizing_inputs(data, "IGV", now)["beta"])
        data["rows"]["IGV"]["referencePrice"]["asOf"] = "2026-09-03"
        self.assertIsNone(verified_sizing_inputs(data, "IGV", now)["referencePrice"])

    def test_wrong_identity_future_stale_disconnected_and_mock_sources_are_rejected(self):
        now = datetime(2026, 9, 7, 22, tzinfo=timezone.utc)
        for field, value in [("symbol", "OTHER"), ("instrumentType", "FUTURE"), ("asOf", "2026-09-08"), ("source", "mock"), ("executable", True), ("fromCache", True)]:
            with self.subTest(field=field):
                data = reference_payload(now=now)
                data["rows"]["IGV"][field] = value
                self.assertEqual(verified_sizing_inputs(data, "IGV", now), {})
        data = reference_payload(now=now)
        data["rows"]["IGV"]["provenance"]["security"]["fetchedAt"] = "2026-09-07T20:00:00Z"
        self.assertEqual(verified_sizing_inputs(data, "IGV", now), {})
        data = reference_payload(now=now)
        data["rows"]["IGV"]["provenance"]["benchmark"]["disconnected"] = True
        self.assertIsNone(verified_sizing_inputs(data, "IGV", now)["beta"])


class PortfolioSizingReaderTests(unittest.IsolatedAsyncioTestCase):
    async def test_entire_book_uses_bounded_batches_and_preserves_sourced_inputs(self):
        import asyncio
        seen, active, peak = [], 0, 0
        async def request(symbols):
            nonlocal active, peak
            seen.extend(symbols)
            self.assertLessEqual(len(symbols), 6)
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0)
            active -= 1
            return reference_payload(symbols)
        reader = PortfolioSizingReader("http://api", request)
        symbols = [f"SYM{i}" for i in range(63)]
        result = await reader.read(symbols, datetime.now(timezone.utc).isoformat())
        self.assertEqual(sorted(seen), sorted(symbols))
        self.assertLessEqual(peak, 4)
        self.assertTrue(all(row["beta"]["value"] == 1.2 for row in result["bySymbol"].values()))
        self.assertEqual(len(reader.cache), 63)

    async def test_failure_clears_prior_values_and_next_read_recovers(self):
        from unittest.mock import AsyncMock
        request = AsyncMock(return_value=reference_payload())
        reader = PortfolioSizingReader("http://api", request)
        as_of = datetime.now(timezone.utc).isoformat()
        await reader.read(["IGV"], as_of)
        self.assertIn("IGV", reader.cache)
        request.side_effect = RuntimeError("source unavailable")
        self.assertEqual((await reader.read(["IGV"], as_of))["bySymbol"], {"IGV": {}})
        self.assertNotIn("IGV", reader.cache)
        request.side_effect = None
        await reader.read(["IGV"], as_of)
        self.assertIn("IGV", reader.cache)

    async def test_cached_inputs_are_refreshed_before_thirty_second_scans_reach_expiry(self):
        import asyncio
        from unittest.mock import AsyncMock
        start = datetime.now(timezone.utc)
        clock = {"now": start}
        request = AsyncMock(side_effect=lambda symbols: reference_payload(symbols))
        reader = PortfolioSizingReader("http://api", request, clock=lambda: clock["now"])
        as_of = start.isoformat()
        scans = []
        for scan in range(6):
            clock["now"] = start + timedelta(seconds=30.5 * scan)
            scans.append("IGV" in reader.read_cached(["IGV"], as_of)["bySymbol"])
            await asyncio.gather(*reader.pending.values())
        # Only the cold first scan waits; expiry used to empty every other scan.
        self.assertEqual(scans, [False] + [True] * 5)

    async def test_answer_without_verified_inputs_is_covered_but_failure_is_not(self):
        from unittest.mock import AsyncMock
        request = AsyncMock(return_value={})
        reader = PortfolioSizingReader("http://api", request)
        as_of = datetime.now(timezone.utc).isoformat()
        self.assertEqual(await reader.read_current(["IGV"], as_of), {"bySymbol": {}, "complete": True})
        reader.cache.clear()
        request.side_effect = RuntimeError("source unavailable")
        self.assertEqual(await reader.read_current(["IGV"], as_of), {"bySymbol": {}, "complete": False})

    async def test_failed_batch_does_not_discard_other_securities(self):
        async def request(symbols):
            if "BAD" in symbols:
                raise RuntimeError("source unavailable")
            return reference_payload(symbols)
        reader = PortfolioSizingReader("http://api", request)
        result = await reader.read(["BAD"] + [f"SYM{i}" for i in range(12)], datetime.now(timezone.utc).isoformat())
        self.assertEqual(len(result["bySymbol"]), 13)
        self.assertEqual(sum(bool(value) for value in result["bySymbol"].values()), 7)


if __name__ == "__main__":
    unittest.main()
