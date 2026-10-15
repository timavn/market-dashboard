import copy
import unittest

from prediction_research_rollup import accepted_prediction_snapshots, build_prediction_research_rollup, prediction_research_section_excluded
from test_daily_research_rollup import snapshot, evidence, CUTOFF, PRIOR


def contents(report, market):
    return str(report["markets"][market]["sections"])


class PredictionResearchRollupTests(unittest.TestCase):
    def test_missing_today_keeps_latest_captured_publication_with_its_original_date(self):
        prior = {
            "signal-strength": snapshot("signal-strength", day=PRIOR, data={"added": ["GLD"]}),
            "the-macro-show": snapshot("the-macro-show", day=PRIOR, body="Gold remains bullish."),
            "the-call": snapshot("the-call", day=PRIOR, body="Gold remains neutral."),
        }
        raw = evidence({product: None for product in prior}, prior)
        original = copy.deepcopy(raw)
        accepted = accepted_prediction_snapshots(raw, as_of=CUTOFF)
        self.assertEqual({product: value["date"] for product, value in accepted.items()},
                         {product: PRIOR for product in prior})
        report = build_prediction_research_rollup(raw, as_of=CUTOFF)
        self.assertIn("Added", contents(report, "gold"))
        self.assertIn("Gold remains neutral", contents(report, "gold"))
        self.assertNotIn("→", contents(report, "gold"))
        self.assertEqual({citation["publicationDate"] for citation in report["citations"]}, {PRIOR})
        self.assertEqual(raw, original)
        # Portfolio retains only Signal Strength's event-driven prior edition;
        # other products keep their existing exact-day selection.
        from daily_research_rollup import accepted_snapshots
        self.assertEqual(accepted_snapshots(raw, as_of=CUTOFF), {"signal-strength": prior["signal-strength"]})

    def test_current_publication_supersedes_prior_and_rejected_prior_never_becomes_research(self):
        current = snapshot("the-call", body="Gold remains neutral.")
        prior = snapshot("the-call", day=PRIOR, body="Gold remains bullish.")
        raw = evidence({"the-call": current}, {"the-call": prior})
        self.assertEqual(accepted_prediction_snapshots(raw, as_of=CUTOFF)["the-call"], current)
        for update in ({"mock": True}, {"seeded": True}, {"source": "synthetic fixture"},
                       {"refreshFailed": True}, {"status": "failed"}, {"snapshotType": "early-look"},
                       {"date": "2026-06-05"}, {"publishedAt": "2026-06-04T20:00:00Z"}):
            with self.subTest(update=update):
                raw = evidence({"the-call": None}, {"the-call": {**prior, **update}})
                self.assertEqual(accepted_prediction_snapshots(raw, as_of=CUTOFF), {})

    def test_legacy_crypto_quant_keeps_its_actual_source_without_tracker_trade_authority(self):
        current = snapshot("bitcoin-trend-tracker", reportType="crypto-quant", data={"cryptos": {
            "BTC": {"trend": "BULLISH", "trade": "BEARISH", "buyTrade": 70000, "sellTrade": 80000, "price": 77777},
        }})
        prior = snapshot("bitcoin-trend-tracker", day=PRIOR, reportType="crypto-quant", data={"cryptos": {
            "BTC": {"trend": "NEUTRAL", "buyTrade": 69000, "sellTrade": 79000},
        }})
        raw = evidence({"bitcoin-trend-tracker": current, "crypto-quant": {**current, "snapshotType": "crypto-quant"}},
                       {"bitcoin-trend-tracker": prior})
        original = copy.deepcopy(raw)
        result = build_prediction_research_rollup(raw, as_of=CUTOFF)
        self.assertEqual(raw, original)
        self.assertEqual(set(accepted_prediction_snapshots(raw, as_of=CUTOFF)), {"crypto-quant"})
        self.assertEqual([row["title"] for row in result["markets"]["bitcoin"]["sections"]], ["Crypto Quant"])
        self.assertIn("Crypto Quant reading", contents(result, "bitcoin"))
        self.assertIn("Neutral → Bullish", contents(result, "bitcoin"))
        self.assertIn("70,000–80,000", contents(result, "bitcoin"))
        self.assertNotIn("Bearish", contents(result, "bitcoin"))
        self.assertNotIn("Tracker", contents(result, "bitcoin"))
        self.assertNotIn("77777", contents(result, "bitcoin"))
        self.assertEqual(result["markets"]["ethereum"]["sections"], [])
        self.assertEqual(len(result["citations"]), 2)
        self.assertEqual({row["product"] for row in result["citations"]}, {"crypto-quant"})

    def test_legacy_alias_does_not_bypass_publication_safety_or_cutoff(self):
        base = snapshot("bitcoin-trend-tracker", reportType="crypto-quant", data={"cryptos": {"BTC": {"trend": "BULLISH"}}})
        for update in ({"mock": True}, {"seeded": True}, {"source": "synthetic fixture"},
                       {"refreshFailed": True}, {"publishedAt": "2026-06-04T20:00:00Z"}, {"reportType": "risk-ranges"}):
            with self.subTest(update=update):
                result = build_prediction_research_rollup(evidence({"bitcoin-trend-tracker": {**base, **update}}), as_of=CUTOFF)
                self.assertEqual(result["citations"], [])

    def test_asset_sections_filter_source_lists_and_retain_changes_and_publications(self):
        current = snapshot("the-call", body="MAIN SUMMARY\n\nBitcoin is bullish, while Ethereum remains neutral.\n\nGold is neutral.\n\nHEDGEYE POSITIONS\n\nLONGS: Bitcoin (BTC), Oil (USO)\n\nNEUTRAL: Ethereum (ETH), Gold (GLD)")
        prior = snapshot("the-call", day=PRIOR, body="HEDGEYE POSITIONS\n\nSHORTS: Bitcoin (BTC)\n\nNEUTRAL: Ethereum (ETH)")
        raw = evidence({"the-call": current}, {"the-call": prior})
        original = copy.deepcopy(raw)
        report = build_prediction_research_rollup(raw, as_of=CUTOFF)
        self.assertEqual(raw, original)
        btc = contents(report, "bitcoin")
        self.assertIn("Short → Long", btc)
        self.assertNotIn("USO", btc)
        self.assertNotIn("Gold is neutral", btc)
        self.assertEqual(report["markets"]["silver"]["sections"], [])
        self.assertEqual(set(report["markets"]), {"cpi", "sp500", "nasdaq100", "gold", "silver", "bitcoin", "ethereum"})
        used = {cid for market in report["markets"].values() for cid in market["citationIds"]}
        self.assertEqual(used, {row["id"] for row in report["citations"]})

    def test_prediction_omits_macro_and_drivers_without_changing_portfolio_research(self):
        from daily_research_rollup import build_daily_research_rollup
        raw = evidence({"early-look": snapshot("early-look", body="CPI inflation remains in focus."),
                        "top-3-things": snapshot("top-3-things", data={"items": [{"rank": 1, "title": "Gold", "body": "Gold demand rose."}]}),
                        "the-macro-show": snapshot("the-macro-show", body="Gold remains bullish as CPI accelerates.")})
        original = copy.deepcopy(raw)
        daily = build_daily_research_rollup(raw, as_of=CUTOFF)
        self.assertEqual({section["id"] for section in daily["sections"]}, {"macro-regime", "macro-show", "market-drivers"})
        report = build_prediction_research_rollup(raw, as_of=CUTOFF)
        self.assertTrue(all(not market["sections"] for market in report["markets"].values()))
        self.assertEqual(report["citations"], [])
        self.assertEqual(raw, original)

    def test_excluded_research_section_identity_accepts_saved_titles_and_ids(self):
        for section in ({"id": "market-drivers", "title": "Legacy title"}, {"id": "saved", "title": "Market drivers"},
                        {"title": "Today's market drivers"}, {"title": "Today’s market drivers"},
                        {"title": "MACRO & REGIME"}, {"id": "macro-show"}):
            with self.subTest(section=section):
                self.assertTrue(prediction_research_section_excluded(section))
        for title in ("Market structure & flows", "Trend & range changes", "Crypto Quant", "Research"):
            self.assertFalse(prediction_research_section_excluded({"title": title}))

    def test_tracker_preserves_each_crypto_reading_excludes_report_price_and_other_assets(self):
        tracker = snapshot("bitcoin-trend-tracker", data={"cryptos": {
            "BTC": {"trend": "BULLISH", "buyTrade": 70000, "sellTrade": 80000, "price": 77777},
            "ETH": {"trade": "BEARISH", "buyTrade": 2300, "sellTrade": 2700, "price": 2525},
            "SOL": {"trend": "NEUTRAL", "buyTrade": 100, "sellTrade": 120},
        }})
        prior = snapshot("bitcoin-trend-tracker", day=PRIOR, data={"cryptos": {
            "ETH": {"trend": "BULLISH", "buyTrade": 2200, "sellTrade": 2600},
        }})
        result = build_prediction_research_rollup(evidence({"bitcoin-trend-tracker": tracker}, {"bitcoin-trend-tracker": prior}), as_of=CUTOFF)
        self.assertIn("70,000–80,000", contents(result, "bitcoin"))
        self.assertNotIn("77777", contents(result, "bitcoin"))
        self.assertNotIn("SOL", contents(result, "bitcoin"))
        self.assertIn("Bullish → Bearish", contents(result, "ethereum"))
        self.assertIn("2,200–2,600 → 2,300–2,700", contents(result, "ethereum"))
        self.assertNotIn("70,000", contents(result, "ethereum"))
        self.assertEqual(len(result["citations"]), 2)

    def test_a_bitcoin_only_tracker_never_supplies_ethereum_readings(self):
        tracker = snapshot("bitcoin-trend-tracker", data={"cryptos": {"BTC": {"trend": "BULLISH", "buyTrade": 10, "sellTrade": 20}}})
        result = build_prediction_research_rollup(evidence({"bitcoin-trend-tracker": tracker}), as_of=CUTOFF)
        self.assertEqual(result["markets"]["ethereum"]["sections"], [])

    def test_fabricated_tracker_rows_cannot_supply_a_published_reading(self):
        for flag in ("mock", "seed", "seeded", "synthetic", "inferred", "fallback"):
            with self.subTest(flag=flag):
                tracker = snapshot("bitcoin-trend-tracker", data={"cryptos": {"BTC": {"trend": "BULLISH", flag: True}}})
                result = build_prediction_research_rollup(evidence({"bitcoin-trend-tracker": tracker}), as_of=CUTOFF)
                self.assertEqual(result["markets"]["bitcoin"]["sections"], [])

    def test_meta_date_publication_remains_citable(self):
        tracker = snapshot("bitcoin-trend-tracker", data={"cryptos": {"BTC": {"trend": "BULLISH"}}})
        tracker["meta"] = {"date": tracker.pop("date")}
        result = build_prediction_research_rollup(evidence({"bitcoin-trend-tracker": tracker}), as_of=CUTOFF)
        self.assertEqual(result["citations"][0]["publicationDate"], "2026-06-04")
        self.assertIn("Bullish", contents(result, "bitcoin"))

    def test_future_fake_failed_and_invalid_publications_are_excluded(self):
        base = snapshot("bitcoin-trend-tracker", data={"cryptos": {"BTC": {"trend": "BULLISH"}}})
        for update in ({"mock": True}, {"seeded": True}, {"source": "synthetic fixture"},
                       {"status": "failed"}, {"refreshFailed": True}, {"error": "timeout"},
                       {"publishedAt": "2026-06-04T20:00:00Z"}, {"date": "2026-06-05"}):
            with self.subTest(update=update):
                result = build_prediction_research_rollup(evidence({"bitcoin-trend-tracker": {**base, **update}}), as_of=CUTOFF)
                self.assertEqual(result["citations"], [])
        self.assertEqual(build_prediction_research_rollup({}, as_of="invalid")["citations"], [])

    def test_dated_publications_survive_disconnected_quote_provider_without_becoming_quotes(self):
        tracker = snapshot("bitcoin-trend-tracker", data={"cryptos": {"BTC": {"trend": "BULLISH", "price": 77777}}},
                           providerStatus="offline", fromCache=True)
        result = build_prediction_research_rollup(evidence({"bitcoin-trend-tracker": tracker}), as_of=CUTOFF)
        self.assertIn("Bullish", contents(result, "bitcoin"))
        self.assertNotIn("77777", contents(result, "bitcoin"))
        self.assertNotIn("LIVE", contents(result, "bitcoin"))

    def test_cpi_only_adds_published_inflation_prose_not_unmatched_forecast_numbers(self):
        inflation = snapshot("inflation-nowcast", body="CPI inflation is expected to accelerate next month.",
                             data={"scenarios": [{"value": 9.99}]})
        result = build_prediction_research_rollup(evidence({"inflation-nowcast": inflation}), as_of=CUTOFF)
        self.assertIn("expected to accelerate", contents(result, "cpi"))
        self.assertNotIn("9.99", contents(result, "cpi"))
        self.assertEqual(result["markets"]["bitcoin"]["sections"], [])

    def test_range_changes_stay_with_published_instrument_and_two_source_dates(self):
        now = snapshot("risk-ranges", data={"GLD": {"originalName": "Gold Spot Price", "trend": "NEUTRAL", "lrr": 4100, "hrr": 4400}})
        prior = snapshot("risk-ranges", day=PRIOR, data={"GLD": {"originalName": "Gold Spot Price", "trend": "BEARISH", "lrr": 4000, "hrr": 4300}})
        result = build_prediction_research_rollup(evidence({"risk-ranges": now}, {"risk-ranges": prior}), as_of=CUTOFF)
        self.assertIn("Gold Spot Price", contents(result, "gold"))
        self.assertEqual(len(result["citations"]), 2)
        self.assertEqual(result["markets"]["silver"]["sections"], [])
        comparison = next(block for section in result["markets"]["gold"]["sections"]
                          for block in section["blocks"] if "Prior range" in block.get("columns", []))
        self.assertEqual(comparison["columns"], ["Ticker", "Security", "Prior range", "Published range", "Trend"])
        self.assertEqual(comparison["rows"][0]["cells"], ["—", "Gold Spot Price", "4,000–4,300", "4,100–4,400", "Neutral"])
        self.assertEqual(len(comparison["rows"][0]["citationIds"]), 2)
        self.assertNotIn("Higher high", contents(result, "gold"))
        self.assertNotIn("Higher low", contents(result, "gold"))
