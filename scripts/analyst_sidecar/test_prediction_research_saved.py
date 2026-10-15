"""Saved research projections remain bound to each review's immutable capture."""

from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from analyst_review_sources import review_sources
from prediction_research_rollup import build_prediction_research_rollup
from review_runs_v2 import ReviewRunV2Store, attach_prediction_reports, public_review_run
from workspace import WorkspaceStore


CAPTURED = "2026-09-19T17:00:00Z"


def evidence(direction="BULLISH", **updates):
    snapshot = {"snapshotType": "crypto-quant", "reportType": "crypto-quant",
                "date": "2026-09-19", "publishedAt": "2026-09-19T15:00:00Z", "source": "gmail",
                "article": {"headline": "Crypto Quant", "url": "https://app.hedgeye.com/feed_items/crypto",
                            "bodyText": "Bitcoin remains in the published range."},
                "data": {"cryptos": {"BTC": {"trend": direction, "buyTrade": 70000, "sellTrade": 80000}}},
                **updates}
    return {"date": "2026-09-19", "snapshots": {"crypto-quant": snapshot}}


def sections():
    return [{"id": "monitored-markets", "markets": [{
        "marketId": "bitcoin", "asset": "Bitcoin", "venue": "Kalshi", "identity": "original-contract",
        "fields": [["Quotes observed", CAPTURED], ["YES native quote", "bid 0.40 · ask 0.45"]],
        "managerView": {"version": 1, "contracts": {"near": {"nativeAsk": 0.45, "asOf": CAPTURED}},
                        "citationIds": ["shared-citation"]},
        "research": {"sections": [{"id": "legacy-research", "title": "Legacy research",
                    "blocks": [{"type": "paragraph", "text": "Old limited projection.",
                                "citationIds": ["old-research", "shared-citation"]}]}],
                    "citationIds": ["old-research", "shared-citation"]},
    }]}]


class SavedPredictionResearchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="saved-prediction-research-")
        self.addCleanup(self.temp.cleanup)
        self.store = ReviewRunV2Store(Path(self.temp.name) / "reviews.sqlite3")
        self.sequence = 0

    def saved_run(self, source=None, *, cutoff=CAPTURED, state="succeeded", kind="prediction-markets-review",
                  dependency_status="partial", include_fingerprint=True, dependency_only=False,
                  conversation_id=None, prediction_source=None, completed_at=CAPTURED):
        self.sequence += 1
        run, _ = self.store.create(review_kind=kind, conversation_id=conversation_id or f"conversation-{self.sequence}",
                                   request_id=f"request-{self.sequence}")
        fingerprint = self.store.store_evidence("predictionResearch", source)[0] if source is not None else None
        fingerprints = {"predictionResearch": fingerprint} if fingerprint and include_fingerprint and not dependency_only else {}
        dependencies = {"predictionResearch": {"asOf": cutoff, "status": dependency_status,
                        "fingerprint": fingerprint if include_fingerprint else None}}
        if prediction_source is not None:
            fingerprints["predictionUniverse"] = self.store.store_evidence("predictionUniverse", prediction_source)[0]
        self.store.update(run["runId"], state=state, phase="terminal" if state in {"succeeded", "failed"} else "acquiring",
                          outcome="partial", completedAt=completed_at if state == "succeeded" else None,
                          sections=sections(), reportMarkdown="Original immutable report",
                          summaryMarkdown="Original immutable summary", dependencies=dependencies,
                          sourceFingerprints=fingerprints, citations=[
                              {"id": "old-research", "title": "Old projection citation"},
                              {"id": "shared-citation", "title": "Shared signal citation"},
                              {"id": "unrelated-citation", "title": "Keep other evidence"},
                          ])
        return run["runId"], run["conversationId"]

    def database_contents(self):
        with self.store.connect() as connection:
            return {table: [tuple(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY rowid")]
                    for table in ("analyst_review_runs_v2", "analyst_review_evidence_v2")}

    def test_response_reprojects_only_research_and_its_citations_without_writing_archive(self):
        source = evidence()
        original = deepcopy(source)
        run_id, _ = self.saved_run(source)
        before = self.database_contents()
        run = self.store.get(run_id)
        expected = build_prediction_research_rollup(source, as_of=CAPTURED)
        market = run["sections"][0]["markets"][0]
        self.assertEqual(market["research"], expected["markets"]["bitcoin"])
        self.assertEqual({key: value for key, value in market.items() if key != "research"},
                         {key: value for key, value in sections()[0]["markets"][0].items() if key != "research"})
        citation_ids = {citation["id"] for citation in run["citations"]}
        self.assertNotIn("old-research", citation_ids)
        self.assertTrue({"shared-citation", "unrelated-citation"}.issubset(citation_ids))
        self.assertTrue(set(expected["markets"]["bitcoin"]["citationIds"]).issubset(citation_ids))
        self.assertEqual(run["reportMarkdown"], "Original immutable report")
        self.assertEqual(run["summaryMarkdown"], "Original immutable summary")
        self.assertIn("Bullish", public_review_run(run)["reportMarkdown"])
        self.assertEqual(self.store.get(run_id), run)
        self.assertEqual(self.store.read_evidence(run, "predictionResearch"), original)
        self.assertEqual(source, original)
        self.assertEqual(self.database_contents(), before)

    def test_saved_missing_daily_edition_recovers_only_its_already_captured_prior_publication(self):
        source = {"date": "2026-09-19", "snapshots": {"the-call": None, "signal-strength": None},
                  "previousSnapshots": {
                      "the-call": {"date": "2026-09-18", "snapshotType": "the-call",
                                   "publishedAt": "2026-09-18T13:30:00Z",
                                   "article": {"bodyText": "Bitcoin remains bullish.",
                                               "url": "https://app.hedgeye.com/feed_items/original-call"}},
                      "signal-strength": {"date": "2026-09-18", "snapshotType": "signal-strength",
                                          "publishedAt": "2026-09-18T15:45:00Z", "data": {"added": ["IBIT"]}},
                  }}
        run_id, _ = self.saved_run(source)
        before = self.database_contents()
        record = self.store.get(run_id)
        items = {item["id"]: item for item in review_sources(record, self.store)["items"]}
        self.assertEqual(items["the-call"]["status"], "ready")
        self.assertEqual(items["signal-strength"]["publishedAt"], "2026-09-18T15:45:00+00:00")
        self.assertTrue(items["signal-strength"]["verifiedFromCapture"])
        self.assertIn("Bitcoin remains bullish", str(record["sections"][0]["markets"][0]["research"]))
        self.assertEqual(record["sections"][0]["markets"][0]["fields"], sections()[0]["markets"][0]["fields"])
        self.assertEqual(self.store.read_evidence(record, "predictionResearch"), source)
        self.assertEqual(self.database_contents(), before)

    def test_separate_fingerprints_and_dependency_fallback_never_borrow_other_review_research(self):
        first_id, _ = self.saved_run(evidence("BULLISH"), dependency_only=True)
        first = self.store.get(first_id)
        second_id, _ = self.saved_run(evidence("BEARISH"))
        second = self.store.get(second_id)
        self.assertNotEqual(first["dependencies"]["predictionResearch"]["fingerprint"],
                            second["sourceFingerprints"]["predictionResearch"])
        self.assertIn("Bullish", str(first["sections"][0]["markets"][0]["research"]))
        self.assertIn("Bearish", str(second["sections"][0]["markets"][0]["research"]))
        self.assertEqual(self.store.get(first_id), first)

    def test_research_uses_original_capture_cutoff_and_rejects_fabricated_publications(self):
        for updates in ({"publishedAt": "2026-09-19T17:00:01Z"}, {"date": "2026-09-20"},
                        {"mock": True}, {"seeded": True}, {"refreshFailed": True}):
            with self.subTest(updates=updates):
                run_id, _ = self.saved_run(evidence(**updates))
                market = self.store.get(run_id)["sections"][0]["markets"][0]
                self.assertEqual(market["research"]["sections"], [])
                self.assertEqual(market["managerView"], sections()[0]["markets"][0]["managerView"])

    def test_dated_research_survives_provider_disconnect_without_changing_native_quotes(self):
        run_id, _ = self.saved_run(evidence(providerStatus="offline", fromCache=True))
        market = self.store.get(run_id)["sections"][0]["markets"][0]
        self.assertIn("Bullish", str(market["research"]))
        self.assertEqual(market["fields"], sections()[0]["markets"][0]["fields"])

    def test_active_failed_other_kind_or_unproven_capture_is_not_reprojected(self):
        for arguments in ({"state": "queued"}, {"state": "running"}, {"state": "failed"},
                          {"kind": "portfolio-review"}, {"include_fingerprint": False},
                          {"cutoff": None}, {"cutoff": "not-a-date"}, {"cutoff": "2026-09-19"},
                          {"dependency_status": "failed"}):
            with self.subTest(arguments=arguments):
                run_id, _ = self.saved_run(evidence(), **arguments)
                with patch.object(self.store, "read_evidence", side_effect=AssertionError("Unexpected archive read")):
                    self.assertEqual(self.store.get(run_id)["sections"], sections())
                if arguments.get("state") in {"queued", "running"}:
                    self.store.update(run_id, state="failed", phase="terminal")

    def test_missing_corrupt_or_mismatched_archived_evidence_does_not_replace_saved_projection(self):
        for variant in ("missing", "corrupt", "mismatched"):
            with self.subTest(variant=variant):
                run_id, _ = self.saved_run(evidence())
                with self.store.connect() as connection:
                    if variant == "missing":
                        connection.execute("DELETE FROM analyst_review_evidence_v2 WHERE fingerprint = ?",
                                           (self.store.get(run_id)["sourceFingerprints"]["predictionResearch"],))
                    elif variant == "corrupt":
                        connection.execute("UPDATE analyst_review_evidence_v2 SET payload_json = '{}' WHERE source_name = 'predictionResearch'")
                    else:
                        connection.execute("UPDATE analyst_review_runs_v2 SET source_fingerprints_json = ? WHERE run_id = ?",
                                           ('{"predictionResearch":"another-fingerprint"}', run_id))
                self.assertEqual(self.store.get(run_id)["sections"], sections())

    def test_additional_prediction_context_comes_from_same_saved_universe(self):
        universe = {"status": "available", "data": {"markets": [{"marketId": "sp500", "capture": "first"}]}}
        completed_at = "2026-09-19T17:00:35Z"
        run_id, _ = self.saved_run(evidence(), prediction_source=universe, completed_at=completed_at)
        self.saved_run(evidence("BEARISH"), prediction_source={"status": "available", "capture": "second"})
        self.store._saved_prediction_projections.clear()
        with patch("prediction_research_rollup.build_prediction_research_rollup", wraps=build_prediction_research_rollup) as build:
            self.store.get(run_id)
        self.assertEqual(build.call_args.kwargs, {"as_of": CAPTURED, "prediction_evidence": universe,
                                                 "prediction_as_of": completed_at})

    def test_invalid_completion_clock_keeps_prediction_context_at_original_research_cutoff(self):
        for completed_at in (None, "not-a-date", "2026-09-19"):
            with self.subTest(completed_at=completed_at):
                run_id, _ = self.saved_run(evidence(), completed_at=completed_at)
                self.store._saved_prediction_projections.clear()
                with patch("prediction_research_rollup.build_prediction_research_rollup", wraps=build_prediction_research_rollup) as build:
                    self.store.get(run_id)
                self.assertEqual(build.call_args.kwargs["prediction_as_of"], CAPTURED)

    def test_workspace_get_attachment_reprojects_report_and_evidence_without_persisting(self):
        workspace = WorkspaceStore(Path(self.temp.name) / "workspace.sqlite3")
        conversation_id = workspace.dispatch("daily", {"kind": "prediction-markets-review", "date": "2026-09-19",
                                                        "title": "Predictive Markets Review"})["conversation"]["id"]
        run_id, _ = self.saved_run(evidence(), conversation_id=conversation_id)
        workspace.dispatch("append", {"conversationId": conversation_id, "sourceId": f"daily-report:{run_id}",
                                      "text": "Original saved workspace report"})
        conversation = workspace.dispatch("get", {"conversationId": conversation_id})["conversation"]
        conversation["messages"][0]["citations"] = [
            {"id": "old-research", "product": "crypto-quant", "title": "Prior limited projection"},
            {"id": "workspace-only", "product": "held-position", "title": "Original position evidence"},
        ]
        original, before = deepcopy(conversation), self.database_contents()
        projected = attach_prediction_reports(conversation, self.store)
        self.assertIn("Bullish", projected["messages"][0]["text"])
        citation_ids = {citation["id"] for citation in projected["messages"][0]["citations"]}
        self.assertNotIn("old-research", citation_ids)
        self.assertIn("workspace-only", citation_ids)
        run = self.store.get(run_id)
        self.assertTrue(set(run["sections"][0]["markets"][0]["research"]["citationIds"]).issubset(citation_ids))
        restored = deepcopy(projected)
        restored["messages"][0]["text"] = original["messages"][0]["text"]
        restored["messages"][0]["citations"] = original["messages"][0]["citations"]
        self.assertEqual(restored, original)
        self.assertEqual(conversation, original)
        self.assertIs(attach_prediction_reports(projected, self.store), projected)
        self.assertEqual(workspace.dispatch("get", {"conversationId": conversation_id})["conversation"]["messages"][0]["text"],
                         "Original saved workspace report")
        self.assertEqual(self.database_contents(), before)


if __name__ == "__main__":
    unittest.main()
