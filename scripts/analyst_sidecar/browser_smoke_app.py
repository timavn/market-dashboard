"""Isolated browser-smoke sidecar using the production ReviewRunV2 coordinator.

This module cannot start without ``ANALYST_SMOKE_MODE=true``. It replaces only
provider boundaries and durable storage; orchestration, deadlines,
fingerprinting, deterministic rendering, HTTP routes, retry, and hydration are
the same code used by production. No real Analyst conversations or accounts
are touched.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
import asyncio
import os
from pathlib import Path
from typing import Any


if os.environ.get("ANALYST_SMOKE_MODE") != "true":
    raise RuntimeError("browser_smoke_app is test-only; set ANALYST_SMOKE_MODE=true.")

data_dir = Path(os.environ.get("ANALYST_DATA_DIR") or "").expanduser()
if not data_dir.is_absolute():
    raise RuntimeError("ANALYST_DATA_DIR must be an explicit isolated absolute path.")

import app as analyst_app
from review_runs_v2 import (
    REVIEW_KINDS,
    ReviewCoordinatorV2,
    ReviewRunError,
    ReviewRunV2Store,
    coordinator_canary,
)


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

_FAIL_FIRST_KIND = str(os.environ.get("ANALYST_SMOKE_FAIL_FIRST_REVIEW") or "").strip()
if _FAIL_FIRST_KIND and _FAIL_FIRST_KIND not in REVIEW_KINDS:
    raise RuntimeError("ANALYST_SMOKE_FAIL_FIRST_REVIEW must name a ReviewRunV2 kind.")
_failed_once: set[str] = set()
try:
    _SMOKE_DELAY_SECONDS = max(
        0.0,
        min(10.0, float(os.environ.get("ANALYST_SMOKE_REVIEW_DELAY_MS") or 0) / 1000),
    )
except ValueError as exc:
    raise RuntimeError("ANALYST_SMOKE_REVIEW_DELAY_MS must be numeric.") from exc


async def _smoke_boundary(review_kind: str) -> None:
    if _SMOKE_DELAY_SECONDS:
        await asyncio.sleep(_SMOKE_DELAY_SECONDS)
    if review_kind == _FAIL_FIRST_KIND and review_kind not in _failed_once:
        _failed_once.add(review_kind)
        raise ReviewRunError(
            "SMOKE_INJECTED_FAILURE",
            "The isolated smoke provider intentionally failed this attempt.",
            retryable=True,
        )


async def _verified_empty_portfolio() -> dict[str, Any]:
    """Return a test-only, explicitly verified zero-position account snapshot."""

    return {
        "status": "available",
        "liveVerified": True,
        "freshness": "live",
        "sourceSystem": "isolated_review_smoke_provider",
        "asOf": "2026-08-31T16:00:00Z",
        "data": {
            "positionTable": {"columns": POSITION_COLUMNS, "rows": [], "rowCount": 0},
            "accountSummaries": [
                {
                    "account": "ISOLATED-SMOKE",
                    "summary": {"NetLiquidation": {"value": 100_000}},
                }
            ],
            "pnl": [{"account": "ISOLATED-SMOKE", "pnl": {"dailyPnL": 0}}],
        },
    }


async def _market_context() -> dict[str, Any]:
    return {
        "status": "available",
        "liveVerified": True,
        "freshness": "live",
        "asOf": "2026-08-31T16:00:00Z",
        "data": {},
    }


async def _held_intelligence(_symbols: list[str], _market_date: str) -> dict[str, Any]:
    return {
        "coverage": {"state": "complete"},
        "bySymbol": {},
        "products": [],
        "generatedAt": "2026-08-31T16:00:00Z",
    }


async def _universe_intelligence(_market_date: str) -> dict[str, Any]:
    return {"scanComplete": True, "bySymbol": {}}


def _portfolio_sources() -> analyst_app.PortfolioReviewSources:
    return analyst_app.PortfolioReviewSources(
        portfolio_context=_verified_empty_portfolio,
        project_portfolio_context=lambda value: value,
        research_coverage=lambda: {
            "products": [],
            "sync": {"status": "ready", "lastSyncAt": "2026-08-31T16:00:00Z"},
        },
        exact_review_documents=lambda: {"products": []},
        market_situation_context=_market_context,
        security_intelligence_symbols=_held_intelligence,
        security_intelligence_universe=_universe_intelligence,
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


async def _prediction_universe() -> dict[str, Any]:
    markets = []
    for market_id, asset, venue in analyst_app.PREDICTIVE_REVIEW_UNIVERSE:
        markets.append(
            {
                "marketId": market_id,
                "asset": asset,
                "requestedVenue": venue,
                "status": "available",
                "errorCode": None,
                "snapshot": {
                    "displayContracts": {
                        "status": "available",
                        "event": {
                            "ticker": f"{market_id}-event",
                            "closeTime": "2099-09-03T20:00:00Z",
                        },
                        "lines": [
                            {
                                "ticker": f"{market_id}-contract",
                                "threshold": 100,
                                "isNearest": True,
                                "yesBid": 0.44,
                                "yesAsk": 0.46,
                                "noBid": 0.54,
                                "noAsk": 0.56,
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
                                }
                            },
                            "settlementState": "open",
                        },
                    },
                    "riskRange": {
                        "status": "available",
                        "date": "2026-08-31",
                        "trend": "Neutral",
                        "buyTrade": 95,
                        "sellTrade": 105,
                    },
                    "scoreInputs": {"trade": {"direction": "neutral"}},
                    "session": {"state": "open"},
                },
            }
        )
    return {
        "status": "available",
        "liveVerified": True,
        "freshness": "live",
        "asOf": "2026-08-31T16:00:00Z",
        "data": {
            "markets": markets,
            "availableCount": 6,
            "requestedCount": 6,
            "policy": {
                "autoVenueAllowed": False,
                "alternateVenueFallbackAllowed": False,
                "recommendationsAllowed": False,
            },
        },
    }


async def _balance() -> dict[str, Any]:
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
                "accountId": "ISOLATED-SMOKE",
                "currency": "USD",
                "observedAt": "2026-08-31T16:00:00Z",
                "fromCache": False,
                "exposure": {
                    "available": True,
                    "netLiquidation": 100_000,
                    "longMarketValue": 0,
                    "shortMarketValue": 0,
                    "grossMarketValue": 0,
                    "netMarketValue": 0,
                    "grossPercent": 0,
                },
                "margin": {
                    "available": True,
                    "status": "live",
                    "source": "ibkr_live_session",
                    "health": "healthy",
                    "netLiquidation": 100_000,
                    "availableFunds": 100_000,
                    "buyingPower": 400_000,
                    "excessLiquidity": 100_000,
                },
                "settlement": {"state": "settled", "date": "2026-08-31"},
                "activity": {"openOrderCount": 0, "sameDayExecutionCount": 0},
                "cash": {
                    "securitiesCashFloor": 100_000,
                    "commodityCashFloor": 0,
                    "addLongRoom": 100_000,
                    "trimRequired": 0,
                },
                "buffer": {"totalReserve": 10_000, "addLongRoom": 90_000},
                "capacity": {"available": True, "status": "live"},
            },
            "interestStatus": {
                "available": True,
                "status": "verified",
                "generatedAt": "2026-08-31T16:00:00Z",
                "mtd": {"liveNetAccrued": 0, "verifiedDebit": 0},
                "forecast": {"status": "awaiting"},
                "latest": None,
                "stockBorrowFees": {"status": "verified_none"},
            },
            "history": {
                "available": True,
                "status": "verified_history",
                "generatedAt": "2026-08-31T16:00:00Z",
                "daily": [],
                "forecasts": [],
                "postings": [],
            },
        },
    }


async def _portfolio_handler(context):
    await _smoke_boundary("portfolio-review")
    return await analyst_app._portfolio_review_v2_handler(
        context, sources=_portfolio_sources()
    )


async def _prediction_handler(context):
    await _smoke_boundary("prediction-markets-review")
    return await analyst_app._prediction_review_v2_handler(
        context,
        prediction_reader=_prediction_universe,
        portfolio_reader=_verified_empty_portfolio,
    )


async def _balance_handler(context):
    await _smoke_boundary("balance-review")
    return await analyst_app._balance_review_v2_handler(
        context,
        balance_reader=_balance,
        portfolio_reader=_verified_empty_portfolio,
    )


data_dir.mkdir(parents=True, exist_ok=True)
analyst_app.review_run_v2_store = ReviewRunV2Store(
    data_dir / "analyst_reviews_v2.sqlite3"
)
analyst_app.review_run_v2_store.interrupt_active_attempts()
analyst_app.review_coordinator_v2 = ReviewCoordinatorV2(
    analyst_app.review_run_v2_store,
    {
        "portfolio-review": _portfolio_handler,
        "prediction-markets-review": _prediction_handler,
        "balance-review": _balance_handler,
    },
)
canary = coordinator_canary()
analyst_app.runtime_state["reviewCoordinatorV2"] = {
    "ready": canary["ready"],
    "state": "ready" if canary["ready"] else "failed",
    "reason": None if canary["ready"] else "Isolated ReviewRunV2 canary failed.",
    "errorCode": None if canary["ready"] else "REVIEW_COORDINATOR_CANARY_FAILED",
    "checkedAt": analyst_app.utc_now_iso(),
    "schemaVersion": 2,
}


@asynccontextmanager
async def _smoke_lifespan(starlette_app):
    """Run the real MCP transport without the production AWS indexing loop."""

    async with analyst_app.mcp_transport_lifespan(starlette_app):
        yield


analyst_app.mcp_app.router.lifespan_context = _smoke_lifespan
app = analyst_app.app


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=int(os.environ.get("ANALYST_SMOKE_SIDECAR_PORT", "6952")),
        reload=False,
    )
