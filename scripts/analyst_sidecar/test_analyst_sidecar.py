from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import AsyncMock, patch
from zoneinfo import ZoneInfo


SIDECAR_DIR = Path(__file__).resolve().parent
if str(SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(SIDECAR_DIR))

_APP_DATA_DIR = tempfile.TemporaryDirectory(prefix="analyst-app-test-")
os.environ.setdefault("ANALYST_DATA_DIR", _APP_DATA_DIR.name)
os.environ.setdefault("ANALYST_TEXTRACT_FALLBACK", "false")

import fitz

import app as analyst_app
from contracts import Citation, envelope, validate_envelope
from index import (
    DeterministicTestEmbedder,
    FastEmbedder,
    NormalizedDocument,
    ResearchIndex,
    content_hash,
    normalize_text,
)
import market
from market import (
    BalanceContextReader,
    IbkrReader,
    MarketSituationContextReader,
    OpenBBReader,
    PredictionMarketReader,
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
        self.assertEqual(self.product_row(after, "inflation-nowcast")["status"], "missing")

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
        product_ids = [
            *[product["id"] for product in analyst_app.REGISTRY["products"]],
            analyst_app.INFLATION_PRODUCT["id"],
        ]
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
        self.assertNotIn("\n", packet_result.content[0].text)
        self.assertLess(len(packet_result.content[0].text), 300)
        self.assertLess(len(packet_result.model_dump_json(exclude_none=True)), 50_000)

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
        self.assertLess(len(context_result.content[0].text), 300)
        self.assertLess(len(context_result.model_dump_json(exclude_none=True)), 50_000)


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
        )
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
                    analyst_app.healthz(None),
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

    async def test_max_search_payload_keeps_one_canonical_evidence_copy(self):
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
        self.assertLess(len(result.content[0].text), 300)
        self.assertLess(len(result.model_dump_json(exclude_none=True)), 50_000)


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
            "/api/security-risk-metrics?symbols=SPX",
            "/api/security-risk-metrics?symbols=SPX&forceRefresh=1",
        ])
        self.assertEqual(result["status"], "available")
        self.assertEqual(result["data"]["oneMonth"], {"windowSessions": 21, "valuePct": 9.5})
        self.assertEqual(result["data"]["threeMonth"], {"windowSessions": 63, "valuePct": 11.2})
        self.assertEqual(result["data"]["spreadPercentagePoints"], -1.7)
        self.assertFalse(result["liveVerified"])


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
    async def test_exact_thirteen_tool_boundary_is_explicitly_read_only(self):
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
                "get_portfolio_context",
                "get_balance_context",
                "get_live_market_snapshot",
                "get_prediction_market_snapshot",
                "get_market_history",
                "get_company_fundamentals",
                "get_macro_series",
            },
        )
        for tool in tools:
            self.assertTrue(tool.annotations.readOnlyHint, tool.name)
            self.assertFalse(tool.annotations.destructiveHint, tool.name)
        prediction_tool = next(tool for tool in tools if tool.name == "get_prediction_market_snapshot")
        market_areas = prediction_tool.inputSchema["properties"]["market_areas"]["anyOf"][0]
        self.assertEqual(
            market_areas["items"]["enum"],
            ["sp500", "wti", "nasdaq100", "gold"],
        )
        properties = prediction_tool.inputSchema["properties"]
        self.assertIn("An empty array is treated as omitted", properties["series_tickers"]["description"])
        self.assertIn("include_market_setups", properties)

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
        portfolio_summary = json.loads(portfolio_text)
        self.assertEqual(portfolio_summary["status"], "available")
        self.assertEqual(portfolio_summary["provider"], "ibkr")
        self.assertTrue(portfolio_summary["liveVerified"])
        self.assertLess(len(portfolio_text), 300)
        projected_portfolio = portfolio_result.structuredContent
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
            45_000,
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
        balance_summary = json.loads(balance_text)
        self.assertEqual(balance_summary["status"], "available")
        self.assertEqual(balance_summary["provider"], "ibkr")
        self.assertTrue(balance_summary["liveVerified"])
        self.assertLess(len(balance_text), 300)
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
            45_000,
        )

        prediction_payload = envelope(
            status="available",
            source_system="market_dashboard",
            provider="kalshi",
            data={"markets": [], "refreshEvidence": {"requestedAt": "2026-08-25T03:00:00Z"}},
            as_of="2026-08-25T03:00:00Z",
            freshness="direct_venue_snapshot",
            live_verified=True,
        )
        prediction_snapshot = AsyncMock(return_value=prediction_payload)
        with patch.object(analyst_app.prediction_markets, "snapshot", new=prediction_snapshot):
            prediction_result = await analyst_app.mcp.call_tool(
                "get_prediction_market_snapshot",
                {
                    "series_tickers": [],
                    "market_areas": [],
                    "include_ladders": True,
                    "include_market_setups": True,
                },
            )

        prediction_snapshot.assert_awaited_once_with(
            series_tickers=None,
            include_ladders=True,
            market_areas=None,
            include_market_setups=True,
        )
        prediction_text = prediction_result.content[0].text
        self.assertNotIn("\n", prediction_text)
        prediction_summary = json.loads(prediction_text)
        self.assertEqual(prediction_summary["status"], "available")
        self.assertEqual(prediction_summary["provider"], "kalshi")
        self.assertTrue(prediction_summary["liveVerified"])
        self.assertLess(len(prediction_text), 300)
        self.assertEqual(prediction_result.structuredContent, prediction_payload)
        serialized = prediction_result.model_dump_json(exclude_none=True)
        self.assertEqual(serialized.count("2026-08-25T03:00:00Z"), 3)
        self.assertLess(len(serialized), len(json.dumps(prediction_payload)) + 1_000)

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
        async def request(path, **_kwargs):
            if path == "/status":
                return {"connected": False, "status": "disconnected", "message": "Gateway offline"}
            raise AssertionError(f"No data request should follow disconnected status: {path}")

        reader = IbkrReader(request=request)
        portfolio = await reader.portfolio_context()
        quotes = await reader.market_snapshot(["AAPL"])
        self.assertEqual(portfolio["status"], "unavailable")
        self.assertFalse(portfolio["liveVerified"])
        self.assertEqual(portfolio["data"]["positions"], [])
        self.assertEqual(quotes["status"], "unavailable")
        self.assertEqual(quotes["data"]["quotes"], [])

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

    async def test_portfolio_skips_expired_forecastex_quotes_and_applies_verified_settlement(self):
        observed = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        quote_con_ids = []
        settlement_requests = []

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

        async def settlement_request(path, **kwargs):
            settlement_requests.append((path, kwargs["json_body"]))
            return {
                "status": "available",
                "rows": [{
                    "conId": 101,
                    "localSymbol": "FES_082426_7675_YES",
                    "status": "verified_settlement",
                    "settlementPrice": 0,
                    "settlementSource": "forecastex_verified_settlement",
                    "settlementObservedAt": observed,
                    "settlementDataDate": "2026-08-25",
                    "settlementDate": "2026-08-24",
                }],
            }

        result = await IbkrReader(
            request=request,
            settlement_request=settlement_request,
            now=lambda: datetime(2026, 8, 25, 18, 0, tzinfo=timezone.utc),
        ).portfolio_context()
        positions = {row["conId"]: row for row in result["data"]["positions"]}
        settled = positions[101]

        self.assertEqual(quote_con_ids, [102])
        self.assertEqual(len(settlement_requests), 1)
        self.assertEqual(settled["currentPrice"], None)
        self.assertEqual(settled["valuationPrice"], 0)
        self.assertEqual(settled["marketValue"], 0)
        self.assertEqual(settled["valuationPnl"], -510)
        self.assertEqual(settled["instrumentCategory"], "event_contract")
        self.assertEqual(settled["valuationBasis"], "official_settlement")
        self.assertFalse(settled["currentValuesLiveVerified"])
        self.assertTrue(settled["currentValuesOfficialSettlementVerified"])
        self.assertEqual(settled["markStatus"], "verified_official_settlement")
        self.assertEqual(result["data"]["quoteCoverage"]["skippedForSettlementCount"], 1)
        self.assertEqual(result["data"]["quoteCoverage"]["missingMarkCount"], 0)
        self.assertEqual(result["data"]["valuationCoverage"], {
            "positionCount": 2,
            "valuedCount": 2,
            "liveMarkCount": 1,
            "verifiedSettlementCount": 1,
            "resolverDeterminedCount": 0,
            "awaitingSettlementCount": 0,
            "missingCount": 0,
            "missingContracts": [],
            "awaitingSettlementContracts": [],
            "settledContracts": ["FES_082426_7675_YES"],
            "resolverDeterminedContracts": [],
            "coverageComplete": True,
        })

    async def test_portfolio_values_same_day_fes_from_verified_exact_cutoff_outcome(self):
        observed = "2026-08-25T22:45:00Z"
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
                        "localSymbol": "FES_082526_7700_YES",
                        "conId": 201,
                        "secType": "FOP",
                        "exchange": None,
                        "currency": "USD",
                        "lastTradeDateOrContractMonth": "20260825",
                        "strike": 7700,
                        "right": "C",
                        "multiplier": "1",
                        "tradingClass": "FES",
                        "position": 2000,
                        "avgCost": 0.575,
                    }],
                }
            if path == "/quotes":
                quote_con_ids.extend(
                    row["conId"] for row in kwargs["json_body"]["instruments"]
                )
                return {"quotes": [], "errors": ["ES: quote_timeout"]}
            raise AssertionError(path)

        async def settlement_request(_path, **_kwargs):
            return {
                "status": "available",
                "rows": [{
                    "conId": 201,
                    "localSymbol": "FES_082526_7700_YES",
                    "status": "resolver_determined",
                    "valuationPrice": 0,
                    "valuationSource": "ibkr_exact_cutoff_bar",
                    "valuationObservedAt": observed,
                    "resolverValue": 7691,
                    "resolverSymbol": "ESU26",
                    "resolverWindowHigh": 7694.75,
                    "resolverWindowLow": 7689.5,
                    "resolverCutoffAt": "2026-08-25T20:00:00Z",
                    "resolverProvenance": "verified_ibkr_historical_trade_bar",
                    "finalSettlementPending": True,
                }],
            }

        result = await IbkrReader(
            request=request,
            settlement_request=settlement_request,
            now=lambda: datetime(2026, 8, 25, 22, 45, tzinfo=timezone.utc),
        ).portfolio_context()
        position = result["data"]["positions"][0]

        self.assertEqual(quote_con_ids, [201, 201])
        self.assertEqual(position["valuationBasis"], "resolver_determined")
        self.assertEqual(position["valuationPrice"], 0)
        self.assertEqual(position["marketValue"], 0)
        self.assertEqual(position["valuationPnl"], -1150)
        self.assertFalse(position["currentValuesLiveVerified"])
        self.assertFalse(position["currentValuesOfficialSettlementVerified"])
        self.assertTrue(position["currentValuesResolverVerified"])
        self.assertEqual(position["markStatus"], "verified_resolver_outcome")
        self.assertEqual(result["data"]["quoteCoverage"]["missingMarkCount"], 1)
        self.assertEqual(result["data"]["quoteCoverage"]["skippedForSettlementCount"], 0)
        self.assertEqual(result["data"]["valuationCoverage"], {
            "positionCount": 1,
            "valuedCount": 1,
            "liveMarkCount": 0,
            "verifiedSettlementCount": 0,
            "resolverDeterminedCount": 1,
            "awaitingSettlementCount": 0,
            "missingCount": 0,
            "missingContracts": [],
            "awaitingSettlementContracts": [],
            "settledContracts": [],
            "resolverDeterminedContracts": ["FES_082526_7700_YES"],
            "coverageComplete": True,
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

    async def test_verified_ibkr_event_marks_survive_prediction_failure_with_exact_metadata(self):
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

        async def failed_prediction_request(_path):
            raise RuntimeError("venue offline")

        prediction = await PredictionMarketReader(
            request=failed_prediction_request,
        ).snapshot(include_ladders=False)
        rows = {row["conId"]: row for row in result["data"]["positions"]}

        self.assertEqual(prediction["status"], "unavailable")
        self.assertFalse(prediction["liveVerified"])
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


class PredictionMarketLiveDataGuardTests(unittest.IsolatedAsyncioTestCase):
    NOW = datetime(2026, 8, 18, 18, 0, tzinfo=timezone.utc)

    def row(self, **updates):
        row = {
            "id": "KXCPIYOY-26AUG",
            "seriesTicker": "KXCPIYOY",
            "eventTicker": "KXCPIYOY-26AUG",
            "marketTicker": "KXCPIYOY-26AUG-T2.9",
            "label": "Headline CPI YoY",
            "eventTitle": "CPI in August",
            "marketTitle": "Above 2.9%",
            "closeTime": "2026-08-20T12:30:00Z",
            "venue": {
                "name": "Kalshi",
                "source": "kalshi_trade_api_v2",
                "snapshotType": "direct_venue",
                "yesBid": 0.41,
                "yesAsk": 0.43,
                "yesBidSize": 120,
                "yesAskSize": 90,
                "noBid": 0.56,
                "noAsk": 0.58,
                "noBidSize": 80,
                "noAskSize": 70,
                "volume24h": 1000,
                "volumeTotal": 5000,
                "openInterest": 2200,
                "fetchedAt": "2026-08-18T17:59:40Z",
                "updatedAt": "2026-08-18T17:59:35Z",
            },
            "ibkr": {"verified": False},
            "executable": False,
        }
        for key, value in updates.items():
            if key == "venue":
                row["venue"] = {**row["venue"], **value}
            elif key == "ibkr":
                row["ibkr"] = {**row["ibkr"], **value}
            else:
                row[key] = value
        return row

    @staticmethod
    def watchlist(rows, *, ibkr=None, warnings=None):
        ibkr_provider = ibkr or {
            "status": "catalog_unavailable",
            "connected": True,
            "authenticated": True,
            "errorCode": "CATALOG_NOT_PROMOTED",
            "message": "Catalog is not promoted",
        }
        ibkr_evidence = ibkr_provider.get("refreshEvidence") or {
            "requestedContractCount": 0,
            "brokerSnapshotRequestedCount": 0,
            "brokerSnapshotRetryCount": 0,
            "verifiedContractCount": 0,
            "missingContractCount": 0,
            "coverageComplete": False,
            "blockedBy": ibkr_provider.get("errorCode") or ibkr_provider.get("status"),
            "fromCache": False,
        }
        return {
            "ok": True,
            "rows": rows,
            "warnings": warnings or [],
            "refreshEvidence": {
                "mode": "on_demand_prediction_fanout",
                "requestedAt": "2026-08-18T17:59:30Z",
                "completedAt": "2026-08-18T17:59:45Z",
                "fromCache": False,
                "kalshi": {
                    "requestedSeriesCount": 11,
                    "venueRequestCount": 11,
                    "retryCount": 0,
                    "verifiedSeriesCount": len(rows),
                    "missingSeriesCount": 11 - len(rows),
                    "coverageComplete": len(rows) == 11,
                    "fromCache": False,
                },
                "ibkr": ibkr_evidence,
            },
            "providers": {
                "kalshi": {"status": "direct_venue_snapshot"},
                "ibkr": ibkr_provider,
            },
        }

    def reader(self, payload):
        async def request(path):
            self.assertEqual(path, "/api/prediction-markets/watchlist?forceRefresh=true")
            return payload

        return PredictionMarketReader(request=request, now=lambda: self.NOW)

    async def test_fresh_direct_kalshi_snapshot_preserves_native_yes_and_no_books(self):
        result = await self.reader(self.watchlist([self.row()])).snapshot(
            ["KXCPIYOY"], include_ladders=False
        )
        self.assertTrue(result["liveVerified"])
        self.assertEqual(result["freshness"], "direct_venue_snapshot")
        self.assertEqual(len(result["data"]["markets"]), 1)
        market_row = result["data"]["markets"][0]
        self.assertEqual(
            {key: market_row[key] for key in ("yesBid", "yesAsk", "noBid", "noAsk")},
            {"yesBid": 0.41, "yesAsk": 0.43, "noBid": 0.56, "noAsk": 0.58},
        )
        self.assertFalse(market_row["executable"])
        self.assertTrue(market_row["liveVerified"])
        self.assertEqual(market_row["usage"], "research_only")
        self.assertEqual(result["data"]["providers"]["ibkr"]["errorCode"], "CATALOG_NOT_PROMOTED")
        evidence = result["data"]["refreshEvidence"]
        self.assertEqual(evidence["mode"], "on_demand_prediction_fanout")
        self.assertEqual(evidence["kalshi"]["requestedOutputSeriesCount"], 1)
        self.assertEqual(evidence["kalshi"]["verifiedOutputSeriesCount"], 1)
        self.assertEqual(evidence["ibkr"]["brokerSnapshotRequestedCount"], 0)
        self.assertEqual(evidence["ibkr"]["blockedBy"], "CATALOG_NOT_PROMOTED")

        native_no_depth_absent = self.row(venue={"noBidSize": None, "noAskSize": None})
        absent = await self.reader(self.watchlist([native_no_depth_absent])).snapshot(
            ["KXCPIYOY"], include_ladders=False
        )
        self.assertTrue(absent["liveVerified"])
        self.assertIsNone(absent["data"]["markets"][0]["noBidSize"])
        self.assertIsNone(absent["data"]["markets"][0]["noAskSize"])

    async def test_stale_incomplete_cached_mock_fallback_closed_and_failed_rows_are_omitted(self):
        variants = {
            "stale": self.row(venue={"fetchedAt": "2026-08-18T17:58:00Z"}),
            "incomplete": self.row(venue={"noAsk": None}),
            "cached": self.row(venue={"fromCache": True}),
            "mock": self.row(venue={"flags": ["mock"]}),
            "fallback": self.row(venue={"flags": ["fallback"]}),
            "closed": self.row(closeTime="2026-08-18T17:00:00Z"),
            "failed": self.row(venue={"dataQualityFlags": ["failed"]}),
        }
        for label, row in variants.items():
            with self.subTest(label=label):
                result = await self.reader(self.watchlist([row])).snapshot(
                    ["KXCPIYOY"], include_ladders=False
                )
                self.assertEqual(result["status"], "unavailable")
                self.assertFalse(result["liveVerified"])
                self.assertEqual(result["data"]["markets"], [])

    async def test_partial_coverage_warns_and_never_retains_rejected_rows(self):
        incomplete = self.row(
            seriesTicker="KXGDP",
            eventTicker="KXGDP-26Q3",
            marketTicker="KXGDP-26Q3-T2",
            venue={"noBidSize": None},
        )
        result = await self.reader(self.watchlist([self.row(), incomplete])).snapshot(
            ["KXCPIYOY", "KXGDP"], include_ladders=False
        )
        self.assertEqual(result["status"], "partial")
        self.assertEqual([row["seriesTicker"] for row in result["data"]["markets"]], ["KXCPIYOY"])
        self.assertTrue(any("KXGDP" in warning for warning in result["warnings"]))

    async def test_only_strict_ibkr_quote_can_make_a_kalshi_row_executable(self):
        strict = self.row(
            ibkr={
                "verified": True,
                "conId": 123456,
                "quoteTimestamp": "2026-08-18T17:59:45Z",
                "sourceApi": "IBKR_TWS_API",
                "marketDataType": "live",
                "nativeQuoteSide": "YES",
                "nativeBid": 0.40,
                "nativeAsk": 0.44,
                "nativeBidSize": 10,
                "nativeAskSize": 12,
                "dataQualityFlags": [],
            },
            executable=True,
        )
        accepted = await self.reader(self.watchlist([strict], ibkr={"status": "connected"})).snapshot(
            ["KXCPIYOY"], include_ladders=False
        )
        self.assertTrue(accepted["data"]["markets"][0]["executable"])
        self.assertEqual(accepted["data"]["providers"]["ibkr"]["verifiedContractCount"], 1)

        rejected = self.row(
            ibkr={**strict["ibkr"], "dataQualityFlags": ["portfolio_seed"]},
            executable=True,
        )
        failed = await self.reader(self.watchlist([rejected], ibkr={"status": "connected"})).snapshot(
            ["KXCPIYOY"], include_ladders=False
        )
        self.assertFalse(failed["data"]["markets"][0]["executable"])
        self.assertIsNone(failed["data"]["markets"][0]["ibkr"]["conId"])

    async def test_unknown_and_excessive_series_are_rejected_without_network_access(self):
        request = AsyncMock()
        reader = PredictionMarketReader(request=request, now=lambda: self.NOW)
        unknown = await reader.snapshot(["NOT_ALLOWED"], include_ladders=False)
        excessive = await reader.snapshot(["KXCPIYOY"] * 12, include_ladders=False)
        self.assertEqual(unknown["status"], "invalid_request")
        self.assertEqual(excessive["status"], "invalid_request")
        request.assert_not_awaited()

    async def test_empty_selectors_are_omitted_and_argument_free_defaults_scan_allowlist(self):
        calls = []
        watchlist = self.watchlist([self.row()])

        async def request(path):
            calls.append(path)
            if path == "/api/prediction-markets/watchlist?forceRefresh=true":
                return watchlist
            if path == "/api/prediction-markets/overview?forceRefresh=true":
                return {"ok": True, "markets": {}}
            raise AssertionError(path)

        reader = PredictionMarketReader(request=request, now=lambda: self.NOW)
        empty = await reader.snapshot(
            series_tickers=[],
            market_areas=[],
            include_ladders=False,
        )
        self.assertNotEqual(empty["status"], "invalid_request")
        self.assertEqual(empty["data"]["requestedSeriesTickers"], list(market.PREDICTION_SERIES_TICKERS))
        self.assertEqual(calls, ["/api/prediction-markets/watchlist?forceRefresh=true"])

        calls.clear()
        default = await reader.snapshot()
        self.assertNotEqual(default["status"], "invalid_request")
        self.assertEqual(default["data"]["requestedSeriesTickers"], list(market.PREDICTION_SERIES_TICKERS))
        self.assertCountEqual(calls, [
            "/api/prediction-markets/watchlist?forceRefresh=true",
            "/api/prediction-markets/overview?forceRefresh=true",
        ])

    async def test_options_bundle_keeps_held_contract_snapshot_and_setup_screen_independent(self):
        calls = []
        monitor_payload = {
            "schemaVersion": 1,
            "reportType": "four_market_morning",
            "generatedAt": "2026-08-18T17:59:45Z",
            "asOf": "2026-08-18T17:59:40Z",
            "status": "available",
            "marketOrder": ["sp500", "wti", "nasdaq100", "gold"],
            "summary": {
                "requestedMarketCount": 4,
                "verifiedDirectBookCount": 1,
                "matchedSetupCount": 1,
                "rankEligibleCount": 1,
            },
            "markets": [
                {
                    "marketId": market_id,
                    "setup": {
                        "researchQualified": market_id == "wti",
                        "rankEligible": market_id == "wti",
                    },
                }
                for market_id in ("sp500", "wti", "nasdaq100", "gold")
            ],
            "warnings": [],
            "policy": {
                "currentFieldsMayUseArchiveFallback": False,
                "recommendationAllowed": False,
            },
        }

        async def request(path):
            calls.append(path)
            if path == "/api/prediction-markets/watchlist?forceRefresh=true":
                return self.watchlist([self.row()])
            if path == "/api/prediction-market-test/morning-report":
                return monitor_payload
            raise AssertionError(path)

        result = await PredictionMarketReader(request=request, now=lambda: self.NOW).snapshot(
            include_ladders=False,
            include_market_setups=True,
        )

        self.assertTrue(result["liveVerified"])
        self.assertEqual(len(result["data"]["markets"]), 1)
        screen = result["data"]["marketSetupScreen"]
        self.assertEqual(screen["status"], "available")
        self.assertEqual(screen["freshness"], "current_monitor")
        self.assertFalse(screen["liveVerified"])
        self.assertEqual(screen["summary"]["rankEligibleCount"], 1)
        self.assertEqual(
            [row["marketId"] for row in screen["markets"]],
            ["sp500", "wti", "nasdaq100", "gold"],
        )
        self.assertCountEqual(calls, [
            "/api/prediction-markets/watchlist?forceRefresh=true",
            "/api/prediction-market-test/morning-report",
        ])

    async def test_offline_setup_screen_never_erases_live_held_rows_or_retains_setup_rows(self):
        async def request(path):
            if path == "/api/prediction-markets/watchlist?forceRefresh=true":
                return self.watchlist([self.row()])
            if path == "/api/prediction-market-test/morning-report":
                raise RuntimeError("monitor offline")
            raise AssertionError(path)

        result = await PredictionMarketReader(request=request, now=lambda: self.NOW).snapshot(
            include_ladders=False,
            include_market_setups=True,
        )

        self.assertTrue(result["liveVerified"])
        self.assertEqual(len(result["data"]["markets"]), 1)
        screen = result["data"]["marketSetupScreen"]
        self.assertEqual(screen["status"], "unavailable")
        self.assertEqual(screen["freshness"], "unavailable")
        self.assertEqual(screen["markets"], [])
        self.assertIn("monitor offline", " ".join(screen["warnings"]))

    async def test_one_nonempty_selector_and_one_empty_selector_are_accepted(self):
        watchlist_calls = []

        async def watchlist_request(path):
            watchlist_calls.append(path)
            return self.watchlist([self.row()])

        series_result = await PredictionMarketReader(
            request=watchlist_request,
            now=lambda: self.NOW,
        ).snapshot(
            series_tickers=["KXCPIYOY"],
            market_areas=[],
            include_ladders=False,
        )
        self.assertNotEqual(series_result["status"], "invalid_request")
        self.assertEqual(series_result["data"]["requestedSeriesTickers"], ["KXCPIYOY"])
        self.assertEqual(watchlist_calls, ["/api/prediction-markets/watchlist?forceRefresh=true"])

        monitor_payload = {
            "schemaVersion": 1,
            "reportType": "four_market_morning",
            "generatedAt": "2026-08-18T17:59:45Z",
            "asOf": "2026-08-18T17:59:40Z",
            "status": "partial",
            "marketOrder": ["sp500"],
            "summary": {},
            "markets": [{"marketId": "sp500"}],
            "warnings": [],
            "policy": {"currentFieldsMayUseArchiveFallback": False},
        }

        async def monitor_request(path):
            self.assertEqual(path, "/api/prediction-market-test/morning-report")
            return monitor_payload

        market_result = await PredictionMarketReader(
            request=monitor_request,
            now=lambda: self.NOW,
        ).snapshot(
            series_tickers=[],
            market_areas=["sp500"],
            include_ladders=False,
        )
        self.assertNotEqual(market_result["status"], "invalid_request")

    async def test_four_market_monitor_uses_one_guarded_endpoint_and_preserves_exact_order(self):
        payload = {
            "schemaVersion": 1,
            "reportType": "four_market_morning",
            "generatedAt": "2026-08-18T17:59:45Z",
            "asOf": "2026-08-18T17:59:40Z",
            "status": "partial",
            "marketOrder": ["sp500", "wti", "nasdaq100", "gold"],
            "summary": {"requestedMarketCount": 4, "verifiedDirectBookCount": 1},
            "markets": [
                {"marketId": market_id, "label": market_id, "setup": {"rankEligible": False}}
                for market_id in ("sp500", "wti", "nasdaq100", "gold")
            ],
            "warnings": ["Gold direct book unavailable."],
            "policy": {
                "currentFieldsMayUseArchiveFallback": False,
                "recommendationAllowed": False,
            },
        }

        async def request(path):
            self.assertEqual(path, "/api/prediction-market-test/morning-report")
            return payload

        result = await PredictionMarketReader(request=request, now=lambda: self.NOW).snapshot(
            market_areas=["sp500", "wti", "nasdaq100", "gold"],
            include_ladders=False,
        )

        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["provider"], "market_dashboard")
        self.assertEqual(result["freshness"], "current_monitor")
        self.assertFalse(result["liveVerified"])
        self.assertEqual(
            [row["marketId"] for row in result["data"]["markets"]],
            ["sp500", "wti", "nasdaq100", "gold"],
        )
        self.assertFalse(result["data"]["policy"]["currentFieldsMayUseArchiveFallback"])

    async def test_monitor_area_validation_rejects_guesses_conflicts_and_duplicates_without_network(self):
        request = AsyncMock()
        reader = PredictionMarketReader(request=request, now=lambda: self.NOW)

        unknown = await reader.snapshot(market_areas=["spx"])
        conflict = await reader.snapshot(series_tickers=["KXINXU"], market_areas=["sp500"])
        duplicate = await reader.snapshot(market_areas=["wti", "wti"])
        bundled_conflict = await reader.snapshot(
            market_areas=["sp500"],
            include_market_setups=True,
        )

        self.assertEqual(unknown["status"], "invalid_request")
        self.assertEqual(conflict["status"], "invalid_request")
        self.assertEqual(duplicate["status"], "invalid_request")
        self.assertEqual(bundled_conflict["status"], "invalid_request")
        request.assert_not_awaited()

    async def test_invalid_monitor_contract_is_failed_closed(self):
        async def request(_path):
            return {
                "reportType": "four_market_morning",
                "marketOrder": ["sp500", "wti"],
                "markets": [],
                "status": "available",
            }

        result = await PredictionMarketReader(request=request, now=lambda: self.NOW).snapshot(
            market_areas=["sp500", "wti", "nasdaq100", "gold"]
        )

        self.assertEqual(result["status"], "unavailable")
        self.assertFalse(result["liveVerified"])
        self.assertEqual(result["data"]["markets"], [])

    async def test_supported_ladder_keeps_native_contract_lines_and_strips_chart_history(self):
        watchlist = self.watchlist([self.row()])
        overview = {
            "ok": True,
            "markets": {
                "cpi": {
                    "status": "available",
                    "summary": {
                        "seriesTicker": "KXCPIYOY",
                        "eventTicker": "KXCPIYOY-26AUG",
                        "eventTitle": "CPI in August",
                        "closeTime": "2026-08-20T12:30:00Z",
                        "freshness": {
                            "status": "direct_snapshot",
                            "snapshotType": "direct_venue",
                            "fetchedAt": "2026-08-18T17:59:40Z",
                            "updatedAt": "2026-08-18T17:59:35Z",
                        },
                        "lines": [
                            {
                                "ticker": "KXCPIYOY-26AUG-T2.9",
                                "label": "Above 2.9%",
                                "sortValue": 2.9,
                                "yesBid": 0.41,
                                "yesAsk": 0.43,
                                "yesBidSize": 120,
                                "yesAskSize": 90,
                                "noBid": 0.56,
                                "noAsk": 0.58,
                                "noBidSize": 80,
                                "noAskSize": 70,
                                "volume24h": 1000,
                                "openInterest": 2200,
                            }
                        ],
                        "chart": {"points": [{"timestamp": 1, "value": 0.42}]},
                        "history": [{"price": 0.4}],
                    },
                },
                "spx": {"status": "unavailable", "summary": None},
                "wti": {},
            },
        }

        async def request(path):
            if path == "/api/prediction-markets/watchlist?forceRefresh=true":
                return watchlist
            if path == "/api/prediction-markets/overview?forceRefresh=true":
                return overview
            raise AssertionError(path)

        result = await PredictionMarketReader(request=request, now=lambda: self.NOW).snapshot(
            ["KXCPIYOY"], include_ladders=True
        )
        ladder = result["data"]["ladders"]["KXCPIYOY"]
        self.assertEqual(ladder["contracts"][0]["noBidSize"], 80)
        self.assertTrue(ladder["contracts"][0]["liveVerified"])
        self.assertEqual(ladder["contracts"][0]["usage"], "research_only")
        self.assertFalse(ladder["contracts"][0]["executable"])
        self.assertNotIn("chart", ladder)
        self.assertNotIn("history", ladder)


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
