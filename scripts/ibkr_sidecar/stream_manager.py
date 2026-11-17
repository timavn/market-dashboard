"""Persistent IBKR connection, streaming quote cache, and portfolio caches."""

from __future__ import annotations

import asyncio
import json
import uuid
import os
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Set

from ib_insync import Contract, IB

from gateway_connection_governor import GatewayConnectionGovernor
from numeric_values import strict_contract_id, strict_finite_float, strict_market_data_type

PERSISTENT_CONNECT = os.environ.get("IBKR_PERSISTENT_CONNECT", "true").lower() == "true"
MAX_STREAM_SUBS = int(os.environ.get("IBKR_MAX_STREAM_SUBS", "100"))
STREAM_DEBOUNCE_MS = int(os.environ.get("IBKR_STREAM_DEBOUNCE_MS", "150"))
QUOTE_WAIT_SEC = max(0.1, float(os.environ.get("IBKR_QUOTE_WAIT_SEC", "2.5")))
QUOTE_QUALIFY_TIMEOUT_SEC = max(
    0.1,
    float(os.environ.get("IBKR_QUOTE_QUALIFY_TIMEOUT_SEC", "3.0")),
)
QUOTE_MAX_CONCURRENCY = max(1, int(os.environ.get("IBKR_QUOTE_MAX_CONCURRENCY", "6")))
FORCED_QUOTE_MAX_CONCURRENCY = max(
    1,
    int(os.environ.get("IBKR_FORCED_QUOTE_MAX_CONCURRENCY", "12")),
)
QUOTE_POLL_SEC = 0.05
# How long the sidecar remembers which contract a symbol identifies, instead of
# asking IBKR again on every quote. Only for a stock, ETF, index or currency
# pair, which a symbol identifies the same way all day; a future or an option
# asked for by symbol follows the front month and is looked up every time.
CONTRACT_MEMORY_SEC = max(
    0.0,
    float(os.environ.get("IBKR_CONTRACT_MEMORY_SEC", str(12 * 60 * 60))),
)
# "No such contract" is remembered only briefly: a contract-definition outage
# at IBKR gives the same empty answer as a symbol that does not exist.
UNKNOWN_CONTRACT_MEMORY_SEC = max(
    0.0,
    float(os.environ.get("IBKR_UNKNOWN_CONTRACT_MEMORY_SEC", "600")),
)
CONTRACT_MEMORY_LIMIT = 2000
# How long an ordinary quote waits for the next tick of a contract the stream
# already delivers, once its last tick has gone stale.
# Pauses between attempts to subscribe the portfolio's positions after a
# connect. The Gateway is at its busiest then, and one timed-out attempt used
# to leave the portfolio without streaming quotes until the next reconnect.
PORTFOLIO_WARMUP_RETRY_SEC = (5.0, 10.0, 20.0, 40.0, 60.0, 60.0)
SUBSCRIBED_QUOTE_WAIT_SEC = max(
    0.0,
    float(os.environ.get("IBKR_SUBSCRIBED_QUOTE_WAIT_SEC", "0.25")),
)
CONTRACT_MEMORY_SEC_TYPES = frozenset({"STK", "ETF", "IND", "CASH"})
UNKNOWN_CONTRACT_PREFIX = "Could not qualify "
# How long a snapshot whose quote has been read may wait for IBKR to end it
# before the sidecar cancels it instead.
SNAPSHOT_END_GRACE_SEC = max(
    0.0,
    float(os.environ.get("IBKR_SNAPSHOT_END_GRACE_SEC", "1.5")),
)
# The gap between any two snapshot messages. IBKR takes 50 API messages a
# second from a client and holds back the rest; 25 ms is 40 a second, evenly.
SNAPSHOT_MESSAGE_INTERVAL_SEC = max(
    0.0,
    float(os.environ.get("IBKR_SNAPSHOT_MESSAGE_INTERVAL_MS", "25")) / 1000.0,
)
ACCOUNT_SUMMARY_REFRESH_SEC = float(os.environ.get("IBKR_ACCOUNT_SUMMARY_REFRESH_SEC", "30"))
PORTFOLIO_SYNC_TIMEOUT_SEC = float(os.environ.get("IBKR_PORTFOLIO_SYNC_TIMEOUT_SEC", "8"))

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


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _quote_timestamp_age_sec(value: Any, now: Optional[datetime] = None) -> Optional[float]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    reference = now or datetime.now(timezone.utc)
    return (reference - parsed.astimezone(timezone.utc)).total_seconds()


def raw_quote_is_ready(raw: Optional[Dict[str, Any]], max_age_sec: float = 60.0) -> bool:
    """Return true only for a provider-timestamped, non-frozen market mark."""
    if not raw or raw.get("priceState") != "market_mark":
        return False
    def positive(value: Any) -> bool:
        parsed = strict_finite_float(value)
        return parsed is not None and parsed > 0

    if any(raw.get(key) is not None and strict_finite_float(raw[key]) is None
           for key in ("bid", "ask", "last", "close")):
        return False
    if not (
        positive(raw.get("last"))
        or (positive(raw.get("bid")) and positive(raw.get("ask")))
    ):
        return False
    if str(raw.get("dataType") or "").lower() not in {"live", "delayed"}:
        return False
    entitlement = str(raw.get("entitlementStatus") or "").lower()
    if entitlement not in {"live", "delayed", "tick_by_tick"}:
        return False
    if positive(raw.get("bid")) and positive(raw.get("ask")) and float(raw["bid"]) > float(raw["ask"]):
        return False
    if any(raw.get(key) is True for key in ("mock", "seeded", "synthetic", "fallback", "cacheOnly", "cachedOnly")):
        return False
    age_sec = _quote_timestamp_age_sec(raw.get("timestamp"))
    return age_sec is not None and age_sec >= -5 and age_sec <= max_age_sec


def ticker_to_raw_quote(ticker: Any, contract: Contract) -> Dict[str, Any]:
    """Return IB-native tick fields; normalization happens in Node."""
    safe_float = strict_finite_float

    if ticker is None:
        return {
            "symbol": contract.symbol,
            "conId": strict_contract_id(contract.conId),
            "secType": contract.secType,
            "exchange": contract.exchange,
            "primaryExchange": getattr(contract, "primaryExchange", None) or None,
            "currency": contract.currency or "USD",
            "localSymbol": contract.localSymbol or contract.symbol,
            "lastTradeDateOrContractMonth": getattr(contract, "lastTradeDateOrContractMonth", None) or None,
            "strike": safe_float(getattr(contract, "strike", None)),
            "right": getattr(contract, "right", None) or None,
            "tradingClass": getattr(contract, "tradingClass", None) or None,
            "multiplier": getattr(contract, "multiplier", None) or None,
            "bid": None,
            "ask": None,
            "last": None,
            "close": None,
            "volume": None,
            "dataType": "unknown",
            "priceState": "unavailable",
            "entitlementStatus": None,
            "timestamp": None,
            "fetched_at": now_iso(),
        }
    ts = None
    if getattr(ticker, "time", None):
        try:
            ts = ticker.time.isoformat()
        except Exception:
            ts = str(ticker.time)

    market_data_type = strict_market_data_type(getattr(ticker, "marketDataType", None))
    data_type_map = {1: "live", 2: "frozen", 3: "delayed", 4: "delayed_frozen"}
    data_type = data_type_map.get(market_data_type, "unknown")

    bid = safe_float(ticker.bid)
    ask = safe_float(ticker.ask)
    last = safe_float(ticker.last)
    close = safe_float(ticker.close) or safe_float(getattr(ticker, "prevClose", None))
    has_market_mark = (
        (last is not None and last > 0)
        or (bid is not None and bid > 0 and ask is not None and ask > 0)
    )
    if has_market_mark:
        price_state = "market_mark"
    elif close is not None:
        price_state = "reference_close"
    else:
        price_state = "unavailable"

    entitlement = None
    if getattr(ticker, "tickByTicks", None):
        entitlement = "tick_by_tick"
    elif market_data_type is not None:
        entitlement = data_type

    return {
        "symbol": contract.symbol,
        "conId": strict_contract_id(contract.conId),
        "secType": contract.secType,
        "exchange": contract.exchange,
        "primaryExchange": getattr(contract, "primaryExchange", None) or None,
        "currency": contract.currency or "USD",
        "localSymbol": contract.localSymbol or contract.symbol,
        "lastTradeDateOrContractMonth": getattr(contract, "lastTradeDateOrContractMonth", None) or None,
        "strike": safe_float(getattr(contract, "strike", None)),
        "right": getattr(contract, "right", None) or None,
        "tradingClass": getattr(contract, "tradingClass", None) or None,
        "multiplier": getattr(contract, "multiplier", None) or None,
        "bid": bid,
        "ask": ask,
        "last": last,
        "close": close,
        "volume": safe_float(ticker.volume),
        "dataType": data_type,
        "priceState": price_state,
        "entitlementStatus": entitlement,
        # A close-only tick does not carry the completed session timestamp.
        # Keep its receipt time separate so callers cannot mistake a prior
        # close observed now for a current market quote.
        "timestamp": ts if has_market_mark else None,
        "fetched_at": now_iso(),
    }


def _new_contract_lookup_counts() -> Dict[str, int]:
    """Contract lookups sent to IBKR, and lookups answered from memory."""
    return {"asked": 0, "reused": 0}


def contract_memory_key(contract: Contract) -> Optional[tuple]:
    """Identity of a symbol lookup that can be remembered, or None.

    A request that names a contract id is not remembered here: a subscribed
    contract is already held by the stream, and the rest are asked each time.
    """
    if getattr(contract, "conId", 0):
        return None
    sec_type = str(getattr(contract, "secType", "") or "").upper()
    symbol = str(getattr(contract, "symbol", "") or "").upper()
    if sec_type not in CONTRACT_MEMORY_SEC_TYPES or not symbol:
        return None
    return (
        sec_type,
        symbol,
        str(getattr(contract, "exchange", "") or "").upper(),
        str(getattr(contract, "primaryExchange", "") or "").upper(),
        str(getattr(contract, "currency", "") or "").upper(),
        str(getattr(contract, "localSymbol", "") or "").upper(),
        str(getattr(contract, "tradingClass", "") or "").upper(),
    )


def _new_broker_snapshot_counts() -> Dict[str, int]:
    return {"requested": 0, "endedByGateway": 0, "cancelled": 0}


class StreamManager:
    def __init__(
        self,
        ib: IB,
        *,
        host: str,
        port: int,
        client_id: int,
        connect_timeout: float,
        instrument_to_contract: Callable[[Any], Contract],
        connection_governor: Optional[GatewayConnectionGovernor] = None,
    ) -> None:
        self.ib = ib
        self.host = host
        self.port = port
        self.client_id = client_id
        self.connect_timeout = connect_timeout
        self.instrument_to_contract = instrument_to_contract
        self.connection_governor = connection_governor or GatewayConnectionGovernor(
            host=host,
            port=port,
            connect_timeout=connect_timeout,
            verify_timeout=connect_timeout,
        )
        self.connection_governor.register_session(
            "primary",
            ib,
            client_id=client_id,
            primary=True,
        )

        self.connected = False
        self.reconnecting = False
        self.last_tick_at: Optional[str] = None
        self.last_error: Optional[str] = None

        self._quote_cache: Dict[int, Dict[str, Any]] = {}
        self._ref_counts: Dict[int, int] = {}
        self._subscription_owners: Dict[str, Set[int]] = {}
        self._owner_reconcile_lock = asyncio.Lock()
        self._instance_id = str(uuid.uuid4())
        self._contracts: Dict[int, Contract] = {}
        self._tickers: Dict[int, Any] = {}
        self._live_last_ticks: Dict[int, Dict[str, Any]] = {}
        self._connection_generation = 0
        self._quote_snapshot_semaphore = asyncio.Semaphore(QUOTE_MAX_CONCURRENCY)
        self._forced_quote_snapshot_semaphore = asyncio.Semaphore(FORCED_QUOTE_MAX_CONCURRENCY)
        self._quote_snapshot_tasks: Dict[int, asyncio.Task] = {}
        self._broker_snapshot_closers: Set[asyncio.Task] = set()
        self._broker_snapshot_counts = _new_broker_snapshot_counts()

        self._portfolio_positions: Dict[str, Dict[int, Dict[str, Any]]] = {}
        self._account_summary: Dict[str, Dict[str, Any]] = {}
        self._portfolio_account: Optional[str] = None
        self._account_updates_active = False

        self._sse_clients: Set[asyncio.Queue] = set()
        self._pending_notify: Set[int] = set()
        self._debounce_task: Optional[asyncio.Task] = None
        self._reconnect_task: Optional[asyncio.Task] = None
        self._summary_task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()
        self._connect_lock = asyncio.Lock()
        self._started = False

    def status_payload(self) -> Dict[str, Any]:
        return {
            "connected": self.connected,
            "instanceId": self._instance_id,
            "connectionGeneration": self._connection_generation,
            "reconnecting": self.reconnecting,
            "persistent": PERSISTENT_CONNECT,
            "last_tick_at": self.last_tick_at,
            "last_error": self.last_error,
            "active_subscriptions": len(self._ref_counts),
            "max_stream_subs": MAX_STREAM_SUBS,
            "forced_quote_max_concurrency": FORCED_QUOTE_MAX_CONCURRENCY,
            "broker_snapshots": dict(self._broker_snapshot_counts),
            "contract_lookups": dict(
                self.__dict__.get("_contract_lookup_counts") or _new_contract_lookup_counts()
            ),
            "portfolio_account": self._portfolio_account,
            "gateway": self.connection_governor.diagnostics(),
        }

    @property
    def connection_generation(self) -> int:
        """Generation token used to reject evidence retained across reconnects."""
        return self._connection_generation

    async def start(self) -> None:
        if self._started:
            return
        self._started = True
        self.ib.pendingTickersEvent += self._on_pending_tickers
        self.ib.updatePortfolioEvent += self._on_update_portfolio
        self.ib.disconnectedEvent += self._on_disconnected
        if PERSISTENT_CONNECT:
            asyncio.create_task(self._initial_connect())
            self._reconnect_task = asyncio.create_task(self._reconnect_loop())
            self._summary_task = asyncio.create_task(self._account_summary_loop())

    async def _initial_connect(self) -> None:
        try:
            result = await self.connect()
            if result.get("ok"):
                asyncio.ensure_future(self._pre_warm_portfolio())
        except Exception as exc:
            self.last_error = str(exc)
            self.connected = False

    async def stop(self) -> None:
        self._started = False
        for task in (
            self._reconnect_task,
            self._summary_task,
            self._debounce_task,
            *self._quote_snapshot_tasks.values(),
            *self._broker_snapshot_closers,
        ):
            if task and not task.done():
                task.cancel()
        if self.ib.isConnected():
            try:
                self.ib.disconnect()
            except Exception:
                pass
        self.connected = False

    async def connect(self) -> Dict[str, Any]:
        async with self._connect_lock:
            was_connected = self.connected
            health = await self.connection_governor.ensure_session(
                "primary",
                self.ib,
                client_id=self.client_id,
                primary=True,
            )
            if not health.get("ok"):
                self.connected = False
                self.last_error = health.get("message")
                return health

            newly_connected = bool(health.get("new_connection")) or not was_connected
            if newly_connected:
                self._connection_generation += 1
                self._live_last_ticks.clear()
                await self._resubscribe_all()
            self.connected = True
            self.reconnecting = False
            self.last_error = None
            return {
                **health,
                "client_id": self.client_id,
            }

    async def ensure_connected(self) -> Dict[str, Any]:
        # A connected TCP object is not readiness evidence. Every caller goes
        # through the shared, coalesced API heartbeat and account refresh.
        return await self.connect()

    def _on_disconnected(self) -> None:
        self._connection_generation += 1
        # Contract definitions are looked up afresh in each Gateway session.
        self.__dict__.get("_contract_memory", {}).clear()
        self.connected = False
        self._live_last_ticks.clear()
        self._tickers.clear()
        self._quote_cache.clear()
        self._pending_notify.clear()
        self._broadcast_status("disconnected", "IB socket disconnected")

    async def _reconnect_loop(self) -> None:
        while self._started:
            await asyncio.sleep(1.0)
            if self.ib.isConnected() and self.connected:
                continue
            self.reconnecting = True
            self.connected = False
            try:
                result = await self.connect()
            except Exception as exc:
                # One failed attempt (for example the socket dropping while
                # subscriptions are restored) must not end reconnection for the
                # life of the process. Report it and try again.
                result = {"ok": False, "message": str(exc) or exc.__class__.__name__}
            if result.get("ok"):
                self._broadcast_status("connected", None)
                asyncio.ensure_future(self._pre_warm_portfolio())
            else:
                self.last_error = result.get("message")
                self._broadcast_status("reconnecting", result.get("message"))
                retry_after = max(1.0, float(result.get("retry_after_ms") or 0) / 1000.0)
                await asyncio.sleep(min(retry_after, 60.0))

    def _portfolio_quotes_subscribed(self, acct: str) -> bool:
        """True once every position of this account is subscribed to the stream."""
        owned = self._subscription_owners.get(f"portfolio:{acct}")
        if owned is None:
            return False
        positions = self._portfolio_positions.get(acct) or {}
        return {int(con_id) for con_id in positions} <= owned

    async def _pre_warm_portfolio(self) -> None:
        """Pre-warm the portfolio cache for all managed accounts after connect.

        An account whose positions could not be subscribed is tried again, with
        growing pauses, for as long as this connection lasts.
        """
        generation = self._connection_generation
        try:
            await asyncio.sleep(1.0)  # brief settle for account list
            for pause in (*PORTFOLIO_WARMUP_RETRY_SEC, None):
                if generation != self._connection_generation or not self.connected:
                    return
                pending = [
                    acct for acct in self.ib.managedAccounts()
                    if not self._portfolio_quotes_subscribed(acct)
                ]
                for acct in pending:
                    try:
                        await asyncio.wait_for(self._ensure_portfolio_stream(acct), timeout=25)
                    except Exception:
                        pass
                if pause is None or all(
                    self._portfolio_quotes_subscribed(acct) for acct in self.ib.managedAccounts()
                ):
                    return
                await asyncio.sleep(pause)
        except Exception:
            pass

    async def _ensure_portfolio_stream(self, account: Optional[str] = None) -> None:
        accounts = self.ib.managedAccounts()
        if not accounts:
            return
        acct = account if account and account in accounts else accounts[0]

        # Positions are account-wide and reliable across managed accounts. Do this
        # before account-updates streaming so retirement accounts do not disappear
        # when reqAccountUpdates stalls.
        await asyncio.wait_for(self.ib.reqPositionsAsync(), timeout=10)
        await asyncio.sleep(0.1)
        self._sync_positions_from_ib(acct)
        await self._subscribe_portfolio_quotes(acct)

        try:
            await asyncio.wait_for(self._refresh_account_summary(acct), timeout=10)
        except Exception as exc:
            self.last_error = f"account_summary: {exc}"

        loop = asyncio.get_event_loop()
        if self._portfolio_account and self._portfolio_account != acct and self._account_updates_active:
            try:
                await asyncio.wait_for(
                    loop.run_in_executor(None, self.ib.reqAccountUpdates, ''),
                    timeout=PORTFOLIO_SYNC_TIMEOUT_SEC,
                )
            except Exception:
                pass
            self._account_updates_active = False
        self._portfolio_account = acct

        if self._account_updates_active:
            return

        try:
            await asyncio.wait_for(
                loop.run_in_executor(None, self.ib.reqAccountUpdates, acct),
                timeout=PORTFOLIO_SYNC_TIMEOUT_SEC,
            )
            self._account_updates_active = True
        except Exception as exc:
            self.last_error = f"portfolio_stream_optional: {exc}"

    async def sync_account_portfolio(self, account: str) -> Dict[str, Any]:
        """One-shot sync for a specific account (multi-account support)."""
        if not self.ib.isConnected():
            return {"ok": False, "status": "gateway_offline", "message": "IB Gateway is not connected"}
        accounts = self.ib.managedAccounts()
        if account not in accounts:
            return {
                "ok": False,
                "status": "account_not_found",
                "message": f"Account {account} is not available",
            }
        try:
            await asyncio.wait_for(
                self._ensure_portfolio_stream(account),
                timeout=PORTFOLIO_SYNC_TIMEOUT_SEC + 12,
            )
            return {"ok": True, "status": "synced", "account": account}
        except Exception as exc:
            self.last_error = f"portfolio_sync_failed: {exc}"
            return {
                "ok": False,
                "status": "portfolio_sync_failed",
                "message": str(exc) or "Portfolio sync timed out",
                "account": account,
            }

    def _sync_positions_from_ib(self, acct: str) -> None:
        old_positions = self._portfolio_positions.get(acct) or {}
        positions: Dict[int, Dict[str, Any]] = {}
        identity_observed_at = now_iso()
        for pos in self.ib.positions():
            if pos.account != acct:
                continue
            c = pos.contract
            cid = int(c.conId) if c.conId else None
            if cid is None:
                continue
            old_pos = old_positions.get(cid) or {}
            positions[cid] = {
                "account": pos.account,
                "symbol": c.symbol,
                "conId": cid,
                "secType": c.secType,
                "exchange": c.exchange,
                "currency": c.currency or "USD",
                "localSymbol": c.localSymbol or c.symbol,
                "position": float(pos.position),
                "avgCost": float(pos.avgCost),
                "marketValue": old_pos.get("marketValue"),
                "unrealizedPnL": old_pos.get("unrealizedPnL"),
                "realizedPnL": old_pos.get("realizedPnL"),
                # An identity/quantity refresh must not make a retained mark
                # look newly observed. Keep the legacy updated_at anchored to
                # the last portfolio-value event when one exists.
                "identity_observed_at": identity_observed_at,
                "mark_observed_at": (
                    old_pos.get("mark_observed_at")
                    or (
                        old_pos.get("updated_at")
                        if old_pos.get("marketValue") is not None
                        else None
                    )
                ),
                "updated_at": old_pos.get("updated_at") or identity_observed_at,
            }
        self._portfolio_positions[acct] = positions

    async def _subscribe_portfolio_quotes(self, acct: str) -> None:
        """Portfolio and browser consumers own independent, idempotent memberships."""
        rows = list((self._portfolio_positions.get(acct) or {}).values())
        contracts = [Contract(conId=int(row.get("conId") or 0)) for row in rows if row.get("conId")]
        result = await self.reconcile_subscriptions(f"portfolio:{acct}", contracts, contracts_are_native=True)
        if result.get("errors"):
            self.last_error = "portfolio_quote_warmup: " + "; ".join(result["errors"])

    def _on_update_portfolio(self, item: Any) -> None:
        acct = getattr(item, "account", None) or self._portfolio_account
        if not acct:
            return
        c = item.contract
        cid = int(c.conId) if c.conId else None
        if cid is None:
            return
        if acct not in self._portfolio_positions:
            self._portfolio_positions[acct] = {}
        position = float(item.position)
        market_value = float(item.marketValue) if item.marketValue == item.marketValue else None
        if position == 0 and (market_value is None or market_value == 0):
            self._portfolio_positions[acct].pop(cid, None)
            return
        observed_at = now_iso()
        self._portfolio_positions[acct][cid] = {
            "account": acct,
            "symbol": c.symbol,
            "conId": cid,
            "secType": c.secType,
            "exchange": c.exchange,
            "currency": c.currency or "USD",
            "localSymbol": c.localSymbol or c.symbol,
            "position": position,
            "avgCost": float(item.averageCost),
            "marketValue": market_value,
            "unrealizedPnL": float(item.unrealizedPNL) if item.unrealizedPNL == item.unrealizedPNL else None,
            "realizedPnL": float(item.realizedPNL) if item.realizedPNL == item.realizedPNL else None,
            "identity_observed_at": observed_at,
            "mark_observed_at": observed_at if market_value is not None else None,
            "updated_at": observed_at,
        }

    async def _account_summary_loop(self) -> None:
        while self._started:
            await asyncio.sleep(ACCOUNT_SUMMARY_REFRESH_SEC)
            if not self.ib.isConnected() or not self._portfolio_account:
                continue
            try:
                await asyncio.wait_for(
                    self._refresh_account_summary(self._portfolio_account),
                    timeout=10,
                )
            except Exception as exc:
                self.last_error = f"account_summary: {exc}"

    async def _refresh_account_summary(self, acct: str) -> None:
        rows = await self.ib.accountSummaryAsync(acct)
        summary: Dict[str, Any] = {"account": acct, "currency": "USD", "updated_at": now_iso()}
        for row in rows:
            tag = row.tag
            if tag in ACCOUNT_SUMMARY_TAG_SET:
                try:
                    summary[tag] = float(row.value)
                except (TypeError, ValueError):
                    summary[tag] = row.value
            if row.currency and tag == "NetLiquidation":
                summary["currency"] = row.currency
        self._account_summary[acct] = summary

    def _on_pending_tickers(self, tickers: list) -> None:
        for ticker in tickers:
            contract = ticker.contract
            if not contract or not contract.conId:
                continue
            cid = int(contract.conId)
            if cid not in self._ref_counts:
                continue
            for tick in list(getattr(ticker, "ticks", None) or []):
                if getattr(tick, "tickType", None) != 4:
                    continue
                last_price = strict_finite_float(getattr(tick, "price", None))
                tick_time = getattr(tick, "time", None)
                if (
                    last_price is None
                    or last_price <= 0
                    or not isinstance(tick_time, datetime)
                    or tick_time.tzinfo is None
                ):
                    continue
                self._live_last_ticks[cid] = {
                    "price": last_price,
                    "observedAt": tick_time.astimezone(timezone.utc),
                    "connectionGeneration": self._connection_generation,
                }
            raw = ticker_to_raw_quote(ticker, contract)
            self._quote_cache[cid] = raw
            self.last_tick_at = now_iso()
            self._pending_notify.add(cid)
        self._schedule_debounce()

    def _schedule_debounce(self) -> None:
        if self._debounce_task and not self._debounce_task.done():
            return
        self._debounce_task = asyncio.create_task(self._flush_notifications())

    async def _flush_notifications(self) -> None:
        await asyncio.sleep(STREAM_DEBOUNCE_MS / 1000.0)
        con_ids = list(self._pending_notify)
        self._pending_notify.clear()
        for cid in con_ids:
            raw = self._quote_cache.get(cid)
            if raw:
                self._broadcast_quote(raw)

    def _broadcast_quote(self, raw: Dict[str, Any]) -> None:
        if not self.connected or not raw_quote_is_ready(raw):
            return
        msg = {"type": "quote", "payload": raw}
        for queue in list(self._sse_clients):
            try:
                queue.put_nowait(msg)
            except Exception:
                pass

    def _broadcast_status(self, status: str, message: Optional[str]) -> None:
        msg = {
            "type": "status",
            "payload": {**self.status_payload(), "status": status, "message": message},
        }
        for queue in list(self._sse_clients):
            try:
                queue.put_nowait(msg)
            except Exception:
                pass

    def add_sse_client(self, queue: asyncio.Queue) -> None:
        self._sse_clients.add(queue)

    def remove_sse_client(self, queue: asyncio.Queue) -> None:
        self._sse_clients.discard(queue)

    def get_quote_cache_list(self, symbols: Optional[List[str]] = None) -> List[Dict[str, Any]]:
        sym_set = {s.upper() for s in symbols} if symbols else None
        out: List[Dict[str, Any]] = []
        for raw in self._quote_cache.values():
            if self.connected and raw_quote_is_ready(raw) and (sym_set is None or raw.get("symbol", "").upper() in sym_set):
                out.append(raw)
        return out

    def get_cached_quote_for_instrument(self, inst: Any) -> Optional[Dict[str, Any]]:
        if getattr(inst, "conId", None):
            return self._quote_cache.get(int(inst.conId))
        sec_type = (getattr(inst, "secType", None) or "STK").upper()
        exchange = (getattr(inst, "exchange", None) or "SMART").upper()
        currency = (getattr(inst, "currency", None) or "USD").upper()
        contract_specific = any(
            getattr(inst, field, None)
            for field in (
                "lastTradeDateOrContractMonth",
                "tradingClass",
                "multiplier",
            )
        )
        if (
            sec_type not in {"STK", "ETF"}
            or exchange != "SMART"
            or currency != "USD"
            or contract_specific
        ):
            return None
        symbol = (getattr(inst, "symbol", None) or "").upper()
        for raw in self._quote_cache.values():
            if raw.get("symbol", "").upper() == symbol:
                return raw
        return None

    async def _qualify_contract(
        self,
        contract: Contract,
        label: Any,
    ) -> tuple[Optional[Contract], Optional[str]]:
        """Resolve one exact contract under a bounded broker request."""
        try:
            qualified = await asyncio.wait_for(
                self.ib.qualifyContractsAsync(contract),
                timeout=QUOTE_QUALIFY_TIMEOUT_SEC,
            )
        except asyncio.TimeoutError:
            return None, f"qualification_timeout for {label}"
        except Exception as exc:
            return None, str(exc) or f"qualification_failed for {label}"

        requested_con_id = int(contract.conId) if contract.conId else None
        if requested_con_id is not None:
            exact = [
                candidate
                for candidate in list(qualified or [])
                if int(getattr(candidate, "conId", 0) or 0) == requested_con_id
            ]
            if len(exact) != 1:
                return None, f"Could not exactly qualify {label}"
            return exact[0], None

        if not qualified:
            return None, f"{UNKNOWN_CONTRACT_PREFIX}{label}"
        return qualified[0], None

    async def _identify_contract(
        self,
        contract: Contract,
        label: Any,
    ) -> tuple[Optional[Contract], Optional[str]]:
        """Qualify a contract, remembering the broker's answer for a symbol.

        A timeout or an error is never remembered: only what IBKR actually
        answered, a contract or "no such contract".
        """
        # Created on first use: tests build a manager without __init__.
        counts = self.__dict__.setdefault("_contract_lookup_counts", _new_contract_lookup_counts())
        memory = self.__dict__.setdefault("_contract_memory", {})
        key = contract_memory_key(contract)
        generation = self._connection_generation
        if key is not None:
            remembered = memory.get(key)
            if remembered is not None:
                remembered_generation, expires_at, qualified, error = remembered
                if remembered_generation == generation and time.monotonic() < expires_at:
                    counts["reused"] += 1
                    return qualified, error
                memory.pop(key, None)

        counts["asked"] += 1
        qualified, error = await self._qualify_contract(contract, label)
        if key is None or generation != self._connection_generation:
            return qualified, error
        if qualified is not None and error is None:
            lifetime = CONTRACT_MEMORY_SEC
        elif error and error.startswith(UNKNOWN_CONTRACT_PREFIX):
            lifetime = UNKNOWN_CONTRACT_MEMORY_SEC
        else:
            lifetime = 0.0
        if lifetime > 0:
            memory.pop(key, None)
            memory[key] = (generation, time.monotonic() + lifetime, qualified, error)
            while len(memory) > CONTRACT_MEMORY_LIMIT:
                memory.pop(next(iter(memory)))
        return qualified, error

    async def _wait_for_persistent_quote(
        self,
        cid: int,
        contract: Contract,
        timeout_sec: float,
    ) -> Dict[str, Any]:
        deadline = asyncio.get_running_loop().time() + timeout_sec
        last_raw = self._quote_cache.get(cid)
        while asyncio.get_running_loop().time() < deadline:
            ticker = self._tickers.get(cid)
            raw = self._quote_cache.get(cid)
            if ticker is not None:
                ticker_raw = ticker_to_raw_quote(ticker, contract)
                if raw is None or ticker_raw.get("fetched_at", "") >= raw.get("fetched_at", ""):
                    raw = ticker_raw
            if raw is not None:
                last_raw = raw
                if raw_quote_is_ready(raw):
                    return raw
            await asyncio.sleep(QUOTE_POLL_SEC)
        return last_raw or ticker_to_raw_quote(self._tickers.get(cid), contract)

    def _persistent_quote_wait(self, cid: int, contract: Contract, timeout_sec: float) -> float:
        """How long to wait for a subscribed contract's next tick.

        Its stream is already the freshest source there is. Once a tick has
        arrived, a stale quote means the market is quiet, and waiting out the
        whole timeout only holds the caller before the same answer. A
        subscription that has delivered nothing yet is still starting and
        gets the full wait.
        """
        last = self._quote_cache.get(cid)
        if last is None:
            ticker = self._tickers.get(cid)
            last = ticker_to_raw_quote(ticker, contract) if ticker is not None else None
        delivered = bool(last and last.get("timestamp"))
        return min(timeout_sec, SUBSCRIBED_QUOTE_WAIT_SEC) if delivered else timeout_sec

    async def _capture_temporary_quote(
        self,
        cid: int,
        contract: Contract,
        timeout_sec: float,
    ) -> Dict[str, Any]:
        async with self._quote_snapshot_semaphore:
            # A persistent subscription may have been established while this
            # request waited for a snapshot slot. Reuse it and never cancel it.
            if self._ref_counts.get(cid, 0) > 0:
                return await self._wait_for_persistent_quote(cid, contract, timeout_sec)

            ticker = self.ib.reqMktData(contract, "", False, False)
            try:
                deadline = asyncio.get_running_loop().time() + timeout_sec
                last_raw = ticker_to_raw_quote(ticker, contract)
                while asyncio.get_running_loop().time() < deadline:
                    last_raw = ticker_to_raw_quote(ticker, contract)
                    if raw_quote_is_ready(last_raw):
                        return last_raw
                    await asyncio.sleep(QUOTE_POLL_SEC)
                return last_raw
            finally:
                # Do not cancel a subscription that another request acquired
                # while this endpoint-owned snapshot was waiting.
                if self._ref_counts.get(cid, 0) <= 0:
                    try:
                        self.ib.cancelMktData(contract)
                    except Exception as exc:
                        self.last_error = f"quote_cancel: {exc}"
                    self._forget_endpoint_ticker(contract)

    def _forget_endpoint_ticker(self, contract: Contract) -> None:
        """Release ib_insync's Ticker for a finished one-off quote.

        ib_insync keeps one Ticker per contract object until the socket
        disconnects, and a one-off quote uses its own contract object. Without
        this, every such request leaves an object behind for the whole Gateway
        session. A contract that still has a subscription is left alone.
        """
        try:
            wrapper = self.ib.wrapper
            ticker = wrapper.tickers.get(id(contract))
            if ticker is None:
                return
            if any(ticker in subscribed for subscribed in wrapper.ticker2ReqId.values()):
                return
            wrapper.tickers.pop(id(contract), None)
            for req_id in [req_id for req_id, held in wrapper.reqId2Ticker.items() if held is ticker]:
                wrapper.reqId2Ticker.pop(req_id, None)
        except Exception:
            # Bookkeeping only: never disturb the quote that was just returned.
            pass

    async def _capture_broker_snapshot(
        self,
        cid: int,
        contract: Contract,
        timeout_sec: float,
    ) -> Dict[str, Any]:
        """Request a new IBKR snapshot without disturbing a live subscription.

        A persistent portfolio subscription can legitimately retain an old
        exchange timestamp when an instrument has not traded recently.  A
        manual Analyst refresh must therefore go back to IBKR instead of
        repeatedly reading that retained ticker.  The cloned contract gives
        ib_insync a distinct request/ticker identity, so cancelling this
        endpoint-owned snapshot cannot cancel the portfolio stream.
        """
        async with self._forced_quote_snapshot_semaphore:
            snapshot_contract = Contract.create(**contract.dict())
            await self._broker_snapshot_turn()
            requested_at = now_iso()
            ticker, req_id, ended = self._open_broker_snapshot(snapshot_contract)
            try:
                deadline = asyncio.get_running_loop().time() + timeout_sec
                last_raw = ticker_to_raw_quote(ticker, snapshot_contract)
                while asyncio.get_running_loop().time() < deadline:
                    last_raw = ticker_to_raw_quote(ticker, snapshot_contract)
                    if raw_quote_is_ready(last_raw):
                        break
                    await asyncio.sleep(QUOTE_POLL_SEC)
                return {
                    **last_raw,
                    "observationMode": "broker_snapshot",
                    "snapshotRequestedAt": requested_at,
                    "from_cache": False,
                }
            finally:
                self._release_broker_snapshot(snapshot_contract, req_id, ended)

    async def _broker_snapshot_turn(self) -> None:
        """Wait until this snapshot message may be sent.

        A whole-book refresh asks for some seventy snapshots at once, and it
        runs every thirty seconds. IBKR takes 50 API messages a second from a
        client and holds back the rest, so these leave at an even pace under
        that limit whatever else is being sent. Only snapshot messages wait
        here: a heartbeat or any other request is never queued behind them.
        """
        if SNAPSHOT_MESSAGE_INTERVAL_SEC <= 0:
            return
        lock = self.__dict__.get("_broker_snapshot_turn_lock")
        if lock is None:
            lock = self.__dict__.setdefault("_broker_snapshot_turn_lock", asyncio.Lock())
        loop = asyncio.get_running_loop()
        # Callers take turns in order, and each gap is measured from when the
        # previous message was actually released, so a late wake-up can only
        # widen a gap and never narrow the next one.
        async with lock:
            wait = (
                self.__dict__.get("_broker_snapshot_last_turn", 0.0)
                + SNAPSHOT_MESSAGE_INTERVAL_SEC
                - loop.time()
            )
            if wait > 0:
                await asyncio.sleep(wait)
            self._broker_snapshot_last_turn = loop.time()

    def _open_broker_snapshot(
        self,
        contract: Contract,
    ) -> tuple[Any, Optional[int], Optional[asyncio.Future]]:
        """Request one snapshot and learn when IBKR has ended it.

        IBKR ends a snapshot by itself once it has sent the quote, and answers
        a cancel for an ended request with error 300. The returned future is
        resolved by IBKR's end-of-snapshot message (or by an error for the
        request), which is how ib_insync's own ``reqTickersAsync`` tracks a
        snapshot. It is None when the client does not expose that bookkeeping;
        the request is then cancelled as soon as its quote has been read.
        """
        counts = self.__dict__.setdefault(
            "_broker_snapshot_counts", _new_broker_snapshot_counts()
        )
        counts["requested"] += 1
        client = getattr(self.ib, "client", None)
        wrapper = getattr(self.ib, "wrapper", None)
        tracked = all(
            callable(getattr(owner, name, None))
            for owner, name in (
                (client, "getReqId"),
                (client, "reqMktData"),
                (wrapper, "startReq"),
                (wrapper, "startTicker"),
                (wrapper, "endTicker"),
                (wrapper, "tickSnapshotEnd"),
            )
        )
        if not tracked:
            return self.ib.reqMktData(contract, "", True, False), None, None
        req_id = client.getReqId()
        ended = wrapper.startReq(req_id, contract)
        # A dropped socket fails every open request. Read that outcome here so
        # it is never reported as an error nobody collected.
        ended.add_done_callback(
            lambda future: None if future.cancelled() else future.exception()
        )
        ticker = wrapper.startTicker(req_id, contract, "mktData")
        try:
            client.reqMktData(req_id, contract, "", True, False, [])
        except Exception:
            # Never sent, so there is nothing for IBKR to end or to cancel.
            wrapper.endTicker(ticker, "mktData")
            wrapper.tickSnapshotEnd(req_id)
            self._forget_endpoint_ticker(contract)
            raise
        return ticker, req_id, ended

    def _release_broker_snapshot(
        self,
        contract: Contract,
        req_id: Optional[int],
        ended: Optional[asyncio.Future],
    ) -> None:
        """Let IBKR end the snapshot; cancel only one it has left open."""
        if ended is None or ended.done() or SNAPSHOT_END_GRACE_SEC <= 0:
            self._close_broker_snapshot(contract, req_id, ended)
            return
        # The quote is already with the caller and its snapshot slot is free.
        # The end-of-snapshot message usually follows within moments.
        closers = self.__dict__.setdefault("_broker_snapshot_closers", set())
        closer = asyncio.create_task(
            self._close_broker_snapshot_after_grace(contract, req_id, ended)
        )
        closers.add(closer)
        closer.add_done_callback(closers.discard)

    async def _close_broker_snapshot_after_grace(
        self,
        contract: Contract,
        req_id: Optional[int],
        ended: asyncio.Future,
    ) -> None:
        try:
            await asyncio.wait({ended}, timeout=SNAPSHOT_END_GRACE_SEC)
            if not ended.done():
                # A cancel is a snapshot message too and takes its turn.
                await self._broker_snapshot_turn()
        finally:
            self._close_broker_snapshot(contract, req_id, ended)

    def _close_broker_snapshot(
        self,
        contract: Contract,
        req_id: Optional[int],
        ended: Optional[asyncio.Future],
    ) -> None:
        counts = self.__dict__.setdefault(
            "_broker_snapshot_counts", _new_broker_snapshot_counts()
        )
        try:
            if ended is not None and ended.done():
                # Over at the Gateway (or the socket is gone): nothing to
                # cancel, only this client's own record of the request.
                wrapper = self.ib.wrapper
                ticker = wrapper.tickers.get(id(contract))
                if ticker is not None:
                    wrapper.endTicker(ticker, "mktData")
                if not ended.cancelled() and ended.exception() is None:
                    counts["endedByGateway"] += 1
            else:
                counts["cancelled"] += 1
                try:
                    self.ib.cancelMktData(contract)
                finally:
                    if ended is not None:
                        # A cancelled request gets no end-of-snapshot message.
                        self.ib.wrapper.tickSnapshotEnd(req_id)
        except Exception as exc:
            self.last_error = f"forced_quote_cancel: {exc}"
        self._forget_endpoint_ticker(contract)

    async def get_quote_for_instrument(
        self,
        inst: Any,
        timeout_sec: float = QUOTE_WAIT_SEC,
        force_refresh: bool = False,
    ) -> Dict[str, Any]:
        """Fetch one quote without fabricating a timestamp or cancelling streams."""
        generation = self._connection_generation
        if not self.connected:
            return {"quote": None, "error": "not_connected"}
        contract = self.instrument_to_contract(inst)
        label = getattr(inst, "localSymbol", None) or getattr(inst, "symbol", None) or getattr(inst, "conId", None)
        requested_cid = int(contract.conId) if contract.conId else None
        # Stable contract identity is not price data. The broker-qualified
        # contract already owned by the persistent stream is reused for every
        # quote; a forced snapshot still requests each mark anew from IBKR.
        qualified_contract = (
            self._contracts.get(requested_cid)
            if requested_cid is not None
            else None
        )
        qualification_error = None
        if qualified_contract is None:
            qualified_contract, qualification_error = await self._identify_contract(contract, label)
        if qualification_error:
            return {"quote": None, "error": qualification_error}
        cid = int(qualified_contract.conId) if qualified_contract.conId else None
        if cid is None:
            return {"quote": None, "error": f"No conId for {qualified_contract.symbol}"}

        if generation != self._connection_generation or not self.connected:
            return {"quote": None, "error": "connection_changed"}
        cached = self._quote_cache.get(cid)
        if not force_refresh and raw_quote_is_ready(cached):
            return {"quote": cached, "error": None, "from_cache": True}

        task_key = (cid, "broker_snapshot" if force_refresh else "current_stream", generation)
        task = self._quote_snapshot_tasks.get(task_key)
        if task is None or task.done():
            task = asyncio.create_task(
                self._capture_broker_snapshot(cid, qualified_contract, timeout_sec)
                if force_refresh
                else (
                    self._wait_for_persistent_quote(
                        cid,
                        qualified_contract,
                        self._persistent_quote_wait(cid, qualified_contract, timeout_sec),
                    )
                    if self._ref_counts.get(cid, 0) > 0
                    else self._capture_temporary_quote(cid, qualified_contract, timeout_sec)
                )
            )
            self._quote_snapshot_tasks[task_key] = task

            def forget(_completed: asyncio.Task, quote_task_key: tuple = task_key) -> None:
                if self._quote_snapshot_tasks.get(quote_task_key) is _completed:
                    self._quote_snapshot_tasks.pop(quote_task_key, None)

            task.add_done_callback(forget)

        try:
            raw = await asyncio.shield(task)
        except Exception as exc:
            return {"quote": None, "error": str(exc) or "quote_request_failed"}
        return {
            "quote": raw if generation == self._connection_generation and self.connected else None,
            "error": (None if raw_quote_is_ready(raw) else "quote_timeout") if generation == self._connection_generation and self.connected else "connection_changed",
            "from_cache": False,
            "refreshMode": "broker_snapshot" if force_refresh else "current_stream",
        }

    async def _resubscribe_all(self) -> None:
        async with self._lock:
            for cid in list(self._ref_counts.keys()):
                if self._ref_counts.get(cid, 0) > 0 and cid in self._contracts:
                    contract = self._contracts[cid]
                    if cid not in self._tickers:
                        ticker = self.ib.reqMktData(contract, "", False, False)
                        self._tickers[cid] = ticker

    async def reconcile_subscriptions(self, owner: str, instruments: List[Any], *, contracts_are_native: bool = False) -> Dict[str, Any]:
        """Replace one consumer's complete desired set; retries never increase references."""
        if not self.connected or not self.ib.isConnected():
            return {"ok": False, "errors": ["not_connected"], "subscribed": []}
        async with self._owner_reconcile_lock:
            generation = self._connection_generation
            desired: Dict[int, Contract] = {}
            errors: List[str] = []
            qualification_slots = asyncio.Semaphore(6)

            async def qualify(inst):
                contract = inst if contracts_are_native else self.instrument_to_contract(inst)
                cid = int(getattr(contract, "conId", None) or 0)
                if cid and cid in self._contracts:
                    return self._contracts[cid], None
                async with qualification_slots:
                    return await self._qualify_contract(contract, getattr(contract, "symbol", None) or str(cid))

            for qc, error in await asyncio.gather(*(qualify(inst) for inst in instruments)):
                if error or not qc or not qc.conId:
                    errors.append(error or "unqualified_contract")
                else:
                    desired[int(qc.conId)] = qc
            async with self._lock:
                if generation != self._connection_generation or not self.connected:
                    return {"ok": False, "errors": ["connection_changed"], "subscribed": []}
                previous = self._subscription_owners.get(owner, set())
                retained = set(previous)
                # Only release this owner's membership. Portfolio/other owners retain theirs.
                for cid in previous - desired.keys():
                    refs = self._ref_counts.get(cid, 0)
                    if refs > 1:
                        self._ref_counts[cid] = refs - 1
                    else:
                        contract = self._contracts.pop(cid, None)
                        self._ref_counts.pop(cid, None)
                        self._tickers.pop(cid, None)
                        self._quote_cache.pop(cid, None)
                        if contract:
                            try:
                                self.ib.cancelMktData(contract)
                            except Exception as exc:
                                errors.append(str(exc))
                    retained.discard(cid)
                for cid, contract in desired.items():
                    if cid in retained:
                        continue
                    refs = self._ref_counts.get(cid, 0)
                    if refs == 0 and len(self._ref_counts) >= MAX_STREAM_SUBS:
                        errors.append(f"Max subscriptions ({MAX_STREAM_SUBS}) reached")
                        continue
                    try:
                        if refs == 0:
                            self._tickers[cid] = self.ib.reqMktData(contract, "", False, False)
                        self._contracts[cid] = contract
                        self._ref_counts[cid] = refs + 1
                        retained.add(cid)
                    except Exception as exc:
                        errors.append(str(exc))
                self._subscription_owners[owner] = retained
                return {"ok": not errors, "errors": errors, "subscribed": [self._contracts[cid].symbol for cid in retained]}

    async def subscribe(self, instruments: List[Any]) -> Dict[str, Any]:
        health = await self.ensure_connected()
        if not health["ok"]:
            return {"ok": False, "message": health.get("message"), "subscribed": []}

        subscribed: List[str] = []
        errors: List[str] = []

        async with self._lock:
            for inst in instruments:
                try:
                    contract = self.instrument_to_contract(inst)
                    qualified = await self.ib.qualifyContractsAsync(contract)
                    if not qualified:
                        errors.append(f"Could not qualify {getattr(inst, 'symbol', None)}")
                        continue
                    qc = qualified[0]
                    cid = int(qc.conId) if qc.conId else None
                    if cid is None:
                        errors.append(f"No conId for {qc.symbol}")
                        continue

                    prev = self._ref_counts.get(cid, 0)
                    if prev == 0 and len(self._ref_counts) >= MAX_STREAM_SUBS:
                        errors.append(f"Max subscriptions ({MAX_STREAM_SUBS}) reached")
                        continue

                    self._ref_counts[cid] = prev + 1
                    self._contracts[cid] = qc
                    if prev == 0:
                        ticker = self.ib.reqMktData(qc, "", False, False)
                        self._tickers[cid] = ticker
                    subscribed.append(qc.symbol)
                except Exception as exc:
                    errors.append(str(exc))

        return {
            "ok": True,
            "subscribed": subscribed,
            "errors": errors,
            "active_subscriptions": len(self._ref_counts),
        }

    async def unsubscribe(self, instruments: List[Any]) -> Dict[str, Any]:
        unsubscribed: List[str] = []
        errors: List[str] = []

        async with self._lock:
            for inst in instruments:
                try:
                    cid = None
                    if getattr(inst, "conId", None):
                        cid = int(inst.conId)
                    else:
                        contract = self.instrument_to_contract(inst)
                        qualified = await self.ib.qualifyContractsAsync(contract)
                        if qualified and qualified[0].conId:
                            cid = int(qualified[0].conId)

                    if cid is None:
                        continue

                    prev = self._ref_counts.get(cid, 0)
                    if prev <= 0:
                        continue
                    if prev == 1:
                        self._ref_counts.pop(cid, None)
                        contract = self._contracts.pop(cid, None)
                        self._tickers.pop(cid, None)
                        self._quote_cache.pop(cid, None)
                        if contract and self.ib.isConnected():
                            self.ib.cancelMktData(contract)
                        unsubscribed.append(contract.symbol if contract else str(cid))
                    else:
                        self._ref_counts[cid] = prev - 1
                        unsubscribed.append(self._contracts[cid].symbol if cid in self._contracts else str(cid))
                except Exception as exc:
                    errors.append(str(exc))

        return {"ok": True, "unsubscribed": unsubscribed, "errors": errors}

    def get_portfolio_cache(self, account: Optional[str] = None) -> Dict[str, Any]:
        acct = account or self._portfolio_account
        if not acct:
            return {"ok": False, "message": "No account", "positions": [], "fetched_at": now_iso()}
        raw_positions = list((self._portfolio_positions.get(acct) or {}).values())
        positions = [
            p for p in raw_positions
            if float(p.get("position") or 0) != 0 or float(p.get("marketValue") or 0) != 0
        ]
        return {
            "ok": True,
            "account": acct,
            "positions": positions,
            "fetched_at": now_iso(),
        }

    def get_fresh_direct_live_marks(
        self,
        con_ids: List[int],
        *,
        max_age_seconds: float,
    ) -> Dict[int, Dict[str, Any]]:
        """Return only direct, fresh IBKR live-last ticks from active streams.

        This deliberately bypasses ``_quote_cache``. A fetched/cache timestamp
        cannot prove when IBKR observed a price, so only the ticker's native,
        timezone-aware timestamp is accepted.
        """
        if not self.connected or not self.ib.isConnected():
            return {}

        current = datetime.now(timezone.utc)
        marks: Dict[int, Dict[str, Any]] = {}
        for raw_con_id in con_ids:
            try:
                con_id = int(raw_con_id)
            except (TypeError, ValueError):
                continue
            ticker = self._tickers.get(con_id)
            last_tick = self._live_last_ticks.get(con_id)
            if (
                ticker is None
                or last_tick is None
                or strict_market_data_type(getattr(ticker, "marketDataType", None)) != 1
                or last_tick.get("connectionGeneration")
                != self._connection_generation
            ):
                continue

            observed = last_tick["observedAt"]
            age_seconds = (current - observed).total_seconds()
            if age_seconds < -5 or age_seconds > max_age_seconds:
                continue

            last = last_tick["price"]

            marks[con_id] = {
                "liveMark": last,
                "liveMarkSource": "ibkr_live_last",
                "liveMarkObservedAt": observed.isoformat().replace("+00:00", "Z"),
                "marketDataType": 1,
            }
        return marks

    def get_account_summary_cache(self, account: Optional[str] = None) -> Dict[str, Any]:
        acct = account or self._portfolio_account
        if not acct or acct not in self._account_summary:
            return {"ok": False, "message": "No cached summary", "summary": {}, "fetched_at": now_iso()}
        return {
            "ok": True,
            "summary": self._account_summary[acct],
            "fetched_at": self._account_summary[acct].get("updated_at", now_iso()),
        }

    async def sse_generator(self):
        queue: asyncio.Queue = asyncio.Queue(maxsize=500)
        self.add_sse_client(queue)
        try:
            yield f"data: {json.dumps({'type': 'status', 'payload': self.status_payload()})}\n\n"
            while True:
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    msg = {"type": "status", "payload": self.status_payload()}
                yield f"data: {json.dumps(msg)}\n\n"
        finally:
            self.remove_sse_client(queue)
