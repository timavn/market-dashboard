from __future__ import annotations

import asyncio
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from uuid import UUID


SIDECAR_DIR = Path(__file__).resolve().parent
if str(SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(SIDECAR_DIR))

from market import PREDICTIVE_REVIEW_UNIVERSE, PredictionMarketReader
from review_runs_v2 import (
    MAX_SUMMARY_INPUT_BYTES,
    MAX_REVIEW_CONTEXT_BYTES,
    ReviewCoordinatorV2,
    ReviewRunError,
    ReviewRunV2Store,
    bounded_summary_input,
    canonical_fingerprint,
    coordinator_canary,
    public_review_conversation_detail,
    public_review_conversation_summary,
    public_review_run,
    public_review_run_status,
    review_conversation_id,
    review_context_v2,
)


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
    async def test_exact_six_asset_venue_allowlist_never_requests_auto(self):
        paths = []

        async def request(path):
            paths.append(path)
            venue = path.split("venue=", 1)[1].split("&", 1)[0]
            market_id = path.split("/monitor/", 1)[1].split("?", 1)[0]
            return {
                "status": "available",
                "marketId": market_id,
                "selectedVenueId": venue,
                "displaySelection": {"status": "available", "venueId": venue},
                "displayContracts": {
                    "status": "available",
                    "event": {"ticker": f"{market_id}-event"},
                    "lines": [
                        {"ticker": f"{market_id}-contract", "yesBid": 40, "yesAsk": 42}
                    ],
                },
            }

        reader = PredictionMarketReader(request=request)
        result = await reader.fixed_review_universe()
        self.assertEqual(result["status"], "available")
        self.assertEqual(len(paths), 6)
        self.assertEqual(
            [
                (row["marketId"], row["asset"], row["venue"])
                for row in result["data"]["universe"]
            ],
            list(PREDICTIVE_REVIEW_UNIVERSE),
        )
        self.assertFalse(any("venue=auto" in path for path in paths))

    async def test_cached_or_wrong_venue_asset_fails_only_that_row(self):
        async def request(path):
            venue = path.split("venue=", 1)[1].split("&", 1)[0]
            market_id = path.split("/monitor/", 1)[1].split("?", 1)[0]
            selected = "kalshi" if market_id == "silver" else venue
            return {
                "status": "available",
                "marketId": market_id,
                "selectedVenueId": selected,
                "displaySelection": {"status": "available", "venueId": selected},
                "displayContracts": {
                    "status": "available",
                    "cachedOnly": market_id == "wti",
                    "event": {"ticker": f"{market_id}-event"},
                    "lines": [{"ticker": f"{market_id}-contract"}],
                },
            }

        result = await PredictionMarketReader(request=request).fixed_review_universe()
        by_market = {row["marketId"]: row for row in result["data"]["markets"]}
        self.assertEqual(result["status"], "partial")
        self.assertEqual(by_market["silver"]["errorCode"], "PINNED_VENUE_MISMATCH")
        self.assertEqual(by_market["wti"]["errorCode"], "PINNED_VENUE_DATA_INCOMPLETE")
        self.assertEqual(by_market["gold"]["status"], "available")


if __name__ == "__main__":
    unittest.main()
