from __future__ import annotations

import asyncio
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
    for market_id, asset, venue in analyst_app.PREDICTIVE_REVIEW_UNIVERSE:
        failed = market_id == failed_market_id
        markets.append(
            {
                "marketId": market_id,
                "asset": asset,
                "requestedVenue": venue,
                "status": "partial" if failed else "available",
                "errorCode": "PINNED_VENUE_DATA_INCOMPLETE" if failed else None,
                "snapshot": {
                    "displayContracts": {
                        "status": "partial" if failed else "available",
                        "event": {
                            "ticker": f"{market_id}-event",
                            "closeTime": "2099-09-03T20:00:00Z",
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
                            }
                        ],
                    },
                    "venues": {
                        venue: {
                            "settlementBasis": {
                                "instrument": f"Official {asset} settlement"
                            },
                            "reference": {
                                "spot": {
                                    "status": "available",
                                    "availability": "live",
                                    "label": asset,
                                    "value": 100,
                                    "asOf": "2026-08-31T16:00:00Z",
                                },
                            },
                            "settlementState": "open",
                        },
                    },
                    "riskRange": {
                        "status": "available",
                        "date": "2026-08-31",
                        "trend": "Bullish",
                        "buyTrade": 95,
                        "sellTrade": 105,
                    },
                    "scoreInputs": {"trade": {"direction": "long"}},
                    "session": {"state": "open"},
                },
            }
        )
    available_count = sum(row["status"] == "available" for row in markets)
    return {
        "status": "available" if available_count == 6 else "partial",
        "liveVerified": True,
        "freshness": "live",
        "asOf": "2026-08-31T16:00:00Z",
        "data": {
            "markets": markets,
            "availableCount": available_count,
            "requestedCount": 6,
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

        async def production_handler(context):
            return await analyst_app._portfolio_review_v2_handler(
                context,
                sources=coordinator_sources(),
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
        self.assertEqual(completed["outcome"], "ready")
        self.assertIsNotNone(completed["baselineAcceptedAt"])
        self.assertEqual(len(completed["sections"]), 6)
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

    async def test_prediction_and_balance_production_handlers_use_injected_live_boundaries(
        self,
    ):
        v2_store = ReviewRunV2Store(Path(self.temp.name) / "reviews-v2-other.sqlite3")

        async def prediction_handler(context):
            return await analyst_app._prediction_review_v2_handler(
                context,
                prediction_reader=lambda: asyncio.sleep(
                    0, result=verified_prediction_universe()
                ),
                portfolio_reader=lambda: asyncio.sleep(
                    0, result=verified_empty_portfolio()
                ),
            )

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
        self.assertEqual(
            [row["venue"] for row in prediction_run["sections"][0]["markets"]],
            ["ForecastEx", "Kalshi", "Kalshi", "Kalshi", "Kalshi", "ForecastEx"],
        )
        self.assertIn("# Predictive Markets Review", prediction_run["reportMarkdown"])
        self.assertIn("Gross leverage: **0.900×**", balance_run["reportMarkdown"])
        self.assertIn(
            "Open orders / same-day executions: **0 / 1**",
            balance_run["reportMarkdown"],
        )
        self.assertNotIn("packets", prediction_run)
        self.assertNotIn("packets", balance_run)

    async def test_one_prediction_failure_preserves_all_sibling_rows(self):
        v2_store = ReviewRunV2Store(Path(self.temp.name) / "reviews-v2-partial.sqlite3")

        async def handler(context):
            return await analyst_app._prediction_review_v2_handler(
                context,
                prediction_reader=lambda: asyncio.sleep(
                    0, result=verified_prediction_universe(failed_market_id="wti")
                ),
                portfolio_reader=lambda: asyncio.sleep(
                    0, result=verified_empty_portfolio()
                ),
            )

        coordinator = ReviewCoordinatorV2(
            v2_store,
            {"prediction-markets-review": handler},
        )
        started = await coordinator.start(
            review_kind="prediction-markets-review",
            session_id="prediction-partial-session",
            request_id="prediction-partial-request",
        )
        await coordinator.tasks[started["runId"]]
        completed = v2_store.get(started["runId"])

        markets = completed["sections"][0]["markets"]
        self.assertEqual(completed["outcome"], "partial")
        self.assertEqual(len(markets), 6)
        self.assertEqual(sum(row["status"] == "available" for row in markets), 5)
        self.assertEqual(
            next(row for row in markets if row["asset"] == "WTI")["status"],
            "partial",
        )

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
