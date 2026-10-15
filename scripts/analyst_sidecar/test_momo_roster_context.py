"""Current dashboard roster is context, never a cached job result or a quote source."""

import asyncio
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import unittest
from zoneinfo import ZoneInfo

import httpx

from momo_roster_context import BLOCKED_FLAGS, MomoRosterContextReader, ROSTER_PATH, project_momo_roster


TOP_TEN = ["NVDA", "AAPL", "GOOGL", "MSFT", "AMZN", "META", "AVGO", "TSLA", "BRK.B", "LLY"]


def roster(now=None):
    now = now or datetime.now(timezone.utc)
    day = now.astimezone(ZoneInfo("America/New_York")).date().isoformat()
    return {"schemaVersion": "MomoRosterContextV1", "date": day, "status": "available",
            "classification": "dated_supporting_context", "liveVerified": False, "source": ROSTER_PATH,
            "asOf": now.isoformat(), "freshness": "current_roster", "data": {
                "topTenTickers": TOP_TEN, "momoAdditionalTickers": ["NFLX", "SNOW"],
                "tickerOrder": TOP_TEN + ["NFLX", "SNOW"], "momoStatus": "available",
                "momoPublicationDate": day, "ranking": "company-market-cap", "sources": {
                    "membership": {"provider": "State Street", "sourceUrl": "https://www.ssga.com/holdings.xlsx", "asOf": day},
                    "ranking": {"provider": "Nasdaq", "sourceUrl": "https://api.nasdaq.com/api/screener/stocks", "retrievedAt": now.isoformat()},
                    "momo": {"provider": "Hedgeye", "product": "MOMO Tracker", "publicationDate": day},
                }}}


class MomoRosterProjectionTests(unittest.TestCase):
    def test_projects_current_order_and_provenance_without_prices_ranges_or_raw_source(self):
        now = datetime.now(timezone.utc)
        payload = roster(now)
        payload["quote"] = {"price": 999.99}
        payload["data"]["momoSnapshot"] = {"buyTrade": 101}
        result = project_momo_roster(payload, now)
        self.assertEqual(result["status"], "available")
        self.assertFalse(result["liveVerified"])
        self.assertEqual(result["freshness"], "current_roster")
        self.assertEqual(result["data"]["topTenTickers"], TOP_TEN)
        self.assertEqual(result["data"]["momoAdditionalTickers"], ["NFLX", "SNOW"])
        self.assertEqual(result["data"]["tickerOrder"], TOP_TEN + ["NFLX", "SNOW"])
        self.assertEqual(result["data"]["sources"]["ranking"]["provider"], "Nasdaq")
        self.assertEqual(result["data"]["sources"]["membership"]["provider"], "State Street")
        self.assertEqual(result["data"]["sources"]["momo"]["provider"], "Hedgeye")
        encoded = json.dumps(result)
        for prohibited in ("999.99", "marketCap", "buyTrade", "sellTrade", "BULLISH", "momoSnapshot", "quote"):
            self.assertNotIn(prohibited, encoded)
        self.assertLess(len(encoded), 2500)

    def test_pending_projection_keeps_verified_top_ten_without_additions(self):
        payload = roster()
        payload["status"] = "partial"
        payload["data"].update(momoStatus="pending", momoPublicationDate=None,
                               momoAdditionalTickers=[], tickerOrder=TOP_TEN)
        result = project_momo_roster(payload)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["data"]["momoStatus"], "pending")
        self.assertEqual(result["data"]["topTenTickers"], TOP_TEN)
        self.assertEqual(result["data"]["momoAdditionalTickers"], [])

    def test_stale_future_and_flagged_server_projection_is_unavailable(self):
        now = datetime.now(timezone.utc)
        for age in (timedelta(minutes=21), timedelta(seconds=-6)):
            result = project_momo_roster(roster(now - age), now)
            self.assertEqual(result["status"], "unavailable")
            self.assertIsNone(result["data"])
        for flag in BLOCKED_FLAGS:
            payload = roster(now)
            payload[flag] = True
            self.assertEqual(project_momo_roster(payload, now)["status"], "unavailable", flag)

    def test_rejects_raw_snapshot_stored_job_output_and_wrong_projection_identity(self):
        for payload in ({"status": "ready", "top10Tickers": TOP_TEN},
                        {"status": "available", "rows": [{"ticker": "NVDA", "quote": {"price": 999.99}}]}):
            self.assertEqual(project_momo_roster(payload)["status"], "unavailable")
        for mutate in (lambda p: p.update(schemaVersion="unknown"),
                       lambda p: p.update(date="2001-01-01"),
                       lambda p: p.update(liveVerified=True),
                       lambda p: p["data"]["sources"]["ranking"].update(sourceUrl="https://nasdaq.com.evil.example/data")):
            payload = roster()
            mutate(payload)
            self.assertEqual(project_momo_roster(payload)["status"], "unavailable")

    def test_rejects_inconsistent_or_duplicate_projected_lists(self):
        for mutate in (lambda p: p["data"].update(tickerOrder=TOP_TEN),
                       lambda p: p["data"].update(momoAdditionalTickers=["NVDA"], tickerOrder=TOP_TEN+["NVDA"]),
                       lambda p: p["data"].update(momoStatus="pending"),
                       lambda p: p["data"].update(momoPublicationDate="2001-01-01")):
            payload = deepcopy(roster())
            mutate(payload)
            self.assertEqual(project_momo_roster(payload)["status"], "unavailable")


class MomoRosterReaderTests(unittest.IsolatedAsyncioTestCase):
    async def test_fetches_fresh_each_time_and_clears_after_failure(self):
        requests = []
        def handler(request):
            requests.append(request)
            if len(requests) == 2:
                return httpx.Response(503, json={"status": "unavailable"})
            return httpx.Response(200, headers={"Cache-Control": "no-store"}, json=roster())
        reader = MomoRosterContextReader("http://localhost:3001", client_factory=lambda **kwargs: httpx.AsyncClient(
            transport=httpx.MockTransport(handler), **kwargs))
        first = await reader.context()
        self.assertEqual(first["status"], "available")
        second = await reader.context()
        self.assertEqual(second["status"], "unavailable")
        self.assertIsNone(second["data"])
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0].url.path, "/api/market/sp500-contributors")
        self.assertEqual(requests[0].url.params["context"], "analyst")
        self.assertEqual(requests[0].headers["Cache-Control"], "no-cache")

    async def test_rejects_cacheable_response_and_bounds_silent_transport(self):
        reader = MomoRosterContextReader("http://localhost:3001", client_factory=lambda **kwargs: httpx.AsyncClient(
            transport=httpx.MockTransport(lambda request: httpx.Response(200, json=roster())), **kwargs))
        self.assertEqual((await reader.context())["status"], "unavailable")
        async def never(request):
            await asyncio.sleep(30)
        reader = MomoRosterContextReader("http://localhost:3001", timeout=0.01,
                                        client_factory=lambda **kwargs: httpx.AsyncClient(
                                            transport=httpx.MockTransport(never), **kwargs))
        self.assertEqual((await reader.context())["status"], "unavailable")


if __name__ == "__main__":
    unittest.main()
