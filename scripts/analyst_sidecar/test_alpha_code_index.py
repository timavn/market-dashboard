"""Full indexed Alpha Code source capture without search rank or text truncation."""

from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from index import DeterministicTestEmbedder, NormalizedDocument, ResearchIndex


DAY = "2026-09-18"
CUTOFF = "2026-09-18T17:00:00Z"
INDEXED = "2026-09-18T16:00:00Z"


class AlphaCodeIndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="alpha-code-index-")
        self.addCleanup(self.temp.cleanup)
        self.index = ResearchIndex(Path(self.temp.name) / "research.sqlite3", embedder=DeterministicTestEmbedder())

    def insert(self, identity, text, *, day=DAY, indexed_at=INDEXED, **extra):
        document = NormalizedDocument.from_payload({
            "documentId": identity, "product": "early-look", "publicationDate": day,
            "title": identity, "sourceUri": f"gmail://message/{identity}", "text": text, **extra,
        })
        with patch("index.utc_now_iso", return_value=indexed_at):
            self.index.upsert_documents([document])
        return document

    def contents(self):
        with self.index.connect() as connection:
            return {table: [tuple(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY rowid")]
                    for table in ("documents", "chunks", "page_grants")}

    def test_matching_document_retains_every_ordered_chunk_and_full_long_excerpts(self):
        text = "Alpha Code: Trade first, then Trend.\n\n" + "\n\n".join(
            f"Section {index}: " + "source words " * 95 for index in range(32)
        ) + "\n\nSPX = 7651/7501"
        self.insert("full-document", text)
        self.insert("long-chunk", "Trend " + "x" * 2200)
        rows = {row["documentId"]: row for row in self.index.alpha_code_documents(DAY, as_of=CUTOFF)}
        full = rows["full-document"]
        self.assertGreater(len(full["chunks"]), 24)
        self.assertEqual([row["ordinal"] for row in full["chunks"]], list(range(1, len(full["chunks"]) + 1)))
        self.assertIn("SPX = 7651/7501", full["chunks"][-1]["excerpt"])
        self.assertEqual(rows["long-chunk"]["chunks"][0]["excerpt"], "Trend " + "x" * 2200)
        for chunk in rows["long-chunk"]["chunks"]:
            self.assertEqual(chunk["citation"]["excerpt"], chunk["excerpt"])

    def test_scan_covers_all_products_and_dates_without_top_k_or_keyword_only_chunks(self):
        for index in range(35):
            self.insert(f"document-{index:02}", "TRADE threshold context.", product=f"product-{index}")
        self.insert("older-publication", "Alpha Code = 100/90", day="2025-07-28", product="generic")
        self.insert("unrelated", "Unrelated operational correspondence.")
        rows = self.index.alpha_code_documents(DAY, as_of=CUTOFF)
        self.assertEqual(len(rows), 36)
        self.assertEqual(rows[-1]["documentId"], "older-publication")
        self.assertNotIn("unrelated", {row["documentId"] for row in rows})
        self.assertEqual(rows, self.index.alpha_code_documents(DAY, as_of=CUTOFF))

    def test_source_metadata_pdf_pages_and_original_citations_are_retained_without_grants(self):
        metadata = {"publishedAt": "2026-09-18T12:30:00Z", "observedAt": "2026-09-18T12:32:00Z",
                    "pdfSha256": "a" * 64, "extraction": "textract", "baseDocumentId": "pdf-document"}
        document = self.insert("pdf:p3", "Gold's Alpha Code = 4395/4251", mediaType="application/pdf", page=3,
                               section="Page 3", sourceUri="s3://research/document.pdf#page=3", metadata=metadata)
        before = self.contents()
        with patch.object(self.index, "_grant_page", side_effect=AssertionError("No PDF rendering grants")), \
             patch.object(self.index.embedder, "embed", side_effect=AssertionError("No semantic embedding")):
            row = self.index.alpha_code_documents(DAY, as_of=CUTOFF)[0]
        self.assertEqual(row["metadata"], metadata)
        self.assertEqual(row["indexedAt"], INDEXED)
        self.assertEqual(row["contentHash"], document.content_hash)
        self.assertEqual(row["mediaType"], "application/pdf")
        citation = row["chunks"][0]["citation"]
        self.assertEqual(citation["page"], 3)
        self.assertEqual(citation["section"], "Page 3")
        self.assertEqual(citation["contentHash"], document.content_hash)
        self.assertNotIn("pageToken", citation)
        self.assertEqual(self.contents(), before)

    def test_future_missing_and_invalid_dates_or_index_clocks_are_excluded(self):
        self.insert("eligible", "Trend level 123", indexed_at="2026-09-18T12:00:00-04:00")
        for identity, changes in (
            ("future-publication", {"day": "2026-09-19"}),
            ("missing-publication", {"day": None}),
            ("invalid-publication", {"day": "2026-09-31"}),
            ("future-index", {"indexed_at": "2026-09-18T17:00:01Z"}),
            ("naive-index", {"indexed_at": "2026-09-18T16:00:00"}),
            ("invalid-index", {"indexed_at": "not-a-date"}),
        ):
            self.insert(identity, "Trade level 100", **changes)
        self.assertEqual([row["documentId"] for row in self.index.alpha_code_documents(DAY, as_of=CUTOFF)], ["eligible"])
        for day, as_of in (("not-a-date", CUTOFF), ("2026-09-31", CUTOFF), (DAY, "invalid"),
                          (DAY, "2026-09-18T17:00:00"), (DAY, "2026-09-18")):
            with self.subTest(day=day, as_of=as_of):
                self.assertEqual(self.index.alpha_code_documents(day, as_of=as_of), [])

    def test_new_york_publication_day_cannot_enter_prior_evening_capture(self):
        self.insert("prior", "Trade level 100", day="2026-09-17", indexed_at="2026-09-17T23:00:00Z")
        self.insert("next-day", "Trend level 90", indexed_at="2026-09-17T23:00:00Z")
        self.assertEqual([row["documentId"] for row in self.index.alpha_code_documents(DAY, as_of="2026-09-18T01:00:00Z")],
                         ["prior"])

    def test_later_reimport_cannot_leak_revised_content_into_earlier_capture(self):
        self.insert("revised", "Alpha Code = 100/90")
        original = self.index.alpha_code_documents(DAY, as_of=CUTOFF)[0]
        self.insert("revised", "Alpha Code = 110/95", indexed_at="2026-09-18T18:00:00Z")
        self.assertEqual(self.index.alpha_code_documents(DAY, as_of=CUTOFF), [])
        revised = self.index.alpha_code_documents(DAY, as_of="2026-09-18T19:00:00Z")[0]
        self.assertNotEqual(revised["contentHash"], original["contentHash"])
        self.assertNotEqual(revised["chunks"][0]["citation"]["id"], original["chunks"][0]["citation"]["id"])
        self.assertEqual(original["chunks"][0]["excerpt"], "Alpha Code = 100/90")


if __name__ == "__main__":
    unittest.main()
