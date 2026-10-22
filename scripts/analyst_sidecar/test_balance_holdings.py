"""Balance holdings are independently acquired without the portfolio quote fanout."""

import copy
from datetime import datetime, timezone
import unittest
from unittest.mock import MagicMock, patch

import httpx

import market
from market import IbkrReader, aclose_shared_clients


NOW = datetime(2026, 9, 18, 17, 0, tzinfo=timezone.utc)
OBSERVED = "2026-09-18T16:59:55Z"


def live_positions():
    return {
        "ok": True, "status": "live", "connected": True,
        "source": "ibkr_live_session", "from_cache": False,
        "accounts": ["U1"], "positions_observed_at": OBSERVED,
        "positions": [{"account": "U1", "symbol": "IGV", "conId": 123,
                       "secType": "STK", "exchange": "SMART", "currency": "USD",
                       "position": -10, "avgCost": 120, "marketValue": -1400}],
    }


def positions_failure(status, body=None):
    request = httpx.Request("GET", "http://127.0.0.1:8765/portfolio/live-positions")
    response = httpx.Response(status, json=body if body is not None else {}, request=request)
    return httpx.HTTPStatusError("Private positions failure", request=request, response=response)


class BalanceHoldingsTests(unittest.IsolatedAsyncioTestCase):
    async def read(self, payload=None, *, error=None):
        calls = []

        async def request(path, **_kwargs):
            calls.append(path)
            if path == "/portfolio/live-positions":
                if error is not None:
                    raise error
                return payload if payload is not None else live_positions()
            raise AssertionError(f"Holdings must not request status, quotes, or P/L: {path}")

        result = await IbkrReader(request=request, now=lambda: NOW).holdings_context()
        return result, calls

    async def test_fresh_broker_holdings_do_not_wait_for_or_invent_valuations(self):
        result, calls = await self.read()
        # The live-positions read and its payload gate are the only guard.
        self.assertEqual(calls, ["/portfolio/live-positions"])
        self.assertTrue(result["liveVerified"])
        self.assertEqual(result["asOf"], OBSERVED)
        self.assertEqual(result["data"]["positions"][0]["quantity"], -10)
        for key in ("marketValue", "price", "averageCost", "valuationPrice"):
            self.assertNotIn(key, result["data"]["positions"][0])

    async def test_verified_empty_book_is_available(self):
        payload = live_positions()
        payload["positions"] = []
        result, _calls = await self.read(payload)
        self.assertTrue(result["liveVerified"])
        self.assertEqual(result["data"]["positions"], [])

    async def test_disconnected_and_failed_refreshes_return_no_holdings(self):
        disconnected = {"ok": False, "connected": False, "status": "gateway_not_authenticated",
                        "error_code": "IBKR_GATEWAY_NOT_AUTHENTICATED", "source": "unavailable", "positions": []}
        for kwargs, expected in (
            ({"payload": disconnected}, "IBKR_HOLDINGS_UNVERIFIED"),
            ({"error": positions_failure(503, disconnected)}, "IBKR_HOLDINGS_SERVICE_UNAVAILABLE"),
            ({"error": TimeoutError("positions timed out")}, "IBKR_HOLDINGS_TIMEOUT"),
        ):
            with self.subTest(expected=expected):
                result, calls = await self.read(**kwargs)
                self.assertEqual(calls, ["/portfolio/live-positions"])
                self.assertFalse(result["liveVerified"])
                self.assertEqual(result["data"]["positions"], [])
                # Holdings never report the shared Gateway connection state.
                self.assertEqual(result["errorCode"], expected)

    async def test_service_failure_and_gateway_disconnection_have_distinct_diagnostics(self):
        for error, expected in (
            (ConnectionError("Private connection details"), "IBKR_HOLDINGS_SERVICE_UNAVAILABLE"),
            (OSError("Private connection details"), "IBKR_HOLDINGS_SERVICE_UNAVAILABLE"),
            (httpx.ConnectError("Private connection details"), "IBKR_HOLDINGS_SERVICE_UNAVAILABLE"),
            (httpx.RemoteProtocolError("Private connection details"), "IBKR_HOLDINGS_SERVICE_UNAVAILABLE"),
            (httpx.ReadTimeout("Private connection details"), "IBKR_HOLDINGS_TIMEOUT"),
            (positions_failure(503, {"error_code": "GATEWAY_UNAVAILABLE"}), "IBKR_HOLDINGS_SERVICE_UNAVAILABLE"),
            (positions_failure(503, {"error_code": "IBKR_POSITIONS_REQUEST_TIMEOUT"}), "IBKR_HOLDINGS_TIMEOUT"),
            (positions_failure(500, {"error_code": "IBKR_GATEWAY_NOT_AUTHENTICATED"}), "IBKR_HOLDINGS_REQUEST_FAILED"),
            (RuntimeError("Private connection details"), "IBKR_HOLDINGS_REQUEST_FAILED"),
        ):
            with self.subTest(error=type(error).__name__, expected=expected):
                result, _calls = await self.read(error=error)
                self.assertEqual(result["errorCode"], expected)
                self.assertFalse(result["errorCode"].startswith(("GATEWAY_", "IBKR_GATEWAY_")))
                self.assertEqual(result["data"]["positions"], [])
                self.assertNotIn("Private", str(result))

    async def test_shared_client_reads_live_positions_without_a_status_precheck(self):
        paths = []

        def handle(request):
            paths.append(request.url.path)
            if request.url.path != "/portfolio/live-positions":
                return httpx.Response(404, json={})
            if len(paths) == 1:
                return httpx.Response(200, json=live_positions())
            return httpx.Response(503, json={"ok": False, "connected": False, "error_code": "IBKR_GATEWAY_NOT_AUTHENTICATED"})

        transport = httpx.MockTransport(handle)
        self.addAsyncCleanup(aclose_shared_clients)
        reader = IbkrReader(base_url="http://ibkr.test", transport=transport, now=lambda: NOW)
        self.assertTrue((await reader.holdings_context())["liveVerified"])
        failed = await reader.holdings_context()
        self.assertEqual(failed["errorCode"], "IBKR_HOLDINGS_SERVICE_UNAVAILABLE")
        self.assertEqual(paths, ["/portfolio/live-positions", "/portfolio/live-positions"])

    async def test_patched_client_constructor_never_shares_a_client_with_real_reads(self):
        self.addAsyncCleanup(aclose_shared_clients)
        real = market._shared_client("http://ibkr.test")
        patched = MagicMock()
        with patch.object(market.httpx, "AsyncClient", return_value=patched):
            self.assertIs(market._shared_client("http://ibkr.test"), patched)
        self.assertIs(market._shared_client("http://ibkr.test"), real)
        # A patched client left in the pool cannot break shutdown.
        await aclose_shared_clients()
        self.assertTrue(real.is_closed)
        self.assertEqual(market._SHARED_CLIENTS, {})

    async def test_rejects_stale_cache_seed_mock_and_unverified_payloads_or_rows(self):
        changes = [
            {"stale": True}, {"fromCache": True}, {"cacheOnly": True},
            {"cached": True}, {"seeded": True}, {"mock": True}, {"synthetic": True},
            {"inferred": True}, {"fallback": True}, {"refreshFailed": True},
            {"connected": False}, {"status": "offline"}, {"freshness": "cache-only"},
            {"source": "cached"}, {"provider": "mock"}, {"metadata": {"mock": True}},
        ]
        for change in changes:
            for target in ("payload", "row"):
                with self.subTest(change=change, target=target):
                    payload = copy.deepcopy(live_positions())
                    (payload if target == "payload" else payload["positions"][0]).update(change)
                    result, _calls = await self.read(payload)
                    self.assertFalse(result["liveVerified"])
                    self.assertEqual(result["data"]["positions"], [])
                    self.assertEqual(result["errorCode"], "IBKR_HOLDINGS_UNVERIFIED")

    async def test_requires_provider_time_and_complete_valid_holdings(self):
        for change in (
            {"positions_observed_at": None}, {"positions_observed_at": "invalid"},
            {"positions_observed_at": "2026-09-18T16:58:59Z"},
            {"positions_observed_at": "2026-09-18T17:00:31Z"},
            {"from_cache": None}, {"accounts": []}, {"positions": None},
            {"positions": [{"account": "U2", "symbol": "IGV", "position": 10}]},
            {"positions": [{"account": "U1", "symbol": "IGV", "position": None}]},
        ):
            with self.subTest(change=change):
                result, _calls = await self.read({**live_positions(), **change})
                self.assertFalse(result["liveVerified"])
                self.assertEqual(result["data"]["positions"], [])


if __name__ == "__main__":
    unittest.main()
