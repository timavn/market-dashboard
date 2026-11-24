"""Daily Review: the post-close wrap-up sheet, computed in code from captured evidence.

One sheet answers what the book made today, where it came from, what was
traded, what risk is carried now and how the prediction-market book stands.
Every figure is arithmetic on values this review captured itself: the verified
IBKR book and account, IBKR's official prior closes, today's IBKR fills, the
previous session's close capture, dated market quotes and the Kalshi account.
A missing input leaves its cells empty and is named under ``notes``; nothing
is estimated to fill a gap.

P&L per position, for quantity ``q1`` now, ``q0`` at the prior close, mark
``P``, official prior close ``C``, and today's signed fills ``s`` at ``f``:

    position = q0 * (P - C)        yesterday's book carried through today
    trading  = sum(s * (P - f))    today's fills against the current mark
    total    = position + trading  = q1*P - q0*C - sum(s*f)

A position sold out today has no mark; its total is ``sum(s * (C - f))`` and
is reported as position P&L (yesterday's book up to its exit).
"""

from __future__ import annotations

import json
import math
import subprocess
from datetime import datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional
from zoneinfo import ZoneInfo

EASTERN = ZoneInfo("America/New_York")
ROOT = Path(__file__).resolve().parents[2]
# A session's wrap-up runs until the next pre-market opens at 4:00am ET, so an
# evening run on the West Coast (already past midnight in New York) stays on its day.
SESSION_ROLL = timedelta(hours=4)
VALUED_STATES = frozenset({"live", "settled", "resolver"})
BLOCK = "analyst-daily-review"
VERSION = 1
# Beta is measured against SPY, so SPY is the day's market return.
BENCHMARK = "SPY"
# The alpha/beta split is shown only when measured betas cover this share of gross exposure.
MIN_BETA_COVERAGE_PCT = 90.0
TOP_MOVERS = 5
MARKET_ROWS = (
    ("us", "SPX", "S&P 500", "index"), ("us", "NDX", "Nasdaq 100", "index"), ("us", "RUT", "Russell 2000", "index"),
    ("us", "DJI", "Dow", "index"), ("rates.us_treasuries", "UST2Y", "UST 2Y", "yield"),
    ("rates.us_treasuries", "UST10Y", "UST 10Y", "yield"), ("currencies", "USD", "US Dollar", "index"),
    ("commodities", "CL", "WTI crude", "price"), ("commodities", "GC", "Gold", "price"), ("crypto", "BTC", "Bitcoin", "price"),
)
SECTOR_SYMBOLS = ("XLK", "XLC", "XLY", "XLF", "XLV", "XLI", "XLE", "XLB", "XLP", "XLU", "XLRE")
ASSET_LABELS = {"STK": "Stocks & ETFs", "OPT": "Listed options", "FOP": "Listed options", "FUT": "Futures",
                "BOND": "Bonds", "CASH": "Foreign exchange", "FUND": "Funds", "CRYPTO": "Crypto"}


def _n(value: Any) -> Optional[float]:
    if isinstance(value, bool) or value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _time(value: Any) -> Optional[datetime]:
    try:
        moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return moment if moment.tzinfo else None


def session_day(value: Any) -> Optional[str]:
    """The exchange day an instant belongs to: its Eastern date, rolling at 4:00am."""
    moment = _time(value)
    return (moment.astimezone(EASTERN) - SESSION_ROLL).date().isoformat() if moment else None


@lru_cache(maxsize=64)
def _session_from_calendar(day: str) -> dict[str, Any]:
    script = (
        "const c=require('./src/utils/usEquityMarketCalendar.cjs');"
        "const d=process.argv[1];const t=c.isTradingDateKey(d);const m=t?d:c.previousTradingDateKey(d);"
        "process.stdout.write(JSON.stringify({marketDate:m,tradingDay:t,closeMinute:c.usEquityCloseMinutes(m)}));"
    )
    result = subprocess.run(["node", "-e", script, day], cwd=ROOT, text=True, capture_output=True, timeout=2, check=True)
    session = json.loads(result.stdout)
    datetime.strptime(session["marketDate"], "%Y-%m-%d")
    if session["closeMinute"] not in {780, 960} or not isinstance(session["tradingDay"], bool):
        raise ValueError("Unexpected exchange session")
    return session


def review_session(as_of: Any) -> dict[str, Any]:
    """The session a review taken now wraps up, from the dashboard's own exchange calendar.

    ``marketDate`` is the latest trading day at or before the capture's session
    day. ``phase`` is pre-market, open or post-market on that day, and closed
    on a weekend or holiday, when the sheet describes the last session.
    """
    day = session_day(as_of)
    if not day:
        raise ValueError("Review time unavailable")
    session = _session_from_calendar(day)
    moment = _time(as_of).astimezone(EASTERN)
    if not session["tradingDay"]:
        phase = "closed"
    elif moment.date().isoformat() != day:
        phase = "post-market"
    else:
        minutes = moment.hour * 60 + moment.minute
        phase = "pre-market" if minutes < 570 else "open" if minutes < session["closeMinute"] else "post-market"
    return {"marketDate": session["marketDate"], "phase": phase}


def comparison_cutoff(as_of: Any, market_date: str) -> str:
    """The instant the previous-close comparison is taken at: now, or the end of the session's own Eastern day.

    The stored close captures are looked up by Eastern calendar date. A run
    after midnight in New York still wraps up ``market_date``, so its baseline
    is the close before that day, never that day's own close.
    """
    moment = _time(as_of)
    if moment and moment.astimezone(EASTERN).date().isoformat() == market_date:
        return str(as_of)
    end = datetime.strptime(market_date, "%Y-%m-%d").replace(hour=23, minute=59, second=59, tzinfo=EASTERN)
    return end.isoformat()


def _daily_bars(history: Any) -> list[tuple[str, float]]:
    data = history.get("data") if isinstance(history, dict) and history.get("status") == "available" else None
    bars = []
    for row in (data or {}).get("results") or []:
        day, close = str((row or {}).get("date") or "")[:10], _n((row or {}).get("close"))
        if len(day) == 10 and close and close > 0:
            bars.append((day, close))
    return sorted(set(bars))


def session_move(history: Any, market_date: str) -> Optional[dict[str, Any]]:
    """A security's move over the session, from dated daily bars: that day's bar against the bar before it.

    After the close a live quote's "previous close" is already today's close,
    so its change is only the after-hours move. Dated bars cannot be misread.
    """
    bars = _daily_bars(history)
    today = [close for day, close in bars if day == market_date]
    earlier = [(day, close) for day, close in bars if day < market_date]
    if not today or not earlier:
        return None
    previous_day, previous = earlier[-1]
    return {"price": today[-1], "previousClose": previous, "change": today[-1] - previous,
            "changePct": (today[-1] / previous - 1) * 100, "sessionDate": market_date,
            "previousSessionDate": previous_day, "observedAt": history.get("asOf"),
            "source": history.get("provider") or history.get("sourceSystem")}


def exit_closes(histories: Any, market_date: str) -> dict[str, float]:
    """Prior-session closes for securities sold out today, from dated daily bars."""
    closes = {}
    for symbol, history in (histories.items() if isinstance(histories, dict) else []):
        earlier = [close for day, close in _daily_bars(history) if day < market_date]
        if earlier:
            closes[str(symbol).upper()] = earlier[-1]
    return closes


REDUCING_ACTIONS = frozenset({"Exit", "Cover", "Trim", "Cover part", "Flip to long", "Flip to short", "Round trip"})


def account_pnl(metrics: dict[str, Any], *, reduced_today: bool = False) -> Optional[dict[str, float]]:
    """IBKR's own account P&L for the single captured account.

    A subscription that has not yet received values reports zero for all three
    fields. With positions held that is a blank reading, not a flat day.
    IBKR also resets its daily figures in the evening, before this session's
    wrap-up ends: zero realized P&L on a day whose fills closed or reduced
    positions (``reduced_today``) means the figures no longer cover the session.
    """
    accounts = metrics.get("accountIds") or []
    rows = [row for row in metrics.get("pnl") or [] if isinstance(row, dict) and row.get("account") in accounts]
    if len(accounts) != 1 or len(rows) != 1:
        return None
    pnl = rows[0].get("pnl") if isinstance(rows[0].get("pnl"), dict) else {}
    daily, realized, unrealized = (_n(pnl.get(key)) for key in ("dailyPnL", "realizedPnL", "unrealizedPnL"))
    if daily is None:
        return None
    if not daily and not realized and not unrealized and metrics.get("positionCount"):
        return None
    if reduced_today and not realized:
        return None
    return {"daily": daily, "realized": realized, "unrealized": unrealized, "observedAt": rows[0].get("observedAt")}


def normalize_executions(payload: Any, market_date: str) -> Optional[list[dict[str, Any]]]:
    """Today's verified fills as signed quantities, or None when the read cannot be trusted."""
    if (not isinstance(payload, dict) or payload.get("ok") is not True or payload.get("liveVerified") is not True
            or payload.get("complete") is not True or payload.get("from_cache") is not False
            or payload.get("source") != "ibkr_executions" or not isinstance(payload.get("executions"), list)):
        return None
    rows = []
    for row in payload["executions"]:
        if not isinstance(row, dict):
            return None
        quantity, price = _n(row.get("shares")), _n(row.get("price"))
        side = str(row.get("side") or "").upper()
        if not row.get("execId") or row.get("conId") is None or not quantity or quantity <= 0 or price is None or side not in {"BOT", "SLD"}:
            return None
        # IBKR returns the current day's executions; an older row is never counted as today's.
        day = session_day(row.get("executionTime"))
        if day is not None and day != market_date:
            continue
        rows.append({"execId": str(row["execId"]), "conId": int(row["conId"]), "symbol": str(row.get("symbol") or "").upper(),
                     "localSymbol": row.get("localSymbol"), "secType": str(row.get("secType") or "").upper(),
                     "signed": quantity if side == "BOT" else -quantity, "price": price, "time": row.get("executionTime"),
                     "commission": _n(row.get("commission")), "realized": _n(row.get("realizedPNL"))})
    return rows


def _trade_action(prior: float, current: float, net: float) -> str:
    if abs(net) < 1e-9:
        return "Round trip"
    if abs(prior) < 1e-9:
        return "New long" if current > 0 else "New short"
    if abs(current) < 1e-9:
        return "Exit" if prior > 0 else "Cover"
    if (prior > 0) != (current > 0):
        return "Flip to long" if current > 0 else "Flip to short"
    if abs(current) > abs(prior):
        return "Add" if current > 0 else "Add short"
    return "Trim" if current > 0 else "Cover part"


def _positions_by_contract(metrics: dict[str, Any]) -> dict[int, dict[str, Any]]:
    held: dict[int, dict[str, Any]] = {}
    for row in metrics.get("positions") or []:
        quantity = _n(row.get("quantity"))
        if row.get("conId") is None or not quantity:
            continue
        valued = row.get("markState") in VALUED_STATES
        value, price = (_n(row.get("marketValue")), _n(row.get("valuationPrice"))) if valued else (None, None)
        # Dollars per unit of quantity and price: 1 for shares, the contract multiplier otherwise.
        unit = value / (quantity * price) if value is not None and price else None
        held[int(row["conId"])] = {
            "conId": int(row["conId"]), "symbol": str(row.get("symbol") or "").upper(), "contract": row.get("contract"),
            "name": row.get("securityName"), "secType": str(row.get("secType") or "").upper(),
            "category": row.get("category"), "quantity": quantity, "value": value, "price": price,
            "unit": unit if unit and abs(unit - round(unit)) < 1e-6 and unit > 0 else None,
        }
    return held


def build_attribution(metrics, closes, executions, exit_closes=None):
    """Position and trading P&L per security, and today's activity per security.

    ``closes`` maps conId to (official prior close, its session date);
    ``executions`` is normalize_executions' result (None when unverified);
    ``exit_closes`` maps a sold-out symbol to its prior close.
    """
    held = _positions_by_contract(metrics)
    nlv = _n(metrics.get("netLiquidation"))
    fills: dict[int, list[dict[str, Any]]] = {}
    for fill in executions or []:
        fills.setdefault(fill["conId"], []).append(fill)
    rows, unpriced, trades = [], [], []
    for con_id in sorted(set(held) | set(fills)):
        position, own = held.get(con_id), fills.get(con_id, [])
        symbol = (position or {}).get("symbol") or own[0]["symbol"]
        sec_type = (position or {}).get("secType") or own[0]["secType"]
        current = position["quantity"] if position else 0.0
        net = sum(fill["signed"] for fill in own)
        prior = current - net
        if abs(prior) < 1e-6:
            prior = 0.0
        unit = position["unit"] if position else 1.0 if sec_type == "STK" else None
        price = position["price"] if position else None
        close = (closes.get(con_id) or (None, None))[0] if position else _n((exit_closes or {}).get(symbol))
        result = None
        if executions is None and position and close and unit and price is not None:
            # Without verified fills the book is marked as held all day; a traded name would be misstated,
            # so this basis is labelled and never reconciled to the account figure.
            result = {"position": current * (price - close) * unit, "trading": None}
        elif executions is not None and position and unit and price is not None and (close or not prior):
            carried = prior * (price - close) * unit if prior else 0.0
            result = {"position": carried, "trading": sum(fill["signed"] * (price - fill["price"]) for fill in own) * unit}
        elif executions is not None and not position and unit and close and own:
            result = {"position": sum(fill["signed"] * (close - fill["price"]) for fill in own) * unit, "trading": 0.0}
        if result is None:
            unpriced.append(symbol)
        else:
            total = result["position"] + (result["trading"] or 0.0)
            rows.append({
                "symbol": symbol, "contract": (position or {}).get("contract") or symbol, "name": (position or {}).get("name"),
                "secType": sec_type, "side": "long" if (current or prior) > 0 else "short",
                "pnl": total, "positionPnl": result["position"], "tradingPnl": result["trading"],
                "bps": total / nlv * 10000 if nlv else None,
                "changePct": (price / close - 1) * 100 if price and close else None,
                "weightPct": position["value"] / nlv * 100 if position and position["value"] is not None and nlv else None,
                "value": position["value"] if position else None, "held": bool(position),
            })
        if own:
            buys = [fill for fill in own if fill["signed"] > 0]
            sells = [fill for fill in own if fill["signed"] < 0]
            notional = sum(fill["signed"] * fill["price"] for fill in own) * unit if unit else None
            realized = [fill["realized"] for fill in own]
            commissions = [fill["commission"] for fill in own]
            trades.append({
                "symbol": symbol, "contract": (position or {}).get("contract") or own[0].get("localSymbol") or symbol,
                "secType": sec_type, "action": _trade_action(prior, current, net), "fills": len(own),
                "netNotional": notional, "netPctNlv": notional / nlv * 100 if notional is not None and nlv else None,
                "grossNotional": sum(abs(fill["signed"]) * fill["price"] for fill in own) * unit if unit else None,
                "avgBuy": sum(f["signed"] * f["price"] for f in buys) / sum(f["signed"] for f in buys) if buys else None,
                "avgSell": sum(f["signed"] * f["price"] for f in sells) / sum(f["signed"] for f in sells) if sells else None,
                "mark": price, "tradingPnl": result["trading"] if result and position else None,
                # IBKR's realized P&L against average cost, only when every fill reported one.
                "realized": sum(realized) if all(value is not None for value in realized) else None,
                "commission": sum(commissions) if all(value is not None for value in commissions) else None,
                "firstAt": min((fill["time"] for fill in own if fill["time"]), default=None),
                "lastAt": max((fill["time"] for fill in own if fill["time"]), default=None),
                "weightPct": position["value"] / nlv * 100 if position and position["value"] is not None and nlv else None,
            })
    gross = sum(abs(position["value"]) for position in held.values() if position["value"] is not None)
    covered = sum(abs(row["value"]) for row in rows if row["value"] is not None)
    return {"rows": rows, "unpriced": sorted(set(unpriced)), "trades": trades,
            "coveragePct": covered / gross * 100 if gross else None,
            "basis": "fills" if executions is not None else "held-all-day"}


def _quote_row(quote: Any, market_date: str, as_of: Any, *, need_previous: bool = True) -> Optional[dict[str, Any]]:
    """A quote observed during or after this session, with the day's change as its source states it.

    A quote last observed in an earlier session still carries that session's
    change, so it says nothing about today and is left out.
    """
    if not isinstance(quote, dict):
        return None
    price, previous = _n(quote.get("price")), _n(quote.get("previousClose"))
    observed, captured = _time(quote.get("observedAt")), _time(as_of)
    if price is None or not observed or not captured or observed > captured + timedelta(minutes=2):
        return None
    if not market_date <= session_day(observed) <= session_day(captured):
        return None
    change = price - previous if previous else _n(quote.get("change"))
    if change is None or (need_previous and not previous):
        return None
    return {"price": price, "previousClose": previous, "change": change,
            "changePct": (price / previous - 1) * 100 if previous else None,
            "observedAt": quote.get("observedAt"), "source": quote.get("source") or (quote.get("observation") or {}).get("source")}


def build_market(quotes: Any, volatility: Any, histories: Any, market_date: str, as_of: Any) -> dict[str, Any]:
    """Market rows from session quotes; SPY and the sector ETFs from dated daily bars (``histories``)."""
    quotes = quotes if isinstance(quotes, dict) else {}

    def group(path: str) -> list[Any]:
        value: Any = quotes
        for key in path.split("."):
            value = value.get(key) if isinstance(value, dict) else None
        return value if isinstance(value, list) else []

    rows = []
    for path, symbol, label, kind in MARKET_ROWS:
        quote = next((row for row in group(path) if isinstance(row, dict) and row.get("symbol") == symbol), None)
        row = _quote_row(quote, market_date, as_of, need_previous=kind != "yield")
        if row:
            rows.append({"symbol": symbol, "label": label, "kind": kind, **row})
    histories = histories if isinstance(histories, dict) else {}
    sectors = []
    for symbol in SECTOR_SYMBOLS:
        move = session_move(histories.get(symbol), market_date)
        if move:
            sectors.append({"symbol": symbol, "changePct": move["changePct"]})
    sectors.sort(key=lambda row: row["changePct"], reverse=True)
    vix = (volatility or {}).get("VIX") if isinstance(volatility, dict) else None
    vol = None
    # The volatility sheet is end-of-day: it counts only once it carries this session's own close.
    if isinstance(vix, dict) and _n(vix.get("lastPx")) is not None and vix.get("marketSessionDate") == market_date:
        vol = {"symbol": "VIX", "level": _n(vix["lastPx"]), "changePct": _n(vix.get("dayChangePct")),
               "asOf": vix.get("marketSessionDate"), "source": vix.get("sourceLabel") or vix.get("source")}
    benchmark = session_move(histories.get(BENCHMARK), market_date)
    return {"rows": rows, "sectors": sectors, "vix": vol,
            "benchmark": {"symbol": BENCHMARK, **benchmark} if benchmark else None}


def build_alpha_beta(attribution, metrics, sizing, benchmark) -> dict[str, Any]:
    """Split the attributed P&L into what the market explains and what is left.

    Beta-weighted exposure is each holding's value times its measured beta to
    SPY. The market's share is that exposure times SPY's move; the remainder is
    selection. Shown only when betas cover nearly all of gross exposure.
    """
    result = {"status": "unavailable"}
    betas = (sizing or {}).get("bySymbol") if isinstance(sizing, dict) else None
    change = (benchmark or {}).get("changePct")
    nlv = _n(metrics.get("netLiquidation"))
    if not isinstance(betas, dict) or change is None or not nlv:
        return result
    gross = covered = weighted = explained_pnl = 0.0
    for row in attribution["rows"]:
        if not row["held"] or row["value"] is None:
            continue
        gross += abs(row["value"])
        beta = _n(((betas.get(row["symbol"]) or {}).get("beta") or {}).get("value")) if row["secType"] == "STK" else None
        if beta is None:
            continue
        covered += abs(row["value"])
        weighted += row["value"] * beta
        explained_pnl += row["pnl"]
    coverage = covered / gross * 100 if gross else None
    result.update(coveragePct=coverage, minCoveragePct=MIN_BETA_COVERAGE_PCT, benchmark=BENCHMARK, benchmarkChangePct=change)
    if coverage is None or coverage < MIN_BETA_COVERAGE_PCT:
        return result
    market = weighted * change / 100
    result.update(status="available", betaExposure=weighted, betaExposurePct=weighted / nlv * 100,
                  marketPnl=market, selectionPnl=explained_pnl - market, coveredPnl=explained_pnl)
    return result


def build_exposure(metrics, comparison, factor_exposure) -> dict[str, Any]:
    nlv = _n(metrics.get("netLiquidation"))
    compared = (comparison or {}).get("metrics") if (comparison or {}).get("status") == "available" else {}
    previous_nlv = _n(((compared or {}).get("netLiquidation") or {}).get("previous"))
    rows = []
    for key, label in (("grossExposure", "Gross"), ("longMarketValue", "Long"), ("shortMarketValue", "Short"), ("netExposure", "Net")):
        value = _n(metrics.get(key))
        pct = value / nlv * 100 if value is not None and nlv else None
        # Each percentage uses the NLV captured with its own endpoint; a missing prior is left empty.
        before = _n(((compared or {}).get(key) or {}).get("previous"))
        previous_pct = before / previous_nlv * 100 if before is not None and previous_nlv else None
        rows.append({"key": key, "label": label, "value": value, "pct": pct, "previousPct": previous_pct,
                     "deltaBps": (pct - previous_pct) * 100 if pct is not None and previous_pct is not None else None})
    positions = [row for row in metrics.get("positions") or [] if _n(row.get("quantity"))]
    valued = [row for row in positions if row.get("markState") in VALUED_STATES and _n(row.get("marketValue")) is not None]
    top = sorted(valued, key=lambda row: abs(_n(row["marketValue"])), reverse=True)[:10]
    return {
        "rows": rows, "nlv": nlv, "previousNlv": previous_nlv,
        "comparison": {"status": (comparison or {}).get("status") or "unavailable",
                       "baselineAsOf": (comparison or {}).get("baselineAsOf"),
                       "baselineSessionDate": (comparison or {}).get("baselineSessionDate"),
                       "rebuilt": (comparison or {}).get("baselineRebuilt") is True},
        "positionCount": len(positions),
        "longCount": sum(1 for row in positions if _n(row["quantity"]) > 0),
        "shortCount": sum(1 for row in positions if _n(row["quantity"]) < 0),
        "assetClasses": (factor_exposure or {}).get("rows") or [],
        "concentrations": [{"symbol": row.get("contract") or row.get("symbol"), "side": "long" if _n(row["quantity"]) > 0 else "short",
                            "value": _n(row["marketValue"]), "pct": _n(row["marketValue"]) / nlv * 100 if nlv else None} for row in top],
    }


def build_liquidity(portfolio, balance, open_orders) -> dict[str, Any]:
    current = ((balance or {}).get("data") or {}).get("current") or {}
    margin = current.get("margin") if isinstance(current.get("margin"), dict) and current["margin"].get("status") == "live" else {}
    cash = None
    for row in ((portfolio or {}).get("data") or {}).get("accountSummaries") or []:
        summary = row.get("summary") if isinstance(row, dict) and isinstance(row.get("summary"), dict) else {}
        cash = _n(summary.get("TotalCashValue")) if cash is None else cash
    orders = (open_orders or {}).get("orders") if isinstance(open_orders, dict) and open_orders.get("liveVerified") is True else None
    return {"cash": cash, "buyingPower": _n(margin.get("buyingPower")), "availableFunds": _n(margin.get("availableFunds")),
            "excessLiquidity": _n(margin.get("excessLiquidity")), "excessLiquidityPct": _n(margin.get("excessLiquidityPercent")),
            "maintenanceMargin": _n(margin.get("maintenanceMarginRequirement")),
            "initialMargin": _n(margin.get("initialMarginRequirement")), "health": margin.get("health"),
            "openOrders": len(orders) if isinstance(orders, list) else None}


def build_prediction(board, activity, metrics) -> dict[str, Any]:
    """The Kalshi account from the setup board's book, today's Kalshi activity, and IBKR event contracts."""
    book = (board or {}).get("kalshiBook") if isinstance(board, dict) else None
    result: dict[str, Any] = {"status": "unavailable"}
    if isinstance(book, dict):
        result = {
            "status": "ready", "asOf": book.get("asOf"),
            **{key: _n(book.get(key)) for key in ("account", "cash", "atRisk", "atRiskPct", "maxPayout", "value", "pnl", "realized")},
            "openLines": book.get("openLines"), "events": book.get("events"), "unvalued": book.get("unvalued"),
            "flags": [{"tone": flag.get("tone"), "text": flag.get("text")} for flag in book.get("flags") or [] if isinstance(flag, dict)],
            "positions": [{"market": row.get("market"), "section": row.get("sectionLabel"), "side": row.get("side"),
                           "direction": row.get("direction"), "lines": len(row.get("lines") or []),
                           "cost": _n(row.get("cost")), "pct": _n(row.get("pct")), "value": _n(row.get("value")),
                           "pnl": _n(row.get("pnl")), "maxPayout": _n(row.get("maxPayout")), "closeTime": row.get("closeTime"),
                           "state": row.get("state"), "tone": row.get("tone")}
                          for row in book.get("positions") or [] if isinstance(row, dict)],
        }
    elif isinstance(board, dict) and (board.get("sourceStatus") or {}).get("kalshiPositions") == "ready":
        result = {"status": "ready", "openLines": 0, "positions": [], "flags": []}
    if isinstance(activity, dict) and activity.get("ok") is True:
        result["today"] = {key: activity.get(key) for key in ("since", "asOf", "fills", "settlements")}
    events = [row for row in metrics.get("positions") or [] if row.get("category") == "event_contract" and _n(row.get("quantity"))]
    if events:
        valued = [_n(row.get("marketValue")) for row in events if row.get("markState") in VALUED_STATES]
        result["ibkrEventContracts"] = {"count": len(events), "valued": len(valued),
                                        "value": sum(value for value in valued if value is not None) if len(valued) == len(events) else None}
    return result


def build_daily_review(*, as_of, market_date, metrics, phase="post-market", portfolio=None, balance=None, closes=None, executions=None,
                       exit_closes=None, comparison=None, factor_exposure=None, quotes=None, volatility=None,
                       histories=None, sizing=None, open_orders=None, board=None, kalshi_activity=None) -> dict[str, Any]:
    """Assemble the sheet. ``metrics`` is portfolio_metrics() of the verified book."""
    notes: list[str] = []
    nlv = _n(metrics.get("netLiquidation"))
    attribution = build_attribution(metrics, closes or {}, executions, exit_closes)
    market = build_market(quotes, volatility, histories, market_date, as_of)
    exposure = build_exposure(metrics, comparison, factor_exposure)
    reduced = any(trade["action"] in REDUCING_ACTIONS for trade in attribution["trades"])
    ibkr = account_pnl(metrics, reduced_today=reduced)
    ibkr_reset = ibkr is None and account_pnl(metrics) is not None
    rows = attribution["rows"]
    attributed = sum(row["pnl"] for row in rows) if rows else None
    complete = bool(rows) and not attribution["unpriced"] and attribution["basis"] == "fills"
    previous_nlv = exposure["previousNlv"]
    nlv_change = nlv - previous_nlv if nlv is not None and previous_nlv is not None else None
    if ibkr:
        day, basis = ibkr["daily"], "ibkr-account"
    elif complete:
        day, basis = attributed, "positions"
    elif rows and attribution["basis"] == "fills":
        # The unpriced positions are named in a note; the rest of the book is still the day's best figure.
        day, basis = attributed, "positions-partial"
    else:
        day, basis = None, None
    # A return is measured on the prior close's separately captured NLV; without one it is a share of today's NLV.
    denominator, pct_basis = (previous_nlv, "prior-close-nlv") if previous_nlv else (nlv, "nlv")
    benchmark = market["benchmark"]
    day_pct = day / denominator * 100 if day is not None and denominator else None
    if executions is None:
        notes.append("Today's IBKR fills could not be verified: positions are marked as held all day and trading activity is not shown.")
    if attribution["unpriced"]:
        shown = ", ".join(attribution["unpriced"][:12]) + ("…" if len(attribution["unpriced"]) > 12 else "")
        notes.append(f"No official prior close or mark, so no P&L is attributed to: {shown}.")
    if ibkr_reset:
        notes.append("IBKR's account daily P&L showed no realized P&L after today's closing trades, so it no longer covers this session and is not used.")
    elif not ibkr and metrics.get("positionCount"):
        notes.append("IBKR's account daily P&L was blank on this read.")
    if exposure["comparison"]["status"] != "available":
        notes.append("No verified capture of the previous close: exposure changes and the NLV change are not shown.")
    if not benchmark:
        notes.append("No daily bar for SPY on this session: the comparison with the market is not shown.")
    side = lambda name: sum(row["pnl"] for row in rows if row["side"] == name) if rows else None
    by_class: dict[str, float] = {}
    for row in rows:
        label = ASSET_LABELS.get(row["secType"], "Other")
        by_class[label] = by_class.get(label, 0.0) + row["pnl"]
    ranked = sorted(rows, key=lambda row: row["pnl"], reverse=True)
    mover = lambda row: {key: row[key] for key in ("symbol", "contract", "name", "side", "pnl", "bps", "changePct", "weightPct", "held")}
    trades = sorted(attribution["trades"], key=lambda row: abs(row["netNotional"] or 0), reverse=True)
    gross_traded = [row["grossNotional"] for row in trades]
    commissions = [row["commission"] for row in trades]
    return {
        "version": VERSION, "asOf": as_of, "marketDate": market_date, "session": phase,
        "headline": {
            "nlv": nlv, "dayPnl": day, "dayPnlPct": day_pct, "basis": basis, "pctBasis": pct_basis if day_pct is not None else None,
            "benchmark": {"symbol": BENCHMARK, "changePct": benchmark["changePct"], "observedAt": benchmark["observedAt"],
                          "sessionDate": benchmark["sessionDate"], "previousSessionDate": benchmark["previousSessionDate"]} if benchmark else None,
            "vsBenchmarkPct": day_pct - benchmark["changePct"] if day_pct is not None and benchmark and benchmark["changePct"] is not None else None,
            "nlvChange": nlv_change, "previousNlv": previous_nlv, "previousNlvAsOf": exposure["comparison"]["baselineAsOf"],
        },
        "pnl": {
            "account": ibkr, "attributed": attributed, "attributionBasis": attribution["basis"],
            "positionPnl": sum(row["positionPnl"] for row in rows) if rows else None,
            "tradingPnl": sum(row["tradingPnl"] or 0.0 for row in rows) if rows and attribution["basis"] == "fills" else None,
            "longPnl": side("long"), "shortPnl": side("short"), "coveragePct": attribution["coveragePct"],
            "attributedCount": len(rows), "unpriced": attribution["unpriced"],
            # What IBKR's account figure holds beyond the attributed positions: options, fees, interest, FX and mark timing.
            "unattributed": ibkr["daily"] - attributed if ibkr and attributed is not None and attribution["basis"] == "fills" else None,
            "byAssetClass": [{"label": label, "pnl": value, "bps": value / nlv * 10000 if nlv else None}
                             for label, value in sorted(by_class.items(), key=lambda item: abs(item[1]), reverse=True)],
            "contributors": [mover(row) for row in ranked[:TOP_MOVERS] if row["pnl"] > 0],
            "detractors": [mover(row) for row in reversed(ranked[-TOP_MOVERS:]) if row["pnl"] < 0],
            "alphaBeta": build_alpha_beta(attribution, metrics, sizing, benchmark),
        },
        "trading": {
            "status": "unavailable" if executions is None else "ready" if trades else "none",
            "fillCount": len(executions or []), "symbolCount": len(trades),
            "grossNotional": sum(gross_traded) if trades and all(value is not None for value in gross_traded) else None,
            "netNotional": sum(row["netNotional"] for row in trades) if trades and all(row["netNotional"] is not None for row in trades) else None,
            "commission": sum(commissions) if trades and all(value is not None for value in commissions) else None,
            "rows": trades,
        },
        "exposure": exposure,
        "liquidity": build_liquidity(portfolio, balance, open_orders),
        "market": market,
        "prediction": build_prediction(board, kalshi_activity, metrics),
        "notes": notes,
    }


def _money(value: Any) -> str:
    number = _n(value)
    return "Unavailable" if number is None else f"{'-' if number < 0 else ''}${abs(number):,.0f}"


def _pct(value: Any, digits: int = 2) -> str:
    number = _n(value)
    return "Unavailable" if number is None else f"{number:+.{digits}f}%"


def render_daily_review(sections: list[dict[str, Any]], _outcome: str = "ready") -> str:
    """A short readable summary, then the sheet itself as one fenced block the Analyst window draws."""
    sheet = next((section.get("sheet") for section in sections
                  if isinstance(section, dict) and section.get("id") == "daily-review" and isinstance(section.get("sheet"), dict)), None)
    if not sheet:
        return "Daily Review unavailable.\n"
    head, pnl, trading, prediction = sheet["headline"], sheet["pnl"], sheet["trading"], sheet["prediction"]
    lines = [f"## Daily Review · {sheet['marketDate']}", ""]
    lines.append(f"- Day P&L: {_money(head['dayPnl'])} ({_pct(head['dayPnlPct'])}); NLV {_money(head['nlv'])}.")
    if head.get("benchmark"):
        lines.append(f"- {head['benchmark']['symbol']} {_pct(head['benchmark']['changePct'])}; versus the market {_pct(head.get('vsBenchmarkPct'))}.")
    if pnl.get("attributed") is not None:
        lines.append(f"- Position P&L {_money(pnl['positionPnl'])}, trading P&L {_money(pnl['tradingPnl'])}; longs {_money(pnl['longPnl'])}, shorts {_money(pnl['shortPnl'])}.")
    for row in sheet["exposure"]["rows"]:
        if row["pct"] is not None:
            lines.append(f"- {row['label']} exposure {_money(row['value'])}, {row['pct']:.0f}% of NLV.")
    lines.append(f"- Trading: {trading['symbolCount']} securities, {trading['fillCount']} fills." if trading["status"] != "unavailable"
                 else "- Trading: today's fills unavailable.")
    if prediction.get("status") == "ready":
        lines.append(f"- Kalshi: {prediction.get('openLines') or 0} open lines, {_money(prediction.get('atRisk'))} at risk, open P&L {_money(prediction.get('pnl'))}.")
    lines += [f"- {note}" for note in sheet.get("notes") or []]
    lines += ["", f"```{BLOCK}", json.dumps(sheet, ensure_ascii=False, separators=(",", ":"), allow_nan=False), "```", ""]
    return "\n".join(lines)
