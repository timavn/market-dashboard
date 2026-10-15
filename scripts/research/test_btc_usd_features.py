"""Timing and data-integrity checks for the research-only dollar overlay."""
from datetime import datetime, timedelta, timezone
import math
import unittest

from btc_usd_features import (build_features, clean_daily, clean_hourly, daily_close_time,
                              hourly_return_pairs, instant, iso, pearson)

UTC = timezone.utc


def hour(at, close=100, **extra):
    start = instant(at)
    return {"startAt": iso(start), "endAt": iso(start + timedelta(hours=1)),
            "open": close, "high": close, "low": close, "close": close,
            "source": "yahoo_finance_chart", **extra}


def daily(count=35, first="2026-07-01", inverse=False):
    start = datetime.fromisoformat(first)
    return {"rows": [{"date": (start + timedelta(days=i)).date().isoformat(),
                      "close": 200 - i if inverse else 100 + i,
                      "source": "yahoo_finance_chart"} for i in range(count)]}


class DollarTimingTests(unittest.TestCase):
    def test_btc_close_not_available_on_its_start_date_and_lag_is_one_hour(self):
        usd_days, btc_days = daily(30), daily(30, inverse=True)
        btc = [hour("2026-07-31T04:00:00Z"), hour("2026-07-31T05:00:00Z")]
        usd = [hour("2026-07-31T02:00:00Z"), hour("2026-07-31T03:00:00Z")]
        result, _ = build_features(btc, usd, usd_days, btc_days)
        self.assertIsNone(result[0]["corr30Level"])
        self.assertAlmostEqual(result[1]["corr30Level"], -1)
        self.assertEqual(result[1]["corrAvailableAt"], "2026-07-31T05:00:00Z")
        self.assertEqual(result[1]["corrSourceDate"], "2026-07-30")

    def test_exact_predictor_lag_and_no_missing_hour_carry(self):
        btc = [hour("2026-08-02T10:00:00Z"), hour("2026-08-02T11:00:00Z")]
        usd = [hour("2026-08-02T08:00:00Z", 130), hour("2026-08-02T10:00:00Z", 200)]
        result, _ = build_features(btc, usd, daily(), daily(inverse=True))
        self.assertEqual(result[0]["usdClose"], 130)
        self.assertEqual(result[0]["usdObservedAt"], "2026-08-02T09:00:00Z")
        self.assertEqual(result[0]["usdAvailableAt"], "2026-08-02T10:00:00Z")
        self.assertIsNone(result[1]["usdClose"])
        self.assertFalse(result[1]["indicatorEligible"])

    def test_session_close_at_predictor_end_is_not_its_own_baseline(self):
        btc = [hour("2026-08-01T05:00:00Z"), hour("2026-08-01T06:00:00Z")]
        usd = [hour("2026-08-01T03:00:00Z", 131), hour("2026-08-01T04:00:00Z", 132)]
        result, _ = build_features(btc, usd, daily(), daily(inverse=True))
        self.assertEqual(result[0]["usdSessionCloseDate"], "2026-07-30")
        self.assertEqual(result[1]["usdSessionCloseDate"], "2026-07-31")
        self.assertAlmostEqual(result[0]["usdSessionMoveBp"], (131 / 129 - 1) * 10_000)
        self.assertAlmostEqual(result[1]["usdSessionMoveBp"], (132 / 130 - 1) * 10_000)
        self.assertEqual(result[1]["dailyReferenceDate"], "2026-07-31")
        self.assertEqual(result[1]["usdReferenceAvailableAt"], "2026-08-01T05:00:00Z")
        self.assertEqual(result[1]["referenceAgeHours"], 1)

    def test_dst_affects_daily_close_but_not_utc_hour_alignment(self):
        self.assertEqual(iso(daily_close_time("2026-03-06", "DXY")), "2026-03-07T05:00:00Z")
        self.assertEqual(iso(daily_close_time("2026-03-09", "DXY")), "2026-03-10T04:00:00Z")
        self.assertEqual(iso(daily_close_time("2026-11-02", "DXY")), "2026-11-03T05:00:00Z")
        self.assertEqual(iso(daily_close_time("2026-03-08", "BTC")), "2026-03-09T00:00:00Z")

    def test_future_daily_prices_cannot_change_existing_features(self):
        btc = [hour("2026-08-01T08:00:00Z")]
        usd = [hour("2026-08-01T06:00:00Z")]
        usd_days, btc_days = daily(), daily(inverse=True)
        before, _ = build_features(btc, usd, usd_days, btc_days)
        for document in (usd_days, btc_days):
            for row in document["rows"]:
                if row["date"] >= "2026-08-01":
                    row["close"] *= 15
        after, _ = build_features(btc, usd, usd_days, btc_days)
        self.assertEqual(before, after)

    def test_all_original_signal_fields_preserved(self):
        target = hour("2026-08-01T08:00:00Z", trend="BULLISH", currentBullishRun=True, signalSourceUrl="https://example.test/report")
        result, _ = build_features([target], [], daily(), daily(inverse=True))
        for key, value in target.items():
            self.assertEqual(result[0][key], value)

    def test_base_eligibility_does_not_require_daily_features(self):
        target = hour("2026-08-01T08:00:00Z")
        usd = [hour("2026-08-01T05:00:00Z", 100), hour("2026-08-01T06:00:00Z", 101)]
        result, coverage = build_features([target], usd, [], [])
        self.assertTrue(result[0]["indicatorEligible"])
        self.assertIsNone(result[0]["corr30Level"])
        self.assertIsNone(result[0]["usdSessionMoveBp"])
        self.assertAlmostEqual(result[0]["usdHourMoveBp"], 100)
        self.assertEqual(coverage["missingFeatureCounts"]["usdSessionMoveBp"], 1)

    def test_explicit_source_availability_is_respected_with_additional_lag(self):
        usd_days, btc_days = daily(30), daily(30, inverse=True)
        usd_days["rows"][-1].update({"endAt": "2026-07-31T04:00:00Z", "availableAt": "2026-07-31T08:00:00Z"})
        result, _ = build_features([hour("2026-07-31T08:00:00Z"), hour("2026-07-31T09:00:00Z")], [], usd_days, btc_days)
        self.assertIsNone(result[0]["corr30Level"])
        self.assertAlmostEqual(result[1]["corr30Level"], -1)
        self.assertEqual(result[1]["corrAvailableAt"], "2026-07-31T09:00:00Z")


class DollarIntegrityTests(unittest.TestCase):
    def test_hourly_conflicts_remove_entire_bucket_and_identical_rows_dedupe(self):
        first = hour("2026-08-01T00:00:00Z")
        second = hour("2026-08-01T01:00:00Z")
        result, coverage = clean_hourly([first, dict(first), second, hour("2026-08-01T01:00:00Z", 101)])
        self.assertEqual(len(result), 1)
        self.assertEqual(coverage["identicalDuplicates"], 1)
        self.assertEqual(coverage["rejected"][0]["reason"], "conflicting duplicate hourly bars")

    def test_incomplete_offhour_invalid_and_synthetic_hourly_bars_excluded(self):
        document = {"asOf": "2026-08-01T03:30:00Z", "rows": [
            hour("2026-08-01T00:00:00Z"), hour("2026-08-01T00:30:00Z"),
            hour("2026-08-01T01:00:00Z", complete=False),
            hour("2026-08-01T02:00:00Z", high=99),
            hour("2026-08-01T03:00:00Z"),
            hour("2026-08-01T04:00:00Z", synthetic=True)]}
        result, coverage = clean_hourly(document)
        self.assertEqual(len(result), 1)
        self.assertEqual(len(coverage["rejected"]), 5)

    def test_duplicate_daily_closes_and_unfinished_daily_bars_excluded(self):
        document = {"asOf": "2026-08-01T23:30:00Z", "rows": [
            {"date": "2026-07-29", "close": 100}, {"date": "2026-07-29", "close": 100},
            {"date": "2026-07-30", "close": 100}, {"date": "2026-07-30", "close": 101},
            {"date": "2026-08-01", "close": 102}]}
        result, coverage = clean_daily(document, "BTC")
        self.assertEqual(list(result), ["2026-07-29"])
        self.assertEqual(coverage["identicalDuplicates"], 1)
        self.assertEqual(len(coverage["rejected"]), 2)

    def test_daily_levels_require_exact_number_of_common_dates(self):
        usd_days, btc_days = daily(30), daily(30, inverse=True)
        btc_days["rows"].pop(10)
        result, _ = build_features([hour("2026-08-01T08:00:00Z")], [], usd_days, btc_days)
        self.assertIsNotNone(result[0]["corr15Level"])
        self.assertIsNone(result[0]["corr30Level"])

    def test_zero_variance_is_unknown_and_precision_is_not_rounded(self):
        self.assertIsNone(pearson([(1, 2), (1, 3)]))
        answer = pearson([(1, 2), (2, 3), (3, 3), (4, 8)])
        self.assertNotEqual(answer, round(answer, 3))

    def test_missing_prices_are_not_filled_and_return_pairs_never_cross_gaps(self):
        all_hours = [hour(f"2026-08-01T{h:02d}:00:00Z", 100 + h) for h in range(5)]
        btc, _ = clean_hourly(all_hours)
        usd, _ = clean_hourly([row for i, row in enumerate(all_hours) if i != 2])
        pairs = hourly_return_pairs(usd, btc)
        self.assertEqual([iso(pair["_end"]) for pair in pairs], ["2026-08-01T02:00:00Z", "2026-08-01T05:00:00Z"])


class HourlyReturnCorrelationTests(unittest.TestCase):
    def make_history(self, count=121, step_hours=1):
        start = instant("2026-07-01T00:00:00Z")
        usd, btc = [], []
        usd_price, btc_price = 100, 10_000
        for i in range(count):
            change = math.sin(i) / 1000
            usd_price *= 1 + change
            btc_price *= 1 - change * 2
            usd.append(hour(iso(start + timedelta(hours=i * step_hours)), usd_price))
            btc.append(hour(iso(start + timedelta(hours=i * step_hours)), btc_price))
        return usd, btc

    def test_120_past_return_pairs_and_future_outcomes_do_not_enter_window(self):
        usd, btc = self.make_history()
        target = hour("2026-07-06T02:00:00Z", 200_000)
        result, coverage = build_features(btc + [target], usd, daily(), daily(inverse=True))
        row = result[-1]
        self.assertEqual(row["corr120ReturnCount"], 120)
        self.assertAlmostEqual(row["corr120Return"], -1)
        self.assertEqual(row["corr120ReturnEndAt"], "2026-07-06T01:00:00Z")
        self.assertEqual(row["corr120ReturnAvailableAt"], target["startAt"])
        self.assertEqual(coverage["pairedHourlyReturns"], 120)
        target["close"] = target["open"] = target["high"] = target["low"] = 100
        again, _ = build_features(btc + [target], usd, daily(), daily(inverse=True))
        self.assertEqual(again[-1]["corr120Return"], row["corr120Return"])

    def test_insufficient_window_and_21_day_expiration(self):
        usd, btc = self.make_history(120)
        result, _ = build_features(btc + [hour("2026-07-06T01:00:00Z")], usd, daily(), daily(inverse=True))
        self.assertEqual(result[-1]["corr120ReturnCount"], 119)
        self.assertIsNone(result[-1]["corr120Return"])
        usd, btc = self.make_history()
        result, _ = build_features(btc + [hour("2026-08-01T01:00:00Z")], usd, daily(), daily(inverse=True))
        self.assertEqual(result[-1]["corr120ReturnCount"], 0)
        self.assertIsNone(result[-1]["corr120Return"])


if __name__ == "__main__":
    unittest.main()
