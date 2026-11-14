"""Today's move and same-day Risk Range location for every held stock or ETF.

One table answers "which of my positions are up or down today, and where are
they in their Risk Range" without per-symbol history or research reads. Every
value is carried from its source: the live mark from the verified portfolio
read, the prior close from IBKR's official daily closes, and the range from
any research product's exact-security range dated this session (or a listed
price-tracking proxy's, labelled as such). Nothing is
inferred; a missing input leaves its cells empty.
"""

from __future__ import annotations

import asyncio
import math
from datetime import date, datetime, timedelta
from typing import Any, Awaitable, Callable, Optional
from zoneinfo import ZoneInfo

import httpx

from security_sectors import SECTOR_ETFS

SESSION_COLUMNS = [
    "symbol", "side", "price", "priorClose", "priorCloseDate",
    "dayChangePct", "rangeLow", "rangeHigh", "rangeDate", "rangePct", "rangeZone",
    "rangeSource", "rangeProxy", "rangeProxyLevel", "rangeProxyKind",
    "sector", "sectorEtf", "sectorCorr90", "sectorBetterFit",
]
INTELLIGENCE_PATH = "/api/research/security-intelligence/v2"
QUOTES_PATH = "/api/quotes"
ETF_PRO_PATH = "/api/hedgeye/etfpro"
SECTOR_FIT_PATH = "/api/analyst/sector-fit"
# A stock borrows its sector ETF's range only when its returns have followed that ETF this closely over 90 sessions.
SECTOR_PROXY_MIN_CORRELATION = 0.5
MAX_SYMBOLS = 200
REQUEST_TIMEOUT_SECONDS = 6.0
VALUED_STATES = frozenset({"live"})
MARKET_ZONE = ZoneInfo("America/New_York")
# The daily sheet's own range leads; any other product's exact-security range follows.
RANGE_PRODUCT_ORDER = ("risk-ranges", "early-look")
# A holding that tracks, one for one in direction, an instrument the research
# prints at its own level. The range and the location are the instrument's.
RANGE_PROXIES = {"IWM": "RUT", "QQQ": "COMPQ", "SLV": "SILVER", "CPER": "COPPER", "EWJ": "NIKK"}
PROXY_QUOTE_MAX_AGE_SECONDS = 24 * 3600


def _number(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


def range_location(price: float, low: float, high: float) -> tuple[float, str]:
    """Match the dashboard's Risk Range watch: thirds on the rounded percent."""
    pct = (price - low) / (high - low) * 100
    rounded = round(pct)
    zone = ("below" if price < low else "above" if price > high
            else "bottom" if rounded <= 33 else "top" if rounded >= 66 else "middle")
    return round(pct, 1), zone


def _prior_closes(reference_payloads: list[Any], market_date: str) -> dict[int, tuple[float, str]]:
    closes: dict[int, tuple[float, str]] = {}
    for payload in reference_payloads:
        if not isinstance(payload, dict) or payload.get("ok") is not True:
            continue
        for mark in payload.get("marks") or []:
            if not isinstance(mark, dict) or mark.get("conId") is None:
                continue
            # After the close the reference becomes today's own close; the
            # prior session is then the mark's previous close.
            pairs = (("referenceClose", "referenceCloseSessionDate"),
                     ("previousClose", "previousCloseSessionDate"))
            for price_key, date_key in pairs:
                close, session = _number(mark.get(price_key)), str(mark.get(date_key) or "")
                if close and close > 0 and len(session) == 10 and session < market_date:
                    closes[int(mark["conId"])] = (close, session)
                    break
    return closes


def _current_ranges(payload: Any) -> dict[str, dict[str, Any]]:
    """Each symbol's exact-security range dated the payload's market date, from any product."""
    if not isinstance(payload, dict):
        return {}
    market_date = str(payload.get("marketDate") or "")
    ranges: dict[str, dict[str, Any]] = {}
    for symbol, record in (payload.get("bySymbol") or {}).items():
        products = record.get("products") if isinstance(record, dict) else None
        if not isinstance(products, dict):
            continue
        ordered = [key for key in RANGE_PRODUCT_ORDER if key in products] + sorted(
            key for key in products if key not in RANGE_PRODUCT_ORDER)
        for product_id in ordered:
            product = products[product_id] if isinstance(products[product_id], dict) else {}
            field = (product.get("fields") or {}).get("riskRange")
            value = field.get("value") if isinstance(field, dict) else None
            if not isinstance(value, dict):
                continue
            low, high = _number(value.get("lrr")), _number(value.get("hrr"))
            # A Risk Range is good for its own session only, and only an exact
            # match is on this security's own price scale.
            if (low and high and high > low > 0 and market_date
                    and str(field.get("marketDate") or "")[:10] == market_date
                    and field.get("matchType") == "direct"):
                ranges[str(symbol).upper()] = {
                    "low": low, "high": high, "date": market_date,
                    "source": product.get("label") or product_id,
                }
                break
    return ranges


def _first_session_on_or_after(day: date) -> date:
    while day.weekday() >= 5:
        day += timedelta(days=1)
    return day


def _etf_pro_ranges(payload: Any, market_date: str) -> dict[str, dict[str, Any]]:
    """ETF Pro's printed range per ETF, good for one session: the first one after its edition.

    The full book arrives Sunday evening, so its ranges stand for Monday only.
    From the next session on they are gone, like any other day-old range.
    """
    if (not isinstance(payload, dict) or payload.get("available") is not True
            or payload.get("current") is not True or not isinstance(payload.get("rows"), list)):
        return {}
    meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
    # The edition that printed the ranges, not a later action email applied on top of it.
    edition = str(meta.get("baseSnapshotDate") or meta.get("declaredCapturedAt") or meta.get("snapshotDate") or "")[:10]
    try:
        if _first_session_on_or_after(date.fromisoformat(edition)).isoformat() != market_date:
            return {}
    except ValueError:
        return {}
    ranges: dict[str, dict[str, Any]] = {}
    for row in payload["rows"]:
        if not isinstance(row, dict) or not row.get("ticker"):
            continue
        low, high = _number(row.get("trendLowEnd")), _number(row.get("trendHighEnd"))
        if low and high and high > low > 0:
            ranges[str(row["ticker"]).upper()] = {
                "low": low, "high": high, "date": market_date, "source": "ETF Pro"}
    return ranges


def _proxy_levels(payload: Any, now: datetime) -> dict[str, float]:
    levels: dict[str, float] = {}
    for symbol, quote in (payload.items() if isinstance(payload, dict) else []):
        if not isinstance(quote, dict):
            continue
        try:
            price = float(quote.get("price"))
            observed = datetime.fromisoformat(str(quote.get("observedAt")).replace("Z", "+00:00"))
            age = (now - observed).total_seconds()
        except (TypeError, ValueError):
            continue
        if math.isfinite(price) and price > 0 and -60 <= age <= PROXY_QUOTE_MAX_AGE_SECONDS:
            levels[str(symbol).upper()] = price
    return levels


def build_session_table(
    projected: dict[str, Any], reference_payloads: list[Any], range_payload: Any,
    *, market_date: str, proxy_levels: Optional[dict[str, float]] = None, etf_pro_payload: Any = None,
    sectors: Optional[dict[str, dict[str, Any]]] = None, sector_fit: Any = None,
) -> dict[str, Any]:
    table = (projected.get("data") or {}).get("positionTable") or {}
    columns = table.get("columns") or []
    index = {name: position for position, name in enumerate(columns)}
    closes = _prior_closes(reference_payloads, market_date)
    ranges = _current_ranges(range_payload)
    etf_pro = _etf_pro_ranges(etf_pro_payload, market_date)
    fits = {str(item.get("symbol")).upper(): item for item in (sector_fit or {}).get("rows") or []
            if isinstance(item, dict)} if isinstance(sector_fit, dict) else {}
    rows: list[list[Any]] = []
    for row in table.get("rows") or []:
        def cell(name: str) -> Any:
            return row[index[name]] if name in index and index[name] < len(row) else None

        quantity = _number(cell("quantity"))
        symbol = str(cell("symbol") or "").upper()
        if cell("secType") != "STK" or not symbol or not quantity:
            continue
        price = _number(cell("valuationPrice")) if cell("markState") in VALUED_STATES else None
        close, close_date = closes.get(int(cell("conId")), (None, None)) if cell("conId") is not None else (None, None)
        change = round((price / close - 1) * 100, 2) if price and close else None
        sector = (sectors or {}).get(symbol) or {}
        fit = fits.get(symbol) if sector.get("etf") and (fits.get(symbol) or {}).get("etf") == sector.get("etf") else None
        correlation = _number(((fit or {}).get("correlations") or {}).get("90", {}).get("value"))
        better = (fit or {}).get("best", {}).get("etf") if fit and fit.get("review") else None
        found, proxy, level, kind = ranges.get(symbol), None, None, None
        if found:
            pct, zone = range_location(price, found["low"], found["high"]) if price else (None, None)
        else:
            proxy, kind = RANGE_PROXIES.get(symbol), "tracks"
            found = ranges.get(proxy) if proxy else None
            if not found and etf_pro.get(symbol):
                # ETF Pro's own range on its one session, on the holding's own price.
                proxy, kind, found = None, None, etf_pro[symbol]
                # A range far from the price is on another scale; it places nothing.
                on_scale = bool(price and 0.5 <= price / ((found["low"] + found["high"]) / 2) <= 2)
                pct, zone = range_location(price, found["low"], found["high"]) if on_scale else (None, None)
            else:
                if (not found and sector.get("etf") and correlation is not None
                        and correlation >= SECTOR_PROXY_MIN_CORRELATION):
                    # Last resort for a single stock that has followed its sector: the sector ETF's range, from any product.
                    proxy, kind = sector["etf"], "sector"
                    found = ranges.get(proxy) or etf_pro.get(proxy)
                level = (proxy_levels or {}).get(proxy) if found else None
                pct, zone = range_location(level, found["low"], found["high"]) if level else (None, None)
                if not found:
                    proxy, kind = None, None
        rows.append([
            symbol, "short" if quantity < 0 else "long", price, close, close_date, change,
            found["low"] if found else None, found["high"] if found else None,
            found["date"] if found else None, pct, zone,
            found["source"] if found else None, proxy, level, kind,
            sector.get("sector"), sector.get("etf"), round(correlation, 2) if correlation is not None else None, better,
        ])
    proxied = sum(1 for row in rows if row[SESSION_COLUMNS.index("rangeProxy")])
    return {
        "columns": list(SESSION_COLUMNS), "rows": rows, "rowCount": len(rows),
        "marketDate": market_date,
        "priorCloseSource": "IBKR official daily close",
        # The read reached every product's ranges; an unrelated product running late does not count against it.
        "rangeCoverageComplete": bool(isinstance(range_payload, dict) and isinstance(range_payload.get("bySymbol"), dict)),
        "rangeCount": sum(1 for row in rows if row[SESSION_COLUMNS.index("rangeLow")] is not None),
        "proxyRangeCount": proxied,
        "sectorProxyRangeCount": sum(1 for row in rows if row[SESSION_COLUMNS.index("rangeProxyKind")] == "sector"),
        "sectorCount": sum(1 for row in rows if row[SESSION_COLUMNS.index("sector")]),
        "sectorSource": "Hedgeye GIP equity sectors; each stock's sector from its company profile",
        "etfProRangeCount": sum(1 for row in rows if row[SESSION_COLUMNS.index("rangeSource")] == "ETF Pro"),
        "notes": [
            "dayChangePct is the live price versus the prior session's close; for a short, a positive value is a move against the position.",
            "rangePct is the location in the range (0 low, 100 high); rangeZone is bottom, middle, top, below or above.",
            "Ranges are read from every research product and count only when dated this session. rangeSource names the product.",
"ETF Pro's printed range counts for one session only, the first after its edition, and only where no other range exists; after that session it is dropped.",
"A row with rangeProxy uses that instrument's range: rangeLow, rangeHigh and rangeProxyLevel are on the proxy's scale and rangePct is the proxy's location, not the holding's own price. rangeProxyKind tracks means the holding follows that instrument closely; sector means it is only the stock's sector ETF, a loose guide to the stock itself. Always name the proxy and its kind.",
            "sector and sectorEtf are the stock's Hedgeye equity sector and that sector's ETF; they are empty for funds.",
            f"sectorCorr90 is the 90-session correlation of the stock's daily returns with its sector ETF. A sector range is borrowed only at {SECTOR_PROXY_MIN_CORRELATION} or higher. sectorBetterFit names another sector ETF the stock has followed clearly better; it is a flag for review, not a reassignment.",
            "Empty range cells mean no product printed a range for that holding or a listed proxy this session"
            + ("." if isinstance(range_payload, dict) else "; the range read itself failed, so coverage is unknown."),
        ],
    }


class PositionSessionReader:
    def __init__(
        self, base_url: str, session_closes: Callable[[list[str]], Awaitable[list[Any]]],
        *, sectors: Optional[Callable[[list[str]], Awaitable[dict[str, dict[str, Any]]]]] = None,
        client_factory: Callable[..., Any] = httpx.AsyncClient,
        now: Callable[[], datetime] = lambda: datetime.now(MARKET_ZONE),
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.session_closes = session_closes
        self.sectors = sectors
        self.client_factory = client_factory
        self.now = now

    async def _get(self, path: str, params: dict[str, str]) -> Any:
        async with self.client_factory(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.get(f"{self.base_url}{path}", params=params)
            response.raise_for_status()
            return response.json()

    async def _ranges(self, symbols: list[str]) -> Any:
        if not symbols:
            return {"marketDate": None, "coverage": {"state": "complete"}, "bySymbol": {}}
        return await self._get(INTELLIGENCE_PATH, {
            "scope": "symbols", "symbols": ",".join(symbols[:MAX_SYMBOLS]), "historyDays": "0"})

    async def _sector_fit(self, sectors: dict[str, dict[str, Any]]) -> Any:
        pairs = sorted(f"{symbol}:{record['etf']}" for symbol, record in sectors.items() if record.get("etf"))
        return await self._get(SECTOR_FIT_PATH, {"pairs": ",".join(pairs[:100])}) if pairs else {"rows": []}

    async def _etf_pro(self) -> Any:
        return await self._get(ETF_PRO_PATH, {})

    async def _proxy_quotes(self, proxies: list[str]) -> Any:
        return await self._get(QUOTES_PATH, {"symbols": ",".join(proxies)}) if proxies else {}

    async def attach(self, projected: dict[str, Any]) -> dict[str, Any]:
        """Add data.sessionTable to a verified projected portfolio; never fail the portfolio read."""
        data = projected.get("data")
        table = data.get("positionTable") if isinstance(data, dict) else None
        if projected.get("liveVerified") is not True or not isinstance(table, dict):
            return projected
        columns = table.get("columns") or []
        if "symbol" not in columns or "secType" not in columns:
            return projected
        symbol_at, type_at = columns.index("symbol"), columns.index("secType")
        symbols = sorted({str(row[symbol_at]).upper() for row in table.get("rows") or []
                          if row[type_at] == "STK" and row[symbol_at]})
        accounts = [str(account) for account in data.get("accounts") or [] if account]

        async def bounded(work: Awaitable[Any]) -> Any:
            try:
                return await asyncio.wait_for(work, timeout=REQUEST_TIMEOUT_SECONDS)
            except Exception:
                return None

        tracked = {RANGE_PROXIES[symbol] for symbol in symbols if symbol in RANGE_PROXIES}
        # Sector ETFs are always read so a stock's sector range needs no second round trip.
        proxies = sorted(tracked | (set(SECTOR_ETFS) if self.sectors else set()))

        async def no_sectors() -> dict[str, dict[str, Any]]:
            return {}

        reference, ranges, quotes, etf_pro, sectors = await asyncio.gather(
            bounded(self.session_closes(accounts)),
            bounded(self._ranges(sorted(set(symbols) | set(proxies)))),
            bounded(self._proxy_quotes(proxies)), bounded(self._etf_pro()),
            bounded(self.sectors(symbols) if self.sectors else no_sectors()))
        sectors = sectors if isinstance(sectors, dict) else {}
        # The fit needs the sectors first; they are on disk after the first read, so this adds one short call.
        fit = await bounded(self._sector_fit(sectors)) if sectors else None
        now = self.now()
        session = build_session_table(
            projected, reference if isinstance(reference, list) else [], ranges,
            market_date=now.date().isoformat(), proxy_levels=_proxy_levels(quotes, now),
            etf_pro_payload=etf_pro, sectors=sectors, sector_fit=fit,
        )
        return {**projected, "data": {**data, "sessionTable": session}}
