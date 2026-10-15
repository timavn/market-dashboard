"""Canonical monitor regressions: preserve facts without inventing trade inputs."""

import copy
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prediction_review import compact_analysis_markets, prediction_contract_row
from review_runs_v2 import _prediction_manager_date, render_prediction_review, render_review

NOW = datetime(2026, 9, 7, 6, 35, tzinfo=timezone.utc)


def monitor(market_id="silver", venue="forecastex", now=NOW):
    as_of = (now - timedelta(seconds=5)).isoformat()
    expires = (now + timedelta(seconds=85)).isoformat()
    source = "ibkr_tws_forecastex_live" if venue == "forecastex" else "kalshi_batch_orderbooks_v2"
    line = {"ticker": f"{market_id}-quoted", "threshold": 66, "comparator": ">",
            "yesBid": .44, "yesAsk": .46, "noBid": .54, "noAsk": .56,
            "source": source, "directNative": True, "derivedFields": [],
            # Metadata creation time must not replace the live quote timestamp.
            "updatedAt": "2025-01-01T00:00:00Z",
            "evidence": {"quotes": {"source": source, "asOf": as_of, "fit": "exact"}}}
    return {"marketId": market_id, "asset": market_id.title(), "requestedVenue": venue, "status": "available", "snapshot": {
        "marketId": market_id, "selectedVenueId": venue,
        "displaySelection": {"venueId": venue, "status": "available"},
        "displayContracts": {"status": "available", "asOf": as_of,
            "expiresAt": (now + timedelta(days=1)).isoformat(), "bookExpiresAt": expires,
            "bookStatus": "partial", "refreshPending": True, "refreshRetained": True,
            "event": {"ticker": f"{market_id}-event", "venueId": venue, "status": "open",
                      "closeTime": (now + timedelta(days=1)).isoformat()},
            "lines": [dict(line, ticker=f"{market_id}-unquoted", threshold=1, yesBid=None, yesAsk=None, noBid=None, noAsk=None), line]},
        "venues": {venue: {"settlementBasis": {"status": "verified", "instrument": "TEST", "sourceName": "Test venue"},
            "reference": {"fit": "exact", "spot": {"status": "available", "availability": "live", "fit": "exact",
                "value": 66, "source": "ibkr_live_quote", "label": "TEST", "asOf": as_of, "expiresAt": expires}}}},
        "riskRange": {"status": "available", "lrr": 63, "hrr": 69, "trend": "BULLISH", "date": "2026-09-04", "source": "hedgeye-risk-ranges-email"},
        "factors": {"trade": {"status": "available", "direction": "BULLISH", "source": "momo-tracker", "date": "2026-09-04"}},
        "scoreInputs": {"trade": {"direction": "BEARISH"}},
        "session": {"state": "closed"},
    }}


class PredictionReviewTests(unittest.TestCase):
    def row(self, raw):
        return prediction_contract_row(raw, now=NOW)

    def test_canonical_prices_ranges_and_trade_survive_incomplete_execution(self):
        row = self.row(monitor())
        self.assertEqual(row["status"], "available")
        self.assertEqual(row["identity"], "silver-quoted")
        self.assertEqual(row["quotedLineCount"], 1)
        self.assertEqual(row["settlementState"], "open")
        self.assertEqual(row["nativeBook"], "YES 0.44/0.46; NO 0.54/0.56")
        self.assertIn("Buy 63 · Sell 69", row["researchState"])
        self.assertIn("BULLISH", dict(row["fields"])["Trade signal"])
        self.assertIn("Displayed size is incomplete", " ".join(row["gaps"]))

    def test_independent_dated_trade_reaches_review_with_its_source_when_same_session_gate_is_empty(self):
        raw = monitor("bitcoin")
        snapshot = raw["snapshot"]
        snapshot["factors"]["trade"] = {"status": "unavailable", "direction": None}
        snapshot["riskRange"].update(ticker="BITCOIN", trend="BULLISH")
        snapshot["publishedResearch"] = {"riskRange": snapshot["riskRange"], "trade": {
            "status": "available", "direction": "BEARISH", "ticker": "BITCOIN", "date": "2026-08-12",
            "source": "early-look", "sourceUrl": "https://app.hedgeye.com/feed_items/123",
            "sourcePublishedAt": "2026-08-12T11:30:00Z", "retainedPublication": True,
            "signalProvenance": {"field": "trade", "method": "explicit-statement", "sourceField": "article.bodyText",
                                 "sourceText": "BITCOIN is BEARISH on TRADE."},
            "contextOnly": True, "decisionEligible": False, "executable": False,
        }}
        row = self.row(raw)
        self.assertEqual(row["managerView"]["trade"]["direction"], "BEARISH")
        self.assertEqual(row["managerView"]["trade"]["publishedAt"], "2026-08-12T11:30:00Z")
        self.assertEqual(row["managerView"]["trade"]["sourceUrl"], "https://app.hedgeye.com/feed_items/123")
        self.assertEqual(row["managerView"]["trend"]["direction"], "BULLISH")
        self.assertEqual(row["managerView"]["direction"]["basis"], "Trade")
        report = render_prediction_review([{"id": "monitored-markets", "markets": [row]}], "partial")
        self.assertIn("**Trade:** Bearish · BITCOIN · Aug 12, 2026 · [Source](https://app.hedgeye.com/feed_items/123)", report)

    def test_stale_offline_seeded_and_failed_refresh_never_render_prices(self):
        for mutation in ({"stale": True}, {"cachedOnly": True}, {"fromCache": True},
                         {"mock": True}, {"seeded": True}, {"refreshFailed": True},
                         {"connected": False}, {"status": "offline"}, {"source": "synthetic_seed"}):
            with self.subTest(mutation=mutation):
                raw = monitor()
                raw["snapshot"]["displayContracts"].update(mutation)
                row = self.row(raw)
                self.assertEqual(row["quotedLineCount"], 0)
                self.assertFalse(any("native quote" in label for label, _ in row["fields"]))

    def test_nasdaq_keeps_fnq_quotes_and_compq_related_research_distinct(self):
        raw = monitor("nasdaq100", "forecastex")
        raw["asset"] = "Nasdaq 100"
        raw["snapshot"]["riskRange"].update(ticker="COMPQ", fit="related_only",
            reason="Related index only; this range is not eligible for Nasdaq-100 scoring or sizing.")
        raw["snapshot"]["factors"]["trade"]["ticker"] = "COMPQ"
        row = self.row(raw)
        self.assertEqual(row["venue"], "ForecastEx")
        self.assertEqual(row["quotedLineCount"], 1)
        self.assertIn("COMPQ · Lower 63 · Upper 69", dict(row["fields"])["Risk range · context only"])
        self.assertIn("COMPQ Trade signal", dict(row["fields"]))
        self.assertNotIn("Buy", row["researchState"])
        self.assertIn("not eligible for Nasdaq-100 scoring or sizing", " ".join(row["gaps"]))
        self.assertIsNone(row["liveReference"])
        for mutation in ({"stale": True}, {"cachedOnly": True}, {"mock": True},
                         {"seeded": True}, {"connected": False}, {"status": "offline"}):
            with self.subTest(mutation=mutation):
                unavailable = copy.deepcopy(raw)
                unavailable["snapshot"]["displayContracts"].update(mutation)
                self.assertEqual(self.row(unavailable)["quotedLineCount"], 0)

    def test_nasdaq_exact_reference_requires_the_verified_fnq_dated_future(self):
        raw = monitor("nasdaq100", "forecastex")
        raw["snapshot"]["displayContracts"]["event"]["resolverSymbol"] = "NQU26"
        venue = raw["snapshot"]["venues"]["forecastex"]
        venue["settlementBasis"]["instrument"] = "NQU26"
        reference = venue["reference"]
        reference["instrument"] = {"displaySymbol": "NQU26", "secType": "FUT"}
        self.assertIsNotNone(self.row(raw)["liveReference"])
        for instrument in ({"displaySymbol": "NDX", "secType": "IND"},
                           {"displaySymbol": "NQZ26", "secType": "FUT"}, {}):
            with self.subTest(instrument=instrument):
                reference["instrument"] = instrument
                self.assertIsNone(self.row(raw)["liveReference"])
                self.assertEqual(self.row(raw)["quotedLineCount"], 1)
        reference["instrument"] = {"displaySymbol": "NQU26", "secType": "FUT"}
        venue["settlementBasis"]["status"] = "unavailable"
        self.assertIsNone(self.row(raw)["liveReference"])

    def test_event_expiry_does_not_extend_quote_lifetime(self):
        for quote_expiry in (None, (NOW - timedelta(seconds=1)).isoformat()):
            raw = monitor()
            raw["snapshot"]["displayContracts"]["bookExpiresAt"] = quote_expiry
            self.assertEqual(self.row(raw)["quotedLineCount"], 0)
        raw = monitor()
        raw["snapshot"]["displayContracts"]["lines"][1]["evidence"]["quotes"]["asOf"] = (NOW - timedelta(seconds=100)).isoformat()
        self.assertEqual(self.row(raw)["quotedLineCount"], 0)

    def test_sparse_book_keeps_native_zero_without_inventing_other_sides(self):
        raw = monitor()
        raw["snapshot"]["displayContracts"]["lines"][1].update(yesBid=0, yesAsk=None, noBid=None, noAsk=None)
        row = self.row(raw)
        fields = dict(row["fields"])
        self.assertEqual(fields["YES native quote"], "bid 0.00 · ask unquoted")
        self.assertNotIn("NO native quote", fields)
        self.assertEqual(row["quotedLineCount"], 0)

    def test_non_native_derived_and_crossed_quotes_are_rejected(self):
        for mutation in ({"directNative": False}, {"derivedFields": ["noAsk"]}, {"yesBid": .6, "yesAsk": .4}):
            raw = monitor()
            raw["snapshot"]["displayContracts"]["lines"][1].update(mutation)
            row = self.row(raw)
            self.assertEqual(row["quotedLineCount"], 0)
            self.assertNotIn("YES native quote", dict(row["fields"]))

    def test_quote_provenance_and_sub_cent_precision_are_preserved(self):
        raw = monitor("cpi", "kalshi")
        line = raw["snapshot"]["displayContracts"]["lines"][1]
        line.update(yesBid=.4444, yesAsk=.4567)
        line["threshold"] = 79599.99
        self.assertEqual(dict(self.row(raw)["fields"])["YES native quote"], "bid 0.4444 · ask 0.4567")
        self.assertEqual(dict(self.row(raw)["fields"])["Threshold"], "> 79599.99%")
        for source in ("kalshi_historical", "kalshi_portfolio_marks"):
            line["evidence"]["quotes"]["source"] = source
            self.assertEqual(self.row(raw)["quotedLineCount"], 0)

    def test_wrong_venue_and_expired_events_cannot_supply_quotes(self):
        raw = monitor()
        raw["snapshot"]["selectedVenueId"] = "kalshi"
        self.assertEqual(self.row(raw)["fields"], [])
        raw = monitor()
        raw["snapshot"]["displayContracts"]["event"]["closeTime"] = (NOW - timedelta(seconds=1)).isoformat()
        self.assertFalse(self.row(raw)["catalogAvailable"])
        self.assertEqual(self.row(raw)["quotedLineCount"], 0)

    def test_proxy_and_historical_references_do_not_become_resolver_quotes(self):
        raw = monitor()
        reference = raw["snapshot"]["venues"]["forecastex"]["reference"]
        reference["fit"] = reference["spot"]["fit"] = "proxy"
        row = self.row(raw)
        self.assertIsNone(row["liveReference"])
        self.assertIn("Live proxy · context only", dict(row["fields"]))
        reference["spot"].update(status="historical", availability="historical")
        self.assertNotIn("Live proxy · context only", dict(self.row(raw)["fields"]))

    def manager_row(self):
        observed = "2026-09-18T19:30:00Z"
        return {"marketId": "silver", "asset": "Silver", "venue": "Kalshi",
            "fields": [("Contract", "KXSILVERW-26SEP25-LONG-INTERNAL-ID")],
            "gaps": ["Native resolver reference failed: HTTP 503"],
            "managerView": {"version": 1,
                "trade": {"direction": "BULLISH", "instrument": "SILVER", "publishedAt": "2026-09-18"},
                "trend": {"direction": "BULLISH", "instrument": "SILVER", "publishedAt": "2026-09-18"},
                "direction": {"value": "BULLISH", "basis": "Trade"},
                "underlying": {"value": 66, "label": "Silver", "fit": "exact", "state": "LIVE", "asOf": observed},
                "riskRange": {"low": 63, "high": 69, "instrument": "SILVER", "publishedAt": "2026-09-18",
                    "rewardRisk": {"direction": "BULLISH", "ratio": 1, "riskPct": 100 * 3 / 66,
                                   "rewardPct": 100 * 3 / 66, "basisLabel": "Silver", "referenceValue": 66}},
                "contracts": {"eventId": "KXSILVERW-26SEP25", "closesAt": "2026-09-25T21:00:00Z",
                    "settlementInstrument": "Metal.Index.SILVER/USD", "settlementLabel": "Pyth Silver", "referenceComparable": True,
                    "near": {"threshold": 66, "comparator": ">", "side": "YES", "ask": .46,
                             "marketImpliedPct": 46, "grossPayoffRatio": .54 / .46, "asOf": observed},
                    "next": {"threshold": 67, "comparator": ">", "side": "YES", "ask": .4,
                             "marketImpliedPct": 40, "grossPayoffRatio": 1.5, "asOf": observed}}}}

    def test_manager_report_keeps_underlying_range_and_binary_payoff_separate(self):
        row = self.manager_row()
        original = copy.deepcopy(row)
        report = render_prediction_review([{"id": "monitored-markets", "markets": [row]}], "partial")
        self.assertTrue(report.startswith("## Kalshi\n\n### Silver\n\n**Trade:** Bullish"))
        self.assertIn("**Trend:** Bullish · SILVER · Sep 18, 2026", report)
        self.assertIn("**Underlying:** Silver 66", report)
        self.assertIn("**Risk Range:** 63–69 · SILVER · Sep 18, 2026", report)
        self.assertIn("**Underlying reward/risk:** Silver 66 · Bullish · 1:1 · reward 4.55% · risk 4.55%", report)
        self.assertIn("| Level | Outcome | Side | Price | Market-implied odds | Gross reward/risk (before fees) |", report)
        self.assertIn("| Current strike | Above 66 | YES | 46¢ | 46% | 1.17:1 |", report)
        self.assertIn("| Next strike | Above 67 | YES | 40¢ | 40% | 1.5:1 |", report)
        self.assertNotIn("**Current strike:**", report)
        self.assertNotIn("**Next strike:**", report)
        self.assertIn("**Trading closes:** Sep 25, 2026 14:00 PDT · Kalshi · Pyth Silver", report)
        self.assertNotIn("**Contract:**", report)
        self.assertNotIn("**Settlement:**", report)
        self.assertNotIn("Metal.Index", report)
        for absent in ("Predictive Markets Review", "Monitored markets", "Partial", "Missing data", "HTTP", "KXSILVERW", "2026-09-25T", "Contract expiration", "Risk limits"):
            self.assertNotIn(absent, report)
        self.assertEqual(row, original)

    def test_venue_sections_keep_captured_research_and_all_section_sources(self):
        rows = [self.manager_row() for _ in range(6)]
        for row, market_id, asset, venue in zip(rows,
                ("cpi", "sp500", "gold", "silver", "bitcoin", "ethereum"),
                ("CPI", "S&P 500", "Gold", "Silver", "Bitcoin", "Ethereum"),
                ("ForecastEx", "ForecastEx", "Kalshi", "Kalshi", "Kalshi", "Kalshi")):
            row.update(marketId=market_id, asset=asset, venue=venue)
        rows[4]["research"] = {"sections": [{"id": "research", "title": "Research", "blocks": [
            {"type": "paragraph", "text": "Bitcoin momentum weakened.", "citationIds": ["crypto-current"]},
            {"type": "table", "columns": ["Signal", "Previous", "Current"], "rows": [
                {"cells": ["Trend", "Bullish", "Neutral"]}]},
        ], "citationIds": ["crypto-prior", "crypto-current", "unverified"]}]}
        citations = [{"id": source_id, "product": "crypto-tracker", "sourceUri": "https://app.hedgeye.com/feed_items/1"}
                     for source_id in ("crypto-prior", "crypto-current")]
        original = copy.deepcopy(rows)
        report = render_review("prediction-markets-review", [{"id": "monitored-markets", "markets": rows}], "partial", citations)
        self.assertEqual([line for line in report.splitlines() if line.startswith("## ")], ["## Interactive Brokers", "## Kalshi"])
        self.assertEqual([line for line in report.splitlines() if line.startswith("### ")],
                         ["### CPI", "### S&P 500", "### Gold", "### Silver", "### Bitcoin", "### Ethereum"])
        self.assertIn("<!-- analyst-prediction-research-rollup -->", report)
        bitcoin = report.split("### Bitcoin", 1)[1].split("### Ethereum", 1)[0]
        self.assertIn("#### Research\n\nBitcoin momentum weakened.", bitcoin)
        self.assertIn("Trend: Bullish → Neutral", bitcoin)
        self.assertNotIn("| Trend |", bitcoin)
        self.assertIn("Sources: [Crypto Tracker](citation://crypto-prior), [Crypto Tracker](citation://crypto-current)", bitcoin)
        self.assertNotIn("unverified", bitcoin)
        self.assertEqual(rows, original)

    def test_last_close_and_trend_based_direction_are_explicit(self):
        row = self.manager_row()
        view = row["managerView"]
        view["trade"] = None
        view["direction"]["basis"] = "Trend"
        view["underlying"].update(state="LAST CLOSE", sessionDate="2026-09-17", asOf="2026-09-17T20:00:00Z")
        view["riskRange"]["rewardRisk"].update(state="LAST CLOSE", asOf="2026-09-17T20:00:00Z")
        view["contracts"]["referenceState"] = "LAST CLOSE"
        report = render_prediction_review([{"id": "monitored-markets", "markets": [row]}], "partial")
        self.assertIn("**Trade:** —", report)
        self.assertIn("Silver 66 · Last close Sep 17, 2026", report)
        self.assertIn("| Strike near last close | Bullish Trend · Above 66 | YES | 46¢ | 46% | 1.17:1 |", report)
        self.assertNotIn("| Current strike |", report)
        self.assertNotIn("LIVE", report)

    def test_prediction_research_omits_macro_and_driver_sections_by_id_or_title_without_mutation(self):
        row = self.manager_row()
        excluded = (("macro-regime", "Old macro context"), ("macro-show", "Episode summary"),
                    ("saved-macro", "Macro & regime"), ("saved-show", "The Macro Show"),
                    ("market-drivers", "Previously captured drivers"), ("saved-drivers", "Today's market drivers"),
                    ("older-drivers", "Today’s market drivers"), ("other-drivers", "Market drivers"))
        row["research"] = {"sections": [
            {"id": section_id, "title": title, "blocks": [{"type": "paragraph", "text": "Excluded macro commentary."}],
             "citationIds": ["macro-source"]} for section_id, title in excluded
        ] + [{"id": "asset-research", "title": "Research", "blocks": [
            {"type": "paragraph", "text": "Silver demand rose 3%."}], "citationIds": ["asset-source"]}]}
        citations = [{"id": "macro-source", "product": "macro-show"}, {"id": "asset-source", "product": "metal-research"}]
        original = copy.deepcopy(row)
        report = render_review("prediction-markets-review", [{"id": "monitored-markets", "markets": [row]}], "partial", citations)
        for _, title in excluded:
            self.assertNotIn(title, report)
        self.assertNotIn("Excluded macro commentary", report)
        self.assertNotIn("citation://macro-source", report)
        self.assertIn("#### Research\n\nSilver demand rose 3%.", report)
        self.assertIn("[Metal Research](citation://asset-source)", report)
        self.assertEqual(row, original)

    def test_research_tables_become_compact_rows_without_changing_contract_table_or_evidence(self):
        row = self.manager_row()
        row["research"] = {"sections": [
            {"id": "risk-ranges", "title": "Trend & range changes", "citationIds": ["prior", "current"], "blocks": [
                {"type": "table", "columns": ["Securities", "Prior Trend", "Trend", "Research list"], "rows": [
                    {"cells": ["Gold Spot Price", "Neutral", "Bullish", "Risk Ranges"]}]},
                {"type": "table", "columns": ["Securities", "Prior range", "Published range", "Trend"], "rows": [
                    {"cells": ["Gold Spot Price", "4,100–4,400", "4,200–4,500", "Bullish"]}]},
            ]},
            {"id": "market-structure", "title": "Market structure & flows", "citationIds": ["structure"], "blocks": [
                {"type": "table", "columns": ["Signal", "Published reading"], "rows": [
                    {"cells": ["SPX Gamma Exposure", "Neutral"]}]},
                {"type": "table", "columns": ["Measure", "Prior reading", "Published observation", "Change"], "rows": [
                    {"cells": ["Flow", 0, "[Source level](https://example.org/research)", None, "Additional recorded field"]}]},
            ]},
        ]}
        citations = [{"id": identity, "product": "risk-ranges" if identity != "structure" else "market-structure"}
                     for identity in ("prior", "current", "structure")]
        original = copy.deepcopy(row)
        report = render_prediction_review([{"id": "monitored-markets", "markets": [row]}], "partial", citations)
        self.assertIn("Gold Spot Price · Trend: Neutral → Bullish", report)
        self.assertNotIn("Research list", report)
        self.assertIn("Gold Spot Price · Range: 4,100–4,400 → 4,200–4,500 · Trend: Bullish", report)
        self.assertIn("SPX Gamma Exposure: Neutral", report)
        self.assertIn("Flow · Prior reading: 0 · Published observation: [Source level](https://example.org/research) · Change: — · Value 5: Additional recorded field", report)
        self.assertIn("Sources: [Risk Ranges](citation://prior), [Risk Ranges](citation://current)", report)
        self.assertIn("Sources: [Market Structure](citation://structure)", report)
        research = report.split("#### Trend & range changes", 1)[1]
        self.assertFalse(any(line.startswith("|") for line in research.splitlines()))
        self.assertIn("| Level | Outcome | Side | Price | Market-implied odds | Gross reward/risk (before fees) |", report)
        self.assertIn("| Current strike | Above 66 | YES | 46¢ | 46% | 1.17:1 |", report)
        self.assertEqual(row, original)

    def test_research_ticker_and_security_remain_compact_and_separate_from_signal_transitions(self):
        row = self.manager_row()
        row["research"] = {"sections": [{"id": "risk-ranges", "title": "Trend & range changes", "blocks": [
            {"type": "table", "columns": ["Ticker", "Security", "Prior Trend", "Trend"], "rows": [
                {"cells": ["SILVER", "Silver Spot Price", "Neutral", "Bullish"]}]},
            {"type": "table", "columns": ["Ticker", "Security", "Prior range", "Published range", "Trend"], "rows": [
                {"cells": ["SILVER", "Silver Spot Price", "62–68", "63–69", "Bullish"]}]},
        ]}]}
        report = render_prediction_review([{"id": "monitored-markets", "markets": [row]}], "partial")
        self.assertIn("SILVER · Silver Spot Price · Trend: Neutral → Bullish", report)
        self.assertIn("SILVER · Silver Spot Price · Range: 62–68 → 63–69 · Trend: Bullish", report)
        self.assertNotIn("Research list", report)

    def test_proxy_underlying_and_distinct_range_basis_are_labeled(self):
        row = self.manager_row()
        row["managerView"]["underlying"].update(label="SLV", fit="proxy", value=60)
        row["managerView"]["riskRange"]["rewardRisk"].update(basisLabel="Silver", referenceValue=66)
        report = render_prediction_review([{"id": "monitored-markets", "markets": [row]}], "partial")
        self.assertIn("**Underlying:** SLV 60 (proxy)", report)
        self.assertIn("**Underlying reward/risk:** Silver 66", report)

    def test_adjacent_unquoted_strike_has_no_invented_odds_or_payoff(self):
        row = self.manager_row()
        row["managerView"]["contracts"]["next"].update(ask=None, marketImpliedPct=40, grossPayoffRatio=1.5)
        report = render_prediction_review([{"id": "monitored-markets", "markets": [row]}], "partial")
        self.assertIn("| Next strike | Above 67 | YES | — | — | — |", report)
        self.assertIn("| Current strike | Above 66 | YES | 46¢ | 46% | 1.17:1 |", report)
        self.assertNotIn("40%", report)
        self.assertNotIn("1.5:1", report)

    def test_neutral_quoted_levels_keep_native_odds_without_a_current_underlying(self):
        row = self.manager_row()
        view = row["managerView"]
        view["trade"]["direction"] = "NEUTRAL"
        view["trend"]["direction"] = "NEUTRAL"
        view.update(direction=None, underlying=None)
        view["riskRange"]["rewardRisk"] = None
        contracts = view["contracts"]
        contracts.update(near=None, next=None, selectionBasis="quoted_level", comparisons=[
            {"label": "Quoted level · YES", "threshold": 66, "comparator": ">", "side": "YES", "ask": .46,
             "marketImpliedPct": 46, "grossPayoffRatio": .54 / .46},
            {"label": "Quoted level · NO", "threshold": 66, "comparator": ">", "directionalComparator": "<=", "side": "NO", "ask": .56,
             "marketImpliedPct": 56, "grossPayoffRatio": .44 / .56},
            {"label": "Higher strike", "threshold": 67, "comparator": ">", "side": "YES", "ask": .4,
             "marketImpliedPct": 40, "grossPayoffRatio": 1.5},
            {"label": "Lower strike", "threshold": 65, "comparator": ">", "directionalComparator": "<=", "side": "NO", "ask": .5,
             "marketImpliedPct": 50, "grossPayoffRatio": 1},
        ])
        report = render_prediction_review([{"id": "monitored-markets", "markets": [row]}], "partial")
        self.assertIn("**Trade:** Neutral", report)
        self.assertIn("**Underlying:** —", report)
        self.assertIn("| Quoted level | Above 66 | YES | 46¢ | 46% | 1.17:1 |", report)
        self.assertIn("| Quoted level | At or below 66 | NO | 56¢ | 56% | 0.79:1 |", report)
        self.assertIn("| Higher strike | Above 67 | YES | 40¢ | 40% | 1.5:1 |", report)
        self.assertIn("| Lower strike | At or below 65 | NO | 50¢ | 50% | 1:1 |", report)
        self.assertNotIn("Current strike", report)
        self.assertNotIn("Bullish", report)
        self.assertNotIn("recommend", report.lower())

    def test_verified_zero_and_one_asks_keep_prices_without_infinite_payoff(self):
        row = self.manager_row()
        row["managerView"]["contracts"]["near"].update(ask=0, marketImpliedPct=0, grossPayoffRatio=None)
        row["managerView"]["contracts"]["next"].update(ask=1, marketImpliedPct=100, grossPayoffRatio=0)
        report = render_prediction_review([{"id": "monitored-markets", "markets": [row]}], "partial")
        self.assertIn("| Current strike | Above 66 | YES | 0¢ | 0% | — |", report)
        self.assertIn("| Next strike | Above 67 | YES | 100¢ | 100% | 0:1 |", report)
        self.assertNotIn("inf", report)

    def test_contract_table_preserves_direct_price_without_deriving_missing_metrics(self):
        row = self.manager_row()
        contracts = row["managerView"]["contracts"]
        contracts["comparisons"] = [{**contracts["near"], "label": "Quoted | level · YES",
                                     "marketImpliedPct": None, "grossPayoffRatio": None}]
        report = render_prediction_review([{"id": "monitored-markets", "markets": [row]}], "partial")
        self.assertIn("| Quoted \\| level | Above 66 | YES | 46¢ | — | — |", report)
        self.assertNotIn("46%", report)
        self.assertNotIn("1.17:1", report)

    def test_failed_and_legacy_markets_keep_only_compact_signal_placeholders(self):
        error = "HTTPStatusError: 503 at http://localhost:3001/api/monitor"
        rows = [{"asset": "Gold", "venue": "Kalshi", "status": "unavailable", "researchState": error},
                {"asset": "Silver", "venue": "ForecastEx", "fields": [("Reference", error), ("Native quote", "bid 0.00 · ask 0.25")]},
                self.row({"marketId": "wti", "asset": "WTI", "requestedVenue": "kalshi", "error": error})]
        original = copy.deepcopy(rows)
        report = render_prediction_review([{"id": "monitored-markets", "markets": rows}], "blocked")
        for asset in ("Gold", "Silver", "WTI"):
            self.assertIn(f"### {asset}\n\n**Trade:** —  \n**Trend:** —", report)
        for absent in ("Missing data", "Unavailable", "HTTP", "localhost", "Native quote", "Held event-contract"):
            self.assertNotIn(absent, report)
        self.assertEqual(rows, original)

    def test_internal_status_recommendations_and_diagnostics_never_become_manager_body(self):
        error = "HTTPStatusError: 415 Unsupported Media Type at http://localhost:3001/internal/analyst/prediction-analysis"
        sections = [
            {"id": "monitored-markets", "markets": [self.manager_row()]},
            {"id": "exceptions", "items": [error, "Silver stops trading within 48 hours."]},
            {"id": "data-status", "items": [error, "Fresh native bid/ask quotes: 1 of 8 monitored assets."]},
            {"id": "held-event-contracts", "positions": [{"contract": "GIANT-INTERNAL-ID", "quantity": 50}]},
            {"id": "process-recommendations", "error": error, "analysis": {"markets": [
                {"label": "Silver", "status": "withheld", "reasons": [error, "Fresh funding unavailable"],
                 "candidates": [{"contractId": "DIAGNOSTIC-CONTRACT", "sizing": {"allowed": False}}]},
            ]}},
        ]
        original = copy.deepcopy(sections)
        report = render_review("prediction-markets-review", sections, "partial", [])
        for absent in ("Missing data", "HTTPStatusError", "localhost", "415", "Risk limits", "Process recommendations",
                       "Data status", "Exceptions", "withheld", "funding", "native bid/ask quotes", "GIANT", "DIAGNOSTIC", "48 hours"):
            self.assertNotIn(absent, report)
        self.assertIn("| Current strike | Above 66 | YES | 46¢ | 46% | 1.17:1 |", report)
        self.assertEqual(sections, original)

    def test_report_clock_times_are_pacific_while_dates_alone_keep_the_exchange_day(self):
        for value, expected in (("2026-09-25T21:00:00Z", "Sep 25, 2026 14:00 PDT"),
                                ("2026-12-25T21:00:00Z", "Dec 25, 2026 13:00 PST"),
                                # 00:30 ET on Sep 26 is 21:30 on Sep 25 in California.
                                ("2026-09-26T04:30:00Z", "Sep 25, 2026 21:30 PDT"),
                                ("2026-09-25", "Sep 25, 2026")):
            with self.subTest(value=value):
                self.assertEqual(_prediction_manager_date(value, include_time=True), expected)
        # Without a clock, a publication or session instant keeps its Eastern day.
        self.assertEqual(_prediction_manager_date("2026-09-26T04:30:00Z"), "Sep 26, 2026")

    def test_saved_intraday_volume_clock_renders_in_pacific_from_its_captured_instant(self):
        volume = {"id": "volume", "product": "spy-volume-(etf-proxy)", "observedAt": "2026-09-29T19:30:00Z"}
        dollar = {"id": "dollar", "product": "spx-/-dollar-correlation", "observedAt": "2026-09-29T20:00:00Z"}
        tail = " SPY ETF volume was 41,000,000 shares versus 50,000,000 for the 20-session average at the same time."

        def render(text, citation_ids, citations):
            row = self.manager_row()
            row["research"] = {"sections": [{"id": "market-structure", "title": "Market structure & flows",
                                             "citationIds": citation_ids, "blocks": [
                                                 {"type": "paragraph", "text": text, "citationIds": citation_ids}]}]}
            sections = [{"id": "monitored-markets", "markets": [row]}]
            original = copy.deepcopy((sections, citations))
            report = render_prediction_review(sections, "partial", citations)
            self.assertEqual((sections, citations), original)
            return report

        saved = "Through 15:30 ET," + tail
        self.assertIn("Through 12:30 PDT," + tail, render(saved, ["dollar", "volume"], [dollar, volume]))
        # A clock that does not match the captured instant, or has no captured
        # instant, stays exactly as recorded instead of being relabeled.
        self.assertIn("Through 15:30 ET," + tail, render(saved, ["volume"],
                                                          [{**volume, "observedAt": "2026-09-29T19:45:00Z"}]))
        self.assertIn("Through 15:30 ET," + tail, render(saved, ["dollar"], [dollar]))
        self.assertIn("Through 15:30 ET," + tail, render(saved, ["volume"], [{**volume, "observedAt": "2026-09-29"}]))
        winter = {**volume, "observedAt": "2026-12-01T16:30:00Z"}
        self.assertIn("Through 08:30 PST," + tail, render("Through 11:30 ET," + tail, ["volume"], [winter]))
        current = "Through 12:30 PDT," + tail
        self.assertIn(current, render(current, ["volume"], [volume]))

    def test_cpi_body_keeps_release_matched_forecasts_with_human_dates(self):
        row = {"marketId": "cpi", "asset": "CPI", "venue": "Kalshi", "fields": [
            ("Hedgeye nowcast", "3.47% · published 2026-09-18T12:00:00Z"),
            ("Cleveland Fed nowcast", "0.00% · published 2026-09-17"),
            ("Previous CPI release", "3.1% · 2026-08 · BLS"),
            ("CPI release", "2026-09 · 2026-10-13T12:30:00Z"),
            ("Contract expiration", "2027-01-13T14:00:00Z"),
        ]}
        report = render_prediction_review([{"id": "monitored-markets", "markets": [row]}], "partial")
        self.assertIn("**Hedgeye nowcast:** 3.47% · published Sep 18, 2026", report)
        self.assertIn("**Cleveland Fed nowcast:** 0.00% · published Sep 17, 2026", report)
        self.assertIn("**Previous CPI release:** 3.1% · Aug 2026 · BLS", report)
        self.assertIn("**CPI release:** Sep 2026 · Oct 13, 2026 05:30 PDT", report)
        for absent in ("Trade", "Trend", "Underlying", "Risk Range", "Contract expiration", "2026-09", "2027"):
            self.assertNotIn(absent, report)

    def test_forecastex_cpi_adapter_contract_renders_native_odds_and_preserves_unquoted_sides(self):
        observed = (NOW - timedelta(seconds=5)).isoformat()
        expires = (NOW + timedelta(seconds=55)).isoformat()
        event = {"ticker": "CPIY_0826", "venueId": "forecastex", "status": "open",
                 "reportMonth": "2026-08", "releaseKey": "KXCPIYOY#2026-08", "payoutAmount": 1,
                 "releaseAt": "2026-09-11T12:30:00Z", "closeTime": "2026-09-11T12:30:00Z"}
        catalog_lines = [{"ticker": f"CPIY_0826_{threshold}", "contractId": f"CPIY_0826_{threshold}",
                          "threshold": threshold, "comparator": ">", "status": "catalog", "directNative": False}
                         for threshold in (3.0, 3.1, 3.2)]
        quoted = [{**line, "source": "ibkr_tws_forecastex_live", "status": "available", "directNative": True,
                   "updatedAt": observed, "evidence": {"quotes": {"source": "ibkr_tws_forecastex_live", "asOf": observed, "fit": "exact"}},
                   "yesBid": .48, "yesAsk": .5, "noBid": .48, "noAsk": .5,
                   "yesBidSize": 5, "yesAskSize": 6, "noBidSize": 7, "noAskSize": 8} for line in catalog_lines]
        quoted[0].update(yesBid=None, yesAsk=None, noBid=None, noAsk=None)
        quoted[2].update(yesBid=.38, yesAsk=.4, noBid=None, noAsk=None)
        raw = {"marketId": "cpi", "asset": "CPI", "requestedVenue": "forecastex", "status": "available", "snapshot": {
            "marketId": "cpi", "selectedVenueId": "forecastex", "status": "available",
            "displaySelection": {"venueId": "forecastex", "status": "available", "strategyEligible": False},
            "displayContracts": {"status": "available", "event": event, "lines": quoted, "asOf": observed, "bookExpiresAt": expires},
            "venues": {"forecastex": {"catalog": {"status": "available", "event": event, "lines": catalog_lines},
                        "settlementBasis": {"status": "verified", "instrument": "All Items CPI-U YoY", "sourceName": "BLS"}}},
            "forecastComparison": {"status": "available", "eventTicker": "CPIY_0826", "sourceEventTicker": "KXCPIYOY-26AUG",
                "reportMonth": "2026-08", "releaseKey": "KXCPIYOY#2026-08",
                "hedgeye": {"status": "available", "baseValue": 3.47, "asOf": "2026-08-13", "source": "hedgeye-inflation-nowcast"},
                "clevelandFed": {"status": "available", "value": 3.38, "asOf": "2026-09-02", "source": "cleveland_fed_inflation_nowcasting"}},
        }}
        row = self.row(raw)
        report = render_prediction_review([{"id": "monitored-markets", "markets": [row]}], "partial")
        self.assertTrue(report.startswith("## Interactive Brokers\n\n### CPI"))
        self.assertEqual(row["quotedLineCount"], 1)
        self.assertIn("**Hedgeye nowcast:** 3.47%", report)
        self.assertIn("| Quoted level | Above 3.1 | YES | 50¢ | 50% | 1:1 |", report)
        self.assertIn("| Higher strike | Above 3.2 | YES | 40¢ | 40% | 1.5:1 |", report)
        self.assertIn("| Lower strike | At or below 3 | NO | — | — | — |", report)
        quoted[1]["noAsk"] = None
        partial = render_prediction_review([{"id": "monitored-markets", "markets": [self.row(raw)]}], "partial")
        self.assertIn("| Quoted level | At or below 3.1 | NO | — | — | — |", partial)
        self.assertIn("| Quoted level | Above 3.1 | YES | 50¢ | 50% | 1:1 |", partial)
        raw["snapshot"]["displayContracts"]["connected"] = False
        unavailable = render_prediction_review([{"id": "monitored-markets", "markets": [self.row(raw)]}], "partial")
        self.assertNotIn("implied", unavailable)
        self.assertIn("**Hedgeye nowcast:** 3.47%", unavailable)

    def test_every_quoted_asset_including_cpi_has_venue_and_trading_close_not_settlement_time(self):
        rows = []
        for market_id, asset, venue in (("silver", "Silver", "Kalshi"), ("sp500", "S&P 500", "ForecastEx"), ("cpi", "CPI", "Kalshi")):
            row = self.manager_row()
            row.update(marketId=market_id, asset=asset, venue=venue)
            contracts = row["managerView"]["contracts"]
            contracts["comparisons"] = [{**contracts["near"], "label": "Quoted level · YES"}]
            contracts["expiresAt"] = "2026-12-25T21:00:00Z"
            rows.append(row)
        report = render_prediction_review([{"id": "monitored-markets", "markets": rows}], "partial")
        for row in rows:
            section = report.split("### " + row["asset"] + "\n", 1)[1].split("### ", 1)[0]
            self.assertIn("| Quoted level | Above 66 | YES | 46¢ | 46% | 1.17:1 |", section)
            self.assertIn(f"**Trading closes:** Sep 25, 2026 14:00 PDT · {row['venue']} · Pyth Silver", section)
            self.assertNotIn("**Contract:**", section)
            self.assertNotIn("**Settlement:**", section)
            self.assertIn("**Expiration:** Dec 25, 2026 13:00 PST", section)
            self.assertNotIn("Metal.Index", section)
        for row in rows:
            contracts = row["managerView"]["contracts"]
            contracts["expiresAt"] = contracts["closesAt"]
        matching = render_prediction_review([{"id": "monitored-markets", "markets": rows}], "partial")
        self.assertNotIn("**Expiration:**", matching)

    def test_cpi_uses_release_matched_forecasts_without_spot_or_risk_range(self):
        raw = monitor("cpi", "kalshi")
        raw["snapshot"].pop("riskRange")
        raw["snapshot"]["displayContracts"]["event"].update(reportMonth="2026-08", releaseKey="KXCPIYOY#2026-08", releaseAt="2026-09-11T12:30:00Z", expirationTime="2026-12-11T14:00:00Z")
        raw["snapshot"]["forecastComparison"] = {
            "status": "partial", "eventTicker": "cpi-event", "reportMonth": "2026-08", "releaseKey": "KXCPIYOY#2026-08",
            "hedgeye": {"status": "available", "baseValue": 3.47, "asOf": "2026-08-13T12:59:50Z", "source": "hedgeye-inflation-nowcast"},
            "clevelandFed": {"status": "available", "value": 0, "asOf": "2026-09-02T12:00:00Z", "source": "cleveland_fed_inflation_nowcasting"}}
        row = self.row(raw)
        self.assertEqual(row["status"], "available")
        fields = dict(row["fields"])
        self.assertIn("3.47%", fields["Hedgeye nowcast"])
        self.assertIn("0.00%", fields["Cleveland Fed nowcast"])
        self.assertEqual(fields["Contract expiration"], "2026-12-11T14:00:00Z")
        self.assertNotIn("LIVE_REFERENCE", row["missingFields"])
        self.assertNotIn("RISK_RANGE", row["missingFields"])
        raw["snapshot"]["forecastComparison"]["reportMonth"] = "2026-07"
        self.assertNotIn("Hedgeye nowcast", dict(self.row(raw)["fields"]))

    def test_live_official_terms_survive_broker_failure_without_any_quote(self):
        raw = monitor()
        display = raw["snapshot"]["displayContracts"]
        raw["snapshot"]["venues"]["forecastex"]["catalog"] = copy.deepcopy(display)
        display.update(refreshFailed=True, refreshIssue="IBKR API session disconnected.")
        row = self.row(raw)
        self.assertTrue(row["catalogAvailable"])
        self.assertEqual(row["quotedLineCount"], 0)
        self.assertIn("Contract", dict(row["fields"]))
        self.assertIn("IB Gateway is disconnected. Sign in to restore broker quotes.", row["gaps"])
        self.assertFalse(any("native quote" in label for label, _ in row["fields"]))

    def test_failed_research_refresh_and_unverified_trade_stay_missing(self):
        raw = monitor()
        raw["snapshot"]["riskRange"].update(refreshFailed=True, refreshIssue="Basis verification failed.")
        raw["snapshot"]["factors"]["trade"]["status"] = "unavailable"
        row = self.row(raw)
        self.assertIsNone(row["researchState"])
        self.assertNotIn("Trade signal", dict(row["fields"]))
        self.assertIn("Basis verification failed.", " ".join(row["gaps"]))

    def test_analysis_payload_omits_ui_history_but_preserves_all_quotes_and_gates(self):
        raw = monitor()
        snapshot = raw["snapshot"]
        snapshot["chart"] = {"data": "x" * 6_000_000}
        snapshot["selectedGeneration"] = copy.deepcopy(snapshot["displayContracts"])
        snapshot["displaySelection"]["contracts"] = copy.deepcopy(snapshot["displayContracts"])
        snapshot["displayContracts"].update(refreshFailed=True, refreshIssue="Book failed.")
        snapshot["venues"]["forecastex"].update(brokerRoutable=False, bookQuality={"eligible": False})
        compact = compact_analysis_markets([raw])[0]["snapshot"]
        self.assertLess(len(json.dumps(compact)), 10_000)
        self.assertEqual(compact["displayContracts"], snapshot["displayContracts"])
        self.assertEqual(compact["displaySelection"], snapshot["displaySelection"])
        self.assertEqual(compact["riskRange"], snapshot["riskRange"])
        self.assertEqual(compact["spot"] if "spot" in compact else None, snapshot.get("spot"))
        self.assertFalse(compact["venues"]["forecastex"]["brokerRoutable"])
        self.assertFalse(compact["venues"]["forecastex"]["bookQuality"]["eligible"])
        self.assertNotIn("selectedGeneration", compact)


if __name__ == "__main__":
    unittest.main()
