"""Cited Alpha Code thresholds remain source-bound, dated and complete."""

from copy import deepcopy
import unittest
from unittest.mock import patch

from alpha_codes import captured_alpha_codes, scan_alpha_codes


DAY = "2026-09-19"
CUTOFF = "2026-09-19T17:00:00Z"


def document(text, *, identity="source", day="2026-09-18", product="early-look", clock=None,
             metadata=None, chunks=None, **extra):
    citation = {"id": f"cite-{identity}", "documentId": identity, "publicationDate": day,
                "product": product, "sourceUri": f"gmail://message/{identity}", "title": identity,
                "excerpt": text, "contentHash": f"hash-{identity}"}
    return {"documentId": identity, "publicationDate": day, "product": product,
            "sourceUri": citation["sourceUri"], "title": identity, "contentHash": citation["contentHash"],
            "indexedAt": f"{day}T16:00:00Z", "metadata": {**({"publishedAt": clock} if clock else {}), **(metadata or {})},
            "chunks": chunks or [{"ordinal": 1, "excerpt": text, "citation": citation}], **extra}


class AlphaCodeTests(unittest.TestCase):
    def scan(self, *documents, cutoff=CUTOFF):
        return scan_alpha_codes(list(documents), DAY, as_of=cutoff)

    def pair(self, result, market):
        row = result["codes"][market]
        return row["tradeLevel"], row["trendLevel"]

    def test_complete_pair_retains_first_publication_through_repeats_and_isolated_updates(self):
        first = document("Gold's Alpha Code = 4395/4251.", identity="first", day="2026-09-15")
        repeated = document("Gold TRADE = 4395, TREND = 4251.", identity="repeat", day="2026-09-16")
        isolated = document("Gold's TRADE Signal Level = 4410.", identity="isolated", day="2026-09-18")
        result = self.scan(isolated, repeated, first)
        self.assertEqual(self.pair(result, "gold"), (4395, 4251))
        self.assertEqual(result["codes"]["gold"]["publicationDate"], "2026-09-15")
        self.assertEqual(result["codes"]["gold"]["citationIds"], ["cite-first"])

    def test_new_complete_pair_replaces_old_pair_and_repeat_does_not_redate_it(self):
        result = self.scan(
            document("Gold TRADE = 4395, TREND = 4251.", identity="first", day="2026-09-15"),
            document("Gold TRADE = 4400, TREND = 4300.", identity="changed", day="2026-09-16"),
            document("Gold TRADE = 4400, TREND = 4300.", identity="repeated", day="2026-09-18"),
        )
        self.assertEqual(self.pair(result, "gold"), (4400, 4300))
        self.assertEqual(result["codes"]["gold"]["publicationDate"], "2026-09-16")

    def test_unknown_same_day_conflicts_are_not_resolved_by_input_order(self):
        first = document("Gold TRADE = 100, TREND = 90.", identity="a")
        second = document("Gold TRADE = 110, TREND = 95.", identity="z")
        prior = document("Gold TRADE = 95, TREND = 85.", identity="prior", day="2026-09-17")
        for sources in ((prior, first, second), (second, first, prior)):
            self.assertNotIn("gold", self.scan(*sources)["codes"])

    def test_verified_same_day_clock_resolves_changed_pair_but_equal_clock_conflict_does_not(self):
        first = document("Gold TRADE = 100, TREND = 90.", identity="a", clock="2026-09-18T12:00:00Z")
        newer = document("Gold TRADE = 110, TREND = 95.", identity="z", clock="2026-09-18T13:00:00Z")
        self.assertEqual(self.pair(self.scan(newer, first), "gold"), (110, 95))
        newer["metadata"]["publishedAt"] = first["metadata"]["publishedAt"]
        self.assertNotIn("gold", self.scan(first, newer)["codes"])

    def test_explicit_roster_header_can_precede_levels_in_earlier_chunk(self):
        header = document("Alpha Codes: TRADE first, then TREND.")
        header["chunks"].append({"ordinal": 2, "excerpt": "SPX = 7651/7501\n\nQQQ = 721/705",
                                "citation": {**header["chunks"][0]["citation"], "id": "cite-levels"}})
        result = self.scan(header)
        self.assertEqual(self.pair(result, "sp500"), (7651, 7501))
        self.assertEqual(result["codes"]["sp500"]["citationIds"], ["cite-levels"])
        self.assertEqual(set(result["codes"]), {"sp500"})

    def test_packed_codes_require_explicit_labeled_expansion(self):
        self.assertEqual(self.scan(document("Silver's Alpha Code = 6564."))["codes"], {})
        result = self.scan(document("Silver’s Alpha Code = 6564 (TRADE $65, TREND $64)."))
        self.assertEqual(self.pair(result, "silver"), (65, 64))

    def test_alpha_prefix_before_instrument_and_explicit_pair_order(self):
        for text in ("Alpha Code for SPX: 7651/7501.", "SPX TRADE/TREND = 7651/7501."):
            with self.subTest(text=text):
                self.assertEqual(self.pair(self.scan(document(text)), "sp500"), (7651, 7501))
        reverse = self.scan(document("SPX TREND/TRADE = 7501/7651."))
        self.assertEqual(self.pair(reverse, "sp500"), (7651, 7501))

    def test_bitcoin_shorthand_requires_explicit_units_and_full_expansion_wins(self):
        self.assertEqual(self.scan(document("Bitcoin's Alpha Code was 64/68."))["codes"], {})
        source = "Bitcoin’s Alpha Code was given as 64/68: approximately $64,000 TRADE and $68,000 TREND."
        result = self.scan(document(source))
        self.assertEqual(self.pair(result, "bitcoin"), (64000, 68000))
        self.assertTrue(result["codes"]["bitcoin"]["approximate"])
        self.assertEqual(self.pair(self.scan(document("BTC TRADE $64k and TREND $68k.")), "bitcoin"), (64000, 68000))

    def test_ethereum_respectively_uses_explicit_label_order(self):
        result = self.scan(document("Ethereum is holding both TRADE and TREND Signal Supports this morning of $4076 and $3604, respectively."))
        self.assertEqual(self.pair(result, "ethereum"), (4076, 3604))
        reverse = self.scan(document("ETH TREND and TRADE supports are $3604 and $4076, respectively."))
        self.assertEqual(self.pair(reverse, "ethereum"), (4076, 3604))

    def test_adjacent_label_matches_cannot_reuse_one_number_for_both_thresholds(self):
        for text in (
            "Gold TRADE 4395 TREND 4251.",
            "Gold\nTRADE 4395\nTREND 4251.",
            "Gold 4395 TRADE 4251 TREND.",
            "Gold 4395 TRADE\n4251 TREND.",
            "Gold TREND 4251 TRADE 4395.",
            "Gold 4251 TREND 4395 TRADE.",
        ):
            with self.subTest(text=text):
                self.assertEqual(self.pair(self.scan(document(text)), "gold"), (4395, 4251))

    def test_hypothetical_and_retrospective_pairs_do_not_replace_published_thresholds(self):
        prior = document("Gold TRADE 4334 and TREND 4251.", identity="published", day="2026-09-17")
        for text in (
            "Gold hypothetical TRADE 4500 and TREND 4300.",
            "Gold TRADE 4500 and TREND 4300 are hypothetical levels, not current thresholds.",
            "Gold TRADE 4395 and TREND 4251 last week; the new code is still pending.",
        ):
            with self.subTest(text=text):
                result = self.scan(prior, document(text))
                self.assertEqual(self.pair(result, "gold"), (4334, 4251))
                self.assertEqual(result["codes"]["gold"]["publicationDate"], "2026-09-17")
        current = self.scan(prior, document("Gold TRADE 4395 and TREND 4251. Last week was volatile."))
        self.assertEqual(self.pair(current, "gold"), (4395, 4251))

    def test_labeled_prose_without_alpha_literal_can_supply_newer_complete_pair(self):
        result = self.scan(
            document("Gold's Alpha Code = 4395/4251.", identity="prior", day="2026-09-15"),
            document("Gold was bouncing. The immediate TRADE level cited was 4,334, with TREND at 4,251.",
                     identity="newer", day="2026-09-17", product="the-macro-show"),
            document("Bitcoin: approximately $75,000 representing TRADE and $70,000 representing TREND.",
                     identity="bitcoin", day="2026-09-10", product="the-macro-show"),
        )
        self.assertEqual(self.pair(result, "gold"), (4334, 4251))
        self.assertEqual(result["codes"]["gold"]["publicationDate"], "2026-09-17")
        self.assertEqual(self.pair(result, "bitcoin"), (75000, 70000))
        self.assertTrue(result["codes"]["bitcoin"]["approximate"])

    def test_published_asset_binding_excludes_etfs_and_different_assets_in_same_paragraph(self):
        source = "Gold TRADE = 4395, TREND = 4251. Silver TRADE = 65. Bitcoin TREND = 70000."
        result = self.scan(document(source))
        self.assertEqual(set(result["codes"]), {"gold"})
        for text in ("GLD TRADE = 4395, TREND = 4251.", "Gold (GLD) TRADE = 4395, TREND = 4251.",
                     "SPY Alpha Code = 7651/7501.", "IBIT TRADE = 64000, TREND = 68000.",
                     "ETHA TRADE = 4076, TREND = 3604."):
            with self.subTest(text=text):
                self.assertEqual(self.scan(document(text))["codes"], {})

    def test_risk_range_buy_sell_and_ordinary_prices_are_not_alpha_thresholds(self):
        for text in ("Gold BUY TRADE = 4229, SELL TRADE = 4399. TREND Bullish.",
                     "Gold's Risk Range = 4229/4399.", "Gold BUY TRADE = 4229, TREND = 4251.",
                     "Gold last price 4395; day low 4251. Trade and Trend bullish."):
            with self.subTest(text=text):
                self.assertEqual(self.scan(document(text))["codes"], {})

    def test_missing_invalid_future_and_unsafe_publication_evidence_is_excluded(self):
        changes = [{"publicationDate": "2026-09-20"}, {"publicationDate": "invalid"},
                   {"sourceUri": "mock://research"}, {"documentId": ""}, {"indexedAt": "2026-09-19T17:00:01Z"},
                   {"metadata": {"publishedAt": "2026-09-19T17:00:01Z"}},
                   {"metadata": {"observedAt": "2026-09-19T17:00:01Z"}},
                   {"metadata": {"publishedAt": "2026-09-18"}},
                   *({"metadata": {key: True}} for key in ("mock", "seeded", "modelOnly", "refreshFailed")),
                   {"metadata": {"lifecycleStage": "ERROR"}}, {"metadata": {"status": "failed"}}]
        for change in changes:
            with self.subTest(change=change):
                source = document("Gold TRADE = 4395, TREND = 4251.")
                source.update(change)
                self.assertEqual(self.scan(source)["codes"], {})

    def test_citation_publication_identity_and_cutoff_cannot_disagree_with_document(self):
        for change in ({"publicationDate": "2026-09-20"}, {"documentId": "another-document"},
                       {"sourceUri": "gmail://message/another"}):
            with self.subTest(change=change):
                source = document("Gold TRADE = 4395, TREND = 4251.")
                source["chunks"][0]["citation"].update(change)
                self.assertEqual(self.scan(source)["codes"], {})

    def test_scan_never_mutates_sources_and_keeps_original_citation_evidence(self):
        source = document("Gold TRADE = 4395, TREND = 4251.")
        original = deepcopy(source)
        result = self.scan(source)
        self.assertEqual(source, original)
        self.assertEqual(result["citations"], [original["chunks"][0]["citation"]])
        self.assertNotIn("direction", result["codes"]["gold"])

    def test_saved_snapshot_fallback_only_uses_original_captured_publications(self):
        original = {"date": "2026-09-18", "snapshots": {"early-look": {
            "snapshotType": "early-look", "date": "2026-09-15", "source": "gmail",
            "publishedAt": "2026-09-15T12:00:00Z", "article": {
                "headline": "Gold thresholds", "feedUrl": "https://app.hedgeye.com/feed_items/gold",
                "bodyText": "Gold TRADE = 4395, TREND = 4251.",
            },
        }}}
        source = deepcopy(original)
        with patch("index.ResearchIndex.alpha_code_documents", side_effect=AssertionError("No current index reads")):
            result = captured_alpha_codes(source, as_of=CUTOFF)
        self.assertEqual(self.pair(result, "gold"), (4395, 4251))
        self.assertEqual(result["codes"]["gold"]["publicationDate"], "2026-09-15")
        self.assertEqual(source, original)
        source["snapshots"]["early-look"]["publishedAt"] = "2026-09-19T17:00:01Z"
        self.assertEqual(captured_alpha_codes(source, as_of=CUTOFF)["codes"], {})

    def test_saved_scan_must_precede_requested_capture(self):
        result = self.scan(document("Gold TRADE = 4395, TREND = 4251."))
        self.assertEqual(captured_alpha_codes({"alphaCodes": result}, as_of=CUTOFF), result)
        self.assertEqual(captured_alpha_codes({"alphaCodes": result}, as_of="2026-09-19T16:59:59Z"), {})


if __name__ == "__main__":
    unittest.main()
