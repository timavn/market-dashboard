from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

import httpx


SIDECAR_DIR = Path(__file__).resolve().parent
if str(SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(SIDECAR_DIR))

from market import PREDICTION_TIMEOUT_SECONDS, PREDICTIVE_REVIEW_UNIVERSE, PredictionMarketReader
from review_runs_v2 import (
    DEADLINE_SECONDS,
    MAX_SUMMARY_INPUT_BYTES,
    MAX_REVIEW_CONTEXT_BYTES,
    ReviewCoordinatorV2,
    ReviewExecutionContext,
    ReviewRunError,
    ReviewRunV2Store,
    SUMMARY_TIMEOUT_SECONDS,
    bounded_summary_input,
    canonical_fingerprint,
    coordinator_canary,
    public_review_conversation_detail,
    public_review_conversation_summary,
    public_review_run,
    public_review_run_status,
    review_conversation_id,
    review_context_v2,
    render_portfolio_review,
)


class PortfolioDailyRenderingTests(unittest.TestCase):
    def test_empty_daily_capture_is_explicitly_unavailable(self):
        report = render_portfolio_review([{"id": "portfolio-research-review", "dailyRollup": {"version": 1, "sections": []}}], "blocked")
        self.assertIn("Portfolio values unavailable.", report)
        self.assertIn("Daily research unavailable.", report)
        self.assertNotIn("No confirmed rule violations", report)

    def test_partial_classification_keeps_its_coverage_in_export(self):
        report = render_portfolio_review([
            {"id": "portfolio-research-review", "dailyRollup": {"version": 1, "sections": []}},
            {"id": "exposure-risk", "factorExposure": {"status": "partial", "coveragePct": 40,
                "label": "Asset exposure", "rows": [{"label": "Stocks & ETFs", "longPct": 10, "shortPct": -5, "netPct": 5}]}},
        ], "partial")
        self.assertIn("40.00% of verified gross exposure classified", report)
        self.assertIn("| Stocks & ETFs | 10.00% | -5.00% | 5.00% |", report)

    def test_paused_pca_keeps_a_compact_pending_section_without_hiding_missing_research(self):
        from portfolio_pca_review import paused_portfolio_pca_section

        def report(*research):
            return render_portfolio_review([{"id": "portfolio-research-review", "dailyRollup": {
                "version": 1, "sections": [paused_portfolio_pca_section(), *research]}}], "partial")

        without_research = report()
        self.assertIn("## PCA risk\n\nPending.\n", without_research)
        # The paused stub is not research; its absence is still stated.
        self.assertTrue(without_research.endswith("Pending.\n\nDaily research unavailable.\n"))
        with_research = report({"id": "readings", "title": "Readings",
                                "blocks": [{"type": "paragraph", "text": "Captured reading."}]})
        self.assertIn("## PCA risk\n\nPending.\n\n\n## Readings\n\nCaptured reading.\n", with_research)
        self.assertNotIn("Daily research unavailable.", with_research)
        # A section with captured content renders it, never a Pending line.
        pending_with_content = report({"id": "late", "title": "Late", "status": "pending",
                                       "blocks": [{"type": "paragraph", "text": "Captured late reading."}]})
        self.assertIn("## Late\n\nCaptured late reading.\n", pending_with_content)
        self.assertEqual(pending_with_content.count("Pending."), 1)

    def test_rollups_without_pending_sections_render_exactly_as_before(self):
        # Saved runs never contain a pending rollup section; their export is unchanged.
        sections = [{"id": "pca-risk", "title": "PCA risk", "status": "available", "citationIds": [],
                     "blocks": [{"type": "paragraph", "text": "Captured PCA reading."}]},
                    {"id": "readings", "title": "Readings", "blocks": []}]
        report = render_portfolio_review([{"id": "portfolio-research-review", "dailyRollup": {
            "version": 1, "sections": sections}}], "partial")
        self.assertEqual(report, "\n".join([
            "# Portfolio Review", "", "<!-- analyst-daily-rollup -->", "", "Portfolio values unavailable.", "",
            "", "## PCA risk", "", "Captured PCA reading.", "", "", "## Readings", "",
        ]).strip() + "\n")


def balance_sections() -> list[dict]:
    return [
        {
            "id": "account-summary",
            "title": "Account Summary",
            "status": "ready",
            "current": {
                "accountId": "TEST",
                "currency": "USD",
                "observedAt": "2026-08-31T16:00:00Z",
                "margin": {"netLiquidation": 100_000},
            },
        },
        {
            "id": "margin-capacity",
            "title": "Exposure, Margin & Capacity",
            "status": "ready",
        },
        {"id": "interest-ledger", "title": "Interest", "status": "ready"},
        {"id": "exceptions", "title": "Exceptions", "status": "ready", "items": []},
    ]


async def await_run(coordinator: ReviewCoordinatorV2, run_id: str) -> dict:
    task = coordinator.tasks.get(run_id)
    if task:
        await task
    for _ in range(100):
        run = coordinator.store.get(run_id)
        if run and run["state"] not in {"queued", "running"}:
            return run
        await asyncio.sleep(0.001)
    raise AssertionError("Review did not terminate")


class ReviewRunV2Tests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="review-run-v2-")
        self.store = ReviewRunV2Store(Path(self.temp.name) / "reviews.sqlite3")

    async def asyncTearDown(self):
        self.temp.cleanup()

    async def test_preaccepted_run_identity_is_preserved_and_replays_do_not_duplicate_acquisition(self):
        release = asyncio.Event()
        calls = []

        async def handler(context):
            calls.append(context.run_id)
            await release.wait()
            return {"outcome": "ready", "sections": balance_sections(), "citations": []}

        run_id = str(uuid4())
        coordinator = ReviewCoordinatorV2(self.store, {"balance-review": handler})
        arguments = {"review_kind": "balance-review", "conversation_id": "accepted-chat",
                     "session_id": "accepted-chat", "request_id": "accepted-request", "run_id": run_id}
        try:
            first = await coordinator.start(**arguments)
            replay = await coordinator.start(**arguments)
            self.assertEqual(first["runId"], run_id)
            self.assertEqual(replay["runId"], run_id)
            self.assertEqual(len(coordinator.tasks), 1)
            for changed, code in (({"run_id": str(uuid4())}, "REVIEW_REQUEST_CONFLICT"),
                                  ({"request_id": "another-request"}, "REVIEW_RUN_CONFLICT"),
                                  ({"conversation_id": "another-chat"}, "REVIEW_RUN_CONFLICT"),
                                  ({"session_id": "another-session"}, "REVIEW_REQUEST_CONFLICT")):
                with self.subTest(changed=changed), self.assertRaises(ReviewRunError) as conflict:
                    await coordinator.start(**{**arguments, **changed})
                self.assertEqual(conflict.exception.code, code)
        finally:
            release.set()
            await coordinator.tasks[run_id]
        replay = await coordinator.start(**arguments)
        self.assertEqual(replay["state"], "succeeded")
        self.assertEqual(calls, [run_id])

    def test_preaccepted_run_identity_requires_a_valid_uuid_before_persistence(self):
        for run_id in ("", "not-a-run", 123, ["invalid"]):
            with self.subTest(run_id=run_id), self.assertRaises(ReviewRunError) as invalid:
                self.store.create(review_kind="balance-review", request_id="accepted", run_id=run_id)
            self.assertEqual(invalid.exception.code, "REVIEW_REQUEST_INVALID")
        self.assertEqual(self.store.list_recent(), [])

    def test_prediction_deadline_covers_upstream_acquisition_summary_and_persistence(self):
        self.assertGreaterEqual(
            DEADLINE_SECONDS["prediction-markets-review"],
            PREDICTION_TIMEOUT_SECONDS + SUMMARY_TIMEOUT_SECONDS + 1,
        )

    def test_status_and_source_metadata_do_not_decode_reports_or_hydrate_archives(self):
        run, _ = self.store.create(review_kind="portfolio-review", conversation_id="bound", request_id="cheap-read")
        fingerprint, _ = self.store.store_evidence("portfolio", {"liveVerified": True, "freshness": "live", "asOf": "2026-10-05T14:00:00Z"})
        dependencies = {"portfolio": {"status": "ready", "asOf": "2026-10-05T14:00:00Z",
                                      "detail": {"liveVerified": True}, "fingerprint": fingerprint}}
        saved = self.store.update(run["runId"], state="succeeded", outcome="partial", dependencies=dependencies,
                                 sourceFingerprints={"portfolio": fingerprint}, reportMarkdown="Original captured report",
                                 sections=[{"id": "large", "detail": "evidence" * 10000}], citations=[{"id": "captured"}])
        expected = public_review_run_status(saved)
        with patch.object(self.store, "_decode", side_effect=AssertionError("Cheap metadata must not hydrate a report")), \
                patch.object(self.store, "read_evidence", side_effect=AssertionError("Metadata must not read source blobs")):
            status = self.store.get_status(run["runId"])
            metadata = self.store.get_source_metadata(run["runId"])
            self.assertEqual(public_review_run_status(status), expected)
            self.assertEqual(metadata["dependencies"], dependencies)
            self.assertEqual(metadata["sourceFingerprints"], {"portfolio": fingerprint})
            for value in (status, metadata):
                self.assertNotIn("sections", value)
                self.assertNotIn("citations", value)
                self.assertNotIn("reportMarkdown", value)
                self.assertTrue(value["reportAvailable"])
            self.assertLess(len(json.dumps(status)), 1500)
            self.assertIsNone(self.store.get_status("missing"))
            self.assertIsNone(self.store.get_source_metadata("missing"))
        from analyst_review_sources import review_sources
        self.assertEqual(review_sources(metadata, self.store), review_sources(saved, self.store))

    def test_legacy_report_lookup_returns_only_ids_and_keeps_duplicate_reports_ambiguous(self):
        runs = []
        for cid, request in (("legacy", "first"), ("legacy", "second"), ("other", "other")):
            run, _ = self.store.create(review_kind="portfolio-review", conversation_id=cid, request_id=request)
            self.store.update(run["runId"], state="succeeded", reportMarkdown="  Original report\n", sections=[{"id": "large"}])
            runs.append(run)
        first, second, other = runs
        with patch.object(self.store, "_decode", side_effect=AssertionError("Legacy lookup must not hydrate report archives")):
            matched = self.store.find_report_run_ids("legacy", ["Original report", "Missing"])
        self.assertEqual(set(matched["Original report"]), {first["runId"], second["runId"]})
        self.assertNotIn("Missing", matched)

    async def test_verified_progress_is_partial_revision_then_terminal_capture_without_premature_all_clear(self):
        run, _ = self.store.create(review_kind="balance-review", conversation_id="progress", request_id="progress")
        context = ReviewExecutionContext(self.store, run["runId"], "balance-review")
        await context.checkpoint("balance", status="ready", evidence={"liveVerified": True, "amount": 100}, as_of="2026-10-05T14:00:00Z")
        citations = [{"id": "captured", "sourceUri": "gmail://message/captured", "publicationDate": "2026-10-05"},
                     {"id": "captured", "sourceUri": "gmail://message/captured", "publicationDate": "2026-10-05"},
                     {"id": 123, "sourceUri": "invalid"}]
        published = await context.publish_verified_sections(balance_sections(), citations, source_names=["balance"])
        self.assertEqual((published["state"], published["phase"], published["outcome"]), ("running", "acquiring", "partial"))
        self.assertIsNone(published["completedAt"])
        self.assertIsNone(published["baselineAcceptedAt"])
        self.assertNotIn("No issues detected", published["reportMarkdown"])
        self.assertEqual(len(published["citations"]), 1)
        self.assertEqual(published["sourceFingerprints"]["balance"], published["dependencies"]["balance"]["fingerprint"])
        status = public_review_run_status(self.store.get_status(run["runId"]))
        self.assertTrue(status["active"])
        self.assertTrue(status["reportAvailable"])
        self.assertEqual(status["reportRevision"], published["reportRevision"])
        repeated = await context.publish_verified_sections(balance_sections(), citations, source_names=["balance"])
        self.assertEqual(repeated["reportRevision"], published["reportRevision"])
        await context.checkpoint("balance", status="ready", evidence={"liveVerified": True, "amount": 101}, as_of="2026-10-05T14:00:02Z")
        revised = await context.publish_verified_sections(balance_sections(), citations, source_names=["balance"])
        self.assertNotEqual(revised["reportRevision"], published["reportRevision"])
        self.assertEqual(revised["sourceFingerprints"]["balance"], revised["dependencies"]["balance"]["fingerprint"])
        final = self.store.update(run["runId"], reportMarkdown="Complete captured review", state="succeeded", outcome="ready", completedAt="2026-10-05T14:00:10Z")
        self.assertNotEqual(final["reportRevision"], published["reportRevision"])
        with self.assertRaises(ReviewRunError):
            await context.publish_verified_sections(balance_sections(), citations, source_names=["balance"])
        self.assertEqual(self.store.get(run["runId"]), final)

    async def test_progress_rejects_missing_tampered_and_unverified_evidence(self):
        for evidence in ({"offline": True}, {"stale": True}, {"cacheOnly": True}, {"mock": True}, {"seed": True}):
            run, _ = self.store.create(review_kind="balance-review", conversation_id="invalid", request_id=json.dumps(evidence))
            context = ReviewExecutionContext(self.store, run["runId"], "balance-review")
            await context.checkpoint("balance", status="ready", evidence=evidence, as_of="2026-10-05T14:00:00Z")
            with self.assertRaises(ReviewRunError):
                await context.publish_verified_sections(balance_sections(), [], source_names=["balance"])
            self.assertFalse(self.store.get_status(run["runId"])["reportAvailable"])
            self.store.update(run["runId"], state="failed")
        run, _ = self.store.create(review_kind="balance-review", conversation_id="tamper", request_id="tamper")
        context = ReviewExecutionContext(self.store, run["runId"], "balance-review")
        with self.assertRaises(ReviewRunError):
            await context.publish_verified_sections(balance_sections(), [])
        await context.checkpoint("balance", status="ready", evidence={"liveVerified": True}, as_of="2026-10-05T14:00:00Z")
        with self.store.connect() as db:
            db.execute("UPDATE analyst_review_evidence_v2 SET payload_json='{}' WHERE source_name='balance'")
        with self.assertRaises(ReviewRunError):
            await context.publish_verified_sections(balance_sections(), [], source_names=["balance"])

    async def test_cancellation_during_progress_render_cannot_resurrect_a_terminal_attempt(self):
        run, _ = self.store.create(review_kind="balance-review", conversation_id="cancel", request_id="cancel")
        context = ReviewExecutionContext(self.store, run["runId"], "balance-review")
        await context.checkpoint("balance", status="ready", evidence={"liveVerified": True}, as_of="2026-10-05T14:00:00Z")
        def cancel_during_render(*args):
            self.store.update(run["runId"], state="cancelled", completedAt="2026-10-05T14:00:05Z")
            return "Supported partial report"
        with patch("review_runs_v2.render_review", side_effect=cancel_during_render), self.assertRaises(ReviewRunError):
            await context.publish_verified_sections(balance_sections(), [], source_names=["balance"])
        saved = self.store.get_status(run["runId"])
        self.assertEqual(saved["state"], "cancelled")
        self.assertFalse(saved["reportAvailable"])

    async def test_progress_preparation_yields_and_preserves_exact_capture(self):
        import review_runs_v2
        run, _ = self.store.create(review_kind="balance-review", conversation_id="off-loop", request_id="off-loop")
        context = ReviewExecutionContext(self.store, run["runId"], "balance-review")
        await context.checkpoint("balance", status="ready", evidence={"liveVerified": True})
        sections = balance_sections()
        citations = [{"id": "source", "sourceUri": "gmail://message/source"}]
        expected = review_runs_v2.render_review("balance-review", sections, "partial", citations)
        expected = "\n".join(line for line in expected.splitlines() if line.strip() not in {
            "No issues detected.",
            "No material conflict or qualifying action-feed change was found in the complete reconciliation.",
        }).strip() + "\n"
        entered, release = threading.Event(), threading.Event()
        loop_thread = threading.get_ident()
        original_render = review_runs_v2.render_review

        def blocked_render(*args):
            self.assertNotEqual(threading.get_ident(), loop_thread)
            entered.set()
            if not release.wait(2):
                raise AssertionError("Partial rendering was not released")
            return original_render(*args)

        with patch("review_runs_v2.render_review", side_effect=blocked_render):
            pending = asyncio.create_task(context.publish_verified_sections(sections, citations, source_names=["balance"]))
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, 1))
                await asyncio.sleep(0)
                self.assertFalse(pending.done())
                self.assertFalse(self.store.get_status(run["runId"])["reportAvailable"])
            finally:
                release.set()
                published = await asyncio.wait_for(pending, 2)
        self.assertEqual(published["reportMarkdown"], expected)
        self.assertEqual(published["sections"], sections)
        self.assertEqual(published["citations"], citations)
        self.assertEqual(published["reportRevision"], canonical_fingerprint({
            "reportMarkdown": expected, "citations": citations, "sourceFingerprints": published["sourceFingerprints"],
        }))

    async def test_final_capture_normalization_does_not_block_a_connection_probe(self):
        import review_runs_v2
        sections = [{"id": "captured-evidence", "rows": [{"source": "publication", "reading": "Wait"}]}]
        citations = [{"id": "source", "sourceUri": "gmail://message/source"}]
        entered = asyncio.Event()
        probe_finished = threading.Event()
        probe_completed_during_normalization = []
        loop = asyncio.get_running_loop()
        original = review_runs_v2.json_copy

        def copy_capture(value):
            if value is sections:
                loop.call_soon_threadsafe(entered.set)
                probe_completed_during_normalization.append(probe_finished.wait(0.5))
            return original(value)

        async def handler(_context):
            return {"outcome": "partial", "sections": sections, "citations": citations}

        coordinator = ReviewCoordinatorV2(self.store, {"balance-review": handler})
        with patch("review_runs_v2.json_copy", side_effect=copy_capture):
            run = await coordinator.start(review_kind="balance-review", request_id="normalization-probe")
            pending = coordinator.tasks[run["runId"]]
            try:
                await asyncio.wait_for(entered.wait(), 1)
                verified = await asyncio.wait_for(asyncio.sleep(0.01, result={"connected": True}), 0.1)
                probe_finished.set()
                await asyncio.wait_for(pending, 1)
            finally:
                probe_finished.set()
                await asyncio.gather(pending, return_exceptions=True)
        saved = self.store.get(run["runId"])
        self.assertTrue(verified["connected"])
        self.assertEqual(probe_completed_during_normalization, [True])
        self.assertEqual(saved["state"], "succeeded")
        self.assertEqual(saved["sections"], sections)
        self.assertEqual(saved["citations"], citations)

    async def test_cancelled_progress_task_does_not_publish_after_off_loop_render_finishes(self):
        run, _ = self.store.create(review_kind="balance-review", conversation_id="cancel-task", request_id="cancel-task")
        context = ReviewExecutionContext(self.store, run["runId"], "balance-review")
        await context.checkpoint("balance", status="ready", evidence={"liveVerified": True})
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        loop_thread = threading.get_ident()

        def blocked_render(*_args):
            self.assertNotEqual(threading.get_ident(), loop_thread)
            entered.set()
            if not release.wait(2):
                raise AssertionError("Partial rendering was not released")
            finished.set()
            return "Exact partial capture.\n"

        with patch("review_runs_v2.render_review", side_effect=blocked_render):
            pending = asyncio.create_task(context.publish_verified_sections(balance_sections(), [], source_names=["balance"]))
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, 1))
                pending.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await pending
                self.store.update(run["runId"], state="cancelled", completedAt="2026-10-05T14:00:05Z")
            finally:
                release.set()
                self.assertTrue(await asyncio.to_thread(finished.wait, 1))
        saved = self.store.get_status(run["runId"])
        self.assertEqual(saved["state"], "cancelled")
        self.assertFalse(saved["reportAvailable"])

    async def test_public_running_capture_returns_exact_supported_report_and_its_revision(self):
        run, _ = self.store.create(review_kind="prediction-markets-review", conversation_id="exact-progress", request_id="exact-progress")
        context = ReviewExecutionContext(self.store, run["runId"], "prediction-markets-review")
        await context.checkpoint("predictionResearch", status="partial", evidence={
            "status": "partial", "snapshots": {"published": {"date": "2026-10-05"}, "unavailableSibling": {"status": "unavailable"}},
        }, as_of="2026-10-05T14:00:00Z")
        supported = "# Predictive Markets Review\n\nIndependently captured research only.\n"
        published = await context.publish_verified_sections([
            {"id": "monitored-markets", "status": "partial", "markets": [{"marketId": "sp500", "asset": "S&P 500"}]},
        ], [], source_names=["predictionResearch"], report_markdown=supported)
        public = public_review_run(self.store.get(run["runId"]))
        self.assertEqual(public["reportMarkdown"], supported)
        self.assertEqual(public["reportRevision"], published["reportRevision"])
        self.assertEqual(public_review_run_status(self.store.get_status(run["runId"]))["reportRevision"], public["reportRevision"])
        self.assertNotIn("No issues detected", public["reportMarkdown"])

    async def test_final_render_keeps_partial_capture_coherent_until_atomic_publication(self):
        render_entered = threading.Event()
        release_render = threading.Event()
        summary_entered = asyncio.Event()
        release_summary = asyncio.Event()
        partial_capture = {}
        partial_sections = [{"id": "account-summary", "status": "ready", "current": {"amount": 100}}]
        final_sections = balance_sections()
        partial_citations = [{"id": "first", "sourceUri": "gmail://message/first"}]
        final_citations = [{"id": "final", "sourceUri": "gmail://message/final"}]
        partial_text = "Verified initial account capture.\n"
        final_text = "Complete verified account review.\n\nNo issues detected."

        async def handler(context):
            await context.checkpoint("balance", status="ready", evidence={"liveVerified": True, "amount": 100})
            partial_capture.update(await context.publish_verified_sections(
                partial_sections, partial_citations, source_names=["balance"], report_markdown=partial_text
            ))
            await context.checkpoint("balance", status="ready", evidence={"liveVerified": True, "amount": 101})
            return {"outcome": "ready", "sections": final_sections, "citations": final_citations}

        def blocked_render(*args):
            render_entered.set()
            if not release_render.wait(5):
                raise AssertionError("Final render was not released")
            return final_text

        async def blocked_summary(*args, **kwargs):
            summary_entered.set()
            await release_summary.wait()
            return "Complete summary."

        def assert_partial(phase):
            active = self.store.get(started["runId"])
            public = public_review_run(active)
            status = public_review_run_status(self.store.get_status(started["runId"]))
            self.assertEqual((active["state"], active["phase"], active["outcome"]), ("running", phase, "partial"))
            self.assertIsNone(active["completedAt"])
            self.assertEqual(active["sections"], partial_sections)
            self.assertEqual(public["reportMarkdown"], partial_text)
            self.assertNotIn("No issues detected", public["reportMarkdown"])
            self.assertEqual(public["citations"], partial_citations)
            self.assertEqual(active["sourceFingerprints"], partial_capture["sourceFingerprints"])
            self.assertEqual(public["reportRevision"], partial_capture["reportRevision"])
            self.assertEqual(status["reportRevision"], partial_capture["reportRevision"])

        coordinator = ReviewCoordinatorV2(self.store, {"balance-review": handler}, summary_provider=blocked_summary)
        with patch("review_runs_v2.render_review", side_effect=blocked_render):
            started = await coordinator.start(review_kind="balance-review", session_id="atomic", request_id="atomic")
            try:
                self.assertTrue(await asyncio.to_thread(render_entered.wait, 2))
                assert_partial("rendering")
                release_render.set()
                await asyncio.wait_for(summary_entered.wait(), 2)
                assert_partial("summarizing")
            finally:
                release_render.set()
                release_summary.set()
                final = await await_run(coordinator, started["runId"])

        public_final = public_review_run(final)
        self.assertEqual(final["state"], "succeeded")
        self.assertEqual(final["outcome"], "ready")
        self.assertEqual(public_final["summaryMarkdown"], "Complete summary.")
        self.assertEqual(final["sections"], final_sections)
        self.assertEqual(public_final["reportMarkdown"], final_text)
        self.assertEqual(public_final["citations"], final_citations)
        self.assertEqual(final["sourceFingerprints"]["balance"], final["dependencies"]["balance"]["fingerprint"])
        self.assertNotEqual(final["sourceFingerprints"], partial_capture["sourceFingerprints"])
        self.assertNotEqual(public_final["reportRevision"], partial_capture["reportRevision"])
        self.assertEqual(public_final["reportRevision"], canonical_fingerprint({
            "reportMarkdown": final_text, "citations": final_citations, "sourceFingerprints": final["sourceFingerprints"],
        }))
        self.assertEqual(public_review_run_status(self.store.get_status(started["runId"]))["reportRevision"], public_final["reportRevision"])

    def test_portfolio_reference_candidates_preserve_metadata_without_hydrating_reports(self):
        conversation, portfolio, _, _ = self.store.create_conversation(
            review_kind="portfolio-review", request_id="reference-portfolio"
        )
        dependencies = {"portfolio": {"status": "partial", "asOf": "2026-09-04T20:05:00Z",
                                       "detail": {"liveVerified": True}, "fingerprint": "original-evidence"}}
        self.store.update(portfolio["runId"], state="succeeded", outcome="partial", dependencies=dependencies,
                          completedAt="2026-09-04T20:06:00Z", reportMarkdown="Original report",
                          sections=[{"large": "section evidence" * 1000}], citations=[{"large": "citations" * 1000}])
        self.store.create_conversation(review_kind="prediction-markets-review", request_id="reference-prediction")
        with patch.object(self.store, "_decode", side_effect=AssertionError("Candidate reads must not hydrate full reports")):
            rows = self.store.list_portfolio_reference_candidates(500)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["runId"], portfolio["runId"])
            self.assertEqual(rows[0]["reportMarkdown"], "Original report")
            self.assertEqual(rows[0]["dependencies"], dependencies)
            self.assertEqual(rows[0]["completedAt"], "2026-09-04T20:06:00Z")
            self.assertNotIn("sections", rows[0])
            self.assertNotIn("citations", rows[0])
            self.assertEqual(self.store.list_portfolio_reference_candidates(1), [])
            self.assertTrue(self.store.has_conversation(conversation["conversationId"]))
            self.assertFalse(self.store.has_conversation("missing"))
        self.store.archive_conversation(conversation["conversationId"])
        self.assertFalse(self.store.has_conversation(conversation["conversationId"]))

    def test_public_prediction_market_ids_come_only_from_report_rows(self):
        run = {"reviewKind": "prediction-markets-review", "sections": [
            {"id": "other-section", "markets": [{"marketId": "gold"}]},
            {"id": "monitored-markets", "markets": [
                {"marketId": "sp500", "status": "available", "nativeBook": "private quote evidence"},
                {"marketId": "nasdaq100", "status": "unavailable"},
                {"asset": "Missing identity"}, {"marketId": None}, {"marketId": 7},
            ]},
        ]}
        public = public_review_run(run)
        self.assertEqual(public["marketIds"], ["sp500", "nasdaq100"])
        self.assertNotIn("sections", public)
        self.assertNotIn("private quote evidence", json.dumps(public))
        self.assertEqual(public_review_run({"reviewKind": "prediction-markets-review"})["marketIds"], [])
        self.assertNotIn("marketIds", public_review_run({**run, "reviewKind": "portfolio-review"}))

    async def test_production_coordinator_path_persists_evidence_hash_report_and_terminal_run(
        self,
    ):
        async def handler(context):
            await context.checkpoint(
                "balance",
                status="ready",
                evidence={"liveVerified": True, "fromCache": False, "amount": 100_000},
                as_of="2026-08-31T16:00:00Z",
            )
            return {"outcome": "ready", "sections": balance_sections(), "citations": []}

        coordinator = ReviewCoordinatorV2(self.store, {"balance-review": handler})
        started = await coordinator.start(
            review_kind="balance-review", session_id="session-1", request_id="request-1"
        )
        final = await await_run(coordinator, started["runId"])

        self.assertEqual(final["schemaVersion"], 2)
        self.assertEqual(final["state"], "succeeded")
        self.assertEqual(final["phase"], "terminal")
        self.assertEqual(final["outcome"], "ready")
        self.assertRegex(final["sourceFingerprints"]["balance"], r"^[a-f0-9]{64}$")
        self.assertIn("# Balance Review", final["reportMarkdown"])
        self.assertNotIn("packets", public_review_run(final))

    async def test_follow_up_context_is_bounded_and_excludes_report_evidence_and_diagnostics(
        self,
    ):
        run = {
            "schemaVersion": 2,
            "runId": "run-context",
            "sessionId": "session-context",
            "reviewKind": "portfolio-review",
            "state": "succeeded",
            "outcome": "partial",
            "completedAt": "2026-08-31T16:00:00Z",
            "sections": [
                {
                    "id": "coverage-data-quality",
                    "title": "Coverage & Data Quality",
                    "status": "partial",
                    "facts": ["bounded fact " + ("x" * 1_000) for _index in range(100)],
                    "raw": "must never be exposed",
                    "evidence": {"archive": "must never be exposed"},
                }
            ],
            "citations": [{"id": f"cite_{index:032x}"} for index in range(200)],
            "summaryMarkdown": "Optional summary.",
            "reportMarkdown": "FULL REPORT MUST NOT ENTER HERMES",
            "dependencies": {"portfolio": {"raw": "archive"}},
            "diagnostics": {"traceback": "hidden"},
        }

        context = review_context_v2(run)
        encoded = json.dumps(context, separators=(",", ":")).encode("utf-8")

        self.assertLessEqual(len(encoded), MAX_REVIEW_CONTEXT_BYTES)
        self.assertEqual(context["schema"], "ReviewContextV2")
        self.assertTrue(context["rules"]["historicalContextOnly"])
        self.assertFalse(context["rules"]["maySatisfyCurrentLiveRead"])
        self.assertNotIn("FULL REPORT", encoded.decode("utf-8"))
        self.assertNotIn("must never be exposed", encoded.decode("utf-8"))
        self.assertNotIn("traceback", encoded.decode("utf-8"))

    async def test_refresh_followup_keeps_captured_conclusions_and_resolvable_citations(self):
        citation = {"id": "cite_" + "a" * 32, "documentId": "doc_" + "b" * 32,
                    "product": "etf-pro", "sourceUri": "https://app.hedgeye.com/feed_items/captured",
                    "contentHash": "captured-hash", "publicationDate": "2026-08-30"}
        report = {"templateVersion": "portfolio-refresh-v1", "asOf": "2026-08-31T16:00:00Z",
                  "complete": False, "positionCount": 72,
                  "holdings": [{"ticker": f"ABC{index}", "security": "Captured security", "heldSide": "LONG",
                                "classification": "realignment", "reviewAction": "Requalify against dated removal",
                                "citationIds": [citation["id"]], "evidence": [{"kind": "action", "reading": "Remove Long",
                                "product": "etf-pro", "date": "2026-08-30", "bodyText": "PRIVATE SOURCE BODY"}]}
                               for index in range(72)], "productCoverage": [{"id": "etf-pro", "status": "ready"}]}
        record = {"schemaVersion": 2, "state": "succeeded", "runId": "run-context", "reviewKind": "portfolio-review",
                  "sections": [{"id": "portfolio-refresh", "status": "partial", "report": report},
                               {"id": "large-section", "facts": ["x" * 1000] * 100}],
                  "citations": [{"id": f"cite_{index:032x}", "title": "x" * 1000} for index in range(100)] + [citation]}
        context = review_context_v2(record)
        refresh = next(row for row in context["sections"] if row["id"] == "portfolio-refresh")
        self.assertEqual(refresh["positionCount"], 72)
        self.assertEqual(len(refresh["checkedTickers"]), 72)
        self.assertEqual(refresh["holdings"][0]["reviewAction"], "Requalify against dated removal")
        self.assertGreater(refresh["omittedHoldings"], 0)
        self.assertIn(citation, context["citations"])
        self.assertNotIn("PRIVATE SOURCE BODY", json.dumps(context))
        self.assertLessEqual(len(json.dumps(context, separators=(",", ":")).encode()), MAX_REVIEW_CONTEXT_BYTES)

    async def test_concurrent_stage_checkpoints_are_merged_without_lost_dependencies(
        self,
    ):
        run, _created = self.store.create(
            review_kind="portfolio-review",
            session_id="session-concurrent",
            request_id="request-concurrent",
        )
        from review_runs_v2 import ReviewExecutionContext

        context = ReviewExecutionContext(self.store, run["runId"], "portfolio-review")
        names = [f"source-{index:02d}" for index in range(24)]
        await asyncio.gather(
            *(
                context.checkpoint(
                    name,
                    status="ready",
                    evidence={"source": name, "liveVerified": True},
                )
                for name in names
            )
        )

        persisted = self.store.get(run["runId"])
        self.assertEqual(set(persisted["dependencies"]), set(names))
        self.assertTrue(
            all(
                persisted["dependencies"][name]["fingerprint"]
                == canonical_fingerprint({"source": name, "liveVerified": True})
                for name in names
            )
        )

    async def test_duplicate_request_is_idempotent_and_different_request_is_rejected_while_running(
        self,
    ):
        release = asyncio.Event()

        async def handler(_context):
            await release.wait()
            return {"outcome": "ready", "sections": balance_sections(), "citations": []}

        coordinator = ReviewCoordinatorV2(self.store, {"balance-review": handler})
        first = await coordinator.start(
            review_kind="balance-review", session_id="session-1", request_id="same"
        )
        duplicate = await coordinator.start(
            review_kind="balance-review", session_id="session-1", request_id="same"
        )
        self.assertEqual(first["runId"], duplicate["runId"])
        with self.assertRaises(ReviewRunError) as raised:
            await coordinator.start(
                review_kind="balance-review",
                session_id="session-1",
                request_id="different",
            )
        self.assertEqual(raised.exception.code, "REVIEW_ALREADY_RUNNING")
        release.set()
        await await_run(coordinator, first["runId"])

    async def test_retry_is_a_new_immutable_attempt_and_performs_new_acquisition(self):
        acquisitions = 0

        async def handler(context):
            nonlocal acquisitions
            acquisitions += 1
            await context.checkpoint(
                "portfolio",
                status="ready",
                evidence={"refresh": acquisitions, "liveVerified": True},
            )
            return {"outcome": "ready", "sections": balance_sections(), "citations": []}

        coordinator = ReviewCoordinatorV2(self.store, {"balance-review": handler})
        first_start = await coordinator.start_conversation(
            review_kind="balance-review", request_id="request-1"
        )
        first = first_start["run"]
        first_final = await await_run(coordinator, first["runId"])
        second = await coordinator.retry(first["runId"], request_id="request-2")
        second_final = await await_run(coordinator, second["runId"])

        self.assertEqual(acquisitions, 2)
        self.assertEqual(first_final["attempt"], 1)
        self.assertEqual(second_final["attempt"], 2)
        self.assertEqual(second_final["previousRunId"], first_final["runId"])
        self.assertEqual(second_final["conversationId"], first_final["conversationId"])
        self.assertNotEqual(
            first_final["sourceFingerprints"]["portfolio"],
            second_final["sourceFingerprints"]["portfolio"],
        )
        self.assertEqual(self.store.get(first_final["runId"])["attempt"], 1)

    async def test_per_launch_uuid_conversations_are_idempotent_and_reuse_only_active_kind(self):
        first_conversation, first_run, created, reused = self.store.create_conversation(
            review_kind="portfolio-review", request_id="launch-one"
        )
        self.assertTrue(created)
        self.assertFalse(reused)
        self.assertEqual(str(UUID(first_conversation["conversationId"])), first_conversation["conversationId"])
        self.assertEqual(first_run["conversationId"], first_conversation["conversationId"])

        duplicate_conversation, duplicate_run, duplicate_created, duplicate_reused = (
            self.store.create_conversation(
                review_kind="portfolio-review", request_id="launch-one"
            )
        )
        self.assertFalse(duplicate_created)
        self.assertFalse(duplicate_reused)
        self.assertEqual(duplicate_conversation["conversationId"], first_conversation["conversationId"])
        self.assertEqual(duplicate_run["runId"], first_run["runId"])

        active_conversation, active_run, active_created, active_reused = (
            self.store.create_conversation(
                review_kind="portfolio-review", request_id="launch-two"
            )
        )
        self.assertFalse(active_created)
        self.assertTrue(active_reused)
        self.assertEqual(active_conversation["conversationId"], first_conversation["conversationId"])
        self.assertEqual(active_run["runId"], first_run["runId"])

        concurrent_conversation, concurrent_run, concurrent_created, _ = (
            self.store.create_conversation(
                review_kind="balance-review", request_id="balance-one"
            )
        )
        self.assertTrue(concurrent_created)
        self.assertNotEqual(concurrent_conversation["conversationId"], first_conversation["conversationId"])

        self.store.update(
            first_run["runId"],
            state="failed",
            phase="terminal",
            outcome="blocked",
            completedAt="2026-09-01T10:00:00Z",
            errorCode="TEST_FAILURE",
            errorMessage="First attempt failed.",
            errorRetryable=True,
        )
        second_conversation, second_run, second_created, second_reused = (
            self.store.create_conversation(
                review_kind="portfolio-review", request_id="launch-three"
            )
        )
        self.assertTrue(second_created)
        self.assertFalse(second_reused)
        self.assertNotEqual(second_conversation["conversationId"], first_conversation["conversationId"])
        self.assertEqual(second_run["attempt"], 1)

        # Finish the other kind so no active attempt leaks into later assertions.
        self.store.update(
            concurrent_run["runId"],
            state="succeeded",
            phase="terminal",
            outcome="ready",
            completedAt="2026-09-01T10:01:00Z",
        )

    async def test_compact_pagination_search_and_selected_detail_payloads(self):
        created = []
        for review_kind in (
            "portfolio-review",
            "prediction-markets-review",
            "balance-review",
        ):
            conversation, run, _created, _reused = self.store.create_conversation(
                review_kind=review_kind, request_id=f"request:{review_kind}"
            )
            self.store.update(
                run["runId"],
                state="succeeded",
                phase="terminal",
                outcome="ready",
                completedAt="2026-09-01T12:00:00Z",
                reportMarkdown=f"# {conversation['title']}\n\nHEAVY_REPORT_{review_kind}",
                citations=[{"id": f"cite:{review_kind}", "title": "Source"}],
                diagnostics={"raw": "HEAVY_DIAGNOSTICS"},
            )
            created.append((conversation, run))

        first_page, cursor = self.store.list_conversations(limit=2)
        second_page, final_cursor = self.store.list_conversations(limit=2, cursor=cursor)
        self.assertEqual(len(first_page), 2)
        self.assertEqual(len(second_page), 1)
        self.assertIsNotNone(cursor)
        self.assertIsNone(final_cursor)
        self.assertEqual(
            len({row["conversationId"] for row in first_page + second_page}), 3
        )

        compact = [public_review_conversation_summary(row) for row in first_page]
        compact_json = json.dumps(compact)
        self.assertLess(len(compact_json.encode("utf-8")), 8_000)
        for forbidden in (
            "reportMarkdown",
            "summaryMarkdown",
            "dependencies",
            "sourceFingerprints",
            "citations",
            "diagnostics",
            "HEAVY_REPORT",
            "HEAVY_DIAGNOSTICS",
        ):
            self.assertNotIn(forbidden, compact_json)

        balance_rows, _ = self.store.list_conversations(query="balance")
        self.assertEqual([row["reviewKind"] for row in balance_rows], ["balance-review"])
        with self.assertRaises(ReviewRunError) as raised:
            self.store.list_conversations(cursor="not-a-cursor")
        self.assertEqual(raised.exception.code, "REVIEW_CURSOR_INVALID")

        selected = self.store.get_conversation(created[0][0]["conversationId"])
        detail = public_review_conversation_detail(selected)
        detail_json = json.dumps(detail)
        self.assertIn("HEAVY_REPORT_portfolio-review", detail_json)
        self.assertIn("cite:portfolio-review", detail_json)
        status_json = json.dumps(public_review_run_status(selected["runs"][-1]))
        self.assertNotIn("HEAVY_REPORT", status_json)
        self.assertNotIn("citations", status_json)

    async def test_archive_hides_only_the_row_and_preserves_immutable_run_and_evidence(self):
        conversation, run, _created, _reused = self.store.create_conversation(
            review_kind="balance-review", request_id="archive-me"
        )
        with self.assertRaises(ReviewRunError) as raised:
            self.store.archive_conversation(conversation["conversationId"])
        self.assertEqual(raised.exception.code, "REVIEW_CONVERSATION_RUNNING")

        fingerprint, _size = self.store.store_evidence(
            "balance", {"liveVerified": True, "amount": 100_000}
        )
        self.store.merge_dependency(
            run["runId"],
            "balance",
            {"status": "ready", "fingerprint": fingerprint},
        )
        self.store.update(
            run["runId"],
            state="succeeded",
            phase="terminal",
            outcome="ready",
            completedAt="2026-09-01T12:00:00Z",
            reportMarkdown="# Immutable report",
        )
        archived = self.store.archive_conversation(conversation["conversationId"])
        self.assertIsNotNone(archived["archivedAt"])
        self.assertIsNone(self.store.get_conversation(conversation["conversationId"]))
        self.assertEqual(self.store.get(run["runId"])["reportMarkdown"], "# Immutable report")
        with self.store.connect() as connection:
            evidence = connection.execute(
                "SELECT payload_json FROM analyst_review_evidence_v2 WHERE fingerprint = ?",
                (fingerprint,),
            ).fetchone()
        self.assertIsNotNone(evidence)

    async def test_legacy_fixed_shell_migration_is_backed_up_transactional_and_idempotent(self):
        path = Path(self.temp.name) / "legacy.sqlite3"
        legacy = ReviewRunV2Store(path)
        first, _ = legacy.create(
            review_kind="portfolio-review",
            session_id="legacy-one",
            request_id="legacy-request-one",
        )
        fingerprint, _size = legacy.store_evidence(
            "portfolio", {"liveVerified": True, "positionCount": 54}
        )
        legacy.merge_dependency(
            first["runId"],
            "portfolio",
            {"status": "ready", "fingerprint": fingerprint},
        )
        legacy.update(
            first["runId"],
            state="succeeded",
            phase="terminal",
            outcome="ready",
            completedAt="2026-09-01T08:00:00Z",
            reportMarkdown="# First immutable report",
            citations=[{"id": "cite:first"}],
            baselineAcceptedAt="2026-09-01T08:00:00Z",
        )
        second, _ = legacy.create(
            review_kind="portfolio-review",
            session_id="legacy-two",
            request_id="legacy-request-two",
        )
        legacy.update(
            second["runId"],
            state="failed",
            phase="terminal",
            outcome="blocked",
            completedAt="2026-09-02T08:00:00Z",
            errorCode="LEGACY_FAILURE",
            errorMessage="Legacy failure",
            errorRetryable=True,
        )

        migrated = ReviewRunV2Store(path)
        first_after = migrated.get(first["runId"])
        second_after = migrated.get(second["runId"])
        self.assertEqual(str(UUID(first_after["conversationId"])), first_after["conversationId"])
        self.assertEqual(str(UUID(second_after["conversationId"])), second_after["conversationId"])
        self.assertNotEqual(first_after["conversationId"], second_after["conversationId"])
        self.assertEqual(first_after["reportMarkdown"], "# First immutable report")
        self.assertEqual(first_after["citations"][0]["id"], "cite:first")
        self.assertEqual(first_after["dependencies"]["portfolio"]["fingerprint"], fingerprint)
        self.assertEqual(second_after["previousRunId"], first_after["runId"])
        self.assertEqual(
            migrated.latest_portfolio_baseline()["runId"], first_after["runId"]
        )
        backup = path.with_name(f"{path.stem}.pre-conversation-v1.bak{path.suffix}")
        self.assertTrue(backup.exists())

        restarted = ReviewRunV2Store(path)
        conversations, cursor = restarted.list_conversations(limit=10)
        self.assertIsNone(cursor)
        self.assertEqual(len(conversations), 2)
        with restarted.connect() as connection:
            fixed_shells = connection.execute(
                "SELECT COUNT(*) FROM analyst_review_conversations_v1 WHERE conversation_id = ?",
                (review_conversation_id("portfolio-review"),),
            ).fetchone()[0]
            evidence_rows = connection.execute(
                "SELECT COUNT(*) FROM analyst_review_evidence_v2 WHERE fingerprint = ?",
                (fingerprint,),
            ).fetchone()[0]
        self.assertEqual(fixed_shells, 0)
        self.assertEqual(evidence_rows, 1)

    async def test_unexpected_finalization_failure_keeps_acquired_evidence_and_hides_raw_exception(
        self,
    ):
        async def handler(context):
            await context.checkpoint(
                "portfolio",
                status="ready",
                evidence={"liveVerified": True, "positionCount": 54},
            )
            raise NameError("name 'sha256' is not defined")

        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        started = await coordinator.start(
            review_kind="portfolio-review",
            session_id="session-1",
            request_id="request-1",
        )
        final = await await_run(coordinator, started["runId"])
        public = public_review_run(final)

        self.assertEqual(final["dependencies"]["portfolio"]["status"], "ready")
        self.assertRegex(
            final["dependencies"]["portfolio"]["fingerprint"], r"^[a-f0-9]{64}$"
        )
        self.assertEqual(public["state"], "failed")
        self.assertEqual(public["error"]["code"], "REVIEW_COORDINATOR_FAILED")
        self.assertNotIn("sha256", public["error"]["message"].lower())
        self.assertIn("sha256", final["diagnostics"]["raw"])

    async def test_deadline_terminates_instead_of_loading_forever(self):
        async def handler(_context):
            await asyncio.Event().wait()

        coordinator = ReviewCoordinatorV2(
            self.store,
            {"balance-review": handler},
            deadlines={"balance-review": 0.01},
        )
        started = await coordinator.start(
            review_kind="balance-review", session_id="session-1", request_id="request-1"
        )
        final = await await_run(coordinator, started["runId"])
        self.assertEqual(final["state"], "failed")
        self.assertEqual(final["outcome"], "blocked")
        self.assertEqual(final["errorCode"], "REVIEW_DEADLINE_EXCEEDED")
        self.assertTrue(final["errorRetryable"])
        # No revision was published, so there is no partial report to keep and
        # the one-line failure stays the whole post. Sources settle as not checked.
        self.assertIsNone(final["reportMarkdown"])
        self.assertFalse(public_review_run_status(final)["reportAvailable"])
        from analyst_review_sources import review_sources
        items = review_sources(final, self.store)["items"]
        self.assertTrue(items)
        self.assertNotIn("checking", {item["status"] for item in items})
        for name in ("balance", "portfolio"):
            item = next(item for item in items if item["id"] == name)
            self.assertEqual((item["status"], item["diagnostic"]["code"]), ("missing", "SOURCE_NOT_ATTEMPTED"))

    async def test_deadline_after_a_published_revision_keeps_that_report_and_settles_sources(self):
        published = asyncio.Event()

        async def handler(context):
            await context.checkpoint("balance", status="ready", as_of="2026-10-05T14:00:00Z",
                                     evidence={"liveVerified": True, "data": {"current": {"available": True}}},
                                     detail={"liveVerified": True})
            await context.publish_verified_sections(balance_sections(), [{"id": "captured"}], source_names=["balance"])
            published.set()
            await asyncio.Event().wait()

        coordinator = ReviewCoordinatorV2(self.store, {"balance-review": handler}, deadlines={"balance-review": 0.5})
        started = await coordinator.start(review_kind="balance-review", session_id="session-1", request_id="request-1")
        await asyncio.wait_for(published.wait(), 0.5)
        partial = self.store.get(started["runId"])
        final = await await_run(coordinator, started["runId"])
        self.assertEqual((final["state"], final["errorCode"]), ("failed", "REVIEW_DEADLINE_EXCEEDED"))
        # The failure never rewrites the published partial capture.
        for key in ("reportMarkdown", "reportRevision", "sections", "citations", "sourceFingerprints"):
            self.assertEqual(final[key], partial[key])
        self.assertTrue(final["reportMarkdown"].strip())
        status = public_review_run_status(final)
        self.assertTrue(status["reportAvailable"])
        self.assertEqual(status["reportRevision"], partial["reportRevision"])
        from analyst_review_sources import review_sources
        items = {item["id"]: item for item in review_sources(final, self.store)["items"]}
        self.assertNotIn("checking", {item["status"] for item in items.values()})
        self.assertEqual(items["balance"]["status"], "ready")
        self.assertEqual((items["portfolio"]["status"], items["portfolio"]["diagnostic"]["code"]),
                         ("missing", "SOURCE_NOT_ATTEMPTED"))

    async def test_optional_synchronous_summary_cannot_extend_the_total_deadline(self):
        calls = []

        async def handler(_context):
            return {"outcome": "ready", "sections": balance_sections(), "citations": []}

        def slow_summary(_payload, **_options):
            calls.append(True)
            time.sleep(0.2)
            return "Too late"

        coordinator = ReviewCoordinatorV2(
            self.store,
            {"balance-review": handler},
            summary_provider=slow_summary,
            deadlines={"balance-review": 0.1},
        )
        started = await coordinator.start(
            review_kind="balance-review",
            session_id="session-summary-deadline",
            request_id="request-summary-deadline",
        )
        before = time.monotonic()
        final = await await_run(coordinator, started["runId"])
        elapsed = time.monotonic() - before

        self.assertEqual(final["state"], "succeeded")
        self.assertIsNone(final["summaryMarkdown"])
        self.assertLess(elapsed, 0.2)
        self.assertEqual(calls, [])

    async def test_sidecar_restart_closes_orphaned_attempt_without_erasing_checkpoints(
        self,
    ):
        created, _ = self.store.create(
            review_kind="balance-review",
            session_id="session-restart",
            request_id="request-restart",
        )
        self.store.update(created["runId"], state="running")
        self.store.merge_dependency(
            created["runId"],
            "balance",
            {
                "status": "ready",
                "fingerprint": canonical_fingerprint({"liveVerified": True}),
            },
        )

        self.assertEqual(self.store.interrupt_active_attempts(), 1)
        interrupted = self.store.get(created["runId"])
        self.assertEqual(interrupted["state"], "failed")
        self.assertEqual(interrupted["phase"], "terminal")
        self.assertEqual(interrupted["outcome"], "blocked")
        self.assertEqual(interrupted["errorCode"], "REVIEW_PROCESS_RESTARTED")
        self.assertEqual(interrupted["dependencies"]["balance"]["status"], "ready")
        self.assertTrue(interrupted["errorRetryable"])

    def test_active_attempt_count_reads_only_recent_queued_or_running_attempts(self):
        def create(kind, index):
            return self.store.create(review_kind=kind, session_id=f"session-{index}",
                                     request_id=f"request-{index}")[0]["runId"]

        runs = [create("balance-review", 0), create("portfolio-review", 1), create("prediction-markets-review", 2)]
        self.store.update(runs[1], state="running")
        self.store.update(runs[2], state="succeeded", phase="terminal", outcome="ready")
        runs.append(create("prediction-markets-review", 3))
        self.assertEqual(self.store.active_attempt_count(1800), 3)
        # An orphaned attempt not updated within the window stops counting.
        with self.store.connect() as connection:
            connection.execute(
                "UPDATE analyst_review_runs_v2 SET updated_at = '2026-01-01T00:00:00.000000Z' WHERE run_id = ?",
                (runs[3],),
            )
        self.assertEqual(self.store.active_attempt_count(1800), 2)
        self.assertEqual(self.store.get(runs[3])["state"], "queued")

    async def test_only_ready_portfolio_run_becomes_automatic_baseline(self):
        outcomes = iter(("partial", "ready"))

        async def handler(context):
            outcome = next(outcomes)
            await context.checkpoint(
                "portfolio", status="ready", evidence={"outcome": outcome}
            )
            sections = [
                {
                    "id": "executive-snapshot",
                    "title": "Snapshot",
                    "status": outcome,
                    "metrics": {},
                },
                {
                    "id": "exposure-risk",
                    "title": "Risk",
                    "status": outcome,
                    "metrics": {},
                },
                {"id": "conflicts-changes", "title": "Conflicts", "status": outcome},
                {"id": "market-macro-context", "title": "Context", "status": outcome},
                {
                    "id": "changes-since-prior",
                    "title": "Changes",
                    "status": "no_baseline",
                },
                {"id": "coverage-data-quality", "title": "Coverage", "status": outcome},
            ]
            return {"outcome": outcome, "sections": sections, "citations": []}

        coordinator = ReviewCoordinatorV2(self.store, {"portfolio-review": handler})
        partial = await coordinator.start(
            review_kind="portfolio-review", session_id="s1", request_id="r1"
        )
        partial_final = await await_run(coordinator, partial["runId"])
        ready = await coordinator.start(
            review_kind="portfolio-review", session_id="s2", request_id="r2"
        )
        ready_final = await await_run(coordinator, ready["runId"])
        self.assertIsNone(partial_final["baselineAcceptedAt"])
        self.assertIsNotNone(ready_final["baselineAcceptedAt"])
        self.assertEqual(
            self.store.latest_portfolio_baseline()["runId"], ready_final["runId"]
        )

    async def test_failed_54_position_regression_has_one_evidence_copy_and_one_bounded_summary_call(
        self,
    ):
        summary_calls = []
        macro_corpus = "macro evidence " * 300_000
        positions = [
            {"symbol": f"P{index:02d}", "marketValue": index} for index in range(54)
        ]

        async def handler(context):
            await context.checkpoint(
                "canonicalResearch", status="ready", evidence={"macro": macro_corpus}
            )
            sections = balance_sections()
            sections[0]["facts"] = positions
            return {"outcome": "ready", "sections": sections, "citations": []}

        async def summarize(payload, **options):
            summary_calls.append((payload, options))
            return "Bounded optional summary."

        coordinator = ReviewCoordinatorV2(
            self.store,
            {"balance-review": handler},
            summary_provider=summarize,
        )
        started = await coordinator.start(
            review_kind="balance-review",
            session_id="session-54",
            request_id="request-54",
        )
        final = await await_run(coordinator, started["runId"])
        with self.store.connect() as connection:
            evidence_rows = connection.execute(
                "SELECT COUNT(*) FROM analyst_review_evidence_v2"
            ).fetchone()[0]

        self.assertEqual(final["state"], "succeeded")
        self.assertEqual(evidence_rows, 1)
        self.assertEqual(len(summary_calls), 1)
        self.assertLessEqual(
            len(summary_calls[0][0].encode("utf-8")), MAX_SUMMARY_INPUT_BYTES
        )
        self.assertEqual(summary_calls[0][1]["allow_tools"], False)
        self.assertNotIn("packets", final)

    def test_hashing_and_canary_cover_the_exact_undefined_name_regression(self):
        self.assertRegex(canonical_fingerprint({"value": 1}), r"^[a-f0-9]{64}$")
        self.assertTrue(coordinator_canary()["ready"])
        payload = bounded_summary_input(
            "balance-review", "ready", balance_sections(), []
        )
        self.assertLessEqual(len(payload.encode("utf-8")), MAX_SUMMARY_INPUT_BYTES)


class FixedPredictionUniverseTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def fresh(path, **changes):
        stamp = datetime.now(timezone.utc).isoformat()
        venue = path.split("venue=", 1)[1].split("&", 1)[0]
        market_id = path.split("/monitor/", 1)[1].split("/", 1)[0]
        return {
            "status": "available", "marketId": market_id, "selectedVenueId": venue,
            "revision": 2, "refresh": {"state": "idle"},
            "acquisition": {"status": "complete", "requestedAt": stamp, "completedAt": stamp,
                            "previousRevision": 1, "revision": 2},
            "displaySelection": {"status": "available", "venueId": venue},
            "displayContracts": {"status": "available", "event": {"ticker": f"{market_id}-event"},
                                 "lines": [{"ticker": f"{market_id}-contract", "yesBid": 40, "yesAsk": 42}]},
            **changes,
        }

    @classmethod
    def native_fresh(cls, path):
        payload = cls.fresh(path)
        stamp = payload["acquisition"]["requestedAt"]
        observed = datetime.fromisoformat(stamp)
        venue = payload["selectedVenueId"]
        source = "ibkr_tws_forecastex_live" if venue == "forecastex" else "kalshi_batch_orderbooks_v2"
        payload["acquisition"]["scope"] = "pinned_native_book"
        payload["refresh"].update(state="refreshing", startedAt=stamp, completedAt=stamp)
        display = payload["displayContracts"]
        display.update(bookExpiresAt=(observed + timedelta(seconds=60)).isoformat(), sourceRefreshPending=True)
        display["event"].update(venueId=venue, status="open", closeTime=(observed + timedelta(days=1)).isoformat())
        display["lines"][0].update(
            yesBid=.40, yesAsk=.42, noBid=.58, noAsk=.60, directNative=True,
            source=source, evidence={"quotes": {"source": source, "asOf": stamp, "fit": "exact"}},
        )
        return payload

    async def test_scoped_native_acquisition_keeps_fresh_quotes_while_other_sources_refresh(self):
        async def request(path, *, method):
            return self.native_fresh(path)

        result = await PredictionMarketReader(request=request).fixed_review_universe()
        self.assertEqual(result["status"], "available")
        self.assertEqual(result["data"]["availableCount"], 7)
        self.assertTrue(all(row["snapshot"]["refresh"]["state"] == "refreshing"
                            for row in result["data"]["markets"]))

    async def test_scoped_acquisition_requires_independent_current_native_book_proof(self):
        cases = (
            ("acquisition", {"scope": "unverified"}),
            ("selection", {"status": "unavailable"}),
            ("selection", {"refreshPending": True}),
            ("selection", {"refreshRetained": True}),
            ("refresh", {"lastError": "Provider unavailable"}),
            ("refresh", {"startedAt": "2020-01-01T00:00:00Z"}),
            ("refresh", {"completedAt": "2020-01-01T00:00:00Z"}),
            ("display", {"refreshPending": True}),
            ("display", {"refreshRetained": True}),
            ("display", {"cachedOnly": True}),
            ("display", {"refreshFailed": True}),
            ("display", {"bookExpiresAt": "2020-01-01T00:00:00Z"}),
            ("event", {"status": "closed"}),
            ("event", {"venueId": "forecastex"}),
            ("line", {"stale": True}),
            ("line", {"mock": True}),
            ("line", {"seeded": True}),
            ("line", {"connected": False}),
            ("line", {"directNative": False}),
            ("line", {"derivedFields": ["noAsk"]}),
            ("line", {"yesBid": .80}),
            ("line", {"noAsk": None}),
            ("quote", {"source": "ibkr_tws_forecastex_live"}),
            ("quote", {"fit": "proxy"}),
            ("quote", {"asOf": "2020-01-01T00:00:00Z"}),
            ("quote", {"asOf": "2099-01-01T00:00:00Z"}),
        )
        for target, mutation in cases:
            with self.subTest(target=target, mutation=mutation):
                async def request(path, *, method):
                    payload = self.native_fresh(path)
                    if payload["marketId"] == "silver":
                        display = payload["displayContracts"]
                        targets = {"acquisition": payload["acquisition"], "refresh": payload["refresh"],
                                   "selection": payload["displaySelection"],
                                   "display": display, "event": display["event"], "line": display["lines"][0],
                                   "quote": display["lines"][0]["evidence"]["quotes"]}
                        targets[target].update(mutation)
                    return payload

                result = await PredictionMarketReader(request=request).fixed_review_universe()
                rows = {row["marketId"]: row for row in result["data"]["markets"]}
                self.assertEqual(result["status"], "partial")
                self.assertIsNone(rows["silver"]["snapshot"])
                self.assertEqual(rows["gold"]["status"], "available")

    async def test_scoped_acquisition_rejects_a_recent_book_from_before_this_request(self):
        async def request(path, *, method):
            payload = self.native_fresh(path)
            requested = datetime.fromisoformat(payload["acquisition"]["requestedAt"])
            payload["displayContracts"]["lines"][0]["evidence"]["quotes"]["asOf"] = (
                requested - timedelta(seconds=1)
            ).isoformat()
            return payload

        result = await PredictionMarketReader(request=request).fixed_review_universe()
        self.assertEqual(result["status"], "unavailable")
        self.assertTrue(all(row["snapshot"] is None for row in result["data"]["markets"]))

    async def test_http_transport_posts_json_for_each_pinned_monitor_refresh(self):
        requests = []

        def respond(request):
            requests.append(request)
            if request.headers.get("Content-Type") != "application/json":
                return httpx.Response(415, json={"error": "JSON request content type is required"})
            self.assertEqual(request.method, "POST")
            self.assertEqual(json.loads(request.content), {})
            self.assertEqual(request.headers.get("Cache-Control"), "no-cache")
            return httpx.Response(
                200,
                headers={"Cache-Control": "no-store, max-age=0"},
                json=self.fresh(str(request.url)),
            )

        async_client = httpx.AsyncClient
        with patch("market.httpx.AsyncClient", side_effect=lambda **kwargs: async_client(
            transport=httpx.MockTransport(respond), **kwargs
        )), patch("market.asyncio.wait_for", wraps=asyncio.wait_for) as wait_for:
            result = await PredictionMarketReader().fixed_review_universe()

        self.assertEqual(result["status"], "available")
        self.assertEqual(result["data"]["availableCount"], 7)
        for call in wait_for.call_args_list:
            self.assertGreater(call.kwargs["timeout"], 35)
            self.assertGreaterEqual(call.kwargs["timeout"], requests[0].extensions["timeout"]["read"])
        self.assertEqual(
            [(request.url.path.split("/monitor/")[1].split("/")[0], request.url.params["venue"])
             for request in requests],
            [(market_id, venue) for market_id, _, venue in PREDICTIVE_REVIEW_UNIVERSE],
        )

    async def test_http_transport_without_no_store_cannot_supply_review_snapshots(self):
        async_client = httpx.AsyncClient
        with patch("market.httpx.AsyncClient", side_effect=lambda **kwargs: async_client(
            transport=httpx.MockTransport(lambda request: httpx.Response(
                200, json=self.fresh(str(request.url))
            )), **kwargs
        )):
            result = await PredictionMarketReader().fixed_review_universe()

        self.assertEqual(result["status"], "unavailable")
        self.assertTrue(all(row["snapshot"] is None for row in result["data"]["markets"]))
        self.assertTrue(all("no-store" in row["error"] for row in result["data"]["markets"]))

    async def test_exact_asset_venue_allowlist_posts_concurrent_fresh_acquisitions(self):
        paths = []
        all_started = asyncio.Event()

        async def request(path, *, method):
            self.assertEqual(method, "POST")
            paths.append(path)
            if len(paths) == len(PREDICTIVE_REVIEW_UNIVERSE):
                all_started.set()
            await asyncio.wait_for(all_started.wait(), .5)
            return self.fresh(path)

        result = await PredictionMarketReader(request=request).fixed_review_universe()
        self.assertEqual(result["status"], "available")
        self.assertEqual(len(paths), len(PREDICTIVE_REVIEW_UNIVERSE))
        self.assertIn("/api/prediction-market-test/monitor/silver/refresh?venue=kalshi&view=review", paths)
        self.assertNotIn("/api/prediction-market-test/monitor/silver/refresh?venue=forecastex&view=review", paths)
        self.assertIn("/api/prediction-market-test/monitor/cpi/refresh?venue=forecastex&view=review", paths)
        self.assertIn("/api/prediction-market-test/monitor/ethereum/refresh?venue=kalshi&view=review", paths)
        self.assertEqual(list(PREDICTIVE_REVIEW_UNIVERSE), [
            ("cpi", "CPI", "forecastex"), ("sp500", "S&P 500", "forecastex"),
            ("nasdaq100", "Nasdaq-100", "kalshi"),
            ("gold", "Gold", "kalshi"), ("silver", "Silver", "kalshi"),
            ("bitcoin", "Bitcoin", "kalshi"), ("ethereum", "Ethereum", "kalshi"),
        ])
        self.assertEqual([(row["marketId"], row["asset"], row["venue"]) for row in result["data"]["universe"]],
                         list(PREDICTIVE_REVIEW_UNIVERSE))
        self.assertFalse(any("venue=auto" in path for path in paths))

    async def test_cached_or_wrong_venue_asset_fails_only_that_row(self):
        async def request(path, *, method):
            payload = self.fresh(path)
            if payload["marketId"] == "silver":
                payload["selectedVenueId"] = "forecastex"
                payload["displaySelection"]["venueId"] = "forecastex"
            if payload["marketId"] == "ethereum":
                payload["displayContracts"]["cachedOnly"] = True
            return payload

        result = await PredictionMarketReader(request=request).fixed_review_universe()
        by_market = {row["marketId"]: row for row in result["data"]["markets"]}
        self.assertEqual(result["status"], "partial")
        self.assertEqual(by_market["silver"]["errorCode"], "PINNED_VENUE_MISMATCH")
        self.assertEqual(by_market["ethereum"]["errorCode"], "PINNED_VENUE_DATA_INCOMPLETE")
        self.assertEqual(by_market["gold"]["status"], "available")
        self.assertIsNone(by_market["silver"]["snapshot"])
        self.assertFalse(result["liveVerified"])

    async def test_failed_or_unverified_refresh_never_returns_an_old_snapshot(self):
        for failure in ("missing", "unchanged", "failed", "old", "offline"):
            with self.subTest(failure=failure):
                async def request(path, *, method):
                    payload = self.fresh(path)
                    if failure == "missing": payload.pop("acquisition")
                    elif failure == "unchanged": payload["acquisition"]["previousRevision"] = 2
                    elif failure == "failed": payload["refresh"]["state"] = "error"
                    elif failure == "old": payload["acquisition"]["requestedAt"] = "2020-01-01T00:00:00Z"
                    else: raise RuntimeError("Provider unavailable")
                    return payload
                result = await PredictionMarketReader(request=request).fixed_review_universe()
                self.assertEqual(result["status"], "unavailable")
                self.assertTrue(all(row["snapshot"] is None for row in result["data"]["markets"]))

    async def test_refresh_deadline_is_bounded_and_no_event_remains_explicit(self):
        async def stalled(path, *, method):
            await asyncio.sleep(1)
            return self.fresh(path)
        result = await PredictionMarketReader(request=stalled, monitor_wait_seconds=.01).fixed_review_universe()
        self.assertTrue(all(row["snapshot"] is None for row in result["data"]["markets"]))

        async def no_event(path, *, method):
            return self.fresh(path, displayContracts={"status": "unavailable", "reason": "No current open event."})
        result = await PredictionMarketReader(request=no_event).fixed_review_universe()
        self.assertTrue(all(row["error"] == "No current open event." for row in result["data"]["markets"]))


class CheckpointAndSourcesCacheTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="review-run-v2-checkpoint-")
        self.store = ReviewRunV2Store(Path(self.temp.name) / "reviews.sqlite3")

    async def asyncTearDown(self):
        self.temp.cleanup()

    def test_single_serialization_keeps_exact_canonical_fingerprint_and_size(self):
        from review_runs_v2 import canonical_json
        payloads = [
            {"liveVerified": True, "amount": 100_000.25, "nested": {"b": [1, 2.5, None], "a": "Zürich ₿TC"}},
            {"observedAt": datetime(2026, 10, 9, 14, 0, tzinfo=timezone.utc), "rows": [{"ticker": "IGV"}] * 3},
            [], "plain text", {"emoji": "📈", "escaped": "line\nbreak\u0000"},
        ]
        for index, payload in enumerate(payloads):
            with self.subTest(index=index):
                fingerprint, size_bytes = self.store.store_evidence(f"source-{index}", payload)
                self.assertEqual(fingerprint, canonical_fingerprint(payload))
                self.assertEqual(size_bytes, len(canonical_json(payload).encode("utf-8")))
                with self.store.connect() as connection:
                    stored = connection.execute(
                        "SELECT payload_json,size_bytes FROM analyst_review_evidence_v2 WHERE fingerprint=?",
                        (fingerprint,)).fetchone()
                self.assertEqual(stored["payload_json"], canonical_json(payload))
                self.assertEqual(stored["size_bytes"], size_bytes)

    async def test_checkpoint_commits_one_descriptor_with_evidence_without_hydrating_the_run(self):
        run, _ = self.store.create(review_kind="portfolio-review", conversation_id="chat", request_id="one-commit")
        evidence = {"liveVerified": True, "freshness": "live", "asOf": "2026-10-09T14:00:00Z"}
        with patch.object(self.store, "commit_dependency", wraps=self.store.commit_dependency) as commit, \
                patch.object(self.store, "_decode", side_effect=AssertionError("Checkpoint must not hydrate the run")):
            context = ReviewExecutionContext(self.store, run["runId"], "portfolio-review")
            descriptor = await context.checkpoint("portfolio", status="ready", evidence=evidence,
                                                  as_of="2026-10-09T14:00:00Z", detail={"elapsedMs": 120})
        self.assertEqual(commit.call_count, 1)
        self.assertEqual(descriptor["fingerprint"], canonical_fingerprint(evidence))
        saved = self.store.get_source_metadata(run["runId"])["dependencies"]["portfolio"]
        self.assertEqual(saved, descriptor)
        self.assertEqual(saved["sizeBytes"], len(json.dumps(evidence, sort_keys=True, separators=(",", ":")).encode()))
        self.assertEqual(self.store.read_evidence({"dependencies": {"portfolio": saved}}, "portfolio"), evidence)
        # The public merge keeps its existing contract for direct callers.
        merged = self.store.merge_dependency(run["runId"], "portfolioOpenOrders", {"status": "failed"})
        self.assertEqual(merged["dependencies"]["portfolioOpenOrders"], {"status": "failed"})

    async def test_checkpoint_hook_runs_off_loop_after_commit_with_the_run_conversation(self):
        delivered = threading.Event()
        calls = []
        loop_thread = threading.get_ident()

        def hook(conversation_id, run_id, source, status):
            metadata = self.store.get_source_metadata(run_id)
            calls.append((threading.get_ident(), (conversation_id, run_id, source, status),
                          (metadata["dependencies"].get(source) or {}).get("fingerprint")))
            if source == "balance":
                delivered.set()

        async def handler(context):
            await context.checkpoint("portfolioPca", status="pending", error_code="SOURCE_PAUSED")
            await context.checkpoint("balance", status="ready", evidence={"liveVerified": True, "amount": 1},
                                     as_of="2026-10-09T14:00:00Z")
            return {"outcome": "ready", "sections": balance_sections(), "citations": []}

        coordinator = ReviewCoordinatorV2(self.store, {"balance-review": handler}, on_checkpoint=hook)
        started = await coordinator.start(review_kind="balance-review", conversation_id="workspace-chat",
                                          request_id="hooked")
        final = await await_run(coordinator, started["runId"])
        self.assertTrue(await asyncio.to_thread(delivered.wait, 2))
        self.assertEqual(final["state"], "succeeded")
        self.assertEqual([call[1] for call in calls], [
            ("workspace-chat", started["runId"], "portfolioPca", "pending"),
            ("workspace-chat", started["runId"], "balance", "ready"),
        ])
        self.assertTrue(all(thread != loop_thread for thread, _args, _fingerprint in calls))
        # The hook observes the committed descriptor, including its evidence address.
        self.assertEqual(calls[1][2], canonical_fingerprint({"liveVerified": True, "amount": 1}))

    async def test_pipeline_logs_each_step_after_the_handler_with_run_and_loop_lag(self):
        import re

        async def handler(_context):
            return {"outcome": "ready", "sections": balance_sections(), "citations": []}

        for summary, expected in ((None, ["normalize", "render", "complete"]),
                                  (lambda *_args, **_options: "Summary.", ["normalize", "render", "summary", "complete"])):
            with self.subTest(summary=bool(summary)):
                coordinator = ReviewCoordinatorV2(self.store, {"balance-review": handler}, summary_provider=summary)
                with self.assertLogs("market_dashboard.analyst.review_runs_v2", "INFO") as logged:
                    started = await coordinator.start(review_kind="balance-review", request_id=f"phase-log-{bool(summary)}")
                    final = await await_run(coordinator, started["runId"])
                self.assertEqual(final["state"], "succeeded")
                phases = re.findall(
                    rf"Review pipeline run={started['runId']} kind=balance-review phase=(\w+) "
                    r"phaseMs=\d+ elapsedMs=\d+ loopLagMaxMs=\d+(?:\.\d+)?$",
                    "\n".join(logged.output), re.MULTILINE)
                self.assertEqual(phases, expected)

    async def test_checkpoint_hook_failure_is_logged_and_never_fails_or_delays_the_review(self):
        release = threading.Event()
        attempted = threading.Event()

        def hook(*_args):
            attempted.set()
            if not release.wait(2):
                raise AssertionError("Hook was not released")
            raise RuntimeError("Workspace unavailable")

        async def handler(context):
            await context.checkpoint("balance", status="ready", evidence={"liveVerified": True})
            return {"outcome": "ready", "sections": balance_sections(), "citations": []}

        coordinator = ReviewCoordinatorV2(self.store, {"balance-review": handler}, on_checkpoint=hook)
        with self.assertLogs("market_dashboard.analyst.review_runs_v2", "ERROR") as logged:
            started = await coordinator.start(review_kind="balance-review", conversation_id="chat", request_id="hook-fails")
            # The review finishes while its notification is still blocked.
            final = await await_run(coordinator, started["runId"])
            self.assertEqual(final["state"], "succeeded")
            self.assertTrue(await asyncio.to_thread(attempted.wait, 2))
            release.set()
            import review_runs_v2
            await asyncio.to_thread(review_runs_v2._CHECKPOINT_NOTIFIER.submit(lambda: None).result, 2)
        self.assertIn("Review checkpoint hook failed", "\n".join(logged.output))

    async def test_rejected_checkpoint_never_notifies(self):
        calls = []
        run, _ = self.store.create(review_kind="balance-review", conversation_id="chat", request_id="terminal")
        self.store.update(run["runId"], state="cancelled", phase="terminal", outcome="blocked")
        context = ReviewExecutionContext(self.store, run["runId"], "balance-review",
                                         conversation_id="chat", on_checkpoint=lambda *args: calls.append(args))
        with self.assertRaises(ReviewRunError):
            await context.checkpoint("balance", status="ready", evidence={"liveVerified": True})
        import review_runs_v2
        await asyncio.to_thread(review_runs_v2._CHECKPOINT_NOTIFIER.submit(lambda: None).result, 2)
        self.assertEqual(calls, [])
        self.assertNotIn("balance", self.store.get_source_metadata(run["runId"])["dependencies"])

    async def test_paused_checkpoint_is_stored_and_projected_as_pending(self):
        from analyst_review_sources import review_sources
        run, _ = self.store.create(review_kind="portfolio-review", conversation_id="chat", request_id="paused")
        self.store.update(run["runId"], state="running")
        context = ReviewExecutionContext(self.store, run["runId"], "portfolio-review")
        descriptor = await context.checkpoint("portfolioPca", status="pending", error_code="SOURCE_PAUSED")
        saved = self.store.get_source_metadata(run["runId"])
        self.assertEqual(saved["dependencies"]["portfolioPca"], descriptor)
        self.assertEqual((descriptor["status"], descriptor["errorCode"], descriptor["fingerprint"]),
                         ("pending", "SOURCE_PAUSED", None))
        for state in ("running", "failed"):
            with self.subTest(state=state):
                if state == "failed":
                    self.store.update(run["runId"], state="failed", phase="terminal", outcome="blocked")
                    saved = self.store.get_source_metadata(run["runId"])
                item = next(row for row in review_sources(saved, self.store)["items"] if row["id"] == "portfolioPca")
                self.assertEqual(item, {"id": "portfolioPca", "label": "PCA model", "status": "pending", "observedAt": None,
                                        "diagnostic": {"code": "SOURCE_PAUSED",
                                                       "reason": "Paused for now. This source returns when it is re-enabled."}})

    def test_conversation_list_can_hide_tombstoned_ids_without_touching_saved_runs(self):
        created = []
        for request in ("first", "second", "third"):
            conversation, run, _created, _reused = self.store.create_conversation(
                review_kind="balance-review", request_id=request)
            self.store.update(run["runId"], state="succeeded", phase="terminal", outcome="ready",
                              reportMarkdown=f"# {request}")
            created.append((conversation["conversationId"], run["runId"]))
        hidden = created[1][0]
        listed, cursor = self.store.list_conversations(limit=10, exclude_conversation_ids={hidden, "never-saved"})
        self.assertIsNone(cursor)
        self.assertEqual({row["conversationId"] for row in listed}, {created[0][0], created[2][0]})
        first_page, cursor = self.store.list_conversations(limit=1, exclude_conversation_ids=[hidden])
        second_page, last = self.store.list_conversations(limit=1, cursor=cursor, exclude_conversation_ids=[hidden])
        self.assertIsNone(last)
        self.assertEqual([row["conversationId"] for row in first_page + second_page], [created[2][0], created[0][0]])
        self.assertEqual(len(self.store.list_conversations(limit=10)[0]), 3)
        self.assertEqual(self.store.get(created[1][1])["reportMarkdown"], "# second")
        self.assertIsNotNone(self.store.get_conversation(hidden))

    def test_shared_evidence_reuses_one_parse_and_still_verifies_stored_bytes(self):
        import review_runs_v2
        fingerprint, _ = self.store.store_evidence("predictionUniverse", {"data": {"markets": [{"marketId": "gold"}]}})
        run = {"dependencies": {"predictionUniverse": {"fingerprint": fingerprint}}}
        with patch.object(review_runs_v2.json, "loads", wraps=json.loads) as loads:
            first = self.store.read_shared_evidence(run, "predictionUniverse")
            second = self.store.read_shared_evidence(run, "predictionUniverse")
        self.assertIs(first, second)
        self.assertEqual(loads.call_count, 1)
        self.assertEqual(first, self.store.read_evidence(run, "predictionUniverse"))
        with self.store.connect() as connection:
            connection.execute("UPDATE analyst_review_evidence_v2 SET payload_json='{}' WHERE fingerprint=?", (fingerprint,))
        self.assertIsNone(self.store.read_shared_evidence(run, "predictionUniverse"))
        self.assertIsNone(self.store.read_shared_evidence({"dependencies": {}}, "predictionUniverse"))
        self.assertIsNone(self.store.read_shared_evidence(
            {"sourceFingerprints": {"predictionUniverse": fingerprint},
             "dependencies": {"predictionUniverse": {"fingerprint": "another"}}}, "predictionUniverse"))

    def test_shared_evidence_cache_is_bounded_by_entries_bytes_and_payload_size(self):
        import review_runs_v2
        fingerprints = [self.store.store_evidence("source", {"index": index, "padding": "x" * 100})[0] for index in range(6)]
        large = self.store.store_evidence("large", {"padding": "y" * 400})[0]
        with patch.object(review_runs_v2, "SHARED_EVIDENCE_MAX_ENTRIES", 4), \
                patch.object(review_runs_v2, "SHARED_EVIDENCE_MAX_BYTES", 400), \
                patch.object(review_runs_v2, "SHARED_EVIDENCE_MAX_ENTRY_BYTES", 300):
            for fingerprint in fingerprints:
                self.store.read_shared_evidence({"dependencies": {"source": {"fingerprint": fingerprint}}}, "source")
            self.assertLessEqual(len(self.store._shared_evidence), 4)
            self.assertLessEqual(self.store._shared_evidence_bytes, 400)
            self.assertEqual(self.store._shared_evidence_bytes,
                             sum(size for _value, size in self.store._shared_evidence.values()))
            self.assertIn(("source", fingerprints[-1]), self.store._shared_evidence)
            self.assertNotIn(("source", fingerprints[0]), self.store._shared_evidence)
            value = self.store.read_shared_evidence({"dependencies": {"large": {"fingerprint": large}}}, "large")
            self.assertEqual(value["padding"], "y" * 400)
            self.assertNotIn(("large", large), self.store._shared_evidence)

    def saved_portfolio_run(self, state="succeeded"):
        run, _ = self.store.create(review_kind="portfolio-review", conversation_id="saved-sources", request_id="saved-" + state)
        at = "2026-10-09T14:00:00Z"
        evidence = {
            "ibGateway": {"status": "available", "liveVerified": True, "freshness": "live", "asOf": at,
                          "data": {"connected": True}},
            "portfolio": {"status": "available", "liveVerified": True, "freshness": "live", "asOf": at},
            "dailyResearch": {"date": "2026-10-09", "snapshots": {
                "risk-ranges": {"date": "2026-10-09", "publishedAt": "2026-10-09T11:30:00Z", "data": {"rows": []}},
                "the-call": {"date": "2026-10-09", "status": "failed"}}},
            "marketSituation": {"status": "available", "asOf": "2026-10-08",
                                "data": {"realizedVolatility": {"asOf": "2026-10-08"}}},
        }
        dependencies = {}
        for name, value in evidence.items():
            fingerprint, size = self.store.store_evidence(name, value)
            dependencies[name] = {"status": "ready", "asOf": value.get("asOf") or at, "fingerprint": fingerprint,
                                  "sizeBytes": size, "errorCode": None, "updatedAt": at,
                                  "detail": {"liveVerified": True, "elapsedMs": 250}}
        dependencies["portfolioPca"] = {"status": "pending", "asOf": None, "fingerprint": None, "sizeBytes": 0,
                                        "errorCode": "SOURCE_PAUSED", "detail": {}, "updatedAt": at}
        updates = {"state": "running", "dependencies": dependencies}
        if state != "running":
            updates.update(state=state, phase="terminal", outcome="partial", completedAt=at)
        self.store.update(run["runId"], **updates)
        return run["runId"]

    def test_terminal_sources_projection_is_memoized_and_byte_identical(self):
        from analyst_review_sources import review_sources
        products = [{"id": "risk-ranges", "label": "Risk Ranges"}, {"id": "the-call", "label": "The Call"},
                    {"id": "cftc-positioning", "label": "CFTC Positioning"}]

        class Uncached:
            def __init__(self, store):
                self.store = store

            def read_evidence(self, run, name):
                return self.store.read_evidence(run, name)

        run_id = self.saved_portfolio_run()
        metadata = self.store.get_source_metadata(run_id)
        expected = json.dumps(review_sources(metadata, Uncached(self.store), research_products=products))
        first = review_sources(metadata, self.store, research_products=products)
        self.assertEqual(json.dumps(first), expected)
        first["items"][0]["status"] = "mutated by a caller"
        with patch.object(self.store, "read_shared_evidence", side_effect=AssertionError("Memoized projection re-read evidence")), \
                patch.object(self.store, "read_evidence", side_effect=AssertionError("Memoized projection re-read evidence")):
            again = review_sources(metadata, self.store, research_products=products)
            hydrated = review_sources(self.store.get(run_id), self.store, research_products=products)
        self.assertEqual(json.dumps(again), expected)
        self.assertEqual(json.dumps(hydrated), expected)
        # A different product roster or a later baseline update is a different identity.
        self.assertNotEqual(json.dumps(review_sources(metadata, self.store, research_products=products[:1])), expected)
        self.store.update(run_id, baselineAcceptedAt="2026-10-09T14:05:00Z")
        changed = review_sources(self.store.get_source_metadata(run_id), self.store, research_products=products)
        self.assertNotEqual(changed["checkedAt"], json.loads(expected)["checkedAt"])

    def test_active_sources_are_never_memoized(self):
        from analyst_review_sources import review_sources
        run_id = self.saved_portfolio_run("running")
        metadata = self.store.get_source_metadata(run_id)
        review_sources(metadata, self.store)
        self.assertEqual(len(self.store._sources_projections), 0)
        with patch.object(self.store, "read_shared_evidence", wraps=self.store.read_shared_evidence) as read:
            review_sources(metadata, self.store)
        self.assertGreater(read.call_count, 0)


if __name__ == "__main__":
    unittest.main()
