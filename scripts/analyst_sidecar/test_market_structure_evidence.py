from copy import deepcopy
import unittest

from market_structure_evidence import evidence_safe, metric_rows, verified_metric


THROTTLE = "spxGammaVolatilityThrottle"
GAMMA_MAP = "spxProbableVolatilityGamma"
THROTTLE_CHART = "a" * 64
GAMMA_CHART = "b" * 64


def captured_structure():
    def metric(chart, **values):
        return {"chartId": chart, "chartDate": "2026-09-18", "extractionBasis": "labeled-chart-ocr",
                "parserVersion": "market-structure-chart-metrics-v3", "source": "Hedgeye/Bloomberg", **values}

    return {
        "snapshotType": "market-structure", "date": "2026-09-21",
        "schemaVersion": "market-structure-v4", "contentComplete": True,
        "data": {
            "charts": [{"id": chart, "sha256": chart,
                        "s3Key": f"hedgeye-email/assets/market-structure/{chart}.png"}
                       for chart in (THROTTLE_CHART, GAMMA_CHART)],
            "chartMetrics": {
                THROTTLE: metric(THROTTLE_CHART, gammaThrottle=.12, tenDayRealizedVolatility=10.71),
                GAMMA_MAP: metric(GAMMA_CHART, zeroGamma=7649, lowerPvBand=7492, upperPvBand=7734,
                                  strikesInPlay=[7500, 7550, 7600, 7650, 7700]),
            },
        },
    }


class MarketStructureEvidenceTests(unittest.TestCase):
    def test_projects_six_published_readings_with_chart_and_report_dates(self):
        snapshot = captured_structure()
        original = deepcopy(snapshot)
        rows = metric_rows(snapshot, "cite_market_structure")
        self.assertEqual([row["cells"] for row in rows], [
            ["Gamma throttle", "0.12", "Sep 18, 2026"],
            ["10-day realized volatility", "10.71", "Sep 18, 2026"],
            ["Zero-gamma level", "7,649", "Sep 18, 2026"],
            ["Lower probable-volatility band", "7,492", "Sep 18, 2026"],
            ["Upper probable-volatility band", "7,734", "Sep 18, 2026"],
            ["Strikes in play", "7,500 / 7,550 / 7,600 / 7,650 / 7,700", "Sep 18, 2026"],
        ])
        for row in rows:
            self.assertEqual(row["citationIds"], ["cite_market_structure"])
            self.assertEqual(row["provenance"]["publicationDate"], "2026-09-21")
            self.assertEqual(row["provenance"]["chartDate"], "2026-09-18")
            self.assertEqual(row["provenance"]["source"], "Hedgeye/Bloomberg")
        self.assertEqual(rows[0]["provenance"]["chartId"], THROTTLE_CHART)
        self.assertEqual(rows[2]["provenance"]["chartId"], GAMMA_CHART)
        self.assertEqual(snapshot, original)

    def test_saved_capture_is_not_expired_by_todays_date(self):
        snapshot = captured_structure()
        snapshot["date"] = "2020-09-21"
        for metric in snapshot["data"]["chartMetrics"].values():
            metric["chartDate"] = "2020-09-18"
        self.assertEqual(len(metric_rows(snapshot, "archive")), 6)
        self.assertEqual(metric_rows(snapshot, "archive")[0]["cells"][2], "Sep 18, 2020")

    def test_unsafe_wrappers_and_metric_or_chart_evidence_cannot_publish_numbers(self):
        patches = ({"connected": False}, {"providerStatus": "offline"}, {"status": "error"},
                   {"status": "failed"}, {"status": "unavailable"}, {"refreshIssue": "timeout"},
                   {"error": "Request failed"}, {"refreshFailed": True}, {"stale": True},
                   {"isStale": True}, {"cachedOnly": True}, {"cacheOnly": True}, {"fromCache": True},
                   {"mock": True}, {"isMock": True}, {"seeded": True}, {"seed": True},
                   {"source": "synthetic fixture"}, {"provenance": "inferred chart axes"},
                   {"dataQualityFlags": ["refresh_failed"]}, {"sourceStatus": "disconnected"})
        for location in ("snapshot", "data", "metric", "chart"):
            for patch in patches:
                with self.subTest(location=location, patch=patch):
                    snapshot = captured_structure()
                    target = {"snapshot": snapshot, "data": snapshot["data"],
                              "metric": snapshot["data"]["chartMetrics"][THROTTLE],
                              "chart": snapshot["data"]["charts"][0]}[location]
                    target.update(patch)
                    self.assertEqual(verified_metric(snapshot, THROTTLE), {})
                    self.assertFalse(evidence_safe(target))
                    self.assertFalse(any(row["cells"][0] == "Gamma throttle"
                                         for row in metric_rows(snapshot, "cite")))

    def test_identity_parser_and_publication_bounds_are_required(self):
        for patch in ({"chartId": "c" * 64}, {"chartDate": "2026-09-22"}, {"chartDate": "2026-09-16"},
                      {"chartDate": "invalid"}, {"parserVersion": "unknown"}, {"extractionBasis": "axis-estimate"}):
            with self.subTest(patch=patch):
                snapshot = captured_structure()
                snapshot["data"]["chartMetrics"][THROTTLE].update(patch)
                self.assertEqual(verified_metric(snapshot, THROTTLE), {})
        for patch in ({"schemaVersion": "market-structure-v3"}, {"contentComplete": False}, {"date": None}):
            snapshot = {**captured_structure(), **patch}
            self.assertEqual(metric_rows(snapshot, "cite"), [])
        for patch in ({"sha256": "c" * 64}, {"s3Key": f"other/path/{THROTTLE_CHART}.png"}):
            snapshot = captured_structure()
            snapshot["data"]["charts"][0].update(patch)
            self.assertEqual(verified_metric(snapshot, THROTTLE), {})
        self.assertEqual(verified_metric(captured_structure(), "unknown"), {})
        self.assertEqual(metric_rows(None, "cite"), [])

    def test_partial_metrics_are_omitted_without_derivation(self):
        snapshot = captured_structure()
        del snapshot["data"]["chartMetrics"][GAMMA_MAP]
        snapshot["data"]["chartMetrics"][THROTTLE]["gammaThrottle"] = True
        self.assertEqual([row["cells"] for row in metric_rows(snapshot, "cite")],
                         [["10-day realized volatility", "10.71", "Sep 18, 2026"]])
        snapshot["data"]["chartMetrics"][THROTTLE]["tenDayRealizedVolatility"] = float("nan")
        self.assertEqual(metric_rows(snapshot, "cite"), [])

    def test_invalid_bands_and_strikes_do_not_invalidate_independent_readings(self):
        snapshot = captured_structure()
        metric = snapshot["data"]["chartMetrics"][GAMMA_MAP]
        metric.update(lowerPvBand=8000, strikesInPlay=[7500, True])
        self.assertEqual(verified_metric(snapshot, GAMMA_MAP), {"zeroGamma": 7649.0, "date": "2026-09-18"})
        self.assertEqual(len(metric_rows(snapshot, "cite")), 3)
        metric.update(lowerPvBand=7492, strikesInPlay=[])
        self.assertNotIn("strikesInPlay", verified_metric(snapshot, GAMMA_MAP))

    def test_legacy_parser_and_article_chart_location_remain_supported(self):
        snapshot = captured_structure()
        snapshot["article"] = {"charts": snapshot["data"].pop("charts")}
        for metric in snapshot["data"]["chartMetrics"].values():
            metric["parserVersion"] = "market-structure-chart-metrics-v2"
        self.assertEqual(len(metric_rows(snapshot, "cite")), 6)

    def test_unvalidated_source_labels_are_not_exposed(self):
        snapshot = captured_structure()
        snapshot["data"]["chartMetrics"][THROTTLE]["source"] = "<b>Hedgeye</b> user@example.com"
        rows = metric_rows(snapshot, "cite")
        self.assertEqual(len(rows), 6)
        self.assertNotIn("source", rows[0]["provenance"])


if __name__ == "__main__":
    unittest.main()
