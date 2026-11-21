import asyncio
import json
import re
import unittest

from analyst_review_sources import review_sources
from prediction_setup_board import _curve_levels, _market_days_old, _product_key, render_setup_board, research_by_section
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
                      "ASOF(Oct 10 10:00;Sep 28,HedgAI;,;Oct 9,Risk Ranges;100) |", report)
        # Sep 28 is nine market days before the Oct 10 board, so its Tick is flagged (;100); Oct 6 is four and is not.
        self.assertEqual([_market_days_old(day, "2026-11-20") for day in ("2026-11-20", "2026-11-16", "2026-11-14", "2026-11-13", "bad")],
                         [0, 4, 5, 5, None])
        self.assertIn("| WTI | BIAS(N/A;;) | BIAS(N/A;;) | BIAS(Bullish;;) | RR(87.14;93.03;91.85;2;) | ASOF(N/A;,;,;,Risk Ranges) |", report)
        self.assertIn("| MKT(Nasdaq-100;COMPQ range) |", report)
        # HedgAI's SHY Buy is a yield-down reading: shown as Bearish, never Buy or Wait.
        self.assertIn("| UST 2Y | BIAS(Bearish;;) | BIAS(N/A;;) | BIAS(Bullish;;) | RR(4.73;4.96;4.75;2;%) | "
                      "ASOF(Oct 8;Sep 28,HedgAI SHY;,;,Risk Ranges;100) |", report)
        self.assertNotIn("Wait", report)
        self.assertNotIn("Buy", report)
        self.assertIn("| Ethereum | BIAS(N/A;;) | BIAS(N/A;;) | BIAS(Bullish;;) | RR(2406;2825;2300;0;) | ASOF(N/A;,;,;,Crypto Quant) |", report)
        self.assertNotIn("front-month futures", report)
        self.assertNotIn("its bar shows the", report)
        self.assertNotIn("read inversely as a yield direction", report)
        self.assertNotIn("reaches the line on any business day", report)

    def test_curve_levels_mark_the_alpha_code_and_only_an_own_price_range(self):
        wti = {"range": {"low": 82.96, "high": 93.11, "fit": "exact"},
               "research": {"alphaCode": {"trade": 92, "trend": 91, "approximate": False}}}
        self.assertEqual(_curve_levels(wti), {"rangeLow": 82.96, "rangeHigh": 93.11, "trade": 92, "trend": 91,
                                              "approximate": False})
        # A range topping the all-time high draws its high blue.
        gold = {"range": {"low": 3823, "high": 4056, "fit": "exact"}, "structure": {"allTimeHigh": {"rangeTopAbove": True}}}
        self.assertEqual(_curve_levels(gold), {"rangeLow": 3823, "rangeHigh": 4056, "rangeHighAth": True})
        # The Nasdaq-100 settles on its own price; the COMPQ range it is read against is left off.
        nasdaq = {"range": {"low": 22000, "high": 23000, "fit": "related-only", "ticker": "COMPQ"},
                  "rangePrice": {"value": 22500}}
        self.assertIsNone(_curve_levels(nasdaq))

    def test_line_monitor_folds_under_each_section_and_the_book_closes_the_report(self):
        data = board()
        gold = data["rows"][0]
        gold["kalshiLines"] = {"id": "gold", "market": "Gold", "gate": {"side": "SHORT", "grade": "B"}, "held": [], "open": True,
                               "lines": {"side": "SHORT", "buy": "NO", "lines": [{"ticker": "T1", "strike": 4200, "kalshiYes": 0.3,
                                                                                    "ticket": {"pct": 2.2, "zone": "target"}}],
                                         "illiquid": 0, "onTicket": 1}}
        report = render_setup_board(data)
        self.assertNotIn("analyst-kalshi-book", report)
        block = json.loads(report.split("```analyst-lines\n", 1)[1].split("\n```", 1)[0])
        # Each market carries the levels its settlement curve marks: here the Risk Range on its own price.
        self.assertEqual(block["markets"], [{**gold["kalshiLines"], "levels": {"rangeLow": 4100, "rangeHigh": 4224}}])
        # Under its own section's market table, ahead of the next section.
        self.assertLess(report.index("## Metals"), report.index("```analyst-lines"))
        self.assertLess(report.index("```analyst-lines"), report.index("## Oil"))
        data["kalshiBook"] = {"account": 5784.0, "atRisk": 2852.0, "sections": [], "flags": []}
        data["paper"] = {"tickets": 1, "open": 1, "settled": 0, "wonTickets": 0, "returnOnStake": None}
        report = render_setup_board(data)
        book = json.loads(report.split("```analyst-kalshi-book\n", 1)[1].split("\n```", 1)[0])
        self.assertEqual(book["atRisk"], 2852.0)
        # The book is the last section, ahead of the paper line and Sources.
        self.assertLess(report.index("## Kalshi book"), report.index("Paper tickets:"))
        self.assertGreater(report.index("## Kalshi book"), report.index("```analyst-lines"))

    def test_a_sized_setup_shows_its_position_and_line_split_under_its_section(self):
        data = board()
        gold = data["rows"][0]
        line = lambda strike, ask, moves: {"strike": strike, "buy": "NO", "ask": ask, "moves": moves, "zone": "target",
                                            "fromCentrePct": (strike / 4200 - 1) * 100, "pct": 2.2, "dollars": 134.0, "contracts": 456, "win": 322.0}
        gold["sizing"] = {
            "side": "SHORT", "pct": 4.5, "basePct": 3, "maxPct": 5.5, "volBand": "Moderate", "expanding": False,
            "event": "KXGOLDD-26OCT1217", "quotedAt": AT, "account": {"value": 6000},
            "components": [{"key": "usd", "label": "Dollar", "weight": 1, "points": 1.0, "detail": "-0.62 corr, dollar bullish"},
                           {"key": "tick", "label": "Tick", "weight": 0.5, "points": -0.5, "detail": "bullish"},
                           {"key": "volume", "label": "Volume", "weight": 0.5, "points": 0, "missing": True},
                           {"key": "zScore", "label": "Z-score", "weight": 0.5, "points": 0.25, "detail": "-1.0 sd"}],
            "ladder": {"centre": 4200.0, "sigma": 42.0}, "unspentPct": 0.1, "spentPct": 4.4,
            "lines": [line(4170, 0.28, 0.7), {**line(4160, 0.19, 0.95), "capped": True}],
            "weekly": {"event": "KXGOLDW-26OCT1617", "closes": AT, "quotedAt": AT, "ladder": {"centre": 4200.0, "sigma": 105.0},
                       "lines": [], "reason": "No size at the ask"}}
        report = render_setup_board(data)
        block = json.loads(report.split("```analyst-sizing\n", 1)[1].split("\n```", 1)[0])
        # The block sits in the setup's own section, after its market table.
        self.assertLess(report.index("## Metals"), report.index("```analyst-sizing"))
        self.assertLess(report.index("```analyst-sizing"), report.index("## Oil"))
        self.assertEqual(report.count("```analyst-sizing"), 1)
        # One ticket per duration: the daily event, then the weekly one.
        market, weekly = block["markets"]
        self.assertEqual((market["market"], market["side"], market["duration"], market["pct"], market["maxPct"], market["dollars"]),
                         ("Gold", "Short", "Daily", "4.5%", "5.5%", "$270 of $6,000"))
        self.assertEqual(market["inputs"], [{"label": "Base", "points": "3%"},
                                            {"label": "Dollar", "points": "+1", "note": "-0.62 corr, dollar bullish"},
                                            {"label": "Tick", "points": "−0.5", "note": "bullish"},
                                            {"label": "Volume", "points": "0", "note": "no reading"},
                                            {"label": "Z-score", "points": "+0.25", "note": "-1.0 sd"}])
        self.assertEqual(market["lines"][0], {"line": "Above 4,170", "from": "-0.7%", "buy": "No", "ask": "28¢",
                                              "stake": "2.2% · $134", "contracts": "456", "wins": "$322"})
        self.assertTrue(market["lines"][1]["capped"])
        self.assertEqual((market["unspent"], market["price"], market["move"], market["vol"]), ("0.1%", "4,200", "±42 (1.0%)", "Vol moderate"))
        self.assertTrue(weekly["duration"].startswith("Weekly · closes "))
        self.assertEqual((weekly["move"], weekly["reason"], weekly["lines"]), ("±105 (2.5%)", "No size at the ask", []))
        # No readable lines: the size still shows, with the reason.
        gold["sizing"] = {**gold["sizing"], "lines": [], "reason": "Kalshi lines unavailable", "account": None, "weekly": None}
        empty = json.loads(render_setup_board(data).split("```analyst-sizing\n", 1)[1].split("\n```", 1)[0])["markets"][0]
        self.assertEqual((empty["pct"], empty["reason"], empty["lines"]), ("4.5%", "Kalshi lines unavailable", []))
        # The paper ledger's running result sits above Sources.
        data["paper"] = {"tickets": 14, "open": 2, "settled": 12, "wonTickets": 7, "returnOnStake": -0.031}
        self.assertIn("Paper tickets: 12 settled, 7 won, -3.1% on stake after fees; 2 open.\n\nSources:", render_setup_board(data))
        data["paper"] = {"tickets": 1, "open": 1, "settled": 0, "wonTickets": 0, "returnOnStake": None}
        self.assertIn("Paper tickets: none settled yet; 1 open.", render_setup_board(data))
        self.assertNotIn("Paper tickets", render_setup_board(board()))
        # A board without sizing keeps its layout.
        self.assertNotIn("analyst-sizing", render_setup_board(board()))

    def test_a_broken_alpha_code_line_reads_neutral_and_says_why(self):
        data = board()
        wti = data["rows"][1]
        wti["trade"] = {"direction": "NEUTRAL", "date": "2026-11-02", "source": "Alpha Code 97"}
        wti["trend"] = "NEUTRAL"
        crossed = {"side": "below", "since": "2026-11-02T16:22:35Z", "productLabel": "Top 3 Things"}
        wti["alphaBreaks"] = {
            "trade": {**crossed, "level": 97, "published": {"value": "BULLISH", "date": "2026-10-21", "source": "The Call"}},
            "trend": {**crossed, "level": 91, "since": "2026-11-03T15:00:00Z", "published": {"value": "BULLISH", "date": "2026-11-03", "source": "Risk Ranges"}}}
        report = render_setup_board(data)
        self.assertIn("| WTI | BIAS(N/A;;) | BIAS(Neutral;;;Below the Top 3 Things Trade line 97 since Nov 2 08:22 · The Call Bullish Oct 21 "
                      "reads Neutral until reclaimed · inferred, not stated by the source) | BIAS(Neutral;;;Below the Top 3 Things Trend line 91 "
                      "since Nov 3 07:00 · Risk Ranges Bullish Nov 3 reads Neutral until reclaimed · inferred, not stated by the source) | ", report)
        # Status names the line each Neutral came from, on the day it broke.
        self.assertIn("ASOF(N/A;,;Nov 2,Alpha Code 97;Nov 3,Alpha Code 91) |", report)

    def test_withheld_price_shows_na_and_names_the_rejected_quote(self):
        data = board()
        data["rows"][0].update(price=None, position=None, priceRejected={"symbol": "GC=F", "value": 41.5},
                               setup={"side": None, "reason": "No comparable range position"})
        report = render_setup_board(data)
        self.assertIn("| Gold | BIAS(Neutral;;) | BIAS(N/A;;) | BIAS(Bearish;;) | RR(4100;4224;;0;) | "
                      "ASOF(N/A;Sep 28,HedgAI;,;Oct 9,Risk Ranges;100) |", report)
        self.assertIn("Gold price withheld: GC=F returned 41.5, inconsistent with its Risk Range.", report)

    def test_morning_research_adds_alpha_code_column_and_research_block(self):
        data = board()
        data["research"] = {"version": 1, "marketDate": "2026-10-16", "products": [
            {"key": "top-3-things", "label": "Top 3 Things", "status": "read", "publishedAt": "2026-10-16T12:31:00.000Z"},
            {"key": "the-macro-show", "label": "The Macro Show", "status": "read", "publishedAt": "2026-10-16T14:55:00.000Z"},
            {"key": "etf-pro", "label": "ETF Pro", "status": "missing"}]}
        excerpt = "UST 2yr holding TRADE/TREND Signal Supports (TREND all the way down at 4.40%)"
        data["research"]["products"] += [{"key": "risk-ranges", "label": "Risk Ranges", "status": "read", "publishedAt": "2026-10-16T11:28:00.000Z",
                                          "messageId": "1a18c949d0c80bdd"},
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
            {"product": "The Macro Show", "time": "07:55", "context": "Long U.S. Dollar (USD)", "source": "Longs: U.S. Dollar (USD), Software (IGV)", "date": "Oct 16"},
            {"product": "Real-Time Alerts", "time": "08:39", "context": "BUY SIGNAL UUP", "source": "BUY SIGNAL UUP", "date": "Oct 16"}]})
        self.assertEqual(metals["markets"][1]["entries"], [
            {"product": "The Macro Show", "time": "07:55", "context": "Gold Alpha Code 4180/4120",
             "source": "Gold Alpha Code 4180/4120; Silver at 57", "date": "Oct 16"},
            {"product": "ETF Pro", "context": "Long GLD"}])
        self.assertIn('{"market":"Ethereum","entries":[]}', report)
        # Published data reads "Label: value", with the line it was printed in as its source.
        self.assertIn('{"market":"WTI","entries":[{"product":"Risk Ranges","time":"04:28","context":"Trend: Neutral → Bullish",'
                      '"source":"Trend change: COPPER changed from Neutral to Bullish","date":"Oct 16","messageId":"1a18c949d0c80bdd",'
                      '"facts":["Trend: Neutral → Bullish"]}]}', report)
        self.assertIn('{"product":"Market Structure","time":"03:30","context":"SPX Gamma Exposure: Neutral",'
                      '"source":"Market makers remain broadly neutral.","date":"Oct 16","facts":["SPX Gamma Exposure: Neutral"]}', report)
        self.assertIn('"context":"Zero gamma: 7,736 · PV band: 7,660–7,886 · Strikes in play: 7,700, 7,750 · Gamma throttle: 0.64 · '
                      '10D realized vol: 9.63%"', report)
        # Reported data also lists one line per fact, so it reads as data rather than a sentence.
        self.assertIn('"facts":["Zero gamma: 7,736","PV band: 7,660–7,886","Strikes in play: 7,700, 7,750","Gamma throttle: 0.64",'
                      '"10D realized vol: 9.63%"]', report)
        rates = json.loads(report.split("## Rates", 1)[1].split("```analyst-research\n", 1)[1].split("\n```", 1)[0])
        # Two findings from one sentence are one mention; the board's own Risk Range is not one.
        self.assertEqual(rates["markets"], [{"market": "UST 2Y", "entries": [
            {"product": "Top 3 Things", "time": "05:31", "context": excerpt, "source": excerpt, "date": "Oct 16"}]}])
        # Each block names its section and market date, so the report can ask for the same section on another day.
        self.assertEqual((metals["section"], metals["marketDate"]), ("metals", "2026-10-16"))
        self.assertEqual(research_by_section(data)["rates"], rates)
        self.assertEqual(research_by_section({**data, "research": None}), {})
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
                          "changePct": 0.3, "signal": {"move": "DV", "tone": "supports", "direction": "up", "side": "against"}}
        gold["structure"] = {"sessions": 1, "low": {"steps": "+", "direction": 1, "run": 1},
                             "high": {"steps": "-", "direction": -1, "run": 1}, "allTimeHigh": None}
        report = render_setup_board(data)
        self.assertIn("| Market | Tick | Trade | Trend | Volume | Price and Risk Range | Structure | Status |", report)
        # An up day in gold's Bearish Trend is against it, so the windows read for a bounce to short.
        self.assertIn("| BIAS(Bearish;;) | VOL(+14;-5;-15;-21;2026-10-09;GLD;-) | RR(", report)
        self.assertIn("STRUCT(+;+1;-;-1;;;;0;;DV;supports;+) |", report)
        # A market whose volume could not be read keeps an empty token, so its row still splits.
        self.assertIn("| BIAS(Bullish;;) | VOL(;;;;;;) | RR(", report)
        self.assertNotIn("Volume", render_setup_board(board()))

    def test_cpi_lists_every_nowcast_month_with_its_kalshi_event_or_na(self):
        report = render_setup_board({"rows": [{"id": "cpi", "label": "CPI YoY", "group": "inflation",
            "events": [{"eventTicker": "KXCPIYOY-26SEP"}], "forecasts": [
                {"reportMonth": "2026-09", "available": True, "lower": 3.63, "base": 3.74, "upper": 3.85,
                 "publishedAt": "2026-10-06T11:48:50+00:00", "eventTicker": "KXCPIYOY-26SEP"},
                {"reportMonth": "2026-10", "available": True, "lower": 3.69, "base": 3.8, "upper": 3.91,
                 "publishedAt": "2026-10-06T11:48:50+00:00", "eventTicker": None}]}]})
        self.assertIn("| Market | Period | Kalshi | Low | Base | High | Published |", report)
        self.assertIn("| CPI YoY | Sep 2026 | Sep | 3.63% | 3.74% | 3.85% | Oct 6 04:48 PDT |", report)
        self.assertIn("| CPI YoY | Oct 2026 | N/A | 3.69% | 3.80% | 3.91% | Oct 6 04:48 PDT |", report)
        self.assertIn("Sources: HedgAI Signals, Cboe volatility indices, Kalshi", report)

    def test_cpi_with_survey_consensus_shows_it_in_place_of_the_kalshi_contract(self):
        report = render_setup_board({"rows": [{"id": "cpi", "label": "CPI YoY", "group": "inflation",
            "events": [{"eventTicker": "KXCPIYOY-26NOV"}], "forecasts": [
                {"reportMonth": "2026-10", "available": True, "lower": 3.77, "base": 3.88, "upper": 3.99,
                 "publishedAt": "2026-10-16T20:11:55+00:00", "eventTicker": None, "consensus": 3.7},
                {"reportMonth": "2026-11", "available": False, "eventTicker": "KXCPIYOY-26NOV", "consensus": None}]}],
            "sources": {"cpiConsensus": "2026-10-26T17:26:10.000Z"}})
        self.assertIn("| Market | Period | Consensus | Low | Base | High | Published |", report)
        self.assertIn("| CPI YoY | Oct 2026 | 3.70% | 3.77% | 3.88% | 3.99% | Oct 16 13:11 PDT |", report)
        self.assertIn("| CPI YoY | Nov 2026 | N/A | N/A | N/A | N/A | N/A |", report)
        self.assertIn("Trading Economics CPI consensus Oct 26 10:26 PDT", report)

    def test_gdp_has_its_own_section_under_cpi_with_the_quarter_as_the_period(self):
        report = render_setup_board({"rows": [
            {"id": "cpi", "label": "CPI YoY", "group": "inflation", "events": [{"eventTicker": "KXCPIYOY-26NOV"}], "forecasts": [
                {"reportMonth": "2026-11", "available": True, "lower": 3.62, "base": 3.73, "upper": 3.84,
                 "publishedAt": "2026-11-10T20:31:00+00:00", "eventTicker": "KXCPIYOY-26NOV", "consensus": None}]},
            {"id": "gdp", "label": "GDP QoQ", "group": "growth", "events": [{"eventTicker": "KXGDP-27JAN28"}], "forecasts": [
                {"reportQuarter": "2026-Q4", "available": True, "base": 2.62, "publishedAt": "2026-11-12",
                 "eventTicker": "KXGDP-27JAN28", "consensus": 2.12},
                {"reportQuarter": "2027-Q1", "available": False, "eventTicker": "KXGDP-27APR29", "consensus": None}]}],
            "sections": [{"id": "inflation", "label": "CPI"}, {"id": "growth", "label": "GDP"}],
            "sources": {"gdpOutlook": "2026-11-12", "gdpOutlookLabel": "Q4 2026 Macro Themes Mid-Quarter Update"}})
        self.assertIn("| CPI YoY | Nov 2026 | N/A | 3.62% | 3.73% | 3.84% | Nov 10 12:31 PST |\n\n## GDP\n", report)
        self.assertIn("\n".join([
            "## GDP", "",
            "| Market | Period | Consensus | Low | Base | High | Published |",
            "| --- | --- | --- | --- | --- | --- | --- |",
            "| GDP QoQ | Q4 2026 | 2.12% | N/A | 2.62% | N/A | Nov 12 |",
            "| GDP QoQ | Q1 2027 | N/A | N/A | N/A | N/A | N/A |"]), report)
        self.assertIn("Q4 2026 Macro Themes Mid-Quarter Update Nov 12", report)
        # A GDP row with nothing listed adds no line, and never joins the priced boards.
        empty = render_setup_board({"rows": [{"id": "gdp", "label": "GDP QoQ", "group": "growth", "events": [], "forecasts": []}],
                                     "sections": [{"id": "growth", "label": "GDP"}]})
        self.assertNotIn("GDP", empty)

    def test_boards_with_price_history_add_the_z_score_to_the_market_cell(self):
        data = board()
        data["usd"]["zScore"] = {"value": 0.62, "sessions": 20, "through": "2026-10-09"}
        scores = {"gold": {"value": 2.149}, "nasdaq100": {"value": -1.04}, "wti": None}
        for row in data["rows"]:
            row["zScore"] = scores.get(row["id"], {"value": 0.0})
        report = render_setup_board(data)
        self.assertIn("| REF(US Dollar;DXY;+0.6) |", report)
        self.assertIn("| NAME(Gold;;+2.1) | BIAS(Neutral;;) |", report)
        self.assertIn("| MKT(Nasdaq-100;COMPQ range;-1.0) |", report)
        # A market without enough history keeps its row with the score unavailable.
        self.assertIn("| NAME(WTI;;) |", report)
        # Every other column is unchanged.
        self.assertIn("| Market | Tick | Trade | Trend | Price and Risk Range | Status |", report)

    def test_sources_line_gives_every_publication_the_same_date_and_time(self):
        ranged = [{"id": "gold", "label": "Gold", "group": "metals", "range": {"low": 4100, "high": 4224}},
                  {"id": "bitcoin", "label": "Bitcoin", "group": "crypto", "range": {"low": 1, "high": 2, "product": "crypto-quant"}}]
        report = render_setup_board({"rows": ranged, "sources": {
            "riskRanges": "2026-10-15T11:37:00.000Z", "cryptoQuant": "2026-10-15T11:40:00.000Z",
            "inflationNowcast": "2026-10-14T13:29:20+00:00"}})
        self.assertIn("Sources: Risk Ranges Oct 15 04:37 PDT, Crypto Quant Oct 15 04:40 PDT, "
                      "Inflation Nowcast Oct 14 06:29 PDT, HedgAI Signals", report)
        # A publication with only a date keeps its date; no time is invented.
        self.assertIn("Sources: Risk Ranges Oct 15, HedgAI", render_setup_board({"rows": ranged[:1], "sources": {"riskRanges": "2026-10-15"}}))
        # A product feed the body never draws on is not a source.
        self.assertIn("Sources: HedgAI", render_setup_board({"rows": [], "sources": {"riskRanges": "2026-10-15"}}))

    def test_sources_name_every_product_the_review_cites(self):
        data = board()
        data["research"] = {"version": 1, "marketDate": "2026-11-05", "products": [
            {"key": "top-3-things", "label": "Top 3 Things", "status": "read", "publishedAt": "2026-11-05T13:44:00.000Z"},
            {"key": "early-look", "label": "Early Look", "status": "read", "publishedAt": "2026-11-05T12:44:00.000Z"},
            {"key": "the-macro-show", "label": "The Macro Show", "status": "missing"},
            {"key": "the-call", "label": "The Call", "status": "read", "publishedAt": "2026-11-05T14:35:00.000Z"},
            {"key": "real-time-alert", "label": "Real-Time Alerts", "status": "read", "publishedAt": "2026-11-05T15:39:00.000Z"},
            {"key": "etf-pro", "label": "ETF Pro", "status": "missing"},
            {"key": "market-structure", "label": "Market Structure", "status": "read", "publishedAt": "2026-11-05T11:30:30+00:00"},
            {"key": "risk-ranges", "label": "Risk Ranges", "status": "read", "publishedAt": "2026-11-05T14:07:00.000Z"}]}
        gold, wti, nasdaq, ust2y = data["rows"][:4]
        # Quoted prose, a product's position and published data each cite their product.
        gold["research"] = {"findings": [
            {"product": "early-look", "productLabel": "Early Look", "kind": "mention", "fit": "exact",
             "excerpt": "Gold remains Bearish TREND", "context": "Gold remains Bearish TREND"},
            {"product": "etf-pro", "productLabel": "ETF Pro", "kind": "position", "side": "Short", "fit": "proxy", "instrumentLabel": "GLD"}]}
        nasdaq["research"] = {"findings": [
            {"product": "market-structure", "productLabel": "Market Structure", "kind": "structure", "fit": "exact",
             "signals": [{"label": "SPX Gamma Exposure", "value": "Neutral"}], "sourceText": "Market makers remain neutral."}]}
        ust2y["research"] = {"alphaCode": {"trade": 4.6, "trend": 4.5, "productLabel": "The Call", "unit": "%"}, "findings": []}
        # Trade columns name their product, older editions included; the Macro Show is one product however it is spelled.
        data["usd"]["trade"] = {"direction": "BULLISH", "date": "2026-10-28", "source": "Macro Show"}
        gold["trade"] = {"direction": "BEARISH", "date": "2026-11-02", "source": "Early Look"}
        wti["trade"] = {"direction": "NEUTRAL", "date": "2026-11-04", "source": "Alpha Code 97"}
        wti["alphaBreaks"] = {"trade": {"side": "below", "level": 97, "since": "2026-11-04T16:22:35Z", "productLabel": "Top 3 Things",
                                        "published": {"value": "BULLISH", "date": "2026-10-21", "source": "The Call"}}}
        report = render_setup_board(data)
        body, sources = report.split("\nSources: ", 1)
        sources = sources.split("\n", 1)[0].split(", ")
        listed = {_product_key(re.sub(r" [A-Z][a-z]{2} \d{1,2}(?: \d{2}:\d{2} P[DS]T)?$", "", item)) for item in sources}

        # Every product the body names, read back from the rendered report itself.
        named = set()
        for block in re.findall(r"```analyst-research\n(.*?)\n```", body):
            named |= {entry["product"] for market in json.loads(block)["markets"] for entry in market["entries"]}
        named |= {fields[9] for fields in (token.split(";") for token in re.findall(r"RR\(([^)]*)\)", body)) if len(fields) == 10 and fields[9]}
        for token in re.findall(r"ASOF\(([^)]*)\)", body):
            named |= {part.split(",", 1)[1] for part in token.split(";")[1:]
                      if "," in part and part.split(",", 1)[1] and not part.split(",", 1)[1].startswith(("HedgAI", "Alpha Code"))}
        for note in re.findall(r"BIAS\([^;]*;;;([^)]*)\)", body):
            named |= set(re.findall(r"the (.+?) (?:Trade|Trend) line", note)) | set(re.findall(r" · (.+?) (?:Bullish|Bearish|Neutral) ", note))
        self.assertTrue({"Early Look", "ETF Pro", "Market Structure", "The Call", "Macro Show", "Top 3 Things", "Risk Ranges"} <= named)
        missing = sorted(name for name in named if _product_key(name) not in listed)
        self.assertEqual(missing, [], f"cited in the review but missing from Sources: {missing}")
        # Nothing the review did not use: Real-Time Alerts was read this morning but cited nowhere.
        self.assertNotIn("Real-Time Alerts", ", ".join(sources))
        self.assertEqual([item for item in sources if "Macro Show" in item], ["The Macro Show Oct 28"])
        self.assertIn("Early Look Nov 5 04:44 PST", sources)
        self.assertIn("ETF Pro", sources)

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
        # The Dollar's Trade cites the Macro Show, so it lists where the aggregate Trade research row stood.
        self.assertEqual(list(items), ["risk-ranges", "crypto-quant", "hedgai-signals", "macro-show",
                                       "inflation-nowcast", "marketPrices", "volatilityIndices", "usdCorrelations", "kalshiContracts"])
        self.assertEqual(items["risk-ranges"]["status"], "ready")
        self.assertEqual(items["risk-ranges"]["publishedAt"], "2026-10-09")
        self.assertEqual(items["inflation-nowcast"]["status"], "unavailable")
        self.assertNotIn("ibGateway", items)

    def test_sources_date_a_product_by_its_newest_edition_received(self):
        data = board()
        data["research"] = {"version": 1, "marketDate": "2026-10-10", "products": [
            {"key": "the-macro-show", "label": "The Macro Show", "status": "missing", "latestEdition": "2026-10-09T15:25:00.000Z"},
            {"key": "top-3-things", "label": "Top 3 Things", "status": "missing", "latestEdition": "2026-10-02T13:30:00.000Z"}]}
        # Trade cells keep their own edition; a cited edition newer than the record is not overridden.
        data["usd"]["trade"] = {"direction": "BULLISH", "date": "2026-10-06", "publishedAt": "2026-10-06T15:45:00.000Z", "source": "Macro Show"}
        data["rows"][1]["trade"] = {"direction": "BEARISH", "date": "2026-10-05", "publishedAt": "2026-10-05T13:30:00.000Z", "source": "Top 3 Things"}
        items = self.project({"predictionBoard": {"status": "ready", "updatedAt": AT}}, {"predictionBoard": data})
        self.assertEqual(items["the-macro-show"]["publishedAt"], "2026-10-09T15:25:00.000Z")
        self.assertEqual(items["top-3-things"]["publishedAt"], "2026-10-05T13:30:00.000Z")
        self.assertEqual(data["usd"]["trade"]["publishedAt"], "2026-10-06T15:45:00.000Z")

    def test_sources_panel_lists_every_product_the_review_cites(self):
        data = board()
        data["research"] = {"version": 1, "marketDate": "2026-10-10", "products": [
            {"key": "top-3-things", "label": "Top 3 Things", "status": "read", "publishedAt": "2026-10-10T13:44:00.000Z"},
            {"key": "early-look", "label": "Early Look", "status": "read", "publishedAt": "2026-10-10T12:44:00.000Z"},
            {"key": "the-macro-show", "label": "The Macro Show", "status": "missing"},
            {"key": "real-time-alert", "label": "Real-Time Alerts", "status": "read", "publishedAt": "2026-10-10T15:39:00.000Z"}]}
        data["usd"]["trade"] = {"direction": "BULLISH", "date": "2026-10-03", "source": "Macro Show"}
        data["rows"][0]["research"] = {"findings": [{"product": "early-look", "productLabel": "Early Look", "kind": "mention",
                                                     "fit": "exact", "excerpt": "Gold remains Bearish TREND"}]}
        data["rows"][1]["trade"] = {"direction": "BEARISH", "date": "2026-10-09", "source": "Top 3 Things"}
        items = self.project({"predictionBoard": {"status": "ready", "updatedAt": AT}}, {"predictionBoard": data})
        self.assertEqual(list(items)[3:6], ["top-3-things", "early-look", "the-macro-show"])
        self.assertEqual({key: (items[key]["label"], items[key]["status"], items[key].get("publishedAt")) for key in list(items)[3:6]}, {
            # Cited only by an Oct 9 Trade, but this morning's edition was read: the row dates what was pulled.
            "top-3-things": ("Top 3 Things", "ready", "2026-10-10T13:44:00.000Z"),
            "early-look": ("Early Look", "ready", "2026-10-10T12:44:00.000Z"),
            "the-macro-show": ("The Macro Show", "ready", "2026-10-03")})
        # Read this morning but cited nowhere in the review: not a source.
        self.assertNotIn("real-time-alert", items)
        self.assertNotIn("tradeResearch", items)
        # Not published yet today: the cited edition, at its send time when the Trade carries one.
        data["usd"]["trade"]["publishedAt"] = "2026-10-03T14:26:00.000Z"
        timed = self.project({"predictionBoard": {"status": "ready", "updatedAt": AT}}, {"predictionBoard": data})
        self.assertEqual(timed["the-macro-show"]["publishedAt"], "2026-10-03T14:26:00.000Z")
        del data["usd"]["trade"]["publishedAt"]
        # A failed Trade feed still shows, beside the products the review could cite.
        data["sourceStatus"]["securityIntelligence"] = "failed"
        failed = self.project({"predictionBoard": {"status": "partial", "updatedAt": AT}}, {"predictionBoard": data})
        self.assertEqual(failed["tradeResearch"]["status"], "unavailable")
        self.assertIn("early-look", failed)

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
