import asyncio
import copy
import json
import unittest
from collections import Counter
from unittest.mock import AsyncMock, patch

import app


def official_contract(strike=28000, right="C", **changes):
    return {
        "publicContractId": f"FNQ_123199_{strike}",
        "contractId": f"FNQ_123199_{strike}",
        "releaseKey": "FNQ_123199", "productCode": "FNQ",
        "symbol": "NQ", "underlying": "NQ", "secType": "FOP",
        "exchange": "FORECASTX", "currency": "USD", "tradingClass": "FNQ",
        "lastTradeDateOrContractMonth": "20991231", "strike": strike,
        "right": right, "quote_side": "YES" if right == "C" else "NO",
        **changes,
    }


def request_for(contracts):
    return app.DiscoveryRequest(
        monitor=app.PredictionMonitorContext(
            marketId="nasdaq100", productCode="FNQ", generationKey="FNQ_123199",
            eventPrefix="FNQ_123199", closeTime="2099-12-31T20:00:00Z",
            targetStrikes=sorted({row["strike"] for row in contracts}),
        ),
        catalogContracts=contracts,
    )


def qualified_contract(requested):
    result = copy.copy(requested)
    result.conId = int(result.strike) * 2 + (result.right == "P")
    result.localSymbol = f"FNQ_123199_{int(result.strike)}_{'YES' if result.right == 'C' else 'NO'}"
    return result


class ForecastExQualificationTests(unittest.IsolatedAsyncioTestCase):
    async def test_retries_only_timeouts_and_retains_exact_failure_diagnostics(self):
        calls = Counter()
        requested_shapes = []

        class BrokerError(Exception):
            errorCode = 354

        class FakeIb:
            async def qualifyContractsAsync(self, requested):
                strike = int(requested.strike)
                calls[strike] += 1
                requested_shapes.append((strike, requested.symbol, requested.secType, requested.right))
                if strike == 28200 or (strike == 28100 and calls[strike] == 1):
                    await asyncio.sleep(1)
                if strike == 28300:
                    return []
                if strike == 28500:
                    raise BrokerError("internal diagnostic text")
                result = qualified_contract(requested)
                if strike == 28400:
                    result.currency = "EUR"
                return [result]

        contracts = [official_contract(strike) for strike in range(28000, 28600, 100)]
        contracts.append(official_contract(28600, symbol="FNQ", secType="OPT"))
        diagnostics = {}
        with patch.object(app, "ib", FakeIb()), patch.object(app, "DISCOVER_DETAILS_TIMEOUT_SEC", .01):
            result = await app.qualify_forecastx_public_contracts(request_for(contracts), diagnostics=diagnostics)

        self.assertEqual({row["strike"] for row in result}, {28000, 28100})
        self.assertEqual(calls, Counter({28000: 1, 28100: 2, 28200: 2, 28300: 1, 28400: 1, 28500: 1}))
        self.assertTrue(all(symbol == "NQ" and sec_type == "FOP" and right == "C"
                            for _, symbol, sec_type, right in requested_shapes))
        self.assertEqual(diagnostics["timedOutContractCount"], 2)
        self.assertEqual(diagnostics["retryCount"], 2)
        self.assertEqual(diagnostics["recoveredContractCount"], 1)
        self.assertEqual({row["errorCode"] for row in diagnostics["attempts"] if row["errorCode"]}, {
            "FORECASTEX_QUALIFICATION_TIMEOUT", "FORECASTEX_QUALIFICATION_NO_CONTRACT",
            "FORECASTEX_QUALIFICATION_IDENTITY_MISMATCH", "FORECASTEX_QUALIFICATION_REQUEST_FAILED",
            "FORECASTEX_QUALIFICATION_INVALID_METADATA",
        })
        error = next(row for row in diagnostics["attempts"] if row.get("brokerErrorCode"))
        self.assertEqual(error["brokerErrorCode"], 354)
        self.assertNotIn("internal diagnostic text", json.dumps(diagnostics))

    async def test_retry_waits_for_first_pass_and_preserves_semaphore_bound(self):
        calls = []

        class FakeIb:
            async def qualifyContractsAsync(self, requested):
                calls.append(int(requested.strike))
                if requested.strike == 28000 and calls.count(28000) == 1:
                    await asyncio.sleep(1)
                return [qualified_contract(requested)]

        with patch.object(app, "ib", FakeIb()), patch.object(app, "DISCOVER_DETAILS_TIMEOUT_SEC", .01):
            result = await app.qualify_forecastx_public_contracts(
                request_for([official_contract(), official_contract(28100)]), concurrency=1,
            )
        self.assertEqual(calls, [28000, 28100, 28000])
        self.assertEqual(len(result), 2)

    async def test_exhausted_retry_budget_does_not_send_more_broker_requests(self):
        qualify = AsyncMock(side_effect=asyncio.TimeoutError)
        diagnostics = {}
        with patch.object(app.ib, "qualifyContractsAsync", qualify), \
                patch.object(app, "FORECASTEX_QUALIFICATION_RETRY_BUDGET_SEC", 0):
            result = await app.qualify_forecastx_public_contracts(
                request_for([official_contract()]), diagnostics=diagnostics,
            )
        self.assertEqual(result, [])
        self.assertEqual(qualify.await_count, 1)
        self.assertEqual(diagnostics["retryCount"], 0)
        self.assertEqual(diagnostics["attempts"][-1]["errorCode"], "FORECASTEX_QUALIFICATION_RETRY_BUDGET_EXHAUSTED")

    async def test_retry_still_rejects_wrong_broker_identity(self):
        calls = 0

        class FakeIb:
            async def qualifyContractsAsync(self, requested):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise asyncio.TimeoutError()
                result = qualified_contract(requested)
                result.tradingClass = "FES"
                return [result]

        diagnostics = {}
        with patch.object(app, "ib", FakeIb()):
            result = await app.qualify_forecastx_public_contracts(request_for([official_contract()]), diagnostics=diagnostics)
        self.assertEqual(result, [])
        self.assertEqual(calls, 2)
        self.assertEqual(diagnostics["attempts"][-1]["errorCode"], "FORECASTEX_QUALIFICATION_IDENTITY_MISMATCH")

    async def test_request_cancellation_propagates_without_retry(self):
        started = asyncio.Event()
        calls = 0

        class FakeIb:
            async def qualifyContractsAsync(self, _requested):
                nonlocal calls
                calls += 1
                started.set()
                await asyncio.Event().wait()

        with patch.object(app, "ib", FakeIb()):
            task = asyncio.create_task(app.qualify_forecastx_public_contracts(request_for([official_contract()])))
            await started.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(calls, 1)

    async def test_discover_retains_diagnostics_without_promoting_failed_metadata(self):
        qualify = AsyncMock(side_effect=asyncio.TimeoutError)
        with patch.object(app, "ensure_connected", AsyncMock(return_value={"ok": True})), \
                patch.object(app.ib, "qualifyContractsAsync", qualify):
            response = await app.discover(request_for([official_contract()]))
        body = json.loads(response.body)
        self.assertEqual(body["catalog_contracts"], [])
        self.assertEqual(body["errorCode"], "FORECASTEX_QUALIFICATION_TIMEOUT")
        self.assertEqual(body["status"], "qualification_timeout")
        self.assertNotIn("entitled", body["message"])
        self.assertEqual(body["catalog_qualification"]["diagnostics"]["retryCount"], 1)
        self.assertEqual([row["errorCode"] for row in body["catalog_qualification"]["diagnostics"]["attempts"]],
                         ["FORECASTEX_QUALIFICATION_TIMEOUT"] * 2)


if __name__ == "__main__":
    unittest.main()
