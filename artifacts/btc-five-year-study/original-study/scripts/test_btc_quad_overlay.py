"""Published quarterly source identity and explicit retrospective timing."""
from copy import deepcopy
import tempfile
from pathlib import Path
import unittest

from btc_quad_overlay import assign_quads, digest, normalize_history, quarter_bounds
from btc_usd_features import iso


class QuadSourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        rows = []
        for group in ("g20", "global"):
            payload = ("original-source-image-" + group).encode()
            (self.directory / f"{group}.png").write_bytes(payload)
            normalized = {"group": group,
                "columns": [{"id": "2026-Q2", "label": "2Q26", "kind": "actual"},
                            {"id": "2026-Q3", "label": "3Q26E", "kind": "estimate"}],
                "rows": [{"country": "United States", "aggregate": False, "values": {
                    "2026-Q2": {"quad": 3, "kind": "actual"}, "2026-Q3": {"quad": 4, "kind": "estimate"}}}]}
            content_hash = digest(normalized)
            rows.append({"date": content_hash, "snapshotType": "global-quads-history",
                "candidate": {**normalized, "contentHash": content_hash, "asOf": "2026-08-12"},
                "source": {"sourceType": "reviewed-screenshot", "id": digest(payload), "asOf": "2026-08-12",
                    "receivedAt": "2026-09-09T18:02:55.426Z", "publishedAt": None,
                    "verification": {"method": "visual-source-comparison", "reviewedBy": "reviewer",
                        "contentHash": content_hash, "reviewedAt": "2026-09-09T18:02:55.426Z"}}})
        self.history = {"source": "HedgeyeDailySnapshot/global-quads-history", "rows": rows}

    def tearDown(self):
        self.temporary.cleanup()

    def load(self, history=None, cutoff="2026-09-15T18:00:00Z"):
        return normalize_history(history or self.history, self.directory, cutoff)

    def test_only_original_reviewed_us_cells_become_classifications(self):
        source = self.load()
        self.assertEqual([(r["quarter"], r["quad"], r["kind"]) for r in source["quarters"]],
                         [("2026-Q2", 3, "actual"), ("2026-Q3", 4, "estimate")])
        self.assertEqual(source["availableAt"], "2026-09-09T18:02:55.426000Z")

    def test_modified_transcription_and_image_are_rejected(self):
        altered = deepcopy(self.history)
        altered["rows"][0]["candidate"]["rows"][0]["values"]["2026-Q2"]["quad"] = 2
        with self.assertRaises(ValueError):
            self.load(altered)
        (self.directory / "g20.png").write_bytes(b"different")
        with self.assertRaises(ValueError):
            self.load()

    def test_mock_missing_review_and_future_source_are_rejected(self):
        for change in ("mock", "missing_review"):
            altered = deepcopy(self.history)
            if change == "mock":
                altered["rows"][0]["candidate"]["mock"] = True
            else:
                altered["rows"][0]["source"]["verification"] = {}
            with self.assertRaises(ValueError):
                self.load(altered)
        with self.assertRaises(ValueError):
            self.load(cutoff="2026-09-09T18:02:55.425Z")

    def test_retrospective_actual_never_labels_current_forecast_as_actual(self):
        source = self.load()
        rows = assign_quads([{"hourStart": "2026-06-01T00:00:00Z"}, {"hourStart": "2026-08-01T00:00:00Z"}], source, "retrospective_actual")
        self.assertEqual([row["quad"] for row in rows], [3, None])
        self.assertEqual(rows[0]["quadBasis"], "retrospective_actual")
        self.assertEqual(rows[1]["quadKind"], "estimate")

    def test_point_in_time_never_backdates_printed_table_date(self):
        source = self.load()
        rows = assign_quads([{"hourStart": "2026-08-12T20:00:00Z"},
            {"hourStart": "2026-09-09T18:02:55.425Z"}, {"hourStart": "2026-09-09T18:02:55.426Z"}], source, "point_in_time")
        self.assertEqual([row["quad"] for row in rows], [None, None, 4])
        with self.assertRaises(ValueError):
            assign_quads([], source, "implicit")

    def test_new_york_quarter_boundaries_preserve_dst(self):
        self.assertEqual(tuple(map(iso, quarter_bounds("2026-Q1"))),
                         ("2026-01-01T05:00:00Z", "2026-04-01T04:00:00Z"))
        source = self.load()
        rows = assign_quads([{"hourStart": "2026-07-01T03:59:59Z"}, {"hourStart": "2026-07-01T04:00:00Z"}], source, "retrospective_actual")
        self.assertEqual([row["quad"] for row in rows], [3, None])


if __name__ == "__main__":
    unittest.main()
