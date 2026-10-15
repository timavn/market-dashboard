"""Manager-facing calculations retain source identity and never manufacture odds."""
import copy
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prediction_review import compact_analysis_markets, prediction_contract_row

NOW = datetime(2026, 9, 18, 21, 0, tzinfo=timezone.utc)
AS_OF = (NOW - timedelta(seconds=5)).isoformat()
EXPIRES = (NOW + timedelta(seconds=85)).isoformat()


def monitor():
    event = {"ticker": "EVENT", "venueId": "kalshi", "status": "open", "payoutAmount": 1, "closeTime": (NOW + timedelta(days=1)).isoformat()}
    lines = [{"ticker": f"EVENT-{strike}", "threshold": strike, "comparator": ">", "upperBound": None,
              "yesBid": .4, "yesAsk": .45, "noBid": .5, "noAsk": .55,
              "directNative": True, "derivedFields": [], "source": "kalshi_batch_orderbooks_v2",
              "evidence": {"quotes": {"source": "kalshi_batch_orderbooks_v2", "asOf": AS_OF, "fit": "exact"}}}
             for strike in (90, 100, 110, 120, 130)]
    reference = {"symbol": "TEST", "fit": "exact", "instrument": {"displaySymbol": "TEST", "secType": "IND"},
                 "spot": {"status": "available", "availability": "live", "fit": "exact", "value": 110,
                          "source": "ibkr_live_quote", "label": "TEST", "asOf": AS_OF, "expiresAt": EXPIRES}}
    return {"marketId": "silver", "asset": "Silver", "requestedVenue": "kalshi", "snapshot": {
        "marketId": "silver", "selectedVenueId": "kalshi", "displaySelection": {"venueId": "kalshi", "status": "available"},
        "displayContracts": {"status": "available", "event": event, "lines": lines, "bookExpiresAt": EXPIRES},
        "venues": {"kalshi": {"catalog": {"status": "available", "event": copy.deepcopy(event), "lines": copy.deepcopy(lines)},
                              "reference": reference, "settlementBasis": {"status": "verified", "instrument": "TEST", "sourceName": "Test venue"}}},
        "riskRange": {"status": "available", "ticker": "TEST", "fit": "exact", "lrr": 100, "hrr": 130,
                      "trend": "BEARISH", "date": "2026-09-18", "source": "hedgeye-risk-ranges-email"},
        "factors": {"trade": {"status": "available", "ticker": "TEST", "direction": "BULLISH", "date": "2026-09-17", "source": "published-trade"}},
    }}


class ManagerViewTests(unittest.TestCase):
    def view(self, raw):
        return prediction_contract_row(raw, now=NOW)["managerView"]

    def test_independent_trade_and_trend_native_ask_odds_and_gross_reward_risk(self):
        raw = monitor()
        view = self.view(raw)
        self.assertEqual(view["trade"]["direction"], "BULLISH")
        self.assertEqual(view["trade"]["publishedAt"], "2026-09-17")
        self.assertEqual(view["trend"]["direction"], "BEARISH")
        self.assertEqual(view["direction"]["basis"], "Trade")
        self.assertEqual(view["underlying"]["value"], 110)
        self.assertEqual(view["riskRange"]["rewardRisk"]["ratio"], 2)
        near, following = view["contracts"]["near"], view["contracts"]["next"]
        self.assertEqual((near["threshold"], following["threshold"]), (110, 120))
        self.assertEqual((near["side"], near["ask"], near["marketImpliedPct"]), ("YES", .45, 45))
        self.assertAlmostEqual(near["grossPayoffRatio"], .55 / .45)

    def test_bearish_uses_independent_no_ask_and_lower_adjacent_strike(self):
        raw = monitor()
        raw["snapshot"]["factors"]["trade"]["direction"] = "BEARISH"
        view = self.view(raw)
        self.assertEqual(view["contracts"]["next"]["threshold"], 100)
        self.assertEqual(view["contracts"]["near"]["side"], "NO")
        self.assertEqual(view["contracts"]["near"]["directionalComparator"], "<=")
        self.assertEqual(view["contracts"]["near"]["ask"], .55)
        self.assertAlmostEqual(view["contracts"]["near"]["marketImpliedPct"], 55)
        self.assertEqual(view["riskRange"]["rewardRisk"]["ratio"], .5)
        raw["snapshot"]["displayContracts"]["lines"][2]["noAsk"] = None
        self.assertIsNone(self.view(raw)["contracts"]["near"]["ask"])

    def test_missing_trade_uses_explicit_trend_basis_but_neutral_has_no_directional_choice(self):
        raw = monitor()
        raw["snapshot"]["factors"]["trade"] = {"status": "unavailable", "buyTrade": 100, "sellTrade": 130}
        self.assertEqual(self.view(raw)["direction"]["basis"], "Trend")
        self.assertIsNone(self.view(raw)["trade"])
        raw["snapshot"]["riskRange"]["trend"] = "NEUTRAL"
        view = self.view(raw)
        self.assertIsNone(view["direction"])
        self.assertIsNone(view["contracts"]["near"])
        self.assertIsNone(view["riskRange"]["rewardRisk"])

    def test_published_signal_survives_numerical_basis_gate_without_reinstating_ratio(self):
        raw = monitor()
        published = copy.deepcopy(raw["snapshot"]["riskRange"])
        raw["snapshot"]["publishedResearch"] = {"riskRange": published}
        raw["snapshot"]["riskRange"].update(status="unavailable", lrr=None, hrr=None, trend=None, hiddenByBasisGate=True)
        view = self.view(raw)
        self.assertEqual(view["trend"]["direction"], "BEARISH")
        self.assertEqual(view["riskRange"]["low"], 100)
        self.assertIsNone(view["riskRange"]["rewardRisk"])
        self.assertEqual(compact_analysis_markets([raw])[0]["snapshot"]["publishedResearch"]["riskRange"], published)

    def test_next_strike_is_actual_adjacent_catalog_strike_even_when_unquoted(self):
        raw = monitor()
        catalog = raw["snapshot"]["venues"]["kalshi"]["catalog"]
        catalog["lines"].insert(3, {"ticker": "EVENT-115", "threshold": 115, "comparator": ">"})
        level = self.view(raw)["contracts"]["next"]
        self.assertEqual(level["threshold"], 115)
        self.assertIsNone(level["ask"])
        self.assertIsNone(level["marketImpliedPct"])
        self.assertIsNone(level["grossPayoffRatio"])

    def test_proxy_price_is_labeled_and_does_not_anchor_contract_levels(self):
        raw = monitor()
        reference = raw["snapshot"]["venues"]["kalshi"]["reference"]
        reference["fit"] = reference["spot"]["fit"] = "proxy"
        view = self.view(raw)
        self.assertEqual(view["underlying"]["fit"], "proxy")
        self.assertFalse(view["contracts"]["referenceComparable"])
        self.assertEqual(view["contracts"]["selectionBasis"], "quoted_level")
        self.assertIsNotNone(view["contracts"]["near"]["ask"])
        self.assertIsNone(view["riskRange"]["rewardRisk"])

    def test_unrelated_index_range_cannot_use_exact_futures_price(self):
        raw = monitor()
        raw["snapshot"]["riskRange"].update(ticker="COMPQ", fit="related_only")
        self.assertIsNone(self.view(raw)["riskRange"]["rewardRisk"])
        self.assertEqual(self.view(raw)["riskRange"]["instrument"], "COMPQ")

    def test_nasdaq_cash_index_is_not_the_dated_fnq_resolver(self):
        raw = monitor()
        venue = raw["snapshot"]["venues"]["kalshi"]
        venue["catalog"]["event"]["resolverSymbol"] = "NQZ26"
        venue["settlementBasis"]["instrument"] = "NQZ26"
        venue["reference"]["instrument"].update(displaySymbol="NDX", secType="IND")
        self.assertFalse(self.view(raw)["contracts"]["referenceComparable"])

    def test_verified_last_close_is_dated_and_only_anchors_the_same_resolver(self):
        raw = monitor()
        reference = raw["snapshot"]["venues"]["kalshi"]["reference"]
        reference["spot"].update(status="historical", availability="historical", source="ibkr_historical_daily_close",
                                 label="TEST LAST CLOSE", asOf="2026-09-18T20:00:00Z", historicalThroughDate="2026-09-18")
        view = self.view(raw)
        self.assertEqual(view["underlying"]["state"], "LAST CLOSE")
        self.assertEqual(view["underlying"]["sessionDate"], "2026-09-18")
        self.assertEqual(view["contracts"]["referenceState"], "LAST CLOSE")
        self.assertEqual(view["contracts"]["near"]["threshold"], 110)
        reference["spot"]["cachedOnly"] = True
        self.assertIsNone(self.view(raw)["underlying"])
        self.assertEqual(self.view(raw)["contracts"]["selectionBasis"], "quoted_level")

    def test_nonpositive_risk_or_outside_range_does_not_create_infinite_ratio(self):
        for value in (100, 130, 150):
            raw = monitor()
            raw["snapshot"]["venues"]["kalshi"]["reference"]["spot"]["value"] = value
            self.assertIsNone(self.view(raw)["riskRange"]["rewardRisk"])

    def test_zero_ask_is_not_infinite_payoff_and_less_than_comparator_selects_no_for_bullish(self):
        raw = monitor()
        for collection in (raw["snapshot"]["displayContracts"], raw["snapshot"]["venues"]["kalshi"]["catalog"]):
            for line in collection["lines"]:
                line.update(comparator="<", noAsk=0, noBid=0)
        near = self.view(raw)["contracts"]["near"]
        self.assertEqual((near["side"], near["ask"], near["marketImpliedPct"]), ("NO", 0, 0))
        self.assertEqual(near["directionalComparator"], ">=")
        self.assertIsNone(near["grossPayoffRatio"])

    def test_stale_offline_cached_mock_and_derived_prices_never_supply_odds(self):
        for mutation in ({"stale": True}, {"connected": False}, {"cacheOnly": True}, {"mock": True},
                         {"seeded": True}, {"source": "synthetic_seed"}, {"derivedFields": ["noAsk"]},
                         {"yesBid": .6, "yesAsk": .45}):
            with self.subTest(mutation=mutation):
                raw = monitor()
                raw["snapshot"]["displayContracts"]["lines"][2].update(mutation)
                self.assertIsNone(self.view(raw)["contracts"]["near"]["ask"])
        raw = monitor()
        raw["snapshot"]["displayContracts"]["bookExpiresAt"] = (NOW - timedelta(seconds=1)).isoformat()
        self.assertIsNone(self.view(raw)["contracts"]["near"]["ask"])

    def test_signal_missing_provenance_or_unavailable_is_not_inferred(self):
        for mutation in ({"status": "unavailable"}, {"source": None}, {"date": None}, {"mock": True}, {"cacheOnly": True}):
            raw = monitor()
            raw["snapshot"]["factors"]["trade"].update(mutation)
            self.assertIsNone(self.view(raw)["trade"])
            self.assertEqual(self.view(raw)["direction"]["basis"], "Trend")

    def test_unsafe_published_or_gated_ranges_cannot_supply_range_math(self):
        for flag in ("isMock", "isStale", "modelOnly"):
            raw = monitor()
            raw["snapshot"]["riskRange"][flag] = True
            view = self.view(raw)
            self.assertIsNone(view["trend"])
            self.assertIsNone(view["riskRange"])
            raw = monitor()
            raw["snapshot"]["publishedResearch"] = {"riskRange": copy.deepcopy(raw["snapshot"]["riskRange"])}
            raw["snapshot"]["riskRange"][flag] = True
            self.assertIsNone(self.view(raw)["riskRange"]["rewardRisk"])

    def test_neutral_without_underlying_still_compares_native_yes_no_and_adjacent_strikes(self):
        raw = monitor()
        raw["snapshot"]["factors"]["trade"]["direction"] = "NEUTRAL"
        raw["snapshot"]["venues"]["kalshi"]["reference"]["spot"]["status"] = "unavailable"
        raw["snapshot"]["displayContracts"]["lines"][2]["volume24h"] = 100
        view = self.view(raw)
        self.assertIsNone(view["underlying"])
        self.assertIsNone(view["direction"])
        self.assertEqual(view["contracts"]["selectionBasis"], "quoted_level")
        levels = view["contracts"]["comparisons"]
        self.assertEqual([(line["threshold"], line["side"]) for line in levels], [(110, "YES"), (110, "NO"), (120, "YES"), (100, "NO")])
        self.assertEqual([line["ask"] for line in levels], [.45, .55, .45, .55])
        self.assertTrue(all(line["marketImpliedPct"] is not None for line in levels))

    def test_unsafe_envelopes_withhold_current_math_but_keep_independent_publications(self):
        for target in ("raw", "snapshot"):
            for flag in ("stale", "isStale", "cacheOnly", "mock", "seeded", "offline", "disconnected", "refreshFailed"):
                with self.subTest(target=target, flag=flag):
                    raw = monitor()
                    (raw if target == "raw" else raw["snapshot"])[flag] = True
                    view = self.view(raw)
                    self.assertIsNone(view["underlying"])
                    self.assertIsNone(view["riskRange"]["rewardRisk"])
                    self.assertEqual(view["contracts"]["comparisons"], [])
                    self.assertEqual(view["trend"]["direction"], "BEARISH")
        raw = monitor()
        raw["snapshot"]["status"] = "unavailable"
        self.assertEqual(self.view(raw)["contracts"]["near"]["ask"], .45)

    def test_non_unit_or_unverified_payout_does_not_produce_unit_payout_odds(self):
        for payout in (None, 100):
            raw = monitor()
            raw["snapshot"]["venues"]["kalshi"]["catalog"]["event"]["payoutAmount"] = payout
            level = self.view(raw)["contracts"]["near"]
            self.assertEqual(level["ask"], .45)
            self.assertIsNone(level["marketImpliedPct"])
            self.assertIsNone(level["grossPayoffRatio"])

    def test_gold_uses_published_instrument_label_without_reclassifying_its_basis(self):
        raw = monitor()
        raw["snapshot"]["riskRange"].update(ticker="GLD", instrumentLabel="Gold Spot Price", fit="strong_proxy")
        view = self.view(raw)
        self.assertEqual(view["trend"]["instrument"], "Gold Spot Price")
        self.assertEqual(view["riskRange"]["instrument"], "Gold Spot Price")
        self.assertEqual(view["riskRange"]["fit"], "strong_proxy")
        self.assertIsNone(view["riskRange"]["rewardRisk"])

    def test_readable_settlement_label_requires_the_same_verified_source(self):
        raw = monitor()
        venue = raw["snapshot"]["venues"]["kalshi"]
        venue["settlementBasis"].update(sourceName="Pyth", sourceUrl="https://pyth.example/silver", instrument="Metal.Index.SILVER/USD")
        venue["catalog"]["event"]["settlementSources"] = [{"name": "Pyth - Silver", "url": "https://pyth.example/silver"}]
        venue["catalog"]["event"]["expirationTime"] = (NOW + timedelta(days=2)).isoformat()
        contracts = self.view(raw)["contracts"]
        self.assertEqual(contracts["settlementLabel"], "Pyth - Silver")
        self.assertEqual(contracts["settlementSource"], "Pyth")
        self.assertEqual(contracts["settlementInstrument"], "Metal.Index.SILVER/USD")
        self.assertEqual(contracts["expiresAt"], (NOW + timedelta(days=2)).isoformat())
        venue["catalog"]["event"]["settlementSources"][0]["url"] = "https://unrelated.example/gold"
        self.assertEqual(self.view(raw)["contracts"]["settlementLabel"], "Pyth")
        venue["settlementBasis"]["status"] = "unavailable"
        self.assertIsNone(self.view(raw)["contracts"]["settlementLabel"])


if __name__ == "__main__":
    unittest.main()
