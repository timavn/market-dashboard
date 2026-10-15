"""Research-only statistical and threshold regression checks."""
import unittest
import csv
from pathlib import Path
from tempfile import TemporaryDirectory

from btc_usd_experiment import VARIATIONS, correlated, triggered, relative_to_baseline, summarize, settlement_checks


def observation(day, direction="UP", move=10, corr=-.5):
    return {"pacificDay": day, "direction": direction,
            "returnPct": {"UP": 1, "DOWN": -1, "UNCHANGED": 0}[direction],
            "indicatorEligible": True, "corr30Level": corr, "usdSessionMoveBp": move}


class DollarFilterStatisticsTests(unittest.TestCase):
    def test_negative_correlation_direction_and_inclusive_boundaries(self):
        spec = VARIATIONS[0]
        self.assertTrue(triggered(observation("a"), spec, "UP"))
        self.assertTrue(triggered(observation("a", move=-10, corr=-.75), spec, "DOWN"))
        self.assertFalse(triggered(observation("a", corr=-.49), spec, "UP"))
        self.assertFalse(triggered(observation("a", move=9.99), spec, "UP"))
        self.assertFalse(triggered(observation("a", move=-10), spec, "UP"))

    def test_missing_indicators_never_qualify(self):
        spec = VARIATIONS[0]
        self.assertFalse(correlated(observation("a", corr=None), spec))
        self.assertFalse(correlated(observation("a", move=None), spec))
        self.assertFalse(correlated({**observation("a"), "indicatorEligible": False}, spec))

    def test_flat_prices_stay_in_denominator(self):
        sample = [observation(str(day), direction) for day in range(3)
                  for direction in ("UP", "DOWN", "UNCHANGED")]
        result = summarize(sample, "flat", 500)
        self.assertEqual(result["hours"], 9)
        self.assertAlmostEqual(result["upPct"], 100 / 3)
        self.assertAlmostEqual(result["unchangedPct"], 100 / 3)
        self.assertEqual(result, summarize(sample, "flat", 500))

    def test_identical_overlapping_baseline_has_exactly_zero_lift(self):
        sample = [observation(str(day), direction) for day in range(12)
                  for direction in ("UP", "DOWN", "UP")]
        result = relative_to_baseline(sample, sample, "UP", "same", 500)
        self.assertEqual(result["targetLiftPp"], 0)
        self.assertEqual(result["targetLift95"], [0, 0])

    def test_empty_and_single_day_samples_have_no_interval(self):
        self.assertIsNone(summarize([], "empty")["upPct95"])
        self.assertIsNone(summarize([observation("a")], "one")["upPct95"])
        self.assertIsNone(relative_to_baseline([], [], "DOWN", "none")["targetLiftPp"])

    def test_two_independent_limited_sample_rules(self):
        many_hours_one_day = summarize([observation("a") for _ in range(40)], "a", 100)
        few_hours_many_days = summarize([observation(str(day)) for day in range(20)], "b", 100)
        enough = summarize([observation(str(day)) for day in range(15) for _ in range(3)], "c", 100)
        self.assertTrue(many_hours_one_day["limitedSample"])
        self.assertTrue(few_hours_many_days["limitedSample"])
        self.assertFalse(enough["limitedSample"])

    def test_settlement_check_excludes_missing_intervals_and_preserves_matched_control(self):
        sample = [{**observation("2026-08-01", move=-10), "hourStart": f"2026-08-01T{h}:00:00Z",
                   "trend": "BULLISH", "currentBullishRun": True, "usdHourMoveBp": -10} for h in ("10", "11", "12")]
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "settlement.csv"
            with path.open("w") as stream:
                writer = csv.DictWriter(stream, ["hourStart", "direction", "returnPct"])
                writer.writeheader()
                for row, direction in zip(sample[:2], ("UP", "DOWN")):
                    writer.writerow({"hourStart": row["hourStart"], "direction": direction, "returnPct": 1 if direction == "UP" else -1})
            results = settlement_checks(sample, path)
        result = next(r for r in results if r["variation"] == "main" and r["cohort"] == "All bullish periods" and r["usdDirection"] == "DOWN")
        self.assertEqual((result["hours"], result["missingSettlementHours"]), (2, 1))
        self.assertEqual(result["targetPct"], 50)
        self.assertEqual(result["coinbaseMatchedTargetPct"], 100)


if __name__ == "__main__":
    unittest.main()
