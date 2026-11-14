"""One table carries today's move and same-day Risk Range location for held stocks and ETFs."""

from datetime import datetime
import unittest
from zoneinfo import ZoneInfo

import httpx

from portfolio_capture import PORTFOLIO_POSITION_COLUMNS
from position_session import PositionSessionReader, SESSION_COLUMNS, range_location

NOW = datetime(2026, 11, 13, 15, 4, tzinfo=ZoneInfo("America/New_York"))


def position(symbol, con_id, quantity, price, *, sec_type="STK", mark_state="live"):
    row = dict.fromkeys(PORTFOLIO_POSITION_COLUMNS)
    row.update(account="U1", symbol=symbol, conId=con_id, quantity=quantity, secType=sec_type,
               markState=mark_state, valuationPrice=price)
    return [row[name] for name in PORTFOLIO_POSITION_COLUMNS]


def portfolio(rows, live=True):
    return {"status": "available", "liveVerified": live, "data": {
        "accounts": ["U1"],
        "positionTable": {"columns": list(PORTFOLIO_POSITION_COLUMNS), "rows": rows, "rowCount": len(rows)}}}


def marks(*items):
    return [{"ok": True, "marks": [
        {"conId": con_id, "referenceClose": close, "referenceCloseSessionDate": session,
         "previousClose": previous, "previousCloseSessionDate": "2026-11-12"}
        for con_id, close, session, previous in items]}]


def intelligence(ranges, *, market_date="2026-11-13", state="complete"):
    by_symbol = {}
    for symbol, product, low, high, dated, match in ranges:
        by_symbol.setdefault(symbol, {"products": {}})["products"][product] = {
            "label": product.title(), "fields": {"riskRange": {
                "value": {"lrr": low, "hrr": high}, "marketDate": dated, "matchType": match}}}
    return {"marketDate": market_date, "coverage": {"state": state}, "bySymbol": by_symbol}


class PositionSessionTests(unittest.IsolatedAsyncioTestCase):
    async def attach(self, projected, reference, ranges, *, range_status=200, quotes=None, weekly=None, sectors=None, fit=None):
        requested = []
        fit_requests = self.fit_requests = []

        def handle(request):
            if request.url.path == "/api/analyst/sector-fit":
                fit_requests.append(request.url.params["pairs"])
                return httpx.Response(200 if fit is not None else 503, json=fit or {})
            if request.url.path == "/api/hedgeye/etfpro":
                return httpx.Response(200 if weekly else 503, json=weekly or {})
            requested.append(request.url)
            if request.url.path == "/api/quotes":
                return httpx.Response(200, json=quotes or {})
            return httpx.Response(range_status, json=ranges)

        async def closes(accounts):
            self.assertEqual(accounts, ["U1"])
            if isinstance(reference, Exception):
                raise reference
            return reference

        async def sector_lookup(symbols):
            return {symbol: sectors[symbol] for symbol in symbols if symbol in sectors}

        reader = PositionSessionReader(
            "http://api.test", closes, now=lambda: NOW, sectors=sector_lookup if sectors is not None else None,
            client_factory=lambda **kwargs: httpx.AsyncClient(transport=httpx.MockTransport(handle), **kwargs))
        result = await reader.attach(projected)
        return result, requested

    def rows(self, result):
        table = result["data"]["sessionTable"]
        self.assertEqual(table["columns"], SESSION_COLUMNS)
        return {row[0]: dict(zip(SESSION_COLUMNS, row)) for row in table["rows"]}

    async def test_short_up_over_two_percent_at_top_of_same_day_range(self):
        projected = portfolio([
            position("HUBS", 1, -10, 220.0), position("XLV", 2, 50, 189.0),
            position("KXCPI", 3, 5, 0.4, sec_type="OPT"),
        ])
        ranges = intelligence([
            ("HUBS", "risk-ranges", 200, 222, "2026-11-13", "direct"),
            ("XLV", "risk-ranges", 183, 192, "2026-11-12", "direct"),
        ])
        result, requested = await self.attach(
            projected, marks((1, 215.0, "2026-11-12", 210.0), (2, 187.83, "2026-11-12", 186.0)), ranges)
        rows = self.rows(result)
        self.assertEqual(set(rows), {"HUBS", "XLV"})
        self.assertEqual(requested[0].params["symbols"], "HUBS,XLV")
        hubs = rows["HUBS"]
        self.assertEqual((hubs["side"], hubs["priorClose"], hubs["priorCloseDate"]), ("short", 215.0, "2026-11-12"))
        self.assertEqual(hubs["dayChangePct"], 2.33)
        self.assertEqual((hubs["rangeLow"], hubs["rangeHigh"], hubs["rangeZone"]), (200, 222, "top"))
        self.assertEqual((hubs["rangePct"], hubs["rangeSource"], hubs["rangeProxy"]), (90.9, "Risk-Ranges", None))
        # A range dated another session is not today's range.
        self.assertIsNone(rows["XLV"]["rangeLow"])
        self.assertIsNone(rows["XLV"]["rangeZone"])
        self.assertEqual(result["data"]["sessionTable"]["rangeCount"], 1)
        # The original position table is untouched.
        self.assertEqual(result["data"]["positionTable"], projected["data"]["positionTable"])

    async def test_any_product_range_counts_and_the_daily_sheet_leads(self):
        projected = portfolio([position("MARA", 1, -10, 7.0), position("RSP", 2, 10, 221.0)])
        ranges = intelligence([
            ("MARA", "bitcoin-trend-tracker", 5.67, 7.99, "2026-11-13", "direct"),
            ("RSP", "early-look", 210, 230, "2026-11-13", "direct"),
            ("RSP", "risk-ranges", 216, 225, "2026-11-13", "direct"),
        ])
        rows = self.rows((await self.attach(projected, marks(), ranges))[0])
        self.assertEqual((rows["MARA"]["rangeLow"], rows["MARA"]["rangeSource"]), (5.67, "Bitcoin-Trend-Tracker"))
        self.assertEqual((rows["RSP"]["rangeLow"], rows["RSP"]["rangeSource"]), (216, "Risk-Ranges"))

    async def test_index_scaled_alias_is_placed_by_the_proxy_level_and_labelled(self):
        projected = portfolio([position("IWM", 1, -10, 277.5), position("QQQ", 2, -5, 680.0)])
        ranges = intelligence([
            # The sheet prints the Russell at index level; on IWM it is not an exact match.
            ("IWM", "risk-ranges", 2707, 2860, "2026-11-13", "direct_alias"),
            ("RUT", "risk-ranges", 2707, 2860, "2026-11-13", "direct"),
            ("COMPQ", "risk-ranges", 24108, 25844, "2026-11-13", "direct"),
        ])
        quotes = {"RUT": {"price": "2786.16", "observedAt": "2026-11-13T20:00:00Z"},
                  "COMPQ": {"price": "25138.99", "observedAt": "2026-11-10T20:00:00Z"}}
        result, requested = await self.attach(projected, marks(), ranges, quotes=quotes)
        self.assertEqual({url.path: url.params["symbols"] for url in requested}, {
            "/api/research/security-intelligence/v2": "COMPQ,IWM,QQQ,RUT", "/api/quotes": "COMPQ,RUT"})
        rows = self.rows(result)
        iwm = rows["IWM"]
        self.assertEqual((iwm["rangeProxy"], iwm["rangeProxyLevel"], iwm["rangeLow"]), ("RUT", 2786.16, 2707))
        self.assertEqual((iwm["rangePct"], iwm["rangeZone"]), (51.7, "middle"))
        # A stale proxy level places nothing; the proxy's range is still shown.
        qqq = rows["QQQ"]
        self.assertEqual((qqq["rangeProxy"], qqq["rangeLow"], qqq["rangePct"], qqq["rangeZone"]), ("COMPQ", 24108, None, None))
        self.assertEqual(result["data"]["sessionTable"]["proxyRangeCount"], 2)

    async def test_etf_pro_range_counts_only_on_the_first_session_after_its_edition(self):
        projected = portfolio([
            position("XLI", 1, -10, 167.0), position("XLV", 2, 10, 189.0),
            position("IWM", 3, -10, 277.0), position("BRKB", 4, 5, 500.0),
        ])
        ranges = intelligence([
            ("XLV", "risk-ranges", 183, 192, "2026-11-13", "direct"),
            ("RUT", "risk-ranges", 2707, 2860, "2026-11-13", "direct"),
        ])
        rows = [{"ticker": "XLI", "trendLowEnd": 158, "trendHighEnd": 170},
                {"ticker": "XLV", "trendLowEnd": 176, "trendHighEnd": 191},
                {"ticker": "IWM", "trendLowEnd": 265, "trendHighEnd": 283},
                {"ticker": "BRKB", "trendLowEnd": 40, "trendHighEnd": 44},
                {"ticker": "XHB", "trendLowEnd": None, "trendHighEnd": None}]
        quotes = {"RUT": {"price": "2786.16", "observedAt": "2026-11-13T20:00:00Z"}}

        def book(edition, current=True):
            return {"available": True, "current": current, "meta": {"baseSnapshotDate": edition}, "rows": rows}

        # NOW is Friday 2026-11-13. An edition dated that day is in its one session.
        result, _ = await self.attach(projected, marks(), ranges, quotes=quotes, weekly=book("2026-11-13"))
        found = self.rows(result)
        xli = found["XLI"]
        self.assertEqual((xli["rangeLow"], xli["rangeHigh"], xli["rangeDate"]), (158, 170, "2026-11-13"))
        self.assertEqual((xli["rangeSource"], xli["rangePct"], xli["rangeZone"]), ("ETF Pro", 75.0, "top"))
        # Another product's range, own or by proxy, always leads.
        self.assertEqual((found["XLV"]["rangeSource"], found["XLV"]["rangeLow"]), ("Risk-Ranges", 183))
        self.assertEqual(found["IWM"]["rangeProxy"], "RUT")
        # A range on another scale is shown but places nothing.
        self.assertEqual((found["BRKB"]["rangeLow"], found["BRKB"]["rangePct"], found["BRKB"]["rangeZone"]), (40, None, None))
        self.assertEqual(result["data"]["sessionTable"]["etfProRangeCount"], 2)

        # Sunday's edition stood for Monday; by Friday it is gone. So is a non-current book.
        for stale in (book("2026-11-08"), book("2026-11-12"), book("2026-11-13", current=False)):
            found = self.rows((await self.attach(projected, marks(), ranges, quotes=quotes, weekly=stale))[0])
            self.assertIsNone(found["XLI"]["rangeLow"])
            self.assertIsNone(found["XLI"]["rangeSource"])

    def test_a_weekend_edition_stands_for_monday(self):
        from position_session import _etf_pro_ranges
        book = {"available": True, "current": True, "meta": {"baseSnapshotDate": "2026-11-08"},
                "rows": [{"ticker": "XLI", "trendLowEnd": 158, "trendHighEnd": 170}]}
        self.assertEqual(_etf_pro_ranges(book, "2026-11-09")["XLI"]["date"], "2026-11-09")
        self.assertEqual(_etf_pro_ranges(book, "2026-11-10"), {})

    async def test_stock_without_a_range_borrows_its_sector_etf_range_labelled_as_sector(self):
        projected = portfolio([
            position("SAIA", 1, -5, 339.0), position("JACK", 2, -5, 14.8), position("HUBS", 3, -5, 220.0),
            position("IWM", 4, -5, 277.0),
        ])
        ranges = intelligence([
            ("XLI", "risk-ranges", 158, 170, "2026-11-13", "direct"),
            ("HUBS", "risk-ranges", 200, 222, "2026-11-13", "direct"),
            ("RUT", "risk-ranges", 2707, 2860, "2026-11-13", "direct"),
        ])
        quotes = {"XLI": {"price": "167.00", "observedAt": "2026-11-13T20:00:00Z"},
                  "RUT": {"price": "2786.16", "observedAt": "2026-11-13T20:00:00Z"}}
        sectors = {"SAIA": {"sector": "Industrials", "etf": "XLI"}, "JACK": {"sector": "Consumer Cyclical", "etf": "XLY"},
                   "HUBS": {"sector": "Information Technology", "etf": "XLK"}}
        fit = {"rows": [
            {"symbol": "SAIA", "etf": "XLI", "correlations": {"90": {"value": 0.7149}}, "best": {"etf": "XLI"}, "review": False},
            {"symbol": "JACK", "etf": "XLY", "correlations": {"90": {"value": 0.31}}, "best": {"etf": "XLP"}, "review": True},
        ]}
        result, requested = await self.attach(projected, marks(), ranges, quotes=quotes, sectors=sectors, fit=fit)
        self.assertIn("XLI", requested[0].params["symbols"].split(","))
        self.assertEqual(self.fit_requests, ["HUBS:XLK,JACK:XLY,SAIA:XLI"])
        rows = self.rows(result)
        saia = rows["SAIA"]
        self.assertEqual((saia["sector"], saia["sectorEtf"]), ("Industrials", "XLI"))
        self.assertEqual((saia["rangeProxy"], saia["rangeProxyKind"], saia["rangeLow"], saia["rangeProxyLevel"]),
                         ("XLI", "sector", 158, 167.0))
        self.assertEqual((saia["rangePct"], saia["rangeZone"]), (75.0, "top"))
        # A sector with no range that session leaves the range empty; the sector is still named.
        jack = rows["JACK"]
        self.assertEqual((jack["sector"], jack["sectorEtf"], jack["rangeLow"], jack["rangeProxy"], jack["rangeProxyKind"]),
                         ("Consumer Cyclical", "XLY", None, None, None))
        # The stock's own range leads its sector's, and a tracking proxy is labelled as one.
        self.assertEqual((rows["HUBS"]["rangeLow"], rows["HUBS"]["rangeProxy"]), (200, None))
        self.assertEqual((rows["IWM"]["rangeProxy"], rows["IWM"]["rangeProxyKind"], rows["IWM"]["sector"]), ("RUT", "tracks", None))
        self.assertEqual((saia["sectorCorr90"], saia["sectorBetterFit"]), (0.71, None))
        self.assertEqual((jack["sectorCorr90"], jack["sectorBetterFit"]), (0.31, "XLP"))
        table = result["data"]["sessionTable"]
        self.assertEqual((table["sectorCount"], table["sectorProxyRangeCount"]), (3, 1))

    async def test_sector_range_is_not_borrowed_without_a_measured_fit(self):
        projected = portfolio([position("SAIA", 1, -5, 339.0)])
        ranges = intelligence([("XLI", "risk-ranges", 158, 170, "2026-11-13", "direct")])
        quotes = {"XLI": {"price": "167.00", "observedAt": "2026-11-13T20:00:00Z"}}
        sectors = {"SAIA": {"sector": "Industrials", "etf": "XLI"}}
        weak = {"rows": [{"symbol": "SAIA", "etf": "XLI", "correlations": {"90": {"value": 0.42}}, "review": False}]}
        for fit in (weak, None, {"rows": [{"symbol": "SAIA", "etf": "XLK", "correlations": {"90": {"value": 0.9}}}]}):
            row = self.rows((await self.attach(projected, marks(), ranges, quotes=quotes, sectors=sectors, fit=fit))[0])["SAIA"]
            self.assertEqual((row["sector"], row["rangeLow"], row["rangeProxy"]), ("Industrials", None, None))

    async def test_after_the_close_the_prior_session_close_is_used(self):
        result, _ = await self.attach(
            portfolio([position("CAT", 1, 5, 303.0)]), marks((1, 303.0, "2026-11-13", 300.0)), intelligence([]))
        row = self.rows(result)["CAT"]
        self.assertEqual((row["priorClose"], row["priorCloseDate"], row["dayChangePct"]), (300.0, "2026-11-12", 1.0))

    async def test_missing_inputs_leave_cells_empty_and_never_fail_the_portfolio(self):
        projected = portfolio([position("JACK", 1, -5, 14.77), position("VFC", 2, -5, 20.7, mark_state="unavailable")])
        result, _ = await self.attach(projected, RuntimeError("closes down"), {}, range_status=503)
        rows = self.rows(result)
        self.assertEqual(rows["JACK"]["price"], 14.77)
        for key in ("priorClose", "dayChangePct", "rangeLow", "rangePct", "rangeZone", "rangeSource", "rangeProxy"):
            self.assertIsNone(rows["JACK"][key])
        # An unvalued mark never supplies a price.
        self.assertIsNone(rows["VFC"]["price"])
        table = result["data"]["sessionTable"]
        self.assertFalse(table["rangeCoverageComplete"])
        self.assertIn("range read itself failed", table["notes"][-1])

    async def test_unverified_portfolio_gets_no_session_table(self):
        projected = portfolio([position("JACK", 1, -5, 14.77)], live=False)
        result, requested = await self.attach(projected, marks(), {})
        self.assertIs(result, projected)
        self.assertEqual(requested, [])

    def test_zones_match_the_dashboard_risk_range_watch(self):
        for price, zone in ((99, "below"), (100, "bottom"), (103.3, "bottom"), (105, "middle"),
                            (106.6, "top"), (110, "top"), (111, "above")):
            self.assertEqual(range_location(price, 100, 110)[1], zone, price)


if __name__ == "__main__":
    unittest.main()
