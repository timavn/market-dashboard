import copy
import unittest

from portfolio_rollup_metrics import build_factor_exposure, build_review_comparison, previous_session_baseline, rebuilt_session_close


def position(value=200, category="stock", **changes):
    return {"symbol": "ABC", "account": "account-a", "quantity": -2 if value is not None and value < 0 else 2,
            "marketValue": value, "markState": "live", "category": category, "currency": "USD", **changes}


def metrics(positions=None, observed="2026-09-18T13:15:00Z", nlv=1000, **changes):
    positions = positions if positions is not None else [position()]
    values = [row["marketValue"] for row in positions
              if row.get("markState") in {"live", "settled", "resolver"} and isinstance(row.get("marketValue"), (int, float))]
    gross, net = sum(abs(value) for value in values), sum(values)
    return {"available": True, "observedAt": observed, "accountKey": "account-a-verified-key",
            "accountIds": ["account-a"], "currency": "USD", "accountSummaryAvailable": True,
            "valuationComplete": len(values) == len(positions), "netLiquidation": nlv,
            "positions": positions, "positionCount": len(positions), "valuedCount": len(values),
            "unavailableCount": len(positions) - len(values), "grossExposure": gross, "netExposure": net,
            "longMarketValue": sum(max(0, value) for value in values),
            "shortMarketValue": sum(min(0, value) for value in values),
            "grossLeverage": gross / nlv if nlv else None,
            "netExposurePctOfNlv": net / nlv * 100 if nlv else None, **changes}


class ReviewComparisonTests(unittest.TestCase):
    def setUp(self):
        self.previous = metrics([position(300), position(-100)], observed="2026-09-17T20:00:00Z")
        self.current = metrics([position(200), position(-200)])

    def test_compares_captured_values_without_replacing_history_with_current_values(self):
        previous = metrics([position(300), position(-100)], observed="2026-09-17T20:00:00Z", nlv=2000)
        original = copy.deepcopy((self.current, previous))
        result = build_review_comparison(self.current, previous)
        self.assertEqual(result["status"], "available")
        self.assertEqual(result["baselineAsOf"], "2026-09-17T20:00:00Z")
        self.assertEqual(result["metrics"], {
            "grossExposure": {"previous": 400, "current": 400},
            "netExposure": {"previous": 200, "current": 0},
            "grossLeverage": {"previous": .2, "current": .4},
            "netExposurePctOfNlv": {"previous": 10, "current": 0},
            "longMarketValue": {"previous": 300, "current": 200},
            "shortMarketValue": {"previous": -100, "current": -200},
            "netLiquidation": {"previous": 2000, "current": 1000},
            "netAccruedInterest": {"previous": None, "current": None},
        })
        self.assertEqual((self.current, previous), original)

    def test_compares_each_capture_own_accrued_interest_without_inventing_a_missing_reading(self):
        previous = {**self.previous, "netAccruedInterest": -388.05}
        result = build_review_comparison({**self.current, "netAccruedInterest": -412.37}, previous)
        self.assertEqual(result["metrics"]["netAccruedInterest"], {"previous": -388.05, "current": -412.37})
        result = build_review_comparison({**self.current, "netAccruedInterest": -412.37}, self.previous)
        self.assertEqual(result["metrics"]["netAccruedInterest"], {"previous": None, "current": -412.37})

    def test_zero_exposure_is_valid_and_is_not_missing_data(self):
        current = metrics([])
        result = build_review_comparison(current, self.previous)
        self.assertEqual(result["status"], "available")
        self.assertEqual(result["metrics"]["grossExposure"]["current"], 0)
        self.assertEqual(result["metrics"]["longMarketValue"]["current"], 0)
        self.assertEqual(result["metrics"]["shortMarketValue"]["current"], 0)

    def test_missing_captured_side_totals_are_not_reconstructed(self):
        previous = {key: value for key, value in self.previous.items()
                    if key not in {"longMarketValue", "shortMarketValue"}}
        result = build_review_comparison(self.current, previous)
        self.assertEqual(result["status"], "available")
        self.assertEqual(result["metrics"]["longMarketValue"], {"previous": None, "current": 200})
        self.assertEqual(result["metrics"]["shortMarketValue"], {"previous": None, "current": -200})

    def test_rejects_missing_same_capture_future_capture_or_wrong_baseline_time(self):
        for previous in (None, {}, self.current, {**self.previous, "observedAt": "2026-09-19T20:00:00Z"},
                         {**self.previous, "observedAt": "2026-09-17"}):
            with self.subTest(previous=previous):
                self.assertEqual(build_review_comparison(self.current, previous)["metrics"], {})
        self.assertEqual(build_review_comparison(self.current, self.previous, "2026-09-16T20:00:00Z")["status"], "unavailable")

    def test_requires_same_verified_account_and_currency(self):
        for changes in ({"accountKey": None}, {"accountKey": "other"}, {"currency": "EUR"}):
            with self.subTest(changes=changes):
                self.assertEqual(build_review_comparison(self.current, {**self.previous, **changes})["status"], "unavailable")

    def test_rejects_incomplete_valuation_and_inconsistent_totals(self):
        for changes in ({"valuationComplete": False}, {"accountSummaryAvailable": False},
                        {"positionCount": 99}, {"grossExposure": 10000}, {"netExposure": None},
                        {"grossLeverage": float("nan")}, {"netExposurePctOfNlv": True}, {"netLiquidation": 0}):
            with self.subTest(changes=changes):
                self.assertEqual(build_review_comparison({**self.current, **changes}, self.previous)["status"], "unavailable")

    def test_explicit_bad_capture_or_row_provenance_invalidates_comparison(self):
        for changes in ({"available": False}, {"stale": True}, {"connected": False}, {"liveVerified": False},
                        {"fromCache": True}, {"cacheOnly": True}, {"mock": True}, {"seeded": True},
                        {"freshness": "offline"}, {"source": "mock_fixture"}):
            with self.subTest(changes=changes):
                self.assertEqual(build_review_comparison({**self.current, **changes}, self.previous)["status"], "unavailable")
        bad_row = copy.deepcopy(self.current)
        bad_row["positions"][0]["seeded"] = True
        self.assertEqual(build_review_comparison(bad_row, self.previous)["status"], "unavailable")

    def test_missing_positions_reduced_presentation_metrics_are_not_a_baseline(self):
        previous = {key: value for key, value in self.previous.items() if key != "positions"}
        self.assertEqual(build_review_comparison(self.current, previous)["status"], "unavailable")

    def account_metrics(self, *, observed, long_value, short_value, **changes):
        gross, net, nlv = long_value - short_value, long_value + short_value, 1000
        return metrics([position(None, markState="unavailable")], observed=observed,
                       exposureComplete=True, exposureBasis="broker_account", exposureObservedAt=observed,
                       exposureProvenance={"verifiedAtCapture": True, "source": "ibkr_live_session", "fromCache": False,
                                          "accountId": "account-a", "currency": "USD", "observedAt": observed},
                       longMarketValue=long_value, shortMarketValue=short_value, grossExposure=gross,
                       netExposure=net, grossLeverage=gross / nlv, netExposurePctOfNlv=net / nlv * 100, **changes)

    def test_independent_broker_account_totals_compare_without_complete_position_quotes(self):
        previous = self.account_metrics(observed="2026-09-17T20:30:05Z", long_value=300, short_value=-100)
        current = self.account_metrics(observed="2026-09-18T14:30:05Z", long_value=400, short_value=-50)
        current["observedAt"] = "2026-09-18T14:30:00Z"
        result = build_review_comparison(current, previous, session_baseline=previous_session_baseline(current["observedAt"]))
        self.assertEqual(result["status"], "available")
        self.assertEqual(result["baselineAsOf"], "2026-09-17T20:30:05Z")
        self.assertEqual(result["currentAsOf"], "2026-09-18T14:30:05Z")
        self.assertEqual(result["metrics"]["grossExposure"], {"previous": 400, "current": 450})
        self.assertEqual(result["metrics"]["netExposurePctOfNlv"], {"previous": 20, "current": 35})
        self.assertEqual(result["metrics"]["longMarketValue"], {"previous": 300, "current": 400})
        self.assertEqual(result["metrics"]["shortMarketValue"], {"previous": -100, "current": -50})
        self.assertEqual(result["metrics"]["netLiquidation"], {"previous": 1000, "current": 1000})
        self.assertEqual(build_factor_exposure(current)["rows"], [])

    def test_account_comparison_rejects_unverified_or_inconsistent_account_proof(self):
        previous = self.account_metrics(observed="2026-09-17T20:30:05Z", long_value=300, short_value=-100)
        current = self.account_metrics(observed="2026-09-18T14:30:05Z", long_value=400, short_value=-50)
        for change in ({"exposureComplete": False}, {"exposureProvenance": None},
                       {"grossExposure": 999}, {"longMarketValue": -400}, {"shortMarketValue": 50},
                       {"exposureObservedAt": "2026-09-18T14:31:00Z"}):
            with self.subTest(change=change):
                self.assertEqual(build_review_comparison({**current, **change}, previous)["status"], "unavailable")
        for change in ({"verifiedAtCapture": False}, {"fromCache": True}, {"source": "cache_only"},
                       {"accountId": "other-account"}, {"currency": "EUR"}, {"mock": True}):
            with self.subTest(proof=change):
                altered = {**current, "exposureProvenance": {**current["exposureProvenance"], **change}}
                self.assertEqual(build_review_comparison(altered, previous)["status"], "unavailable")

    def test_previous_session_calendar_honors_weekends_holidays_and_after_close(self):
        for observed, expected in (("2026-10-08T15:00:00Z", "2026-10-07"),
                                   ("2026-10-09T02:37:00Z", "2026-10-07"),
                                   ("2026-10-12T15:00:00Z", "2026-10-09"),
                                   ("2026-09-08T15:00:00Z", "2026-09-04")):
            with self.subTest(observed=observed):
                self.assertEqual(previous_session_baseline(observed)["baselineSessionDate"], expected)
        self.assertEqual(previous_session_baseline("2026-11-30T15:00:00Z")["baselineSessionCloseAt"], "2026-11-27T18:00:00Z")

    def test_intraday_older_or_current_session_reviews_are_not_previous_close(self):
        session = previous_session_baseline(self.current["observedAt"])
        for observed in ("2026-09-17T19:59:59Z", "2026-09-16T20:30:00Z", "2026-09-18T12:00:00Z"):
            with self.subTest(observed=observed):
                result = build_review_comparison(self.current, {**self.previous, "observedAt": observed}, session_baseline=session)
                self.assertEqual(result["status"], "unavailable")
                self.assertEqual(result["baselineSessionDate"], "2026-09-17")
                self.assertIsNone(result["baselineAsOf"])

    def test_holdings_read_before_the_next_pre_market_open_is_the_previous_close(self):
        current = {**self.current, "observedAt": "2026-10-19T14:30:00Z"}
        session = previous_session_baseline(current["observedAt"])
        for observed, status in (("2026-10-17T13:30:00Z", "available"), ("2026-10-19T07:59:00Z", "available"),
                                 ("2026-10-19T08:00:00Z", "unavailable"), ("2026-10-16T19:59:59Z", "unavailable")):
            with self.subTest(observed=observed):
                result = build_review_comparison(current, {**self.previous, "observedAt": observed}, session_baseline=session)
                self.assertEqual(result["baselineSessionDate"], "2026-10-16")
                self.assertEqual(result["status"], status)

    def rebuild_inputs(self, *, executions=0, prior_date="2026-10-30", dpnl=-150, short_count=1):
        current = self.account_metrics(observed="2026-11-02T14:09:05Z", long_value=600, short_value=-400)
        current["observedAt"] = "2026-11-02T14:09:04Z"
        shorts = [{"symbol": "BYD", "quantity": -5, "priorClose": 76, "priorCloseSessionDate": prior_date,
                   "priorCloseSource": "ibkr_historical_daily_close"}][:short_count]
        balance = {"data": {"current": {"activity": {"sameDayExecutionCount": executions}, "eventPositions": [],
                                        "shortPositions": shorts, "positions": [{"symbol": "BYD", "quantity": -5}, {"symbol": "CVI", "quantity": 10}]}}}
        portfolio = {"data": {"pnl": [{"account": "account-a", "pnl": {"dailyPnL": dpnl}}]}}
        return current, portfolio, balance, previous_session_baseline(current["observedAt"])

    def test_a_missed_close_is_rebuilt_from_a_later_read_with_no_trades_since(self):
        current, portfolio, balance, session = self.rebuild_inputs()
        closing = rebuilt_session_close(current, portfolio, balance, session)
        # Shorts at the official Oct 30 close (-5 x 76); NLV and net less the day's -150 P&L; longs the remainder.
        self.assertEqual([closing[key] for key in ("shortMarketValue", "netLiquidation", "netExposure", "longMarketValue", "grossExposure")],
                         [-380, 1150, 350, 730, 1110])
        self.assertEqual(closing["observedAt"], "2026-10-30T20:00:00Z")
        result = build_review_comparison(current, closing, session_baseline=session)
        self.assertEqual(result["status"], "available")
        self.assertEqual(result["baselineAsOf"], "2026-10-30T20:00:00Z")
        self.assertEqual(result["metrics"]["shortMarketValue"], {"previous": -380, "current": -400})

    def test_a_close_is_not_rebuilt_after_a_trade_or_without_full_closing_evidence(self):
        for change in ({"executions": 1}, {"prior_date": "2026-10-29"}, {"short_count": 0}, {"dpnl": None}):
            with self.subTest(change=change):
                self.assertIsNone(rebuilt_session_close(*self.rebuild_inputs(**change)))


class ExposureTests(unittest.TestCase):
    def test_nlv_denominator_signed_shorts_and_netting(self):
        result = build_factor_exposure(metrics([position(300), position(-100), position(500, "bond")]))
        self.assertEqual(result, {"status": "available", "label": "Asset exposure", "coveragePct": 100,
                                 "rows": [{"label": "Bonds", "longPct": 50, "shortPct": 0, "netPct": 50},
                                          {"label": "Stocks & ETFs", "longPct": 30, "shortPct": -10, "netPct": 20}]})

    def test_coverage_is_value_weighted_not_position_count(self):
        result = build_factor_exposure(metrics([position(100), position(900, "other")]))
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["coveragePct"], 10)
        self.assertEqual(result["rows"][0]["netPct"], 10)

    def test_partial_position_marks_never_present_asset_totals_or_full_coverage(self):
        partial = metrics([position(200), position(None, "bond", quantity=1, markState="unavailable")])
        result = build_factor_exposure(partial)
        self.assertEqual(result, {"status": "unavailable", "label": "Asset exposure", "rows": []})

    def test_complete_broker_totals_do_not_fill_missing_asset_allocations(self):
        partial = metrics([
            position(8646.72, symbol="ABC"),
            position(None, "stock", symbol="XYZ", quantity=-10, markState="unavailable"),
        ], nlv=175487.03, exposureComplete=True, exposureBasis="broker_account",
            grossExposure=211185.06, netExposure=17033.2)
        self.assertEqual(build_factor_exposure(partial),
                         {"status": "unavailable", "label": "Asset exposure", "rows": []})

    def test_no_ticker_inference_or_research_mention_as_factor_classification(self):
        result = build_factor_exposure(metrics([position(500, "other", symbol="QQQ")]),
                                       {"bySymbol": {"QQQ": {"sector": "Technology", "factor": "Momentum"}}})
        self.assertEqual(result, {"status": "unavailable", "label": "Asset exposure", "rows": [], "coveragePct": 0})

    def test_broker_security_type_and_upstream_verified_event_category(self):
        result = build_factor_exposure(metrics([position(200, "other", secType="STK"),
                                                position(100, "event_contract", secType="OPT", markState="settled")]))
        self.assertEqual(result["status"], "available")
        self.assertEqual([row["label"] for row in result["rows"]], ["Event contracts", "Stocks & ETFs"])
        result = build_factor_exposure(metrics([position(200, "bond", secType="STK")]))
        self.assertEqual(result["rows"], [])

    def test_all_forbidden_top_level_inputs_are_empty(self):
        for changes in ({"available": False}, {"observedAt": None}, {"stale": True}, {"connected": False},
                        {"from_cache": True}, {"cacheOnly": True}, {"mock": True}, {"seeded": True},
                        {"inferred": True}, {"freshness": "offline"}, {"source": "cached_disconnected_snapshot"},
                        {"accountSummaryAvailable": False}, {"netLiquidation": None}, {"netLiquidation": -100}):
            with self.subTest(changes=changes):
                self.assertEqual(build_factor_exposure(metrics(**changes))["rows"], [])

    def test_one_unverified_row_invalidates_asset_totals_for_the_book(self):
        for changes in ({"stale": True}, {"mock": True}, {"seeded": True}, {"cacheOnly": True},
                        {"markState": "unavailable"}, {"marketValue": float("inf")}, {"quantity": -2}):
            with self.subTest(changes=changes):
                result = build_factor_exposure(metrics([position(200), position(800, "bond", **changes)]))
                self.assertEqual(result, {"status": "unavailable", "label": "Asset exposure", "rows": []})

    def test_native_currency_values_cannot_be_added_without_verified_conversion(self):
        result = build_factor_exposure(metrics([position(200), position(100, "bond", currency="EUR")]))
        self.assertEqual(result["rows"], [])
        converted = metrics([position(200), position(100, "bond", currency="EUR", valuationCurrency="USD")])
        self.assertEqual(build_factor_exposure(converted)["status"], "available")


if __name__ == "__main__":
    unittest.main()


class CalendarLookupRetryTest(unittest.TestCase):
    """A slow or failed calendar helper is asked again, not remembered."""

    def setUp(self):
        import portfolio_rollup_metrics
        self.module = portfolio_rollup_metrics
        self.module._previous_session_from_calendar.cache_clear()
        self.module._holdings_frozen_until_from_calendar.cache_clear()
        self.addCleanup(self.module._previous_session_from_calendar.cache_clear)
        self.addCleanup(self.module._holdings_frozen_until_from_calendar.cache_clear)

    def _flaky_run(self):
        import subprocess
        real_run = subprocess.run
        calls = []

        def run(*args, **kwargs):
            calls.append(args)
            if len(calls) == 1:
                raise subprocess.TimeoutExpired(cmd="node", timeout=1)
            return real_run(*args, **kwargs)

        return run, calls

    def test_previous_session_is_retried_after_a_timeout_then_remembered(self):
        from unittest import mock
        run, calls = self._flaky_run()
        with mock.patch.object(self.module.subprocess, "run", side_effect=run):
            self.assertEqual(previous_session_baseline("2026-10-08T15:00:00Z"), {})
            self.assertEqual(previous_session_baseline("2026-10-08T15:00:00Z")["baselineSessionDate"], "2026-10-07")
            self.assertEqual(previous_session_baseline("2026-10-08T16:00:00Z")["baselineSessionDate"], "2026-10-07")
        self.assertEqual(len(calls), 2)

    def test_holdings_freeze_is_retried_after_a_timeout_then_remembered(self):
        from unittest import mock
        run, calls = self._flaky_run()
        with mock.patch.object(self.module.subprocess, "run", side_effect=run):
            self.assertIsNone(self.module._holdings_frozen_until("2026-10-07"))
            first = self.module._holdings_frozen_until("2026-10-07")
            self.assertEqual(first.date().isoformat(), "2026-10-08")
            self.assertEqual(self.module._holdings_frozen_until("2026-10-07"), first)
        self.assertEqual(len(calls), 2)
