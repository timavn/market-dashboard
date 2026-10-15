import asyncio
import json
import unittest

from analyst_review_sources import review_sources
from prediction_setup_board import render_setup_board
from review_runs_v2 import ReviewRunError, render_prediction_review

AT = "2026-10-10T17:00:00Z"


def drivers(report, section):
    block = report.split(f"## {section}\n\n```analyst-drivers\n", 1)[1].split("\n```", 1)[0]
    return json.loads(block)


def board():
    return {
        "asOf": AT, "sources": {"riskRanges": "2026-10-09", "cryptoQuant": "2026-10-09"},
        "usd": {"value": 102.47, "changePct": 0.25, "d15": 1.99, "m1": 3.15, "asOf": AT, "trend": "BULLISH", "low": 101.4, "high": 102.58,
                "rangeDate": "2026-10-09", "trade": {"direction": "BULLISH", "date": "2026-10-06", "source": "Macro Show"},
                "tick": {"position": "Buy", "ticker": "UUP", "direction": "BULLISH", "date": "2026-10-06"}},
        "sourceStatus": {"riskRanges": "ready", "cryptoQuant": "ready", "hedgai": "ready", "securityIntelligence": "ready",
                         "nowcast": "failed", "quotes": "ready", "volatility": "ready", "kalshi": "ready"},
        "rows": [
            {"id": "gold", "label": "Gold", "group": "metals", "events": [{"eventTicker": "KXGOLDD-26OCT1217"}],
             "price": {"value": 4216.3, "fit": "proxy", "asOf": AT}, "range": {"low": 4100, "high": 4224, "fit": "exact", "date": "2026-10-09"},
             "volatility": {"symbol": "GVZ", "value": 22.93, "changePct": 0.61, "d15": -6.7, "m1": -17.07, "regimeKey": "GVZ"},
             "usdCorrelation": {"key": "GOLD", "d15": -0.839, "d30": -0.9, "d60": -0.81, "d90": -0.764, "calculationDate": "2026-10-09"},
             "position": 0.938, "tick": {"position": "Wait", "direction": "NEUTRAL", "date": "2026-09-28"},
             "trade": None, "trend": "BEARISH", "setup": {"side": None, "reason": None}},
            {"id": "wti", "label": "WTI", "group": "oil", "events": [{"eventTicker": "KXWTI-26OCT1314"}],
             "price": {"value": 91.85, "fit": "exact"}, "range": {"low": 87.14, "high": 93.03}, "position": 0.8,
             "volatility": {"symbol": "OVX", "label": "Cboe Crude Oil Volatility", "value": None, "unavailable": True},
             "tick": None, "trade": None, "trend": "BULLISH", "setup": {"side": None, "reason": None}},
            {"id": "nasdaq100", "label": "Nasdaq-100", "group": "indices", "events": [{"eventTicker": "KXNASDAQ100U-26OCT12H1600"}],
             "volatility": {"symbol": "VIX", "value": 15.34, "changePct": 3.37, "low": 14.58, "high": 16.71, "trend": "BEARISH"},
             "price": {"value": 30883.15, "fit": "exact"}, "rangePrice": {"value": 27366.17, "label": "Nasdaq Composite"},
             "range": {"low": 26804, "high": 27777, "ticker": "COMPQ", "fit": "related-only"}, "position": 0.578,
             "tick": None, "trade": None, "trend": "BULLISH", "setup": {"side": None, "reason": None}},
            {"id": "ust2y", "label": "UST 2Y", "group": "rates",
             "events": [{"eventTicker": "KX2YRDIRHM-26OCT30H"}, {"eventTicker": "KX2YRDIRLM-26OCT30L"}],
             "price": {"value": 4.75, "fit": "exact", "asOf": "2026-10-08T00:00:00.000Z"}, "range": {"low": 4.73, "high": 4.96}, "position": 0.087,
             "tick": {"position": "Buy", "ticker": "SHY", "inverse": True, "direction": "BEARISH", "date": "2026-09-28"},
             "trade": None, "trend": "BULLISH", "setup": {"side": None, "reason": None}},
            {"id": "ethereum", "label": "Ethereum", "group": "crypto", "events": [],
             "price": {"value": 2300}, "range": {"low": 2406, "high": 2825, "product": "crypto-quant"}, "position": -0.25,
             "tick": None, "trade": None, "trend": "BULLISH", "setup": {"side": None, "reason": "Below range"}},
        ],
    }


class SetupBoardRenderTests(unittest.TestCase):
    def test_renders_one_table_per_section_with_tick_trade_trend(self):
        report = render_setup_board(board())
        self.assertTrue(report.startswith("## Metals"))
        self.assertNotIn("**Long:**", report)
        headings = [line for line in report.splitlines() if line.startswith("## ")]
        self.assertEqual(headings, ["## Metals", "## Crypto", "## Oil", "## Indices", "## Rates"])
        metals, indices = drivers(report, "Metals"), drivers(report, "Indices")
        # Volatility (with regime inputs and implied one-day move) and USD correlations; no Dollar cell or Kalshi cell.
        self.assertEqual(metals["volatility"], [{"symbol": "GVZ", "market": "Gold", "level": "22.93", "d1": 0.61,
                                                 "d15": -6.7, "m1": -17.07, "regimeKey": "GVZ", "regimeValue": 22.93,
                                                 "implied": "±1.4% · ±61"}])
        self.assertEqual(metals["correlations"], {"rows": [{"market": "Gold", "d15": "-0.84", "d30": "-0.90", "d60": "-0.81", "d90": "-0.76"}],
                                                  "asOf": "Oct 9 close"})
        self.assertNotIn("cells", metals)
        # A configured gauge without a reading keeps its row as N/A rather than dropping out.
        self.assertEqual(drivers(report, "Oil")["volatility"], [{"symbol": "OVX", "market": "WTI", "level": "N/A", "note": "Unavailable"}])
        self.assertEqual(indices["volatility"][0]["signal"], "Bearish")
        self.assertEqual(indices["volatility"][0]["range"], "14.58–16.71")
        self.assertNotIn('"Kalshi"', report)
        self.assertIn("| Market | Tick | Trade | Trend | Price and Risk Range | As of (PT) |", report)
        self.assertNotIn("Setup", report)
        # The US Dollar is the first row of every section, laid out like a market.
        self.assertIn("| Market | Tick | Trade | Trend | Price and Risk Range | As of (PT) |\n| --- | --- | --- | --- | --- | --- |\n"
                      "| REF(US Dollar;DXY) | BIAS(Bullish;;) | BIAS(Bullish;;) | BIAS(Bullish;;) | RR(101.40;102.58;102.47;2;) | "
                      "ASOF(Oct 10 10:00;Oct 6,HedgAI UUP;Oct 6,Macro Show;Oct 9,Risk Ranges) |", report)
        self.assertEqual(report.count("REF(US Dollar;DXY)"), 5)
        # Bias cells hold only the word; dates and products move to As of.
        self.assertIn("| Gold | BIAS(Neutral;;) | BIAS(N/A;;) | BIAS(Bearish;;) | RR(4100;4224;4216;0;) | "
                      "ASOF(Oct 10 10:00;Sep 28,HedgAI;,;Oct 9,Risk Ranges) |", report)
        self.assertIn("| WTI | BIAS(N/A;;) | BIAS(N/A;;) | BIAS(Bullish;;) | RR(87.14;93.03;91.85;2;) | ASOF(N/A;,;,;,Risk Ranges) |", report)
        self.assertIn("| MKT(Nasdaq-100;COMPQ range) |", report)
        # HedgAI's SHY Buy is a yield-down reading: shown as Bearish, never Buy or Wait.
        self.assertIn("| UST 2Y | BIAS(Bearish;;) | BIAS(N/A;;) | BIAS(Bullish;;) | RR(4.73;4.96;4.75;2;%) | "
                      "ASOF(Oct 8;Sep 28,HedgAI SHY;,;,Risk Ranges) |", report)
        self.assertNotIn("Wait", report)
        self.assertNotIn("Buy", report)
        self.assertIn("| Ethereum | BIAS(N/A;;) | BIAS(N/A;;) | BIAS(Bullish;;) | RR(2406;2825;2300;0;) | ASOF(N/A;,;,;,Crypto Quant) |", report)
        self.assertIn("Prices are front-month futures; Kalshi settles on Pyth spot.", report)
        self.assertIn("Nasdaq-100 30,883; its bar shows the COMPQ range and Nasdaq Composite price.", report)

    def test_withheld_price_shows_na_and_names_the_rejected_quote(self):
        data = board()
        data["rows"][0].update(price=None, position=None, priceRejected={"symbol": "GC=F", "value": 41.5},
                               setup={"side": None, "reason": "No comparable range position"})
        report = render_setup_board(data)
        self.assertIn("| Gold | BIAS(Neutral;;) | BIAS(N/A;;) | BIAS(Bearish;;) | RR(4100;4224;;0;) | "
                      "ASOF(N/A;Sep 28,HedgAI;,;Oct 9,Risk Ranges) |", report)
        self.assertIn("Gold price withheld: GC=F returned 41.5, inconsistent with its Risk Range.", report)

    def test_cpi_lists_every_nowcast_month_with_its_kalshi_event_or_na(self):
        report = render_setup_board({"rows": [{"id": "cpi", "label": "CPI YoY", "group": "inflation",
            "events": [{"eventTicker": "KXCPIYOY-26SEP"}], "forecasts": [
                {"reportMonth": "2026-09", "available": True, "lower": 3.63, "base": 3.74, "upper": 3.85,
                 "publishedAt": "2026-10-06T11:48:50+00:00", "eventTicker": "KXCPIYOY-26SEP"},
                {"reportMonth": "2026-10", "available": True, "lower": 3.69, "base": 3.8, "upper": 3.91,
                 "publishedAt": "2026-10-06T11:48:50+00:00", "eventTicker": None}]}]})
        self.assertIn("| CPI YoY · Sep 2026 | Sep | 3.63% | 3.74% | 3.85% | Oct 6 |", report)
        self.assertIn("| CPI YoY · Oct 2026 | N/A | 3.69% | 3.80% | 3.91% | Oct 6 |", report)
        self.assertIn("Sources: HedgAI Signals, Cboe volatility indices, Kalshi", report)

    def test_saved_legacy_and_new_captures_use_their_own_renderer(self):
        sections = [{"id": "setup-board", "board": board()}]
        self.assertTrue(render_prediction_review(sections, "ready", []).startswith("## Metals"))


class SetupBoardSourcesTests(unittest.TestCase):
    class Store:
        def __init__(self, evidence):
            self.evidence = evidence

        def read_evidence(self, run, name):
            return self.evidence.get(name)

    def project(self, dependencies, evidence, state="succeeded"):
        record = {"runId": "run-1", "conversationId": "c-1", "reviewKind": "prediction-markets-review",
                  "state": state, "updatedAt": AT, "dependencies": dependencies}
        result = review_sources(record, self.Store(evidence), research_products=[], prediction_universe=[])
        return {item["id"]: item for item in result["items"]}

    def test_each_board_input_is_its_own_source_row(self):
        items = self.project({"predictionBoard": {"status": "partial", "updatedAt": AT}}, {"predictionBoard": board()})
        self.assertEqual(list(items), ["risk-ranges", "crypto-quant", "hedgai-signals", "tradeResearch",
                                       "inflation-nowcast", "marketPrices", "volatilityIndices", "usdCorrelations", "kalshiContracts"])
        self.assertEqual(items["risk-ranges"]["status"], "ready")
        self.assertEqual(items["risk-ranges"]["publishedAt"], "2026-10-09")
        self.assertEqual(items["inflation-nowcast"]["status"], "unavailable")
        self.assertNotIn("ibGateway", items)

    def test_running_review_shows_board_inputs_checking(self):
        items = self.project({}, {}, state="running")
        self.assertTrue(all(item["status"] == "checking" for item in items.values()))


class SetupBoardHandlerTests(unittest.IsolatedAsyncioTestCase):
    async def test_board_failure_checkpoints_and_raises(self):
        import app as analyst_app

        calls = []

        class Context:
            async def checkpoint(self, name, **kwargs):
                calls.append((name, kwargs.get("status")))

        async def failing():
            raise RuntimeError("down")

        with self.assertRaises(ReviewRunError):
            await analyst_app._prediction_review_v2_handler(Context(), board_reader=failing)
        self.assertEqual(calls, [("predictionBoard", "failed")])


if __name__ == "__main__":
    unittest.main()
