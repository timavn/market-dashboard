"""Alpha-code projections use only the publications captured with each review."""

from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from alpha_codes import scan_alpha_codes
from prediction_research_rollup import build_prediction_research_rollup
from review_runs_v2 import ReviewRunV2Store, attach_prediction_reports, public_review_run


CAPTURED = "2026-09-19T17:00:00Z"
LATER = "2026-09-19T18:00:00Z"
MARKET_DAY = "2026-09-18"
MARKETS = ("cpi", "sp500", "gold", "silver", "bitcoin", "ethereum")


def document(identifier="alpha-old", *, text="SPX Trade 7,651 and Trend 7,501.", day="2026-09-17", indexed_at=None):
    citation = {"id": f"cite_{identifier}", "documentId": f"doc_{identifier}", "product": "early-look",
                "productLabel": "Early Look", "publicationDate": day,
                "sourceUri": f"https://app.hedgeye.com/feed_items/{identifier}", "excerpt": text}
    return {**citation, "indexedAt": indexed_at or day + "T16:00:00Z",
            "metadata": {"publishedAt": day + "T15:00:00Z"},
            "chunks": [{"excerpt": text, "citation": citation}]}


def captured_scan(documents=None, *, as_of=CAPTURED):
    return {"date": MARKET_DAY, "snapshots": {}, "previousSnapshots": {},
            "alphaCodes": scan_alpha_codes(documents or [document()], MARKET_DAY, as_of=as_of)}


def publication(day, text, **extra):
    return {"snapshotType": "early-look", "date": day, "source": "gmail-html",
            "publishedAt": day + "T15:00:00Z",
            "article": {"headline": "Early Look", "feedUrl": f"https://app.hedgeye.com/feed_items/{day}", "bodyText": text},
            "data": {}, **extra}


def sections():
    return [{"id": "monitored-markets", "markets": [
        {"marketId": market, "asset": "S&P 500" if market == "sp500" else market.title(),
         "venue": "ForecastEx" if market in {"cpi", "sp500"} else "Kalshi",
         "identity": f"original-{market}-contract", "fields": [["Quotes observed", CAPTURED]],
         "managerView": {"version": 1}, "research": {"sections": [], "citationIds": []}}
        for market in MARKETS
    ]}]


class PredictionAlphaIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="prediction-alpha-integration-")
        self.addCleanup(self.temp.cleanup)
        self.store = ReviewRunV2Store(Path(self.temp.name) / "reviews.sqlite3")
        self.sequence = 0

    def save(self, evidence, *, cutoff=CAPTURED):
        self.sequence += 1
        run, _ = self.store.create(review_kind="prediction-markets-review", conversation_id="alpha-conversation",
                                   request_id=f"request-{self.sequence}")
        fingerprint, _ = self.store.store_evidence("predictionResearch", evidence)
        self.store.update(run["runId"], state="succeeded", phase="terminal", outcome="partial", completedAt=cutoff,
                          sections=sections(), reportMarkdown="Original stored report", summaryMarkdown="Original stored summary",
                          dependencies={"predictionResearch": {"fingerprint": fingerprint, "asOf": cutoff, "status": "ready"}},
                          sourceFingerprints={"predictionResearch": fingerprint})
        return run["runId"]

    def database_contents(self):
        with self.store.connect() as connection:
            return {table: [tuple(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY rowid")]
                    for table in ("analyst_review_runs_v2", "analyst_review_evidence_v2")}

    def test_captured_scan_and_citation_attach_only_to_the_exact_market(self):
        evidence = captured_scan()
        original = deepcopy(evidence)
        result = build_prediction_research_rollup(evidence, as_of=CAPTURED)
        code = result["markets"]["sp500"]["alphaCode"]
        self.assertEqual((code["tradeLevel"], code["trendLevel"]), (7651, 7501))
        self.assertEqual(code["publicationDate"], "2026-09-17")
        self.assertEqual(code["citationIds"], ["cite_alpha-old"])
        self.assertEqual(result["markets"]["sp500"]["citationIds"], ["cite_alpha-old"])
        self.assertEqual({row["id"] for row in result["citations"]}, {"cite_alpha-old"})
        for market in set(MARKETS) - {"sp500"}:
            self.assertNotIn("alphaCode", result["markets"][market])
            self.assertNotIn("cite_alpha-old", result["markets"][market]["citationIds"])
        self.assertEqual(evidence, original)

    def test_saved_fingerprint_keeps_its_original_pair_after_a_new_scan_exists(self):
        old_source = captured_scan()
        old_id = self.save(old_source)
        original_run = self.store.get(old_id)
        later_document = document("alpha-new", text="SPX Trade 7,666 and Trend 7,444.", day=MARKET_DAY,
                                  indexed_at="2026-09-19T17:30:00Z")
        self.assertEqual(scan_alpha_codes([later_document], MARKET_DAY, as_of=CAPTURED)["codes"], {})
        new_source = captured_scan([document(), later_document], as_of=LATER)
        new_id = self.save(new_source, cutoff=LATER)
        before = self.database_contents()
        with patch("alpha_codes.scan_alpha_codes", side_effect=AssertionError("Saved scan must not consult a new index")):
            old_run, new_run = self.store.get(old_id), self.store.get(new_id)
            old_report, new_report = public_review_run(old_run)["reportMarkdown"], public_review_run(new_run)["reportMarkdown"]
            conversation = {"id": "alpha-conversation", "kind": "prediction-markets-review", "messages": [
                {"role": "assistant", "reviewRunId": old_id, "text": "Stored workspace report", "citations": []}
            ]}
            projected = attach_prediction_reports(conversation, self.store)
        self.assertIn("Trade 7,651 · Trend 7,501", old_report)
        self.assertNotIn("7,666", old_report)
        self.assertIn("Trade 7,666 · Trend 7,444", new_report)
        self.assertIn("Trade 7,651 · Trend 7,501", projected["messages"][0]["text"])
        self.assertTrue(any(row["id"] == "cite_alpha-old" for row in projected["messages"][0]["citations"]))
        self.assertEqual(conversation["messages"][0]["text"], "Stored workspace report")
        self.assertEqual(old_run, original_run)
        self.assertEqual(old_run["reportMarkdown"], "Original stored report")
        for expected, actual in zip(sections()[0]["markets"], old_run["sections"][0]["markets"]):
            self.assertEqual({key: value for key, value in actual.items() if key != "research"},
                             {key: value for key, value in expected.items() if key != "research"})
        self.assertEqual(self.store.read_evidence(old_run, "predictionResearch"), old_source)
        self.assertEqual(self.database_contents(), before)

    def test_legacy_fallback_scans_only_dated_publications_inside_that_capture(self):
        evidence = {"date": MARKET_DAY,
            "previousSnapshots": {"early-look": publication("2026-09-17", "SPX Trade 7,651 and Trend 7,501.")},
            "snapshots": {
                "early-look": publication(MARKET_DAY, "SPX Trade 7,688. SPY Trade 500 and Trend 450."),
                "macro-show": publication("2026-09-20", "SPX Trade 8,000 and Trend 7,999."),
                "the-call": publication(MARKET_DAY, "Gold Trade 4,001 and Trend 3,950.", mock=True),
            }}
        run_id = self.save(evidence)
        before = self.database_contents()
        self.store._saved_prediction_projections.clear()
        with patch("alpha_codes.scan_alpha_codes", wraps=scan_alpha_codes) as scan:
            run = self.store.get(run_id)
        scanned = scan.call_args.args[0]
        self.assertEqual([doc["publicationDate"] for doc in scanned], ["2026-09-17", MARKET_DAY])
        self.assertNotIn("8,000", str(scanned))
        self.assertNotIn("4,001", str(scanned))
        market = next(row for row in run["sections"][0]["markets"] if row["marketId"] == "sp500")
        self.assertEqual(market["research"]["alphaCode"]["publicationDate"], "2026-09-17")
        self.assertEqual(market["research"]["alphaCode"]["tradeLevel"], 7651)
        report = public_review_run(run)["reportMarkdown"]
        self.assertIn("Trade 7,651 · Trend 7,501 · Sep 17, 2026", report)
        self.assertEqual(report.count("**Alpha codes:** —"), 5)
        self.assertEqual(self.database_contents(), before)

    def test_capture_rejects_a_later_scan_without_borrowing_other_available_pairs(self):
        evidence = captured_scan(as_of=LATER)
        evidence["previousSnapshots"] = {"early-look": publication("2026-09-17", "SPX Trade 7,651 and Trend 7,501.")}
        result = build_prediction_research_rollup(evidence, as_of=CAPTURED)
        self.assertTrue(all("alphaCode" not in market for market in result["markets"].values()))


if __name__ == "__main__":
    unittest.main()
