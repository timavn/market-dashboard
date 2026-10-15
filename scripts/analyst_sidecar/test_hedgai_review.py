import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import httpx

from daily_research_rollup import build_daily_research_rollup, PRODUCTS
from hedgai_review import _publication_label, accepted_hedgai, hedgai_citations, portfolio_hedgai_section, portfolio_tick_readings, prediction_hedgai_readings, prediction_hedgai_text, prediction_hedgai_comparison, read_hedgai_research
from analyst_review_sources import review_sources
from portfolio_brief import build_portfolio_brief
from prediction_research_rollup import build_prediction_research_rollup
from review_runs_v2 import ReviewRunV2Store, public_review_run, render_portfolio_review, render_prediction_review


ROOT = Path(__file__).resolve().parents[2]
CUTOFF = "2026-09-28T21:00:00Z"


def reviewed_projection():
    """Exercise the real shared service contract and reviewed 47-row source."""
    source = """
const {loadReviewedBaseline,buildHedgaiResearch}=require('./src/services/hedgaiResearch.cjs');
const {withHedgaiMarketReadings}=require('./src/services/hedgaiMarketResearch.cjs');
process.stdout.write(JSON.stringify(withHedgaiMarketReadings(buildHedgaiResearch({baseline:loadReviewedBaseline(),asOf:'2026-09-28T21:00:00Z',continuity:'complete'}))));
"""
    return json.loads(subprocess.check_output(["node", "-e", source], cwd=ROOT, text=True))


class HedgaiReviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.captured = reviewed_projection()

    def projection(self):
        return copy.deepcopy(self.captured)

    def test_complete_reviewed_book_and_six_qualified_active_rows(self):
        section, citations = portfolio_hedgai_section(self.projection(), as_of=CUTOFF)
        tables = [block for block in section["blocks"] if block["type"] == "table"]
        self.assertEqual(section["title"], "Tick")
        self.assertEqual(tables[0]["columns"], ["Ticker", "Security", "Tick", "Today", "History", "60% filter"])
        self.assertTrue(tables[0]["groupRows"])
        self.assertEqual([row["cells"][0] for row in tables[0]["rows"]], ["QQQ", "GLD", "XLE", "UJB", "SLX", "SPY", "PALL", "XLY", "IWM", "SLV"])
        self.assertEqual({row["ticker"] for row in tables[-1]["rows"] if row["activeDirection"]}, {"XLE", "SLX", "UJB", "SPY", "IWM", "XLY"})
        self.assertEqual(len(tables[-1]["rows"]), 47)
        self.assertIn("47 securities", tables[-1]["disclosure"])
        self.assertEqual({row["group"] for row in tables[-1]["rows"]}, {"Top AI Signals", "Need More Data AI Signals"})
        self.assertEqual(len(section["metadata"]["presentationCatalog"]["securityNames"]), 47)
        self.assertEqual([row["cells"][1] for row in tables[0]["rows"][:2]], ["Nasdaq 100", "Gold"])
        self.assertEqual(tables[0]["rows"][0]["cells"][-1], "Short excluded")
        self.assertEqual(tables[0]["rows"][0]["sourceLabel"], "NASDAQ 100")
        self.assertIn("81.0% · 21 signals · W/L 2.75", tables[0]["rows"][0]["cellTitles"][4])
        self.assertTrue(all(len(row["cellTitles"]) == len(row["cells"]) == len(row["cellCitationIds"]) for table in tables for row in table["rows"]))
        self.assertTrue(citations)
        self.assertTrue(all(source["sourceUri"] and source["excerpt"] for source in citations))
        self.assertNotIn("hedgai-signals", PRODUCTS)

    def test_layer_precedes_ranges_and_saved_brief_uses_captured_book(self):
        projection = self.projection()
        evidence = {"date": "2026-09-28", "hedgai": projection, "snapshots": {"risk-ranges": {
            "date": "2026-09-28", "publishedAt": "2026-09-28T12:00:00Z",
            "data": {"SPY": {"lrr": 10, "hrr": 20, "trend": "BULLISH"}}}}}
        rollup = build_daily_research_rollup(evidence, as_of=CUTOFF)
        ids = [section["id"] for section in rollup["sections"]]
        self.assertLess(ids.index("hedgai-signals"), ids.index("risk-ranges"))
        run = {"runId": "captured", "state": "succeeded", "createdAt": CUTOFF,
               "sections": [{"id": "portfolio-research-review", "dailyRollup": rollup}]}
        brief = build_portfolio_brief(run, {}, {}, daily_research=evidence)
        self.assertEqual(brief["dailyRollup"], rollup)
        exported = render_portfolio_review(run["sections"], "partial")
        self.assertIn("<summary>Full Tick book · 47 securities</summary>", exported)
        self.assertEqual(exported.count("## Tick"), 1)
        self.assertIn("**Top AI Signals**", exported)
        self.assertIn("**Need More Data AI Signals**", exported)
        self.assertIn("](http://127.0.0.1:3001/api/research/hedgai/source/", exported)
        self.assertEqual(projection, self.captured)

    def test_held_tick_is_independent_exact_captured_context_with_original_sources(self):
        projection = self.projection()
        run = {"runId": "captured", "state": "succeeded", "createdAt": CUTOFF}
        metrics = {"available": True, "observedAt": CUTOFF, "netLiquidation": 100000,
            "positions": [{"symbol": ticker, "quantity": 10, "marketValue": 1000,
                           "category": "etf", "markState": "live"} for ticker in ("XLE", "SPY", "QQQ", "GLD", "SPX", "UPRO")]}
        without = build_portfolio_brief(run, metrics, {})
        original = copy.deepcopy((projection, run, metrics))
        with patch("hedgai_review.read_hedgai_research", side_effect=AssertionError("No current fetch")):
            brief = build_portfolio_brief(run, metrics, {}, daily_research={"hedgai": projection})
        rows = {row["holding"]: row for row in brief["holdings"]}
        tick = rows["XLE"]["tick"]
        self.assertEqual((tick["value"], tick["status"], tick["qualified"]), ("BULLISH", "published", True))
        self.assertEqual(tick["source"]["citation"]["productLabel"], "HedgAI Signals")
        self.assertIn("HedgAI Signals", tick["source"]["citation"]["title"])
        self.assertEqual(tick["publishedAt"], "2026-09-28T12:43:00Z")
        self.assertEqual(tick["metricsDate"], "2026-09-28")
        self.assertEqual(len(tick["citationIds"]), 2)
        self.assertTrue(tick["contextOnly"])
        self.assertFalse(tick["decisionEligible"])
        self.assertFalse(tick["executable"])
        self.assertEqual(rows["SPY"]["tick"]["sourceLabel"], "S&P 500")
        self.assertEqual(rows["SPY"]["tick"]["marketMatches"][0]["matchType"], "proxy")
        self.assertEqual((rows["QQQ"]["tick"]["value"], rows["QQQ"]["tick"]["status"]), ("BEARISH", "published"))
        self.assertFalse(rows["QQQ"]["tick"]["strategyQualified"])
        self.assertEqual((rows["GLD"]["tick"]["value"], rows["GLD"]["tick"]["status"]), ("NEUTRAL", "published"))
        self.assertEqual(rows["GLD"]["tick"]["contribution"], "Wait and Watch")
        self.assertEqual(rows["GLD"]["tick"]["position"], "Wait")
        self.assertNotIn("tick", rows["SPX"])
        self.assertNotIn("tick", rows["UPRO"])
        self.assertTrue(set(tick["citationIds"]).issubset({source["id"] for source in brief["citations"]}))
        self.assertEqual([{key: value for key, value in row.items() if key != "tick"} for row in brief["holdings"]], without["holdings"])
        self.assertEqual((projection, run, metrics), original)

    def test_tick_keeps_published_bias_separate_from_strategy_statistics_and_quality_gaps(self):
        for case in ("missing-metrics-source", "future-metrics", "lower-threshold", "zero-history", "last-known", "global-gap"):
            with self.subTest(case=case):
                projection = self.projection()
                row = next(row for row in projection["book"]["rows"] if row["ticker"] == "XLE")
                if case == "missing-metrics-source":
                    row["metricsSourceIds"] = ["absent"]
                elif case == "future-metrics":
                    row["metricsDate"] = "2026-09-29"
                elif case == "lower-threshold":
                    projection["threshold"] = .5
                elif case == "zero-history":
                    row["metrics"]["buy"]["signals"] = 0
                elif case == "last-known":
                    row["status"] = "last-known"
                else:
                    projection["sourceQuality"].update(continuity="unknown", issues=[])
                readings, _ = portfolio_tick_readings(projection, as_of=CUTOFF)
                historical = case in {"last-known", "global-gap"}
                self.assertEqual(readings["XLE"]["value"], None if historical else "BULLISH")
                self.assertFalse(readings["XLE"]["qualified"])
                self.assertFalse(readings["XLE"]["strategyQualified"])
                self.assertEqual(readings["XLE"]["status"], "historical" if historical else "published")
                if case == "global-gap":
                    self.assertEqual(readings["GLD"]["status"], "historical")

    def test_all_47_source_verified_current_positions_have_tick_including_low_history_and_wait(self):
        projection = self.projection()
        original = copy.deepcopy(projection)
        with patch("hedgai_review.read_hedgai_research", side_effect=AssertionError("Use only captured evidence")):
            readings, citations = portfolio_tick_readings(projection, as_of=CUTOFF)
        self.assertEqual(len(readings), 47)
        for row in projection["book"]["rows"]:
            tick = readings[row["ticker"]]
            self.assertEqual(tick["value"], {"Buy": "BULLISH", "Short": "BEARISH", "Wait": "NEUTRAL"}[row["position"]])
            self.assertEqual(tick["status"], "published")
            self.assertEqual(tick["position"], row["position"])
            if row["position"] == "Wait":
                self.assertEqual(tick["contribution"], "Wait and Watch")
                self.assertNotIn("Neutral", tick["contribution"])
            self.assertFalse(tick["decisionEligible"])
            self.assertFalse(tick["executable"])
            self.assertTrue(set(tick["citationIds"]).issubset({source["id"] for source in citations}))
        self.assertEqual(sum(tick["strategyQualified"] for tick in readings.values()), 6)
        self.assertEqual(projection, original)

    def test_tick_omits_unsafe_ambiguous_future_or_unsourced_holdings(self):
        for case in ("mock", "seeded", "synthetic", "inferred", "duplicate", "future-position", "missing-position-source", "unverified-source"):
            with self.subTest(case=case):
                projection = self.projection()
                row = next(row for row in projection["book"]["rows"] if row["ticker"] == "XLE")
                if case == "duplicate":
                    projection["book"]["rows"].append({**row, "instrumentId": "ambiguous"})
                elif case == "future-position":
                    row["lastConfirmedAt"] = "2026-09-29T12:00:00Z"
                elif case == "missing-position-source":
                    row["positionSourceIds"] = ["absent"]
                elif case == "unverified-source":
                    next(source for source in projection["sources"] if source["id"] == row["positionSourceIds"][0])["publicationTimeVerified"] = False
                else:
                    row[case] = True
                readings, _ = portfolio_tick_readings(projection, as_of=CUTOFF)
                self.assertNotIn("XLE", readings)
        projection = self.projection()
        projection["asOf"] = "2026-09-29T12:00:00Z"
        self.assertEqual(portfolio_tick_readings(projection, as_of=CUTOFF), ({}, []))

    def test_email_actions_and_reaffirmations_remain_sourced_without_book_inference(self):
        projection = self.projection()
        source_id = projection["sources"][0]["id"]
        projection["changes"] = [{"sourceText": text, "publicationDate": "2026-09-28", "sourceIds": [source_id]}
                                 for text in ("Buys Added: UST 30yr Yield", "Shorts Added: US Dollar",
                                              "Buys Closed: Palladium", "Buys Closed: UST 10yr Yield", "Shorts Closed: Platinum")]
        projection["reaffirmations"] = [{"sourceText": "Remaining Long META Up 13%", "publicationDate": "2026-09-28", "sourceIds": [source_id]}]
        section, _ = portfolio_hedgai_section(projection, as_of=CUTOFF)
        other = next(block for block in section["blocks"] if block.get("disclosure") == "Other source actions")
        self.assertEqual(len(other["rows"]), 6)
        self.assertTrue(all(row["citationIds"] == [source_id] for row in other["rows"]))
        self.assertTrue(all(block["text"].startswith("Positioning:") for block in section["blocks"] if block["type"] == "paragraph"))
        self.assertEqual(projection["book"], self.captured["book"])

    def test_publication_clock_uses_pacific_date_and_zone_while_date_only_days_stay(self):
        for value, expected in (("2026-09-28T12:43:00Z", "Sep 28, 2026 05:43 PDT"),
                                ("2026-01-05T13:43:00Z", "Jan 5, 2026 05:43 PST"),
                                # 00:30 ET on Sep 29 is still Sep 28 in California.
                                ("2026-09-29T04:30:00Z", "Sep 28, 2026 21:30 PDT"),
                                ("2026-09-28", "Sep 28, 2026")):
            with self.subTest(value=value):
                self.assertEqual(_publication_label(value), expected)

    def test_email_changes_are_dated_capture_day_only_and_metrics_dates_remain_per_security(self):
        projection = self.projection()
        source_id = projection["sources"][0]["id"]
        projection["changes"] = [{"instrumentId": "hedgai:PFIX", "action": "open-long", "sourceLabel": "UST 30yr Yield", "publishedAt": "2026-09-28T12:43:00Z", "sourceIds": [source_id]},
                                 {"action": "close-short", "sourceLabel": "Old change", "publishedAt": "2026-09-27T12:43:00Z", "sourceIds": [source_id]}]
        projection["metricsDate"] = "2026-09-28"
        for row in projection["book"]["rows"]:
            row["metricsDate"] = "2026-09-25"
        section, _ = portfolio_hedgai_section(projection, as_of=CUTOFF)
        pfix = next(row for row in section["blocks"][-1]["rows"] if row["ticker"] == "PFIX")
        self.assertEqual(pfix["cells"][3], "Added Long")
        # 12:43 UTC is shown as the Pacific clock, not relabeled Eastern time.
        self.assertIn("Sep 28, 2026 05:43 PDT", pfix["cellTitles"][3])
        self.assertNotIn(" ET", pfix["cellTitles"][3])
        self.assertNotIn("Old change", json.dumps(section))
        self.assertEqual(section["blocks"][-1]["rows"][0]["cells"][-2], "Sep 25, 2026")
        readings, _ = prediction_hedgai_readings(projection, as_of=CUTOFF)
        self.assertEqual(readings["sp500"]["metricsDate"], "2026-09-25")
        next_day, _ = portfolio_hedgai_section(projection, as_of="2026-09-29T21:00:00Z")
        self.assertTrue(all(row["cells"][3] == "—" for block in next_day["blocks"] if block["type"] == "table" for row in block["rows"]))

    def test_actions_explain_the_named_side_filter_without_reopening_closed_positions(self):
        projection = self.projection()
        projection["sources"].append({"id": "email-actions", "title": "Adding Long 30yr Yields", "publicationDate": "2026-09-28", "sourceUrl": "https://app.hedgeye.com/feed_items/187742"})
        projection["changes"] = [{"instrumentId": f"hedgai:{ticker}", "action": action, "sourceLabel": label,
            "sourceText": f"Published {action}: {label}", "publishedAt": "2026-09-28T12:43:00Z", "sourceIds": ["email-actions"]}
            for ticker, action, label in [("PFIX", "open-long", "UST 30yr Yield"), ("UUP", "open-short", "US Dollar"),
                ("PALL", "close-long", "Palladium"), ("UST", "close-long", "UST 10yr Yield"), ("PPLT", "close-short", "Platinum")]]
        projection["reaffirmations"] = [{"instrumentId": "hedgai:META", "action": "maintain-long", "sourceText": "Remaining Long META Up 13%", "publishedAt": "2026-09-28T12:43:00Z", "sourceIds": ["email-actions"]}]
        section, citations = portfolio_hedgai_section(projection, as_of=CUTOFF)
        full = {row["ticker"]: row for row in section["blocks"][-1]["rows"]}
        self.assertIn("48.5% history; below 60%", full["PFIX"]["cellTitles"][3])
        self.assertIn("38.5% history; below 60%", full["UUP"]["cellTitles"][3])
        self.assertEqual(full["PALL"]["cells"][2:4], ["Wait", "Closed Long"])
        self.assertEqual(full["PALL"]["cells"][-1], "Closed qualifying side")
        self.assertIn("qualifying side (63.2%)", full["PALL"]["cellTitles"][3])
        self.assertIn("qualifying side (80.0%)", full["PPLT"]["cellTitles"][3])
        self.assertIn("Remaining Long META Up 13% · 50.0% history; below 60%", full["META"]["cellTitles"][3])
        self.assertEqual(full["META"]["cells"][3], "Long reaffirmed")
        self.assertEqual(sum(bool(row["todayActions"]) for row in full.values()), 6)
        self.assertTrue(all(len(row["citationIds"]) > 1 for row in full.values() if row["todayActions"]))
        pall = next(row for row in projection["book"]["rows"] if row["ticker"] == "PALL")
        self.assertEqual(pall["position"], "Wait")
        email = next(source for source in citations if source["id"] == "email-actions")
        self.assertIn("Published close-long: Palladium", email["excerpt"])
        self.assertNotIn("63.2%", email["excerpt"])
        self.assertNotIn("batting", email["excerpt"])
        pall["metricsDate"] = "2026-09-29"
        section, _ = portfolio_hedgai_section(projection, as_of=CUTOFF)
        pall_row = next(row for row in section["blocks"][-1]["rows"] if row["ticker"] == "PALL")
        self.assertNotIn("qualifying side", pall_row["cellTitles"][3])

    def test_source_excerpts_do_not_attribute_latest_book_to_old_screenshots(self):
        projection = self.projection()
        before = hedgai_citations(projection)
        projection["book"]["rows"][0].update(position="Buy", initiatedAt="2026-09-28")
        projection["book"]["rows"][0]["metrics"]["buy"]["battingAverage"] = .99
        self.assertEqual(hedgai_citations(projection), before)
        self.assertTrue(any("Reviewed screenshot; open the original" in source["excerpt"] for source in before))

    def test_unverified_publication_time_remains_unknown_with_source_bound_unresolved_evidence(self):
        projection = self.projection()
        projection["sources"].append({"id": "undated-email", "title": "Source with unverified time", "publicationTimeVerified": False,
                                      "publicationDate": None, "publishedAt": None, "sourceUrl": "https://app.hedgeye.com/feed_items/187742"})
        projection["unresolvedActions"] = [{"sourceIds": ["undated-email"], "sourceText": "Buys Added: UST 30yr Yield"}]
        citations = hedgai_citations(projection)
        source = next(row for row in citations if row["id"] == "undated-email")
        self.assertIsNone(source["publicationDate"])
        self.assertIsNone(source["publishedAt"])
        self.assertEqual(source["excerpt"], "Buys Added: UST 30yr Yield")
        section, _ = portfolio_hedgai_section(projection, as_of=CUTOFF)
        self.assertFalse(any("Buys Added: UST 30yr Yield" in block.get("text", "") for block in section["blocks"]))

    def test_prediction_comparison_uses_only_five_matched_markets_with_current_contribution(self):
        readings, _ = prediction_hedgai_readings(self.projection(), as_of=CUTOFF)
        markets = [{"research": {"hedgai": readings[market]}} for market in ("sp500", "nasdaq100", "gold", "silver", "bitcoin")]
        comparison = prediction_hedgai_comparison(markets)
        self.assertEqual(comparison["title"], "Tick comparison · 5 securities")
        self.assertEqual({row[0] for row in comparison["rows"]}, {"SPY", "QQQ", "GLD", "SLV", "IBIT"})
        nasdaq, agreement = prediction_hedgai_text(readings["nasdaq100"], {"trade": {"direction": "BULLISH"}})
        self.assertTrue(nasdaq.startswith("Short · QQQ proxy"))
        self.assertIn("48.0%", nasdaq)
        self.assertIn("signals · W/L", nasdaq)
        self.assertEqual(agreement, "Bearish Tick QQQ proxy conflicts with Bullish Trade.")
        self.assertIsNone(readings["nasdaq100"]["activeDirection"])
        self.assertEqual(readings["nasdaq100"]["tick"]["value"], "BEARISH")
        self.assertFalse(readings["nasdaq100"]["tick"]["strategyQualified"])
        gold, _ = prediction_hedgai_text(readings["gold"], {})
        self.assertTrue(gold.startswith("Wait and Watch · GLD proxy"))
        self.assertNotIn("Neutral", gold)
        self.assertEqual(next(row for row in comparison["rows"] if row[0] == "GLD")[2], "Wait")
        self.assertTrue(comparison["citationIds"])

    def test_prediction_legacy_capture_uses_only_its_dated_position_and_rejects_missing_tick_sources(self):
        readings, _ = prediction_hedgai_readings(self.projection(), as_of=CUTOFF)
        legacy = copy.deepcopy(readings["nasdaq100"])
        del legacy["tick"]
        original = copy.deepcopy(legacy)
        with patch("hedgai_review.read_hedgai_research", side_effect=AssertionError("No new research for a saved capture")):
            text, comparison = prediction_hedgai_text(legacy, {"trade": {"direction": "BULLISH"}})
        self.assertTrue(text.startswith("Short · QQQ proxy"))
        self.assertEqual(comparison, "Bearish Tick QQQ proxy conflicts with Bullish Trade.")
        self.assertEqual(legacy, original)
        for patch_data in ({"positionSourceIds": ["missing"]}, {"status": "last-known"}, {"tick": None},
                           {"sourceQuality": {"continuity": "unknown", "issues": []}}):
            _, comparison = prediction_hedgai_text({**legacy, **patch_data}, {"trade": {"direction": "BULLISH"}})
            self.assertIsNone(comparison)

    def test_last_known_wait_and_excluded_side_keep_dated_status_and_zero_win_loss(self):
        readings, _ = prediction_hedgai_readings(self.projection(), as_of=CUTOFF)
        nasdaq = readings["nasdaq100"]
        nasdaq.update(status="last-known", activeDirection=None)
        nasdaq["metrics"]["short"]["winLoss"] = 0
        text, _ = prediction_hedgai_text(nasdaq, {})
        self.assertIn("Last known Short excluded", text)
        self.assertIn("W/L 0", text)
        gold = readings["gold"]
        gold.update(status="last-known", activeDirection=None)
        text, _ = prediction_hedgai_text(gold, {})
        self.assertIn("Last known Wait · Await Buy", text)
        gold["metrics"]["buy"]["battingAverage"] = .4
        gold["metrics"]["short"]["battingAverage"] = .4
        text, _ = prediction_hedgai_text(gold, {})
        self.assertIn("Last known Wait · Neither side qualifies", text)

    def test_optional_failed_source_marker_does_not_reclassify_preintegration_reviews(self):
        class Store:
            def __init__(self, evidence):
                self.evidence = evidence
            def read_evidence(self, _run, key):
                return self.evidence.get(key, {})
        run = {"reviewKind": "portfolio-review", "state": "succeeded", "createdAt": CUTOFF, "updatedAt": CUTOFF,
               "dependencies": {"dailyResearch": {"status": "partial", "asOf": CUTOFF}}}
        def item(evidence):
            items = [item for item in review_sources(run, Store({"dailyResearch": evidence}),
                     research_products=[{"id": "hedgai-signals", "label": "HedgAI Signals"}], prediction_universe=[])["items"]
                     if item["id"] == "hedgai-signals"]
            self.assertLessEqual(len(items), 1)
            return items[0] if items else None
        self.assertIsNone(item({}))
        unavailable = item({"hedgaiCapture": {"attempted": True, "status": "unavailable", "asOf": CUTOFF}})
        self.assertEqual(unavailable["status"], "unavailable")
        self.assertTrue(unavailable["optional"])
        projection = self.projection()
        projection["sourceQuality"].update(continuity="unknown", lastPublicationAt="2026-09-28T14:43:00Z")
        captured = item({"hedgai": projection})
        self.assertEqual(captured["status"], "ready")
        self.assertEqual(captured["publishedAt"], "2026-09-28T14:43:00Z")

    def test_side_specific_boundary_wait_and_gaps_never_become_active_signals(self):
        projection = self.projection()
        row = projection["book"]["rows"][0]
        row.update(position="Short", activeDirection="Bearish", status="current")
        row["metrics"]["short"]["battingAverage"] = .6
        section, _ = portfolio_hedgai_section(projection, as_of=CUTOFF)
        self.assertEqual(next(item for item in section["blocks"][-1]["rows"] if item["ticker"] == row["ticker"])["activeDirection"], "Bearish")
        for mutation in (lambda: row["metrics"]["short"].update(battingAverage=.599),
                         lambda: row.update(position="Wait"),
                         lambda: projection["sourceQuality"].update(continuity="gap")):
            mutation()
            section, _ = portfolio_hedgai_section(projection, as_of=CUTOFF)
            self.assertIsNone(next(item for item in section["blocks"][-1]["rows"] if item["ticker"] == row["ticker"])["activeDirection"])
        self.assertEqual(len(section["blocks"][-1]["rows"]), 47)

    def test_future_fabricated_and_unproven_captures_are_rejected(self):
        for patch in ({"asOf": "2026-09-29T12:00:00Z"}, {"mock": True}, {"seeded": True},
                      {"synthetic": True}, {"baselineDate": "2026-09-29"}, {"sources": []}):
            projection = {**self.projection(), **patch}
            self.assertEqual(accepted_hedgai(projection, as_of=CUTOFF), {})

    def test_preview_filter_retains_zero_and_never_promotes_invalid_threshold(self):
        projection = self.projection()
        projection["threshold"] = 0
        section, _ = portfolio_hedgai_section(projection, as_of=CUTOFF)
        self.assertEqual(section["metadata"]["filterThreshold"], 0)
        self.assertEqual(section["blocks"][1]["columns"][-1], "0% filter")
        for invalid in (None, "0.6", True, 1.1, -1):
            projection["threshold"] = invalid
            section, _ = portfolio_hedgai_section(projection, as_of=CUTOFF)
            self.assertIsNone(section["metadata"]["filterThreshold"])
            self.assertEqual(section["metadata"]["selectedInstrumentIds"], [])
            self.assertTrue(all(row["cells"][-1] == "—" for row in section["blocks"][-1]["rows"]))

    def test_saved_combined_layout_export_and_ui_use_own_verified_evidence_and_captured_catalog(self):
        captured = {"date": "2026-09-28", "hedgai": self.projection()}
        original_rollup = build_daily_research_rollup(captured, as_of=CUTOFF)
        catalog = next(s for s in original_rollup["sections"] if s["id"] == "hedgai-signals")["metadata"]["presentationCatalog"]
        catalog["securityNames"]["hedgai:QQQ"] = "Captured Nasdaq name"
        catalog["groups"][0]["pinnedInstrumentIds"] = ["hedgai:GLD", "hedgai:QQQ"]
        with tempfile.TemporaryDirectory() as directory:
            store = ReviewRunV2Store(Path(directory) / "reviews.sqlite3")
            run, _ = store.create(review_kind="portfolio-review", conversation_id="captured", request_id="captured")
            fingerprint, _ = store.store_evidence("dailyResearch", captured)
            store.update(run["runId"], state="succeeded", outcome="partial", completedAt=CUTOFF,
                sourceFingerprints={"dailyResearch": fingerprint}, dependencies={"dailyResearch": {"asOf": CUTOFF, "status": "partial", "fingerprint": fingerprint}},
                sections=[{"id": "portfolio-research-review", "dailyRollup": original_rollup}], reportMarkdown="Original immutable report")
            with store.connect() as connection:
                before = tuple(connection.execute("SELECT * FROM analyst_review_runs_v2 WHERE run_id=?", (run["runId"],)).fetchone())
            later = copy.deepcopy(captured)
            next(row for row in later["hedgai"]["book"]["rows"] if row["ticker"] == "QQQ")["position"] = "Buy"
            store.store_evidence("dailyResearch", later)
            with patch("hedgai_review.read_hedgai_research", side_effect=AssertionError("Saved reviews cannot fetch today's research")):
                saved = store.get(run["runId"])
                exported = public_review_run(saved)["reportMarkdown"]
                metrics = {"available": True, "positions": [{"symbol": "QQQ", "quantity": 1, "category": "etf"}]}
                brief = build_portfolio_brief(saved, metrics, {}, daily_research=store.read_evidence(saved, "dailyResearch"))
            self.assertEqual(brief["holdings"][0]["tick"]["position"], "Short")
            self.assertEqual(brief["holdings"][0]["tick"]["value"], "BEARISH")
            self.assertFalse(brief["holdings"][0]["tick"]["strategyQualified"])
            section = next(s for s in brief["dailyRollup"]["sections"] if s["id"] == "hedgai-signals")
            main = next(block for block in section["blocks"] if block.get("groupRows") and not block.get("disclosure"))
            self.assertEqual([row["ticker"] for row in main["rows"][:2]], ["GLD", "QQQ"])
            self.assertEqual(main["rows"][1]["cells"][1:3], ["Captured Nasdaq name", "Short"])
            self.assertEqual(saved["reportMarkdown"], "Original immutable report")
            self.assertIn("Captured Nasdaq name", exported)
            self.assertIn("**Top AI Signals**", exported)
            self.assertIn("Bull history | Bear history | Initiated | Statistics date", exported)
            self.assertEqual(saved["sourceFingerprints"]["dailyResearch"], fingerprint)
            with store.connect() as connection:
                after = tuple(connection.execute("SELECT * FROM analyst_review_runs_v2 WHERE run_id=?", (run["runId"],)).fetchone())
            self.assertEqual(after, before)

    def test_old_capture_without_presentation_metadata_gains_layout_without_fetch_or_rewrite(self):
        captured = {"date": "2026-09-28", "hedgai": self.projection()}
        with tempfile.TemporaryDirectory() as directory:
            store = ReviewRunV2Store(Path(directory) / "reviews.sqlite3")
            run, _ = store.create(review_kind="portfolio-review", conversation_id="legacy", request_id="legacy")
            fingerprint, _ = store.store_evidence("dailyResearch", captured)
            old = {"version": 1, "sections": [{"id": "hedgai-signals", "title": "HedgAI Signals", "blocks": [{"type": "paragraph", "text": "Old layout"}]}], "citations": []}
            store.update(run["runId"], state="succeeded", outcome="partial", sourceFingerprints={"dailyResearch": fingerprint},
                dependencies={"dailyResearch": {"asOf": CUTOFF, "status": "partial", "fingerprint": fingerprint}},
                sections=[{"id": "portfolio-research-review", "dailyRollup": old}], reportMarkdown="Old stored report")
            saved = store.get(run["runId"])
            self.assertIn("Tick | Today | History | 60% filter", public_review_run(saved)["reportMarkdown"])
            self.assertEqual(saved["reportMarkdown"], "Old stored report")
            # A damaged evidence blob must never be used to rebuild a report.
            with store.connect() as connection:
                connection.execute("UPDATE analyst_review_evidence_v2 SET payload_json='{}' WHERE fingerprint=?", (fingerprint,))
            self.assertEqual(public_review_run(store.get(run["runId"]))["reportMarkdown"], "Old stored report")

    def test_one_instrument_conflict_preserves_independent_active_readings(self):
        projection = self.projection()
        projection["sourceQuality"].update(continuity="unknown", issues=[{"blocking": True, "instrumentId": "hedgai:XLE", "code": "close-side-conflict"}])
        section, _ = portfolio_hedgai_section(projection, as_of=CUTOFF)
        tickers = [row["ticker"] for row in section["blocks"][-1]["rows"] if row["activeDirection"]]
        self.assertNotIn("XLE", tickers)
        self.assertEqual(set(tickers), {"SLX", "UJB", "SPY", "IWM", "XLY"})
        readings, _ = prediction_hedgai_readings(projection, as_of=CUTOFF)
        self.assertEqual(readings["sp500"]["activeDirection"], "Bullish")
        projection["sourceQuality"]["issues"][0]["instrumentId"] = "hedgai:UNMAPPED"
        readings, _ = prediction_hedgai_readings(projection, as_of=CUTOFF)
        self.assertIsNone(readings["sp500"]["activeDirection"])

    def test_prediction_priority_proxy_identity_and_native_contracts_are_unchanged(self):
        projection = self.projection()
        evidence = {"date": "2026-09-28", "hedgai": projection}
        rollup = build_prediction_research_rollup(evidence, as_of=CUTOFF)
        for market, ticker in (("sp500", "SPY"), ("nasdaq100", "QQQ"), ("gold", "GLD"), ("bitcoin", "IBIT")):
            reading = rollup["markets"][market]["hedgai"]
            self.assertEqual(reading["ticker"], ticker)
            self.assertEqual(reading["mapping"]["fit"], "proxy")
            self.assertFalse(reading["decisionEligible"])
            self.assertFalse(reading["executable"])
        self.assertIsNone(rollup["markets"]["nasdaq100"]["hedgai"]["activeDirection"])
        self.assertEqual(rollup["markets"]["nasdaq100"]["hedgai"]["position"], "Short")
        view = {"version": 1, "trade": {"direction": "BULLISH", "instrument": "SPX", "publishedAt": "2026-09-28"},
                "trend": {"direction": "BEARISH", "instrument": "SPX", "publishedAt": "2026-09-28"},
                "direction": {"value": "BULLISH", "basis": "Trade"}, "contracts": {"comparisons": [{
                    "threshold": 7600, "comparator": ">", "side": "YES", "ask": .4,
                    "marketImpliedPct": 40, "grossPayoffRatio": 1.5, "label": "Current strike"}]}}
        original = copy.deepcopy(view)
        row = {"marketId": "sp500", "asset": "S&P 500", "venue": "forecastex", "managerView": view,
               "research": rollup["markets"]["sp500"]}
        rendered = render_prediction_review([{"id": "monitored-markets", "markets": [row]}], "ready", rollup["citations"])
        self.assertLess(rendered.index("**Tick:"), rendered.index("**Trade:"))
        self.assertIn("Bullish Tick SPY proxy agrees", rendered)
        self.assertIn("[HedgAI Signals](citation://", rendered)
        self.assertIn("SPY proxy", rendered)
        self.assertIn("agrees with Bullish Trade; conflicts with Bearish Trend", rendered)
        self.assertIn("40¢ | 40% | 1.5:1", rendered)
        self.assertEqual(view, original)
        row["managerView"] = {}
        offline = render_prediction_review([{"id": "monitored-markets", "markets": [row]}], "partial", rollup["citations"])
        self.assertIn("**Tick:", offline)
        self.assertNotIn("40¢", offline)


class HedgaiReaderTests(unittest.IsolatedAsyncioTestCase):
    async def test_exact_cutoff_capture_and_optional_failure(self):
        projection = reviewed_projection()
        requests = []
        def handle(request):
            requests.append(request)
            return httpx.Response(200, json=projection)
        result = await read_hedgai_research("http://dashboard.test", CUTOFF, transport=httpx.MockTransport(handle))
        self.assertEqual(result, projection)
        self.assertEqual(requests[0].url.path, "/api/research/hedgai")
        self.assertEqual(requests[0].url.params["asOf"], CUTOFF)
        self.assertEqual(await read_hedgai_research("http://dashboard.test", CUTOFF,
            transport=httpx.MockTransport(lambda _request: httpx.Response(503))), {})


if __name__ == "__main__":
    unittest.main()
