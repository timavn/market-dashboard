from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import sys
import tempfile
import unittest

SIDECAR_DIR = Path(__file__).resolve().parent
if str(SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(SIDECAR_DIR))

from index import DeterministicTestEmbedder, NormalizedDocument, ResearchIndex
from portfolio_refresh import _citation
from research_source_resolver import ResearchSourceResolver


class ResearchSourceResolverTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.index = ResearchIndex(Path(self.directory.name) / "research.sqlite3", DeterministicTestEmbedder())
        self.resolver = ResearchSourceResolver(self.index)
        self.cutoff = datetime(2026, 10, 5, 19, tzinfo=timezone.utc)

    def tearDown(self):
        self.directory.cleanup()

    def citation(self, *, day="2026-10-02", excerpt="WST Sell some; bullish Trend remains.", event="event-1"):
        return _citation({"id": event, "sourceEventId": event, "productId": "real-time-alert",
                          "productLabel": "Real-Time Alert", "marketDate": day,
                          "sourceUrl": "https://app.hedgeye.com/feed_items/123456",
                          "qualityStatus": "validated", "excerpt": excerpt,
                          "sourceSnapshotId": f"real-time-alert#{day}", "sourceContentHash": "a" * 64,
                          "sourceEvidence": {"bodyText": "Publisher's original full body.", "headline": "WST Sell Signal",
                                             "contentHash": "a" * 64}}, self.cutoff)

    def test_exact_archive_citation_resolves_without_semantic_search_or_live_reads(self):
        citation = self.citation()
        self.assertIsNone(self.index.get_source(citation["id"]))
        self.assertEqual(self.resolver.remember([citation]), 1)
        row = self.resolver.resolve(citation["id"])
        self.assertEqual(row["citation"], citation)
        self.assertEqual(row["excerpt"], "WST Sell some; bullish Trend remains.")
        self.assertEqual(row["publication_date"], "2026-10-02")
        self.assertEqual(row["metadata"]["sourceSnapshotId"], "real-time-alert#2026-10-02")
        self.assertEqual(row["metadata"]["sourceContentHash"], "a" * 64)
        self.assertEqual(row["metadata"]["resolutionSource"], "captured_research_archive")
        self.assertNotIn("bodyText", row["metadata"]["sourceEvidence"])

    def test_index_citations_still_resolve_exactly_and_unknown_ids_do_not_search(self):
        self.index.upsert_documents([NormalizedDocument.from_payload({"product": "the-call", "publicationDate": "2026-10-05",
                                                                      "sourceUri": "gmail://message/report", "text": "Source body."})])
        with self.index.connect() as db:
            citation_id = db.execute("SELECT citation_id FROM chunks").fetchone()[0]
        self.assertEqual(self.resolver.resolve(citation_id), self.index.get_source(citation_id))
        self.assertIsNone(self.resolver.resolve("cite_" + "f" * 32))
        self.assertIsNone(self.resolver.resolve("123"))
        self.assertIsNone(self.resolver.resolve(None))

    def test_later_capture_cannot_replace_old_publication_or_action_scope(self):
        original = self.citation(excerpt="WST Sell some; bullish Trend remains.")
        new = self.citation(day="2026-10-05", excerpt="WST Exit Long.", event="event-2")
        saved = deepcopy(original)
        self.resolver.remember([original, new])
        original["excerpt"] = "Caller mutated this object."
        self.assertEqual(self.resolver.resolve(saved["id"])["citation"], saved)
        returned = self.resolver.resolve(saved["id"])
        returned["metadata"]["sourceEvidence"]["headline"] = "Changed externally"
        self.assertEqual(self.resolver.resolve(saved["id"])["citation"], saved)
        self.assertEqual(self.resolver.resolve(new["id"])["excerpt"], "WST Exit Long.")

    def test_conflicting_reuse_of_a_citation_id_is_quarantined(self):
        original = self.citation()
        conflicting = {**original, "excerpt": "WST Exit Long."}
        self.resolver.remember([original, conflicting, original])
        self.assertIsNone(self.resolver.resolve(original["id"]))
        hash_conflict = self.citation(event="event-3")
        self.resolver.remember([hash_conflict, {**hash_conflict, "sourceContentHash": "b" * 64}])
        self.assertIsNone(self.resolver.resolve(hash_conflict["id"]))

    def test_only_research_fields_are_retained_with_bounded_capacity(self):
        original = {**self.citation(), "positions": [{"last": 123}], "liveVerified": True, "data": {"quotes": []}}
        original["sourceEvidence"]["positions"] = [{"mark": 999}]
        self.resolver.remember([original])
        stored = self.resolver.resolve(original["id"])["citation"]
        self.assertNotIn("positions", stored)
        self.assertNotIn("liveVerified", stored)
        self.assertNotIn("data", stored)
        self.assertNotIn("positions", stored["sourceEvidence"])
        limited = ResearchSourceResolver(self.index, max_sources=1)
        new = self.citation(event="event-2", day="2026-10-05")
        limited.remember([original, new])
        self.assertIsNone(limited.resolve(original["id"]))
        self.assertIsNotNone(limited.resolve(new["id"]))
        too_small = ResearchSourceResolver(self.index, max_bytes=20)
        self.assertEqual(too_small.remember([original]), 0)
        self.assertIsNone(too_small.resolve(original["id"]))

    def test_malformed_or_empty_evidence_never_becomes_an_available_source(self):
        original = self.citation()
        malformed = [{**original, key: value} for key, value in (
            ("id", "cite_placeholder"), ("documentId", "doc_placeholder"), ("publicationDate", "2026-13-99"),
            ("excerpt", ""), ("sourceUri", "javascript:bad"))]
        self.assertEqual(self.resolver.remember(malformed), 0)
        self.assertIsNone(self.resolver.resolve(original["id"]))


if __name__ == "__main__":
    unittest.main()
