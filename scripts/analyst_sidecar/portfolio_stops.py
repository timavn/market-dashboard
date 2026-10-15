"""Dated stop-order coverage; never places or changes broker orders."""
from datetime import datetime
from portfolio_review import _number

STOP_TYPES = {"STP", "STP LMT", "STP PRT", "TRAIL", "TRAIL LIMIT"}
WORKING = {"Submitted", "PreSubmitted"}
FINISHED = {"Filled", "Cancelled", "ApiCancelled"}


def stop_checks(metrics, snapshot):
    unavailable = {"status": "unavailable", "asOf": None, "byHolding": {}, "reason": "Stop orders were not captured with these holdings."}
    snapshot = snapshot or {}
    if not metrics.get("available") or not (snapshot.get("ok") is True and snapshot.get("complete") is True
            and snapshot.get("liveVerified") is True and snapshot.get("source") == "ibkr_all_open_orders"
            and snapshot.get("from_cache") is False) or any(snapshot.get(flag) is True for flag in ("stale", "cacheOnly", "fromCache", "mock", "seeded", "inferred")):
        return unavailable
    try:
        observed = datetime.fromisoformat(str(snapshot.get("asOf") or "").replace("Z", "+00:00"))
        held_at = datetime.fromisoformat(str(metrics.get("observedAt") or "").replace("Z", "+00:00"))
        if not observed.tzinfo or not held_at.tzinfo or abs((observed - held_at).total_seconds()) > 60:
            return unavailable
    except (KeyError, TypeError, ValueError):
        return unavailable
    orders = snapshot.get("orders") or []
    accounts = set(snapshot.get("accounts") or [])
    grouped = {}
    for position in metrics.get("positions") or []:
        quantity = _number(position.get("quantity"))
        if not quantity or position.get("category") == "event_contract" or not position.get("symbol"):
            continue
        side = "LONG" if quantity > 0 else "SHORT"
        key = f"{position['symbol']}:{side}"
        grouped.setdefault(key, []).append(position)
    checks = {}
    for key, positions in grouped.items():
        action = "SELL" if key.endswith(":LONG") else "BUY"
        contracts = {}
        uncertain = False
        for position in positions:
            identity = (position.get("account"), position.get("conId"))
            if identity[0] not in accounts or not identity[1]:
                uncertain = True
            contracts[identity] = contracts.get(identity, 0) + abs(_number(position.get("quantity")))
        held = sum(contracts.values())
        covered = 0
        has_excess = False
        wrong_side = False
        stops = []
        for identity, quantity in contracts.items():
            if identity[0] not in accounts or not identity[1]:
                continue
            candidates = [order for order in orders if (order.get("account"), order.get("conId")) == identity
                          and order.get("orderType") in STOP_TYPES and order.get("status") not in FINISHED]
            amounts = {}
            for order in candidates:
                if order.get("action") != action:
                    wrong_side = True
                    continue
                stops.append(order)
                remaining = _number(order.get("remaining"))
                parent_working = order.get("parentId") and any(parent.get("orderId") == order["parentId"]
                    and parent.get("clientId") == order.get("clientId") and parent.get("account") == identity[0]
                    and parent.get("status") not in FINISHED for parent in orders)
                cross_contract_oca = order.get("ocaGroup") and any(other.get("ocaGroup") == order["ocaGroup"]
                    and (other.get("account"), other.get("conId")) != identity for other in orders)
                trigger = _number(order.get("auxPrice")) if order.get("orderType") in {"STP", "STP LMT", "STP PRT"} else (
                    _number(order.get("trailStopPrice")) or _number(order.get("trailingPercent")) or _number(order.get("auxPrice")))
                if order.get("status") not in WORKING or order.get("conditional") or order.get("goodAfterTime") or parent_working or cross_contract_oca or remaining is None or not trigger or trigger <= 0:
                    uncertain = True
                    continue
                group = ("oca", order["ocaGroup"]) if order.get("ocaGroup") else ("order", order.get("permId") or (order.get("clientId"), order.get("orderId")))
                amounts[group] = max(amounts.get(group, 0), max(0, remaining))
            contract_covered = sum(amounts.values())
            has_excess = has_excess or contract_covered > quantity + 1e-6
            covered += min(contract_covered, quantity)
        status = "oversized" if has_excess else "verify" if uncertain else "covered" if covered >= held - 1e-6 else "partial" if covered > 0 else "wrong_side" if wrong_side else "missing"
        checks[key] = {"status": status, "heldQuantity": held, "coveredQuantity": covered,
                       "coveragePct": covered / held * 100 if held else None, "orders": stops}
    return {"status": "captured", "asOf": snapshot["asOf"], "byHolding": checks}
