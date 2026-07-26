"""Persistent IBKR connection, streaming quote cache, and portfolio caches."""

from __future__ import annotations

import asyncio
import json
import os
import random
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Set

from ib_insync import Contract, IB

PERSISTENT_CONNECT = os.environ.get("IBKR_PERSISTENT_CONNECT", "true").lower() == "true"
MAX_STREAM_SUBS = int(os.environ.get("IBKR_MAX_STREAM_SUBS", "100"))
STREAM_DEBOUNCE_MS = int(os.environ.get("IBKR_STREAM_DEBOUNCE_MS", "150"))
RECONNECT_BASE_MS = int(os.environ.get("IBKR_RECONNECT_BASE_MS", "1000"))
ACCOUNT_SUMMARY_REFRESH_SEC = float(os.environ.get("IBKR_ACCOUNT_SUMMARY_REFRESH_SEC", "30"))
CLIENT_ID_MAX_ATTEMPTS = int(os.environ.get("IB_GATEWAY_CLIENT_ID_ATTEMPTS", "10"))
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


def ticker_to_raw_quote(ticker: Any, contract: Contract) -> Dict[str, Any]:
    """Return IB-native tick fields; normalization happens in Node."""
    ts = None
    if getattr(ticker, "time", None):
        try:
            ts = ticker.time.isoformat()
        except Exception:
            ts = str(ticker.time)

    market_data_type = getattr(ticker, "marketDataType", None)
    data_type_map = {1: "live", 2: "frozen", 3: "delayed", 4: "delayed_frozen"}
    data_type = data_type_map.get(market_data_type, "unknown")

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

    bid = safe_float(ticker.bid)
    ask = safe_float(ticker.ask)
    last = safe_float(ticker.last)
    close = safe_float(ticker.close) or safe_float(getattr(ticker, "prevClose", None))

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
        "currency": contract.currency or "USD",
        "localSymbol": contract.localSymbol or contract.symbol,
        "bid": bid,
        "ask": ask,
        "last": last,
        "close": close,
        "volume": safe_float(ticker.volume),
        "dataType": data_type,
        "entitlementStatus": entitlement,
        "timestamp": ts or now_iso(),
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
    ) -> None:
        self.ib = ib
        self.host = host
        self.port = port
        self.client_id = client_id
        self.connect_timeout = connect_timeout
        self.instrument_to_contract = instrument_to_contract

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
            "portfolio_account": self._portfolio_account,
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
        for task in (self._reconnect_task, self._summary_task, self._debounce_task):
            if task and not task.done():
                task.cancel()
        if self.ib.isConnected():
            try:
                self.ib.disconnect()
            except Exception:
                pass
        self.connected = False

    async def _try_connect_once(self, client_id: int) -> bool:
        if self.ib.isConnected():
            try:
                self.ib.disconnect()
            except Exception:
                pass
        try:
            await asyncio.wait_for(
                self.ib.connectAsync(
                    self.host, self.port, clientId=client_id, readonly=True
                ),
                timeout=self.connect_timeout,
            )
            return self.ib.isConnected()
        except (ConnectionRefusedError, TimeoutError, asyncio.TimeoutError, OSError, asyncio.CancelledError):
            if self.ib.isConnected():
                try:
                    self.ib.disconnect()
                except Exception:
                    pass
            return False
        except Exception:
            if self.ib.isConnected():
                try:
                    self.ib.disconnect()
                except Exception:
                    pass
            return False

    async def connect(self) -> Dict[str, Any]:
        async with self._connect_lock:
            if self.ib.isConnected():
                if not self.connected:
                    self._connection_generation += 1
                    self._live_last_ticks.clear()
                self.connected = True
                self.reconnecting = False
                await self._resubscribe_all()
                return {"ok": True, "status": "connected", "client_id": self.client_id}

            base_id = self.client_id
            last_msg = None
            for offset in range(CLIENT_ID_MAX_ATTEMPTS):
                candidate = base_id + offset
                if await self._try_connect_once(candidate):
                    self.client_id = candidate
                    self._connection_generation += 1
                    self._live_last_ticks.clear()
                    self.connected = True
                    self.reconnecting = False
                    self.last_error = None
                    await self._resubscribe_all()
                    return {"ok": True, "status": "connected", "client_id": self.client_id}
                last_msg = f"clientId {candidate} unavailable (in use or timed out)"

            self.connected = False
            self.last_error = last_msg
            return {
                "ok": False,
                "status": "tws_offline",
                "message": (
                    f"IB Gateway/TWS not reachable at {self.host}:{self.port} "
                    f"(tried clientIds {base_id}-{base_id + CLIENT_ID_MAX_ATTEMPTS - 1}). "
                    f"Stop duplicate sidecars: pkill -f 'uvicorn app:app'"
                ),
            }

    async def ensure_connected(self) -> Dict[str, Any]:
        if PERSISTENT_CONNECT:
            if self.ib.isConnected():
                self.connected = True
                return {"ok": True, "status": "connected"}
            return await self.connect()
        if self.ib.isConnected():
            return {"ok": True, "status": "connected"}
        return await self.connect()

    def _on_disconnected(self) -> None:
        self.connected = False
        self._live_last_ticks.clear()
        self._tickers.clear()
        self._quote_cache.clear()
        self._pending_notify.clear()
        self._broadcast_status("disconnected", "IB socket disconnected")

    async def _reconnect_loop(self) -> None:
        attempt = 0
        while self._started:
            await asyncio.sleep(1.0)
            if self.ib.isConnected():
                attempt = 0
                continue
            self.reconnecting = True
            self.connected = False
            delay = min(RECONNECT_BASE_MS * (2**attempt) / 1000.0, 60.0)
            delay += random.uniform(0, 0.5)
            await asyncio.sleep(delay)
            result = await self.connect()
            if result.get("ok"):
                attempt = 0
                self._broadcast_status("connected", None)
                asyncio.ensure_future(self._pre_warm_portfolio())
            else:
                attempt += 1
                self.last_error = result.get("message")
                self._broadcast_status("reconnecting", result.get("message"))

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

        async with self._lock:
            for row in rows:
                cid = int(row.get("conId") or 0)
                if not cid or cid in self._ref_counts:
                    continue
                if len(self._ref_counts) >= MAX_STREAM_SUBS:
                    self.last_error = f"portfolio_quote_warmup_limited: max {MAX_STREAM_SUBS}"
                    return

                contract = Contract()
                contract.conId = cid
                contract.symbol = row.get("symbol") or ""
                contract.secType = row.get("secType") or "STK"
                contract.exchange = row.get("exchange") or "SMART"
                contract.currency = row.get("currency") or "USD"

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
        symbol = (getattr(inst, "symbol", None) or "").upper()
        for raw in self._quote_cache.values():
            if raw.get("symbol", "").upper() == symbol:
                return raw
        return None

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
