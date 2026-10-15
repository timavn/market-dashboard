import asyncio
import copy
from datetime import date, timedelta
import json
from pathlib import Path
import subprocess
import time as wall_time
import unittest
from unittest.mock import patch

import httpx

from portfolio_pca_review import build_portfolio_pca_section, read_portfolio_pca_review


AS_OF = "2026-09-19T18:00:00Z"
HEADERS = {"Cache-Control": "no-store", "X-Data-Use": "historical-research-only"}


def snapshot():
    days = []
    day = date(2026, 9, 18)
    while len(days) < 63:
        if day.weekday() < 5:
            days.insert(0, day.isoformat())
        day -= timedelta(days=1)
    config = {"window": 63, "warnThreshold": .35, "highThreshold": .5}
    components = [{"id": f"PC{i}", "rank": i, "label": label, "riskShare": share, "status": "ok"}
                  for i, label, share in [(1, "Equities / Credit", .2), (2, "Rates", .3)]]
    return {
        "id": "a" * 64, "source": "pca_saved_snapshot", "status": "available",
        "accountId": "account-a", "asOf": "2026-09-18", "sessionDate": "2026-09-18",
        "generatedAt": "2026-09-18T23:53:05Z", "historicalOnly": True, "executable": False,
        "modelVersion": "holdings-correlation-pca-v1", "config": config,
        "provenance": {
            "holdingsObservedAt": "2026-09-18T23:52:58Z", "navObservedAt": "2026-09-18T23:52:58Z",
            "socketVerifiedAt": "2026-09-18T23:52:57Z", "capturedAt": "2026-09-18T23:53:01Z",
            "sessionDate": "2026-09-18", "currency": "USD", "historicalOnly": True, "executable": False,
            "valuationBasis": "current signed broker quantities × official session close / current broker NAV",
            "catalogVersion": "pca-macro-references-v1", "historyCount": 3,
            "sources": ["yahoo", "fred"], "inputHash": "b" * 64,
        },
        "coverage": {"scope": "equities-etfs", "holdingCount": 2, "modeledCount": 2,
                     "excluded": [], "outOfScope": [], "modeledGrossWeight": .4, "complete": True},
        "model": {"modelVersion": "holdings-correlation-pca-v1", "dates": days, "config": config,
                  "holdings": [{"id": "ABC", "symbol": "ABC", "weight": .3},
                               {"id": "XYZ", "symbol": "XYZ", "weight": -.1}],
                  "components": components, "otherComponents": [],
                  "summary": {"annualizedVolatility": .08, "dailyVariance": .0001,
                              "topFiveRiskShare": .5, "residualRiskShare": .5, "maxRiskShare": .3}},
    }


def envelope(source=None):
    source = source or snapshot()
    return {"status": source["status"], "historicalOnly": True, "executable": False,
            "snapshot": {key: value for key, value in source.items()
                         if key not in {"source", "status", "asOf", "modelVersion"}}}


def section(source=None, **kwargs):
    return build_portfolio_pca_section(source or snapshot(), {"accountIds": ["account-a"]}, AS_OF, **kwargs)


class PortfolioPcaSectionTests(unittest.TestCase):
    def test_saved_model_is_dated_research_and_uses_only_native_metrics(self):
        source = snapshot()
        before = copy.deepcopy(source)
        result = section(source)
        self.assertEqual(result["id"], "pca-risk")
        self.assertEqual(result["title"], "PCA risk")
        self.assertEqual(result["asOf"], "2026-09-18")
        self.assertEqual(result["portfolioObservedAt"], source["provenance"]["holdingsObservedAt"])
        self.assertEqual(result["provenance"], source["provenance"])
        self.assertIn("Portfolio captured Sep 18, 2026", result["blocks"][0]["text"])
        self.assertIn("63-session model through Sep 18, 2026", result["blocks"][0]["text"])
        self.assertIn("2/2 stocks & ETFs modeled", result["blocks"][0]["text"])
        self.assertIn("8.0%", result["blocks"][1]["text"])
        self.assertIn("First five PCs: 50.0%", result["blocks"][1]["text"])
        self.assertEqual(result["blocks"][2]["rows"][0]["cells"], ["PC2", "Rates", "30.0%"])
        for invented in ("effective bets", "top three", "bullish", "bearish", "allocation", "current risk"):
            self.assertNotIn(invented, json.dumps(result["blocks"]).lower())
        self.assertEqual(source, before)

    def test_partial_scope_is_preserved_without_inventing_whole_portfolio_risk(self):
        source = snapshot()
        source["status"] = "partial"
        source["coverage"].update(holdingCount=3, complete=False,
                                  excluded=[{"id": "OTHER", "symbol": "OTHER", "reason": "official_close_unavailable"}],
                                  outOfScope=[{"id": "EVENT", "symbol": "EVENT", "reason": "prediction_contract"}])
        result = section(source)
        self.assertIn("2/3 stocks & ETFs modeled", result["blocks"][0]["text"])
        self.assertEqual(result["coverage"], source["coverage"])
        self.assertIn("Modeled annualized volatility", result["blocks"][1]["text"])
        self.assertNotIn("official_close_unavailable", json.dumps(result["blocks"]))

    def test_historical_capture_survives_newer_different_or_incomplete_current_book(self):
        metrics = {"accountIds": ["account-a"], "observedAt": AS_OF, "positions": [], "available": False}
        self.assertIsNotNone(build_portfolio_pca_section(snapshot(), metrics, AS_OF))
        for accounts in ([], ["other-account"], ["account-a", "other-account"], None):
            self.assertIsNone(build_portfolio_pca_section(snapshot(), {"accountIds": accounts}, AS_OF))

    def test_unsafe_capture_flags_are_rejected_at_every_preserved_level(self):
        for flags in ({"offline": True}, {"connected": False}, {"stale": True}, {"cacheOnly": True},
                      {"fromCache": True}, {"mock": True}, {"isMock": True}, {"seeded": True},
                      {"isSeed": True}, {"status": "cached"}, {"provider": "mock-yahoo"},
                      {"actionable": True}, {"executable": True}):
            for location in ("snapshot", "provenance", "holding", "component"):
                with self.subTest(flags=flags, location=location):
                    source = snapshot()
                    target = (source if location == "snapshot" else source["provenance"] if location == "provenance"
                              else source["model"]["holdings"][0] if location == "holding" else source["model"]["components"][0])
                    target.update(flags)
                    self.assertIsNone(section(source))

    def test_identity_scope_and_provenance_are_required(self):
        changes = [
            lambda s: s.update(source="exposure_lab", modelVersion="exposure-lab-ridge-v2"),
            lambda s: s.update(historicalOnly=False),
            lambda s: s.update(status="unavailable"),
            lambda s: s.update(id="unknown"),
            lambda s: s["provenance"].update(sources=[]),
            lambda s: s["provenance"].update(inputHash=None),
            lambda s: s["provenance"].update(valuationBasis="last price"),
            lambda s: s["provenance"].update(catalogVersion="unknown"),
            lambda s: s["coverage"].update(scope="all-instruments"),
            lambda s: s["coverage"].update(modeledCount=1),
            lambda s: s["coverage"].update(holdingCount=3),
            lambda s: s["model"]["holdings"].append(s["model"]["holdings"][0]),
        ]
        for change in changes:
            source = snapshot()
            change(source)
            self.assertIsNone(section(source))

    def test_future_or_inconsistent_dates_and_capture_provenance_fail_closed(self):
        for key, value in (("sessionDate", "2026-09-21"), ("sessionDate", "2026-02-30"),
                           ("generatedAt", "2026-09-20T12:00:00Z"), ("generatedAt", None)):
            self.assertIsNone(section({**snapshot(), key: value}))
        for key, value in (("capturedAt", "2026-09-19T23:53:01Z"), ("socketVerifiedAt", None),
                           ("holdingsObservedAt", "2026-09-18T22:00:00Z"), ("navObservedAt", "2026-09-18T23:59:00Z")):
            source = snapshot()
            source["provenance"][key] = value
            self.assertIsNone(section(source))
        source = snapshot()
        source["model"]["dates"][-1] = source["model"]["dates"][-2]
        self.assertIsNone(section(source))
        self.assertIsNone(build_portfolio_pca_section(snapshot(), {"accountIds": ["account-a"]}, "bad date"))

    def test_malformed_model_values_are_withheld(self):
        for value in (None, True, "0.08", float("nan"), float("inf"), -.1):
            source = snapshot()
            source["model"]["summary"]["annualizedVolatility"] = value
            self.assertIsNone(section(source))
        for value in (None, 2, -.1, "30%", True):
            source = snapshot()
            source["model"]["components"][0]["riskShare"] = value
            self.assertIsNone(section(source))
        for field in ("model", "coverage", "provenance"):
            self.assertIsNone(section({**snapshot(), field: []}))

    def test_accepts_production_model_serialization(self):
        # Generated data is confined to this regression test; the runtime
        # reader uses only the existing saved PCA service endpoint.
        script = """
const { buildPcaModel } = require('./src/services/pca/pcaModel.cjs');
const input = JSON.parse(process.argv[1]);
process.stdout.write(JSON.stringify(buildPcaModel({dates: input.dates, config: input.config,
  assets: [{id:'ABC',symbol:'ABC',weight:.3,returns:input.dates.map((_,i)=>Math.sin(i/7)*.01)},
           {id:'XYZ',symbol:'XYZ',weight:-.1,returns:input.dates.map((_,i)=>Math.cos(i/11)*.008)}]})));
"""
        source = snapshot()
        process = subprocess.run(["node", "-e", script, json.dumps(source["model"])],
                                 cwd=Path(__file__).resolve().parents[2], check=True,
                                 capture_output=True, text=True, timeout=15)
        model = json.loads(process.stdout)
        model.pop("fit")
        source["model"] = model
        result = section(source)
        self.assertIsNotNone(result)
        self.assertIn(f"{model['summary']['annualizedVolatility'] * 100:.1f}%", result["blocks"][1]["text"])


class PortfolioPcaReaderTests(unittest.IsolatedAsyncioTestCase):
    async def test_transient_delivery_failure_settles_without_retrying_or_building_a_model(self):
        requests = []
        diagnostics = {}

        def respond(request):
            requests.append(request)
            return httpx.Response(503)

        result = await read_portfolio_pca_review("http://local", "account-a", diagnostics=diagnostics,
                                               transport=httpx.MockTransport(respond))
        self.assertEqual(result, {})
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0].method, "GET")
        self.assertEqual(requests[0].url.path, "/api/risk/pca/snapshot")
        self.assertEqual(dict(requests[0].url.params), {"account": "account-a"})
        self.assertEqual(diagnostics["attemptCount"], 1)
        self.assertEqual(diagnostics["outcome"], "http_error")
        self.assertEqual(diagnostics["budgetMs"], 1000)

    async def test_default_one_second_budget_cancels_a_hung_request_once(self):
        requests = []
        cancelled = []
        diagnostics = {}

        async def respond(request):
            requests.append(request)
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.append(request)

        started = asyncio.get_running_loop().time()
        result = await read_portfolio_pca_review("http://local", "account-a", timeout=30,
            diagnostics=diagnostics, transport=httpx.MockTransport(respond))
        elapsed = asyncio.get_running_loop().time() - started
        self.assertEqual(result, {})
        self.assertEqual(len(requests), 1)
        self.assertEqual(len(cancelled), 1)
        self.assertGreaterEqual(elapsed, .9)
        self.assertLess(elapsed, 1.5)
        self.assertEqual(diagnostics["attemptCount"], 1)
        self.assertEqual(diagnostics["budgetMs"], 1000)
        self.assertEqual(diagnostics["outcome"], "timeout")

    async def test_active_capture_guard_prevents_request_retry_or_return_after_stop_and_deadline(self):
        for phase in ("before_request", "after_failure", "after_response", "expired"):
            with self.subTest(phase=phase):
                stopped = False
                requests = []
                diagnostics = {}

                async def ensure_active():
                    if phase == "expired":
                        return 0
                    if stopped or phase == "before_request":
                        raise asyncio.CancelledError()
                    return 30

                def respond(request):
                    nonlocal stopped
                    requests.append(request)
                    stopped = True
                    return (httpx.Response(503) if phase == "after_failure"
                            else httpx.Response(200, json=envelope(), headers=HEADERS))

                read = read_portfolio_pca_review("http://local", "account-a", ensure_active=ensure_active,
                    diagnostics=diagnostics, transport=httpx.MockTransport(respond))
                if phase == "expired":
                    self.assertEqual(await read, {})
                    self.assertEqual(diagnostics["outcome"], "timeout")
                else:
                    with self.assertRaises(asyncio.CancelledError):
                        await read
                    self.assertEqual(diagnostics["outcome"], "cancelled")
                self.assertEqual(len(requests), 0 if phase in {"before_request", "expired"} else 1)
                self.assertNotIn("account-a", json.dumps(diagnostics))

    async def test_stage_diagnostics_preserve_exact_result_and_omit_private_data(self):
        payload = envelope()
        diagnostics = {}
        result = await read_portfolio_pca_review("http://local", "account-a", diagnostics=diagnostics,
            transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload, headers=HEADERS)))
        self.assertEqual(result["model"], payload["snapshot"]["model"])
        self.assertEqual(result["provenance"], payload["snapshot"]["provenance"])
        self.assertEqual(diagnostics["outcome"], "available")
        self.assertEqual(diagnostics["attemptCount"], 1)
        attempt = diagnostics["attempts"][0]
        self.assertEqual(attempt["httpStatus"], 200)
        for field in ("clientMs", "requestHeadersMs", "bodyMs", "jsonDecodeMs",
                      "envelopeValidationMs", "snapshotValidationMs", "elapsedMs"):
            self.assertGreaterEqual(attempt[field], 0)
        self.assertGreater(attempt["bodyBytes"], 0)
        for private in ("account-a", "Equities / Credit", "netLiquidation", "http://local", payload["snapshot"]["id"]):
            self.assertNotIn(private, json.dumps(diagnostics))
        self.assertFalse(any(task.get_name() == "pca-acquisition-watchdog" for task in asyncio.all_tasks()))

    async def test_stage_diagnostics_distinguish_headers_timeout_body_timeout_and_rejection(self):
        async def wait_headers(_request):
            await asyncio.Event().wait()

        class WaitBody(httpx.AsyncByteStream):
            async def __aiter__(self):
                await asyncio.Event().wait()
                yield b""

        for phase, respond in (("request_headers", wait_headers),
                               ("response_body", lambda _: httpx.Response(200, stream=WaitBody(), headers=HEADERS))):
            with self.subTest(phase=phase):
                diagnostics = {}
                with patch("portfolio_pca_review.PCA_READ_TOTAL_TIMEOUT_SECONDS", .045):
                    result = await read_portfolio_pca_review("http://local", "account-a", timeout=.03,
                        diagnostics=diagnostics, transport=httpx.MockTransport(respond))
                self.assertEqual(result, {})
                self.assertEqual(diagnostics["outcome"], "timeout")
                self.assertEqual(diagnostics["phase"], phase)
                self.assertEqual(diagnostics["attemptCount"], 1)
                self.assertGreaterEqual(diagnostics["elapsedMs"], 25)
                self.assertGreater(diagnostics["phaseElapsedMs"], 0)
        diagnostics = {}
        payload = envelope()
        payload["snapshot"]["accountId"] = "wrong-private-account"
        result = await read_portfolio_pca_review("http://local", "account-a", diagnostics=diagnostics,
            transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload, headers=HEADERS)))
        self.assertEqual(result, {})
        self.assertEqual(diagnostics["outcome"], "rejected_snapshot")
        self.assertEqual(diagnostics["attemptCount"], 1)
        self.assertNotIn("wrong-private-account", json.dumps(diagnostics))

    async def test_stage_diagnostics_record_loop_lag_and_cancel_watchdog(self):
        def blocked_headers(_request):
            wall_time.sleep(.08)
            return httpx.Response(200, json=envelope(), headers=HEADERS)

        diagnostics = {}
        result = await read_portfolio_pca_review("http://local", "account-a", diagnostics=diagnostics,
                                               transport=httpx.MockTransport(blocked_headers))
        self.assertTrue(result)
        self.assertGreaterEqual(diagnostics["eventLoopLagMaxMs"], 25)
        entered = asyncio.Event()

        async def pending(_request):
            entered.set()
            await asyncio.Event().wait()

        cancelled = {}
        task = asyncio.create_task(read_portfolio_pca_review("http://local", "account-a", diagnostics=cancelled,
                                                           transport=httpx.MockTransport(pending)))
        await entered.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(cancelled["outcome"], "cancelled")
        self.assertEqual(cancelled["phase"], "request_headers")
        self.assertFalse(any(task.get_name() == "pca-acquisition-watchdog" for task in asyncio.all_tasks()))

    async def test_stage_diagnostics_survive_overlapping_outer_cancellation_during_cleanup(self):
        entered = asyncio.Event()
        cleaning = asyncio.Event()
        released = asyncio.Event()
        real_gather = asyncio.gather

        async def respond(_request):
            entered.set()
            await asyncio.Event().wait()

        async def delayed_cleanup(*tasks, **kwargs):
            cleaning.set()
            await released.wait()
            return await real_gather(*tasks, **kwargs)

        diagnostics = {}
        with patch("portfolio_pca_review.asyncio.gather", side_effect=delayed_cleanup):
            task = asyncio.create_task(read_portfolio_pca_review("http://local", "account-a", diagnostics=diagnostics,
                                                               transport=httpx.MockTransport(respond)))
            await entered.wait()
            task.cancel()
            await cleaning.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(diagnostics["outcome"], "cancelled")
        self.assertEqual(diagnostics["phase"], "request_headers")
        self.assertEqual(diagnostics["attemptCount"], 1)
        self.assertGreaterEqual(diagnostics["elapsedMs"], 0)
        self.assertNotIn("account-a", json.dumps(diagnostics))
        self.assertFalse(any(task.get_name() == "pca-acquisition-watchdog" for task in asyncio.all_tasks()))

    async def test_transport_timeout_returns_unavailable_without_retry(self):
        requests = []

        def respond(request):
            requests.append(request)
            raise httpx.ReadTimeout("temporary delivery timeout", request=request)

        result = await read_portfolio_pca_review("http://local", "account-a", transport=httpx.MockTransport(respond))
        self.assertEqual(result, {})
        self.assertEqual(len(requests), 1)

    async def test_server_and_client_failures_settle_without_retry(self):
        for status in (500, 503, 404, 429):
            with self.subTest(status=status):
                requests = []

                def respond(request):
                    requests.append(request)
                    return httpx.Response(status)

                result = await read_portfolio_pca_review("http://local", "account-a", transport=httpx.MockTransport(respond))
                self.assertEqual(len(requests), 1)
                self.assertEqual(result, {})

    async def test_shorter_requested_timeout_cancels_the_only_request(self):
        requests = []
        cancelled = []

        async def respond(request):
            requests.append(request)
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.append(request)

        loop = asyncio.get_running_loop()
        started = loop.time()
        result = await read_portfolio_pca_review("http://local", "account-a", timeout=.03,
                                               transport=httpx.MockTransport(respond))
        self.assertEqual(result, {})
        self.assertEqual(len(requests), 1)
        self.assertEqual(len(cancelled), 1)
        self.assertLess(loop.time() - started, .2)

    async def test_available_model_is_preserved_with_one_read_and_original_provenance(self):
        requests = []
        payload = envelope()

        def respond(request):
            requests.append(request)
            return httpx.Response(200, json=payload, headers=HEADERS)

        result = await read_portfolio_pca_review("http://local", "account-a", timeout=.02,
                                               transport=httpx.MockTransport(respond))
        self.assertEqual(len(requests), 1)
        self.assertEqual(result["id"], payload["snapshot"]["id"])
        self.assertEqual(result["generatedAt"], payload["snapshot"]["generatedAt"])
        self.assertEqual(result["provenance"], payload["snapshot"]["provenance"])
        self.assertEqual(result["model"], payload["snapshot"]["model"])
        self.assertIsNotNone(section(result))

    async def test_rejected_evidence_and_headers_are_not_retried(self):
        for mutation in (lambda p: p.update(mock=True), lambda p: p.update(stale=True),
                         lambda p: p.update(cacheOnly=True),
                         lambda p: p["snapshot"].update(accountId="wrong-account"),
                         lambda p: p["snapshot"]["model"].update(modelVersion="wrong-model")):
            payload = envelope()
            mutation(payload)
            requests = []

            def respond(request):
                requests.append(request)
                return httpx.Response(200, json=payload, headers=HEADERS)

            self.assertEqual(await read_portfolio_pca_review("http://local", "account-a",
                             transport=httpx.MockTransport(respond)), {})
            self.assertEqual(len(requests), 1)
        for headers in ({}, {**HEADERS, "X-Data-Use": "live"}):
            requests = []

            def respond(request):
                requests.append(request)
                return httpx.Response(200, json=envelope(), headers=headers)

            self.assertEqual(await read_portfolio_pca_review("http://local", "account-a",
                             transport=httpx.MockTransport(respond)), {})
            self.assertEqual(len(requests), 1)

    async def test_read_only_route_retains_saved_research_after_later_refresh_failure(self):
        requests = []
        payload = envelope()
        payload["latestAttempt"] = {"status": "failed", "code": "portfolio_unavailable"}
        payload["snapshot"]["model"]["fit"] = {"scores": ["private internal fit"]}
        payload["snapshot"]["evidence"] = {"holdings": ["raw account evidence"]}

        def respond(request):
            requests.append(request)
            return httpx.Response(200, json=payload, headers=HEADERS)

        result = await read_portfolio_pca_review("http://local", "account-a", transport=httpx.MockTransport(respond))
        self.assertEqual(requests[0].method, "GET")
        self.assertEqual(requests[0].url.path, "/api/risk/pca/snapshot")
        self.assertEqual(dict(requests[0].url.params), {"account": "account-a"})
        self.assertEqual(result["source"], "pca_saved_snapshot")
        self.assertEqual(result["generatedAt"], payload["snapshot"]["generatedAt"])
        self.assertNotIn("fit", result["model"])
        self.assertNotIn("evidence", result)
        self.assertIsNotNone(section(result))

    async def test_unavailable_untrusted_malformed_and_other_account_responses_return_empty(self):
        wrong_account = envelope()
        wrong_account["snapshot"]["accountId"] = "other-account"
        for response in (httpx.Response(503), httpx.Response(200, text="bad json"),
                         httpx.Response(200, json=[]), httpx.Response(200, json=envelope()),
                         httpx.Response(200, json={"status": "unavailable"}, headers=HEADERS),
                         httpx.Response(200, json=wrong_account, headers=HEADERS),
                         httpx.Response(200, json={**envelope(), "offline": True}, headers=HEADERS),
                         httpx.Response(200, json={**envelope(), "snapshot": []}, headers=HEADERS)):
            result = await read_portfolio_pca_review("http://local", "account-a", transport=httpx.MockTransport(lambda _: response))
            self.assertEqual(result, {})

    async def test_total_timeout_is_bounded(self):
        async def respond(_request):
            await asyncio.sleep(1)
            return httpx.Response(200, json=envelope(), headers=HEADERS)

        result = await read_portfolio_pca_review("http://local", "account-a", timeout=.01,
                                               transport=httpx.MockTransport(respond))
        self.assertEqual(result, {})


if __name__ == "__main__":
    unittest.main()
