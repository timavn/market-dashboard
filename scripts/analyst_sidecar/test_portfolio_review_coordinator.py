from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from dataclasses import replace
from hashlib import sha256
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch


SIDECAR_DIR = Path(__file__).resolve().parent
if str(SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(SIDECAR_DIR))

_APP_DATA_DIR = tempfile.TemporaryDirectory(prefix="analyst-coordinator-test-")
os.environ.setdefault("ANALYST_DATA_DIR", _APP_DATA_DIR.name)
os.environ.setdefault("ANALYST_TEXTRACT_FALLBACK", "false")

import app as analyst_app
from portfolio_review import MAX_PACKET_BYTES, PortfolioReviewStore, public_run
from review_runs_v2 import ReviewCoordinatorV2, ReviewRunV2Store, public_review_run


POSITION_COLUMNS = [
    "account",
    "symbol",
    "contract",
    "conId",
    "category",
    "expiration",
    "strike",
    "right",
    "eventSide",
    "currency",
    "quantity",
    "averageCost",
    "costBasis",
    "markState",
    "valuationPrice",
    "marketValue",
    "valuationPnl",
    "unavailableReason",
]


def verified_empty_portfolio() -> dict:
    """A verified zero-position book with no invented market or position values."""
    return {
        "status": "available",
        "liveVerified": True,
        "freshness": "live",
        "asOf": "2026-08-31T14:00:00Z",
        "data": {
            "positionTable": {
                "columns": POSITION_COLUMNS,
                "rows": [],
                "rowCount": 0,
            },
            "accountSummaries": [
                {
                    "account": "TEST",
                    "summary": {"NetLiquidation": {"value": 0}},
                }
            ],
            "pnl": [{"account": "TEST", "pnl": {"dailyPnL": 0}}],
        },
    }


def coordinator_sources() -> analyst_app.PortfolioReviewSources:
    registered_products = [
        *analyst_app.REGISTRY["products"],
        analyst_app.INFLATION_PRODUCT,
    ]

    async def portfolio_context():
        return verified_empty_portfolio()

    async def market_situation_context():
        return {
            "status": "available",
            "freshness": "live",
            "liveVerified": True,
            "asOf": "2026-08-31T14:00:00Z",
            "data": {},
        }

    async def security_intelligence_symbols(_symbols, _market_date):
        return {
            "coverage": {"state": "complete"},
            "bySymbol": {},
            "products": [
                {"id": product["id"], "status": "indexed"}
                for product in registered_products
            ],
            "generatedAt": "2026-08-31T14:00:00Z",
        }

    async def security_intelligence_universe(_market_date):
        return {"scanComplete": True, "bySymbol": {}}

    return analyst_app.PortfolioReviewSources(
        portfolio_context=portfolio_context,
        project_portfolio_context=lambda value: value,
        research_coverage=lambda: {
            "products": [
                {
                    "product": product["id"],
                    "label": product.get("label") or product["id"],
                    "status": "indexed",
                    "latestPublicationDate": "2026-08-31",
                    "expectedPublicationDate": "2026-08-31",
                }
                for product in registered_products
            ],
            "sync": {"status": "ready", "lastSyncAt": "2026-08-31T14:00:00Z"},
        },
        exact_review_documents=lambda: {
            "products": [{
                "product": "market-structure",
                "publicationDate": "2026-08-31",
                "excerpts": [{
                    "excerpt": "USD and rates are stable in the current market context.",
                    "citation": {
                        "id": "cite_0123456789abcdef0123456789abcdef",
                        "product": "market-structure",
                        "publicationDate": "2026-08-31",
                        "sourceUri": "test://market-structure",
                    },
                }],
            }],
        },
        market_situation_context=market_situation_context,
        security_intelligence_symbols=security_intelligence_symbols,
        security_intelligence_universe=security_intelligence_universe,
        current_alpha_codes=lambda market_date: {
            "marketDate": market_date,
            "scanComplete": True,
            "scannedExcerptCount": 0,
            "codes": [],
            "citations": [],
        },
        market_situation_research=lambda: ({}, []),
        market_date=lambda: "2026-08-31",
    )


def verified_prediction_universe(*, failed_market_id: str | None = None) -> dict:
    markets = []
    observed = datetime.now(timezone.utc)
    as_of = observed.isoformat()
    expires = (observed + timedelta(seconds=85)).isoformat()
    for market_id, asset, venue in analyst_app.PREDICTIVE_REVIEW_UNIVERSE:
        failed = market_id == failed_market_id
        source = "ibkr_tws_forecastex_live" if venue == "forecastex" else "kalshi_batch_orderbooks_v2"
        markets.append(
            {
                "marketId": market_id,
                "asset": asset,
                "requestedVenue": venue,
                "status": "partial" if failed else "available",
                "errorCode": "PINNED_VENUE_DATA_INCOMPLETE" if failed else None,
                "snapshot": {
                    "marketId": market_id,
                    "selectedVenueId": venue,
                    "displaySelection": {"status": "available", "venueId": venue},
                    "displayContracts": {
                        "status": "partial" if failed else "available",
                        "asOf": as_of,
                        "bookExpiresAt": expires,
                        "event": {
                            "ticker": f"{market_id}-event",
                            "resolverSymbol": "NQU26" if market_id == "nasdaq100" else None,
                            "closeTime": "2099-09-03T20:00:00Z",
                            "status": "open",
                            "reportMonth": "2026-08",
                            "releaseKey": "KXCPIYOY#2026-08",
                        },
                        "lines": [
                            {
                                "ticker": f"{market_id}-contract",
                                "threshold": 100,
                                "isNearest": True,
                                "yesBid": None if failed else 0.44,
                                "yesAsk": None if failed else 0.46,
                                "noBid": None if failed else 0.54,
                                "noAsk": None if failed else 0.56,
                                "source": source,
                                "directNative": True,
                                "evidence": {"quotes": {"source": source, "fit": "exact", "asOf": as_of}},
                            }
                        ],
                    },
                    "venues": {
                        venue: {
                            "settlementBasis": {
                                "instrument": "NQU26" if market_id == "nasdaq100" else f"Official {asset} settlement",
                                "status": "verified",
                            },
                            "reference": {
                                "instrument": {"displaySymbol": "NQU26", "secType": "FUT"} if market_id == "nasdaq100" else None,
                                "spot": {
                                    "status": "available",
                                    "availability": "live",
                                    "label": asset,
                                    "value": 100,
                                    "asOf": as_of,
                                    "expiresAt": expires,
                                    "fit": "exact",
                                    "source": "ibkr_live_quote",
                                },
                            },
                            "settlementState": "open",
                        },
                    },
                    "riskRange": {
                        "status": "available",
                        "date": "2026-08-31",
                        "trend": "Bullish",
                        "lrr": 95,
                        "hrr": 105,
                        "source": "hedgeye-risk-ranges-email",
                    },
                    "factors": {"trade": {"direction": "BULLISH", "status": "available", "source": "momo-tracker", "date": "2026-08-31"}},
                    "forecastComparison": {
                        "status": "available", "eventTicker": f"{market_id}-event", "reportMonth": "2026-08", "releaseKey": "KXCPIYOY#2026-08",
                        "hedgeye": {"status": "available", "baseValue": 3.47, "source": "hedgeye-inflation-nowcast", "asOf": "2026-08-13"},
                        "clevelandFed": {"status": "available", "value": 3.38, "source": "cleveland_fed_inflation_nowcasting", "asOf": "2026-09-02"},
                    },
                    "session": {"state": "open"},
                },
            }
        )
    available_count = sum(row["status"] == "available" for row in markets)
    return {
        "status": "available" if available_count == len(analyst_app.PREDICTIVE_REVIEW_UNIVERSE) else "partial",
        "liveVerified": False,
        "freshness": "current_monitor",
        "asOf": "2026-08-31T16:00:00Z",
        "data": {
            "markets": markets,
            "availableCount": available_count,
            "requestedCount": len(analyst_app.PREDICTIVE_REVIEW_UNIVERSE),
            "policy": {
                "autoVenueAllowed": False,
                "alternateVenueFallbackAllowed": False,
                "recommendationsAllowed": False,
            },
        },
    }


def verified_balance_context() -> dict:
    return {
        "status": "available",
        "provider": "ibkr",
        "liveVerified": True,
        "freshness": "live_with_dated_verified_history",
        "asOf": "2026-08-31T16:00:00Z",
        "data": {
            "current": {
                "available": True,
                "status": "live",
                "source": "ibkr_live_session",
                "accountId": "TEST",
                "currency": "USD",
                "observedAt": "2026-08-31T16:00:00Z",
                "fromCache": False,
                "exposure": {
                    "available": True,
                    "netLiquidation": 100_000,
                    "longMarketValue": 70_000,
                    "shortMarketValue": 20_000,
                    "grossMarketValue": 90_000,
                    "netMarketValue": 50_000,
                    "grossPercent": 90,
                },
                "margin": {
                    "available": True,
                    "status": "live",
                    "source": "ibkr_live_session",
                    "health": "healthy",
                    "netLiquidation": 100_000,
                    "availableFunds": 40_000,
                    "buyingPower": 160_000,
                    "excessLiquidity": 55_000,
                },
                "settlement": {"state": "settled", "date": "2026-08-31"},
                "activity": {"openOrderCount": 0, "sameDayExecutionCount": 1},
                "cash": {
                    "securitiesCashFloor": 25_000,
                    "commodityCashFloor": 5_000,
                    "addLongRoom": 20_000,
                    "trimRequired": 0,
                },
                "buffer": {"totalReserve": 10_000, "addLongRoom": 10_000},
                "capacity": {"available": True, "status": "live"},
            },
            "interestStatus": {
                "available": True,
                "status": "verified",
                "generatedAt": "2026-08-31T16:00:00Z",
                "mtd": {"liveNetAccrued": -12.50, "verifiedDebit": 10.25},
                "forecast": {"status": "issued", "lower": 1, "point": 2, "upper": 3},
                "latest": {"actual": 2.25, "residual": 0.25},
                "stockBorrowFees": {"status": "verified_none"},
            },
            "history": {
                "available": True,
                "status": "verified_history",
                "generatedAt": "2026-08-31T16:00:00Z",
                "daily": [{"date": "2026-08-29", "debitAmount": 2.25}],
                "forecasts": [{"value_date": "2026-08-29", "point": 2}],
                "postings": [{"posted_date": "2026-08-29", "amount": -2.25}],
            },
        },
    }



def setup_board_fixture():
    return {
        "version": 1, "asOf": "2026-10-10T17:00:00.000Z", "marketDate": "2026-10-09",
        "sources": {"riskRanges": "2026-10-09", "cryptoQuant": "2026-10-09", "inflationNowcast": "2026-10-06T11:48:50+00:00"},
        "sourceStatus": {key: "ready" for key in ("riskRanges", "cryptoQuant", "hedgai", "securityIntelligence", "nowcast", "quotes", "kalshi")},
        "rows": [
            {"id": "bitcoin", "label": "Bitcoin", "group": "crypto", "events": [{"series": "KXBTCD", "eventTicker": "KXBTCD-26OCT1017"}],
             "price": {"value": 82627, "symbol": "BTC", "fit": "close", "asOf": "2026-10-10T16:45:00Z"},
             "range": {"low": 81450, "high": 87366, "trend": "BULLISH", "ticker": "BITCOIN", "fit": "exact"},
             "position": 0.199, "tick": {"position": "Buy", "direction": "BULLISH", "date": "2026-09-29", "ticker": "IBIT"},
             "trade": {"direction": "BULLISH", "date": "2026-09-10"}, "trend": "BULLISH", "setup": {"side": "LONG", "reason": None}},
            {"id": "cpi", "label": "CPI YoY", "group": "inflation", "events": [{"series": "KXCPIYOY", "eventTicker": "KXCPIYOY-26SEP"}],
             "forecast": {"available": True, "lower": 3.63, "base": 3.74, "upper": 3.85, "publishedAt": "2026-10-06T11:48:50+00:00"}},
        ],
    }

class PortfolioReviewCoordinatorIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="portfolio-review-coordinator-")
        self.store = PortfolioReviewStore(Path(self.temp.name) / "portfolio.sqlite3")
        self.original_store = analyst_app.portfolio_review_store
        self.original_coordinator_state = dict(
            analyst_app.runtime_state.get("portfolioReviewCoordinator") or {}
        )
        analyst_app.portfolio_review_store = self.store

    async def asyncTearDown(self):
        pending = list(analyst_app.portfolio_review_tasks.values())
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        analyst_app.portfolio_review_store = self.original_store
        analyst_app.runtime_state["portfolioReviewCoordinator"] = (
            self.original_coordinator_state
        )
        self.temp.cleanup()

    async def launch(self, request_id: str = "request-1") -> dict:
        started = await analyst_app._start_portfolio_review_run(
            "session-1",
            request_id,
            sources=coordinator_sources(),
        )
        task = analyst_app.portfolio_review_tasks[started["runId"]]
        await task
        return self.store.get(started["runId"])

    async def test_real_coordinator_finalizes_hashes_packets_persistence_and_acceptance(
        self,
    ):
        completed = await self.launch()

        self.assertIn(completed["status"], {"ready", "partial"})
        self.assertIsNotNone(completed["completedAt"])
        self.assertIsNone(completed["errorCode"])
        self.assertTrue(completed["sourceFingerprints"])
        self.assertTrue(
            all(
                re.fullmatch(r"[a-f0-9]{64}", fingerprint)
                for fingerprint in completed["sourceFingerprints"].values()
            )
        )
        self.assertEqual(len(completed["sections"]), 8)
        self.assertTrue(
            all(
                section["status"] not in {"pending", "loading"}
                for section in completed["sections"]
            )
        )
        self.assertGreaterEqual(len(completed["packets"]), 3)
        for packet in completed["packets"]:
            self.assertEqual(
                packet["sha256"],
                sha256(packet["jsonFragment"].encode("utf-8")).hexdigest(),
            )
            self.assertLess(packet["sizeBytes"], MAX_PACKET_BYTES)

        accepted = self.store.accept(completed["runId"])
        self.assertIsNotNone(accepted["acceptedAt"])

    async def test_v2_production_handler_is_deterministic_bounded_and_packet_free(self):
        v2_store = ReviewRunV2Store(Path(self.temp.name) / "reviews-v2.sqlite3")
        order_snapshot = {"ok": True, "status": "live", "complete": True, "liveVerified": True, "from_cache": False,
                          "source": "ibkr_all_open_orders", "orders": [], "accounts": ["TEST"], "asOf": "2026-08-31T14:00:00Z"}
        read_orders = AsyncMock(return_value=order_snapshot)

        async def production_handler(context):
            return await analyst_app._portfolio_review_v2_handler(
                context,
                sources=replace(coordinator_sources(), open_orders=read_orders),
            )

        coordinator = ReviewCoordinatorV2(
            v2_store,
            {"portfolio-review": production_handler},
        )
        started = await coordinator.start(
            review_kind="portfolio-review",
            session_id="v2-session-1",
            request_id="v2-request-1",
        )
        await coordinator.tasks[started["runId"]]
        completed = v2_store.get(started["runId"])
        projected = public_review_run(completed)

        self.assertEqual(completed["state"], "succeeded")
        self.assertEqual(completed["phase"], "terminal")
        read_orders.assert_awaited_once()
        self.assertEqual(v2_store.read_evidence(completed, "portfolioOpenOrders"), order_snapshot)
        self.assertEqual(completed["outcome"], "ready")
        self.assertIsNotNone(completed["baselineAcceptedAt"])
        self.assertEqual(len(completed["sections"]), 7)
        research_review = next(section for section in completed["sections"] if section["id"] == "portfolio-research-review")
        self.assertEqual(research_review["reviewedCount"], 0)
        self.assertFalse(research_review["historicalHoldings"])
        self.assertTrue(completed["sourceFingerprints"])
        self.assertEqual(
            set(completed["dependencies"]),
            {
                "portfolio",
                "researchCoverage",
                "exactResearchDocuments",
                "marketSituation",
                "heldResearchEvents",
                "researchEventUniverse",
                "alphaCurrentDate",
                "marketSituationResearch",
                "portfolioOpenOrders",
            },
        )
        self.assertTrue(
            all(
                re.fullmatch(r"[a-f0-9]{64}", fingerprint)
                for fingerprint in completed["sourceFingerprints"].values()
            )
        )
        self.assertIn("# Portfolio Review", completed["reportMarkdown"])
        self.assertNotIn("packets", completed)
        self.assertNotIn("sections", projected)
        self.assertNotIn("diagnostics", projected)

    async def test_v2_rollup_is_captured_once_and_restored_without_research_reads(self):
        from portfolio_brief import attach_portfolio_briefs
        store = ReviewRunV2Store(Path(self.temp.name) / "daily-rollup.sqlite3")
        evidence = {"date": "2026-08-31", "snapshots": {"early-look": {
            "date": "2026-08-31", "publishedAt": "2026-08-31T12:00:00Z",
            "article": {"headline": "Today's outlook", "feedUrl": "https://app.hedgeye.com/feed/123",
                        "bodyText": "The next quarter could slow while inflation remains elevated."}}}}
        reader = AsyncMock(return_value=evidence)
        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, sources=replace(coordinator_sources(), daily_research=reader))
        coordinator = ReviewCoordinatorV2(store, {"portfolio-review": handler})
        run = await coordinator.start(review_kind="portfolio-review", session_id="rollup", request_id="rollup")
        await coordinator.tasks[run["runId"]]
        saved = store.get(run["runId"])
        self.assertEqual(saved["state"], "succeeded")
        self.assertEqual(store.read_evidence(saved, "dailyResearch"), evidence)
        self.assertIn("next quarter could slow", saved["reportMarkdown"])
        self.assertIn("| Exposure | Value | Weight |", saved["reportMarkdown"])
        self.assertNotIn("Research reviewed", saved["reportMarkdown"])
        self.assertNotIn("Coverage & data quality", saved["reportMarkdown"])
        conversation = {"id": saved["conversationId"], "kind": "portfolio-review", "messages": [{"role": "assistant", "text": saved["reportMarkdown"]}]}
        restored = attach_portfolio_briefs(conversation, store, lambda value: value)
        brief = restored["messages"][0]["portfolioBrief"]
        self.assertTrue(brief["dailyRollup"]["sections"])
        self.assertTrue(brief["dailyRollup"]["citations"])
        self.assertEqual(brief["comparison"]["status"], "unavailable")
        reader.assert_awaited_once_with("2026-08-31")

    @patch.dict(os.environ, {"ANALYST_PORTFOLIO_PCA_ENABLED": "true"})
    async def test_pca_reads_saved_research_for_verified_account_after_disconnect(self):
        store = ReviewRunV2Store(Path(self.temp.name) / "factor-offline.sqlite3")
        capture = verified_empty_portfolio()
        position = {"account": "TEST", "symbol": "ABC", "quantity": 10, "marketValue": 1000,
                    "valuationPrice": 100, "category": "other", "markState": "live"}
        capture["data"]["positionTable"].update(rows=[[position.get(key) for key in POSITION_COLUMNS]], rowCount=1)
        capture["data"]["accountSummaries"][0]["summary"]["NetLiquidation"]["value"] = 100000
        pca_reader = AsyncMock(return_value={})
        sources = replace(coordinator_sources(),
                          portfolio_context=AsyncMock(return_value={"liveVerified": False, "freshness": "unavailable"}),
                          portfolio_reference=lambda: {"portfolio": capture, "verifiedAtCapture": True},
                          pca_research=pca_reader)
        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, sources=sources)
        coordinator = ReviewCoordinatorV2(store, {"portfolio-review": handler})
        run = await coordinator.start(review_kind="portfolio-review", session_id="offline-factors", request_id="offline-factors")
        await coordinator.tasks[run["runId"]]
        saved = store.get(run["runId"])
        self.assertEqual(saved["state"], "succeeded")
        self.assertEqual(saved["dependencies"]["portfolioPca"]["status"], "failed")
        self.assertNotIn("portfolioFactors", saved["dependencies"])
        self.assertNotIn("## PCA risk", saved["reportMarkdown"])
        pca_reader.assert_awaited_once_with("TEST")

    @patch.dict(os.environ, {"ANALYST_PORTFOLIO_PCA_ENABLED": "true"})
    async def test_review_captures_pca_and_preserves_its_model_date(self):
        store = ReviewRunV2Store(Path(self.temp.name) / "pca-review.sqlite3")
        capture = verified_empty_portfolio()
        position = {"account": "TEST", "symbol": "ABC", "quantity": 10, "marketValue": 1000,
                    "valuationPrice": 100, "category": "other", "markState": "live"}
        capture["data"]["positionTable"].update(rows=[[position.get(key) for key in POSITION_COLUMNS]], rowCount=1)
        capture["data"]["accountSummaries"][0]["summary"]["NetLiquidation"]["value"] = 100000
        snapshot = {"status": "partial", "asOf": "2026-08-28", "accountId": "TEST", "source": "pca_saved_snapshot"}
        section = {"id": "pca-risk", "title": "PCA risk", "asOf": "2026-08-28", "citationIds": [],
                   "blocks": [{"type": "paragraph", "text": "Captured portfolio · Aug 28, 2026", "citationIds": []}]}
        reader = AsyncMock(return_value=snapshot)
        sources = replace(coordinator_sources(), portfolio_context=AsyncMock(return_value=capture), pca_research=reader)
        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, sources=sources)
        coordinator = ReviewCoordinatorV2(store, {"portfolio-review": handler})
        with patch.object(analyst_app, "build_portfolio_pca_section", return_value=section) as project:
            run = await coordinator.start(review_kind="portfolio-review", session_id="pca", request_id="pca")
            await coordinator.tasks[run["runId"]]
        saved = store.get(run["runId"])
        self.assertEqual(saved["state"], "succeeded")
        checkpoint = saved["dependencies"]["portfolioPca"]
        self.assertEqual((checkpoint["status"], checkpoint["asOf"]), ("ready", "2026-08-28"))
        self.assertEqual({key: checkpoint["detail"][key] for key in ("historicalOnly", "executable")},
                         {"historicalOnly": True, "executable": False})
        self.assertGreaterEqual(checkpoint["detail"]["elapsedMs"], 0)
        self.assertEqual(store.read_evidence(saved, "portfolioPca"), snapshot)
        self.assertNotIn("portfolioFactors", saved["dependencies"])
        self.assertIn("PCA risk", saved["reportMarkdown"])
        self.assertIn("Captured portfolio · Aug 28, 2026", saved["reportMarkdown"])
        reader.assert_awaited_once_with("TEST")
        self.assertEqual(project.call_args.kwargs["as_of"], saved["createdAt"])

    async def test_disconnected_review_checks_every_historical_holding_without_claiming_current_holdings(self):
        store = ReviewRunV2Store(Path(self.temp.name) / "historical-review.sqlite3")
        captured = verified_empty_portfolio()
        position = {"account": "TEST", "symbol": "IGV", "quantity": 10, "category": "other", "markState": "live", "valuationPrice": 100, "marketValue": 1000}
        captured["data"]["positionTable"].update(rows=[[position.get(key) for key in POSITION_COLUMNS]], rowCount=1)
        captured["data"]["accountSummaries"][0]["summary"]["NetLiquidation"]["value"] = 100000
        intelligence = AsyncMock(return_value={"coverage": {"state": "complete"}, "bySymbol": {"IGV": {"decision": {}}}})
        read_orders = AsyncMock()
        sources = replace(coordinator_sources(), portfolio_context=AsyncMock(return_value={"liveVerified": False, "freshness": "unavailable"}),
                          portfolio_reference=lambda: {"portfolio": captured, "runId": "old-close", "asOf": captured["asOf"], "verifiedAtCapture": True},
                          market_date=AsyncMock(return_value="2026-09-04"),
                          security_intelligence_symbols=intelligence, open_orders=read_orders)
        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, sources=sources)
        coordinator = ReviewCoordinatorV2(store, {"portfolio-review": handler})
        run = await coordinator.start(review_kind="portfolio-review", session_id="history", request_id="history")
        await coordinator.tasks[run["runId"]]
        saved = store.get(run["runId"])
        self.assertEqual(saved["state"], "succeeded")
        self.assertEqual(saved["outcome"], "partial")
        intelligence.assert_awaited_once_with(["IGV"], "2026-09-04")
        read_orders.assert_not_awaited()
        self.assertEqual(saved["dependencies"]["portfolioOpenOrders"]["status"], "failed")
        review = next(row for row in saved["sections"] if row["id"] == "portfolio-research-review")
        self.assertTrue(review["historicalHoldings"])
        self.assertEqual(review["reviewedCount"], 1)
        self.assertEqual(review["researchDate"], "2026-08-31")
        self.assertNotEqual(saved["dependencies"]["portfolio"]["status"], "ready")
        self.assertTrue(saved["dependencies"]["portfolioReference"]["detail"]["verifiedAtCapture"])

    async def test_slow_supporting_market_data_does_not_discard_completed_portfolio_checks(self):
        store = ReviewRunV2Store(Path(self.temp.name) / "slow-market-context.sqlite3")
        async def slow_context():
            await asyncio.sleep(10)
        sources = replace(coordinator_sources(), market_situation_context=slow_context)
        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, sources=sources)
        coordinator = ReviewCoordinatorV2(store, {"portfolio-review": handler})
        with patch.object(analyst_app, "PORTFOLIO_CONTEXT_TIMEOUT_SECONDS", 0.01):
            run = await coordinator.start(review_kind="portfolio-review", session_id="slow", request_id="slow")
            await coordinator.tasks[run["runId"]]
        saved = store.get(run["runId"])
        self.assertEqual(saved["state"], "succeeded")
        self.assertEqual(saved["dependencies"]["portfolio"]["status"], "ready")
        self.assertEqual(saved["dependencies"]["heldResearchEvents"]["status"], "ready")
        self.assertEqual(saved["dependencies"]["marketSituation"]["status"], "failed")

    async def test_stops_follow_holdings_without_waiting_for_documents_and_sizing_runs_with_research(self):
        import threading
        store = ReviewRunV2Store(Path(self.temp.name) / "parallel-checks.sqlite3")
        captured = verified_empty_portfolio()
        position = {"account": "TEST", "symbol": "IGV", "quantity": 10, "category": "other", "markState": "live", "valuationPrice": 100, "marketValue": 1000}
        captured["data"]["positionTable"].update(rows=[[position.get(key) for key in POSITION_COLUMNS]], rowCount=1)
        orders_checked, sizing_started = threading.Event(), asyncio.Event()
        defaults = coordinator_sources()

        async def orders():
            orders_checked.set()
            return {"ok": True, "complete": True, "liveVerified": True, "from_cache": False, "source": "ibkr_all_open_orders", "orders": []}

        def documents():
            self.assertTrue(orders_checked.wait(0.5), "Orders must not wait for the document scan")
            return defaults.exact_review_documents()

        async def intelligence(*args):
            await asyncio.wait_for(sizing_started.wait(), 0.5)
            return await defaults.security_intelligence_symbols(*args)

        async def sizing(*_args):
            sizing_started.set()
            return {"bySymbol": {}, "asOf": captured["asOf"]}

        sources = replace(defaults, portfolio_context=AsyncMock(return_value=captured), open_orders=orders,
                          exact_review_documents=documents, security_intelligence_symbols=intelligence, sizing_context=sizing)
        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, sources=sources)
        coordinator = ReviewCoordinatorV2(store, {"portfolio-review": handler})
        started = await coordinator.start(review_kind="portfolio-review", request_id="parallel")
        await coordinator.tasks[started["runId"]]
        saved = store.get(started["runId"])
        self.assertEqual(saved["state"], "succeeded")
        for source in ("portfolioOpenOrders", "exactResearchDocuments", "heldResearchEvents", "portfolioSizing"):
            self.assertEqual(saved["dependencies"][source]["status"], "ready", source)

    async def test_sizing_timeout_keeps_the_review_and_marks_a_verification_gap(self):
        store = ReviewRunV2Store(Path(self.temp.name) / "sizing-timeout.sqlite3")
        captured = verified_empty_portfolio()
        position = {"account": "TEST", "symbol": "IGV", "quantity": 10, "category": "other", "markState": "live", "valuationPrice": 100, "marketValue": 1000}
        captured["data"]["positionTable"].update(rows=[[position.get(key) for key in POSITION_COLUMNS]], rowCount=1)
        sources = replace(coordinator_sources(), portfolio_context=AsyncMock(return_value=captured),
                          sizing_context=lambda *_args: asyncio.sleep(10))
        async def handler(context):
            return await analyst_app._portfolio_review_v2_handler(context, sources=sources)
        coordinator = ReviewCoordinatorV2(store, {"portfolio-review": handler})
        with patch.object(analyst_app, "PORTFOLIO_SIZING_TIMEOUT_SECONDS", 0.01):
            started = await coordinator.start(review_kind="portfolio-review", request_id="sizing-timeout")
            await coordinator.tasks[started["runId"]]
        saved = store.get(started["runId"])
        self.assertEqual(saved["state"], "succeeded")
        self.assertEqual(saved["dependencies"]["portfolioSizing"]["status"], "failed")
        self.assertIsNone(store.read_evidence(saved, "portfolioSizing"))

    async def test_balance_review_keeps_verified_amount_when_portfolio_crosscheck_times_out(self):
        store = ReviewRunV2Store(Path(self.temp.name) / "balance-timeout.sqlite3")

        async def handler(context):
            return await analyst_app._balance_review_v2_handler(
                context,
                balance_reader=lambda: asyncio.sleep(0, result=verified_balance_context()),
                portfolio_reader=lambda: asyncio.sleep(10),
                portfolio_timeout_seconds=0.01,
            )

        coordinator = ReviewCoordinatorV2(store, {"balance-review": handler})
        run = await coordinator.start(review_kind="balance-review", request_id="slow-crosscheck")
        await coordinator.tasks[run["runId"]]
        result = store.get(run["runId"])
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual(result["outcome"], "partial")
        self.assertIn("**Net liquidation:** $100,000.00", result["reportMarkdown"])
        self.assertIn("portfolio exposure cross-check was unavailable", result["reportMarkdown"])

    async def test_balance_review_reads_holdings_without_waiting_for_portfolio_quotes(self):
        from analyst_review_sources import review_sources

        store = ReviewRunV2Store(Path(self.temp.name) / "balance-holdings.sqlite3")
        holdings = {
            "status": "available", "provider": "ibkr", "liveVerified": True,
            "freshness": "live", "asOf": datetime.now(timezone.utc).isoformat(),
            "data": {"accounts": ["TEST"], "positions": [
                {"account": "TEST", "symbol": "IGV", "quantity": -10},
            ]},
        }

        async def handler(context):
            return await analyst_app._balance_review_v2_handler(
                context,
                balance_reader=lambda: asyncio.sleep(0, result=verified_balance_context()),
            )

        with (
            patch.object(analyst_app.ibkr, "holdings_context", new=AsyncMock(return_value=holdings)) as reader,
            patch.object(analyst_app.ibkr, "portfolio_context", new=AsyncMock(side_effect=AssertionError("Full-book quotes must not gate holdings"))) as quotes,
        ):
            coordinator = ReviewCoordinatorV2(store, {"balance-review": handler})
            run = await coordinator.start(review_kind="balance-review", request_id="holdings-only")
            await coordinator.tasks[run["runId"]]
        result = store.get(run["runId"])
        reader.assert_awaited_once()
        quotes.assert_not_awaited()
        self.assertEqual(result["outcome"], "ready")
        dependency = result["dependencies"]["portfolio"]
        self.assertEqual(dependency["status"], "ready")
        self.assertEqual(dependency["asOf"], holdings["asOf"])
        source = next(item for item in review_sources(result, store)["items"] if item["id"] == "portfolio")
        self.assertEqual(source["status"], "ready")
        self.assertEqual(source["observedAt"], holdings["asOf"])
        metrics = next(section for section in result["sections"] if section["id"] == "margin-capacity")["portfolioMetrics"]
        self.assertEqual(metrics, {"available": True, "observedAt": holdings["asOf"], "positionCount": 1})
        self.assertIn("**Independent position cross-check:** verified", result["reportMarkdown"])

    async def test_prediction_and_balance_production_handlers_use_injected_live_boundaries(
        self,
    ):
        v2_store = ReviewRunV2Store(Path(self.temp.name) / "reviews-v2-other.sqlite3")

        async def prediction_handler(context):
            return await analyst_app._prediction_review_v2_handler(
                context, board_reader=lambda: asyncio.sleep(0, result=setup_board_fixture()))

        async def balance_handler(context):
            return await analyst_app._balance_review_v2_handler(
                context,
                balance_reader=lambda: asyncio.sleep(
                    0, result=verified_balance_context()
                ),
                portfolio_reader=lambda: asyncio.sleep(
                    0, result=verified_empty_portfolio()
                ),
            )

        coordinator = ReviewCoordinatorV2(
            v2_store,
            {
                "prediction-markets-review": prediction_handler,
                "balance-review": balance_handler,
            },
        )
        prediction = await coordinator.start(
            review_kind="prediction-markets-review",
            session_id="prediction-session",
            request_id="prediction-request",
        )
        balance = await coordinator.start(
            review_kind="balance-review",
            session_id="balance-session",
            request_id="balance-request",
        )
        await asyncio.gather(
            coordinator.tasks[prediction["runId"]],
            coordinator.tasks[balance["runId"]],
        )

        prediction_run = v2_store.get(prediction["runId"])
        balance_run = v2_store.get(balance["runId"])
        self.assertEqual(prediction_run["outcome"], "ready")
        self.assertEqual(balance_run["outcome"], "ready")
        self.assertEqual(prediction_run["sections"][0]["id"], "setup-board")
        self.assertTrue(prediction_run["reportMarkdown"].startswith("## Crypto\n\n| Market | Tick | Trade | Trend |"))
        self.assertNotIn('"Kalshi"', prediction_run["reportMarkdown"])
        self.assertIn("| Bitcoin | BIAS(Bullish;;) | BIAS(Bullish;;) | BIAS(Bullish;;) | "
                      "RR(81450;87366;82627;0;) | ASOF(Oct 10 09:45;Sep 29,HedgAI IBIT;Sep 10,;,Risk Ranges) |",
                      prediction_run["reportMarkdown"])
        self.assertIn("| CPI YoY · Sep 2026 | Sep | 3.63% | 3.74% | 3.85% | Oct 6 04:48 PDT |", prediction_run["reportMarkdown"])
        self.assertEqual(prediction_run["dependencies"]["predictionBoard"]["status"], "ready")
        self.assertIn("**Gross leverage:** 0.900×", balance_run["reportMarkdown"])
        self.assertIn(
            "**Open orders:** 0",
            balance_run["reportMarkdown"],
        )
        self.assertIn("**Same-day executions:** 1", balance_run["reportMarkdown"])
        self.assertNotIn("packets", prediction_run)
        self.assertNotIn("packets", balance_run)

    async def test_packet_finalization_failure_preserves_completed_sections_and_hides_raw_error(
        self,
    ):
        raw_error = "name 'sha256' is not defined"
        with patch.object(
            analyst_app, "build_packets", side_effect=NameError(raw_error)
        ):
            failed = await self.launch("request-finalization-failure")

        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["errorCode"], "COORDINATOR_FINALIZATION_FAILED")
        self.assertEqual(failed["error"], raw_error)
        self.assertTrue(
            all(
                section["status"] not in {"pending", "loading"}
                for section in failed["sections"]
            )
        )
        self.assertTrue(
            any(section["status"] != "failed" for section in failed["sections"])
        )
        projected = public_run(failed)
        self.assertEqual(projected["errorCode"], "COORDINATOR_FINALIZATION_FAILED")
        self.assertNotIn("sha256", projected["error"])
        self.assertNotIn("not defined", projected["error"])
        self.assertFalse(
            analyst_app.runtime_state["portfolioReviewCoordinator"]["ready"]
        )

    async def test_section_construction_failure_isolated_to_that_section(self):
        with patch.object(
            analyst_app,
            "extract_market_fields",
            side_effect=ValueError("malformed market fields"),
        ):
            completed = await self.launch("request-section-failure")

        by_id = {section["sectionId"]: section for section in completed["sections"]}
        self.assertEqual(by_id["market-situation"]["status"], "failed")
        self.assertEqual(
            by_id["market-situation"]["reasonCode"], "SECTION_BUILD_FAILED"
        )
        self.assertTrue(
            all(
                section["status"] not in {"pending", "loading"}
                for section_id, section in by_id.items()
                if section_id != "market-situation"
            )
        )
        self.assertIn(completed["status"], {"partial", "blocked"})

    async def test_health_latches_readiness_off_after_coordinator_failure(self):
        analyst_app.runtime_state["portfolioReviewCoordinator"] = {
            "ready": False,
            "state": "failed",
            "reason": "Portfolio Review coordinator failed and requires a sidecar restart.",
            "errorCode": "COORDINATOR_FINALIZATION_FAILED",
            "checkedAt": "2026-08-31T14:00:00Z",
        }
        analyst_app.runtime_state.update(
            syncStatus="ready",
            lastSyncAt="2026-08-31T14:00:00Z",
            lastSyncError=None,
        )
        with (
            patch.object(
                analyst_app.research_index, "coverage_counts", return_value={}
            ),
            patch.object(
                analyst_app.research_index, "latest_by_product", return_value={}
            ),
            patch.object(
                analyst_app.ibkr,
                "status",
                AsyncMock(
                    return_value={
                        "status": "available",
                        "freshness": "live",
                        "liveVerified": True,
                        "warnings": [],
                    }
                ),
            ),
        ):
            health = await analyst_app._portfolio_review_dependency_health()

        self.assertFalse(health["ready"])
        self.assertFalse(health["dependencies"]["coordinator"]["ready"])
        self.assertEqual(
            health["dependencies"]["coordinator"]["errorCode"],
            "COORDINATOR_FINALIZATION_FAILED",
        )


if __name__ == "__main__":
    unittest.main()
