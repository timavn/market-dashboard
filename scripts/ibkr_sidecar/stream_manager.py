"""Persistent IBKR connection, streaming quote cache, and portfolio caches."""

from __future__ import annotations

import asyncio
import json
import math
import os
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Set

from ib_insync import Contract, IB

from gateway_connection_governor import GatewayConnectionGovernor

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
        try:
            return math.isfinite(float(value)) and float(value) > 0
        except (TypeError, ValueError):
            return False

    if not (
        positive(raw.get("last"))
        or (positive(raw.get("bid")) and positive(raw.get("ask")))
    ):
        return False
    if str(raw.get("dataType") or "").lower() not in {"live", "delayed"}:
        return False
    entitlement = str(raw.get("entitlementStatus") or "").lower()
    if not entitlement or entitlement in {
        "denied",
        "not_entitled",
        "unavailable",
        "disabled",
        "offline",
    }:
        return False
    age_sec = _quote_timestamp_age_sec(raw.get("timestamp"))
    return age_sec is not None and age_sec >= -30 and age_sec <= max_age_sec


def ticker_to_raw_quote(ticker: Any, contract: Contract) -> Dict[str, Any]:
    """Return IB-native tick fields; normalization happens in Node."""
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

    if ticker is None:
        return {
            "symbol": contract.symbol,
            "conId": int(contract.conId) if contract.conId else None,
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

    market_data_type = getattr(ticker, "marketDataType", None)
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
    if hasattr(ticker, "tickByTicks"):
        entitlement = "tick_by_tick"
    elif market_data_type is not None:
        entitlement = data_type

    return {
        "symbol": contract.symbol,
        "conId": int(contract.conId) if contract.conId else None,
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
        self._contracts: Dict[int, Contract] = {}
        self._tickers: Dict[int, Any] = {}
        self._live_last_ticks: Dict[int, Dict[str, Any]] = {}
        self._connection_generation = 0
        self._quote_snapshot_semaphore = asyncio.Semaphore(QUOTE_MAX_CONCURRENCY)
        self._forced_quote_snapshot_semaphore = asyncio.Semaphore(FORCED_QUOTE_MAX_CONCURRENCY)
        self._quote_snapshot_tasks: Dict[int, asyncio.Task] = {}

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
            "reconnecting": self.reconnecting,
            "persistent": PERSISTENT_CONNECT,
            "last_tick_at": self.last_tick_at,
            "last_error": self.last_error,
            "active_subscriptions": len(self._ref_counts),
            "max_stream_subs": MAX_STREAM_SUBS,
            "forced_quote_max_concurrency": FORCED_QUOTE_MAX_CONCURRENCY,
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
            result = await self.connect()
            if result.get("ok"):
                self._broadcast_status("connected", None)
                asyncio.ensure_future(self._pre_warm_portfolio())
            else:
                self.last_error = result.get("message")
                self._broadcast_status("reconnecting", result.get("message"))
                retry_after = max(1.0, float(result.get("retry_after_ms") or 0) / 1000.0)
                await asyncio.sleep(min(retry_after, 60.0))

    async def _pre_warm_portfolio(self) -> None:
        """Pre-warm the portfolio cache for all managed accounts after connect."""
        try:
            await asyncio.sleep(1.0)  # brief settle for account list
            accounts = self.ib.managedAccounts()
            for acct in accounts:
                try:
                    await asyncio.wait_for(self._ensure_portfolio_stream(acct), timeout=25)
                except Exception:
                    pass
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
        """Keep quote cache warm for active portfolio positions."""
        rows = list((self._portfolio_positions.get(acct) or {}).values())
        if not rows:
            return

        qualified_rows = []
        for row in rows:
            cid = int(row.get("conId") or 0)
            if not cid or cid in self._ref_counts:
                continue
            qualified_contract, error = await self._qualify_contract(
                Contract(conId=cid),
                row.get("localSymbol") or row.get("symbol") or str(cid),
            )
            if error:
                self.last_error = f"portfolio_quote_warmup: {error}"
                continue
            qualified_rows.append((cid, qualified_contract))

        async with self._lock:
            for cid, contract in qualified_rows:
                if cid in self._ref_counts:
                    continue
                if len(self._ref_counts) >= MAX_STREAM_SUBS:
                    self.last_error = f"portfolio_quote_warmup_limited: max {MAX_STREAM_SUBS}"
                    return

                try:
                    ticker = self.ib.reqMktData(contract, "", False, False)
                    self._ref_counts[cid] = 1
                    self._contracts[cid] = contract
                    self._tickers[cid] = ticker
                except Exception as exc:
                    self.last_error = f"portfolio_quote_warmup: {exc}"

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
                try:
                    last_price = float(getattr(tick, "price", None))
                except (TypeError, ValueError):
                    continue
                tick_time = getattr(tick, "time", None)
                if (
                    last_price != last_price
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
            if sym_set is None or raw.get("symbol", "").upper() in sym_set:
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
            return None, f"Could not qualify {label}"
        return qualified[0], None

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
            requested_at = now_iso()
            ticker = self.ib.reqMktData(snapshot_contract, "", True, False)
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
                try:
                    self.ib.cancelMktData(snapshot_contract)
                except Exception as exc:
                    self.last_error = f"forced_quote_cancel: {exc}"

    async def get_quote_for_instrument(
        self,
        inst: Any,
        timeout_sec: float = QUOTE_WAIT_SEC,
        force_refresh: bool = False,
    ) -> Dict[str, Any]:
        """Fetch one quote without fabricating a timestamp or cancelling streams."""
        contract = self.instrument_to_contract(inst)
        label = getattr(inst, "localSymbol", None) or getattr(inst, "symbol", None) or getattr(inst, "conId", None)
        requested_cid = int(contract.conId) if contract.conId else None
        # Stable contract identity is not price data. For a forced snapshot,
        # reuse the broker-qualified contract already owned by the persistent
        # portfolio stream, while still requesting every mark anew from IBKR.
        qualified_contract = (
            self._contracts.get(requested_cid)
            if force_refresh and requested_cid is not None
            else None
        )
        qualification_error = None
        if qualified_contract is None:
            qualified_contract, qualification_error = await self._qualify_contract(contract, label)
        if qualification_error:
            return {"quote": None, "error": qualification_error}
        cid = int(qualified_contract.conId) if qualified_contract.conId else None
        if cid is None:
            return {"quote": None, "error": f"No conId for {qualified_contract.symbol}"}

        cached = self._quote_cache.get(cid)
        if not force_refresh and raw_quote_is_ready(cached):
            return {"quote": cached, "error": None, "from_cache": True}

        task_key = (cid, "broker_snapshot" if force_refresh else "current_stream")
        task = self._quote_snapshot_tasks.get(task_key)
        if task is None or task.done():
            task = asyncio.create_task(
                self._capture_broker_snapshot(cid, qualified_contract, timeout_sec)
                if force_refresh
                else (
                    self._wait_for_persistent_quote(cid, qualified_contract, timeout_sec)
                    if self._ref_counts.get(cid, 0) > 0
                    else self._capture_temporary_quote(cid, qualified_contract, timeout_sec)
                )
            )
            self._quote_snapshot_tasks[task_key] = task

            def forget(_completed: asyncio.Task, quote_task_key: tuple[int, str] = task_key) -> None:
                if self._quote_snapshot_tasks.get(quote_task_key) is _completed:
                    self._quote_snapshot_tasks.pop(quote_task_key, None)

            task.add_done_callback(forget)

        try:
            raw = await asyncio.shield(task)
        except Exception as exc:
            return {"quote": None, "error": str(exc) or "quote_request_failed"}
        return {
            "quote": raw,
            "error": None if raw_quote_is_ready(raw) else "quote_timeout",
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
                or getattr(ticker, "marketDataType", None) != 1
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
                msg = await queue.get()
                yield f"data: {json.dumps(msg)}\n\n"
        finally:
            self.remove_sse_client(queue)
