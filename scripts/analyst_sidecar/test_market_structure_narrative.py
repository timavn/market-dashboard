import copy
import unittest

from market_structure_narrative import narrative_blocks


def snapshot(*paragraphs):
    return {"data": {"blocks": [{"type": "paragraph", "text": text} for text in paragraphs]}}


def body(source):
    return "\n".join(block["text"] for block in narrative_blocks(source))


class MarketStructureNarrativeTests(unittest.TestCase):
    def test_keeps_opposing_cta_conditions_and_negations_together(self):
        scenarios = ("CTA exposure has declined. If momentum weakens, funds may add selling pressure. "
                     "Conversely, if momentum strengthens, CTAs could add demand. "
                     "This does not establish a directional forecast.")
        source = snapshot("SPX gamma is neutral after expiration.", scenarios)
        text = body(source)
        self.assertIn(scenarios, text)
        self.assertNotIn("remains", text)
        self.assertEqual([row["title"] for row in narrative_blocks(source)], ["Interpretation", "Flows to watch"])

    def test_preserves_alternative_outcomes_across_paragraphs(self):
        source = snapshot("If momentum weakens, CTAs may sell.",
                          "Conversely, if momentum strengthens, CTAs may buy.")
        self.assertIn("If momentum weakens, CTAs may sell. Conversely, if momentum strengthens, CTAs may buy.", body(source))

    def test_over_budget_condition_pair_is_omitted_as_a_whole(self):
        large = "If momentum weakens, CTAs may sell " + "additional exposure " * 70 + "."
        source = snapshot(large, "Conversely, if momentum strengthens, CTAs may buy.",
                          "Systematic exposure is low.")
        text = body(source)
        self.assertNotIn("CTAs may sell", text)
        self.assertNotIn("CTAs may buy", text)
        self.assertIn("Systematic exposure is low.", text)

    def test_source_levels_and_percentages_are_preserved_without_current_math(self):
        source = snapshot("SPX is in neutral gamma territory.",
                          "The chart provides a range. The lower band is 7500, indicating roughly -2% downside, "
                          "while the upper band is 7730, indicating 1% upside.")
        text = body(source)
        self.assertIn("7500, indicating roughly -2% downside", text)
        self.assertIn("7730, indicating 1% upside", text)
        self.assertNotIn("2:1", text)

    def test_unknown_body_format_retains_complete_prose_without_invented_context(self):
        source = {"article": {"bodyText": "The balance of supply and demand has shifted.\n\nLiquidity is improving."}}
        self.assertIn("The balance of supply and demand has shifted.", body(source))
        self.assertIn("Liquidity is improving.", body(source))
        self.assertNotIn("Flows to watch", body(source))
        self.assertNotIn("gamma", body(source).lower())

    def test_uses_ordered_blocks_instead_of_conflicting_body_fallback(self):
        source = snapshot("Gamma is positive.")
        source["article"] = {"bodyText": "Gamma is negative."}
        self.assertIn("Gamma is positive.", body(source))
        self.assertNotIn("negative", body(source))

    def test_missing_or_malformed_prose_adds_no_generic_commentary(self):
        for source in (None, {}, {"data": {"blocks": "invalid"}},
                       {"data": {"signals": [{"label": "Gamma", "value": "Neutral"}]}},
                       snapshot("An unfinished source fragment")):
            with self.subTest(source=source):
                self.assertEqual(narrative_blocks(source), [])

    def test_is_deterministic_and_does_not_mutate_captured_research(self):
        source = snapshot("Gamma is negative. Lower support is 7200.", "CTAs are reducing exposure.")
        before = copy.deepcopy(source)
        self.assertEqual(narrative_blocks(source), narrative_blocks(source))
        self.assertEqual(source, before)
        newer = snapshot("Gamma is positive. Upper resistance is 7800.", "CTAs are adding exposure.")
        self.assertNotEqual(body(source), body(newer))
        self.assertNotIn("7800", body(source))

    def test_compact_selection_keeps_source_sentences_and_skips_dependent_fragments(self):
        paragraphs = [
            "SPX is in neutral territory. Monthly expiration reduced gamma positioning, making supply and demand more influential.",
            "The bands describe near-term outcomes. The lower band implies -2% downside and the upper band implies 1% upside. "
            "Overall, this is a broad window of outcomes.",
            "Systematic flows have been mixed, with volatility-control inflows and moderate CTA selling.",
            "CTA exposure has declined. This could increase selling if momentum weakens. "
            "Conversely, if momentum strengthens, CTAs would add demand.",
        ]
        source = snapshot(*paragraphs)
        result = narrative_blocks(source)
        self.assertLessEqual(sum(len(row["text"].split()) for row in result), 240)
        for block in result:
            self.assertTrue(block["text"].endswith("."))
        self.assertIn(paragraphs[-1], body(source))


if __name__ == "__main__":
    unittest.main()
