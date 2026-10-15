import copy
import unittest

from prediction_review import _cpi_forecasts


class PredictionCpiForecastTests(unittest.TestCase):
    def setUp(self):
        self.event = {"ticker": "CPIY_0926", "reportMonth": "2026-09", "releaseKey": "KXCPIYOY#2026-09"}
        self.comparison = {
            "status": "available", "eventTicker": "CPIY_0926", "reportMonth": "2026-09",
            "releaseKey": "KXCPIYOY#2026-09",
            "hedgeye": {"status": "available", "baseValue": 3.61,
                        "scenarios": [{"key": "downside", "value": 3.50}, {"key": "base", "value": 3.61},
                                      {"key": "upside", "value": 3.72}],
                        "source": "hedgeye-inflation-nowcast", "asOf": "2026-09-16T15:37:07.000Z"},
        }

    def fields(self):
        return dict(_cpi_forecasts({"forecastComparison": self.comparison}, self.event)[0])

    def test_published_bounds_survive_without_changing_evidence(self):
        original = copy.deepcopy(self.comparison)
        self.assertEqual(self.fields()["Hedgeye nowcast"],
                         "Lower 3.50% · Base 3.61% · Upper 3.72% · published 2026-09-16T15:37:07.000Z")
        self.assertEqual(self.comparison, original)

    def test_missing_or_invalid_bound_is_not_inferred(self):
        for lower in (None, True, float("nan"), 3.9):
            with self.subTest(lower=lower):
                self.comparison["hedgeye"]["scenarios"][0]["value"] = lower
                self.assertIn("Lower — · Base 3.61% · Upper 3.72%", self.fields()["Hedgeye nowcast"])
        self.comparison["hedgeye"]["scenarios"] = [{"key": "downside", "value": 0}, {"key": "upside", "value": 0}]
        self.assertIn("Lower 0.00% · Base 3.61% · Upper —", self.fields()["Hedgeye nowcast"])

    def test_unsafe_forecasts_and_mismatched_releases_are_excluded(self):
        for flag in ("offline", "stale", "cachedOnly", "seeded", "mock", "refreshFailed"):
            with self.subTest(flag=flag):
                self.comparison["hedgeye"][flag] = True
                self.assertNotIn("Hedgeye nowcast", self.fields())
                del self.comparison["hedgeye"][flag]
        self.comparison["reportMonth"] = "2026-08"
        self.assertNotIn("Hedgeye nowcast", self.fields())

    def test_unsafe_bounds_do_not_erase_independently_verified_base(self):
        for row in self.comparison["hedgeye"]["scenarios"]:
            row["mock"] = True
        self.assertIn("Lower — · Base 3.61% · Upper —", self.fields()["Hedgeye nowcast"])

    def test_legacy_base_only_forecast_does_not_gain_invented_bounds(self):
        del self.comparison["hedgeye"]["scenarios"]
        self.assertEqual(self.fields()["Hedgeye nowcast"], "3.61% · published 2026-09-16T15:37:07.000Z")
