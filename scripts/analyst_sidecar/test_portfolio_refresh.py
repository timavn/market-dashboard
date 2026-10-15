import copy
import json
import unittest

from portfolio_refresh import build_portfolio_refresh, TEMPLATE_VERSION, COLUMNS, REALIGNMENT_COLUMNS


DAY = "2026-09-30"
CUTOFF = DAY + "T21:00:00Z"


def book(*positions, **extra):
    rows = list(positions) or [{"symbol": "ABC", "quantity": 10, "marketValue": 3000, "markState": "live",
                              "category": "stock", "secType": "STK", "longName": "ABC Corporation"}]
    return {"available": True, "observedAt": CUTOFF, "positionCount": len(rows), "netLiquidation": 100000,
            "positions": rows, **extra}


def reference(kind="trend_signal", value="BULLISH", day=DAY, symbol="ABC", product="risk-ranges", **extra):
    row = {"kind": kind, "value": value, "productId": product, "productLabel": product.title(), "marketDate": day,
           "publishedAt": day + "T12:00:00Z", "qualityStatus": "indexed", "matchType": "direct", "sourceTicker": symbol,
           "sourceUrl": f"https://app.hedgeye.com/feed_items/{day.replace('-', '')}", "sourceEventId": f"{product}-{kind}-{day}-{value}",
           "excerpt": f"{symbol} Trend is {value}."}
    if kind == "trade_signal":
        row["excerpt"] = f"{symbol} Trade is {value}."
        row["signalProvenance"] = {"field": "trade", "method": "explicit-statement", "sourceField": "article.bodyText", "sourceText": row["excerpt"]}
    return {**row, **extra}


def action(text="REMOVE ABC — Long", day="2026-07-15", **extra):
    value = extra.pop("value", {"action": "REMOVE", "side": "Long", "ticker": "ABC"})
    kind = extra.pop("kind", "etf_pro_change")
    return reference(kind, value, day,
                     product="etf-pro", excerpt=text, referenceOnly=True, currentDecisionEligible=False,
                     executable=False, **extra)


def archived(*refs, **extra):
    return {"schemaVersion": 1, "scope": "available-source-archive", "scanComplete": True,
            "manifest": {"documentCount": 20, "pages": 2, "earliestDate": "2026-01-01", "latestDate": DAY, "hash": "capturedhash"},
            "coverage": {"products": [{"id": "etf-pro", "label": "ETF Pro", "status": "checked", "documentCount": 20}], "reasons": []},
            "bySymbol": {"ABC": {"references": list(refs)}}, **extra}


def intelligence(*refs):
    decision = {}
    for ref in refs:
        field = "trade" if ref["kind"] == "trade_signal" else "trend"
        value = ref["value"].get("trend") if isinstance(ref["value"], dict) else ref["value"]
        decision[field] = {"status": "available", "value": value, "sourceId": ref["productId"]}
    return {"bySymbol": {"ABC": {"decision": decision, "directReferences": list(refs)}}}


def refresh(metrics=None, current=None, archive=None, coverage=None):
    return build_portfolio_refresh(metrics if metrics is not None else book(), current or {},
                                   archive if archive is not None else archived(), coverage or {}, as_of=CUTOFF)


class PortfolioRefreshTests(unittest.TestCase):
    def test_old_removal_is_dated_requalification_and_readd_supersedes_it(self):
        removed = action()
        report = refresh(archive=archived(removed))
        row = report["holdings"][0]
        self.assertEqual(row["classification"], "realignment")
        self.assertEqual(row["sourceAction"], "Removed source Long")
        self.assertEqual(row["proposedAction"], "Requalify Long holding")
        self.assertFalse(row["currentActionAllowed"])
        self.assertIn("2026-07-15", row["publishedAt"])
        added = action("ADD ABC — Long", "2026-09-15", value={"action": "ADD", "side": "Long"})
        report = refresh(archive=archived(removed, added))
        row = report["holdings"][0]
        self.assertEqual(row["classification"], "watch")
        self.assertIsNone(row["proposedAction"])
        self.assertNotIn("Removed", row["reading"])
        self.assertEqual(len(row["evidence"]), 1)

    def test_partial_sale_and_cover_preserve_source_meaning(self):
        for text, side, quantity, label in (("ABC: Sell some into strength; this is not an exit.", "LONG", 10, "Sell some"),
                                             ("Cover some ABC", "SHORT", -10, "Cover some")):
            with self.subTest(label=label):
                metrics = book({"symbol": "ABC", "quantity": quantity, "category": "stock", "markState": "live", "marketValue": quantity * 100})
                report = refresh(metrics, archive=archived(action(text, DAY)))
                row = report["holdings"][0]
                self.assertEqual(row["sourceAction"], label)
                self.assertIn("partial", row["proposedAction"])
                self.assertNotIn("Exit", row["proposedAction"])
                self.assertFalse(row["currentActionAllowed"])
                self.assertEqual(row["heldSide"], side)

    def test_realignment_template_splits_verified_bias_and_size_without_changing_source_evidence(self):
        report = refresh(archive=archived(action("ABC: Sell some into strength; this is not an exit.", DAY)))
        block = report["sections"][0]["blocks"][0]
        row = block["rows"][0]
        self.assertEqual(block["columns"], ["Ticker", "Security", "Bias", "Size", "Source action", "Notes", "Source date"])
        self.assertEqual(row["cells"], ["ABC", "ABC Corporation", "Long", "3.00%", "Sell some",
                                        "Review partial Long reduction", "Sep 30, 2026"])
        self.assertNotIn("Exit", row["cells"][4])
        self.assertEqual(row["cellCitationIds"], [[], [], [], [], row["citationIds"], row["citationIds"], row["citationIds"]])
        self.assertIn("Sell some", row["cellTitles"][4])
        self.assertEqual(row["cellTitles"][6], report["holdings"][0]["publishedAt"])
        checks = report["sections"][2]["blocks"][-1]
        self.assertEqual(checks["columns"], COLUMNS)
        self.assertEqual(checks["rows"][0]["cells"][2], "Long · 3.00%")

    def test_realignment_unavailable_size_stays_dash_and_offline_holdings_propose_no_action(self):
        metrics = book()
        metrics["positions"][0].update(markState="unavailable", marketValue=9000)
        archive = archived(action("ABC: Sell some into strength", DAY))
        report = refresh(metrics, archive=archive)
        block = report["sections"][0]["blocks"][0]
        self.assertEqual(block["columns"], REALIGNMENT_COLUMNS)
        self.assertEqual(block["rows"][0]["cells"][2:5], ["Long", "—", "Sell some"])
        self.assertFalse(report["holdings"][0]["currentActionAllowed"])
        self.assertEqual(report["holdings"][0]["proposedAction"], "Review partial Long reduction")
        offline = refresh({**metrics, "available": False}, archive=archive)
        self.assertIsNone(offline["holdings"][0]["proposedAction"])
        self.assertFalse(offline["holdings"][0]["currentActionAllowed"])
        self.assertFalse(any(block["type"] == "table" for block in offline["sections"][0]["blocks"]))

    def test_watch_and_aligned_tables_keep_the_existing_column_contract(self):
        for current, archive, section_index in ((intelligence(reference()), archived(), 2),
                                                 ({}, archived(reference("portfolio_solutions_rank", 100, product="portfolio-solutions")), 1)):
            with self.subTest(section=section_index):
                report = refresh(current=current, archive=archive)
                table = next(block for block in report["sections"][section_index]["blocks"] if block["type"] == "table")
                self.assertEqual(table["columns"], COLUMNS)
                self.assertEqual(len(table["rows"][0]["cells"]), 6)

    def test_exact_rta_partial_body_overrides_generic_headline_and_requires_same_source(self):
        proof = {"title": "ABC SELL Signal", "bodyText": "Portfolio Managers should be selling-SOME of their ABC Long position into strength.",
                 "publicationDate": DAY, "sourceMessageId": "exact", "sourceUrl": "gmail://message/exact", "contentHash": "exacthash"}
        ref = action("SELL ABC", DAY, kind="real_time_alert", value={"action": "SELL", "side": "Long", "ticker": "ABC"},
                     sourceUrl="gmail://message/exact", sourceMessageId="exact", sourceEvidence=proof)
        row = refresh(archive=archived(ref))["holdings"][0]
        self.assertEqual(row["sourceAction"], "Sell some")
        self.assertIn("partial", row["proposedAction"])
        wrong = copy.deepcopy(ref)
        wrong["sourceEvidence"]["sourceMessageId"] = "other-report"
        row = refresh(archive=archived(wrong))["holdings"][0]
        self.assertEqual(row["sourceAction"], "Sell")
        self.assertNotIn("partial", row["proposedAction"])

    def test_publisher_structured_partial_scope_is_preserved(self):
        ref = action("SELL ABC", DAY, value={"action": "SELL", "side": "Long", "scope": "partial", "ticker": "ABC"})
        row = refresh(archive=archived(ref))["holdings"][0]
        self.assertEqual(row["sourceAction"], "Sell some")

    def test_real_rta_intrinsic_partial_action_accepts_null_side_with_exact_hashed_source(self):
        for raw_action, quantity, label in (("SELL-SOME", 10, "Sell some"), ("COVER-SOME", -10, "Cover some")):
            with self.subTest(action=raw_action):
                exact = {"ticker": "ABC", "action": raw_action, "signalPhrase": f"Macro Trend {raw_action}",
                         "headline": f"Real-Time Alert: Macro Trend {raw_action} Signal: ABC Corporation (ABC) -KM", "side": None}
                proof = {"title": exact["headline"], "publicationDate": DAY, "sourceMessageId": "exact",
                         "sourceUrl": "gmail://message/exact", "contentHash": "exacthash", "bodyText": None}
                ref = action(exact["signalPhrase"], DAY, kind="real_time_alert", value=exact,
                             sourceEvidence=proof, sourceUrl=proof["sourceUrl"], sourceMessageId="exact")
                metrics = book({"symbol": "ABC", "quantity": quantity, "category": "stock"})
                row = refresh(metrics, archive=archived(ref))["holdings"][0]
                self.assertEqual(row["sourceAction"], label)
                self.assertIn("partial", row["proposedAction"])
                wrong = copy.deepcopy(ref)
                wrong["sourceEvidence"]["sourceMessageId"] = "wrong"
                row = refresh(metrics, archive=archived(wrong))["holdings"][0]
                self.assertIsNone(row["sourceAction"])

    def test_current_direct_trade_and_trend_apply_existing_rules(self):
        report = refresh(current=intelligence(reference("trade_signal", "BEARISH", product="etf-pro")))
        self.assertEqual(report["holdings"][0]["proposedAction"], "Exit Long")
        self.assertTrue(report["holdings"][0]["currentActionAllowed"])
        report = refresh(current=intelligence(reference("trade_signal", "BULLISH", product="etf-pro"), reference(value="BEARISH")))
        self.assertEqual(report["holdings"][0]["proposedAction"], "Reduce to MIN")

    def test_archive_trade_does_not_grant_current_eligibility(self):
        ref = reference("trade_signal", "BEARISH", product="etf-pro", referenceOnly=True, currentDecisionEligible=False, executable=False)
        report = refresh(current=intelligence(ref), archive=archived(ref))
        row = report["holdings"][0]
        self.assertEqual(row["classification"], "watch")
        self.assertIsNone(row["proposedAction"])
        self.assertFalse(row["currentActionAllowed"])

    def test_stale_or_cache_only_typed_signal_stays_dated_without_current_rule(self):
        for flag in ("stale", "cacheOnly", "offline", "refreshFailed"):
            with self.subTest(flag=flag):
                ref = reference("trade_signal", "BEARISH", product="etf-pro", **{flag: True})
                row = refresh(current=intelligence(ref))["holdings"][0]
                self.assertEqual(row["classification"], "watch")
                self.assertIsNone(row["proposedAction"])
                self.assertFalse(row["currentActionAllowed"])

    def test_unknown_and_unsupported_positions_survive_without_alignment(self):
        metrics = book({"symbol": "UNKNOWN", "quantity": 2, "category": "stock", "conId": 123, "account": "A"},
                       {"symbol": "ABC", "quantity": 1, "category": "option", "secType": "OPT", "conId": 456, "account": "A", "contract": "ABC option", "expiration": "2026-10-02", "strike": 30, "right": "C"},
                       {"symbol": "ABC", "quantity": 1, "category": "event_contract", "conId": 789, "account": "A"})
        report = refresh(metrics, current=intelligence(reference()))
        self.assertEqual(report["positionCount"], 3)
        self.assertEqual([row["conId"] for row in report["holdings"]], [123, 456, 789])
        self.assertEqual(report["holdings"][1]["expiration"], "2026-10-02")
        self.assertTrue(all(row["classification"] != "aligned" for row in report["holdings"]))
        self.assertTrue(all(row["proposedAction"] is None for row in report["holdings"]))
        check = report["sections"][2]["blocks"][-1]
        self.assertEqual(len(check["rows"]), 3)
        self.assertIn("2026-10-02", check["rows"][1]["cellTitles"][0])
        self.assertTrue(check["disclosure"])
        self.assertFalse(any(block["type"] == "table" for block in report["sections"][1]["blocks"]))

    def test_unknown_instrument_identity_does_not_borrow_same_ticker_signal(self):
        row = refresh(book({"symbol": "ABC", "quantity": 1, "category": "other", "secType": "UNKNOWN"}),
                      current=intelligence(reference()))["holdings"][0]
        self.assertFalse(row["supported"])
        self.assertEqual(row["classification"], "unavailable")
        self.assertIsNone(row["proposedAction"])
        row = refresh(book({"symbol": "ABC", "quantity": 1, "category": "other", "secType": "STK"}),
                      current=intelligence(reference()))["holdings"][0]
        self.assertTrue(row["supported"])
        self.assertEqual(row["classification"], "aligned")

    def test_same_date_opposing_actions_are_ambiguous(self):
        report = refresh(archive=archived(action(day=DAY), action("ADD ABC — Long", DAY, value={"action": "ADD", "side": "Long"})))
        row = report["holdings"][0]
        self.assertEqual(row["classification"], "watch")
        self.assertIsNone(row["proposedAction"])
        self.assertEqual(row["reading"], "Conflicting source actions")
        self.assertEqual(len(report["citations"]), 2)

    def test_same_date_signal_conflicts_never_propose_exit(self):
        bullish, bearish = reference("trade_signal", "BULLISH", product="etf-pro"), reference("trade_signal", "BEARISH", product="etf-pro")
        report = refresh(current=intelligence(bearish), archive=archived(bullish))
        self.assertEqual(report["holdings"][0]["classification"], "watch")
        self.assertFalse(report["holdings"][0]["currentActionAllowed"])

    def test_bad_future_conditional_and_wrong_instrument_research_do_not_apply(self):
        refs = [reference("trade_signal", "BEARISH", "2026-10-01", product="etf-pro"),
                reference(value="BEARISH", mock=True),
                reference(value="BEARISH", sourceTicker="XYZ"),
                reference("trade_signal", "BEARISH", product="etf-pro", signalProvenance={"field": "trade", "method": "explicit-statement", "sourceField": "body", "sourceText": "ABC could turn Bearish Trade."}),
                action("ABC may exit Long tomorrow", DAY)]
        report = refresh(archive=archived(*refs))
        self.assertEqual(report["holdings"][0]["evidence"], [])
        self.assertIsNone(report["holdings"][0]["proposedAction"])

    def test_invalid_range_does_not_discard_independent_published_trend(self):
        invalid = reference("primary_risk_range", {"trend": "BEARISH", "low": 200, "high": 100})
        report = refresh(current=intelligence(reference("trade_signal", "BULLISH", product="etf-pro"), invalid))
        self.assertEqual(report["holdings"][0]["proposedAction"], "Reduce to MIN")
        cells = report["sections"][0]["blocks"][0]["rows"][0]["cells"]
        self.assertNotIn("200", str(cells))
        self.assertTrue(any("200" in (citation.get("excerpt") or "") for citation in report["citations"]))

    def test_observed_event_time_orders_same_day_readd_without_inventing_publication_time(self):
        for published in (None, DAY + "T00:00:00Z"):
            with self.subTest(published=published):
                removed = action(day=DAY, publishedAt=published, eventTime=DAY + "T13:00:00Z")
                added = action("ADD ABC — Long", DAY, value={"action": "ADD", "side": "Long"}, publishedAt=published, eventTime=DAY + "T14:00:00Z")
                row = refresh(archive=archived(removed, added))["holdings"][0]
                self.assertEqual(row["reading"], "Added source Long")
                self.assertEqual(row["publishedAt"], DAY)
                self.assertIsNone(row["proposedAction"])

    def test_no_current_action_for_offline_stale_mock_or_malformed_holdings(self):
        current = intelligence(reference("trade_signal", "BEARISH", product="etf-pro"))
        for patch in ({"available": False}, {"offline": True}, {"stale": True}, {"cacheOnly": True}, {"mock": True}, {"positionCount": 2}):
            with self.subTest(patch=patch):
                report = refresh(book(**patch), current)
                self.assertFalse(report["available"])
                self.assertEqual(len(report["holdings"]), 1)
                self.assertIsNone(report["holdings"][0]["proposedAction"])
                self.assertFalse(report["holdings"][0]["currentActionAllowed"])
        for field in ("offline", "stale", "cacheOnly", "seeded", "mock"):
            metrics = book()
            metrics["positions"][0][field] = True
            report = refresh(metrics, current)
            self.assertIsNone(report["holdings"][0]["proposedAction"])
            self.assertFalse(report["holdings"][0]["currentHoldingVerified"])

    def test_nonlive_mark_withholds_weight_without_erasing_holding(self):
        metrics = book()
        metrics["positions"][0].update(markState="unavailable", marketValue=9000)
        row = refresh(metrics, current=intelligence(reference()))["holdings"][0]
        self.assertIsNone(row["weightPct"])
        self.assertTrue(row["currentHoldingVerified"])

    def test_roster_absence_never_infers_removal_and_rank_never_means_sell(self):
        archive = archived(reference("portfolio_solutions_rank", 100, product="portfolio-solutions"))
        archive["publications"] = [{"productId": "etf-pro", "marketDate": DAY, "completeRoster": True, "positions": []}]
        row = refresh(archive=archive)["holdings"][0]
        self.assertIsNone(row["sourceAction"])
        self.assertIsNone(row["proposedAction"])
        self.assertEqual(row["classification"], "watch")
        self.assertEqual(row["reading"], "Published rank 100")

    def test_complete_affirmative_roster_supersedes_older_same_product_removal(self):
        archive = archived(action())
        archive["publications"] = [{"productId": "etf-pro", "productLabel": "ETF Pro", "marketDate": "2026-09-15", "publishedAt": None,
                                    "sourceUrl": "gmail://message/full-book", "sourceMessageId": "full-book", "contentHash": "verifiedhash",
                                    "sourceSnapshotId": "2026-09-15:etf-pro", "completeRoster": True, "positions": [{"ticker": "ABC", "side": "LONG"}]}]
        report = refresh(archive=archive)
        row = report["holdings"][0]
        self.assertEqual(row["classification"], "watch")
        self.assertIsNone(row["proposedAction"])
        self.assertEqual(row["reading"], "Source Long position")
        self.assertFalse(any(item["kind"] == "trade" for item in row["evidence"]))
        self.assertEqual(report["citations"][0]["sourceMessageId"], "full-book")
        archive["publications"][0]["positions"] = []
        row = refresh(archive=archive)["holdings"][0]
        self.assertEqual(row["sourceAction"], "Removed source Long")
        self.assertEqual(row["classification"], "realignment")

    def test_complete_roster_requires_original_hash_and_exact_identity(self):
        archive = archived(action())
        publication = {"productId": "etf-pro", "marketDate": DAY, "sourceUrl": "gmail://message/checkpoint",
                       "completeRoster": True, "positions": [{"ticker": "ABC", "side": "LONG"}]}
        for patch in ({}, {"contentHash": "hash", "positions": [{"ticker": "XYZ", "side": "LONG"}]}, {"contentHash": "hash", "mock": True}):
            with self.subTest(patch=patch):
                archive["publications"] = [{**publication, **patch}]
                row = refresh(archive=archive)["holdings"][0]
                self.assertEqual(row["sourceAction"], "Removed source Long")

    def test_fresh_empty_book_is_distinct_from_unavailable(self):
        empty = {"available": True, "positions": [], "positionCount": 0, "observedAt": CUTOFF}
        report = refresh(empty)
        self.assertTrue(report["available"])
        self.assertEqual(report["holdings"], [])
        self.assertNotIn("unavailable", str(report["sections"]).lower())
        report = refresh({"available": False, "positions": []})
        self.assertFalse(report["available"])

    def test_complete_capture_template_sources_and_input_immutability(self):
        metrics, current, archive = book(), intelligence(reference()), archived()
        before = copy.deepcopy((metrics, current, archive))
        report = refresh(metrics, current, archive)
        self.assertEqual((metrics, current, archive), before)
        self.assertEqual(report["templateVersion"], TEMPLATE_VERSION)
        self.assertEqual([section["title"] for section in report["sections"]], ["Highest-priority realignment", "Watch list", "What is already aligned", "Recommended sequence"])
        self.assertEqual(report["holdings"][0]["classification"], "aligned")
        self.assertTrue(report["complete"])
        self.assertEqual(report["archiveManifest"]["hash"], "capturedhash")
        for section in report["sections"]:
            for block in section["blocks"]:
                if block["type"] == "table":
                    self.assertEqual(block["columns"][:2], ["Ticker", "Security"])
                    self.assertEqual(block["columns"][-1], "Source date" if section["id"] == "refresh-realignment" else "Date")

    def test_missing_holding_name_uses_its_own_captured_research_identity(self):
        metrics, current = book({"symbol": "ABC", "quantity": 1, "category": "stock"}), intelligence(reference())
        current["bySymbol"]["ABC"]["securityName"] = "Captured ABC Corporation"
        row = refresh(metrics, current)["holdings"][0]
        self.assertEqual(row["security"], "Captured ABC Corporation")
        metrics["positions"][0]["securityName"] = "Original broker name"
        self.assertEqual(refresh(metrics, current)["holdings"][0]["security"], "Original broker name")

    def test_report_does_not_repeat_source_bodies_or_every_daily_confirmation(self):
        refs = []
        full_body = "Captured exact publisher body. " * 10000
        for index in range(1, 29):
            day = f"2026-09-{index:02d}"
            proof = {"publicationDate": day, "sourceMessageId": f"message-{index}", "sourceUrl": f"gmail://message/{index}",
                     "contentHash": f"hash-{index}", "title": "Sell some ABC", "bodyText": full_body}
            refs.append(action("ABC: Sell some into strength", day, value={"action": "SELL-SOME", "side": "Long", "ticker": "ABC"},
                               sourceUrl=proof["sourceUrl"], sourceMessageId=proof["sourceMessageId"], sourceEvidence=proof))
        archive = archived(*refs)
        before = copy.deepcopy(archive)
        metrics = book(*[{"symbol": "ABC", "quantity": 1, "category": "stock", "conId": index} for index in range(72)])
        report = refresh(metrics, archive=archive)
        self.assertEqual(archive, before)
        self.assertEqual(len(report["holdings"]), 72)
        self.assertEqual(len(report["citations"]), 2)
        self.assertTrue(report["holdings"][0]["publishedAt"].startswith("2026-09-01"))
        self.assertNotIn("bodyText", json.dumps(report))
        self.assertNotIn("citations", report["holdings"][0]["evidence"][0])
        self.assertEqual(len(report["holdings"][0]["evidence"][0]["citationIds"]), 2)
        self.assertNotIn("evidence", report["sections"][0]["blocks"][0]["rows"][0])
        self.assertLess(len(json.dumps(report)), 250000)

    def test_incomplete_scan_and_missing_delivery_prevent_complete_claim(self):
        report = refresh(archive=archived(scanComplete=False))
        self.assertFalse(report["complete"])
        self.assertIn("incomplete", report["sections"][0]["blocks"][0]["text"])
        report = refresh(coverage={"products": [{"product": "etf-pro", "label": "ETF Pro", "status": "missing"}]})
        self.assertFalse(report["complete"])
        self.assertEqual(report["productCoverage"][0]["currentStatus"], "missing")

    def test_realignment_capture_retains_all_priority_rows_for_report_disclosure(self):
        metrics = book(*[{"symbol": "ABC", "quantity": 1, "category": "stock", "conId": i} for i in range(20)])
        report = refresh(metrics, current=intelligence(reference("trade_signal", "BEARISH", product="etf-pro")))
        self.assertEqual(len(report["sections"][0]["blocks"][0]["rows"]), 20)
        self.assertEqual(len(report["sections"][2]["blocks"][-1]["rows"]), 20)
        self.assertEqual(report["diagnostics"]["displayedCounts"]["realignment"], {"total": 20, "shown": 20})

    def test_realignment_disclosure_capture_retains_both_sides_and_verified_priority(self):
        positions = [{"symbol": symbol, "quantity": quantity, "category": "stock", "conId": index,
                      "marketValue": quantity * (index + 1) * 100, "markState": "live"}
                     for symbol, quantity in (("ABC", 1), ("XYZ", -1)) for index in range(7)]
        positions.append({"symbol": "ABC", "quantity": 1, "category": "stock", "conId": 99, "verified": False})
        long_ref = reference("trade_signal", "BEARISH", product="etf-pro")
        short_ref = reference("trade_signal", "BULLISH", symbol="XYZ", product="etf-pro")
        current = {"bySymbol": {
            "ABC": intelligence(long_ref)["bySymbol"]["ABC"],
            "XYZ": intelligence(short_ref)["bySymbol"]["ABC"],
        }}
        before = copy.deepcopy((positions, current))
        report = refresh(book(*positions), current=current)
        rows = report["sections"][0]["blocks"][0]["rows"]
        self.assertEqual((positions, current), before)
        self.assertEqual(len(rows), 14)
        for side in ("Long", "Short"):
            side_rows = [row for row in rows if row["cells"][2] == side]
            self.assertEqual(len(side_rows), 7)
            self.assertEqual([row["cells"][3] for row in side_rows], [f"0.{value}0%" for value in range(7, 0, -1)])
            self.assertTrue(all(row["citationIds"] for row in side_rows))
        self.assertFalse(any(":99:" in row["positionId"] for row in rows))
        self.assertEqual(len(report["sections"][2]["blocks"][-1]["rows"]), 15)

    def test_watch_and_aligned_capture_retains_complete_eligible_roster_for_report_disclosure(self):
        positions = [{"symbol": "ABC", "quantity": 1, "category": "stock", "conId": index,
                      "marketValue": (index + 1) * 100, "markState": "live"}
                     for index in range(20)]
        positions.extend([
            {"symbol": "ABC", "quantity": 1, "category": "stock", "conId": 99, "verified": False},
            {"symbol": "MISSING", "quantity": 1, "category": "stock", "conId": 100},
        ])
        cases = (
            ("watch", 1, {}, archived(reference("portfolio_solutions_rank", 100, product="portfolio-solutions"))),
            ("aligned", 2, intelligence(reference()), archived()),
        )
        for category, section_index, current, archive in cases:
            with self.subTest(category=category):
                metrics = book(*positions)
                before = copy.deepcopy((metrics, current, archive))
                report = refresh(metrics, current=current, archive=archive)
                rows = report["sections"][section_index]["blocks"][0]["rows"]
                self.assertEqual((metrics, current, archive), before)
                self.assertEqual(len(rows), 20)
                self.assertEqual([row["cells"][2] for row in rows], [f"Long · {value / 10:.2f}%" for value in range(20, 0, -1)])
                self.assertTrue(all(row["classification"] == category and row["citationIds"] for row in rows))
                self.assertFalse(any(":99:" in row["positionId"] or row["holding"] == "MISSING" for row in rows))
                self.assertEqual(report["diagnostics"]["displayedCounts"][category], {"total": 20, "shown": 20})
                self.assertEqual(len(report["sections"][2]["blocks"][-1]["rows"]), 22)


if __name__ == "__main__":
    unittest.main()
