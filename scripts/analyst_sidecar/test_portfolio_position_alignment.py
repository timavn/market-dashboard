import copy
import unittest
from unittest.mock import patch

import portfolio_position_alignment as alignment
from portfolio_position_alignment import build_position_alignment_sections


DAY = "2026-09-28"
CUTOFF = f"{DAY}T21:00:00Z"


def holding(symbol="ABC", side="LONG", **extra):
    return {"holding": symbol, "heldSide": side, "quantity": 10 if side == "LONG" else -10,
            "securityName": f"{symbol} Incorporated", "weightPct": 3.18, **extra}


def reference(field="trend", value="BULLISH", day=DAY, **extra):
    trade = field == "trade"
    row = {"kind": "trade_signal" if trade else "primary_risk_range", "productId": "etf-pro" if trade else "risk-ranges",
           "marketDate": day, "publishedAt": f"{day}T12:30:00Z", "qualityStatus": "indexed", "matchType": "direct",
           "sourceTicker": "ABC", "sourceUrl": "https://app.hedgeye.com/feed_items/12345",
           "sourceEventId": f"{field}-{day}-{value}", "value": value if trade else {"trend": value},
           "excerpt": f"ABC {field.title()} is {value.title()}."}
    if trade:
        row["signalProvenance"] = {"field": "trade", "method": "explicit-statement", "sourceField": "article.bodyText", "sourceText": row["excerpt"]}
    return {**row, **extra}


def security(refs, history=None):
    decision = {}
    for ref in refs:
        field = "trade" if ref["kind"] == "trade_signal" else "trend"
        value = ref["value"].get("trend") if isinstance(ref["value"], dict) else ref["value"]
        decision[field] = {"status": "available", "value": value, "sourceId": ref["productId"]}
    return {"decision": decision, "directReferences": refs, "history": [{"directReferences": history or []}]}


def daily(body, *, product="the-call", **extra):
    snapshot = {"date": DAY, "publishedAt": f"{DAY}T13:28:00Z", "article": {
        "feedUrl": "https://app.hedgeye.com/feed_items/54321", "bodyText": body}, **extra}
    return {"date": DAY, "snapshots": {product: snapshot}}


def rows(sections, index):
    return [row for block in sections[index]["blocks"] for row in block.get("rows", [])]


class PositionAlignmentTests(unittest.TestCase):
    def build(self, book=None, research=None, intelligence=None):
        return build_position_alignment_sections(book if book is not None else [holding()], intelligence or {}, research or {}, as_of=CUTOFF)

    def test_explicit_call_buying_opportunity_keeps_weight_name_source_and_why_last(self):
        sections, citations = self.build(research=daily("TOP 5 MOST ACTIONABLE\n\nABC: A good buying opportunity after the pullback."))
        row = rows(sections, 0)[0]
        self.assertEqual(sections[0]["blocks"][0]["columns"], ["Ticker", "Security", "Position", "Product", "Reading", "Why"])
        self.assertEqual(row["cells"][:4], ["ABC", "ABC Incorporated", "Long · 3.18%", "The Call"])
        self.assertIn("Sep 28, 2026", row["cells"][4])
        self.assertIn("supports", row["cells"][-1].lower())
        self.assertTrue(row["cellCitationIds"][3])
        self.assertIn("buying opportunity", row["evidenceTexts"][0])
        self.assertEqual(len(citations), 1)
        self.assertFalse(rows(sections, 1))

    def test_mention_negation_conditional_and_unqualified_add_are_not_directions(self):
        for text in ("ABC was mentioned in today's call.", "ABC is not a buying opportunity.", "If ABC falls, buy it.", "We could buy ABC.", "Add ABC", "ABC is discussed; BBB is a buying opportunity.", "ABC short-term results improved.", "ABC has short term volatility.", "ABC is a long-term investment.", "ABC is reducing costs.", "ABC is selling more merchandise.", "ABC is buying a software company.", "ABC sees bearish consumers but remains Long."):
            with self.subTest(text=text):
                sections, _ = self.build(research=daily(text))
                self.assertFalse(rows(sections, 0) or rows(sections, 1))

    def test_symbol_bound_prefix_buys_and_named_subject(self):
        for text in ("Buy ABC.", "Buying ABC", "ABC Incorporated (ABC) is a buying opportunity."):
            with self.subTest(text=text):
                self.assertEqual(len(rows(self.build(research=daily(text))[0], 0)), 1)

    def test_partial_sale_never_becomes_bearish_reversal_or_exit(self):
        sections, _ = self.build(research=daily("ABC: Sell some into strength; this is not an exit."))
        row = rows(sections, 1)[0]
        self.assertIn("Sell some", row["cells"][4])
        self.assertIn("partial Long reduction", row["cells"][5])
        self.assertNotIn("Bearish", row["cells"][4])
        self.assertNotIn("exit", row["cells"][5])

    def test_sell_and_exit_remain_distinct(self):
        for text, reading, why in (("Sell ABC", "Sell", "reports a Sell"), ("Exit ABC", "Exit Long", "explicitly exits")):
            with self.subTest(text=text):
                row = rows(self.build(research=daily(text))[0], 1)[0]
                self.assertTrue(row["cells"][4].startswith(reading + " ·"))
                self.assertIn(why, row["cells"][5])

    def test_partial_cover_targets_short_only_without_promoting_long(self):
        sections, _ = self.build(book=[holding(side="SHORT")], research=daily("Cover some ABC"))
        self.assertIn("partial Short cover", rows(sections, 1)[0]["cells"][5])
        sections, _ = self.build(research=daily("Cover some ABC"))
        self.assertFalse(rows(sections, 0) or rows(sections, 1))

    def test_source_add_short_is_not_bullish_or_a_false_contradiction(self):
        ref = reference(kind="etf_pro_change", value="ADD", excerpt="ADD ABC — Short — Financials", productId="etf-pro")
        sections, _ = self.build(book=[holding(side="SHORT")], intelligence={"bySymbol": {"ABC": {"directReferences": [ref]}}})
        self.assertIn("Added source Short", rows(sections, 0)[0]["cells"][4])
        self.assertFalse(rows(sections, 1))

    def test_clipped_action_excerpt_stays_in_evidence_not_why(self):
        excerpt = '…DT SELL SIGNAL - SHORTING ABC $17.40 No IDEA "why" this clipped email paragraph carries more text.'
        ref = reference(kind="real_time_alert", value="SHORT", excerpt=excerpt, productId="real-time-alert")
        sections, _ = self.build(book=[holding(side="SHORT")], intelligence={"bySymbol": {"ABC": {"directReferences": [ref]}}})
        row = rows(sections, 0)[0]
        self.assertEqual(row["cells"][-1], "Published Short action supports the held Short position.")
        self.assertIn(excerpt, row["evidenceTexts"])
        self.assertNotIn("17.40", row["cells"][-1])
        sections, _ = self.build(intelligence={"bySymbol": {"ABC": {"directReferences": [ref]}}})
        self.assertEqual(rows(sections, 1)[0]["cells"][-1], "Published Short action opposes the held Long position.")

    def test_remove_short_does_not_turn_into_bullish_or_full_cover(self):
        ref = reference(kind="etf_pro_change", value="REMOVE", excerpt="REMOVE ABC — Short — Financials", productId="etf-pro")
        sections, _ = self.build(book=[holding(side="SHORT")], intelligence={"bySymbol": {"ABC": {"directReferences": [ref]}}})
        why = rows(sections, 1)[0]["cells"][5]
        self.assertIn("Removed", why)
        self.assertNotIn("cover", why.lower())

    def test_bounded_positioning_support_is_not_trade_and_neutral_contamination_is_ignored(self):
        publication = daily("HEDGEYE POSITIONS\n\nLONGS: XYZ\n\nSHORTS: ABC\n\nNEUTRAL: MSFT\n\nSIGNAL DIVERGENCE\n\nCCC - Monitor LONG / Off Signal Strength")
        publication["snapshots"]["the-call"]["data"] = {"neutrals": ["MSFT", "SIGNAL", "CCC"], "longs": ["NOPE"]}
        sections, _ = self.build(book=[holding(side="SHORT"), holding("MSFT"), holding("CCC"), holding("NOPE")], research=publication)
        self.assertEqual([row["cells"][0] for row in rows(sections, 0)], ["ABC"])
        self.assertIn("Source Short position", rows(sections, 0)[0]["cells"][4])
        self.assertNotIn("Trade", rows(sections, 0)[0]["cells"][5])

    def test_multi_ticker_source_positioning_does_not_drop_later_rows(self):
        publication = daily("TL;DR - POSITIONS MENTIONED\n\nBEARISH: Long Treasuries (TLT, ZROZ), Germany (EWG), Switzerland (EWL), Mexico (EWW), High Yield (HYG), Qatar (QAT)\n\nMAIN SUMMARY\n\nLonger-term rates remain higher.", product="the-macro-show")
        symbols = ["TLT", "ZROZ", "EWG", "EWL", "EWW", "HYG", "QAT"]
        sections, _ = self.build(book=[holding(symbol, "SHORT") for symbol in symbols], research=publication)
        self.assertEqual({row["holding"] for row in rows(sections, 0)}, set(symbols))

    def test_direct_trade_break_takes_precedence_over_supportive_call(self):
        current = reference("trade", "BEARISH")
        sections, citations = self.build(research=daily("ABC: Good buying opportunity."), intelligence={"bySymbol": {"ABC": security([current])}})
        self.assertFalse(rows(sections, 0))
        row = rows(sections, 1)[0]
        self.assertIn("portfolio rule calls for exit", row["cells"][5])
        self.assertTrue(any(item["product"] == "the-call" for item in row["evidence"]))
        self.assertEqual(len(citations), 2)

    def test_trend_break_with_aligned_trade_caps_min(self):
        data = security([reference("trade"), reference("trend", "BEARISH")], [reference("trend", "BULLISH", "2026-09-25")])
        sections, _ = self.build(intelligence={"bySymbol": {"ABC": data}})
        row = rows(sections, 1)[0]
        self.assertIn("Bullish → Bearish Trend", row["cells"][4])
        self.assertIn("caps the position at MIN", row["cells"][5])
        self.assertGreaterEqual(len(row["citationIds"]), 3)

    def test_trend_conflict_without_trade_does_not_invent_exit(self):
        sections, _ = self.build(intelligence={"bySymbol": {"ABC": security([reference("trend", "BEARISH")])}})
        why = rows(sections, 1)[0]["cells"][5]
        self.assertNotIn("exit", why)
        self.assertNotIn("MIN", why)

    def test_repeated_transition_preserves_first_change_date(self):
        data = security([reference("trend", "BEARISH")], [reference("trend", "BEARISH", "2026-09-25"), reference("trend", "BULLISH", "2026-09-24")])
        sections, _ = self.build(intelligence={"bySymbol": {"ABC": data}})
        row = rows(sections, 1)[0]
        self.assertIn("Sep 25, 2026", row["cells"][4])
        self.assertEqual(row["evidence"][0]["lastConfirmedAt"], f"{DAY}T12:30:00Z")

    def test_historical_trade_retains_date_without_current_exit(self):
        data = security([reference("trade", "BEARISH", "2026-09-24")])
        sections, _ = self.build(intelligence={"bySymbol": {"ABC": data}})
        self.assertIn("Sep 24, 2026", rows(sections, 1)[0]["cells"][4])
        self.assertNotIn("calls for exit", rows(sections, 1)[0]["cells"][5])

    def test_midnight_import_placeholder_keeps_original_publication_day(self):
        ref = reference(publishedAt=f"{DAY}T00:00:00Z")
        sections, _ = self.build(intelligence={"bySymbol": {"ABC": security([ref])}})
        self.assertIn("Sep 28, 2026", rows(sections, 0)[0]["cells"][4])

    def test_future_unverified_or_missing_source_evidence_cannot_contribute(self):
        for patch_data in ({"marketDate": "2026-09-29", "publishedAt": "2026-09-29T13:00:00Z"}, {"qualityStatus": "failed"}, {"mock": True}, {"seeded": True}, {"sourceUrl": None, "sourceEventId": None}):
            with self.subTest(patch_data=patch_data):
                data = security([reference(**patch_data)])
                self.assertFalse(rows(self.build(intelligence={"bySymbol": {"ABC": data}})[0], 0))

    def test_trade_requires_independent_explicit_provenance(self):
        for patch_data in ({"signalProvenance": None}, {"signalProvenance": {"field": "trend", "method": "explicit-field", "sourceField": "trend", "sourceText": "Bullish"}}, {"kind": "position_mention"}):
            with self.subTest(patch_data=patch_data):
                data = security([reference("trade", **patch_data)])
                self.assertFalse(rows(self.build(intelligence={"bySymbol": {"ABC": data}})[0], 0))

    def test_no_proxy_inference_or_forged_source_alias(self):
        for patch_data in ({"sourceTicker": "XYZ"}, {"sourceTicker": None, "matchedText": "XYZ", "matchType": "direct_alias"}, {"sourceTicker": "ABC", "fieldPath": "data.XYZ.trend"}, {"matchType": "proxy"}):
            with self.subTest(patch_data=patch_data):
                data = security([reference(**patch_data)])
                self.assertFalse(rows(self.build(intelligence={"bySymbol": {"ABC": data}})[0], 0))

    def test_verified_proxy_is_labeled_without_exit_rule(self):
        proxy = reference("trade", "BEARISH", matchType="proxy", sourceTicker="XYZ", instrumentMapping={"verified": True, "heldTicker": "ABC", "sourceTicker": "XYZ", "relationship": "proxy", "sourceUrl": "https://issuer.example/proxy"})
        data = {"proxyReferences": [proxy]}
        sections, _ = self.build(intelligence={"bySymbol": {"ABC": data}})
        row = rows(sections, 1)[0]
        self.assertIn("XYZ proxy", row["cells"][4])
        self.assertNotIn("calls for exit", row["cells"][5])

    def test_ambiguous_same_time_direction_is_not_selected(self):
        data = security([reference(value="BULLISH"), reference(value="BEARISH")])
        sections, _ = self.build(intelligence={"bySymbol": {"ABC": data}})
        self.assertFalse(rows(sections, 0) or rows(sections, 1))

    def test_unavailable_holdings_missing_weight_and_invalid_holding_metadata(self):
        sections, _ = build_position_alignment_sections(None, {}, {}, as_of=CUTOFF)
        self.assertTrue(all(section["blocks"][0]["text"] == "Position comparison unavailable." for section in sections))
        sections, _ = self.build(book=[holding(weightPct=None)], research=daily("Buy ABC"))
        self.assertEqual(rows(sections, 0)[0]["cells"][2], "Long · —")
        for patch_data in ({"category": "option"}, {"secType": "OPT"}, {"mock": True}, {"seeded": True}, {"cacheOnly": True}, {"offline": True}, {"stale": True}, {"quantity": -10}):
            with self.subTest(patch_data=patch_data):
                self.assertFalse(rows(self.build(book=[holding(**patch_data)], research=daily("Buy ABC"))[0], 0))

    def test_research_keeps_working_without_executable_quotes_and_inputs_immutable(self):
        book, research, intelligence = [holding()], daily("Buy ABC", providerStatus="offline", fromCache=True), {"bySymbol": {"ABC": security([reference()])}}
        original = copy.deepcopy((book, research, intelligence))
        sections, _ = self.build(book, research, intelligence)
        self.assertTrue(rows(sections, 0))
        self.assertEqual((book, research, intelligence), original)
        self.assertNotIn("quote", str(sections).lower())

    def test_publication_preparation_runs_once_per_product_for_many_holdings(self):
        research = daily("HEDGEYE POSITIONS\n\nLONGS: ABC, DEF\n\nTOP 5 MOST ACTIONABLE\n\nABC: A buying opportunity.\n\nDEF: A buying opportunity.")
        research["snapshots"].update(daily("TL;DR - POSITIONS MENTIONED\n\nBULLISH: Alpha (ABC), Delta (DEF)", product="the-macro-show")["snapshots"])
        original = copy.deepcopy(research)
        with patch.object(alignment, "_citation", wraps=alignment._citation) as citation, \
                patch.object(alignment, "_article_sections", wraps=alignment._article_sections) as sections, \
                patch.object(alignment, "_bounded_positions", wraps=alignment._bounded_positions) as positions:
            report, _ = self.build(book=[holding("ABC"), holding("DEF"), holding("GHI")], research=research)
        self.assertEqual([citation.call_count, sections.call_count, positions.call_count], [2, 2, 2])
        self.assertEqual({row["holding"] for row in rows(report, 0)}, {"ABC", "DEF"})
        self.assertEqual(research, original)

    def test_tick_only_qualified_active_side_contributes_and_opposition_never_exits(self):
        tick = {"qualified": True, "status": "published", "value": "BEARISH", "publishedAt": CUTOFF, "sourceLabel": "ABC", "contribution": "Short", "metricsDate": DAY, "citationIds": ["tick"]}
        source = {"id": "tick", "product": "hedgai-signals", "productLabel": "HedgAI Signals", "publicationDate": DAY, "sourceUri": "https://source.example"}
        with patch("portfolio_position_alignment.portfolio_tick_readings", return_value=({"ABC": tick}, [source])):
            row = rows(self.build()[0], 1)[0]
            self.assertIn("shortest horizon", row["cells"][5])
            self.assertNotIn("exit", row["cells"][5])
        for patch_data in ({"status": "wait", "qualified": False}, {"qualified": False}, {"status": "historical"}):
            with self.subTest(patch_data=patch_data), patch("portfolio_position_alignment.portfolio_tick_readings", return_value=({"ABC": {**tick, **patch_data}}, [source])):
                sections, _ = self.build()
                self.assertFalse(rows(sections, 0) or rows(sections, 1))


if __name__ == "__main__":
    unittest.main()
