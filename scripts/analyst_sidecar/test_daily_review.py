"""The Daily Review sheet is arithmetic on captured evidence; a missing input leaves a gap, never a guess."""

import json
import unittest

from daily_review import (
    BLOCK, account_pnl, build_attribution, build_daily_review, build_market, normalize_executions,
    exit_closes, render_daily_review, review_session, session_day, session_move,
)

DAY = "2026-11-20"
AS_OF = "2026-11-20T21:10:00Z"


def position(symbol, con_id, quantity, price, *, sec_type="STK", mark_state="live", multiplier=1, category="stock"):
    return {"account": "U1", "symbol": symbol, "contract": symbol, "conId": con_id, "category": category,
            "quantity": quantity, "markState": mark_state, "valuationPrice": price,
            "marketValue": quantity * price * multiplier if mark_state == "live" else None,
            "secType": sec_type, "securityName": f"{symbol} Inc"}


def metrics(positions, *, nlv=100_000.0, pnl=None):
    long_value = sum(row["marketValue"] for row in positions if (row["marketValue"] or 0) > 0)
    short_value = sum(row["marketValue"] for row in positions if (row["marketValue"] or 0) < 0)
    return {"available": True, "accountIds": ["U1"], "positionCount": len(positions), "positions": positions,
            "netLiquidation": nlv, "longMarketValue": long_value, "shortMarketValue": short_value,
            "grossExposure": long_value - short_value, "netExposure": long_value + short_value,
            "pnl": [{"account": "U1", "observedAt": AS_OF, "pnl": pnl}] if pnl else []}


def fill(exec_id, con_id, symbol, side, shares, price, *, time="2026-11-20T15:00:00Z", commission=1.0, realized=0.0, sec_type="STK"):
    return {"execId": exec_id, "conId": con_id, "symbol": symbol, "secType": sec_type, "side": side, "shares": shares,
            "price": price, "executionTime": time, "commission": commission, "realizedPNL": realized}


def executions(*rows):
    return {"ok": True, "liveVerified": True, "complete": True, "from_cache": False, "source": "ibkr_executions",
            "executions": list(rows)}


def bars(today, previous, *, day=DAY, before="2026-11-19"):
    return {"status": "available", "provider": "yfinance", "asOf": AS_OF,
            "data": {"results": [{"date": before, "close": previous}, {"date": day, "close": today}]}}


def quote(symbol, price, previous, observed="2026-11-20T21:00:00Z"):
    return {"symbol": symbol, "price": str(price), "previousClose": str(previous), "observedAt": observed, "source": "yahoo"}


class DailyReviewTest(unittest.TestCase):
    def test_position_and_trading_pnl_reconcile_to_the_cash_identity(self):
        # 100 held at a 50 close, 50 more bought at 52, marked 55: 150*55 - 100*50 - 50*52 = 650.
        book = metrics([position("AAA", 1, 150, 55.0)])
        fills = normalize_executions(executions(fill("e1", 1, "AAA", "BOT", 50, 52.0)), DAY)
        result = build_attribution(book, {1: (50.0, "2026-11-19")}, fills)
        row = result["rows"][0]
        self.assertAlmostEqual(row["positionPnl"], 500.0)
        self.assertAlmostEqual(row["tradingPnl"], 150.0)
        self.assertAlmostEqual(row["pnl"], 650.0)
        self.assertEqual(result["trades"][0]["action"], "Add")
        self.assertAlmostEqual(result["trades"][0]["netPctNlv"], 2.6)

    def test_a_short_gains_when_its_price_falls_and_a_cover_is_named(self):
        book = metrics([position("BBB", 2, -50, 18.0)])
        fills = normalize_executions(executions(fill("e1", 2, "BBB", "BOT", 50, 19.0)), DAY)
        result = build_attribution(book, {2: (20.0, "2026-11-19")}, fills)
        row = result["rows"][0]
        self.assertEqual(row["side"], "short")
        self.assertAlmostEqual(row["positionPnl"], 200.0)  # -100 carried, 20 -> 18
        self.assertAlmostEqual(row["tradingPnl"], -50.0)   # 50 bought at 19, now 18
        self.assertEqual(result["trades"][0]["action"], "Cover part")

    def test_a_position_sold_out_today_is_measured_against_its_prior_close(self):
        fills = normalize_executions(executions(fill("e1", 3, "CCC", "SLD", 100, 31.0, realized=250.0)), DAY)
        result = build_attribution(metrics([]), {}, fills, {"CCC": 30.0})
        self.assertAlmostEqual(result["rows"][0]["pnl"], 100.0)
        trade = result["trades"][0]
        self.assertEqual((trade["action"], trade["realized"]), ("Exit", 250.0))
        # Without the sold security's prior close nothing is attributed to it.
        self.assertEqual(build_attribution(metrics([]), {}, fills)["unpriced"], ["CCC"])

    def test_a_new_position_needs_no_prior_close_and_a_held_one_without_it_is_left_out(self):
        book = metrics([position("NEW", 4, 10, 105.0), position("OLD", 5, 10, 50.0)])
        fills = normalize_executions(executions(fill("e1", 4, "NEW", "BOT", 10, 100.0)), DAY)
        result = build_attribution(book, {}, fills)
        self.assertEqual([row["symbol"] for row in result["rows"]], ["NEW"])
        self.assertAlmostEqual(result["rows"][0]["pnl"], 50.0)
        self.assertEqual(result["unpriced"], ["OLD"])
        self.assertEqual(result["trades"][0]["action"], "New long")

    def test_option_pnl_uses_the_contract_multiplier_from_the_valued_position(self):
        book = metrics([position("AAA", 6, 2, 3.0, sec_type="OPT", multiplier=100)])
        result = build_attribution(book, {6: (2.5, "2026-11-19")}, [])
        self.assertAlmostEqual(result["rows"][0]["pnl"], 100.0)

    def test_unverified_fills_mark_the_book_as_held_and_show_no_trading(self):
        book = metrics([position("AAA", 1, 100, 55.0)], pnl={"dailyPnL": 480.0, "realizedPnL": 0.0, "unrealizedPnL": 900.0})
        sheet = build_daily_review(as_of=AS_OF, market_date=DAY, metrics=book, closes={1: (50.0, "2026-11-19")}, executions=None)
        self.assertEqual(sheet["trading"]["status"], "unavailable")
        self.assertEqual(sheet["pnl"]["attributionBasis"], "held-all-day")
        self.assertIsNone(sheet["pnl"]["tradingPnl"])
        self.assertIsNone(sheet["pnl"]["unattributed"])
        self.assertTrue(any("fills could not be verified" in note for note in sheet["notes"]))

    def test_executions_are_rejected_unless_live_complete_and_well_formed(self):
        good = executions(fill("e1", 1, "AAA", "BOT", 5, 10.0))
        self.assertEqual(len(normalize_executions(good, DAY)), 1)
        for change in ({"complete": False}, {"from_cache": True}, {"liveVerified": False}, {"source": "cache"}):
            self.assertIsNone(normalize_executions({**good, **change}, DAY))
        self.assertIsNone(normalize_executions(executions({**fill("e1", 1, "AAA", "BOT", 5, 10.0), "side": "?"}), DAY))
        # A fill dated another session is not today's.
        old = executions(fill("e0", 1, "AAA", "BOT", 5, 10.0, time="2026-11-19T15:00:00Z"))
        self.assertEqual(normalize_executions(old, DAY), [])

    def test_blank_account_pnl_is_not_a_flat_day(self):
        book = [position("AAA", 1, 100, 55.0)]
        self.assertIsNone(account_pnl(metrics(book, pnl={"dailyPnL": 0.0, "realizedPnL": 0.0, "unrealizedPnL": 0.0})))
        self.assertIsNone(account_pnl(metrics(book)))
        self.assertEqual(account_pnl(metrics(book, pnl={"dailyPnL": -12.5, "realizedPnL": 0.0, "unrealizedPnL": 3.0}))["daily"], -12.5)

    def test_headline_prefers_ibkr_and_falls_back_to_complete_attribution(self):
        book = [position("AAA", 1, 100, 55.0)]
        closes = {1: (50.0, "2026-11-19")}
        comparison = {"status": "available", "baselineAsOf": "2026-11-19T21:05:00Z", "baselineSessionDate": "2026-11-19", "metrics": {
            "netLiquidation": {"previous": 99_000.0, "current": 100_000.0}, "grossExposure": {"previous": 5_000.0, "current": 5_500.0},
            "longMarketValue": {"previous": 5_000.0, "current": 5_500.0}, "shortMarketValue": {"previous": 0.0, "current": 0.0},
            "netExposure": {"previous": 5_000.0, "current": 5_500.0}}}
        with_ibkr = build_daily_review(as_of=AS_OF, market_date=DAY, executions=[], closes=closes, comparison=comparison,
            metrics=metrics(book, pnl={"dailyPnL": 480.0, "realizedPnL": 0.0, "unrealizedPnL": 900.0}),
            histories={"SPY": bars(101.0, 100.0)})
        head = with_ibkr["headline"]
        self.assertEqual((head["dayPnl"], head["basis"], head["pctBasis"]), (480.0, "ibkr-account", "prior-close-nlv"))
        self.assertAlmostEqual(head["dayPnlPct"], 480 / 99_000 * 100)
        self.assertAlmostEqual(head["vsBenchmarkPct"], 480 / 99_000 * 100 - 1.0)
        self.assertAlmostEqual(head["nlvChange"], 1_000.0)
        self.assertAlmostEqual(with_ibkr["pnl"]["unattributed"], -20.0)
        gross = with_ibkr["exposure"]["rows"][0]
        self.assertAlmostEqual(gross["deltaBps"], (5.5 - 5_000 / 99_000 * 100) * 100)
        blank = build_daily_review(as_of=AS_OF, market_date=DAY, executions=[], closes=closes, metrics=metrics(book))
        self.assertEqual((blank["headline"]["dayPnl"], blank["headline"]["basis"], blank["headline"]["pctBasis"]), (500.0, "positions", "nlv"))
        # With nothing attributed and no IBKR figure there is no day P&L at all.
        gap = build_daily_review(as_of=AS_OF, market_date=DAY, executions=[], closes={}, metrics=metrics(book))
        self.assertIsNone(gap["headline"]["dayPnl"])
        self.assertIsNone(gap["exposure"]["rows"][0]["deltaBps"])
        # Part of the book attributed: that sum is the headline, marked partial, with the rest named.
        partial = build_daily_review(as_of=AS_OF, market_date=DAY, executions=[], closes=closes,
                                     metrics=metrics([*book, position("ZZZ", 9, 10, 5.0)]))
        self.assertEqual((partial["headline"]["dayPnl"], partial["headline"]["basis"]), (500.0, "positions-partial"))
        self.assertEqual(partial["pnl"]["unpriced"], ["ZZZ"])

    def test_ibkr_figures_without_realized_pnl_after_closing_trades_are_not_the_session(self):
        # IBKR resets its daily figures in the evening: a day with a trim cannot have realized nothing.
        book = metrics([position("AAA", 1, 100, 55.0)], pnl={"dailyPnL": -20.0, "realizedPnL": 0.0, "unrealizedPnL": 900.0})
        fills = normalize_executions(executions(fill("e1", 1, "AAA", "SLD", 50, 54.0)), DAY)
        sheet = build_daily_review(as_of=AS_OF, market_date=DAY, metrics=book, closes={1: (50.0, "2026-11-19")}, executions=fills)
        # 150 carried 50 -> 55, 50 sold at 54 against a 55 mark: 750 - 50.
        self.assertEqual((sheet["headline"]["dayPnl"], sheet["headline"]["basis"]), (700.0, "positions"))
        self.assertIsNone(sheet["pnl"]["account"])
        self.assertIsNone(sheet["pnl"]["unattributed"])
        self.assertTrue(any("no longer covers this session" in note for note in sheet["notes"]))
        # A day of opening trades only can truly realize nothing.
        opened = normalize_executions(executions(fill("e1", 1, "AAA", "BOT", 50, 54.0)), DAY)
        kept = build_daily_review(as_of=AS_OF, market_date=DAY, metrics=book, closes={1: (50.0, "2026-11-19")}, executions=opened)
        self.assertEqual(kept["headline"]["basis"], "ibkr-account")

    def test_market_rows_need_a_same_session_quote(self):
        quotes = {"us": [quote("SPX", 6600, 6500), quote("NDX", 100, 99, observed="2026-11-19T21:00:00Z")],
                  # A yield is quoted with its change and no previous close.
                  "rates": {"us_treasuries": [{"symbol": "UST10Y", "price": "4.92", "change": "0.03", "previousClose": None,
                                               "observedAt": "2026-11-20T21:05:00Z", "source": "cnbc"}]},
                  "crypto": [quote("BTC", 60_000, 61_000, observed="2026-11-20T20:59:00Z")]}
        market = build_market(quotes, {"VIX": {"lastPx": 20.0, "dayChangePct": -5.0, "marketSessionDate": DAY}}, {}, DAY, AS_OF)
        self.assertEqual([row["symbol"] for row in market["rows"]], ["SPX", "UST10Y", "BTC"])
        self.assertAlmostEqual(market["rows"][1]["change"], 0.03)
        self.assertIsNone(market["rows"][1]["changePct"])
        self.assertEqual(market["vix"]["level"], 20.0)
        self.assertIsNone(build_market(quotes, {"VIX": {"lastPx": 20.0, "marketSessionDate": "2026-11-19"}}, {}, DAY, AS_OF)["vix"])

    def test_spy_and_sectors_move_by_dated_daily_bars_never_an_after_hours_quote(self):
        # After the close a live quote's previous close is today's close; the bars still say 650 -> 660.
        histories = {"SPY": bars(660, 650), "XLK": bars(101, 100), "XLE": bars(99, 100),
                     "XLF": bars(50, 49, day="2026-11-19", before="2026-11-18")}
        market = build_market({}, None, histories, DAY, "2026-11-21T03:30:00Z")
        self.assertAlmostEqual(market["benchmark"]["changePct"], (660 / 650 - 1) * 100)
        self.assertEqual((market["benchmark"]["sessionDate"], market["benchmark"]["previousSessionDate"]), (DAY, "2026-11-19"))
        self.assertEqual([row["symbol"] for row in market["sectors"]], ["XLK", "XLE"])
        self.assertIsNone(session_move({"status": "unavailable"}, DAY))
        self.assertIsNone(session_move(bars(660, 650, day="2026-11-19", before="2026-11-18"), DAY))
        self.assertEqual(exit_closes({"ccc": bars(31, 30), "DDD": {"status": "unavailable"}}, DAY), {"CCC": 30})

    def test_alpha_beta_needs_measured_betas_for_nearly_all_of_gross(self):
        book = metrics([position("AAA", 1, 100, 55.0), position("BBB", 2, -100, 45.0)])
        closes = {1: (50.0, "2026-11-19"), 2: (50.0, "2026-11-19")}
        beta = lambda value: {"beta": {"value": value}}
        sheet = build_daily_review(as_of=AS_OF, market_date=DAY, metrics=book, closes=closes, executions=[],
            histories={"SPY": bars(102.0, 100.0)}, sizing={"bySymbol": {"AAA": beta(1.0), "BBB": beta(0.5)}})
        split = sheet["pnl"]["alphaBeta"]
        self.assertEqual(split["status"], "available")
        self.assertAlmostEqual(split["betaExposure"], 5_500 - 2_250)
        self.assertAlmostEqual(split["marketPnl"], 65.0)
        self.assertAlmostEqual(split["selectionPnl"], 1_000.0 - 65.0)
        partial = build_daily_review(as_of=AS_OF, market_date=DAY, metrics=book, closes=closes, executions=[],
            histories={"SPY": bars(102.0, 100.0)}, sizing={"bySymbol": {"AAA": beta(1.0)}})
        self.assertEqual(partial["pnl"]["alphaBeta"]["status"], "unavailable")
        self.assertAlmostEqual(partial["pnl"]["alphaBeta"]["coveragePct"], 55.0)

    def test_prediction_section_carries_the_kalshi_book_activity_and_ibkr_event_contracts(self):
        board = {"kalshiBook": {"asOf": AS_OF, "account": 10_000, "cash": 7_000, "atRisk": 600, "atRiskPct": 6.0, "maxPayout": 1_500,
                                "value": 650, "pnl": 50, "realized": 20, "openLines": 2, "events": 1, "unvalued": 0,
                                "flags": [{"tone": "yellow", "text": "Stacked."}],
                                "positions": [{"market": "Gold", "sectionLabel": "Metals", "side": "NO", "direction": "SHORT",
                                               "lines": [{}, {}], "cost": 600, "pct": 6.0, "value": 650, "pnl": 50, "maxPayout": 1_500,
                                               "closeTime": "2026-11-27T22:00:00Z", "state": "HOLD", "tone": "none"}]}}
        activity = {"ok": True, "since": "2026-11-20T05:00:00Z", "asOf": AS_OF, "fills": {"count": 1}, "settlements": {"count": 0}}
        event = position("FF", 9, 100, 0.6, sec_type="OPT", category="event_contract")
        sheet = build_daily_review(as_of=AS_OF, market_date=DAY, metrics=metrics([event]), executions=[], board=board, kalshi_activity=activity)
        prediction = sheet["prediction"]
        self.assertEqual((prediction["status"], prediction["openLines"], prediction["positions"][0]["lines"]), ("ready", 2, 2))
        self.assertEqual(prediction["today"]["fills"], {"count": 1})
        self.assertEqual(prediction["ibkrEventContracts"], {"count": 1, "valued": 1, "value": 60.0})
        self.assertEqual(build_daily_review(as_of=AS_OF, market_date=DAY, metrics=metrics([]), executions=[])["prediction"]["status"], "unavailable")

    def test_render_carries_the_sheet_in_one_fenced_block(self):
        sheet = build_daily_review(as_of=AS_OF, market_date=DAY, metrics=metrics([position("AAA", 1, 100, 55.0)]),
                                   closes={1: (50.0, "2026-11-19")}, executions=[])
        text = render_daily_review([{"id": "daily-review", "status": "ready", "sheet": sheet}])
        body = text.split(f"```{BLOCK}\n", 1)[1].split("\n```", 1)[0]
        self.assertEqual(json.loads(body), json.loads(json.dumps(sheet)))
        self.assertIn("Day P&L: $500", text)
        self.assertEqual(render_daily_review([]), "Daily Review unavailable.\n")

    def test_the_session_runs_until_the_next_pre_market_opens(self):
        self.assertEqual(review_session("2026-11-20T21:10:00Z"), {"marketDate": DAY, "phase": "post-market"})
        self.assertEqual(review_session("2026-11-20T18:30:00Z"), {"marketDate": DAY, "phase": "open"})
        self.assertEqual(review_session("2026-11-20T13:00:00Z"), {"marketDate": DAY, "phase": "pre-market"})
        # 22:30 Pacific on Friday is 01:30 Saturday in New York: still Friday's wrap-up.
        self.assertEqual(review_session("2026-11-21T06:30:00Z"), {"marketDate": DAY, "phase": "post-market"})
        # A weekend read describes the last session and is marked closed.
        self.assertEqual(review_session("2026-11-21T18:30:00Z"), {"marketDate": DAY, "phase": "closed"})
        # Thanksgiving 2026 is closed; the day after closes at 13:00 Eastern.
        self.assertEqual(review_session("2026-11-26T18:30:00Z"), {"marketDate": "2026-11-25", "phase": "closed"})
        self.assertEqual(review_session("2026-11-27T18:30:00Z"), {"marketDate": "2026-11-27", "phase": "post-market"})
        self.assertEqual(session_day("2026-11-21T07:59:00Z"), DAY)
        self.assertEqual(session_day("2026-11-21T09:01:00Z"), "2026-11-21")


if __name__ == "__main__":
    unittest.main()
