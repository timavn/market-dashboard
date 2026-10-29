from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import io
import json
import logging
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import ANY, AsyncMock, Mock, patch
from zoneinfo import ZoneInfo


SIDECAR_DIR = Path(__file__).resolve().parent
if str(SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(SIDECAR_DIR))

_APP_DATA_DIR = tempfile.TemporaryDirectory(prefix="analyst-app-test-")
os.environ.setdefault("ANALYST_DATA_DIR", _APP_DATA_DIR.name)
os.environ.setdefault("ANALYST_TEXTRACT_FALLBACK", "false")

import httpx
import pymupdf as fitz

import app as analyst_app
from contracts import Citation, envelope, validate_envelope
from index import (
    DeterministicTestEmbedder,
    FastEmbedder,
    NormalizedDocument,
    ResearchIndex,
    ResearchSearchError,
    content_hash,
    normalize_text,
)
import market
from market import (
    BalanceContextReader,
    IbkrReader,
    MarketSituationContextReader,
    OpenBBReader,
    current_price,
    verified_live_quote,
)
import pdf_ingest
from pdf_ingest import (
    PdfLibrary,
    PdfValidationError,
    detect_pdf_metadata_date,
    detect_product,
    detect_publication_date,
    extract_pdf,
    normalized_pdf_documents,
    render_selected_page,
    validate_pdf_bytes,
)


def make_pdf(*page_texts: str) -> bytes:
    document = fitz.open()
    for text in page_texts:
        page = document.new_page()
        if text:
            page.insert_text((72, 72), text)
    data = document.tobytes()
    document.close()
    return data


class TempIndexTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="analyst-index-test-")
        self.index = ResearchIndex(
            Path(self.temp.name) / "research.sqlite3",
            embedder=DeterministicTestEmbedder(),
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def document(self, *, document_id: str, product: str, date: str, text: str, **extra):
        return NormalizedDocument.from_payload(
            {
                "documentId": document_id,
                "product": product,
                "publicationDate": date,
                "title": f"{product} {date}",
                "sourceUri": extra.pop("sourceUri", f"gmail://message/{document_id}"),
                "text": text,
                **extra,
            }
        )


class NormalizationAndIndexTests(TempIndexTestCase):
    def test_fastembed_uses_a_bounded_local_micro_batch(self):
        observed = {}

        class FakeModel:
            @staticmethod
            def embed(texts, *, batch_size):
                observed["texts"] = list(texts)
                observed["batch_size"] = batch_size
                return [[1.0, 0.0] for _text in observed["texts"]]

        embedder = FastEmbedder()
        embedder._model = FakeModel()
        self.assertEqual(embedder.embed(["one", "two"]), [[1.0, 0.0], [1.0, 0.0]])
        self.assertEqual(observed, {"texts": ["one", "two"], "batch_size": 32})

    def test_a_repeated_document_in_one_page_is_embedded_once(self):
        embedded = []
        embed = self.index.embedder.embed

        def counting(texts):
            embedded.extend(texts)
            return embed(texts)

        original = self.document(document_id="doc-1", product="signal-strength", date="2026-09-25", text="Longs: OKTA.")
        latest = self.document(document_id="doc-1", product="signal-strength", date="2026-09-25", text="Longs: OKTA, CAKE.")
        with patch.object(self.index.embedder, "embed", side_effect=counting):
            result = self.index.upsert_documents([original, latest])
        self.assertEqual(result["documents"], 1)
        self.assertEqual(embedded, ["Longs: OKTA, CAKE."])

    def test_fastembed_serializes_concurrent_model_inference(self):
        state_lock = threading.Lock()
        start = threading.Barrier(3)
        state = {"active": 0, "max_active": 0, "calls": 0}

        class FakeModel:
            @staticmethod
            def embed(texts, *, batch_size):
                with state_lock:
                    state["active"] += 1
                    state["max_active"] = max(state["max_active"], state["active"])
                    state["calls"] += 1
                try:
                    time.sleep(0.05)
                    return [[1.0, 0.0] for _text in texts]
                finally:
                    with state_lock:
                        state["active"] -= 1

        embedder = FastEmbedder()
        embedder._model = FakeModel()
        outputs = [None, None]
        errors = []

        def run(slot):
            try:
                start.wait(timeout=1)
                outputs[slot] = embedder.embed([f"query-{slot}"])
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=run, args=(slot,)) for slot in range(2)]
        for thread in threads:
            thread.start()
        start.wait(timeout=1)
        for thread in threads:
            thread.join(timeout=2)

        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual(errors, [])
        self.assertEqual(outputs, [[[1.0, 0.0]], [[1.0, 0.0]]])
        self.assertEqual(state["calls"], 2)
        self.assertEqual(state["max_active"], 1)

    def test_query_embedding_runs_between_background_batches_without_losing_chunks(self):
        started, release = threading.Event(), threading.Event()
        calls, outputs, errors = [], {}, []

        class FakeModel:
            def embed(self, texts, *, batch_size):
                calls.append(list(texts))
                if texts[0] == "background-0":
                    started.set()
                    if not release.wait(2):
                        raise TimeoutError("background test batch was not released")
                return [[float(text.rsplit("-", 1)[-1]), 0.0] for text in texts]

        embedder = FastEmbedder()
        embedder._model = FakeModel()

        def run(name, callback):
            try:
                outputs[name] = callback()
            except Exception as exc:
                errors.append(exc)

        with patch("index.EMBEDDING_BATCH_SIZE", 2):
            background = threading.Thread(target=run, args=("background", lambda: embedder.embed([f"background-{i}" for i in range(5)])))
            foreground = threading.Thread(target=run, args=("foreground", lambda: embedder.embed_query("query-9")))
            background.start()
            try:
                self.assertTrue(started.wait(1))
                foreground.start()
                with embedder._inference_condition:
                    self.assertTrue(embedder._inference_condition.wait_for(lambda: bool(embedder._foreground_waiters), 1))
            finally:
                release.set()
                background.join(2)
                foreground.join(2)
        self.assertFalse(background.is_alive() or foreground.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(calls, [["background-0", "background-1"], ["query-9"], ["background-2", "background-3"], ["background-4"]])
        self.assertEqual(outputs["background"], [[float(i), 0.0] for i in range(5)])
        self.assertEqual(outputs["foreground"], [9.0, 0.0])

    def test_cancelled_and_expired_queries_leave_the_inference_queue_usable(self):
        started, release, cancelled = threading.Event(), threading.Event(), threading.Event()
        calls, errors = [], []

        class FakeModel:
            def embed(self, texts, *, batch_size):
                calls.extend(texts)
                if texts == ["background"]:
                    started.set()
                    if not release.wait(2):
                        raise TimeoutError("background test batch was not released")
                return [[1.0, 0.0] for _ in texts]

        embedder = FastEmbedder()
        embedder._model = FakeModel()

        def query():
            try:
                embedder.embed_query("abandoned", cancel_event=cancelled)
            except ResearchSearchError as exc:
                errors.append(exc.code)

        background = threading.Thread(target=lambda: embedder.embed(["background"]))
        foreground = threading.Thread(target=query)
        background.start()
        try:
            self.assertTrue(started.wait(1))
            foreground.start()
            with embedder._inference_condition:
                self.assertTrue(embedder._inference_condition.wait_for(lambda: bool(embedder._foreground_waiters), 1))
            cancelled.set()
            foreground.join(1)
            self.assertFalse(foreground.is_alive())
            with self.assertRaisesRegex(ResearchSearchError, "search timeout"):
                embedder.embed_query("expired", deadline_monotonic=time.monotonic() - 1)
        finally:
            release.set()
            background.join(2)
            foreground.join(2)
        self.assertEqual(errors, ["search_cancelled"])
        self.assertEqual(embedder.embed_query("next"), [1.0, 0.0])
        self.assertEqual(calls, ["background", "next"])

    def test_foreground_bursts_do_not_starve_background_ingestion(self):
        entered, release = threading.Event(), threading.Event()
        calls, errors = [], []

        class FakeModel:
            def embed(self, texts, *, batch_size):
                calls.append(texts[0])
                if texts == ["initial"]:
                    entered.set()
                    if not release.wait(2):
                        raise TimeoutError("initial inference was not released")
                return [[1.0] for _ in texts]

        embedder = FastEmbedder()
        embedder._model = FakeModel()

        def run(callback):
            try:
                callback()
            except Exception as exc:
                errors.append(exc)

        initial = threading.Thread(target=run, args=(lambda: embedder.embed(["initial"]),))
        background = threading.Thread(target=run, args=(lambda: embedder.embed(["waiting-background"]),))
        foreground = [threading.Thread(target=run, args=(lambda i=i: embedder.embed_query(f"query-{i}"),)) for i in range(10)]
        initial.start()
        try:
            self.assertTrue(entered.wait(1))
            background.start()
            for thread in foreground:
                thread.start()
            with embedder._inference_condition:
                self.assertTrue(embedder._inference_condition.wait_for(
                    lambda: len(embedder._foreground_waiters) == 10 and len(embedder._background_waiters) == 1, 1))
        finally:
            release.set()
            for thread in [initial, background, *foreground]:
                thread.join(2)
        self.assertEqual(errors, [])
        self.assertFalse(any(thread.is_alive() for thread in [initial, background, *foreground]))
        self.assertEqual(calls[9], "waiting-background")
        self.assertEqual(set(calls), {"initial", "waiting-background", *[f"query-{i}" for i in range(10)]})

    def test_embedding_admission_is_bounded_and_failed_inference_releases_its_slot(self):
        entered, release = threading.Event(), threading.Event()
        failures = []

        class FakeModel:
            def embed(self, texts, *, batch_size):
                if texts == ["initial"]:
                    entered.set()
                    if not release.wait(2):
                        raise TimeoutError("initial inference was not released")
                if texts == ["failed"]:
                    raise ValueError("inference failed")
                return [[1.0] for _ in texts]

        embedder = FastEmbedder()
        embedder._model = FakeModel()

        def run(callback):
            try:
                callback()
            except Exception as exc:
                failures.append(exc)

        initial = threading.Thread(target=run, args=(lambda: embedder.embed(["initial"]),))
        queries = [threading.Thread(target=run, args=(lambda i=i: embedder.embed_query(f"query-{i}"),)) for i in range(2)]
        with patch("index.MAX_EMBEDDING_WAITERS", 2):
            initial.start()
            try:
                self.assertTrue(entered.wait(1))
                for thread in queries:
                    thread.start()
                with embedder._inference_condition:
                    self.assertTrue(embedder._inference_condition.wait_for(lambda: len(embedder._foreground_waiters) == 2, 1))
                with self.assertRaisesRegex(ResearchSearchError, "embedding busy"):
                    embedder.embed_query("overflow")
            finally:
                release.set()
                for thread in [initial, *queries]:
                    thread.join(2)
        self.assertFalse(any(thread.is_alive() for thread in [initial, *queries]))
        self.assertEqual(failures, [])
        with self.assertRaisesRegex(ValueError, "inference failed"):
            embedder.embed_query("failed")
        self.assertEqual(embedder.embed_query("after-failure"), [1.0])

    def test_normalization_hash_and_supplied_hash_validation(self):
        self.assertEqual(normalize_text(" A\tB\r\n\r\n\r\nC\x00 "), "A B\n\nC")
        self.assertEqual(content_hash(" A  B "), content_hash("A B"))
        with self.assertRaisesRegex(ValueError, "contentHash"):
            NormalizedDocument.from_payload(
                {"product": "risk-ranges", "sourceUri": "gmail://x", "text": "body", "contentHash": "0" * 64}
            )

    def test_hybrid_ranking_product_symbol_and_date_filters(self):
        self.index.upsert_documents(
            [
                self.document(
                    document_id="doc_macro",
                    product="the-macro-show",
                    date="2026-08-14",
                    text="AAPL demand accelerated while inflation cooled and growth broadened.",
                ),
                self.document(
                    document_id="doc_call",
                    product="the-call",
                    date="2026-08-13",
                    text="Energy breadth improved. XOM remained a preferred expression.",
                ),
                self.document(
                    document_id="doc_old",
                    product="the-macro-show",
                    date="2025-01-02",
                    text="AAPL demand was weak while inflation rose.",
                ),
            ]
        )
        ranked = self.index.search("AAPL demand accelerated", limit=3)
        self.assertEqual(ranked[0]["citation"]["documentId"], "doc_macro")
        filtered = self.index.search(
            "demand",
            product="the-macro-show",
            symbol="AAPL",
            start_date="2026-01-01",
            end_date="2026-12-31",
        )
        self.assertEqual([row["citation"]["documentId"] for row in filtered], ["doc_macro"])
        self.assertEqual(self.index.search("energy", product="risk-ranges"), [])

    def test_citation_is_stable_and_changes_when_content_changes(self):
        original = self.document(
            document_id="doc_stable",
            product="the-call",
            date="2026-08-15",
            text="Original sourced view.",
        )
        self.index.upsert_documents([original])
        first_id = self.index.search("Original")[0]["citation"]["id"]
        unchanged = self.index.upsert_documents([original])
        self.assertEqual(unchanged["unchanged"], 1)
        self.assertEqual(self.index.search("Original")[0]["citation"]["id"], first_id)

        changed = self.document(
            document_id="doc_stable",
            product="the-call",
            date="2026-08-15",
            text="Revised sourced view.",
        )
        self.index.upsert_documents([changed])
        second_id = self.index.search("Revised")[0]["citation"]["id"]
        self.assertNotEqual(first_id, second_id)
        self.assertIsNone(self.index.get_source(first_id))

    def test_embedding_does_not_hold_a_sqlite_writer_transaction(self):
        test_embedder = DeterministicTestEmbedder()
        active_index = self.index

        class WriterProbeEmbedder:
            model_name = "writer-probe"

            def embed(self, texts):
                active_index.set_sync_state("embedding_probe", "writer_available")
                return test_embedder.embed(texts)

        self.index.embedder = WriterProbeEmbedder()
        inserted = self.index.upsert_documents(
            [
                self.document(
                    document_id="doc_writer_probe",
                    product="the-call",
                    date="2026-08-15",
                    text="Embedding should not hold a SQLite writer transaction.",
                )
            ]
        )
        self.assertEqual(inserted["documents"], 1)
        self.assertEqual(self.index.get_sync_state("embedding_probe"), "writer_available")

    def test_metadata_refresh_does_not_reembed_or_renew_index_time(self):
        values = dict(document_id="metadata-refresh", product="the-call", date="2026-09-18", text="Sourced view.")
        original = self.document(**values, metadata={"ingestedAt": "2026-09-18T15:00:00Z"})
        self.index.upsert_documents([original])
        with self.index.connect() as connection:
            before = dict(connection.execute("SELECT * FROM documents WHERE document_id = ?", (original.document_id,)).fetchone())
            chunks_before = [dict(row) for row in connection.execute("SELECT * FROM chunks")]
        metadata = {"publishedAt": "2026-09-18T12:00:00Z", "observedAt": "2026-09-18T12:01:00Z"}
        refreshed = self.document(**values, metadata=metadata)
        with patch.object(self.index.embedder, "embed", side_effect=AssertionError("Unchanged content must not be reembedded")), \
                patch("index.utc_now_iso", side_effect=AssertionError("Metadata must not renew index time")):
            result = self.index.upsert_documents([refreshed])
        self.assertEqual(result, {"documents": 0, "chunks": 0, "unchanged": 1})
        with self.index.connect() as connection:
            after = dict(connection.execute("SELECT * FROM documents WHERE document_id = ?", (original.document_id,)).fetchone())
            self.assertEqual([dict(row) for row in connection.execute("SELECT * FROM chunks")], chunks_before)
        self.assertEqual(json.loads(after.pop("metadata_json")), metadata)
        before.pop("metadata_json")
        self.assertEqual(after, before)

    def test_metadata_refresh_after_concurrent_ingestion_keeps_existing_chunks_and_index_time(self):
        values = dict(document_id="metadata-race", product="the-call", date="2026-09-18", text="Sourced view.")
        refreshed = self.document(**values, metadata={"publishedAt": "2026-09-18T12:00:00Z"})
        concurrent_index = ResearchIndex(self.index.db_path, embedder=DeterministicTestEmbedder())
        embed = self.index.embedder.embed
        inserted = {}

        def ingest_while_embedding(texts):
            concurrent_index.upsert_documents([self.document(**values, metadata={"legacy": True})])
            with self.index.connect() as connection:
                inserted["document"] = dict(connection.execute("SELECT * FROM documents").fetchone())
                inserted["chunks"] = [dict(row) for row in connection.execute("SELECT * FROM chunks")]
            return embed(texts)

        with patch.object(self.index.embedder, "embed", side_effect=ingest_while_embedding) as embedded, \
                patch("index.utc_now_iso", side_effect=["2026-09-18T15:00:00Z", "2026-09-18T16:00:00Z"]) as now:
            result = self.index.upsert_documents([refreshed])
        self.assertEqual(result, {"documents": 0, "chunks": 0, "unchanged": 1})
        self.assertEqual(embedded.call_count, 1)
        self.assertEqual(now.call_count, 1)
        with self.index.connect() as connection:
            after = dict(connection.execute("SELECT * FROM documents").fetchone())
            self.assertEqual([dict(row) for row in connection.execute("SELECT * FROM chunks")], inserted["chunks"])
        self.assertEqual(json.loads(after.pop("metadata_json")), refreshed.metadata)
        inserted["document"].pop("metadata_json")
        self.assertEqual(after, inserted["document"])

    def test_changed_documents_are_embedded_in_one_batch(self):
        class CountingEmbedder(DeterministicTestEmbedder):
            model_name = "counting-test-embedder"

            def __init__(self):
                super().__init__()
                self.calls = 0

            def embed(self, texts):
                self.calls += 1
                return super().embed(texts)

        embedder = CountingEmbedder()
        self.index.embedder = embedder
        result = self.index.upsert_documents(
            [
                self.document(document_id="doc_batch_1", product="the-call", date="2026-08-15", text="First changed document."),
                self.document(document_id="doc_batch_2", product="the-call", date="2026-08-15", text="Second changed document."),
            ]
        )
        self.assertEqual(result["documents"], 2)
        self.assertEqual(embedder.calls, 1)

    def test_full_review_document_scan_includes_late_fragments_without_preparing_pdf_previews(self):
        text = "\n\n".join(f"Paragraph {i}. " + "Research context. " * 65 for i in range(30)) + "\n\nFINAL_SIGNAL: Quad 2 to Quad 3 shift expected."
        self.index.upsert_documents([self.document(document_id="full-call", product="the-call", date="2026-09-04",
                                                   text=text, page=1, mediaType="application/pdf")])
        with patch.object(self.index, "_grant_page", side_effect=AssertionError("Bulk reviews must not prepare PDF previews")):
            excerpts = self.index.document_excerpts("full-call", limit=None, grant_pages=False)
        self.assertGreater(len(excerpts), 24)
        self.assertTrue(any("FINAL_SIGNAL" in row["excerpt"] for row in excerpts))
        self.assertTrue(all(row["citation"]["documentId"] == "full-call" for row in excerpts))

    def test_existing_index_upgrades_exact_document_reads_without_scanning_other_documents(self):
        self.index.upsert_documents([self.document(document_id="saved-call", product="the-call", date="2026-09-04",
                                                   text="First section. " * 100 + "\n\nFinal section. " * 100)])
        expected = self.index.document_excerpts("saved-call", limit=None, grant_pages=False)
        with self.index.connect() as connection:
            connection.execute("DROP INDEX idx_chunks_document_ordinal")
        reopened = ResearchIndex(self.index.db_path, embedder=DeterministicTestEmbedder())
        statements = []
        connect = reopened.connect

        def traced_connect():
            connection = connect()
            connection.set_trace_callback(statements.append)
            return connection

        with patch.object(reopened, "connect", side_effect=traced_connect):
            self.assertEqual(reopened.document_excerpts("saved-call", limit=None, grant_pages=False), expected)
        query = next(sql for sql in statements if "FROM chunks c JOIN documents" in sql)
        with reopened.connect() as connection:
            plan = [row[3] for row in connection.execute("EXPLAIN QUERY PLAN " + query)]
        self.assertTrue(any("SEARCH c " in step for step in plan), plan)
        self.assertFalse(any("SCAN c" in step or "TEMP B-TREE" in step for step in plan), plan)

    def test_date_first_index_preserves_candidate_scope_and_eliminates_temporary_sort(self):
        documents = [self.document(document_id=f"candidate-{i}", product="the-call" if i % 2 else "risk-ranges",
                                   date="2026-09-04" if i % 3 else "2026-09-03", text=f"SPX cited reading {i}.") for i in range(20)]
        self.index.upsert_documents(documents)
        query = """SELECT c.*,d.title,d.source_uri,d.content_hash,d.media_type
                   FROM chunks c JOIN documents d ON d.document_id=c.document_id WHERE 1=1
                   ORDER BY c.publication_date DESC,c.document_id,c.ordinal LIMIT 2000"""
        with self.index.connect() as connection:
            new_rows = [dict(row) for row in connection.execute(query)]
            plan = [row[3] for row in connection.execute("EXPLAIN QUERY PLAN " + query)]
            connection.execute("DROP INDEX idx_chunks_date_document_ordinal")
            old_rows = [dict(row) for row in connection.execute(query)]
        self.assertEqual(new_rows, old_rows)
        self.assertTrue(any("idx_chunks_date_document_ordinal" in step for step in plan), plan)
        self.assertFalse(any("TEMP B-TREE" in step for step in plan), plan)
        reopened = ResearchIndex(self.index.db_path, embedder=DeterministicTestEmbedder())
        with reopened.connect() as connection:
            indexes = {row[1] for row in connection.execute("PRAGMA index_list(chunks)")}
        self.assertIn("idx_chunks_date_document_ordinal", indexes)

    def test_product_date_document_index_serves_exact_source_report_lookups(self):
        documents = [self.document(document_id=f"report-{i}", product="the-call" if i % 2 else "risk-ranges",
                                   date="2026-09-04" if i % 3 else "2026-09-03", text=f"SPX cited reading {i}.",
                                   sourceUri=f"s3://bucket/hedgeye/{i}-message-{i}.html") for i in range(20)]
        self.index.upsert_documents(documents)
        # The Inbox source-report lookup in finding_source_reports.py.
        query = ("SELECT * FROM documents WHERE product=? AND publication_date=? AND source_uri LIKE ? "
                 "ORDER BY indexed_at DESC LIMIT 9")
        params = ("the-call", "2026-09-04", "%/5-%")
        with self.index.connect() as connection:
            new_rows = [dict(row) for row in connection.execute(query, params)]
            plan = [row[3] for row in connection.execute("EXPLAIN QUERY PLAN " + query, params)]
            connection.execute("DROP INDEX idx_documents_product_date")
            old_rows = [dict(row) for row in connection.execute(query, params)]
        self.assertEqual([row["document_id"] for row in new_rows], ["report-5"])
        self.assertEqual(new_rows, old_rows)
        self.assertTrue(any("idx_documents_product_date (product=? AND publication_date=?)" in step for step in plan), plan)
        reopened = ResearchIndex(self.index.db_path, embedder=DeterministicTestEmbedder())
        with reopened.connect() as connection:
            indexes = {row[1] for row in connection.execute("PRAGMA index_list(documents)")}
        self.assertIn("idx_documents_product_date", indexes)

    def test_search_cancellation_and_deadline_never_return_a_not_found_result(self):
        cancelled = threading.Event()
        cancelled.set()
        with patch.object(self.index.embedder, "embed", side_effect=AssertionError("abandoned search must not infer")):
            with self.assertRaisesRegex(ResearchSearchError, "search cancelled"):
                self.index.search("unknown", cancel_event=cancelled)
            with self.assertRaisesRegex(ResearchSearchError, "search timeout"):
                self.index.search("unknown", deadline_monotonic=time.monotonic() - 1)

    def test_pdf_page_grant_is_exact_and_expires(self):
        self.index.upsert_documents(
            [
                self.document(
                    document_id="doc_pdf:p2",
                    product="risk-ranges",
                    date="2026-08-15",
                    text="The relevant AAPL range is on this exact page.",
                    sourceUri="s3://market-dashboard-csv-data/analyst-research/example.pdf",
                    page=2,
                    section="Page 2",
                    mediaType="application/pdf",
                )
            ]
        )
        citation = self.index.search("AAPL range")[0]["citation"]
        self.assertEqual(citation["page"], 2)
        self.assertTrue(citation["pageToken"].startswith("page_"))
        self.assertIsNotNone(self.index.resolve_page_grant(citation["id"], citation["pageToken"]))
        self.assertIsNone(self.index.resolve_page_grant(citation["id"], "page_wrong"))
        with self.index.connect() as connection:
            connection.execute(
                "UPDATE page_grants SET expires_at=? WHERE token=?",
                ((datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat(), citation["pageToken"]),
            )
        self.assertIsNone(self.index.resolve_page_grant(citation["id"], citation["pageToken"]))


class CoverageTests(TempIndexTestCase):
    def product_row(self, coverage, product):
        return next(row for row in coverage["products"] if row["product"] == product)

    def test_cftc_report_week_is_current_without_relabelling_the_report_date(self):
        self.index.upsert_documents([self.document(
            document_id="cftc", product="cftc-positioning", date="2026-09-15",
            text="Official CFTC observations for September 15",
            metadata={"observedAt": "2026-09-18T20:15:08Z"},
        )])
        for day, hour, expected in ((18, 17, "available"), (19, 10, "available"),
                                     (21, 10, "available"), (25, 15, "available"),
                                     (25, 17, "late")):
            with self.subTest(day=day, hour=hour):
                result = self.product_row(analyst_app.research_coverage(self.index,
                    datetime(2026, 9, day, hour, tzinfo=ZoneInfo("America/New_York"))), "cftc-positioning")
                self.assertEqual(result["status"], expected)
                self.assertEqual(result["latestPublicationDate"], "2026-09-15")
                self.assertEqual(result["observedAt"], "2026-09-18T20:15:08Z")

    def test_cftc_schedule_accepts_shifted_report_days_but_not_old_or_future_weeks(self):
        for report_date, expected in (("2026-09-08", "late"), ("2026-09-14", "available"),
                                      ("2026-09-16", "available"), ("2026-09-18", "available"),
                                      ("2026-09-22", "late")):
            with self.subTest(report_date=report_date):
                self.index.upsert_documents([self.document(
                    document_id="cftc", product="cftc-positioning", date=report_date,
                    text=f"Official CFTC report {report_date}",
                )])
                result = self.product_row(analyst_app.research_coverage(self.index,
                    datetime(2026, 9, 21, 10, tzinfo=ZoneInfo("America/New_York"))), "cftc-positioning")
                self.assertEqual(result["status"], expected)
        self.index.set_sync_state("feed_coverage", json.dumps({"products": [
            {"product": "cftc-positioning", "status": "failed"}]}))
        result = self.product_row(analyst_app.research_coverage(self.index,
            datetime(2026, 9, 21, 10, tzinfo=ZoneInfo("America/New_York"))), "cftc-positioning")
        self.assertEqual(result["status"], "failed")

    def test_inflation_nowcast_shows_its_latest_date_and_is_late_only_behind_the_feed(self):
        now = datetime(2026, 9, 18, 14, tzinfo=ZoneInfo("America/New_York"))
        for publication in ("2026-08-13", "2026-09-16"):
            with self.subTest(publication=publication):
                self.index.upsert_documents([self.document(
                    document_id="nowcast", product="inflation-nowcast", date=publication,
                    text=f"Monthly inflation nowcast published {publication}",
                )])
                result = self.product_row(analyst_app.research_coverage(self.index, now), "inflation-nowcast")
                self.assertEqual(result["status"], "available")
                self.assertEqual(result["cadence"], "event_driven")
                self.assertEqual(result["latestPublicationDate"], publication)
                self.assertIsNone(result["expectedPublicationDate"])
        checked = {"product": "inflation-nowcast", "status": "not_due", "latestPublicationDate": "2026-09-17",
                   "stages": {"received": False, "parsed": False, "validated": False, "indexed": False}}
        self.index.set_sync_state("feed_coverage", json.dumps({"products": [checked]}))
        result = self.product_row(analyst_app.research_coverage(self.index, now), "inflation-nowcast")
        self.assertEqual(result["status"], "available")
        self.assertEqual(result["latestPublicationDate"], "2026-09-16")
        received = {**checked, "status": "indexed",
                    "stages": {"received": True, "parsed": True, "validated": True, "indexed": True}}
        self.index.set_sync_state("feed_coverage", json.dumps({"products": [received]}))
        result = self.product_row(analyst_app.research_coverage(self.index, now), "inflation-nowcast")
        self.assertEqual(result["status"], "late")
        self.assertEqual(result["latestPublicationDate"], "2026-09-16")
        self.assertEqual(result["expectedPublicationDate"], "2026-09-17")

    def test_coverage_and_exact_manifest_preserve_source_times(self):
        observed = "2026-09-17T18:01:00Z"
        published = "2026-09-17T11:30:00Z"
        self.index.upsert_documents([self.document(
            document_id="source-clock", product="risk-ranges", date="2026-09-17",
            text="Verified source clock", metadata={"observedAt": observed, "publishedAt": published},
        )])
        coverage = analyst_app.research_coverage(self.index, datetime(2026, 9, 17, 15, tzinfo=ZoneInfo("America/New_York")))
        source = self.product_row(coverage, "risk-ranges")
        self.assertEqual(source["observedAt"], observed)
        self.assertEqual(source["publishedAt"], published)
        with patch.object(analyst_app, "research_index", self.index):
            manifest = analyst_app._exact_review_documents()
        document = manifest["products"][0]["documents"][0]
        self.assertEqual(document["observedAt"], observed)
        self.assertEqual(document["publishedAt"], published)
        self.assertEqual(document["publicationDate"], "2026-09-17")

    def test_workspace_readiness_retains_original_feed_observation_time(self):
        observed_at = "2026-09-14T16:58:00.000Z"
        feed = {"generatedAt": observed_at, "products": [{"product": "risk-ranges"}], "warnings": []}
        self.index.set_sync_state("feed_coverage", json.dumps(feed))

        class Request:
            path_params = {"operation": "readiness"}

            async def json(self):
                return {}

        with patch.object(analyst_app, "research_index", self.index):
            response = asyncio.run(analyst_app.workspace_route(Request()))
        result = json.loads(response.body)
        self.assertEqual(result["feedGeneratedAt"], observed_at)
        self.assertEqual(result["products"], feed["products"])
        self.assertEqual(result["indexed"], [])
        self.assertEqual(result["errors"], [])

    def test_cadence_aware_available_late_not_due_and_missing(self):
        monday_before_deadline = datetime(2026, 8, 17, 7, 30, tzinfo=ZoneInfo("America/New_York"))
        before = analyst_app.research_coverage(self.index, monday_before_deadline)
        self.assertEqual(self.product_row(before, "risk-ranges")["status"], "not due")

        self.index.upsert_documents(
            [
                self.document(
                    document_id="doc_rr",
                    product="risk-ranges",
                    date="2026-08-14",
                    text="Friday risk range source.",
                )
            ]
        )
        monday_after_deadline = datetime(2026, 8, 17, 9, 0, tzinfo=ZoneInfo("America/New_York"))
        after = analyst_app.research_coverage(self.index, monday_after_deadline)
        risk_range = self.product_row(after, "risk-ranges")
        self.assertEqual(risk_range["status"], "late")
        self.assertEqual(risk_range["latestPublicationDate"], "2026-08-14")
        self.assertEqual(self.product_row(after, "inflation-nowcast")["status"], "not due")

        self.index.upsert_documents(
            [
                self.document(
                    document_id="doc_rr_current",
                    product="risk-ranges",
                    date="2026-08-17",
                    text="Monday risk range source.",
                )
            ]
        )
        current = analyst_app.research_coverage(self.index, monday_after_deadline)
        self.assertEqual(self.product_row(current, "risk-ranges")["status"], "available")

    def test_feed_indexing_and_failure_override_archive_age(self):
        self.index.set_sync_state(
            "feed_coverage",
            '{"products":[{"product":"risk-ranges","status":"indexing"},{"product":"the-call","status":"failed","failureReason":"parser"}]}',
        )
        coverage = analyst_app.research_coverage(
            self.index,
            datetime(2026, 8, 17, 9, 0, tzinfo=ZoneInfo("America/New_York")),
        )
        self.assertEqual(self.product_row(coverage, "risk-ranges")["status"], "indexing")
        self.assertEqual(self.product_row(coverage, "the-call")["status"], "failed")


class BriefingPacketTests(TempIndexTestCase):
    def test_market_situation_report_leads_a_compact_cited_packet(self):
        product_ids = [product["id"] for product in analyst_app.research_product_definitions()]
        self.assertEqual(len(product_ids), len(set(product_ids)))
        self.index.upsert_documents([
            self.document(
                document_id=f"doc_briefing_{product_id}",
                product=product_id,
                date="2026-08-14",
                text=f"{product_id} sourced evidence with portfolio context and risk levels. " * 180,
            )
            for product_id in product_ids
        ])

        with patch.object(analyst_app, "research_index", self.index):
            packet_result = asyncio.run(analyst_app.get_briefing_packet())

        packet = packet_result.structuredContent
        self.assertEqual(packet["status"], "available")
        products = packet["data"]["products"]
        self.assertEqual(products[0]["product"], "market-structure")
        self.assertEqual(len(products), len(product_ids))
        self.assertEqual(products[0]["briefingRole"], "required_market_situation")
        self.assertEqual(products[0]["requiredSection"], "Market Situation Report")
        self.assertTrue(products[0]["excerpts"])
        self.assertEqual(set(products[0]["excerpts"][0]), {"excerpt", "citationId"})

        citation_by_id = {row["id"]: row for row in packet["citations"]}
        market_citation = citation_by_id[products[0]["excerpts"][0]["citationId"]]
        self.assertEqual(market_citation["product"], "market-structure")
        self.assertLessEqual(len(market_citation["excerpt"]), analyst_app.MAX_BRIEFING_CITATION_PREVIEW_CHARS)
        self.assertEqual(len(citation_by_id), len(product_ids) * 2)
        self.assertLessEqual(sum(len(row["excerpt"]) for product in products for row in product["excerpts"]),
                             analyst_app.MAX_BRIEFING_EXCERPT_CHARS)
        for product in products:
            self.assertEqual(len(product["excerpts"]), 2)
            for excerpt in product["excerpts"]:
                citation = citation_by_id[excerpt["citationId"]]
                self.assertEqual(citation["product"], product["product"])
                self.assertEqual(citation["publicationDate"], "2026-08-14")
                self.assertTrue(citation["excerpt"])
                self.assertTrue(excerpt["excerpt"].startswith(citation["excerpt"]))
                self.assertLessEqual(len(citation["excerpt"]), analyst_app.MAX_BRIEFING_CITATION_PREVIEW_CHARS)
        self.assertNotIn("\n", packet_result.content[0].text)
        self.assertEqual(json.loads(packet_result.content[0].text), packet)
        # Each registered product adds about 2.5k characters (two cited excerpts);
        # 20 products, including Signal Strength Shorts, fit under 55k.
        self.assertLess(len(packet_result.content[0].text), 55_000)
        self.assertLess(len(packet_result.model_dump_json(exclude_none=True)), 110_000)

    def test_market_situation_context_returns_complete_cited_research_and_spx_vol(self):
        self.index.upsert_documents([
            self.document(
                document_id="doc_market_context",
                product="market-structure",
                date="2026-08-25",
                text=(
                    "Verified gamma matrix, throttle, PV bands, flow, breadth, leadership, "
                    "support, resistance, catalysts, and game plan. " * 260
                ),
            )
        ])
        volatility = envelope(
            status="available",
            source_system="market_dashboard",
            provider="Yahoo Finance chart API",
            data={
                "symbol": "SPX",
                "oneMonth": {"windowSessions": 21, "valuePct": 9.5},
                "threeMonth": {"windowSessions": 63, "valuePct": 11.2},
                "spreadPercentagePoints": -1.7,
                "historicalOnly": True,
                "executable": False,
            },
            as_of="2026-08-24",
            freshness="historical_completed_session",
            live_verified=False,
        )
        with (
            patch.object(analyst_app, "research_index", self.index),
            patch.object(
                analyst_app.market_situation_context,
                "spx_realized_volatility",
                new=AsyncMock(return_value=volatility),
            ),
        ):
            context_result = asyncio.run(analyst_app.get_market_situation_context())

        context = context_result.structuredContent
        self.assertEqual(context["status"], "available")
        self.assertEqual(context["data"]["research"]["publicationDate"], "2026-08-25")
        self.assertEqual(len(context["data"]["research"]["excerpts"]), 24)
        self.assertEqual(context["data"]["realizedVolatility"], volatility)
        self.assertEqual(len(context["citations"]), len(context["data"]["research"]["excerpts"]))
        self.assertTrue(all(set(row) == {"citationId"} for row in context["data"]["research"]["excerpts"]))
        self.assertEqual(
            [row["citationId"] for row in context["data"]["research"]["excerpts"]],
            [row["id"] for row in context["citations"]],
        )
        self.assertNotIn("\n", context_result.content[0].text)
        self.assertEqual(json.loads(context_result.content[0].text), context)
        self.assertLess(len(context_result.content[0].text), 50_000)
        self.assertLess(len(context_result.model_dump_json(exclude_none=True)), 110_000)


class ResearchToolConcurrencyTests(unittest.IsolatedAsyncioTestCase):
    async def test_model_omission_sentinels_do_not_become_literal_search_filters(self):
        with patch.object(analyst_app.research_index, "search", return_value=[]) as search:
            result = await analyst_app.search_research(
                "ticker TREND BULLISH BEARISH NEUTRAL",
                product="risk-ranges",
                symbol=":",
                start_date=" none ",
                end_date="null",
                limit=5,
            )

        search.assert_called_once_with(
            "ticker TREND BULLISH BEARISH NEUTRAL",
            product="risk-ranges",
            symbol=None,
            start_date=None,
            end_date=None,
            limit=5,
            cancel_event=ANY,
            deadline_monotonic=ANY,
        )
        self.assertTrue(search.call_args.kwargs["cancel_event"].is_set())
        self.assertIsInstance(search.call_args.kwargs["deadline_monotonic"], float)
        self.assertEqual(result.structuredContent["status"], "not_found")

    async def test_cancelled_tool_releases_its_worker_and_the_next_search(self):
        entered = threading.Event()
        released = threading.Event()
        calls = []

        def waiting(query, **kwargs):
            calls.append(query)
            if query == "cancel-me":
                entered.set()
                try:
                    if not kwargs["cancel_event"].wait(2):
                        raise AssertionError("Cancelled search worker did not receive Stop")
                finally:
                    released.set()
            return []

        with patch.object(analyst_app.research_index, "search", side_effect=waiting):
            task = asyncio.create_task(analyst_app.search_research("cancel-me"))
            self.assertTrue(await asyncio.to_thread(entered.wait, 1))
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertTrue(await asyncio.to_thread(released.wait, 1))
            result = await asyncio.wait_for(analyst_app.search_research("next-query"), 1)
        self.assertEqual(calls, ["cancel-me", "next-query"])
        self.assertEqual(result.structuredContent["status"], "not_found")

    async def test_twelve_parallel_searches_queue_without_starving_health_workers(self):
        entered = threading.Event()
        release = threading.Event()
        state_lock = threading.Lock()
        state = {"active": 0, "max_active": 0, "calls": 0}

        def blocked_search(*_args, **_kwargs):
            with state_lock:
                state["active"] += 1
                state["max_active"] = max(state["max_active"], state["active"])
                state["calls"] += 1
            entered.set()
            try:
                if not release.wait(timeout=2):
                    raise TimeoutError("test search was not released")
                return []
            finally:
                with state_lock:
                    state["active"] -= 1

        with patch.object(analyst_app.research_index, "search", side_effect=blocked_search):
            first_batch = [
                asyncio.create_task(analyst_app.search_research(f"first-{index}"))
                for index in range(12)
            ]
            try:
                started = await asyncio.wait_for(
                    asyncio.to_thread(entered.wait, 1),
                    timeout=1.5,
                )
                self.assertTrue(started)
                health_response = await asyncio.wait_for(
                    analyst_app.livez(None),
                    timeout=0.5,
                )
                self.assertEqual(health_response.status_code, 200)
                self.assertTrue(json.loads(health_response.body)["ok"])
            finally:
                release.set()

            first_results = await asyncio.gather(*first_batch)
            second_results = await asyncio.gather(*[
                analyst_app.search_research(f"second-{index}")
                for index in range(3)
            ])

        self.assertEqual(state["calls"], 15)
        self.assertEqual(state["max_active"], 1)
        for result in [*first_results, *second_results]:
            self.assertEqual(result.structuredContent["status"], "not_found")

    async def test_max_search_payload_keeps_canonical_evidence_in_both_channels(self):
        rows = []
        for index in range(20):
            excerpt = (f"Evidence block {index} with cited portfolio context. " * 40)[:900]
            citation = Citation(
                id=f"cite_{index:032x}",
                documentId=f"doc_{index:032x}",
                product="portfolio-solutions",
                publicationDate="2026-08-25",
                sourceUri=f"gmail://message/research-{index}",
                title=f"Portfolio Solutions {index}",
                section=f"Section {index}",
                excerpt=excerpt,
                contentHash=sha256(excerpt.encode("utf-8")).hexdigest(),
            ).as_dict()
            rows.append({"score": round(1 - index / 100, 2), "excerpt": excerpt, "citation": citation})

        with patch.object(analyst_app.research_index, "search", return_value=rows):
            result = await analyst_app.search_research(
                "portfolio construction",
                product="portfolio-solutions",
                limit=20,
            )

        payload = result.structuredContent
        self.assertEqual(len(payload["data"]["results"]), 20)
        self.assertEqual(len(payload["citations"]), 20)
        self.assertTrue(all(set(row) == {"score", "citationId"} for row in payload["data"]["results"]))
        self.assertEqual(
            [row["citationId"] for row in payload["data"]["results"]],
            [row["id"] for row in payload["citations"]],
        )
        self.assertTrue(all(row.get("excerpt") for row in payload["citations"]))
        self.assertNotIn("\n", result.content[0].text)
        self.assertEqual(json.loads(result.content[0].text), payload)
        self.assertLess(len(result.content[0].text), 50_000)
        self.assertLess(len(result.model_dump_json(exclude_none=True)), 110_000)


class MarketSituationContextReaderTests(unittest.IsolatedAsyncioTestCase):
    async def test_spx_realized_volatility_uses_only_current_completed_session_history(self):
        calls = []

        async def request(path):
            calls.append(path)
            current = "forceRefresh=1" in path
            return {
                "status": "available",
                "source": "Yahoo Finance chart API",
                "rows": {
                    "SPX": {
                        "status": "available",
                        "asOf": "2026-08-24",
                        "realizedVolatility": {
                            "status": "available",
                            "rv21": 0.095,
                            "rv63": 0.112,
                            "asOf": "2026-08-24",
                        },
                    },
                },
                "completedSession": {
                    "status": "current" if current else "unavailable",
                    "expectedAsOf": "2026-08-24",
                    "observedAsOf": "2026-08-24",
                },
                "historicalOnly": True,
                "executable": False,
            }

        result = await MarketSituationContextReader(request=request).spx_realized_volatility()

        self.assertEqual(calls, [
            "/api/security-risk-metrics/spx-realized-volatility",
            "/api/security-risk-metrics/spx-realized-volatility?forceRefresh=1",
        ])
        self.assertEqual(result["status"], "available")
        self.assertEqual(result["data"]["oneMonth"], {"windowSessions": 21, "valuePct": 9.5})
        self.assertEqual(result["data"]["threeMonth"], {"windowSessions": 63, "valuePct": 11.2})
        self.assertEqual(result["data"]["spreadPercentagePoints"], -1.7)
        self.assertFalse(result["liveVerified"])

    @staticmethod
    def current_volatility():
        return {"source": "Yahoo Finance chart API", "historicalOnly": True, "executable": False,
                "rows": {"SPX": {"asOf": "2026-08-24", "realizedVolatility": {
                    "status": "available", "rv21": 0.095, "rv63": 0.112, "asOf": "2026-08-24"}}},
                "completedSession": {"status": "current", "expectedAsOf": "2026-08-24"}}

    async def test_transient_timeout_retries_the_exact_source_in_background(self):
        calls = []

        async def request(path):
            calls.append(path)
            if len(calls) == 1:
                raise asyncio.TimeoutError()
            return self.current_volatility()

        with patch("market.asyncio.sleep", new_callable=AsyncMock):
            result = await MarketSituationContextReader(request=request).spx_realized_volatility()
        self.assertEqual(result["status"], "available")
        self.assertEqual(len(calls), 2)
        self.assertTrue(calls[1].endswith("?forceRefresh=1"))

    async def test_provider_failures_are_bounded_and_never_become_a_cached_success(self):
        request = AsyncMock(side_effect=asyncio.TimeoutError())
        with patch("market.asyncio.sleep", new_callable=AsyncMock):
            result = await MarketSituationContextReader(request=request).spx_realized_volatility()
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(request.await_count, 4)
        self.assertIsNone(result["data"]["oneMonth"])

    async def test_market_delivery_recovers_on_fourth_fresh_attempt_without_retrying_auth_or_invalid_data(self):
        import httpx

        request = AsyncMock(side_effect=[asyncio.TimeoutError(), asyncio.TimeoutError(), asyncio.TimeoutError(),
                                         self.current_volatility()])
        with patch("market.asyncio.sleep", new_callable=AsyncMock):
            result = await MarketSituationContextReader(request=request).spx_realized_volatility()
        self.assertEqual(result["status"], "available")
        self.assertEqual(request.await_count, 4)
        self.assertTrue(all(call.args[0].endswith("?forceRefresh=1") for call in request.await_args_list[1:]))
        req = httpx.Request("GET", "http://dashboard.test/history")
        for status in (401, 403, 404):
            error = httpx.HTTPStatusError("Unavailable", request=req, response=httpx.Response(status, request=req))
            reader = AsyncMock(side_effect=[error, self.current_volatility()])
            result = await MarketSituationContextReader(request=reader).spx_realized_volatility()
            self.assertEqual(result["status"], "unavailable")
            reader.assert_awaited_once()
        payload = {**self.current_volatility(), "mock": True}
        payload["completedSession"] = {"status": "unavailable"}
        reader = AsyncMock(side_effect=[payload, self.current_volatility()])
        self.assertEqual((await MarketSituationContextReader(request=reader).spx_realized_volatility())["status"], "unavailable")
        reader.assert_awaited_once()

    async def test_invalid_executable_mock_seed_stale_or_cache_only_input_is_withheld(self):
        for flag in ("mock", "seed", "seeded", "stale", "cacheOnly", "offline"):
            payload = self.current_volatility()
            payload[flag] = True
            result = await MarketSituationContextReader(request=AsyncMock(return_value=payload)).spx_realized_volatility()
            self.assertEqual(result["status"], "unavailable")
        payload = {**self.current_volatility(), "executable": True}
        result = await MarketSituationContextReader(request=AsyncMock(return_value=payload)).spx_realized_volatility()
        self.assertEqual(result["status"], "unavailable")


class ContractTests(unittest.TestCase):
    def test_common_envelope_and_live_provider_guard(self):
        value = envelope(
            status="available",
            source_system="ibkr",
            provider="ibkr",
            data={"quotes": []},
            freshness="live",
            live_verified=True,
        )
        validate_envelope(value)
        self.assertEqual(
            set(value),
            {"status", "sourceSystem", "provider", "asOf", "freshness", "liveVerified", "warnings", "data", "citations"},
        )
        invalid = {**value, "sourceSystem": "openbb", "provider": "yfinance"}
        with self.assertRaisesRegex(ValueError, "Only verified IBKR"):
            validate_envelope(invalid)

        direct_kalshi = envelope(
            status="available",
            source_system="market_dashboard",
            provider="kalshi",
            data={"markets": []},
            freshness="direct_venue_snapshot",
            live_verified=True,
        )
        validate_envelope(direct_kalshi)
        with self.assertRaisesRegex(ValueError, "direct_venue_snapshot"):
            validate_envelope({**direct_kalshi, "freshness": "archival"})

    def test_duplicate_or_invalid_citations_are_rejected(self):
        citation = Citation(
            id="cite_" + "a" * 32,
            documentId="doc_" + "b" * 32,
            product="the-call",
            publicationDate="2026-08-15",
            sourceUri="gmail://message/1",
            title="The Call",
        ).as_dict()
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            validate_envelope(
                envelope(
                    status="available",
                    source_system="analyst_index",
                    provider="sqlite",
                    data={},
                    citations=[citation, citation],
                )
            )


class McpBoundaryTests(unittest.IsolatedAsyncioTestCase):
    def test_portfolio_projection_preserves_captured_security_name(self):
        from app import project_portfolio_context
        captured = {"data": {"positions": [{"symbol": "DBMF", "longName": "iMGP DBi Managed Futures Strategy ETF"}]}}
        projected = project_portfolio_context(captured)
        table = projected["data"]["positionTable"]
        self.assertEqual(table["rows"][0][table["columns"].index("securityName")], "iMGP DBi Managed Futures Strategy ETF")
        self.assertEqual(captured["data"]["positions"][0]["longName"], "iMGP DBi Managed Futures Strategy ETF")

    async def test_dashboard_supporting_context_does_not_repeat_live_acquisition(self):
        dated = {"asOf": "2026-09-30T20:00:00Z", "reading": "Captured supporting observation"}
        response = analyst_app.httpx.Response(200, json=dated,
                                             request=analyst_app.httpx.Request("GET", "http://localhost/supporting"))
        supporting = {"status": "available", "liveVerified": False, "freshness": "archival", "data": dated}
        with (
            patch.object(analyst_app.ibkr, "portfolio_context", AsyncMock(side_effect=AssertionError("No repeated valuation"))) as portfolio,
            patch.object(analyst_app.balance_context, "context", AsyncMock(side_effect=AssertionError("No repeated balance"))) as balance,
            patch.object(analyst_app.market_situation_context, "spx_realized_volatility", AsyncMock(return_value=supporting)),
            patch.object(analyst_app.momo_roster_context, "context", AsyncMock(return_value=supporting)),
            patch.object(analyst_app.daily_market_context, "context", AsyncMock(return_value=supporting)),
            patch.object(analyst_app.httpx.AsyncClient, "get", AsyncMock(return_value=response)) as get,
            patch.object(analyst_app.httpx.AsyncClient, "post", AsyncMock(side_effect=AssertionError("No repeated setup analysis"))) as post,
            patch.object(analyst_app, "research_coverage", return_value={"products": []}),
            patch.object(analyst_app.workspace_store, "dispatch", return_value={"conversations": []}),
        ):
            dashboard = await analyst_app.mcp.call_tool("get_dashboard_context", {"include_live_channels": False})
        for reader in (portfolio, balance, post):
            reader.assert_not_awaited()
        self.assertEqual(get.await_count, 5)
        data = dashboard.structuredContent["data"]
        self.assertNotIn("predictionMonitors", data)
        for name in ("portfolio", "balances"):
            self.assertEqual(data[name], {"status": "unavailable", "classification": "not_requested",
                                          "liveVerified": False, "freshness": "unavailable", "data": None})
        self.assertNotIn("exposure", data)
        for name in ("volatility", "currencies", "correlations", "liquidity", "calendarEvents"):
            self.assertEqual(data[name]["data"], dated)
            self.assertEqual(data[name]["classification"], "dated_supporting_context")
            self.assertFalse(data[name]["liveVerified"])
        for name in ("marketBackdrop", "momoRoster", "dailyMarket"):
            self.assertEqual(data[name], supporting)
        self.assertFalse(dashboard.structuredContent["liveVerified"])

    async def test_dashboard_default_preserves_live_readers(self):
        unavailable = envelope(status="unavailable", source_system="ibkr", provider="ibkr", data=None)
        with (
            patch.object(analyst_app.ibkr, "portfolio_context", AsyncMock(return_value=unavailable)) as portfolio,
            patch.object(analyst_app.balance_context, "context", AsyncMock(return_value=unavailable)) as balance,
            patch.object(analyst_app.market_situation_context, "spx_realized_volatility", AsyncMock(return_value=unavailable)),
            patch.object(analyst_app.momo_roster_context, "context", AsyncMock(return_value=unavailable)),
            patch.object(analyst_app.daily_market_context, "context", AsyncMock(return_value=unavailable)),
            patch.object(analyst_app.httpx.AsyncClient, "get", AsyncMock(side_effect=RuntimeError("Provider unavailable"))),
            patch.object(analyst_app.httpx.AsyncClient, "post", AsyncMock(side_effect=AssertionError("No setup analysis post"))) as post,
            patch.object(analyst_app, "research_coverage", return_value={"products": []}),
            patch.object(analyst_app.workspace_store, "dispatch", return_value={"conversations": []}),
        ):
            dashboard = await analyst_app.mcp.call_tool("get_dashboard_context", {})
        for reader in (portfolio, balance):
            reader.assert_awaited_once()
        post.assert_not_awaited()
        self.assertNotIn("predictionMonitors", dashboard.structuredContent["data"])
        self.assertEqual(dashboard.structuredContent["data"]["balances"], unavailable)
        tools = await analyst_app.mcp.list_tools()
        tool = next(tool for tool in tools if tool.name == "get_dashboard_context")
        self.assertTrue(tool.inputSchema["properties"]["include_live_channels"]["default"])

    async def test_process_and_dashboard_tools_keep_independent_evidence(self):
        process = await analyst_app.mcp.call_tool("get_process_context", {})
        self.assertEqual(process.structuredContent["data"]["setupMaxLossPctNlv"], 5)
        self.assertEqual(process.structuredContent["data"]["cpiReleaseMaxLossPctNlv"], 15)
        self.assertIn("canonicalSource", process.structuredContent["data"])
        # Every security is sized by the ATR band in the canonical Process source.
        self.assertNotIn("portfolioSizingPolicies", process.structuredContent["data"])
        self.assertIn("risk.atr_band", process.structuredContent["data"]["canonicalSource"]["text"])
        unavailable = envelope(status="unavailable", source_system="ibkr", provider="ibkr", data=None)
        with (
            patch.object(analyst_app.ibkr, "portfolio_context", AsyncMock(return_value=unavailable)),
            patch.object(analyst_app.balance_context, "context", AsyncMock(return_value=unavailable)),
            patch.object(analyst_app.market_situation_context, "spx_realized_volatility", AsyncMock(return_value=unavailable)),
            patch.object(analyst_app.httpx.AsyncClient, "get", AsyncMock(side_effect=RuntimeError("Provider unavailable"))),
            patch.object(analyst_app.httpx.AsyncClient, "post", AsyncMock(side_effect=RuntimeError("Provider unavailable"))),
        ):
            dashboard = await analyst_app.mcp.call_tool("get_dashboard_context", {})
        data = dashboard.structuredContent["data"]
        self.assertFalse(data["portfolio"]["liveVerified"])
        self.assertEqual(set(["balances", "marketBackdrop", "volatility", "currencies", "correlations", "liquidity", "calendarEvents", "momoRoster"]) - set(data), set())
        self.assertEqual(data["momoRoster"]["status"], "unavailable")
        self.assertFalse(data["momoRoster"]["liveVerified"])

    async def test_dashboard_includes_bounded_verified_momo_universe_through_existing_tool(self):
        from test_momo_roster_context import roster, TOP_TEN
        from momo_roster_context import project_momo_roster
        projected = project_momo_roster(roster())
        unavailable = envelope(status="unavailable", source_system="ibkr", provider="ibkr", data=None)
        with (
            patch.object(analyst_app.ibkr, "portfolio_context", AsyncMock(return_value=unavailable)),
            patch.object(analyst_app.balance_context, "context", AsyncMock(return_value=unavailable)),
            patch.object(analyst_app.market_situation_context, "spx_realized_volatility", AsyncMock(return_value=unavailable)),
            patch.object(analyst_app.momo_roster_context, "context", AsyncMock(return_value=projected)) as context,
            patch.object(analyst_app.httpx.AsyncClient, "get", AsyncMock(side_effect=RuntimeError("Provider unavailable"))),
            patch.object(analyst_app.httpx.AsyncClient, "post", AsyncMock(side_effect=RuntimeError("Provider unavailable"))),
        ):
            dashboard = await analyst_app.mcp.call_tool("get_dashboard_context", {})
        context.assert_awaited_once()
        value = dashboard.structuredContent["data"]["momoRoster"]
        self.assertEqual(value["data"]["tickerOrder"], TOP_TEN + ["NFLX", "SNOW"])
        self.assertFalse(value["liveVerified"])
        self.assertNotIn("quote", json.dumps(value))

    async def test_dashboard_includes_complete_dated_movers_without_a_new_tool_or_live_claim(self):
        from test_daily_market_context import daily_snapshot, NOW
        from daily_market_context import project_daily_market
        projected = project_daily_market(daily_snapshot(NOW - timedelta(days=40)), NOW)
        unavailable = envelope(status="unavailable", source_system="ibkr", provider="ibkr", data=None)
        with (
            patch.object(analyst_app.ibkr, "portfolio_context", AsyncMock(return_value=unavailable)),
            patch.object(analyst_app.balance_context, "context", AsyncMock(return_value=unavailable)),
            patch.object(analyst_app.market_situation_context, "spx_realized_volatility", AsyncMock(return_value=unavailable)),
            patch.object(analyst_app.daily_market_context, "context", AsyncMock(return_value=projected)) as context,
            patch.object(analyst_app.httpx.AsyncClient, "get", AsyncMock(side_effect=RuntimeError("Provider unavailable"))),
            patch.object(analyst_app.httpx.AsyncClient, "post", AsyncMock(side_effect=RuntimeError("Provider unavailable"))),
        ):
            dashboard = await analyst_app.mcp.call_tool("get_dashboard_context", {})
        context.assert_awaited_once()
        value = dashboard.structuredContent["data"]["dailyMarket"]
        self.assertFalse(value["liveVerified"])
        self.assertFalse(value["executable"])
        self.assertEqual(value["data"]["displayStatus"], "D")
        self.assertEqual(value["data"]["universe"]["label"], "S&P 500 · SPY")
        self.assertEqual(value["data"]["coverage"], {"quotes": 503, "total": 503})
        self.assertEqual([row["ticker"] for row in value["data"]["winners"]], ["AAA", "BBB"])

    async def test_exact_fifteen_tool_boundary_is_explicitly_read_only(self):
        tools = await analyst_app.mcp.list_tools()
        self.assertEqual(
            {tool.name for tool in tools},
            {
                "get_research_coverage",
                "get_briefing_packet",
                "get_market_situation_context",
                "search_research",
                "get_research_source",
                "get_research_page_image",
                "get_dashboard_context",
                "get_process_context",
                "get_portfolio_context",
                "get_balance_context",
                "get_live_market_snapshot",
                "get_market_history",
                "get_company_fundamentals",
                "get_macro_series",
            },
        )
        for tool in tools:
            self.assertTrue(tool.annotations.readOnlyHint, tool.name)
            self.assertFalse(tool.annotations.destructiveHint, tool.name)

    def test_review_catalog_alone_never_verifies_live_quotes(self):
        source = envelope(status="partial", source_system="dashboard", provider="fixed_prediction_monitor_universe",
                          freshness="current_monitor", data={"markets": []})
        source["liveVerified"] = True
        with self.assertRaisesRegex(ValueError, "quote-only scope"):
            validate_envelope(source)

    async def test_health_splits_stale_research_and_live_ibkr_review_dependencies(self):
        original_status = analyst_app.ibkr.status
        original_runtime = dict(analyst_app.runtime_state)
        original_coverage = analyst_app.research_index.coverage_counts
        original_latest = analyst_app.research_index.latest_by_product
        try:
            analyst_app.research_index.coverage_counts = lambda: {"documents": 1}
            analyst_app.research_index.latest_by_product = lambda: {}

            async def live_ibkr():
                return {"status": "available", "freshness": "live", "liveVerified": True, "warnings": []}

            analyst_app.ibkr.status = live_ibkr
            analyst_app.runtime_state.update(
                syncStatus="ready",
                lastSyncAt="2020-01-01T00:00:00Z",
                lastSyncError=None,
            )
            stale_response = await analyst_app.healthz(None)
            stale = json.loads(stale_response.body)
            self.assertFalse(stale["portfolioReview"]["ready"])
            self.assertFalse(stale["portfolioReview"]["dependencies"]["research"]["ready"])
            self.assertIn("stale", stale["portfolioReview"]["dependencies"]["research"]["reason"].lower())
            self.assertTrue(stale["portfolioReview"]["dependencies"]["ibkr"]["ready"])

            async def offline_ibkr():
                return {
                    "status": "unavailable",
                    "freshness": "unavailable",
                    "liveVerified": False,
                    "warnings": ["IBKR disconnected"],
                }

            analyst_app.ibkr.status = offline_ibkr
            analyst_app.runtime_state.update(
                syncStatus="ready",
                lastSyncAt=datetime.now(timezone.utc).isoformat(),
                lastSyncError=None,
            )
            offline_response = await analyst_app.healthz(None)
            offline = json.loads(offline_response.body)
            self.assertTrue(offline["portfolioReview"]["dependencies"]["research"]["ready"])
            self.assertFalse(offline["portfolioReview"]["dependencies"]["ibkr"]["ready"])
            self.assertEqual(
                offline["portfolioReview"]["dependencies"]["ibkr"]["reason"],
                "IBKR disconnected",
            )
        finally:
            analyst_app.ibkr.status = original_status
            analyst_app.runtime_state.clear()
            analyst_app.runtime_state.update(original_runtime)
            analyst_app.research_index.coverage_counts = original_coverage
            analyst_app.research_index.latest_by_product = original_latest

    async def test_portfolio_review_launch_rejects_failed_dependency_before_persisting_a_run(self):
        class Request:
            async def json(self):
                return {
                    "reviewKind": "portfolio-review",
                    "sessionId": "stored-a",
                    "requestId": "request-a",
                }

        dependency_health = {
            "ready": False,
            "coverage": {},
            "latestRiskRanges": {},
            "dependencies": {
                "research": {
                    "ready": True,
                    "state": "ready",
                    "reason": None,
                },
                "ibkr": {
                    "ready": False,
                    "state": "unavailable",
                    "reason": "IBKR disconnected",
                },
            },
        }
        with (
            patch.object(
                analyst_app,
                "_portfolio_review_dependency_health",
                AsyncMock(return_value=dependency_health),
            ),
            patch.object(analyst_app, "_start_portfolio_review_run", AsyncMock()) as start_run,
        ):
            response = await analyst_app.start_portfolio_review_route(Request())

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(payload["code"], "PORTFOLIO_REVIEW_DEPENDENCY_UNAVAILABLE")
        self.assertIn("IBKR disconnected", payload["error"])
        start_run.assert_not_awaited()

    async def test_large_live_tools_emit_bounded_authoritative_contracts(self):
        mark_variants = [
            {
                "currentValuesLiveVerified": True,
                "markStatus": "fresh_live_ibkr",
                "valuationBasis": "live_ibkr",
            },
            {
                "currentValuesOfficialSettlementVerified": True,
                "markStatus": "verified_official_settlement",
                "valuationBasis": "official_settlement",
            },
            {
                "currentValuesResolverVerified": True,
                "markStatus": "verified_resolver_outcome",
                "valuationBasis": "resolver_determined",
            },
            {
                "markStatus": "awaiting_official_settlement",
                "valuationBasis": "unavailable",
                "markUnavailableReason": "awaiting_official_settlement",
            },
            {
                "markStatus": "unavailable_after_broker_snapshot",
                "valuationBasis": "unavailable",
                "markUnavailableReason": "quote_timeout",
            },
        ]
        source_positions = []
        for index in range(200):
            variant = mark_variants[index if index < 5 else 0]
            source_positions.append({
                "account": "U1",
                "symbol": f"SYM{index}",
                "localSymbol": f"CONTRACT_{index}",
                "conId": 10_000 + index,
                "instrumentCategory": "event_contract" if index < 5 else "stock",
                "contractExpiration": "20260828" if index < 5 else None,
                "contractStrike": 6500 + index if index < 5 else None,
                "contractRight": "C" if index < 5 else None,
                "eventContractSide": "YES" if index < 5 else None,
                "currency": "USD",
                "quantity": index + 1,
                "averageCost": 10.25,
                "costBasis": (index + 1) * 10.25,
                "valuationPrice": 12.5,
                "marketValue": (index + 1) * 12.5,
                "valuationPnl": (index + 1) * 2.25,
                "padding": "x" * 500,
                **variant,
            })
        portfolio_data = {
            "accounts": ["U1"],
            "accountSummaries": [{"account": "U1", "NetLiquidation": 100_000}],
            "pnl": [{"account": "U1", "dailyPnL": 125}],
            "coverageComplete": True,
            "positionValuationCoverageComplete": False,
            "quoteCoverage": {"positionCount": 200, "freshMarkCount": 197},
            "valuationCoverage": {"positionCount": 200, "valuedCount": 198},
            "refreshEvidence": {"mode": "on_demand_live_fanout", "accountReads": 1},
            "positions": source_positions,
        }
        portfolio_payload = envelope(
            status="available",
            source_system="ibkr",
            provider="ibkr",
            data=portfolio_data,
            as_of="2026-08-25T03:00:00Z",
            freshness="live",
            live_verified=True,
        )
        with patch.object(
            analyst_app.ibkr,
            "portfolio_context",
            new=AsyncMock(return_value=portfolio_payload),
        ):
            portfolio_result = await analyst_app.mcp.call_tool("get_portfolio_context", {})

        portfolio_text = portfolio_result.content[0].text
        self.assertNotIn("\n", portfolio_text)
        portfolio_envelope = json.loads(portfolio_text)
        self.assertEqual(portfolio_envelope["status"], "available")
        self.assertEqual(portfolio_envelope["provider"], "ibkr")
        self.assertTrue(portfolio_envelope["liveVerified"])
        self.assertLess(len(portfolio_text), 45_000)
        projected_portfolio = portfolio_result.structuredContent
        self.assertEqual(portfolio_envelope, projected_portfolio)
        projected_data = projected_portfolio["data"]
        self.assertNotIn("positions", projected_data)
        for field in (
            "accounts",
            "accountSummaries",
            "pnl",
            "coverageComplete",
            "positionValuationCoverageComplete",
            "quoteCoverage",
            "valuationCoverage",
            "refreshEvidence",
        ):
            self.assertEqual(projected_data[field], portfolio_data[field])
        table = projected_data["positionTable"]
        self.assertEqual(table["columns"], [
            "account", "symbol", "contract", "conId", "category",
            "expiration", "strike", "right", "eventSide", "currency",
            "quantity", "averageCost", "costBasis", "markState",
            "valuationPrice", "marketValue", "valuationPnl", "unavailableReason",
            "secType", "securityName",
        ])
        self.assertEqual(table["rowCount"], 200)
        self.assertEqual(len(table["rows"]), 200)
        con_id_index = table["columns"].index("conId")
        self.assertEqual(
            [row[con_id_index] for row in table["rows"]],
            [position["conId"] for position in source_positions],
        )
        mark_state_index = table["columns"].index("markState")
        self.assertEqual(
            [row[mark_state_index] for row in table["rows"][:5]],
            ["live", "settled", "resolver", "awaiting_settlement", "unavailable"],
        )
        for row in table["rows"][:3]:
            self.assertEqual(row[14:17], [12.5, row[10] * 12.5, row[10] * 2.25])
        for row in table["rows"][3:5]:
            self.assertEqual(row[14:17], [None, None, None])
            self.assertEqual(row[11], 10.25)
            self.assertIsNotNone(row[12])
        self.assertLess(
            len(portfolio_result.model_dump_json(exclude_none=True)),
            100_000,
        )

        history = {
            "available": True,
            "status": "verified_history",
            "summary": {"forecastRows": 14},
            "daily": [{"date": f"2026-08-{day:02d}", "actual": day} for day in range(12, 26)],
            "observations": [{"session_date": "2026-08-25", "value": 1}],
            "forecasts": [{"value_date": "2026-08-25", "value": 2}],
            "postings": [{"posted_date": "2026-08-25", "value": 3}],
            "formulaAudit": [{"value_date": "2026-08-25", "value": 4}],
            "coverage": {"rowLimitPerSection": 14},
        }
        current = {
            "available": True,
            "status": "live",
            "source": "ibkr_live_session",
            "accountId": "U1",
            "currency": "USD",
            "positionScope": "stocks_and_event_contracts",
            "observedAt": "2026-08-25T03:00:00Z",
            "socketVerifiedAt": "2026-08-25T03:00:00Z",
            "accountValuesObservedAt": "2026-08-25T03:00:00Z",
            "fromCache": False,
            "exposure": {"available": True, "netLiquidation": 100_000},
            "margin": {"available": True, "maintenanceMarginRequirement": 20_000},
            "settlement": {"state": "settled"},
            "activity": {"openOrderCount": 0},
            "cash": {"noBorrowBalance": 10_000},
            "buffer": {"available": 8_000},
            "eventContracts": {"positionCount": 3, "marketValue": 400},
            "interestExposure": {"available": True, "current": -12.5},
            "freshness": {"status": "fresh"},
            "capacity": {
                "available": True,
                "status": "live",
                "settlement": {"state": "duplicate"},
                "activity": {"openOrderCount": 999},
                "cash": {"noBorrowBalance": 999},
                "buffer": {"available": 999},
            },
            "positions": [{"padding": "x" * 500} for _ in range(200)],
            "longPositions": [{"padding": "x" * 500} for _ in range(200)],
            "shortPositions": [{"padding": "x" * 500} for _ in range(200)],
            "eventPositions": [{"padding": "x" * 500} for _ in range(200)],
            "timing": {"total_ms": 125},
            "snapshotId": "verbose-snapshot-id",
        }
        balance_payload = envelope(
            status="available",
            source_system="market_dashboard",
            provider="ibkr",
            data={
                "current": current,
                "interestStatus": {"available": True, "mtd": {"liveNetAccrued": -12.5}},
                "history": history,
                "policy": {"missingValuesMayBeInferred": False},
            },
            as_of="2026-08-25T03:00:00Z",
            freshness="live_with_dated_verified_history",
            live_verified=True,
        )
        with patch.object(
            analyst_app.balance_context,
            "context",
            new=AsyncMock(return_value=balance_payload),
        ):
            balance_result = await analyst_app.mcp.call_tool("get_balance_context", {})

        balance_text = balance_result.content[0].text
        self.assertNotIn("\n", balance_text)
        balance_envelope = json.loads(balance_text)
        self.assertEqual(balance_envelope["status"], "available")
        self.assertEqual(balance_envelope["provider"], "ibkr")
        self.assertTrue(balance_envelope["liveVerified"])
        self.assertLess(len(balance_text), 45_000)
        self.assertEqual(balance_envelope, balance_result.structuredContent)
        projected_balance_data = balance_result.structuredContent["data"]
        projected_current = projected_balance_data["current"]
        for removed in (
            "positions", "longPositions", "shortPositions", "eventPositions",
            "timing", "snapshotId",
        ):
            self.assertNotIn(removed, projected_current)
        for retained in (
            "exposure", "margin", "settlement", "activity", "cash", "buffer",
            "eventContracts", "interestExposure", "freshness",
        ):
            self.assertEqual(projected_current[retained], current[retained])
        self.assertEqual(
            projected_current["capacity"],
            {"available": True, "status": "live"},
        )
        self.assertEqual(projected_balance_data["interestStatus"], balance_payload["data"]["interestStatus"])
        self.assertEqual(projected_balance_data["history"], history)
        self.assertEqual(projected_balance_data["policy"], balance_payload["data"]["policy"])
        self.assertLess(
            len(balance_result.model_dump_json(exclude_none=True)),
            100_000,
        )

    def test_feed_sweep_resumes_a_parked_cursor_and_reconciles_after_bootstrap(self):
        class Index:
            def __init__(self, **state):
                self.state = state

            def get_sync_state(self, key, default=""):
                return self.state.get(key, default)

        now = datetime(2026, 10, 25, 21, 0, tzinfo=timezone.utc)
        recent = (now - timedelta(minutes=30)).isoformat()
        old = (now - timedelta(seconds=analyst_app.FEED_RECONCILE_INTERVAL_SECONDS)).isoformat()
        self.assertTrue(analyst_app.feed_sweep_due(Index(), now))
        self.assertFalse(analyst_app.feed_sweep_due(Index(research_bootstrap_complete=recent), now))
        # A sweep cut short at its page limit must finish, however recent bootstrap was.
        self.assertTrue(analyst_app.feed_sweep_due(
            Index(research_bootstrap_complete=recent, research_feed_cursor="parked"), now))
        # A publication that never reached the change journal is found by reconciliation.
        self.assertTrue(analyst_app.feed_sweep_due(Index(research_bootstrap_complete=old), now))
        self.assertTrue(analyst_app.feed_sweep_due(Index(research_bootstrap_complete="2026-10-25T20:00:00"), now))

    async def test_indexing_loop_lives_for_the_whole_application_lifespan(self):
        entered = asyncio.Event()
        started = asyncio.Event()
        cancelled = asyncio.Event()
        exited = asyncio.Event()

        @asynccontextmanager
        async def transport_lifespan(_application):
            entered.set()
            try:
                yield
            finally:
                exited.set()

        async def indexer():
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        async with analyst_app.managed_indexing_lifespan(None, transport_lifespan, indexer):
            await asyncio.wait_for(started.wait(), timeout=1)
            self.assertTrue(entered.is_set())
            self.assertFalse(cancelled.is_set())
        self.assertTrue(cancelled.is_set())
        self.assertTrue(exited.is_set())


class SidecarRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_application_lifespan_measures_loop_lag_for_its_whole_duration(self):
        events = []

        @asynccontextmanager
        async def indexing(_application, _transport):
            events.append("enter")
            try:
                yield
            finally:
                events.append("exit")

        monitor = Mock()
        monitor.start.side_effect = lambda loop: events.append(("start", loop))
        monitor.stop.side_effect = lambda: events.append("stop")
        # Pooled clients close only after indexing and the MCP transport have exited.
        aclose = AsyncMock(side_effect=lambda: events.append("aclose"))
        with patch.object(analyst_app, "managed_indexing_lifespan", indexing), \
                patch.object(analyst_app, "loop_lag_monitor", monitor), \
                patch.object(analyst_app, "aclose_shared_clients", aclose):
            async with analyst_app.application_lifespan(None):
                self.assertEqual(events, [("start", asyncio.get_running_loop()), "enter"])
        self.assertEqual(events[2:], ["exit", "aclose", "stop"])

        @asynccontextmanager
        async def failed_startup(_application, _transport):
            raise RuntimeError("transport startup failed")
            yield

        monitor.reset_mock()
        aclose = AsyncMock()
        with patch.object(analyst_app, "managed_indexing_lifespan", failed_startup), \
                patch.object(analyst_app, "loop_lag_monitor", monitor), \
                patch.object(analyst_app, "aclose_shared_clients", aclose):
            with self.assertRaisesRegex(RuntimeError, "transport startup failed"):
                async with analyst_app.application_lifespan(None):
                    pass
        monitor.start.assert_called_once()
        monitor.stop.assert_called_once_with()
        aclose.assert_awaited_once_with()

        # The monitor stops even when closing pooled clients fails.
        monitor.reset_mock()
        with patch.object(analyst_app, "managed_indexing_lifespan", indexing), \
                patch.object(analyst_app, "loop_lag_monitor", monitor), \
                patch.object(analyst_app, "aclose_shared_clients", AsyncMock(side_effect=RuntimeError("client close failed"))):
            with self.assertRaisesRegex(RuntimeError, "client close failed"):
                async with analyst_app.application_lifespan(None):
                    pass
        monitor.stop.assert_called_once_with()

    async def test_production_review_checkpoints_become_workspace_source_progress(self):
        import review_runs_v2
        from review_runs_v2 import ReviewExecutionContext, ReviewRunV2Store

        with tempfile.TemporaryDirectory() as directory:
            store = ReviewRunV2Store(Path(directory) / "reviews.sqlite3")
            run, _ = store.create(review_kind="balance-review", conversation_id="workspace-chat",
                                  request_id="source-progress-wiring")
            context = ReviewExecutionContext(store, run["runId"], "balance-review", conversation_id="workspace-chat",
                                             on_checkpoint=analyst_app.review_coordinator_v2.on_checkpoint)
            # The hook reads the module's current workspace store when it fires.
            with patch.object(analyst_app.workspace_store, "record_source_progress", return_value=True) as record:
                await context.checkpoint("balance", status="ready", evidence={"liveVerified": True})
                await asyncio.to_thread(review_runs_v2._CHECKPOINT_NOTIFIER.submit(lambda: None).result, 2)
        record.assert_called_once_with("workspace-chat", run["runId"], "balance", "ready")

    async def test_review_conversation_list_hides_workspace_deleted_chats(self):
        from types import SimpleNamespace
        from review_runs_v2 import ReviewRunV2Store

        with tempfile.TemporaryDirectory() as directory:
            store = ReviewRunV2Store(Path(directory) / "reviews.sqlite3")
            conversations = []
            for request in ("kept", "deleted"):
                conversation, run, _created, _reused = store.create_conversation(
                    review_kind="balance-review", request_id=request)
                store.update(run["runId"], state="succeeded", phase="terminal", outcome="ready")
                conversations.append(conversation)
            kept, deleted = conversations
            with patch.object(analyst_app, "review_run_v2_store", store), \
                    patch.object(analyst_app.workspace_store, "deleted_conversation_ids",
                                 return_value={deleted["conversationId"]}):
                response = await analyst_app.list_review_conversations_v2_route(SimpleNamespace(query_params={}))
            listed = [row["conversationId"] for row in json.loads(response.body)["conversations"]]
            self.assertEqual(listed, [kept["conversationId"]])
            # The deleted chat's review history itself is kept.
            self.assertEqual(len(store.list_conversations(limit=10)[0]), 2)

    def test_timestamped_logging_prefixes_lines_without_changing_their_content(self):
        from uvicorn.logging import AccessFormatter, DefaultFormatter

        access = logging.StreamHandler(io.StringIO())
        access.setFormatter(AccessFormatter('%(levelprefix)s %(client_addr)s - "%(request_line)s" %(status_code)s',
                                            use_colors=False))
        default = logging.StreamHandler(io.StringIO())
        default.setFormatter(DefaultFormatter("%(levelprefix)s %(message)s", use_colors=False))
        access_record = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d',
                                          ("127.0.0.1:61514", "POST", "/internal/workspace/list", "1.1", 200), None)
        error_record = logging.LogRecord("uvicorn.error", logging.INFO, __file__, 1, "Application startup complete.", (), None)
        originals = (access.formatter.format(access_record), default.formatter.format(error_record))
        self.assertEqual(originals[0], 'INFO:     127.0.0.1:61514 - "POST /internal/workspace/list HTTP/1.1" 200 OK')
        logging.getLogger("uvicorn.access").addHandler(access)
        logging.getLogger("uvicorn").addHandler(default)
        try:
            analyst_app.configure_timestamped_logging()
            # A second configuration (application startup) never stacks prefixes.
            analyst_app.configure_timestamped_logging()
            stamped = (access.formatter.format(access_record), default.formatter.format(error_record))
        finally:
            logging.getLogger("uvicorn.access").removeHandler(access)
            logging.getLogger("uvicorn").removeHandler(default)
        for record, original, line in zip((access_record, error_record), originals, stamped):
            prefix = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + f".{int(record.msecs):03d}Z "
            self.assertEqual(line, prefix + original)
        # Application loggers propagate to the timestamped root handler.
        self.assertTrue(any(getattr(handler.formatter, "analyst_timestamped", False)
                            for handler in logging.getLogger().handlers))

    def test_timestamped_logging_leaves_brace_and_dollar_formats_unchanged(self):
        # Both styles subclass PercentStyle; a "%" prefix would print "{message}".
        record = logging.LogRecord("uvicorn.error", logging.INFO, __file__, 1, "Application startup complete.", (), None)
        for formatter in (logging.Formatter("{levelname} {message}", style="{"),
                          logging.Formatter("$levelname $message", style="$")):
            handler = logging.StreamHandler(io.StringIO())
            handler.setFormatter(formatter)
            logging.getLogger("uvicorn.error").addHandler(handler)
            try:
                analyst_app.configure_timestamped_logging()
            finally:
                logging.getLogger("uvicorn.error").removeHandler(handler)
            self.assertIs(handler.formatter, formatter)
            self.assertEqual(handler.formatter.format(record), "INFO Application startup complete.")

    async def test_typed_workspace_absence_keeps_status_and_code_but_untyped_key_errors_do_not(self):
        class ConversationDeleted(KeyError):
            code = "ANALYST_CONVERSATION_DELETED"
            status_code = 410

        class UnverifiedStatus(KeyError):
            code = "ANALYST_CONVERSATION_NOT_FOUND"
            status_code = "410"

        request = AsyncMock()
        request.path_params = {"operation": "get"}
        request.json.return_value = {"conversationId": "saved-chat"}
        for failure, status, body in (
            (ConversationDeleted("saved-chat"), 410, {"error": "'saved-chat'", "code": "ANALYST_CONVERSATION_DELETED"}),
            (UnverifiedStatus("saved-chat"), 404, {"error": "'saved-chat'", "code": "ANALYST_CONVERSATION_NOT_FOUND"}),
            (KeyError("messages"), 404, {"error": "'messages'"}),
        ):
            with self.subTest(failure=type(failure).__name__), \
                    patch.object(analyst_app.workspace_store, "dispatch", side_effect=failure):
                response = await analyst_app.workspace_route(request)
            self.assertEqual(response.status_code, status)
            self.assertEqual(json.loads(response.body), body)

    async def test_research_readiness_and_change_feed_store_work_runs_off_the_loop(self):
        loop_thread = threading.get_ident()
        calls = []

        def recent(dates_per_product):
            calls.append(("recent", threading.get_ident()))
            return [{"document_id": "doc-1", "content_hash": "hash-1", "product": "the-call"}]

        def sync_state(key, default=""):
            calls.append(("feed", threading.get_ident()))
            return json.dumps({"products": [{"id": "the-call"}], "generatedAt": "2026-10-09T12:00:00Z", "warnings": []})

        request = AsyncMock()
        request.path_params = {"operation": "readiness"}
        request.json.return_value = {}
        with patch.object(analyst_app.research_index, "recent_documents_by_product", side_effect=recent), \
                patch.object(analyst_app.research_index, "get_sync_state", side_effect=sync_state):
            response = await analyst_app.workspace_route(request)
        self.assertEqual(json.loads(response.body), {
            "products": [{"id": "the-call"}], "indexed": [], "feedGeneratedAt": "2026-10-09T12:00:00Z",
            "portfolioIndexed": [{"document_id": "doc-1", "content_hash": "hash-1"}], "errors": []})

        def setting(operation, payload):
            calls.append(("cursor", threading.get_ident()))
            self.assertEqual((operation, payload), ("setting", {"key": "research-change-cursor"}))
            return {"value": "cursor-1"}

        def coverage(key, value):
            calls.append(("coverage", threading.get_ident()))
            self.assertEqual((key, json.loads(value)), ("feed_coverage", {"products": []}))

        feed = {"documents": [], "coverage": {"products": []}, "events": [{"id": "event-1"}], "cursor": "cursor-2"}
        client = httpx.AsyncClient

        def change_client(**options):
            return client(transport=httpx.MockTransport(
                lambda feed_request: httpx.Response(200, json=feed) if feed_request.url.params["cursor"] == "cursor-1"
                else httpx.Response(400)), **options)

        request.path_params = {"operation": "changes"}
        with patch.object(analyst_app.workspace_store, "dispatch", side_effect=setting), \
                patch.object(analyst_app.research_index, "set_sync_state", side_effect=coverage), \
                patch.object(analyst_app.httpx, "AsyncClient", side_effect=change_client):
            response = await analyst_app.workspace_route(request)
        self.assertEqual(json.loads(response.body), {"events": [{"id": "event-1"}], "cursor": "cursor-2", "ingestion": None})
        self.assertEqual([name for name, _thread in calls], ["feed", "recent", "cursor", "coverage"])
        self.assertTrue(all(thread != loop_thread for _name, thread in calls), calls)

    async def test_a_slow_change_page_keeps_coverage_current_without_a_second_embed(self):
        release = threading.Event()
        upserts = []
        coverage = []

        def upsert(documents):
            upserts.append([document.document_id for document in documents])
            release.wait(5)
            return {"documents": len(documents), "chunks": 0, "unchanged": 0}

        client = httpx.AsyncClient

        def change_client(**options):
            feed = {"documents": [{"documentId": "doc-1", "product": "signal-strength", "publicationDate": "2026-09-25",
                                   "title": "Signal Strength", "sourceUri": "gmail://message/doc-1", "text": "Longs: OKTA."}],
                    "coverage": {"generatedAt": f"2026-10-23T18:5{len(coverage)}:00Z", "products": []},
                    "events": [{"id": "event-1"}], "cursor": "cursor-2"}
            return client(transport=httpx.MockTransport(lambda _request: httpx.Response(200, json=feed)), **options)

        request = AsyncMock()
        request.path_params = {"operation": "changes"}
        request.json.return_value = {}
        with patch.object(analyst_app.workspace_store, "dispatch", return_value={"value": "cursor-1"}), \
                patch.object(analyst_app.research_index, "set_sync_state", side_effect=lambda _key, value: coverage.append(json.loads(value)["generatedAt"])), \
                patch.object(analyst_app.research_index, "upsert_documents", side_effect=upsert), \
                patch.object(analyst_app, "CHANGE_INDEX_WAIT_SECONDS", 0.05), \
                patch.object(analyst_app, "_change_indexing", None), \
                patch.object(analyst_app.httpx, "AsyncClient", side_effect=change_client):
            first = json.loads((await analyst_app.workspace_route(request)).body)
            retry = json.loads((await analyst_app.workspace_route(request)).body)
            release.set()
            await analyst_app._change_indexing
            settled = json.loads((await analyst_app.workspace_route(request)).body)

        self.assertEqual(first, {"events": [], "cursor": None, "ingestion": None})
        self.assertEqual(retry, first)
        self.assertEqual(settled, {"events": [{"id": "event-1"}], "cursor": "cursor-2", "ingestion": None})
        self.assertEqual(coverage, ["2026-10-23T18:50:00Z", "2026-10-23T18:51:00Z", "2026-10-23T18:52:00Z"])
        self.assertEqual(upserts, [["doc-1"], ["doc-1"]])

    async def test_activity_reports_in_progress_work_from_both_stores_off_the_loop(self):
        from review_runs_v2 import ReviewRunV2Store
        from workspace import WorkspaceStore

        loop_thread = threading.get_ident()
        with tempfile.TemporaryDirectory() as directory:
            reviews = ReviewRunV2Store(Path(directory) / "reviews.sqlite3")
            workspace = WorkspaceStore(Path(directory) / "workspace.sqlite3")
            reviews.create(review_kind="balance-review", session_id="session", request_id="request")
            workspace.dispatch("accept", {"requestId": "chat", "text": "Hello"})
            threads = []
            counted = reviews.active_attempt_count

            def count(window):
                threads.append(threading.get_ident())
                return counted(window)

            request = AsyncMock()
            request.path_params = {"operation": "activity"}
            with patch.object(analyst_app, "review_run_v2_store", reviews), \
                    patch.object(analyst_app, "workspace_store", workspace), \
                    patch.object(reviews, "active_attempt_count", side_effect=count):
                request.json.return_value = {"windowSeconds": 1800}
                response = await analyst_app.workspace_route(request)
                self.assertEqual(json.loads(response.body),
                                 {"reviews": 1, "turns": 1, "windowSeconds": 1800})
                self.assertEqual(response.headers["Cache-Control"], "no-store")
                self.assertEqual(len(threads), 1)
                self.assertNotEqual(threads[0], loop_thread)
                request.json.return_value = {}
                self.assertEqual(json.loads((await analyst_app.workspace_route(request)).body)["windowSeconds"], 1800)
                for invalid in (59, 86401, "1800", True, 1800.5):
                    with self.subTest(window=invalid):
                        request.json.return_value = {"windowSeconds": invalid}
                        self.assertEqual((await analyst_app.workspace_route(request)).status_code, 409)

    async def test_source_binding_names_the_sources_the_user_paused(self):
        request = AsyncMock()
        request.path_params = {"operation": "source-binding"}
        request.json.return_value = {"conversationId": "conversation"}
        binding = {"conversation": {"id": "conversation", "kind": "portfolio-review"}, "runId": None}
        flags = ("ANALYST_PORTFOLIO_PCA_ENABLED", "ANALYST_ALPHA_ARCHIVE_SCAN_ENABLED")
        for enabled, expected in (((), ["portfolioPca", "alphaCodes"]), ((flags[0],), ["alphaCodes"]), (flags, [])):
            with self.subTest(enabled=enabled), patch.dict(os.environ), \
                    patch.object(analyst_app.workspace_store, "dispatch", return_value=dict(binding)):
                for flag in flags:
                    os.environ[flag] = "true" if flag in enabled else "false"
                response = await analyst_app.workspace_route(request)
                self.assertEqual(json.loads(response.body), {**binding, "pausedSources": expected})


class LiveDataGuardTests(unittest.IsolatedAsyncioTestCase):
    def test_expired_forecastex_identity_accepts_ibkr_missing_exchange_only_with_exact_metadata(self):
        now = datetime(2026, 8, 25, 18, 0, tzinfo=timezone.utc)
        exact = {
            "localSymbol": "FES_082426_7675_YES",
            "secType": "FOP",
            "exchange": None,
            "tradingClass": "FES",
            "currency": "USD",
            "right": "C",
            "lastTradeDateOrContractMonth": "20260824",
        }

        self.assertTrue(market._expired_forecastex_contract(exact, now))
        for changes in (
            {"tradingClass": "ES"},
            {"secType": "STK"},
            {"exchange": "CBOE"},
            {"right": "P"},
            {"lastTradeDateOrContractMonth": "20260825"},
        ):
            self.assertFalse(market._expired_forecastex_contract({**exact, **changes}, now))

    async def test_disconnected_ibkr_returns_no_portfolio_or_quote_values(self):
        paths = []

        async def request(path, **_kwargs):
            # The data endpoints themselves refuse while disconnected; no
            # separate /status read gates them.
            paths.append(path)
            if path == "/quotes":
                # The quote service answers 200 with its refusal.
                return {"ok": False, "status": "gateway_not_authenticated", "message": "Gateway offline",
                        "quotes": []}
            response = market.httpx.Response(503, json={
                "ok": False, "connected": False, "status": "gateway_not_authenticated",
                "error_code": "IBKR_GATEWAY_NOT_AUTHENTICATED", "message": "Gateway offline",
            }, request=market.httpx.Request("GET", f"http://127.0.0.1:8765{path}"))
            response.raise_for_status()

        reader = IbkrReader(request=request)
        portfolio = await reader.portfolio_context()
        quotes = await reader.market_snapshot(["AAPL"])
        self.assertEqual(paths, ["/portfolio/live-positions", "/quotes"])
        self.assertEqual(portfolio["status"], "unavailable")
        self.assertFalse(portfolio["liveVerified"])
        self.assertEqual(portfolio["data"]["positions"], [])
        # A failed holdings read never reports the shared Gateway connection state.
        self.assertEqual(portfolio["errorCode"], "IBKR_HOLDINGS_SERVICE_UNAVAILABLE")
        self.assertEqual(quotes["status"], "unavailable")
        self.assertEqual(quotes["data"]["quotes"], [])
        # The refusal is stated without the service's raw message.
        self.assertIn("The IBKR session could not be verified, so no verified quotes were returned.",
                      quotes["warnings"])
        self.assertNotIn("Gateway offline", " ".join(quotes["warnings"]))

    async def test_balance_survives_slow_supporting_interest_reads(self):
        now = datetime(2026, 9, 6, 18, 0, tzinfo=timezone.utc)
        stamp = now.isoformat()

        async def request(path):
            if path == "/api/portfolio/balance":
                return {
                    "available": True, "status": "live", "source": "ibkr_live_session",
                    "accountId": "U1", "fromCache": False,
                    "observedAt": stamp, "socketVerifiedAt": stamp,
                    "accountValuesObservedAt": stamp, "freshness": {"status": "fresh"},
                    "exposure": {"available": True, "status": "live",
                                 "source": "ibkr_live_session", "netLiquidation": 100000},
                }
            await asyncio.sleep(10)

        result = await BalanceContextReader(
            request=request, now=lambda: now, supporting_timeout_seconds=0.01,
        ).context()
        self.assertTrue(result["liveVerified"])
        self.assertEqual(result["data"]["current"]["exposure"]["netLiquidation"], 100000)
        self.assertIsNone(result["data"]["interestStatus"])
        self.assertIsNone(result["data"]["history"])

    async def test_balance_failure_preserves_safe_provider_classification_without_account_data(self):
        unverified = market.BALANCE_FAILURE_MESSAGES["IBKR_BALANCE_UNVERIFIED"]
        self.assertIn("does not establish an IB Gateway disconnect", unverified)
        for code, producer, captured, expected in (
            ("IBKR_BALANCE_REQUEST_TIMEOUT", {}, "IBKR_BALANCE_REQUEST_TIMEOUT",
             "The live IBKR balance request exceeded its total deadline."),
            # The dedicated balance client failing is not a verified Gateway
            # disconnect; only the producer's explicit classification is.
            ("GATEWAY_UNAVAILABLE", {}, "IBKR_BALANCE_UNVERIFIED", unverified),
            ("GATEWAY_UNAVAILABLE", {"gatewayErrorCode": "IBKR_GATEWAY_NOT_CONNECTED"}, "GATEWAY_UNAVAILABLE",
             "The dedicated IBKR balance connection was unavailable."),
            ("ACCOUNT_NOT_MANAGED", {}, "ACCOUNT_NOT_MANAGED",
             "The requested account was not managed by the verified IBKR session."),
        ):
            with self.subTest(code=code, producer=producer):
                response = market.httpx.Response(503, json={
                    "errorCode": code, "accountId": "private-account",
                    "message": "private-account has 123456.78; raw provider diagnostic",
                    "exposure": {"netLiquidation": 123456.78}, **producer,
                }, request=market.httpx.Request("GET", "http://localhost/api/portfolio/balance"))

                async def request(path):
                    self.assertEqual(path, "/api/portfolio/balance")
                    response.raise_for_status()

                result = await BalanceContextReader(request=request).context()
                self.assertEqual(result["errorCode"], captured)
                self.assertEqual(result["diagnostic"], {"errorCode": captured, "message": expected, "httpStatus": 503})
                self.assertEqual(result["warnings"], [expected])
                self.assertEqual(result["status"], "unavailable")
                self.assertFalse(result["liveVerified"])
                for name in ("current", "history", "interestStatus"):
                    self.assertIsNone(result["data"][name])
                for private_value in ("private-account", "123456.78", "raw provider diagnostic"):
                    self.assertNotIn(private_value, json.dumps(result))
                validate_envelope(result)

    async def test_balance_failure_rejects_unknown_or_malformed_http_diagnostics(self):
        for status, body, expected in (
            (503, '{"errorCode":"private-account","message":"123456.78"}', "BALANCE_HTTP_ERROR"),
            (503, '{"errorCode":{"private-account":123456.78}}', "BALANCE_HTTP_ERROR"),
            (503, '["private-account",123456.78]', "BALANCE_HTTP_ERROR"),
            (503, "private-account:123456.78", "BALANCE_HTTP_ERROR"),
            (504, "private-account:123456.78", "BALANCE_REQUEST_TIMEOUT"),
        ):
            with self.subTest(status=status, body=body):
                response = market.httpx.Response(status, content=body,
                    request=market.httpx.Request("GET", "http://localhost/api/portfolio/balance"))

                async def request(_path):
                    response.raise_for_status()

                result = await BalanceContextReader(request=request).context()
                self.assertEqual(result["errorCode"], expected)
                self.assertEqual(result["diagnostic"]["httpStatus"], status)
                self.assertFalse(result["liveVerified"])
                self.assertIsNone(result["data"]["current"])
                self.assertNotIn("private-account", json.dumps(result))
                self.assertNotIn("123456.78", json.dumps(result))

    async def test_balance_failure_distinguishes_transport_timeout_without_copying_exception_text(self):
        for error, expected in (
            (market.httpx.ReadTimeout("private-account 123456.78"), "BALANCE_REQUEST_TIMEOUT"),
            (asyncio.TimeoutError("private-account 123456.78"), "BALANCE_REQUEST_TIMEOUT"),
            (market.httpx.ConnectError("private-account 123456.78"), "BALANCE_SERVICE_UNAVAILABLE"),
            (market.httpx.ReadError("private-account 123456.78"), "BALANCE_SERVICE_UNAVAILABLE"),
            (market.httpx.RemoteProtocolError("private-account 123456.78"), "BALANCE_SERVICE_UNAVAILABLE"),
            (RuntimeError("private-account 123456.78"), "BALANCE_UNAVAILABLE"),
        ):
            with self.subTest(error=type(error).__name__):
                async def request(_path):
                    raise error

                result = await BalanceContextReader(request=request).context()
                self.assertEqual(result["errorCode"], expected)
                self.assertFalse(result["liveVerified"])
                self.assertIsNone(result["data"]["current"])
                self.assertNotIn("httpStatus", result["diagnostic"])
                self.assertNotIn("private-account", json.dumps(result))
                self.assertNotIn("123456.78", json.dumps(result))

    async def test_balance_context_keeps_live_current_data_separate_from_bounded_history(self):
        now = datetime(2026, 8, 26, 18, 0, tzinfo=timezone.utc)
        observed_at = now.isoformat().replace("+00:00", "Z")
        calls = []
        daily = [
            {
                "date": f"2026-08-{day:02d}",
                "forecast_point_debit_cost": float(day),
                "flex_actual_debit_cost": float(day) + 0.25,
                "row_status": "verified_evidence_present",
            }
            for day in range(1, 21)
        ]
        forecasts = [
            {
                "value_date": f"2026-08-{day:02d}",
                "point_forecast": float(day),
                "actual_debit_interest": float(day) + 0.25,
                "point_residual_actual_minus_forecast": 0.25,
                "comparison_status": "verified",
            }
            for day in range(1, 21)
        ]

        async def request(path):
            calls.append(path)
            if path == "/api/portfolio/balance":
                return {
                    "available": True,
                    "status": "live",
                    "source": "ibkr_live_session",
                    "accountId": "U1",
                    "observedAt": observed_at,
                    "socketVerifiedAt": observed_at,
                    "accountValuesObservedAt": observed_at,
                    "fromCache": False,
                    "exposure": {
                        "available": True,
                        "status": "live",
                        "source": "ibkr_live_session",
                        "netLiquidation": 100_000,
                    },
                    "margin": {
                        "available": True,
                        "status": "live",
                        "source": "ibkr_live_session",
                    },
                    "capacity": {"available": True, "status": "live"},
                    "freshness": {"status": "fresh"},
                }
            if path == "/api/ibkr/interest-validation/status?account=U1":
                return {
                    "source": "ibkr_interest_validation",
                    "generatedAt": observed_at,
                    "accountMatched": True,
                    "available": True,
                    "actionable": False,
                    "mtd": {"liveNetAccrued": -12.5},
                }
            if path == "/api/ibkr/interest-validation/ledger?account=U1":
                return {
                    "source": "ibkr_verified_interest_ledger",
                    "available": True,
                    "status": "verified_history",
                    "accountId": "U1",
                    "accountMatched": True,
                    "fromCache": False,
                    "generatedAt": observed_at,
                    "summary": {"recovered": {"forecastRows": 20}},
                    "ledger": daily,
                    "observations": [],
                    "forecasts": forecasts,
                    "postings": [],
                    "formulaAudit": [],
                }
            raise AssertionError(path)

        result = await BalanceContextReader(
            request=request,
            now=lambda: now,
        ).context()

        self.assertEqual(result["status"], "available")
        self.assertTrue(result["liveVerified"])
        self.assertEqual(result["provider"], "ibkr")
        self.assertEqual(result["data"]["current"]["accountId"], "U1")
        self.assertEqual(len(result["data"]["history"]["daily"]), 14)
        self.assertEqual(result["data"]["history"]["daily"][0]["date"], "2026-08-07")
        self.assertEqual(result["data"]["history"]["daily"][-1]["date"], "2026-08-20")
        self.assertEqual(len(result["data"]["history"]["forecasts"]), 14)
        self.assertEqual(
            result["data"]["history"]["coverage"]["daily"],
            {"returnedRows": 14, "from": "2026-08-07", "through": "2026-08-20"},
        )
        self.assertFalse(result["data"]["policy"]["historicalPortfolioTotalsAvailable"])
        self.assertFalse(result["data"]["policy"]["liveMtdNetAndDailyGrossDebitAreComparable"])
        self.assertCountEqual(calls, [
            "/api/portfolio/balance",
            "/api/ibkr/interest-validation/status?account=U1",
            "/api/ibkr/interest-validation/ledger?account=U1",
        ])

    async def test_balance_context_keeps_verified_exposure_as_live_partial(self):
        now = datetime(2026, 8, 26, 18, 0, tzinfo=timezone.utc)
        observed_at = now.isoformat().replace("+00:00", "Z")
        calls = []

        async def request(path):
            calls.append(path)
            if path == "/api/portfolio/balance":
                return {
                    "available": True,
                    "status": "live",
                    "source": "ibkr_live_session",
                    "accountId": "U1",
                    "observedAt": observed_at,
                    "socketVerifiedAt": observed_at,
                    "accountValuesObservedAt": observed_at,
                    "fromCache": False,
                    "exposure": {
                        "available": True,
                        "status": "live",
                        "source": "ibkr_live_session",
                        "netLiquidation": 100_000,
                    },
                    "margin": {
                        "available": False,
                        "status": "unavailable",
                        "source": "unavailable",
                        "errorCode": "BALANCE_MARGIN_UNAVAILABLE",
                    },
                    "capacity": {
                        "available": False,
                        "status": "unavailable",
                        "errorCode": "EVENT_CONTRACT_ACCOUNTING_UNRECONCILED",
                    },
                    "settlement": None,
                    "cash": None,
                    "buffer": None,
                    "freshness": {"status": "fresh"},
                }
            if path == "/api/ibkr/interest-validation/status?account=U1":
                return {
                    "source": "ibkr_interest_validation",
                    "generatedAt": observed_at,
                    "accountMatched": True,
                    "available": True,
                    "actionable": False,
                }
            if path == "/api/ibkr/interest-validation/ledger?account=U1":
                return {
                    "source": "ibkr_verified_interest_ledger",
                    "available": True,
                    "status": "verified_history",
                    "accountId": "U1",
                    "accountMatched": True,
                    "fromCache": False,
                    "generatedAt": observed_at,
                    "summary": {"actualDebitInterest": 12.5},
                    "ledger": [{
                        "date": "2026-08-25",
                        "row_status": "verified_evidence_present",
                        "actual_debit_interest": 12.5,
                    }],
                    "observations": [],
                    "forecasts": [],
                    "postings": [],
                    "formulaAudit": [],
                }
            raise AssertionError(path)

        result = await BalanceContextReader(
            request=request,
            now=lambda: now,
        ).context()

        self.assertEqual(result["status"], "partial")
        self.assertTrue(result["liveVerified"])
        self.assertEqual(result["data"]["current"]["exposure"]["netLiquidation"], 100_000)
        self.assertIsNone(result["data"]["current"]["cash"])
        self.assertIsNone(result["data"]["current"]["settlement"])
        self.assertEqual(result["data"]["history"]["daily"][0]["actual_debit_interest"], 12.5)
        self.assertTrue(any("margin" in warning.lower() for warning in result["warnings"]))
        self.assertTrue(any("capacity" in warning.lower() for warning in result["warnings"]))
        self.assertCountEqual(calls, [
            "/api/portfolio/balance",
            "/api/ibkr/interest-validation/status?account=U1",
            "/api/ibkr/interest-validation/ledger?account=U1",
        ])

    async def test_balance_context_omits_stale_current_data_before_reading_history(self):
        now = datetime(2026, 8, 26, 18, 0, tzinfo=timezone.utc)
        stale = (now - timedelta(minutes=5)).isoformat().replace("+00:00", "Z")
        calls = []

        async def request(path):
            calls.append(path)
            if path != "/api/portfolio/balance":
                raise AssertionError("Historical reads must not follow a failed current account gate.")
            return {
                "available": True,
                "status": "live",
                "source": "ibkr_live_session",
                "accountId": "U1",
                "observedAt": stale,
                "socketVerifiedAt": stale,
                "accountValuesObservedAt": stale,
                "fromCache": False,
                "exposure": {
                    "available": True,
                    "status": "live",
                    "source": "ibkr_live_session",
                },
                "freshness": {"status": "fresh"},
            }

        result = await BalanceContextReader(
            request=request,
            now=lambda: now,
        ).context()

        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["errorCode"], "BALANCE_VERIFICATION_FAILED")
        self.assertFalse(result["liveVerified"])
        self.assertIsNone(result["data"]["current"])
        self.assertIsNone(result["data"]["history"])
        self.assertEqual(calls, ["/api/portfolio/balance"])

    async def test_balance_context_rejects_offline_cache_mock_and_seed_inputs(self):
        now = datetime(2026, 8, 26, 18, 0, tzinfo=timezone.utc)
        observed_at = now.isoformat().replace("+00:00", "Z")
        valid = {
            "available": True,
            "status": "live",
            "source": "ibkr_live_session",
            "accountId": "U1",
            "observedAt": observed_at,
            "socketVerifiedAt": observed_at,
            "accountValuesObservedAt": observed_at,
            "fromCache": False,
            "exposure": {
                "available": True,
                "status": "live",
                "source": "ibkr_live_session",
            },
            "freshness": {"status": "fresh"},
        }
        for label, changes in (
            ("cache", {"fromCache": True}),
            ("mock", {"mock": True}),
            ("seed", {"seeded": True}),
        ):
            with self.subTest(label=label):
                async def request(path, payload={**valid, **changes}):
                    self.assertEqual(path, "/api/portfolio/balance")
                    return payload

                result = await BalanceContextReader(
                    request=request,
                    now=lambda: now,
                ).context()
                self.assertEqual(result["status"], "unavailable")
                self.assertFalse(result["liveVerified"])
                self.assertIsNone(result["data"]["current"])

        async def offline(_path):
            raise RuntimeError("IBKR offline")

        offline_result = await BalanceContextReader(
            request=offline,
            now=lambda: now,
        ).context()
        self.assertEqual(offline_result["status"], "unavailable")
        self.assertFalse(offline_result["liveVerified"])
        self.assertIsNone(offline_result["data"]["current"])

    async def test_delayed_stale_and_unentitled_quotes_are_omitted(self):
        observed = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

        async def request(path, **_kwargs):
            if path == "/status":
                return {"connected": True, "status": "connected", "accounts": ["A"]}
            if path == "/quotes":
                return {
                    "quotes": [
                        {"symbol": "AAPL", "last": 100, "dataType": "delayed", "priceState": "market_mark", "entitlementStatus": "delayed", "timestamp": observed},
                        {"symbol": "MSFT", "last": 200, "dataType": "live", "priceState": "market_mark", "entitlementStatus": "not_entitled", "timestamp": observed},
                    ]
                }
            raise AssertionError(path)

        result = await IbkrReader(request=request).market_snapshot(["AAPL", "MSFT"])
        self.assertEqual(result["status"], "unavailable")
        self.assertFalse(result["liveVerified"])
        self.assertEqual(result["data"]["quotes"], [])

    async def test_portfolio_retries_a_missing_mark_and_keeps_only_verified_live_value(self):
        observed = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        quote_calls = 0

        async def request(path, **kwargs):
            nonlocal quote_calls
            if path == "/status":
                return {"connected": True, "status": "connected", "accounts": []}
            if path == "/portfolio/live-positions":
                return {
                    "ok": True,
                    "source": "ibkr_live_session",
                    "from_cache": False,
                    "accounts": [],
                    "positions_observed_at": observed,
                    "positions": [{
                        "symbol": "EXPGY",
                        "localSymbol": "EXPGY",
                        "conId": 41197624,
                        "secType": "STK",
                        "exchange": "PINK",
                        "currency": "USD",
                        "position": 10,
                        "avgCost": 38,
                    }],
                }
            if path == "/quotes":
                quote_calls += 1
                self.assertEqual(kwargs["json_body"]["instruments"][0]["conId"], 41197624)
                self.assertTrue(kwargs["json_body"]["forceRefresh"])
                if quote_calls == 1:
                    return {"quotes": [], "errors": ["EXPGY: quote_timeout"]}
                return {
                    "quotes": [{
                        "symbol": "EXPGY",
                        "localSymbol": "EXPGY",
                        "conId": 41197624,
                        "last": 40,
                        "dataType": "live",
                        "priceState": "market_mark",
                        "entitlementStatus": "tick_by_tick",
                        "timestamp": observed,
                    }],
                    "errors": [],
                }
            raise AssertionError(path)

        result = await IbkrReader(request=request).portfolio_context()

        self.assertEqual(quote_calls, 2)
        self.assertEqual(result["status"], "available")
        self.assertTrue(result["liveVerified"])
        self.assertEqual(result["data"]["quoteCoverage"], {
            "positionCount": 1,
            "quoteEligiblePositionCount": 1,
            "freshMarkCount": 1,
            "missingMarkCount": 0,
            "skippedForSettlementCount": 0,
            "initialFreshMarkCount": 0,
            "brokerSnapshotRequestedCount": 1,
            "brokerSnapshotRetryCount": 1,
            "brokerSnapshotAttemptCount": 2,
            "brokerSnapshotRecoveredCount": 1,
            "recoveredAfterRetryCount": 1,
            "coverageComplete": True,
            "asOf": observed,
            "missingBySecurityType": {},
            "missingByExchange": {},
            "missingByExpiration": {},
        })
        self.assertEqual(result["data"]["refreshEvidence"]["mode"], "on_demand_live_fanout")
        self.assertEqual(result["data"]["refreshEvidence"]["brokerSnapshotRequestedCount"], 1)
        self.assertEqual(result["data"]["refreshEvidence"]["brokerSnapshotRecoveredCount"], 1)
        self.assertEqual(result["data"]["positions"][0]["currentPrice"], 40)
        self.assertEqual(result["data"]["positions"][0]["marketValue"], 400)
        self.assertNotIn("quote_timeout", " ".join(result["warnings"]))

    async def test_portfolio_skips_expired_forecastex_quotes_and_awaits_settlement(self):
        observed = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        quote_con_ids = []

        async def request(path, **kwargs):
            if path == "/status":
                return {"connected": True, "status": "connected", "accounts": []}
            if path == "/portfolio/live-positions":
                return {
                    "ok": True,
                    "source": "ibkr_live_session",
                    "from_cache": False,
                    "accounts": [],
                    "positions_observed_at": observed,
                    "positions": [{
                        "symbol": "ES",
                        "localSymbol": "FES_082426_7675_YES",
                        "conId": 101,
                        "secType": "FOP",
                        # IBKR's live position endpoint omits exchange after
                        # expiry; the exact FES trading class and local-symbol
                        # identity still distinguish this ForecastEx contract.
                        "exchange": None,
                        "currency": "USD",
                        "lastTradeDateOrContractMonth": "20260824",
                        "strike": 7675,
                        "right": "C",
                        "multiplier": "1",
                        "tradingClass": "FES",
                        "position": 1000,
                        "avgCost": 0.51,
                    }, {
                        "symbol": "AAPL",
                        "localSymbol": "AAPL",
                        "conId": 102,
                        "secType": "STK",
                        "exchange": "NASDAQ",
                        "currency": "USD",
                        "position": 2,
                        "avgCost": 220,
                    }],
                }
            if path == "/quotes":
                quote_con_ids.extend(row["conId"] for row in kwargs["json_body"]["instruments"])
                return {
                    "quotes": [{
                        "symbol": "AAPL",
                        "localSymbol": "AAPL",
                        "conId": 102,
                        "secType": "STK",
                        "exchange": "NASDAQ",
                        "last": 230,
                        "dataType": "live",
                        "priceState": "market_mark",
                        "entitlementStatus": "tick_by_tick",
                        "timestamp": observed,
                    }],
                    "errors": [],
                }
            raise AssertionError(path)

        result = await IbkrReader(
            request=request,
            now=lambda: datetime(2026, 8, 25, 18, 0, tzinfo=timezone.utc),
        ).portfolio_context()
        positions = {row["conId"]: row for row in result["data"]["positions"]}
        expired = positions[101]

        self.assertEqual(quote_con_ids, [102])
        self.assertIsNone(expired["currentPrice"])
        self.assertIsNone(expired["valuationPrice"])
        self.assertIsNone(expired["marketValue"])
        self.assertEqual(expired["instrumentCategory"], "event_contract")
        self.assertEqual(expired["valuationStatus"], "awaiting_official_settlement")
        self.assertEqual(expired["markStatus"], "awaiting_official_settlement")
        self.assertEqual(expired["markUnavailableReason"], "awaiting_official_settlement")
        self.assertFalse(expired["currentValuesLiveVerified"])
        self.assertEqual(result["data"]["quoteCoverage"]["skippedForSettlementCount"], 1)
        self.assertEqual(result["data"]["quoteCoverage"]["missingMarkCount"], 0)
        self.assertEqual(result["data"]["valuationCoverage"], {
            "positionCount": 2,
            "valuedCount": 1,
            "liveMarkCount": 1,
            "awaitingSettlementCount": 1,
            "missingCount": 0,
            "missingContracts": [],
            "awaitingSettlementContracts": ["FES_082426_7675_YES"],
            "coverageComplete": False,
        })

    async def test_portfolio_does_not_fabricate_missing_average_cost_or_cost_basis(self):
        observed = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

        async def request(path, **_kwargs):
            if path == "/status":
                return {"connected": True, "status": "connected", "accounts": []}
            if path == "/portfolio/live-positions":
                return {
                    "ok": True,
                    "source": "ibkr_live_session",
                    "from_cache": False,
                    "accounts": [],
                    "positions_observed_at": observed,
                    "positions": [{
                        "symbol": "CPIY",
                        "localSymbol": "CPIY_0826_3.3_YES",
                        "conId": 101,
                        "secType": "OPT",
                        "exchange": "FORECASTX",
                        "currency": "USD",
                        "position": 10,
                    }],
                }
            if path == "/quotes":
                return {
                    "quotes": [{
                        "symbol": "CPIY",
                        "localSymbol": "CPIY_0826_3.3_YES",
                        "conId": 101,
                        "secType": "OPT",
                        "exchange": "FORECASTX",
                        "last": 0.42,
                        "multiplier": "1",
                        "right": "C",
                        "dataType": "live",
                        "priceState": "market_mark",
                        "entitlementStatus": "tick_by_tick",
                        "timestamp": observed,
                    }],
                    "errors": [],
                }
            raise AssertionError(path)

        result = await IbkrReader(request=request).portfolio_context()
        position = result["data"]["positions"][0]

        self.assertEqual(position["instrumentCategory"], "event_contract")
        self.assertIsNone(position["averageCost"])
        self.assertIsNone(position["costBasis"])
        self.assertEqual(position["marketValue"], 4.2)
        self.assertIsNone(position["unrealizedPnlEstimate"])
        self.assertTrue(position["currentValuesLiveVerified"])

    async def test_portfolio_never_substitutes_cost_basis_for_a_missing_live_mark(self):
        observed = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        forced_refresh_values = []

        async def request(path, **kwargs):
            if path == "/status":
                return {"connected": True, "status": "connected", "accounts": []}
            if path == "/portfolio/live-positions":
                return {
                    "ok": True,
                    "source": "ibkr_live_session",
                    "from_cache": False,
                    "accounts": [],
                    "positions_observed_at": observed,
                    "positions": [{
                        "symbol": "ES",
                        "localSymbol": "FES_082126_7750_YES",
                        "conId": 913869780,
                        "secType": "FOP",
                        "exchange": None,
                        "currency": "USD",
                        "position": 100,
                        "avgCost": 0.03,
                    }],
                }
            if path == "/quotes":
                forced_refresh_values.append(kwargs["json_body"]["forceRefresh"])
                return {
                    "quotes": [],
                    "errors": ["ES: quote_timeout"],
                }
            raise AssertionError(path)

        result = await IbkrReader(request=request).portfolio_context()
        position = result["data"]["positions"][0]

        self.assertEqual(result["status"], "partial")
        self.assertEqual(position["costBasis"], 3)
        self.assertIsNone(position["currentPrice"])
        self.assertIsNone(position["marketValue"])
        self.assertIsNone(position["unrealizedPnlEstimate"])
        self.assertFalse(position["currentValuesLiveVerified"])
        self.assertEqual(position["instrumentCategory"], "other")
        self.assertEqual(position["markStatus"], "unavailable_after_broker_snapshot")
        self.assertEqual(position["markUnavailableReason"], "quote_timeout")
        self.assertEqual(forced_refresh_values, [True, True])
        self.assertTrue(any(
            warning.startswith("The dashboard withheld valuations")
            for warning in result["warnings"]
        ))

    async def test_verified_ibkr_event_marks_keep_exact_metadata(self):
        observed = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        quote_request_counts = []
        live_positions = [
            {
                "symbol": "CPIY",
                "localSymbol": "CPIY_0826_3.3_YES",
                "conId": 101,
                "secType": "OPT",
                "exchange": "FORECASTX",
                "currency": "USD",
                "lastTradeDateOrContractMonth": "20260911",
                "strike": 3.3,
                "right": "C",
                "multiplier": "1",
                "tradingClass": "CPIY",
                "position": 66,
                "avgCost": 0.696,
            },
            {
                "symbol": "ES",
                "localSymbol": "FES_082426_7700_YES",
                "conId": 102,
                "secType": "FOP",
                "exchange": "FORECASTX",
                "currency": "USD",
                "lastTradeDateOrContractMonth": "20260824",
                "strike": 7700,
                "right": "P",
                "multiplier": "1",
                "tradingClass": "FES",
                "position": 10,
                "avgCost": 0.35,
            },
            {
                "symbol": "SPX",
                "localSymbol": "SPX   260918P05000000",
                "conId": 103,
                "secType": "OPT",
                "exchange": "CBOE",
                "currency": "USD",
                "lastTradeDateOrContractMonth": "20260918",
                "strike": 5000,
                "right": "P",
                "multiplier": "100",
                "tradingClass": "SPX",
                "position": -2,
                "avgCost": 125,
            },
            {
                "symbol": "ES",
                "localSymbol": "FES_082126_7750_YES",
                "conId": 104,
                "secType": "FOP",
                "exchange": "FORECASTX",
                "currency": "USD",
                "position": 0,
                "avgCost": 0.03,
            },
        ]
        quotes = {
            101: {
                "symbol": "CPIY", "localSymbol": "CPIY_0826_3.3_YES", "conId": 101,
                "secType": "OPT", "exchange": "FORECASTX", "last": 0.685,
                "lastTradeDateOrContractMonth": "20260911", "strike": 3.3, "right": "C",
                "multiplier": "1", "tradingClass": "CPIY",
            },
            102: {
                "symbol": "ES", "localSymbol": "FES_082426_7700_YES", "conId": 102,
                "secType": "FOP", "exchange": "FORECASTX", "last": 0.4,
                "lastTradeDateOrContractMonth": "20260824", "strike": 7700, "right": "P",
                "multiplier": "1", "tradingClass": "FES",
            },
            103: {
                "symbol": "SPX", "localSymbol": "SPX   260918P05000000", "conId": 103,
                "secType": "OPT", "exchange": "CBOE", "last": 1.5,
                "lastTradeDateOrContractMonth": "20260918", "strike": 5000, "right": "P",
                "multiplier": "100", "tradingClass": "SPX",
            },
        }
        for quote in quotes.values():
            quote.update({
                "dataType": "live",
                "priceState": "market_mark",
                "entitlementStatus": "tick_by_tick",
                "timestamp": observed,
            })

        async def request(path, **kwargs):
            if path == "/status":
                return {"connected": True, "status": "connected", "accounts": []}
            if path == "/portfolio/live-positions":
                return {
                    "ok": True,
                    "source": "ibkr_live_session",
                    "from_cache": False,
                    "accounts": [],
                    "positions_observed_at": observed,
                    "positions": live_positions,
                }
            if path == "/quotes":
                instruments = kwargs["json_body"]["instruments"]
                quote_request_counts.append(len(instruments))
                self.assertNotIn(104, {row["conId"] for row in instruments})
                return {"quotes": [quotes[row["conId"]] for row in instruments], "errors": []}
            raise AssertionError(path)

        result = await IbkrReader(request=request).portfolio_context()
        rows = {row["conId"]: row for row in result["data"]["positions"]}

        self.assertEqual(quote_request_counts, [3])
        self.assertEqual(result["data"]["quoteCoverage"]["positionCount"], 3)
        self.assertEqual(result["data"]["quoteCoverage"]["freshMarkCount"], 3)
        self.assertNotIn(104, rows)

        cpi = rows[101]
        self.assertEqual(cpi["instrumentCategory"], "event_contract")
        self.assertEqual(cpi["eventContractSide"], "YES")
        self.assertEqual(cpi["contractExpiration"], "20260911")
        self.assertEqual(cpi["contractStrike"], 3.3)
        self.assertEqual(cpi["contractMultiplier"], 1)
        self.assertEqual(cpi["contractRight"], "C")
        self.assertEqual(cpi["contractExchange"], "FORECASTX")
        self.assertEqual(cpi["tradingClass"], "CPIY")
        self.assertEqual(cpi["averageCost"], 0.696)
        self.assertAlmostEqual(cpi["costBasis"], 45.936)
        self.assertAlmostEqual(cpi["marketValue"], 45.21)
        self.assertAlmostEqual(cpi["unrealizedPnlEstimate"], 66 * (0.685 - 0.696))
        self.assertTrue(cpi["currentValuesLiveVerified"])

        mismatched = rows[102]
        self.assertEqual(mismatched["instrumentCategory"], "event_contract")
        self.assertIsNone(mismatched["eventContractSide"])

        listed = rows[103]
        self.assertEqual(listed["instrumentCategory"], "listed_option")
        self.assertEqual(listed["optionType"], "PUT")
        self.assertEqual(listed["marketValue"], -300)
        self.assertIsNone(listed["unrealizedPnlEstimate"])
        self.assertEqual(listed["valuationStatus"], "live_mark_and_value")

    def test_fresh_live_quote_contract(self):
        quote = {
            "last": 123.45,
            "dataType": "live",
            "priceState": "market_mark",
            "entitlementStatus": "entitled",
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        self.assertTrue(verified_live_quote(quote))
        self.assertEqual(current_price(quote), 123.45)


class OpenBBTests(unittest.IsolatedAsyncioTestCase):
    async def test_metadata_warnings_and_delayed_label_are_preserved(self):
        class Response:
            provider = "yfinance"
            warnings = ["vendor warning"]
            extra = {"arguments": {"symbol": "AAPL"}, "duration": 0.1}
            results = [{"date": "2026-08-14", "close": 100.0}]

        class Price:
            @staticmethod
            def historical(**_kwargs):
                return Response()

        class Equity:
            price = Price()

        class FakeObb:
            equity = Equity()

        result = await OpenBBReader(obb=FakeObb()).market_history("AAPL")
        self.assertEqual(result["provider"], "yfinance")
        self.assertEqual(result["freshness"], "historical_or_delayed")
        self.assertFalse(result["liveVerified"])
        self.assertEqual(result["warnings"], ["vendor warning"])
        self.assertEqual(result["data"]["metadata"]["arguments"]["symbol"], "AAPL")


class PdfTests(TempIndexTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.registry = {
            "products": [
                {"id": "risk-ranges", "matchTerms": ["risk range", "processing signals"]},
                {"id": "the-call", "matchTerms": ["the call"]},
            ]
        }
        self.library = PdfLibrary(self.index, self.registry)

    def test_valid_pdf_wrong_mime_signature_oversize_missing_date_and_detection(self):
        data = make_pdf("Risk Range report 2026-08-15 AAPL")
        extracted = extract_pdf(data)
        self.assertEqual(extracted["pageCount"], 1)
        self.assertIn("Risk Range", extracted["pages"][0]["text"])
        with self.assertRaisesRegex(PdfValidationError, "application/pdf"):
            validate_pdf_bytes(data, content_type="text/plain")
        with self.assertRaisesRegex(PdfValidationError, "signature"):
            validate_pdf_bytes(b"not a pdf", content_type="application/pdf")
        with patch.object(pdf_ingest, "MAX_PDF_BYTES", 4):
            with self.assertRaisesRegex(PdfValidationError, "50 MB"):
                validate_pdf_bytes(b"%PDF-oversize", content_type="application/pdf")
        self.assertIsNone(detect_publication_date("Undated research"))
        self.assertEqual(detect_publication_date("Published 08/15/2026"), "2026-08-15")
        self.assertEqual(
            detect_pdf_metadata_date({"creationDate": "D:20260813084218-04'00'"}),
            "2026-08-13",
        )
        self.assertEqual(
            detect_pdf_metadata_date({"creationDate": "invalid", "modDate": "D:20260814090000Z"}),
            "2026-08-14",
        )
        product, candidates = detect_product("Daily risk range processing signals", self.registry)
        self.assertEqual(product, "risk-ranges")
        self.assertTrue(candidates)

    def test_parser_failure_and_textract_fallback(self):
        with self.assertRaises(PdfValidationError) as failure:
            extract_pdf(b"%PDF-invalid", content_type="application/pdf")
        self.assertEqual(failure.exception.code, "parser_failure")

        blank = make_pdf("")
        with patch.object(pdf_ingest, "_textract_page", return_value="OCR recovered enough searchable words from this scanned page."):
            recovered = extract_pdf(blank)
        self.assertEqual(recovered["ocrPageCount"], 1)
        self.assertEqual(recovered["pages"][0]["extraction"], "textract")

    def test_archived_pdf_normalizes_to_exact_page_documents(self):
        data = make_pdf("Page one sourced view", "Page two sourced view")
        digest = sha256(data).hexdigest()
        documents, result = normalized_pdf_documents(
            data,
            source_uri="s3://market-dashboard-csv-data/hedgeye-email/the-call/deck.pdf",
            product="the-call",
            publication_date="2026-08-15",
            title="The Call",
            expected_sha256=digest,
            metadata={"gmailMessageId": "message-1"},
        )
        self.assertEqual([document.page for document in documents], [1, 2])
        self.assertEqual(len({document.document_id for document in documents}), 2)
        self.assertEqual(
            [document.source_uri.rsplit("#", 1)[-1] for document in documents],
            ["page=1", "page=2"],
        )
        self.assertTrue(all(document.media_type == "application/pdf" for document in documents))
        self.assertEqual(result["pageCount"], 2)
        with self.assertRaises(PdfValidationError) as mismatch:
            normalized_pdf_documents(
                data,
                source_uri="s3://market-dashboard-csv-data/hedgeye-email/the-call/deck.pdf",
                product="the-call",
                publication_date="2026-08-15",
                title="The Call",
                expected_sha256="0" * 64,
            )
        self.assertEqual(mismatch.exception.code, "digest_mismatch")

        repeated, _result = normalized_pdf_documents(
            make_pdf("Repeated sourced page", "Repeated sourced page"),
            source_uri="s3://market-dashboard-csv-data/hedgeye-email/the-call/repeated.pdf",
            product="the-call",
            publication_date="2026-08-15",
            title="The Call",
        )
        inserted = self.index.upsert_documents(repeated)
        self.assertEqual(inserted["documents"], 2)

    def test_commit_requires_date_and_deduplicates_sha256(self):
        data = make_pdf("Risk Range 2026-08-15 AAPL trend and range")
        digest = sha256(data).hexdigest()

        async def run():
            with patch.object(pdf_ingest, "fetch_pdf", new=AsyncMock(return_value=data)):
                analysis = await self.library.analyze(
                    staging_key="analyst-staging/one/report.pdf",
                    filename="risk-range-2026-08-15.pdf",
                    download_url="https://staging.invalid/report.pdf",
                    content_type="application/pdf",
                )
                with self.assertRaises(PdfValidationError) as missing:
                    await self.library.commit(
                        import_id=analysis["importId"],
                        source_uri=f"s3://market-dashboard-csv-data/analyst-research/{digest}.pdf",
                        download_url="https://immutable.invalid/report.pdf",
                        product="risk-ranges",
                        publication_date="",
                        expected_sha256=digest,
                    )
                self.assertEqual(missing.exception.code, "missing_date")
                committed = await self.library.commit(
                    import_id=analysis["importId"],
                    source_uri=f"s3://market-dashboard-csv-data/analyst-research/{digest}.pdf",
                    download_url="https://immutable.invalid/report.pdf",
                    product="risk-ranges",
                    publication_date="2026-08-15",
                    expected_sha256=digest,
                )
                self.assertEqual(committed["status"], "committed")
                duplicate = await self.library.analyze(
                    staging_key="analyst-staging/two/report.pdf",
                    filename="copy.pdf",
                    download_url="https://staging.invalid/copy.pdf",
                    content_type="application/pdf",
                )
                self.assertEqual(duplicate["status"], "duplicate")
                self.assertEqual(duplicate["duplicateOf"], analysis["importId"])

        asyncio.run(run())

    def test_selected_page_renderer_returns_only_requested_page_and_enforces_limit(self):
        data = make_pdf("Page one", "Page two")
        with patch.object(pdf_ingest, "read_source_bytes", return_value=data):
            first = render_selected_page("s3://market-dashboard-csv-data/analyst-research/test.pdf", 1)
            second = render_selected_page("s3://market-dashboard-csv-data/analyst-research/test.pdf", 2)
            self.assertTrue(first.startswith(b"\x89PNG"))
            self.assertTrue(second.startswith(b"\x89PNG"))
            with self.assertRaises(PdfValidationError) as missing:
                render_selected_page("s3://market-dashboard-csv-data/analyst-research/test.pdf", 3)
            self.assertEqual(missing.exception.code, "invalid_page")
            with patch.object(pdf_ingest, "MAX_SELECTED_PAGE_BYTES", 1):
                with self.assertRaises(PdfValidationError) as oversized:
                    render_selected_page("s3://market-dashboard-csv-data/analyst-research/test.pdf", 1)
                self.assertEqual(oversized.exception.code, "page_image_oversize")


if __name__ == "__main__":
    unittest.main()
