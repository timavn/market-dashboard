import unittest
from btc_price_history import (normalize_candle, inspect_settlement, collect_settlement_market,
                               finalize_settlements, missing_runs, load_market_pages)


class HistoricalPriceTests(unittest.TestCase):
    def market(self, value="100", ticker="KXBTCD-EXAMPLE-T99"):
        return {"event_ticker": "KXBTCD-EXAMPLE", "ticker": ticker, "close_time": "2026-01-01T01:00:00Z",
                "status": "finalized", "expiration_value": value,
                "rules_primary": "The average of sixty seconds of BRTI", "rules_secondary": ""}

    def test_excludes_candle_ending_after_cutoff(self):
        self.assertIsNone(normalize_candle([3600, 99, 102, 100, 101, 2], 0, 3600, "raw"))

    def test_candle_start_and_end_are_distinct(self):
        result = normalize_candle([0, 99, 102, 100, 101, 2], 0, 3600, "raw")
        self.assertEqual(result["startAt"], "1970-01-01T00:00:00Z")
        self.assertEqual(result["endAt"], "1970-01-01T01:00:00Z")
        self.assertEqual(result["open"], 100)
        self.assertEqual(result["close"], 101)

    def test_bad_candle_prices_are_rejected(self):
        for candle in ([0, 100, 99, 100, 100, 2], [0, 99, 102, 100, "NaN", 2], [3, 99, 102, 100, 101, 2]):
            with self.assertRaises(ValueError):
                normalize_candle(candle, 0, 3600, "raw")

    def test_only_final_official_settlements(self):
        self.assertEqual(str(inspect_settlement(self.market(), 0, 2_000_000_000)[1]), "100")
        for update in ({"status": "open"}, {"is_provisional": True}, {"expiration_value": ""},
                       {"rules_primary": "Coinbase price average sixty seconds"}):
            with self.assertRaises(ValueError):
                inspect_settlement({**self.market(), **update}, 0, 2_000_000_000)

    def test_outside_window_legacy_markets_are_ignored(self):
        legacy = {**self.market(""), "event_ticker": "BTCD-OLD", "close_time": "2024-01-01T01:00:00Z"}
        self.assertIsNone(inspect_settlement(legacy, 1767225600, 1767240000))

    def test_disagreeing_strikes_reject_entire_event(self):
        groups, rejected = {}, []
        for market in (self.market(), self.market("101", "KXBTCD-EXAMPLE-T100")):
            collect_settlement_market(groups, market, "raw", 0, 2_000_000_000, rejected)
        result = finalize_settlements([{"groups": groups, "rejected": rejected, "pages": 1, "marketRows": 2}],
                                      1767229200, 1767229200)
        self.assertEqual(result["rows"], [])
        self.assertIn("disagreeing", result["rejected"][0]["reason"])

    def test_agreeing_strikes_are_one_observation(self):
        groups, rejected = {}, []
        for market in (self.market(), self.market("100.00", "KXBTCD-EXAMPLE-T100")):
            collect_settlement_market(groups, market, "raw", 0, 2_000_000_000, rejected)
        result = finalize_settlements([{"groups": groups, "rejected": rejected, "pages": 1, "marketRows": 2}],
                                      1767229200, 1767229200)
        self.assertEqual(len(result["rows"]), 1)
        self.assertEqual(result["rows"][0]["status"], "finalized")
        self.assertEqual(len(result["rows"][0]["marketTickers"]), 2)

    def test_missing_hours_remain_missing(self):
        result = missing_runs({0, 3 * 3600}, 0, 4 * 3600)
        self.assertEqual(result, [{"startInclusive": "1970-01-01T01:00:00Z",
                                   "endExclusive": "1970-01-01T03:00:00Z", "hours": 2}])

    def test_historical_cursor_is_exhausted_despite_nonchronological_closes(self):
        example = self.market()
        pages = [
            {"markets": [{**example, "close_time": "2026-01-01T02:00:00Z"}], "cursor": "second"},
            {"markets": [{**example, "event_ticker": "KXBTCD-OLDER", "close_time": "2025-01-01T01:00:00Z"}], "cursor": "third"},
            {"markets": [{**example, "event_ticker": "KXBTCD-LATE", "close_time": "2026-01-01T03:00:00Z"}], "cursor": ""},
        ]

        class FakeDownloader:
            def get(self, *args):
                return pages.pop(0), "raw"

        result = load_market_pages(FakeDownloader(), "/historical/markets", 1767225600, 1767240000)
        self.assertEqual(result["pages"], 3)
        self.assertEqual(set(result["groups"]), {"KXBTCD-EXAMPLE", "KXBTCD-LATE"})

    def test_invalid_final_strike_does_not_leave_valid_sibling_as_verified(self):
        groups, rejected = {}, []
        for market in (self.market(), self.market("", "KXBTCD-EXAMPLE-T100")):
            collect_settlement_market(groups, market, "raw", 0, 2_000_000_000, rejected)
        result = finalize_settlements([{"groups": groups, "rejected": rejected, "pages": 1, "marketRows": 2}],
                                      1767229200, 1767229200)
        self.assertEqual(result["rows"], [])


if __name__ == "__main__":
    unittest.main()
