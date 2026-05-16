import asyncio
import json
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from ib_insync import Contract, IB, util

APP_DIR = Path(__file__).resolve().parent
SEED_PATH = Path(os.environ.get("IBKR_EVENT_CONTRACTS_PATH", APP_DIR / "event_contracts.json"))

IB_HOST = os.environ.get("IB_GATEWAY_HOST", "127.0.0.1")
IB_PORT = int(os.environ.get("IB_GATEWAY_PORT", "4002"))
IB_CLIENT_ID = int(os.environ.get("IB_GATEWAY_CLIENT_ID", "17"))
CONNECT_TIMEOUT = float(os.environ.get("IB_GATEWAY_CONNECT_TIMEOUT_SEC", "2.5"))

ib = IB()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # ib_insync Connection uses asyncio.get_event_loop(); align it with uvicorn's loop.
    loop = asyncio.get_running_loop()
    asyncio.set_event_loop(loop)
    util.patchAsyncio()
    yield
    if ib.isConnected():
        try:
            ib.disconnect()
        except Exception:
            pass


app = FastAPI(title="IBKR Sidecar", version="1.0.0", lifespan=lifespan)
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
    if not health["ok"]:
        return JSONResponse(
            {
                "status": health["status"],
                "connected": False,
                "host": IB_HOST,
                "port": IB_PORT,
                "client_id": IB_CLIENT_ID,
                "message": health.get("message"),
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
        }
    )


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
        fetched_at = now_iso()
        last_snapshot = {
            "events": [],
            "providers": {
                "ibkr": provider(
                    "connected",
                    "IB Gateway connected; no seeded event contracts configured",
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
