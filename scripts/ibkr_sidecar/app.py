import asyncio
import errno
import fcntl
import hashlib
import json
import math
import os
import re
import sys
import tempfile
import time
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Dict, List, Optional, Set
from zoneinfo import ZoneInfo

from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse, StreamingResponse
from ib_insync import Contract, ExecutionFilter, IB, util
from pydantic import BaseModel, Field

from gateway_connection_governor import (
    CLIENT_ID_IN_USE,
    GATEWAY_API_UNRESPONSIVE,
    GATEWAY_NOT_AUTHENTICATED,
    GatewayConnectionGovernor,
)
from stream_manager import PERSISTENT_CONNECT, QUOTE_WAIT_SEC, StreamManager
from numeric_values import strict_finite_float, strict_market_data_type
from open_order_snapshot import fresh_open_orders

APP_DIR = Path(__file__).resolve().parent
WORKSPACE_ROOT = APP_DIR.parent.parent.resolve()

IB_HOST = os.environ.get("IB_GATEWAY_HOST", "127.0.0.1")
IB_PORT = int(os.environ.get("IB_GATEWAY_PORT", "4002"))
IB_CLIENT_ID = int(os.environ.get("IB_GATEWAY_CLIENT_ID", "17"))
FUNDING_CLIENT_ID = int(
    os.environ.get("IBKR_FUNDING_CLIENT_ID", str(IB_CLIENT_ID + 100))
)
REFERENCE_MARKS_CLIENT_ID = int(
    os.environ.get("IBKR_REFERENCE_MARKS_CLIENT_ID", str(IB_CLIENT_ID + 101))
)
BALANCE_CLIENT_ID = int(
    os.environ.get("IBKR_BALANCE_CLIENT_ID", str(IB_CLIENT_ID + 102))
)
CONNECT_TIMEOUT = float(os.environ.get("IB_GATEWAY_CONNECT_TIMEOUT_SEC", "2.5"))
STATUS_TIMEOUT = float(os.environ.get("IBKR_STATUS_TIMEOUT_SEC", str(CONNECT_TIMEOUT + 2.0)))
MAX_QUOTE_BATCH = int(os.environ.get("IBKR_MAX_QUOTE_BATCH", "50"))
PNL_WAIT_SEC = min(5.0, max(0.3, float(os.environ.get("IBKR_PNL_WAIT_SEC", "5.0"))))
PORTFOLIO_SYNC_TIMEOUT_SEC = float(os.environ.get("IBKR_PORTFOLIO_SYNC_TIMEOUT_SEC", "2.5"))
POSITIONS_REQUEST_TIMEOUT_SEC = float(
    os.environ.get("IBKR_POSITIONS_REQUEST_TIMEOUT_SEC", "4.0")
)
LIVE_POSITIONS_REQUEST_TIMEOUT_SEC = min(
    8.0,
    max(
        0.1,
        float(
            os.environ.get(
                "IBKR_LIVE_POSITIONS_REQUEST_TIMEOUT_SEC",
                "8.0",
            )
        ),
    ),
)
POSITIONS_CANCEL_GRACE_SEC = float(os.environ.get("IBKR_POSITIONS_CANCEL_GRACE_SEC", "0.5"))
_configured_positions_client_id = os.environ.get("IBKR_POSITIONS_SNAPSHOT_CLIENT_ID")
POSITIONS_SNAPSHOT_CLIENT_ID = int(
    _configured_positions_client_id
    or str(IB_CLIENT_ID + 150)
)
BALANCE_TOTAL_DEADLINE_SEC = min(
    12.0,
    max(
        1.0,
        float(os.environ.get("IBKR_BALANCE_TOTAL_DEADLINE_SEC", "12.0")),
    ),
)
SIDECAR_LOCK_PATH = Path(
    os.environ.get(
        "IBKR_SIDECAR_LOCK_PATH",
        Path.home() / "Library" / "Application Support" / "market-dashboard" / "ibkr-sidecar.lock",
    )
).expanduser()
_sidecar_lock_handle = None
_pnl_singleflight_lock = asyncio.Lock()
_open_orders_snapshot_lock = asyncio.Lock()
_executions_snapshot_lock = asyncio.Lock()
_pnl_inflight: Dict[str, asyncio.Task] = {}
LIVE_SESSION_VERIFY_TIMEOUT_SEC = float(os.environ.get("IBKR_LIVE_SESSION_VERIFY_TIMEOUT_SEC", "2.5"))
FUNDING_ACCOUNT_UPDATE_TIMEOUT_SEC = float(
    os.environ.get("IBKR_FUNDING_ACCOUNT_UPDATE_TIMEOUT_SEC", "5.0")
)
FUNDING_QUALIFICATION_TIMEOUT_SEC = float(
    os.environ.get("IBKR_FUNDING_QUALIFICATION_TIMEOUT_SEC", "3.0")
)
FUNDING_QUOTE_TIMEOUT_SEC = float(os.environ.get("IBKR_FUNDING_QUOTE_TIMEOUT_SEC", "8.0"))
FUNDING_QUOTE_BATCH_SIZE = max(
    1,
    int(os.environ.get("IBKR_FUNDING_QUOTE_BATCH_SIZE", "25")),
)
FUNDING_QUOTE_POLL_SEC = float(
    os.environ.get("IBKR_FUNDING_QUOTE_POLL_SEC", "0.05")
)
FUNDING_QUOTE_MAX_AGE_SEC = float(
    os.environ.get("IBKR_FUNDING_QUOTE_MAX_AGE_SEC", "60.0")
)
FUNDING_HISTORICAL_TIMEOUT_SEC = float(
    os.environ.get("IBKR_FUNDING_HISTORICAL_TIMEOUT_SEC", "4.0")
)
FUNDING_MARKET_CALENDAR_TIMEOUT_SEC = float(
    os.environ.get("IBKR_FUNDING_MARKET_CALENDAR_TIMEOUT_SEC", "4.0")
)
FUNDING_MARKET_CALENDAR_CON_ID = 756733  # SPY, exact IBKR US-equity calendar anchor.
FUNDING_MARKET_CALENDAR_LOOKBACK_DAYS = max(
    7,
    int(os.environ.get("IBKR_FUNDING_MARKET_CALENDAR_LOOKBACK_DAYS", "10")),
)
FUNDING_HISTORICAL_BATCH_SIZE = max(
    1,
    int(os.environ.get("IBKR_FUNDING_HISTORICAL_BATCH_SIZE", "10")),
)
FUNDING_OPEN_ORDERS_TIMEOUT_SEC = float(
    os.environ.get("IBKR_FUNDING_OPEN_ORDERS_TIMEOUT_SEC", "4.0")
)
FUNDING_EXECUTIONS_TIMEOUT_SEC = float(
    os.environ.get("IBKR_FUNDING_EXECUTIONS_TIMEOUT_SEC", "4.0")
)
REFERENCE_MARKS_HISTORY_TIMEOUT_SEC = float(
    os.environ.get("IBKR_REFERENCE_MARKS_HISTORY_TIMEOUT_SEC", "6.0")
)
REFERENCE_MARKS_HISTORY_DURATION = os.environ.get(
    "IBKR_REFERENCE_MARKS_HISTORY_DURATION",
    "1 Y",
).strip() or "1 Y"
REFERENCE_MARKS_POSITIONS_TIMEOUT_SEC = float(
    os.environ.get("IBKR_REFERENCE_MARKS_POSITIONS_TIMEOUT_SEC", "5.0")
)
REFERENCE_MARKS_REQUEST_GAP_SEC = max(
    0.0,
    float(os.environ.get("IBKR_REFERENCE_MARKS_REQUEST_GAP_SEC", "0.05")),
)
REFERENCE_MARKS_LIVE_TIMEOUT_SEC = float(
    os.environ.get("IBKR_REFERENCE_MARKS_LIVE_TIMEOUT_SEC", "1.5")
)
REFERENCE_MARKS_LIVE_MAX_AGE_SEC = float(
    os.environ.get("IBKR_REFERENCE_MARKS_LIVE_MAX_AGE_SEC", "60.0")
)
REFERENCE_MARKS_CACHE_TTL_SEC = float(
    os.environ.get("IBKR_REFERENCE_MARKS_CACHE_TTL_SEC", "3600.0")
)
REFERENCE_MARKS_POST_CLOSE_RETRY_SEC = float(
    os.environ.get("IBKR_REFERENCE_MARKS_POST_CLOSE_RETRY_SEC", "300.0")
)
REFERENCE_MARKS_RTH_FINALIZE_MINUTES = max(
    0,
    int(os.environ.get("IBKR_REFERENCE_MARKS_RTH_FINALIZE_MINUTES", "15")),
)
REFERENCE_MARKS_MAX_ATTEMPTS = max(
    1,
    int(os.environ.get("IBKR_REFERENCE_MARKS_MAX_ATTEMPTS", "3")),
)
REFERENCE_MARKS_RETRY_DELAY_SEC = max(
    0.0,
    float(os.environ.get("IBKR_REFERENCE_MARKS_RETRY_DELAY_SEC", "2.0")),
)
REFERENCE_MARKS_TERMINAL_RETRY_SEC = max(
    60.0,
    float(os.environ.get("IBKR_REFERENCE_MARKS_TERMINAL_RETRY_SEC", "1800.0")),
)
REFERENCE_MARKS_BACKGROUND_SCAN_SEC = max(
    5.0,
    float(os.environ.get("IBKR_REFERENCE_MARKS_BACKGROUND_SCAN_SEC", "30.0")),
)
REFERENCE_MARKS_BACKGROUND_REFRESH_SEC = max(
    REFERENCE_MARKS_BACKGROUND_SCAN_SEC,
    float(os.environ.get("IBKR_REFERENCE_MARKS_BACKGROUND_REFRESH_SEC", "300.0")),
)
REFERENCE_MARKS_STARTUP_DELAY_SEC = max(
    0.0,
    float(os.environ.get("IBKR_REFERENCE_MARKS_STARTUP_DELAY_SEC", "2.0")),
)
REFERENCE_MARKS_CACHE_PATH = Path(
    os.environ.get(
        "IBKR_REFERENCE_MARKS_CACHE_PATH",
        str(
            Path.home()
            / "Library"
            / "Application Support"
            / "market-dashboard"
            / "ibkr-reference-marks-v1.json"
        ),
    )
).expanduser()
PRIMARY_SOCKET_HEARTBEAT_MAX_AGE_SEC = max(
    0.1,
    float(os.environ.get("IBKR_PRIMARY_SOCKET_HEARTBEAT_MAX_AGE_SEC", "15.0")),
)
INTEREST_OBSERVATION_BROKER_TIME_MAX_AGE_SEC = max(
    1.0,
    float(
        os.environ.get(
            "IBKR_INTEREST_OBSERVATION_BROKER_TIME_MAX_AGE_SEC",
            "30.0",
        )
    ),
)
INTEREST_OBSERVATION_BROKER_TIME_MAX_FUTURE_SEC = max(
    0.0,
    float(
        os.environ.get(
            "IBKR_INTEREST_OBSERVATION_BROKER_TIME_MAX_FUTURE_SEC",
            "5.0",
        )
    ),
)

ib = IB()
funding_ib = IB()
balance_ib = IB()
reference_marks_ib = IB()
positions_ib = IB()
positions_snapshot_lock = asyncio.Lock()
positions_broker_request_lock = asyncio.Lock()
historical_request_lock = asyncio.Lock()
positions_snapshot_task: Optional[asyncio.Task] = None
positions_snapshot_client_id = POSITIONS_SNAPSHOT_CLIENT_ID
gateway_governor = GatewayConnectionGovernor(
    host=IB_HOST,
    port=IB_PORT,
    connect_timeout=CONNECT_TIMEOUT,
    verify_timeout=LIVE_SESSION_VERIFY_TIMEOUT_SEC,
    heartbeat_ttl=PRIMARY_SOCKET_HEARTBEAT_MAX_AGE_SEC,
)
gateway_governor.register_session(
    "primary", ib, client_id=IB_CLIENT_ID, primary=True
)
gateway_governor.register_session(
    "funding", funding_ib, client_id=FUNDING_CLIENT_ID
)
gateway_governor.register_session(
    "balance", balance_ib, client_id=BALANCE_CLIENT_ID
)
gateway_governor.register_session(
    "reference_marks", reference_marks_ib, client_id=REFERENCE_MARKS_CLIENT_ID
)
gateway_governor.register_session(
    "positions", positions_ib, client_id=POSITIONS_SNAPSHOT_CLIENT_ID
)
live_positions_state: Dict[str, Any] = {
    "status": "unverified",
    "error_code": "IBKR_LIVE_SESSION_UNVERIFIED",
    "connected": False,
    "accounts": [],
    "position_count": 0,
    "observed_at": None,
    "socket_verified_at": None,
    "message": "No fresh IBKR position snapshot has been verified.",
    "client_id": positions_snapshot_client_id,
}


def acquire_sidecar_lock():
    """Hold one workspace-sidecar lease for the lifetime of this process."""
    global _sidecar_lock_handle
    if _sidecar_lock_handle is not None:
        return _sidecar_lock_handle

    SIDECAR_LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    handle = SIDECAR_LOCK_PATH.open("a+")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        handle.close()
        if exc.errno in (errno.EACCES, errno.EAGAIN):
            raise RuntimeError(
                "Another workspace IBKR sidecar already owns the singleton lease."
            ) from exc
        raise

    handle.seek(0)
    handle.truncate()
    handle.write(f"{os.getpid()}\n")
    handle.flush()
    _sidecar_lock_handle = handle
    return handle


def release_sidecar_lock() -> None:
    global _sidecar_lock_handle
    handle = _sidecar_lock_handle
    _sidecar_lock_handle = None
    if handle is None:
        return
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        handle.close()


def update_live_positions_state(
    *,
    status: str,
    connected: bool,
    error_code: Optional[str] = None,
    message: Optional[str] = None,
    accounts: Optional[List[str]] = None,
    position_count: int = 0,
    observed_at: Optional[str] = None,
    socket_verified_at: Optional[str] = None,
) -> None:
    live_positions_state.update(
        {
            "status": status,
            "error_code": error_code,
            "connected": bool(connected),
            "message": message,
            "accounts": list(accounts or []),
            "position_count": int(position_count or 0),
            "observed_at": observed_at,
            "socket_verified_at": socket_verified_at,
            "client_id": positions_snapshot_client_id,
        }
    )


def live_positions_error_code(status: Optional[str]) -> str:
    return {
        "disconnected": GATEWAY_NOT_AUTHENTICATED,
        "gateway_unavailable": GATEWAY_NOT_AUTHENTICATED,
        "gateway_not_authenticated": GATEWAY_NOT_AUTHENTICATED,
        "gateway_api_unresponsive": GATEWAY_API_UNRESPONSIVE,
        "client_id_in_use": CLIENT_ID_IN_USE,
        "not_connected": GATEWAY_NOT_AUTHENTICATED,
        "accounts_unavailable": "IBKR_ACCOUNTS_UNAVAILABLE",
        "positions_request_busy": "IBKR_POSITIONS_REQUEST_BUSY",
        "positions_request_timeout": "IBKR_POSITIONS_REQUEST_TIMEOUT",
        "socket_verification_timeout": "IBKR_SOCKET_VERIFICATION_TIMEOUT",
        "tws_offline": "IBKR_POSITIONS_CLIENT_UNAVAILABLE",
        "positions_client_unavailable": "IBKR_POSITIONS_CLIENT_UNAVAILABLE",
    }.get(str(status or "").strip().lower(), "IBKR_LIVE_SESSION_UNVERIFIED")


async def req_positions_bounded(
    session: IB,
    *,
    timeout_sec: float = POSITIONS_REQUEST_TIMEOUT_SEC,
) -> List[Any]:
    """Request positions without letting cancel cleanup hold callers forever.

    ``asyncio.wait_for`` waits for the cancelled awaitable to finish. ib_insync
    ``reqPositionsAsync`` can ignore cancellation while Gateway is wedged, which
    previously pinned ``positions_snapshot_lock`` and made every subsequent
    ``/portfolio/live-positions`` call return ``positions_request_busy``.
    """
    awaitable = session.reqPositionsAsync()
    task = asyncio.ensure_future(awaitable)
    try:
        done, _pending = await asyncio.wait({task}, timeout=timeout_sec)
        if done:
            return task.result()
    except Exception:
        if not task.done():
            task.cancel()
        raise

    try:
        cancel = getattr(session, "cancelPositions", None)
        if callable(cancel):
            cancel()
        else:
            client = getattr(session, "client", None)
            client_cancel = getattr(client, "cancelPositions", None)
            if callable(client_cancel):
                client_cancel()
    except Exception:
        pass
    task.cancel()
    try:
        await asyncio.wait_for(asyncio.shield(task), timeout=POSITIONS_CANCEL_GRACE_SEC)
    except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
        # Some ib_insync awaitables swallow the first cancellation while they
        # unwind their request future. A second cancellation interrupts that
        # cleanup await so it cannot survive the bounded request or pin test /
        # shutdown event loops indefinitely.
        task.cancel()
        try:
            await asyncio.wait_for(
                asyncio.gather(task, return_exceptions=True),
                timeout=POSITIONS_CANCEL_GRACE_SEC,
            )
        except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
            pass
    raise asyncio.TimeoutError(
        f"IBKR positions request timed out after {timeout_sec:.1f}s"
    )


def serialize_live_position(account: str, contract: Any, quantity: float, avg_cost: float) -> Dict[str, Any]:
    strike = getattr(contract, "strike", None)
    try:
        strike = float(strike) if strike not in (None, "") else None
    except (TypeError, ValueError):
        strike = None
    return {
        "account": account,
        "conId": int(contract.conId) if getattr(contract, "conId", None) else None,
        "symbol": getattr(contract, "symbol", None) or None,
        "localSymbol": getattr(contract, "localSymbol", None) or None,
        "secType": getattr(contract, "secType", None) or None,
        "exchange": getattr(contract, "exchange", None) or None,
        "currency": getattr(contract, "currency", None) or None,
        "lastTradeDateOrContractMonth": (
            getattr(contract, "lastTradeDateOrContractMonth", None) or None
        ),
        "strike": strike,
        "right": getattr(contract, "right", None) or None,
        "multiplier": getattr(contract, "multiplier", None) or None,
        "tradingClass": getattr(contract, "tradingClass", None) or None,
        "position": float(quantity),
        "avgCost": float(avg_cost),
    }


def create_positions_snapshot_session() -> IB:
    """Factory retained for tests that override the positions session."""
    return positions_ib


def invalidate_positions_session(positions_session: Optional[IB] = None) -> None:
    """Drop a dedicated positions socket that may be wedged after a failure."""
    global positions_snapshot_client_id
    session = positions_session or positions_ib
    gateway_governor.invalidate_session("positions", session)
    if session is positions_ib:
        positions_snapshot_client_id = POSITIONS_SNAPSHOT_CLIENT_ID


async def ensure_positions_connected(
    positions_session: Optional[IB] = None,
) -> Dict[str, Any]:
    """Verify the one fixed, persistent positions snapshot session."""
    global positions_snapshot_client_id
    session = positions_session or positions_ib
    positions_snapshot_client_id = POSITIONS_SNAPSHOT_CLIENT_ID
    return await gateway_governor.ensure_session(
        "positions",
        session,
        client_id=POSITIONS_SNAPSHOT_CLIENT_ID,
        primary=False,
    )


async def fetch_raw_positions_via_persistent_session(
    required_accounts: List[str],
    *,
    timeout_sec: float = LIVE_POSITIONS_REQUEST_TIMEOUT_SEC,
    require_exact_accounts: bool = False,
) -> List[Any]:
    """Perform one fresh ``reqPositions`` on the persistent positions client."""
    session = create_positions_snapshot_session()
    health = await ensure_positions_connected(session)
    if not health.get("ok"):
        error = RuntimeError(
            health.get("message") or "Dedicated IBKR positions client is unavailable."
        )
        error.error_code = health.get("error_code") or live_positions_error_code(
            health.get("status")
        )
        error.retry_after_ms = int(health.get("retry_after_ms") or 0)
        raise error
    managed = [str(account) for account in session.managedAccounts() if account]
    required = {str(account) for account in required_accounts if account}
    if not managed:
        raise RuntimeError("The positions snapshot session returned no managed accounts.")
    if not required.issubset(set(managed)) or (
        require_exact_accounts and set(managed) != required
    ):
        raise RuntimeError(
            "The dedicated positions session does not cover the verified "
            "managed-account set."
        )

    try:
        async with positions_broker_request_lock:
            fresh_positions = await req_positions_bounded(
                session,
                timeout_sec=timeout_sec,
            )
    except asyncio.CancelledError:
        gateway_governor.record_session_failure(
            "positions",
            code=GATEWAY_API_UNRESPONSIVE,
            message="The fresh IBKR positions request was cancelled.",
            session=session,
        )
        raise
    except asyncio.TimeoutError:
        gateway_governor.record_session_failure(
            "positions",
            code="IBKR_POSITIONS_REQUEST_TIMEOUT",
            message=f"The fresh IBKR positions request timed out after {timeout_sec:.1f}s.",
            session=session,
        )
        raise
    except BaseException:
        gateway_governor.record_session_failure(
            "positions",
            code=GATEWAY_API_UNRESPONSIVE,
            message="The fresh IBKR positions request failed before positionEnd.",
            session=session,
        )
        raise
    if not session.isConnected():
        gateway_governor.record_session_failure(
            "positions",
            code=GATEWAY_API_UNRESPONSIVE,
            message="The dedicated positions session disconnected during reqPositions.",
            session=session,
        )
        error = RuntimeError(
            "The dedicated positions session disconnected during reqPositions."
        )
        error.error_code = GATEWAY_API_UNRESPONSIVE
        raise error
    return list(fresh_positions or [])


async def fetch_positions_via_ephemeral_session(
    accounts: List[str],
    *,
    timeout_sec: float = LIVE_POSITIONS_REQUEST_TIMEOUT_SEC,
) -> List[Dict[str, Any]]:
    """Request positions explicitly on the dedicated positions_ib client.

    Uses a persistent secondary IB session (like funding_ib) instead of
    the quote-heavy primary session. ``reqPositionsAsync`` completes only after
    a new broker ``positionEnd`` response, so no ib_insync position cache is
    consulted or restamped.
    """
    fresh_positions = await fetch_raw_positions_via_persistent_session(
        accounts,
        timeout_sec=timeout_sec,
        require_exact_accounts=True,
    )
    return [
        serialize_live_position(
            position.account,
            position.contract,
            float(position.position),
            float(position.avgCost),
        )
        for position in fresh_positions
        if float(position.position) != 0.0
    ]


async def request_fresh_positions_snapshot(
    accounts: List[str],
    *,
    timeout_sec: float = LIVE_POSITIONS_REQUEST_TIMEOUT_SEC,
) -> Dict[str, Any]:
    """Share only an in-flight broker request between concurrent callers.

    A completed task is never reused. Concurrent SYS/readiness/bridge callers
    can await the same newly requested broker response instead of either
    restamping cached rows or failing with ``positions_request_busy``.
    """
    global positions_snapshot_task

    async with positions_snapshot_lock:
        if positions_snapshot_task is None or positions_snapshot_task.done():
            async def capture() -> Dict[str, Any]:
                positions = await fetch_positions_via_ephemeral_session(
                    accounts,
                    timeout_sec=timeout_sec,
                )
                return {
                    "positions": positions,
                    "observedAt": now_iso(),
                }

            positions_snapshot_task = asyncio.create_task(capture())
        task = positions_snapshot_task

    try:
        return await asyncio.shield(task)
    finally:
        if task.done():
            async with positions_snapshot_lock:
                if positions_snapshot_task is task:
                    positions_snapshot_task = None


funding_snapshot_lock = asyncio.Lock()
balance_snapshot_lock = asyncio.Lock()
balance_request_state_lock = asyncio.Lock()
balance_request_task: Optional[asyncio.Task] = None
balance_request_account: Optional[str] = None
balance_socket_state: Dict[str, Any] = {
    "brokerTime": None,
    "socketVerifiedAt": None,
    "verifiedMonotonic": None,
}
reference_marks_snapshot_lock = asyncio.Lock()
reference_close_cache: Dict[str, Dict[int, Dict[str, Any]]] = {}
reference_marks_cache_health: Dict[str, Any] = {
    "loadedAt": None,
    "lastSavedAt": None,
    "lastErrorCode": None,
    "lastErrorAt": None,
}
reference_marks_warm_states: Dict[str, Dict[str, Any]] = {}
reference_marks_terminal_failures: Dict[str, Dict[int, Dict[str, Any]]] = {}
reference_marks_requested_accounts: Set[str] = set()
reference_marks_worker_task: Optional[asyncio.Task] = None
reference_marks_startup_task: Optional[asyncio.Task] = None
reference_marks_active_account: Optional[str] = None
primary_socket_heartbeat: Dict[str, Any] = {
    "connectionGeneration": None,
    "gatewayTime": None,
    "verifiedAt": None,
    "verifiedMonotonic": None,
}

# Account summary tags requested from IB
ACCOUNT_SUMMARY_TAG_SET = {
    "NetLiquidation",
    "TotalCashValue",
    "SettledCash",
    "BuyingPower",
    "EquityWithLoanValue",
    "InitMarginReq",
    "MaintMarginReq",
    "AvailableFunds",
    "ExcessLiquidity",
    "SMA",
    "AccruedCash",
}

FUNDING_REQUIRED_NUMERIC_TAGS = (
    "NetLiquidation",
    "TotalCashValue",
    "TotalCashValue-S",
    "TotalCashValue-C",
    "MaintMarginReq-C",
    "StockMarketValue",
    "AccruedCash-S",
)
FUNDING_GROSS_POSITION_TAGS = (
    "GrossPositionValue-S",
    "GrossPositionValue",
)
BALANCE_MARGIN_NUMERIC_TAGS = (
    "EquityWithLoanValue",
    "InitMarginReq",
    "MaintMarginReq",
    "AvailableFunds",
    "ExcessLiquidity",
    "BuyingPower",
)
EVENT_CONTRACT_ACCOUNTING_TAGS = (
    "GrossPositionValue-C",
    "NetLiquidation-C",
    "TotalCashValue-C",
    "InitMarginReq-C",
    "MaintMarginReq-C",
    "AvailableFunds-C",
    "EquityWithLoanValue-C",
)
SUPPORTED_EVENT_CONTRACT_VENUES = frozenset({"FORECASTX", "KALSHI"})
SUPPORTED_EVENT_CONTRACT_TYPES_BY_VENUE = {
    "FORECASTX": frozenset({"FOP", "OPT"}),
    "KALSHI": frozenset({"OPT"}),
}
ACCOUNT_VALUE_TOLERANCE = 0.01
ACCOUNT_VALUE_TOLERANCE_CENTS = 1


class InstrumentIn(BaseModel):
    symbol: Optional[str] = None
    secType: Optional[str] = Field(default="STK")
    exchange: Optional[str] = Field(default="SMART")
    currency: Optional[str] = Field(default="USD")
    conId: Optional[int] = None
    lastTradeDateOrContractMonth: Optional[str] = None
    tradingClass: Optional[str] = None
    multiplier: Optional[str] = None


class QuotesRequest(BaseModel):
    instruments: List[InstrumentIn] = Field(default_factory=list)
    forceRefresh: bool = False


class HistoricalRequest(BaseModel):
    instrument: InstrumentIn
    range: str = "1mo"
    interval: str = "1d"
    useRth: bool = True


class HistoricalRecordRequest(BaseModel):
    instrument: InstrumentIn
    throughDate: str


class SubscribeRequest(BaseModel):
    instruments: List[InstrumentIn] = Field(default_factory=list, max_length=100)


class ReconcileSubscriptionsRequest(SubscribeRequest):
    owner: str = Field(pattern=r"^market-dashboard$")


class PortfolioBalancePreviewLeg(BaseModel):
    id: str
    action: str
    symbol: Optional[str] = None
    conId: Optional[int] = None
    quantityMode: str = "shares"
    quantity: Optional[float] = None
    price: Optional[float] = None
    priceMode: str = "live_side"


class PortfolioBalancePreviewEvidenceRequest(BaseModel):
    account: str
    # The legacy single-short fields remain accepted for compatibility while
    # the planner uses one verified read for all active legs.
    conId: Optional[int] = None
    action: Optional[str] = None
    quantity: Optional[float] = None
    legs: List[PortfolioBalancePreviewLeg] = Field(default_factory=list)


stream_manager: Optional[StreamManager] = None


def _resolved_path(value: Any) -> Path:
    return Path(str(value)).expanduser().resolve()


def _absolute_path_without_symlink_resolution(value: Any) -> Path:
    """Keep the invoked venv path visible even when its python binary is a symlink."""
    return Path(os.path.abspath(str(Path(str(value)).expanduser())))


def _path_is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def runtime_provenance(
    *,
    interpreter: Optional[Any] = None,
    prefix: Optional[Any] = None,
    app_path: Optional[Any] = None,
    dependency_paths: Optional[Dict[str, Any]] = None,
    workspace_root: Optional[Any] = None,
) -> Dict[str, Any]:
    """Report resolved runtime paths and fail visibly on global dependency drift."""
    root = _resolved_path(workspace_root or WORKSPACE_ROOT)
    invoked_interpreter = _absolute_path_without_symlink_resolution(interpreter or sys.executable)
    resolved_interpreter = _resolved_path(invoked_interpreter)
    resolved_prefix = _resolved_path(prefix or sys.prefix)
    resolved_app = _resolved_path(app_path or __file__)
    if dependency_paths is None:
        dependency_paths = {
            name: module.__file__
            for name in ("fastapi", "ib_insync", "pydantic")
            for module in [sys.modules.get(name)]
            if module is not None and getattr(module, "__file__", None)
        }
    resolved_dependencies = {
        name: str(_resolved_path(path))
        for name, path in dependency_paths.items()
        if path
    }
    dependencies_inside_workspace = bool(resolved_dependencies) and all(
        _path_is_within(Path(path), root)
        for path in resolved_dependencies.values()
    )
    interpreter_inside_workspace = _path_is_within(invoked_interpreter, root)
    prefix_inside_workspace = _path_is_within(resolved_prefix, root)
    app_inside_workspace = _path_is_within(resolved_app, root)
    runtime_drift = not (
        interpreter_inside_workspace and
        dependencies_inside_workspace and
        prefix_inside_workspace and
        app_inside_workspace
    )
    return {
        "interpreter": str(invoked_interpreter),
        "interpreterRealPath": str(resolved_interpreter),
        "prefix": str(resolved_prefix),
        "appPath": str(resolved_app),
        "workspaceRoot": str(root),
        "dependencyPaths": resolved_dependencies,
        "interpreterInsideWorkspace": interpreter_inside_workspace,
        "dependenciesInsideWorkspace": dependencies_inside_workspace,
        "prefixInsideWorkspace": prefix_inside_workspace,
        "appInsideWorkspace": app_inside_workspace,
        "errorCode": "RUNTIME_DRIFT" if runtime_drift else None,
    }


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global stream_manager, reference_marks_startup_task, reference_marks_worker_task
    gateway_governor.validate_client_ids(
        {
            "primary": IB_CLIENT_ID,
            "funding": FUNDING_CLIENT_ID,
            "balance": BALANCE_CLIENT_ID,
            "reference_marks": REFERENCE_MARKS_CLIENT_ID,
            "positions": POSITIONS_SNAPSHOT_CLIENT_ID,
        }
    )
    gateway_governor.reset()
    gateway_governor.register_session(
        "primary", ib, client_id=IB_CLIENT_ID, primary=True
    )
    gateway_governor.register_session(
        "funding", funding_ib, client_id=FUNDING_CLIENT_ID
    )
    gateway_governor.register_session(
        "balance", balance_ib, client_id=BALANCE_CLIENT_ID
    )
    gateway_governor.register_session(
        "reference_marks", reference_marks_ib, client_id=REFERENCE_MARKS_CLIENT_ID
    )
    gateway_governor.register_session(
        "positions", positions_ib, client_id=POSITIONS_SNAPSHOT_CLIENT_ID
    )
    acquire_sidecar_lock()
    # ib_insync Connection uses asyncio.get_event_loop(); align it with uvicorn's loop.
    loop = asyncio.get_running_loop()
    asyncio.set_event_loop(loop)
    util.patchAsyncio()
    try:
        stream_manager = StreamManager(
            ib,
            host=IB_HOST,
            port=IB_PORT,
            client_id=IB_CLIENT_ID,
            connect_timeout=CONNECT_TIMEOUT,
            instrument_to_contract=instrument_to_contract,
            connection_governor=gateway_governor,
        )
        load_reference_close_cache()
        await stream_manager.start()
        reference_marks_startup_task = asyncio.create_task(
            reference_marks_background_scan()
        )
    except BaseException:
        release_sidecar_lock()
        raise

    try:
        yield
    finally:
        try:
            background_tasks = [
                task
                for task in (
                    reference_marks_startup_task,
                    reference_marks_worker_task,
                )
                if task and not task.done()
            ]
            for task in background_tasks:
                task.cancel()
            if background_tasks:
                await asyncio.gather(*background_tasks, return_exceptions=True)
            reference_marks_startup_task = None
            reference_marks_worker_task = None
            reference_marks_requested_accounts.clear()
            if stream_manager:
                await stream_manager.stop()
            elif ib.isConnected():
                try:
                    ib.disconnect()
                except Exception:
                    pass
            if funding_ib.isConnected():
                try:
                    funding_ib.disconnect()
                except Exception:
                    pass
            if balance_ib.isConnected():
                try:
                    balance_ib.disconnect()
                except Exception:
                    pass
            if reference_marks_ib.isConnected():
                try:
                    reference_marks_ib.disconnect()
                except Exception:
                    pass
            if positions_ib.isConnected():
                try:
                    positions_ib.disconnect()
                except Exception:
                    pass
            gateway_governor.invalidate_all()
        finally:
            release_sidecar_lock()


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from local_http_trust import LocalHttpTrust

app = FastAPI(title="IBKR Sidecar", version="1.1.0", lifespan=lifespan)
app.add_middleware(LocalHttpTrust)
def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def elapsed_ms(start: float) -> int:
    return int(round((time.monotonic() - start) * 1000))


class FundingEvidenceError(RuntimeError):
    def __init__(self, message: str, code: str = "FUNDING_EVIDENCE_UNAVAILABLE"):
        super().__init__(message)
        self.code = code


def finite_float(value: Any) -> Optional[float]:
    return strict_finite_float(value)


def money_cents(value: Any) -> int:
    """Normalize a finite broker monetary value to integer cents."""
    parsed = finite_float(value)
    if parsed is None:
        raise ValueError("A finite monetary value is required.")
    return int(
        (Decimal(str(value)) * Decimal("100")).quantize(
            Decimal("1"),
            rounding=ROUND_HALF_UP,
        )
    )


def iso_timestamp(value: Any) -> Optional[str]:
    if value is None:
        return None
    candidate = value
    if hasattr(candidate, "to_pydatetime"):
        candidate = candidate.to_pydatetime()
    if isinstance(candidate, str):
        try:
            candidate = datetime.fromisoformat(candidate.replace("Z", "+00:00"))
        except ValueError:
            return None
    if not isinstance(candidate, datetime) or candidate.tzinfo is None:
        return None
    return candidate.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def require_fresh_snapshot_timestamp(value: Any, now: Optional[datetime] = None) -> str:
    normalized = iso_timestamp(value)
    if not normalized:
        raise FundingEvidenceError(
            "A short-position snapshot did not include a timezone-aware IBKR timestamp.",
            "SHORT_SNAPSHOT_TIMESTAMP_MISSING",
        )
    observed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    current = now or datetime.now(timezone.utc)
    age_seconds = (current - observed).total_seconds()
    if age_seconds < -5 or age_seconds > FUNDING_QUOTE_MAX_AGE_SEC:
        raise FundingEvidenceError(
            "A short-position IBKR snapshot is stale.",
            "SHORT_SNAPSHOT_STALE",
        )
    return normalized


async def request_fresh_account_updates_multi(
    funding_session: IB,
    account: str,
) -> List[Dict[str, Any]]:
    """Capture only account values emitted for one reqAccountUpdatesMulti request."""
    wrapper = getattr(funding_session, "wrapper", None)
    client = getattr(funding_session, "client", None)
    if not wrapper or not client:
        raise FundingEvidenceError(
            "IBKR account-update request plumbing is unavailable.",
            "ACCOUNT_UPDATE_REQUEST_UNAVAILABLE",
        )

    req_id = client.getReqId()
    future = wrapper.startReq(req_id)
    captured: List[Dict[str, Any]] = []
    original_handler = getattr(wrapper, "accountUpdateMulti", None)
    if not callable(original_handler):
        raise FundingEvidenceError(
            "IBKR account-update callback is unavailable.",
            "ACCOUNT_UPDATE_CALLBACK_UNAVAILABLE",
        )

    instance_dict = getattr(wrapper, "__dict__", {})
    had_instance_handler = "accountUpdateMulti" in instance_dict
    prior_instance_handler = instance_dict.get("accountUpdateMulti")

    def capture_account_update(
        incoming_req_id: int,
        incoming_account: str,
        model_code: str,
        tag: str,
        value: str,
        currency: str,
    ) -> None:
        if incoming_req_id == req_id:
            captured.append(
                {
                    "account": incoming_account,
                    "modelCode": model_code,
                    "tag": tag,
                    "value": value,
                    "currency": currency,
                    "received_at": now_iso(),
                }
            )
        original_handler(
            incoming_req_id,
            incoming_account,
            model_code,
            tag,
            value,
            currency,
        )

    setattr(wrapper, "accountUpdateMulti", capture_account_update)
    cancel_error: Optional[Exception] = None
    try:
        # Request the full account update set. IBKR's ledgerAndNLV=True mode
        # returns only a reduced ledger subset and omits the segment fields
        # required by the portfolio-balance calculation.
        client.reqAccountUpdatesMulti(req_id, account, "", False)
        await asyncio.wait_for(future, timeout=FUNDING_ACCOUNT_UPDATE_TIMEOUT_SEC)
    finally:
        try:
            client.cancelAccountUpdatesMulti(req_id)
        except Exception as exc:
            cancel_error = exc
        if had_instance_handler:
            setattr(wrapper, "accountUpdateMulti", prior_instance_handler)
        else:
            try:
                delattr(wrapper, "accountUpdateMulti")
            except AttributeError:
                pass

    if cancel_error:
        raise FundingEvidenceError(
            f"IBKR account-update request could not be cancelled: {cancel_error}",
            "ACCOUNT_UPDATE_CANCEL_FAILED",
        )
    if not captured:
        raise FundingEvidenceError(
            "The fresh IBKR account-update request returned no values.",
            "ACCOUNT_UPDATE_EMPTY",
        )
    if any(row["account"] != account for row in captured):
        raise FundingEvidenceError(
            "The fresh IBKR account-update response did not exactly match the requested account.",
            "ACCOUNT_UPDATE_ACCOUNT_MISMATCH",
        )
    return captured


def currency_code(value: Any) -> Optional[str]:
    candidate = str(value or "").strip().upper()
    if candidate == "BASE":
        return None
    return candidate if re.fullmatch(r"[A-Z]{3}", candidate) else None


def infer_base_currency(rows: List[Dict[str, Any]]) -> str:
    explicit = [
        currency_code(row.get("value"))
        for row in rows
        if row.get("tag") in {"BaseCurrency", "Currency"}
        and str(row.get("currency") or "").strip().upper() in {"", "BASE"}
    ]
    explicit = list(dict.fromkeys(value for value in explicit if value))
    if len(explicit) == 1:
        return explicit[0]
    if len(explicit) > 1:
        raise FundingEvidenceError(
            "The fresh IBKR account update returned conflicting base currencies.",
            "BASE_CURRENCY_AMBIGUOUS",
        )

    currency_rows = [
        currency_code(row.get("value"))
        for row in rows
        if row.get("tag") in {"BaseCurrency", "Currency"}
    ]
    currency_rows = list(dict.fromkeys(value for value in currency_rows if value))
    if len(currency_rows) == 1:
        return currency_rows[0]

    nlv_currencies = [
        currency_code(row.get("currency"))
        for row in rows
        if row.get("tag") == "NetLiquidation"
    ]
    nlv_currencies = list(dict.fromkeys(value for value in nlv_currencies if value))
    if len(nlv_currencies) == 1:
        return nlv_currencies[0]

    raise FundingEvidenceError(
        "The fresh IBKR account update did not identify one base currency.",
        "BASE_CURRENCY_MISSING",
    )


def select_native_number(
    rows: List[Dict[str, Any]],
    tag: str,
    base_currency: str,
    *,
    required: bool = True,
) -> Optional[float]:
    matches = [row for row in rows if row.get("tag") == tag]
    if not matches:
        if required:
            raise FundingEvidenceError(
                f"The fresh IBKR account update omitted {tag}.",
                "ACCOUNT_VALUE_MISSING",
            )
        return None

    def priority(row: Dict[str, Any]) -> int:
        row_currency = str(row.get("currency") or "").strip().upper()
        if row_currency == base_currency:
            return 0
        if row_currency == "BASE":
            return 1
        if not row_currency:
            return 2
        return 3

    best_priority = min(priority(row) for row in matches)
    if best_priority == 3:
        raise FundingEvidenceError(
            f"The fresh IBKR account update returned {tag} only in a non-base currency.",
            "ACCOUNT_VALUE_CURRENCY_MISMATCH",
        )
    preferred = [row for row in matches if priority(row) == best_priority]
    parsed = [finite_float(row.get("value")) for row in preferred]
    if any(value is None for value in parsed):
        raise FundingEvidenceError(
            f"The fresh IBKR account update returned a non-numeric {tag}.",
            "ACCOUNT_VALUE_INVALID",
        )
    distinct = set(parsed)
    if len(distinct) != 1:
        raise FundingEvidenceError(
            f"The fresh IBKR account update returned conflicting {tag} values.",
            "ACCOUNT_VALUE_AMBIGUOUS",
        )
    return parsed[0]


def select_settled_cash_by_date(
    rows: List[Dict[str, Any]],
    base_currency: str,
    *,
    tag: str = "SettledCashByDate-S",
    required: bool = True,
) -> Optional[str]:
    """Validate IBKR's compact YYYYMMDD:amount ledger without changing it."""
    matches = [row for row in rows if row.get("tag") == tag]
    if not matches:
        if not required:
            return None
        raise FundingEvidenceError(
            f"The fresh IBKR account update omitted {tag}.",
            "ACCOUNT_VALUE_MISSING",
        )

    def priority(row: Dict[str, Any]) -> int:
        row_currency = str(row.get("currency") or "").strip().upper()
        if row_currency == base_currency:
            return 0
        if row_currency == "BASE":
            return 1
        if not row_currency:
            return 2
        return 3

    best_priority = min(priority(row) for row in matches)
    if best_priority == 3:
        raise FundingEvidenceError(
            f"The fresh IBKR account update returned {tag} only in a non-base currency.",
            "ACCOUNT_VALUE_CURRENCY_MISMATCH",
        )
    preferred = [row for row in matches if priority(row) == best_priority]
    values = [str(row.get("value") or "").strip() for row in preferred]
    if not values or any(not value for value in values):
        raise FundingEvidenceError(
            f"The fresh IBKR account update returned an empty {tag}.",
            "ACCOUNT_VALUE_INVALID",
        )
    if len(set(values)) != 1:
        raise FundingEvidenceError(
            f"The fresh IBKR account update returned conflicting {tag} values.",
            "ACCOUNT_VALUE_AMBIGUOUS",
        )

    value = values[0]
    seen_dates = set()
    for entry in value.split(";"):
        date_text, separator, amount_text = entry.partition(":")
        if not separator or len(date_text) != 8 or not date_text.isdigit():
            raise FundingEvidenceError(
                f"The fresh IBKR account update returned an invalid {tag}.",
                "ACCOUNT_VALUE_INVALID",
            )
        try:
            datetime.strptime(date_text, "%Y%m%d")
        except ValueError as exc:
            raise FundingEvidenceError(
                f"The fresh IBKR account update returned an invalid {tag} date.",
                "ACCOUNT_VALUE_INVALID",
            ) from exc
        if date_text in seen_dates or finite_float(amount_text) is None:
            raise FundingEvidenceError(
                f"The fresh IBKR account update returned an invalid {tag}.",
                "ACCOUNT_VALUE_INVALID",
            )
        seen_dates.add(date_text)
    return value


def compact_cash_by_date_amounts(value: str) -> List[float]:
    return [
        float(entry.partition(":")[2])
        for entry in value.split(";")
    ]


def compact_cash_by_date_rows(value: str) -> Dict[date, float]:
    return {
        datetime.strptime(entry.partition(":")[0], "%Y%m%d").date(): float(
            entry.partition(":")[2]
        )
        for entry in value.split(";")
    }


def require_fully_settled_securities_cash(
    summary: Dict[str, Any],
    settlement_date: date,
) -> None:
    for segment, label in (("S", "securities"), ("C", "commodities")):
        ledger_value = summary.get(f"SettledCashByDate-{segment}")
        total_cash = finite_float(summary.get(f"TotalCashValue-{segment}"))
        if not isinstance(ledger_value, str) or total_cash is None:
            raise FundingEvidenceError(
                f"The {label} cash ledger is unavailable.",
                "UNSETTLED_SECURITIES_ACTIVITY",
            )
        ledger = compact_cash_by_date_rows(ledger_value)
        if settlement_date not in ledger or any(
            day > settlement_date for day in ledger
        ):
            raise FundingEvidenceError(
                f"The {label} cash ledger includes unsettled or future-dated activity.",
                "UNSETTLED_SECURITIES_ACTIVITY",
            )
        if abs(ledger[settlement_date] - total_cash) > 0.01:
            raise FundingEvidenceError(
                f"TotalCashValue-{segment} does not reconcile to today's settled {label} cash.",
                "UNSETTLED_SECURITIES_ACTIVITY",
            )


def require_reference_cash_ladder(summary: Dict[str, Any]) -> None:
    """Validate a broker-reported weekend ladder without calling it settled today."""
    for segment, label in (("S", "securities"), ("C", "commodities")):
        ledger_value = summary.get(f"SettledCashByDate-{segment}")
        total_cash = finite_float(summary.get(f"TotalCashValue-{segment}"))
        if not isinstance(ledger_value, str) or total_cash is None:
            raise FundingEvidenceError(
                f"The {label} cash ladder is unavailable.",
                "REFERENCE_CASH_LADDER_UNAVAILABLE",
            )
        ledger = compact_cash_by_date_rows(ledger_value)
        if not ledger:
            raise FundingEvidenceError(
                f"The {label} cash ladder is empty.",
                "REFERENCE_CASH_LADDER_UNAVAILABLE",
            )
        terminal_date = max(ledger)
        if abs(ledger[terminal_date] - total_cash) > 0.01:
            raise FundingEvidenceError(
                f"TotalCashValue-{segment} does not reconcile to the terminal {label} cash-ladder balance.",
                "REFERENCE_CASH_LADDER_UNRECONCILED",
            )


def require_reconciled_cash_ladders(
    summary: Dict[str, Any],
    settlement_date: date,
) -> Dict[str, Any]:
    """Validate complete live settlement ladders without rejecting pending cash.

    A future-dated balance is normal evidence, not an error. The terminal row
    must still reconcile exactly to the broker's segment TotalCashValue, and a
    ladder whose newest row predates the broker date is rejected as stale.
    """
    horizon_dates: List[date] = []
    pending = False
    for segment, label in (("S", "securities"), ("C", "commodities")):
        ledger_value = summary.get(f"SettledCashByDate-{segment}")
        total_cash = finite_float(summary.get(f"TotalCashValue-{segment}"))
        if not isinstance(ledger_value, str) or total_cash is None:
            raise FundingEvidenceError(
                f"The {label} cash settlement ladder is unavailable.",
                "BALANCE_CASH_LADDER_UNAVAILABLE",
            )
        ledger = compact_cash_by_date_rows(ledger_value)
        if not ledger:
            raise FundingEvidenceError(
                f"The {label} cash settlement ladder is empty.",
                "BALANCE_CASH_LADDER_UNAVAILABLE",
            )
        if not any(day <= settlement_date for day in ledger):
            raise FundingEvidenceError(
                f"The {label} cash settlement ladder has no current balance anchor.",
                "BALANCE_CASH_LADDER_INCOMPLETE",
            )
        terminal_date = max(ledger)
        if terminal_date < settlement_date:
            raise FundingEvidenceError(
                f"The {label} cash settlement ladder is stale.",
                "BALANCE_CASH_LADDER_STALE",
            )
        if abs(ledger[terminal_date] - total_cash) > 0.01:
            raise FundingEvidenceError(
                f"TotalCashValue-{segment} does not reconcile to the terminal {label} cash-ladder balance.",
                "BALANCE_CASH_LADDER_UNRECONCILED",
            )
        horizon_dates.append(terminal_date)
        pending = pending or any(day > settlement_date for day in ledger)

    return {
        "state": "pending" if pending else "settled",
        "settlementDate": settlement_date.isoformat(),
        "horizonDate": max(horizon_dates).isoformat(),
    }


def reference_settlement_horizon(summary: Dict[str, Any]) -> date:
    dates = []
    for segment in ("S", "C"):
        ledger_value = summary.get(f"SettledCashByDate-{segment}")
        if isinstance(ledger_value, str):
            dates.extend(compact_cash_by_date_rows(ledger_value))
    if not dates:
        raise FundingEvidenceError(
            "The reference cash ladder has no dated balances.",
            "REFERENCE_CASH_LADDER_UNAVAILABLE",
        )
    return max(dates)


def funding_ledger_signature(summary: Dict[str, Any]) -> tuple:
    return (
        summary.get("TotalCashValue-S"),
        summary.get("SettledCashByDate-S"),
        summary.get("TotalCashValue-C"),
        summary.get("SettledCashByDate-C"),
        summary.get("TotalCashValue-Z"),
        summary.get("SettledCashByDate-Z"),
    )


def balance_snapshot_signature(
    summary: Dict[str, Any],
    positions: List[Any],
    open_order_count: int,
    execution_signature: tuple,
    settlement: Dict[str, Any],
) -> Dict[str, Any]:
    """Reduce both broker reads to the evidence that must remain unchanged."""
    return {
        "cash": funding_ledger_signature(summary),
        "margin": tuple(
            summary.get(tag) for tag in BALANCE_MARGIN_NUMERIC_TAGS
        ),
        "positions": position_quantity_signature(positions),
        "openOrders": open_order_count,
        "executions": execution_signature,
        "settlement": {
            "state": settlement.get("state"),
            "settlementDate": settlement.get("settlementDate"),
            "horizonDate": settlement.get("horizonDate"),
        },
    }


def build_balance_exposure_summary(
    rows: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Parse only broker-native aggregate exposure fields.

    Cash-ledger, instrument-scope, and position evidence intentionally do not
    participate so a capacity blocker cannot erase valid current exposure.
    """
    ready_rows = [row for row in rows if row.get("tag") == "AccountReady"]
    if not ready_rows or str(ready_rows[-1].get("value") or "").strip().lower() != "true":
        raise FundingEvidenceError(
            "IBKR did not report AccountReady=true for the fresh exposure snapshot.",
            "ACCOUNT_NOT_READY",
        )

    base_currency = infer_base_currency(rows)
    summary: Dict[str, Any] = {
        "baseCurrency": base_currency,
        "AccountReady": True,
        "NetLiquidation": select_native_number(
            rows,
            "NetLiquidation",
            base_currency,
        ),
        "StockMarketValue": select_native_number(
            rows,
            "StockMarketValue",
            base_currency,
        ),
    }
    gross_values = {
        tag: select_native_number(rows, tag, base_currency, required=False)
        for tag in FUNDING_GROSS_POSITION_TAGS
    }
    if all(value is None for value in gross_values.values()):
        raise FundingEvidenceError(
            "The fresh IBKR account update omitted GrossPositionValue.",
            "ACCOUNT_VALUE_MISSING",
        )
    summary.update({tag: value for tag, value in gross_values.items() if value is not None})
    return summary


def build_balance_margin_summary(
    rows: List[Dict[str, Any]],
    base_currency: str,
) -> Dict[str, float]:
    """Read broker-native margin health from the same fresh account update.

    These values are deliberately kept separate from the settled-cash interest
    model. A missing broker margin value makes the balance snapshot unavailable
    instead of allowing a model-derived cash deficit to masquerade as margin
    evidence.
    """
    return {
        tag: select_native_number(rows, tag, base_currency)
        for tag in BALANCE_MARGIN_NUMERIC_TAGS
    }


def build_funding_summary(
    rows: List[Dict[str, Any]],
    settlement_date: date,
) -> Dict[str, Any]:
    ready_rows = [row for row in rows if row.get("tag") == "AccountReady"]
    if not ready_rows or str(ready_rows[-1].get("value") or "").strip().lower() != "true":
        raise FundingEvidenceError(
            "IBKR did not report AccountReady=true for the fresh funding snapshot.",
            "ACCOUNT_NOT_READY",
        )

    base_currency = infer_base_currency(rows)
    summary: Dict[str, Any] = {
        "baseCurrency": base_currency,
        "AccountReady": True,
    }
    for tag in FUNDING_REQUIRED_NUMERIC_TAGS:
        summary[tag] = select_native_number(rows, tag, base_currency)
    summary["SettledCashByDate-S"] = select_settled_cash_by_date(rows, base_currency)
    summary["SettledCashByDate-C"] = select_settled_cash_by_date(
        rows,
        base_currency,
        tag="SettledCashByDate-C",
    )

    # FxCashBalance is IBKR's account-value evidence for cash held in the
    # related IB-UKL account. Do not silently treat an omitted or nonzero value
    # as available securities cash.
    fx_cash_balance = select_native_number(
        rows,
        "FxCashBalance",
        base_currency,
        required=True,
    )
    if fx_cash_balance != 0:
        raise FundingEvidenceError(
            "The account has a nonzero IB-UKL cash balance that this funding calculation does not support.",
            "IBUKL_CASH_SEGMENT_UNSUPPORTED",
        )
    summary["FxCashBalance"] = fx_cash_balance

    total_cash_z = select_native_number(
        rows,
        "TotalCashValue-Z",
        base_currency,
        required=False,
    )
    settled_cash_z = select_settled_cash_by_date(
        rows,
        base_currency,
        tag="SettledCashByDate-Z",
        required=False,
    )
    z_segment_rows = [
        row
        for row in rows
        if str(row.get("tag") or "") == "SegmentTitle-Z"
        or str(row.get("tag") or "").endswith("-Z")
    ]
    if (total_cash_z is None) != (settled_cash_z is None):
        raise FundingEvidenceError(
            "The fresh IBKR account update returned incomplete Z-segment cash evidence.",
            "ACCOUNT_VALUE_MISSING",
        )
    if total_cash_z is None and settled_cash_z is None:
        # Some accounts have no Z segment and therefore emit no -Z keys at all.
        # Treat that as zero only when the same fresh response proves both
        # absence of the segment and exact reconciliation of total cash to the
        # securities and commodities segments.
        if z_segment_rows:
            raise FundingEvidenceError(
                "The fresh IBKR account update identified a Z segment but omitted its cash ledger.",
                "ACCOUNT_VALUE_MISSING",
            )
        cash_reconciliation = (
            summary["TotalCashValue"]
            - summary["TotalCashValue-S"]
            - summary["TotalCashValue-C"]
        )
        if abs(cash_reconciliation) > 0.01:
            raise FundingEvidenceError(
                "Total cash does not reconcile to the reported securities and commodities segments.",
                "CASH_SEGMENT_RECONCILIATION_FAILED",
            )
        total_cash_z = 0.0
        settled_cash_z = f"{settlement_date:%Y%m%d}:0"
        summary["cashSegmentZVerification"] = "absent_reconciled_zero"
    else:
        cash_reconciliation = (
            summary["TotalCashValue"]
            - summary["TotalCashValue-S"]
            - summary["TotalCashValue-C"]
            - total_cash_z
        )
        if abs(cash_reconciliation) > 0.01:
            raise FundingEvidenceError(
                "Total cash does not reconcile to the reported account segments.",
                "CASH_SEGMENT_RECONCILIATION_FAILED",
            )
        summary["cashSegmentZVerification"] = "explicit_zero"
    if (
        (total_cash_z is not None and total_cash_z != 0)
        or (
            settled_cash_z is not None
            and any(amount != 0 for amount in compact_cash_by_date_amounts(settled_cash_z))
        )
    ):
        raise FundingEvidenceError(
            "The account has a nonzero IBUKL cash segment that this funding calculation does not support.",
            "IBUKL_CASH_SEGMENT_UNSUPPORTED",
        )
    summary["TotalCashValue-Z"] = total_cash_z
    summary["SettledCashByDate-Z"] = settled_cash_z

    gross_values = {
        tag: select_native_number(rows, tag, base_currency, required=False)
        for tag in FUNDING_GROSS_POSITION_TAGS
    }
    if all(value is None for value in gross_values.values()):
        raise FundingEvidenceError(
            "The fresh IBKR account update omitted GrossPositionValue.",
            "ACCOUNT_VALUE_MISSING",
        )
    summary.update({tag: value for tag, value in gross_values.items() if value is not None})

    cash_balances: Dict[str, float] = {}
    for row in rows:
        if row.get("tag") != "CashBalance":
            continue
        row_currency = str(row.get("currency") or "").strip().upper()
        balance_currency = base_currency if row_currency in {"", "BASE"} else currency_code(row_currency)
        value = finite_float(row.get("value"))
        if not balance_currency or value is None:
            raise FundingEvidenceError(
                "The fresh IBKR account update returned an invalid currency cash balance.",
                "CASH_BALANCE_INVALID",
            )
        if balance_currency in cash_balances and cash_balances[balance_currency] != value:
            raise FundingEvidenceError(
                f"The fresh IBKR account update returned conflicting {balance_currency} cash balances.",
                "CASH_BALANCE_AMBIGUOUS",
            )
        cash_balances[balance_currency] = value
    if base_currency not in cash_balances:
        raise FundingEvidenceError(
            f"The fresh IBKR account update omitted the {base_currency} cash balance.",
            "CASH_BALANCE_MISSING",
        )
    non_base_balances = {
        currency: value
        for currency, value in cash_balances.items()
        if currency != base_currency and value != 0
    }
    if non_base_balances:
        raise FundingEvidenceError(
            "The account has a nonzero non-base-currency cash balance that this funding calculation does not support.",
            "NON_BASE_CURRENCY_CASH_UNSUPPORTED",
        )
    summary["CashBalance"] = dict(sorted(cash_balances.items()))
    return summary


def supported_stock_positions_from_snapshot(
    raw_positions: Any,
    account: str,
    base_currency: Optional[str] = None,
) -> List[Any]:
    if raw_positions is None:
        raise FundingEvidenceError(
            "The fresh IBKR positions request returned no result.",
            "POSITIONS_UNAVAILABLE",
        )

    positions: List[Any] = []
    for position in list(raw_positions):
        position_account = str(getattr(position, "account", "") or "")
        quantity = finite_float(getattr(position, "position", None))
        if not position_account:
            raise FundingEvidenceError(
                "An IBKR position omitted its account.",
                "POSITION_ACCOUNT_MISSING",
            )
        if position_account != account:
            continue
        if quantity is None:
            raise FundingEvidenceError(
                "An IBKR position returned an invalid quantity.",
                "POSITION_QUANTITY_INVALID",
            )
        if quantity == 0:
            continue
        contract = getattr(position, "contract", None)
        sec_type = str(getattr(contract, "secType", "") or "").upper()
        currency = str(getattr(contract, "currency", "") or "").upper()
        if sec_type != "STK" or currency != "USD":
            raise FundingEvidenceError(
                "Portfolio balance supports only open USD stock positions.",
                "POSITION_SCOPE_UNSUPPORTED",
            )
        if base_currency and currency != base_currency:
            raise FundingEvidenceError(
                "An open position is not denominated in the account base currency.",
                "POSITION_CURRENCY_MISMATCH",
            )
        positions.append(position)
    return positions


async def request_fresh_supported_stock_positions(
    funding_session: IB,
    account: str,
) -> List[Any]:
    """Read one uncached position snapshot from the appropriate persistent client.

    Portfolio balance must share the dedicated positions client with the live
    positions endpoint. Funding and interest observations retain their own
    already-persistent session so their larger broker evidence transaction
    remains internally ordered.
    """
    try:
        if funding_session is balance_ib:
            raw_positions = await fetch_raw_positions_via_persistent_session(
                [account],
                timeout_sec=POSITIONS_REQUEST_TIMEOUT_SEC,
                require_exact_accounts=False,
            )
        else:
            raw_positions = await req_positions_bounded(
                funding_session,
                timeout_sec=POSITIONS_REQUEST_TIMEOUT_SEC,
            )
    except asyncio.TimeoutError as exc:
        raise FundingEvidenceError(
            "The fresh IBKR positions request timed out.",
            "IBKR_POSITIONS_REQUEST_TIMEOUT",
        ) from exc
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        code = getattr(exc, "error_code", None) or "IBKR_POSITIONS_CLIENT_UNAVAILABLE"
        raise FundingEvidenceError(
            f"Fresh account-scoped IBKR positions are unavailable: {exc}",
            code,
        ) from exc
    return supported_stock_positions_from_snapshot(raw_positions, account)


def _contract_from_details(details: Any) -> Any:
    contract = getattr(details, "contract", None)
    return contract if contract is not None else details


def _contract_multiplier(contract: Any) -> Optional[float]:
    value = getattr(contract, "multiplier", None)
    if value in (None, ""):
        return None
    return finite_float(value)


async def qualify_balance_event_contract(
    funding_session: IB,
    position: Any,
    qualification_cache: Dict[int, Dict[str, Any]],
) -> Dict[str, Any]:
    """Qualify one event position from live IBKR contract identity.

    The position snapshot does not reliably carry the venue, so symbols and
    local-name heuristics are deliberately ignored. The request-local cache
    avoids duplicate conid requests during one balance read but never survives
    the request or substitutes for a live Gateway response.
    """
    raw_contract = getattr(position, "contract", None)
    con_id = int(getattr(raw_contract, "conId", 0) or 0)
    if con_id <= 0:
        raise FundingEvidenceError(
            "A non-stock balance position omitted a valid IBKR conId.",
            "POSITION_SCOPE_UNSUPPORTED",
        )
    raw_sec_type = str(getattr(raw_contract, "secType", "") or "").upper()
    if raw_sec_type not in {"FOP", "OPT"}:
        raise FundingEvidenceError(
            "Only exact IBKR option-modeled event contracts are supported.",
            "POSITION_SCOPE_UNSUPPORTED",
        )

    if con_id not in qualification_cache:
        try:
            details = await asyncio.wait_for(
                funding_session.reqContractDetailsAsync(
                    Contract(conId=con_id)
                ),
                timeout=FUNDING_QUALIFICATION_TIMEOUT_SEC,
            )
        except asyncio.TimeoutError as exc:
            raise FundingEvidenceError(
                f"IBKR contract qualification timed out for conId {con_id}.",
                "EVENT_CONTRACT_DETAILS_TIMEOUT",
            ) from exc
        except Exception as exc:
            raise FundingEvidenceError(
                f"IBKR contract qualification failed for conId {con_id}: {exc}",
                "EVENT_CONTRACT_DETAILS_UNAVAILABLE",
            ) from exc

        exact_details = [
            detail
            for detail in list(details or [])
            if int(
                getattr(_contract_from_details(detail), "conId", 0) or 0
            ) == con_id
        ]
        if len(exact_details) != 1:
            raise FundingEvidenceError(
                f"IBKR did not uniquely qualify event-contract conId {con_id}.",
                "POSITION_SCOPE_UNSUPPORTED",
            )
        qualified_detail = exact_details[0]
        qualified = _contract_from_details(qualified_detail)
        exchange = str(getattr(qualified, "exchange", "") or "").upper()
        qualified_sec_type = str(
            getattr(qualified, "secType", "") or ""
        ).upper()
        raw_valid_exchanges = (
            getattr(qualified_detail, "validExchanges", None)
            or getattr(qualified, "validExchanges", None)
            or ""
        )
        valid_exchanges = {
            value.strip().upper()
            for value in str(raw_valid_exchanges).split(",")
            if value.strip()
        }
        if (
            exchange not in SUPPORTED_EVENT_CONTRACT_VENUES
            or qualified_sec_type not in (
                SUPPORTED_EVENT_CONTRACT_TYPES_BY_VENUE.get(
                    exchange,
                    frozenset(),
                )
            )
            or raw_sec_type != qualified_sec_type
            or (
                valid_exchanges
                and exchange not in valid_exchanges
            )
            or str(getattr(qualified, "currency", "") or "").upper() != "USD"
            or _contract_multiplier(qualified) != 1
        ):
            raise FundingEvidenceError(
                f"IBKR conId {con_id} is not a supported USD event contract.",
                "POSITION_SCOPE_UNSUPPORTED",
            )
        qualification_cache[con_id] = {
            "conId": con_id,
            "symbol": str(getattr(qualified, "symbol", "") or "").upper(),
            "localSymbol": str(
                getattr(qualified, "localSymbol", "") or ""
            ),
            "tradingClass": str(
                getattr(qualified, "tradingClass", "") or ""
            ),
            "exchange": exchange,
            "secType": qualified_sec_type,
            "currency": "USD",
            "multiplier": 1,
        }
    return qualification_cache[con_id]


async def balance_positions_from_snapshot(
    raw_positions: Any,
    account: str,
    base_currency: str,
    funding_session: IB,
) -> Dict[str, Any]:
    """Split one fresh position snapshot into stock and verified event rows."""
    if raw_positions is None:
        raise FundingEvidenceError(
            "The fresh IBKR positions request returned no result.",
            "POSITIONS_UNAVAILABLE",
        )
    normalized_base_currency = str(base_currency or "").upper()
    if normalized_base_currency != "USD":
        raise FundingEvidenceError(
            "Event-contract-aware portfolio balance requires a USD base currency.",
            "POSITION_CURRENCY_MISMATCH",
        )

    all_positions: List[Any] = []
    stock_positions: List[Any] = []
    event_positions: List[Dict[str, Any]] = []
    seen_con_ids: Set[int] = set()
    qualification_cache: Dict[int, Dict[str, Any]] = {}

    for position in list(raw_positions):
        position_account = str(getattr(position, "account", "") or "")
        if not position_account:
            raise FundingEvidenceError(
                "An IBKR position omitted its account.",
                "POSITION_ACCOUNT_MISSING",
            )
        if position_account != account:
            continue
        quantity = finite_float(getattr(position, "position", None))
        if quantity is None:
            raise FundingEvidenceError(
                "An IBKR position returned an invalid quantity.",
                "POSITION_QUANTITY_INVALID",
            )
        if quantity == 0:
            continue
        contract = getattr(position, "contract", None)
        con_id = int(getattr(contract, "conId", 0) or 0)
        if con_id <= 0 or con_id in seen_con_ids:
            raise FundingEvidenceError(
                "The fresh IBKR positions contained an invalid or duplicate conId.",
                "POSITION_SCOPE_UNSUPPORTED",
            )
        seen_con_ids.add(con_id)
        sec_type = str(getattr(contract, "secType", "") or "").upper()
        currency = str(getattr(contract, "currency", "") or "").upper()
        if sec_type == "STK":
            if currency != normalized_base_currency:
                raise FundingEvidenceError(
                    "An open stock position is not denominated in the account base currency.",
                    "POSITION_CURRENCY_MISMATCH",
                )
            stock_positions.append(position)
            all_positions.append(position)
            continue

        # IBKR event venues support fixed-point contract quantities, and IBKR
        # reports those live quantities directly (for example, 499.17).
        # Sign and finiteness are validated here; broker-native value/margin
        # reconciliation below remains mandatory before capacity is enabled.
        if quantity <= 0:
            raise FundingEvidenceError(
                "Event-contract positions must be positive quantities.",
                "POSITION_SCOPE_UNSUPPORTED",
            )
        qualified = await qualify_balance_event_contract(
            funding_session,
            position,
            qualification_cache,
        )
        event_positions.append({
            **qualified,
            "quantity": quantity,
        })
        all_positions.append(position)

    event_venues = sorted({
        row["exchange"] for row in event_positions
    })
    return {
        "all": all_positions,
        "stocks": stock_positions,
        "eventContracts": event_positions,
        "positionScope": {
            "mode": (
                "stocks_and_event_contracts"
                if event_positions
                else "stocks_only"
            ),
            "eventVenues": event_venues,
            "allSupportedForBalance": True,
            "allStock": not event_positions,
            "allBaseCurrency": True,
            "stockPositionCount": len(stock_positions),
            "eventPositionCount": len(event_positions),
        },
    }


async def request_fresh_balance_position_rows(
    funding_session: IB,
    account: str,
) -> List[Any]:
    """Read the same fresh balance positions before currency qualification."""
    try:
        if funding_session is balance_ib:
            raw_positions = await fetch_raw_positions_via_persistent_session(
                [account],
                timeout_sec=POSITIONS_REQUEST_TIMEOUT_SEC,
                require_exact_accounts=False,
            )
        else:
            raw_positions = await req_positions_bounded(
                funding_session,
                timeout_sec=POSITIONS_REQUEST_TIMEOUT_SEC,
            )
    except asyncio.TimeoutError as exc:
        raise FundingEvidenceError(
            "The fresh IBKR positions request timed out.",
            "IBKR_POSITIONS_REQUEST_TIMEOUT",
        ) from exc
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        code = getattr(exc, "error_code", None) or "IBKR_POSITIONS_CLIENT_UNAVAILABLE"
        raise FundingEvidenceError(
            f"Fresh account-scoped IBKR positions are unavailable: {exc}",
            code,
        ) from exc
    return raw_positions


async def request_fresh_balance_positions(
    funding_session: IB,
    account: str,
    base_currency: str,
) -> Dict[str, Any]:
    """Read and qualify one fresh balance position snapshot.

    Portfolio balance and interest observations use this mixed scope. Trade
    previews intentionally retain the strict stock-only reader.
    """
    return await balance_positions_from_snapshot(
        await request_fresh_balance_position_rows(funding_session, account),
        account,
        base_currency,
        funding_session,
    )


@asynccontextmanager
async def fresh_balance_read_bracket(
    funding_session: IB,
    account: str,
    timings: Dict[str, Any],
    *,
    prefix: str = "",
):
    """Overlap independent fresh reads within one verification bracket.

    Callers still await and validate them in the original order. No completed
    result is reused between brackets, and every outstanding read is joined
    before the caller can release its account-scoped balance lock.
    """
    async def timed_read(label, operation):
        started = time.monotonic()
        try:
            return await operation
        finally:
            timings[f"{prefix}{label}_ms"] = elapsed_ms(started)

    tasks = {
        "account": asyncio.create_task(timed_read(
            "account_values", request_fresh_account_updates_multi(funding_session, account),
        )),
        "positions": asyncio.create_task(timed_read(
            "positions", request_fresh_balance_position_rows(funding_session, account),
        )),
        "orders": asyncio.create_task(timed_read(
            "open_orders", request_fresh_open_order_count(funding_session, account),
        )),
        "executions": asyncio.create_task(timed_read(
            "executions", request_fresh_account_execution_signature(funding_session, account),
        )),
    }
    try:
        yield tasks
    finally:
        for task in tasks.values():
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks.values(), return_exceptions=True)


def build_event_contract_accounting_summary(
    rows: List[Dict[str, Any]],
    base_currency: str,
    event_positions: List[Dict[str, Any]],
    *,
    total_gross_position_value: Optional[float] = None,
    stock_gross_position_value: Optional[float] = None,
) -> Optional[Dict[str, Any]]:
    """Validate broker-native event-contract segment accounting for one read."""
    event_position_count = len(event_positions)
    event_exchanges = [
        str(position.get("exchange") or "").upper()
        for position in event_positions
    ]
    event_venues = sorted(set(event_exchanges))
    if (
        event_position_count > 0
        and (
            not event_venues
            or any(
                venue not in SUPPORTED_EVENT_CONTRACT_VENUES
                for venue in event_exchanges
            )
        )
    ):
        raise FundingEvidenceError(
            "Event-contract accounting received an unsupported venue.",
            "EVENT_CONTRACT_ACCOUNTING_UNRECONCILED",
        )
    if event_position_count == 0:
        commodity_gross = select_native_number(
            rows,
            "GrossPositionValue-C",
            base_currency,
            required=False,
        )
        if (
            commodity_gross is not None
            and abs(money_cents(commodity_gross)) > ACCOUNT_VALUE_TOLERANCE_CENTS
        ):
            raise FundingEvidenceError(
                "IBKR reported unexplained commodity exposure without supported event contracts.",
                "EVENT_CONTRACT_ACCOUNTING_UNRECONCILED",
            )
        return None

    values = {
        tag: select_native_number(rows, tag, base_currency)
        for tag in EVENT_CONTRACT_ACCOUNTING_TAGS
    }
    if any(value is None for value in values.values()):
        raise FundingEvidenceError(
            "IBKR omitted a required event-contract commodity-accounting value.",
            "EVENT_CONTRACT_ACCOUNTING_UNRECONCILED",
        )
    market_value = values["GrossPositionValue-C"]
    if money_cents(market_value) < -ACCOUNT_VALUE_TOLERANCE_CENTS:
        raise FundingEvidenceError(
            "IBKR returned a negative event-contract commodity market value.",
            "EVENT_CONTRACT_ACCOUNTING_UNRECONCILED",
        )
    if total_gross_position_value is None or stock_gross_position_value is None:
        raise FundingEvidenceError(
            "IBKR omitted total or securities gross position value needed to separate event-contract exposure.",
            "EVENT_CONTRACT_ACCOUNTING_UNRECONCILED",
        )
    if abs(
        money_cents(total_gross_position_value)
        - money_cents(stock_gross_position_value)
        - money_cents(market_value)
    ) > ACCOUNT_VALUE_TOLERANCE_CENTS:
        raise FundingEvidenceError(
            "IBKR gross position values do not reconcile across account segments.",
            "EVENT_CONTRACT_ACCOUNTING_UNRECONCILED",
        )
    market_value_cents = money_cents(market_value)
    net_liquidation_cents = money_cents(values["NetLiquidation-C"])
    cash_value_cents = money_cents(values["TotalCashValue-C"])
    initial_margin_cents = money_cents(values["InitMarginReq-C"])
    maintenance_margin_cents = money_cents(values["MaintMarginReq-C"])
    equity_cents = money_cents(values["EquityWithLoanValue-C"])
    theoretical_available_cents = net_liquidation_cents - initial_margin_cents
    theoretical_available_funds = theoretical_available_cents / 100
    cent_differences = (
        net_liquidation_cents - cash_value_cents - market_value_cents,
        initial_margin_cents - market_value_cents,
        maintenance_margin_cents - market_value_cents,
        equity_cents
        - cash_value_cents
        - market_value_cents
        + maintenance_margin_cents,
    )
    if any(
        abs(difference) > ACCOUNT_VALUE_TOLERANCE_CENTS
        for difference in cent_differences
    ):
        raise FundingEvidenceError(
            "IBKR event-contract value, margin, and equity tags do not reconcile.",
            "EVENT_CONTRACT_ACCOUNTING_UNRECONCILED",
        )
    available_funds = values["AvailableFunds-C"]
    available_funds_cents = money_cents(available_funds)
    if (
        available_funds_cents < -ACCOUNT_VALUE_TOLERANCE_CENTS
        or available_funds_cents
        > theoretical_available_cents + ACCOUNT_VALUE_TOLERANCE_CENTS
    ):
        raise FundingEvidenceError(
            "IBKR event-contract available funds exceed the reconciled commodity residual.",
            "EVENT_CONTRACT_ACCOUNTING_UNRECONCILED",
        )
    # IBKR may retain an additional broker-native commodity holdback even
    # when a long event-contract position's value and margin fully offset. It
    # is safe only in the conservative direction: never infer more usable cash
    # than AvailableFunds-C reports, and preserve the difference as evidence.
    available_funds_holdback = max(
        0.0,
        (theoretical_available_cents - available_funds_cents) / 100,
    )
    return {
        "venues": event_venues,
        "positionCount": event_position_count,
        "marketValue": market_value,
        "initialMargin": values["InitMarginReq-C"],
        "maintenanceMargin": values["MaintMarginReq-C"],
        "availableFunds": values["AvailableFunds-C"],
        "equityWithLoanValue": values["EquityWithLoanValue-C"],
        "theoreticalAvailableFunds": theoretical_available_funds,
        "availableFundsHoldback": available_funds_holdback,
        "capacityContribution": 0.0,
        "verification": "ibkr_event_contract_commodity_segment_reconciled",
        "accountValues": values,
    }


def require_positions_in_base_currency(positions: List[Any], base_currency: str) -> None:
    for position in positions:
        position_currency = str(
            getattr(getattr(position, "contract", None), "currency", "") or ""
        ).upper()
        if position_currency != base_currency:
            raise FundingEvidenceError(
                "An open position is not denominated in the account base currency.",
                "POSITION_CURRENCY_MISMATCH",
            )


async def request_fresh_open_order_count(
    funding_session: IB,
    account: str,
) -> int:
    try:
        trades = await asyncio.wait_for(
            funding_session.reqAllOpenOrdersAsync(),
            timeout=FUNDING_OPEN_ORDERS_TIMEOUT_SEC,
        )
    except asyncio.TimeoutError as exc:
        raise FundingEvidenceError(
            "The fresh IBKR all-open-orders request timed out.",
            "OPEN_ORDERS_TIMEOUT",
        ) from exc
    except Exception as exc:
        raise FundingEvidenceError(
            f"Fresh IBKR open orders are unavailable: {exc}",
            "OPEN_ORDERS_UNAVAILABLE",
        ) from exc
    if trades is None:
        raise FundingEvidenceError(
            "The fresh IBKR all-open-orders request returned no result.",
            "OPEN_ORDERS_UNAVAILABLE",
        )

    count = 0
    for trade in list(trades):
        order_account = str(
            getattr(getattr(trade, "order", None), "account", "") or ""
        ).strip()
        if not order_account:
            raise FundingEvidenceError(
                "A freshly returned open IBKR order omitted its account.",
                "OPEN_ORDER_ACCOUNT_MISSING",
            )
        if order_account == account:
            count += 1
    return count


async def request_fresh_account_execution_signature(
    funding_session: IB,
    account: str,
) -> tuple:
    try:
        fills = await asyncio.wait_for(
            funding_session.reqExecutionsAsync(
                ExecutionFilter(acctCode=account)
            ),
            timeout=FUNDING_EXECUTIONS_TIMEOUT_SEC,
        )
    except asyncio.TimeoutError as exc:
        raise FundingEvidenceError(
            "The fresh account-filtered IBKR executions request timed out.",
            "EXECUTIONS_TIMEOUT",
        ) from exc
    except Exception as exc:
        raise FundingEvidenceError(
            f"Fresh account-filtered IBKR executions are unavailable: {exc}",
            "EXECUTIONS_UNAVAILABLE",
        ) from exc
    if fills is None:
        raise FundingEvidenceError(
            "The fresh account-filtered IBKR executions request returned no result.",
            "EXECUTIONS_UNAVAILABLE",
        )

    signature = []
    for fill in list(fills):
        execution = getattr(fill, "execution", None)
        execution_account = str(
            getattr(execution, "acctNumber", "") or ""
        ).strip()
        if not execution_account:
            raise FundingEvidenceError(
                "A freshly returned IBKR execution omitted its account.",
                "EXECUTION_ACCOUNT_MISSING",
            )
        if execution_account != account:
            raise FundingEvidenceError(
                "The account-filtered IBKR execution response included another account.",
                "EXECUTION_ACCOUNT_MISMATCH",
            )
        execution_id = str(getattr(execution, "execId", "") or "").strip()
        if not execution_id:
            raise FundingEvidenceError(
                "A freshly returned IBKR execution omitted its execution ID.",
                "EXECUTION_EVIDENCE_INVALID",
            )
        signature.append(execution_id)
    if len(set(signature)) != len(signature):
        raise FundingEvidenceError(
            "The fresh IBKR execution response contained duplicate execution IDs.",
            "EXECUTION_EVIDENCE_INVALID",
        )
    return tuple(sorted(signature))


async def request_fresh_account_execution_evidence(
    funding_session: IB,
    account: str,
) -> Dict[str, Any]:
    """Read account-filtered executions without consulting ib_insync caches."""
    try:
        fills = await asyncio.wait_for(
            funding_session.reqExecutionsAsync(
                ExecutionFilter(acctCode=account)
            ),
            timeout=FUNDING_EXECUTIONS_TIMEOUT_SEC,
        )
    except asyncio.TimeoutError as exc:
        raise FundingEvidenceError(
            "The fresh account-filtered IBKR executions request timed out.",
            "EXECUTIONS_TIMEOUT",
        ) from exc
    except Exception as exc:
        raise FundingEvidenceError(
            f"Fresh account-filtered IBKR executions are unavailable: {exc}",
            "EXECUTIONS_UNAVAILABLE",
        ) from exc
    if fills is None:
        raise FundingEvidenceError(
            "The fresh account-filtered IBKR executions request returned no result.",
            "EXECUTIONS_UNAVAILABLE",
        )

    rows: List[Dict[str, Any]] = []
    for fill in list(fills):
        execution = getattr(fill, "execution", None)
        execution_account = str(
            getattr(execution, "acctNumber", "") or ""
        ).strip()
        if not execution_account:
            raise FundingEvidenceError(
                "A freshly returned IBKR execution omitted its account.",
                "EXECUTION_ACCOUNT_MISSING",
            )
        if execution_account != account:
            raise FundingEvidenceError(
                "The account-filtered IBKR execution response included another account.",
                "EXECUTION_ACCOUNT_MISMATCH",
            )
        execution_id = str(
            getattr(execution, "execId", "") or ""
        ).strip()
        if not execution_id:
            raise FundingEvidenceError(
                "A freshly returned IBKR execution omitted its execution ID.",
                "EXECUTION_EVIDENCE_INVALID",
            )

        row: Dict[str, Any] = {"execId": execution_id, "accountId": account}
        contract = getattr(fill, "contract", None)
        con_id = int(getattr(contract, "conId", 0) or 0)
        if con_id > 0:
            row["conId"] = con_id
        for field, attr in (
            ("symbol", "symbol"),
            ("localSymbol", "localSymbol"),
            ("description", "description"),
            ("exchange", "exchange"),
            ("secType", "secType"),
            ("tradingClass", "tradingClass"),
            ("expiration", "lastTradeDateOrContractMonth"),
            ("contractSide", "right"),
        ):
            value = getattr(contract, attr, None)
            if value not in (None, ""):
                row[field] = str(value)
        strike = finite_float(getattr(contract, "strike", None))
        if strike is not None:
            row["strike"] = strike
        execution_time = (
            getattr(fill, "time", None)
            or getattr(execution, "time", None)
        )
        if execution_time is not None:
            row["executionTime"] = (
                iso_timestamp(execution_time)
                or str(execution_time).strip()
            )
        side = str(getattr(execution, "side", "") or "").strip()
        if side:
            row["side"] = side
        shares = finite_float(getattr(execution, "shares", None))
        if shares is not None:
            row["shares"] = shares
        price = finite_float(getattr(execution, "price", None))
        if price is not None:
            row["price"] = price
        for field, attr in (
            ("orderId", "orderId"),
            ("permId", "permId"),
            ("clientId", "clientId"),
            ("cumQty", "cumQty"),
            ("avgPrice", "avgPrice"),
            ("liquidation", "liquidation"),
            ("lastLiquidity", "lastLiquidity"),
        ):
            value = finite_float(getattr(execution, attr, None))
            if value is not None:
                row[field] = int(value) if field in {
                    "orderId", "permId", "clientId", "liquidation", "lastLiquidity"
                } else value
        order_ref = str(getattr(execution, "orderRef", "") or "").strip()
        if order_ref:
            row["orderRef"] = order_ref
        commission_report = getattr(fill, "commissionReport", None)
        # ib_insync creates a blank, zero-valued CommissionReport before the
        # broker report arrives, including on repeated execution requests.
        # Only an explicitly matched report is accounting evidence; its
        # default zeros must not be mistaken for verified fees or P&L.
        commission_execution_id = str(
            getattr(commission_report, "execId", "") or ""
        ).strip()
        if commission_execution_id == execution_id:
            commission = finite_float(getattr(commission_report, "commission", None))
            if commission is not None:
                row["commission"] = commission
            commission_currency = str(getattr(commission_report, "currency", "") or "").strip()
            if commission_currency:
                row["commissionCurrency"] = commission_currency
            realized_pnl = finite_float(getattr(commission_report, "realizedPNL", None))
            if realized_pnl is not None:
                row["realizedPNL"] = realized_pnl
        rows.append(row)

    rows.sort(key=lambda row: row["execId"])
    if len({row["execId"] for row in rows}) != len(rows):
        raise FundingEvidenceError(
            "The fresh IBKR execution response contained duplicate execution IDs.",
            "EXECUTION_EVIDENCE_INVALID",
        )
    return {
        "asOf": now_iso(),
        "count": len(rows),
        "rows": rows,
        "signature": tuple(
            json.dumps(
                row,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            )
            for row in rows
        ),
    }


def position_quantity_signature(positions: List[Any]) -> tuple:
    rows = []
    for position in positions:
        contract = getattr(position, "contract", None)
        con_id = int(getattr(contract, "conId", 0) or 0)
        quantity = finite_float(getattr(position, "position", None))
        if con_id <= 0 or quantity is None:
            raise FundingEvidenceError(
                "A fresh IBKR position could not be identified for settlement verification.",
                "UNSETTLED_SECURITIES_ACTIVITY",
            )
        rows.append((con_id, quantity))
    if len({con_id for con_id, _quantity in rows}) != len(rows):
        raise FundingEvidenceError(
            "The fresh IBKR positions contained duplicate contracts.",
            "UNSETTLED_SECURITIES_ACTIVITY",
        )
    return tuple(sorted(rows))


def positive_float(value: Any) -> Optional[float]:
    parsed = finite_float(value)
    return parsed if parsed is not None and parsed > 0 else None


def fresh_snapshot_timestamp(value: Any) -> Optional[str]:
    normalized = iso_timestamp(value)
    if not normalized:
        return None
    observed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    age_seconds = (datetime.now(timezone.utc) - observed).total_seconds()
    if age_seconds < -5 or age_seconds > FUNDING_QUOTE_MAX_AGE_SEC:
        return None
    return normalized


def historical_bar_date(value: Any) -> Optional[date]:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value or "").strip()
    for pattern in ("%Y-%m-%d", "%Y%m%d"):
        try:
            return datetime.strptime(text[:10], pattern).date()
        except ValueError:
            continue
    return None


def liquid_hours_session_state(
    liquid_hours: Any,
    target_date: date,
) -> Optional[bool]:
    """Return whether IBKR schedules RTH on target_date, or None if unverifiable."""
    if not isinstance(liquid_hours, str):
        return None
    target_key = target_date.strftime("%Y%m%d")
    matching_rows = []
    for raw_row in liquid_hours.split(";"):
        row = raw_row.strip()
        if not row or ":" not in row:
            continue
        row_date, hours = row.split(":", 1)
        if row_date == target_key:
            matching_rows.append(hours.strip())
    if len(matching_rows) != 1:
        return None
    hours = matching_rows[0]
    if hours.upper() == "CLOSED":
        return False
    session_pattern = re.compile(
        r"^(?:\d{8}:)?\d{4}-(?:\d{8}:)?\d{4}"
        r"(?:,(?:\d{8}:)?\d{4}-(?:\d{8}:)?\d{4})*$"
    )
    return True if session_pattern.fullmatch(hours) else None


def parse_us_equity_liquid_hours(
    liquid_hours: Any,
) -> Dict[date, Optional[datetime]]:
    """Parse IBKR RTH rows into broker-calendar session close timestamps."""
    if not isinstance(liquid_hours, str) or not liquid_hours.strip():
        raise FundingEvidenceError(
            "IBKR omitted the US-equity liquid-hours calendar.",
            "MARKET_SESSION_SCHEDULE_INVALID",
        )

    ny_zone = ZoneInfo("America/New_York")
    schedule: Dict[date, Optional[datetime]] = {}
    for raw_row in liquid_hours.split(";"):
        row = raw_row.strip()
        if not row:
            continue
        row_date_text, separator, hours = row.partition(":")
        if (
            not separator
            or len(row_date_text) != 8
            or not row_date_text.isdigit()
        ):
            raise FundingEvidenceError(
                "IBKR returned an invalid US-equity liquid-hours row.",
                "MARKET_SESSION_SCHEDULE_INVALID",
            )
        try:
            row_date = datetime.strptime(
                row_date_text,
                "%Y%m%d",
            ).date()
        except ValueError as exc:
            raise FundingEvidenceError(
                "IBKR returned an invalid US-equity liquid-hours date.",
                "MARKET_SESSION_SCHEDULE_INVALID",
            ) from exc
        if row_date in schedule:
            raise FundingEvidenceError(
                "IBKR returned duplicate US-equity liquid-hours dates.",
                "MARKET_SESSION_SCHEDULE_AMBIGUOUS",
            )

        hours = hours.strip()
        if hours.upper() == "CLOSED":
            schedule[row_date] = None
            continue
        if liquid_hours_session_state(
            f"{row_date_text}:{hours}",
            row_date,
        ) is not True:
            raise FundingEvidenceError(
                "IBKR returned invalid US-equity liquid hours.",
                "MARKET_SESSION_SCHEDULE_INVALID",
            )

        final_range = hours.split(",")[-1]
        _open_text, range_separator, close_text = final_range.partition("-")
        if not range_separator:
            raise FundingEvidenceError(
                "IBKR returned an invalid US-equity session range.",
                "MARKET_SESSION_SCHEDULE_INVALID",
            )
        close_date = row_date
        close_time_text = close_text
        if ":" in close_text:
            close_date_text, close_time_text = close_text.rsplit(":", 1)
            try:
                close_date = datetime.strptime(
                    close_date_text,
                    "%Y%m%d",
                ).date()
            except ValueError as exc:
                raise FundingEvidenceError(
                    "IBKR returned an invalid US-equity session close date.",
                    "MARKET_SESSION_SCHEDULE_INVALID",
                ) from exc
        if (
            len(close_time_text) != 4
            or not close_time_text.isdigit()
        ):
            raise FundingEvidenceError(
                "IBKR returned an invalid US-equity session close time.",
                "MARKET_SESSION_SCHEDULE_INVALID",
            )
        close_hour = int(close_time_text[:2])
        close_minute = int(close_time_text[2:])
        if close_hour > 23 or close_minute > 59:
            raise FundingEvidenceError(
                "IBKR returned an invalid US-equity session close time.",
                "MARKET_SESSION_SCHEDULE_INVALID",
            )
        schedule[row_date] = datetime(
            close_date.year,
            close_date.month,
            close_date.day,
            close_hour,
            close_minute,
            tzinfo=ny_zone,
        )

    if not schedule:
        raise FundingEvidenceError(
            "IBKR returned an empty US-equity liquid-hours calendar.",
            "MARKET_SESSION_SCHEDULE_INVALID",
        )
    return schedule


def build_interest_forecast_calendar(
    market_calendar: Dict[str, Any],
    *,
    broker_time: datetime,
    prior_completed_session: date,
) -> Dict[str, Any]:
    """Derive an issuance window only from verified IBKR calendar rows."""
    schedule = parse_us_equity_liquid_hours(
        market_calendar.get("liquidHours")
    )
    broker_ny = broker_time.astimezone(
        ZoneInfo("America/New_York")
    )
    broker_date = broker_ny.date()
    current_session_close = schedule.get(broker_date)
    current_session_scheduled = market_calendar.get(
        "currentSessionScheduled"
    )
    parsed_current_scheduled = current_session_close is not None
    if (
        broker_date not in schedule
        or not isinstance(current_session_scheduled, bool)
        or current_session_scheduled != parsed_current_scheduled
    ):
        raise FundingEvidenceError(
            "IBKR returned inconsistent current-session calendar evidence.",
            "MARKET_SESSION_SCHEDULE_AMBIGUOUS",
        )

    next_session_date = next(
        (
            session_date
            for session_date in sorted(schedule)
            if session_date > broker_date
            and schedule[session_date] is not None
        ),
        None,
    )
    current_session_complete = bool(
        current_session_close is not None
        and broker_ny >= current_session_close
    )
    eligible = False
    forecast_kind = None
    basis_session_date = prior_completed_session
    if current_session_complete and next_session_date is not None:
        eligible = True
        forecast_kind = "completed_session_window"
        basis_session_date = broker_date
    elif not current_session_scheduled:
        if (
            not isinstance(prior_completed_session, date)
            or isinstance(prior_completed_session, datetime)
            or prior_completed_session >= broker_date
            or next_session_date is None
        ):
            raise FundingEvidenceError(
                "IBKR did not provide exact prior- and next-session evidence for the closed broker date.",
                "MARKET_SESSION_SCHEDULE_AMBIGUOUS",
            )

        # A closed-day forecast can only cover the remaining calendar days
        # when every remaining date from the current broker date through the
        # next scheduled session is present. The independently verified SPY
        # historical schedule proves the prior completed session; IBKR's live
        # liquidHours window can begin on the current closed date and omit that
        # prior session.
        # Missing forward rows must never be interpreted as market closures.
        evidence_date = broker_date
        while evidence_date < next_session_date:
            if (
                evidence_date not in schedule
                or schedule[evidence_date] is not None
            ):
                raise FundingEvidenceError(
                    "IBKR returned incomplete closed-day calendar evidence.",
                    "MARKET_SESSION_SCHEDULE_AMBIGUOUS",
                )
            evidence_date += timedelta(days=1)

        eligible = True
        forecast_kind = "closed_day_remaining_window"
        basis_session_date = prior_completed_session
    latest_completed_session = (
        broker_date
        if current_session_complete
        else prior_completed_session
    )
    return {
        "eligible": eligible,
        "forecastKind": forecast_kind,
        "sessionDate": broker_date.isoformat(),
        "basisSessionDate": basis_session_date.isoformat(),
        "cashAnchorDate": broker_date.isoformat(),
        "accrualDays": (
            (next_session_date - broker_date).days
            if next_session_date is not None
            and eligible
            else None
        ),
        "nextSessionDate": (
            next_session_date.isoformat()
            if next_session_date is not None
            else None
        ),
        "currentSessionCloseAt": (
            iso_timestamp(current_session_close)
            if current_session_close is not None
            else None
        ),
        "currentSessionScheduled": current_session_scheduled,
        "currentSessionComplete": current_session_complete,
        "priorCompletedSessionDate": (
            prior_completed_session.isoformat()
        ),
        "latestCompletedSessionDate": (
            latest_completed_session.isoformat()
        ),
        "verification": "ibkr_liquid_hours_and_broker_time",
    }


def require_interest_forecast_cash_anchor(
    summary: Dict[str, Any],
    forecast: Dict[str, Any],
) -> None:
    """Require broker-native cash at the forecast's verified calendar anchor."""
    if forecast.get("eligible") is not True:
        return
    cash_anchor_date = historical_bar_date(forecast.get("cashAnchorDate"))
    if cash_anchor_date is None:
        raise FundingEvidenceError(
            "The interest forecast omitted a valid cash anchor date.",
            "FORECAST_CASH_ANCHOR_INVALID",
        )

    for segment, label in (
        ("S", "securities"),
        ("C", "commodities"),
        ("Z", "IB-UKL"),
    ):
        ledger_value = summary.get(f"SettledCashByDate-{segment}")
        total_cash = finite_float(summary.get(f"TotalCashValue-{segment}"))
        if not isinstance(ledger_value, str) or total_cash is None:
            raise FundingEvidenceError(
                f"The {label} cash ladder is unavailable for the interest forecast.",
                "FORECAST_CASH_ANCHOR_UNAVAILABLE",
            )
        ledger = compact_cash_by_date_rows(ledger_value)
        if cash_anchor_date not in ledger:
            raise FundingEvidenceError(
                f"The {label} cash ladder omitted the verified forecast anchor date.",
                "FORECAST_CASH_ANCHOR_UNAVAILABLE",
            )
        terminal_cash = ledger[max(ledger)]
        if abs(terminal_cash - total_cash) > ACCOUNT_VALUE_TOLERANCE:
            raise FundingEvidenceError(
                f"The {label} cash ladder terminal balance does not reconcile to current IBKR cash.",
                "FORECAST_CASH_ANCHOR_UNRECONCILED",
            )


async def request_us_equity_market_calendar(
    funding_session: IB,
    settlement_date: date,
    timings: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Verify today's US-equity session state from fresh IBKR contract details."""
    started = time.monotonic()
    try:
        details = await asyncio.wait_for(
            funding_session.reqContractDetailsAsync(
                Contract(conId=FUNDING_MARKET_CALENDAR_CON_ID)
            ),
            timeout=FUNDING_MARKET_CALENDAR_TIMEOUT_SEC,
        )
    except asyncio.TimeoutError as exc:
        raise FundingEvidenceError(
            "The IBKR US-equity market calendar request timed out.",
            "MARKET_SESSION_SCHEDULE_TIMEOUT",
        ) from exc
    except Exception as exc:
        raise FundingEvidenceError(
            f"The IBKR US-equity market calendar is unavailable: {exc}",
            "MARKET_SESSION_SCHEDULE_UNAVAILABLE",
        ) from exc
    finally:
        if timings is not None:
            timings["market_calendar_ms"] = elapsed_ms(started)

    exact_details = []
    for detail in list(details or []):
        contract = getattr(detail, "contract", None)
        if (
            int(getattr(contract, "conId", 0) or 0)
            == FUNDING_MARKET_CALENDAR_CON_ID
            and str(getattr(contract, "symbol", "") or "").upper() == "SPY"
            and str(getattr(contract, "secType", "") or "").upper() == "STK"
            and str(getattr(contract, "currency", "") or "").upper() == "USD"
        ):
            exact_details.append(detail)
    if len(exact_details) != 1:
        raise FundingEvidenceError(
            "IBKR did not return one exact SPY contract for US-equity calendar verification.",
            "MARKET_SESSION_SCHEDULE_AMBIGUOUS",
        )

    detail = exact_details[0]
    if str(getattr(detail, "timeZoneId", "") or "") not in {
        "US/Eastern",
        "America/New_York",
    }:
        raise FundingEvidenceError(
            "The IBKR US-equity calendar returned an unexpected time zone.",
            "MARKET_SESSION_SCHEDULE_INVALID",
        )
    current_session_scheduled = liquid_hours_session_state(
        getattr(detail, "liquidHours", None),
        settlement_date,
    )
    if current_session_scheduled is None:
        raise FundingEvidenceError(
            "IBKR did not return an unambiguous RTH schedule for the broker date.",
            "MARKET_SESSION_SCHEDULE_INVALID",
        )
    return {
        "contract": getattr(detail, "contract"),
        "currentSessionScheduled": current_session_scheduled,
        "liquidHours": getattr(detail, "liquidHours"),
    }


async def request_latest_completed_us_equity_session(
    funding_session: IB,
    calendar_contract: Contract,
    settlement_date: date,
    timings: Optional[Dict[str, Any]] = None,
) -> date:
    """Resolve the last completed US-equity RTH session from IBKR schedule data."""
    started = time.monotonic()
    try:
        schedule = await asyncio.wait_for(
            funding_session.reqHistoricalScheduleAsync(
                calendar_contract,
                FUNDING_MARKET_CALENDAR_LOOKBACK_DAYS,
                endDateTime="",
                useRTH=True,
            ),
            timeout=FUNDING_MARKET_CALENDAR_TIMEOUT_SEC,
        )
    except asyncio.TimeoutError as exc:
        raise FundingEvidenceError(
            "The IBKR completed-session schedule request timed out.",
            "REFERENCE_SESSION_SCHEDULE_TIMEOUT",
        ) from exc
    except Exception as exc:
        raise FundingEvidenceError(
            f"The IBKR completed-session schedule is unavailable: {exc}",
            "REFERENCE_SESSION_SCHEDULE_UNAVAILABLE",
        ) from exc
    finally:
        if timings is not None:
            timings["reference_session_schedule_ms"] = elapsed_ms(started)

    if str(getattr(schedule, "timeZone", "") or "") not in {
        "US/Eastern",
        "America/New_York",
    }:
        raise FundingEvidenceError(
            "The IBKR completed-session schedule returned an unexpected time zone.",
            "REFERENCE_SESSION_SCHEDULE_INVALID",
        )
    completed_dates = {
        session_date
        for session_date in (
            historical_bar_date(getattr(session, "refDate", None))
            for session in list(getattr(schedule, "sessions", None) or [])
        )
        if session_date is not None and session_date < settlement_date
    }
    if not completed_dates:
        raise FundingEvidenceError(
            "IBKR returned no completed US-equity session before the broker date.",
            "REFERENCE_SESSION_SCHEDULE_MISSING",
        )
    return max(completed_dates)


async def request_historical_prior_closes(
    funding_session: IB,
    contracts: List[Contract],
    *,
    completed_before: Optional[date] = None,
) -> Dict[int, Dict[str, Any]]:
    """Fetch completed prior-session closes directly from IBKR, never today's partial bar."""
    if not contracts:
        return {}

    prior_closes: Dict[int, Dict[str, Any]] = {}
    cutoff_date = (
        completed_before
        if completed_before is not None
        else datetime.now(ZoneInfo("America/New_York")).date()
    )
    for offset in range(0, len(contracts), FUNDING_HISTORICAL_BATCH_SIZE):
        batch = contracts[offset:offset + FUNDING_HISTORICAL_BATCH_SIZE]
        try:
            bars_lists = await asyncio.wait_for(
                asyncio.gather(
                    *[
                        funding_session.reqHistoricalDataAsync(
                            contract,
                            endDateTime="",
                            durationStr=(
                                "7 D" if completed_before is not None else "3 D"
                            ),
                            barSizeSetting="1 day",
                            whatToShow="TRADES",
                            useRTH=True,
                            formatDate=2,
                            timeout=FUNDING_HISTORICAL_TIMEOUT_SEC,
                        )
                        for contract in batch
                    ]
                ),
                timeout=FUNDING_HISTORICAL_TIMEOUT_SEC + 1.0,
            )
        except asyncio.TimeoutError as exc:
            raise FundingEvidenceError(
                "The IBKR prior-close history request timed out.",
                "SHORT_PRIOR_CLOSE_TIMEOUT",
            ) from exc
        except Exception as exc:
            raise FundingEvidenceError(
                f"The IBKR prior-close history request failed: {exc}",
                "SHORT_PRIOR_CLOSE_UNAVAILABLE",
            ) from exc

        observed_at = now_iso()
        for contract, bars in zip(batch, bars_lists):
            completed: Dict[date, float] = {}
            for bar in list(bars or []):
                session_date = historical_bar_date(getattr(bar, "date", None))
                close = positive_float(getattr(bar, "close", None))
                if not session_date or session_date >= cutoff_date or close is None:
                    continue
                if session_date in completed and completed[session_date] != close:
                    raise FundingEvidenceError(
                        f"IBKR returned conflicting prior closes for conId {contract.conId}.",
                        "SHORT_PRIOR_CLOSE_AMBIGUOUS",
                    )
                completed[session_date] = close
            if not completed:
                raise FundingEvidenceError(
                    f"IBKR returned no completed prior-session close for conId {contract.conId}.",
                    "SHORT_PRIOR_CLOSE_MISSING",
                )
            session_date = max(completed)
            prior_closes[int(contract.conId)] = {
                "priorClose": completed[session_date],
                "priorCloseSource": "ibkr_historical_daily_close",
                "priorCloseSessionDate": session_date.isoformat(),
                "priorCloseObservedAt": observed_at,
            }
    return prior_closes


def portfolio_mark_failure(
    *,
    account: Optional[str],
    con_id: Optional[int],
    symbol: Optional[str],
    code: str,
    stage: str,
    message: str,
    retryable: bool,
) -> Dict[str, Any]:
    """Build a stable, non-sensitive per-contract failure payload."""
    return {
        "account": account,
        "conId": con_id,
        "symbol": symbol,
        "errorCode": code,
        "stage": stage,
        "message": message,
        "retryable": retryable,
        "terminal": not retryable,
        "exhausted": False,
        "terminalReason": "non_retryable" if not retryable else None,
        "attemptCount": None,
        "observedAt": now_iso(),
    }


def reference_session_is_complete(
    session_date: date,
    broker_time: datetime,
) -> bool:
    """Treat a same-day RTH bar as complete only after a post-close grace period."""
    broker_ny = broker_time.astimezone(ZoneInfo("America/New_York"))
    if session_date < broker_ny.date():
        return True
    if session_date > broker_ny.date():
        return False
    completed_after_minutes = (16 * 60) + REFERENCE_MARKS_RTH_FINALIZE_MINUTES
    return (broker_ny.hour * 60) + broker_ny.minute >= completed_after_minutes


def next_reference_refresh_at(
    session_date: date,
    broker_time: datetime,
    post_close_attempts: int = 0,
) -> datetime:
    """Earliest time a newer completed RTH daily bar can reasonably exist."""
    ny_zone = ZoneInfo("America/New_York")
    broker_ny = broker_time.astimezone(ny_zone)
    finalize_hour, finalize_minute = divmod(
        (16 * 60) + REFERENCE_MARKS_RTH_FINALIZE_MINUTES,
        60,
    )

    def finalized_at(day: date) -> datetime:
        return datetime(
            day.year,
            day.month,
            day.day,
            finalize_hour,
            finalize_minute,
            tzinfo=ny_zone,
        )

    if broker_ny.weekday() >= 5:
        days_until_monday = 7 - broker_ny.weekday()
        return finalized_at(
            broker_ny.date() + timedelta(days=days_until_monday)
        ).astimezone(timezone.utc)

    today_finalize = finalized_at(broker_ny.date())
    if broker_ny < today_finalize:
        return today_finalize.astimezone(timezone.utc)

    if session_date < broker_ny.date():
        # The just-finished daily bar may take a few minutes to appear.
        if post_close_attempts >= 2:
            next_day = broker_ny.date() + timedelta(days=1)
            while next_day.weekday() >= 5:
                next_day += timedelta(days=1)
            return finalized_at(next_day).astimezone(timezone.utc)
        return (
            broker_ny + timedelta(
                seconds=REFERENCE_MARKS_POST_CLOSE_RETRY_SEC
            )
        ).astimezone(timezone.utc)

    next_day = broker_ny.date() + timedelta(days=1)
    while next_day.weekday() >= 5:
        next_day += timedelta(days=1)
    return finalized_at(next_day).astimezone(timezone.utc)


def serialized_reference_close_cache() -> Dict[str, Any]:
    accounts: Dict[str, Dict[str, Dict[str, Any]]] = {}
    allowed_fields = (
        "price",
        "priceState",
        "priceSource",
        "priceSessionDate",
        "priceObservedAt",
        "referenceClose",
        "referenceCloseSource",
        "referenceCloseSessionDate",
        "referenceCloseObservedAt",
        "previousClose",
        "previousCloseSessionDate",
        "referenceLastCheckedAt",
        "referenceRefreshAttemptCount",
        "referenceRefreshAfter",
    )
    for account, rows in reference_close_cache.items():
        account_rows: Dict[str, Dict[str, Any]] = {}
        for con_id, row in rows.items():
            if row.get("priceState") != "historical_close":
                continue
            account_rows[str(con_id)] = {
                field: row.get(field)
                for field in allowed_fields
            }
        if account_rows:
            accounts[account] = account_rows
    return {
        "schemaVersion": 1,
        "source": "ibkr_historical_daily_close",
        "savedAt": now_iso(),
        "accounts": accounts,
    }


def persist_reference_close_cache() -> None:
    temp_path: Optional[str] = None
    try:
        REFERENCE_MARKS_CACHE_PATH.parent.mkdir(
            parents=True,
            exist_ok=True,
        )
        descriptor, temp_path = tempfile.mkstemp(
            prefix=f".{REFERENCE_MARKS_CACHE_PATH.name}.",
            suffix=".tmp",
            dir=str(REFERENCE_MARKS_CACHE_PATH.parent),
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(
                serialized_reference_close_cache(),
                handle,
                separators=(",", ":"),
                sort_keys=True,
            )
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_path, 0o600)
        os.replace(temp_path, REFERENCE_MARKS_CACHE_PATH)
        reference_marks_cache_health.update(
            {
                "lastSavedAt": now_iso(),
                "lastErrorCode": None,
                "lastErrorAt": None,
            }
        )
    except Exception:
        reference_marks_cache_health.update(
            {
                "lastErrorCode": "REFERENCE_MARKS_CACHE_WRITE_FAILED",
                "lastErrorAt": now_iso(),
            }
        )
        if temp_path:
            try:
                os.unlink(temp_path)
            except OSError:
                pass


def load_reference_close_cache() -> None:
    if not REFERENCE_MARKS_CACHE_PATH.exists():
        reference_marks_cache_health["loadedAt"] = now_iso()
        return
    try:
        with REFERENCE_MARKS_CACHE_PATH.open(
            "r",
            encoding="utf-8",
        ) as handle:
            payload = json.load(handle)
        if (
            payload.get("schemaVersion") != 1
            or payload.get("source") != "ibkr_historical_daily_close"
            or not isinstance(payload.get("accounts"), dict)
        ):
            raise ValueError("unsupported reference-mark cache schema")

        loaded: Dict[str, Dict[int, Dict[str, Any]]] = {}
        for raw_account, raw_rows in payload["accounts"].items():
            account = str(raw_account or "").strip()
            if not account or not isinstance(raw_rows, dict):
                continue
            for raw_con_id, row in raw_rows.items():
                if not isinstance(row, dict):
                    continue
                try:
                    con_id = int(raw_con_id)
                except (TypeError, ValueError):
                    continue
                reference_close = positive_float(
                    row.get("referenceClose")
                )
                reference_session = historical_bar_date(
                    row.get("referenceCloseSessionDate")
                )
                reference_observed_at = iso_timestamp(
                    row.get("referenceCloseObservedAt")
                )
                refresh_after = iso_timestamp(
                    row.get("referenceRefreshAfter")
                )
                if (
                    con_id <= 0
                    or reference_close is None
                    or reference_session is None
                    or not reference_observed_at
                    or not refresh_after
                    or row.get("priceState") != "historical_close"
                    or row.get("priceSource")
                    != "ibkr_historical_daily_close"
                    or row.get("referenceCloseSource")
                    != "ibkr_historical_daily_close"
                ):
                    continue
                previous_close = positive_float(row.get("previousClose"))
                previous_session = historical_bar_date(
                    row.get("previousCloseSessionDate")
                )
                if previous_close is None or previous_session is None:
                    previous_close = None
                    previous_session_text = None
                elif previous_session >= reference_session:
                    previous_close = None
                    previous_session_text = None
                else:
                    previous_session_text = previous_session.isoformat()
                loaded.setdefault(account, {})[con_id] = {
                    "account": account,
                    "conId": con_id,
                    "status": "reference",
                    "price": reference_close,
                    "priceState": "historical_close",
                    "priceSource": "ibkr_historical_daily_close",
                    "priceSessionDate": reference_session.isoformat(),
                    "priceObservedAt": (
                        iso_timestamp(row.get("priceObservedAt"))
                        or reference_observed_at
                    ),
                    "referenceClose": reference_close,
                    "referenceCloseSource": "ibkr_historical_daily_close",
                    "referenceCloseSessionDate": reference_session.isoformat(),
                    "referenceCloseObservedAt": reference_observed_at,
                    "previousClose": previous_close,
                    "previousCloseSessionDate": previous_session_text,
                    "marketDataType": None,
                    "referenceCacheState": "broker_historical_snapshot",
                    "referenceLastCheckedAt": (
                        iso_timestamp(row.get("referenceLastCheckedAt"))
                        or reference_observed_at
                    ),
                    "referenceRefreshAttemptCount": max(
                        0,
                        int(row.get("referenceRefreshAttemptCount") or 0),
                    ),
                    "referenceRefreshAfter": refresh_after,
                }
        reference_close_cache.clear()
        reference_close_cache.update(loaded)
        reference_marks_cache_health.update(
            {
                "loadedAt": now_iso(),
                "lastErrorCode": None,
                "lastErrorAt": None,
            }
        )
    except Exception:
        reference_marks_cache_health.update(
            {
                "loadedAt": now_iso(),
                "lastErrorCode": "REFERENCE_MARKS_CACHE_READ_FAILED",
                "lastErrorAt": now_iso(),
            }
        )


def cached_portfolio_reference_close(
    *,
    account: str,
    position: Any,
    broker_time: datetime,
    require_current: bool = False,
) -> Optional[Dict[str, Any]]:
    contract = getattr(position, "contract", None)
    try:
        con_id = int(getattr(contract, "conId", 0) or 0)
    except (TypeError, ValueError):
        return None
    cached = (reference_close_cache.get(account) or {}).get(con_id)
    if not cached:
        return None

    observed_text = iso_timestamp(cached.get("referenceCloseObservedAt"))
    session_date = historical_bar_date(cached.get("referenceCloseSessionDate"))
    if not observed_text or not session_date:
        return None
    observed = datetime.fromisoformat(observed_text.replace("Z", "+00:00"))
    age_seconds = (broker_time - observed).total_seconds()
    if age_seconds < -5:
        return None

    refresh_text = iso_timestamp(cached.get("referenceRefreshAfter"))
    refresh_after = (
        datetime.fromisoformat(refresh_text.replace("Z", "+00:00"))
        if refresh_text
        else None
    )
    refresh_pending = (
        refresh_after is not None and broker_time >= refresh_after
    )
    if refresh_pending and require_current:
        return None
    if (
        refresh_after is None
        and age_seconds > REFERENCE_MARKS_CACHE_TTL_SEC
    ):
        # Compatibility for cache entries written before refresh scheduling
        # was added.
        return None

    return {
        **cached,
        "referenceCacheState": "broker_historical_snapshot_reused",
        "referenceRefreshPending": refresh_pending,
    }


def store_portfolio_reference_close(
    account: str,
    mark: Dict[str, Any],
) -> None:
    try:
        con_id = int(mark.get("conId") or 0)
    except (TypeError, ValueError):
        return
    if con_id <= 0 or mark.get("priceState") != "historical_close":
        return
    account_cache = reference_close_cache.setdefault(account, {})
    previous = account_cache.get(con_id) or {}
    same_session = (
        previous.get("referenceCloseSessionDate")
        and previous.get("referenceCloseSessionDate")
        == mark.get("referenceCloseSessionDate")
    )
    stored_mark = {**mark}
    if same_session:
        # Reconfirming the same completed bar updates health, not the price's
        # original evidence timestamp.
        stored_mark["referenceCloseObservedAt"] = previous.get(
            "referenceCloseObservedAt"
        ) or mark.get("referenceCloseObservedAt")
        stored_mark["priceObservedAt"] = previous.get(
            "priceObservedAt"
        ) or mark.get("priceObservedAt")
    account_cache[con_id] = {
        **stored_mark,
        "referenceCacheState": "broker_historical_snapshot",
    }
    persist_reference_close_cache()


async def request_portfolio_reference_close(
    reference_session: IB,
    *,
    account: str,
    position: Any,
    broker_time: datetime,
) -> Dict[str, Any]:
    """Fetch the latest two completed RTH daily closes for one exact conId."""
    contract = getattr(position, "contract", None)
    raw_con_id = getattr(contract, "conId", None)
    try:
        con_id = int(raw_con_id)
    except (TypeError, ValueError):
        con_id = 0
    symbol = str(
        getattr(contract, "localSymbol", None)
        or getattr(contract, "symbol", None)
        or ""
    ).strip() or None

    if con_id <= 0:
        return {
            "mark": None,
            "failure": portfolio_mark_failure(
                account=account,
                con_id=None,
                symbol=symbol,
                code="REFERENCE_MARK_CONID_MISSING",
                stage="identity",
                message="The broker position omitted a valid conId.",
                retryable=False,
            ),
        }

    history_started = time.monotonic()
    try:
        bars = await asyncio.wait_for(
            reference_session.reqHistoricalDataAsync(
                contract,
                endDateTime="",
                durationStr=REFERENCE_MARKS_HISTORY_DURATION,
                barSizeSetting="1 day",
                whatToShow="TRADES",
                useRTH=True,
                formatDate=2,
                timeout=REFERENCE_MARKS_HISTORY_TIMEOUT_SEC,
            ),
            timeout=REFERENCE_MARKS_HISTORY_TIMEOUT_SEC + 1.0,
        )
    except asyncio.TimeoutError:
        return {
            "mark": None,
            "failure": portfolio_mark_failure(
                account=account,
                con_id=con_id,
                symbol=symbol,
                code="REFERENCE_MARK_HISTORY_TIMEOUT",
                stage="historical_daily_close",
                message="IBKR daily-close history timed out for this contract.",
                retryable=True,
            ),
        }
    except Exception:
        return {
            "mark": None,
            "failure": portfolio_mark_failure(
                account=account,
                con_id=con_id,
                symbol=symbol,
                code="REFERENCE_MARK_HISTORY_UNAVAILABLE",
                stage="historical_daily_close",
                message="IBKR daily-close history is unavailable for this contract.",
                retryable=True,
            ),
        }

    completed: Dict[date, float] = {}
    for bar in list(bars or []):
        session_date = historical_bar_date(getattr(bar, "date", None))
        close = positive_float(getattr(bar, "close", None))
        if (
            not session_date
            or close is None
            or not reference_session_is_complete(session_date, broker_time)
        ):
            continue
        if session_date in completed and completed[session_date] != close:
            return {
                "mark": None,
                "failure": portfolio_mark_failure(
                    account=account,
                    con_id=con_id,
                    symbol=symbol,
                    code="REFERENCE_MARK_HISTORY_AMBIGUOUS",
                    stage="historical_daily_close",
                    message="IBKR returned conflicting closes for one completed session.",
                    retryable=True,
                ),
            }
        completed[session_date] = close

    if not completed:
        elapsed_seconds = time.monotonic() - history_started
        timed_out = elapsed_seconds >= REFERENCE_MARKS_HISTORY_TIMEOUT_SEC * 0.9
        return {
            "mark": None,
            "failure": portfolio_mark_failure(
                account=account,
                con_id=con_id,
                symbol=symbol,
                code=(
                    "REFERENCE_MARK_HISTORY_TIMEOUT"
                    if timed_out
                    else "REFERENCE_MARK_NO_TRADE_IN_LOOKBACK"
                ),
                stage="historical_daily_close",
                message=(
                    "IBKR daily-close history timed out for this contract."
                    if timed_out
                    else (
                        "IBKR returned no completed RTH daily close for this "
                        f"contract in the {REFERENCE_MARKS_HISTORY_DURATION} lookback."
                    )
                ),
                retryable=True,
            ),
        }

    session_dates = sorted(completed, reverse=True)
    latest_session_date = session_dates[0]
    previous_session_date = session_dates[1] if len(session_dates) > 1 else None
    observed_at = now_iso()
    quantity = finite_float(getattr(position, "position", None))
    previous_cached = (
        reference_close_cache.get(account) or {}
    ).get(con_id) or {}
    same_cached_session = (
        previous_cached.get("referenceCloseSessionDate")
        == latest_session_date.isoformat()
    )
    broker_ny = broker_time.astimezone(ZoneInfo("America/New_York"))
    finalize_minutes = (16 * 60) + REFERENCE_MARKS_RTH_FINALIZE_MINUTES
    after_finalize = (
        broker_ny.weekday() < 5
        and (broker_ny.hour * 60) + broker_ny.minute >= finalize_minutes
    )
    same_session_recheck_count = (
        int(previous_cached.get("referenceRefreshAttemptCount") or 0) + 1
        if (
            same_cached_session
            and after_finalize
            and latest_session_date < broker_ny.date()
        )
        else 1
        if after_finalize and latest_session_date < broker_ny.date()
        else 0
    )
    mark = {
        "account": account,
        "conId": con_id,
        "symbol": str(getattr(contract, "symbol", None) or "").strip() or symbol,
        "localSymbol": symbol,
        "position": quantity,
        "status": "reference",
        "price": completed[latest_session_date],
        "priceState": "historical_close",
        "priceSource": "ibkr_historical_daily_close",
        "priceSessionDate": latest_session_date.isoformat(),
        "priceObservedAt": observed_at,
        "referenceClose": completed[latest_session_date],
        "referenceCloseSource": "ibkr_historical_daily_close",
        "referenceCloseSessionDate": latest_session_date.isoformat(),
        "referenceCloseObservedAt": observed_at,
        "previousClose": (
            completed[previous_session_date]
            if previous_session_date is not None
            else None
        ),
        "previousCloseSessionDate": (
            previous_session_date.isoformat()
            if previous_session_date is not None
            else None
        ),
        "marketDataType": None,
        "referenceCacheState": "broker_historical_snapshot",
        "referenceLastCheckedAt": observed_at,
        "referenceRefreshAttemptCount": same_session_recheck_count,
        "referenceRefreshAfter": next_reference_refresh_at(
            latest_session_date,
            broker_time,
            same_session_recheck_count,
        ).isoformat().replace("+00:00", "Z"),
    }
    return {"mark": mark, "failure": None}


def reference_position_scope(
    raw_positions: Any,
    account: str,
) -> Dict[str, Any]:
    """Resolve one unambiguous open broker position per account/conId."""
    failures: List[Dict[str, Any]] = []
    positions_by_con_id: Dict[int, Any] = {}
    duplicate_con_ids: Set[int] = set()
    for position in list(raw_positions or []):
        position_account = str(getattr(position, "account", "") or "")
        if position_account != account:
            continue
        quantity = finite_float(getattr(position, "position", None))
        contract = getattr(position, "contract", None)
        symbol = str(
            getattr(contract, "localSymbol", None)
            or getattr(contract, "symbol", None)
            or ""
        ).strip() or None
        raw_con_id = getattr(contract, "conId", None)
        try:
            con_id = int(raw_con_id)
        except (TypeError, ValueError):
            con_id = 0
        if quantity is None:
            failures.append(
                portfolio_mark_failure(
                    account=account,
                    con_id=con_id if con_id > 0 else None,
                    symbol=symbol,
                    code="REFERENCE_MARK_POSITION_INVALID",
                    stage="identity",
                    message="The broker position returned an invalid quantity.",
                    retryable=True,
                )
            )
            continue
        if quantity == 0:
            continue
        if con_id <= 0:
            failures.append(
                portfolio_mark_failure(
                    account=account,
                    con_id=None,
                    symbol=symbol,
                    code="REFERENCE_MARK_CONID_MISSING",
                    stage="identity",
                    message="The broker position omitted a valid conId.",
                    retryable=False,
                )
            )
            continue
        if con_id in positions_by_con_id or con_id in duplicate_con_ids:
            positions_by_con_id.pop(con_id, None)
            if con_id not in duplicate_con_ids:
                failures.append(
                    portfolio_mark_failure(
                        account=account,
                        con_id=con_id,
                        symbol=symbol,
                        code="REFERENCE_MARK_IDENTITY_AMBIGUOUS",
                        stage="identity",
                        message="The broker returned duplicate open positions for one conId.",
                        retryable=True,
                    )
                )
            duplicate_con_ids.add(con_id)
            continue
        positions_by_con_id[con_id] = position
    return {
        "positionsByConId": positions_by_con_id,
        "failures": failures,
    }


def reference_warm_state(account: str) -> Dict[str, Any]:
    return reference_marks_warm_states.setdefault(
        account,
        {
            "state": "idle",
            "requestedCount": 0,
            "completedCount": 0,
            "pendingCount": 0,
            "exhaustedFailureCount": 0,
            "progressPercent": 0.0,
            "startedAt": None,
            "updatedAt": None,
            "completedAt": None,
            "socketVerifiedAt": None,
            "positionsObservedAt": None,
            "lastErrorCode": None,
            "lastErrorAt": None,
        },
    )


def update_reference_warm_state(
    account: str,
    **values: Any,
) -> Dict[str, Any]:
    state = reference_warm_state(account)
    state.update(values)
    state["updatedAt"] = now_iso()
    return state


def active_reference_terminal_failures(
    account: str,
    con_ids: Set[int],
) -> Dict[int, Dict[str, Any]]:
    stored = reference_marks_terminal_failures.setdefault(account, {})
    current = datetime.now(timezone.utc)
    for con_id, failure in list(stored.items()):
        observed_text = iso_timestamp(failure.get("observedAt"))
        observed = (
            datetime.fromisoformat(observed_text.replace("Z", "+00:00"))
            if observed_text
            else None
        )
        expired = (
            observed is None
            or (current - observed).total_seconds()
            >= REFERENCE_MARKS_TERMINAL_RETRY_SEC
        )
        if con_id not in con_ids or expired:
            stored.pop(con_id, None)
    return stored


def reference_progress_percent(completed: int, requested: int) -> float:
    if requested <= 0:
        return 100.0
    return round((completed / requested) * 100.0, 1)


async def warm_reference_marks_account(account: str) -> None:
    """Incrementally fill completed-close cache without blocking HTTP requests."""
    async with reference_marks_snapshot_lock:
        cycle_started_at = now_iso()
        update_reference_warm_state(
            account,
            state="warming",
            startedAt=cycle_started_at,
            completedAt=None,
            lastErrorCode=None,
            lastErrorAt=None,
        )
        reference_session = reference_marks_ib
        health = await ensure_reference_marks_connected(reference_session)
        if not health.get("ok"):
            update_reference_warm_state(
                account,
                state="waiting",
                lastErrorCode="REFERENCE_MARKS_GATEWAY_UNAVAILABLE",
                lastErrorAt=now_iso(),
            )
            return

        try:
            gateway_time = health.get("gatewayTime")
            if gateway_time is None:
                gateway_time = await asyncio.wait_for(
                    reference_session.reqCurrentTimeAsync(),
                    timeout=LIVE_SESSION_VERIFY_TIMEOUT_SEC,
                )
            socket_verified_at = iso_timestamp(gateway_time)
            if not socket_verified_at:
                update_reference_warm_state(
                    account,
                    state="waiting",
                    lastErrorCode="REFERENCE_MARKS_SOCKET_TIMESTAMP_INVALID",
                    lastErrorAt=now_iso(),
                )
                return
            broker_time = datetime.fromisoformat(
                socket_verified_at.replace("Z", "+00:00")
            )
            broker_time_anchor = time.monotonic()
            accounts = [
                str(value)
                for value in reference_session.managedAccounts()
                if value
            ]
            if account not in accounts:
                update_reference_warm_state(
                    account,
                    state="blocked",
                    lastErrorCode="REFERENCE_MARKS_ACCOUNT_NOT_MANAGED",
                    lastErrorAt=now_iso(),
                    socketVerifiedAt=socket_verified_at,
                )
                return
            try:
                raw_positions = await fetch_raw_positions_via_persistent_session(
                    [account],
                    timeout_sec=REFERENCE_MARKS_POSITIONS_TIMEOUT_SEC,
                    require_exact_accounts=False,
                )
            except asyncio.TimeoutError:
                # The positions governor already invalidated the positions
                # client and opened its bounded circuit. The independently
                # verified reference-history session remains healthy.
                update_reference_warm_state(
                    account,
                    state="waiting",
                    lastErrorCode="REFERENCE_MARKS_POSITIONS_TIMEOUT",
                    lastErrorAt=now_iso(),
                    socketVerifiedAt=socket_verified_at,
                )
                return
            except Exception:
                update_reference_warm_state(
                    account,
                    state="waiting",
                    lastErrorCode="REFERENCE_MARKS_POSITIONS_UNAVAILABLE",
                    lastErrorAt=now_iso(),
                    socketVerifiedAt=socket_verified_at,
                )
                return
            positions_observed_at = now_iso()
        except asyncio.TimeoutError:
            disconnect_reference_marks_session(reference_session)
            update_reference_warm_state(
                account,
                state="waiting",
                lastErrorCode="REFERENCE_MARKS_BROKER_TIMEOUT",
                lastErrorAt=now_iso(),
            )
            return
        except Exception:
            disconnect_reference_marks_session(reference_session)
            update_reference_warm_state(
                account,
                state="waiting",
                lastErrorCode="REFERENCE_MARKS_BROKER_UNAVAILABLE",
                lastErrorAt=now_iso(),
            )
            return

        scope = reference_position_scope(raw_positions, account)
        positions_by_con_id = scope["positionsByConId"]
        con_ids = set(positions_by_con_id)
        terminal_failures = active_reference_terminal_failures(
            account,
            con_ids,
        )
        completed_ids: Set[int] = set()
        pending_positions: List[Any] = []
        for con_id, position in positions_by_con_id.items():
            cached = cached_portfolio_reference_close(
                account=account,
                position=position,
                broker_time=broker_time
                + timedelta(seconds=time.monotonic() - broker_time_anchor),
                require_current=True,
            )
            if cached:
                completed_ids.add(con_id)
            elif con_id not in terminal_failures:
                pending_positions.append(position)

        requested_count = len(positions_by_con_id) + len(scope["failures"])
        exhausted_count = len(terminal_failures) + len(scope["failures"])
        update_reference_warm_state(
            account,
            state=(
                "warming"
                if pending_positions
                else "degraded"
                if exhausted_count
                else "complete"
            ),
            requestedCount=requested_count,
            completedCount=len(completed_ids),
            pendingCount=len(pending_positions),
            exhaustedFailureCount=exhausted_count,
            progressPercent=reference_progress_percent(
                len(completed_ids),
                requested_count,
            ),
            socketVerifiedAt=socket_verified_at,
            positionsObservedAt=positions_observed_at,
        )

        retry_positions = pending_positions
        for attempt_index in range(REFERENCE_MARKS_MAX_ATTEMPTS):
            if not retry_positions:
                break
            next_retry: List[Any] = []
            for position_index, position in enumerate(retry_positions):
                try:
                    connection_was_live = reference_session.isConnected()
                except Exception:
                    connection_was_live = False
                if not connection_was_live:
                    update_reference_warm_state(
                        account,
                        state="waiting",
                        pendingCount=max(
                            0,
                            requested_count
                            - len(completed_ids)
                            - exhausted_count,
                        ),
                        lastErrorCode="REFERENCE_MARKS_GATEWAY_DISCONNECTED",
                        lastErrorAt=now_iso(),
                    )
                    return
                result = await request_portfolio_reference_close(
                    reference_session,
                    account=account,
                    position=position,
                    broker_time=broker_time
                    + timedelta(
                        seconds=time.monotonic() - broker_time_anchor
                    ),
                )
                try:
                    connection_is_live = reference_session.isConnected()
                except Exception:
                    connection_is_live = False
                if not connection_is_live:
                    # Never accept a result completed across a disconnected
                    # socket. Leave this and all remaining contracts pending
                    # for the next verified generation.
                    update_reference_warm_state(
                        account,
                        state="waiting",
                        pendingCount=max(
                            0,
                            requested_count
                            - len(completed_ids)
                            - exhausted_count,
                        ),
                        lastErrorCode="REFERENCE_MARKS_GATEWAY_DISCONNECTED",
                        lastErrorAt=now_iso(),
                    )
                    return
                contract = getattr(position, "contract", None)
                con_id = int(getattr(contract, "conId", 0) or 0)
                if result.get("mark"):
                    store_portfolio_reference_close(
                        account,
                        result["mark"],
                    )
                    completed_ids.add(con_id)
                    terminal_failures.pop(con_id, None)
                else:
                    failure = result.get("failure") or portfolio_mark_failure(
                        account=account,
                        con_id=con_id,
                        symbol=str(getattr(contract, "symbol", "") or "") or None,
                        code="REFERENCE_MARK_HISTORY_UNAVAILABLE",
                        stage="historical_daily_close",
                        message="IBKR daily-close history is unavailable for this contract.",
                        retryable=True,
                    )
                    can_retry = (
                        failure.get("retryable") is True
                        and attempt_index + 1 < REFERENCE_MARKS_MAX_ATTEMPTS
                    )
                    if can_retry:
                        next_retry.append(position)
                    else:
                        retryable = failure.get("retryable") is True
                        terminal_failures[con_id] = {
                            **failure,
                            "attemptCount": attempt_index + 1,
                            "terminal": True,
                            "exhausted": retryable,
                            "terminalReason": (
                                "retry_budget_exhausted"
                                if retryable
                                else "non_retryable"
                            ),
                        }

                exhausted_count = (
                    len(terminal_failures) + len(scope["failures"])
                )
                pending_count = max(
                    0,
                    requested_count
                    - len(completed_ids)
                    - exhausted_count,
                )
                update_reference_warm_state(
                    account,
                    state="warming" if pending_count else (
                        "degraded" if exhausted_count else "complete"
                    ),
                    requestedCount=requested_count,
                    completedCount=len(completed_ids),
                    pendingCount=pending_count,
                    exhaustedFailureCount=exhausted_count,
                    progressPercent=reference_progress_percent(
                        len(completed_ids),
                        requested_count,
                    ),
                    socketVerifiedAt=socket_verified_at,
                    positionsObservedAt=positions_observed_at,
                )
                if REFERENCE_MARKS_REQUEST_GAP_SEC > 0:
                    await asyncio.sleep(REFERENCE_MARKS_REQUEST_GAP_SEC)

            retry_positions = next_retry
            if retry_positions and REFERENCE_MARKS_RETRY_DELAY_SEC > 0:
                await asyncio.sleep(REFERENCE_MARKS_RETRY_DELAY_SEC)

        exhausted_count = len(terminal_failures) + len(scope["failures"])
        update_reference_warm_state(
            account,
            state="degraded" if exhausted_count else "complete",
            requestedCount=requested_count,
            completedCount=len(completed_ids),
            pendingCount=0,
            exhaustedFailureCount=exhausted_count,
            progressPercent=reference_progress_percent(
                len(completed_ids),
                requested_count,
            ),
            completedAt=now_iso(),
            socketVerifiedAt=socket_verified_at,
            positionsObservedAt=positions_observed_at,
        )


async def reference_marks_worker() -> None:
    global reference_marks_worker_task, reference_marks_active_account
    try:
        while reference_marks_requested_accounts:
            account = sorted(reference_marks_requested_accounts)[0]
            reference_marks_requested_accounts.discard(account)
            reference_marks_active_account = account
            try:
                await warm_reference_marks_account(account)
            except asyncio.CancelledError:
                raise
            except Exception:
                update_reference_warm_state(
                    account,
                    state="waiting",
                    lastErrorCode="REFERENCE_MARKS_WORKER_FAILED",
                    lastErrorAt=now_iso(),
                )
            finally:
                reference_marks_active_account = None
    finally:
        reference_marks_active_account = None
        reference_marks_worker_task = None


def schedule_reference_marks_warm(account: str) -> bool:
    global reference_marks_worker_task
    acct = str(account or "").strip()
    if not acct:
        return False
    if (
        acct == reference_marks_active_account
        or acct in reference_marks_requested_accounts
    ):
        return False
    worker_active = (
        reference_marks_worker_task is not None
        and not reference_marks_worker_task.done()
    )
    reference_marks_requested_accounts.add(acct)
    if not worker_active:
        reference_marks_worker_task = asyncio.create_task(
            reference_marks_worker()
        )
    return True


async def reference_marks_background_scan() -> None:
    await asyncio.sleep(REFERENCE_MARKS_STARTUP_DELAY_SEC)
    while True:
        try:
            if ib.isConnected():
                current = datetime.now(timezone.utc)
                for account in [
                    str(value)
                    for value in ib.managedAccounts()
                    if value
                ]:
                    state = reference_marks_warm_states.get(account) or {}
                    updated_text = iso_timestamp(state.get("updatedAt"))
                    updated = (
                        datetime.fromisoformat(
                            updated_text.replace("Z", "+00:00")
                        )
                        if updated_text
                        else None
                    )
                    if (
                        updated is None
                        or (current - updated).total_seconds()
                        >= REFERENCE_MARKS_BACKGROUND_REFRESH_SEC
                    ):
                        schedule_reference_marks_warm(account)
        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        await asyncio.sleep(REFERENCE_MARKS_BACKGROUND_SCAN_SEC)


async def request_live_short_quotes(
    funding_session: IB,
    contracts: List[Contract],
    *,
    include_shortability: bool = False,
) -> Dict[int, Dict[str, Any]]:
    """Use temporary live streams so evidence does not wait for tickSnapshotEnd."""
    quote_rows: Dict[int, Dict[str, Any]] = {}
    for offset in range(0, len(contracts), FUNDING_QUOTE_BATCH_SIZE):
        batch = contracts[offset:offset + FUNDING_QUOTE_BATCH_SIZE]
        tickers: List[Any] = []
        cancel_errors: List[str] = []
        try:
            for contract in batch:
                tickers.append(
                    funding_session.reqMktData(
                        contract,
                        "236" if include_shortability else "",
                        False,
                        False,
                    )
                )

            deadline = time.monotonic() + FUNDING_QUOTE_TIMEOUT_SEC
            while True:
                explicit_non_live = [
                    strict_market_data_type(getattr(ticker, "marketDataType", None))
                    for ticker in tickers
                    if strict_market_data_type(getattr(ticker, "marketDataType", None)) not in {None, 0, 1}
                ]
                if explicit_non_live:
                    raise FundingEvidenceError(
                        "A short-position stream was not live IBKR market data.",
                        "SHORT_SNAPSHOT_NOT_LIVE",
                    )
                for ticker in tickers:
                    if (
                        iso_timestamp(getattr(ticker, "time", None))
                        and fresh_snapshot_timestamp(getattr(ticker, "time", None)) is None
                    ):
                        require_fresh_snapshot_timestamp(
                            getattr(ticker, "time", None)
                        )

                ready = [
                    strict_market_data_type(getattr(ticker, "marketDataType", None)) == 1
                    and positive_float(getattr(ticker, "bid", None)) is not None
                    and positive_float(getattr(ticker, "ask", None)) is not None
                    and fresh_snapshot_timestamp(getattr(ticker, "time", None)) is not None
                    and (
                        not include_shortability
                        or (
                            finite_float(getattr(ticker, "shortableShares", None))
                            is not None
                            and finite_float(
                                getattr(ticker, "shortableShares", None)
                            ) >= 0
                        )
                    )
                    for ticker in tickers
                ]
                if ready and all(ready):
                    break
                if time.monotonic() >= deadline:
                    for ticker in tickers:
                        market_data_type = strict_market_data_type(getattr(ticker, "marketDataType", None))
                        if market_data_type not in {None, 0, 1}:
                            raise FundingEvidenceError(
                                "A short-position stream did not verify live IBKR market data.",
                                "SHORT_SNAPSHOT_NOT_LIVE",
                            )
                        if market_data_type != 1:
                            raise FundingEvidenceError(
                                "The IBKR short-position live streams timed out.",
                                "SHORT_SNAPSHOT_TIMEOUT",
                            )
                        if positive_float(getattr(ticker, "ask", None)) is None:
                            raise FundingEvidenceError(
                                "A short-position stream omitted a finite positive live ask.",
                                "SHORT_LIVE_ASK_MISSING",
                            )
                        if positive_float(getattr(ticker, "bid", None)) is None:
                            raise FundingEvidenceError(
                                "A short-position stream omitted a finite positive live bid.",
                                "SHORT_LIVE_BID_MISSING",
                            )
                        if (
                            include_shortability
                            and finite_float(
                                getattr(ticker, "shortableShares", None)
                            ) is None
                        ):
                            raise FundingEvidenceError(
                                "A short-position stream omitted live shortable-share evidence.",
                                "SHORTABLE_SHARES_MISSING",
                            )
                        require_fresh_snapshot_timestamp(getattr(ticker, "time", None))
                    raise FundingEvidenceError(
                        "The IBKR short-position live streams timed out.",
                        "SHORT_SNAPSHOT_TIMEOUT",
                    )
                await asyncio.sleep(FUNDING_QUOTE_POLL_SEC)

            for contract, ticker in zip(batch, tickers):
                ask = positive_float(getattr(ticker, "ask", None))
                bid = positive_float(getattr(ticker, "bid", None))
                last = positive_float(getattr(ticker, "last", None))
                if ask is None:
                    raise FundingEvidenceError(
                        "A short-position stream omitted a finite positive live ask.",
                        "SHORT_LIVE_ASK_MISSING",
                    )
                if bid is None:
                    raise FundingEvidenceError(
                        "A short-position stream omitted a finite positive live bid.",
                        "SHORT_LIVE_BID_MISSING",
                    )
                current_price = max(
                    value
                    for value in (ask, bid, last)
                    if value is not None
                )
                quote_rows[int(contract.conId)] = {
                    "marketDataType": 1,
                    "snapshotTimestamp": require_fresh_snapshot_timestamp(
                        getattr(ticker, "time", None)
                    ),
                    "directAsk": ask,
                    "directBid": bid,
                    "directLast": last,
                    "currentPrice": current_price,
                    "currentPriceSource": "ibkr_ticker_direct_max",
                    "tickClose": positive_float(getattr(ticker, "close", None)),
                    **(
                        {
                            "shortableShares": finite_float(
                                getattr(ticker, "shortableShares", None)
                            ),
                            "shortabilitySource": "ibkr_generic_tick_236",
                        }
                        if include_shortability
                        else {}
                    ),
                }
        finally:
            for contract in batch[:len(tickers)]:
                try:
                    funding_session.cancelMktData(contract)
                except Exception as exc:
                    cancel_errors.append(f"{contract.conId}: {exc}")
            if cancel_errors:
                raise FundingEvidenceError(
                    "IBKR live short streams could not be cancelled: "
                    + "; ".join(cancel_errors),
                    "SHORT_STREAM_CANCEL_FAILED",
                )
    return quote_rows


async def build_short_position_evidence(
    funding_session: IB,
    positions: List[Any],
    timings: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    shorts = []
    for position in positions:
        quantity = finite_float(getattr(position, "position", None))
        if quantity is None:
            raise FundingEvidenceError(
                "An IBKR position returned an invalid quantity.",
                "POSITION_QUANTITY_INVALID",
            )
        if quantity < 0:
            shorts.append(position)
    if not shorts:
        if timings is not None:
            timings["short_qualification_ms"] = 0
            timings["short_live_quotes_ms"] = 0
            timings["short_prior_close_history_ms"] = 0
        return []

    probes: List[Contract] = []
    for position in shorts:
        source_contract = getattr(position, "contract", None)
        con_id = int(getattr(source_contract, "conId", 0) or 0)
        if con_id <= 0:
            raise FundingEvidenceError(
                "A short stock position omitted its IBKR conId.",
                "SHORT_CONID_MISSING",
            )
        probes.append(Contract(conId=con_id))

    qualification_started = time.monotonic()
    try:
        qualified = await asyncio.wait_for(
            funding_session.qualifyContractsAsync(*probes),
            timeout=FUNDING_QUALIFICATION_TIMEOUT_SEC,
        )
    except asyncio.TimeoutError as exc:
        raise FundingEvidenceError(
            "IBKR batch contract qualification timed out for the short stock positions.",
            "SHORT_QUALIFICATION_TIMEOUT",
        ) from exc
    if timings is not None:
        timings["short_qualification_ms"] = elapsed_ms(qualification_started)

    qualified_by_con_id: Dict[int, Contract] = {}
    for contract in qualified:
        con_id = int(getattr(contract, "conId", 0) or 0)
        if con_id <= 0 or con_id in qualified_by_con_id:
            raise FundingEvidenceError(
                "IBKR returned ambiguous short-stock contract qualification evidence.",
                "SHORT_QUALIFICATION_FAILED",
            )
        qualified_by_con_id[con_id] = contract

    qualified_contracts: List[Contract] = []
    for position in shorts:
        source_contract = getattr(position, "contract", None)
        con_id = int(getattr(source_contract, "conId", 0) or 0)
        contract = qualified_by_con_id.get(con_id)
        if not contract:
            raise FundingEvidenceError(
                f"IBKR could not exactly qualify short stock conId {con_id}.",
                "SHORT_QUALIFICATION_FAILED",
            )
        if (
            str(getattr(contract, "secType", "") or "").upper() != "STK"
            or str(getattr(contract, "currency", "") or "").upper() != "USD"
        ):
            raise FundingEvidenceError(
                f"Qualified conId {con_id} is not a USD stock.",
                "SHORT_QUALIFICATION_FAILED",
            )
        qualified_contracts.append(contract)

    quotes_started = time.monotonic()
    quote_rows = await request_live_short_quotes(
        funding_session,
        qualified_contracts,
    )
    if timings is not None:
        timings["short_live_quotes_ms"] = elapsed_ms(quotes_started)

    missing_close_contracts = [
        contract
        for contract in qualified_contracts
        if quote_rows[int(contract.conId)]["tickClose"] is None
    ]
    history_started = time.monotonic()
    historical_closes = await request_historical_prior_closes(
        funding_session,
        missing_close_contracts,
    )
    if timings is not None:
        timings["short_prior_close_history_ms"] = elapsed_ms(history_started)

    evidence: List[Dict[str, Any]] = []
    for position, contract in zip(shorts, qualified_contracts):
        quote = quote_rows[int(contract.conId)]
        tick_close = quote.pop("tickClose")
        if tick_close is not None:
            prior_close = {
                "priorClose": tick_close,
                "priorCloseSource": "ibkr_live_tick_close",
                "priorCloseObservedAt": quote["snapshotTimestamp"],
            }
        else:
            prior_close = historical_closes.get(int(contract.conId))
            if not prior_close:
                raise FundingEvidenceError(
                    f"IBKR returned no prior close for conId {contract.conId}.",
                    "SHORT_PRIOR_CLOSE_MISSING",
                )
        source_contract = getattr(position, "contract", None)
        evidence.append(
            {
                "conId": int(contract.conId),
                "symbol": getattr(source_contract, "symbol", None) or getattr(contract, "symbol", None),
                "currency": str(
                    getattr(source_contract, "currency", None)
                    or getattr(contract, "currency", "")
                ).upper(),
                "quantity": finite_float(getattr(position, "position", None)),
                **prior_close,
                **quote,
            }
        )
    return evidence


async def build_short_position_reference_evidence(
    funding_session: IB,
    positions: List[Any],
    completed_before: date,
    timings: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """Build non-executable evidence from dated IBKR daily bars only."""
    shorts = []
    for position in positions:
        quantity = finite_float(getattr(position, "position", None))
        if quantity is None:
            raise FundingEvidenceError(
                "An IBKR position returned an invalid quantity.",
                "POSITION_QUANTITY_INVALID",
            )
        if quantity < 0:
            shorts.append(position)
    if not shorts:
        if timings is not None:
            timings["short_qualification_ms"] = 0
            timings["short_reference_history_ms"] = 0
        return []

    probes: List[Contract] = []
    for position in shorts:
        source_contract = getattr(position, "contract", None)
        con_id = int(getattr(source_contract, "conId", 0) or 0)
        if con_id <= 0:
            raise FundingEvidenceError(
                "A short stock position omitted its IBKR conId.",
                "SHORT_CONID_MISSING",
            )
        probes.append(Contract(conId=con_id))

    qualification_started = time.monotonic()
    try:
        qualified = await asyncio.wait_for(
            funding_session.qualifyContractsAsync(*probes),
            timeout=FUNDING_QUALIFICATION_TIMEOUT_SEC,
        )
    except asyncio.TimeoutError as exc:
        raise FundingEvidenceError(
            "IBKR batch contract qualification timed out for the short stock positions.",
            "SHORT_QUALIFICATION_TIMEOUT",
        ) from exc
    if timings is not None:
        timings["short_qualification_ms"] = elapsed_ms(qualification_started)

    qualified_by_con_id: Dict[int, Contract] = {}
    for contract in qualified:
        con_id = int(getattr(contract, "conId", 0) or 0)
        if con_id <= 0 or con_id in qualified_by_con_id:
            raise FundingEvidenceError(
                "IBKR returned ambiguous short-stock contract qualification evidence.",
                "SHORT_QUALIFICATION_FAILED",
            )
        qualified_by_con_id[con_id] = contract

    qualified_contracts: List[Contract] = []
    for position in shorts:
        source_contract = getattr(position, "contract", None)
        con_id = int(getattr(source_contract, "conId", 0) or 0)
        contract = qualified_by_con_id.get(con_id)
        if not contract:
            raise FundingEvidenceError(
                f"IBKR could not exactly qualify short stock conId {con_id}.",
                "SHORT_QUALIFICATION_FAILED",
            )
        if (
            str(getattr(contract, "secType", "") or "").upper() != "STK"
            or str(getattr(contract, "currency", "") or "").upper() != "USD"
        ):
            raise FundingEvidenceError(
                f"Qualified conId {con_id} is not a USD stock.",
                "SHORT_QUALIFICATION_FAILED",
            )
        qualified_contracts.append(contract)

    history_started = time.monotonic()
    historical_closes = await request_historical_prior_closes(
        funding_session,
        qualified_contracts,
        completed_before=completed_before,
    )
    if timings is not None:
        timings["short_reference_history_ms"] = elapsed_ms(history_started)

    evidence: List[Dict[str, Any]] = []
    session_dates = set()
    for position, contract in zip(shorts, qualified_contracts):
        historical_close = historical_closes.get(int(contract.conId))
        if not historical_close:
            raise FundingEvidenceError(
                f"IBKR returned no completed-session close for conId {contract.conId}.",
                "SHORT_PRIOR_CLOSE_MISSING",
            )
        session_date = historical_close.get("priorCloseSessionDate")
        session_dates.add(session_date)
        source_contract = getattr(position, "contract", None)
        evidence.append(
            {
                "conId": int(contract.conId),
                "symbol": (
                    getattr(source_contract, "symbol", None)
                    or getattr(contract, "symbol", None)
                ),
                "currency": str(
                    getattr(source_contract, "currency", None)
                    or getattr(contract, "currency", "")
                ).upper(),
                "quantity": finite_float(getattr(position, "position", None)),
                "referenceClose": historical_close["priorClose"],
                "referenceCloseSource": historical_close["priorCloseSource"],
                "referenceCloseSessionDate": session_date,
                "referenceCloseObservedAt": historical_close[
                    "priorCloseObservedAt"
                ],
            }
        )
    if len(session_dates) != 1:
        raise FundingEvidenceError(
            "IBKR returned short reference closes from different completed sessions.",
            "SHORT_REFERENCE_SESSION_AMBIGUOUS",
        )
    return evidence


def balance_prior_session_close(
    mark: Dict[str, Any],
    settlement_date: date,
) -> Optional[Dict[str, Any]]:
    """Select the newest broker daily close strictly before settlement day."""
    if mark.get("referenceCloseSource") != "ibkr_historical_daily_close":
        return None
    observed_at = iso_timestamp(mark.get("referenceCloseObservedAt"))
    if not observed_at:
        return None
    candidates = []
    for value_key, date_key in (
        ("referenceClose", "referenceCloseSessionDate"),
        ("previousClose", "previousCloseSessionDate"),
    ):
        close = positive_float(mark.get(value_key))
        session = historical_bar_date(mark.get(date_key))
        if close is not None and session is not None and session < settlement_date:
            candidates.append((session, close))
    if not candidates:
        return None
    session, close = max(candidates, key=lambda row: row[0])
    return {
        "close": close,
        "sessionDate": session,
        "observedAt": observed_at,
    }


async def build_balance_short_position_evidence(
    funding_session: IB,
    positions: List[Any],
    *,
    account: str,
    broker_time: datetime,
    settlement_date: date,
    timings: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """Return dated prior-close evidence without requiring live quote streams."""
    started = time.monotonic()
    evidence: List[Dict[str, Any]] = []
    session_dates: Set[str] = set()
    for position in positions:
        quantity = finite_float(getattr(position, "position", None))
        if quantity is None:
            raise FundingEvidenceError(
                "An IBKR position returned an invalid quantity.",
                "POSITION_QUANTITY_INVALID",
            )
        if quantity >= 0:
            continue

        contract = getattr(position, "contract", None)
        con_id = int(getattr(contract, "conId", 0) or 0)
        if con_id <= 0:
            raise FundingEvidenceError(
                "A short stock position omitted its IBKR conId.",
                "SHORT_CONID_MISSING",
            )

        mark = cached_portfolio_reference_close(
            account=account,
            position=position,
            broker_time=broker_time,
            require_current=True,
        )
        if mark is None:
            result = await request_portfolio_reference_close(
                funding_session,
                account=account,
                position=position,
                broker_time=broker_time,
            )
            mark = result.get("mark")
            if mark is None:
                failure = result.get("failure") or {}
                raise FundingEvidenceError(
                    failure.get("message")
                    or f"IBKR returned no completed-session close for conId {con_id}.",
                    failure.get("errorCode") or "SHORT_PRIOR_CLOSE_MISSING",
                )
            store_portfolio_reference_close(account, mark)

        prior_session = balance_prior_session_close(mark, settlement_date)
        if (
            prior_session is None
            or mark.get("referenceRefreshPending") is True
        ):
            raise FundingEvidenceError(
                f"The prior-close evidence for short conId {con_id} is not current and complete.",
                "SHORT_PRIOR_CLOSE_UNVERIFIED",
            )

        reference_close = prior_session["close"]
        reference_session = prior_session["sessionDate"]
        reference_observed_at = prior_session["observedAt"]
        session_date = reference_session.isoformat()
        session_dates.add(session_date)
        evidence.append(
            {
                "conId": con_id,
                "symbol": (
                    getattr(contract, "symbol", None)
                    or getattr(contract, "localSymbol", None)
                ),
                "currency": str(
                    getattr(contract, "currency", "") or ""
                ).upper(),
                "quantity": quantity,
                "priorClose": reference_close,
                "priorCloseSource": "ibkr_historical_daily_close",
                "priorCloseSessionDate": session_date,
                "priorCloseObservedAt": reference_observed_at,
                "referenceCacheState": mark.get("referenceCacheState"),
            }
        )

    if len(session_dates) > 1:
        raise FundingEvidenceError(
            "IBKR returned short collateral closes from different completed sessions.",
            "SHORT_PRIOR_CLOSE_SESSION_AMBIGUOUS",
        )
    if timings is not None:
        timings["short_prior_close_ms"] = elapsed_ms(started)
    return sorted(evidence, key=lambda row: row["conId"])


INTEREST_OBSERVATION_NO_STORE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
}


def interest_observation_unavailable(
    message: str,
    *,
    code: str,
    account: Optional[str] = None,
    status_code: int = 503,
    socket_verified_at: Optional[str] = None,
    timing: Optional[Dict[str, Any]] = None,
    gateway_error_code: Optional[str] = None,
) -> JSONResponse:
    payload: Dict[str, Any] = {
        "ok": False,
        "connected": False,
        "status": "unavailable",
        "source": "unavailable",
        "account": account,
        "from_cache": False,
        "errorCode": code,
        "message": message,
        "detail": message,
        "retry_after_ms": gateway_governor.diagnostics().get(
            "retry_after_ms", 0
        ),
        "observed_at": now_iso(),
    }
    if gateway_error_code:
        payload["gatewayErrorCode"] = gateway_error_code
    if socket_verified_at:
        payload["socket_verified_at"] = socket_verified_at
    if timing is not None:
        payload["timing"] = timing
    return JSONResponse(
        payload,
        status_code=status_code,
        headers=INTEREST_OBSERVATION_NO_STORE_HEADERS,
    )


def require_funding_socket_connected(funding_session: IB) -> None:
    try:
        connected = bool(funding_session.isConnected())
    except Exception as exc:
        raise FundingEvidenceError(
            f"The dedicated IBKR observation socket state is unavailable: {exc}",
            "INTEREST_OBSERVATION_DISCONNECTED",
        ) from exc
    if not connected:
        raise FundingEvidenceError(
            "The dedicated IBKR observation socket disconnected.",
            "INTEREST_OBSERVATION_DISCONNECTED",
        )


def require_fresh_interest_broker_time(
    value: Any,
    *,
    observed_at: Optional[datetime] = None,
) -> Dict[str, Any]:
    normalized = iso_timestamp(value)
    if not normalized:
        raise FundingEvidenceError(
            "IBKR socket verification returned an invalid timestamp.",
            "SOCKET_TIMESTAMP_INVALID",
        )
    broker_time = datetime.fromisoformat(
        normalized.replace("Z", "+00:00")
    )
    local_observed_at = observed_at or datetime.now(timezone.utc)
    age_seconds = (local_observed_at - broker_time).total_seconds()
    if age_seconds > INTEREST_OBSERVATION_BROKER_TIME_MAX_AGE_SEC:
        raise FundingEvidenceError(
            "IBKR socket verification returned stale broker time.",
            "BROKER_TIME_STALE",
        )
    if age_seconds < -INTEREST_OBSERVATION_BROKER_TIME_MAX_FUTURE_SEC:
        raise FundingEvidenceError(
            "IBKR socket verification returned broker time too far in the future.",
            "BROKER_TIME_FUTURE",
        )
    return {
        "brokerTime": broker_time,
        "socketVerifiedAt": normalized,
        "localObservedAt": local_observed_at,
        "ageSeconds": round(age_seconds, 3),
    }


def interest_observation_account_signature(
    summary: Dict[str, Any],
    positions: List[Any],
    execution_signature: tuple,
    *,
    position_scope: Optional[Dict[str, Any]] = None,
    event_accounting: Optional[Dict[str, Any]] = None,
) -> str:
    payload = {
        "summary": {
            "baseCurrency": summary.get("baseCurrency"),
            "cashLedger": funding_ledger_signature(summary),
            "FxCashBalance": summary.get("FxCashBalance"),
        },
        "positions": position_quantity_signature(positions),
        "executions": execution_signature,
        "positionScope": position_scope,
        # Each account-value read is reconciled independently. Do not require
        # event-contract marks and matching margin to remain byte-identical
        # between reads while markets are moving.
        "eventAccounting": (
            {
                "venues": event_accounting.get("venues"),
                "positionCount": event_accounting.get("positionCount"),
                "verification": event_accounting.get("verification"),
                "capacityContribution": event_accounting.get(
                    "capacityContribution"
                ),
            }
            if event_accounting
            else None
        ),
    }
    return json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def interest_observation_summary(
    summary: Dict[str, Any],
) -> Dict[str, Any]:
    explicit_z_segment = (
        summary.get("cashSegmentZVerification") == "explicit_zero"
    )
    return {
        "baseCurrency": summary["baseCurrency"],
        "NetLiquidation": summary["NetLiquidation"],
        "TotalCashValue-S": summary["TotalCashValue-S"],
        "TotalCashValue-C": summary["TotalCashValue-C"],
        "TotalCashValue-Z": (
            summary["TotalCashValue-Z"]
            if explicit_z_segment
            else None
        ),
        "MaintMarginReq-C": summary["MaintMarginReq-C"],
        "AccruedCash-S": summary["AccruedCash-S"],
        "FxCashBalance": summary["FxCashBalance"],
        "SettledCashByDate-S": summary["SettledCashByDate-S"],
        "SettledCashByDate-C": summary["SettledCashByDate-C"],
        "SettledCashByDate-Z": (
            summary["SettledCashByDate-Z"]
            if explicit_z_segment
            else None
        ),
    }


def interest_short_positions(
    reference_evidence: List[Dict[str, Any]],
    *,
    snapshot_timestamp: str,
) -> List[Dict[str, Any]]:
    rows = [
        {
            "conId": row["conId"],
            "symbol": row.get("symbol"),
            "currency": row["currency"],
            "quantity": row["quantity"],
            "priorClose": row["referenceClose"],
            "priorCloseSource": row["referenceCloseSource"],
            "priorCloseSessionDate": row["referenceCloseSessionDate"],
            "priorCloseObservedAt": row["referenceCloseObservedAt"],
            "snapshotTimestamp": snapshot_timestamp,
        }
        for row in reference_evidence
    ]
    return sorted(rows, key=lambda row: row["conId"])


def evidence_sha256(payload: Dict[str, Any]) -> str:
    canonical = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def funding_unavailable(
    message: str,
    *,
    code: str,
    account: Optional[str] = None,
    connected: bool = False,
    socket_verified_at: Optional[str] = None,
    timing: Optional[Dict[str, Any]] = None,
    gateway_error_code: Optional[str] = None,
) -> JSONResponse:
    payload: Dict[str, Any] = {
        "ok": False,
        "connected": connected,
        "status": "unavailable",
        "source": "unavailable",
        "account": account,
        "errorCode": code,
        "message": message,
        "summary": {},
        "funding": None,
        "retry_after_ms": gateway_governor.diagnostics().get(
            "retry_after_ms", 0
        ),
        "observed_at": now_iso(),
    }
    if gateway_error_code:
        payload["gatewayErrorCode"] = gateway_error_code
    if socket_verified_at:
        payload["socket_verified_at"] = socket_verified_at
    if timing is not None:
        payload["timing"] = timing
    return JSONResponse(
        payload,
        status_code=503,
        headers=INTEREST_OBSERVATION_NO_STORE_HEADERS,
    )


def balance_unavailable(
    message: str,
    *,
    code: str,
    account: Optional[str] = None,
    connected: bool = False,
    socket_verified_at: Optional[str] = None,
    timing: Optional[Dict[str, Any]] = None,
    gateway_error_code: Optional[str] = None,
) -> JSONResponse:
    payload: Dict[str, Any] = {
        "ok": False,
        "connected": connected,
        "status": "unavailable",
        "source": "unavailable",
        "account": account,
        "errorCode": code,
        "message": message,
        "summary": {},
        "balanceEvidence": None,
        "retry_after_ms": gateway_governor.diagnostics().get(
            "retry_after_ms", 0
        ),
        "observed_at": now_iso(),
    }
    if gateway_error_code:
        payload["gatewayErrorCode"] = gateway_error_code
    if socket_verified_at:
        payload["socket_verified_at"] = socket_verified_at
    if timing is not None:
        payload["timing"] = timing
    return JSONResponse(
        payload,
        status_code=503,
        headers=INTEREST_OBSERVATION_NO_STORE_HEADERS,
    )


def balance_exposure_only(
    *,
    account: str,
    summary: Dict[str, Any],
    margin_summary: Optional[Dict[str, float]],
    account_values_observed_at: str,
    capacity_code: str,
    capacity_message: str,
    socket_verified_at: str,
    timing: Optional[Dict[str, Any]] = None,
) -> JSONResponse:
    """Return reverified live account fields while failing capacity closed."""
    observed_at = now_iso()
    summary_payload = {
        "account": account,
        **summary,
        **(margin_summary or {}),
        "valueObservedAt": account_values_observed_at,
    }
    evidence_payload = {
        "accountValuesObservedAt": account_values_observed_at,
        "capacityAvailable": False,
        "capacityUnavailableCode": capacity_code,
        "capacityUnavailableMessage": capacity_message,
        "openPositionCount": None,
        "shortPositionCount": None,
        "openOrderCount": None,
        "sameDayExecutionCount": None,
        "shortPositionEvidence": [],
        "positionEvidence": [],
        "positionScope": {
            "allStock": False,
            "allBaseCurrency": False,
        },
        "settlementLaddersVerified": False,
        "activitySnapshotVerified": False,
        "settlementState": None,
        "settlementDate": None,
        "settlementHorizonDate": None,
        "settlementVerification": "capacity_unavailable",
    }
    snapshot_id = evidence_sha256(
        {
            "account": account,
            "summary": summary_payload,
            "balanceEvidence": evidence_payload,
            "observedAt": observed_at,
        }
    )
    return JSONResponse(
        {
            "ok": True,
            "connected": True,
            "status": "live",
            "source": "ibkr_live_session",
            "from_cache": False,
            "account": account,
            "summary": summary_payload,
            "snapshotId": snapshot_id,
            "balanceEvidence": evidence_payload,
            "socket_verified_at": socket_verified_at,
            "observed_at": observed_at,
            "freshness": {
                "status": "fresh",
                "maxAgeSeconds": 45,
                "accountReads": 2,
                "positionReads": 0,
                "activityReads": 0,
            },
            "timing": timing or {},
        },
        headers=INTEREST_OBSERVATION_NO_STORE_HEADERS,
    )


async def wait_for_balance_snapshot_slot(timeout_seconds: float = 5.0) -> bool:
    """Wait behind one active IBKR balance read instead of failing transiently."""
    if not balance_snapshot_lock.locked():
        return True
    try:
        await asyncio.wait_for(
            balance_snapshot_lock.acquire(),
            timeout=timeout_seconds,
        )
    except asyncio.TimeoutError:
        return False
    balance_snapshot_lock.release()
    return True


def provider(status: str, message: Optional[str] = None, last_success_at: Optional[str] = None) -> Dict[str, Any]:
    return {
        "status": status,
        "last_success_at": last_success_at,
        "message": message,
    }


async def ensure_connected() -> Dict[str, Any]:
    if stream_manager:
        return await stream_manager.ensure_connected()
    return await gateway_governor.ensure_session(
        "primary",
        ib,
        client_id=IB_CLIENT_ID,
        primary=True,
    )


def reset_primary_socket_heartbeat() -> None:
    primary_socket_heartbeat.update(
        {
            "connectionGeneration": None,
            "gatewayTime": None,
            "verifiedAt": None,
            "verifiedMonotonic": None,
        }
    )


async def verify_primary_socket() -> Dict[str, Any]:
    """Return the process-wide coalesced primary heartbeat evidence."""
    payload = await gateway_governor.verify_session(
        "primary",
        ib,
        client_id=IB_CLIENT_ID,
        primary=True,
    )
    connection_generation = (
        id(ib),
        getattr(stream_manager, "connection_generation", 0)
        if stream_manager
        else 0,
    )
    primary_socket_heartbeat.update(
        {
            "connectionGeneration": connection_generation,
            "gatewayTime": payload.get("gatewayTime"),
            "verifiedAt": payload.get("socketVerifiedAt"),
            "verifiedMonotonic": time.monotonic(),
        }
    )
    return {
        **payload,
        "connectionGeneration": connection_generation,
    }


def disconnect_funding_session(funding_session: IB) -> None:
    label = "funding" if funding_session is funding_ib else "auxiliary"
    gateway_governor.invalidate_session(label, funding_session)


def disconnect_balance_session(balance_session: IB) -> None:
    balance_socket_state.update(
        {
            "brokerTime": None,
            "socketVerifiedAt": None,
            "verifiedMonotonic": None,
        }
    )
    gateway_governor.invalidate_session("balance", balance_session)


async def request_balance_broker_time(balance_session: IB) -> Dict[str, Any]:
    """Return the governor's coalesced, account-verified balance heartbeat."""
    payload = await gateway_governor.verify_session(
        "balance",
        balance_session,
        client_id=BALANCE_CLIENT_ID,
        primary=False,
    )
    gateway_time = payload.get("gatewayTime")
    socket_verified_at = payload.get("socketVerifiedAt")
    balance_socket_state.update(
        {
            "brokerTime": gateway_time,
            "socketVerifiedAt": socket_verified_at,
            "verifiedMonotonic": time.monotonic(),
        }
    )
    return {
        "gatewayTime": gateway_time,
        "socketVerifiedAt": socket_verified_at,
        "cacheState": payload.get("cacheState", "shared_heartbeat"),
    }


async def ensure_funding_connected(
    funding_session: Optional[IB] = None,
    *,
    client_id: Optional[int] = None,
    resource_label: str = "funding",
) -> Dict[str, Any]:
    """Connect an isolated read-only IB session without using the quote client."""
    session = funding_session or funding_ib
    session_label = str(resource_label or "funding").strip() or "funding"
    session_client_id = int(client_id or FUNDING_CLIENT_ID)
    return await gateway_governor.ensure_session(
        session_label,
        session,
        client_id=session_client_id,
        primary=False,
    )


async def ensure_balance_connected(
    balance_session: Optional[IB] = None,
) -> Dict[str, Any]:
    """Connect the balance-only socket, isolated from interest validation."""
    return await ensure_funding_connected(
        balance_session or balance_ib,
        client_id=BALANCE_CLIENT_ID,
        resource_label="balance",
    )


def disconnect_reference_marks_session(reference_session: IB) -> None:
    gateway_governor.invalidate_session("reference_marks", reference_session)


async def ensure_reference_marks_connected(
    reference_session: Optional[IB] = None,
) -> Dict[str, Any]:
    """Connect the isolated read-only historical-marks session."""
    session = reference_session or reference_marks_ib
    return await gateway_governor.ensure_session(
        "reference_marks",
        session,
        client_id=REFERENCE_MARKS_CLIENT_ID,
        primary=False,
    )


def reference_marks_unavailable(
    message: str,
    *,
    code: str,
    account: Optional[str],
    connected: bool,
    socket_verified_at: Optional[str] = None,
) -> JSONResponse:
    payload: Dict[str, Any] = {
        "ok": False,
        "connected": connected,
        "status": "unavailable",
        "source": "unavailable",
        "account": account,
        "errorCode": code,
        "message": message,
        "marks": [],
        "failures": [],
        "retry_after_ms": gateway_governor.diagnostics().get(
            "retry_after_ms", 0
        ),
        "observed_at": now_iso(),
    }
    if socket_verified_at:
        payload["socket_verified_at"] = socket_verified_at
    return JSONResponse(payload, status_code=503)


@app.get("/status")
async def status() -> JSONResponse:
    stream = stream_manager.status_payload() if stream_manager else {}
    try:
        health = await asyncio.wait_for(ensure_connected(), timeout=STATUS_TIMEOUT)
    except asyncio.TimeoutError:
        diagnostics = gateway_governor.diagnostics()
        return JSONResponse(
            {
                "status": "gateway_api_unresponsive",
                "error_code": GATEWAY_API_UNRESPONSIVE,
                "connected": False,
                "host": IB_HOST,
                "port": IB_PORT,
                "client_id": stream_manager.client_id if stream_manager else IB_CLIENT_ID,
                "message": f"Timed out while checking IB Gateway/TWS at {IB_HOST}:{IB_PORT}",
                "account_discovery_ok": False,
                "stream": stream,
                "gateway": diagnostics,
                "retry_after_ms": diagnostics.get("retry_after_ms", 0),
            },
            status_code=200,
        )

    stream = stream_manager.status_payload() if stream_manager else {}
    if not health["ok"]:
        return JSONResponse(
            {
                "status": health["status"],
                "connected": False,
                "host": IB_HOST,
                "port": IB_PORT,
                "client_id": stream_manager.client_id if stream_manager else IB_CLIENT_ID,
                "message": health.get("message"),
                "error_code": health.get("error_code"),
                "account_discovery_ok": False,
                "stream": stream,
                "gateway": gateway_governor.diagnostics(),
                "retry_after_ms": int(health.get("retry_after_ms") or 0),
            },
            status_code=200,
        )

    try:
        accounts = list(health.get("accounts") or ib.managedAccounts())
        account_discovery_ok = True
    except Exception:
        accounts = []
        account_discovery_ok = False
    return JSONResponse(
        {
            "status": "connected",
            "connected": True,
            "host": IB_HOST,
            "port": IB_PORT,
            "client_id": stream_manager.client_id if stream_manager else IB_CLIENT_ID,
            "accounts": accounts,
            "account_discovery_ok": account_discovery_ok,
            "server_version": ib.client.serverVersion(),
            "time": now_iso(),
            "stream": stream,
            "gateway": gateway_governor.diagnostics(),
        }
    )


@app.get("/gateway-readiness")
async def gateway_readiness() -> JSONResponse:
    """Bound connection verification independently of data acquisition."""
    health = await gateway_governor.bounded_readiness(
        "primary", ib, client_id=IB_CLIENT_ID,
    )
    return JSONResponse(health, headers={"Cache-Control": "no-store, max-age=0"})


@app.get("/livez")
async def livez() -> JSONResponse:
    """Fast sidecar process liveness. Does not touch IB Gateway or portfolio sync."""
    stream = stream_manager.status_payload() if stream_manager else {}
    return JSONResponse(
        {
            "ok": True,
            "status": "alive",
            "sidecar": "running",
            "host": IB_HOST,
            "port": IB_PORT,
            "client_id": stream_manager.client_id if stream_manager else IB_CLIENT_ID,
            "persistent": PERSISTENT_CONNECT,
            "connected": bool(ib.isConnected()),
            "time": now_iso(),
            "stream": stream,
            "runtime": runtime_provenance(),
        }
    )


@app.get("/readyz")
async def readyz() -> JSONResponse:
    """Trading readiness: Gateway connected and at least one managed account available."""
    health = await ensure_connected()
    if not health["ok"]:
        return JSONResponse(
            {
                "ok": False,
                "status": health["status"],
                "error_code": health.get("error_code"),
                "connected": False,
                "accounts": [],
                "message": health.get("message"),
                "retry_after_ms": int(health.get("retry_after_ms") or 0),
                "gateway": gateway_governor.diagnostics(),
                "time": now_iso(),
            },
            status_code=503,
        )
    try:
        accounts = list(health.get("accounts") or ib.managedAccounts())
    except Exception:
        accounts = []
    if not accounts:
        return JSONResponse(
            {"ok": False, "status": "accounts_unavailable", "connected": True, "accounts": [], "time": now_iso()},
            status_code=503,
        )
    return JSONResponse({
        "ok": True,
        "status": "ready",
        "connected": True,
        "accounts": accounts,
        "gateway": gateway_governor.diagnostics(),
        "time": now_iso(),
    })


@app.post("/subscriptions/reconcile")
async def reconcile_subscriptions(body: ReconcileSubscriptionsRequest) -> JSONResponse:
    if not stream_manager:
        return JSONResponse({"ok": False, "errors": ["Stream manager not initialized"]})
    try:
        result = await asyncio.wait_for(stream_manager.reconcile_subscriptions(body.owner, body.instruments), timeout=8.0)
    except asyncio.TimeoutError:
        result = {"ok": False, "errors": ["subscription_reconciliation_timeout"]}
    return JSONResponse(result)


@app.post("/subscribe")
async def subscribe(body: SubscribeRequest) -> JSONResponse:
    if not stream_manager:
        return JSONResponse({"ok": False, "message": "Stream manager not initialized"}, status_code=200)
    result = await stream_manager.subscribe(body.instruments)
    return JSONResponse(result)


@app.post("/unsubscribe")
async def unsubscribe(body: SubscribeRequest) -> JSONResponse:
    if not stream_manager:
        return JSONResponse({"ok": False, "message": "Stream manager not initialized"}, status_code=200)
    result = await stream_manager.unsubscribe(body.instruments)
    return JSONResponse(result)


@app.get("/stream/quotes")
async def stream_quotes() -> StreamingResponse:
    if not stream_manager:
        async def empty():
            yield f"data: {json.dumps({'type': 'status', 'payload': {'connected': False}})}\n\n"

        return StreamingResponse(empty(), media_type="text/event-stream")

    return StreamingResponse(
        stream_manager.sse_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


@app.get("/cache/quotes")
async def cache_quotes(symbols: Optional[str] = Query(None)) -> JSONResponse:
    if not stream_manager:
        return JSONResponse({"ok": False, "quotes": []}, status_code=200)
    sym_list = [s.strip() for s in symbols.split(",")] if symbols else None
    return JSONResponse(
        {
            "ok": True,
            "quotes": stream_manager.get_quote_cache_list(sym_list),
            "fetched_at": now_iso(),
        }
    )


@app.get("/cache/portfolio")
async def cache_portfolio(account: Optional[str] = Query(None)) -> JSONResponse:
    if not stream_manager:
        return JSONResponse({"ok": False, "positions": []}, status_code=200)
    return JSONResponse(stream_manager.get_portfolio_cache(account))


@app.get("/cache/account-summary")
async def cache_account_summary(account: Optional[str] = Query(None)) -> JSONResponse:
    if not stream_manager:
        return JSONResponse({"ok": False, "summary": {}}, status_code=200)
    return JSONResponse(stream_manager.get_account_summary_cache(account))


@app.get("/portfolio/live-positions")
async def portfolio_live_positions() -> JSONResponse:
    """Return verified position identity, quantity, and broker average cost."""
    health = await ensure_connected()
    if not health.get("ok"):
        message = health.get("message") or "IB Gateway/TWS is not connected."
        error_code = live_positions_error_code(health.get("status"))
        update_live_positions_state(
            status=health.get("status", "gateway_unavailable"),
            connected=False,
            error_code=error_code,
            message=message,
            observed_at=None,
        )
        return JSONResponse(
            {
                "ok": False,
                "status": health.get("status", "gateway_unavailable"),
                "error_code": error_code,
                "message": message,
                "source": "unavailable",
                "positions": [],
                "observed_at": now_iso(),
                "retry_after_ms": int(health.get("retry_after_ms") or 0),
            },
            status_code=503,
        )

    try:
        socket_verification = await verify_primary_socket()
        connection_generation = socket_verification["connectionGeneration"]
        accounts_before = [
            str(account) for account in ib.managedAccounts() if account
        ]
        if not accounts_before:
            raise RuntimeError("The verified IB session returned no managed accounts.")
        position_source = "ibkr_req_positions"
        try:
            capture = await request_fresh_positions_snapshot(
                accounts_before,
                timeout_sec=LIVE_POSITIONS_REQUEST_TIMEOUT_SEC,
            )
            positions = capture["positions"]
            positions_observed_at = capture["observedAt"]
        except asyncio.TimeoutError:
            message = (
                "The fresh IBKR positions request timed out after "
                f"{LIVE_POSITIONS_REQUEST_TIMEOUT_SEC:.1f}s."
            )
            error_code = "IBKR_POSITIONS_REQUEST_TIMEOUT"
            update_live_positions_state(
                status="positions_request_timeout",
                connected=False,
                error_code=error_code,
                message=message,
                accounts=accounts_before,
                observed_at=None,
            )
            return JSONResponse(
                {
                    "ok": False,
                    "status": "positions_request_timeout",
                    "error_code": error_code,
                    "message": message,
                    "source": "unavailable",
                    "position_source": "unavailable",
                    "from_cache": False,
                    "positions": [],
                    "observed_at": now_iso(),
                    "retry_after_ms": gateway_governor.diagnostics().get(
                        "retry_after_ms", 0
                    ),
                },
                status_code=503,
            )
        post_positions_verification = await verify_primary_socket()
        if (
            post_positions_verification["connectionGeneration"]
            != connection_generation
        ):
            raise RuntimeError(
                "The IBKR connection generation changed during the fresh "
                "positions request."
            )
        accounts = [str(account) for account in ib.managedAccounts() if account]
        if not accounts or set(accounts) != set(accounts_before):
            raise RuntimeError(
                "The IBKR managed-account set changed during the fresh "
                "positions request."
            )
        account_set = set(accounts)
        unexpected_accounts = sorted(
            {
                str(position["account"])
                for position in positions
                if str(position["account"]) not in account_set
            }
        )
        if unexpected_accounts:
            raise RuntimeError(
                "The fresh IBKR positions response included accounts outside the "
                f"verified managed-account set: {', '.join(unexpected_accounts)}."
            )
    except asyncio.TimeoutError:
        message = f"IB socket verification timed out after {LIVE_SESSION_VERIFY_TIMEOUT_SEC:.1f}s."
        error_code = "IBKR_SOCKET_VERIFICATION_TIMEOUT"
        update_live_positions_state(
            status="socket_verification_timeout",
            connected=False,
            error_code=error_code,
            message=message,
            observed_at=None,
        )
        return JSONResponse(
            {
                "ok": False,
                "status": "socket_verification_timeout",
                "error_code": error_code,
                "message": message,
                "source": "unavailable",
                "positions": [],
                "observed_at": now_iso(),
                "retry_after_ms": gateway_governor.diagnostics().get(
                    "retry_after_ms", 0
                ),
            },
            status_code=503,
        )
    except Exception as exc:
        message = str(exc)
        error_code = getattr(exc, "error_code", "IBKR_LIVE_SESSION_UNVERIFIED")
        update_live_positions_state(
            status="live_session_unverified",
            connected=False,
            error_code=error_code,
            message=message,
            observed_at=None,
        )
        return JSONResponse(
            {
                "ok": False,
                "status": "live_session_unverified",
                "error_code": error_code,
                "message": message,
                "source": "unavailable",
                "positions": [],
                "observed_at": now_iso(),
                "retry_after_ms": getattr(
                    exc,
                    "retry_after_ms",
                    gateway_governor.diagnostics().get("retry_after_ms", 0),
                ),
            },
            status_code=503,
        )

    update_live_positions_state(
        status="ready",
        connected=True,
        error_code=None,
        message=None,
        accounts=accounts,
        position_count=len(positions),
        observed_at=positions_observed_at,
        socket_verified_at=post_positions_verification["socketVerifiedAt"],
    )
    return JSONResponse(
        {
            "ok": True,
            "status": "live",
            "connected": True,
            "source": "ibkr_live_session",
            "position_source": position_source,
            "from_cache": False,
            "accounts": accounts,
            "positions": positions,
            "position_count": len(positions),
            "socket_verified_at": post_positions_verification["socketVerifiedAt"],
            "positions_observed_at": positions_observed_at,
            "observed_at": positions_observed_at,
        }
    )


@app.get("/portfolio/status")
async def portfolio_status() -> JSONResponse:
    """Return gateway health separately from verified live-position readiness."""
    health = await ensure_connected()
    primary_connected = bool(health.get("ok"))
    accounts = [str(account) for account in health.get("accounts", []) if account]
    account_discovery_ok = primary_connected and bool(accounts)
    diagnostics = gateway_governor.diagnostics()

    state = dict(live_positions_state)
    return JSONResponse(
        {
            "ok": primary_connected and state.get("status") == "ready",
            "connected": primary_connected,
            "status": health.get("status", "gateway_unavailable"),
            "error_code": health.get("error_code"),
            "accounts": accounts,
            "account_discovery_ok": account_discovery_ok,
            "portfolio_verified": state.get("status") == "ready",
            "portfolio_status": state.get("status", "unverified"),
            "portfolio_error_code": state.get("error_code"),
            "portfolio_message": state.get("message"),
            "portfolio_position_count": state.get("position_count", 0),
            "portfolio_observed_at": state.get("observed_at"),
            "portfolio_socket_verified_at": state.get("socket_verified_at"),
            "portfolio_client_id": state.get("client_id"),
            "positions": [],
            "circuit_state": diagnostics.get("circuit_state"),
            "gateway_failure_count": diagnostics.get("failure_count"),
            "gateway_consecutive_failure_count": diagnostics.get(
                "consecutive_failure_count"
            ),
            "gateway_connection_attempt_count": diagnostics.get(
                "connection_attempt_count"
            ),
            "gateway_last_verification_at": diagnostics.get(
                "last_verification_at"
            ),
            "gateway_last_attempt_at": diagnostics.get("last_attempt_at"),
            "gateway_next_probe_at": diagnostics.get("next_probe_at"),
            "retry_after_ms": diagnostics.get("retry_after_ms", 0),
            "time": now_iso(),
            "source": "ibkr_live_session" if state.get("status") == "ready" else "unavailable",
        }
    )


@app.get("/portfolio/reference-marks")
async def portfolio_reference_marks(
    account: Optional[str] = Query(None),
    include_live: bool = Query(True),
) -> JSONResponse:
    """Return cached broker marks immediately and warm missing closes in background."""
    requested_account = str(account).strip() if account else None
    health = await ensure_connected()
    if not health.get("ok"):
        return reference_marks_unavailable(
            health.get("message") or "IB Gateway/TWS is not connected.",
            code="REFERENCE_MARKS_GATEWAY_UNAVAILABLE",
            account=requested_account,
            connected=False,
        )

    socket_verified_at: Optional[str] = None
    try:
        socket_verification = await verify_primary_socket()
        gateway_time = socket_verification["gatewayTime"]
        socket_verified_at = socket_verification["socketVerifiedAt"]
        broker_time = datetime.fromisoformat(
            socket_verified_at.replace("Z", "+00:00")
        )
        accounts = [str(value) for value in ib.managedAccounts() if value]
        if not accounts:
            return reference_marks_unavailable(
                "The verified IBKR session returned no managed accounts.",
                code="REFERENCE_MARKS_MANAGED_ACCOUNTS_MISSING",
                account=requested_account,
                connected=True,
                socket_verified_at=socket_verified_at,
            )
        if requested_account:
            if requested_account not in accounts:
                return reference_marks_unavailable(
                    f"Account {requested_account} is not managed by the verified IBKR session.",
                    code="REFERENCE_MARKS_ACCOUNT_NOT_MANAGED",
                    account=requested_account,
                    connected=True,
                    socket_verified_at=socket_verified_at,
                )
            acct = requested_account
        elif len(accounts) == 1:
            acct = accounts[0]
        else:
            return reference_marks_unavailable(
                "An exact account is required when the IBKR session manages multiple accounts.",
                code="REFERENCE_MARKS_ACCOUNT_REQUIRED",
                account=None,
                connected=True,
                socket_verified_at=socket_verified_at,
            )
        raw_positions = list(ib.positions())
        # Reading ib.positions() is a cache read; it must not be restamped as
        # a fresh position observation. The warmer records the timestamp of
        # its explicit reqPositionsAsync response.
        positions_observed_at = reference_warm_state(acct).get(
            "positionsObservedAt"
        )
    except asyncio.TimeoutError:
        return reference_marks_unavailable(
            "The IBKR reference-marks socket verification timed out.",
            code="REFERENCE_MARKS_SOCKET_TIMEOUT",
            account=requested_account,
            connected=True,
        )
    except Exception:
        return reference_marks_unavailable(
            "The IBKR reference-marks session could not be verified.",
            code="REFERENCE_MARKS_SESSION_UNVERIFIED",
            account=requested_account,
            connected=True,
            socket_verified_at=socket_verified_at,
        )

    scope = reference_position_scope(raw_positions, acct)
    positions_by_con_id = scope["positionsByConId"]
    con_ids = set(positions_by_con_id)
    terminal_failures = active_reference_terminal_failures(acct, con_ids)
    marks_by_con_id: Dict[int, Dict[str, Any]] = {}
    reference_complete_ids: Set[int] = set()
    reference_refresh_pending_ids: Set[int] = set()
    for con_id, position in positions_by_con_id.items():
        cached = cached_portfolio_reference_close(
            account=acct,
            position=position,
            broker_time=broker_time,
        )
        if not cached:
            continue
        contract = getattr(position, "contract", None)
        marks_by_con_id[con_id] = {
            **cached,
            "account": acct,
            "conId": con_id,
            "symbol": str(getattr(contract, "symbol", "") or "") or cached.get("symbol"),
            "localSymbol": str(
                getattr(contract, "localSymbol", "")
                or getattr(contract, "symbol", "")
                or ""
            ) or cached.get("localSymbol"),
            "position": finite_float(getattr(position, "position", None)),
        }
        reference_complete_ids.add(con_id)
        if cached.get("referenceRefreshPending") is True:
            reference_refresh_pending_ids.add(con_id)

    direct_live_marks: Dict[int, Dict[str, Any]] = {}
    if include_live and stream_manager:
        try:
            direct_live_marks = stream_manager.get_fresh_direct_live_marks(
                list(positions_by_con_id),
                max_age_seconds=REFERENCE_MARKS_LIVE_MAX_AGE_SEC,
            )
        except Exception:
            direct_live_marks = {}
    for con_id, live_mark in direct_live_marks.items():
        position = positions_by_con_id.get(con_id)
        if position is None:
            continue
        contract = getattr(position, "contract", None)
        row = marks_by_con_id.get(con_id) or {
            "account": acct,
            "conId": con_id,
            "symbol": str(getattr(contract, "symbol", "") or "") or None,
            "localSymbol": str(
                getattr(contract, "localSymbol", "")
                or getattr(contract, "symbol", "")
                or ""
            ) or None,
            "position": finite_float(getattr(position, "position", None)),
            "referenceClose": None,
            "referenceCloseSource": None,
            "referenceCloseSessionDate": None,
            "referenceCloseObservedAt": None,
            "referenceCacheState": None,
            "previousClose": None,
            "previousCloseSessionDate": None,
        }
        row.update(
            {
                "status": "live",
                "price": live_mark["liveMark"],
                "priceState": "live",
                "priceSource": live_mark["liveMarkSource"],
                "priceSessionDate": None,
                "priceObservedAt": live_mark["liveMarkObservedAt"],
                "marketDataType": live_mark["marketDataType"],
            }
        )
        marks_by_con_id[con_id] = row

    pending_con_ids = [
        con_id
        for con_id in positions_by_con_id
        if (
            con_id not in reference_complete_ids
            or con_id in reference_refresh_pending_ids
        )
        and con_id not in terminal_failures
    ]
    pending = []
    for con_id in pending_con_ids:
        position = positions_by_con_id[con_id]
        contract = getattr(position, "contract", None)
        pending.append(
            {
                "account": acct,
                "conId": con_id,
                "symbol": str(getattr(contract, "symbol", "") or "") or None,
                "state": "warming",
            }
        )

    failures = [
        *scope["failures"],
        *[
            terminal_failures[con_id]
            for con_id in positions_by_con_id
            if con_id in terminal_failures
        ],
    ]
    requested_count = len(positions_by_con_id) + len(scope["failures"])
    warming = len(pending_con_ids) > 0
    worker_triggered = schedule_reference_marks_warm(acct) if warming else False
    current_state = reference_warm_state(acct)
    current_reference_count = len(
        reference_complete_ids - reference_refresh_pending_ids
    )
    progress_state = (
        "warming"
        if warming
        else "degraded"
        if failures
        else "complete"
    )
    progress = {
        **current_state,
        "state": progress_state,
        "requestedCount": requested_count,
        "completedCount": current_reference_count,
        "pendingCount": len(pending_con_ids),
        "exhaustedFailureCount": len(failures),
        "progressPercent": reference_progress_percent(
            current_reference_count,
            requested_count,
        ),
        "socketVerifiedAt": socket_verified_at,
        "positionsObservedAt": positions_observed_at,
    }

    marks = [
        marks_by_con_id[con_id]
        for con_id in positions_by_con_id
        if con_id in marks_by_con_id
    ]
    live_mark_count = sum(
        1 for row in marks if row.get("priceState") == "live"
    )
    historical_mark_count = sum(
        1 for row in marks if row.get("priceState") == "historical_close"
    )
    if not positions_by_con_id and not failures:
        status = "empty"
    elif warming:
        status = "warming"
    elif failures:
        status = "partial"
    elif historical_mark_count:
        status = "reference"
    else:
        status = "live"
    observed_at = now_iso()
    return JSONResponse(
        {
            "ok": True,
            "connected": True,
            "status": status,
            "source": "ibkr_portfolio_reference_marks",
            "account": acct,
            "accounts": accounts,
            "include_live": include_live,
            "warming": warming,
            "worker_triggered": worker_triggered,
            "requested_count": requested_count,
            "mark_count": len(marks),
            "reference_close_count": len(reference_complete_ids),
            "live_mark_count": live_mark_count,
            "historical_mark_count": historical_mark_count,
            "warming_count": len(pending),
            "failure_count": len(failures),
            "marks": marks,
            "pending": pending,
            "failures": failures,
            "progress": progress,
            "cache_health": {
                **reference_marks_cache_health,
                "persistent": True,
            },
            "socket_verified_at": socket_verified_at,
            "positions_observed_at": positions_observed_at,
            "observed_at": observed_at,
        }
    )


@app.get("/portfolio/live-account-summary")
async def portfolio_live_account_summary(account: Optional[str] = Query(None)) -> JSONResponse:
    """Return NLV/margin tags only after a current socket round trip."""
    health = await ensure_connected()
    if not health.get("ok"):
        return JSONResponse(
            {
                "ok": False,
                "status": health.get("status", "gateway_unavailable"),
                "message": health.get("message") or "IB Gateway/TWS is not connected.",
                "source": "unavailable",
                "summary": {},
                "observed_at": now_iso(),
            },
            status_code=503,
        )

    try:
        socket_verification = await verify_primary_socket()
        gateway_time = socket_verification["gatewayTime"]
        accounts = [str(value) for value in ib.managedAccounts() if value]
        if not accounts:
            raise RuntimeError("The verified IB session returned no managed accounts.")
        acct = str(account) if account else accounts[0]
        if acct not in accounts:
            raise RuntimeError(f"Account {acct} is not managed by the verified IB session.")
        rows = await asyncio.wait_for(
            ib.accountSummaryAsync(acct),
            timeout=POSITIONS_REQUEST_TIMEOUT_SEC,
        )
        summary: Dict[str, Any] = {"account": acct, "currency": "USD"}
        for row in rows:
            if row.tag not in ACCOUNT_SUMMARY_TAG_SET:
                continue
            try:
                summary[row.tag] = float(row.value)
            except (TypeError, ValueError):
                summary[row.tag] = row.value
            if row.currency and row.tag == "NetLiquidation":
                summary["currency"] = row.currency
        if "NetLiquidation" not in summary:
            raise RuntimeError("The live IB account summary did not return NetLiquidation.")
    except asyncio.TimeoutError:
        return JSONResponse(
            {
                "ok": False,
                "status": "live_account_summary_timeout",
                "message": "The verified IB account-summary request timed out.",
                "source": "unavailable",
                "summary": {},
                "observed_at": now_iso(),
            },
            status_code=503,
        )
    except Exception as exc:
        return JSONResponse(
            {
                "ok": False,
                "status": "live_account_summary_unverified",
                "message": str(exc),
                "source": "unavailable",
                "summary": {},
                "observed_at": now_iso(),
            },
            status_code=503,
        )

    observed_at = now_iso()
    return JSONResponse(
        {
            "ok": True,
            "status": "live",
            "connected": True,
            "source": "ibkr_live_session",
            "account": acct,
            "accounts": accounts,
            "summary": summary,
            "socket_verified_at": gateway_time.isoformat() if hasattr(gateway_time, "isoformat") else str(gateway_time),
            "observed_at": observed_at,
            "fetched_at": observed_at,
        }
    )


@app.get("/portfolio/interest-observation")
async def portfolio_interest_observation(
    account: Optional[str] = Query(None),
) -> JSONResponse:
    """Return a double-read, non-cached IBKR cash-interest observation."""
    requested_account = (
        str(account).strip()
        if isinstance(account, str) and str(account).strip()
        else None
    )
    request_started = time.monotonic()
    timings: Dict[str, Any] = {}
    socket_verified_at: Optional[str] = None

    if not requested_account:
        return interest_observation_unavailable(
            "An exact IBKR account is required for an interest observation.",
            code="ACCOUNT_REQUIRED",
            status_code=409,
            timing={"total_ms": elapsed_ms(request_started)},
        )

    # The dedicated client cannot safely overlap account-update callbacks.
    # Reject rather than queue so abandoned HTTP requests cannot build up.
    if funding_snapshot_lock.locked():
        return interest_observation_unavailable(
            "A live IBKR funding or interest observation is already in progress.",
            code="INTEREST_OBSERVATION_BUSY",
            account=requested_account,
            status_code=409,
            timing={"total_ms": elapsed_ms(request_started)},
        )

    async with funding_snapshot_lock:
        funding_session = funding_ib
        phase_started = time.monotonic()
        health = await ensure_funding_connected(funding_session)
        timings["connect_ms"] = elapsed_ms(phase_started)
        if not health.get("ok"):
            return interest_observation_unavailable(
                health.get("message")
                or "The dedicated IBKR observation client is not connected.",
                code="GATEWAY_UNAVAILABLE",
                account=requested_account,
                timing={**timings, "total_ms": elapsed_ms(request_started)},
                gateway_error_code=health.get("error_code"),
            )

        try:
            require_funding_socket_connected(funding_session)
            phase_started = time.monotonic()
            gateway_time = health.get("gatewayTime")
            if gateway_time is None:
                gateway_time = await asyncio.wait_for(
                    funding_session.reqCurrentTimeAsync(),
                    timeout=LIVE_SESSION_VERIFY_TIMEOUT_SEC,
                )
            socket_observed_datetime = datetime.now(timezone.utc)
            broker_verification = require_fresh_interest_broker_time(
                gateway_time,
                observed_at=socket_observed_datetime,
            )
            timings["socket_ms"] = elapsed_ms(phase_started)
            socket_verified_at = broker_verification["socketVerifiedAt"]
            socket_observed_at = iso_timestamp(socket_observed_datetime)
            require_funding_socket_connected(funding_session)

            managed_accounts = [
                str(value).strip()
                for value in funding_session.managedAccounts()
                if str(value).strip()
            ]
            if not managed_accounts:
                raise FundingEvidenceError(
                    "The verified IB session returned no managed accounts.",
                    "MANAGED_ACCOUNTS_MISSING",
                )
            if len(set(managed_accounts)) != len(managed_accounts):
                raise FundingEvidenceError(
                    "The verified IB session returned duplicate managed accounts.",
                    "MANAGED_ACCOUNTS_DUPLICATE",
                )
            if requested_account not in managed_accounts:
                raise FundingEvidenceError(
                    f"Account {requested_account} is not managed by the verified live IB session.",
                    "ACCOUNT_NOT_MANAGED",
                )
            acct = requested_account
            broker_time = broker_verification["brokerTime"]
            verified_ny_date = broker_time.astimezone(
                ZoneInfo("America/New_York")
            ).date()

            first_read_started = time.monotonic()
            first_account_rows = await request_fresh_account_updates_multi(
                funding_session,
                acct,
            )
            require_funding_socket_connected(funding_session)
            first_summary = build_funding_summary(
                first_account_rows,
                verified_ny_date,
            )
            first_position_snapshot = await request_fresh_balance_positions(
                funding_session,
                acct,
                first_summary["baseCurrency"],
            )
            first_positions = first_position_snapshot["all"]
            first_stock_positions = first_position_snapshot["stocks"]
            first_event_accounting = build_event_contract_accounting_summary(
                first_account_rows,
                first_summary["baseCurrency"],
                first_position_snapshot["eventContracts"],
                total_gross_position_value=finite_float(
                    first_summary.get("GrossPositionValue")
                ),
                stock_gross_position_value=finite_float(
                    first_summary.get("GrossPositionValue-S")
                ),
            )
            if first_event_accounting:
                first_summary.update(
                    first_event_accounting["accountValues"]
                )
            require_positions_in_base_currency(
                first_stock_positions,
                first_summary["baseCurrency"],
            )
            first_positions_observed_at = now_iso()
            first_executions = (
                await request_fresh_account_execution_evidence(
                    funding_session,
                    acct,
                )
            )
            require_funding_socket_connected(funding_session)
            first_signature = interest_observation_account_signature(
                first_summary,
                first_positions,
                first_executions["signature"],
                position_scope=first_position_snapshot["positionScope"],
                event_accounting=first_event_accounting,
            )
            timings["first_read_ms"] = elapsed_ms(first_read_started)

            market_calendar = await request_us_equity_market_calendar(
                funding_session,
                verified_ny_date,
                timings,
            )
            prior_completed_session = (
                await request_latest_completed_us_equity_session(
                    funding_session,
                    market_calendar["contract"],
                    verified_ny_date,
                    timings,
                )
            )
            require_funding_socket_connected(funding_session)

            short_reference_evidence = (
                await build_short_position_reference_evidence(
                    funding_session,
                    first_stock_positions,
                    verified_ny_date,
                    timings,
                )
            )
            if any(
                row.get("referenceCloseSessionDate")
                != prior_completed_session.isoformat()
                for row in short_reference_evidence
            ):
                raise FundingEvidenceError(
                    "A short prior close does not match the verified prior completed US-equity session.",
                    "SHORT_PRIOR_CLOSE_SESSION_MISMATCH",
                )
            require_funding_socket_connected(funding_session)

            second_read_started = time.monotonic()
            second_account_rows = await request_fresh_account_updates_multi(
                funding_session,
                acct,
            )
            require_funding_socket_connected(funding_session)
            second_summary = build_funding_summary(
                second_account_rows,
                verified_ny_date,
            )
            second_position_snapshot = await request_fresh_balance_positions(
                funding_session,
                acct,
                second_summary["baseCurrency"],
            )
            second_positions = second_position_snapshot["all"]
            second_stock_positions = second_position_snapshot["stocks"]
            second_event_accounting = build_event_contract_accounting_summary(
                second_account_rows,
                second_summary["baseCurrency"],
                second_position_snapshot["eventContracts"],
                total_gross_position_value=finite_float(
                    second_summary.get("GrossPositionValue")
                ),
                stock_gross_position_value=finite_float(
                    second_summary.get("GrossPositionValue-S")
                ),
            )
            if second_event_accounting:
                second_summary.update(
                    second_event_accounting["accountValues"]
                )
            require_positions_in_base_currency(
                second_stock_positions,
                second_summary["baseCurrency"],
            )
            second_positions_observed_at = now_iso()
            second_executions = (
                await request_fresh_account_execution_evidence(
                    funding_session,
                    acct,
                )
            )
            require_funding_socket_connected(funding_session)
            second_signature = interest_observation_account_signature(
                second_summary,
                second_positions,
                second_executions["signature"],
                position_scope=second_position_snapshot["positionScope"],
                event_accounting=second_event_accounting,
            )
            timings["second_read_ms"] = elapsed_ms(second_read_started)
            if first_signature != second_signature:
                raise FundingEvidenceError(
                    "Account values, settlement ladders, positions, or executions changed during interest observation.",
                    "INTEREST_OBSERVATION_CHANGED",
                )

            account_values_observed_at = iso_timestamp(
                second_account_rows[-1].get("received_at")
            )
            if not account_values_observed_at:
                raise FundingEvidenceError(
                    "The fresh account update omitted its receipt timestamp.",
                    "ACCOUNT_UPDATE_TIMESTAMP_MISSING",
                )

            forecast = build_interest_forecast_calendar(
                market_calendar,
                broker_time=broker_time,
                prior_completed_session=prior_completed_session,
            )
            require_interest_forecast_cash_anchor(
                second_summary,
                forecast,
            )
            summary_payload = interest_observation_summary(
                second_summary
            )
            settlement_ladders = {
                "securities": summary_payload["SettledCashByDate-S"],
                "commodities": summary_payload["SettledCashByDate-C"],
                "z": summary_payload["SettledCashByDate-Z"],
            }
            short_positions = interest_short_positions(
                short_reference_evidence,
                snapshot_timestamp=second_positions_observed_at,
            )
            execution_evidence = {
                "asOf": second_executions["asOf"],
                "count": second_executions["count"],
                "rows": second_executions["rows"],
            }
            market_calendar_payload = {
                "verifiedNyDate": verified_ny_date.isoformat(),
                "forecastKind": forecast["forecastKind"],
                "sessionDate": forecast["sessionDate"],
                "basisSessionDate": forecast["basisSessionDate"],
                "cashAnchorDate": forecast["cashAnchorDate"],
                "accrualDays": forecast["accrualDays"],
                "currentSessionScheduled": market_calendar[
                    "currentSessionScheduled"
                ],
                "currentSessionCloseAt": forecast[
                    "currentSessionCloseAt"
                ],
                "currentSessionComplete": forecast[
                    "currentSessionComplete"
                ],
                "priorCompletedSessionDate": forecast[
                    "priorCompletedSessionDate"
                ],
                "latestCompletedSessionDate": (
                    forecast["latestCompletedSessionDate"]
                ),
                "nextSessionDate": forecast["nextSessionDate"],
                "liquidHours": market_calendar["liquidHours"],
                "source": "ibkr_contract_details_and_historical_schedule",
            }
            hashed_evidence = {
                "account": acct,
                "summary": summary_payload,
                "settlement_ladders": settlement_ladders,
                "positions": position_quantity_signature(second_positions),
                "position_scope": second_position_snapshot["positionScope"],
                "event_position_evidence": second_position_snapshot["eventContracts"],
                "event_accounting": second_event_accounting,
                "short_positions": short_positions,
                "execution_evidence": execution_evidence,
                "market_calendar": market_calendar_payload,
                "forecast": forecast,
            }
            require_funding_socket_connected(funding_session)
            final_broker_verification = (
                require_fresh_interest_broker_time(
                    gateway_time,
                    observed_at=datetime.now(timezone.utc),
                )
            )
            observed_at = now_iso()
            timings["total_ms"] = elapsed_ms(request_started)
            return JSONResponse(
                {
                    "ok": True,
                    "connected": True,
                    "status": "live",
                    "source": "ibkr_live_interest_observation",
                    "account": acct,
                    "observed_at": observed_at,
                    "socket_verified_at": socket_verified_at,
                    "socket_observed_at": socket_observed_at,
                    "account_values_observed_at": (
                        account_values_observed_at
                    ),
                    "positions_observed_at": (
                        second_positions_observed_at
                    ),
                    "executions_observed_at": second_executions["asOf"],
                    "from_cache": False,
                    "freshness": {
                        "status": "fresh",
                        "broker_time_age_seconds": (
                            final_broker_verification["ageSeconds"]
                        ),
                        "broker_time_max_age_seconds": (
                            INTEREST_OBSERVATION_BROKER_TIME_MAX_AGE_SEC
                        ),
                        "account_reads": 2,
                        "position_reads": 2,
                        "execution_reads": 2,
                        "first_positions_observed_at": (
                            first_positions_observed_at
                        ),
                    },
                    "summary": summary_payload,
                    "settlement_ladders": settlement_ladders,
                    "market_calendar": market_calendar_payload,
                    "forecast": forecast,
                    "position_scope": second_position_snapshot["positionScope"],
                    "event_position_evidence": second_position_snapshot["eventContracts"],
                    "event_accounting": second_event_accounting,
                    "short_positions": short_positions,
                    "execution_evidence": execution_evidence,
                    "evidence_hash": evidence_sha256(hashed_evidence),
                    "timing": timings,
                },
                headers=INTEREST_OBSERVATION_NO_STORE_HEADERS,
            )
        except asyncio.TimeoutError:
            disconnect_funding_session(funding_session)
            return interest_observation_unavailable(
                "The live IBKR interest observation timed out.",
                code="INTEREST_OBSERVATION_TIMEOUT",
                account=requested_account,
                socket_verified_at=socket_verified_at,
                timing={**timings, "total_ms": elapsed_ms(request_started)},
            )
        except FundingEvidenceError as exc:
            disconnect_funding_session(funding_session)
            conflict_codes = {
                "ACCOUNT_NOT_MANAGED",
                "ACCOUNT_UPDATE_ACCOUNT_MISMATCH",
                "EXECUTION_ACCOUNT_MISMATCH",
                "INTEREST_OBSERVATION_CHANGED",
                "MANAGED_ACCOUNTS_DUPLICATE",
                "POSITION_ACCOUNT_MISMATCH",
            }
            return interest_observation_unavailable(
                str(exc),
                code=exc.code,
                account=requested_account,
                status_code=409 if exc.code in conflict_codes else 503,
                socket_verified_at=socket_verified_at,
                timing={**timings, "total_ms": elapsed_ms(request_started)},
            )
        except Exception as exc:
            disconnect_funding_session(funding_session)
            return interest_observation_unavailable(
                f"The live IBKR interest observation failed: {exc}",
                code="INTEREST_OBSERVATION_FAILED",
                account=requested_account,
                socket_verified_at=socket_verified_at,
                timing={**timings, "total_ms": elapsed_ms(request_started)},
            )


@app.get("/portfolio/live-funding")
async def portfolio_live_funding(account: Optional[str] = Query(None)) -> JSONResponse:
    """Return fail-closed cash-debit inputs from one serialized live IBKR read."""
    requested_account = str(account).strip() if account else None
    response_account = requested_account
    socket_verified_at: Optional[str] = None
    request_started = time.monotonic()
    timings: Dict[str, Any] = {}

    # Never let timed-out HTTP clients accumulate behind the serialized IBKR
    # funding request. The next poll can retry after the active read finishes.
    if funding_snapshot_lock.locked():
        return funding_unavailable(
            "A live IBKR funding snapshot is already in progress.",
            code="FUNDING_SNAPSHOT_BUSY",
            account=requested_account,
            connected=False,
            timing={"total_ms": elapsed_ms(request_started)},
        )

    async with funding_snapshot_lock:
        funding_session = funding_ib
        phase_started = time.monotonic()
        health = await ensure_funding_connected(funding_session)
        timings["connect_ms"] = elapsed_ms(phase_started)
        if not health.get("ok"):
            return funding_unavailable(
                health.get("message") or "The dedicated IBKR funding client is not connected.",
                code="GATEWAY_UNAVAILABLE",
                account=requested_account,
                connected=False,
                timing={**timings, "total_ms": elapsed_ms(request_started)},
                gateway_error_code=health.get("error_code"),
            )

        try:
            phase_started = time.monotonic()
            gateway_time = health.get("gatewayTime")
            if gateway_time is None:
                gateway_time = await asyncio.wait_for(
                    funding_session.reqCurrentTimeAsync(),
                    timeout=LIVE_SESSION_VERIFY_TIMEOUT_SEC,
                )
            timings["socket_ms"] = elapsed_ms(phase_started)
            socket_verified_at = iso_timestamp(gateway_time)
            if not socket_verified_at:
                raise FundingEvidenceError(
                    "IBKR socket verification returned an invalid timestamp.",
                    "SOCKET_TIMESTAMP_INVALID",
                )
            verified_ny_datetime = datetime.fromisoformat(
                socket_verified_at.replace("Z", "+00:00")
            ).astimezone(ZoneInfo("America/New_York"))
            settlement_date = verified_ny_datetime.date()

            managed_accounts = [
                str(value)
                for value in funding_session.managedAccounts()
                if value
            ]
            if not managed_accounts:
                raise FundingEvidenceError(
                    "The verified IB session returned no managed accounts.",
                    "MANAGED_ACCOUNTS_MISSING",
                )
            if requested_account:
                if requested_account not in managed_accounts:
                    raise FundingEvidenceError(
                        f"Account {requested_account} is not managed by the verified live IB session.",
                        "ACCOUNT_NOT_MANAGED",
                    )
                acct = requested_account
            elif len(managed_accounts) == 1:
                acct = managed_accounts[0]
            else:
                raise FundingEvidenceError(
                    "An exact account is required when the IB session manages multiple accounts.",
                    "ACCOUNT_REQUIRED",
                )
            response_account = acct

            phase_started = time.monotonic()
            account_value_rows = await request_fresh_account_updates_multi(
                funding_session,
                acct,
            )
            timings["account_values_ms"] = elapsed_ms(phase_started)
            summary = build_funding_summary(account_value_rows, settlement_date)

            phase_started = time.monotonic()
            positions = await request_fresh_supported_stock_positions(
                funding_session,
                acct,
            )
            timings["positions_ms"] = elapsed_ms(phase_started)
            require_positions_in_base_currency(positions, summary["baseCurrency"])
            initial_position_signature = position_quantity_signature(positions)

            market_calendar = await request_us_equity_market_calendar(
                funding_session,
                settlement_date,
                timings,
            )
            reference_mode = not market_calendar["currentSessionScheduled"]
            reference_session_date: Optional[date] = None
            if reference_mode:
                require_reference_cash_ladder(summary)
                reference_session_date = (
                    await request_latest_completed_us_equity_session(
                        funding_session,
                        market_calendar["contract"],
                        settlement_date,
                        timings,
                    )
                )
            else:
                require_fully_settled_securities_cash(summary, settlement_date)

            phase_started = time.monotonic()
            open_order_count = await request_fresh_open_order_count(
                funding_session,
                acct,
            )
            timings["open_orders_ms"] = elapsed_ms(phase_started)
            if reference_mode and open_order_count:
                raise FundingEvidenceError(
                    "Open orders prevent a stable completed-session reference.",
                    "OPEN_ORDERS_PRESENT",
                )

            phase_started = time.monotonic()
            execution_signature = await request_fresh_account_execution_signature(
                funding_session,
                acct,
            )
            timings["executions_ms"] = elapsed_ms(phase_started)
            if not reference_mode and execution_signature:
                raise FundingEvidenceError(
                    "Same-day account execution activity prevents settled-cash verification.",
                    "UNSETTLED_SECURITIES_ACTIVITY",
                )

            if reference_mode:
                short_reference_evidence = (
                    await build_short_position_reference_evidence(
                        funding_session,
                        positions,
                        settlement_date,
                        timings,
                    )
                )
                if any(
                    row.get("referenceCloseSessionDate")
                    != reference_session_date.isoformat()
                    for row in short_reference_evidence
                ):
                    raise FundingEvidenceError(
                        "A short reference close does not match the verified completed US-equity session.",
                        "SHORT_REFERENCE_SESSION_MISMATCH",
                    )
                short_evidence = []
            else:
                short_evidence = await build_short_position_evidence(
                    funding_session,
                    positions,
                    timings,
                )
                short_reference_evidence = []

            verification_started = time.monotonic()
            verification_rows = await request_fresh_account_updates_multi(
                funding_session,
                acct,
            )
            verification_summary = build_funding_summary(
                verification_rows,
                settlement_date,
            )
            if reference_mode:
                require_reference_cash_ladder(verification_summary)
            else:
                require_fully_settled_securities_cash(
                    verification_summary,
                    settlement_date,
                )
            verification_positions = await request_fresh_supported_stock_positions(
                funding_session,
                acct,
            )
            require_positions_in_base_currency(
                verification_positions,
                verification_summary["baseCurrency"],
            )
            verification_open_order_count = await request_fresh_open_order_count(
                funding_session,
                acct,
            )
            verification_execution_signature = (
                await request_fresh_account_execution_signature(
                    funding_session,
                    acct,
                )
            )
            if (
                funding_ledger_signature(summary)
                != funding_ledger_signature(verification_summary)
                or initial_position_signature
                != position_quantity_signature(verification_positions)
                or open_order_count != verification_open_order_count
                or execution_signature != verification_execution_signature
                or (
                    not reference_mode
                    and bool(verification_execution_signature)
                )
            ):
                raise FundingEvidenceError(
                    "Ledger, positions, or order activity changed during funding verification.",
                    "UNSETTLED_SECURITIES_ACTIVITY",
                )
            if reference_mode and verification_open_order_count:
                raise FundingEvidenceError(
                    "Open orders prevent a stable completed-session reference.",
                    "OPEN_ORDERS_PRESENT",
                )
            timings["settlement_verification_ms"] = elapsed_ms(verification_started)
            account_value_rows = verification_rows
            summary = verification_summary
            positions = verification_positions
            open_order_count = verification_open_order_count

            account_values_observed_at = account_value_rows[-1]["received_at"]
            short_prior_close_value = sum(
                abs(row["quantity"]) * row["priorClose"]
                for row in short_evidence
            )
            summary = {
                "account": acct,
                **summary,
                "valueObservedAt": account_values_observed_at,
            }
            observed_at = now_iso()
            if reference_mode:
                short_reference_close_value = sum(
                    abs(row["quantity"]) * row["referenceClose"]
                    for row in short_reference_evidence
                )
                settlement_horizon = reference_settlement_horizon(summary)
                return JSONResponse(
                    {
                        "ok": True,
                        "connected": True,
                        "status": "reference",
                        "source": "ibkr_completed_session_reference",
                        "account": acct,
                        "summary": summary,
                        "funding": None,
                        "fundingReference": {
                            "schemaVersion": 1,
                            "referenceOnly": True,
                            "actionable": False,
                            "referenceKind": (
                                "completed_market_session_with_current_settlement_ladder"
                            ),
                            "referenceSessionDate": (
                                reference_session_date.isoformat()
                            ),
                            "cashLedgerObservedDate": (
                                settlement_date.isoformat()
                            ),
                            "settlementHorizonDate": (
                                settlement_horizon.isoformat()
                            ),
                            "accountValuesObservedAt": (
                                account_values_observed_at
                            ),
                            "openPositionCount": len(positions),
                            "shortPositionCount": len(
                                short_reference_evidence
                            ),
                            "openOrderCount": open_order_count,
                            "executionCountObserved": len(
                                execution_signature
                            ),
                            "cashBalances": summary["CashBalance"],
                            "shortStockReferenceCloseValue": (
                                short_reference_close_value
                            ),
                            "shortPositionReferenceEvidence": (
                                short_reference_evidence
                            ),
                            "positionScope": {
                                "allStock": True,
                                "allBaseCurrency": True,
                            },
                            "settlementVerification": (
                                "reference_segment_ladders_double_snapshot"
                            ),
                        },
                        "socket_verified_at": socket_verified_at,
                        "observed_at": observed_at,
                        "timing": {
                            **timings,
                            "total_ms": elapsed_ms(request_started),
                        },
                    }
                )
            return JSONResponse(
                {
                    "ok": True,
                    "connected": True,
                    "status": "live",
                    "source": "ibkr_live_session",
                    "account": acct,
                    "summary": summary,
                    "funding": {
                        "accountValuesObservedAt": account_values_observed_at,
                        "openPositionCount": len(positions),
                        "shortPositionCount": len(short_evidence),
                        "openOrderCount": open_order_count,
                        "sameDayExecutionCount": 0,
                        "cashBalances": summary["CashBalance"],
                        "shortStockPriorCloseValue": short_prior_close_value,
                        "shortPositionEvidence": short_evidence,
                        "positionScope": {
                            "allStock": True,
                            "allBaseCurrency": True,
                        },
                        "settledShortPositionsVerified": True,
                        "noSameDayExecutionsVerified": True,
                        "settlementStatus": "settled",
                        "settlementDate": settlement_date.strftime("%Y%m%d"),
                        "settlementVerification": (
                            "settled_segment_ledgers_double_snapshot"
                        ),
                    },
                    "socket_verified_at": socket_verified_at,
                    "observed_at": observed_at,
                    "timing": {
                        **timings,
                        "total_ms": elapsed_ms(request_started),
                    },
                }
            )
        except asyncio.TimeoutError:
            disconnect_funding_session(funding_session)
            return funding_unavailable(
                "The live IBKR funding snapshot timed out.",
                code="FUNDING_SNAPSHOT_TIMEOUT",
                account=response_account,
                connected=False,
                socket_verified_at=socket_verified_at,
                timing={**timings, "total_ms": elapsed_ms(request_started)},
            )
        except FundingEvidenceError as exc:
            disconnect_funding_session(funding_session)
            return funding_unavailable(
                str(exc),
                code=exc.code,
                account=response_account,
                connected=False,
                socket_verified_at=socket_verified_at,
                timing={**timings, "total_ms": elapsed_ms(request_started)},
            )
        except Exception as exc:
            disconnect_funding_session(funding_session)
            return funding_unavailable(
                f"The live IBKR funding snapshot failed: {exc}",
                code="FUNDING_SNAPSHOT_FAILED",
                account=response_account,
                connected=False,
                socket_verified_at=socket_verified_at,
                timing={**timings, "total_ms": elapsed_ms(request_started)},
            )




async def _portfolio_live_balance_once(
    account: Optional[str] = None,
) -> JSONResponse:
    """Return one fail-closed, account-scoped portfolio-balance snapshot."""
    requested_account = str(account).strip() if account else None
    response_account = requested_account
    socket_verified_at: Optional[str] = None
    request_started = time.monotonic()
    timings: Dict[str, Any] = {}
    exposure_summary: Optional[Dict[str, Any]] = None

    # Preview evidence and balance reads share this broker mutation-free lock.
    # Same-account HTTP callers are coalesced outside this function.
    if not await wait_for_balance_snapshot_slot():
        return balance_unavailable(
            "A live IBKR portfolio-balance snapshot is already in progress.",
            code="BALANCE_SNAPSHOT_BUSY",
            account=requested_account,
            connected=False,
            timing={"total_ms": elapsed_ms(request_started)},
        )

    async with balance_snapshot_lock:
        funding_session = balance_ib
        phase_started = time.monotonic()
        health = await ensure_balance_connected(funding_session)
        timings["connect_ms"] = elapsed_ms(phase_started)
        if not health.get("ok"):
            return balance_unavailable(
                health.get("message") or "The dedicated IBKR balance client is not connected.",
                code="GATEWAY_UNAVAILABLE",
                account=requested_account,
                connected=False,
                timing={**timings, "total_ms": elapsed_ms(request_started)},
                gateway_error_code=health.get("error_code"),
            )

        try:
            phase_started = time.monotonic()
            socket_verification = await request_balance_broker_time(
                funding_session
            )
            gateway_time = socket_verification["gatewayTime"]
            timings["socket_ms"] = elapsed_ms(phase_started)
            socket_verified_at = socket_verification["socketVerifiedAt"]
            verified_ny_datetime = datetime.fromisoformat(
                socket_verified_at.replace("Z", "+00:00")
            ).astimezone(ZoneInfo("America/New_York"))
            settlement_date = verified_ny_datetime.date()

            managed_accounts = [
                str(value)
                for value in funding_session.managedAccounts()
                if value
            ]
            if not managed_accounts:
                raise FundingEvidenceError(
                    "The verified IB session returned no managed accounts.",
                    "MANAGED_ACCOUNTS_MISSING",
                )
            if requested_account:
                if requested_account not in managed_accounts:
                    raise FundingEvidenceError(
                        f"Account {requested_account} is not managed by the verified live IB session.",
                        "ACCOUNT_NOT_MANAGED",
                    )
                acct = requested_account
            elif len(managed_accounts) == 1:
                acct = managed_accounts[0]
            else:
                raise FundingEvidenceError(
                    "An exact account is required when the IB session manages multiple accounts.",
                    "ACCOUNT_REQUIRED",
                )
            response_account = acct

            async with fresh_balance_read_bracket(funding_session, acct, timings) as reads:
                account_value_rows = await reads["account"]
                exposure_summary = build_balance_exposure_summary(
                    account_value_rows,
                )
                summary = build_funding_summary(account_value_rows, settlement_date)
                summary.update(build_balance_margin_summary(
                    account_value_rows,
                    summary["baseCurrency"],
                ))

                initial_position_snapshot = await balance_positions_from_snapshot(
                    await reads["positions"],
                    acct,
                    summary["baseCurrency"],
                    funding_session,
                )
                positions = initial_position_snapshot["stocks"]
                all_positions = initial_position_snapshot["all"]
                initial_event_accounting = build_event_contract_accounting_summary(
                    account_value_rows,
                    summary["baseCurrency"],
                    initial_position_snapshot["eventContracts"],
                    total_gross_position_value=finite_float(
                        summary.get("GrossPositionValue")
                    ),
                    stock_gross_position_value=finite_float(
                        summary.get("GrossPositionValue-S")
                    ),
                )
                if initial_event_accounting:
                    summary.update(initial_event_accounting["accountValues"])
                require_positions_in_base_currency(positions, summary["baseCurrency"])
                gross_position_value = finite_float(
                    summary.get("GrossPositionValue-S", summary.get("GrossPositionValue"))
                )
                stock_market_value = finite_float(summary.get("StockMarketValue"))
                derived_short_market_value = (
                    max(0.0, (gross_position_value - stock_market_value) / 2.0)
                    if gross_position_value is not None and stock_market_value is not None
                    else 0.0
                )
                if derived_short_market_value > 0.01 and not any(
                    (finite_float(getattr(position, "position", None)) or 0) < 0
                    for position in positions
                ):
                    raise FundingEvidenceError(
                        "IBKR aggregate exposure reports a short while the account-scoped portfolio omitted its position detail.",
                        "SHORT_POSITION_EVIDENCE_MISSING",
                    )

                settlement = require_reconciled_cash_ladders(
                    summary,
                    settlement_date,
                )

                open_order_count = await reads["orders"]
                execution_signature = await reads["executions"]
            short_evidence = await build_balance_short_position_evidence(
                funding_session,
                positions,
                account=acct,
                broker_time=verified_ny_datetime,
                settlement_date=settlement_date,
                timings=timings,
            )

            verification_started = time.monotonic()
            async with fresh_balance_read_bracket(
                funding_session, acct, timings, prefix="verification_",
            ) as reads:
                verification_rows = await reads["account"]
                verification_summary = build_funding_summary(
                    verification_rows,
                    settlement_date,
                )
                verification_summary.update(build_balance_margin_summary(
                    verification_rows,
                    verification_summary["baseCurrency"],
                ))
                exposure_summary = build_balance_exposure_summary(
                    verification_rows,
                )
                verification_settlement = require_reconciled_cash_ladders(
                    verification_summary,
                    settlement_date,
                )
                verification_position_snapshot = await balance_positions_from_snapshot(
                    await reads["positions"],
                    acct,
                    verification_summary["baseCurrency"],
                    funding_session,
                )
                verification_positions = verification_position_snapshot["stocks"]
                verification_all_positions = verification_position_snapshot["all"]
                verification_event_accounting = build_event_contract_accounting_summary(
                    verification_rows,
                    verification_summary["baseCurrency"],
                    verification_position_snapshot["eventContracts"],
                    total_gross_position_value=finite_float(
                        verification_summary.get("GrossPositionValue")
                    ),
                    stock_gross_position_value=finite_float(
                        verification_summary.get("GrossPositionValue-S")
                    ),
                )
                if verification_event_accounting:
                    verification_summary.update(
                        verification_event_accounting["accountValues"]
                    )
                require_positions_in_base_currency(
                    verification_positions,
                    verification_summary["baseCurrency"],
                )
                verification_open_order_count = await reads["orders"]
                verification_execution_signature = await reads["executions"]
            initial_balance_signature = balance_snapshot_signature(
                summary,
                all_positions,
                open_order_count,
                execution_signature,
                settlement,
            )
            verification_balance_signature = balance_snapshot_signature(
                verification_summary,
                verification_all_positions,
                verification_open_order_count,
                verification_execution_signature,
                verification_settlement,
            )
            if initial_balance_signature != verification_balance_signature:
                raise FundingEvidenceError(
                    "Ledger, positions, executions, or order activity changed during balance verification.",
                    "BALANCE_SNAPSHOT_CHANGED",
                )
            timings["settlement_verification_ms"] = elapsed_ms(verification_started)
            account_value_rows = verification_rows
            summary = verification_summary
            positions = verification_positions
            all_positions = verification_all_positions
            position_snapshot = verification_position_snapshot
            event_accounting = verification_event_accounting
            open_order_count = verification_open_order_count
            settlement = verification_settlement

            account_values_observed_at = account_value_rows[-1]["received_at"]
            short_prior_close_value = sum(
                abs(row["quantity"]) * row["priorClose"]
                for row in short_evidence
            )
            summary = {
                "account": acct,
                **summary,
                "valueObservedAt": account_values_observed_at,
            }
            observed_at = now_iso()
            evidence_payload = {
                "accountValuesObservedAt": account_values_observed_at,
                "openPositionCount": len(all_positions),
                "shortPositionCount": len(short_evidence),
                "openOrderCount": open_order_count,
                "sameDayExecutionCount": len(execution_signature),
                "cashBalances": summary["CashBalance"],
                "shortStockPriorCloseValue": short_prior_close_value,
                "shortPositionEvidence": short_evidence,
                "positionEvidence": [
                    {
                        "conId": int(
                            getattr(getattr(position, "contract", None), "conId", 0)
                            or 0
                        ),
                        "symbol": str(
                            getattr(getattr(position, "contract", None), "symbol", "")
                            or ""
                        ).upper(),
                        "quantity": finite_float(getattr(position, "position", None)),
                        "currency": str(
                            getattr(getattr(position, "contract", None), "currency", "")
                            or ""
                        ).upper(),
                    }
                    for position in positions
                ],
                "eventPositionEvidence": position_snapshot["eventContracts"],
                "eventAccounting": event_accounting,
                "positionScope": position_snapshot["positionScope"],
                "capacityAvailable": True,
                "settlementLaddersVerified": True,
                "activitySnapshotVerified": True,
                "settlementState": settlement["state"],
                "settlementDate": settlement["settlementDate"],
                "settlementHorizonDate": settlement["horizonDate"],
                "settlementVerification": "segment_ladders_double_snapshot",
            }
            snapshot_id = evidence_sha256(
                {
                    "account": acct,
                    "summary": summary,
                    "balanceEvidence": evidence_payload,
                    "observedAt": observed_at,
                }
            )
            return JSONResponse(
                {
                    "ok": True,
                    "connected": True,
                    "status": "live",
                    "source": "ibkr_live_session",
                    "from_cache": False,
                    "account": acct,
                    "summary": summary,
                    "snapshotId": snapshot_id,
                    "balanceEvidence": evidence_payload,
                    "socket_verified_at": socket_verified_at,
                    "observed_at": observed_at,
                    "freshness": {
                        "status": "fresh",
                        "maxAgeSeconds": 45,
                        "accountReads": 2,
                        "positionReads": 2,
                        "activityReads": 2,
                    },
                    "timing": {
                        **timings,
                        "total_ms": elapsed_ms(request_started),
                    },
                },
                headers=INTEREST_OBSERVATION_NO_STORE_HEADERS,
            )
        except asyncio.TimeoutError:
            disconnect_balance_session(funding_session)
            return balance_unavailable(
                "The live IBKR portfolio-balance snapshot timed out.",
                code="BALANCE_SNAPSHOT_TIMEOUT",
                account=response_account,
                connected=False,
                socket_verified_at=socket_verified_at,
                timing={**timings, "total_ms": elapsed_ms(request_started)},
            )
        except FundingEvidenceError as exc:
            terminal_codes = {
                "ACCOUNT_NOT_MANAGED",
                "ACCOUNT_REQUIRED",
                "ACCOUNT_UPDATE_ACCOUNT_MISMATCH",
                "ACCOUNT_NOT_READY",
                "MANAGED_ACCOUNTS_MISSING",
                "SOCKET_TIMESTAMP_INVALID",
            }
            if (
                response_account
                and exposure_summary is not None
                and socket_verified_at
                and exc.code not in terminal_codes
            ):
                try:
                    partial_started = time.monotonic()
                    verification_rows = await request_fresh_account_updates_multi(
                        funding_session,
                        response_account,
                    )
                    verified_exposure_summary = build_balance_exposure_summary(
                        verification_rows,
                    )
                    try:
                        verified_margin_summary = build_balance_margin_summary(
                            verification_rows,
                            verified_exposure_summary["baseCurrency"],
                        )
                    except FundingEvidenceError:
                        verified_margin_summary = None
                    socket_verification = await request_balance_broker_time(
                        funding_session,
                    )
                    timings["partial_exposure_ms"] = elapsed_ms(partial_started)
                    return balance_exposure_only(
                        account=response_account,
                        summary=verified_exposure_summary,
                        margin_summary=verified_margin_summary,
                        account_values_observed_at=verification_rows[-1]["received_at"],
                        capacity_code=exc.code,
                        capacity_message=str(exc),
                        socket_verified_at=socket_verification["socketVerifiedAt"],
                        timing={**timings, "total_ms": elapsed_ms(request_started)},
                    )
                except Exception:
                    pass
            disconnect_balance_session(funding_session)
            return balance_unavailable(
                str(exc),
                code=exc.code,
                account=response_account,
                connected=False,
                socket_verified_at=socket_verified_at,
                timing={**timings, "total_ms": elapsed_ms(request_started)},
            )
        except Exception as exc:
            disconnect_balance_session(funding_session)
            return balance_unavailable(
                f"The live IBKR portfolio-balance snapshot failed: {exc}",
                code="BALANCE_SNAPSHOT_FAILED",
                account=response_account,
                connected=False,
                socket_verified_at=socket_verified_at,
                timing={**timings, "total_ms": elapsed_ms(request_started)},
            )


@app.get("/portfolio/live-balance")
async def portfolio_live_balance(account: Optional[str] = Query(None)) -> JSONResponse:
    """Coalesce one account's live read and enforce a 12-second total budget."""
    global balance_request_account, balance_request_task
    requested_account = str(account).strip() if account else None

    async with balance_request_state_lock:
        active_task = balance_request_task
        if active_task is not None and not active_task.done():
            if balance_request_account != requested_account:
                return balance_unavailable(
                    "A live IBKR balance request for a different account is already in progress.",
                    code="BALANCE_SNAPSHOT_ACCOUNT_BUSY",
                    account=requested_account,
                )
            task = active_task
        else:
            async def bounded_request() -> JSONResponse:
                try:
                    return await asyncio.wait_for(
                        _portfolio_live_balance_once(requested_account),
                        timeout=BALANCE_TOTAL_DEADLINE_SEC,
                    )
                except asyncio.TimeoutError:
                    disconnect_balance_session(balance_ib)
                    return balance_unavailable(
                        "The live IBKR portfolio-balance request exceeded its "
                        f"{BALANCE_TOTAL_DEADLINE_SEC:.0f}-second total deadline.",
                        code="IBKR_BALANCE_REQUEST_TIMEOUT",
                        account=requested_account,
                        connected=False,
                        timing={"total_ms": int(BALANCE_TOTAL_DEADLINE_SEC * 1000)},
                    )

            task = asyncio.create_task(bounded_request())
            balance_request_task = task
            balance_request_account = requested_account

    try:
        return await asyncio.shield(task)
    finally:
        if task.done():
            async with balance_request_state_lock:
                if balance_request_task is task:
                    balance_request_task = None
                    balance_request_account = None


async def build_batch_portfolio_preview_evidence(
    request: PortfolioBalancePreviewEvidenceRequest,
) -> JSONResponse:
    """Verify every active planner leg in one read-only broker pass."""
    account = str(request.account or "").strip()
    legs = list(request.legs or [])
    request_started = time.monotonic()
    socket_verified_at: Optional[str] = None
    if not account or not legs:
        return balance_unavailable(
            "A valid account and at least one scenario leg are required.",
            code="BALANCE_PREVIEW_REQUEST_INVALID",
            account=account or None,
        )
    if not await wait_for_balance_snapshot_slot():
        return balance_unavailable(
            "A live IBKR portfolio-balance read is already in progress.",
            code="BALANCE_SNAPSHOT_BUSY",
            account=account,
        )

    async with balance_snapshot_lock:
        funding_session = balance_ib
        health = await ensure_balance_connected(funding_session)
        if not health.get("ok"):
            return balance_unavailable(
                health.get("message") or "The dedicated IBKR balance client is not connected.",
                code="GATEWAY_UNAVAILABLE",
                account=account,
            )
        try:
            socket_verification = await request_balance_broker_time(funding_session)
            gateway_time = socket_verification["gatewayTime"]
            socket_verified_at = socket_verification["socketVerifiedAt"]
            settlement_date = gateway_time.astimezone(
                ZoneInfo("America/New_York")
            ).date()
            managed_accounts = [
                str(value) for value in funding_session.managedAccounts() if value
            ]
            if account not in managed_accounts:
                raise FundingEvidenceError(
                    f"Account {account} is not managed by the verified live IB session.",
                    "ACCOUNT_NOT_MANAGED",
                )

            positions = await request_fresh_supported_stock_positions(
                funding_session,
                account,
            )
            open_order_count = await request_fresh_open_order_count(
                funding_session,
                account,
            )
            if open_order_count > 0:
                raise FundingEvidenceError(
                    "Open orders must be resolved before previewing another trade.",
                    "OPEN_ORDERS_PRESENT",
                )

            qualified_contracts: Dict[str, Contract] = {}
            for leg in legs:
                action = str(leg.action or "").strip().lower()
                symbol = str(leg.symbol or "").strip().upper()
                con_id = int(leg.conId or 0)
                if action not in {"buy_long", "sell_long", "add_short", "cover_short"}:
                    raise FundingEvidenceError(
                        f"Unsupported planner action for leg {leg.id}.",
                        "BALANCE_PREVIEW_REQUEST_INVALID",
                    )
                if con_id <= 0 and not symbol:
                    raise FundingEvidenceError(
                        f"A ticker or conId is required for planner leg {leg.id}.",
                        "BALANCE_PREVIEW_SYMBOL_REQUIRED",
                    )
                requested = Contract(
                    conId=con_id,
                    symbol=None if con_id > 0 else symbol,
                    secType="STK",
                    exchange="SMART",
                    currency="USD",
                )
                qualified = await asyncio.wait_for(
                    funding_session.qualifyContractsAsync(requested),
                    timeout=FUNDING_QUALIFICATION_TIMEOUT_SEC,
                )
                exact = [
                    contract for contract in list(qualified or [])
                    if int(getattr(contract, "conId", 0) or 0) > 0
                    and str(getattr(contract, "secType", "") or "").upper() == "STK"
                    and str(getattr(contract, "currency", "") or "").upper() == "USD"
                    and (not symbol or str(getattr(contract, "symbol", "") or "").upper() == symbol)
                ]
                if len(exact) != 1:
                    raise FundingEvidenceError(
                        f"IBKR could not uniquely qualify USD stock ticker {symbol or con_id}.",
                        "BALANCE_PREVIEW_SYMBOL_AMBIGUOUS",
                    )
                qualified_contracts[str(leg.id)] = exact[0]

            include_shortability = any(
                str(leg.action or "").strip().lower() == "add_short"
                for leg in legs
            )
            unique_contracts: List[Contract] = []
            seen_contract_ids = set()
            for contract in qualified_contracts.values():
                contract_id = int(getattr(contract, "conId", 0) or 0)
                if contract_id and contract_id not in seen_contract_ids:
                    seen_contract_ids.add(contract_id)
                    unique_contracts.append(contract)
            quote_rows = await request_live_short_quotes(
                funding_session,
                unique_contracts,
                include_shortability=include_shortability,
            )
            short_contracts = []
            short_contract_ids = set()
            for leg in legs:
                if str(leg.action or "").strip().lower() not in {"add_short", "cover_short"}:
                    continue
                contract = qualified_contracts[str(leg.id)]
                contract_id = int(getattr(contract, "conId", 0) or 0)
                if contract_id and contract_id not in short_contract_ids:
                    short_contract_ids.add(contract_id)
                    short_contracts.append(contract)
            prior_closes = await request_historical_prior_closes(
                funding_session,
                short_contracts,
                completed_before=settlement_date,
            ) if short_contracts else {}

            positions_by_con_id = {
                int(getattr(getattr(position, "contract", None), "conId", 0) or 0): position
                for position in positions
            }
            evidence_rows = []
            for leg in legs:
                contract = qualified_contracts[str(leg.id)]
                con_id = int(contract.conId)
                action = str(leg.action or "").strip().lower()
                quote = quote_rows.get(con_id)
                if not quote:
                    raise FundingEvidenceError(
                        f"IBKR returned no live quote for planner leg {leg.id}.",
                        "BALANCE_PREVIEW_QUOTE_MISSING",
                    )
                position = positions_by_con_id.get(con_id)
                position_quantity = finite_float(
                    getattr(position, "position", None)
                ) if position is not None else 0.0
                prior = prior_closes.get(con_id) or {}
                evidence_rows.append({
                    "id": str(leg.id),
                    "action": action,
                    "available": True,
                    "conId": con_id,
                    "symbol": str(getattr(contract, "symbol", "") or "").upper(),
                    "positionQuantity": position_quantity,
                    "bid": quote.get("directBid"),
                    "ask": quote.get("directAsk"),
                    "last": quote.get("directLast"),
                    "currentPrice": quote.get("currentPrice"),
                    "marketDataType": quote.get("marketDataType"),
                    "quoteObservedAt": quote.get("snapshotTimestamp"),
                    "shortableShares": quote.get("shortableShares"),
                    "shortabilitySource": quote.get("shortabilitySource"),
                    "priorClose": prior.get("priorClose"),
                    "priorCloseSource": prior.get("priorCloseSource"),
                    "priorCloseSessionDate": prior.get("priorCloseSessionDate"),
                    "priorCloseObservedAt": prior.get("priorCloseObservedAt"),
                    "from_cache": False,
                })

            verification_positions = await request_fresh_supported_stock_positions(
                funding_session,
                account,
            )
            verification_open_order_count = await request_fresh_open_order_count(
                funding_session,
                account,
            )
            if (
                position_quantity_signature(positions)
                != position_quantity_signature(verification_positions)
                or open_order_count != verification_open_order_count
            ):
                raise FundingEvidenceError(
                    "Account positions or open orders changed during planner verification.",
                    "BALANCE_PREVIEW_EVIDENCE_CHANGED",
                )
            observed_at = now_iso()
            return JSONResponse(
                {
                    "ok": True,
                    "available": True,
                    "connected": True,
                    "status": "live",
                    "source": "ibkr_live_session",
                    "account": account,
                    "legs": evidence_rows,
                    "positions": [
                        {
                            "conId": int(getattr(getattr(position, "contract", None), "conId", 0) or 0),
                            "symbol": str(getattr(getattr(position, "contract", None), "symbol", "") or "").upper(),
                            "quantity": finite_float(getattr(position, "position", None)),
                            "currency": str(getattr(getattr(position, "contract", None), "currency", "") or "").upper(),
                        }
                        for position in verification_positions
                    ],
                    "observed_at": observed_at,
                    "socket_verified_at": socket_verified_at,
                    "from_cache": False,
                    "orderSubmitted": False,
                    "timing": {"total_ms": elapsed_ms(request_started)},
                },
                headers=INTEREST_OBSERVATION_NO_STORE_HEADERS,
            )
        except asyncio.TimeoutError:
            disconnect_balance_session(funding_session)
            return balance_unavailable(
                "The live planner evidence timed out.",
                code="BALANCE_PREVIEW_TIMEOUT",
                account=account,
                socket_verified_at=socket_verified_at,
            )
        except FundingEvidenceError as exc:
            disconnect_balance_session(funding_session)
            return balance_unavailable(
                str(exc),
                code=exc.code,
                account=account,
                socket_verified_at=socket_verified_at,
            )
        except Exception as exc:
            disconnect_balance_session(funding_session)
            return balance_unavailable(
                f"The live planner evidence failed: {exc}",
                code="BALANCE_PREVIEW_FAILED",
                account=account,
                socket_verified_at=socket_verified_at,
            )


@app.post("/portfolio/live-balance/preview-evidence")
async def portfolio_live_balance_preview_evidence(
    request: PortfolioBalancePreviewEvidenceRequest,
) -> JSONResponse:
    """Verify one existing short for a read-only, conditional trade preview."""
    if request.legs:
        return await build_batch_portfolio_preview_evidence(request)

    account = str(request.account or "").strip()
    action = str(request.action or "").strip().lower()
    con_id = int(request.conId or 0)
    quantity = finite_float(request.quantity)
    request_started = time.monotonic()
    socket_verified_at: Optional[str] = None
    if (
        not account
        or action not in {"add_short", "cover_short"}
        or con_id <= 0
        or quantity is None
        or quantity <= 0
    ):
        return balance_unavailable(
            "A valid account, existing short conId, action, and positive quantity are required.",
            code="BALANCE_PREVIEW_REQUEST_INVALID",
            account=account or None,
        )
    if not await wait_for_balance_snapshot_slot():
        return balance_unavailable(
            "A live IBKR portfolio-balance read is already in progress.",
            code="BALANCE_SNAPSHOT_BUSY",
            account=account,
        )

    async with balance_snapshot_lock:
        funding_session = balance_ib
        health = await ensure_balance_connected(funding_session)
        if not health.get("ok"):
            return balance_unavailable(
                health.get("message") or "The dedicated IBKR balance client is not connected.",
                code="GATEWAY_UNAVAILABLE",
                account=account,
            )
        try:
            socket_verification = await request_balance_broker_time(
                funding_session
            )
            gateway_time = socket_verification["gatewayTime"]
            socket_verified_at = socket_verification["socketVerifiedAt"]
            managed_accounts = [
                str(value) for value in funding_session.managedAccounts() if value
            ]
            if account not in managed_accounts:
                raise FundingEvidenceError(
                    f"Account {account} is not managed by the verified live IB session.",
                    "ACCOUNT_NOT_MANAGED",
                )

            positions = await request_fresh_supported_stock_positions(
                funding_session,
                account,
            )
            matches = [
                position
                for position in positions
                if int(
                    getattr(getattr(position, "contract", None), "conId", 0)
                    or 0
                ) == con_id
            ]
            if len(matches) != 1:
                raise FundingEvidenceError(
                    "The requested existing short position was not uniquely verified.",
                    "BALANCE_PREVIEW_POSITION_NOT_FOUND",
                )
            position = matches[0]
            position_quantity = finite_float(getattr(position, "position", None))
            if position_quantity is None or position_quantity >= 0:
                raise FundingEvidenceError(
                    "The requested conId is not a currently verified short position.",
                    "BALANCE_PREVIEW_POSITION_NOT_SHORT",
                )
            if action == "cover_short" and quantity > abs(position_quantity):
                raise FundingEvidenceError(
                    "Cover shares exceed the currently verified short position.",
                    "BALANCE_PREVIEW_COVER_EXCEEDS_POSITION",
                )

            open_order_count = await request_fresh_open_order_count(
                funding_session,
                account,
            )
            if open_order_count > 0:
                raise FundingEvidenceError(
                    "Open orders must be resolved before previewing another trade.",
                    "OPEN_ORDERS_PRESENT",
                )

            try:
                qualified = await asyncio.wait_for(
                    funding_session.qualifyContractsAsync(Contract(conId=con_id)),
                    timeout=FUNDING_QUALIFICATION_TIMEOUT_SEC,
                )
            except asyncio.TimeoutError as exc:
                raise FundingEvidenceError(
                    "IBKR contract qualification timed out for the short preview.",
                    "SHORT_QUALIFICATION_TIMEOUT",
                ) from exc
            exact_contracts = [
                contract
                for contract in list(qualified or [])
                if int(getattr(contract, "conId", 0) or 0) == con_id
                and str(getattr(contract, "secType", "") or "").upper()
                == "STK"
                and str(getattr(contract, "currency", "") or "").upper()
                == "USD"
            ]
            if len(exact_contracts) != 1:
                raise FundingEvidenceError(
                    "IBKR could not exactly qualify the USD stock short preview.",
                    "SHORT_QUALIFICATION_FAILED",
                )

            quote = (
                await request_live_short_quotes(
                    funding_session,
                    exact_contracts,
                    include_shortability=action == "add_short",
                )
            ).get(con_id)
            if not quote:
                raise FundingEvidenceError(
                    "IBKR returned no verified live quote for the short preview.",
                    "SHORT_SNAPSHOT_UNAVAILABLE",
                )
            return JSONResponse(
                {
                    "ok": True,
                    "available": True,
                    "connected": True,
                    "status": "live",
                    "source": "ibkr_live_session",
                    "account": account,
                    "conId": con_id,
                    "action": action,
                    "positionQuantity": position_quantity,
                    "bid": quote["directBid"],
                    "ask": quote["directAsk"],
                    "last": quote["directLast"],
                    "currentPrice": quote["currentPrice"],
                    "marketDataType": quote["marketDataType"],
                    "quoteObservedAt": quote["snapshotTimestamp"],
                    "shortableShares": quote.get("shortableShares"),
                    "shortabilitySource": quote.get("shortabilitySource"),
                    "socket_verified_at": socket_verified_at,
                    "observed_at": now_iso(),
                    "from_cache": False,
                    "orderSubmitted": False,
                    "timing": {"total_ms": elapsed_ms(request_started)},
                },
                headers=INTEREST_OBSERVATION_NO_STORE_HEADERS,
            )
        except asyncio.TimeoutError:
            disconnect_balance_session(funding_session)
            return balance_unavailable(
                "The live short-preview evidence timed out.",
                code="BALANCE_PREVIEW_TIMEOUT",
                account=account,
                socket_verified_at=socket_verified_at,
            )
        except FundingEvidenceError as exc:
            disconnect_balance_session(funding_session)
            return balance_unavailable(
                str(exc),
                code=exc.code,
                account=account,
                socket_verified_at=socket_verified_at,
            )
        except Exception as exc:
            disconnect_balance_session(funding_session)
            return balance_unavailable(
                f"The live short-preview evidence failed: {exc}",
                code="BALANCE_PREVIEW_FAILED",
                account=account,
                socket_verified_at=socket_verified_at,
            )


def instrument_to_contract(inst: InstrumentIn) -> Contract:
    # A broker conId is the authoritative contract identity. Re-attaching the
    # partial fields returned by reqPositions can make an otherwise exact
    # contract invalid (for example PINK vs SMART, or SMART vs
    # FORECASTX/KALSHI). Qualify the conId alone and let IBKR return the full
    # routing and derivative identity before requesting market data.
    if inst.conId:
        return Contract(conId=int(inst.conId))

    c = Contract()
    c.symbol = (inst.symbol or "").upper()
    c.secType = inst.secType or "STK"
    c.exchange = inst.exchange or "SMART"
    c.currency = inst.currency or "USD"
    if inst.lastTradeDateOrContractMonth:
        c.lastTradeDateOrContractMonth = inst.lastTradeDateOrContractMonth
    if inst.tradingClass:
        c.tradingClass = inst.tradingClass
    if inst.multiplier:
        c.multiplier = inst.multiplier
    return c


def historical_what_to_show(contract: Contract) -> str:
    """Use the broker's midpoint series for instruments without trade prints."""
    sec_type = str(getattr(contract, "secType", "") or "").upper()
    return "MIDPOINT" if sec_type in {"CASH", "CMDTY"} else "TRADES"


def resolve_account(account: Optional[str]) -> Optional[str]:
    if account:
        return account
    accounts = ib.managedAccounts()
    return accounts[0] if accounts else None


@app.get("/accounts")
async def accounts() -> JSONResponse:
    health = await ensure_connected()
    if not health["ok"]:
        return JSONResponse(
            {"ok": False, "status": health["status"], "message": health.get("message"), "accounts": []},
            status_code=200,
        )
    try:
        managed_accounts = ib.managedAccounts()
    except Exception as exc:
        return JSONResponse(
            {
                "ok": False,
                "status": "accounts_unavailable",
                "message": str(exc),
                "accounts": [],
            },
            status_code=200,
        )
    return JSONResponse({"ok": True, "accounts": managed_accounts, "fetched_at": now_iso()})


@app.post("/quotes")
async def quotes(body: QuotesRequest) -> JSONResponse:
    health = await ensure_connected()
    if not health["ok"]:
        return JSONResponse(
            {"ok": False, "status": health["status"], "message": health.get("message"), "quotes": []},
            status_code=200,
        )

    instruments = body.instruments[:MAX_QUOTE_BATCH]
    async def fetch_one(inst: InstrumentIn):
        try:
            if not stream_manager:
                return inst, None, "stream_manager_unavailable"
            result = await stream_manager.get_quote_for_instrument(
                inst,
                timeout_sec=QUOTE_WAIT_SEC,
                force_refresh=body.forceRefresh,
            )
            return inst, result.get("quote"), result.get("error")
        except Exception as exc:
            return inst, None, str(exc)

    results = await asyncio.gather(*(fetch_one(inst) for inst in instruments))
    quotes_out: List[Dict[str, Any]] = []
    errors: List[str] = []
    for inst, raw, error in results:
        if raw and not error:
            quotes_out.append(raw)
        if error:
            errors.append(f"{inst.symbol or inst.conId}: {error}")

    return JSONResponse(
        {
            "ok": True,
            "quotes": quotes_out,
            "errors": errors,
            "forceRefresh": body.forceRefresh,
            "refreshMode": "broker_snapshot" if body.forceRefresh else "current_stream",
            "fetched_at": now_iso(),
        }
    )


@app.post("/historical")
async def historical(body: HistoricalRequest) -> JSONResponse:
    health = await ensure_connected()
    if not health["ok"]:
        return JSONResponse(
            {"ok": False, "status": health["status"], "message": health.get("message"), "bars": []},
            status_code=200,
        )

    duration_map = {
        "1d": "1 D",
        "5d": "5 D",
        "10d": "10 D",
        "11d": "11 D",
        "1mo": "1 M",
        "3mo": "3 M",
        "6mo": "6 M",
        "1y": "1 Y",
        "2y": "2 Y",
    }
    bar_size_map = {
        "1m": "1 min",
        "5m": "5 mins",
        "15m": "15 mins",
        "1h": "1 hour",
        "1d": "1 day",
    }
    duration = duration_map.get(body.range, "1 M")
    bar_size = bar_size_map.get(body.interval, "1 day")

    try:
        async with historical_request_lock:
            contract = instrument_to_contract(body.instrument)
            qualified = await asyncio.wait_for(
                ib.qualifyContractsAsync(contract),
                timeout=8.0,
            )
            if not qualified:
                return JSONResponse(
                    {"ok": False, "message": "Could not qualify contract", "bars": []},
                    status_code=200,
                )
            qc = qualified[0]
            what_to_show = historical_what_to_show(qc)
            bars = await asyncio.wait_for(
                ib.reqHistoricalDataAsync(
                    qc,
                    endDateTime="",
                    durationStr=duration,
                    barSizeSetting=bar_size,
                    whatToShow=what_to_show,
                    useRTH=body.useRth,
                    formatDate=1,
                ),
                timeout=8.0,
            )
        out = [
            {
                "date": str(b.date),
                "open": float(b.open),
                "high": float(b.high),
                "low": float(b.low),
                "close": float(b.close),
                "volume": float(b.volume) if b.volume is not None else None,
            }
            for b in bars
        ]
        return JSONResponse(
            {
                "ok": True,
                "source": "ibkr",
                "bars": out,
                "contract": {
                    "conId": int(qc.conId) if qc.conId else None,
                    "symbol": qc.symbol or body.instrument.symbol,
                    "localSymbol": qc.localSymbol or None,
                    "lastTradeDateOrContractMonth": qc.lastTradeDateOrContractMonth or None,
                    "exchange": qc.exchange or body.instrument.exchange,
                    "currency": qc.currency or body.instrument.currency,
                    "multiplier": qc.multiplier or body.instrument.multiplier,
                    "tradingClass": qc.tradingClass or body.instrument.tradingClass,
                    "secType": qc.secType or body.instrument.secType,
                    "provider": "ibkr",
                },
                "what_to_show": what_to_show,
                "use_rth": body.useRth,
                "fetched_at": now_iso(),
            }
        )
    except asyncio.TimeoutError:
        return JSONResponse(
            {"ok": False, "message": "IBKR historical request timed out", "bars": []},
            status_code=200,
        )
    except Exception as exc:
        return JSONResponse({"ok": False, "message": str(exc), "bars": []}, status_code=200)


def exact_date(value: Any) -> Optional[date]:
    text = str(value or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return None
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


async def load_historical_high_record(
    session: IB,
    contract: Contract,
    through_date: date,
    *,
    chunk_years: int = 10,
    max_chunks: int = 20,
) -> Dict[str, Any]:
    """Load a complete IBKR daily-high record through an exact session date."""
    # Futures and spot FX/commodity series require their full broker session.
    # Spot gold also has no trade-print history at IBKR, so its record must use
    # the same verified MIDPOINT series as the chart instead of TRADES.
    sec_type = str(getattr(contract, "secType", "") or "").upper()
    is_future = sec_type == "FUT"
    use_rth = sec_type not in {"FUT", "CASH", "CMDTY"}
    what_to_show = historical_what_to_show(contract)
    head_value = await session.reqHeadTimeStampAsync(
        contract,
        whatToShow=what_to_show,
        useRTH=use_rth,
        formatDate=2,
    )
    head_date = historical_bar_date(head_value)
    allow_provider_boundary = sec_type in {"CASH", "CMDTY"}
    if (head_date is None and not allow_provider_boundary) or (
        head_date is not None and head_date > through_date
    ):
        raise RuntimeError("IBKR did not return a valid historical-data start date")

    rows_by_date: Dict[date, float] = {}
    cursor_date = through_date
    chunks = 0
    coverage_complete = False
    eastern = ZoneInfo("America/New_York")

    while chunks < max_chunks:
        cursor_end = datetime(
            cursor_date.year,
            cursor_date.month,
            cursor_date.day,
            23,
            59,
            59,
            tzinfo=eastern,
        )
        bars = await session.reqHistoricalDataAsync(
            contract,
            endDateTime=cursor_end,
            durationStr=f"{max(1, int(chunk_years))} Y",
            barSizeSetting="1 day",
            whatToShow=what_to_show,
            useRTH=use_rth,
            formatDate=1,
        )
        chunks += 1
        chunk_dates: List[date] = []
        for bar in bars or []:
            bar_date = historical_bar_date(getattr(bar, "date", None))
            bar_high = positive_float(getattr(bar, "high", None))
            if (
                bar_date is None
                or bar_high is None
                or (head_date is not None and bar_date < head_date)
                or bar_date > cursor_date
                or bar_date > through_date
            ):
                continue
            rows_by_date[bar_date] = bar_high
            chunk_dates.append(bar_date)
        if not chunk_dates and (is_future or allow_provider_boundary) and rows_by_date:
            # IBKR's head timestamp for a dated future can describe the root
            # history rather than that exact conId. XAUUSD midpoint history can
            # omit a head timestamp entirely. In either case, an explicit
            # request ending before the first returned bar establishes the
            # broker's complete provider boundary for this exact contract.
            head_date = min(rows_by_date)
            coverage_complete = True
            break
        if not chunk_dates:
            raise RuntimeError("IBKR returned no usable daily highs for a record-history chunk")
        earliest = min(chunk_dates)
        if head_date is not None and earliest <= head_date:
            coverage_complete = True
            break
        next_cursor = earliest - timedelta(days=1)
        if next_cursor >= cursor_date:
            raise RuntimeError("IBKR historical-record pagination made no backward progress")
        cursor_date = next_cursor

    if not coverage_complete or not rows_by_date:
        raise RuntimeError("IBKR all-history coverage is incomplete")
    coverage_start = min(rows_by_date)
    coverage_end = max(rows_by_date)
    if coverage_end != through_date:
        raise RuntimeError(
            f"IBKR record history ended on {coverage_end.isoformat()} instead of {through_date.isoformat()}"
        )
    record_date, record_high = max(
        rows_by_date.items(),
        key=lambda item: (item[1], item[0]),
    )
    return {
        "record": {"high": record_high, "date": record_date.isoformat()},
        "coverage": {
            "complete": True,
            "start_date": coverage_start.isoformat(),
            "end_date": coverage_end.isoformat(),
            "head_date": head_date.isoformat(),
            "chunks": chunks,
            "observations": len(rows_by_date),
        },
    }


@app.post("/historical-record")
async def historical_record(body: HistoricalRecordRequest) -> JSONResponse:
    through_date = exact_date(body.throughDate)
    if through_date is None:
        return JSONResponse(
            {"ok": False, "status": "unavailable", "source": None, "message": "Invalid throughDate"},
            status_code=200,
        )
    health = await ensure_connected()
    if not health["ok"]:
        return JSONResponse(
            {
                "ok": False,
                "status": "unavailable",
                "source": None,
                "message": health.get("message") or health["status"],
            },
            status_code=200,
        )

    try:
        contract = instrument_to_contract(body.instrument)
        qualified = await ib.qualifyContractsAsync(contract)
        if not qualified:
            return JSONResponse(
                {
                    "ok": False,
                    "status": "unavailable",
                    "source": None,
                    "message": "Could not qualify contract",
                },
                status_code=200,
            )
        result = await load_historical_high_record(ib, qualified[0], through_date)
        return JSONResponse(
            {
                "ok": True,
                "status": "available",
                "source": "ibkr",
                "through_date": through_date.isoformat(),
                **result,
                "fetched_at": now_iso(),
            }
        )
    except Exception as exc:
        return JSONResponse(
            {
                "ok": False,
                "status": "unavailable",
                "source": None,
                "message": str(exc),
            },
            status_code=200,
        )


async def fetch_positions_snapshot(acct: str) -> Dict[str, Any]:
    snapshot_started_at = now_iso()
    try:
        await req_positions_bounded(ib)
    except asyncio.TimeoutError:
        return {
            "ok": False,
            "account": acct,
            "positions": [],
            "snapshot_started_at": snapshot_started_at,
            "fetched_at": now_iso(),
            "source": "ibkr_positions",
            "status": "positions_timeout",
            "message": f"IBKR positions request timed out after {POSITIONS_REQUEST_TIMEOUT_SEC:.1f}s",
        }
    except Exception as exc:
        return {
            "ok": False,
            "account": acct,
            "positions": [],
            "snapshot_started_at": snapshot_started_at,
            "fetched_at": now_iso(),
            "source": "ibkr_positions",
            "status": "positions_error",
            "message": str(exc),
        }
    await asyncio.sleep(0.5)
    positions = []
    for pos in ib.positions():
        if pos.account != acct:
            continue
        c = pos.contract
        positions.append(
            {
                "account": pos.account,
                "symbol": c.symbol,
                "conId": int(c.conId) if c.conId else None,
                "secType": c.secType,
                "exchange": c.exchange,
                "currency": c.currency or "USD",
                "localSymbol": c.localSymbol or c.symbol,
                "description": getattr(c, "description", None) or None,
                "tradingClass": getattr(c, "tradingClass", None) or None,
                "expiration": getattr(c, "lastTradeDateOrContractMonth", None) or None,
                "strike": float(c.strike) if getattr(c, "strike", None) not in (None, "") else None,
                "contractSide": getattr(c, "right", None) or None,
                "position": float(pos.position),
                "quantity": abs(float(pos.position)),
                "side": "SHORT" if float(pos.position) < 0 else "LONG",
                "price": float(pos.avgCost),
                "avgCost": float(pos.avgCost),
                "marketValue": None,
                "unrealizedPnL": None,
                "realizedPnL": None,
            }
        )

    return {
        "ok": True,
        "account": acct,
        "positions": positions,
        "snapshot_started_at": snapshot_started_at,
        "fetched_at": now_iso(),
        "source": "ibkr_positions",
    }


@app.get("/portfolio/positions")
async def portfolio_positions(
    account: Optional[str] = Query(None),
    direct: bool = Query(False),
) -> JSONResponse:
    health = await ensure_connected()
    if not health["ok"]:
        return JSONResponse(
            {"ok": False, "status": health["status"], "message": health.get("message"), "positions": []},
            status_code=200,
        )

    acct = resolve_account(account)
    if not acct:
        return JSONResponse({"ok": False, "message": "No managed accounts", "positions": []}, status_code=200)

    # A direct snapshot is intentionally cache-free. Callers use it only
    # after the normal stream-sync path fails verification.
    if direct:
        async with positions_snapshot_lock:
            return JSONResponse(await fetch_positions_snapshot(acct))

    if stream_manager:
        sync = {"ok": False, "status": "sync_skipped", "message": "Portfolio stream sync timed out"}
        try:
            sync = await asyncio.wait_for(
                stream_manager.sync_account_portfolio(acct),
                timeout=PORTFOLIO_SYNC_TIMEOUT_SEC,
            )
        except asyncio.TimeoutError:
            sync = {
                "ok": False,
                "status": "sync_timeout",
                "message": f"Portfolio stream sync timed out after {PORTFOLIO_SYNC_TIMEOUT_SEC:.1f}s",
            }
        except Exception as exc:
            sync = {"ok": False, "status": "sync_error", "message": str(exc)}

        cached = stream_manager.get_portfolio_cache(acct)
        if cached.get("positions"):
            return JSONResponse({**cached, "sync": sync, "source": "stream_cache"})

        snapshot = await fetch_positions_snapshot(acct)
        return JSONResponse({**snapshot, "sync": sync})

    snapshot = await fetch_positions_snapshot(acct)
    return JSONResponse(snapshot)


@app.get("/portfolio/account-summary")
async def portfolio_account_summary(account: Optional[str] = Query(None)) -> JSONResponse:
    health = await ensure_connected()
    if not health["ok"]:
        return JSONResponse(
            {"ok": False, "status": health["status"], "message": health.get("message"), "summary": {}},
            status_code=200,
        )

    acct = resolve_account(account)
    if not acct:
        return JSONResponse({"ok": False, "message": "No managed accounts", "summary": {}}, status_code=200)

    if stream_manager:
        sync = await stream_manager.sync_account_portfolio(acct)
        cached = stream_manager.get_account_summary_cache(acct)
        if not sync.get("ok") and not cached.get("summary"):
            return JSONResponse(
                {
                    **cached,
                    "ok": False,
                    "status": sync.get("status"),
                    "message": sync.get("message"),
                },
                status_code=200,
            )
        return JSONResponse(cached)

    rows = await ib.accountSummaryAsync(acct)
    summary: Dict[str, Any] = {"account": acct, "currency": "USD"}
    for row in rows:
        tag = row.tag
        if tag in ACCOUNT_SUMMARY_TAG_SET:
            try:
                summary[tag] = float(row.value)
            except (TypeError, ValueError):
                summary[tag] = row.value
        if row.currency and tag == "NetLiquidation":
            summary["currency"] = row.currency

    return JSONResponse({"ok": True, "summary": summary, "fetched_at": now_iso()})


@app.get("/portfolio/open-orders")
async def portfolio_open_orders(account: Optional[str] = Query(None)) -> JSONResponse:
    health = await ensure_connected()
    if not health["ok"]:
        return JSONResponse(
            {"ok": False, "complete": False, "liveVerified": False, "status": health["status"], "message": health.get("message"), "orders": []},
            status_code=200,
            headers={"Cache-Control": "no-store"},
        )
    try:
        accounts = list(ib.managedAccounts())
        if not accounts or account and account not in accounts:
            raise ValueError("Managed account could not be verified")
        async with _open_orders_snapshot_lock:
            started_at = now_iso()
            # All clients, including broker-visible TWS orders. Do not bind,
            # modify, place, or cancel any order while checking protection.
            orders = await fresh_open_orders(ib, accounts, FUNDING_OPEN_ORDERS_TIMEOUT_SEC, LIVE_SESSION_VERIFY_TIMEOUT_SEC)
        if any(not order["account"] for order in orders):
            raise ValueError("An order's account could not be verified")
        if account:
            orders = [order for order in orders if order["account"] == account]
        observed_at = now_iso()
        return JSONResponse({"ok": True, "status": "live", "liveVerified": True, "complete": True,
                             "source": "ibkr_all_open_orders", "from_cache": False,
                             "account": account, "accounts": [account] if account else accounts,
                             "orders": orders, "requestedAt": started_at, "asOf": observed_at,
                             "fetched_at": observed_at}, headers={"Cache-Control": "no-store"})
    except Exception as exc:
        return JSONResponse({"ok": False, "status": "unavailable", "complete": False,
                             "liveVerified": False, "orders": [], "message": str(exc) or "Open orders unavailable"},
                            headers={"Cache-Control": "no-store"})


@app.get("/portfolio/executions")
async def portfolio_executions(account: Optional[str] = Query(None)) -> JSONResponse:
    """Today's fills for the Analyst's Daily Review, read fresh from the broker. Read-only."""
    headers = {"Cache-Control": "no-store"}
    health = await ensure_connected()
    if not health["ok"]:
        return JSONResponse(
            {"ok": False, "complete": False, "liveVerified": False, "status": health["status"],
             "message": health.get("message"), "executions": []},
            status_code=200, headers=headers,
        )
    try:
        accounts = [str(value) for value in ib.managedAccounts() if value]
        if not accounts or account and account not in accounts:
            raise ValueError("Managed account could not be verified")
        selected = [account] if account else accounts
        async with _executions_snapshot_lock:
            started_at = now_iso()
            rows: List[Dict[str, Any]] = []
            # One account-filtered request per account; a failed account fails the whole read,
            # so a partial list is never presented as the day's trading.
            for selected_account in selected:
                evidence = await request_fresh_account_execution_evidence(ib, selected_account)
                rows.extend(evidence["rows"])
        observed_at = now_iso()
        return JSONResponse({"ok": True, "status": "live", "liveVerified": True, "complete": True,
                             "source": "ibkr_executions", "from_cache": False,
                             "account": account, "accounts": selected, "executions": rows,
                             "requestedAt": started_at, "asOf": observed_at, "fetched_at": observed_at},
                            headers=headers)
    except Exception as exc:
        return JSONResponse({"ok": False, "status": "unavailable", "complete": False, "liveVerified": False,
                             "executions": [], "errorCode": getattr(exc, "code", None) or "EXECUTIONS_UNAVAILABLE",
                             "message": str(exc) or "Executions unavailable"}, headers=headers)


def _safe_pnl_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        number = float(value)
        return None if number != number else number
    except (TypeError, ValueError):
        return None


async def _request_fresh_account_pnl(account: str, gateway_time: Any) -> tuple[dict[str, Any], int]:
    """Own exactly one fresh subscription and cancel it only after settlement."""
    subscription_started = False
    try:
        # Deliberately do not cancel before reqPnL. A previous implementation
        # let one HTTP caller cancel another caller's in-flight subscription.
        pnl_subscription = ib.reqPnL(account, "")
        subscription_started = True
        pnl = None
        deadline = asyncio.get_running_loop().time() + PNL_WAIT_SEC
        while asyncio.get_running_loop().time() < deadline:
            subscribed = ib.pnl(account, "")
            candidate = subscribed[0] if subscribed else pnl_subscription
            if candidate and any(
                _safe_pnl_float(getattr(candidate, field, None)) is not None
                for field in ("dailyPnL", "unrealizedPnL", "realizedPnL")
            ):
                pnl = candidate
                break
            await asyncio.sleep(0.2)
        if pnl is None:
            return ({
                "ok": False,
                "connected": True,
                "status": "live_pnl_unavailable",
                "message": "The fresh IB PnL subscription returned no values within five seconds.",
                "source": "unavailable",
                "account": account,
                "pnl": None,
                "observed_at": now_iso(),
            }, 503)
        observed_at = now_iso()
        return ({
            "ok": True,
            "connected": True,
            "status": "live",
            "source": "ibkr_live_session",
            "account": account,
            "pnl": {
                "dailyPnL": _safe_pnl_float(pnl.dailyPnL),
                # IB's PnL subscription does not provide a percentage. Never
                # infer one from a cached account-summary value.
                "dailyPnLPercent": None,
                "dailyPnLPercentSource": None,
                "unrealizedPnL": _safe_pnl_float(pnl.unrealizedPnL),
                "realizedPnL": _safe_pnl_float(pnl.realizedPnL),
            },
            "socket_verified_at": gateway_time.isoformat() if hasattr(gateway_time, "isoformat") else str(gateway_time),
            "observed_at": observed_at,
            "fetched_at": observed_at,
        }, 200)
    finally:
        if subscription_started:
            try:
                ib.cancelPnL(account, "")
            except Exception:
                pass


async def _singleflight_account_pnl(account: str, gateway_time: Any) -> tuple[dict[str, Any], int]:
    async with _pnl_singleflight_lock:
        task = _pnl_inflight.get(account)
        if task is None or task.done():
            task = asyncio.create_task(_request_fresh_account_pnl(account, gateway_time))
            _pnl_inflight[account] = task
    try:
        # One disconnected HTTP waiter must not cancel the shared broker read.
        return await asyncio.shield(task)
    finally:
        async with _pnl_singleflight_lock:
            if _pnl_inflight.get(account) is task and task.done():
                _pnl_inflight.pop(account, None)


@app.get("/portfolio/pnl")
async def portfolio_pnl(account: Optional[str] = Query(None)) -> JSONResponse:
    """Share one fresh account-scoped PnL subscription across concurrent callers."""
    health = await ensure_connected()
    if not health.get("ok"):
        return JSONResponse(
            {
                "ok": False,
                "connected": False,
                "status": health.get("status", "gateway_unavailable"),
                "message": health.get("message") or "IB Gateway/TWS is not connected.",
                "source": "unavailable",
                "pnl": None,
                "observed_at": now_iso(),
            },
            status_code=503,
        )

    acct: Optional[str] = None
    try:
        socket_verification = await verify_primary_socket()
        gateway_time = socket_verification["gatewayTime"]
        accounts = [str(value) for value in ib.managedAccounts() if value]
        if not accounts:
            raise RuntimeError("The verified IB session returned no managed accounts.")
        acct = str(account) if account else accounts[0]
        if acct not in accounts:
            raise RuntimeError(f"Account {acct} is not managed by the verified IB session.")
        payload, status_code = await _singleflight_account_pnl(acct, gateway_time)
        return JSONResponse(payload, status_code=status_code)
    except asyncio.TimeoutError:
        return JSONResponse(
            {
                "ok": False,
                "connected": False,
                "status": "live_pnl_timeout",
                "message": "The verified IB PnL request timed out.",
                "source": "unavailable",
                "account": acct,
                "pnl": None,
                "observed_at": now_iso(),
            },
            status_code=503,
        )
    except Exception as exc:
        return JSONResponse(
            {
                "ok": False,
                "connected": False,
                "status": "live_pnl_unverified",
                "message": str(exc),
                "source": "unavailable",
                "account": acct,
                "pnl": None,
                "observed_at": now_iso(),
            },
            status_code=503,
        )
