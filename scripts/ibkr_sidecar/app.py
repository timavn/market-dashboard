import asyncio
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
from pathlib import Path
from typing import Any, Dict, List, Optional, Set
from zoneinfo import ZoneInfo

from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse, StreamingResponse
from ib_insync import Contract, ExecutionFilter, IB, util
from pydantic import BaseModel, Field

from stream_manager import PERSISTENT_CONNECT, StreamManager, ticker_to_raw_quote

APP_DIR = Path(__file__).resolve().parent
WORKSPACE_ROOT = APP_DIR.parent.parent.resolve()
LEGACY_SEED_PATH = APP_DIR / "event_contracts.json"
SEED_PATH = Path(
    os.environ.get(
        "IBKR_EVENT_CATALOG_PATH",
        os.environ.get("IBKR_EVENT_CONTRACTS_PATH", APP_DIR / "event_contract_catalog.json"),
    )
)

IB_HOST = os.environ.get("IB_GATEWAY_HOST", "127.0.0.1")
IB_PORT = int(os.environ.get("IB_GATEWAY_PORT", "4002"))
IB_CLIENT_ID = int(os.environ.get("IB_GATEWAY_CLIENT_ID", "17"))
FUNDING_CLIENT_ID = int(
    os.environ.get("IBKR_FUNDING_CLIENT_ID", str(IB_CLIENT_ID + 100))
)
REFERENCE_MARKS_CLIENT_ID = int(
    os.environ.get("IBKR_REFERENCE_MARKS_CLIENT_ID", str(IB_CLIENT_ID + 101))
)
CONNECT_TIMEOUT = float(os.environ.get("IB_GATEWAY_CONNECT_TIMEOUT_SEC", "2.5"))
STATUS_TIMEOUT = float(os.environ.get("IBKR_STATUS_TIMEOUT_SEC", str(CONNECT_TIMEOUT + 2.0)))
MAX_QUOTE_BATCH = int(os.environ.get("IBKR_MAX_QUOTE_BATCH", "50"))
QUOTE_WAIT_SEC = float(os.environ.get("IBKR_QUOTE_WAIT_SEC", "1.0"))
PNL_WAIT_SEC = float(os.environ.get("IBKR_PNL_WAIT_SEC", "2.0"))
DISCOVER_DETAILS_TIMEOUT_SEC = float(os.environ.get("IBKR_DISCOVER_DETAILS_TIMEOUT_SEC", "2.5"))
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
POSITIONS_CONNECT_TIMEOUT_SEC = min(
    5.0,
    max(
        1.0,
        float(os.environ.get("IBKR_POSITIONS_CONNECT_TIMEOUT_SEC", "4.0")),
    ),
)
POSITIONS_CANCEL_GRACE_SEC = float(os.environ.get("IBKR_POSITIONS_CANCEL_GRACE_SEC", "0.5"))
POSITIONS_SNAPSHOT_CLIENT_ID = int(
    os.environ.get("IBKR_POSITIONS_SNAPSHOT_CLIENT_ID", str(IB_CLIENT_ID + 150))
)
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
    float(os.environ.get("IBKR_PRIMARY_SOCKET_HEARTBEAT_MAX_AGE_SEC", "1.0")),
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
reference_marks_ib = IB()
positions_ib = IB()
positions_snapshot_lock = asyncio.Lock()
positions_snapshot_task: Optional[asyncio.Task] = None


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
        pass
    raise asyncio.TimeoutError(
        f"IBKR positions request timed out after {timeout_sec:.1f}s"
    )


def serialize_live_position(account: str, contract: Any, quantity: float, avg_cost: float) -> Dict[str, Any]:
    return {
        "account": account,
        "conId": int(contract.conId) if getattr(contract, "conId", None) else None,
        "symbol": getattr(contract, "symbol", None) or None,
        "localSymbol": getattr(contract, "localSymbol", None) or None,
        "secType": getattr(contract, "secType", None) or None,
        "exchange": getattr(contract, "exchange", None) or None,
        "currency": getattr(contract, "currency", None) or None,
        "position": float(quantity),
        "avgCost": float(avg_cost),
    }


def create_positions_snapshot_session() -> IB:
    """Factory retained for tests that override the positions session."""
    return positions_ib


async def ensure_positions_connected(
    positions_session: Optional[IB] = None,
) -> Dict[str, Any]:
    """Connect the isolated positions snapshot session (no quote/stream load)."""
    session = positions_session or positions_ib
    try:
        if session.isConnected():
            return {"ok": True, "status": "connected"}
    except Exception as exc:
        try:
            session.disconnect()
        except Exception:
            pass
        return {
            "ok": False,
            "status": "error",
            "message": f"Dedicated IBKR positions client state is unavailable: {exc}",
        }

    try:
        await asyncio.wait_for(
            session.connectAsync(
                IB_HOST,
                IB_PORT,
                clientId=POSITIONS_SNAPSHOT_CLIENT_ID,
                timeout=min(CONNECT_TIMEOUT, POSITIONS_CONNECT_TIMEOUT_SEC),
                readonly=True,
            ),
            timeout=POSITIONS_CONNECT_TIMEOUT_SEC,
        )
        if session.isConnected():
            return {"ok": True, "status": "connected"}
        try:
            session.disconnect()
        except Exception:
            pass
        return {
            "ok": False,
            "status": "tws_offline",
            "message": "The dedicated IBKR positions socket did not connect.",
        }
    except (ConnectionRefusedError, ConnectionError, TimeoutError, asyncio.TimeoutError, OSError) as exc:
        try:
            session.disconnect()
        except Exception:
            pass
        return {
            "ok": False,
            "status": "tws_offline",
            "message": (
                f"Dedicated IBKR positions client could not reach "
                f"{IB_HOST}:{IB_PORT}: {exc}"
            ),
        }
    except Exception as exc:
        try:
            session.disconnect()
        except Exception:
            pass
        return {
            "ok": False,
            "status": "error",
            "message": f"Dedicated IBKR positions client failed to connect: {exc}",
        }


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
    session = create_positions_snapshot_session()
    health = await ensure_positions_connected(session)
    if not health.get("ok"):
        raise RuntimeError(
            health.get("message") or "Dedicated IBKR positions client is unavailable."
        )
    managed = [str(account) for account in session.managedAccounts() if account]
    if not managed:
        raise RuntimeError(
            "The positions snapshot session returned no managed accounts."
        )
    if set(managed) != set(accounts):
        raise RuntimeError(
            "The dedicated positions session does not cover the verified "
            "managed-account set."
        )
    fresh_positions = await req_positions_bounded(
        session,
        timeout_sec=timeout_sec,
    )
    if not session.isConnected():
        raise RuntimeError(
            "The dedicated positions session disconnected during reqPositions."
        )
    return [
        serialize_live_position(
            position.account,
            position.contract,
            float(position.position),
            float(position.avgCost),
        )
        for position in fresh_positions
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
primary_socket_verification_lock = asyncio.Lock()
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


class InstrumentIn(BaseModel):
    symbol: Optional[str] = None
    secType: Optional[str] = Field(default="STK")
    exchange: Optional[str] = Field(default="SMART")
    currency: Optional[str] = Field(default="USD")
    conId: Optional[int] = None


class QuotesRequest(BaseModel):
    instruments: List[InstrumentIn] = Field(default_factory=list)


class HistoricalRequest(BaseModel):
    instrument: InstrumentIn
    range: str = "1mo"
    interval: str = "1d"


class SubscribeRequest(BaseModel):
    instruments: List[InstrumentIn] = Field(default_factory=list)


class CpiDiscoveryContext(BaseModel):
    series: Optional[str] = None
    releaseKey: Optional[str] = None
    metric: Optional[str] = None
    forecastMonth: Optional[str] = None
    reportMonth: Optional[str] = None
    reportMonthId: Optional[str] = None
    releaseCode: Optional[str] = None
    releaseDate: Optional[str] = None
    eventTicker: Optional[str] = None
    targetStrikes: List[float] = Field(default_factory=list)


class DiscoveryRequest(BaseModel):
    cpi: Optional[CpiDiscoveryContext] = None
    # Contract metadata is supplied by the server from
    # PredictionMarketCatalogV2. It contains no quotes and is never a local
    # sidecar cache.
    catalogContracts: List[Dict[str, Any]] = Field(default_factory=list)


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
    # ib_insync Connection uses asyncio.get_event_loop(); align it with uvicorn's loop.
    loop = asyncio.get_running_loop()
    asyncio.set_event_loop(loop)
    util.patchAsyncio()
    stream_manager = StreamManager(
        ib,
        host=IB_HOST,
        port=IB_PORT,
        client_id=IB_CLIENT_ID,
        connect_timeout=CONNECT_TIMEOUT,
        instrument_to_contract=instrument_to_contract,
    )
    load_reference_close_cache()
    await stream_manager.start()
    reference_marks_startup_task = asyncio.create_task(
        reference_marks_background_scan()
    )
    yield
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


app = FastAPI(title="IBKR Sidecar", version="1.1.0", lifespan=lifespan)
last_snapshot: Dict[str, Any] = {
    "events": [],
    "providers": {
        "ibkr": {
            "status": "unknown",
            "last_success_at": None,
            "message": "Sidecar has not refreshed yet",
        }
    },
    "fetched_at": None,
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class FundingEvidenceError(RuntimeError):
    def __init__(self, message: str, code: str = "FUNDING_EVIDENCE_UNAVAILABLE"):
        super().__init__(message)
        self.code = code


def finite_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


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
        # required by the cash-debit calculation.
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
                "Live funding supports only open USD stock positions.",
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
    try:
        raw_positions = await asyncio.wait_for(
            funding_session.reqPositionsAsync(),
            timeout=POSITIONS_REQUEST_TIMEOUT_SEC,
        )
    except asyncio.TimeoutError as exc:
        raise FundingEvidenceError(
            "The fresh IBKR positions request timed out.",
            "POSITIONS_TIMEOUT",
        ) from exc
    except Exception as exc:
        raise FundingEvidenceError(
            f"Fresh IBKR positions are unavailable: {exc}",
            "POSITIONS_UNAVAILABLE",
        ) from exc
    return supported_stock_positions_from_snapshot(raw_positions, account)


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

        row: Dict[str, Any] = {"execId": execution_id}
        contract = getattr(fill, "contract", None)
        con_id = int(getattr(contract, "conId", 0) or 0)
        if con_id > 0:
            row["conId"] = con_id
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
    eligible = bool(
        current_session_complete
        and next_session_date is not None
    )
    latest_completed_session = (
        broker_date
        if current_session_complete
        else prior_completed_session
    )
    return {
        "eligible": eligible,
        "sessionDate": (
            broker_date.isoformat()
            if current_session_scheduled
            else None
        ),
        "accrualDays": (
            (next_session_date - broker_date).days
            if next_session_date is not None
            and current_session_scheduled
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
        "currentSessionComplete": current_session_complete,
        "priorCompletedSessionDate": (
            prior_completed_session.isoformat()
        ),
        "latestCompletedSessionDate": (
            latest_completed_session.isoformat()
        ),
        "verification": "ibkr_liquid_hours_and_broker_time",
    }


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
            raw_positions = await asyncio.wait_for(
                reference_session.reqPositionsAsync(),
                timeout=REFERENCE_MARKS_POSITIONS_TIMEOUT_SEC,
            )
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
                        "",
                        False,
                        False,
                    )
                )

            deadline = time.monotonic() + FUNDING_QUOTE_TIMEOUT_SEC
            while True:
                explicit_non_live = [
                    getattr(ticker, "marketDataType", None)
                    for ticker in tickers
                    if getattr(ticker, "marketDataType", None) not in {None, 0, 1}
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
                    getattr(ticker, "marketDataType", None) == 1
                    and positive_float(getattr(ticker, "bid", None)) is not None
                    and positive_float(getattr(ticker, "ask", None)) is not None
                    and fresh_snapshot_timestamp(getattr(ticker, "time", None)) is not None
                    for ticker in tickers
                ]
                if ready and all(ready):
                    break
                if time.monotonic() >= deadline:
                    for ticker in tickers:
                        market_data_type = getattr(ticker, "marketDataType", None)
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
        "observed_at": now_iso(),
    }
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
) -> str:
    payload = {
        "summary": summary,
        "positions": position_quantity_signature(positions),
        "executions": execution_signature,
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
        "observed_at": now_iso(),
    }
    if socket_verified_at:
        payload["socket_verified_at"] = socket_verified_at
    if timing is not None:
        payload["timing"] = timing
    return JSONResponse(payload, status_code=503)


def provider(status: str, message: Optional[str] = None, last_success_at: Optional[str] = None) -> Dict[str, Any]:
    return {
        "status": status,
        "last_success_at": last_success_at,
        "message": message,
    }


async def ensure_connected() -> Dict[str, Any]:
    if stream_manager:
        return await stream_manager.ensure_connected()
    if ib.isConnected():
        return {"ok": True, "status": "connected"}

    try:
        await asyncio.wait_for(
            ib.connectAsync(IB_HOST, IB_PORT, clientId=IB_CLIENT_ID, readonly=True),
            timeout=CONNECT_TIMEOUT,
        )
        if ib.isConnected():
            return {"ok": True, "status": "connected"}
        return {"ok": False, "status": "tws_offline", "message": "IB API socket did not connect"}
    except (ConnectionRefusedError, TimeoutError, asyncio.TimeoutError, OSError) as exc:
        return {
            "ok": False,
            "status": "tws_offline",
            "message": f"IB Gateway/TWS not reachable at {IB_HOST}:{IB_PORT}: {exc}",
        }
    except Exception as exc:
        return {"ok": False, "status": "error", "message": str(exc)}


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
    """Single-flight current-time probe shared by primary-client endpoints.

    ib_insync keys this request as one singleton. Overlapping calls can replace
    each other's futures, so all primary-client users share this short-lived
    heartbeat and a lock.
    """
    def primary_is_connected() -> bool:
        checker = getattr(ib, "isConnected", None)
        # Test doubles and alternate clients may omit this optional state
        # accessor; callers have already passed ensure_connected().
        return bool(checker()) if callable(checker) else True

    if not primary_is_connected():
        reset_primary_socket_heartbeat()
        raise ConnectionError("The primary IBKR socket is not connected.")

    def current_generation() -> Any:
        return (
            id(ib),
            getattr(stream_manager, "connection_generation", 0)
            if stream_manager
            else 0,
        )

    def cached_heartbeat() -> Optional[Dict[str, Any]]:
        connection_generation = current_generation()
        verified_monotonic = primary_socket_heartbeat.get(
            "verifiedMonotonic"
        )
        if (
            primary_socket_heartbeat.get("connectionGeneration")
            != connection_generation
            or not isinstance(verified_monotonic, (int, float))
            or time.monotonic() - verified_monotonic
            > PRIMARY_SOCKET_HEARTBEAT_MAX_AGE_SEC
        ):
            return None
        gateway_time = primary_socket_heartbeat.get("gatewayTime")
        verified_at = iso_timestamp(
            primary_socket_heartbeat.get("verifiedAt")
        )
        if not gateway_time or not verified_at:
            return None
        return {
            "gatewayTime": gateway_time,
            "socketVerifiedAt": verified_at,
            "connectionGeneration": connection_generation,
            "cacheState": "shared_heartbeat",
        }

    cached = cached_heartbeat()
    if cached:
        return cached

    async with primary_socket_verification_lock:
        if not primary_is_connected():
            reset_primary_socket_heartbeat()
            raise ConnectionError("The primary IBKR socket disconnected.")
        connection_generation = current_generation()
        cached = cached_heartbeat()
        if cached:
            return cached
        gateway_time = await asyncio.wait_for(
            ib.reqCurrentTimeAsync(),
            timeout=LIVE_SESSION_VERIFY_TIMEOUT_SEC,
        )
        socket_verified_at = iso_timestamp(gateway_time)
        if not socket_verified_at:
            reset_primary_socket_heartbeat()
            raise RuntimeError(
                "IBKR socket verification returned an invalid timestamp."
            )
        primary_socket_heartbeat.update(
            {
                "connectionGeneration": connection_generation,
                "gatewayTime": gateway_time,
                "verifiedAt": socket_verified_at,
                "verifiedMonotonic": time.monotonic(),
            }
        )
        return {
            "gatewayTime": gateway_time,
            "socketVerifiedAt": socket_verified_at,
            "connectionGeneration": connection_generation,
            "cacheState": "fresh_probe",
        }


def disconnect_funding_session(funding_session: IB) -> None:
    try:
        funding_session.disconnect()
    except Exception:
        pass


async def ensure_funding_connected(
    funding_session: Optional[IB] = None,
) -> Dict[str, Any]:
    """Connect the isolated read-only funding session without using the quote client."""
    session = funding_session or funding_ib
    try:
        if session.isConnected():
            return {"ok": True, "status": "connected"}
    except Exception as exc:
        disconnect_funding_session(session)
        return {
            "ok": False,
            "status": "error",
            "message": f"Dedicated IBKR funding client state is unavailable: {exc}",
        }

    try:
        await asyncio.wait_for(
            session.connectAsync(
                IB_HOST,
                IB_PORT,
                clientId=FUNDING_CLIENT_ID,
                timeout=CONNECT_TIMEOUT,
                readonly=True,
            ),
            timeout=CONNECT_TIMEOUT + 1.0,
        )
        if session.isConnected():
            return {"ok": True, "status": "connected"}
        disconnect_funding_session(session)
        return {
            "ok": False,
            "status": "tws_offline",
            "message": "The dedicated read-only IBKR funding socket did not connect.",
        }
    except (ConnectionRefusedError, ConnectionError, TimeoutError, asyncio.TimeoutError, OSError) as exc:
        disconnect_funding_session(session)
        return {
            "ok": False,
            "status": "tws_offline",
            "message": (
                f"Dedicated IBKR funding client could not reach "
                f"{IB_HOST}:{IB_PORT}: {exc}"
            ),
        }
    except Exception as exc:
        disconnect_funding_session(session)
        return {
            "ok": False,
            "status": "error",
            "message": f"Dedicated IBKR funding client failed to connect: {exc}",
        }


def disconnect_reference_marks_session(reference_session: IB) -> None:
    try:
        reference_session.disconnect()
    except Exception:
        pass


async def ensure_reference_marks_connected(
    reference_session: Optional[IB] = None,
) -> Dict[str, Any]:
    """Connect the isolated read-only historical-marks session."""
    session = reference_session or reference_marks_ib
    try:
        if session.isConnected():
            return {"ok": True, "status": "connected"}
    except Exception as exc:
        disconnect_reference_marks_session(session)
        return {
            "ok": False,
            "status": "error",
            "message": f"Dedicated IBKR reference-marks client state is unavailable: {exc}",
        }

    try:
        await asyncio.wait_for(
            session.connectAsync(
                IB_HOST,
                IB_PORT,
                clientId=REFERENCE_MARKS_CLIENT_ID,
                timeout=CONNECT_TIMEOUT,
                readonly=True,
            ),
            timeout=CONNECT_TIMEOUT + 1.0,
        )
        if session.isConnected():
            return {"ok": True, "status": "connected"}
        disconnect_reference_marks_session(session)
        return {
            "ok": False,
            "status": "tws_offline",
            "message": "The dedicated read-only IBKR reference-marks socket did not connect.",
        }
    except (ConnectionRefusedError, ConnectionError, TimeoutError, asyncio.TimeoutError, OSError) as exc:
        disconnect_reference_marks_session(session)
        return {
            "ok": False,
            "status": "tws_offline",
            "message": (
                f"Dedicated IBKR reference-marks client could not reach "
                f"{IB_HOST}:{IB_PORT}: {exc}"
            ),
        }
    except Exception as exc:
        disconnect_reference_marks_session(session)
        return {
            "ok": False,
            "status": "error",
            "message": f"Dedicated IBKR reference-marks client failed to connect: {exc}",
        }


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
        "observed_at": now_iso(),
    }
    if socket_verified_at:
        payload["socket_verified_at"] = socket_verified_at
    return JSONResponse(payload, status_code=503)


def load_seed_contracts() -> List[Dict[str, Any]]:
    if not SEED_PATH.exists():
        return []
    with SEED_PATH.open("r", encoding="utf-8") as f:
        data = json.load(f)
    return data.get("contracts", [])


def save_seed_contracts(
    contracts: List[Dict[str, Any]],
    retired_contracts: Optional[List[Dict[str, Any]]] = None,
) -> None:
    payload: Dict[str, Any] = {"schemaVersion": 2, "contracts": contracts}
    previously_retired: List[Dict[str, Any]] = []
    if SEED_PATH.exists():
        with SEED_PATH.open("r", encoding="utf-8") as f:
            existing = json.load(f)
        if "example_contract" in existing:
            payload["example_contract"] = existing["example_contract"]
        previously_retired = existing.get("retired_contracts", []) or []
    retired = [*previously_retired, *(retired_contracts or [])]
    if retired:
        by_key = {}
        for seed in retired:
            key = (
                seed.get("releaseKey"),
                seed.get("conId") or seed.get("localSymbol"),
                seed.get("retired_reason"),
            )
            by_key[key] = seed
        payload["retired_contracts"] = list(by_key.values())[-500:]
    SEED_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp_path: Optional[Path] = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=str(SEED_PATH.parent),
            prefix=f".{SEED_PATH.name}.",
            suffix=".tmp",
            delete=False,
        ) as f:
            temp_path = Path(f.name)
            json.dump(payload, f, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_path, SEED_PATH)
    finally:
        if temp_path and temp_path.exists():
            temp_path.unlink()


def contract_to_seed(contract: Contract, venue: str, release_key: Optional[str] = None) -> Dict[str, Any]:
    trading_class = getattr(contract, "tradingClass", "") or ""
    seed = {
        "description": contract.localSymbol or contract.symbol,
        "conId": int(contract.conId) if contract.conId else None,
        "venue": venue,
        "category": "Other Macro",
        "underlying": contract.symbol,
        "event_title": contract.symbol,
        "contract_title": contract.localSymbol or contract.symbol,
        "question": contract.localSymbol or contract.symbol,
        "secType": contract.secType,
        "exchange": contract.exchange,
        "currency": contract.currency or "USD",
        "localSymbol": contract.localSymbol or "",
        "tradingClass": trading_class,
        "lastTradeDateOrContractMonth": contract.lastTradeDateOrContractMonth or "",
        "strike": float(contract.strike) if contract.strike else None,
        "right": contract.right or "",
        "multiplier": contract.multiplier or "",
        "max_payout_per_contract": 1,
        "min_tick": 0.01,
        "quote_wait_sec": 1.5,
        "releaseKey": release_key,
        "catalog_source": "ibkr_contract_details",
        "catalog_validated_at": now_iso(),
    }
    native_side = infer_seed_contract_side(seed, contract)
    seed["quote_side"] = native_side
    seed["native_side"] = native_side
    seed["tradable_in_ibkr"] = native_side in {"YES", "NO"}
    return seed


def merge_seed_lists(existing: List[Dict[str, Any]], incoming: List[Dict[str, Any]]) -> tuple[List[Dict[str, Any]], int]:
    """Upsert authoritative catalog rows by release and native IB conId."""
    merged = list(existing)
    index = {
        (seed.get("releaseKey"), int(seed["conId"])): position
        for position, seed in enumerate(merged)
        if seed.get("releaseKey") and seed.get("conId")
    }
    added = 0
    for seed in incoming:
        cid = seed.get("conId")
        release_key = seed.get("releaseKey")
        if not cid or not release_key:
            continue
        key = (release_key, int(cid))
        if key in index:
            merged[index[key]] = {**merged[index[key]], **seed}
            continue
        merged.append(seed)
        index[key] = len(merged) - 1
        added += 1
    return merged, added


def is_portfolio_seed(seed: Dict[str, Any]) -> bool:
    return "portfolio_seed" in (seed.get("data_quality_flags") or [])


def parse_contract_deadline(seed: Dict[str, Any]) -> Optional[datetime]:
    for value in (
        seed.get("close_time"),
        seed.get("expiration_time"),
        seed.get("lastTradeDateOrContractMonth"),
    ):
        text = str(value or "").strip()
        if not text:
            continue
        compact = re.match(r"^(\d{4})(\d{2})(\d{2})", text)
        if compact:
            try:
                return datetime(
                    int(compact.group(1)),
                    int(compact.group(2)),
                    int(compact.group(3)),
                    23,
                    59,
                    59,
                    tzinfo=timezone.utc,
                )
            except ValueError:
                continue
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def seed_is_expired(seed: Dict[str, Any], now: Optional[datetime] = None) -> bool:
    deadline = parse_contract_deadline(seed)
    return bool(deadline and deadline < (now or datetime.now(timezone.utc)))


def request_release_key(request: Optional[DiscoveryRequest]) -> Optional[str]:
    if not request or not request.cpi:
        return None
    explicit = str(request.cpi.releaseKey or "").strip()
    if explicit:
        return explicit
    value = request.cpi.reportMonthId or request.cpi.reportMonth or request.cpi.forecastMonth
    text = str(value or "").strip().upper()
    iso = re.match(r"^(20\d{2})-(0[1-9]|1[0-2])$", text)
    if iso:
        return f"KXCPIYOY#{iso.group(1)}-{iso.group(2)}"
    months = {
        "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
        "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
    }
    match = re.search(
        r"\b(JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUN(?:E)?|JUL(?:Y)?|AUG(?:UST)?|SEP(?:TEMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)\b\D{0,6}(\d{2}|20\d{2})\b",
        text,
    )
    if not match:
        return None
    year = int(match.group(2))
    if year < 100:
        year += 2000
    month = months.get(match.group(1)[:3])
    return f"KXCPIYOY#{year}-{month:02d}" if month else None


def request_catalog_contracts(request: Optional[DiscoveryRequest]) -> List[Dict[str, Any]]:
    if not request:
        return []
    return [dict(contract) for contract in (request.catalogContracts or [])]


def seed_is_authoritative(seed: Dict[str, Any]) -> bool:
    return bool(
        seed.get("catalog_source") == "ibkr_contract_details"
        and seed.get("conId")
        and str(seed.get("exchange") or "").strip()
        and str(seed.get("tradingClass") or "").strip()
        and str(
            seed.get("expiration_time")
            or seed.get("lastTradeDateOrContractMonth")
            or ""
        ).strip()
    )


def quote_eligible_seeds(
    seeds: List[Dict[str, Any]],
    request: Optional[DiscoveryRequest] = None,
    now: Optional[datetime] = None,
) -> List[Dict[str, Any]]:
    release_key = request_release_key(request)
    if not release_key:
        return []
    return [
        seed for seed in seeds
        if seed_is_authoritative(seed)
        and seed.get("releaseKey") == release_key
        and not seed_is_expired(seed, now)
        and infer_seed_contract_side(seed, seeded_contract(seed)) in {"YES", "NO"}
    ]


def partition_catalog_for_release(
    seeds: List[Dict[str, Any]],
    request: Optional[DiscoveryRequest],
    now: Optional[datetime] = None,
) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    release_key = request_release_key(request)
    active: List[Dict[str, Any]] = []
    retired: List[Dict[str, Any]] = []
    retired_at = (now or datetime.now(timezone.utc)).isoformat().replace("+00:00", "Z")
    for seed in seeds:
        reason = None
        if not seed_is_authoritative(seed):
            reason = "non_authoritative_seed"
        elif seed.get("releaseKey") != release_key:
            reason = "wrong_release"
        elif seed_is_expired(seed, now):
            reason = "expired_contract"
        elif infer_seed_contract_side(seed, seeded_contract(seed)) not in {"YES", "NO"}:
            reason = "unknown_contract_side"
        if reason:
            retired.append({
                **seed,
                "catalog_state": "retired",
                "retired_reason": reason,
                "retired_at": retired_at,
            })
        else:
            active.append(seed)
    return active, retired


def elapsed_ms(start: float) -> int:
    return int(round((time.monotonic() - start) * 1000))


def cpi_target_ticks(request: Optional[DiscoveryRequest]) -> set:
    targets = request.cpi.targetStrikes if request and request.cpi else []
    ticks = set()
    for value in targets or []:
        try:
            ticks.add(int(round(float(value) * 10)))
        except (TypeError, ValueError):
            continue
    return ticks


def seed_text(seed: Dict[str, Any]) -> str:
    return " ".join(
        str(seed.get(key) or "")
        for key in (
            "description",
            "underlying",
            "event_title",
            "contract_title",
            "question",
            "localSymbol",
            "tradingClass",
            "symbol",
        )
    )


def is_cpi_seed(seed: Dict[str, Any]) -> bool:
    text = re.sub(r"[^A-Z0-9.]+", " ", seed_text(seed).upper())
    return bool(
        re.search(r"\bKXCPI[A-Z0-9]*\b", text)
        or re.search(r"\bCPI(?:Y|YOY|M|MOM|MM)?\b", text)
        or "CONSUMER PRICE INDEX" in text
        or "INFLATION" in text
    )


def seed_cpi_tick(seed: Dict[str, Any]) -> Optional[int]:
    try:
        if seed.get("strike") is not None:
            return int(round(float(seed.get("strike")) * 10))
    except (TypeError, ValueError):
        pass
    text = seed_text(seed)
    match = re.search(r"\babove\s+(-?\d+(?:\.\d+)?)\s*%?", text, flags=re.IGNORECASE)
    if not match:
        match = re.search(r"(?:^|[-_\s])T(-?\d+(?:\.\d+)?)(?:[-_\s]?(?:YES|NO)\b|$)", text, flags=re.IGNORECASE)
    if not match:
        return None
    try:
        return int(round(float(match.group(1)) * 10))
    except ValueError:
        return None


def cpi_discovery_report(
    seeds: List[Dict[str, Any]],
    request: Optional[DiscoveryRequest],
    discovered_count: Optional[int] = None,
    contracts_added: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    ticks = cpi_target_ticks(request)
    if not ticks:
        return None
    current_seeds = quote_eligible_seeds(seeds, request)
    found_ticks = {
        tick
        for seed in current_seeds
        for tick in [seed_cpi_tick(seed)]
        if tick in ticks
    }
    return {
        "releaseKey": request_release_key(request),
        "metric": request.cpi.metric if request and request.cpi else None,
        "forecastMonth": request.cpi.forecastMonth if request and request.cpi else None,
        "reportMonth": request.cpi.reportMonth if request and request.cpi else None,
        "releaseCode": request.cpi.releaseCode if request and request.cpi else None,
        "targetStrikes": [tick / 10 for tick in sorted(ticks)],
        "foundStrikes": [tick / 10 for tick in sorted(found_ticks)],
        "missingStrikes": [tick / 10 for tick in sorted(ticks - found_ticks)],
        "contractsTotal": len(current_seeds),
        "contracts_total": len(current_seeds),
        **({"discovered": discovered_count} if discovered_count is not None else {}),
        **({"contractsAdded": contracts_added, "contracts_added": contracts_added} if contracts_added is not None else {}),
    }


def cpi_catalog_qualification_report(
    seeds: List[Dict[str, Any]],
    discovered: List[Dict[str, Any]],
    request: Optional[DiscoveryRequest],
) -> Dict[str, Any]:
    target_ticks = cpi_target_ticks(request)
    qualified = quote_eligible_seeds(seeds, request)
    freshly_qualified = quote_eligible_seeds(discovered, request)
    found_ticks = {
        tick
        for seed in qualified
        for tick in [seed_cpi_tick(seed)]
        if tick in target_ticks
    }
    fresh_found_ticks = {
        tick
        for seed in freshly_qualified
        for tick in [seed_cpi_tick(seed)]
        if tick in target_ticks
    }
    missing_ticks = target_ticks - found_ticks
    fresh_missing_ticks = target_ticks - fresh_found_ticks
    target_coverage_complete = bool(target_ticks) and not missing_ticks
    fresh_target_coverage_complete = bool(target_ticks) and not fresh_missing_ticks
    complete = bool(qualified) and target_coverage_complete and fresh_target_coverage_complete
    return {
        "releaseKey": request_release_key(request),
        "authoritative": all(seed_is_authoritative(seed) for seed in qualified),
        "qualifiedContracts": len(qualified),
        "freshDiscoveredContracts": len(freshly_qualified),
        "targetCoverageComplete": target_coverage_complete,
        "freshTargetCoverageComplete": fresh_target_coverage_complete,
        "missingStrikes": [tick / 10 for tick in sorted(missing_ticks)],
        "freshMissingStrikes": [tick / 10 for tick in sorted(fresh_missing_ticks)],
        "complete": complete,
    }


def cpi_release_tokens(request: Optional[DiscoveryRequest]) -> set:
    if not request or not request.cpi:
        return set()
    raw_values = [
        request.cpi.releaseKey,
        request.cpi.reportMonthId,
        request.cpi.eventTicker,
        request.cpi.releaseCode,
        request.cpi.reportMonth,
        request.cpi.forecastMonth,
    ]
    tokens = set()
    month_map = {
        "JANUARY": "JAN",
        "FEBRUARY": "FEB",
        "MARCH": "MAR",
        "APRIL": "APR",
        "MAY": "MAY",
        "JUNE": "JUN",
        "JULY": "JUL",
        "AUGUST": "AUG",
        "SEPTEMBER": "SEP",
        "OCTOBER": "OCT",
        "NOVEMBER": "NOV",
        "DECEMBER": "DEC",
    }
    for value in raw_values:
        text = str(value or "").upper()
        compact = re.sub(r"[^A-Z0-9]+", "", text)
        if compact:
            tokens.add(compact)
        match = re.search(
            r"\b(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b\D*(\d{2,4})",
            text,
        )
        if match:
            month = month_map.get(match.group(1), match.group(1)[:3])
            year = match.group(2)[-2:]
            tokens.add(f"{month}{year}")
            tokens.add(f"{year}{month}")
    return tokens


def seed_matches_release(seed: Dict[str, Any], release_tokens: set) -> bool:
    if not release_tokens:
        return False
    compact = re.sub(r"[^A-Z0-9]+", "", seed_text(seed).upper())
    return any(token in compact for token in release_tokens)


def forecastx_contract() -> Contract:
    return Contract(secType="OPT", exchange="FORECASTX", currency="USD")


def cpi_symbol_templates(request: Optional[DiscoveryRequest]) -> List[Contract]:
    if not request or not request.cpi or not cpi_target_ticks(request):
        return []
    # Query only the native IB venue/security type. Symbol, contract ID, local
    # symbol, expiry, strike, side, and trading class must all come back from
    # reqContractDetails; Kalshi tickers are never manufactured as IB symbols.
    return [forecastx_contract()]


async def discover_event_contract_seeds(
    max_per_venue: int = int(os.environ.get("IBKR_DISCOVER_MAX_PER_VENUE", "25")),
    request: Optional[DiscoveryRequest] = None,
) -> List[Dict[str, Any]]:
    """Search IB for ForecastEx and CME event (EC*) contracts when Gateway is connected."""
    seeds: List[Dict[str, Any]] = []
    seen: set = set()
    target_ticks = cpi_target_ticks(request)
    release_tokens = cpi_release_tokens(request)
    release_key = request_release_key(request)

    if target_ticks:
        searches = [(template, "ForecastEx") for template in cpi_symbol_templates(request)]
    elif os.environ.get("IBKR_ALLOW_BROAD_EVENT_DISCOVERY") == "true":
        searches = [
            (Contract(secType="OPT", exchange="FORECASTX"), "ForecastEx"),
            (Contract(secType="FOP", exchange="CME"), "CME"),
            (Contract(secType="FUT", exchange="CME", tradingClass="EC"), "CME"),
        ]
    else:
        searches = []

    for template, venue in searches:
        try:
            details = await asyncio.wait_for(
                ib.reqContractDetailsAsync(template),
                timeout=DISCOVER_DETAILS_TIMEOUT_SEC,
            )
        except (TimeoutError, asyncio.TimeoutError):
            continue
        except Exception:
            continue
        candidates: List[Dict[str, Any]] = []
        local_seen: set = set()
        target_ticks = target_ticks or set()
        def seed_priority(seed: Dict[str, Any]) -> tuple:
            tick = seed_cpi_tick(seed)
            target_match = tick in target_ticks if tick is not None else False
            release_match = seed_matches_release(seed, release_tokens)
            kxcpi_match = "KXCPI" in seed_text(seed).upper()
            if tick is not None and target_ticks:
                distance = min(abs(tick - target) for target in target_ticks)
            else:
                distance = 999
            return (
                0 if target_match and release_match else 1 if target_match else 2 if is_cpi_seed(seed) else 3,
                0 if release_match else 1,
                0 if kxcpi_match else 1,
                distance,
                seed.get("localSymbol") or seed.get("description") or "",
            )

        for detail in details:
            contract = detail.contract
            if venue == "CME":
                tc = getattr(contract, "tradingClass", "") or ""
                if not tc.startswith("EC"):
                    continue
            key = contract.conId or f"{contract.localSymbol}:{contract.exchange}"
            if key in local_seen:
                continue
            local_seen.add(key)
            seed = contract_to_seed(contract, venue, release_key=release_key)
            if seed.get("conId"):
                candidates.append(seed)
        candidates.sort(key=seed_priority)

        count = 0
        for seed in candidates:
            key = seed.get("conId") or f"{seed.get('localSymbol')}:{seed.get('exchange')}"
            if key in seen:
                continue
            seen.add(key)
            tick = seed_cpi_tick(seed)
            target_match = tick in target_ticks if tick is not None else False
            if target_ticks:
                if (
                    target_match
                    and is_cpi_seed(seed)
                    and seed_matches_release(seed, release_tokens)
                    and not seed_is_expired(seed)
                ):
                    seeds.append(seed)
                continue
            if count < max_per_venue:
                seeds.append(seed)
            count += 1
            if count >= max_per_venue:
                break

    return seeds


def seeded_contract(seed: Dict[str, Any]) -> Contract:
    contract = Contract()
    if seed.get("conId"):
        contract.conId = int(seed["conId"])
    contract.symbol = seed.get("symbol", "")
    contract.secType = seed.get("secType", "")
    contract.exchange = seed.get("exchange", "")
    contract.currency = seed.get("currency", "USD")
    contract.lastTradeDateOrContractMonth = seed.get("lastTradeDateOrContractMonth", "")
    contract.strike = float(seed["strike"]) if seed.get("strike") is not None else 0.0
    contract.right = seed.get("right", "")
    contract.multiplier = str(seed.get("multiplier", "")) if seed.get("multiplier") else ""
    contract.localSymbol = seed.get("localSymbol", "")
    contract.tradingClass = seed.get("tradingClass", "")
    return contract


def infer_seed_contract_side(seed: Dict[str, Any], contract: Contract) -> str:
    explicit_side = str(seed.get("quote_side") or seed.get("native_side") or "").upper()
    if explicit_side in {"YES", "NO"}:
        return explicit_side
    text = seed_text(
        {
            **seed,
            "localSymbol": seed.get("localSymbol") or getattr(contract, "localSymbol", ""),
            "symbol": seed.get("symbol") or getattr(contract, "symbol", ""),
        }
    )
    match = re.search(r"(?:^|[-_\s])(YES|NO)(?:$|[-_\s])", text, flags=re.IGNORECASE)
    if match:
        return match.group(1).upper()
    # `right` is returned by IB ContractDetails; unlike a manufactured local
    # symbol it is authoritative contract metadata.
    right = str(seed.get("right") or getattr(contract, "right", "") or "").upper()
    if right in {"YES", "Y", "C", "CALL"}:
        return "YES"
    if right in {"NO", "N", "P", "PUT"}:
        return "NO"
    return "UNKNOWN"


def normalize_seeded_event(seed: Dict[str, Any], ticker: Any) -> Dict[str, Any]:
    contract = ticker.contract
    bid = ticker.bid if ticker.bid is not None and ticker.bid >= 0 else None
    ask = ticker.ask if ticker.ask is not None and ticker.ask >= 0 else None
    last = ticker.last if ticker.last is not None and ticker.last >= 0 else None

    # IB event contracts may display as 0-100 or 0-1; normalize at the sidecar boundary.
    def norm(value: Optional[float]) -> Optional[float]:
        if value is None:
            return None
        return value / 100 if value > 1 else value

    bid = norm(bid)
    ask = norm(ask)
    last = norm(last)
    quote_side = infer_seed_contract_side(seed, contract)
    if quote_side == "NO":
        yes_bid = None
        yes_ask = None
        no_bid = bid
        no_ask = ask
        side_last = last
    elif quote_side == "YES":
        yes_bid = bid
        yes_ask = ask
        no_bid = None
        no_ask = None
        side_last = last
    else:
        yes_bid = None
        yes_ask = None
        no_bid = None
        no_ask = None
        side_last = None
    flags = [
        flag
        for flag in (seed.get("data_quality_flags", []) or [])
        if flag != "portfolio_seed"
    ]
    if is_portfolio_seed(seed):
        flags.append("portfolio_discovered")
    if bid is None and ask is None:
        flags.append("no_live_quote")
    if quote_side == "UNKNOWN":
        flags.extend(["unknown_contract_side", "no_live_quote"])
    expired = seed_is_expired(seed)
    if expired:
        flags.append("expired_contract")

    raw_id = str(seed.get("conId") or getattr(contract, "conId", "") or seed.get("id", "unknown"))
    venue = seed.get("venue") or ("CME" if str(seed.get("tradingClass", "")).startswith("EC") else "IBKR")
    updated = now_iso()

    return {
        "id": f"{venue.lower()}:{raw_id}",
        "venue": venue,
        "source_api": "IBKR_TWS_API",
        "tradable_in_ibkr": quote_side in {"YES", "NO"},
        "conId": int(seed.get("conId") or getattr(contract, "conId", 0)) or None,
        "secType": seed.get("secType") or getattr(contract, "secType", None),
        "exchange": seed.get("exchange") or getattr(contract, "exchange", None),
        "tradingClass": seed.get("tradingClass") or getattr(contract, "tradingClass", None),
        "lastTradeDateOrContractMonth": (
            seed.get("lastTradeDateOrContractMonth")
            or getattr(contract, "lastTradeDateOrContractMonth", None)
        ),
        "right": seed.get("right") or getattr(contract, "right", None),
        "category": seed.get("category", "Other Macro"),
        "underlying": seed.get("underlying") or contract.symbol,
        "event_title": seed.get("event_title") or seed.get("description") or contract.symbol,
        "contract_title": seed.get("contract_title") or contract.localSymbol or raw_id,
        "question": seed.get("question") or seed.get("description") or contract.localSymbol or raw_id,
        "settlement_rules_summary": seed.get("settlement_rules_summary", ""),
        "settlement_source": seed.get("settlement_source"),
        "event_date": seed.get("event_date"),
        "close_time": seed.get("close_time"),
        "expiration_time": seed.get("expiration_time") or contract.lastTradeDateOrContractMonth or None,
        "status": "closed" if expired else "open",
        "yes_bid": yes_bid,
        "yes_ask": yes_ask,
        "yes_mid": (yes_bid + yes_ask) / 2 if yes_bid is not None and yes_ask is not None else None,
        "no_bid": no_bid,
        "no_ask": no_ask,
        "no_mid": (no_bid + no_ask) / 2 if no_bid is not None and no_ask is not None else None,
        "last_price": side_last,
        "implied_probability_mid": (yes_bid + yes_ask) / 2 if yes_bid is not None and yes_ask is not None else None,
        "spread": ask - bid if quote_side in {"YES", "NO"} and bid is not None and ask is not None else None,
        "quote_side": quote_side,
        "releaseKey": seed.get("releaseKey"),
        "catalog_source": seed.get("catalog_source"),
        "volume": ticker.volume if ticker.volume is not None and ticker.volume >= 0 else None,
        "open_interest": None,
        "liquidity": None,
        "min_tick": seed.get("min_tick"),
        "fee_per_contract": seed.get("fee_per_contract"),
        "max_payout_per_contract": seed.get("max_payout_per_contract", 1),
        "url": seed.get("url"),
        "api_raw_symbol": contract.localSymbol or seed.get("localSymbol"),
        "api_raw_id": raw_id,
        "comparison_group_id": None,
        "data_quality_flags": list(dict.fromkeys(flags)),
        "fee_adjusted_edge": None,
        "updated_at": updated,
    }


@app.get("/status")
async def status() -> JSONResponse:
    stream = stream_manager.status_payload() if stream_manager else {}
    try:
        health = await asyncio.wait_for(ensure_connected(), timeout=STATUS_TIMEOUT)
    except asyncio.TimeoutError:
        return JSONResponse(
            {
                "status": "gateway_timeout",
                "connected": False,
                "host": IB_HOST,
                "port": IB_PORT,
                "client_id": stream_manager.client_id if stream_manager else IB_CLIENT_ID,
                "message": f"Timed out while checking IB Gateway/TWS at {IB_HOST}:{IB_PORT}",
                "account_discovery_ok": False,
                "stream": stream,
            },
            status_code=200,
        )

    if not health["ok"]:
        return JSONResponse(
            {
                "status": health["status"],
                "connected": False,
                "host": IB_HOST,
                "port": IB_PORT,
                "client_id": stream_manager.client_id if stream_manager else IB_CLIENT_ID,
                "message": health.get("message"),
                "account_discovery_ok": False,
                "stream": stream,
            },
            status_code=200,
        )

    try:
        accounts = ib.managedAccounts()
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
            "catalog_authority": "PredictionMarketCatalogV2",
            "local_catalog_operational": False,
            "legacy_local_catalog_path": str(SEED_PATH),
            "legacy_seed_quarantined": LEGACY_SEED_PATH.exists() and LEGACY_SEED_PATH != SEED_PATH,
        }
    )


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
            {"ok": False, "status": health["status"], "connected": False, "accounts": [], "message": health.get("message"), "time": now_iso()},
            status_code=503,
        )
    try:
        accounts = ib.managedAccounts()
    except Exception:
        accounts = []
    if not accounts:
        return JSONResponse(
            {"ok": False, "status": "accounts_unavailable", "connected": True, "accounts": [], "time": now_iso()},
            status_code=503,
        )
    return JSONResponse({"ok": True, "status": "ready", "connected": True, "accounts": accounts, "time": now_iso()})


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
        return JSONResponse(
            {
                "ok": False,
                "status": health.get("status", "gateway_unavailable"),
                "message": health.get("message") or "IB Gateway/TWS is not connected.",
                "source": "unavailable",
                "positions": [],
                "observed_at": now_iso(),
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
            return JSONResponse(
                {
                    "ok": False,
                    "status": "positions_request_timeout",
                    "message": (
                        "The fresh IBKR positions request timed out after "
                        f"{LIVE_POSITIONS_REQUEST_TIMEOUT_SEC:.1f}s."
                    ),
                    "source": "unavailable",
                    "position_source": "unavailable",
                    "from_cache": False,
                    "positions": [],
                    "observed_at": now_iso(),
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
        return JSONResponse(
            {
                "ok": False,
                "status": "socket_verification_timeout",
                "message": f"IB socket verification timed out after {LIVE_SESSION_VERIFY_TIMEOUT_SEC:.1f}s.",
                "source": "unavailable",
                "positions": [],
                "observed_at": now_iso(),
            },
            status_code=503,
        )
    except Exception as exc:
        return JSONResponse(
            {
                "ok": False,
                "status": "live_session_unverified",
                "message": str(exc),
                "source": "unavailable",
                "positions": [],
                "observed_at": now_iso(),
            },
            status_code=503,
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
            )

        try:
            require_funding_socket_connected(funding_session)
            phase_started = time.monotonic()
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
            first_positions = await request_fresh_supported_stock_positions(
                funding_session,
                acct,
            )
            require_positions_in_base_currency(
                first_positions,
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
                    first_positions,
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
            second_positions = await request_fresh_supported_stock_positions(
                funding_session,
                acct,
            )
            require_positions_in_base_currency(
                second_positions,
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
            forecast = build_interest_forecast_calendar(
                market_calendar,
                broker_time=broker_time,
                prior_completed_session=prior_completed_session,
            )
            market_calendar_payload = {
                "verifiedNyDate": verified_ny_date.isoformat(),
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
            )

        try:
            phase_started = time.monotonic()
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


@app.get("/events")
async def events() -> Dict[str, Any]:
    return last_snapshot


@app.post("/refresh")
async def refresh(request: Optional[DiscoveryRequest] = None) -> JSONResponse:
    global last_snapshot
    request_start = time.monotonic()
    timings: Dict[str, Any] = {}

    phase_start = time.monotonic()
    health = await ensure_connected()
    timings["gateway_ms"] = elapsed_ms(phase_start)
    if not health["ok"]:
        last_snapshot = {
            "events": [],
            "providers": {"ibkr": provider(health["status"], health.get("message"))},
            "fetched_at": now_iso(),
            "timing": {**timings, "total_ms": elapsed_ms(request_start), "phase": "gateway"},
        }
        return JSONResponse(last_snapshot)

    if not request_release_key(request):
        last_snapshot = {
            "events": [],
            "providers": {
                "ibkr": provider(
                    "invalid_release_context",
                    "A server-owned CPI releaseKey is required before event-contract refresh.",
                )
            },
            "fetched_at": now_iso(),
            "contracts_added": 0,
            "contracts_total": 0,
            "portfolio_seed_count": 0,
            "timing": {**timings, "total_ms": elapsed_ms(request_start), "phase": "release"},
        }
        return JSONResponse(last_snapshot)

    phase_start = time.monotonic()
    # The sidecar is a quote adapter, not a catalog database. Only the exact
    # release generation loaded by Express from PredictionMarketCatalogV2 is
    # eligible for qualification and market-data requests.
    seeds = request_catalog_contracts(request)
    discovered_count = 0
    added = 0
    portfolio_seed_count = 0
    catalog_seeds, retired_seeds = partition_catalog_for_release(seeds, request)
    timings["seed_load_ms"] = elapsed_ms(phase_start)

    if not catalog_seeds:
        fetched_at = now_iso()
        error_code = "CATALOG_NOT_PROMOTED"
        last_snapshot = {
            "events": [],
            "providers": {
                "ibkr": {
                    **provider(
                        "catalog_unavailable",
                        "PredictionMarketCatalogV2 has no qualified metadata for the active CPI release.",
                        fetched_at,
                    ),
                    "errorCode": error_code,
                    "catalog_status": "no_current_contracts",
                    "execution_ready": False,
                    "releaseKey": request_release_key(request),
                }
            },
            "fetched_at": fetched_at,
            "contracts_added": added,
            "contracts_total": 0,
            "errorCode": error_code,
            "portfolio_seed_count": portfolio_seed_count,
            "catalog_source": "PredictionMarketCatalogV2",
            "catalog_rejected_contracts": len(retired_seeds),
            "cpi_discovery": cpi_discovery_report(catalog_seeds, request, discovered_count, added),
            "timing": {**timings, "total_ms": elapsed_ms(request_start), "phase": "catalog"},
        }
        return JSONResponse(last_snapshot)

    events_out: List[Dict[str, Any]] = []
    errors: List[str] = []
    quote_start = time.monotonic()
    quote_timings: List[Dict[str, Any]] = []
    for seed in catalog_seeds:
        seed_start = time.monotonic()
        try:
            contract = seeded_contract(seed)
            qualified = await ib.qualifyContractsAsync(contract)
            if not qualified:
                errors.append(f"Could not qualify {seed.get('description') or seed.get('conId')}")
                continue
            ticker = ib.reqMktData(qualified[0], "", False, False)
            await asyncio.sleep(float(seed.get("quote_wait_sec", 1.5)))
            events_out.append(normalize_seeded_event(seed, ticker))
            ib.cancelMktData(qualified[0])
            quote_timings.append({
                "contract": seed.get("localSymbol") or seed.get("description") or seed.get("conId"),
                "ms": elapsed_ms(seed_start),
            })
        except Exception as exc:
            errors.append(f"{seed.get('description') or seed.get('conId')}: {exc}")
            quote_timings.append({
                "contract": seed.get("localSymbol") or seed.get("description") or seed.get("conId"),
                "ms": elapsed_ms(seed_start),
                "error": str(exc),
            })
    timings["quote_ms"] = elapsed_ms(quote_start)

    fetched_at = now_iso()
    last_snapshot = {
        "events": events_out,
        "providers": {
            "ibkr": {
                **provider(
                    "connected",
                    "; ".join(errors[:3]) if errors else None,
                    fetched_at,
                ),
                "catalog_status": "authoritative_current" if catalog_seeds else "no_current_contracts",
                "execution_ready": any(
                    event.get("yes_ask") is not None or event.get("no_ask") is not None
                    for event in events_out
                ),
                "releaseKey": request_release_key(request),
                "qualification_errors": len(errors),
            }
        },
        "fetched_at": fetched_at,
        "contracts_added": added,
        "contracts_total": len(catalog_seeds),
        "catalog_source": "PredictionMarketCatalogV2",
        "catalog_rejected_contracts": len(retired_seeds),
        "portfolio_seed_count": portfolio_seed_count,
        "cpi_discovery": cpi_discovery_report(catalog_seeds, request, discovered_count, added),
        "timing": {
            **timings,
            "total_ms": elapsed_ms(request_start),
            "phase": "quotes",
            "quote_contracts": len(catalog_seeds),
            "quote_details": quote_timings[:10],
        },
    }
    return JSONResponse(last_snapshot)


@app.post("/discover")
async def discover(request: Optional[DiscoveryRequest] = None) -> JSONResponse:
    """Find current-release event contracts from authoritative IB contract details."""
    request_start = time.monotonic()
    health = await ensure_connected()
    if not health["ok"]:
        return JSONResponse(
            {
                "ok": False,
                "status": health["status"],
                "message": health.get("message"),
                "contracts_added": 0,
                "timing": {"phase": "gateway", "total_ms": elapsed_ms(request_start)},
            },
            status_code=200,
        )

    if not request_release_key(request):
        return JSONResponse(
            {
                "ok": False,
                "status": "invalid_release_context",
                "message": "A server-owned CPI releaseKey is required for discovery.",
                "contracts_added": 0,
                "contracts_total": 0,
                "timing": {"phase": "release", "total_ms": elapsed_ms(request_start)},
            },
            status_code=200,
        )

    discovery_start = time.monotonic()
    discovered = await discover_event_contract_seeds(request=request)
    discovery_ms = elapsed_ms(discovery_start)
    # Discovery returns an authoritative candidate generation. Express owns
    # the only operational promotion and commits it atomically to DynamoDB.
    catalog_seeds, retired_seeds = partition_catalog_for_release(discovered, request)
    added = len(catalog_seeds)
    portfolio_seed_count = 0

    unsupported = not discovered
    error_code = "UNSUPPORTED_OR_NOT_ENTITLED" if unsupported else None

    return JSONResponse(
        {
            "ok": not unsupported,
            "status": "unsupported_or_not_entitled" if unsupported else "connected",
            "message": (
                "IBKR returned no supported/entitled current-release ForecastEx CPI contracts."
                if unsupported else None
            ),
            "errorCode": error_code,
            "discovered": len(discovered),
            "contracts_added": added,
            "contracts_total": len(catalog_seeds),
            "portfolio_seed_count": portfolio_seed_count,
            "catalog_contracts": catalog_seeds,
            "catalog_rejected_contracts": len(retired_seeds),
            "catalog_promotion": {
                "type": "catalog_candidate",
                "status": "candidate" if catalog_seeds else "not_promoted",
                "atomic": False,
                "releaseKey": request_release_key(request),
                "activeContracts": len(catalog_seeds),
                "retiredContracts": len(retired_seeds),
                "authority": "PredictionMarketCatalogV2",
            },
            "cpi_discovery": cpi_discovery_report(catalog_seeds, request, len(discovered), added),
            "catalog_qualification": cpi_catalog_qualification_report(catalog_seeds, discovered, request),
            "timing": {
                "phase": "discovery",
                "discovery_ms": discovery_ms,
                "total_ms": elapsed_ms(request_start),
            },
        }
    )


def instrument_to_contract(inst: InstrumentIn) -> Contract:
    c = Contract()
    if inst.conId:
        c.conId = int(inst.conId)
    c.symbol = (inst.symbol or "").upper()
    c.secType = inst.secType or "STK"
    c.exchange = inst.exchange or "SMART"
    c.currency = inst.currency or "USD"
    return c


def resolve_account(account: Optional[str]) -> Optional[str]:
    if account:
        return account
    accounts = ib.managedAccounts()
    return accounts[0] if accounts else None


# TODO: discover_forecast_event_contracts() — Forecast/Event/Prediction Market conids;
# do not map to Yahoo-style tickers. Use POST /discover for event seeds today.


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
    quotes_out: List[Dict[str, Any]] = []
    errors: List[str] = []

    for inst in instruments:
        try:
            if stream_manager:
                cached = stream_manager.get_cached_quote_for_instrument(inst)
                if cached:
                    quotes_out.append(cached)
                    continue

            contract = instrument_to_contract(inst)
            qualified = await ib.qualifyContractsAsync(contract)
            if not qualified:
                errors.append(f"Could not qualify {inst.symbol or inst.conId}")
                continue
            qc = qualified[0]
            ticker = ib.reqMktData(qc, "", False, False)
            await asyncio.sleep(QUOTE_WAIT_SEC)
            quotes_out.append(ticker_to_raw_quote(ticker, qc))
            ib.cancelMktData(qc)
        except Exception as exc:
            errors.append(f"{inst.symbol or inst.conId}: {exc}")

    return JSONResponse(
        {
            "ok": True,
            "quotes": quotes_out,
            "errors": errors,
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
        contract = instrument_to_contract(body.instrument)
        qualified = await ib.qualifyContractsAsync(contract)
        if not qualified:
            return JSONResponse(
                {"ok": False, "message": "Could not qualify contract", "bars": []},
                status_code=200,
            )
        qc = qualified[0]
        bars = await ib.reqHistoricalDataAsync(
            qc,
            endDateTime="",
            durationStr=duration,
            barSizeSetting=bar_size,
            whatToShow="TRADES",
            useRTH=True,
            formatDate=1,
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
        return JSONResponse({"ok": True, "bars": out, "fetched_at": now_iso()})
    except Exception as exc:
        return JSONResponse({"ok": False, "message": str(exc), "bars": []}, status_code=200)


async def fetch_positions_snapshot(acct: str) -> Dict[str, Any]:
    try:
        await req_positions_bounded(ib)
    except asyncio.TimeoutError:
        return {
            "ok": False,
            "account": acct,
            "positions": [],
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
                "position": float(pos.position),
                "avgCost": float(pos.avgCost),
                "marketValue": None,
                "unrealizedPnL": None,
                "realizedPnL": None,
            }
        )

    return {"ok": True, "account": acct, "positions": positions, "fetched_at": now_iso(), "source": "ibkr_positions"}


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

    # A direct snapshot is intentionally cache-free. The dashboard's
    # prediction-market position endpoint uses this only after the normal
    # stream-sync path fails verification.
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
            {"ok": False, "status": health["status"], "message": health.get("message"), "orders": []},
            status_code=200,
        )

    acct = resolve_account(account)
    orders_out: List[Dict[str, Any]] = []
    for trade in ib.openTrades():
        if acct and trade.order.account and trade.order.account != acct:
            continue
        o = trade.order
        c = trade.contract
        orders_out.append(
            {
                "orderId": o.orderId,
                "account": o.account or acct,
                "symbol": c.symbol,
                "conId": int(c.conId) if c.conId else None,
                "action": o.action,
                "totalQuantity": float(o.totalQuantity),
                "orderType": o.orderType,
                "lmtPrice": float(o.lmtPrice) if o.lmtPrice else None,
                "status": o.status,
            }
        )

    return JSONResponse({"ok": True, "account": acct, "orders": orders_out, "fetched_at": now_iso()})


@app.get("/portfolio/pnl")
async def portfolio_pnl(account: Optional[str] = Query(None)) -> JSONResponse:
    """Return only a freshly subscribed PnL update from a verified live IB session."""
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

    def safe_float(val: Any) -> Optional[float]:
        if val is None:
            return None
        try:
            f = float(val)
            if f != f:
                return None
            return f
        except (TypeError, ValueError):
            return None

    subscription_started = False
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

        # Start a new subscription for this request. Reusing ib.pnl() here can
        # surface a value retained by ib_insync from an earlier session.
        try:
            ib.cancelPnL(acct, "")
        except Exception:
            pass
        pnl_subscription = ib.reqPnL(acct, "")
        subscription_started = True
        pnl = None
        deadline = asyncio.get_running_loop().time() + max(0.3, PNL_WAIT_SEC)
        while asyncio.get_running_loop().time() < deadline:
            subscribed = ib.pnl(acct, "")
            candidate = subscribed[0] if subscribed else pnl_subscription
            if candidate and any(
                safe_float(getattr(candidate, field, None)) is not None
                for field in ("dailyPnL", "unrealizedPnL", "realizedPnL")
            ):
                pnl = candidate
                break
            await asyncio.sleep(0.2)

        if pnl:
            daily_pnl = safe_float(pnl.dailyPnL)
            observed_at = now_iso()
            return JSONResponse(
                {
                    "ok": True,
                    "connected": True,
                    "status": "live",
                    "source": "ibkr_live_session",
                    "account": acct,
                    "pnl": {
                        "dailyPnL": daily_pnl,
                        # IB's PnL subscription does not provide a percentage.
                        # Do not infer one from a cached account-summary value.
                        "dailyPnLPercent": None,
                        "dailyPnLPercentSource": None,
                        "unrealizedPnL": safe_float(pnl.unrealizedPnL),
                        "realizedPnL": safe_float(pnl.realizedPnL),
                    },
                    "socket_verified_at": gateway_time.isoformat() if hasattr(gateway_time, "isoformat") else str(gateway_time),
                    "observed_at": observed_at,
                    "fetched_at": observed_at,
                }
            )
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
    finally:
        if subscription_started and acct:
            try:
                ib.cancelPnL(acct, "")
            except Exception:
                pass

    return JSONResponse(
        {
            "ok": False,
            "connected": True,
            "status": "live_pnl_unavailable",
            "message": "The fresh IB PnL subscription returned no values.",
            "source": "unavailable",
            "account": acct,
            "pnl": None,
            "observed_at": now_iso(),
        },
        status_code=503,
    )
