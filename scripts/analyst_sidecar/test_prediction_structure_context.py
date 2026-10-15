from copy import deepcopy
import re
import unittest

from prediction_structure_context import prediction_structure_context


AT = "2026-09-19T19:35:00Z"
DAY = "2026-09-18"


def snapshot():
    return {"marketId": "sp500", "status": "partial", "factors": {
        "usd": {"status": "available", "sourceStatus": "current", "source": "Yahoo Finance daily bars",
                "date": DAY, "asOf": "2026-09-19T19:30:00Z", "expiresAt": "2026-09-20T01:30:00Z",
                "r15": -0.396, "r30": 0.055, "r90": -0.419},
        "dxy": {"status": "historical", "availability": "historical", "value": 100.22,
                "fifteenDayChangePercent": 1.069, "thirtyDayChangePercent": 0.2501,
                "source": "Yahoo Finance completed DXY daily bars", "asOf": DAY,
                "historicalThroughDate": DAY, "expiresAt": "2026-09-23T23:59:59Z"},
        "spyVolume": {"status": "historical", "availability": "historical", "ratio": 1.2,
                      "currentVolume": 120000, "average20": 100000, "comparisonSessions": 20,
                      "source": "ibkr_historical_bars", "asOf": "2026-09-18T19:55:00Z",
                      "historicalThroughDate": DAY, "expiresAt": None},
        "vix": {"status": "historical", "availability": "last_close", "value": 14.81,
                "source": "ibkr_historical_daily_close", "asOf": "2026-09-18T20:00:00Z",
                "historicalThroughDate": DAY, "expiresAt": None},
        "vvix": {"status": "historical", "availability": "last_close", "value": 87.38,
                 "source": "ibkr_historical_daily_close", "asOf": "2026-09-18T20:00:00Z",
                 "historicalThroughDate": DAY, "expiresAt": None},
        "cftc": {"status": "available", "source": "cftc-public-reporting-environment",
                 "asOf": "2026-09-15", "date": "2026-09-15", "expiresAt": "2026-09-25T23:59:59Z",
                 "latest": -67379, "weeklyChange": -3846, "contractCode": "13874A",
                 "seriesType": "legacy-noncommercial-combined"},
    }}


def volume():
    return {"asOf": DAY, "totalExchange": [{"date": DAY, "volume": 200}, {"date": "2026-09-17", "volume": 100}],
            "metrics": {"exchange": {"priorDay": 200, "pctPriorDay": 100, "avg1M": 150,
                                     "pct1M": (200 / 150 - 1) * 100, "avg3M": 125, "pct3M": 60,
                                     "avg1Y": 100, "pct1Y": 100}},
            "meta": {"status": "current", "verified": True, "provider": "Cboe",
                     "sourceType": "cboe-consolidated-volume", "methodologyVersion": "cboe-consolidated-exchange-volume-v2",
                     "asOfTradingDate": DAY, "expectedTradingDate": DAY, "fetchedAt": "2026-09-19T19:34:50Z",
                     "comparisonWindows": {"priorDay": 1, "avg1M": 21, "avg3M": 60, "avg1Y": 250},
                     "sourceBreakdown": [{"id": "cboeConsolidatedVolume", "provider": "Cboe", "dataset": "Historical Market Volume"}]}}


class PredictionStructureContextTests(unittest.TestCase):
    def project(self, source=None, **kwargs):
        return prediction_structure_context(source if source is not None else snapshot(), as_of=AT, market_date=DAY, **kwargs)

    def test_retains_independent_dated_readings_and_explains_mixed_dollar_signs(self):
        source = snapshot()
        original = deepcopy(source)
        result = self.project(source)
        rows = {row[0]: row[1:] for row in result["rows"]}
        self.assertEqual(rows["SPX / dollar correlation"], ["15D -0.396 · 30D +0.055 · 90D -0.419", DAY])
        self.assertEqual(rows["SPY volume (ETF proxy)"], ["1.20× 20-session average", DAY])
        self.assertIn("last close", rows["Dollar index"][0])
        self.assertIn("14.81", rows["VIX"][0])
        self.assertEqual(rows["SPX noncommercial futures"][1], "2026-09-15")
        self.assertTrue(any("changes sign" in text for text in result["paragraphs"]))
        self.assertTrue(any("120,000 shares versus 100,000" in text for text in result["paragraphs"]))
        self.assertEqual(source, original)
        self.assertEqual(result["sources"][0]["asOf"], source["factors"]["usd"]["asOf"])
        self.assertNotIn("score", str(result).lower())

    def test_unsafe_factor_never_leaks_values_but_verified_siblings_survive(self):
        for patch in ({"stale": True}, {"mock": True}, {"seeded": True}, {"cacheOnly": True},
                      {"refreshFailed": True}, {"refreshRetained": True}, {"connected": False},
                      {"source": "model synthetic"}, {"metadata": {"mock": True}}):
            with self.subTest(patch=patch):
                source = snapshot()
                source["factors"]["usd"].update(patch)
                result = self.project(source)
                self.assertEqual(result["rows"][0], ["SPX / dollar correlation", "—", None])
                self.assertIn("Dollar index", str(result["rows"]))
                self.assertNotIn("-0.396", str(result))
        source = snapshot()
        source["mock"] = True
        self.assertEqual(self.project(source)["sources"], [])

    def test_observation_expiry_and_reading_dates_are_checked_at_capture(self):
        for patch in ({"asOf": "2026-09-19T19:36:00Z"}, {"expiresAt": AT}, {"expiresAt": None},
                      {"date": "2026-09-19"}, {"asOf": "invalid"}, {"date": "2026-09-31"}):
            with self.subTest(patch=patch):
                source = snapshot()
                source["factors"]["usd"].update(patch)
                self.assertEqual(self.project(source)["rows"][0][1], "—")
        self.assertEqual(prediction_structure_context(snapshot(), as_of="invalid", market_date=DAY)["sources"], [])

    def test_correlations_are_bounded_without_inventing_unreported_windows(self):
        source = snapshot()
        source["factors"]["usd"].update(r15=1.1, r30=None, r90=-0.4)
        self.assertEqual(self.project(source)["rows"][0][1], "15D — · 30D — · 90D -0.400")
        source["factors"]["usd"]["r90"] = -1.1
        self.assertEqual(self.project(source)["rows"][0][1], "—")

    def test_spy_volume_requires_matching_baseline_and_explains_intraday_cutoff(self):
        for patch in ({"ratio": 5}, {"comparisonSessions": 19}, {"average20": 0},
                      {"historicalThroughDate": "2026-09-17"}, {"status": "refreshing"}, {"cacheOnly": True}):
            with self.subTest(patch=patch):
                source = snapshot()
                source["factors"]["spyVolume"].update(patch)
                rows = {row[0]: row[1] for row in self.project(source)["rows"]}
                self.assertEqual(rows["SPY volume (ETF proxy)"], "—")
        source = snapshot()
        source["factors"]["spyVolume"].update(status="available", availability="live", asOf="2026-09-18T19:30:00Z",
            historicalThroughDate=None, expiresAt="2026-09-18T19:40:00Z")
        result = prediction_structure_context(source, as_of="2026-09-18T19:35:00Z", market_date=DAY)
        self.assertTrue(any("same time" in row[1] for row in result["rows"]))
        # The intraday cutoff is shown in Pacific time (19:30 UTC is 12:30 PDT).
        self.assertTrue(any(text.startswith("Through 12:30 PDT, SPY ETF volume") for text in result["paragraphs"]))
        self.assertFalse(any(re.search(r"\d ET\b", text) for text in result["paragraphs"]))
        source["factors"]["spyVolume"].update(asOf="2026-01-16T19:30:00Z", expiresAt="2026-01-16T19:40:00Z")
        winter = prediction_structure_context(source, as_of="2026-01-16T19:35:00Z", market_date="2026-01-16")
        self.assertTrue(any(text.startswith("Through 11:30 PST,") for text in winter["paragraphs"]), winter["paragraphs"])

    def test_verified_market_volume_has_distinct_consolidated_scope_and_actual_windows(self):
        source = volume()
        original = deepcopy(source)
        result = self.project(market_volume=source)
        rows = {row[0]: row[1] for row in result["rows"]}
        self.assertEqual(rows["U.S. volume vs prior session"], "+100.00%")
        self.assertEqual(rows["U.S. volume vs 21-session average"], "+33.33%")
        self.assertEqual(rows["U.S. volume vs 60-session average"], "+60.00%")
        self.assertEqual(rows["U.S. volume vs 250-session average"], "+100.00%")
        self.assertTrue(any("FINRA-reported" in text for text in result["paragraphs"]))
        self.assertEqual(source, original)

    def test_market_volume_rejects_wrong_date_flags_timestamps_and_inconsistent_math(self):
        for patch in ({"verified": False}, {"fetchedAt": "2026-09-19T19:36:00Z"},
                      {"fetchedAt": "2026-09-19T18:00:00Z"}, {"asOfTradingDate": "2026-09-17"},
                      {"cacheOnly": True}, {"provider": "Unknown"}):
            with self.subTest(patch=patch):
                source = volume()
                source["meta"].update(patch)
                self.assertFalse(any(row[0].startswith("U.S. volume") for row in self.project(market_volume=source)["rows"]))
        source = volume()
        source["metrics"]["exchange"]["pctPriorDay"] = 999
        rows = self.project(market_volume=source)["rows"]
        self.assertFalse(any(row[0] == "U.S. volume vs prior session" for row in rows))
        self.assertTrue(any(row[0] == "U.S. volume vs 21-session average" for row in rows))


if __name__ == "__main__":
    unittest.main()
