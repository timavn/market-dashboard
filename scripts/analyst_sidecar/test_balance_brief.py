from copy import deepcopy
from pathlib import Path
import tempfile
import unittest

from balance_brief import attach_balance_primary
from review_runs_v2 import ReviewExecutionContext, ReviewRunV2Store
from test_portfolio_review_coordinator import verified_balance_context


class BalancePrimaryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = ReviewRunV2Store(Path(self.temp.name) / "reviews.sqlite3")

    async def capture(self, evidence=None, *, request="current"):
        run, _ = self.store.create(review_kind="balance-review", conversation_id="balance", request_id=request)
        self.store.update(run["runId"], state="running", phase="acquiring")
        context = ReviewExecutionContext(self.store, run["runId"], "balance-review")
        if evidence is not None:
            await context.checkpoint("balance", status="partial", evidence=evidence, as_of=evidence.get("asOf"))
        return run

    def conversation(self, run):
        return {"id": "balance", "kind": "balance-review", "reviewRunId": run["runId"], "messages": [
            {"id": "saved", "role": "assistant", "state": "complete", "reviewRunId": "saved-run",
             "reviewPostId": "saved", "text": "Immutable older balance report."},
            {"id": "managed", "role": "assistant", "state": "running", "reviewRunId": run["runId"],
             "reviewPostId": run["runId"], "text": "", "citations": []},
        ]}

    async def test_current_checkpoint_shows_exact_primary_before_report_frame_or_history(self):
        evidence = verified_balance_context()
        evidence["data"]["history"] = None
        evidence["data"]["interestStatus"] = None
        original = deepcopy(evidence)
        run = await self.capture(evidence)
        conversation = self.conversation(run)
        primary = attach_balance_primary(conversation, self.store)["messages"][-1]
        self.assertTrue(primary["balancePrimary"]["available"])
        self.assertEqual(primary["balancePrimary"]["runId"], run["runId"])
        self.assertEqual(primary["balancePrimary"]["asOf"], evidence["data"]["current"]["observedAt"])
        self.assertIn("$100,000.00", primary["text"])
        self.assertNotIn("No issues detected", primary["text"])
        self.assertEqual(primary["state"], "running")
        self.assertEqual(conversation["messages"][0]["text"], "Immutable older balance report.")
        self.assertFalse(self.store.get_status(run["runId"])["reportAvailable"])
        self.assertEqual(self.store.read_evidence(self.store.get(run["runId"]), "balance"), original)

    async def test_completed_capture_retains_exact_saved_body_and_marker_requires_fresh_bytes(self):
        run = await self.capture(verified_balance_context())
        report = "# Balance Review\n\nExact captured current, accounting history, and exceptions.\n"
        self.store.update(run["runId"], state="succeeded", reportMarkdown=report)
        primary = attach_balance_primary(self.conversation(run), self.store)["messages"][-1]
        self.assertEqual(primary["text"], report)
        revision = primary["balancePrimary"]["reportRevision"]
        with self.store.connect() as connection:
            connection.execute("UPDATE analyst_review_evidence_v2 SET payload_json='{}' WHERE source_name='balance'")
        rejected = attach_balance_primary(self.conversation(run), self.store)["messages"][-1]
        self.assertFalse(rejected["balancePrimary"]["available"])
        self.assertNotEqual(rejected["balancePrimary"]["reportRevision"], revision)
        self.assertEqual(rejected["text"], "Balance evidence unavailable.")
        self.assertEqual(self.store.get(run["runId"])["reportMarkdown"], report)

    async def test_pending_or_unverified_current_never_becomes_a_primary(self):
        for index, flag in enumerate(("stale", "cached", "cacheOnly", "fromCache", "from_cache", "mock", "seed", "seeded", "synthetic", "fallback", "inferred", "portfolioDerived", "offline", "disconnected", "refreshFailed", "connected")):
            for level in ("root", "current"):
                evidence = verified_balance_context()
                target = evidence if level == "root" else evidence["data"]["current"]
                target[flag] = flag != "connected"
                with self.subTest(flag=flag, level=level):
                    run = await self.capture(evidence, request=f"flag-{index}-{level}")
                    primary = attach_balance_primary(self.conversation(run), self.store)["messages"][-1]
                    self.assertFalse(primary["balancePrimary"]["available"])
                    self.assertEqual(primary["text"], "")
                    self.store.update(run["runId"], state="failed")
        run = await self.capture()
        primary = attach_balance_primary(self.conversation(run), self.store)["messages"][-1]
        self.assertFalse(primary["balancePrimary"]["available"])
        self.assertEqual(primary["text"], "")

    async def test_foreign_narrative_and_unmanaged_messages_cannot_borrow_current_balance(self):
        run = await self.capture(verified_balance_context())
        for changed in ({"id": "foreign"}, {"kind": "portfolio-review"}):
            conversation = {**self.conversation(run), **changed}
            original = deepcopy(conversation)
            self.assertEqual(attach_balance_primary(conversation, self.store), original)
        for changed in ({"reviewNarrative": True}, {"reviewPostId": None}, {"role": "user"}, {"reviewRunId": "unknown"}):
            conversation = self.conversation(run)
            conversation["messages"][-1].update(changed)
            original = deepcopy(conversation)
            self.assertEqual(attach_balance_primary(conversation, self.store), original)
        self.store.update(run["runId"], state="cancelled")
        original = self.conversation(run)
        self.assertEqual(attach_balance_primary(deepcopy(original), self.store), original)
