"""Research entry selection, thirds boundaries, timing, and export regressions."""
from datetime import timedelta
import unittest

from btc_usd_features import instant, iso
from btc_range_entry_experiment import (calculate, preferred_direction, prepare_observations,
                                        public_observations, select_entries, thirds_zone, validate_totals)


def observation(hour="2026-08-01T08:00:00Z", trend="BULLISH", opening=100, direction="UP", **updates):
    at = instant(hour)
    return {"hourStart": hour, "startAt": hour, "endAt": iso(at + timedelta(hours=1)),
            "pacificDay": "2026-08-01", "pacificStart": "2026-08-01T01:00:00-07:00", "pacificHour": 1,
            "trend": trend, "signalAvailableAt": "2026-07-31T12:00:00Z", "currentBullishRun": trend == "BULLISH",
            "open": opening, "lowerRange": 100, "upperRange": 160,
            "direction": direction, "returnPct": 0 if direction == "UNCHANGED" else .1 if direction == "UP" else -.1,
            "indicatorEligible": False, **updates}


class RangeBoundaryTests(unittest.TestCase):
    def test_exact_boundaries_and_outside_prices(self):
        cases = [(99.99, "below"), (100, "bottom"), (119.99, "bottom"),
                 (120, "middle"), (139.99, "middle"), (140, "top"),
                 (160, "top"), (160.01, "above")]
        for price, expected in cases:
            self.assertEqual(thirds_zone(price, 100, 160), expected)

    def test_non_integer_third_boundaries(self):
        self.assertEqual(thirds_zone(100 + 100 / 3, 100, 200), "middle")
        self.assertEqual(thirds_zone(100 + 200 / 3, 100, 200), "top")

    def test_unknown_invalid_or_inverted_ranges_excluded(self):
        for values in [(100, None, 160), (100, 100, 100), (100, 160, 100),
                       (100, 0, 160), (float("nan"), 100, 160), (100, 100, float("inf")), (True, 1, 2)]:
            self.assertIsNone(thirds_zone(*values))

    def test_only_requested_inside_range_setups_highlighted(self):
        self.assertEqual(preferred_direction("bullish", "bottom"), "UP")
        self.assertEqual(preferred_direction("current_bullish", "bottom"), "UP")
        self.assertEqual(preferred_direction("bearish", "top"), "DOWN")
        for cohort in ("bullish", "bearish", "neutral", "all", "current_bullish"):
            for zone in ("below", "above"):
                self.assertIsNone(preferred_direction(cohort, zone))
        self.assertIsNone(preferred_direction("neutral", "bottom"))
        self.assertIsNone(preferred_direction("all", "top"))


class EntrySelectionTests(unittest.TestCase):
    def test_no_dollar_filter_retains_hours_without_dollar_data(self):
        rows, _ = prepare_observations([observation()])
        self.assertEqual(rows[0]["qualifyingFilters"], ["none"])
        self.assertEqual(len(select_entries(rows, "bullish", "bottom", "none", "all_hours")), 1)
        self.assertEqual(len(select_entries(rows, "bullish", "bottom", "main_down", "all_hours")), 0)

    def test_dollar_filters_respect_direction_correlation_and_exact_threshold(self):
        base = observation(indicatorEligible=True, corr30Level=-.5, usdSessionMoveBp=-10,
                           corr15Level=None, corr120Return=None, usdHourMoveBp=None)
        rows, _ = prepare_observations([base, {**base, "usdSessionMoveBp": 10}, {**base, "corr30Level": -.4999}])
        self.assertIn("main_down", rows[0]["qualifyingFilters"])
        self.assertNotIn("main_up", rows[0]["qualifyingFilters"])
        self.assertIn("main_up", rows[1]["qualifyingFilters"])
        self.assertNotIn("main_down", rows[2]["qualifyingFilters"])

    def test_first_per_day_is_earliest_qualifying_within_each_group(self):
        rows, _ = prepare_observations([observation("2026-08-01T10:00:00Z", opening=145),
                                       observation("2026-08-01T09:00:00Z"),
                                       observation("2026-08-01T08:00:00Z"),
                                       observation("2026-08-02T08:00:00Z", pacificDay="2026-08-02")])
        bottom = select_entries(rows, "bullish", "bottom", "none", "first_per_day")
        top = select_entries(rows, "bullish", "top", "none", "first_per_day")
        self.assertEqual([row["hourStart"] for row in bottom], ["2026-08-01T08:00:00Z", "2026-08-02T08:00:00Z"])
        self.assertEqual([row["hourStart"] for row in top], ["2026-08-01T10:00:00Z"])

    def test_first_per_day_uses_first_filtered_hour_not_first_unfiltered_hour(self):
        rows, _ = prepare_observations([observation("2026-08-01T08:00:00Z"),
            observation("2026-08-01T09:00:00Z", indicatorEligible=True, corr30Level=-.6, usdSessionMoveBp=-11)])
        selected = select_entries(rows, "bullish", "bottom", "main_down", "first_per_day")
        self.assertEqual(selected[0]["hourStart"], "2026-08-01T09:00:00Z")

    def test_dst_repeated_hour_remains_two_primary_observations_one_first_entry(self):
        rows, _ = prepare_observations([observation("2026-11-01T08:00:00Z", pacificDay="2026-11-01"),
                                       observation("2026-11-01T09:00:00Z", pacificDay="2026-11-01")])
        self.assertEqual(len(select_entries(rows, "bullish", "bottom", "none", "all_hours")), 2)
        self.assertEqual(len(select_entries(rows, "bullish", "bottom", "none", "first_per_day")), 1)

    def test_future_signal_unknown_state_and_missing_range_excluded_and_counted(self):
        rows, reasons = prepare_observations([observation(trend="UNKNOWN"), observation(lowerRange=None),
                                             observation(signalAvailableAt="2026-08-01T08:00:01Z"), observation()])
        self.assertEqual(sum(row["entryEligible"] for row in rows), 1)
        self.assertEqual(sum(reasons.values()), 3)
        self.assertEqual(reasons["Unknown tracker signal"], 1)
        self.assertEqual(reasons["Missing or invalid known risk range"], 1)
        self.assertEqual(reasons["Signal was not yet available at entry"], 1)


class OutputTests(unittest.TestCase):
    def test_complete_grid_zero_groups_flat_denominator_and_reconciliation(self):
        observations, _ = prepare_observations([observation(), observation(direction="UNCHANGED"),
            observation(trend="BEARISH", opening=150, direction="DOWN"), observation(trend="NEUTRAL", opening=130)])
        results = calculate(observations, 20)
        self.assertEqual(len(results), 750)
        row = next(row for row in results if (row["cohort"], row["zone"], row["filter"], row["entryMode"]) == ("bullish", "bottom", "none", "all_hours"))
        self.assertEqual((row["upPct"], row["unchangedPct"], row["hours"]), (50, 50, 2))
        empty = next(row for row in results if row["hours"] == 0)
        self.assertIsNone(empty["upPct"])
        self.assertTrue(empty["limitedSample"])
        self.assertTrue(validate_totals(observations, results)["countsReconciled"])

    def test_bootstrap_is_reproducible_and_first_per_day_has_one_hour_per_day(self):
        observations, _ = prepare_observations([observation(pacificDay=f"2026-08-{day:02}", direction="UP" if day % 2 else "DOWN") for day in range(1, 11)])
        first = calculate(observations, 30)
        self.assertEqual(first, calculate(observations, 30))
        for row in first:
            if row["entryMode"] == "first_per_day":
                self.assertEqual(row["hours"], row["days"])

    def test_public_export_is_allowlisted_without_subscriber_identifiers(self):
        source = observation(signalMessageId="private", signalSourceUrl="https://mail.google.com/private",
                             rawResponse="private.json.gz", sourceHtml="private text", providerToken="private")
        rows, _ = prepare_observations([source])
        exported = public_observations(rows)[0]
        for key in ("signalMessageId", "signalSourceUrl", "rawResponse", "sourceHtml", "providerToken"):
            self.assertNotIn(key, exported)
        self.assertEqual(exported["entryZone"], "bottom")
        self.assertEqual(exported["signalAvailableAt"], source["signalAvailableAt"])


if __name__ == "__main__":
    unittest.main()
