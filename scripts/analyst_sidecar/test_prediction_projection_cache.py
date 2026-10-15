"""Warm saved reports skip large JSON parsing while verifying the original bytes."""

from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from prediction_research_rollup import build_prediction_research_rollup
from review_runs_v2 import ReviewRunV2Store, canonical_json
from test_prediction_cpi_saved import BASE_ONLY, evidence as cpi_evidence, sections as cpi_sections
from test_prediction_research_saved import CAPTURED, evidence as research_evidence, sections as research_sections


class PredictionProjectionCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="prediction-projection-cache-")
        self.addCleanup(self.temp.cleanup)
        self.store = ReviewRunV2Store(Path(self.temp.name) / "reviews.sqlite3")
        self.sections = research_sections()
        self.sections[0]["markets"].append(cpi_sections()[0]["markets"][0])
        universe = cpi_evidence()
        universe["largeChartPadding"] = "x" * 1024 * 1024
        universe["asOf"] = CAPTURED
        fingerprints = {"predictionResearch": self.store.store_evidence("predictionResearch", research_evidence())[0],
                        "predictionUniverse": self.store.store_evidence("predictionUniverse", universe)[0]}
        run, _ = self.store.create(review_kind="prediction-markets-review", conversation_id="cache-conversation", request_id="capture")
        self.run_id = run["runId"]
        self.store.update(self.run_id, state="succeeded", phase="terminal", outcome="partial", completedAt=CAPTURED,
                          sections=self.sections, sourceFingerprints=fingerprints,
                          dependencies={name: {"asOf": CAPTURED, "status": "ready", "fingerprint": fingerprint}
                                        for name, fingerprint in fingerprints.items()})

    def test_warm_projection_checks_blobs_once_without_decoding_them_or_rebuilding(self):
        expected = self.store.get(self.run_id)
        statements = []
        connect = self.store.connect

        def observed_connect():
            connection = connect()
            connection.set_trace_callback(statements.append)
            return connection

        with patch.object(self.store, "connect", side_effect=observed_connect), \
                patch.object(self.store, "_decode_saved_evidence_payload", side_effect=AssertionError("Unexpected large JSON parse")), \
                patch("prediction_research_rollup.build_prediction_research_rollup", side_effect=AssertionError("Unexpected projection rebuild")):
            self.assertEqual(self.store.get(self.run_id), expected)
        evidence_reads = [statement for statement in statements if "SELECT payload_json" in statement]
        self.assertEqual(len(evidence_reads), 2)
        self.assertEqual(sum("'predictionUniverse'" in statement for statement in evidence_reads), 1)
        self.assertNotIn("largeChartPadding", canonical_json(list(self.store._saved_prediction_projections.values())))

    def test_tampered_research_is_rejected_even_with_a_warm_projection(self):
        original = self.store.get(self.run_id)
        self.assertNotEqual(original["sections"][0]["markets"][0]["research"], self.sections[0]["markets"][0]["research"])
        with self.store.connect() as connection:
            # Even semantically equivalent JSON is no longer the fingerprinted
            # byte sequence written by store_evidence.
            connection.execute("UPDATE analyst_review_evidence_v2 SET payload_json = payload_json || ' ' WHERE source_name = 'predictionResearch'")
        result = self.store.get(self.run_id)
        self.assertEqual(result["sections"][0]["markets"][0]["research"], self.sections[0]["markets"][0]["research"])

    def test_tampered_universe_invalidates_cpi_and_research_context_without_borrowing_cache(self):
        self.store.get(self.run_id)
        with self.store.connect() as connection:
            connection.execute("UPDATE analyst_review_evidence_v2 SET payload_json = '{}' WHERE source_name = 'predictionUniverse'")
        with patch("prediction_research_rollup.build_prediction_research_rollup", wraps=build_prediction_research_rollup) as build:
            result = self.store.get(self.run_id)
        self.assertEqual(build.call_args.kwargs["prediction_evidence"], {})
        cpi = result["sections"][0]["markets"][1]
        self.assertEqual(dict(cpi["fields"])["Hedgeye nowcast"], BASE_ONLY)

    def test_response_mutation_never_changes_cached_projection_and_cache_is_bounded(self):
        changed = self.store.get(self.run_id)
        expected = deepcopy(changed)
        changed["sections"][0]["markets"][0]["research"]["sections"].clear()
        self.assertEqual(self.store.get(self.run_id), expected)
        for index in range(30):
            self.store._saved_projection_put(("small", index), {"rows": [index]})
        self.assertEqual(len(self.store._saved_prediction_projections), 16)
        self.store._saved_projection_put(("oversized",), {"body": "x" * 512 * 1024})
        self.assertNotIn(("oversized",), self.store._saved_prediction_projections)


if __name__ == "__main__":
    unittest.main()
