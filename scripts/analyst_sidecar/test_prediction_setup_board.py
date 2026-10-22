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
        self.assertIn("| Market | Tick | Trade | Trend | Price and Risk Range | Status |", report)
        self.assertNotIn("Setup", report)
        # The US Dollar is the first row of every section, laid out like a market.
        self.assertIn("| Market | Tick | Trade | Trend | Price and Risk Range | Status |\n| --- | --- | --- | --- | --- | --- |\n"
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
        self.assertNotIn("front-month futures", report)
        self.assertIn("Nasdaq-100 30,883; its bar shows the COMPQ range and Nasdaq Composite price.", report)

    def test_withheld_price_shows_na_and_names_the_rejected_quote(self):
        data = board()
        data["rows"][0].update(price=None, position=None, priceRejected={"symbol": "GC=F", "value": 41.5},
                               setup={"side": None, "reason": "No comparable range position"})
        report = render_setup_board(data)
        self.assertIn("| Gold | BIAS(Neutral;;) | BIAS(N/A;;) | BIAS(Bearish;;) | RR(4100;4224;;0;) | "
                      "ASOF(N/A;Sep 28,HedgAI;,;Oct 9,Risk Ranges) |", report)
        self.assertIn("Gold price withheld: GC=F returned 41.5, inconsistent with its Risk Range.", report)

    def test_morning_research_adds_alpha_code_column_and_research_block(self):
        data = board()
        data["research"] = {"version": 1, "marketDate": "2026-10-16", "products": [
            {"key": "top-3-things", "label": "Top 3 Things", "status": "read", "publishedAt": "2026-10-16T12:31:00.000Z"},
            {"key": "the-macro-show", "label": "The Macro Show", "status": "read", "publishedAt": "2026-10-16T14:55:00.000Z"},
            {"key": "etf-pro", "label": "ETF Pro", "status": "missing"}]}
        excerpt = "UST 2yr holding TRADE/TREND Signal Supports (TREND all the way down at 4.40%)"
        data["research"]["products"] += [{"key": "risk-ranges", "label": "Risk Ranges", "status": "read", "publishedAt": "2026-10-16T11:28:00.000Z"},
                                         {"key": "market-structure", "label": "Market Structure", "status": "read",
                                          "publishedAt": "2026-10-16T10:30:29+00:00"}]
        data["rows"][1]["research"] = {"findings": [
            {"product": "risk-ranges", "productLabel": "Risk Ranges", "kind": "trendChange", "from": "Neutral", "to": "Bullish", "fit": "exact",
             "sourceText": "Trend change: COPPER changed from Neutral to Bullish"}]}
        data["rows"][2]["research"] = {"findings": [
            {"product": "market-structure", "productLabel": "Market Structure", "kind": "structure", "fit": "exact",
             "signals": [{"label": "SPX Gamma Exposure", "value": "Neutral", "tone": "neutral"}], "sourceText": "Market makers remain broadly neutral."},
            {"product": "market-structure", "productLabel": "Market Structure", "kind": "structureLevels", "fit": "exact", "zeroGamma": 7736,
             "lowerPvBand": 7660, "upperPvBand": 7886, "strikesInPlay": [7700, 7750], "gammaThrottle": 0.64, "realizedVolatility": 9.63,
             "sourceText": "Read from the SPX Probable Volatility / Gamma By Strike chart"}]}
        data["rows"][3]["research"] = {"findings": [
            {"product": "top-3-things", "productLabel": "Top 3 Things", "kind": "trendLevel", "level": 4.4, "unit": "%", "fit": "exact",
             "excerpt": excerpt},
            {"product": "top-3-things", "productLabel": "Top 3 Things", "kind": "signal", "trade": "Bullish", "trend": "Bullish",
             "fit": "exact", "excerpt": excerpt},
            # The board's own Risk Range repeated by a product adds nothing.
            {"product": "top-3-things", "productLabel": "Top 3 Things", "kind": "riskRange", "low": 4.73, "high": 4.96, "unit": "%"}]}
        data["rows"][0]["research"] = {"alphaCode": {"trade": 4180, "trend": 4120, "approximate": True, "productLabel": "The Macro Show",
                                                     "unit": None},
                                       "findings": [{"product": "the-macro-show", "productLabel": "The Macro Show", "kind": "alphaCode",
                                                     "trade": 4180, "trend": 4120, "approximate": True, "fit": "exact",
                                                     "excerpt": "Gold Alpha Code 4180/4120; Silver at 57", "context": "Gold Alpha Code 4180/4120"},
                                                    {"product": "etf-pro", "productLabel": "ETF Pro", "kind": "position", "side": "Long",
                                                     "fit": "proxy", "instrumentLabel": "GLD"}]}
        data["research"]["products"].append({"key": "real-time-alert", "label": "Real-Time Alerts", "status": "read",
                                             "publishedAt": "2026-10-16T15:39:00.000Z"})
        data["usd"]["research"] = {"findings": [
            {"product": "real-time-alert", "productLabel": "Real-Time Alerts", "kind": "mention", "fit": "exact", "excerpt": "BUY SIGNAL UUP",
             "context": "BUY SIGNAL UUP"},
            # The alert's own position repeats what its prose already says.
            {"product": "real-time-alert", "productLabel": "Real-Time Alerts", "kind": "position", "side": "Long", "action": "Buy",
             "name": "UUP", "fit": "proxy", "instrumentLabel": "UUP", "eventTime": "2026-10-16T15:42:24+00:00"},
            {"product": "the-macro-show", "productLabel": "The Macro Show", "kind": "position", "side": "Long", "name": "U.S. Dollar (USD)",
             "fit": "exact", "sourceText": "Longs: U.S. Dollar (USD), Software (IGV)"}]}
        report = render_setup_board(data)
        # The Alpha Code rides in the range cell as Trade;Trend;approximate;dots;product, not a column of its own.
        self.assertIn("| Market | Tick | Trade | Trend | Price and Risk Range | Status |", report)
        self.assertIn("| Gold | BIAS(Neutral;;) | BIAS(N/A;;) | BIAS(Bearish;;) | RR(4100;4224;4216;0;;4180;4120;1;1;The Macro Show) |", report)
        # UST 2Y has only a Trend level.
        self.assertIn("| BIAS(Bullish;;) | RR(4.73;4.96;4.75;2;%;;4.4;0;1;Top 3 Things) |", report)
        self.assertIn("| WTI | BIAS(N/A;;) | BIAS(N/A;;) | BIAS(Bullish;;) | RR(87.14;93.03;91.85;2;) |", report)
        metals = json.loads(report.split("## Metals", 1)[1].split("```analyst-research\n", 1)[1].split("\n```", 1)[0])
        # One entry per mention in time order: the part of the sentence about the market, with the sentence as its source;
        # published data carries the line or list it was printed in.
        self.assertEqual(metals["markets"][0], {"market": "US Dollar", "entries": [
            {"product": "The Macro Show", "time": "07:55", "context": "Long U.S. Dollar (USD)", "source": "Longs: U.S. Dollar (USD), Software (IGV)"},
            {"product": "Real-Time Alerts", "time": "08:39", "context": "BUY SIGNAL UUP", "source": "BUY SIGNAL UUP"}]})
        self.assertEqual(metals["markets"][1]["entries"], [
            {"product": "The Macro Show", "time": "07:55", "context": "Gold Alpha Code 4180/4120",
             "source": "Gold Alpha Code 4180/4120; Silver at 57"},
            {"product": "ETF Pro", "context": "Long GLD"}])
        self.assertIn('{"market":"Ethereum","entries":[]}', report)
        # Published data reads "Label: value", with the line it was printed in as its source.
        self.assertIn('{"market":"WTI","entries":[{"product":"Risk Ranges","time":"04:28","context":"Trend: Neutral → Bullish",'
                      '"source":"Trend change: COPPER changed from Neutral to Bullish","facts":["Trend: Neutral → Bullish"]}]}', report)
        self.assertIn('{"product":"Market Structure","time":"03:30","context":"SPX Gamma Exposure: Neutral",'
                      '"source":"Market makers remain broadly neutral.","facts":["SPX Gamma Exposure: Neutral"]}', report)
        self.assertIn('"context":"Zero gamma: 7,736 · PV band: 7,660–7,886 · Strikes in play: 7,700, 7,750 · Gamma throttle: 0.64 · '
                      '10D realized vol: 9.63%"', report)
        # Reported data also lists one line per fact, so it reads as data rather than a sentence.
        self.assertIn('"facts":["Zero gamma: 7,736","PV band: 7,660–7,886","Strikes in play: 7,700, 7,750","Gamma throttle: 0.64",'
                      '"10D realized vol: 9.63%"]', report)
        rates = json.loads(report.split("## Rates", 1)[1].split("```analyst-research\n", 1)[1].split("\n```", 1)[0])
        # Two findings from one sentence are one mention; the board's own Risk Range is not one.
        self.assertEqual(rates["markets"], [{"market": "UST 2Y", "entries": [
            {"product": "Top 3 Things", "time": "05:31", "context": excerpt, "source": excerpt}]}])
        # The US Dollar's research appears with the first section only.
        self.assertNotIn('"market":"US Dollar"', report.split("## Crypto", 1)[1])
        self.assertIn("Research read for Oct 16: Top 3 Things 05:31, The Macro Show 07:55, Risk Ranges 04:28, Market Structure 03:30, "
                      "Real-Time Alerts 08:39. Not published yet: ETF Pro.", report)

    def test_boards_without_morning_research_keep_their_layout(self):
        report = render_setup_board(board())
        self.assertNotIn("Alpha Code", report)
        self.assertNotIn("analyst-research", report)
        self.assertNotIn("Research read", report)

    def test_structure_column_carries_runs_and_the_all_time_high_before_as_of(self):
        data = board()
        data["structureSessions"] = 10
        data["usd"]["structure"] = {"sessions": 2, "low": {"steps": "+-", "direction": -1, "run": 1},
                                    "high": {"steps": "==", "direction": 0, "run": 0},
                                    "allTimeHigh": {"value": 164.72, "date": "1985-02-25", "rangeTopAbove": False}}
        gold = next(row for row in data["rows"] if row["id"] == "gold")
        gold["structure"] = {"sessions": 3, "low": {"steps": "+=+", "direction": 1, "run": 2},
                             "high": {"steps": "-++", "direction": 1, "run": 2},
                             "allTimeHigh": {"value": 4200, "date": "2026-10-06", "rangeTopAbove": True}}
        report = render_setup_board(data)
        self.assertIn("| Price and Risk Range | Structure | Status |", report)
        # The record's full date rides along for the ATH pop-up. Price sits 0% from the ATH.
        self.assertIn("| STRUCT(+=+;+2;-++;+2;4,200;Oct 6, 2026;+0;1;) | ASOF(", report)
        self.assertIn("| STRUCT(+-;-1;==;0;164.72;Feb 25, 1985;-38;0;) |", report)
        # A market whose structure could not be read shows N/A; boards without history keep six columns.
        self.assertIn("| N/A | ASOF(", report)
        self.assertNotIn("Structure", render_setup_board(board()))

    def test_volume_column_follows_trend_and_structure_carries_dv_or_av(self):
        data = board()
        data["volumeWindows"] = {"d15": 15, "d30": 30, "d90": 90}
        data["structureSessions"] = 10
        gold = next(row for row in data["rows"] if row["id"] == "gold")
        gold["volume"] = {"symbol": "GLD", "date": "2026-10-09", "d1": 13.6, "d15": -4.6, "d30": -15.2, "d90": -21.4,
                          "changePct": 0.3, "signal": {"move": "DV", "tone": None}}
        gold["structure"] = {"sessions": 1, "low": {"steps": "+", "direction": 1, "run": 1},
                             "high": {"steps": "-", "direction": -1, "run": 1}, "allTimeHigh": None}
        report = render_setup_board(data)
        self.assertIn("| Market | Tick | Trade | Trend | Volume | Price and Risk Range | Structure | Status |", report)
        self.assertIn("| BIAS(Bearish;;) | VOL(+14;-5;-15;-21;2026-10-09;GLD) | RR(", report)
        self.assertIn("STRUCT(+;+1;-;-1;;;;0;;DV;) |", report)
        # A market whose volume could not be read keeps an empty token, so its row still splits.
        self.assertIn("| BIAS(Bullish;;) | VOL(;;;;;) | RR(", report)
        self.assertNotIn("Volume", render_setup_board(board()))

    def test_cpi_lists_every_nowcast_month_with_its_kalshi_event_or_na(self):
        report = render_setup_board({"rows": [{"id": "cpi", "label": "CPI YoY", "group": "inflation",
            "events": [{"eventTicker": "KXCPIYOY-26SEP"}], "forecasts": [
                {"reportMonth": "2026-09", "available": True, "lower": 3.63, "base": 3.74, "upper": 3.85,
                 "publishedAt": "2026-10-06T11:48:50+00:00", "eventTicker": "KXCPIYOY-26SEP"},
                {"reportMonth": "2026-10", "available": True, "lower": 3.69, "base": 3.8, "upper": 3.91,
                 "publishedAt": "2026-10-06T11:48:50+00:00", "eventTicker": None}]}]})
        self.assertIn("| Market | Kalshi | Low | Base | High | Published |", report)
        self.assertIn("| CPI YoY · Sep 2026 | Sep | 3.63% | 3.74% | 3.85% | Oct 6 04:48 PDT |", report)
        self.assertIn("| CPI YoY · Oct 2026 | N/A | 3.69% | 3.80% | 3.91% | Oct 6 04:48 PDT |", report)
        self.assertIn("Sources: HedgAI Signals, Cboe volatility indices, Kalshi", report)

    def test_sources_line_gives_every_publication_the_same_date_and_time(self):
        report = render_setup_board({"rows": [], "sources": {
            "riskRanges": "2026-10-15T11:37:00.000Z", "cryptoQuant": "2026-10-15T11:40:00.000Z",
            "inflationNowcast": "2026-10-14T13:29:20+00:00"}})
        self.assertIn("Sources: Risk Ranges Oct 15 04:37 PDT, Crypto Quant Oct 15 04:40 PDT, "
                      "Inflation Nowcast Oct 14 06:29 PDT, HedgAI Signals", report)
        # A publication with only a date keeps its date; no time is invented.
        self.assertIn("Sources: Risk Ranges Oct 15, HedgAI", render_setup_board({"rows": [], "sources": {"riskRanges": "2026-10-15"}}))

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
