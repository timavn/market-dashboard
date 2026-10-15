from copy import deepcopy
import unittest

from review_runs_v2 import render_prediction_review


CITATIONS = [{"id": "cite_alpha", "product": "early-look", "productLabel": "Early Look", "publicationDate": "2026-09-17"}]


def market(market_id="sp500", *, alpha=True):
    row = {"marketId": market_id, "asset": {"sp500": "S&P 500", "cpi": "CPI"}.get(market_id, market_id.title()),
           "venue": "ForecastEx" if market_id in {"cpi", "sp500"} else "Kalshi",
           "fields": [["Hedgeye nowcast", "3.61% · published 2026-09-16"], ["CPI release", "2026-10-14T12:30:00Z"]],
           "managerView": {"version": 1, "trade": None, "trend": None,
               "underlying": {"value": 7600, "label": "SPX"},
               "riskRange": {"low": 7500, "high": 7800, "instrument": "SPX", "publishedAt": "2026-09-18",
                             "rewardRisk": {"ratio": 2, "direction": "BULLISH"}},
               "contracts": {"comparisons": [{"label": "Current strike", "threshold": 7600, "side": "YES",
                                               "directionalComparator": ">", "ask": .4, "marketImpliedPct": 40,
                                               "grossPayoffRatio": 1.5}]}},
           "research": {"sections": []}}
    if alpha:
        row["research"]["alphaCode"] = {"marketId": market_id, "instrument": "SPX", "tradeLevel": 7651,
                                           "trendLevel": 7501, "publicationDate": "2026-09-17", "approximate": False,
                                           "citationIds": ["cite_alpha"]}
    return row


def render(rows, citations=CITATIONS):
    return render_prediction_review([{"id": "monitored-markets", "markets": rows}], "partial", citations)


class PredictionAlphaRenderTests(unittest.TestCase):
    def test_cited_alpha_levels_sit_immediately_below_range_and_leave_signals_unchanged(self):
        row = market()
        original = deepcopy(row)
        report = render([row])
        alpha = "**Alpha codes:** Trade 7,651 · Trend 7,501 · Sep 17, 2026 · Sources: [Early Look](citation://cite_alpha)"
        self.assertIn(alpha, report)
        lines = report.splitlines()
        range_index = next(index for index, line in enumerate(lines) if line.startswith("**Risk Range:**"))
        self.assertEqual(lines[range_index + 1].strip(), alpha)
        self.assertLess(report.index(alpha), report.index("**Underlying reward/risk:**"))
        self.assertIn("**Trade:** —", report)
        self.assertIn("**Trend:** —", report)
        self.assertIn("**Underlying:** SPX 7,600", report)
        self.assertEqual(row, original)

    def test_all_six_cards_have_alpha_line_and_cpi_places_it_before_contracts(self):
        rows = [market(key) for key in ("cpi", "sp500", "gold", "silver", "bitcoin", "ethereum")]
        report = render(rows)
        self.assertEqual(report.count("**Alpha codes:**"), 6)
        cpi = report.split("### CPI", 1)[1].split("### S&P 500", 1)[0]
        self.assertLess(cpi.index("**CPI release:**"), cpi.index("**Alpha codes:**"))
        self.assertLess(cpi.index("**Alpha codes:**"), cpi.index("| Level |"))
        self.assertNotIn("**Risk Range:**", cpi)

    def test_unsupported_alpha_is_a_compact_dash_for_each_card(self):
        rows = [market(key, alpha=False) for key in ("cpi", "sp500", "gold", "silver", "bitcoin", "ethereum")]
        self.assertEqual(render(rows).count("**Alpha codes:** —"), 6)
        row = market(alpha=False)
        row["managerView"] = {}
        self.assertIn("**Alpha codes:** —", render([row]))

    def test_preserves_published_precision_and_marks_explicit_approximations(self):
        row = market("bitcoin")
        row["research"]["alphaCode"].update(tradeLevel=101234.125, trendLevel=.012345, approximate=True)
        report = render([row])
        self.assertIn("Trade ≈101,234.125 · Trend ≈0.012345", report)
        self.assertNotIn("101,234.13", report)

    def test_invalid_values_dates_market_identity_and_missing_evidence_are_not_rendered(self):
        for updates in ({"tradeLevel": float("nan"), "trendLevel": float("inf")},
                        {"tradeLevel": True, "trendLevel": -1}, {"tradeLevel": None},
                        {"tradeLevel": "7651<script>", "trendLevel": 0},
                        {"publicationDate": "2026-09-31"}, {"publicationDate": "2026-09-17[bad](https://bad)"},
                        {"marketId": "gold"}, {"instrument": ""},
                        {"citationIds": ["missing"]}, {"citationIds": ["cite_alpha)[bad](https://bad)"]}):
            with self.subTest(updates=updates):
                row = market()
                row["research"]["alphaCode"].update(updates)
                report = render([row])
                self.assertIn("**Alpha codes:** —", report)
                self.assertNotIn("<script>", report)
                self.assertNotIn("https://bad", report)
        row = market()
        self.assertIn("**Alpha codes:** —", render([row], []))

    def test_source_links_are_deduplicated_and_ignore_malformed_ids(self):
        row = market()
        row["research"]["alphaCode"].update(citationIds=["cite_alpha", "cite_alpha", None, {}])
        report = render([row])
        self.assertIn("**Alpha codes:** Trade 7,651 · Trend 7,501 · Sep 17, 2026", report)
        self.assertEqual(report.count("citation://cite_alpha"), 1)


if __name__ == "__main__":
    unittest.main()
