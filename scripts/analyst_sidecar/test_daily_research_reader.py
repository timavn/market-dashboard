import unittest

import httpx

from daily_research_reader import read_daily_research


class DailyResearchReaderTests(unittest.IsolatedAsyncioTestCase):
    async def test_captures_raw_articles_previous_publications_and_separate_structure(self):
        paths = []
        snapshot = {"date": "2026-09-18", "article": {"bodyText": "Full source text", "feedUrl": "https://app.hedgeye.com/feed/123"}}
        def handle(request):
            paths.append(request.url.raw_path.decode())
            return httpx.Response(200, json={"date": "2026-09-18", "snapshots": {"the-call": snapshot},
                                           "previousSnapshots": {"the-call": {"date": "2026-09-17"}}}
                                  if "/tldr/" in request.url.path else snapshot)
        result = await read_daily_research("http://dashboard.test", "2026-09-18", transport=httpx.MockTransport(handle))
        self.assertEqual(result["snapshots"]["the-call"], snapshot)
        self.assertEqual(result["marketStructure"], snapshot)
        self.assertEqual(result["previousSnapshots"]["the-call"]["date"], "2026-09-17")
        self.assertEqual(set(paths), {"/api/hedgeye/tldr/archive/2026-09-18", "/api/hedgeye/snapshot/market-structure?date=2026-09-18"})

    async def test_independent_failure_keeps_available_research_without_latest_fallback(self):
        def handle(request):
            return httpx.Response(503) if "/tldr/" in request.url.path else httpx.Response(200, json={"date": "2026-09-18", "data": {"signals": []}})
        result = await read_daily_research("http://dashboard.test", "2026-09-18", transport=httpx.MockTransport(handle))
        self.assertEqual(result["snapshots"], {})
        self.assertEqual(result["marketStructure"]["date"], "2026-09-18")
        self.assertEqual(result["acquisitionDiagnostics"]["dailyArchive"]["code"], "RESEARCH_ARCHIVE_UNAVAILABLE")

    async def test_wrong_date_and_non_object_responses_are_unavailable(self):
        result = await read_daily_research("http://dashboard.test", "2026-09-18", transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json={"date": "2026-09-19", "snapshots": {"the-call": {}}} if "/tldr/" in request.url.path else [])))
        self.assertEqual(result, {"date": "2026-09-18", "snapshots": {}, "previousSnapshots": {}, "marketStructure": {},
                                 "acquisitionDiagnostics": {"dailyArchive": {"code": "RESEARCH_ARCHIVE_DATE_MISMATCH", "retryable": False},
                                                            "marketStructure": {"code": "RESEARCH_STRUCTURE_INVALID_RESPONSE", "retryable": False}}})

    async def test_archive_failures_retain_typed_cause_without_provider_text_or_erasing_structure(self):
        for failure, code in (("timeout", "RESEARCH_ARCHIVE_TIMEOUT"), ("offline", "RESEARCH_ARCHIVE_UNAVAILABLE"),
                              ("non-object", "RESEARCH_ARCHIVE_INVALID_RESPONSE"), ("json", "RESEARCH_ARCHIVE_INVALID_RESPONSE")):
            with self.subTest(failure=failure):
                def handle(request):
                    if "/tldr/" not in request.url.path:
                        return httpx.Response(200, json={"date": "2026-09-18", "data": {"signals": ["independent"]}})
                    if failure == "timeout":
                        raise httpx.ReadTimeout("private provider detail", request=request)
                    if failure == "offline":
                        raise httpx.ConnectError("private provider detail", request=request)
                    return httpx.Response(200, json=[]) if failure == "non-object" else httpx.Response(200, text="private invalid body")
                result = await read_daily_research("http://dashboard.test", "2026-09-18", transport=httpx.MockTransport(handle))
                self.assertEqual(result["acquisitionDiagnostics"], {"dailyArchive": {"code": code, "retryable": failure in {"timeout", "offline"}}})
                self.assertEqual(result["marketStructure"]["data"]["signals"], ["independent"])
                self.assertNotIn("private", str(result))

    async def test_genuinely_empty_or_absent_edition_is_not_an_acquisition_failure(self):
        for status in (200, 404):
            result = await read_daily_research("http://dashboard.test", "2026-09-18", transport=httpx.MockTransport(
                lambda request: httpx.Response(status, json={"date": "2026-09-18", "snapshots": {}, "previousSnapshots": {}})))
            self.assertEqual(result["snapshots"], {})
            self.assertNotIn("acquisitionDiagnostics", result)

    async def test_http_failure_diagnostics_distinguish_transient_delivery_from_permanent_rejection(self):
        for status in (403, 410, 500, 503):
            with self.subTest(status=status):
                result = await read_daily_research("http://dashboard.test", "2026-09-18", transport=httpx.MockTransport(
                    lambda request: httpx.Response(status)))
                for name in ("dailyArchive", "marketStructure"):
                    self.assertEqual(result["acquisitionDiagnostics"][name]["statusCode"], status)
                    self.assertEqual(result["acquisitionDiagnostics"][name]["retryable"], status >= 500)
