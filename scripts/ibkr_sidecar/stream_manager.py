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

    async def start(self) -> None:
        if self._started:
            return
        self._started = True
        self.ib.pendingTickersEvent += self._on_pending_tickers
        self.ib.updatePortfolioEvent += self._on_update_portfolio
        self.ib.disconnectedEvent += self._on_disconnected
        if PERSISTENT_CONNECT:
            await self.connect()
            self._reconnect_task = asyncio.create_task(self._reconnect_loop())
            self._summary_task = asyncio.create_task(self._account_summary_loop())

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

    async def connect(self) -> Dict[str, Any]:
        if self.ib.isConnected():
            self.connected = True
            self.reconnecting = False
            await self._ensure_portfolio_stream()
            await self._resubscribe_all()
            return {"ok": True, "status": "connected"}

        try:
            await asyncio.wait_for(
                self.ib.connectAsync(
                    self.host, self.port, clientId=self.client_id, readonly=True
                ),
                timeout=self.connect_timeout,
            )
            if self.ib.isConnected():
                self.connected = True
                self.reconnecting = False
                self.last_error = None
                await self._ensure_portfolio_stream()
                await self._resubscribe_all()
                return {"ok": True, "status": "connected"}
            return {"ok": False, "status": "tws_offline", "message": "IB API socket did not connect"}
        except (ConnectionRefusedError, TimeoutError, asyncio.TimeoutError, OSError) as exc:
            self.connected = False
            self.last_error = str(exc)
            return {
                "ok": False,
                "status": "tws_offline",
                "message": f"IB Gateway/TWS not reachable at {self.host}:{self.port}: {exc}",
            }
        except Exception as exc:
            self.connected = False
            self.last_error = str(exc)
            return {"ok": False, "status": "error", "message": str(exc)}

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
            else:
                attempt += 1
                self.last_error = result.get("message")
                self._broadcast_status("reconnecting", result.get("message"))

    async def _ensure_portfolio_stream(self) -> None:
        accounts = self.ib.managedAccounts()
        if not accounts:
            return
        acct = accounts[0]
        if self._portfolio_account == acct and self._account_updates_active:
            return
        self._portfolio_account = acct
        try:
            self.ib.reqAccountUpdates(acct)
            self._account_updates_active = True
            await self.ib.reqPositionsAsync()
            await asyncio.sleep(0.3)
            self._sync_positions_from_ib(acct)
            await self._refresh_account_summary(acct)
        except Exception as exc:
            self.last_error = f"portfolio_stream: {exc}"

    def _sync_positions_from_ib(self, acct: str) -> None:
        positions: Dict[int, Dict[str, Any]] = {}
        for pos in self.ib.positions():
            if pos.account != acct:
                continue
            c = pos.contract
            cid = int(c.conId) if c.conId else None
            if cid is None:
                continue
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
                "marketValue": None,
                "unrealizedPnL": None,
                "realizedPnL": None,
                "updated_at": now_iso(),
            }
        self._portfolio_positions[acct] = positions

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
        self._portfolio_positions[acct][cid] = {
            "account": acct,
            "symbol": c.symbol,
            "conId": cid,
            "secType": c.secType,
            "exchange": c.exchange,
            "currency": c.currency or "USD",
            "localSymbol": c.localSymbol or c.symbol,
            "position": float(item.position),
            "avgCost": float(item.averageCost),
            "marketValue": float(item.marketValue) if item.marketValue == item.marketValue else None,
            "unrealizedPnL": float(item.unrealizedPNL) if item.unrealizedPNL == item.unrealizedPNL else None,
            "realizedPnL": float(item.realizedPNL) if item.realizedPNL == item.realizedPNL else None,
            "updated_at": now_iso(),
        }

    async def _account_summary_loop(self) -> None:
        while self._started:
            await asyncio.sleep(ACCOUNT_SUMMARY_REFRESH_SEC)
            if not self.ib.isConnected() or not self._portfolio_account:
                continue
            try:
                await self._refresh_account_summary(self._portfolio_account)
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
        positions = list((self._portfolio_positions.get(acct) or {}).values())
        return {
            "ok": True,
            "account": acct,
            "positions": positions,
            "fetched_at": now_iso(),
        }

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
