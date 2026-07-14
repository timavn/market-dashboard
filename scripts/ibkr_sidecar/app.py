import asyncio
import json
import os
import re
import time
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
STATUS_TIMEOUT = float(os.environ.get("IBKR_STATUS_TIMEOUT_SEC", str(CONNECT_TIMEOUT + 2.0)))
MAX_QUOTE_BATCH = int(os.environ.get("IBKR_MAX_QUOTE_BATCH", "50"))
QUOTE_WAIT_SEC = float(os.environ.get("IBKR_QUOTE_WAIT_SEC", "1.0"))
PNL_WAIT_SEC = float(os.environ.get("IBKR_PNL_WAIT_SEC", "2.0"))
DISCOVER_DETAILS_TIMEOUT_SEC = float(os.environ.get("IBKR_DISCOVER_DETAILS_TIMEOUT_SEC", "2.5"))
PORTFOLIO_SYNC_TIMEOUT_SEC = float(os.environ.get("IBKR_PORTFOLIO_SYNC_TIMEOUT_SEC", "2.5"))
POSITIONS_REQUEST_TIMEOUT_SEC = float(os.environ.get("IBKR_POSITIONS_REQUEST_TIMEOUT_SEC", "4.0"))

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


class CpiDiscoveryContext(BaseModel):
    metric: Optional[str] = None
    forecastMonth: Optional[str] = None
    reportMonth: Optional[str] = None
    releaseCode: Optional[str] = None
    targetStrikes: List[float] = Field(default_factory=list)


class DiscoveryRequest(BaseModel):
    cpi: Optional[CpiDiscoveryContext] = None


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


def portfolio_position_to_seed(position: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    local_symbol = position.get("localSymbol") or position.get("description") or position.get("symbol") or ""
    con_id = position.get("conId") or position.get("conid")
    if not con_id or not is_cpi_seed(position):
        return None
    symbol = position.get("symbol") or str(local_symbol).split("-")[0] or "KXCPIYOY"
    return {
        "description": local_symbol or symbol,
        "conId": int(con_id),
        "venue": "IBKR",
        "category": "Inflation",
        "underlying": symbol,
        "event_title": symbol,
        "contract_title": local_symbol or symbol,
        "question": local_symbol or symbol,
        "secType": position.get("secType") or "OPT",
        "exchange": position.get("exchange") or "",
        "currency": position.get("currency") or "USD",
        "localSymbol": local_symbol,
        "tradingClass": position.get("tradingClass") or "",
        "lastTradeDateOrContractMonth": position.get("lastTradeDateOrContractMonth") or "",
        "strike": position.get("strike"),
        "right": position.get("right") or "",
        "multiplier": position.get("multiplier") or "",
        "max_payout_per_contract": 1,
        "min_tick": 0.01,
        "quote_wait_sec": 1.0,
        "data_quality_flags": ["portfolio_seed"],
    }


def merge_seed_lists(existing: List[Dict[str, Any]], incoming: List[Dict[str, Any]]) -> tuple[List[Dict[str, Any]], int]:
    merged = list(existing)
    existing_ids = {int(seed["conId"]) for seed in merged if seed.get("conId")}
    added = 0
    for seed in incoming:
        cid = seed.get("conId")
        if cid and int(cid) not in existing_ids:
            merged.append(seed)
            existing_ids.add(int(cid))
            added += 1
    return merged, added


def is_portfolio_seed(seed: Dict[str, Any]) -> bool:
    return "portfolio_seed" in (seed.get("data_quality_flags") or [])


def quote_eligible_seeds(seeds: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [seed for seed in seeds if seed.get("conId")]


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
    found_ticks = {
        tick
        for seed in seeds
        for tick in [seed_cpi_tick(seed)]
        if tick in ticks
    }
    return {
        "metric": request.cpi.metric if request and request.cpi else None,
        "forecastMonth": request.cpi.forecastMonth if request and request.cpi else None,
        "reportMonth": request.cpi.reportMonth if request and request.cpi else None,
        "releaseCode": request.cpi.releaseCode if request and request.cpi else None,
        "targetStrikes": [tick / 10 for tick in sorted(ticks)],
        "foundStrikes": [tick / 10 for tick in sorted(found_ticks)],
        "missingStrikes": [tick / 10 for tick in sorted(ticks - found_ticks)],
        "contractsTotal": len(seeds),
        "contracts_total": len(seeds),
        **({"discovered": discovered_count} if discovered_count is not None else {}),
        **({"contractsAdded": contracts_added, "contracts_added": contracts_added} if contracts_added is not None else {}),
    }


def cpi_release_tokens(request: Optional[DiscoveryRequest]) -> set:
    if not request or not request.cpi:
        return set()
    raw_values = [
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


def cpi_metric_symbols(request: Optional[DiscoveryRequest]) -> List[str]:
    if not request or not request.cpi:
        return []
    metric = str(request.cpi.metric or "").upper()
    symbols: List[str] = []
    if "YOY" in metric or "Y/Y" in metric:
        symbols.append("KXCPIYOY")
    if "M/M" in metric or "MOM" in metric:
        symbols.extend(["KXCPIMOM", "KXCPIM", "CPIM"])
    if not symbols:
        symbols.extend(["KXCPIYOY", "KXCPIMOM", "KXCPIM", "KXCPI"])
    unique_symbols: List[str] = []
    for symbol in symbols:
        if symbol not in unique_symbols:
            unique_symbols.append(symbol)
    return unique_symbols


def cpi_contract_month_codes(request: Optional[DiscoveryRequest]) -> List[str]:
    if not request or not request.cpi:
        return []
    raw_values = [
        request.cpi.releaseCode,
        request.cpi.reportMonth,
        request.cpi.forecastMonth,
    ]
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
    codes: List[str] = []
    for value in raw_values:
        text = str(value or "").upper()
        match = re.search(
            r"\b(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b\D*(\d{2,4})",
            text,
        )
        if not match:
            continue
        month = month_map.get(match.group(1), match.group(1)[:3])
        year = match.group(2)[-2:]
        code = f"{year}{month}"
        if code not in codes:
            codes.append(code)
    return codes


def cpi_strike_symbol_value(tick: int) -> str:
    return f"{tick / 10:.1f}"


def forecastx_contract(symbol: str, local_symbol: Optional[str] = None) -> Contract:
    contract = Contract(symbol=symbol, secType="OPT", exchange="FORECASTX", currency="USD")
    if local_symbol:
        contract.localSymbol = local_symbol
    return contract


def cpi_symbol_templates(request: Optional[DiscoveryRequest]) -> List[Contract]:
    if not request or not request.cpi or not cpi_target_ticks(request):
        return []
    templates: List[Contract] = []
    symbols = cpi_metric_symbols(request)
    month_codes = cpi_contract_month_codes(request)
    target_ticks = sorted(cpi_target_ticks(request))
    for symbol in symbols:
        for month_code in month_codes:
            for tick in target_ticks:
                strike = cpi_strike_symbol_value(tick)
                for side in ("YES", "NO"):
                    templates.append(forecastx_contract(symbol, f"{symbol}-{month_code}-T{strike}_{side}"))
        templates.append(forecastx_contract(symbol))
    return templates


def portfolio_cpi_seed_candidates(request: Optional[DiscoveryRequest] = None) -> List[Dict[str, Any]]:
    if not stream_manager:
        return []
    accounts = []
    preferred = os.environ.get("IBKR_ACCOUNT_ID")
    if preferred:
        accounts.append(preferred)
    accounts.append("U25779973")
    try:
        accounts.extend(ib.managedAccounts())
    except Exception:
        pass
    target_ticks = cpi_target_ticks(request)
    seeds: List[Dict[str, Any]] = []
    seen: set = set()
    for account in dict.fromkeys(account for account in accounts if account):
        cached = stream_manager.get_portfolio_cache(account)
        for position in cached.get("positions", []):
            seed = portfolio_position_to_seed(position)
            if not seed:
                continue
            tick = seed_cpi_tick(seed)
            if target_ticks and tick not in target_ticks:
                continue
            key = seed.get("conId") or seed.get("localSymbol")
            if key in seen:
                continue
            seen.add(key)
            seeds.append(seed)
    return seeds


async def discover_event_contract_seeds(
    max_per_venue: int = int(os.environ.get("IBKR_DISCOVER_MAX_PER_VENUE", "25")),
    request: Optional[DiscoveryRequest] = None,
) -> List[Dict[str, Any]]:
    """Search IB for ForecastEx and CME event (EC*) contracts when Gateway is connected."""
    seeds: List[Dict[str, Any]] = []
    seen: set = set()
    target_ticks = cpi_target_ticks(request)
    release_tokens = cpi_release_tokens(request)

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
            seed = contract_to_seed(contract, venue)
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
                if target_match:
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
    text = seed_text(
        {
            **seed,
            "localSymbol": seed.get("localSymbol") or getattr(contract, "localSymbol", ""),
            "symbol": seed.get("symbol") or getattr(contract, "symbol", ""),
        }
    )
    match = re.search(r"(?:^|[-_\s])(YES|NO)(?:$|[-_\s])", text, flags=re.IGNORECASE)
    return match.group(1).upper() if match else "YES"


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
        yes_bid = 1 - ask if ask is not None else None
        yes_ask = 1 - bid if bid is not None else None
        no_bid = bid
        no_ask = ask
        yes_last = 1 - last if last is not None else None
    else:
        yes_bid = bid
        yes_ask = ask
        no_bid = 1 - ask if ask is not None else None
        no_ask = 1 - bid if bid is not None else None
        yes_last = last
    flags = [
        flag
        for flag in (seed.get("data_quality_flags", []) or [])
        if flag != "portfolio_seed"
    ]
    if is_portfolio_seed(seed):
        flags.append("portfolio_discovered")
    if bid is None and ask is None:
        flags.append("no_live_quote")

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
        "yes_bid": yes_bid,
        "yes_ask": yes_ask,
        "yes_mid": (yes_bid + yes_ask) / 2 if yes_bid is not None and yes_ask is not None else None,
        "no_bid": no_bid,
        "no_ask": no_ask,
        "no_mid": (no_bid + no_ask) / 2 if no_bid is not None and no_ask is not None else None,
        "last_price": yes_last,
        "implied_probability_mid": (yes_bid + yes_ask) / 2 if yes_bid is not None and yes_ask is not None else None,
        "spread": ask - bid if bid is not None and ask is not None else None,
        "quote_side": quote_side,
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
                "stream": stream,
            },
            status_code=200,
        )

    try:
        accounts = ib.managedAccounts()
    except Exception:
        accounts = []
    return JSONResponse(
        {
            "status": "connected",
            "connected": True,
            "host": IB_HOST,
            "port": IB_PORT,
            "client_id": stream_manager.client_id if stream_manager else IB_CLIENT_ID,
            "accounts": accounts,
            "server_version": ib.client.serverVersion(),
            "time": now_iso(),
            "stream": stream,
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

    target_ticks = cpi_target_ticks(request)
    phase_start = time.monotonic()
    seeds = load_seed_contracts()
    discovered_count = 0
    added = 0
    portfolio_seeds = portfolio_cpi_seed_candidates(request)
    if portfolio_seeds:
        seeds, portfolio_added = merge_seed_lists(seeds, portfolio_seeds)
        added += portfolio_added
        if portfolio_added:
            save_seed_contracts(seeds)
    portfolio_seed_count = sum(1 for seed in seeds if is_portfolio_seed(seed))
    catalog_seeds = quote_eligible_seeds(seeds)
    timings["seed_load_ms"] = elapsed_ms(phase_start)

    missing_target_ticks = target_ticks - {
        tick
        for seed in catalog_seeds
        for tick in [seed_cpi_tick(seed)]
        if tick in target_ticks
    }
    if not catalog_seeds or missing_target_ticks:
        phase_start = time.monotonic()
        discovered = await discover_event_contract_seeds(request=request)
        timings["discovery_ms"] = elapsed_ms(phase_start)
        discovered_count = len(discovered)
        if discovered:
            merged, discovered_added = merge_seed_lists(seeds, discovered)
            added += discovered_added
            save_seed_contracts(merged)
            seeds = merged
            portfolio_seed_count = sum(1 for seed in seeds if is_portfolio_seed(seed))
            catalog_seeds = quote_eligible_seeds(seeds)

    if not catalog_seeds:
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
            "contracts_added": added,
            "contracts_total": 0,
            "portfolio_seed_count": portfolio_seed_count,
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
            "ibkr": provider(
                "connected" if not errors else "error",
                "; ".join(errors[:3]) if errors else None,
                fetched_at if events_out or not errors else None,
            )
        },
        "fetched_at": fetched_at,
        "contracts_added": added,
        "contracts_total": len(catalog_seeds),
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
    """Find event contracts via IB API and merge into event_contracts.json."""
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

    discovery_start = time.monotonic()
    discovered = await discover_event_contract_seeds(request=request)
    discovery_ms = elapsed_ms(discovery_start)
    existing = load_seed_contracts()
    portfolio_seeds = portfolio_cpi_seed_candidates(request)
    merged, portfolio_added = merge_seed_lists(existing, portfolio_seeds)
    merged, discovered_added = merge_seed_lists(merged, discovered)
    added = portfolio_added + discovered_added
    catalog_seeds = quote_eligible_seeds(merged)
    portfolio_seed_count = sum(1 for seed in merged if is_portfolio_seed(seed))

    if merged:
        save_seed_contracts(merged)

    return JSONResponse(
        {
            "ok": True,
            "status": "connected",
            "discovered": len(discovered),
            "contracts_added": added,
            "contracts_total": len(catalog_seeds),
            "portfolio_seed_count": portfolio_seed_count,
            "seed_path": str(SEED_PATH),
            "cpi_discovery": cpi_discovery_report(catalog_seeds, request, len(discovered), added),
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


async def fetch_positions_snapshot(acct: str) -> Dict[str, Any]:
    try:
        await asyncio.wait_for(ib.reqPositionsAsync(), timeout=POSITIONS_REQUEST_TIMEOUT_SEC)
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
    health = await ensure_connected()
    if not health["ok"]:
        return JSONResponse(
            {"ok": False, "status": health["status"], "message": health.get("message"), "pnl": None},
            status_code=200,
        )

    acct = resolve_account(account)
    if not acct:
        return JSONResponse({"ok": False, "message": "No managed accounts", "pnl": None}, status_code=200)

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

    try:
        existing = ib.pnl(acct, "")
        pnl = existing[0] if existing else ib.reqPnL(acct, "")
        pnl = None
        deadline = asyncio.get_running_loop().time() + max(0.3, PNL_WAIT_SEC)
        while asyncio.get_running_loop().time() < deadline:
            subscribed = ib.pnl(acct, "")
            candidate = subscribed[0] if subscribed else None
            if candidate and any(
                safe_float(getattr(candidate, field, None)) is not None
                for field in ("dailyPnL", "unrealizedPnL", "realizedPnL")
            ):
                pnl = candidate
                break
            await asyncio.sleep(0.2)

        if pnl:
            daily_pnl = safe_float(pnl.dailyPnL)
            daily_pct = None
            if daily_pnl is not None:
                cached_summary = (
                    stream_manager.get_account_summary_cache(acct).get("summary", {})
                    if stream_manager
                    else {}
                )
                net_liquidation = safe_float(cached_summary.get("NetLiquidation"))
                prior_close = net_liquidation - daily_pnl if net_liquidation is not None else None
                if prior_close and prior_close > 0:
                    daily_pct = (daily_pnl / prior_close) * 100
            return JSONResponse(
                {
                    "ok": True,
                    "account": acct,
                    "pnl": {
                        "dailyPnL": daily_pnl,
                        "dailyPnLPercent": daily_pct,
                        "unrealizedPnL": safe_float(pnl.unrealizedPnL),
                        "realizedPnL": safe_float(pnl.realizedPnL),
                    },
                    "fetched_at": now_iso(),
                }
            )
    except Exception as exc:
        return JSONResponse({"ok": False, "message": str(exc), "pnl": None}, status_code=200)

    return JSONResponse({"ok": True, "account": acct, "pnl": None, "fetched_at": now_iso()})
