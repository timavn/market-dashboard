import asyncio
import json
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse, StreamingResponse
from ib_insync import Contract, IB, util
from pydantic import BaseModel, Field

from stream_manager import PERSISTENT_CONNECT, StreamManager, ticker_to_raw_quote

APP_DIR = Path(__file__).resolve().parent
SEED_PATH = Path(os.environ.get("IBKR_EVENT_CONTRACTS_PATH", APP_DIR / "event_contracts.json"))

IB_HOST = os.environ.get("IB_GATEWAY_HOST", "127.0.0.1")
IB_PORT = int(os.environ.get("IB_GATEWAY_PORT", "4002"))
IB_CLIENT_ID = int(os.environ.get("IB_GATEWAY_CLIENT_ID", "17"))
CONNECT_TIMEOUT = float(os.environ.get("IB_GATEWAY_CONNECT_TIMEOUT_SEC", "2.5"))
MAX_QUOTE_BATCH = int(os.environ.get("IBKR_MAX_QUOTE_BATCH", "50"))
QUOTE_WAIT_SEC = float(os.environ.get("IBKR_QUOTE_WAIT_SEC", "1.0"))

ib = IB()

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


stream_manager: Optional[StreamManager] = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global stream_manager
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
    await stream_manager.start()
    yield
    if stream_manager:
        await stream_manager.stop()
    elif ib.isConnected():
        try:
            ib.disconnect()
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


def load_seed_contracts() -> List[Dict[str, Any]]:
    if not SEED_PATH.exists():
        return []
    with SEED_PATH.open("r", encoding="utf-8") as f:
        data = json.load(f)
    return data.get("contracts", [])


def save_seed_contracts(contracts: List[Dict[str, Any]]) -> None:
    payload: Dict[str, Any] = {"contracts": contracts}
    if SEED_PATH.exists():
        with SEED_PATH.open("r", encoding="utf-8") as f:
            existing = json.load(f)
        if "example_contract" in existing:
            payload["example_contract"] = existing["example_contract"]
    SEED_PATH.parent.mkdir(parents=True, exist_ok=True)
    with SEED_PATH.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")


def contract_to_seed(contract: Contract, venue: str) -> Dict[str, Any]:
    trading_class = getattr(contract, "tradingClass", "") or ""
    return {
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
    }


async def discover_event_contract_seeds(
    max_per_venue: int = int(os.environ.get("IBKR_DISCOVER_MAX_PER_VENUE", "25")),
) -> List[Dict[str, Any]]:
    """Search IB for ForecastEx and CME event (EC*) contracts when Gateway is connected."""
    seeds: List[Dict[str, Any]] = []
    seen: set = set()

    searches = [
        (Contract(secType="OPT", exchange="FORECASTX"), "ForecastEx"),
        (Contract(secType="FOP", exchange="CME"), "CME"),
        (Contract(secType="FUT", exchange="CME", tradingClass="EC"), "CME"),
    ]

    for template, venue in searches:
        try:
            details = await ib.reqContractDetailsAsync(template)
        except Exception:
            continue
        count = 0
        for detail in details:
            contract = detail.contract
            if venue == "CME":
                tc = getattr(contract, "tradingClass", "") or ""
                if not tc.startswith("EC"):
                    continue
            key = contract.conId or f"{contract.localSymbol}:{contract.exchange}"
            if key in seen:
                continue
            seen.add(key)
            seed = contract_to_seed(contract, venue)
            if seed.get("conId"):
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
    no_bid = 1 - ask if ask is not None else None
    no_ask = 1 - bid if bid is not None else None

    raw_id = str(seed.get("conId") or getattr(contract, "conId", "") or seed.get("id", "unknown"))
    venue = seed.get("venue") or ("CME" if str(seed.get("tradingClass", "")).startswith("EC") else "IBKR")
    updated = now_iso()

    return {
        "id": f"{venue.lower()}:{raw_id}",
        "venue": venue,
        "source_api": "IBKR_TWS_API",
        "tradable_in_ibkr": True,
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
        "status": "open",
        "yes_bid": bid,
        "yes_ask": ask,
        "yes_mid": (bid + ask) / 2 if bid is not None and ask is not None else None,
        "no_bid": no_bid,
        "no_ask": no_ask,
        "no_mid": (no_bid + no_ask) / 2 if no_bid is not None and no_ask is not None else None,
        "last_price": last,
        "implied_probability_mid": (bid + ask) / 2 if bid is not None and ask is not None else None,
        "spread": ask - bid if bid is not None and ask is not None else None,
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
        "data_quality_flags": [],
        "fee_adjusted_edge": None,
        "updated_at": updated,
    }


@app.get("/status")
async def status() -> JSONResponse:
    health = await ensure_connected()
    stream = stream_manager.status_payload() if stream_manager else {}
    if not health["ok"]:
        return JSONResponse(
            {
                "status": health["status"],
                "connected": False,
                "host": IB_HOST,
                "port": IB_PORT,
                "client_id": IB_CLIENT_ID,
                "message": health.get("message"),
                "stream": stream,
            },
            status_code=200,
        )

    accounts = ib.managedAccounts()
    return JSONResponse(
        {
            "status": "connected",
            "connected": True,
            "host": IB_HOST,
            "port": IB_PORT,
            "client_id": IB_CLIENT_ID,
            "accounts": accounts,
            "server_version": ib.client.serverVersion(),
            "time": now_iso(),
            "stream": stream,
        }
    )


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


@app.get("/events")
async def events() -> Dict[str, Any]:
    return last_snapshot


@app.post("/refresh")
async def refresh() -> JSONResponse:
    global last_snapshot

    health = await ensure_connected()
    if not health["ok"]:
        last_snapshot = {
            "events": [],
            "providers": {"ibkr": provider(health["status"], health.get("message"))},
            "fetched_at": now_iso(),
        }
        return JSONResponse(last_snapshot)

    seeds = load_seed_contracts()
    if not seeds:
        discovered = await discover_event_contract_seeds()
        if discovered:
            save_seed_contracts(discovered)
            seeds = discovered

    if not seeds:
        fetched_at = now_iso()
        last_snapshot = {
            "events": [],
            "providers": {
                "ibkr": provider(
                    "connected",
                    "IB Gateway connected; no event contracts found (run POST /discover or add seeds to event_contracts.json)",
                    fetched_at,
                )
            },
            "fetched_at": fetched_at,
        }
        return JSONResponse(last_snapshot)

    events_out: List[Dict[str, Any]] = []
    errors: List[str] = []
    for seed in seeds:
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
        except Exception as exc:
            errors.append(f"{seed.get('description') or seed.get('conId')}: {exc}")

    fetched_at = now_iso()
    last_snapshot = {
        "events": events_out,
        "providers": {
            "ibkr": provider(
                "connected" if not errors else "error",
                "; ".join(errors[:3]) if errors else None,
                fetched_at if events_out or not errors else None,
            )
        },
        "fetched_at": fetched_at,
    }
    return JSONResponse(last_snapshot)


@app.post("/discover")
async def discover() -> JSONResponse:
    """Find event contracts via IB API and merge into event_contracts.json."""
    health = await ensure_connected()
    if not health["ok"]:
        return JSONResponse(
            {
                "ok": False,
                "status": health["status"],
                "message": health.get("message"),
                "contracts_added": 0,
            },
            status_code=200,
        )

    discovered = await discover_event_contract_seeds()
    existing = load_seed_contracts()
    existing_ids = {int(s["conId"]) for s in existing if s.get("conId")}
    merged = list(existing)
    added = 0
    for seed in discovered:
        cid = seed.get("conId")
        if cid and int(cid) not in existing_ids:
            merged.append(seed)
            existing_ids.add(int(cid))
            added += 1

    if merged:
        save_seed_contracts(merged)

    return JSONResponse(
        {
            "ok": True,
            "status": "connected",
            "discovered": len(discovered),
            "contracts_added": added,
            "contracts_total": len(merged),
            "seed_path": str(SEED_PATH),
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
    return JSONResponse({"ok": True, "accounts": ib.managedAccounts(), "fetched_at": now_iso()})


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


@app.get("/portfolio/positions")
async def portfolio_positions(account: Optional[str] = Query(None)) -> JSONResponse:
    health = await ensure_connected()
    if not health["ok"]:
        return JSONResponse(
            {"ok": False, "status": health["status"], "message": health.get("message"), "positions": []},
            status_code=200,
        )

    acct = resolve_account(account)
    if not acct:
        return JSONResponse({"ok": False, "message": "No managed accounts", "positions": []}, status_code=200)

    if stream_manager:
        cached = stream_manager.get_portfolio_cache(acct)
        if cached.get("ok"):
            return JSONResponse(cached)

    await ib.reqPositionsAsync()
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

    return JSONResponse({"ok": True, "account": acct, "positions": positions, "fetched_at": now_iso()})


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
        cached = stream_manager.get_account_summary_cache(acct)
        if cached.get("ok"):
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
    health = await ensure_connected()
    if not health["ok"]:
        return JSONResponse(
            {"ok": False, "status": health["status"], "message": health.get("message"), "pnl": None},
            status_code=200,
        )

    acct = resolve_account(account)
    if not acct:
        return JSONResponse({"ok": False, "message": "No managed accounts", "pnl": None}, status_code=200)

    try:
        ib.reqPnL(acct, "")
        await asyncio.sleep(0.3)
        pnl = ib.pnl(acct, "")
        if pnl:
            return JSONResponse(
                {
                    "ok": True,
                    "account": acct,
                    "pnl": {
                        "dailyPnL": float(pnl.dailyPnL) if pnl.dailyPnL == pnl.dailyPnL else None,
                        "unrealizedPnL": float(pnl.unrealizedPnL) if pnl.unrealizedPnL == pnl.unrealizedPnL else None,
                        "realizedPnL": float(pnl.realizedPnL) if pnl.realizedPnL == pnl.realizedPnL else None,
                    },
                    "fetched_at": now_iso(),
                }
            )
    except Exception as exc:
        return JSONResponse({"ok": False, "message": str(exc), "pnl": None}, status_code=200)

    return JSONResponse({"ok": True, "account": acct, "pnl": None, "fetched_at": now_iso()})
