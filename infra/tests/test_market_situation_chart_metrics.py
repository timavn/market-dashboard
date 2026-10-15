"""Source-label and chart geometry regressions for Market Situation metrics."""

import sys
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lambdas" / "gmail_ingestor"))
import parse_hedgeye_email_html as parser


def line(text, *, left=None, top=None, width=0.08, height=0.03):
    block = {"BlockType": "LINE", "Text": text}
    if left is not None and top is not None:
        block["Geometry"] = {"BoundingBox": {
            "Left": left, "Top": top, "Width": width, "Height": height,
        }}
    return block


class MarketSituationChartMetricTests(unittest.TestCase):
    def throttle(self, *lines):
        return parser._extract_spx_gamma_volatility_throttle_metric(
            {"Blocks": [line("SPX Gamma Volatility Throttle Vs. 10-Day Realized Volatility"),
                        *[line(text) for text in lines]]},
            chart_id="verified-chart-id",
        )

    def strike_map(self, *blocks):
        return parser._extract_spx_probable_volatility_gamma_metric(
            {"Blocks": [line("SPX Probable Volatility & Put/Call Gamma By Strike, Weighted Expirations"),
                        *blocks]},
            chart_id="verified-chart-id",
        )

    def test_throttle_does_not_require_realized_volatility_sibling(self):
        metric = self.throttle("Gamma Throttle: 0.08", "Date: 2026/09/11")
        self.assertEqual(metric["gammaThrottle"], Decimal("0.08"))
        self.assertNotIn("tenDayRealizedVolatility", metric)
        self.assertEqual(metric["chartDate"], "2026-09-11")
        self.assertEqual(metric["parserVersion"], "market-structure-chart-metrics-v3")

    def test_labels_do_not_consume_unrelated_numbers_on_next_ocr_line(self):
        metric = self.throttle("Gamma Throttle", "120", "10-Day rVol: 10.74", "Date: 2026/09/11")
        self.assertNotIn("gammaThrottle", metric)
        self.assertEqual(metric["tenDayRealizedVolatility"], Decimal("10.74"))
        self.assertIsNone(self.throttle("Gamma Throttle", "120", "Date: 2026/09/11"))

    def test_throttle_rejects_unlabeled_or_undated_values(self):
        self.assertIsNone(self.throttle("0.08", "10.74", "Date: 2026/09/11"))
        self.assertIsNone(self.throttle("Gamma Throttle: 0.08"))
        self.assertIsNone(self.throttle("Gamma Throttle: 999", "Date: 2026/09/11"))

    def test_flip_survives_missing_strikes_and_bands(self):
        metric = self.strike_map(line("Zero Gamma: 7656"), line("Date: 2026/09/11"))
        self.assertEqual(metric["zeroGamma"], Decimal("7656"))
        self.assertNotIn("strikesInPlay", metric)
        self.assertNotIn("upperPvBand", metric)
        self.assertNotIn("lowerPvBand", metric)

    def test_flip_line_label_is_accepted_only_with_source_date(self):
        metric = self.strike_map(line("Gamma Flip Line: 7,656"), line("Date: 2026/09/11"))
        self.assertEqual(metric["zeroGamma"], Decimal("7656"))
        self.assertIsNone(self.strike_map(line("Gamma Flip Line: 7,656")))

    def test_vertical_strike_callout_ignores_interleaved_axis_ticks(self):
        # Reduced geometry from the September 14 report's September 11 chart.
        # Textract places the far-right 7800 tick immediately after the heading.
        metric = self.strike_map(
            line("7900", left=0.965, top=0.092, width=0.023, height=0.021),
            line("Strikes In Play", left=0.0294, top=0.1527, width=0.0859, height=0.0352),
            line("7800", left=0.965, top=0.2071, width=0.023, height=0.021),
            line("7550.0", left=0.0292, top=0.2275, width=0.0459, height=0.0272),
            line("7600.0", left=0.0297, top=0.2655, width=0.0481, height=0.0269),
            line("7650.0", left=0.0294, top=0.3023, width=0.0480, height=0.0272),
            line("7700", left=0.965, top=0.3222, width=0.023, height=0.021),
            line("7700.0", left=0.0298, top=0.3398, width=0.0479, height=0.0265),
            line("7750.0", left=0.0296, top=0.3776, width=0.0466, height=0.0271),
            line("7400", left=0.0295, top=0.90, width=0.024, height=0.02),
            line("Zero Gamma 7656"), line("Upper PV Band: 7769.0"),
            line("Lower PV Band: 7512.0"), line("Date: 2026/09/11"),
            line("Source: Intrinio/Tier1Alpha.com"),
        )
        self.assertEqual(metric["zeroGamma"], Decimal("7656"))
        self.assertEqual(metric["upperPvBand"], Decimal("7769.0"))
        self.assertEqual(metric["lowerPvBand"], Decimal("7512.0"))
        self.assertEqual(metric["strikesInPlay"], [Decimal(value) for value in (7550, 7600, 7650, 7700, 7750)])
        self.assertEqual(metric["source"], "Intrinio/Tier1Alpha.com")

    def test_unpositioned_vertical_numbers_are_not_strikes(self):
        metric = self.strike_map(
            line("Strikes In Play"), line("7800"), line("7550.0"),
            line("Zero Gamma: 7656"), line("Date: 2026/09/11"),
        )
        self.assertNotIn("strikesInPlay", metric)

    def test_inline_strike_callout_is_preserved(self):
        metric = self.strike_map(
            line("Strikes In Play: 7550, 7600, 7650, 7700, 7750"),
            line("Zero Gamma: 7656"), line("Date: 2026/09/11"),
        )
        self.assertEqual(metric["strikesInPlay"], [Decimal(value) for value in (7550, 7600, 7650, 7700, 7750)])

    def test_contradictory_bands_do_not_discard_verified_flip(self):
        metric = self.strike_map(
            line("Zero Gamma: 7656"), line("Lower PV Band: 7790"),
            line("Upper PV Band: 7500"), line("Date: 2026/09/11"),
        )
        self.assertEqual(metric["zeroGamma"], Decimal("7656"))
        self.assertNotIn("lowerPvBand", metric)
        self.assertNotIn("upperPvBand", metric)


if __name__ == "__main__":
    unittest.main()
