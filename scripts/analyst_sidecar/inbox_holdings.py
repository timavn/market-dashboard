"""Current inbox portfolio weights, with independent valuation provenance."""
from datetime import datetime, timezone

from portfolio_review import _number


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


def current_holding_weights(source, now=None):
    """Absolute holding value divided by complete, same-currency account NLV.

    This uses only values already verified by the broker reader. A missing
    position mark, currency, account summary, or observation withholds weight.
    """
    now = now or datetime.now(timezone.utc)
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
            "verified": True, "timestamps": list(timestamps),
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
        row["verified"] = row["verified"] and verified
        if verified:
            row["marketValue"] += value
            row["timestamps"].append(timestamp)
    return [{
        "holding": row["holding"], "heldSide": row["heldSide"], "quantity": row["quantity"],
        "currentHolding": {
            "weightPct": abs(row["marketValue"]) / nlv * 100,
            "source": "ibkr", "basis": "absolute_market_value_over_net_liquidation",
            "asOf": min(row["timestamps"]).isoformat().replace("+00:00", "Z"), "currency": currency,
        } if row["verified"] else None,
    } for row in grouped.values()]
