"""Curated OpenBB, fail-closed IBKR, and direct Kalshi market reads."""

from __future__ import annotations

import asyncio
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timezone
import inspect
import logging
import math
import os
import re
import threading
import time
from typing import Any, Awaitable, Callable, Optional
from urllib.parse import quote

import httpx

from contracts import envelope, utc_now_iso
from inbox_holdings import verified_current_portfolio_input
from loop_lag import monitor as loop_lag_monitor
from prediction_review import prediction_contract_row


LOGGER = logging.getLogger("market_dashboard.analyst.gateway")


IBKR_BASE_URL = os.environ.get("IBKR_SIDECAR_URL", "http://127.0.0.1:8765").rstrip("/")
MARKET_DASHBOARD_API_BASE = os.environ.get(
    "MARKET_DASHBOARD_API_BASE", "http://127.0.0.1:3001"
).rstrip("/")
IBKR_TIMEOUT_SECONDS = float(os.environ.get("ANALYST_IBKR_TIMEOUT_SEC", "15"))
IBKR_READINESS_TIMEOUT_SECONDS = 1.0
IBKR_READINESS_PROBE_WORKERS = 2
# Checks that start together share one request this young; an older request
# may be hung, so a new check starts its own while a worker is free.
IBKR_READINESS_JOIN_SECONDS = 0.25
# A readiness timeout while this process stalled this much (loop lag, a late
# request, or CPU held while waiting) is local contention, not Gateway
# evidence; it earns exactly one fresh probe.
LOCAL_CONTENTION_LAG_MS = 250
IBKR_READINESS_CODES = frozenset({
    "IBKR_GATEWAY_READINESS_TIMEOUT", "IBKR_GATEWAY_NOT_VERIFIED", "IBKR_GATEWAY_NOT_AUTHENTICATED",
    "IBKR_GATEWAY_API_UNRESPONSIVE", "IBKR_GATEWAY_RECONNECTING",
})
# Only these establish a disconnect. Every other failed check leaves the
# connection unverified, and the sources it gates were simply not attempted.
GATEWAY_DISCONNECT_CODES = frozenset({
    "IBKR_GATEWAY_NOT_CONNECTED", "IBKR_GATEWAY_NOT_AUTHENTICATED", "GATEWAY_UNAVAILABLE",
})
GATEWAY_UNVERIFIED_NOT_ATTEMPTED = "IBKR_CONNECTION_UNVERIFIED_NOT_ATTEMPTED"
# Pooled connections retire before the local servers' 5 s keep-alive closes them.
SHARED_CLIENT_KEEPALIVE_SECONDS = 2.0
IBKR_QUOTE_MAX_AGE_SECONDS = float(os.environ.get("ANALYST_IBKR_QUOTE_MAX_AGE_SEC", "60"))
IBKR_HOLDINGS_MAX_AGE_SECONDS = 60
PREDICTION_TIMEOUT_SECONDS = float(os.environ.get("ANALYST_PREDICTION_TIMEOUT_SEC", "45"))
PREDICTION_MAX_AGE_SECONDS = float(os.environ.get("ANALYST_PREDICTION_MAX_AGE_SEC", "60"))
BALANCE_TIMEOUT_SECONDS = float(os.environ.get("ANALYST_BALANCE_TIMEOUT_SEC", "35"))
BALANCE_MAX_AGE_SECONDS = float(os.environ.get("ANALYST_BALANCE_MAX_AGE_SEC", "45"))
BALANCE_HISTORY_ROW_LIMIT = 14
BALANCE_SUPPORT_CAPTURE_BUDGET_SECONDS = 20
BALANCE_SUPPORT_RETRY_DELAY_SECONDS = 0.15
BALANCE_SUPPORT_MAX_ATTEMPTS = 3
BALANCE_FAILURE_MESSAGES = {
    "BALANCE_UNAVAILABLE": "Verified live IBKR balance is unavailable.",
    "BALANCE_HTTP_ERROR": "The balance service could not complete the live IBKR request.",
    "BALANCE_SERVICE_UNAVAILABLE": "The local balance service could not be reached.",
    "BALANCE_REQUEST_TIMEOUT": "The live IBKR balance request timed out.",
    "IBKR_BALANCE_REQUEST_TIMEOUT": "The live IBKR balance request exceeded its total deadline.",
    "BALANCE_SNAPSHOT_TIMEOUT": "The live IBKR balance snapshot timed out.",
    "BALANCE_SNAPSHOT_BUSY": "Another live IBKR balance snapshot was still in progress.",
    "BALANCE_SNAPSHOT_ACCOUNT_BUSY": "Another account's live IBKR balance snapshot was still in progress.",
    "BALANCE_SNAPSHOT_FAILED": "The live IBKR balance snapshot failed.",
    "BALANCE_SNAPSHOT_CHANGED": "Account activity changed during balance verification.",
    "GATEWAY_UNAVAILABLE": "The dedicated IBKR balance connection was unavailable.",
    "IBKR_BALANCE_UNVERIFIED": ("The dedicated IBKR balance connection could not be verified; "
                                "this does not establish an IB Gateway disconnect."),
    "BALANCE_ACCOUNT_REQUIRED": "An exact live IBKR account could not be established for balance verification.",
    "ACCOUNT_REQUIRED": "Balance verification requires an exact IBKR account.",
    "ACCOUNT_NOT_MANAGED": "The requested account was not managed by the verified IBKR session.",
    "ACCOUNT_NOT_READY": "The IBKR account was not ready for balance verification.",
    "MANAGED_ACCOUNTS_MISSING": "The verified IBKR session returned no managed accounts.",
    "ACCOUNT_UPDATE_ACCOUNT_MISMATCH": "The account updates did not match the account being verified.",
    "BALANCE_VERIFICATION_FAILED": "The balance response did not pass the verified-live IBKR gate.",
}
HOLDINGS_FAILURE_MESSAGES = {
    "IBKR_HOLDINGS_TIMEOUT": "The fresh IBKR holdings request timed out.",
    "IBKR_HOLDINGS_SERVICE_UNAVAILABLE": "The local IBKR holdings service could not provide fresh holdings.",
    "IBKR_HOLDINGS_REQUEST_FAILED": "Fresh IBKR holdings could not be acquired.",
}
MAX_MARKET_SYMBOLS = 50
MAX_QUOTE_BATCH_CONCURRENCY = 2
# Live marks are optional evidence for an already verified book. When IBKR
# sends no ticks (a closed session), every contract waits out its snapshot
# window, so all work after the holdings read shares one bounded budget and
# the book settles with valuations withheld instead of stalling the review.
PORTFOLIO_VALUATION_BUDGET_SECONDS = float(os.environ.get("ANALYST_IBKR_VALUATION_BUDGET_SEC", "12"))
# A retry pass needs at least one broker snapshot window to recover a mark.
PORTFOLIO_VALUATION_RETRY_MIN_SECONDS = 3.0
VALUATION_BUDGET_EXHAUSTED = "valuation_budget_exhausted"
FORECASTEX_DAILY_CONTRACT_RE = re.compile(
    r"^(?P<product>COMCO|METLG|FES)_(?P<month>\d{2})(?P<day>\d{2})(?P<year>\d{2})_"
    r"-?\d+(?:\.\d+)?_(?P<side>YES|NO)$"
)
PREDICTION_SERIES_TICKERS = (
    "KXCPIYOY",
    "KXINXU",
    "KXINX",
    "KXWTI",
    "KXWTIW",
    "KXFEDDECISION",
    "KXFED",
    "KXPAYROLLS",
    "KXU3",
    "KXPCECORE",
    "KXGDP",
)
PREDICTION_SERIES_ALLOWLIST = frozenset(PREDICTION_SERIES_TICKERS)
PREDICTION_LADDER_SERIES = frozenset({"KXCPIYOY", "KXINXU", "KXWTI", "KXWTIW"})
PREDICTION_MONITOR_AREAS = ("sp500", "wti", "nasdaq100", "gold")
PREDICTION_MONITOR_AREA_ALLOWLIST = frozenset(PREDICTION_MONITOR_AREAS)
PREDICTIVE_REVIEW_UNIVERSE = (
    ("cpi", "CPI", "forecastex"),
    ("sp500", "S&P 500", "forecastex"),
    ("nasdaq100", "Nasdaq-100", "kalshi"),
    ("gold", "Gold", "kalshi"),
    ("silver", "Silver", "kalshi"),
    ("bitcoin", "Bitcoin", "kalshi"),
    ("ethereum", "Ethereum", "kalshi"),
)
OPTION_SECURITY_TYPES = frozenset({"OPT", "FOP"})
EVENT_CONTRACT_TYPES_BY_VENUE = {
    "FORECASTX": frozenset({"OPT", "FOP"}),
    "KALSHI": frozenset({"OPT"}),
}
PREDICTION_FORBIDDEN_FLAGS = frozenset(
    {
        "stale_quote",
        "portfolio_seed",
        "portfolio_discovered",
        "catalog_missing",
        "cache",
        "cached",
        "mock",
        "fallback",
        "no_live_quote",
        "failed",
        "closed",
        "settled",
        "incomplete",
    }
)
_SHARED_CLIENTS: dict[tuple[str, Any, Any], tuple[httpx.AsyncClient, asyncio.AbstractEventLoop]] = {}
_READINESS_LOCK = threading.Lock()
_READINESS_EXECUTOR: Optional[ThreadPoolExecutor] = None
_READINESS_IN_FLIGHT = 0
_READINESS_CLIENTS: dict[str, httpx.Client] = {}
_READINESS_SHARED: dict[str, "_SharedReadinessRequest"] = {}


def _shared_client(base_url: str, transport: Optional[httpx.AsyncBaseTransport] = None) -> httpx.AsyncClient:
    """One pooled client per base URL and event loop; each request sets its own timeout."""
    loop = asyncio.get_running_loop()
    # A patched constructor (tests) never reuses a real client, and a real
    # read never reuses a patched one.
    key = (base_url, transport, httpx.AsyncClient)
    entry = _SHARED_CLIENTS.get(key)
    if entry is not None and entry[1] is loop and entry[0].is_closed is False:
        return entry[0]
    options: dict[str, Any] = {"limits": httpx.Limits(
        max_connections=100, max_keepalive_connections=20, keepalive_expiry=SHARED_CLIENT_KEEPALIVE_SECONDS)}
    if transport is not None:
        options["transport"] = transport
    client = httpx.AsyncClient(**options)
    _SHARED_CLIENTS[key] = (client, loop)
    return client


async def aclose_shared_clients() -> None:
    """Close pooled reader clients at shutdown; later reads open new ones."""
    global _READINESS_EXECUTOR
    loop = asyncio.get_running_loop()
    entries = list(_SHARED_CLIENTS.items())
    _SHARED_CLIENTS.clear()
    for _key, (client, owner) in entries:
        # A client bound to an earlier, closed loop cannot be awaited here.
        if owner is loop:
            closing = client.aclose()
            if inspect.isawaitable(closing):
                await closing
    with _READINESS_LOCK:
        clients = list(_READINESS_CLIENTS.values())
        _READINESS_CLIENTS.clear()
        executor, _READINESS_EXECUTOR = _READINESS_EXECUTOR, None
    if executor is not None:
        # Running probes end on their own HTTP timeouts and settle their waiters.
        executor.shutdown(wait=False)
    for client in clients:
        client.close()


def _readiness_client(base_url: str) -> httpx.Client:
    """The synchronous client used only by readiness probe threads."""
    with _READINESS_LOCK:
        client = _READINESS_CLIENTS.get(base_url)
        if client is None or client.is_closed:
            client = httpx.Client(limits=httpx.Limits(
                max_connections=IBKR_READINESS_PROBE_WORKERS,
                max_keepalive_connections=IBKR_READINESS_PROBE_WORKERS,
                keepalive_expiry=SHARED_CLIENT_KEEPALIVE_SECONDS,
            ))
            _READINESS_CLIENTS[base_url] = client
        return client


class _SharedReadinessRequest:
    """One in-flight readiness request and every check waiting on its answer."""

    def __init__(self, base_url: str, probe: "GatewayProbe") -> None:
        self.base_url = base_url
        self.started = time.monotonic()
        # When a worker began the request and when it reached the IBKR
        # service. A stall that holds the GIL delays both.
        self.began: Optional[float] = None
        self.sent: Optional[float] = None
        probe.request = self
        self.subscribers = [probe]
        self.future: Future = Future()
        # Waiters that give up must never cancel the answer the others share.
        self.future.set_running_or_notify_cancel()


def _finish_shared_readiness(shared: _SharedReadinessRequest, outcome: "GatewayProbe") -> None:
    global _READINESS_IN_FLIGHT
    with _READINESS_LOCK:
        if _READINESS_SHARED.get(shared.base_url) is shared:
            del _READINESS_SHARED[shared.base_url]
        _READINESS_IN_FLIGHT -= 1
        subscribers = list(shared.subscribers)
    for probe in subscribers:
        probe.adopt(outcome)
    shared.future.set_result(outcome.result())


def _run_shared_readiness(shared: _SharedReadinessRequest, function: Callable[["GatewayProbe"], Any]) -> None:
    shared.began = time.monotonic()
    outcome = GatewayProbe(shared.subscribers[0].budget_seconds)
    outcome.request = shared
    try:
        function(outcome)
    finally:
        if not outcome.done():
            outcome.finish(IbkrReader._gateway_unavailable("IBKR_SERVICE_UNAVAILABLE"),
                           io_ms=round((time.monotonic() - shared.started) * 1000), received_at=None)
        _finish_shared_readiness(shared, outcome)


def _start_readiness_probe(
    base_url: str, probe: "GatewayProbe", function: Callable[["GatewayProbe"], Any],
) -> Optional[Future]:
    """Join a request started moments ago, start one on a free worker, or join the newest.

    Checks that start together share one request. A new check starts its own
    request while a worker is free. When every worker is busy it joins the
    newest request instead of reporting an unverified check; its own budget
    still bounds the wait. Only with no request to join does it return None.
    """
    global _READINESS_EXECUTOR, _READINESS_IN_FLIGHT
    with _READINESS_LOCK:
        shared = _READINESS_SHARED.get(base_url)
        if shared is not None and (time.monotonic() - shared.started <= IBKR_READINESS_JOIN_SECONDS
                                   or _READINESS_IN_FLIGHT >= IBKR_READINESS_PROBE_WORKERS):
            probe.request = shared
            shared.subscribers.append(probe)
            return shared.future
        if _READINESS_IN_FLIGHT >= IBKR_READINESS_PROBE_WORKERS:
            return None
        if _READINESS_EXECUTOR is None:
            _READINESS_EXECUTOR = ThreadPoolExecutor(
                max_workers=IBKR_READINESS_PROBE_WORKERS, thread_name_prefix="ibkr-readiness")
        executor = _READINESS_EXECUTOR
        shared = _SharedReadinessRequest(base_url, probe)
        _READINESS_SHARED[base_url] = shared
        _READINESS_IN_FLIGHT += 1
    try:
        executor.submit(_run_shared_readiness, shared, function)
    except RuntimeError:
        # Only possible while shutting down; settle anyone who already joined.
        outcome = GatewayProbe(probe.budget_seconds)
        outcome.finish(IbkrReader._gateway_unavailable("IBKR_SERVICE_UNAVAILABLE"), io_ms=0, received_at=None)
        _finish_shared_readiness(shared, outcome)
    return shared.future


class GatewayProbe:
    """What one readiness request observed in its own thread.

    The event loop can resume after its timers expire. This record lets a late
    loop accept an answer that arrived within budget instead of reporting a
    timeout the request itself never had.
    """

    def __init__(self, budget_seconds: float) -> None:
        self.budget_seconds = budget_seconds
        # What ended the request: none (it answered), producer (the IBKR
        # service reported its own timeout), or inner (the HTTP timeout).
        self.bound: Optional[str] = None
        # Which loop-side wait gave up first: inner, outer, or busy.
        self.waited: Optional[str] = None
        self.io_ms: Optional[int] = None
        self.received_at: Optional[str] = None
        self.heartbeat_age_ms: Optional[int] = None
        # The thread request this check waits on; None on the async path.
        self.request: Optional[_SharedReadinessRequest] = None
        self._result: Optional[dict[str, Any]] = None
        self._done = threading.Event()

    def finish(self, result: dict[str, Any], *, io_ms: int, received_at: Optional[str]) -> None:
        self._result = result
        self.io_ms = io_ms
        self.received_at = received_at
        self._done.set()

    def adopt(self, outcome: "GatewayProbe") -> None:
        """Take the measurements of the shared request this check waited on."""
        self.bound = outcome.bound
        self.heartbeat_age_ms = outcome.heartbeat_age_ms
        self.finish(outcome.result(), io_ms=outcome.io_ms, received_at=outcome.received_at)

    def done(self) -> bool:
        return self._done.is_set()

    def result(self) -> Optional[dict[str, Any]]:
        return self._result

    def completed(self) -> Optional[dict[str, Any]]:
        """The in-thread verdict when an answer arrived within the budget."""
        if (self._done.is_set() and self.bound != "inner" and self.io_ms is not None
                and self.io_ms <= self.budget_seconds * 1000):
            return self._result
        return None

    def fired(self) -> str:
        """The bound that decided this check, for diagnostics."""
        if self.completed() is not None:
            return self.bound or "none"
        return self.waited or self.bound or "none"

    def start_delay_ms(self, since: float, now: float) -> float:
        """How long after ``since`` this check's request reached the IBKR service.

        A request no worker has begun counts until ``now``. One still
        connecting counts from when its worker began: a slow connect is not a
        local delay.
        """
        request = self.request
        if request is None:
            return 0.0
        at = request.sent if request.sent is not None else request.began if request.began is not None else now
        return round(max(0.0, at - since) * 1000, 1)


def _iso_age_seconds(value: Any) -> Optional[float]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - parsed.astimezone(timezone.utc)).total_seconds()
    except (TypeError, ValueError):
        return None


def _finite_positive(value: Any) -> bool:
    try:
        number = float(value)
        return math.isfinite(number) and number > 0
    except (TypeError, ValueError):
        return False


def _finite_number_or_none(value: Any) -> Optional[float]:
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def _positive_number_or_none(value: Any) -> Optional[float]:
    number = _finite_number_or_none(value)
    return number if number is not None and number > 0 else None


def _position_instrument_category(sec_type: Any, exchange: Any) -> str:
    normalized_type = str(sec_type or "").strip().upper()
    normalized_exchange = str(exchange or "").strip().upper()
    if normalized_type in EVENT_CONTRACT_TYPES_BY_VENUE.get(normalized_exchange, frozenset()):
        return "event_contract"
    if normalized_type in OPTION_SECURITY_TYPES and normalized_exchange:
        return "listed_option"
    return "other"


def _normalized_event_contract_side(local_symbol: Any, contract_right: Any) -> Optional[str]:
    symbol = str(local_symbol or "").strip().upper()
    right = str(contract_right or "").strip().upper()
    provider_side = "YES" if symbol.endswith("_YES") else "NO" if symbol.endswith("_NO") else None
    native_side = "YES" if right in {"C", "CALL"} else "NO" if right in {"P", "PUT"} else None
    return provider_side if provider_side and provider_side == native_side else None


def _verified_forecastex_resolution_date(row: dict[str, Any]):
    exchange = str(row.get("exchange") or "").strip().upper()
    if exchange and exchange not in {"FORECASTX", "FORECASTEX"}:
        return False
    local_symbol = str(row.get("localSymbol") or "").strip().upper()
    match = FORECASTEX_DAILY_CONTRACT_RE.fullmatch(local_symbol)
    if not match or _normalized_event_contract_side(local_symbol, row.get("right")) is None:
        return False
    product = match.group("product")
    trading_class = str(row.get("tradingClass") or "").strip().upper()
    sec_type = str(row.get("secType") or "").strip().upper()
    currency = str(row.get("currency") or "").strip().upper()
    # IBKR's position snapshot currently omits exchange for settled ForecastEx
    # rows. In that exact case require the native product trading class plus
    # the full local-symbol/side/expiry identity; never classify by symbol
    # alone or accept another populated venue.
    if trading_class and trading_class != product:
        return False
    if not exchange and trading_class != product:
        return False
    if sec_type not in OPTION_SECURITY_TYPES or (currency and currency != "USD"):
        return False
    try:
        resolution_date = datetime(
            2000 + int(match.group("year")),
            int(match.group("month")),
            int(match.group("day")),
            tzinfo=timezone.utc,
        ).date()
    except ValueError:
        return False
    expected_expiration = resolution_date.strftime("%Y%m%d")
    returned_expiration = str(
        row.get("lastTradeDateOrContractMonth") or ""
    ).strip()
    if not returned_expiration.startswith(expected_expiration):
        return None
    return resolution_date


def _expired_forecastex_contract(row: dict[str, Any], now: datetime) -> bool:
    resolution_date = _verified_forecastex_resolution_date(row)
    return bool(
        resolution_date
        and resolution_date < now.astimezone(timezone.utc).date()
    )


def _forecastex_settlement_probe_candidate(row: dict[str, Any], now: datetime) -> bool:
    resolution_date = _verified_forecastex_resolution_date(row)
    return bool(
        resolution_date
        and resolution_date <= now.astimezone(timezone.utc).date()
    )


def _finite_between(value: Any, minimum: float, maximum: Optional[float] = None) -> bool:
    try:
        number = float(value)
        return math.isfinite(number) and number >= minimum and (maximum is None or number <= maximum)
    except (TypeError, ValueError):
        return False


def _parse_iso(value: Any) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def _age_at(value: Any, now: datetime) -> Optional[float]:
    parsed = _parse_iso(value)
    return None if parsed is None else (now - parsed).total_seconds()


def _flags(value: Any) -> set[str]:
    if not isinstance(value, (list, tuple, set)):
        return set()
    return {str(flag).strip().lower() for flag in value if str(flag).strip()}


def _has_forbidden_prediction_quality(*values: Any) -> bool:
    observed: set[str] = set()
    for value in values:
        if isinstance(value, dict):
            observed.update(_flags(value.get("flags")))
            observed.update(_flags(value.get("dataQualityFlags")))
            observed.update(_flags(value.get("data_quality_flags")))
            if value.get("from_cache") is True or value.get("fromCache") is True:
                observed.add("cached")
            if value.get("mock") is True:
                observed.add("mock")
            if value.get("fallback") is True:
                observed.add("fallback")
        else:
            observed.update(_flags(value))
    return any(
        flag in PREDICTION_FORBIDDEN_FLAGS
        or "cache" in flag
        or "mock" in flag
        or "fallback" in flag
        or "stale" in flag
        for flag in observed
    )


def _complete_native_book(value: dict[str, Any]) -> bool:
    prices_complete = bool(
        _finite_between(value.get("yesBid"), 0, 1)
        and _finite_positive(value.get("yesAsk"))
        and float(value["yesAsk"]) <= 1
        and float(value["yesAsk"]) >= float(value["yesBid"])
        and _finite_between(value.get("noBid"), 0, 1)
        and _finite_positive(value.get("noAsk"))
        and float(value["noAsk"]) <= 1
        and float(value["noAsk"]) >= float(value["noBid"])
    )
    yes_depth_complete = all(
        _finite_between(value.get(field), 0)
        for field in ("yesBidSize", "yesAskSize")
    )
    no_depth = (value.get("noBidSize"), value.get("noAskSize"))
    no_depth_native_or_absent = (
        no_depth == (None, None)
        or all(_finite_between(depth, 0) for depth in no_depth)
    )
    return prices_complete and yes_depth_complete and no_depth_native_or_absent


def _strict_ibkr_prediction_quote(value: dict[str, Any], now: datetime) -> bool:
    if value.get("verified") is not True or value.get("executable") is False:
        return False
    try:
        con_id = int(value.get("conId"))
    except (TypeError, ValueError):
        return False
    if con_id <= 0 or str(value.get("sourceApi") or "") != "IBKR_TWS_API":
        return False
    if str(value.get("marketDataType") or "").lower() not in {"1", "live"}:
        return False
    age = _age_at(value.get("quoteTimestamp"), now)
    if age is None or age < -30 or age > IBKR_QUOTE_MAX_AGE_SECONDS:
        return False
    if _has_forbidden_prediction_quality(value):
        return False
    return bool(
        _finite_between(value.get("nativeBid"), 0, 1)
        and _finite_between(value.get("nativeAsk"), 0, 1)
        and float(value["nativeAsk"]) > float(value["nativeBid"])
        and _finite_positive(value.get("nativeBidSize"))
        and _finite_positive(value.get("nativeAskSize"))
    )


class BalanceContextReader:
    """Verified live balance plus explicitly dated IBKR interest history."""

    def __init__(
        self,
        base_url: str = MARKET_DASHBOARD_API_BASE,
        request: Optional[Callable[..., Awaitable[dict[str, Any]]]] = None,
        now: Optional[Callable[[], datetime]] = None,
        supporting_timeout_seconds: float = 3.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._request_override = request
        self._now = now or (lambda: datetime.now(timezone.utc))
        self.supporting_timeout_seconds = supporting_timeout_seconds

    async def _request(self, path: str) -> dict[str, Any]:
        if self._request_override:
            return await self._request_override(path)
        response = await _shared_client(self.base_url).get(
            f"{self.base_url}{path}",
            headers={"Cache-Control": "no-cache", "Pragma": "no-cache"},
            timeout=BALANCE_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        if "no-store" not in str(response.headers.get("Cache-Control") or "").lower():
            raise RuntimeError("Balance endpoint did not return no-store data")
        return response.json()

    @staticmethod
    def _recent_rows(
        rows: Any,
        *,
        key: str,
        limit: int = BALANCE_HISTORY_ROW_LIMIT,
    ) -> list[dict[str, Any]]:
        if not isinstance(rows, list):
            return []
        valid = [row for row in rows if isinstance(row, dict)]
        valid.sort(key=lambda row: str(row.get(key) or ""))
        return valid[-limit:]

    @staticmethod
    def _history_range(rows: list[dict[str, Any]], key: str) -> dict[str, Any]:
        dates = [str(row.get(key)) for row in rows if row.get(key)]
        return {
            "returnedRows": len(rows),
            "from": dates[0] if dates else None,
            "through": dates[-1] if dates else None,
        }

    def _verified_current_balance(self, payload: Any) -> bool:
        if not isinstance(payload, dict):
            return False
        if (
            payload.get("available") is not True
            or payload.get("status") != "live"
            or payload.get("source") != "ibkr_live_session"
            or payload.get("fromCache") is not False
            or not str(payload.get("accountId") or "").strip()
        ):
            return False
        forbidden_flags = (
            "stale",
            "cached",
            "cacheOnly",
            "from_cache",
            "mock",
            "seeded",
            "synthetic",
            "fallback",
            "inferred",
            "portfolioDerived",
            "offline",
            "disconnected",
            "refreshFailed",
        )
        if any(payload.get(flag) is True for flag in forbidden_flags):
            return False
        timestamps = (
            payload.get("observedAt"),
            payload.get("socketVerifiedAt"),
            payload.get("accountValuesObservedAt"),
        )
        ages = [_age_at(value, self._now()) for value in timestamps]
        if any(
            age is None or age < -30 or age > BALANCE_MAX_AGE_SECONDS
            for age in ages
        ):
            return False
        exposure = payload.get("exposure")
        freshness = payload.get("freshness")
        return bool(
            isinstance(exposure, dict)
            and exposure.get("available") is True
            and exposure.get("status") == "live"
            and exposure.get("source") == "ibkr_live_session"
            and isinstance(freshness, dict)
            and freshness.get("status") == "fresh"
        )

    @staticmethod
    def _verified_interest_status(payload: Any) -> bool:
        return bool(
            isinstance(payload, dict)
            and BalanceContextReader._qualified_support(payload)
            and payload.get("source") == "ibkr_interest_validation"
            and payload.get("accountMatched") is True
            and payload.get("actionable") is False
            and _parse_iso(payload.get("generatedAt")) is not None
        )

    @staticmethod
    def _verified_interest_ledger(payload: Any, account_id: str) -> bool:
        return bool(
            isinstance(payload, dict)
            and BalanceContextReader._qualified_support(payload)
            and payload.get("source") == "ibkr_verified_interest_ledger"
            and payload.get("accountMatched") is True
            and payload.get("accountId") == account_id
            and payload.get("fromCache") is False
            and _parse_iso(payload.get("generatedAt")) is not None
            and all(
                isinstance(payload.get(name), list)
                for name in ("ledger", "observations", "forecasts", "postings", "formulaAudit")
            )
        )

    @staticmethod
    def _qualified_support(payload: dict[str, Any]) -> bool:
        return not any(payload.get(flag) is True for flag in (
            "stale", "cached", "cacheOnly", "fromCache", "from_cache", "mock", "seed", "seeded",
            "synthetic", "fallback", "inferred", "portfolioDerived", "offline", "disconnected", "refreshFailed",
        )) and payload.get("connected") is not False

    @staticmethod
    def _support_delivery_failure(error: Exception) -> tuple[bool, dict[str, Any]]:
        # Retain only reviewed codes and HTTP status, never provider messages,
        # request URLs, response bodies, account identifiers, or ledger values.
        if isinstance(error, (httpx.TimeoutException, asyncio.TimeoutError)):
            return True, {"outcome": "timeout", "errorCode": "INTEREST_SUPPORT_TIMEOUT"}
        if isinstance(error, httpx.TransportError):
            return True, {"outcome": "transport_error", "errorCode": "INTEREST_SUPPORT_TRANSPORT_ERROR"}
        if not isinstance(error, httpx.HTTPStatusError):
            return False, {"outcome": "rejected", "errorCode": "INTEREST_SUPPORT_INVALID_RESPONSE"}
        status = error.response.status_code
        try:
            payload = error.response.json()
        except ValueError:
            payload = None
        nested = payload.get("error") if isinstance(payload, dict) else None
        code = (nested.get("code") if isinstance(nested, dict) else None) or (
            payload.get("errorCode") if isinstance(payload, dict) else None)
        transient_codes = {"interest_evidence_worker_busy", "interest_evidence_worker_unavailable",
                           "interest_evidence_worker_timeout"}
        reviewed_codes = transient_codes | {
            "interest_store_integrity_error", "flex_interest_integrity_error", "interest_ledger_account_required",
            "interest_ledger_account_mismatch", "interest_export_not_configured", "interest_validation_status_error",
            "interest_evidence_worker_response_invalid", "interest_evidence_invalid_operation",
        }
        detail = {"outcome": "http_error", "httpStatus": status,
                  "errorCode": code if isinstance(code, str) and code in reviewed_codes else "INTEREST_SUPPORT_HTTP_ERROR"}
        transient = status in {408, 429} or 500 <= status < 600
        # A typed rejection is authoritative. An ambiguous status-service error
        # may represent a journal integrity failure, so it cannot be retried.
        if code is not None:
            transient = transient and isinstance(code, str) and code in transient_codes
        return transient, detail

    async def _read_support(self, path: str, validator, deadline: float):
        attempts = []
        result = asyncio.TimeoutError()
        for attempt in range(BALANCE_SUPPORT_MAX_ATTEMPTS):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            started = time.monotonic()
            try:
                result = await asyncio.wait_for(self._request(path), min(self.supporting_timeout_seconds, remaining))
            except Exception as error:
                result = error
                retryable, detail = self._support_delivery_failure(error)
            else:
                # A received valid partial or empty ledger is exact evidence;
                # a rejected account/schema/quality response is not transport.
                retryable = False
                detail = {"outcome": "verified" if validator(result) else "rejected"}
            detail["elapsedMs"] = round((time.monotonic() - started) * 1000)
            attempts.append(detail)
            if not retryable or attempt == BALANCE_SUPPORT_MAX_ATTEMPTS - 1:
                break
            remaining = deadline - time.monotonic()
            if remaining <= BALANCE_SUPPORT_RETRY_DELAY_SECONDS:
                break
            await asyncio.sleep(BALANCE_SUPPORT_RETRY_DELAY_SECONDS)
        return result, {"attemptCount": len(attempts), "attempts": attempts}

    @staticmethod
    def _unavailable(error_code: str = "BALANCE_UNAVAILABLE", *, http_status: Optional[int] = None) -> dict[str, Any]:
        # Never copy provider messages, account identifiers, or account values
        # into diagnostics. Only reviewed codes select fixed explanatory text.
        code = error_code if error_code in BALANCE_FAILURE_MESSAGES else "BALANCE_UNAVAILABLE"
        reason = BALANCE_FAILURE_MESSAGES[code]
        result = envelope(
            status="unavailable",
            source_system="market_dashboard",
            provider="ibkr",
            data={
                "current": None,
                "interestStatus": None,
                "history": None,
                "policy": {
                    "currentRequiresVerifiedLiveIbkr": True,
                    "historicalValuesAreDatedReferenceOnly": True,
                    "missingValuesMayBeInferred": False,
                },
            },
            freshness="unavailable",
            live_verified=False,
            warnings=[reason],
        )
        result["errorCode"] = code
        result["diagnostic"] = {"errorCode": code, "message": reason}
        if http_status is not None:
            result["diagnostic"]["httpStatus"] = http_status
        return result

    @staticmethod
    def _response_error_code(payload: Any, fallback: str) -> str:
        code = payload.get("errorCode") if isinstance(payload, dict) else None
        if code == "GATEWAY_UNAVAILABLE" and payload.get("gatewayErrorCode") not in {
                "IBKR_GATEWAY_NOT_CONNECTED", "IBKR_GATEWAY_NOT_AUTHENTICATED"}:
            # The dedicated balance client failing does not prove the shared
            # Gateway is down; only an explicit producer classification does.
            return "IBKR_BALANCE_UNVERIFIED"
        return code if isinstance(code, str) and code in BALANCE_FAILURE_MESSAGES else fallback

    def _request_failure(self, error: Exception) -> dict[str, Any]:
        if isinstance(error, httpx.HTTPStatusError):
            status = error.response.status_code
            try:
                payload = error.response.json()
            except ValueError:
                payload = None
            fallback = "BALANCE_REQUEST_TIMEOUT" if status in {408, 504} else "BALANCE_HTTP_ERROR"
            return self._unavailable(self._response_error_code(payload, fallback), http_status=status)
        if isinstance(error, (httpx.TimeoutException, asyncio.TimeoutError)):
            return self._unavailable("BALANCE_REQUEST_TIMEOUT")
        if isinstance(error, httpx.TransportError):
            return self._unavailable("BALANCE_SERVICE_UNAVAILABLE")
        return self._unavailable()

    async def context(self, *, on_current: Optional[Callable[[dict[str, Any]], Awaitable[None]]] = None) -> dict[str, Any]:
        support_deadline = time.monotonic() + BALANCE_SUPPORT_CAPTURE_BUDGET_SECONDS
        try:
            current = await self._request("/api/portfolio/balance")
        except Exception as error:
            return self._request_failure(error)
        if not self._verified_current_balance(current):
            return self._unavailable(self._response_error_code(current, "BALANCE_VERIFICATION_FAILED"))

        if on_current is not None:
            # Preserve the exact current observation while independently dated
            # supporting evidence is still being acquired. No history, interest,
            # capacity, or missing margin values are filled in here.
            await on_current(envelope(
                status="partial", source_system="market_dashboard", provider="ibkr",
                data={"current": current, "interestStatus": None, "history": None,
                      "policy": {"currentRequiresVerifiedLiveIbkr": True,
                                 "historicalValuesAreDatedReferenceOnly": True,
                                 "historicalPortfolioTotalsAvailable": False,
                                 "liveMtdNetAndDailyGrossDebitAreComparable": False,
                                 "missingValuesMayBeInferred": False, "actionable": False}},
                as_of=current.get("observedAt"), freshness="live_with_dated_verified_history",
                live_verified=True,
            ))

        account_id = str(current["accountId"]).strip()
        encoded_account = quote(account_id, safe="")
        status_read, ledger_read = await asyncio.gather(
            self._read_support(f"/api/ibkr/interest-validation/status?account={encoded_account}",
                               self._verified_interest_status, support_deadline),
            self._read_support(f"/api/ibkr/interest-validation/ledger?account={encoded_account}",
                               lambda value: self._verified_interest_ledger(value, account_id), support_deadline),
        )
        status_result, status_diagnostics = status_read
        ledger_result, ledger_diagnostics = ledger_read
        warnings: list[str] = []
        margin = current.get("margin")
        margin_available = bool(
            isinstance(margin, dict)
            and margin.get("available") is True
            and margin.get("status") == "live"
            and margin.get("source") == "ibkr_live_session"
        )
        if not margin_available:
            warnings.append(
                "Current exposure is verified live, but broker-native margin "
                "evidence is unavailable; margin fields remain unavailable."
            )
        capacity = current.get("capacity")
        capacity_available = bool(
            isinstance(capacity, dict)
            and capacity.get("available") is True
            and capacity.get("status") == "live"
        )
        if not capacity_available:
            capacity_code = (
                str(capacity.get("errorCode") or "").strip()
                if isinstance(capacity, dict)
                else ""
            )
            suffix = f" ({capacity_code})" if capacity_code else ""
            warnings.append(
                "Current exposure is verified live, but capacity reconciliation "
                f"is unavailable{suffix}; cash, settlement, and capacity values "
                "were not inferred."
            )
        interest_status = (
            status_result
            if self._verified_interest_status(status_result)
            else None
        )
        if interest_status is None:
            warnings.append("Verified IBKR interest status is unavailable.")

        history = None
        ledger_available = False
        if self._verified_interest_ledger(ledger_result, account_id):
            ledger_available = ledger_result.get("available") is True
            daily = self._recent_rows(
                [
                    row
                    for row in ledger_result["ledger"]
                    if isinstance(row, dict) and row.get("row_status") != "no_verified_interest_row"
                ],
                key="date",
            )
            observations = self._recent_rows(
                ledger_result["observations"],
                key="observed_at",
            )
            forecasts = self._recent_rows(
                ledger_result["forecasts"],
                key="value_date",
            )
            postings = self._recent_rows(
                ledger_result["postings"],
                key="posted_date",
            )
            formula_audit = self._recent_rows(
                ledger_result["formulaAudit"],
                key="value_date",
            )
            history = {
                "available": ledger_available,
                "status": ledger_result.get("status"),
                "generatedAt": ledger_result.get("generatedAt"),
                "summary": ledger_result.get("summary") or {},
                "daily": daily,
                "observations": observations,
                "forecasts": forecasts,
                "postings": postings,
                "formulaAudit": formula_audit,
                "coverage": {
                    "rowLimitPerSection": BALANCE_HISTORY_ROW_LIMIT,
                    "daily": self._history_range(daily, "date"),
                    "observations": self._history_range(observations, "session_date"),
                    "forecasts": self._history_range(forecasts, "value_date"),
                    "postings": self._history_range(postings, "posted_date"),
                    "formulaAudit": self._history_range(formula_audit, "value_date"),
                },
            }
            if not ledger_available:
                warnings.append("The verified IBKR interest ledger has no historical evidence yet.")
        else:
            warnings.append("Verified IBKR interest-ledger history is unavailable.")

        interest_available = bool(
            interest_status
            and interest_status.get("available") is True
        )
        current_complete = margin_available and capacity_available
        result = envelope(
            status=(
                "available"
                if current_complete and interest_available and ledger_available
                else "partial"
            ),
            source_system="market_dashboard",
            provider="ibkr",
            data={
                "current": current,
                "interestStatus": interest_status,
                "history": history,
                "policy": {
                    "currentRequiresVerifiedLiveIbkr": True,
                    "historicalValuesAreDatedReferenceOnly": True,
                    "historicalPortfolioTotalsAvailable": False,
                    "liveMtdNetAndDailyGrossDebitAreComparable": False,
                    "missingValuesMayBeInferred": False,
                    "actionable": False,
                },
            },
            as_of=current.get("observedAt"),
            freshness="live_with_dated_verified_history",
            live_verified=True,
            warnings=warnings,
        )
        result["supportDiagnostics"] = {"interestStatus": status_diagnostics, "history": ledger_diagnostics}
        return result


class PredictionMarketReader:
    """Fail-closed facade over the dashboard's direct Kalshi/IBKR read pipeline."""

    def __init__(
        self,
        base_url: str = MARKET_DASHBOARD_API_BASE,
        request: Optional[Callable[..., Awaitable[dict[str, Any]]]] = None,
        now: Optional[Callable[[], datetime]] = None,
        monitor_wait_seconds: float = PREDICTION_TIMEOUT_SECONDS,
        monitor_poll_seconds: float = 0.5,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._request_override = request
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._monitor_wait_seconds = max(0, monitor_wait_seconds)
        self._monitor_poll_seconds = max(0.01, monitor_poll_seconds)

    async def _request(self, path: str, *, method: str = "GET") -> dict[str, Any]:
        if self._request_override:
            return await self._request_override(path) if method == "GET" else await self._request_override(path, method=method)
        response = await _shared_client(self.base_url).request(method,
            f"{self.base_url}{path}",
            headers={"Cache-Control": "no-cache", "Pragma": "no-cache"},
            timeout=PREDICTION_TIMEOUT_SECONDS,
            **({"json": {}} if method == "POST" else {}),
        )
        response.raise_for_status()
        if "no-store" not in str(response.headers.get("Cache-Control") or "").lower():
            raise RuntimeError("Prediction-market endpoint did not return a no-store snapshot")
        return response.json()

    @staticmethod
    def _invalid(message: str) -> dict[str, Any]:
        return envelope(
            status="invalid_request",
            source_system="market_dashboard",
            provider="kalshi",
            data={"markets": [], "ladders": {}, "providers": {}, "policy": {}},
            freshness="unavailable",
            warnings=[message],
        )

    async def _monitor_report(self, requested: list[str]) -> dict[str, Any]:
        try:
            payload = await self._request("/api/prediction-market-test/morning-report")
        except Exception as exc:
            return envelope(
                status="unavailable",
                source_system="market_dashboard",
                provider="market_dashboard",
                data={
                    "reportType": "four_market_morning",
                    "marketOrder": requested,
                    "markets": [],
                    "policy": {
                        "currentFieldsMayUseArchiveFallback": False,
                        "recommendationAllowed": False,
                    },
                },
                freshness="unavailable",
                warnings=[f"Four-market current monitor failed: {exc}"],
            )

        market_order = payload.get("marketOrder")
        raw_markets = payload.get("markets")
        if (
            payload.get("reportType") != "four_market_morning"
            or market_order != list(PREDICTION_MONITOR_AREAS)
            or not isinstance(raw_markets, list)
        ):
            return envelope(
                status="unavailable",
                source_system="market_dashboard",
                provider="market_dashboard",
                data={
                    "reportType": "four_market_morning",
                    "marketOrder": requested,
                    "markets": [],
                    "policy": {
                        "currentFieldsMayUseArchiveFallback": False,
                        "recommendationAllowed": False,
                    },
                },
                freshness="unavailable",
                warnings=["The dashboard returned an invalid four-market morning-report contract."],
            )

        by_market = {
            str(row.get("marketId")): row
            for row in raw_markets
            if isinstance(row, dict) and row.get("marketId")
        }
        selected = [by_market[market_id] for market_id in requested if market_id in by_market]
        missing = [market_id for market_id in requested if market_id not in by_market]
        warnings = [str(value) for value in payload.get("warnings") or [] if str(value).strip()]
        if missing:
            warnings.append("The current monitor omitted requested areas: " + ", ".join(missing))
        status = str(payload.get("status") or "unavailable")
        if missing:
            status = "partial" if selected else "unavailable"
        if status not in {"available", "partial", "unavailable"}:
            status = "unavailable"
            warnings.append("The current monitor returned an unknown status and was failed closed.")

        return envelope(
            status=status,
            source_system="market_dashboard",
            provider="market_dashboard",
            data={
                "schemaVersion": payload.get("schemaVersion"),
                "reportType": payload.get("reportType"),
                "generatedAt": payload.get("generatedAt"),
                "asOf": payload.get("asOf"),
                "marketOrder": requested,
                "summary": payload.get("summary") or {},
                "markets": selected,
                "policy": payload.get("policy") or {},
            },
            as_of=payload.get("asOf") or payload.get("generatedAt"),
            freshness="current_monitor" if status != "unavailable" else "unavailable",
            live_verified=False,
            warnings=warnings,
        )

    async def fixed_review_universe(self) -> dict[str, Any]:
        """Read the review universe with explicitly pinned venues.

        This method never requests ``venue=auto`` and never substitutes an
        alternate venue when a pinned source fails.  Individual failures are
        returned beside verified siblings so the deterministic review can
        settle partial within its deadline.
        """

        requested_at = self._now().isoformat().replace("+00:00", "Z")

        async def read_one(market_id: str, asset: str, venue: str) -> dict[str, Any]:
            path = (
                f"/api/prediction-market-test/monitor/{market_id}/refresh"
                f"?venue={venue}&view=review"
            )
            try:
                payload = await asyncio.wait_for(self._request(path, method="POST"), timeout=max(.01, self._monitor_wait_seconds))
                acquisition = payload.get("acquisition") or {}
                requested = _parse_iso(acquisition.get("requestedAt"))
                completed = _parse_iso(acquisition.get("completedAt"))
                acquisition_complete = payload.get("refresh", {}).get("state") == "idle"
                if not acquisition_complete and requested and acquisition.get("scope") == "pinned_native_book":
                    acquisition_complete = self._fresh_pinned_native_acquisition(payload, market_id, venue, requested)
                fresh = (acquisition.get("status") == "complete" and requested and completed and completed >= requested
                         and requested.timestamp() >= _parse_iso(requested_at).timestamp() - .01
                         and _finite_number_or_none(acquisition.get("revision")) is not None
                         and _finite_number_or_none(acquisition.get("previousRevision")) is not None
                         and float(acquisition["revision"]) > float(acquisition["previousRevision"])
                         and payload.get("revision") == acquisition["revision"]
                         and acquisition_complete)
                if not fresh:
                    raise ValueError("Fresh monitor acquisition could not be verified.")
            except Exception as exc:
                return {
                    "marketId": market_id,
                    "asset": asset,
                    "requestedVenue": venue,
                    "status": "unavailable",
                    "errorCode": "PREDICTION_MONITOR_UNAVAILABLE",
                    "error": str(exc),
                    "snapshot": None,
                }
            selected_venue = str(
                payload.get("selectedVenueId")
                or (payload.get("displaySelection") or {}).get("venueId")
                or ""
            ).lower()
            display = payload.get("displayContracts") if isinstance(payload.get("displayContracts"), dict) else {}
            selection = payload.get("displaySelection") if isinstance(payload.get("displaySelection"), dict) else {}
            valid_venue = (selected_venue == venue and str(selection.get("venueId") or venue).lower() == venue
                           and payload.get("marketId", market_id) == market_id)
            current_catalog = bool(
                display.get("status") == "available"
                and display.get("refreshFailed") is not True
                and display.get("cachedOnly") is not True
                and display.get("stale") is not True
                and display.get("refreshRetained") is not True
                and display.get("refreshPending") is not True
            )
            status = "available" if valid_venue and current_catalog else "partial" if valid_venue else "unavailable"
            return {
                "marketId": market_id,
                "asset": asset,
                "requestedVenue": venue,
                "status": status,
                "errorCode": (
                    None if status == "available"
                    else "PINNED_VENUE_DATA_INCOMPLETE" if valid_venue
                    else "PREDICTION_MONITOR_LOADING" if not selected_venue
                    else "PINNED_VENUE_MISMATCH"
                ),
                "error": (None if status == "available" else display.get("reason") or selection.get("reason")
                          or ("The monitor is still refreshing; retry the review shortly." if not selected_venue else "The requested venue did not return a current verified catalog.")),
                "snapshot": payload if valid_venue else None,
            }

        rows = await asyncio.gather(*(
            read_one(market_id, asset, venue)
            for market_id, asset, venue in PREDICTIVE_REVIEW_UNIVERSE
        ))
        available_count = sum(row["status"] == "available" for row in rows)
        overall = (
            "available" if available_count == len(PREDICTIVE_REVIEW_UNIVERSE)
            else "partial" if available_count else "unavailable"
        )
        return envelope(
            status=overall,
            source_system="market_dashboard",
            provider="fixed_prediction_monitor_universe",
            data={
                "requestedAt": requested_at,
                "universe": [
                    {"marketId": market_id, "asset": asset, "venue": venue}
                    for market_id, asset, venue in PREDICTIVE_REVIEW_UNIVERSE
                ],
                "markets": rows,
                "availableCount": available_count,
                "requestedCount": len(PREDICTIVE_REVIEW_UNIVERSE),
                "policy": {
                    "autoVenueAllowed": False,
                    "alternateVenueFallbackAllowed": False,
                    "recommendationsAllowed": False,
                },
            },
            as_of=requested_at,
            freshness="current_monitor" if available_count else "unavailable",
            live_verified=False,
            warnings=[
                f"{row['asset']} / {row['requestedVenue']}: {row['errorCode']}"
                for row in rows if row.get("errorCode")
            ],
        )

    def _fresh_pinned_native_acquisition(self, payload, market_id, venue, requested):
        """Verify fresh native quotes while unrelated monitor work is pending."""
        refresh = payload.get("refresh") or {}
        started = _parse_iso(refresh.get("startedAt"))
        completed = _parse_iso(refresh.get("completedAt"))
        acquired = _parse_iso((payload.get("acquisition") or {}).get("completedAt"))
        display = payload.get("displayContracts") or {}
        selection = payload.get("displaySelection") or {}
        if (refresh.get("state") != "refreshing" or refresh.get("lastError")
                or not started or not completed or started < requested or completed < started
                or payload.get("marketId") != market_id or payload.get("selectedVenueId") != venue
                or selection.get("venueId") != venue or selection.get("status") != "available"
                or acquired != completed or display.get("status") != "available"
                or any(value.get(flag) is True for value in (display, selection)
                       for flag in ("refreshing", "refreshPending", "refreshRetained"))):
            return False
        # Use the same native-price and catalog validation as report rendering.
        # A new monitor revision alone cannot prove a new quote observation.
        current_lines = []
        for line in display.get("lines") or []:
            if not isinstance(line, dict):
                continue
            evidence = (line.get("evidence") or {}).get("quotes") or {}
            observed = _parse_iso(evidence.get("asOf") or line.get("quoteAsOf"))
            if observed and observed >= requested:
                current_lines.append(line)
        proof = prediction_contract_row({
            "marketId": market_id,
            "requestedVenue": venue,
            "snapshot": {
                "marketId": market_id, "selectedVenueId": venue, "displaySelection": selection,
                "displayContracts": {**display, "lines": current_lines},
            },
        }, now=self._now())
        return bool(proof.get("catalogAvailable") and proof.get("quotedLineCount", 0) > 0)

    def _normalize_market(self, row: dict[str, Any], now: datetime) -> Optional[dict[str, Any]]:
        venue = row.get("venue") if isinstance(row.get("venue"), dict) else {}
        observed_at = venue.get("fetchedAt")
        age = _age_at(observed_at, now)
        close_at = _parse_iso(row.get("closeTime"))
        if (
            str(row.get("seriesTicker") or "") not in PREDICTION_SERIES_ALLOWLIST
            or str(venue.get("name") or "").lower() != "kalshi"
            or venue.get("source") != "kalshi_trade_api_v2"
            or venue.get("snapshotType") != "direct_venue"
            or age is None
            or age < -30
            or age > PREDICTION_MAX_AGE_SECONDS
            or close_at is None
            or close_at <= now
            or not row.get("eventTicker")
            or not row.get("marketTicker")
            or _has_forbidden_prediction_quality(row, venue)
            or not _complete_native_book(venue)
        ):
            return None

        raw_ibkr = row.get("ibkr") if isinstance(row.get("ibkr"), dict) else {}
        candidate_ibkr = {**raw_ibkr, "executable": row.get("executable") is True}
        ibkr_verified = _strict_ibkr_prediction_quote(candidate_ibkr, now)
        ibkr = {
            "verified": ibkr_verified,
            "conId": raw_ibkr.get("conId") if ibkr_verified else None,
            "quoteTimestamp": raw_ibkr.get("quoteTimestamp") if ibkr_verified else None,
            "sourceApi": raw_ibkr.get("sourceApi") if ibkr_verified else None,
            "marketDataType": raw_ibkr.get("marketDataType") if ibkr_verified else None,
            "nativeQuoteSide": raw_ibkr.get("nativeQuoteSide") if ibkr_verified else None,
            "nativeBid": raw_ibkr.get("nativeBid") if ibkr_verified else None,
            "nativeAsk": raw_ibkr.get("nativeAsk") if ibkr_verified else None,
            "nativeBidSize": raw_ibkr.get("nativeBidSize") if ibkr_verified else None,
            "nativeAskSize": raw_ibkr.get("nativeAskSize") if ibkr_verified else None,
            "dataQualityFlags": raw_ibkr.get("dataQualityFlags", []) if ibkr_verified else [],
        }
        return {
            "id": row.get("id"),
            "seriesTicker": row.get("seriesTicker"),
            "eventTicker": row.get("eventTicker"),
            "contractId": row.get("marketTicker"),
            "label": row.get("label"),
            "eventTitle": row.get("eventTitle"),
            "contractTitle": row.get("marketTitle"),
            "closeTime": row.get("closeTime"),
            "yesBid": venue.get("yesBid"),
            "yesAsk": venue.get("yesAsk"),
            "yesBidSize": venue.get("yesBidSize"),
            "yesAskSize": venue.get("yesAskSize"),
            "noBid": venue.get("noBid"),
            "noAsk": venue.get("noAsk"),
            "noBidSize": venue.get("noBidSize"),
            "noAskSize": venue.get("noAskSize"),
            "volume24h": venue.get("volume24h"),
            "volumeTotal": venue.get("volumeTotal"),
            "openInterest": venue.get("openInterest"),
            "observedAt": observed_at,
            "updatedAt": venue.get("updatedAt"),
            "source": "kalshi_trade_api_v2",
            "snapshotType": "direct_venue",
            "liveVerified": True,
            "usage": "research_only",
            "ibkr": ibkr,
            "executable": ibkr_verified,
        }

    def _normalize_ladders(
        self,
        payload: dict[str, Any],
        requested: set[str],
        now: datetime,
    ) -> tuple[dict[str, Any], list[str]]:
        markets = payload.get("markets") if isinstance(payload.get("markets"), dict) else {}
        wti = markets.get("wti") if isinstance(markets.get("wti"), dict) else {}
        entries = [markets.get("cpi"), markets.get("spx"), wti.get("daily"), wti.get("weekly")]
        ladders: dict[str, Any] = {}
        warnings: list[str] = []
        for entry in entries:
            if not isinstance(entry, dict) or entry.get("status") != "available":
                if isinstance(entry, dict) and entry.get("error"):
                    warnings.append(str(entry["error"]))
                continue
            summary = entry.get("summary") if isinstance(entry.get("summary"), dict) else {}
            series = str(summary.get("seriesTicker") or "")
            if series not in requested or series not in PREDICTION_LADDER_SERIES:
                continue
            freshness = summary.get("freshness") if isinstance(summary.get("freshness"), dict) else {}
            age = _age_at(freshness.get("fetchedAt"), now)
            close_at = _parse_iso(summary.get("closeTime"))
            if (
                freshness.get("status") != "direct_snapshot"
                or freshness.get("snapshotType") != "direct_venue"
                or age is None
                or age < -30
                or age > PREDICTION_MAX_AGE_SECONDS
                or close_at is None
                or close_at <= now
                or _has_forbidden_prediction_quality(summary, freshness)
            ):
                warnings.append(f"{series or 'Prediction ladder'} was omitted because its direct snapshot was not current.")
                continue
            contracts = []
            for raw in summary.get("lines") or []:
                if not isinstance(raw, dict) or not raw.get("ticker") or not _complete_native_book(raw):
                    continue
                contracts.append(
                    {
                        "contractId": raw.get("ticker"),
                        "label": raw.get("label"),
                        "sortValue": raw.get("sortValue"),
                        "yesBid": raw.get("yesBid"),
                        "yesAsk": raw.get("yesAsk"),
                        "yesBidSize": raw.get("yesBidSize"),
                        "yesAskSize": raw.get("yesAskSize"),
                        "noBid": raw.get("noBid"),
                        "noAsk": raw.get("noAsk"),
                        "noBidSize": raw.get("noBidSize"),
                        "noAskSize": raw.get("noAskSize"),
                        "volume24h": raw.get("volume24h"),
                        "openInterest": raw.get("openInterest"),
                        "liveVerified": True,
                        "usage": "research_only",
                        "executable": False,
                    }
                )
            if not contracts:
                warnings.append(f"{series} ladder was omitted because it had no complete native contract books.")
                continue
            ladders[series] = {
                "seriesTicker": series,
                "eventTicker": summary.get("eventTicker"),
                "eventTitle": summary.get("eventTitle"),
                "closeTime": summary.get("closeTime"),
                "observedAt": freshness.get("fetchedAt"),
                "updatedAt": freshness.get("updatedAt"),
                "contracts": contracts,
            }
        return ladders, warnings

    async def snapshot(
        self,
        series_tickers: Optional[list[str]] = None,
        include_ladders: bool = True,
        market_areas: Optional[list[str]] = None,
        include_market_setups: bool = False,
    ) -> dict[str, Any]:
        # Tool clients may serialize an omitted optional array as ``[]``.
        # Normalize that representation at the provider boundary so a default
        # full snapshot is stable across MCP clients. Non-empty selectors stay
        # mutually exclusive.
        if isinstance(series_tickers, list) and not series_tickers:
            series_tickers = None
        if isinstance(market_areas, list) and not market_areas:
            market_areas = None
        if series_tickers is not None and market_areas is not None:
            return self._invalid("Choose market_areas or series_tickers, not both.")
        if include_market_setups and market_areas is not None:
            return self._invalid(
                "include_market_setups bundles the complete broad-market screen; do not also send market_areas."
            )
        if market_areas is not None:
            if not isinstance(market_areas, list):
                return self._invalid("market_areas must be a list of supported monitor area IDs.")
            requested_areas: list[str] = []
            for raw in market_areas:
                market_area = str(raw or "").strip().lower()
                if market_area not in PREDICTION_MONITOR_AREA_ALLOWLIST:
                    return self._invalid(f"Unknown prediction-market monitor area: {market_area or '<empty>'}")
                if market_area in requested_areas:
                    return self._invalid(f"Duplicate prediction-market monitor area: {market_area}")
                requested_areas.append(market_area)
            return await self._monitor_report(requested_areas)
        if series_tickers is not None and not isinstance(series_tickers, list):
            return self._invalid("series_tickers must be a list of allowlisted Kalshi series tickers.")
        supplied = list(series_tickers) if series_tickers is not None else list(PREDICTION_SERIES_TICKERS)
        if len(supplied) > len(PREDICTION_SERIES_TICKERS):
            return self._invalid(f"At most {len(PREDICTION_SERIES_TICKERS)} series tickers may be requested.")
        requested: list[str] = []
        for raw in supplied:
            ticker = str(raw or "").strip().upper()
            if ticker not in PREDICTION_SERIES_ALLOWLIST:
                return self._invalid(f"Unknown prediction-market series ticker: {ticker or '<empty>'}")
            if ticker not in requested:
                requested.append(ticker)

        if include_market_setups:
            base_snapshot, setup_screen = await asyncio.gather(
                self.snapshot(
                    series_tickers=requested,
                    include_ladders=include_ladders,
                    market_areas=None,
                    include_market_setups=False,
                ),
                self._monitor_report(list(PREDICTION_MONITOR_AREAS)),
            )
            base_data = base_snapshot.get("data")
            if not isinstance(base_data, dict):
                base_data = {}
                base_snapshot["data"] = base_data
            setup_data = setup_screen.get("data")
            base_data["marketSetupScreen"] = {
                "status": setup_screen.get("status") or "unavailable",
                "sourceSystem": setup_screen.get("sourceSystem"),
                "provider": setup_screen.get("provider"),
                "asOf": setup_screen.get("asOf"),
                "freshness": setup_screen.get("freshness") or "unavailable",
                "liveVerified": setup_screen.get("liveVerified") is True,
                "warnings": list(setup_screen.get("warnings") or []),
                **(setup_data if isinstance(setup_data, dict) else {}),
            }
            return base_snapshot

        refresh_requested_at = self._now().astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        watchlist_task = asyncio.create_task(
            self._request("/api/prediction-markets/watchlist?forceRefresh=true")
        )
        overview_task = (
            asyncio.create_task(self._request("/api/prediction-markets/overview?forceRefresh=true"))
            if include_ladders
            else None
        )
        try:
            watchlist = await watchlist_task
        except Exception as exc:
            if overview_task:
                overview_task.cancel()
                await asyncio.gather(overview_task, return_exceptions=True)
            return envelope(
                status="unavailable",
                source_system="market_dashboard",
                provider="kalshi",
                data={
                    "markets": [],
                    "ladders": {},
                    "providers": {},
                    "policy": {},
                    "refreshEvidence": {
                        "mode": "on_demand_prediction_fanout",
                        "requestedAt": refresh_requested_at,
                        "fromCache": False,
                        "blockedBy": "PREDICTION_REFRESH_FAILED",
                    },
                },
                freshness="unavailable",
                warnings=[f"Direct prediction-market snapshot failed: {exc}"],
            )

        now = self._now().astimezone(timezone.utc)
        if watchlist.get("ok") is not True:
            if overview_task:
                overview_task.cancel()
                await asyncio.gather(overview_task, return_exceptions=True)
            return envelope(
                status="unavailable",
                source_system="market_dashboard",
                provider="kalshi",
                data={
                    "markets": [],
                    "ladders": {},
                    "providers": watchlist.get("providers") or {},
                    "policy": {},
                    "refreshEvidence": watchlist.get("refreshEvidence") or {
                        "mode": "on_demand_prediction_fanout",
                        "requestedAt": refresh_requested_at,
                        "fromCache": False,
                        "blockedBy": "PREDICTION_REFRESH_UNAVAILABLE",
                    },
                },
                freshness="unavailable",
                warnings=[str(watchlist.get("error") or "Kalshi direct snapshot was unavailable.")],
            )

        top_providers = watchlist.get("providers") if isinstance(watchlist.get("providers"), dict) else {}
        top_kalshi = top_providers.get("kalshi") if isinstance(top_providers.get("kalshi"), dict) else {}
        if top_kalshi.get("status") != "direct_venue_snapshot" or _has_forbidden_prediction_quality(watchlist, top_kalshi):
            if overview_task:
                overview_task.cancel()
                await asyncio.gather(overview_task, return_exceptions=True)
            return envelope(
                status="unavailable",
                source_system="market_dashboard",
                provider="kalshi",
                data={
                    "markets": [],
                    "ladders": {},
                    "providers": top_providers,
                    "policy": {},
                    "refreshEvidence": watchlist.get("refreshEvidence") or {
                        "mode": "on_demand_prediction_fanout",
                        "requestedAt": refresh_requested_at,
                        "fromCache": False,
                        "blockedBy": "DIRECT_VENUE_ATTESTATION_FAILED",
                    },
                },
                freshness="unavailable",
                warnings=["Kalshi did not identify this response as a direct, no-cache venue snapshot."],
            )

        requested_set = set(requested)
        accepted = []
        seen_series: set[str] = set()
        for raw in watchlist.get("rows") or []:
            if not isinstance(raw, dict) or raw.get("seriesTicker") not in requested_set:
                continue
            normalized = self._normalize_market(raw, now)
            if normalized is not None:
                accepted.append(normalized)
                seen_series.add(str(normalized["seriesTicker"]))

        warnings = []
        for warning in watchlist.get("warnings") or []:
            if isinstance(warning, dict):
                code = f" [{warning.get('code')}]" if warning.get("code") else ""
                warnings.append(f"{warning.get('seriesTicker') or 'Provider'}{code}: {warning.get('message') or 'unavailable'}")
            elif warning:
                warnings.append(str(warning))
        missing = [ticker for ticker in requested if ticker not in seen_series]
        if missing:
            warnings.append(
                "No live row was retained for stale, incomplete, cached, mock, fallback, closed, failed, or missing series: "
                + ", ".join(missing)
            )

        ladders: dict[str, Any] = {}
        if overview_task:
            try:
                overview = await overview_task
                if overview.get("ok") is True:
                    ladders, ladder_warnings = self._normalize_ladders(overview, requested_set, now)
                    warnings.extend(ladder_warnings)
                else:
                    warnings.append(str(overview.get("error") or "Detailed prediction ladders were unavailable."))
            except Exception as exc:
                warnings.append(f"Detailed prediction ladders were unavailable: {exc}")

        raw_providers = top_providers
        raw_ibkr = raw_providers.get("ibkr") if isinstance(raw_providers.get("ibkr"), dict) else {}
        raw_refresh_evidence = (
            watchlist.get("refreshEvidence")
            if isinstance(watchlist.get("refreshEvidence"), dict)
            else {}
        )
        raw_kalshi_evidence = (
            raw_refresh_evidence.get("kalshi")
            if isinstance(raw_refresh_evidence.get("kalshi"), dict)
            else {}
        )
        raw_ibkr_evidence = (
            raw_refresh_evidence.get("ibkr")
            if isinstance(raw_refresh_evidence.get("ibkr"), dict)
            else (
                raw_ibkr.get("refreshEvidence")
                if isinstance(raw_ibkr.get("refreshEvidence"), dict)
                else {}
            )
        )
        verified_ibkr_count = sum(1 for row in accepted if row["executable"])
        providers = {
            "kalshi": {
                "status": "direct_venue_snapshot" if accepted else "unavailable",
                "requestedSeriesCount": len(requested),
                "verifiedContractCount": len(accepted),
                "coverageComplete": not missing,
                "observedAt": min(
                    (row["observedAt"] for row in accepted if row.get("observedAt")),
                    default=None,
                ),
                "refreshEvidence": raw_kalshi_evidence,
            },
            "ibkr": {
                "status": raw_ibkr.get("status") or "unavailable",
                "connected": raw_ibkr.get("connected") is True,
                "authenticated": raw_ibkr.get("authenticated") is True,
                "errorCode": raw_ibkr.get("errorCode"),
                "message": raw_ibkr.get("message"),
                "releaseKey": raw_ibkr.get("releaseKey"),
                "observedAt": raw_ibkr.get("observedAt"),
                "verifiedContractCount": verified_ibkr_count,
                "refreshEvidence": raw_ibkr_evidence,
            },
        }
        policy = {
            "kalshiRowsAreResearchOnly": True,
            "liveVerifiedMeaning": "validated direct Kalshi venue snapshot",
            "executableRequires": "exact IBKR conId + native live market-data type + fresh timestamp + native bid/ask sizes + no forbidden quality flags",
            "archivedResearchMayReplaceCurrentVenueData": False,
            "ordersAvailable": False,
        }
        if not accepted:
            unavailable_refresh_evidence = {
                "mode": "on_demand_prediction_fanout",
                "requestedAt": raw_refresh_evidence.get("requestedAt") or refresh_requested_at,
                "completedAt": raw_refresh_evidence.get("completedAt")
                or self._now().astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                "fromCache": False,
                "kalshi": {
                    **raw_kalshi_evidence,
                    "requestedOutputSeriesCount": len(requested),
                    "verifiedOutputSeriesCount": 0,
                    "missingOutputSeriesCount": len(missing),
                    "missingOutputSeriesTickers": missing,
                    "coverageComplete": False,
                },
                "ibkr": raw_ibkr_evidence,
                "researchCoverageComplete": False,
                "executionCoverageComplete": False,
            }
            return envelope(
                status="unavailable",
                source_system="market_dashboard",
                provider="kalshi",
                data={
                    "markets": [],
                    "ladders": {},
                    "providers": providers,
                    "policy": policy,
                    "refreshEvidence": unavailable_refresh_evidence,
                },
                freshness="unavailable",
                warnings=warnings or ["No direct Kalshi row passed the live-data policy."],
            )

        expected_ladders = requested_set.intersection(PREDICTION_LADDER_SERIES)
        ladder_complete = not include_ladders or expected_ladders.issubset(ladders)
        ibkr_complete = providers["ibkr"]["status"] in {"verified_contracts", "connected"}
        missing_ladders = sorted(expected_ladders.difference(ladders)) if include_ladders else []
        refresh_evidence = {
            "mode": "on_demand_prediction_fanout",
            "requestedAt": raw_refresh_evidence.get("requestedAt") or refresh_requested_at,
            "completedAt": raw_refresh_evidence.get("completedAt")
            or self._now().astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
            "fromCache": False,
            "kalshi": {
                **raw_kalshi_evidence,
                "requestedOutputSeriesCount": len(requested),
                "verifiedOutputSeriesCount": len(accepted),
                "missingOutputSeriesCount": len(missing),
                "missingOutputSeriesTickers": missing,
                "coverageComplete": not missing,
            },
            "ladders": {
                "requestedCount": len(expected_ladders) if include_ladders else 0,
                "verifiedCount": len(expected_ladders.intersection(ladders)) if include_ladders else 0,
                "missingCount": len(missing_ladders),
                "missingSeriesTickers": missing_ladders,
                "coverageComplete": ladder_complete,
                "fromCache": False,
            },
            "ibkr": raw_ibkr_evidence,
            "researchCoverageComplete": not missing and ladder_complete,
            "executionCoverageComplete": ibkr_complete
            and raw_ibkr_evidence.get("coverageComplete") is True,
        }
        status = "available" if not missing and ladder_complete and ibkr_complete else "partial"
        observed_times = [row["observedAt"] for row in accepted if row.get("observedAt")]
        return envelope(
            status=status,
            source_system="market_dashboard",
            provider="kalshi",
            data={
                "markets": accepted,
                "ladders": ladders,
                "providers": providers,
                "policy": policy,
                "requestedSeriesTickers": requested,
                "coverageComplete": not missing and ladder_complete,
                "refreshEvidence": refresh_evidence,
            },
            as_of=min(observed_times) if observed_times else utc_now_iso(),
            freshness="direct_venue_snapshot",
            live_verified=True,
            warnings=warnings,
        )


def verified_live_quote(raw: dict[str, Any], *, max_age_seconds: float = IBKR_QUOTE_MAX_AGE_SECONDS) -> bool:
    if str(raw.get("dataType") or "").lower() != "live":
        return False
    if raw.get("priceState") != "market_mark":
        return False
    if not (_finite_positive(raw.get("last")) or (_finite_positive(raw.get("bid")) and _finite_positive(raw.get("ask")))):
        return False
    entitlement = str(raw.get("entitlementStatus") or "").lower()
    if entitlement in {"", "denied", "not_entitled", "unavailable", "disabled", "offline"}:
        return False
    age = _iso_age_seconds(raw.get("timestamp"))
    return age is not None and -30 <= age <= max_age_seconds


def current_price(raw: dict[str, Any]) -> Optional[float]:
    if not verified_live_quote(raw):
        return None
    if _finite_positive(raw.get("last")):
        return float(raw["last"])
    return (float(raw["bid"]) + float(raw["ask"])) / 2


class IbkrReader:
    def __init__(
        self,
        base_url: str = IBKR_BASE_URL,
        request: Optional[Callable[..., Awaitable[dict[str, Any]]]] = None,
        settlement_base_url: str = MARKET_DASHBOARD_API_BASE,
        settlement_request: Optional[Callable[..., Awaitable[dict[str, Any]]]] = None,
        now: Optional[Callable[[], datetime]] = None,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._request_override = request
        self.settlement_base_url = settlement_base_url.rstrip("/")
        self._settlement_request_override = settlement_request
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._transport = transport

    async def _request(self, path: str, *, method: str = "GET", json_body: Any = None) -> dict[str, Any]:
        if self._request_override:
            return await self._request_override(path, method=method, json_body=json_body)
        response = await _shared_client(self.base_url, self._transport).request(
            method, f"{self.base_url}{path}", json=json_body, timeout=IBKR_TIMEOUT_SECONDS)
        response.raise_for_status()
        return response.json()

    async def _request_settlement_marks(self, positions: list[dict[str, Any]]) -> dict[str, Any]:
        path = "/api/prediction-markets/performance/settlement-marks"
        body = {"positions": positions}
        if self._settlement_request_override:
            return await self._settlement_request_override(path, method="POST", json_body=body)
        # An injected transport (tests) also serves this read; it never reaches the live API.
        response = await _shared_client(self.settlement_base_url, self._transport).post(
            f"{self.settlement_base_url}{path}",
            json=body,
            headers={"Cache-Control": "no-cache", "Pragma": "no-cache"},
            timeout=PREDICTION_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        if "no-store" not in str(response.headers.get("Cache-Control") or "").lower():
            raise RuntimeError("Settlement endpoint did not return a no-store response")
        return response.json()

    async def readiness(self, *, probe: Optional[GatewayProbe] = None) -> dict[str, Any]:
        """Check authenticated socket evidence without acquisition or subscriptions.

        The production request runs on a dedicated thread whose own HTTP timeouts
        enforce the budget, so a stalled event loop cannot turn a prompt answer
        into a timeout. ``probe`` receives that thread's measurements.
        """
        probe = probe or GatewayProbe(IBKR_READINESS_TIMEOUT_SECONDS)
        if self._request_override is None:
            return await self._threaded_readiness(probe)

        async def request():
            payload = await self._request("/gateway-readiness")
            now = self._now()
            return self._readiness_result(payload, requested_at=now, received_at=now,
                                          as_of=payload.get("socket_verified_at"), probe=probe)

        try:
            return await asyncio.wait_for(request(), IBKR_READINESS_TIMEOUT_SECONDS)
        except (httpx.TimeoutException, asyncio.TimeoutError):
            probe.waited = "inner"
            return self._gateway_unavailable("IBKR_GATEWAY_READINESS_TIMEOUT")
        except Exception:
            return self._gateway_unavailable("IBKR_SERVICE_UNAVAILABLE")

    async def _threaded_readiness(self, probe: GatewayProbe) -> dict[str, Any]:
        future = _start_readiness_probe(self.base_url, probe, self._readiness_in_thread)
        if future is None:
            probe.waited = "busy"
            return self._gateway_unavailable("IBKR_GATEWAY_NOT_VERIFIED")
        try:
            return await asyncio.wait_for(asyncio.wrap_future(future), probe.budget_seconds)
        except asyncio.TimeoutError:
            completed = probe.completed()
            if completed is not None:
                return completed
            probe.waited = "inner"
            return self._gateway_unavailable("IBKR_GATEWAY_READINESS_TIMEOUT")
        except Exception:
            return self._gateway_unavailable("IBKR_SERVICE_UNAVAILABLE")

    def _readiness_in_thread(self, probe: GatewayProbe) -> dict[str, Any]:
        """Run one bounded GET off the event loop and record when it answered."""
        received_at = None
        started = time.monotonic()
        shared = probe.request

        def trace(event: str, _info: Any) -> None:
            # Record when the request actually reached the IBKR service.
            if event == "http11.send_request_headers.complete" and shared is not None and shared.sent is None:
                shared.sent = time.monotonic()

        try:
            client = _readiness_client(self.base_url)
            requested_at = self._now()
            started = time.monotonic()
            response = client.get(f"{self.base_url}/gateway-readiness", timeout=probe.budget_seconds,
                                  extensions={"trace": trace})
            io_ms = round((time.monotonic() - started) * 1000)
            received = self._now()
            received_at = received.isoformat().replace("+00:00", "Z")
            response.raise_for_status()
            payload = response.json()
            result = self._readiness_result(payload, requested_at=requested_at, received_at=received,
                                            as_of=received_at, probe=probe)
            probe.bound = probe.bound or "none"
        except httpx.TimeoutException:
            io_ms = round((time.monotonic() - started) * 1000)
            probe.bound = "inner"
            result = self._gateway_unavailable("IBKR_GATEWAY_READINESS_TIMEOUT")
        except Exception:
            io_ms = round((time.monotonic() - started) * 1000)
            probe.bound = "none"
            result = self._gateway_unavailable("IBKR_SERVICE_UNAVAILABLE")
        probe.finish(result, io_ms=io_ms, received_at=received_at)
        return result

    def _readiness_result(self, payload: dict[str, Any], *, requested_at: datetime, received_at: datetime,
                          as_of: Optional[str], probe: GatewayProbe) -> dict[str, Any]:
        verified_at = payload.get("socket_verified_at")
        try:
            observed = datetime.fromisoformat(str(verified_at or "").replace("Z", "+00:00"))
        except (TypeError, ValueError):
            observed = None
        fresh = False
        if observed is not None and observed.tzinfo is not None:
            probe.heartbeat_age_ms = round((received_at - observed).total_seconds() * 1000)
            # The producer may refresh its heartbeat while answering, so it can
            # be newer than the request but never newer than the answer. It must
            # already be current when requested; I/O time cannot age it out.
            fresh = ((received_at - observed).total_seconds() >= -1
                     and (requested_at - observed).total_seconds() <= 16)
        if (payload.get("ok") is not True or payload.get("connected") is not True
                or payload.get("status") != "connected"
                or not verified_current_portfolio_input(payload)
                or any(payload.get(flag) is True for flag in ("cached", "cache", "cachedOnly", "fallback", "inferred"))
                or not fresh):
            code = payload.get("error_code")
            if code == "IBKR_GATEWAY_READINESS_TIMEOUT":
                probe.bound = "producer"
            if code not in IBKR_READINESS_CODES:
                code = "IBKR_GATEWAY_NOT_VERIFIED"
            return self._gateway_unavailable(code)
        return envelope(
            status="available", source_system="ibkr", provider="ibkr",
            data={"connected": True}, as_of=as_of, freshness="live", live_verified=True,
        )

    @staticmethod
    def _gateway_unavailable(code: str) -> dict[str, Any]:
        return {**envelope(
            status="unavailable", source_system="ibkr", provider="ibkr",
            data={"connected": False}, freshness="unavailable",
            warnings=["IB Gateway readiness could not be verified."],
        ), "errorCode": code}

    async def status(self) -> dict[str, Any]:
        try:
            payload = await asyncio.wait_for(self._request("/status"), IBKR_READINESS_TIMEOUT_SECONDS)
            if (payload.get("connected") is not True or payload.get("status") != "connected"
                    or not verified_current_portfolio_input(payload)):
                return {**envelope(
                    status="unavailable",
                    source_system="ibkr",
                    provider="ibkr",
                    data={"connected": False},
                    freshness="unavailable",
                    warnings=[payload.get("message") or "IBKR is disconnected."],
                ), "errorCode": "GATEWAY_UNAVAILABLE"}
            return envelope(
                status="available",
                source_system="ibkr",
                provider="ibkr",
                data={"connected": True, "accounts": payload.get("accounts", [])},
                as_of=payload.get("time"),
                freshness="live",
                live_verified=True,
            )
        except (httpx.TimeoutException, asyncio.TimeoutError):
            return self._gateway_unavailable("IBKR_GATEWAY_READINESS_TIMEOUT")
        except Exception as exc:
            return {**envelope(
                status="unavailable",
                source_system="ibkr",
                provider="ibkr",
                data={"connected": False},
                freshness="unavailable",
                warnings=[f"IBKR sidecar unavailable: {exc}"],
            ), "errorCode": "IBKR_SERVICE_UNAVAILABLE"}

    async def market_snapshot(self, symbols: list[str]) -> dict[str, Any]:
        refresh_requested_at = utc_now_iso()
        normalized = []
        for symbol in symbols:
            value = str(symbol or "").strip().upper()
            if value and value not in normalized:
                normalized.append(value)
        normalized = normalized[:MAX_MARKET_SYMBOLS]
        if not normalized:
            return envelope(
                status="invalid_request",
                source_system="ibkr",
                provider="ibkr",
                data={"quotes": []},
                freshness="unavailable",
                warnings=["At least one ticker is required."],
            )
        # Each returned quote must pass the live gate below; a separate status
        # read would only add a request that can fail on its own.
        try:
            payload = await self._request(
                "/quotes",
                method="POST",
                json_body={
                    "instruments": [
                        {"symbol": symbol, "secType": "STK", "exchange": "SMART", "currency": "USD"}
                        for symbol in normalized
                    ],
                    "forceRefresh": True,
                },
            )
        except Exception as exc:
            return envelope(
                status="unavailable",
                source_system="ibkr",
                provider="ibkr",
                data={"quotes": []},
                freshness="unavailable",
                warnings=[f"Verified IBKR quote request failed: {exc}"],
            )
        accepted = []
        rejected = []
        for raw in payload.get("quotes", []):
            symbol = str(raw.get("symbol") or raw.get("localSymbol") or "").upper()
            if verified_live_quote(raw):
                accepted.append(
                    {
                        "symbol": symbol,
                        "conId": raw.get("conId"),
                        "bid": raw.get("bid"),
                        "ask": raw.get("ask"),
                        "last": raw.get("last"),
                        "price": current_price(raw),
                        "currency": raw.get("currency"),
                        "exchange": raw.get("exchange"),
                        "observedAt": raw.get("timestamp"),
                        "dataType": "live",
                        "entitlementStatus": raw.get("entitlementStatus"),
                    }
                )
            else:
                rejected.append(symbol or "unknown")
        missing = sorted(set(normalized) - {row["symbol"] for row in accepted})
        rejected = sorted(set(rejected + missing))
        warnings = list(payload.get("errors") or [])
        if payload.get("ok") is False and not accepted:
            # The service refused before quoting. Say so without its raw message,
            # and without implying a verified IB Gateway disconnect.
            warnings.append("The IBKR session could not be verified, so no verified quotes were returned.")
        if rejected:
            warnings.append(
                "No current value was returned for non-live, stale, unentitled, or missing quotes: "
                + ", ".join(rejected)
            )
        status = "available" if accepted and not rejected else "partial" if accepted else "unavailable"
        as_of = min((row["observedAt"] for row in accepted if row.get("observedAt")), default=utc_now_iso())
        return envelope(
            status=status,
            source_system="ibkr",
            provider="ibkr",
            data={
                "quotes": accepted,
                "requestedSymbols": normalized,
                "coverageComplete": not rejected,
                "refreshEvidence": {
                    "mode": "on_demand_broker_snapshot",
                    "requestedAt": refresh_requested_at,
                    "completedAt": utc_now_iso(),
                    "brokerSnapshotRequestedCount": len(normalized),
                    "freshMarkCount": len(accepted),
                    "missingMarkCount": len(rejected),
                },
            },
            as_of=as_of,
            freshness="live" if accepted else "unavailable",
            live_verified=bool(accepted),
            warnings=warnings,
        )

    async def open_orders(self) -> dict[str, Any]:
        return await self._request("/portfolio/open-orders")

    async def holdings_context(self) -> dict[str, Any]:
        """Read the broker's current holdings without waiting for quote or P/L work.

        The live-positions read and its payload gate are the only guard. A
        failed holdings request never reports a Gateway connection state.
        """
        try:
            payload = await self._request("/portfolio/live-positions")
        except Exception as error:
            code = self._holdings_failure_code(error)
            return self._holdings_unavailable(HOLDINGS_FAILURE_MESSAGES[code], code)
        return self._holdings_context_from_payload(payload)

    @staticmethod
    def _holdings_failure_code(error: Exception) -> str:
        # Built-in TimeoutError is an OSError, so timeouts are classified first.
        if isinstance(error, (httpx.TimeoutException, asyncio.TimeoutError)):
            return "IBKR_HOLDINGS_TIMEOUT"
        if isinstance(error, httpx.HTTPStatusError):
            if error.response.status_code != 503:
                return "IBKR_HOLDINGS_REQUEST_FAILED"
            try:
                payload = error.response.json()
            except ValueError:
                payload = None
            code = payload.get("error_code") if isinstance(payload, dict) else None
            # The positions service reports its own bounded broker waits.
            return ("IBKR_HOLDINGS_TIMEOUT"
                    if code in {"IBKR_POSITIONS_REQUEST_TIMEOUT", "IBKR_SOCKET_VERIFICATION_TIMEOUT"}
                    else "IBKR_HOLDINGS_SERVICE_UNAVAILABLE")
        if isinstance(error, (httpx.TransportError, OSError)):
            return "IBKR_HOLDINGS_SERVICE_UNAVAILABLE"
        return "IBKR_HOLDINGS_REQUEST_FAILED"

    @staticmethod
    def _holdings_unavailable(message: str, code: str = "IBKR_HOLDINGS_UNVERIFIED") -> dict[str, Any]:
        return {**envelope(
            status="unavailable", source_system="ibkr", provider="ibkr",
            data={"accounts": [], "positions": []}, freshness="unavailable",
            warnings=[message],
        ), "errorCode": code}

    def _holdings_context_from_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Project the exact fresh broker read without carrying any mark fields."""
        def verified(value: dict[str, Any]) -> bool:
            return (
                verified_current_portfolio_input(value)
                and not any(value.get(flag) is True for flag in (
                    "cached", "cachedOnly", "synthetic", "inferred", "fallback", "refreshFailed",
                ))
                and not any(str(value.get(key) or "").lower() in {
                    "cached", "synthetic", "inferred", "fallback",
                } for key in ("status", "freshness", "source", "provider"))
                and all(verified(value[key]) for key in ("metadata", "provenance")
                        if isinstance(value.get(key), dict))
            )

        observed = payload.get("positions_observed_at") or payload.get("observed_at")
        age = _age_at(observed, self._now())
        accounts = payload.get("accounts")
        rows = payload.get("positions")
        if (
            payload.get("ok") is not True or payload.get("connected") is not True
            or payload.get("status") != "live" or payload.get("source") != "ibkr_live_session"
            or payload.get("from_cache") is not False
            or not verified(payload)
            or age is None or not -30 <= age <= IBKR_HOLDINGS_MAX_AGE_SECONDS
            or not isinstance(accounts, list) or not accounts or not all(accounts)
            or not isinstance(rows, list)
        ):
            return self._holdings_unavailable("Fresh IBKR holdings could not be verified.")
        positions = []
        for row in rows:
            if (
                not isinstance(row, dict) or not verified(row)
                or row.get("account") not in accounts or not row.get("symbol")
                or _finite_number_or_none(row.get("position")) is None
            ):
                return self._holdings_unavailable("Fresh IBKR holdings were incomplete or unverified.")
            quantity = _finite_number_or_none(row["position"])
            if quantity == 0:
                continue
            positions.append({
                "account": row["account"], "symbol": row["symbol"],
                "localSymbol": row.get("localSymbol"), "conId": row.get("conId"),
                "quantity": quantity,
                "currency": row.get("currency"),
                "instrumentCategory": _position_instrument_category(
                    str(row.get("secType") or "").upper(),
                    str(row.get("exchange") or "").upper(),
                ),
            })
        return envelope(
            status="available", source_system="ibkr", provider="ibkr",
            data={"accounts": list(accounts), "positions": positions, "coverageComplete": True},
            as_of=observed, freshness="live", live_verified=True,
        )

    async def portfolio_context(
        self, *, on_holdings: Optional[Callable[[dict[str, Any]], Awaitable[None]]] = None,
    ) -> dict[str, Any]:
        refresh_requested_at = utc_now_iso()
        refresh_started = time.perf_counter()
        # The live-positions read and its payload gate are the only guard; a
        # failed read is a holdings failure, never a Gateway connection state.
        try:
            positions_payload = await self._request("/portfolio/live-positions")
        except Exception as exc:
            return {**envelope(
                status="unavailable",
                source_system="ibkr",
                provider="ibkr",
                data={"accounts": [], "positions": [], "accountSummaries": [], "pnl": []},
                freshness="unavailable",
                warnings=[f"Fresh IBKR positions were unavailable: {exc}"],
            ), "errorCode": self._holdings_failure_code(exc)}
        if positions_payload.get("ok") is not True or positions_payload.get("source") != "ibkr_live_session" or not verified_current_portfolio_input(positions_payload):
            return {**envelope(
                status="unavailable",
                source_system="ibkr",
                provider="ibkr",
                data={"accounts": [], "positions": [], "accountSummaries": [], "pnl": []},
                freshness="unavailable",
                warnings=[positions_payload.get("message") or "Fresh IBKR positions could not be verified."],
            ), "errorCode": "IBKR_HOLDINGS_UNVERIFIED"}
        accounts = [str(value) for value in positions_payload.get("accounts", []) if value]
        raw_positions = [
            row
            for row in positions_payload.get("positions") or []
            if _finite_number_or_none(row.get("position")) not in {None, 0.0}
        ][:200]
        position_snapshot_duration_ms = round((time.perf_counter() - refresh_started) * 1000)
        if on_holdings is not None:
            holdings = self._holdings_context_from_payload(positions_payload)
            if holdings.get("liveVerified") is True:
                # Publish this same verified position read before quote, P/L,
                # and settlement work. The callback receives no valuation,
                # average-cost, or inferred price fields.
                await on_holdings(holdings)
        valuation_deadline = time.monotonic() + PORTFOLIO_VALUATION_BUDGET_SECONDS

        def valuation_remaining() -> float:
            return valuation_deadline - time.monotonic()

        settlement_candidates = [
            row for row in raw_positions
            if _forecastex_settlement_probe_candidate(row, self._now())
        ]
        broker_settlement_skip_candidates = [
            row for row in settlement_candidates
            if _expired_forecastex_contract(row, self._now())
        ]
        broker_settlement_skip_con_ids = {
            int(row["conId"])
            for row in broker_settlement_skip_candidates
            if row.get("conId") is not None
        }
        settlement_request_rows = [
            {
                "symbol": row.get("symbol"),
                "localSymbol": row.get("localSymbol"),
                "contractKey": row.get("localSymbol"),
                "conId": row.get("conId"),
                "secType": row.get("secType"),
                "exchange": row.get("exchange"),
                "contractRight": row.get("right"),
                "contractSide": _normalized_event_contract_side(
                    row.get("localSymbol"), row.get("right")
                ),
                "expiration": row.get("lastTradeDateOrContractMonth"),
                "strike": row.get("strike"),
            }
            for row in settlement_candidates
        ]
        settlement_started = time.perf_counter()
        settlement_task = (
            asyncio.create_task(self._request_settlement_marks(settlement_request_rows))
            if settlement_request_rows
            else None
        )

        async def safe_account_request(path: str) -> Any:
            try:
                return await self._request(path)
            except Exception as exc:
                return exc

        async def request_account_context(account: str) -> tuple[str, Any, Any]:
            summary_result, pnl_result = await asyncio.gather(
                safe_account_request(f"/portfolio/live-account-summary?account={account}"),
                safe_account_request(f"/portfolio/pnl?account={account}"),
            )
            return account, summary_result, pnl_result

        # Account context does not depend on marks; it runs beside them under
        # the same budget rather than after the slowest quote batch.
        account_task = asyncio.gather(
            *(request_account_context(account) for account in accounts)
        )
        budget_exhausted_con_ids: set[int] = set()
        quote_inputs = []
        for row in raw_positions:
            if row.get("conId") is not None and int(row["conId"]) in broker_settlement_skip_con_ids:
                continue
            quote_inputs.append(
                {
                    "symbol": row.get("symbol"),
                    "conId": row.get("conId"),
                    "secType": row.get("secType"),
                    "exchange": row.get("exchange") or "SMART",
                    "currency": row.get("currency") or "USD",
                    "localSymbol": row.get("localSymbol"),
                    "lastTradeDateOrContractMonth": row.get("lastTradeDateOrContractMonth"),
                    "tradingClass": row.get("tradingClass"),
                    "multiplier": row.get("multiplier"),
                }
            )
        async def request_quote_batches(
            inputs: list[dict[str, Any]],
            *,
            force_refresh: bool = False,
        ) -> tuple[list[dict[str, Any]], list[str]]:
            batch_quotes: list[dict[str, Any]] = []
            batch_warnings: list[str] = []
            batches = [
                inputs[offset : offset + MAX_MARKET_SYMBOLS]
                for offset in range(0, len(inputs), MAX_MARKET_SYMBOLS)
            ]
            semaphore = asyncio.Semaphore(MAX_QUOTE_BATCH_CONCURRENCY)

            async def request_batch(batch: list[dict[str, Any]]) -> Any:
                async with semaphore:
                    try:
                        remaining = valuation_remaining()
                        if remaining <= 0:
                            raise asyncio.TimeoutError()
                        return await asyncio.wait_for(self._request(
                            "/quotes",
                            method="POST",
                            json_body={
                                "instruments": batch,
                                "forceRefresh": force_refresh,
                            },
                        ), remaining)
                    except asyncio.TimeoutError:
                        # Unanswered marks stay withheld; this is not a
                        # holdings, Gateway, or per-contract quote failure.
                        budget_exhausted_con_ids.update(
                            int(row["conId"]) for row in batch if row.get("conId") is not None
                        )
                        return None
                    except Exception as exc:
                        return exc

            for quote_payload in await asyncio.gather(
                *(request_batch(batch) for batch in batches)
            ):
                if quote_payload is None:
                    continue
                if isinstance(quote_payload, Exception):
                    batch_warnings.append(f"Position quote batch failed: {quote_payload}")
                    continue
                try:
                    batch_quotes.extend(quote_payload.get("quotes") or [])
                    batch_warnings.extend(quote_payload.get("errors") or [])
                except Exception as exc:
                    batch_warnings.append(f"Position quote batch failed: {exc}")
            return batch_quotes, batch_warnings

        # An on-demand Analyst read must actually ping IBKR for the full book.
        # Snapshot every contract first; reading retained streams can let marks
        # cross the freshness boundary while slower instruments are retried.
        initial_quote_started = time.perf_counter()
        raw_quotes, quote_warnings = await request_quote_batches(
            quote_inputs,
            force_refresh=True,
        )
        initial_quote_duration_ms = round((time.perf_counter() - initial_quote_started) * 1000)
        first_verified_con_ids = {
            int(row["conId"])
            for row in raw_quotes
            if row.get("conId") is not None and verified_live_quote(row)
        }
        retry_inputs = [
            row
            for row in quote_inputs
            if row.get("conId") is None or int(row["conId"]) not in first_verified_con_ids
        ] if valuation_remaining() >= PORTFOLIO_VALUATION_RETRY_MIN_SECONDS else []
        retry_quote_started = time.perf_counter()
        if retry_inputs:
            # Retry only contracts that did not produce a verified live mark on
            # the full-book snapshot pass. Both attempts remain broker reads.
            retry_quotes, retry_warnings = await request_quote_batches(
                retry_inputs,
                force_refresh=True,
            )
            raw_quotes.extend(retry_quotes)
            quote_warnings.extend(retry_warnings)
        retry_quote_duration_ms = round((time.perf_counter() - retry_quote_started) * 1000)
        settlement_payload: dict[str, Any] = {"status": "available", "rows": []}
        if settlement_task is not None:
            try:
                settlement_payload = await asyncio.wait_for(settlement_task, max(0.0, valuation_remaining()))
            except Exception:
                settlement_payload = {"status": "unavailable", "rows": []}
        settlement_duration_ms = (
            round((time.perf_counter() - settlement_started) * 1000)
            if settlement_task is not None
            else 0
        )
        settlement_rows_by_contract = {
            int(row["conId"]): row
            for row in settlement_payload.get("rows") or []
            if row.get("conId") is not None
        }
        quotes_by_contract = {
            int(row["conId"]): row
            for row in raw_quotes
            if row.get("conId") is not None and verified_live_quote(row)
        }
        latest_quote_attempt_by_contract = {
            int(row["conId"]): row
            for row in raw_quotes
            if row.get("conId") is not None
        }
        initial_fresh_mark_count = sum(
            1
            for row in quote_inputs
            if row.get("conId") is not None and int(row["conId"]) in first_verified_con_ids
        )
        recovered_after_retry_count = sum(
            1
            for row in quote_inputs
            if row.get("conId") is not None
            and int(row["conId"]) in quotes_by_contract
            and int(row["conId"]) not in first_verified_con_ids
        )
        quote_observed_times = sorted(
            str(row.get("timestamp"))
            for row in quotes_by_contract.values()
            if row.get("timestamp")
        )
        quote_errors_by_label: dict[str, str] = {}
        for warning in quote_warnings:
            label, separator, detail = str(warning).partition(":")
            if separator and label.strip():
                quote_errors_by_label[label.strip().upper()] = detail.strip() or "quote_unavailable"
        positions = []
        missing_quote_marks = []
        missing_valuations = []
        awaiting_settlements = []
        verified_settlements = []
        resolver_determined_outcomes = []
        quote_input_con_ids = {
            int(row["conId"])
            for row in quote_inputs
            if row.get("conId") is not None
        }
        for row in raw_positions:
            con_id = int(row["conId"]) if row.get("conId") is not None else None
            quote = quotes_by_contract.get(con_id)
            quote_attempt = latest_quote_attempt_by_contract.get(con_id, {})
            settlement = settlement_rows_by_contract.get(con_id, {})
            settlement_status = str(settlement.get("status") or "").strip().lower()
            is_settlement_candidate = bool(
                con_id in broker_settlement_skip_con_ids
                or settlement_status in {
                    "verified_settlement",
                    "resolver_determined",
                    "awaiting_settlement",
                }
            )
            mark = current_price(quote) if quote else None
            if con_id in quote_input_con_ids and mark is None:
                missing_quote_marks.append(
                    str(row.get("localSymbol") or row.get("symbol") or con_id)
                )
            quantity = float(row.get("position") or 0)
            avg_cost = _finite_number_or_none(row.get("avgCost"))
            cost_basis = abs(quantity) * avg_cost if avg_cost is not None else None
            sec_type = str(quote_attempt.get("secType") or row.get("secType") or "").strip().upper()
            contract_exchange = str(
                quote_attempt.get("exchange") or row.get("exchange") or ""
            ).strip().upper() or None
            contract_expiration = (
                quote_attempt.get("lastTradeDateOrContractMonth")
                or row.get("lastTradeDateOrContractMonth")
            )
            contract_strike = _finite_number_or_none(
                quote_attempt.get("strike")
                if quote_attempt.get("strike") is not None
                else row.get("strike")
            )
            contract_multiplier = _positive_number_or_none(
                quote_attempt.get("multiplier")
                if quote_attempt.get("multiplier") is not None
                else row.get("multiplier")
            )
            contract_right = str(
                quote_attempt.get("right") or row.get("right") or ""
            ).strip().upper() or None
            contract_local_symbol = (
                quote_attempt.get("localSymbol") or row.get("localSymbol")
            )
            instrument_category = (
                "event_contract"
                if is_settlement_candidate
                else _position_instrument_category(sec_type, contract_exchange)
            )
            option_type = None
            if instrument_category == "listed_option":
                option_type = (
                    "CALL" if contract_right in {"C", "CALL"}
                    else "PUT" if contract_right in {"P", "PUT"}
                    else None
                )
            event_contract_side = (
                _normalized_event_contract_side(contract_local_symbol, contract_right)
                if instrument_category == "event_contract"
                else None
            )
            valuation_multiplier = (
                contract_multiplier
                if instrument_category in {"listed_option", "event_contract"}
                else contract_multiplier or 1.0
            )
            market_value = (
                quantity * mark * valuation_multiplier
                if mark is not None and valuation_multiplier is not None
                else None
            )
            unrealized_pnl_estimate = None
            if mark is not None and avg_cost is not None and instrument_category == "event_contract" and contract_multiplier == 1.0:
                unrealized_pnl_estimate = quantity * (mark - avg_cost)
            elif mark is not None and avg_cost is not None and instrument_category == "other":
                unrealized_pnl_estimate = quantity * (mark - avg_cost)
            settlement_price = _finite_number_or_none(settlement.get("settlementPrice"))
            official_settlement_verified = bool(
                is_settlement_candidate
                and settlement_status == "verified_settlement"
                and settlement_price in {0.0, 1.0}
            )
            resolver_outcome_price = _finite_number_or_none(
                settlement.get("valuationPrice")
            )
            resolver_window_high = _finite_number_or_none(
                settlement.get("resolverWindowHigh")
            )
            resolver_window_low = _finite_number_or_none(
                settlement.get("resolverWindowLow")
            )
            resolver_yes_outcome = (
                True
                if contract_strike is not None
                and resolver_window_low is not None
                and resolver_window_low > contract_strike
                else False
                if contract_strike is not None
                and resolver_window_high is not None
                and resolver_window_high <= contract_strike
                else None
            )
            expected_resolver_price = (
                1.0
                if resolver_yes_outcome is not None
                and (
                    (event_contract_side == "YES" and resolver_yes_outcome)
                    or (event_contract_side == "NO" and not resolver_yes_outcome)
                )
                else 0.0
                if resolver_yes_outcome is not None
                and event_contract_side in {"YES", "NO"}
                else None
            )
            resolver_outcome_verified = bool(
                is_settlement_candidate
                and settlement_status == "resolver_determined"
                and resolver_outcome_price in {0.0, 1.0}
                and resolver_outcome_price == expected_resolver_price
                and settlement.get("valuationSource") == "ibkr_exact_cutoff_bar"
                and settlement.get("resolverProvenance")
                == "verified_ibkr_historical_trade_bar"
                and settlement.get("finalSettlementPending") is True
                and _parse_iso(settlement.get("valuationObservedAt")) is not None
                and _parse_iso(settlement.get("resolverCutoffAt")) is not None
            )
            valuation_basis = "live_ibkr" if mark is not None else "unavailable"
            valuation_price = mark
            valuation_pnl = unrealized_pnl_estimate
            if official_settlement_verified:
                valuation_basis = "official_settlement"
                valuation_price = settlement_price
                if quantity > 0 and contract_multiplier == 1.0:
                    market_value = quantity * settlement_price
                    valuation_pnl = (
                        market_value - cost_basis
                        if cost_basis is not None
                        else None
                    )
                    valuation_status = (
                        "official_settlement_with_pnl"
                        if valuation_pnl is not None
                        else "official_settlement_and_value"
                    )
                else:
                    market_value = None
                    valuation_pnl = None
                    valuation_status = "official_settlement_price_only"
                verified_settlements.append(
                    str(row.get("localSymbol") or row.get("symbol") or con_id)
                )
            elif resolver_outcome_verified:
                valuation_basis = "resolver_determined"
                valuation_price = resolver_outcome_price
                if quantity > 0 and contract_multiplier == 1.0:
                    market_value = quantity * resolver_outcome_price
                    valuation_pnl = (
                        market_value - cost_basis
                        if cost_basis is not None
                        else None
                    )
                    valuation_status = (
                        "resolver_outcome_with_pnl"
                        if valuation_pnl is not None
                        else "resolver_outcome_and_value"
                    )
                else:
                    market_value = None
                    valuation_pnl = None
                    valuation_status = "resolver_outcome_price_only"
                resolver_determined_outcomes.append(
                    str(row.get("localSymbol") or row.get("symbol") or con_id)
                )
            elif is_settlement_candidate:
                valuation_status = "awaiting_official_settlement"
                awaiting_settlements.append(
                    str(row.get("localSymbol") or row.get("symbol") or con_id)
                )
            elif mark is None:
                valuation_status = "unavailable"
            elif market_value is None:
                valuation_status = "live_mark_only"
            elif unrealized_pnl_estimate is None:
                valuation_status = "live_mark_and_value"
            else:
                valuation_status = "live_mark_with_estimate"
            result = {
                "account": row.get("account"),
                "symbol": quote_attempt.get("symbol") or row.get("symbol"),
                "localSymbol": contract_local_symbol,
                "conId": con_id,
                "secType": sec_type or None,
                "instrumentCategory": instrument_category,
                "contractExchange": contract_exchange,
                "contractExpiration": contract_expiration,
                "contractStrike": contract_strike,
                "contractMultiplier": contract_multiplier,
                "contractRight": contract_right,
                "optionType": option_type,
                "eventContractSide": event_contract_side,
                "tradingClass": quote_attempt.get("tradingClass") or row.get("tradingClass"),
                "currency": quote_attempt.get("currency") or row.get("currency"),
                "quantity": quantity,
                "averageCost": avg_cost,
                "costBasis": cost_basis,
                "currentPrice": mark,
                "valuationPrice": valuation_price,
                "marketValue": market_value,
                "unrealizedPnlEstimate": unrealized_pnl_estimate,
                "valuationPnl": valuation_pnl,
                "valuationBasis": valuation_basis,
                "valuationStatus": valuation_status,
                "valuationSource": (
                    settlement.get("settlementSource")
                    if official_settlement_verified
                    else settlement.get("valuationSource")
                    if resolver_outcome_verified
                    else "ibkr_broker_snapshot" if mark is not None else None
                ),
                "quoteObservedAt": quote.get("timestamp") if quote else None,
                "quoteObservationMode": quote_attempt.get("observationMode"),
                "quoteDataType": quote_attempt.get("dataType"),
                "quotePriceState": quote_attempt.get("priceState"),
                "currentValuesLiveVerified": mark is not None,
                "portfolioWeightVerified": bool(
                    quote and _finite_positive(quote.get("last"))
                    and verified_current_portfolio_input(quote)
                    and verified_current_portfolio_input(row)
                ),
                "currentValuesOfficialSettlementVerified": official_settlement_verified,
                "currentValuesResolverVerified": resolver_outcome_verified,
                "settlementPrice": settlement_price if official_settlement_verified else None,
                "settlementSource": settlement.get("settlementSource") if official_settlement_verified else None,
                "settlementObservedAt": settlement.get("settlementObservedAt") if official_settlement_verified else None,
                "settlementDataDate": settlement.get("settlementDataDate") if official_settlement_verified else None,
                "settlementDate": settlement.get("settlementDate") if official_settlement_verified else None,
                "resolverOutcomePrice": (
                    resolver_outcome_price if resolver_outcome_verified else None
                ),
                "resolverValue": (
                    settlement.get("resolverValue") if resolver_outcome_verified else None
                ),
                "resolverSymbol": (
                    settlement.get("resolverSymbol") if resolver_outcome_verified else None
                ),
                "resolverObservedAt": (
                    settlement.get("valuationObservedAt")
                    if resolver_outcome_verified else None
                ),
                "resolverCutoffAt": (
                    settlement.get("resolverCutoffAt")
                    if resolver_outcome_verified else None
                ),
                "officialSettlementPending": resolver_outcome_verified,
                "markStatus": (
                    "verified_official_settlement"
                    if official_settlement_verified
                    else "verified_resolver_outcome" if resolver_outcome_verified
                    else "awaiting_official_settlement" if is_settlement_candidate
                    else "fresh_live_ibkr" if mark is not None
                    else "unavailable_after_broker_snapshot"
                ),
            }
            if official_settlement_verified:
                result["markUnavailableReason"] = None
            elif resolver_outcome_verified:
                result["markUnavailableReason"] = None
            elif is_settlement_candidate:
                result["markUnavailableReason"] = "awaiting_official_settlement"
            elif mark is None:
                missing_label = str(row.get("localSymbol") or row.get("symbol") or con_id)
                missing_valuations.append(missing_label)
                error_candidates = (row.get("symbol"), row.get("localSymbol"), con_id)
                result["markUnavailableReason"] = next(
                    (
                        quote_errors_by_label[str(candidate).strip().upper()]
                        for candidate in error_candidates
                        if candidate is not None
                        and str(candidate).strip().upper() in quote_errors_by_label
                    ),
                    VALUATION_BUDGET_EXHAUSTED
                    if con_id in budget_exhausted_con_ids
                    else "no_fresh_live_ibkr_mark_after_broker_snapshot",
                )
            else:
                result["markUnavailableReason"] = None
            positions.append(result)
        summaries = []
        pnl_rows = []
        missing_error_labels = {
            str(value).strip().upper()
            for row in positions
            if row.get("markStatus") == "unavailable_after_broker_snapshot"
            for value in (row.get("symbol"), row.get("localSymbol"), row.get("conId"))
            if value is not None and str(value).strip()
        }
        warnings = []
        for warning in quote_warnings:
            text = str(warning)
            label, separator, _detail = text.partition(":")
            if (
                separator
                and not text.startswith("Position quote batch failed:")
                and label.strip().upper() not in missing_error_labels
            ):
                continue
            if text not in warnings:
                warnings.append(text)
        budget_exhausted_labels = [
            str(row.get("localSymbol") or row.get("symbol") or row.get("conId"))
            for row in positions
            if row.get("markUnavailableReason") == VALUATION_BUDGET_EXHAUSTED
        ]
        if budget_exhausted_labels:
            warnings.append(
                f"IBKR returned no live marks within the {PORTFOLIO_VALUATION_BUDGET_SECONDS:g}-second valuation budget; "
                "the verified holdings were kept and these valuations were withheld: "
                + ", ".join(budget_exhausted_labels[:30])
            )
        try:
            account_results = await asyncio.wait_for(account_task, max(0.0, valuation_remaining()))
        except asyncio.TimeoutError:
            expired = asyncio.TimeoutError("the valuation budget expired")
            account_results = [(account, expired, expired) for account in accounts]
        for account, summary, pnl in account_results:
            if isinstance(summary, Exception):
                warnings.append(f"Account summary unavailable for {account}: {summary}")
            elif summary.get("ok") is True and summary.get("source") == "ibkr_live_session" and verified_current_portfolio_input(summary):
                summaries.append({"account": account, "summary": summary.get("summary"), "observedAt": summary.get("observed_at")})
            else:
                warnings.append(summary.get("message") or f"Account summary unavailable for {account}.")

            if isinstance(pnl, Exception):
                warnings.append(f"PnL unavailable for {account}: {pnl}")
            elif pnl.get("ok") is True and pnl.get("source") == "ibkr_live_session":
                pnl_rows.append({"account": account, "pnl": pnl.get("pnl"), "observedAt": pnl.get("observed_at")})
            else:
                warnings.append(pnl.get("message") or f"PnL unavailable for {account}.")
        if missing_valuations:
            warnings.append(
                "The dashboard withheld valuations where neither a fresh live IBKR mark, verified resolver outcome, nor verified official settlement was available: "
                + ", ".join(missing_valuations[:30])
            )
        refresh_completed_at = utc_now_iso()
        missing_positions = [
            row for row in positions
            if row.get("markStatus") == "unavailable_after_broker_snapshot"
        ]
        missing_by_security_type: dict[str, int] = {}
        missing_by_exchange: dict[str, int] = {}
        missing_by_expiration: dict[str, int] = {}
        for row in missing_positions:
            security_type = str(row.get("secType") or "unknown")
            exchange = str(row.get("contractExchange") or "unknown")
            expiration = str(row.get("contractExpiration") or "unknown")
            missing_by_security_type[security_type] = missing_by_security_type.get(security_type, 0) + 1
            missing_by_exchange[exchange] = missing_by_exchange.get(exchange, 0) + 1
            missing_by_expiration[expiration] = missing_by_expiration.get(expiration, 0) + 1
        complete = (
            not missing_valuations
            and not awaiting_settlements
            and len(summaries) == len(accounts)
            and len(pnl_rows) == len(accounts)
        )
        total_refresh_duration_ms = round((time.perf_counter() - refresh_started) * 1000)
        raw_live_mark_count = sum(
            1 for row in positions if row.get("currentValuesLiveVerified") is True
        )
        live_mark_count = sum(
            1 for row in positions if row.get("valuationBasis") == "live_ibkr"
        )
        verified_settlement_count = sum(
            1 for row in positions
            if row.get("currentValuesOfficialSettlementVerified") is True
        )
        resolver_determined_count = sum(
            1 for row in positions
            if row.get("currentValuesResolverVerified") is True
        )
        return envelope(
            status="available" if complete else "partial",
            source_system="ibkr",
            provider="ibkr",
            data={
                "accounts": accounts,
                "positions": positions,
                "accountSummaries": summaries,
                "pnl": pnl_rows,
                "coverageComplete": complete,
                "positionValuationCoverageComplete": (
                    not missing_valuations and not awaiting_settlements
                ),
                "quoteCoverage": {
                    "positionCount": len(positions),
                    "quoteEligiblePositionCount": len(quote_inputs),
                    "freshMarkCount": raw_live_mark_count,
                    "missingMarkCount": len(missing_quote_marks),
                    "skippedForSettlementCount": len(broker_settlement_skip_candidates),
                    "initialFreshMarkCount": initial_fresh_mark_count,
                    "brokerSnapshotRequestedCount": len(quote_inputs),
                    "brokerSnapshotRetryCount": len(retry_inputs),
                    "brokerSnapshotAttemptCount": len(quote_inputs) + len(retry_inputs),
                    "brokerSnapshotRecoveredCount": recovered_after_retry_count,
                    "recoveredAfterRetryCount": recovered_after_retry_count,
                    "coverageComplete": not missing_quote_marks,
                    "asOf": quote_observed_times[0] if quote_observed_times else None,
                    "missingBySecurityType": missing_by_security_type,
                    "missingByExchange": missing_by_exchange,
                    "missingByExpiration": missing_by_expiration,
                },
                "valuationCoverage": {
                    "positionCount": len(positions),
                    "valuedCount": live_mark_count + verified_settlement_count + resolver_determined_count,
                    "liveMarkCount": live_mark_count,
                    "verifiedSettlementCount": verified_settlement_count,
                    "resolverDeterminedCount": resolver_determined_count,
                    "awaitingSettlementCount": len(awaiting_settlements),
                    "missingCount": len(missing_valuations),
                    "missingContracts": sorted(set(missing_valuations)),
                    "awaitingSettlementContracts": sorted(set(awaiting_settlements)),
                    "settledContracts": sorted(set(verified_settlements)),
                    "resolverDeterminedContracts": sorted(set(resolver_determined_outcomes)),
                    "coverageComplete": not missing_valuations and not awaiting_settlements,
                },
                "refreshEvidence": {
                    "mode": "on_demand_live_fanout",
                    "requestedAt": refresh_requested_at,
                    "completedAt": refresh_completed_at,
                    "positionSnapshotRequested": True,
                    "positionSnapshotSource": positions_payload.get("position_source") or "ibkr_live_session",
                    "brokerSnapshotRequestedCount": len(quote_inputs),
                    "brokerSnapshotRetryCount": len(retry_inputs),
                    "brokerSnapshotAttemptCount": len(quote_inputs) + len(retry_inputs),
                    "brokerSnapshotRecoveredCount": recovered_after_retry_count,
                    "brokerSnapshotSkippedForSettlementCount": len(broker_settlement_skip_candidates),
                    "officialSettlementRequestedCount": len(settlement_request_rows),
                    "officialSettlementVerifiedCount": verified_settlement_count,
                    "resolverDeterminedCount": resolver_determined_count,
                    "accountSummaryRequestedCount": len(accounts),
                    "pnlRequestedCount": len(accounts),
                    "durationMs": {
                        "positionSnapshot": position_snapshot_duration_ms,
                        "initialBrokerQuotes": initial_quote_duration_ms,
                        "brokerRetry": retry_quote_duration_ms,
                        "officialSettlement": settlement_duration_ms,
                        "total": total_refresh_duration_ms,
                    },
                    "coverageComplete": complete,
                },
                "calculationNotes": [
                    "Average cost is broker-reported; cost basis is the absolute live position quantity multiplied by broker-reported average cost and is unavailable when either input is missing.",
                    "Market value is arithmetic using the fresh IBKR quantity, live mark, and exact contract multiplier when required.",
                    "Listed-option unrealized P/L is withheld unless native contract-consistent P/L is available; multiplier-one event-contract P/L remains an explicitly labeled estimate.",
                    "ForecastEx final settlements use only a verified complementary official YES/NO pair or an official resolver settlement; official settlement is historical valuation evidence and is never labeled as a live mark.",
                    "After the exact ForecastEx cutoff, a complete exact-contract IBKR resolver bar may determine a binary outcome only when its full high/low range is wholly on one side of the strike; that valuation remains labeled resolver-determined until the official settlement publishes.",
                    "No orders, buying-power changes, or account-control operations are available to The Analyst.",
                ],
            },
            as_of=positions_payload.get("positions_observed_at") or positions_payload.get("observed_at"),
            freshness="live",
            live_verified=True,
            warnings=warnings,
        )


def _accepts_probe(reader: Callable[..., Any]) -> bool:
    try:
        parameter = inspect.signature(reader).parameters.get("probe")
    except (TypeError, ValueError):
        return False
    return parameter is not None and parameter.kind is inspect.Parameter.KEYWORD_ONLY


async def bounded_gateway_readiness(
    reader: Callable[..., Awaitable[Any]], *, run_id: Optional[str] = None, mode: Optional[str] = None,
) -> tuple[Any, dict[str, Any]]:
    """Return one bounded IB Gateway check and how its verdict was reached.

    An answer that arrived within budget stands even when the event loop
    resumes late. A local timeout while this process stalled is contention,
    not Gateway evidence, and gets exactly one fresh probe; an at-budget
    timeout in a free process is final. One structured log line records each
    verdict.
    """
    budget = IBKR_READINESS_TIMEOUT_SECONDS
    with_probe = _accepts_probe(reader)
    attempts = 0
    contention = False
    lag_ms = start_delay_ms = busy_ms = 0.0
    while True:
        attempts += 1
        probe = GatewayProbe(budget)
        started = time.monotonic()
        cpu_started = time.process_time()
        try:
            readiness = await asyncio.wait_for(reader(probe=probe) if with_probe else reader(), budget)
        except (httpx.TimeoutException, asyncio.TimeoutError):
            readiness = probe.completed()
            if readiness is None:
                probe.waited = "outer"
                readiness = {"liveVerified": False, "errorCode": "IBKR_GATEWAY_READINESS_TIMEOUT"}
        except Exception:
            readiness = {"liveVerified": False, "errorCode": "IBKR_SERVICE_UNAVAILABLE"}
        now = time.monotonic()
        # A stalled loop cannot time itself. Use the watchdog's pings, or the
        # late wake-up itself when the watchdog is not running.
        late_ms = max(0.0, now - started - budget) * 1000
        attempt_lag_ms = max(loop_lag_monitor.max_lag_ms(started), round(late_ms, 1))
        # Neither sees work that holds the GIL, such as decoding a multi-MB
        # payload in any thread: the watchdog and the probe thread wait on it
        # too. A request that reached the service late, or CPU this process
        # spent while the check waited, shows it directly.
        attempt_start_delay_ms = probe.start_delay_ms(started, now)
        attempt_busy_ms = round(max(0.0, time.process_time() - cpu_started) * 1000, 1)
        lag_ms = max(lag_ms, attempt_lag_ms)
        start_delay_ms = max(start_delay_ms, attempt_start_delay_ms)
        busy_ms = max(busy_ms, attempt_busy_ms)
        bound = probe.fired()
        code = readiness.get("errorCode") if isinstance(readiness, dict) else None
        # A check that found every worker busy joined an older request, whose
        # timeout did not give this check its full budget. Busy workers are
        # local contention too, never Gateway evidence.
        inherited = (probe.request is not None
                     and started - probe.request.started > IBKR_READINESS_JOIN_SECONDS)
        if attempts == 1 and (bound == "busy" or (
                code == "IBKR_GATEWAY_READINESS_TIMEOUT" and bound in {"inner", "outer"}
                and (inherited or max(attempt_lag_ms, attempt_start_delay_ms, attempt_busy_ms) > LOCAL_CONTENTION_LAG_MS))):
            contention = True
            continue
        break
    if isinstance(readiness, dict) and readiness.get("liveVerified") is True:
        verdict = "ready"
    elif code in GATEWAY_DISCONNECT_CODES:
        verdict = "disconnected"
    else:
        verdict = "unverified-local-contention" if contention else "unverified"
    diagnostics = {"runId": run_id, "mode": mode, "bound": bound, "ioMs": probe.io_ms, "loopLagMs": lag_ms,
                   "startDelayMs": start_delay_ms, "busyMs": busy_ms, "attempts": attempts, "verdict": verdict,
                   "code": code, "heartbeatAgeMs": probe.heartbeat_age_ms}
    LOGGER.info("IB Gateway verdict run=%s mode=%s verdict=%s code=%s bound=%s ioMs=%s loopLagMs=%s "
                "startDelayMs=%s busyMs=%s attempts=%s heartbeatAgeMs=%s", run_id, mode, verdict,
                code or "none", bound, probe.io_ms, lag_ms, start_delay_ms, busy_ms, attempts,
                probe.heartbeat_age_ms)
    return readiness, diagnostics


def _serialize(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): _serialize(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_serialize(item) for item in value]
    if hasattr(value, "model_dump"):
        return _serialize(value.model_dump())
    if hasattr(value, "to_dict"):
        return _serialize(value.to_dict())
    return str(value)


class OpenBBReader:
    """Narrow, read-only OpenBB facade; provider metadata is never discarded."""

    def __init__(self, obb: Any = None) -> None:
        self._obb = obb

    def _client(self):
        if self._obb is None:
            from openbb import obb

            self._obb = obb
        return self._obb

    async def _call(
        self,
        *,
        operation: str,
        provider: str,
        invoke: Callable[[Any], Any],
    ) -> dict[str, Any]:
        try:
            response = await asyncio_to_thread(invoke, self._client())
            resolved_provider = str(getattr(response, "provider", None) or provider)
            metadata = _serialize(getattr(response, "extra", None) or getattr(response, "metadata", None) or {})
            warnings = _serialize(getattr(response, "warnings", None) or [])
            if not isinstance(warnings, list):
                warnings = [str(warnings)]
            results = _serialize(getattr(response, "results", response))
            return envelope(
                status="available" if results else "not_found",
                source_system="openbb",
                provider=resolved_provider,
                data={"operation": operation, "results": results, "metadata": metadata},
                freshness="historical_or_delayed",
                live_verified=False,
                warnings=warnings,
            )
        except Exception as exc:
            return envelope(
                status="unavailable",
                source_system="openbb",
                provider=provider,
                data={"operation": operation, "results": [] if operation == "market_history" else None, "metadata": {}},
                freshness="unavailable",
                live_verified=False,
                warnings=[f"OpenBB {operation} failed: {exc}"],
            )

    async def market_history(
        self,
        symbol: str,
        *,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        provider: str = "yfinance",
        adjustment: Optional[str] = None,
    ) -> dict[str, Any]:
        response = await self._call(
            operation="market_history",
            provider=provider,
            invoke=lambda obb: obb.equity.price.historical(
                symbol=symbol,
                start_date=start_date,
                end_date=end_date,
                provider=provider,
                **({"adjustment": adjustment} if adjustment is not None else {}),
            ),
        )
        if adjustment is not None and response.get("status") == "available":
            metadata = response["data"].get("metadata")
            response["data"]["metadata"] = {
                **(metadata if isinstance(metadata, dict) else {}),
                "priceAdjustment": adjustment,
            }
        return response

    async def company_fundamentals(self, symbol: str, *, provider: str = "yfinance") -> dict[str, Any]:
        return await self._call(
            operation="company_fundamentals",
            provider=provider,
            invoke=lambda obb: obb.equity.fundamental.metrics(symbol=symbol, provider=provider),
        )

    async def macro_series(
        self,
        series_id: str,
        *,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        provider: str = "fred",
    ) -> dict[str, Any]:
        return await self._call(
            operation="macro_series",
            provider=provider,
            invoke=lambda obb: obb.economy.fred_series(
                symbol=series_id,
                start_date=start_date,
                end_date=end_date,
                provider=provider,
            ),
        )


class MarketSituationContextReader:
    """Source-dated SPX context from the dashboard's completed-session model."""

    def __init__(
        self,
        base_url: str = MARKET_DASHBOARD_API_BASE,
        request: Optional[Callable[..., Awaitable[dict[str, Any]]]] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._request_override = request

    async def _request(self, path: str) -> dict[str, Any]:
        if self._request_override:
            return await self._request_override(path)
        response = await _shared_client(self.base_url).get(
            f"{self.base_url}{path}",
            headers={"Cache-Control": "no-cache", "Pragma": "no-cache"},
            timeout=5,
        )
        response.raise_for_status()
        if "no-store" not in str(response.headers.get("Cache-Control") or "").lower():
            raise RuntimeError("Historical market-context endpoint did not return no-store")
        return response.json()

    @staticmethod
    def _unavailable(reason: str) -> dict[str, Any]:
        return envelope(
            status="unavailable",
            source_system="market_dashboard",
            provider="Yahoo Finance chart API",
            data={
                "symbol": "SPX",
                "oneMonth": None,
                "threeMonth": None,
                "spreadPercentagePoints": None,
                "relationship": None,
                "historicalOnly": True,
                "executable": False,
            },
            freshness="unavailable",
            live_verified=False,
            warnings=[reason],
        )

    async def spx_realized_volatility(self) -> dict[str, Any]:
        path = "/api/security-risk-metrics/spx-realized-volatility"
        payload = {}
        # Provider work continues independently of the usable Portfolio report.
        # Retry short transient failures rather than stamp a first timeout into
        # the capture; every result still passes the same session/provenance gate.
        deadline = time.monotonic() + 25
        for attempt in range(4):
            try:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return self._unavailable("Completed-session SPX history is unavailable.")
                payload = await asyncio.wait_for(
                    self._request(path if attempt == 0 else f"{path}?forceRefresh=1"), min(5, remaining))
                row = (payload.get("rows") or {}).get("SPX") or {}
                realized = row.get("realizedVolatility") or {}
                if (payload.get("historicalOnly") is not True or payload.get("executable") is not False
                        or payload.get("source") != "Yahoo Finance chart API"
                        or any(value.get(flag) is True for value in (payload, row, realized)
                               for flag in ("mock", "seed", "seeded", "stale", "cacheOnly", "offline"))):
                    return self._unavailable("Current completed-session 1M/3M SPX volatility is unavailable.")
                if payload.get("completedSession", {}).get("status") == "current":
                    break
            except Exception as exc:
                transient = (isinstance(exc, (httpx.TransportError, asyncio.TimeoutError))
                             or isinstance(exc, httpx.HTTPStatusError) and 500 <= exc.response.status_code < 600)
                if not transient or attempt == 3:
                    return self._unavailable("Completed-session SPX history is unavailable.")
            if attempt < 3:
                delay = 0.15 * (attempt + 1)
                if deadline - time.monotonic() <= delay:
                    return self._unavailable("Completed-session SPX history is unavailable.")
                await asyncio.sleep(delay)

        row = (payload.get("rows") or {}).get("SPX") or {}
        realized = row.get("realizedVolatility") or {}
        one_month = _finite_number_or_none(realized.get("rv21"))
        three_month = _finite_number_or_none(realized.get("rv63"))
        as_of = str(realized.get("asOf") or row.get("asOf") or "").strip() or None
        completed = payload.get("completedSession") or {}
        valid = bool(
            payload.get("historicalOnly") is True
            and payload.get("executable") is False
            and payload.get("source") == "Yahoo Finance chart API"
            and completed.get("status") == "current"
            and completed.get("expectedAsOf") == as_of
            and realized.get("status") == "available"
            and one_month is not None and one_month > 0
            and three_month is not None and three_month > 0
            and not any(value.get(flag) is True for value in (payload, row, realized)
                        for flag in ("mock", "seed", "seeded", "stale", "cacheOnly", "offline"))
        )
        if not valid:
            return self._unavailable("Current completed-session 1M/3M SPX volatility is unavailable.")

        one_month_pct = round(one_month * 100, 2)
        three_month_pct = round(three_month * 100, 2)
        spread = round(one_month_pct - three_month_pct, 2)
        relationship = (
            "one_month_above_three_month" if spread > 0
            else "one_month_below_three_month" if spread < 0
            else "one_month_equal_three_month"
        )
        return envelope(
            status="available",
            source_system="market_dashboard",
            provider="Yahoo Finance chart API",
            data={
                "symbol": "SPX",
                "priceBasis": "completed SPX cash-index adjusted daily close",
                "returnMethod": "daily log returns; sample standard deviation; annualized by square root of 252",
                "oneMonth": {"windowSessions": 21, "valuePct": one_month_pct},
                "threeMonth": {"windowSessions": 63, "valuePct": three_month_pct},
                "spreadPercentagePoints": spread,
                "relationship": relationship,
                "asOf": as_of,
                "historicalOnly": True,
                "executable": False,
            },
            as_of=as_of,
            freshness="historical_completed_session",
            live_verified=False,
        )


async def asyncio_to_thread(function: Callable[..., Any], *args: Any) -> Any:
    import asyncio

    return await asyncio.to_thread(function, *args)
