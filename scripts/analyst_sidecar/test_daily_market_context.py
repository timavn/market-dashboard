"""Daily mover ranks keep their original complete group and informational status."""

import asyncio
from datetime import datetime, timedelta, timezone
import json
import unittest

import httpx

from daily_market_context import (
    BLOCKED_FLAGS, DAILY_MARKET_PATH, DailyMarketContextReader, project_daily_market,
)


NOW = datetime(2026, 9, 30, 18, 0, tzinfo=timezone.utc)


def daily_snapshot(observed=NOW):
    as_of = observed.isoformat()
    expires = (observed + timedelta(minutes=20)).isoformat()
    date = observed.date().isoformat()
    universe = {"label": "S&P 500 · SPY", "count": 503, "asOf": date}
    coverage = {"quotes": 503, "total": 503, "history200": 501}
    observation = {"asOf": as_of, "expiresAt": expires, "marketDate": date,
                   "quoteStatus": "delayed", "source": "Yahoo Finance",
                   "sourceUrl": "https://query1.finance.yahoo.com/chart/AAA",
                   "universe": universe, "coverage": coverage, "retained": False}
    def row(ticker, change):
        return {"ticker": ticker, "name": f"{ticker} Security", "changePercent": change,
                "asOf": as_of, "expiresAt": expires, "marketDate": date, "status": "delayed",
                "source": "Yahoo Finance", "sourceUrl": f"https://query1.finance.yahoo.com/chart/{ticker}",
                "delayedSource": True}
    return {"status": "partial", "asOf": as_of, "marketDate": date, "quoteStatus": "delayed",
            "universe": universe, "coverage": coverage, "displayOnly": True, "executable": False,
            "retained": False, "referenceObservations": {"movers": observation},
            "moverDetails": {"winners": [row("AAA", 4.2), row("BBB", 2.1)],
                             "losers": [row("CCC", -3.5), row("DDD", -1.1)]}}


class DailyMarketProjectionTests(unittest.TestCase):
    def test_preserves_published_order_and_provenance_without_executable_price_fields(self):
        payload = daily_snapshot()
        payload["moverDetails"]["winners"][0].update(price=123, bid=122, ask=124, raw="unused")
        result = project_daily_market(payload, NOW)
        self.assertEqual(result["status"], "available")
        self.assertFalse(result["liveVerified"])
        self.assertFalse(result["executable"])
        self.assertEqual(result["data"]["universe"], payload["universe"])
        self.assertEqual(result["data"]["coverage"], {"quotes": 503, "total": 503})
        self.assertEqual([row["ticker"] for row in result["data"]["winners"]], ["AAA", "BBB"])
        self.assertEqual(result["data"]["winners"][0]["changePercent"], 4.2)
        self.assertEqual(result["data"]["displayStatus"], "D")
        self.assertFalse(result["data"]["retained"])
        self.assertEqual(result["data"]["observation"]["asOf"], NOW.isoformat())
        for field in ("price", "bid", "ask", "raw", "history200"):
            self.assertNotIn(field, json.dumps(result))
        self.assertLess(len(json.dumps(result)), 6000)

    def test_expired_retained_reference_has_no_age_deadline_or_timestamp_refresh(self):
        old = NOW - timedelta(days=365)
        payload = daily_snapshot(old)
        payload.update(asOf=NOW.isoformat(), marketDate=NOW.date().isoformat(), retained=True)
        result = project_daily_market(payload, NOW)
        self.assertEqual(result["status"], "available")
        self.assertEqual(result["freshness"], "retained_verified_reference")
        self.assertEqual(result["asOf"], old.isoformat())
        self.assertEqual(result["data"]["observation"]["marketDate"], old.date().isoformat())
        self.assertTrue(result["data"]["retained"])
        for row in result["data"]["winners"] + result["data"]["losers"]:
            self.assertEqual(row["asOf"], old.isoformat())
            self.assertEqual(row["displayStatus"], "D")
            self.assertTrue(row["retained"])
            self.assertFalse(row["executable"])

    def test_independent_group_coverage_and_retention_survive_partial_newer_aggregate(self):
        payload = daily_snapshot()
        payload.update(coverage={"quotes": 100, "total": 503}, retained=True,
                       outliers={"mock": True}, incompleteReferenceGroups=["relativeVolume"])
        result = project_daily_market(payload, NOW)
        self.assertEqual(result["status"], "available")
        self.assertEqual(result["data"]["coverage"]["quotes"], 503)
        self.assertFalse(result["data"]["retained"])

    def test_incomplete_contaminated_unverified_or_mixed_session_rankings_are_unavailable(self):
        mutations = (
            lambda p: p["referenceObservations"]["movers"]["coverage"].update(quotes=502),
            lambda p: p.update(incompleteReferenceGroups=["movers"]),
            lambda p: p["referenceObservations"]["movers"]["universe"].update(label="Nasdaq 100"),
            lambda p: p["moverDetails"]["winners"][0].update(marketDate="2026-09-29"),
            lambda p: p["moverDetails"]["winners"][0].update(status="live"),
            lambda p: p["moverDetails"]["winners"][0].update(sourceUrl="http://example.com"),
            lambda p: p["moverDetails"]["winners"][0].update(asOf=(NOW + timedelta(seconds=6)).isoformat()),
            lambda p: p["moverDetails"]["winners"].reverse(),
            lambda p: p["moverDetails"]["losers"][0].update(ticker="AAA"),
            lambda p: p["moverDetails"]["winners"].append(None),
            lambda p: p.update(referenceObservations=[]),
            lambda p: p.update(displayOnly=False),
            lambda p: p.update(executable=True),
        )
        for mutate in mutations:
            payload = daily_snapshot()
            mutate(payload)
            result = project_daily_market(payload, NOW)
            self.assertEqual(result["status"], "unavailable", mutate)
            self.assertIsNone(result["data"])
        for flag in BLOCKED_FLAGS:
            for target in ("snapshot", "observation", "row"):
                payload = daily_snapshot()
                value = payload if target == "snapshot" else payload["referenceObservations"]["movers"] if target == "observation" else payload["moverDetails"]["winners"][0]
                value[flag] = True
                self.assertEqual(project_daily_market(payload, NOW)["status"], "unavailable", (flag, target))

    def test_last_close_is_dated_context_and_empty_side_is_not_invented(self):
        payload = daily_snapshot()
        payload["referenceObservations"]["movers"].update(quoteStatus="last-close")
        payload["moverDetails"]["losers"] = []
        for row in payload["moverDetails"]["winners"]:
            row["status"] = "last-close"
        result = project_daily_market(payload, NOW)
        self.assertEqual(result["data"]["displayStatus"], "LAST CLOSE")
        self.assertEqual(result["data"]["losers"], [])
        self.assertTrue(result["data"]["winners"][0]["delayedSource"])


class DailyMarketReaderTests(unittest.IsolatedAsyncioTestCase):
    async def test_reads_server_reference_each_turn_and_never_caches_after_transport_failure(self):
        requests = []
        def handler(request):
            requests.append(request)
            if len(requests) == 2:
                return httpx.Response(503, json={"status": "unavailable"})
            return httpx.Response(200, headers={"Cache-Control": "no-store"}, json=daily_snapshot(NOW - timedelta(days=40)))
        reader = DailyMarketContextReader("http://localhost:3001", client_factory=lambda **kwargs: httpx.AsyncClient(
            transport=httpx.MockTransport(handler), **kwargs))
        self.assertEqual((await reader.context())["status"], "available")
        failed = await reader.context()
        self.assertEqual(failed["status"], "unavailable")
        self.assertIsNone(failed["data"])
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0].url.path, DAILY_MARKET_PATH)
        self.assertEqual(requests[0].headers["Cache-Control"], "no-cache")

    async def test_rejects_cacheable_responses_and_bounds_transport_wait(self):
        reader = DailyMarketContextReader("http://localhost:3001", client_factory=lambda **kwargs: httpx.AsyncClient(
            transport=httpx.MockTransport(lambda request: httpx.Response(200, json=daily_snapshot())), **kwargs))
        self.assertEqual((await reader.context())["status"], "unavailable")
        async def never(request):
            await asyncio.sleep(30)
        reader = DailyMarketContextReader("http://localhost:3001", timeout=0.01, client_factory=lambda **kwargs: httpx.AsyncClient(
            transport=httpx.MockTransport(never), **kwargs))
        self.assertEqual((await reader.context())["status"], "unavailable")


if __name__ == "__main__":
    unittest.main()
