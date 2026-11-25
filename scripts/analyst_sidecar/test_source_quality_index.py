import tempfile
import unittest
from pathlib import Path

from index import DeterministicTestEmbedder, NormalizedDocument, ResearchIndex


class SourceQualityIndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.index = ResearchIndex(Path(self.temp.name) / "research.sqlite3", embedder=DeterministicTestEmbedder())
        self.uri = "s3://research/early-look/original.html"
        self.quality = {"status": "discrepancy", "issues": [{
            "id": "original-rut-range", "code": "invalid_bounds", "ticker": "RUT", "field": "riskRange",
            "observed": {"lrr": 2834, "hrr": 2825, "trend": "BULLISH"},
            "source": {"productId": "early-look", "reportDate": "2026-09-22", "artifactKey": self.uri},
        }]}

    def document(self, identity, text, quality=None, uri=None):
        if quality and quality.get("issues"):
            text = "Generated source-quality note.\n\n" + text
        return NormalizedDocument.from_payload({
            "documentId": identity, "product": "early-look", "publicationDate": "2026-09-22",
            "sourceUri": uri or self.uri, "text": text,
            "metadata": {"sourceQuality": quality} if quality else {},
        })

    def test_new_source_annotation_applies_to_old_current_excerpts_without_changing_saved_citation(self):
        original = "RUT published lower 2834, upper 2825. Unaffected SPX thesis remains useful."
        self.index.upsert_documents([self.document("old", original)])
        saved = self.index.document_excerpts("old")[0]
        saved_source = self.index.get_source(saved["citation"]["id"])
        self.index.upsert_documents([self.document("annotated", original, self.quality)])
        current = self.index.document_excerpts("old")[0]
        self.assertEqual(current["citation"], saved["citation"])
        self.assertEqual(self.index.get_source(saved["citation"]["id"]), saved_source)
        self.assertTrue(current["excerpt"].startswith("Source discrepancy (dashboard validation"))
        self.assertIn("published lower 2834 and upper 2825 conflict", current["excerpt"])
        self.assertIn("unaffected research remains usable", current["excerpt"])
        self.assertEqual(current["sourceQuality"], self.quality)

    def test_every_retrieval_path_and_later_chunk_carries_warning_for_exact_source_only(self):
        text = "\n\n".join(f"Paragraph {i}. " + "Published research context. " * 35 for i in range(6))
        text += "\n\nRUT lower 2834 and upper 2825."
        self.index.upsert_documents([
            self.document("old", text), self.document("new", text, self.quality),
            self.document("other", "RUT valid range from another report.", uri="s3://research/another.html"),
        ])
        paths = [self.index.search("RUT", limit=20), self.index.latest_excerpts("early-look", "2026-09-22", 12),
                 self.index.excerpts_for_publication_date("2026-09-22"), self.index.document_excerpts("old", limit=None)]
        self.assertGreater(len(paths[-1]), 2)
        for rows in paths:
            for row in rows:
                with self.subTest(document=row["citation"]["documentId"]):
                    if row["citation"]["sourceUri"] == self.uri:
                        self.assertEqual(row["sourceQuality"], self.quality)
                        self.assertIn("Source discrepancy", row["excerpt"])
                        self.assertNotIn("Source discrepancy", row["citation"]["excerpt"])
                    else:
                        self.assertNotIn("sourceQuality", row)
                        self.assertEqual(row["excerpt"], row["citation"]["excerpt"])

    def test_retired_signal_strength_shorts_documents_stay_out_of_every_listing(self):
        shorts = NormalizedDocument.from_payload({
            "documentId": "shorts", "product": "signal-strength-shorts", "publicationDate": "2026-09-22",
            "sourceUri": "s3://research/signal-strength-shorts/list.html", "text": "Signal Strength Shorts ADDING: RUT"})
        self.index.upsert_documents([self.document("kept", "RUT valid range."), shorts])
        products = lambda rows: {row["citation"]["product"] for row in rows}
        self.assertEqual(products(self.index.search("RUT", limit=20)), {"early-look"})
        self.assertEqual(self.index.search("RUT", product="signal-strength-shorts"), [])
        self.assertEqual(products(self.index.excerpts_for_publication_date("2026-09-22")), {"early-look"})
        self.assertEqual(set(self.index.latest_by_product()), {"early-look"})
        self.assertEqual({row["product"] for row in self.index.recent_documents_by_product()}, {"early-look"})
        self.assertEqual([row["product"] for row in self.index.coverage_counts()["byProduct"]], ["early-look"])

    def test_successful_replay_without_issues_does_not_erase_source_defect(self):
        self.index.upsert_documents([self.document("annotated", "Original RUT range.", self.quality)])
        self.index.upsert_documents([self.document("replayed", "Original RUT range.", {"status": "clear", "issues": []})])
        row = self.index.document_excerpts("replayed")[0]
        self.assertEqual(row["sourceQuality"], self.quality)
        self.assertIn("No corrected values have been established", row["excerpt"])


if __name__ == "__main__":
    unittest.main()
