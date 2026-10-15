import asyncio
from concurrent.futures import ThreadPoolExecutor
import os
import threading
import time
import unittest
from unittest.mock import Mock, patch

import httpx

from alpha_codes import captured_alpha_codes
from prediction_research_reader import alpha_archive_scan_enabled, capture_prediction_research, read_prediction_research
from prediction_research_rollup import build_prediction_research_rollup
from test_prediction_alpha_integration import publication


class PredictionResearchReaderTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Every external publication reader is isolated in these acquisition tests.
        optional = patch("prediction_research_reader.read_hedgai_research", return_value={})
        optional.start()
        self.addCleanup(optional.stop)
        # These tests pin the indexed archive scan itself, which the user has
        # paused by default. Its paused behavior is pinned separately below.
        enabled = patch.dict(os.environ, {"ANALYST_ALPHA_ARCHIVE_SCAN_ENABLED": "true"})
        enabled.start()
        self.addCleanup(enabled.stop)

    async def test_archive_scan_survives_a_saturated_shared_history_worker_pool(self):
        loop = asyncio.get_running_loop()
        loop.set_default_executor(ThreadPoolExecutor(max_workers=1))
        release = threading.Event()
        busy = loop.run_in_executor(None, release.wait, 2)
        index = Mock()
        index.alpha_code_documents.return_value = []
        try:
            with patch("prediction_research_reader.read_prediction_research", return_value={"date": "2026-09-18"}):
                result = await capture_prediction_research("http://dashboard.test", "2026-09-18", research_index=index,
                    as_of="2026-09-19T17:00:00Z", timeout_seconds=.2)
            self.assertIn("alphaCodes", result)
            self.assertFalse(busy.done())
        finally:
            release.set()
            await busy

    async def test_capture_retains_alpha_when_daily_publications_time_out(self):
        index = Mock()
        index.alpha_code_documents.return_value = []

        async def slow_daily(*_args, **_kwargs):
            await asyncio.sleep(1)

        with patch("prediction_research_reader.read_prediction_research", side_effect=slow_daily):
            result = await capture_prediction_research("http://dashboard.test", "2026-09-18", research_index=index,
                as_of="2026-09-19T17:00:00Z", timeout_seconds=.02)
        self.assertEqual(result["date"], "2026-09-18")
        self.assertEqual(result["alphaCodes"]["version"], 1)
        self.assertEqual(result["alphaCodes"]["asOf"], "2026-09-19T17:00:00Z")
        self.assertNotIn("snapshots", result)

    async def test_capture_retains_daily_publications_when_index_fails_or_times_out(self):
        daily = {"date": "2026-09-18", "snapshots": {"early-look": {"date": "2026-09-18"}}}
        for failure in ("error", "timeout"):
            with self.subTest(failure=failure):
                index = Mock()
                if failure == "error":
                    index.alpha_code_documents.side_effect = RuntimeError("index unavailable")
                else:
                    def slow_index(*_args, **_kwargs):
                        time.sleep(.06)
                        return []
                    index.alpha_code_documents.side_effect = slow_index
                with patch("prediction_research_reader.read_prediction_research", return_value=daily):
                    result = await capture_prediction_research("http://dashboard.test", "2026-09-18", research_index=index,
                        as_of="2026-09-19T17:00:00Z", timeout_seconds=.02)
                self.assertEqual({key: value for key, value in result.items() if key != "hedgaiCapture"}, daily)
                self.assertEqual(result["hedgaiCapture"]["status"], "unavailable")
                self.assertIsNot(result, daily)

    async def test_capture_passes_same_cutoff_and_all_indexed_products_to_scan(self):
        index = Mock()
        documents = [{"product": "early-look"}, {"product": "macro-show"}, {"product": "the-call"}]
        index.alpha_code_documents.return_value = documents
        alpha = {"version": 1, "asOf": "2026-09-19T17:00:00Z", "codes": {"sp500": {"tradeLevel": 7651}}}
        transport = httpx.MockTransport(lambda _request: httpx.Response(404))
        with patch("prediction_research_reader.read_prediction_research", return_value={"date": "2026-09-18"}) as read, \
                patch("alpha_codes.scan_alpha_codes", return_value=alpha) as scan:
            result = await capture_prediction_research("http://dashboard.test", "2026-09-18", research_index=index,
                as_of="2026-09-19T17:00:00Z", transport=transport)
        index.alpha_code_documents.assert_called_once_with("2026-09-19", as_of="2026-09-19T17:00:00Z")
        scan.assert_called_once_with(documents, "2026-09-19", as_of="2026-09-19T17:00:00Z")
        read.assert_awaited_once_with("http://dashboard.test", "2026-09-18", transport=transport)
        self.assertEqual(result["alphaCodes"], alpha)

    async def test_capture_with_both_sources_failed_returns_only_original_requested_date(self):
        index = Mock()
        index.alpha_code_documents.side_effect = RuntimeError("private index error")
        with patch("prediction_research_reader.read_prediction_research", side_effect=RuntimeError("private source error")):
            result = await capture_prediction_research("http://dashboard.test", "2026-09-18", research_index=index,
                as_of="2026-09-19T17:00:00Z")
        self.assertEqual(result, {"date": "2026-09-18", "hedgaiCapture": {"attempted": True,
            "asOf": "2026-09-19T17:00:00Z", "status": "unavailable"}})

    async def test_legacy_crypto_quant_uses_actual_product_and_retains_separate_tracker_history(self):
        calls = []

        def handle(request):
            calls.append(str(request.url))
            if "/tldr/archive/" in request.url.path:
                return httpx.Response(200, json={"date": "2026-09-18", "snapshots": {}})
            if request.url.path.endswith("bitcoin-trend-tracker"):
                day = request.url.params.get("date") or "2026-09-18"
                product = "bitcoin-trend-tracker" if day == "2026-09-16" else "crypto-quant"
                return httpx.Response(200, json={"snapshotType": "bitcoin-trend-tracker", "reportType": product,
                    "date": day, "publishedAt": day + "T12:06:00Z", "data": {"cryptos": {"BTC": {"trend": "BULLISH"}}}})
            return httpx.Response(404)

        result = await read_prediction_research("http://dashboard.test", "2026-09-18", transport=httpx.MockTransport(handle))
        crypto = result["snapshots"]["crypto-quant"]
        self.assertEqual(crypto["snapshotType"], "crypto-quant")
        self.assertEqual(crypto["storageSnapshotType"], "bitcoin-trend-tracker")
        self.assertEqual(crypto["date"], "2026-09-18")
        self.assertEqual(result["previousSnapshots"]["crypto-quant"]["date"], "2026-09-17")
        self.assertEqual(result["snapshots"]["bitcoin-trend-tracker"]["date"], "2026-09-16")
        self.assertEqual(len(calls), 12)

    async def test_legacy_and_direct_crypto_publications_are_deduplicated_by_publication_date(self):
        def handle(request):
            if "/tldr/archive/" in request.url.path:
                return httpx.Response(200, json={"date": "2026-09-18", "snapshots": {}})
            product = request.url.path.rsplit("/", 1)[-1]
            if product in {"crypto-quant", "bitcoin-trend-tracker"}:
                day = request.url.params.get("date") or ("2026-09-17" if product == "crypto-quant" else "2026-09-18")
                return httpx.Response(200, json={"snapshotType": product, "reportType": "crypto-quant",
                                               "date": day, "data": {}})
            return httpx.Response(404)

        result = await read_prediction_research("http://dashboard.test", "2026-09-18", transport=httpx.MockTransport(handle))
        self.assertEqual(set(result["snapshots"]), {"crypto-quant"})
        self.assertEqual(result["snapshots"]["crypto-quant"]["date"], "2026-09-18")
        self.assertEqual(result["previousSnapshots"]["crypto-quant"]["date"], "2026-09-17")

    async def test_captures_daily_and_less_frequent_products_with_original_dates(self):
        calls = []

        def handle(request):
            calls.append(str(request.url))
            path = request.url.path
            if "/tldr/archive/" in path:
                return httpx.Response(200, json={"date": "2026-09-18", "snapshots": {}})
            product = path.rsplit("/", 1)[-1]
            day = request.url.params.get("date") or ("2026-09-16" if product == "inflation-nowcast" else "2026-09-18")
            return httpx.Response(200, json={"snapshotType": product, "date": day, "data": {}})

        result = await read_prediction_research("http://dashboard.test", "2026-09-18", transport=httpx.MockTransport(handle))
        self.assertEqual(result["snapshots"]["inflation-nowcast"]["date"], "2026-09-16")
        self.assertEqual(result["snapshots"]["bitcoin-trend-tracker"]["date"], "2026-09-18")
        self.assertEqual(result["previousSnapshots"]["bitcoin-trend-tracker"]["date"], "2026-09-17")
        self.assertEqual(len(calls), 7)
        self.assertTrue(any("/tldr/archive/2026-09-18" in url for url in calls))

    async def test_future_wrong_product_and_failed_reads_never_replace_verified_sibling(self):
        def handle(request):
            path = request.url.path
            if "bitcoin-trend-tracker" in path:
                return httpx.Response(200, json={"snapshotType": "bitcoin-trend-tracker", "date": "2026-09-20"})
            if "crypto-quant" in path:
                return httpx.Response(200, json={"snapshotType": "risk-ranges", "date": "2026-09-18"})
            if "inflation-nowcast" in path:
                return httpx.Response(200, json={"snapshotType": "inflation-nowcast", "date": "2026-09-16"})
            return httpx.Response(503)

        result = await read_prediction_research("http://dashboard.test", "2026-09-18", transport=httpx.MockTransport(handle))
        self.assertEqual(set(result["snapshots"]), {"inflation-nowcast"})
        self.assertEqual(result["previousSnapshots"], {})

    async def test_market_volume_is_captured_only_for_the_explicit_review_date(self):
        for volume_day in ("2026-09-18", "2026-09-17", "2026-09-21", None):
            with self.subTest(volume_day=volume_day):
                source = {"asOf": volume_day, "meta": {"provider": "Cboe", "fetchedAt": "2026-09-19T12:00:00Z"}}

                def handle(request):
                    if request.url.path == "/api/volume/market-share":
                        self.assertEqual(request.url.params.get("days"), "25")
                        return httpx.Response(200, json=source)
                    return httpx.Response(404)

                result = await read_prediction_research("http://dashboard.test", "2026-09-18", transport=httpx.MockTransport(handle))
                self.assertEqual(result["marketVolume"], source if volume_day == "2026-09-18" else {})

    async def test_volume_failure_does_not_erase_independent_research(self):
        def handle(request):
            if request.url.path == "/api/volume/market-share":
                raise httpx.ReadTimeout("volume timed out", request=request)
            if request.url.path.endswith("inflation-nowcast"):
                return httpx.Response(200, json={"snapshotType": "inflation-nowcast", "date": "2026-09-16"})
            return httpx.Response(404)

        result = await read_prediction_research("http://dashboard.test", "2026-09-18", transport=httpx.MockTransport(handle))
        self.assertEqual(result["marketVolume"], {})
        self.assertEqual(result["snapshots"]["inflation-nowcast"]["date"], "2026-09-16")


class PausedAlphaArchiveScanTests(unittest.IsolatedAsyncioTestCase):
    CUTOFF = "2026-09-19T17:00:00Z"

    def setUp(self):
        optional = patch("prediction_research_reader.read_hedgai_research", return_value={})
        optional.start()
        self.addCleanup(optional.stop)
        environment = patch.dict(os.environ)
        environment.start()
        self.addCleanup(environment.stop)
        os.environ.pop("ANALYST_ALPHA_ARCHIVE_SCAN_ENABLED", None)

    def daily(self):
        # The captured publications carry their own complete Trade/Trend pair.
        return {"date": "2026-09-18", "snapshots": {"early-look": publication("2026-09-18", "SPX Trade 7,688 and Trend 7,540.")},
                "previousSnapshots": {"early-look": publication("2026-09-17", "SPX Trade 7,651 and Trend 7,501.")}}

    def test_archive_scan_is_paused_unless_explicitly_enabled(self):
        self.assertFalse(alpha_archive_scan_enabled())
        for value, enabled in (("false", False), ("0", False), ("yes", False), ("true", True), ("TRUE", True)):
            with self.subTest(value=value), patch.dict(os.environ, {"ANALYST_ALPHA_ARCHIVE_SCAN_ENABLED": value}):
                self.assertEqual(alpha_archive_scan_enabled(), enabled)

    async def test_paused_scan_does_no_index_or_executor_work_and_records_pending(self):
        index = Mock()
        executor = Mock()
        daily = self.daily()
        with patch("prediction_research_reader.read_prediction_research", return_value=daily), \
                patch("prediction_research_reader.ALPHA_SCAN_EXECUTOR", executor), \
                patch("alpha_codes.scan_alpha_codes") as scan:
            result = await capture_prediction_research("http://dashboard.test", "2026-09-18", research_index=index,
                as_of=self.CUTOFF, timeout_seconds=.2)
        index.alpha_code_documents.assert_not_called()
        executor.submit.assert_not_called()
        scan.assert_not_called()
        self.assertNotIn("alphaCodes", result)
        self.assertEqual(result["alphaCodesCapture"], {"status": "pending", "reason": "paused"})
        self.assertEqual({key: value for key, value in result.items() if key not in {"hedgaiCapture", "alphaCodesCapture"}}, daily)

    async def test_paused_scan_projects_exactly_like_a_timed_out_scan(self):
        def slow_index(*_args, **_kwargs):
            time.sleep(.06)
            return []

        timed_out_index = Mock()
        timed_out_index.alpha_code_documents.side_effect = slow_index
        with patch("prediction_research_reader.read_prediction_research", return_value=self.daily()), \
                patch.dict(os.environ, {"ANALYST_ALPHA_ARCHIVE_SCAN_ENABLED": "true"}):
            timed_out = await capture_prediction_research("http://dashboard.test", "2026-09-18",
                research_index=timed_out_index, as_of=self.CUTOFF, timeout_seconds=.02)
        with patch("prediction_research_reader.read_prediction_research", return_value=self.daily()):
            paused = await capture_prediction_research("http://dashboard.test", "2026-09-18",
                research_index=Mock(), as_of=self.CUTOFF, timeout_seconds=.02)
        self.assertNotIn("alphaCodes", timed_out)
        self.assertNotIn("alphaCodesCapture", timed_out)
        self.assertEqual({key: value for key, value in paused.items() if key != "alphaCodesCapture"}, timed_out)
        # Report thresholds still come from the captured publications.
        alpha = captured_alpha_codes(paused, as_of=self.CUTOFF)
        self.assertEqual(alpha, captured_alpha_codes(timed_out, as_of=self.CUTOFF))
        self.assertEqual((alpha["codes"]["sp500"]["tradeLevel"], alpha["codes"]["sp500"]["trendLevel"]), (7688, 7540))
        rollup = build_prediction_research_rollup(paused, as_of=self.CUTOFF)
        self.assertEqual(rollup, build_prediction_research_rollup(timed_out, as_of=self.CUTOFF))
        self.assertEqual(rollup["markets"]["sp500"]["alphaCode"]["publicationDate"], "2026-09-18")


if __name__ == "__main__":
    unittest.main()
