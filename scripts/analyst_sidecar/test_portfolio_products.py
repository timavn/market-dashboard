import copy
import unittest

from portfolio_brief import build_portfolio_brief, compact_portfolio_brief
from portfolio_products import portfolio_product_readings, with_captured_refresh_products
from test_portfolio_position_alignment import CUTOFF, DAY, daily, holding, reference, security
from test_portfolio_brief import metrics


def membership(kind="investing_idea_position", value=None, **extra):
    return {**reference(), "kind": kind, "value": value if value is not None else {"side": "LONG"},
            "productId": "investing-ideas", "productLabel": "Investing Ideas", **extra}


class PortfolioProductsTests(unittest.TestCase):
    def project(self, refs=None, research=None, **extra):
        return portfolio_product_readings([holding()], {"bySymbol": {"ABC": {
            "directReferences": refs or [], **extra}}}, research or {}, as_of=CUTOFF)["ABC"]

    def test_explicit_source_book_and_membership_do_not_manufacture_trade(self):
        products = self.project([membership(), membership("portfolio_solutions_rank", 12,
            productId="portfolio-solutions", productLabel="Portfolio Solutions")], daily("LONGS: ABC\n"))
        by_product = {item["product"]: item for item in products}
        self.assertEqual(by_product["the-call"]["reading"], "Source Long position")
        self.assertEqual(by_product["investing-ideas"]["reading"], "Source Long position")
        self.assertEqual(by_product["portfolio-solutions"]["reading"], "Rank #12")
        self.assertFalse(any(item["kind"] == "trade" for item in products))
        self.assertEqual(by_product["investing-ideas"]["date"], f"{DAY}T12:30:00Z")
        self.assertEqual(by_product["investing-ideas"]["citations"][0]["sourceUri"], "https://app.hedgeye.com/feed_items/12345")

    def test_preserves_partial_action_from_the_exact_report_instead_of_headline_sell(self):
        report = {"contentHash": "verified-body", "publicationDate": DAY,
                  "sourceUrl": "https://app.hedgeye.com/feed_items/12345", "bodyText": "Portfolio Managers should be selling-SOME of ABC."}
        ref = membership("real_time_alert", {"action": "sell", "side": "LONG"}, productId="real-time-alert",
                         productLabel="Real-Time Alerts", excerpt="ABC Sell Signal", sourceEvidence=report)
        products = self.project([ref])
        self.assertEqual([(item["kind"], item["reading"]) for item in products], [("action", "Sell some")])

    def test_only_latest_explicit_membership_retains_its_original_date(self):
        prior = membership(value={"side": "LONG"}, marketDate="2026-09-27", publishedAt="2026-09-27T12:00:00Z")
        current = membership(value={"side": "SHORT"})
        products = self.project([current], history=[{"directReferences": [prior]}])
        self.assertEqual([item["reading"] for item in products], ["Source Short position"])
        self.assertEqual(products[0]["date"], f"{DAY}T12:30:00Z")
        listed = self.project([membership("signal_strength_listed", "LISTED", productId="signal-strength")])
        self.assertEqual(listed[0]["reading"], "Listed")

    def test_rejects_unsupported_mentions_future_unverified_and_inferred_membership(self):
        for patch in ({"qualityStatus": "failed"}, {"mock": True}, {"fixture": True}, {"isSeeded": True},
                      {"matchType": "inferred"}, {"sourceTicker": "BBB"}, {"sourceUrl": None, "sourceEventId": None},
                      {"marketDate": "2026-09-29", "publishedAt": "2026-09-29T12:30:00Z"}):
            with self.subTest(patch=patch):
                self.assertEqual(self.project([membership(**patch)]), [])
        self.assertEqual(self.project(research=daily("ABC was mentioned during the call.")), [])
        self.assertEqual(self.project([membership("portfolio_solutions_rank", float("inf"))]), [])
        self.assertEqual(portfolio_product_readings([holding()], {}, {}, as_of=None), {})

    def test_dated_signals_retain_the_actual_source_instrument_and_verified_proxy(self):
        direct = reference(value="BEARISH")
        proxy = reference(value="BULLISH", productId="early-look", productLabel="Early Look",
                          matchType="proxy", sourceTicker="SPX", instrumentMapping={"verified": True,
                          "heldTicker": "ABC", "sourceTicker": "SPX", "relationship": "proxy", "sourceUrl": "https://issuer.example/map"})
        products = self.project([direct], proxyReferences=[proxy])
        self.assertEqual([item["reading"] for item in products], ["Bearish Trend", "Bullish Trend"])
        self.assertEqual(products[1]["sourceTicker"], "SPX")
        self.assertEqual(products[1]["relation"], "proxy")

    def test_capture_projection_and_compact_citations_never_mutate_or_refresh_publications(self):
        book = metrics()
        book["positions"][0]["symbol"] = "ABC"
        intelligence = {"coverage": {"state": "complete"}, "bySymbol": {"ABC": security([membership()])}}
        research = daily("LONGS: ABC\n")
        original = copy.deepcopy((book, intelligence, research))
        run = {"runId": "saved", "state": "succeeded", "createdAt": CUTOFF, "sections": [],
               "dependencies": {"dailyResearch": {"asOf": CUTOFF}}}
        brief = build_portfolio_brief(run, book, intelligence, daily_research=research)
        products = brief["holdings"][0]["productReadings"]
        self.assertEqual({item["product"] for item in products}, {"the-call", "investing-ideas"})
        self.assertEqual((book, intelligence, research), original)
        compact = compact_portfolio_brief(brief)
        self.assertEqual(compact["holdings"][0]["productReadings"][0]["reading"], products[0]["reading"])
        self.assertFalse(compact["holdings"][0]["productReadings"][0]["citations"][0]["evidenceIncluded"])
        self.assertTrue(products[0]["citations"][0].get("excerpt"))

    def test_archive_refresh_labels_survive_compact_brief_without_old_roster_sides(self):
        short_source = {"id": "cite_short", "product": "etf-pro", "publicationDate": "2026-09-22", "title": "ETF Pro"}
        long_source = {"id": "cite_long", "product": "etf-pro", "publicationDate": "2026-10-05", "title": "ETF Pro"}
        rank_source = {"id": "cite_rank", "product": "portfolio-solutions", "publicationDate": DAY, "title": "Portfolio Solutions"}
        report = {"citations": [short_source, long_source, rank_source], "holdings": [{"ticker": "ABC", "heldSide": "LONG", "evidence": [
            {"product": "etf-pro", "productLabel": "ETF Pro", "kind": "source-position", "relation": "direct",
             "reading": "Source Short position", "date": "2026-09-22", "lastConfirmedAt": "2026-09-22", "citationIds": ["cite_short"]},
            {"product": "etf-pro", "productLabel": "ETF Pro", "kind": "source-position", "relation": "direct",
             "reading": "Source Long position", "date": "2026-09-24", "lastConfirmedAt": "2026-10-05", "citationIds": ["cite_long"]},
            {"product": "portfolio-solutions", "kind": "rank", "reading": "Published rank 8", "date": DAY, "citationIds": ["cite_rank"]},
        ]}]}
        original = copy.deepcopy(report)
        rows = [{"holding": "ABC", "heldSide": "LONG", "productReadings": []}]
        with_captured_refresh_products(rows, report)
        self.assertEqual([item["reading"] for item in rows[0]["productReadings"]], ["Source Long position", "Rank #8"])
        self.assertEqual(rows[0]["productReadings"][0]["date"], "2026-09-24")
        self.assertEqual(rows[0]["productReadings"][0]["lastConfirmedAt"], "2026-10-05")
        self.assertEqual([source["id"] for source in rows[0]["productReadings"][0]["citations"]], ["cite_short", "cite_long"])
        self.assertEqual(rows[0]["productReadings"][1]["sourceTicker"], "ABC")
        self.assertEqual(rows[0]["productReadings"][1]["relation"], "direct")
        self.assertEqual(report, original)


if __name__ == "__main__":
    unittest.main()
