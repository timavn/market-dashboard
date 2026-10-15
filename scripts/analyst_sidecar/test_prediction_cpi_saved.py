"""Saved CPI bounds come only from the immutable evidence for that review."""

from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from review_runs_v2 import (
    ReviewRunV2Store,
    attach_prediction_reports,
    public_review_conversation_detail,
    public_review_run,
)


CAPTURED = "2026-09-19T19:34:23Z"
BASE_ONLY = "3.61% · published 2026-09-16T15:37:07Z"


def evidence():
    event = {"ticker": "CPIY_0926", "venueId": "forecastex", "reportMonth": "2026-09",
             "releaseKey": "KXCPIYOY#2026-09", "closeTime": "2026-10-14T12:30:00Z"}
    return {"status": "available", "asOf": CAPTURED, "data": {"markets": [{
        "marketId": "cpi", "requestedVenue": "forecastex", "snapshot": {
            "marketId": "cpi", "selectedVenueId": "forecastex",
            "displaySelection": {"venueId": "forecastex"},
            "venues": {"forecastex": {"catalog": {"status": "available", "event": event}}},
            "forecastComparison": {"status": "available", "eventTicker": "CPIY_0926",
                "reportMonth": "2026-09", "releaseKey": "KXCPIYOY#2026-09",
                "hedgeye": {"status": "available", "reportMonth": "2026-09", "baseValue": 3.61,
                    "asOf": "2026-09-16T15:37:07Z", "source": "hedgeye-inflation-nowcast",
                    "scenarios": [{"key": "downside", "value": 3.50}, {"key": "base", "value": 3.61},
                                  {"key": "upside", "value": 3.72}]},
            },
        },
    }]}}


def sections(nowcast=BASE_ONLY):
    return [{"id": "monitored-markets", "markets": [{
        "marketId": "cpi", "asset": "CPI", "venue": "ForecastEx", "identity": "CPIY_0926_3.6",
        "fields": [["Hedgeye nowcast", nowcast], ["Cleveland Fed nowcast", "3.50% · published 2026-09-17"],
                   ["YES native quote", "bid 0.40 · ask 0.45"], ["Quotes observed", CAPTURED]],
        "managerView": {"version": 1, "contracts": {"near": {"nativeAsk": 0.45, "asOf": CAPTURED}}},
    }, {"marketId": "gold", "asset": "Gold", "venue": "Kalshi", "fields": [],
        "managerView": {"version": 1, "trend": {"direction": "BULLISH", "publishedAt": "2026-09-18"}}}]}]


class SavedCpiForecastTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="saved-cpi-")
        self.addCleanup(self.temp.cleanup)
        self.store = ReviewRunV2Store(Path(self.temp.name) / "reviews.sqlite3")
        self.sequence = 0

    def saved_run(self, source=None, *, report_sections=None, include_fingerprint=True):
        self.sequence += 1
        run, _ = self.store.create(review_kind="prediction-markets-review",
                                   conversation_id=f"conversation-{self.sequence}", request_id=f"request-{self.sequence}")
        fingerprint = self.store.store_evidence("predictionUniverse", source)[0] if source is not None else None
        self.store.update(run["runId"], state="succeeded", phase="terminal", outcome="partial",
                          completedAt=CAPTURED, sections=report_sections or sections(),
                          reportMarkdown="Original immutable report", summaryMarkdown="Original immutable summary",
                          sourceFingerprints={"predictionUniverse": fingerprint} if fingerprint and include_fingerprint else {},
                          dependencies={"predictionUniverse": {"fingerprint": fingerprint, "asOf": CAPTURED}} if fingerprint else {})
        return run["runId"], run["conversationId"]

    def cpi(self, run_id):
        return self.store.get(run_id)["sections"][0]["markets"][0]

    def database_contents(self):
        with self.store.connect() as connection:
            return {table: [tuple(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY rowid")]
                    for table in ("analyst_review_runs_v2", "analyst_review_evidence_v2")}

    def test_saved_run_and_conversation_restore_bounds_without_mutating_capture(self):
        original_source, original_sections = evidence(), sections()
        run_id, conversation_id = self.saved_run(original_source, report_sections=original_sections)
        before = self.database_contents()
        run = self.store.get(run_id)
        conversation = self.store.get_conversation(conversation_id)
        reports = [public_review_run(run)["reportMarkdown"],
                   public_review_conversation_detail(conversation)["messages"][1]["text"]]
        for report in reports:
            for value in ("Lower 3.50%", "Base 3.61%", "Upper 3.72%"):
                self.assertIn(value, report)
        expected = deepcopy(original_sections)
        expected[0]["markets"][0]["fields"][0][1] = (
            "Lower 3.50% · Base 3.61% · Upper 3.72% · published 2026-09-16T15:37:07Z"
        )
        self.assertEqual(run["sections"], expected)
        self.assertEqual(run["reportMarkdown"], "Original immutable report")
        self.assertEqual(run["summaryMarkdown"], "Original immutable summary")
        self.assertEqual(self.database_contents(), before)
        self.assertEqual(original_sections, sections())
        self.assertEqual(self.store.read_evidence(run, "predictionUniverse"), original_source)

    def test_each_run_uses_only_its_fingerprint_and_never_borrows_latest(self):
        first, _ = self.saved_run(evidence())
        newer_source = evidence()
        forecast = newer_source["data"]["markets"][0]["snapshot"]["forecastComparison"]["hedgeye"]
        forecast.update(baseValue=4.0, scenarios=[{"key": "downside", "value": 3.9}, {"key": "upside", "value": 4.1}])
        second, _ = self.saved_run(newer_source)
        missing, _ = self.saved_run()
        self.assertIn("Lower 3.50%", dict(self.cpi(first)["fields"])["Hedgeye nowcast"])
        self.assertIn("Lower 3.90%", dict(self.cpi(second)["fields"])["Hedgeye nowcast"])
        self.assertEqual(dict(self.cpi(missing)["fields"])["Hedgeye nowcast"], BASE_ONLY)

    def test_unsafe_provenance_or_different_release_preserves_recorded_base(self):
        for location, key, value in (
            ("envelope", "mock", True), ("raw", "seeded", True), ("snapshot", "cacheOnly", True),
            ("forecast", "source", "synthetic model"), ("forecast", "stale", True),
            ("forecast", "reportMonth", "2026-08"), ("comparison", "releaseKey", "KXCPIYOY#2026-08"),
            ("raw", "requestedVenue", "kalshi"), ("snapshot", "selectedVenueId", "kalshi"),
        ):
            with self.subTest(location=location, key=key, value=value):
                source = evidence()
                raw = source["data"]["markets"][0]
                snapshot = raw["snapshot"]
                targets = {"envelope": source, "raw": raw, "snapshot": snapshot,
                           "comparison": snapshot["forecastComparison"],
                           "forecast": snapshot["forecastComparison"]["hedgeye"]}
                targets[location][key] = value
                run_id, _ = self.saved_run(source)
                self.assertEqual(dict(self.cpi(run_id)["fields"])["Hedgeye nowcast"], BASE_ONLY)

    def test_invalid_or_later_publication_cannot_enter_an_earlier_capture(self):
        for as_of in ("2026-09-19T19:34:24Z", "2026-09-20", "not a date", "2026-09-31"):
            with self.subTest(as_of=as_of):
                source = evidence()
                source["data"]["markets"][0]["snapshot"]["forecastComparison"]["hedgeye"]["asOf"] = as_of
                run_id, _ = self.saved_run(source)
                self.assertEqual(dict(self.cpi(run_id)["fields"])["Hedgeye nowcast"], BASE_ONLY)

    def test_date_only_publication_and_dependency_fingerprint_are_supported(self):
        source = evidence()
        source["data"]["markets"][0]["snapshot"]["forecastComparison"]["hedgeye"]["asOf"] = "2026-09-16"
        run_id, _ = self.saved_run(source, include_fingerprint=False)
        restored = dict(self.cpi(run_id)["fields"])["Hedgeye nowcast"]
        self.assertIn("Lower 3.50%", restored)
        self.assertTrue(restored.endswith("published 2026-09-16"))

    def test_missing_or_ambiguous_raw_evidence_keeps_base_only_report(self):
        for variant in ("absent", "duplicate", "no scenarios"):
            with self.subTest(variant=variant):
                source = evidence()
                if variant == "absent":
                    source["data"]["markets"] = []
                elif variant == "duplicate":
                    source["data"]["markets"] *= 2
                else:
                    del source["data"]["markets"][0]["snapshot"]["forecastComparison"]["hedgeye"]["scenarios"]
                run_id, _ = self.saved_run(source)
                self.assertEqual(dict(self.cpi(run_id)["fields"])["Hedgeye nowcast"], BASE_ONLY)

    def test_already_projected_scenarios_do_not_reload_evidence(self):
        projected = "Lower 3.50% · Base 3.61% · Upper 3.72% · published 2026-09-16"
        run_id, _ = self.saved_run(evidence(), report_sections=sections(projected))
        with patch.object(self.store, "read_evidence", side_effect=AssertionError("Unexpected evidence read")):
            self.assertEqual(dict(self.cpi(run_id)["fields"])["Hedgeye nowcast"], projected)

    def test_workspace_projection_updates_only_text_from_the_same_saved_capture(self):
        run_id, conversation_id = self.saved_run(evidence())
        conversation = {"id": conversation_id, "kind": "prediction-markets-review", "revision": 9,
                        "messages": [{"id": "report", "role": "assistant", "reviewRunId": run_id,
                                      "reviewNarrative": False, "reviewUnchanged": False, "state": "complete",
                                      "text": "Old report body", "created_at": CAPTURED,
                                      "citations": [{"id": "original-citation"}]}]}
        original, database = deepcopy(conversation), self.database_contents()
        projected = attach_prediction_reports(conversation, self.store)
        self.assertIsNot(projected, conversation)
        self.assertIn("Lower 3.50% · Base 3.61% · Upper 3.72%", projected["messages"][0]["text"])
        restored_metadata = deepcopy(projected)
        restored_metadata["messages"][0]["text"] = "Old report body"
        self.assertEqual(restored_metadata, original)
        self.assertEqual(conversation, original)
        self.assertEqual(self.database_contents(), database)
        self.assertIs(attach_prediction_reports(projected, self.store), projected)

    def test_workspace_never_projects_other_runs_or_nonreport_messages(self):
        run_id, conversation_id = self.saved_run(evidence())
        other_id, _ = self.saved_run(evidence())
        messages = [{"id": "other conversation", "role": "assistant", "reviewRunId": other_id,
                     "text": "Do not borrow another review"},
                    {"id": "narrative", "role": "assistant", "reviewRunId": run_id,
                     "reviewNarrative": True, "text": "Preserve authored analysis"},
                    {"id": "unchanged", "role": "assistant", "reviewRunId": run_id,
                     "reviewUnchanged": True, "text": "No material changes"},
                    {"id": "user", "role": "user", "reviewRunId": run_id, "text": "Follow-up question"},
                    {"id": "unlinked", "role": "assistant", "text": "Unlinked response"},
                    {"id": "failed", "role": "assistant", "reviewRunId": run_id,
                     "state": "failed", "text": "Could not complete"}]
        conversation = {"id": conversation_id, "kind": "prediction-markets-review", "messages": messages}
        with patch.object(self.store, "get", wraps=self.store.get) as get:
            self.assertIs(attach_prediction_reports(conversation, self.store), conversation)
            get.assert_called_once_with(other_id)
        with patch.object(self.store, "get", side_effect=AssertionError("Unexpected read")):
            nonprediction = {**conversation, "kind": "portfolio-review"}
            self.assertIs(attach_prediction_reports(nonprediction, self.store), nonprediction)

    def test_workspace_preserves_failed_missing_and_unnormalized_runs(self):
        for variant in ("missing", "failed", "wrong kind", "no markets"):
            with self.subTest(variant=variant):
                run_id, conversation_id = self.saved_run(evidence())
                run = self.store.get(run_id)
                if variant == "missing":
                    run = None
                elif variant == "failed":
                    run["state"] = "failed"
                elif variant == "wrong kind":
                    run["reviewKind"] = "portfolio-review"
                else:
                    run["sections"] = []
                conversation = {"id": conversation_id, "kind": "prediction-markets-review",
                                "messages": [{"role": "assistant", "reviewRunId": run_id, "text": "Original"}]}
                with patch.object(self.store, "get", return_value=run):
                    self.assertIs(attach_prediction_reports(conversation, self.store), conversation)


if __name__ == "__main__":
    unittest.main()
