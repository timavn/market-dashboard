import copy
import json
from pathlib import Path
import subprocess
import unittest

import httpx

from portfolio_factor_review import build_portfolio_factor_section, read_portfolio_factor_review
from test_portfolio_rollup_metrics import metrics, position


def captured_book():
    return metrics([position(300, "other", symbol="ABC", quantity=3, secType="STK"),
                    position(-100, "other", symbol="XYZ", quantity=-2, secType="STK")])


def snapshot(book=None):
    book = book or captured_book()
    factors = [
        {"id": "market", "label": "Market", "formula": "SPY", "status": "available",
         "netExposurePct": 16, "grossExposurePct": 34, "contributionToTotalRiskPct": 72.5},
        {"id": "momentum", "label": "Momentum", "formula": "MTUM - SPY", "status": "available",
         "netExposurePct": -4.5, "grossExposurePct": 8, "contributionToTotalRiskPct": -2},
    ]
    return {
        "status": "available", "modelVersion": "exposure-lab-ridge-v2", "historicalOnly": True,
        "executable": False, "actionable": False, "asOf": "2026-09-17",
        "generatedAt": "2026-09-18T13:15:04Z",
        "portfolioState": {"accountId": "account-a", "mode": "live", "markState": "live",
                           "dataSource": "ibkr_api", "liveSessionVerified": True, "fromCache": False,
                           "fetchedAt": "2026-09-18T13:15:02Z", "socketVerifiedAt": "2026-09-18T13:15:01Z",
                           "dataQuality": {"status": "ok", "markState": "live"}},
        "sourceScope": {"sourceHoldingCount": 2, "eligibleHoldingCount": 2, "eligibleSymbolCount": 2,
                        "excludedHoldings": []},
        "positions": [{"symbol": row["symbol"], "quantity": row["quantity"], "marketValue": row["marketValue"],
                       "signedWeightPct": row["marketValue"] / 10, "modelStatus": "available"}
                      for row in book["positions"]],
        "factors": factors,
        "provenance": {"provider": "Yahoo Finance chart API",
                       "returnBasis": "explicit adjusted close; completed daily sessions only",
                       "factorDefinitions": [{"id": row["id"], "formula": row["formula"]} for row in factors]},
    }


class PortfolioFactorSectionTests(unittest.TestCase):
    def setUp(self):
        self.book = captured_book()
        self.source = snapshot(self.book)

    def test_projects_actual_dated_model_outputs_without_fabricated_long_short_or_beta(self):
        before = copy.deepcopy(self.source)
        result = build_portfolio_factor_section(self.source, self.book)
        self.assertEqual(result["title"], "Factor exposure")
        self.assertEqual(result["asOf"], "2026-09-17")
        self.assertEqual(result["coveragePct"], 100)
        self.assertEqual(result["blocks"][1]["columns"], ["Factor", "Gross (% NLV)", "Net (% NLV)", "Risk contribution"])
        self.assertEqual(result["blocks"][1]["rows"][1]["cells"], ["Momentum", "8.0%", "-4.5%", "-2.0%"])
        self.assertIn("2026-09-17", result["blocks"][0]["text"])
        self.assertNotIn("beta", str(result).lower())
        self.assertEqual(self.source, before)

    def test_independently_captured_valuation_may_move_without_changing_quantity_scope(self):
        self.source["positions"][0].update(marketValue=301, signedWeightPct=30.1)
        self.assertIsNotNone(build_portfolio_factor_section(self.source, self.book))
        self.source["positions"][0]["signedWeightPct"] = 60.2
        self.assertIsNone(build_portfolio_factor_section(self.source, self.book))

    def test_partial_coverage_uses_gross_value_and_keeps_negative_risk_contribution(self):
        self.source["status"] = "partial"
        self.source["positions"][1]["modelStatus"] = "unavailable"
        result = build_portfolio_factor_section(self.source, self.book)
        self.assertEqual(result["coveragePct"], 75)
        self.assertIn("Partial model", result["blocks"][0]["text"])
        self.assertEqual(result["blocks"][1]["rows"][1]["cells"][-1], "-2.0%")

    def test_exact_explicit_exclusions_are_required_and_coverage_includes_them(self):
        self.book = metrics(self.book["positions"] + [position(100, "event_contract", symbol="EVENT", secType="OPT")])
        self.source["sourceScope"]["sourceHoldingCount"] = 3
        self.source["sourceScope"]["excludedHoldings"] = [
            {"symbol": "EVENT", "secType": "OPT", "reason": "prediction_market_separate_ledger"}]
        result = build_portfolio_factor_section(self.source, self.book)
        self.assertEqual(result["coveragePct"], 80)
        self.source["sourceScope"]["excludedHoldings"][0]["symbol"] = "OTHER"
        self.assertIsNone(build_portfolio_factor_section(self.source, self.book))

    def test_unverified_live_inputs_fail_closed(self):
        for flags in ({"offline": True}, {"stale": True}, {"cacheOnly": True}, {"fromCache": True},
                      {"mock": True}, {"seeded": True}, {"isMock": True}, {"isSeed": True}):
            for location in ("snapshot", "state", "position"):
                with self.subTest(flags=flags, location=location):
                    source = copy.deepcopy(self.source)
                    target = source if location == "snapshot" else source["portfolioState"] if location == "state" else source["positions"][0]
                    target.update(flags)
                    self.assertIsNone(build_portfolio_factor_section(source, self.book))
        for flags in ({"available": False}, {"valuationComplete": False}, {"accountSummaryAvailable": False},
                      {"fromCache": True}, {"stale": True}):
            self.assertIsNone(build_portfolio_factor_section(self.source, {**self.book, **flags}))

    def test_account_scope_quantity_and_contract_identity_must_match(self):
        mutations = [
            lambda s: s["portfolioState"].update(accountId="other-account"),
            lambda s: s["sourceScope"].update(sourceHoldingCount=3),
            lambda s: s["sourceScope"].update(eligibleHoldingCount=1),
            lambda s: s["positions"][0].update(quantity=4),
            lambda s: s["positions"][0].update(quantity=-3),
            lambda s: s["positions"][0].update(symbol="OTHER"),
            lambda s: s["positions"].append(copy.deepcopy(s["positions"][0])),
        ]
        for mutate in mutations:
            source = copy.deepcopy(self.source)
            mutate(source)
            self.assertIsNone(build_portfolio_factor_section(source, self.book))
        for sec_type in (None, "FUT", "BOND"):
            book = copy.deepcopy(self.book)
            book["positions"][0]["secType"] = sec_type
            self.assertIsNone(build_portfolio_factor_section(self.source, book))

    def test_fresh_capture_and_historical_date_are_not_relabelled(self):
        for field in ("fetchedAt", "socketVerifiedAt"):
            for stamp in (None, "2026-09-18", "2026-09-18T13:12:00Z", "2026-09-18T13:17:00Z"):
                source = copy.deepcopy(self.source)
                source["portfolioState"][field] = stamp
                self.assertIsNone(build_portfolio_factor_section(source, self.book))
        for field, value in (("asOf", "2026-09-19"), ("asOf", None), ("generatedAt", "2026-09-18T13:14:00Z"),
                             ("generatedAt", "2026-09-18T13:17:00Z")):
            self.assertIsNone(build_portfolio_factor_section({**self.source, field: value}, self.book))

    def test_unsupported_or_missing_models_do_not_become_zero_exposure(self):
        for flags in ({"historicalOnly": False}, {"executable": True}, {"actionable": True},
                      {"modelVersion": "unknown"}, {"status": "unavailable"}, {"factors": []}, {"provenance": {}}):
            self.assertIsNone(build_portfolio_factor_section({**self.source, **flags}, self.book))
        for row in self.source["positions"]:
            row["modelStatus"] = "unavailable"
        self.assertIsNone(build_portfolio_factor_section(self.source, self.book))

    def test_missing_or_inconsistent_factor_evidence_is_withheld(self):
        for flags in ({"netExposurePct": None}, {"grossExposurePct": -1}, {"netExposurePct": 100},
                      {"formula": "invented"}, {"status": "unavailable"}):
            source = copy.deepcopy(self.source)
            source["factors"][0].update(flags)
            self.assertIsNone(build_portfolio_factor_section(source, self.book))
        self.source["factors"][0]["contributionToTotalRiskPct"] = None
        self.assertEqual(build_portfolio_factor_section(self.source, self.book)["blocks"][1]["rows"][0]["cells"][-1], "—")

    def test_caps_rows_by_absolute_net_sensitivity(self):
        for number in range(9):
            row = {**self.source["factors"][0], "id": str(number), "label": f"Factor {number}",
                   "netExposurePct": -number, "grossExposurePct": number}
            self.source["factors"].append(row)
            self.source["provenance"]["factorDefinitions"].append({"id": row["id"], "formula": row["formula"]})
        rows = build_portfolio_factor_section(self.source, self.book)["blocks"][1]["rows"]
        self.assertEqual(len(rows), 8)
        self.assertEqual(rows[0]["cells"][0], "Market")
        self.assertEqual(rows[1]["cells"][0], "Factor 8")
        self.assertIn("Largest 8 net sensitivities", build_portfolio_factor_section(self.source, self.book)["blocks"][0]["text"])

    def test_accepts_real_factor_model_serialization_contract(self):
        # Exercise production model serialization rather than repeating its
        # contract in the Python fixture. Generated bars are test-only inputs.
        script = r"""
const { buildPortfolioFactorRiskSnapshot, getFactorProxySymbols } = require('./src/utils/exposureLabFactorRisk.cjs');
const symbols = [...new Set([...getFactorProxySymbols(), 'ABC', 'XYZ'])];
const histories = Object.fromEntries(symbols.map((symbol, phase) => {
  let price = 100;
  return [symbol, Array.from({length: 191}, (_, index) => {
    price *= 1 + Math.sin((index + phase) / 7) * .006 + Math.cos((index + phase) / 19) * .003;
    return {date: new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10), adjustedClose: price, close: price};
  })];
}));
process.stdout.write(JSON.stringify(buildPortfolioFactorRiskSnapshot({
  holdings: [{symbol: 'ABC', quantity: 3, marketValue: 300}, {symbol: 'XYZ', quantity: -2, marketValue: -100}],
  totalValue: 1000, histories,
})));
"""
        process = subprocess.run(["node", "-e", script], cwd=Path(__file__).resolve().parents[2],
                                 check=True, capture_output=True, text=True, timeout=15)
        source = {**self.source, **json.loads(process.stdout)}
        result = build_portfolio_factor_section(source, self.book)
        self.assertIsNotNone(result)
        self.assertEqual(result["asOf"], source["asOf"])
        self.assertEqual(result["coveragePct"], 100)
        self.assertEqual(len(result["blocks"][1]["rows"]), 8)


class PortfolioFactorReaderTests(unittest.IsolatedAsyncioTestCase):
    async def test_uses_read_only_account_route_and_excludes_hedge_scenarios(self):
        requests = []
        payload = {**snapshot(), "hedgeScenarios": {"orders": ["unwanted"]}, "correlation": {}}

        def respond(request):
            requests.append(request)
            return httpx.Response(200, json=payload)

        result = await read_portfolio_factor_review("http://local", "account-a", transport=httpx.MockTransport(respond))
        self.assertEqual(requests[0].method, "GET")
        self.assertEqual(requests[0].url.path, "/api/risk/exposure-lab/snapshot")
        self.assertEqual(dict(requests[0].url.params), {"account": "account-a"})
        self.assertNotIn("hedgeScenarios", result)
        self.assertNotIn("correlation", result)
        self.assertIsNotNone(build_portfolio_factor_section(result, captured_book()))

    async def test_failures_mismatched_account_invalid_json_and_unavailable_return_empty(self):
        for response in (httpx.Response(503), httpx.Response(200, text="bad json"),
                         httpx.Response(200, json=[]), httpx.Response(200, json={"status": "unavailable"}),
                         httpx.Response(200, json={**snapshot(), "portfolioState": []}),
                         httpx.Response(200, json={**snapshot(), "portfolioState": {"accountId": "other"}})):
            result = await read_portfolio_factor_review("http://local", "account-a", transport=httpx.MockTransport(lambda r: response))
            self.assertEqual(result, {})

    async def test_total_timeout_is_bounded(self):
        import asyncio

        async def respond(request):
            await asyncio.sleep(1)
            return httpx.Response(200, json=snapshot())

        result = await read_portfolio_factor_review("http://local", "account-a", timeout=.01,
                                                  transport=httpx.MockTransport(respond))
        self.assertEqual(result, {})


if __name__ == "__main__":
    unittest.main()
