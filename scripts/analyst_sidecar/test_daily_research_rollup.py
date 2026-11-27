import copy
from datetime import datetime, timezone
import unittest

from daily_research_rollup import accepted_snapshots, build_daily_research_rollup

DAY = "2026-06-04"
PRIOR = "2026-06-03"
CUTOFF = "2026-06-04T17:00:00Z"


def snapshot(product, *, day=DAY, body="", data=None, **extra):
    return {"snapshotType": product, "date": day, "publishedAt": f"{day}T12:00:00Z",
            "article": {"bodyText": body, "feedUrl": "https://app.hedgeye.com/feed_items/12345"},
            "data": data or {}, **extra}


def evidence(current=None, previous=None):
    return {"date": DAY, "snapshots": current or {}, "previousSnapshots": previous or {}}


def body(report):
    return "\n".join(block.get("text") or "\n".join(" | ".join(row["cells"]) for row in block.get("rows", []))
                     for section in report["sections"] for block in section["blocks"])


def tables(report):
    return [block for section in report["sections"] for block in section["blocks"] if block["type"] == "table"]


def market_structure_snapshot():
    chart = "a" * 64
    provenance = {"chartId": chart, "chartDate": PRIOR, "extractionBasis": "labeled-chart-ocr",
                  "parserVersion": "market-structure-chart-metrics-v3", "source": "Tier1Alpha.com"}
    return snapshot("market-structure", schemaVersion="market-structure-v4", contentComplete=True,
        body="Neutral gamma leaves SPX sensitive to supply and demand.\n\n"
             "If momentum weakens, CTA selling could increase. Conversely, if momentum strengthens, CTAs could buy.",
        data={"signals": [{"label": label, "value": value} for label, value in (
            ("SPX Gamma Exposure", "Neutral"), ("Systematic Flow Risk", "Neutral"),
            ("PV Band Risk/Reward", "Neutral"), ("Strategic Allocation", "Risk On"))],
            "charts": [{"id": chart, "sha256": chart}], "chartMetrics": {
                "spxGammaVolatilityThrottle": {**provenance, "gammaThrottle": 0.12, "tenDayRealizedVolatility": 10.71},
                "spxProbableVolatilityGamma": {**provenance, "zeroGamma": 7649, "lowerPvBand": 7492,
                    "upperPvBand": 7734, "strikesInPlay": [7500, 7550, 7600, 7650, 7700]}}})


class DailyResearchRollupTests(unittest.TestCase):
    def build(self, current=None, previous=None, cutoff=CUTOFF):
        return build_daily_research_rollup(evidence(current, previous), as_of=cutoff)

    def test_prior_only_signal_strength_remains_captured_research_with_its_original_date(self):
        prior = snapshot("signal-strength", day=PRIOR, data={"added": ["AAA"]})
        raw = evidence({"signal-strength": None}, {"signal-strength": prior,
                       "the-call": snapshot("the-call", day=PRIOR, body="Older exact-day product")})
        original = copy.deepcopy(raw)
        self.assertEqual(accepted_snapshots(raw, as_of=CUTOFF), {"signal-strength": prior})
        report = build_daily_research_rollup(raw, as_of=CUTOFF)
        self.assertEqual([section["id"] for section in report["sections"]], ["signal-strength"])
        self.assertIn("Added", body(report))
        self.assertEqual([row["publicationDate"] for row in report["citations"]], [PRIOR])
        self.assertEqual(report["citations"][0]["publishedAt"], f"{PRIOR}T12:00:00+00:00")
        self.assertEqual(raw, original)

    def test_a_captured_signal_strength_shorts_edition_is_never_read(self):
        shorts = snapshot("signal-strength-shorts", data={"added": ["ZZZ"], "removed": ["YYY"]})
        raw = evidence({"signal-strength-shorts": shorts, "signalstrengthshorts": shorts}, {"signal-strength-shorts": shorts})
        self.assertEqual(accepted_snapshots(raw, as_of=CUTOFF), {})
        self.assertEqual(build_daily_research_rollup(raw, as_of=CUTOFF)["sections"], [])

    def test_latest_signal_strength_respects_capture_cutoff_product_identity_and_current_precedence(self):
        prior = snapshot("signal-strength", day=PRIOR, data={"added": ["AAA"]})
        current = snapshot("signal-strength", data={"added": ["BBB"]})
        self.assertEqual(accepted_snapshots(evidence({"signal-strength": current}, {"signal-strength": prior}), as_of=CUTOFF)
                         ["signal-strength"], current)
        same_time_prior = {**current, "data": {"added": ["CCC"]}}
        self.assertEqual(accepted_snapshots(evidence({"signal-strength": current}, {"signal-strength": same_time_prior}), as_of=CUTOFF)
                         ["signal-strength"], current)
        future = {**current, "publishedAt": f"{DAY}T20:00:00Z"}
        self.assertEqual(accepted_snapshots(evidence({"signal-strength": future}, {"signal-strength": prior}), as_of=CUTOFF)
                         ["signal-strength"], prior)
        for update in ({"mock": True}, {"seeded": True}, {"source": "synthetic fixture"},
                       {"refreshFailed": True}, {"status": "failed"}, {"snapshotType": "early-look"},
                       {"snapshotType": {"invalid": True}}, {"date": "2026-06-05"},
                       {"publishedAt": "2026-06-04T20:00:00Z"}):
            with self.subTest(update=update):
                self.assertEqual(accepted_snapshots(evidence({"signal-strength": None},
                                 {"signal-strength": {**prior, **update}}), as_of=CUTOFF), {})

    def test_actual_email_time_excludes_future_same_date_despite_midnight_placeholder(self):
        source = snapshot("top-3-things", body="06/04/2026 11:36 AM EDT", data={"items": [{"title": "Dollar", "body": "Stronger dollar pressures liquidity."}]},
                          publishedAt=f"{DAY}T00:00:00+00:00")
        self.assertEqual(self.build({"top-3-things": source}, cutoff="2026-06-04T13:30:00Z")["sections"], [])
        result = self.build({"top-3-things": source})
        self.assertEqual(result["citations"][0]["publishedAt"], "2026-06-04T15:36:00+00:00")
        self.assertIn("Stronger dollar", body(result))

    def test_future_date_and_future_previous_publication_are_not_compared(self):
        current = snapshot("risk-ranges", data={"ABC": {"lrr": 10, "hrr": 12, "trend": "BULLISH"}})
        future = snapshot("risk-ranges", day="2026-06-05", data={"ABC": {"lrr": 11, "hrr": 13, "trend": "BEARISH"}})
        result = self.build({"risk-ranges": current}, {"risk-ranges": future})
        self.assertNotIn("Prior range", str(tables(result)))
        self.assertNotIn("Bearish", body(result))
        self.assertEqual(self.build({"risk-ranges": future})["sections"], [])

    def test_same_day_unknown_publication_needs_capture_evidence(self):
        source = snapshot("early-look", body="The Big Picture\n\nGrowth is expected to slow.", publishedAt=f"{DAY}T00:00:00Z")
        self.assertEqual(self.build({"early-look": source})["sections"], [])
        source["scrapedAt"] = f"{DAY}T13:00:00Z"
        result = self.build({"early-look": source})
        self.assertIn("Growth is expected", body(result))
        self.assertNotIn("publishedAt", result["citations"][0])
        source["scrapedAt"] = f"{DAY}T18:00:00Z"
        self.assertEqual(self.build({"early-look": source})["sections"], [])

    def test_missing_date_invalid_cutoff_and_fake_inputs_fail_quietly(self):
        source = snapshot("early-look", body="Key Takeaways\n\nGrowth slows.")
        self.assertEqual(build_daily_research_rollup({"snapshots": {"early-look": source}}, as_of=CUTOFF)["sections"], [])
        self.assertEqual(self.build({"early-look": source}, cutoff="not-a-time")["sections"], [])
        for patch in ({"mock": True}, {"seeded": True}, {"source": "synthetic fixture"}, {"data": {"mock": True}}):
            with self.subTest(patch=patch):
                self.assertEqual(self.build({"early-look": {**source, **patch}})["sections"], [])

    def test_partial_research_has_no_filler_fake_sections_or_other_products(self):
        source = snapshot("top-3-things", data={"items": [{"title": "Rates", "body": "Yields are rising."}]})
        result = self.build({"top-3-things": source, "early-look": None, "signal-strength": {}})
        self.assertEqual([section["id"] for section in result["sections"]], ["market-drivers"])
        self.assertEqual(tables(result), [])
        self.assertNotIn("missing", body(result).lower())
        self.assertEqual(len(result["citations"]), 1)

    def test_failed_refresh_envelopes_cannot_promote_a_preserved_article(self):
        source = snapshot("early-look", body="Key Takeaways\n\nInflation is accelerating.")
        for patch in ({"status": "failed"}, {"status": "unavailable"}, {"status": "error"},
                      {"error": "Request failed"}, {"refreshFailed": True}, {"refreshIssue": "timeout"}):
            with self.subTest(patch=patch):
                self.assertEqual(self.build({"early-look": {**source, **patch}})["sections"], [])
        # A successfully retained immutable publication is research evidence,
        # even when a quote provider is offline; no quote is projected from it.
        archived = {**source, "providerStatus": "offline", "fromCache": True}
        self.assertIn("Inflation is accelerating.", body(self.build({"early-look": archived})))

    def test_macro_lists_use_bounded_source_groups_not_contaminated_arrays(self):
        source = snapshot("the-macro-show", body="""TL;DR - POSITIONS MENTIONED

• BULLISH: Energy Fund (ENG), Corn (CORN)

• BEARISH: Treasury Fund (TLT), Zero Coupon Fund (ZROZ)

The summary and positions listed here reflect commentary from The Macro Show.

MAIN SUMMARY

Rates remain higher, supporting the source's short Treasury view.
""", data={"longs": ["Energy Fund (ENG)", "BEARISH: Treasury Fund (TLT)", "Zero Coupon Fund (ZROZ)", "not of any strength"]})
        result = self.build({"the-macro-show": source})
        group_table = next(table for table in tables(result) if table["columns"][-1] == "Positioning")
        self.assertEqual(group_table["columns"], ["Ticker", "Security", "Positioning"])
        self.assertEqual([row["cells"] for row in group_table["rows"]], [
            ["ENG", "Energy Fund", "Long"], ["CORN", "Corn", "Long"],
            ["TLT", "Treasury Fund", "Short"], ["ZROZ", "Zero Coupon Fund", "Short"],
        ])
        self.assertNotIn("not of any strength", body(result))

    def test_call_neutral_group_stops_at_signal_divergence_and_preserves_dotted_ticker(self):
        source = snapshot("the-call", body="""HEDGEYE POSITIONS

LONGS: AAA

SHORTS: BBB

NEUTRAL: AI.PA, CCC

SIGNAL DIVERGENCE

AAA - Monitor LONG / Off Signal Strength

TOP 5 MOST ACTIONABLE

AAA: Sell some into strength; this is not an exit.
""", data={"neutrals": ["AI", "PA", "CCC", "SIGNAL", "AAA"]})
        result = self.build({"the-call": source})
        neutral = [row["cells"] for table in tables(result) for row in table["rows"] if row["cells"][-1] == "Neutral"]
        self.assertEqual(neutral, [["AI.PA", "—", "Neutral"], ["CCC", "—", "Neutral"]])
        self.assertIn("Sell some into strength; this is not an exit.", body(result))
        self.assertNotIn("Signal Divergence", body(result))
        self.assertNotIn("Off Signal Strength", body(result))

    def test_unsafe_arrays_without_explicit_source_labels_are_omitted(self):
        source = snapshot("the-call", body="Top 5 Most Actionable\n\nAAA: Remains on the watch list.", data={"longs": ["AAA", "BEARISH: BBB"], "shorts": ["BBB"]})
        result = self.build({"the-call": source})
        self.assertEqual(tables(result), [])
        self.assertIn("watch list", body(result))

    def test_research_position_deltas_do_not_become_buy_sell_or_user_holdings(self):
        current = snapshot("the-call", body="HEDGEYE POSITIONS\n\nLONGS: NEW, MOVE\n\nSHORTS: BBB\n\nNEUTRAL: CCC")
        prior = snapshot("the-call", day=PRIOR, body="HEDGEYE POSITIONS\n\nLONGS: OLD\n\nSHORTS: MOVE, BBB\n\nNEUTRAL: CCC")
        result = self.build({"the-call": current}, {"the-call": prior})
        text = body(result)
        self.assertIn("Short → Long", text)
        self.assertIn("Added to Long mentions", text)
        self.assertIn("No longer listed Long", text)
        self.assertNotRegex(text, r"\b(Buy|Sell|Exit)\b")
        self.assertNotIn("Your", text)
        change_rows = tables(result)[-1]["rows"]
        self.assertTrue(all(len(row["citationIds"]) == 2 for row in change_rows))

    def test_signal_additions_are_not_a_complete_roster(self):
        source = snapshot("signal-strength", data={"added": ["AAA", "BBB"], "removed": ["CCC"], "stocks": [{"ticker": "AAA"}, {"ticker": "BBB"}]}, meta={"stockCount": 35})
        result = self.build({"signal-strength": source})
        self.assertEqual(len(tables(result)), 1)
        self.assertEqual(tables(result)[0]["columns"], ["Ticker", "Security", "Change"])
        self.assertEqual([row["cells"] for row in tables(result)[0]["rows"]], [
            ["AAA", "—", "Added"], ["BBB", "—", "Added"], ["CCC", "—", "Removed"],
        ])
        self.assertNotIn("Days on", str(result))
        self.assertNotIn("Since signal", str(result))

    def test_complete_signal_roster_preserves_zero_and_missing_metrics(self):
        source = snapshot("signal-strength", data={"stocks": [{"ticker": "AAA", "daysOn": 0, "percentChangeSinceSignal": 0}, {"ticker": "BBB", "daysOn": 2}]}, meta={"stockCount": 2})
        table = tables(self.build({"signal-strength": source}))[0]
        self.assertEqual(table["rows"][0]["cells"], ["AAA", "—", "0", "0%"])
        self.assertEqual(table["rows"][1]["cells"], ["BBB", "—", "2", "—"])
        source["data"]["stocks"][1]["ticker"] = "AAA"
        self.assertEqual(tables(self.build({"signal-strength": source})), [])

    def test_risk_changes_preserve_explicit_outbucket_and_removal_meaning(self):
        current = snapshot("risk-ranges", body="""TREND CHANGE:

BBB moved to the #OutBucket

CCC was removed from Risk Ranges™

DDD was added to Risk Ranges™

#OUTBUCKET

Beta Fund (BBB) = Neutral (6/4/2026)
""", data={"AAA": {"lrr": 10, "hrr": 12, "trend": "BULLISH"}, "DDD": {"lrr": 20, "hrr": 22, "trend": "NEUTRAL"},
            "EEE": {"lrr": 30, "hrr": 32, "trend": "BULLISH"}},
                           trendChanges=[{"ticker": "OUT", "oldTrend": "BEARISH", "newTrend": "NEUTRAL", "note": "outbucket"}])
        prior = snapshot("risk-ranges", day=PRIOR, data={"AAA": {"lrr": 9, "hrr": 12, "trend": "NEUTRAL"}, "BBB": {"trend": "NEUTRAL"}, "CCC": {"trend": "BULLISH"}, "FFF": {"lrr": 40, "hrr": 42, "trend": "BULLISH"}})
        result = self.build({"risk-ranges": current}, {"risk-ranges": prior})
        text = body(result)
        self.assertIn("AAA | — | Neutral | Bullish", text)
        self.assertIn("OUT | — | Bearish | Neutral", text)
        self.assertEqual(tables(result)[0]["columns"], ["Ticker", "Security", "Prior Trend", "Trend"])
        self.assertEqual(tables(result)[1]["columns"], ["Ticker", "Security", "Prior range", "Published range", "LOW", "HIGH", "Trend"])
        self.assertNotIn("Research list", str(result))
        coverage = next(table for table in tables(result) if table["columns"][-1] == "Coverage change")
        self.assertEqual([row["cells"] for row in coverage["rows"]], [
            ["EEE", "—", "+ Risk Ranges"],
            ["BBB", "Beta Fund", "+ OutBucket"],
            ["CCC", "—", "- Risk Ranges"],
            ["DDD", "—", "+ Risk Ranges"],
            ["FFF", "—", "- Risk Ranges"],
        ])
        sources = {source["id"]: source for source in result["citations"]}
        for row in coverage["rows"]:
            expected_dates = [PRIOR, DAY] if row["cells"][0] in {"EEE", "FFF"} else [DAY]
            self.assertEqual([sources[cid]["publicationDate"] for cid in row["citationIds"]], expected_dates)
        excerpt = sources[coverage["rows"][1]["citationIds"][0]]["excerpt"]
        self.assertIn("BBB moved to the #OutBucket", excerpt)
        self.assertIn("CCC was removed from Risk Ranges™", excerpt)
        self.assertIn("DDD was added to Risk Ranges™", excerpt)
        self.assertIn("9–12 | 10–12", text)
        self.assertIn("Jun 4, 2026", text)
        self.assertNotIn("No longer in published range table", text)

    def test_initial_range_readings_are_not_comparison_alerts_or_live_prices(self):
        source = snapshot("risk-ranges", data={"AAA": {"lrr": 10, "hrr": 12, "trend": "BULLISH", "prevClose": 11}})
        result = self.build({"risk-ranges": source})
        self.assertEqual(tables(result)[0]["columns"], ["Ticker", "Security", "Published range", "Trend"])
        self.assertNotIn("11", body(result))
        self.assertNotIn("Added", body(result))
        self.assertNotIn("LIVE", body(result))

    def test_range_boundary_changes_compare_each_unrounded_endpoint(self):
        cases = [
            ((10, 20), (11, 21), ["Higher low", "Higher high"]),
            ((10, 20), (9, 19), ["Lower low", "Lower high"]),
            ((10, 20), (11, 19), ["Higher low", "Lower high"]),
            ((10, 20), (9, 21), ["Lower low", "Higher high"]),
            ((10, 20), (10, 21), ["Unchanged", "Higher high"]),
            ((10, 20), (11, 20), ["Higher low", "Unchanged"]),
            (("0.71000001", "0.71800002"), ("0.71000002", "0.71800001"), ["Higher low", "Lower high"]),
            (("4,240", "4,419"), ("4,250", "4,419"), ["Higher low", "Unchanged"]),
        ]
        for (old_low, old_high), (new_low, new_high), expected in cases:
            with self.subTest(previous=(old_low, old_high), current=(new_low, new_high)):
                current = snapshot("risk-ranges", data={"AAA": {
                    "lrr": new_low, "hrr": new_high, "trend": "BULLISH"}})
                prior = snapshot("risk-ranges", day=PRIOR, data={"AAA": {
                    "lrr": old_low, "hrr": old_high, "trend": "BULLISH"}})
                original = copy.deepcopy((current, prior))
                result = self.build({"risk-ranges": current}, {"risk-ranges": prior})
                comparison = tables(result)[0]
                self.assertEqual(comparison["columns"], [
                    "Ticker", "Security", "Prior range", "Published range", "LOW", "HIGH", "Trend"])
                row = comparison["rows"][0]
                self.assertEqual(row["cells"][4:6], expected)
                self.assertEqual(row["cells"][6], "Bullish")
                self.assertEqual(len(row["citationIds"]), 2)
                sources = {source["id"]: source["publicationDate"] for source in result["citations"]}
                self.assertEqual([sources[cid] for cid in row["citationIds"]], [PRIOR, DAY])
                self.assertEqual((current, prior), original)
                self.assertNotIn("all-time", body(result).lower())

    def test_missing_and_nonfinite_range_endpoint_has_no_invented_direction(self):
        for unavailable in (None, "", "unavailable", True, float("nan"), float("inf"), float("-inf")):
            for boundary in ("lrr", "hrr"):
                for missing_in in ("prior", "current"):
                    with self.subTest(unavailable=unavailable, boundary=boundary, missing_in=missing_in):
                        current_row = {"lrr": 11, "hrr": 21, "trend": "BULLISH"}
                        prior_row = {"lrr": 10, "hrr": 20, "trend": "BULLISH"}
                        (prior_row if missing_in == "prior" else current_row)[boundary] = unavailable
                        current = snapshot("risk-ranges", data={"AAA": current_row})
                        prior = snapshot("risk-ranges", day=PRIOR, data={"AAA": prior_row})
                        result = self.build({"risk-ranges": current}, {"risk-ranges": prior})
                        labels = tables(result)[0]["rows"][0]["cells"][4:6]
                        self.assertEqual(labels, ["—", "Higher high"] if boundary == "lrr" else ["Higher low", "—"])

    def test_identical_ranges_still_do_not_create_comparison_rows(self):
        row = {"lrr": 10, "hrr": 20, "trend": "BULLISH"}
        result = self.build(
            {"risk-ranges": snapshot("risk-ranges", data={"AAA": row})},
            {"risk-ranges": snapshot("risk-ranges", day=PRIOR, data={"AAA": row})})
        self.assertEqual(tables(result), [])

    def test_spot_research_stored_under_etf_alias_keeps_published_instrument_name(self):
        current = snapshot("risk-ranges", data={"GLD": {
            "originalName": "Gold Spot Price", "lrr": 4250, "hrr": 4424, "trend": "NEUTRAL"}})
        prior = snapshot("risk-ranges", day=PRIOR, data={"GLD": {
            "originalName": "Gold Spot Price", "lrr": 4243, "hrr": 4439, "trend": "BEARISH"}})
        early = snapshot("early-look", data={"GOLD SPOT PRICE (GOLD)": {
            "originalName": "Gold Spot Price (GOLD)", "lrr": 4250, "hrr": 4424, "trend": "NEUTRAL"}})
        result = self.build({"risk-ranges": current, "early-look": early}, {"risk-ranges": prior})
        text = body(result)
        self.assertIn("Gold Spot Price | 4,243–4,439 | 4,250–4,424", text)
        self.assertIn("Gold Spot Price | Bearish | Neutral", text)
        self.assertNotIn("GLD", text)
        self.assertEqual(text.count("4,250–4,424"), 1)
        self.assertNotIn("GLD", body(self.build({"risk-ranges": current})))

    def test_ticker_and_name_come_from_captured_publication_including_outbucket(self):
        source_body = """VIX (BEARISH)
Volatility Index
14.26
18.57
14.92

GOLD (NEUTRAL)
Gold Spot Price
4,240
4,419
4,385

BRENT (BULLISH)
Brent Crude Oil Continuous Contract
97
110
101

#OUTBUCKET
VanEck Oil Services ETF (OIH) = Bearish (6/4/2026)
"""
        now = snapshot("risk-ranges", body=source_body, data={
            "VIX": {"originalName": "Volatility Index", "lrr": 14.26, "hrr": 18.57, "trend": "BEARISH"},
            "GLD": {"originalName": "Gold Spot Price", "lrr": 4240, "hrr": 4419, "trend": "NEUTRAL"},
            "BRENT": {"originalName": "Brent Crude Oil Continuous Contract", "lrr": 97, "hrr": 110, "trend": "BULLISH"},
        }, trendChanges=[{"ticker": "OIH", "oldTrend": "NEUTRAL", "newTrend": "BEARISH", "note": "outbucket"}])
        prior = snapshot("risk-ranges", day=PRIOR, data={
            "VIX": {"lrr": 14.26, "hrr": 18.57, "trend": "NEUTRAL"},
            "GLD": {"lrr": 4240, "hrr": 4420, "trend": "BEARISH"},
            "BRENT": {"lrr": 97, "hrr": 111, "trend": "BULLISH"},
        })
        original = copy.deepcopy(now)
        result = self.build({"risk-ranges": now}, {"risk-ranges": prior})
        trend, ranges = tables(result)[:2]
        self.assertEqual(trend["rows"][0]["cells"], ["VIX", "Volatility Index", "Neutral", "Bearish"])
        self.assertEqual(trend["rows"][1]["cells"][:2], ["GOLD", "Gold Spot Price"])
        self.assertEqual(trend["rows"][2]["cells"], ["OIH", "VanEck Oil Services ETF", "Neutral", "Bearish"])
        self.assertEqual(ranges["rows"][1]["cells"], ["BRENT", "Brent Crude Oil Continuous Contract", "97–111", "97–110", "Unchanged", "Lower high", "Bullish"])
        self.assertTrue(all(row["citationIds"] for row in trend["rows"] + ranges["rows"]))
        self.assertNotIn("GLD", body(result))
        self.assertEqual(now, original)

    def test_a_company_named_mid_sentence_is_only_its_name_not_the_sentence(self):
        from daily_research_rollup import _published_security_identities
        body = ("HEDGEYE POSITIONS\n\nLONGS: ISRG , UNH , ONON , BBWI\n\nHealth Care\n\n"
                "Hospital Volumes are tracking robustly, with adjusted admissions for Tenet Healthcare (THC) , "
                "and the new utilization tracker for Intuitive Surgical (ISRG) ; the broader view is negative.\n\n"
                "Medicare Advantage Mandatory Models announced Friday require plan contractors such as "
                "UnitedHealth Group (UNH) , and Oscar Health (OSCR) to comply.\n\n"
                "The main upside risk is On Holding (ONON) expanding; Bath & Body Works, Inc. (BBWI) reports.")
        names = _published_security_identities(snapshot("the-call", body=body))
        self.assertEqual(names, {"ISRG": "Intuitive Surgical", "UNH": "UnitedHealth Group", "ONON": "On Holding",
                                 "BBWI": "Bath & Body Works, Inc."})

    def test_all_security_tables_use_individual_ticker_and_name_rows(self):
        call = snapshot("the-call", body="HEDGEYE POSITIONS\n\nLONGS: Alpha Fund (AAA), Beta Fund (BBB)\n\nSHORTS: Gamma Fund (CCC)")
        prior = snapshot("the-call", day=PRIOR, body="HEDGEYE POSITIONS\n\nLONGS: Gamma Fund (CCC), Delta Fund (DDD)")
        early = snapshot("early-look", data={"Alpha Fund (AAA)": {"originalName": "Alpha Fund (AAA)", "lrr": 10, "hrr": 12, "trend": "BULLISH"}})
        signal = snapshot("signal-strength", data={"added": ["AAA", "BBB"], "removed": ["DDD"], "stocks": [
            {"ticker": "AAA", "name": "Alpha Fund", "daysOn": 0, "percentChangeSinceSignal": 0},
            {"ticker": "CCC", "name": "Gamma Fund", "daysOn": 2},
        ]}, meta={"stockCount": 2})
        result = self.build({"the-call": call, "early-look": early, "signal-strength": signal}, {"the-call": prior})
        self.assertTrue(all(table["columns"][:2] == ["Ticker", "Security"] for table in tables(result)))
        positions = next(table for table in tables(result) if table["columns"][-1] == "Positioning")
        self.assertEqual(len(positions["rows"]), 3)
        changes = next(table for table in tables(result) if table["columns"][-1] == "Research positioning change")
        self.assertEqual([row["cells"] for row in changes["rows"]], [
            ["AAA", "Alpha Fund", "Added to Long mentions"], ["BBB", "Beta Fund", "Added to Long mentions"],
            ["CCC", "Gamma Fund", "Long → Short"], ["DDD", "Delta Fund", "No longer listed Long"],
        ])
        self.assertTrue(all(len(row["citationIds"]) == 2 for row in changes["rows"]))
        self.assertEqual(result["securityTickers"], ["AAA", "BBB", "CCC", "DDD"])

    def test_ticker_metadata_uses_accepted_evidence_and_never_uppercase_prose_acronyms(self):
        valid = snapshot("the-call", body="HEDGEYE POSITIONS\n\nLONGS: Alpha Fund (AAA), AI.PA\n\nTOP 5 MOST ACTIONABLE\n\n$TLT is mentioned. CPI and GDP affect NLV. Treasury yield is $100.\n\nAir Liquide (AI.PA) remains on the list.\n\nGross Domestic Product (GDP) slowed.")
        rejected = snapshot("signal-strength", data={"stocks": [{"ticker": "FAKE"}]}, seeded=True)
        future = snapshot("risk-ranges", day="2026-06-05", data={"FUTURE": {"trend": "BULLISH"}})
        result = self.build({"the-call": valid, "signal-strength": rejected, "risk-ranges": future})
        self.assertEqual(result["securityTickers"], ["AAA", "AI.PA", "TLT"])
        positions = next(table for table in tables(result) if table["columns"][-1] == "Positioning")
        self.assertEqual(positions["rows"][1]["cells"], ["AI.PA", "Air Liquide", "Long"])

    def test_known_paragraph_titles_are_explicit_without_rewriting_source_text(self):
        drivers = snapshot("top-3-things", data={"items": [{"title": "Rates", "body": "Yields rose.\n\nBonds fell."}]})
        macro = snapshot("early-look", body="Macro Grind\n\nGrowth slowed.")
        result = self.build({"top-3-things": drivers, "early-look": macro})
        paragraphs = [block for section in result["sections"] for block in section["blocks"] if block["type"] == "paragraph"]
        self.assertEqual(paragraphs[0]["title"], "Rates")
        self.assertEqual(paragraphs[0]["text"], "Rates — Yields rose.")
        self.assertNotIn("title", paragraphs[1])
        self.assertEqual(paragraphs[2]["title"], "Macro Grind")
        self.assertEqual(paragraphs[2]["text"], "Macro Grind — Growth slowed.")

    def test_rhetorical_chatter_is_removed_without_losing_financial_facts(self):
        source = snapshot("early-look", body="""Key Takeaways

FAFO is not a doom call. It is a reminder that risks can become liabilities.

The Big Picture

It is the oldest consequence in the world delivered as a meme. Actions have consequences isn't original. We might be f*cking around and at risk of a great finding out.

Macro Grind

Leveraged ETFs hold $198 billion. Hold my beer! They reset daily and decay in sideways markets. Like squid games.

Shipping constraints could raise the price deck in a future Quad 4. We'll find out.

In Quad 4, the $3 trillion in obligations becomes a solvency concern. FAFO is not a prediction of doom. It is a statement about consequences. The great finding out is rarely scheduled at a convenient time. From YOLO to FAFO.
""")
        text = body(self.build({"early-look": source}))
        self.assertIn("$198 billion", text)
        self.assertIn("reset daily and decay", text)
        self.assertIn("could raise the price deck in a future Quad 4", text)
        self.assertIn("$3 trillion in obligations becomes a solvency concern", text)
        for chatter in ("FAFO", "YOLO", "f*cking around", "Hold my beer", "squid games", "find out", "great finding out"):
            self.assertNotIn(chatter, text)

    def test_display_times_use_24_hour_clock_without_inventing_timezone(self):
        source = snapshot("the-call", body="TOP 5 MOST ACTIONABLE\n\nAAA: A call is scheduled for 10 a.m. today, followed by earnings at 2:30 PM and a reset at 12 AM.")
        result = self.build({"the-call": source})
        text = body(result)
        self.assertIn("10:00 today", text)
        self.assertIn("14:30", text)
        self.assertIn("00:00", text)
        self.assertNotIn(" ET", text)
        self.assertNotIn(" PT", text)
        self.assertIn("10 a.m.", result["citations"][0]["excerpt"])

    def test_duplicate_levels_and_exact_narrative_are_combined_with_citations(self):
        risk = snapshot("risk-ranges", data={"AAA": {"lrr": 10, "hrr": 12, "trend": "BULLISH"}})
        early = snapshot("early-look", body="Key Takeaways\n\nRates are expected to rise.", data={"Alpha (AAA)": {"lrr": 10, "hrr": 12, "trend": "BULLISH"}})
        macro = snapshot("the-macro-show", body="MAIN SUMMARY\n\nRates are expected to rise.")
        result = self.build({"risk-ranges": risk, "early-look": early, "the-macro-show": macro})
        self.assertEqual(body(result).count("10–12"), 1)
        self.assertEqual(body(result).count("Rates are expected to rise."), 1)
        paragraph = next(b for s in result["sections"] for b in s["blocks"] if "Rates are expected" in b.get("text", ""))
        self.assertEqual(len(paragraph["citationIds"]), 2)

    def test_complete_article_topics_survive_malformed_sections_without_tiny_caps(self):
        full = "The inflation forecast remains conditional on shipping disruptions. " * 30
        source = snapshot("early-look", body=f"HEDGEYE\n\nThis research was prepared exclusively for secret@example.com\n\nKey Takeaways\n\nGrowth may slow next quarter.\n\nThe Big Picture\n\n{full}\n\nMacro Grind\n\nFuture Quad 4 risk is not the current regime.\n\nBest of luck out there today,\n\nKM\n\n( VIEW LARGER IMAGE )")
        source["article"]["sections"] = {"Portfolio Manager, Hedgeye Asset Management": "Broken import."}
        result = self.build({"early-look": source})
        text = body(result)
        self.assertIn(full.strip(), text)
        self.assertIn("Future Quad 4 risk is not the current regime.", text)
        for forbidden in ("secret@example", "VIEW LARGER", "Broken import", "Portfolio Manager", "Best of luck"):
            self.assertNotIn(forbidden, text)

    def test_call_retains_top_five_all_sector_catalysts_and_exact_partial_action(self):
        source = snapshot("the-call", body="""TOP 5 MOST ACTIONABLE

(Positioning based on Hedgeye's Macro Signals)

AAA: Cover-SOME after earnings; retain the remaining short.

MACRO COMMENTARY

The next policy decision remains a catalyst.

SECTOR SUMMARY

Consumer Staples: Jane Doe - 00:08:01

BBB: A product launch is expected next quarter.

CCC: Guidance was reduced, with weaker units but higher prices.

(This summary has been enhanced with A.I., which can sometimes make errors)
""")
        text = body(self.build({"the-call": source}))
        self.assertIn("Cover-SOME after earnings; retain the remaining short.", text)
        self.assertIn("Consumer Staples — BBB", text)
        self.assertIn("CCC: Guidance was reduced", text)
        self.assertNotIn("Jane Doe", text)
        self.assertNotIn("enhanced with", text)
        self.assertNotIn("Positioning based", text)

    def test_market_structure_preserves_four_signals_and_ordered_text_not_chart_guesses(self):
        source = snapshot("market-structure", data={"signals": [{"label": label, "value": "Neutral"} for label in ("Gamma", "Flows", "Risk/reward", "Allocation")],
                           "chartMetrics": {"unverified": {"gamma": 999}}, "blocks": [
                               {"type": "paragraph", "text": "Opening settlement comes first."},
                               {"type": "chart", "chartId": "chart"},
                               {"type": "paragraph", "text": "Closing expiration follows."}]})
        source["article"]["bodyText"] = "Out-of-order body fallback."
        result = self.build({"market-structure": source})
        self.assertEqual(len(tables(result)[0]["rows"]), 4)
        self.assertEqual(result["sections"][0]["blocks"][0]["text"], "Published Jun 4, 2026")
        self.assertLess(body(result).index("Opening settlement"), body(result).index("Closing expiration"))
        self.assertNotIn("999", body(result))
        self.assertNotIn("Out-of-order", body(result))

    def test_market_structure_adds_only_dated_published_metrics_and_preserves_source_evidence(self):
        source = market_structure_snapshot()
        original = copy.deepcopy(source)
        result = self.build({"market-structure": source})
        signals, readings = tables(result)
        self.assertEqual(signals["columns"], ["Published signal", "Reading"])
        self.assertEqual(len(signals["rows"]), 4)
        self.assertEqual(readings["columns"], ["SPX metric", "Reading", "Data as of"])
        self.assertEqual([row["cells"] for row in readings["rows"]], [
            ["Gamma throttle", "0.12", "Jun 3, 2026"],
            ["10-day realized volatility", "10.71", "Jun 3, 2026"],
            ["Zero-gamma level", "7,649", "Jun 3, 2026"],
            ["Lower probable-volatility band", "7,492", "Jun 3, 2026"],
            ["Upper probable-volatility band", "7,734", "Jun 3, 2026"],
            ["Strikes in play", "7,500 / 7,550 / 7,600 / 7,650 / 7,700", "Jun 3, 2026"],
        ])
        self.assertEqual(result["sections"][0]["blocks"][0]["text"],
                         "Published Jun 4, 2026 · Data as of Jun 3, 2026")
        self.assertNotIn("Risk Range", body(result))
        self.assertTrue(all(block["type"] in {"paragraph", "table"}
                            for section in result["sections"] for block in section["blocks"]))
        citation = result["citations"][0]
        self.assertEqual(citation["publicationDate"], DAY)
        self.assertIn("Gamma throttle: 0.12 · Jun 3, 2026", citation["excerpt"])
        self.assertIn("If momentum weakens", citation["excerpt"])
        self.assertEqual(len(citation["chartReadings"]), 6)
        self.assertTrue(all(row["citationIds"] == [citation["id"]] for row in readings["rows"]))
        self.assertEqual(source, original)

    def test_market_structure_metric_revision_changes_its_citation_even_when_article_is_unchanged(self):
        source = market_structure_snapshot()
        before = self.build({"market-structure": source})
        source["data"]["chartMetrics"]["spxGammaVolatilityThrottle"]["gammaThrottle"] = -0.25
        after = self.build({"market-structure": source})
        self.assertNotEqual(before["citations"][0]["id"], after["citations"][0]["id"])
        self.assertIn("Gamma throttle: -0.25", after["citations"][0]["excerpt"])
        self.assertNotIn("Gamma throttle: 0.12", after["citations"][0]["excerpt"])

    def test_market_structure_rejected_metric_never_leaks_through_table_or_source_popup(self):
        for patch in ({"stale": True}, {"fromCache": True}, {"connected": False}, {"mock": True},
                      {"seeded": True}, {"chartId": "b" * 64}, {"parserVersion": "unknown"}):
            source = market_structure_snapshot()
            source["data"]["chartMetrics"]["spxGammaVolatilityThrottle"].update(patch)
            with self.subTest(patch=patch):
                result = self.build({"market-structure": source})
                self.assertNotIn("0.12", str(result))
                self.assertNotIn("10.71", str(result))
                self.assertIn("7,649", body(result))
                self.assertIn("Risk On", body(result))

    def test_market_structure_different_chart_dates_stay_on_their_own_rows(self):
        source = market_structure_snapshot()
        source["data"]["chartMetrics"]["spxProbableVolatilityGamma"]["chartDate"] = DAY
        result = self.build({"market-structure": source})
        self.assertEqual(result["sections"][0]["blocks"][0]["text"], "Published Jun 4, 2026")
        self.assertEqual(tables(result)[1]["columns"], ["SPX metric", "Reading", "Data as of"])
        self.assertEqual([row["cells"][2] for row in tables(result)[1]["rows"]],
                         ["Jun 3, 2026"] * 2 + ["Jun 4, 2026"] * 4)

    def test_market_structure_same_day_publication_and_readings_keep_explicit_labels(self):
        source = market_structure_snapshot()
        for metric in source["data"]["chartMetrics"].values():
            metric["chartDate"] = DAY
        original = copy.deepcopy(source)
        result = self.build({"market-structure": source})
        self.assertEqual(result["sections"][0]["blocks"][0]["text"],
                         "Published Jun 4, 2026 · Data as of Jun 4, 2026")
        self.assertEqual([row["cells"][2] for row in tables(result)[1]["rows"]],
                         ["Jun 4, 2026"] * 6)
        self.assertEqual(result, self.build({"market-structure": source}))
        self.assertEqual(source, original)

    def test_empty_market_structure_does_not_create_a_date_only_section(self):
        result = self.build({"market-structure": snapshot("market-structure")})
        self.assertEqual(result["sections"], [])
        self.assertEqual(result["citations"], [])

    def test_citations_are_deterministic_dated_and_strip_subscriber_tracking(self):
        source = snapshot("early-look", body="Key Takeaways\n\nInflation is accelerating.")
        source["article"]["feedUrl"] += "?email=secret@example.com"
        source["article"]["headline"] = "Inflation update"
        result = self.build({"early-look": source})
        self.assertEqual(result, self.build({"early-look": copy.deepcopy(source)}))
        citation = result["citations"][0]
        self.assertEqual(citation["publicationDate"], DAY)
        self.assertEqual(citation["title"], "Inflation update")
        self.assertEqual(citation["sourceUri"], "https://app.hedgeye.com/feed_items/12345")
        self.assertTrue(citation["id"].startswith("cite_"))
        self.assertTrue(citation["documentId"].startswith("doc_"))
        known = {citation["id"] for citation in result["citations"]}
        self.assertTrue(all(set(section["citationIds"]) <= known for section in result["sections"]))

    def test_aliases_and_datetime_cutoff_support_contract(self):
        source = snapshot("top-3-things", data={"items": [{"title": "Rates", "body": "Rates rose."}]})
        result = self.build({"top3": source}, cutoff=datetime(2026, 6, 4, 17, tzinfo=timezone.utc))
        self.assertEqual(result["citations"][0]["product"], "top-3-things")


if __name__ == "__main__":
    unittest.main()
