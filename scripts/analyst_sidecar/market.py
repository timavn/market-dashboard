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


LOGGER = logging.getLogger("market_dashboard.analyst.gateway")


IBKR_BASE_URL = os.environ.get("IBKR_SIDECAR_URL", "http://127.0.0.1:8765").rstrip("/")
# Longest Gateway re-probe wait a holdings read absorbs before reporting unavailable.
IBKR_HOLDINGS_GATEWAY_RETRY_MAX_MS = 6000
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


# Bare tickers stay US stocks and ETFs: "ES" is Eversource, so a futures, FX or
# crypto contract is only requested when the symbol's own form says so.
_FUTURES_ROOTS = {
    **{root: (root, "CME") for root in ("ES", "NQ", "RTY", "MES", "MNQ", "M2K", "MBT", "MET")},
    **{root: (root, "CBOT") for root in (
        "YM", "MYM", "ZT", "ZF", "ZN", "TN", "ZB", "UB", "ZC", "ZS", "ZW",
    )},
    **{root: (root, "COMEX") for root in ("GC", "MGC", "SI", "HG")},
    **{root: (root, "NYMEX") for root in ("CL", "NG", "RB", "HO", "PL", "PA")},
    "BTC": ("BRR", "CME"),
    "ETH": ("ETHUSDRR", "CME"),
    "6E": ("EUR", "CME"),
    "6J": ("JPY", "CME"),
    "6B": ("GBP", "CME"),
    "6A": ("AUD", "CME"),
    "6C": ("CAD", "CME"),
    "6S": ("CHF", "CME"),
    "DX": ("DX", "NYBOT"),
    "VX": ("VIX", "CFE"),
}
_FX_CURRENCIES = frozenset({
    "USD", "EUR", "JPY", "GBP", "AUD", "CAD", "CHF", "NZD",
    "SEK", "NOK", "DKK", "MXN", "CNH", "HKD", "SGD", "ZAR",
})
_SPOT_CRYPTO = frozenset({"BTC", "ETH", "LTC", "BCH"})


def market_instrument(requested: str) -> Optional[dict[str, str]]:
    """Return the IBKR contract a symbol names, or None for an unmapped futures root."""
    futures = re.fullmatch(r"/([A-Z0-9]{1,5})|([A-Z0-9]{1,5})=F", requested)
    if futures:
        mapped = _FUTURES_ROOTS.get(futures[1] or futures[2])
        if mapped is None:
            return None
        return {"symbol": mapped[0], "secType": "CONTFUT", "exchange": mapped[1], "currency": "USD"}
    pair = re.fullmatch(r"([A-Z]{3})[/.]?([A-Z]{3})(?:=X)?", requested)
    if pair and pair[1] in _FX_CURRENCIES and pair[2] in _FX_CURRENCIES:
        return {"symbol": pair[1], "secType": "CASH", "exchange": "IDEALPRO", "currency": pair[2]}
    crypto = re.fullmatch(r"([A-Z]{3})[-/]?USD", requested)
    if crypto and crypto[1] in _SPOT_CRYPTO:
        return {"symbol": crypto[1], "secType": "CRYPTO", "exchange": "PAXOS", "currency": "USD"}
    return {"symbol": requested, "secType": "STK", "exchange": "SMART", "currency": "USD"}


def _instrument_key(row: dict[str, Any]) -> tuple[str, str, str]:
    return (
        str(row.get("symbol") or row.get("localSymbol") or "").upper(),
        str(row.get("secType") or "STK").upper(),
        str(row.get("currency") or "USD").upper(),
    )


class IbkrReader:
    def __init__(
        self,
        base_url: str = IBKR_BASE_URL,
        request: Optional[Callable[..., Awaitable[dict[str, Any]]]] = None,
        now: Optional[Callable[[], datetime]] = None,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._request_override = request
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._transport = transport

    async def _request(self, path: str, *, method: str = "GET", json_body: Any = None) -> dict[str, Any]:
        if self._request_override:
            return await self._request_override(path, method=method, json_body=json_body)
        response = await _shared_client(self.base_url, self._transport).request(
            method, f"{self.base_url}{path}", json=json_body, timeout=IBKR_TIMEOUT_SECONDS)
        response.raise_for_status()
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
        instruments: dict[str, dict[str, str]] = {}
        requested_by_key: dict[tuple[str, str, str], str] = {}
        for symbol in symbols:
            value = str(symbol or "").strip().upper()
            if not value or value in normalized or len(normalized) >= MAX_MARKET_SYMBOLS:
                continue
            instrument = market_instrument(value)
            if instrument is not None:
                key = _instrument_key(instrument)
                if key in requested_by_key:
                    continue
                requested_by_key[key] = value
                instruments[value] = instrument
            normalized.append(value)
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
                json_body={"instruments": list(instruments.values()), "forceRefresh": True},
            ) if instruments else {"quotes": []}
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
            key = _instrument_key(raw)
            symbol = requested_by_key.get(key, key[0])
            if verified_live_quote(raw):
                accepted.append(
                    {
                        "symbol": symbol,
                        "secType": key[1],
                        "localSymbol": raw.get("localSymbol"),
                        "expiry": raw.get("lastTradeDateOrContractMonth"),
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
        unmapped = [symbol for symbol in normalized if symbol not in instruments]
        if unmapped:
            warnings.append("No IBKR futures contract is mapped for: " + ", ".join(unmapped))
        spot_crypto = [symbol for symbol in rejected if instruments.get(symbol, {}).get("secType") == "CRYPTO"]
        if spot_crypto:
            warnings.append(
                "No live PAXOS spot quote for " + ", ".join(spot_crypto)
                + "; IBKR has reported this account as not subscribed to PAXOS data. "
                "BTC=F and ETH=F are CME futures, not spot."
            )
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
                    "brokerSnapshotRequestedCount": len(instruments),
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

    async def executions(self) -> dict[str, Any]:
        """Today's fills for every managed account, read fresh. Read-only."""
        return await self._request("/portfolio/executions")

    async def session_closes(self, accounts: list[str]) -> list[Any]:
        """IBKR official daily closes per account, from the bridge's reference marks."""
        return await asyncio.gather(*(
            self._request(f"/portfolio/reference-marks?account={quote(str(account))}&include_live=false")
            for account in accounts
        ), return_exceptions=True)

    async def holdings_context(self) -> dict[str, Any]:
        """Read the broker's current holdings without waiting for quote or P/L work.

        The live-positions read and its payload gate are the only guard. A
        failed holdings request never reports a Gateway connection state.
        """
        try:
            payload = await self._request("/portfolio/live-positions")
        except Exception as error:
            # The IBKR sidecar answers 503 at once while its Gateway circuit
            # waits for the next probe. When that probe is due within a few
            # seconds (a just-relaunched Gateway), wait for it once instead of
            # reporting holdings unavailable.
            wait_ms = self._short_gateway_retry_ms(error)
            if wait_ms is None:
                code = self._holdings_failure_code(error)
                return self._holdings_unavailable(HOLDINGS_FAILURE_MESSAGES[code], code)
            await asyncio.sleep(wait_ms / 1000 + 0.25)
            try:
                payload = await self._request("/portfolio/live-positions")
            except Exception as retry_error:
                code = self._holdings_failure_code(retry_error)
                return self._holdings_unavailable(HOLDINGS_FAILURE_MESSAGES[code], code)
        return self._holdings_context_from_payload(payload)

    @staticmethod
    def _short_gateway_retry_ms(error: Exception) -> Optional[float]:
        if not isinstance(error, httpx.HTTPStatusError) or error.response.status_code != 503:
            return None
        try:
            payload = error.response.json()
        except ValueError:
            return None
        if not isinstance(payload, dict):
            return None
        retry_ms = _finite_number_or_none(payload.get("retry_after_ms"))
        if retry_ms is None or not 0 < retry_ms <= IBKR_HOLDINGS_GATEWAY_RETRY_MAX_MS:
            return None
        return retry_ms

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
                # Publish this same verified position read before quote and
                # P/L work. The callback receives no valuation,
                # average-cost, or inferred price fields.
                await on_holdings(holdings)
        valuation_deadline = time.monotonic() + PORTFOLIO_VALUATION_BUDGET_SECONDS

        def valuation_remaining() -> float:
            return valuation_deadline - time.monotonic()

        # IBKR does not quote expired ForecastEx contracts; they are held
        # as awaiting official settlement instead of being snapshotted.
        broker_settlement_skip_candidates = [
            row for row in raw_positions
            if _expired_forecastex_contract(row, self._now())
        ]
        broker_settlement_skip_con_ids = {
            int(row["conId"])
            for row in broker_settlement_skip_candidates
            if row.get("conId") is not None
        }

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
        quote_input_con_ids = {
            int(row["conId"])
            for row in quote_inputs
            if row.get("conId") is not None
        }
        for row in raw_positions:
            con_id = int(row["conId"]) if row.get("conId") is not None else None
            quote = quotes_by_contract.get(con_id)
            quote_attempt = latest_quote_attempt_by_contract.get(con_id, {})
            is_settlement_candidate = con_id in broker_settlement_skip_con_ids
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
            valuation_basis = "live_ibkr" if mark is not None else "unavailable"
            valuation_price = mark
            valuation_pnl = unrealized_pnl_estimate
            if is_settlement_candidate:
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
                "valuationSource": "ibkr_broker_snapshot" if mark is not None else None,
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
                "markStatus": (
                    "awaiting_official_settlement" if is_settlement_candidate
                    else "fresh_live_ibkr" if mark is not None
                    else "unavailable_after_broker_snapshot"
                ),
            }
            if is_settlement_candidate:
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
                "The dashboard withheld valuations where no fresh live IBKR mark was available: "
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
                    "valuedCount": live_mark_count,
                    "liveMarkCount": live_mark_count,
                    "awaitingSettlementCount": len(awaiting_settlements),
                    "missingCount": len(missing_valuations),
                    "missingContracts": sorted(set(missing_valuations)),
                    "awaitingSettlementContracts": sorted(set(awaiting_settlements)),
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
                    "accountSummaryRequestedCount": len(accounts),
                    "pnlRequestedCount": len(accounts),
                    "durationMs": {
                        "positionSnapshot": position_snapshot_duration_ms,
                        "initialBrokerQuotes": initial_quote_duration_ms,
                        "brokerRetry": retry_quote_duration_ms,
                        "total": total_refresh_duration_ms,
                    },
                    "coverageComplete": complete,
                },
                "calculationNotes": [
                    "Average cost is broker-reported; cost basis is the absolute live position quantity multiplied by broker-reported average cost and is unavailable when either input is missing.",
                    "Market value is arithmetic using the fresh IBKR quantity, live mark, and exact contract multiplier when required.",
                    "Listed-option unrealized P/L is withheld unless native contract-consistent P/L is available; multiplier-one event-contract P/L remains an explicitly labeled estimate.",
                    "Expired ForecastEx contracts are not quoted; they stay awaiting official settlement and are never valued from a live mark.",
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

    async def company_profiles(self, symbols: list[str], *, provider: str = "yfinance") -> list[dict[str, Any]]:
        """Company profile rows (sector, industry, issue type) for many symbols in one read."""
        response = await self._call(
            operation="company_profiles",
            provider=provider,
            invoke=lambda obb: obb.equity.profile(symbol=",".join(symbols), provider=provider),
        )
        results = response["data"].get("results")
        if response.get("status") != "available" or not isinstance(results, list):
            raise RuntimeError("company profiles unavailable")
        return [row for row in results if isinstance(row, dict)]

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
