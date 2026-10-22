import copy
import json
import unittest

from analyst_review_sources import document_source_times, review_sources
from pathlib import Path


AT = "2026-09-17T18:00:00Z"
PRODUCTS = [{"id": "risk-ranges", "label": "Risk Ranges"}, {"id": "early-look", "label": "Early Look"}]
UNIVERSE = [("gold", "Gold", "kalshi"), ("silver", "Silver", "forecastex")]


class Store:
    def __init__(self, evidence):
        self.evidence = evidence

    def read_evidence(self, run, name):
        return self.evidence.get(name)


def checkpoint(status="ready", **changes):
    return {"status": status, "asOf": AT, "updatedAt": AT, "fingerprint": "verified-evidence-hash", "detail": {"liveVerified": True}, **changes}


def run(kind, dependencies=None, **changes):
    return {"runId": "run-1", "conversationId": "conversation-1", "reviewKind": kind,
            "state": "succeeded", "updatedAt": AT, "dependencies": dependencies or {}, **changes}


def research():
    return {
        "researchCoverage": {"products": [{"product": "risk-ranges", "status": "available", "latestPublicationDate": "2026-09-17", "indexedAt": AT}]},
        "exactResearchDocuments": {"products": [{"product": "risk-ranges", "publicationDate": "2026-09-17", "documents": [{
            "documentId": "doc-1", "contentHash": "content-hash", "sourceUri": "https://app.hedgeye.com/feed_items/report",
            "publicationDate": "2026-09-17", "indexedAt": AT, "privateExcerpt": "DO NOT EXPOSE",
        }]}]},
    }


def venue(market_id="gold", requested="kalshi"):
    source = "kalshi_trade_api" if requested == "kalshi" else "ibkr_forecastex_live"
    return {"marketId": market_id, "asset": market_id.title(), "requestedVenue": requested, "status": "available", "snapshot": {
        "marketId": market_id, "selectedVenueId": requested, "displaySelection": {"venueId": requested},
        "displayContracts": {"status": "available", "bookExpiresAt": "2026-09-17T18:01:00Z", "event": {
            "ticker": "event-1", "status": "open", "venueId": requested, "closeTime": "2026-09-18T20:00:00Z",
        }, "lines": [{"ticker": "contract-1", "source": source, "directNative": True,
                     "yesBid": .4, "yesAsk": .42, "noBid": .58, "noAsk": .6,
                     "evidence": {"quotes": {"source": source, "fit": "exact", "asOf": AT}}}]},
    }}


def scoped_venue():
    row = venue("silver", "forecastex")
    row["snapshot"].update({
        "status": "unavailable", "revision": 2, "refreshPending": True,
        "acquisition": {"status": "complete", "scope": "pinned_native_book", "revision": 2, "previousRevision": 1,
                        "requestedAt": "2026-09-17T17:59:58Z", "completedAt": AT},
        "refresh": {"state": "refreshing", "lastError": None,
                    "startedAt": "2026-09-17T17:59:59Z", "completedAt": AT},
    })
    return row


class ReviewSourcesTests(unittest.TestCase):
    def project(self, record, evidence):
        result = review_sources(record, Store(evidence), research_products=PRODUCTS, prediction_universe=UNIVERSE)
        return result, {item["id"]: item for item in result["items"]}

    def test_gateway_uses_its_own_immutable_connection_capture_for_every_review(self):
        evidence = {"ibGateway": {"status": "available", "liveVerified": True, "freshness": "live",
                                 "asOf": AT, "data": {"connected": True, "accounts": ["PRIVATE"]}}}
        original = copy.deepcopy(evidence)
        for kind in ("portfolio-review", "balance-review", "prediction-markets-review"):
            with self.subTest(kind=kind):
                record = run(kind, {"ibGateway": checkpoint(), "portfolio": checkpoint("failed"),
                                   "balance": checkpoint("failed"), "portfolioBalance": checkpoint("failed"),
                                   "portfolioOpenOrders": checkpoint("failed")})
                result, items = self.project(record, evidence)
                self.assertEqual(items["ibGateway"], {"id": "ibGateway", "label": "IB Gateway", "status": "ready",
                    "observedAt": AT, "requiresIbGateway": True, "timestampKind": "captured"})
                self.assertEqual(items["portfolio"]["status"], "unavailable")
                self.assertNotIn("PRIVATE", json.dumps(result))
                record["updatedAt"] = "2026-10-08T18:00:00Z"
                self.assertEqual(self.project(record, evidence)[1]["ibGateway"], items["ibGateway"])
        self.assertEqual(evidence, original)

    def test_legacy_account_readiness_never_invents_an_explicit_gateway_check(self):
        for state in ("running", "succeeded", "failed"):
            with self.subTest(state=state):
                _, items = self.project(run("portfolio-review", {name: checkpoint() for name in
                    ("portfolio", "portfolioBalance", "portfolioOpenOrders")}, state=state), {})
                self.assertNotIn("ibGateway", items)
                self.assertEqual(items["portfolio"]["status"], "ready")

    def test_gateway_requires_explicit_live_connection_and_original_check_time(self):
        connected = {"status": "available", "liveVerified": True, "freshness": "live", "asOf": AT,
                     "data": {"connected": True}}
        for changes in ({"liveVerified": False}, {"freshness": "unavailable"}, {"data": {"connected": False}},
                        {"asOf": None}, {"asOf": "2026-09-17T17:59:00Z"}, {"stale": True},
                        {"cacheOnly": True}, {"from_cache": True}, {"seeded": True}, {"mock": True}):
            with self.subTest(changes=changes):
                _, items = self.project(run("portfolio-review", {"ibGateway": checkpoint()}),
                                        {"ibGateway": {**connected, **changes}})
                self.assertEqual(items["ibGateway"]["status"], "unavailable")
        for observed in (None, "2026-09-17", "2026-09-17T18:00:00"):
            with self.subTest(observed=observed):
                _, items = self.project(run("portfolio-review", {"ibGateway": checkpoint(asOf=observed)}),
                                        {"ibGateway": {**connected, "asOf": observed}})
                self.assertEqual(items["ibGateway"]["status"], "unavailable")

    def test_gateway_retains_typed_connection_failure_without_account_or_provider_text(self):
        record = run("portfolio-review", {"ibGateway": checkpoint("failed", errorCode="IBKR_SERVICE_UNAVAILABLE")})
        result, items = self.project(record, {"ibGateway": {"status": "unavailable", "asOf": AT,
            "liveVerified": False, "errorCode": "IBKR_GATEWAY_READINESS_TIMEOUT",
            "warnings": ["Private account 123456"]}})
        self.assertEqual(items["ibGateway"]["diagnostic"], {"code": "IBKR_GATEWAY_READINESS_TIMEOUT"})
        self.assertEqual(items["ibGateway"]["observedAt"], AT)
        self.assertNotIn("123456", json.dumps(result))

    def test_portfolio_archive_source_discloses_capture_scope_and_partial_scan(self):
        archive = {"scanComplete": True, "manifest": {"documentCount": 120, "earliestDate": "2026-04-01", "latestDate": "2026-09-17"}}
        evidence = {"portfolioRefreshResearch": archive}
        original = copy.deepcopy(evidence)
        _, items = self.project(run("portfolio-review", {"portfolioRefreshResearch": checkpoint()}), evidence)
        item = items["portfolioRefreshResearch"]
        self.assertEqual(item["status"], "ready")
        self.assertIn("120 source publications", item["detail"])
        self.assertIn("complete available archive scan", item["detail"])
        self.assertEqual(item["timestampKind"], "review-captured")
        self.assertEqual(evidence, original)
        archive["scanComplete"] = False
        _, items = self.project(run("portfolio-review", {"portfolioRefreshResearch": checkpoint("partial")}), evidence)
        self.assertNotEqual(items["portfolioRefreshResearch"]["status"], "ready")
        self.assertIn("incomplete archive scan", items["portfolioRefreshResearch"]["detail"])

    def test_complete_archive_scan_discloses_rejected_history_without_erasing_valid_evidence(self):
        archive = {"scanComplete": True, "manifest": {"documentCount": 120}, "coverage": {"products": [
            {"id": "etf-pro", "label": "ETF Pro", "status": "checked", "reasons": []},
            {"id": "early-look", "label": "Early Look", "status": "partial", "reasons": ["source-provenance-missing"]}]}}
        evidence = {"portfolioRefreshResearch": archive}
        original = copy.deepcopy(evidence)
        _, items = self.project(run("portfolio-review", {"portfolioRefreshResearch": checkpoint()}), evidence)
        item = items["portfolioRefreshResearch"]
        self.assertEqual(item["status"], "partial")
        self.assertEqual(item["diagnostic"]["code"], "PORTFOLIO_REFRESH_ARCHIVE_PARTIAL")
        self.assertEqual(item["archiveCoverage"]["count"], 1)
        self.assertEqual(item["archiveCoverage"]["reasons"], ["source-provenance-missing"])
        self.assertIn("1 products with archived gaps", item["detail"])
        self.assertEqual(item["observedAt"], AT)
        self.assertEqual(evidence, original)

    def test_prediction_sources_use_already_captured_prior_publications_when_today_is_missing(self):
        publications = {product: {"date": "2026-09-16", "snapshotType": product,
                        "publishedAt": "2026-09-16T14:10:00Z", "article": {"bodyText": "Published research"}}
                        for product in ("signal-strength", "the-macro-show")}
        evidence = {"predictionResearch": {"date": "2026-09-17",
                    "snapshots": {product: None for product in publications}, "previousSnapshots": publications}}
        original = copy.deepcopy(evidence)
        record = run("prediction-markets-review", {"predictionResearch": checkpoint("partial")})
        _, items = self.project(record, evidence)
        for product in publications:
            self.assertEqual(items[product]["status"], "ready")
            self.assertEqual(items[product]["publishedAt"], "2026-09-16T14:10:00+00:00")
            self.assertEqual(items[product]["observedAt"], "2026-09-16T14:10:00+00:00")
            self.assertTrue(items[product]["verifiedFromCapture"])
        self.assertEqual(evidence, original)

    def test_saved_portfolio_sources_recover_its_own_prior_signal_strength_without_newer_research(self):
        prior = {"date": "2026-10-06", "snapshotType": "signal-strength",
                 "publishedAt": "2026-10-06T00:00:00+00:00", "scrapedAt": "2026-10-06T15:32:52Z",
                 "article": {"bodyText": "Preserved publication"}, "data": {"added": ["AAA"]}}
        evidence = {"dailyResearch": {"date": "2026-10-07", "snapshots": {"signal-strength": None},
                                     "previousSnapshots": {"signal-strength": prior}}}
        original = copy.deepcopy(evidence)
        captured_at = "2026-10-07T14:30:24Z"
        record = run("portfolio-review", {"dailyResearch": checkpoint("partial", asOf=captured_at)},
                     createdAt=captured_at, updatedAt=captured_at)
        result = review_sources(record, Store(evidence), research_products=[{"id": "signal-strength", "label": "Signal Strength"}])
        item = next(row for row in result["items"] if row["id"] == "signal-strength")
        self.assertEqual(item["status"], "ready")
        self.assertEqual(item["publishedAt"], "2026-10-06")
        self.assertEqual(item["observedAt"], "2026-10-06")
        self.assertTrue(item["verifiedFromCapture"])
        self.assertNotIn("diagnostic", item)
        self.assertEqual(evidence, original)
        # Today's edition, published after this capture, cannot replace it.
        evidence["dailyResearch"]["snapshots"]["signal-strength"] = {**prior, "date": "2026-10-07",
                                                                   "publishedAt": "2026-10-07T14:49:27Z"}
        item = next(row for row in review_sources(record, Store(evidence), research_products=[
            {"id": "signal-strength", "label": "Signal Strength"}])["items"] if row["id"] == "signal-strength")
        self.assertEqual(item["publishedAt"], "2026-10-06")

    def test_absent_and_rejected_daily_publications_have_bounded_distinct_explanations(self):
        record = run("portfolio-review", {"dailyResearch": checkpoint("partial")})
        products = [{"id": "signal-strength", "label": "Signal Strength"}]
        for publication, expected in ((None, "RESEARCH_PUBLICATION_NOT_CAPTURED"),
                                      ({"date": "2026-09-17", "snapshotType": "signal-strength", "status": "failed",
                                        "error": "Private provider account 123456"}, "RESEARCH_PUBLICATION_REJECTED")):
            raw = {"dailyResearch": {"date": "2026-09-17", "snapshots": {"signal-strength": publication}}}
            result = review_sources(record, Store(raw), research_products=products)
            item = next(row for row in result["items"] if row["id"] == "signal-strength")
            self.assertEqual(item["diagnostic"]["code"], expected)
            self.assertTrue(item["diagnostic"]["reason"])
            self.assertTrue(item["diagnostic"]["remedy"])
            self.assertNotIn("Private", json.dumps(result))
            self.assertNotIn("123456", json.dumps(result))

    def test_archive_acquisition_failure_is_unavailable_without_erasing_independent_publications(self):
        for code in ("RESEARCH_ARCHIVE_TIMEOUT", "RESEARCH_ARCHIVE_UNAVAILABLE",
                     "RESEARCH_ARCHIVE_INVALID_RESPONSE", "RESEARCH_ARCHIVE_DATE_MISMATCH"):
            with self.subTest(code=code):
                evidence = {"predictionResearch": {"date": "2026-09-17", "snapshots": {
                    "crypto-quant": {"date": "2026-09-16", "snapshotType": "crypto-quant", "publishedAt": "2026-09-16T12:00:00Z"}},
                    "previousSnapshots": {"the-macro-show": {"date": "2026-09-16", "snapshotType": "the-macro-show",
                                                              "publishedAt": "2026-09-16T14:10:00Z"}},
                    "acquisitionDiagnostics": {"dailyArchive": {"code": code}}}}
                original = copy.deepcopy(evidence)
                record = run("prediction-markets-review", {"predictionResearch": checkpoint("partial")})
                _, items = self.project(record, evidence)
                self.assertEqual(items["signal-strength"]["status"], "unavailable")
                self.assertEqual(items["signal-strength"]["diagnostic"]["code"], code)
                self.assertTrue(items["signal-strength"]["diagnostic"]["reason"])
                self.assertTrue(items["signal-strength"]["diagnostic"]["remedy"])
                self.assertEqual(items["crypto-quant"]["status"], "ready")
                self.assertEqual(items["the-macro-show"]["status"], "ready")
                self.assertNotIn("diagnostic", items["the-macro-show"])
                self.assertEqual(evidence, original)
        record = run("prediction-markets-review", {"predictionResearch": checkpoint("partial")})
        _, items = self.project(record, {"predictionResearch": {"date": "2026-09-17", "snapshots": {}}})
        self.assertEqual(items["signal-strength"]["status"], "missing")
        self.assertEqual(items["signal-strength"]["diagnostic"]["code"], "RESEARCH_PUBLICATION_NOT_CAPTURED")

    def test_failed_source_retains_typed_diagnosis_without_provider_payload(self):
        record = run("portfolio-review", {"portfolioBalance": checkpoint("failed", errorCode="REVIEW_SOURCE_UNAVAILABLE")}, createdAt=AT)
        evidence = {"portfolioBalance": {"status": "unavailable", "liveVerified": False,
                    "errorCode": "IBKR_BALANCE_TIMEOUT", "diagnostic": {"message": "Private account 123456"}}}
        result, items = self.project(record, evidence)
        self.assertEqual(result["capturedAt"], AT)
        self.assertEqual(items["portfolioBalance"]["status"], "unavailable")
        self.assertEqual(items["portfolioBalance"]["diagnostic"], {"code": "IBKR_BALANCE_TIMEOUT"})
        self.assertNotIn("123456", json.dumps(result))
        evidence["portfolioBalance"]["errorCode"] = "Private account 123456"
        self.assertNotIn("diagnostic", self.project(record, evidence)[1]["portfolioBalance"])

    def test_saved_cftc_uses_its_captured_report_week_and_source_clock(self):
        registry = json.loads((Path(__file__).resolve().parents[2] / "infra/lambdas/gmail_ingestor/research_products.json").read_text())
        product = next(product for product in registry["products"] if product["id"] == "cftc-positioning")
        captured = "2026-09-21T14:33:50Z"
        observed = "2026-09-18T20:15:08Z"
        record = run("portfolio-review", {name: checkpoint(updatedAt=captured) for name in
            ("researchCoverage", "exactResearchDocuments")}, updatedAt=captured)
        evidence = {"researchCoverage": {"products": [{
            "product": "cftc-positioning", "status": "late", "latestPublicationDate": "2026-09-15",
            "expectedPublicationDate": "2026-09-18", "observedAt": observed,
        }]}, "exactResearchDocuments": {"products": [{"product": "cftc-positioning", "documents": [{
            "documentId": "cftc-sep15", "contentHash": "source-content-hash",
            "sourceUri": "dynamodb://HedgeyeDailySnapshot/2026-09-15",
            "publicationDate": "2026-09-15", "indexedAt": "2026-09-18T22:14:36Z", "observedAt": observed,
        }]}]}}

        def project():
            return next(item for item in review_sources(record, Store(evidence), research_products=[product])["items"]
                        if item["id"] == "cftc-positioning")

        original = copy.deepcopy(evidence)
        item = project()
        self.assertEqual(item["status"], "ready")
        self.assertEqual(item["observedAt"], observed)
        self.assertEqual(item["publishedAt"], "2026-09-15")
        self.assertEqual(item["detail"], "Report date: 2026-09-15")
        record["updatedAt"] = "2026-09-28T14:33:50Z"
        self.assertEqual(project(), item)
        self.assertEqual(evidence, original)

        for invalid in ({"stale": True}, {"cacheOnly": True}, {"mock": True},
                        {"seeded": True}, {"connected": False}, {"status": "failed"}):
            with self.subTest(invalid=invalid):
                evidence = copy.deepcopy(original)
                evidence["researchCoverage"]["products"][0].update(invalid)
                self.assertNotEqual(project()["status"], "ready")
        evidence = copy.deepcopy(original)
        evidence["researchCoverage"]["products"][0]["expectedPublicationDate"] = "2026-09-25"
        self.assertEqual(project()["status"], "missing")
        evidence = copy.deepcopy(original)
        evidence["exactResearchDocuments"]["products"][0]["documents"] = []
        self.assertEqual(project()["status"], "missing")

    def test_crypto_quant_legacy_storage_does_not_make_bitcoin_tracker_ready(self):
        record = run("prediction-markets-review", {"predictionResearch": checkpoint()})
        evidence = {"predictionResearch": {"date": "2026-09-17", "snapshots": {
            "bitcoin-trend-tracker": {"snapshotType": "bitcoin-trend-tracker", "reportType": "crypto-quant",
                "date": "2026-09-17", "publishedAt": "2026-09-17T12:06:00Z", "data": {"cryptos": {}}},
        }}}
        _, items = self.project(record, evidence)
        self.assertEqual(items["crypto-quant"]["status"], "ready")
        self.assertEqual(items["crypto-quant"]["publishedAt"], "2026-09-17T12:06:00+00:00")
        self.assertNotIn("bitcoin-trend-tracker", items)

    def test_independent_bitcoin_tracker_and_crypto_quant_remain_separate_sources(self):
        record = run("prediction-markets-review", {"predictionResearch": checkpoint()})
        evidence = {"predictionResearch": {"date": "2026-09-17", "snapshots": {
            "bitcoin-trend-tracker": {"snapshotType": "bitcoin-trend-tracker", "reportType": "bitcoin-trend-tracker",
                "date": "2026-09-17", "publishedAt": "2026-09-17T11:30:00Z", "data": {"cryptos": {}}},
            "crypto-quant": {"snapshotType": "crypto-quant", "reportType": "crypto-quant",
                "storageSnapshotType": "bitcoin-trend-tracker", "date": "2026-09-17",
                "publishedAt": "2026-09-17T12:06:00Z", "data": {"cryptos": {}}},
        }}}
        _, items = self.project(record, evidence)
        self.assertEqual(items["bitcoin-trend-tracker"]["status"], "ready")
        self.assertEqual(items["crypto-quant"]["status"], "ready")

    def test_prediction_research_sources_use_immutable_publication_cutoff(self):
        record = run("prediction-markets-review", {"predictionResearch": checkpoint(asOf="2026-09-17T13:30:00Z")})
        evidence = {"predictionResearch": {"date": "2026-09-17", "snapshots": {
            "bitcoin-trend-tracker": {"date": "2026-09-17", "publishedAt": "2026-09-17T11:30:00Z", "data": {"cryptos": {}}},
            "crypto-quant": {"date": "2026-09-17", "publishedAt": "2026-09-17T14:00:00Z", "article": {"bodyText": "Later research"}},
        }}}
        _, items = self.project(record, evidence)
        self.assertEqual(items["bitcoin-trend-tracker"]["status"], "ready")
        self.assertEqual(items["bitcoin-trend-tracker"]["publishedAt"], "2026-09-17T11:30:00+00:00")
        self.assertEqual(items["crypto-quant"]["status"], "missing")
        record["updatedAt"] = "2026-09-18T20:00:00Z"
        _, reopened = self.project(record, evidence)
        self.assertEqual(reopened, items)

    def test_legacy_prediction_roster_keeps_its_original_venues_after_six_market_change(self):
        historical = [("silver", "Silver", "kalshi"), ("gold", "Gold", "kalshi"), ("wti", "WTI", "kalshi"),
                      ("brent", "Brent", "kalshi"), ("bitcoin", "Bitcoin", "kalshi"),
                      ("sp500", "S&P 500", "forecastex"), ("nasdaq100", "Nasdaq 100", "forecastex"), ("cpi", "CPI", "kalshi")]
        current = [("cpi", "CPI", "forecastex"), ("sp500", "S&P 500", "forecastex"), ("gold", "Gold", "kalshi"),
                   ("silver", "Silver", "kalshi"), ("bitcoin", "Bitcoin", "kalshi"), ("ethereum", "Ethereum", "kalshi")]
        source = {"asOf": AT, "status": "available", "data": {
            "policy": {"autoVenueAllowed": False, "alternateVenueFallbackAllowed": False},
            "universe": [{"marketId": market_id, "asset": asset, "venue": selected} for market_id, asset, selected in historical],
            "markets": [venue(market_id, selected) for market_id, _asset, selected in historical],
        }}
        record = run("prediction-markets-review", {"predictionUniverse": checkpoint()})
        result = review_sources(record, Store({"predictionUniverse": source}), prediction_universe=current)
        items = {item["id"]: item for item in result["items"]}
        self.assertEqual(items["cpi"]["label"], "CPI · Kalshi")
        self.assertEqual(items["cpi"]["status"], "ready")
        self.assertNotIn("requiresIbGateway", items["cpi"])
        self.assertEqual(items["nasdaq100"]["status"], "ready")
        self.assertTrue(items["nasdaq100"]["requiresIbGateway"])
        self.assertNotIn("ethereum", items)

    def test_daily_sources_use_captured_publications_and_exclude_later_reports(self):
        record = run("portfolio-review", {"dailyResearch": checkpoint(asOf="2026-09-17T13:30:00Z")})
        evidence = {"dailyResearch": {"date": "2026-09-17", "snapshots": {
            "risk-ranges": {"date": "2026-09-17", "publishedAt": "2026-09-17T11:30:00Z", "data": {"rows": []}},
            "early-look": {"date": "2026-09-17", "publishedAt": "2026-09-17T14:00:00Z", "article": {"bodyText": "Later research"}},
        }}}
        _, items = self.project(record, evidence)
        self.assertEqual(items["risk-ranges"]["status"], "ready")
        self.assertEqual(items["risk-ranges"]["publishedAt"], "2026-09-17T11:30:00+00:00")
        self.assertEqual(items["early-look"]["status"], "missing")
        record["updatedAt"] = "2026-09-18T20:00:00Z"
        _, reopened = self.project(record, evidence)
        self.assertEqual(reopened, items)

    def test_market_situation_report_exposes_original_capture_without_inventing_publication_time(self):
        record = run("portfolio-review", {"dailyResearch": checkpoint(asOf="2026-09-19T14:59:42Z")},
                     updatedAt="2026-09-19T14:59:50Z")
        snapshot = {"date": "2026-09-18", "publishedAt": "2026-09-18T00:00:00+00:00",
                    "scrapedAt": "2026-09-18T10:30:42+00:00", "source": "gmail-html",
                    "article": {"bodyText": "Dated market structure research."}}
        evidence = {"dailyResearch": {"date": "2026-09-18", "marketStructure": snapshot}}
        products = [{"id": "market-structure", "label": "Market Situation Report"}]

        def project():
            return next(item for item in review_sources(record, Store(evidence), research_products=products)["items"]
                        if item["id"] == "market-structure")

        item = project()
        self.assertEqual(item["observedAt"], "2026-09-18T10:30:42+00:00")
        self.assertEqual(item["publishedAt"], "2026-09-18")
        self.assertEqual(item["timestampKind"], "captured")
        self.assertIn("Publication time unavailable", item["detail"])
        record["updatedAt"] = "2026-09-20T18:00:00Z"
        self.assertEqual(project(), item)
        snapshot["article"]["publishedAt"] = "2026-09-18T10:20:00Z"
        self.assertEqual(project()["observedAt"], "2026-09-18T10:20:00+00:00")
        self.assertNotIn("timestampKind", project())

    def test_missing_capture_clock_never_borrows_review_or_indexing_time(self):
        record = run("portfolio-review", {"dailyResearch": checkpoint(asOf="2026-09-19T14:59:42Z")},
                     updatedAt="2026-09-19T14:59:50Z")
        for stamp in (None, "bad", "2026-09-18", "2026-09-18T10:30:42"):
            evidence = {"dailyResearch": {"date": "2026-09-18", "marketStructure": {
                "date": "2026-09-18", "publishedAt": "2026-09-18T00:00:00Z", "scrapedAt": stamp,
                "indexedAt": "2026-09-18T18:00:00Z", "article": {"bodyText": "Dated research."}}}}
            result = review_sources(record, Store(evidence), research_products=[{"id": "market-structure"}])
            item = next(item for item in result["items"] if item["id"] == "market-structure")
            self.assertEqual(item["observedAt"], "2026-09-18")
            self.assertNotIn("timestampKind", item)

    def test_prediction_market_structure_uses_same_original_clock_as_portfolio(self):
        snapshot = {"date": "2026-09-18", "publishedAt": "2026-09-18T00:00:00Z",
                    "scrapedAt": "2026-09-18T10:30:42+00:00", "source": "gmail-html",
                    "article": {"bodyText": "Dated market structure research."}}
        for published, captured in ((None, "2026-09-18T10:30:42+00:00"),
                                    ("2026-09-18T10:20:00Z", "2026-09-18T10:20:00+00:00")):
            snapshot["article"]["publishedAt"] = published
            items = []
            for kind, dependency in (("portfolio-review", "dailyResearch"),
                                     ("prediction-markets-review", "predictionResearch")):
                record = run(kind, {dependency: checkpoint(asOf="2026-09-19T15:00:00Z")},
                             updatedAt="2026-09-19T15:00:10Z")
                evidence = {dependency: {"date": "2026-09-18", "snapshots": {"market-structure": snapshot}}}
                result = review_sources(record, Store(evidence), research_products=[{"id": "market-structure", "label": "Market Structure"}])
                item = next(row for row in result["items"] if row["id"] == "market-structure")
                self.assertEqual(item["observedAt"], captured)
                self.assertEqual(item.get("timestampKind"), None if published else "captured")
                items.append(item)
            self.assertEqual(items[0], items[1])

    def test_market_research_without_captured_volatility_preserves_partial_status(self):
        captured = "2026-09-19T14:59:43.537343Z"
        record = run("portfolio-review", {"marketSituation": checkpoint("partial", asOf="2026-09-18", updatedAt=captured)},
                     updatedAt="2026-09-19T14:59:50Z")
        evidence = {"marketSituation": {"status": "partial", "asOf": "2026-09-18",
                    "data": {"realizedVolatility": {"status": "unavailable"},
                             "research": {"publicationDate": "2026-09-18"}}}}
        _, items = self.project(record, evidence)
        item = items["marketSituation"]
        self.assertEqual(item["status"], "partial")
        self.assertEqual(item["observedAt"], captured)
        self.assertEqual(item["timestampKind"], "review-captured")
        self.assertNotIn("publishedAt", item)
        evidence["marketSituation"]["stale"] = True
        self.assertEqual(self.project(record, evidence)[1]["marketSituation"]["status"], "unavailable")

    def test_balance_supports_check_only_for_the_exact_active_pending_capture(self):
        evidence = {"balance": {"status": "partial", "liveVerified": True, "asOf": AT,
                    "data": {"current": {"available": True, "status": "live", "source": "ibkr_live_session", "fromCache": False},
                             "interestStatus": None, "history": None}}}
        descriptor = checkpoint("partial", detail={"liveVerified": True, "acquisition": {"supportingPending": True}})
        record = run("balance-review", {"balance": descriptor}, state="running")
        _, items = self.project(record, evidence)
        self.assertEqual(items["balance"]["status"], "ready")
        self.assertEqual(items["interestStatus"]["status"], "checking")
        self.assertEqual(items["history"]["status"], "checking")
        for state, pending_supports in (("succeeded", True), ("running", False)):
            with self.subTest(state=state):
                record["state"] = state
                descriptor["detail"]["acquisition"]["supportingPending"] = pending_supports
                _, items = self.project(record, evidence)
                self.assertEqual(items["interestStatus"]["status"], "missing")
                self.assertEqual(items["history"]["status"], "missing")
        record["state"] = "running"
        descriptor["detail"]["acquisition"]["supportingPending"] = True
        evidence["balance"]["data"]["current"]["stale"] = True
        _, items = self.project(record, evidence)
        self.assertEqual(items["balance"]["status"], "unavailable")
        self.assertNotEqual(items["history"]["status"], "checking")

    def test_market_data_capture_is_the_persisted_composite_checkpoint_not_its_research_clock(self):
        captured = "2026-09-19T14:59:43.537343Z"
        record = run("portfolio-review", {"marketSituation": checkpoint(asOf="2026-09-18", updatedAt=captured)},
                     updatedAt="2026-09-19T14:59:50Z")
        evidence = {"marketSituation": {"status": "available", "asOf": "2026-09-18",
                    "data": {"realizedVolatility": {"asOf": "2026-09-18"},
                             "research": {"publicationDate": "2026-09-18"}}}}
        _, items = self.project(record, evidence)
        item = items["marketSituation"]
        self.assertEqual(item["status"], "ready")
        self.assertEqual(item["observedAt"], captured)
        self.assertEqual(item["timestampKind"], "review-captured")
        self.assertEqual(item["detail"], "Review capture; source data through 2026-09-18")
        self.assertNotIn("publishedAt", item)
        record["updatedAt"] = "2026-09-20T18:00:00Z"
        self.assertEqual(self.project(record, evidence)[1]["marketSituation"], item)
        record["dependencies"]["marketSituation"]["asOf"] = "2026-09-18T18:00:00Z"
        item = self.project(record, evidence)[1]["marketSituation"]
        self.assertEqual(item["observedAt"], "2026-09-18T18:00:00Z")
        self.assertNotIn("timestampKind", item)

    def test_capture_does_not_override_invalid_sources_or_future_dates(self):
        record = run("portfolio-review", {"marketSituation": checkpoint(asOf="2026-09-17")})
        for changes in ({"stale": True}, {"mock": True}, {"cacheOnly": True}, {"seeded": True}, {"status": "unavailable"}):
            _, items = self.project(record, {"marketSituation": changes})
            self.assertEqual(items["marketSituation"]["status"], "unavailable")
            self.assertNotIn("timestampKind", items["marketSituation"])
        record["dependencies"]["marketSituation"]["asOf"] = "2026-09-18"
        _, items = self.project(record, {"marketSituation": {"status": "available", "asOf": "2026-09-18"}})
        self.assertEqual(items["marketSituation"]["status"], "unavailable")
        self.assertIsNone(items["marketSituation"]["observedAt"])

    def test_gateway_requirement_is_explicit_for_broker_dependent_sources_only(self):
        record = run("portfolio-review", {"portfolioFactors": checkpoint("failed")})
        _, items = self.project(record, {})
        for name in ("portfolio", "portfolioBalance", "portfolioOpenOrders", "portfolioFactors"):
            self.assertIs(items[name]["requiresIbGateway"], True)
        for name in ("risk-ranges", "early-look", "marketSituation"):
            self.assertNotIn("requiresIbGateway", items[name])
        _, items = self.project(run("balance-review"), {})
        self.assertIs(items["balance"]["requiresIbGateway"], True)
        self.assertNotIn("requiresIbGateway", items["interestStatus"])

    def test_pca_source_uses_saved_generation_clock_and_keeps_session_date_separate(self):
        record = run("portfolio-review", {"portfolioPca": checkpoint(asOf="2026-09-16"),
                                           "portfolioFactors": checkpoint("failed")})
        evidence = {"portfolioPca": {"status": "partial", "asOf": "2026-09-16",
                                    "sessionDate": "2026-09-16", "generatedAt": "2026-09-16T23:53:05Z",
                                    "historicalOnly": True, "executable": False}}
        original = copy.deepcopy(evidence)
        _, items = self.project(record, evidence)
        self.assertEqual(items["portfolioPca"], {"id": "portfolioPca", "label": "PCA model",
                                              "status": "ready", "observedAt": "2026-09-16T23:53:05Z",
                                              "timestampKind": "model-generated", "sessionDate": "2026-09-16",
                                              "detail": "Model through 2026-09-16"})
        self.assertNotIn("portfolioFactors", items)
        record["updatedAt"] = "2026-09-20T18:00:00Z"
        self.assertEqual(self.project(record, evidence)[1]["portfolioPca"], items["portfolioPca"])
        self.assertEqual(evidence, original)

    def test_pca_without_exact_generation_clock_does_not_borrow_review_time(self):
        record = run("portfolio-review", {"portfolioPca": checkpoint(asOf="2026-09-16")})
        for stamp in (None, "bad", "2026-09-16", "2026-09-16T23:53:05"):
            with self.subTest(stamp=stamp):
                evidence = {"portfolioPca": {"status": "partial", "asOf": "2026-09-16",
                                            "sessionDate": "2026-09-16", "generatedAt": stamp,
                                            "historicalOnly": True, "executable": False}}
                item = self.project(record, evidence)[1]["portfolioPca"]
                self.assertEqual(item["observedAt"], "2026-09-16")
                self.assertEqual(item["sessionDate"], "2026-09-16")
                self.assertNotIn("timestampKind", item)

    def test_pca_generation_clock_never_makes_invalid_or_pending_evidence_ready(self):
        for state, changes in (("ready", {"stale": True}), ("ready", {"mock": True}),
                               ("ready", {"cacheOnly": True}), ("ready", {"seeded": True}),
                               ("ready", {"connected": False}), ("failed", {}), ("checking", {})):
            with self.subTest(state=state, changes=changes):
                record = run("portfolio-review", {"portfolioPca": checkpoint(state, asOf="2026-09-16")},
                             state="running")
                evidence = {"portfolioPca": {"status": "partial", "asOf": "2026-09-16",
                                            "generatedAt": "2026-09-16T23:53:05Z", **changes}}
                item = self.project(record, evidence)[1]["portfolioPca"]
                self.assertEqual(item["status"], "checking" if state == "checking" else "unavailable")
                self.assertNotIn("timestampKind", item)

    def test_pca_generation_after_saved_review_is_unavailable(self):
        record = run("portfolio-review", {"portfolioPca": checkpoint(asOf="2026-09-16")})
        evidence = {"portfolioPca": {"status": "partial", "asOf": "2026-09-16",
                                    "generatedAt": "2026-09-18T23:53:05Z"}}
        item = self.project(record, evidence)[1]["portfolioPca"]
        self.assertEqual(item["status"], "unavailable")
        self.assertIsNone(item["observedAt"])
        self.assertNotIn("timestampKind", item)

    def test_old_factor_capture_is_not_relabelled_as_pca(self):
        record = run("portfolio-review", {"portfolioFactors": checkpoint("failed")})
        _, items = self.project(record, {})
        self.assertEqual(items["portfolioFactors"]["label"], "Factor model")
        self.assertNotIn("portfolioPca", items)

    def test_running_sources_begin_unchecked_without_a_report(self):
        for kind in ("portfolio-review", "balance-review", "prediction-markets-review"):
            with self.subTest(kind=kind):
                result, items = self.project(run(kind, state="running"), {})
                self.assertTrue(items)
                self.assertTrue(all(item["status"] == "checking" for item in items.values()))
                self.assertEqual(result["checkedAt"], AT)

    def test_portfolio_uses_per_product_documents_and_original_observations(self):
        record = run("portfolio-review", {key: checkpoint() for key in ("portfolio", "portfolioOpenOrders", "researchCoverage", "exactResearchDocuments")})
        result, items = self.project(record, research())
        self.assertEqual(items["risk-ranges"]["status"], "ready")
        self.assertEqual(items["risk-ranges"]["observedAt"], "2026-09-17")
        self.assertEqual(items["risk-ranges"]["publishedAt"], "2026-09-17")
        self.assertEqual(items["early-look"]["status"], "missing")
        self.assertEqual(items["portfolio"]["status"], "ready")
        self.assertNotIn("privateExcerpt", json.dumps(result))
        self.assertNotIn("DO NOT EXPOSE", json.dumps(result))

    def test_a_finished_report_does_not_make_missing_sources_ready(self):
        _, items = self.project(run("portfolio-review", reportMarkdown="A complete-looking report"), {})
        self.assertTrue(all(item["status"] == "missing" for item in items.values()))

    def test_research_preserves_source_clock_and_separate_report_date(self):
        record = run("portfolio-review", {key: checkpoint() for key in ("researchCoverage", "exactResearchDocuments")})
        evidence = research()
        document = evidence["exactResearchDocuments"]["products"][0]["documents"][0]
        document.update(observedAt="2026-09-17T17:50:00Z", publishedAt="2026-09-17T11:30:00Z")
        _, items = self.project(record, evidence)
        self.assertEqual(items["risk-ranges"]["observedAt"], "2026-09-17T17:50:00Z")
        self.assertEqual(items["risk-ranges"]["publishedAt"], "2026-09-17T11:30:00Z")
        document["publicationDate"] = "2026-09-08"
        evidence["researchCoverage"]["products"][0]["latestPublicationDate"] = "2026-09-08"
        document.pop("publishedAt")
        _, items = self.project(record, evidence)
        self.assertEqual(items["risk-ranges"]["observedAt"], "2026-09-17T17:50:00Z")
        self.assertEqual(items["risk-ranges"]["detail"], "Report date: 2026-09-08")

    def test_document_source_clocks_never_use_indexing_or_ingestion_times(self):
        metadata = {"ingestedAt": AT, "indexedAt": AT, "updatedAt": AT}
        self.assertEqual(document_source_times({"metadata": metadata}), {})
        metadata.update(observedAt="2026-09-17T17:50:00Z", publishedAt="2026-09-17T11:30:00Z")
        self.assertEqual(document_source_times({"metadata_json": json.dumps(metadata)}), {
            "observedAt": "2026-09-17T17:50:00Z", "publishedAt": "2026-09-17T11:30:00Z"})
        for changes in ({"mock": True}, {"stale": True}, {"seeded": True}):
            self.assertEqual(document_source_times({"metadata": {**metadata, **changes}}), {})
        self.assertEqual(document_source_times({"metadata": {"publishedAt": "2026-09-17T11:30:00"}}), {})
        self.assertEqual(document_source_times({"publication_date": "2026-09-17", "metadata": {
            "publishedAt": "2026-09-17T00:00:00+00:00", "observedAt": "2026-09-17T00:00:00+00:00"}}), {})
        self.assertEqual(document_source_times({"publication_date": "2026-09-17", "metadata": {
            "publishedAt": "2026-09-17T00:00:00+00:00", "observedAt": "2026-09-17T11:30:00Z"}}), {
                "observedAt": "2026-09-17T11:30:00Z"})

    def test_future_source_clock_cannot_make_research_ready(self):
        record = run("portfolio-review", {key: checkpoint() for key in ("researchCoverage", "exactResearchDocuments")})
        evidence = research()
        evidence["exactResearchDocuments"]["products"][0]["documents"][0]["observedAt"] = "2026-09-18T18:00:00Z"
        _, items = self.project(record, evidence)
        self.assertEqual(items["risk-ranges"]["status"], "unavailable")
        self.assertIsNone(items["risk-ranges"]["observedAt"])

    def test_late_or_invalid_research_never_gets_a_check(self):
        record = run("portfolio-review", {key: checkpoint() for key in ("researchCoverage", "exactResearchDocuments")})
        for update in ({"status": "late"}, {"stale": True}, {"cacheOnly": True}, {"mock": True}, {"seeded": True}, {"connected": False}):
            with self.subTest(update=update):
                evidence = research()
                evidence["researchCoverage"]["products"][0].update(update)
                _, items = self.project(record, evidence)
                self.assertIn(items["risk-ranges"]["status"], {"missing", "unavailable"})

    def test_future_publication_clock_cannot_fall_back_to_ready_observation(self):
        record = run("portfolio-review", {key: checkpoint() for key in ("researchCoverage", "exactResearchDocuments")})
        evidence = research()
        document = evidence["exactResearchDocuments"]["products"][0]["documents"][0]
        document.update(observedAt="2026-09-17T17:00:00Z", publishedAt="2026-09-17T19:00:00Z")
        _, items = self.project(record, evidence)
        self.assertEqual(items["risk-ranges"]["status"], "unavailable")
        self.assertIsNone(items["risk-ranges"]["observedAt"])
        self.assertNotIn("publishedAt", items["risk-ranges"])

    def test_balance_subsources_are_independent_and_never_expose_financial_values(self):
        evidence = {"balance": {"status": "partial", "data": {
            "current": {"available": True, "status": "live", "netLiquidation": 987654},
            "interestStatus": {"available": False, "status": "unavailable", "generatedAt": AT},
            "history": {"available": True, "status": "verified_history", "generatedAt": AT, "daily": [{"amount": 12345}]},
        }}}
        result, items = self.project(run("balance-review", {"balance": checkpoint("partial"), "portfolio": checkpoint("failed")}), evidence)
        self.assertEqual(items["balance"]["status"], "ready")
        self.assertEqual(items["portfolio"]["status"], "unavailable")
        self.assertEqual(items["interestStatus"]["status"], "unavailable")
        self.assertEqual(items["history"]["status"], "ready")
        self.assertNotIn("987654", json.dumps(result))
        self.assertNotIn("12345", json.dumps(result))

    def test_disconnected_or_invalid_broker_evidence_is_unavailable(self):
        for update in ({"connected": False}, {"status": "stale"}, {"cacheOnly": True}, {"mock": True}, {"seeded": True}):
            with self.subTest(update=update):
                _, items = self.project(run("balance-review", {"balance": checkpoint()}), {"balance": update})
                self.assertEqual(items["balance"]["status"], "unavailable")

    def test_prediction_sources_keep_the_pinned_native_book_failure_without_raw_messages(self):
        row = venue("silver", "forecastex")
        row["snapshot"]["displayContracts"].update(bookStatus="unavailable", scheduleOnly=True, lines=[])
        row["snapshot"]["venues"] = {"forecastex": {"book": {
            "status": "unavailable", "errorCode": "IBKR_GATEWAY_NOT_AUTHENTICATED",
            "refreshIssue": "Private broker connection details",
        }}}
        # A failure for an unrelated venue/reference must never label this book.
        row["snapshot"]["sourceHealth"] = [{"id": "kalshi_book", "errorCode": "KALSHI_FAILURE"}]
        source = {"status": "partial", "asOf": AT, "data": {
            "policy": {"autoVenueAllowed": False, "alternateVenueFallbackAllowed": False},
            "markets": [venue(), row],
        }}
        record = run("prediction-markets-review", {"predictionUniverse": checkpoint("partial")})
        original = copy.deepcopy(source)
        result, items = self.project(record, {"predictionUniverse": source})
        self.assertEqual(items["silver"]["status"], "unavailable")
        self.assertTrue(items["silver"]["requiresIbGateway"])
        self.assertEqual(items["silver"]["diagnostic"], {"code": "IBKR_GATEWAY_NOT_AUTHENTICATED"})
        self.assertNotIn("requiresIbGateway", items["gold"])
        self.assertNotIn("Private broker", json.dumps(result))
        self.assertEqual(source, original)

        row["snapshot"]["venues"]["forecastex"]["book"]["errorCode"] = "Private account 12345"
        _, items = self.project(record, {"predictionUniverse": source})
        self.assertEqual(items["silver"]["diagnostic"], {"code": "FORECASTEX_NATIVE_QUOTES_UNAVAILABLE"})

    def test_prediction_checks_each_pinned_native_book_at_its_capture_time(self):
        source = {"status": "partial", "liveVerified": False, "asOf": AT, "data": {
            "policy": {"autoVenueAllowed": False, "alternateVenueFallbackAllowed": False},
            "markets": [venue(), {"marketId": "silver", "requestedVenue": "forecastex", "status": "unavailable"}],
        }}
        record = run("prediction-markets-review", {"predictionUniverse": checkpoint("failed", detail={"liveVerified": False})})
        result, items = self.project(record, {"predictionUniverse": source})
        self.assertEqual(items["gold"]["status"], "ready")
        self.assertEqual(items["gold"]["observedAt"], AT)
        self.assertEqual(items["silver"]["status"], "unavailable")
        self.assertNotIn("yesAsk", json.dumps(result))
        self.assertNotIn("contract-1", json.dumps(result))
        for update in ({"stale": True}, {"cachedOnly": True}, {"mock": True}, {"seeded": True}, {"connected": False}):
            with self.subTest(update=update):
                changed = copy.deepcopy(source)
                changed["data"]["markets"][0]["snapshot"]["displayContracts"].update(update)
                _, invalid = self.project(record, {"predictionUniverse": changed})
                self.assertEqual(invalid["gold"]["status"], "unavailable")
        for update in ({"mock": True}, {"freshness": {"status": "stale"}}):
            with self.subTest(snapshot=update):
                changed = copy.deepcopy(source)
                changed["data"]["markets"][0]["snapshot"].update(update)
                _, invalid = self.project(record, {"predictionUniverse": changed})
                self.assertEqual(invalid["gold"]["status"], "unavailable")

    def test_scoped_native_book_readiness_is_independent_of_pending_monitor_references(self):
        source = {"status": "partial", "data": {
            "policy": {"autoVenueAllowed": False, "alternateVenueFallbackAllowed": False},
            "markets": [scoped_venue()],
        }}
        record = run("prediction-markets-review", {"predictionUniverse": checkpoint("failed")})
        _, items = self.project(record, {"predictionUniverse": source})
        self.assertEqual(items["silver"]["status"], "ready")
        self.assertEqual(items["silver"]["observedAt"], AT)
        self.assertEqual(source["data"]["markets"][0]["snapshot"]["status"], "unavailable")

    def test_saved_prediction_venue_survives_current_pin_changes(self):
        current = [("gold", "Gold", "kalshi"), ("silver", "Silver", "kalshi")]
        record = run("prediction-markets-review", {"predictionUniverse": checkpoint()})
        for recorded_venue in ("forecastex", "kalshi"):
            with self.subTest(recorded_venue=recorded_venue):
                source = {"status": "available", "data": {
                    "policy": {"autoVenueAllowed": False, "alternateVenueFallbackAllowed": False},
                    "universe": [{"marketId": "gold", "asset": "Gold", "venue": "kalshi"},
                                 {"marketId": "silver", "asset": "Silver", "venue": recorded_venue}],
                    "markets": [venue(), venue("silver", recorded_venue)],
                }}
                result = review_sources(record, Store({"predictionUniverse": source}), prediction_universe=current)
                silver = next(item for item in result["items"] if item["id"] == "silver")
                self.assertEqual(silver["label"], "Silver · " + ("ForecastEx" if recorded_venue == "forecastex" else "Kalshi"))
                self.assertEqual(silver["status"], "ready")
                self.assertEqual(silver["observedAt"], AT)

    def test_recorded_prediction_universe_never_coerces_invalid_or_inconsistent_venues(self):
        current = [("gold", "Gold", "kalshi"), ("silver", "Silver", "kalshi")]
        record = run("prediction-markets-review", {"predictionUniverse": checkpoint()})
        recorded = [{"marketId": "gold", "asset": "Gold", "venue": "kalshi"},
                    {"marketId": "silver", "asset": "Silver", "venue": "forecastex"}]
        source = {"status": "available", "data": {
            "policy": {"autoVenueAllowed": False, "alternateVenueFallbackAllowed": False},
            "universe": recorded, "markets": [venue(), venue("silver", "forecastex")],
        }}
        invalid_universes = [None, {}, "auto", [], recorded[:1], [recorded[0], recorded[0]]]
        for update in ({"venue": "auto"}, {"venue": "KALSHI"}, {"venue": "unknown"},
                       {"venue": {"id": "forecastex"}}, {"marketId": "unknown"},
                       {"marketId": ["silver"]}, {"asset": "Gold"}):
            invalid_universes.append([recorded[0], {**recorded[1], **update}])
        for value in invalid_universes:
            with self.subTest(universe=value):
                changed = copy.deepcopy(source)
                changed["data"]["universe"] = value
                result = review_sources(record, Store({"predictionUniverse": changed}), prediction_universe=current)
                markets = [item for item in result["items"] if item["id"] in {"gold", "silver"}]
                self.assertTrue(all(item["status"] == "unavailable" for item in markets))
                self.assertTrue(all(item["observedAt"] is None for item in markets))
        for target, update in (("row", {"requestedVenue": "kalshi"}),
                               ("snapshot", {"selectedVenueId": "kalshi"}),
                               ("policy", {"alternateVenueFallbackAllowed": True})):
            with self.subTest(target=target):
                changed = copy.deepcopy(source)
                row = changed["data"]["markets"][1]
                destination = row if target == "row" else row["snapshot"] if target == "snapshot" else changed["data"]["policy"]
                destination.update(update)
                result = review_sources(record, Store({"predictionUniverse": changed}), prediction_universe=current)
                silver = next(item for item in result["items"] if item["id"] == "silver")
                self.assertEqual(silver["status"], "unavailable")
                self.assertEqual(silver["label"], "Silver · ForecastEx")

    def test_scoped_acquisition_does_not_override_invalid_or_unverified_evidence(self):
        record = run("prediction-markets-review", {"predictionUniverse": checkpoint("failed")})
        cases = [
            ("acquisition", {"scope": None}), ("acquisition", {"status": "failed"}),
            ("acquisition", {"previousRevision": 2}), ("acquisition", {"requestedAt": AT + "invalid"}),
            ("acquisition", {"completedAt": "2026-09-17T18:00:01Z"}),
            ("refresh", {"lastError": "Native refresh failed"}), ("refresh", {"state": "failed"}),
            ("refresh", {"startedAt": "2026-09-17T17:59:57Z"}),
            ("snapshot", {"revision": 1}), ("snapshot", {"status": "offline"}),
            ("snapshot", {"stale": True}), ("snapshot", {"cachedOnly": True}),
            ("snapshot", {"mock": True}), ("snapshot", {"seeded": True}),
            ("snapshot", {"connected": False}), ("snapshot", {"freshness": {"status": "stale"}}),
            ("displayContracts", {"stale": True}), ("displayContracts", {"cachedOnly": True}),
            ("displayContracts", {"mock": True}), ("displayContracts", {"seeded": True}),
            ("displayContracts", {"connected": False}), ("displayContracts", {"refreshFailed": True}),
            ("displayContracts", {"bookExpiresAt": AT}), ("displayContracts", {"lines": []}),
            ("line", {"yesBid": None}), ("line", {"directNative": False}),
            ("quotes", {"asOf": "2026-09-17T17:58:00Z"}), ("quotes", {"source": "alternate_provider"}),
        ]
        for target, update in cases:
            with self.subTest(target=target, update=update):
                row = scoped_venue()
                snapshot = row["snapshot"]
                value = snapshot if target == "snapshot" else snapshot.get(target)
                if target == "line":
                    value = snapshot["displayContracts"]["lines"][0]
                elif target == "quotes":
                    value = snapshot["displayContracts"]["lines"][0]["evidence"]["quotes"]
                value.update(update)
                source = {"status": "partial", "data": {
                    "policy": {"autoVenueAllowed": False, "alternateVenueFallbackAllowed": False}, "markets": [row],
                }}
                _, items = self.project(record, {"predictionUniverse": source})
                self.assertEqual(items["silver"]["status"], "unavailable")

    def test_missing_timestamps_and_future_observations_cannot_be_checked(self):
        for at in (None, "not-a-time", "2026-10-01T18:00:00Z"):
            with self.subTest(at=at):
                _, items = self.project(run("balance-review", {"balance": checkpoint(asOf=at)}), {})
                self.assertEqual(items["balance"]["status"], "unavailable")


class SourceReasonTests(unittest.TestCase):
    """Settled rows say why they are missing; paused sources keep their place."""

    def project(self, record, evidence=None, products=PRODUCTS):
        result = review_sources(record, Store(evidence or {}), research_products=products, prediction_universe=UNIVERSE)
        return result, {item["id"]: item for item in result["items"]}

    def test_paused_pca_model_is_left_out_while_running_and_after_settling(self):
        paused = {"status": "pending", "asOf": AT, "updatedAt": AT, "fingerprint": None, "errorCode": "SOURCE_PAUSED",
                  "detail": {"elapsedMs": 5}}
        for state in ("running", "succeeded", "failed"):
            with self.subTest(state=state):
                _, items = self.project(run("portfolio-review", {"portfolioPca": paused}, state=state))
                self.assertNotIn("portfolioPca", items)
        _, running = self.project(run("portfolio-review", state="running"))
        self.assertNotIn("portfolioPca", running)

    def test_settled_rows_without_a_check_are_not_checked_and_running_rows_stay_checking(self):
        _, running = self.project(run("portfolio-review", state="running"))
        self.assertTrue(all(item["status"] == "checking" and "diagnostic" not in item for item in running.values()))
        _, settled = self.project(run("portfolio-review", state="failed"))
        for name in ("portfolio", "portfolioBalance", "portfolioOpenOrders", "marketSituation", "risk-ranges", "early-look"):
            with self.subTest(name=name):
                self.assertEqual(settled[name]["status"], "missing")
                self.assertEqual(settled[name]["diagnostic"]["code"], "SOURCE_NOT_ATTEMPTED")
                self.assertTrue(settled[name]["diagnostic"]["reason"])
        _, balance = self.project(run("balance-review", state="cancelled"))
        self.assertTrue(all(item["diagnostic"]["code"] == "SOURCE_NOT_ATTEMPTED" for item in balance.values()))
        _, prediction = self.project(run("prediction-markets-review", state="failed"))
        for name in ("risk-ranges", "hedgai-signals", "marketPrices", "kalshiContracts"):
            self.assertEqual(prediction[name]["diagnostic"]["code"], "SOURCE_NOT_ATTEMPTED")

    def test_settled_stage_left_checking_is_an_incomplete_check(self):
        for state, expected in (("running", None), ("succeeded", "SOURCE_CHECK_INCOMPLETE")):
            with self.subTest(state=state):
                _, items = self.project(run("portfolio-review", {"marketSituation": checkpoint("checking")}, state=state))
                self.assertEqual(items["marketSituation"]["status"], "checking" if expected is None else "missing")
                self.assertEqual(items["marketSituation"].get("diagnostic", {}).get("code"), expected)
        record = run("balance-review", {"balance": checkpoint("partial", detail={
            "liveVerified": True, "acquisition": {"supportingPending": True}})}, state="failed")
        evidence = {"balance": {"status": "partial", "liveVerified": True, "asOf": AT, "data": {
            "current": {"available": True, "status": "live", "source": "ibkr_live_session", "fromCache": False}}}}
        _, items = self.project(record, evidence)
        self.assertEqual(items["balance"]["status"], "ready")
        self.assertEqual(items["history"]["diagnostic"]["code"], "SOURCE_CHECK_INCOMPLETE")

    def test_dependents_untried_after_an_unverified_gateway_are_not_checked_never_disconnected(self):
        untried = checkpoint("failed", asOf=None, fingerprint=None, errorCode="IBKR_CONNECTION_UNVERIFIED_NOT_ATTEMPTED",
                             detail={"liveVerified": False, "elapsedMs": 1000, "attemptCount": 1})
        gateway = checkpoint("failed", errorCode="IBKR_GATEWAY_READINESS_TIMEOUT")
        record = run("portfolio-review", {"ibGateway": gateway, "portfolio": untried, "portfolioBalance": untried,
                                          "portfolioOpenOrders": untried})
        result, items = self.project(record, {"ibGateway": {"status": "unavailable", "asOf": AT, "liveVerified": False,
                                                            "errorCode": "IBKR_GATEWAY_READINESS_TIMEOUT"}})
        self.assertEqual(items["ibGateway"]["status"], "unavailable")
        self.assertEqual(items["ibGateway"]["diagnostic"], {"code": "IBKR_GATEWAY_READINESS_TIMEOUT"})
        for name in ("portfolio", "portfolioBalance", "portfolioOpenOrders"):
            with self.subTest(name=name):
                self.assertEqual(items[name]["status"], "missing")
                self.assertIsNone(items[name]["observedAt"])
                self.assertEqual(items[name]["diagnostic"], {"code": "IBKR_CONNECTION_UNVERIFIED_NOT_ATTEMPTED"})
                self.assertTrue(items[name]["requiresIbGateway"])
                # The stamp carries the Gateway check's clock; this row was never timed.
                self.assertNotIn("elapsedMs", items[name])
        _, balance = self.project(run("balance-review", {"balance": untried}))
        self.assertEqual({balance[key]["diagnostic"]["code"] for key in ("balance", "interestStatus", "history")},
                         {"IBKR_CONNECTION_UNVERIFIED_NOT_ATTEMPTED"})
        _, prediction = self.project(run("prediction-markets-review", {"predictionUniverse": untried, "portfolio": untried}))
        self.assertEqual(prediction["silver"]["diagnostic"], {"code": "IBKR_CONNECTION_UNVERIFIED_NOT_ATTEMPTED"})
        self.assertEqual(prediction["portfolio"]["status"], "missing")

    def test_verified_disconnect_keeps_unavailable_gateway_failure_on_dependents(self):
        failed = checkpoint("failed", errorCode="GATEWAY_UNAVAILABLE")
        _, items = self.project(run("portfolio-review", {"portfolio": failed}), {})
        self.assertEqual(items["portfolio"]["status"], "unavailable")
        self.assertEqual(items["portfolio"]["diagnostic"], {"code": "GATEWAY_UNAVAILABLE"})

    def test_gateway_stamped_dependents_never_show_the_gateway_check_time(self):
        gateway = checkpoint("failed", errorCode="GATEWAY_UNAVAILABLE", detail={"liveVerified": False, "elapsedMs": 81})
        stamped = checkpoint("failed", asOf=None, fingerprint=None, errorCode="GATEWAY_UNAVAILABLE",
                             detail={"liveVerified": False, "attemptCount": 1, "elapsedMs": 118})
        names = ("portfolio", "portfolioBalance", "portfolioOpenOrders", "portfolioPca")
        record = run("portfolio-review", {"ibGateway": gateway, **{name: stamped for name in names}}, state="failed")
        _, items = self.project(record, {"ibGateway": {"status": "unavailable", "asOf": AT, "liveVerified": False,
                                                       "errorCode": "GATEWAY_UNAVAILABLE"}})
        self.assertEqual(items["ibGateway"]["elapsedMs"], 81)
        for name in names:
            with self.subTest(name=name):
                self.assertEqual(items[name]["status"], "unavailable")
                self.assertEqual(items[name]["diagnostic"], {"code": "GATEWAY_UNAVAILABLE"})
                self.assertNotIn("elapsedMs", items[name])
        # Older unverified stamps carried the raw Gateway code; they were never timed either.
        legacy = {**stamped, "errorCode": "IBKR_GATEWAY_READINESS_TIMEOUT"}
        _, items = self.project(run("prediction-markets-review", {"portfolio": legacy, "balance": legacy}, state="failed"))
        self.assertTrue(all("elapsedMs" not in items[name] for name in ("portfolio", "balance")))
        # A real attempt that failed with a Gateway code stored its evidence and keeps its own time.
        attempted = checkpoint("failed", errorCode="GATEWAY_UNAVAILABLE", detail={"liveVerified": False, "elapsedMs": 3945})
        _, items = self.project(run("portfolio-review", {"portfolio": attempted}, state="failed"),
                                {"portfolio": {"status": "unavailable", "errorCode": "GATEWAY_UNAVAILABLE"}})
        self.assertEqual((items["portfolio"]["status"], items["portfolio"]["elapsedMs"]), ("unavailable", 3945))

    def test_a_succeeded_review_that_never_captured_a_source_did_not_end_early(self):
        record = run("prediction-markets-review", {"portfolio": checkpoint(), "predictionResearch": checkpoint()})
        for state, reason in (("succeeded", "This review's capture did not include this source."),
                              ("failed", "This review ended before this source was checked."),
                              ("cancelled", "This review ended before this source was checked.")):
            with self.subTest(state=state):
                _, items = self.project({**record, "state": state})
                self.assertEqual(items["balance"]["status"], "missing")
                self.assertEqual(items["balance"]["diagnostic"], {
                    "code": "SOURCE_NOT_ATTEMPTED", "reason": reason,
                    "remedy": "Refresh this review to check this source. The saved capture stays unchanged."})

    def test_a_succeeded_portfolio_review_keeps_its_own_state_after_research_rows(self):
        # Research rows are projected before Market data; their coverage
        # statuses must never stand in for the run's own state.
        bare = run("portfolio-review", {"portfolio": checkpoint()})
        covered = run("portfolio-review", {"portfolio": checkpoint(), "researchCoverage": checkpoint(),
                                           "exactResearchDocuments": checkpoint()})
        for state, reason in (("succeeded", "This review's capture did not include this source."),
                              ("failed", "This review ended before this source was checked."),
                              ("cancelled", "This review ended before this source was checked.")):
            with self.subTest(state=state):
                _, items = self.project({**bare, "state": state})
                for name in ("risk-ranges", "early-look", "marketSituation"):
                    self.assertEqual((items[name]["status"], items[name]["diagnostic"]["code"]), ("missing", "SOURCE_NOT_ATTEMPTED"))
                    self.assertEqual(items[name]["diagnostic"]["reason"], reason)
                _, items = self.project({**covered, "state": state}, research())
                self.assertEqual(items["risk-ranges"]["status"], "ready")
                self.assertEqual(items["marketSituation"]["diagnostic"]["reason"], reason)

    def test_interest_rows_follow_the_balance_capture_they_ride_on(self):
        failed = {"balance": {"status": "unavailable", "liveVerified": False, "errorCode": "BALANCE_HTTP_ERROR",
                              "data": {"current": None, "interestStatus": None, "history": None}}}
        for state in ("failed", "succeeded", "running"):
            with self.subTest(state=state):
                _, items = self.project(run("balance-review", {"balance": checkpoint(
                    "failed", errorCode="BALANCE_HTTP_ERROR", detail={"elapsedMs": 900})}, state=state), failed)
                self.assertEqual(items["balance"]["status"], "unavailable")
                for key in ("interestStatus", "history"):
                    # A failed balance capture returns before its interest reads begin.
                    self.assertEqual(items[key]["status"], "missing")
                    self.assertEqual(items[key]["diagnostic"]["code"], "SOURCE_NOT_ATTEMPTED")
                    self.assertEqual(items[key]["diagnostic"]["reason"],
                                     "Interest data is read only after a verified IBKR balance, which this review did not capture.")
        _, items = self.project(run("balance-review", {"balance": checkpoint("checking")}, state="failed"))
        self.assertEqual({items[key]["diagnostic"]["code"] for key in ("interestStatus", "history")}, {"SOURCE_CHECK_INCOMPLETE"})
        live = {"balance": {"status": "partial", "liveVerified": True, "asOf": AT, "data": {
            "current": {"available": True, "status": "live", "source": "ibkr_live_session", "fromCache": False}}}}
        _, items = self.project(run("balance-review", {"balance": checkpoint("partial")}, state="succeeded"), live)
        # The balance capture made these reads; an empty result stays plainly missing.
        self.assertEqual(items["balance"]["status"], "ready")
        self.assertTrue(all(items[key]["status"] == "missing" and "diagnostic" not in items[key]
                            for key in ("interestStatus", "history")))

    def test_gateway_stamped_prediction_markets_are_not_checked_unless_a_disconnect_settles_forecastex(self):
        stamp = checkpoint("failed", asOf=None, fingerprint=None, detail={"liveVerified": False, "attemptCount": 1})
        for code in ("IBKR_GATEWAY_READINESS_TIMEOUT", "IBKR_SERVICE_UNAVAILABLE"):
            with self.subTest(code=code):
                _, items = self.project(run("prediction-markets-review",
                                            {"predictionUniverse": {**stamp, "errorCode": code}}, state="failed"))
                for market in ("gold", "silver"):
                    # An unverified check never reads as a disconnect, even for ForecastEx.
                    self.assertEqual(items[market]["status"], "missing")
                    self.assertEqual(items[market]["diagnostic"], {"code": "IBKR_CONNECTION_UNVERIFIED_NOT_ATTEMPTED"})
        for code in ("GATEWAY_UNAVAILABLE", "IBKR_GATEWAY_NOT_AUTHENTICATED", "IBKR_GATEWAY_NOT_CONNECTED"):
            with self.subTest(code=code):
                _, items = self.project(run("prediction-markets-review",
                                            {"predictionUniverse": {**stamp, "errorCode": code}}, state="failed"))
                # A verified disconnect settles the Gateway-dependent ForecastEx
                # book unavailable (AGENTS.md); Kalshi was simply never read.
                self.assertEqual(items["silver"], {"id": "silver", "label": "Silver · ForecastEx", "status": "unavailable",
                                                   "observedAt": None, "requiresIbGateway": True, "diagnostic": {"code": code}})
                self.assertEqual(items["gold"]["status"], "missing")
                self.assertEqual(items["gold"]["diagnostic"]["code"], "SOURCE_NOT_ATTEMPTED")
        # A market read that really failed without a Gateway code stays plainly missing.
        _, items = self.project(run("prediction-markets-review", {"predictionUniverse": {
            **stamp, "errorCode": "REVIEW_SOURCE_UNAVAILABLE"}}, state="failed"))
        self.assertNotIn("diagnostic", items["gold"])
        # Evidence-backed failures keep their own projection.
        _, items = self.project(run("prediction-markets-review", {"predictionUniverse": checkpoint(
            "failed", errorCode="IBKR_GATEWAY_READINESS_TIMEOUT")}, state="failed"))
        self.assertNotIn("diagnostic", items["gold"])

    def test_paused_alpha_code_scan_keeps_its_place_as_pending(self):
        evidence = {"predictionResearch": {"date": "2026-09-17", "snapshots": {},
                                           "alphaCodesCapture": {"status": "pending", "reason": "paused"}}}
        for state in ("running", "succeeded", "failed"):
            with self.subTest(state=state):
                result, items = self.project(run("prediction-markets-review",
                                                 {"predictionResearch": checkpoint("partial")}, state=state), evidence)
                self.assertEqual(items["alphaCodes"], {
                    "id": "alphaCodes", "label": "Alpha codes", "status": "pending", "observedAt": None,
                    "diagnostic": {"code": "SOURCE_PAUSED",
                                   "reason": "Paused for now. This source returns when it is re-enabled."}})
                ids = [item["id"] for item in result["items"]]
                # It follows the captured research publications.
                self.assertEqual(ids.index("alphaCodes"), ids.index("inflation-nowcast") + 1)
        # A capture that ran the scan, or predates the pause, has no such row.
        enabled = {"predictionResearch": {"date": "2026-09-17", "snapshots": {}, "alphaCodes": {"codes": []}}}
        for record, saved in ((run("prediction-markets-review", {"predictionResearch": checkpoint("partial")}), enabled),
                              (run("prediction-markets-review", state="running"), evidence)):
            _, items = self.project(record, saved)
            self.assertNotIn("alphaCodes", items)
        _, items = self.project(run("portfolio-review", {"dailyResearch": checkpoint()}),
                                {"dailyResearch": evidence["predictionResearch"]})
        self.assertNotIn("alphaCodes", items)

    def test_checkpointed_alpha_code_pause_is_pending_from_the_start(self):
        paused = {"status": "pending", "asOf": AT, "updatedAt": AT, "fingerprint": None, "errorCode": "SOURCE_PAUSED"}
        recorded = {"predictionResearch": {"date": "2026-09-17", "snapshots": {},
                                           "alphaCodesCapture": {"status": "pending", "reason": "paused"}}}
        expected = {"id": "alphaCodes", "label": "Alpha codes", "status": "pending", "observedAt": None,
                    "diagnostic": {"code": "SOURCE_PAUSED", "reason": "Paused for now. This source returns when it is re-enabled."}}
        cases = (("running", {"alphaCodes": paused}, {}),
                 # A verified disconnect ends the review before research; the pause still holds its place.
                 ("failed", {"alphaCodes": paused, "predictionUniverse": checkpoint(
                     "failed", asOf=None, fingerprint=None, errorCode="GATEWAY_UNAVAILABLE")}, {}),
                 # The checkpoint and the research evidence both record it; one row remains.
                 ("succeeded", {"alphaCodes": paused, "predictionResearch": checkpoint("partial")}, recorded))
        for state, dependencies, evidence in cases:
            with self.subTest(state=state):
                result, items = self.project(run("prediction-markets-review", dependencies, state=state), evidence)
                self.assertEqual(items["alphaCodes"], expected)
                ids = [item["id"] for item in result["items"]]
                self.assertEqual(ids.count("alphaCodes"), 1)
                self.assertEqual(ids[-1], "alphaCodes")

    def test_research_coverage_states_have_late_missing_not_due_and_not_checked_reasons(self):
        products = [{"id": "cftc-positioning", "label": "CFTC Positioning"}]
        record = run("portfolio-review", {key: checkpoint() for key in ("researchCoverage", "exactResearchDocuments")})
        cases = (({"status": "late", "latestPublicationDate": "2026-09-10", "expectedPublicationDate": "2026-09-17"},
                  "RESEARCH_PUBLICATION_LATE"),
                 ({"status": "missing", "expectedPublicationDate": "2026-09-17"}, "RESEARCH_PUBLICATION_MISSING"),
                 ({"status": "not due"}, "RESEARCH_NOT_DUE"),
                 ({"status": "indexing"}, "SOURCE_CHECK_INCOMPLETE"),
                 ({"status": "available", "latestPublicationDate": "2026-09-17"}, "RESEARCH_PUBLICATION_NOT_CAPTURED"))
        for row, code in cases:
            with self.subTest(code=code):
                evidence = {"researchCoverage": {"products": [{"product": "cftc-positioning", **row}]},
                            "exactResearchDocuments": {"products": []}}
                _, items = self.project(record, evidence, products)
                self.assertEqual(items["cftc-positioning"]["status"], "missing")
                self.assertEqual(items["cftc-positioning"]["diagnostic"]["code"], code)
                self.assertEqual("remedy" in items["cftc-positioning"]["diagnostic"], code != "RESEARCH_NOT_DUE")
        _, items = self.project(run("portfolio-review", {"researchCoverage": checkpoint()}),
                                {"researchCoverage": {"products": [{"product": "cftc-positioning", "status": "available"}]}}, products)
        self.assertEqual(items["cftc-positioning"]["diagnostic"]["code"], "SOURCE_NOT_ATTEMPTED")
        _, items = self.project(record, {"researchCoverage": {"products": []}, "exactResearchDocuments": {"products": []}}, products)
        self.assertEqual(items["cftc-positioning"]["diagnostic"]["code"], "RESEARCH_PUBLICATION_NOT_CAPTURED")

    def test_every_missing_research_publication_has_a_reason(self):
        record = run("prediction-markets-review", {"predictionResearch": checkpoint("partial")})
        evidence = {"predictionResearch": {"date": "2026-09-17", "snapshots": {
            "crypto-quant": {"date": "2026-09-17", "snapshotType": "crypto-quant", "status": "failed"}}}}
        _, items = self.project(record, evidence)
        missing = [item for item in items.values() if item["status"] == "missing"]
        self.assertTrue(missing)
        self.assertTrue(all(item.get("diagnostic", {}).get("code") for item in missing))
        self.assertEqual(items["crypto-quant"]["diagnostic"]["code"], "RESEARCH_PUBLICATION_REJECTED")
        self.assertEqual(items["inflation-nowcast"]["diagnostic"]["code"], "RESEARCH_PUBLICATION_NOT_CAPTURED")
        structure = {"dailyResearch": {"date": "2026-09-17", "marketStructure": {"date": "2026-09-17", "status": "failed"}}}
        _, items = self.project(run("portfolio-review", {"dailyResearch": checkpoint()}), structure,
                                [{"id": "market-structure", "label": "Market Structure"}])
        self.assertEqual(items["market-structure"]["diagnostic"]["code"], "RESEARCH_PUBLICATION_REJECTED")

    def test_elapsed_time_is_forwarded_only_for_settled_rows_that_recorded_it(self):
        timed = checkpoint(detail={"liveVerified": True, "elapsedMs": 1400})
        _, items = self.project(run("portfolio-review", {"ibGateway": timed, "portfolio": timed,
                                                         "portfolioOpenOrders": checkpoint("checking", detail={"elapsedMs": 30})},
                                    state="running"),
                                {"ibGateway": {"status": "available", "liveVerified": True, "freshness": "live",
                                               "asOf": AT, "data": {"connected": True}}})
        self.assertEqual(items["ibGateway"]["elapsedMs"], 1400)
        self.assertEqual(items["portfolio"]["elapsedMs"], 1400)
        self.assertNotIn("elapsedMs", items["portfolioOpenOrders"])
        self.assertNotIn("elapsedMs", items["risk-ranges"])
        for value in (True, -1, 1.5, 600_001, "1400", None):
            with self.subTest(value=value):
                _, items = self.project(run("portfolio-review", {"portfolio": checkpoint(
                    detail={"liveVerified": True, "elapsedMs": value})}))
                self.assertNotIn("elapsedMs", items["portfolio"])

    def test_archive_row_keeps_its_not_checked_reason(self):
        record = run("portfolio-review", {"portfolioRefreshResearch": checkpoint("checking")}, state="failed")
        _, items = self.project(record, {})
        self.assertEqual(items["portfolioRefreshResearch"]["status"], "missing")
        self.assertEqual(items["portfolioRefreshResearch"]["diagnostic"]["code"], "SOURCE_CHECK_INCOMPLETE")
        self.assertNotIn("detail", items["portfolioRefreshResearch"])

    def test_reasons_never_change_ready_rows_or_saved_evidence(self):
        evidence = research()
        original = copy.deepcopy(evidence)
        record = run("portfolio-review", {key: checkpoint() for key in ("portfolio", "researchCoverage", "exactResearchDocuments")})
        _, items = self.project(record, evidence)
        self.assertEqual(items["risk-ranges"], {"id": "risk-ranges", "label": "Risk Ranges", "status": "ready",
                                                "observedAt": "2026-09-17", "publishedAt": "2026-09-17"})
        self.assertEqual(items["portfolio"], {"id": "portfolio", "label": "IBKR holdings", "status": "ready",
                                              "observedAt": AT, "requiresIbGateway": True})
        self.assertEqual(evidence, original)


if __name__ == "__main__":
    unittest.main()
