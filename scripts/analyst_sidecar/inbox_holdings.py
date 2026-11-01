"""Current inbox portfolio weights, with independent valuation provenance."""
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
import subprocess

from portfolio_review import _number

ROOT = Path(__file__).resolve().parents[2]


def verified_current_portfolio_input(value):
    return value.get("connected") is not False and not any(value.get(flag) is True for flag in (
        "stale", "isStale", "from_cache", "fromCache", "cacheOnly", "mock", "isMock", "seed", "seeded",
    )) and all(str(value.get(field) or "").lower() not in {
        "offline", "disconnected", "error", "failed", "unavailable", "stale", "cache-only", "mock", "seed", "seeded",
    } for field in ("status", "freshness", "source", "provider"))


def _observed(value, now):
    try:
        observed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return observed if observed.tzinfo and -30 <= (now - observed).total_seconds() <= 60 else None
    except (ValueError, TypeError):
        return None


@lru_cache(maxsize=8)
def _frozen_session(minute):
    """The session whose close the book is frozen at, or None while it can trade.

    Holdings and prices hold from a session's close to the next 4:00am ET
    pre-market open (analystPolicy.portfolioCaptureSession).
    """
    script = (
        "const p=require('./src/services/analyst/analystPolicy.cjs');"
        "const n=new Date(process.argv[1]);const s=p.portfolioCaptureSession(n);"
        "process.stdout.write(p.marketSession(n)==='closed'||s.date!==p.easternDate(n)?s.date:'');"
    )
    try:
        result = subprocess.run(["node", "-e", script, minute], cwd=ROOT, text=True,
                                capture_output=True, timeout=2, check=True)
        return result.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def session_close_marks(response, accounts, now):
    """IBKR official daily closes by (account, conId), for the frozen session only."""
    session = _frozen_session(now.strftime("%Y-%m-%dT%H:%MZ"))
    if (not session or not isinstance(response, dict) or response.get("ok") is not True
            or response.get("connected") is not True or response.get("source") != "ibkr_portfolio_reference_marks"
            or response.get("account") not in accounts or _observed(response.get("observed_at"), now) is None):
        return {}
    marks = {}
    for mark in response.get("marks") or []:
        close = _number(mark.get("referenceClose"))
        if (mark.get("account") == response["account"] and mark.get("conId") is not None and close and close > 0
                and mark.get("referenceCloseSource") == "ibkr_historical_daily_close"
                and mark.get("referenceCloseSessionDate") == session):
            marks[(mark["account"], str(mark["conId"]))] = {
                "close": close, "quantity": _number(mark.get("position")), "session": session,
                "observedAt": response["observed_at"]}
    return marks


def current_holding_weights(source, now=None, closes=None):
    """Absolute holding value divided by complete, same-currency account NLV.

    This uses only values already verified by the broker reader. A missing
    position mark, currency, account summary, or observation withholds weight,
    except that while the book is frozen after a close a position without a
    live mark is valued at IBKR's official close for that session (``closes``,
    from ``session_close_marks``).
    """
    now = now or datetime.now(timezone.utc)
    closes = closes or {}
    if (source.get("liveVerified") is not True or source.get("freshness") != "live"
            or source.get("provider") != "ibkr" or not verified_current_portfolio_input(source)):
        return []
    observed = _observed(source.get("asOf"), now)
    if observed is None:
        return []
    data = source.get("data") or {}
    accounts = set(data.get("accounts") or [])
    summaries = data.get("accountSummaries") or []
    if not accounts or len(summaries) != len(accounts) or {row.get("account") for row in summaries} != accounts:
        return []
    timestamps = [observed]
    currencies = set()
    nlv = 0
    for row in summaries:
        summary = row.get("summary") or {}
        value = summary.get("NetLiquidation")
        if not verified_current_portfolio_input(row) or not verified_current_portfolio_input(summary) or isinstance(value, dict) and not verified_current_portfolio_input(value):
            return []
        amount = _number(value.get("value") if isinstance(value, dict) else value)
        timestamp = _observed(row.get("observedAt"), now)
        currency = str((value.get("currency") if isinstance(value, dict) else summary.get("currency")) or "").upper()
        if amount is None or timestamp is None or not currency or currency == "BASE":
            return []
        nlv += amount
        currencies.add(currency)
        timestamps.append(timestamp)
    if nlv <= 0 or len(currencies) != 1:
        return []
    currency = next(iter(currencies))
    grouped = {}
    for position in data.get("positions") or []:
        if position.get("instrumentCategory") == "event_contract":
            continue
        symbol = str(position.get("symbol") or "").upper()
        quantity = _number(position.get("quantity"))
        if not symbol or quantity in {None, 0}:
            continue
        side = "LONG" if quantity > 0 else "SHORT"
        row = grouped.setdefault((symbol, side), {
            "holding": symbol, "heldSide": side, "quantity": 0, "marketValue": 0,
            "verified": True, "timestamps": list(timestamps), "closeSession": None,
        })
        row["quantity"] += quantity
        value = _number(position.get("marketValue"))
        timestamp = _observed(position.get("quoteObservedAt"), now)
        verified = (position.get("instrumentCategory") == "other"
                    and position.get("account") in accounts and verified_current_portfolio_input(position)
                    and position.get("currentValuesLiveVerified") is True
                    and position.get("portfolioWeightVerified") is True
                    and position.get("valuationBasis") == "live_ibkr"
                    and position.get("valuationSource") == "ibkr_broker_snapshot"
                    and position.get("currency") == currency and timestamp is not None
                    and value is not None and value * quantity > 0)
        mark = closes.get((position.get("account"), str(position.get("conId"))))
        if (not verified and mark and position.get("instrumentCategory") == "other"
                and position.get("account") in accounts and verified_current_portfolio_input(position)
                and position.get("currency") == currency and mark["quantity"] == quantity):
            verified, value, timestamp = True, quantity * mark["close"], _observed(mark["observedAt"], now)
            row["closeSession"] = mark["session"]
        row["verified"] = row["verified"] and verified and timestamp is not None
        if row["verified"]:
            row["marketValue"] += value
            row["timestamps"].append(timestamp)
    return [{
        "holding": row["holding"], "heldSide": row["heldSide"], "quantity": row["quantity"],
        "currentHolding": {
            "weightPct": abs(row["marketValue"]) / nlv * 100,
            "source": "ibkr", "basis": "absolute_market_value_over_net_liquidation",
            "asOf": min(row["timestamps"]).isoformat().replace("+00:00", "Z"), "currency": currency,
            **({"closeSession": row["closeSession"]} if row["closeSession"] else {}),
        } if row["verified"] else None,
    } for row in grouped.values()]
