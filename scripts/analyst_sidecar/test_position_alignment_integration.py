"""Captured holdings comparisons stay consistent across chat and export."""
import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from portfolio_brief import build_portfolio_brief, with_position_alignment
from portfolio_capture import project_portfolio_context
from portfolio_review import portfolio_metrics
from review_runs_v2 import ReviewRunV2Store, public_review_run


CUTOFF = "2026-09-28T21:00:00Z"


def capture():
    return {"liveVerified": True, "freshness": "live", "asOf": CUTOFF,
            "data": {"positions": [{"account": "test", "symbol": "AAPL", "longName": "Apple Inc.",
                "secType": "STK", "instrumentCategory": "other", "quantity": 10, "currency": "USD",
                "marketValue": 3180, "valuationPrice": 318, "currentValuesLiveVerified": True,
                "markStatus": "fresh_live_ibkr", "valuationBasis": "live_ibkr"}],
                "accountSummaries": [{"account": "test", "summary": {"NetLiquidation": {"value": 100000}}}]}}


def intelligence():
    return {"coverage": {"state": "complete"}, "bySymbol": {"AAPL": {
        "decision": {"trend": {"status": "available", "value": "BULLISH", "sourceId": "risk-ranges"}},
        "directReferences": [{"kind": "primary_risk_range", "productId": "risk-ranges", "productLabel": "Risk Ranges",
            "marketDate": "2026-09-28", "publishedAt": "2026-09-28T12:00:00Z", "qualityStatus": "indexed",
            "matchType": "direct", "sourceTicker": "AAPL", "sourceEventId": "original-rr",
            "sourceUrl": "https://app.hedgeye.com/feed_items/example-original", "value": {"trend": "BULLISH"}}]}}}


def rollup():
    return {"version": 1, "sections": [{"id": "existing-research", "title": "Existing research",
            "blocks": [{"type": "paragraph", "text": "Captured publication"}]}], "citations": [], "securityTickers": []}


def rows(projected, section_id="position-confirmations"):
    section = next(s for s in projected["sections"] if s["id"] == section_id)
    return [r for block in section["blocks"] for r in block.get("rows", [])]


class PositionAlignmentIntegrationTests(unittest.TestCase):
    def test_shared_projection_is_idempotent_and_preserves_position_names(self):
        raw = capture()
        original = copy.deepcopy(raw)
        projected = project_portfolio_context(raw)
        self.assertEqual(raw, original)
        self.assertEqual(project_portfolio_context(projected), projected)
        self.assertEqual(portfolio_metrics(projected)["positions"][0]["securityName"], "Apple Inc.")

    def test_tables_are_last_and_names_product_weight_and_why_are_captured(self):
        original = rollup()
        result = with_position_alignment(original, portfolio_metrics(project_portfolio_context(capture())), intelligence(),
                                         {"date": "2026-09-28"}, as_of=CUTOFF)
        self.assertEqual([s["id"] for s in result["sections"]][-2:], ["position-confirmations", "position-contradictions"])
        self.assertEqual(original, rollup())
        row = rows(result)[0]
        self.assertEqual(row["cells"][:4], ["AAPL", "Apple Inc.", "Long · 3.18%", "Risk Ranges"])
        self.assertTrue(row["cells"][-1])
        self.assertTrue(row["cellCitationIds"][3])
        self.assertEqual(result["sections"][-2]["blocks"][0]["columns"][-1], "Why")

    def test_options_do_not_enlarge_underlying_stock_weight(self):
        raw = capture()
        raw["data"]["positions"].insert(0, {**raw["data"]["positions"][0], "secType": "OPT", "marketValue": 50000})
        result = with_position_alignment(rollup(), portfolio_metrics(project_portfolio_context(raw)), intelligence(),
                                         {"date": "2026-09-28"}, as_of=CUTOFF)
        self.assertEqual(rows(result)[0]["cells"][2], "Long · 3.18%")

    def test_unverified_books_never_create_position_comparisons(self):
        for patch in ({"liveVerified": False}, {"freshness": "stale"}, {"freshness": "cache-only"},
                      {"status": "offline"}, {"mock": True}, {"seeded": True}):
            with self.subTest(patch=patch):
                metrics = portfolio_metrics(project_portfolio_context({**capture(), **patch}))
                result = with_position_alignment(rollup(), metrics, intelligence(), {}, as_of=CUTOFF)
                self.assertEqual(rows(result), [])
                self.assertEqual(rows(result, "position-contradictions"), [])
                self.assertIn("unavailable", str(result["sections"][-2:]).lower())

    def test_missing_mark_keeps_position_direction_without_inventing_weight(self):
        raw = capture()
        raw["data"]["positions"][0]["currentValuesLiveVerified"] = False
        result = with_position_alignment(rollup(), portfolio_metrics(project_portfolio_context(raw)), intelligence(),
                                         {"date": "2026-09-28"}, as_of=CUTOFF)
        self.assertEqual(rows(result)[0]["cells"][2], "Long · —")

    def test_saved_chat_and_export_use_their_own_capture_without_database_rewrite(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ReviewRunV2Store(Path(directory) / "reviews.sqlite3")
            run, _ = store.create(review_kind="portfolio-review", conversation_id="original", request_id="original")
            captured = {"portfolio": capture(), "heldResearchEvents": intelligence(), "dailyResearch": {"date": "2026-09-28"}}
            fingerprints = {key: store.store_evidence(key, value)[0] for key, value in captured.items()}
            store.update(run["runId"], state="succeeded", outcome="partial", reportMarkdown="Original report",
                sourceFingerprints=fingerprints, dependencies={key: {"fingerprint": value, "asOf": CUTOFF} for key, value in fingerprints.items()},
                sections=[{"id": "portfolio-research-review", "dailyRollup": rollup()}])
            with store.connect() as db:
                before = tuple(db.execute("SELECT * FROM analyst_review_runs_v2 WHERE run_id=?", (run["runId"],)).fetchone())
            later = intelligence()
            later["bySymbol"]["AAPL"]["directReferences"][0]["value"]["trend"] = "BEARISH"
            store.store_evidence("heldResearchEvents", later)
            saved = store.get(run["runId"])
            with patch("portfolio_position_alignment.build_position_alignment_sections", side_effect=AssertionError("unchanged capture should reuse projection")):
                memoized = store.get(run["runId"])
            self.assertEqual(saved["sections"], memoized["sections"])
            memoized["sections"][0]["dailyRollup"]["sections"][-2]["blocks"][0]["rows"][0]["cells"][1] = "Changed response only"
            self.assertEqual(rows(store.get(run["runId"])["sections"][0]["dailyRollup"])[0]["cells"][1], "Apple Inc.")
            brief = build_portfolio_brief(saved, portfolio_metrics(project_portfolio_context(store.read_evidence(saved, "portfolio"))),
                store.read_evidence(saved, "heldResearchEvents"), daily_research=store.read_evidence(saved, "dailyResearch"))
            # Portfolio Review no longer shows the position-alignment sections.
            self.assertFalse({"position-confirmations", "position-contradictions"}
                             & {section["id"] for section in brief["dailyRollup"]["sections"]})
            exported = public_review_run(saved)["reportMarkdown"]
            self.assertIn("Ticker | Security | Position | Product | Reading | Why", exported)
            self.assertLess(exported.index("Position confirmations"), exported.index("Position contradictions"))
            self.assertEqual(saved["reportMarkdown"], "Original report")
            self.assertEqual(saved["sourceFingerprints"], fingerprints)
            with store.connect() as db:
                after = tuple(db.execute("SELECT * FROM analyst_review_runs_v2 WHERE run_id=?", (run["runId"],)).fetchone())
            self.assertEqual(before, after)
            with store.connect() as db:
                db.execute("UPDATE analyst_review_evidence_v2 SET payload_json='{}' WHERE fingerprint=?", (fingerprints["heldResearchEvents"],))
            self.assertIsNone(store.read_evidence(saved, "heldResearchEvents"))
            damaged = store.get(run["runId"])
            self.assertEqual(rows(damaged["sections"][0]["dailyRollup"]), [])


if __name__ == "__main__":
    unittest.main()
