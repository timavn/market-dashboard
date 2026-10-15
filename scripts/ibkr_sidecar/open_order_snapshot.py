"""Read-only serialization of broker-reported working orders."""
import asyncio
import math
from types import SimpleNamespace


def broker_number(value):
    try:
        number = float(value)
        return number if math.isfinite(number) and abs(number) < 1e100 else None
    except (TypeError, ValueError):
        return None


def serialize_open_order(trade, accounts):
    order, contract, status = trade.order, trade.contract, trade.orderStatus
    account = order.account or (accounts[0] if len(accounts) == 1 else None)
    return {
        "orderId": order.orderId, "permId": order.permId or None,
        "clientId": order.clientId, "account": account,
        "symbol": contract.symbol, "conId": contract.conId or None,
        "secType": contract.secType, "currency": contract.currency,
        "action": order.action, "orderType": order.orderType,
        "totalQuantity": broker_number(order.totalQuantity),
        "filled": broker_number(status.filled), "remaining": broker_number(status.remaining),
        "status": status.status, "whyHeld": status.whyHeld or None,
        "lmtPrice": broker_number(order.lmtPrice), "auxPrice": broker_number(order.auxPrice),
        "trailStopPrice": broker_number(order.trailStopPrice),
        "trailingPercent": broker_number(order.trailingPercent),
        "parentId": order.parentId or None, "ocaGroup": order.ocaGroup or None,
        "ocaType": order.ocaType, "conditional": bool(order.conditions),
        "tif": order.tif, "outsideRth": order.outsideRth,
        "goodAfterTime": order.goodAfterTime or None, "goodTillDate": order.goodTillDate or None,
    }


async def fresh_open_orders(broker, accounts, timeout, verify_timeout):
    """Capture this request's callbacks, never ib_insync's merged trade cache.

    ib_insync retains some old order fields when an existing order is refreshed.
    Its default zero remaining quantity is also not a broker observation.
    Preserve missing quantity as unknown unless orderStatus actually arrives.
    """
    orders, statuses = {}, {}
    original_open, original_status = broker.wrapper.openOrder, broker.wrapper.orderStatus
    key_for = lambda order_id, client_id, perm_id: ("perm", perm_id) if perm_id else (client_id, order_id)

    def on_open(order_id, contract, order, state):
        if not order.whatIf:
            key = key_for(order_id, order.clientId, order.permId)
            status = statuses.get(key) or {"status": state.status, "filled": None, "remaining": None, "whyHeld": None}
            orders[key] = serialize_open_order(SimpleNamespace(order=order, contract=contract, orderStatus=SimpleNamespace(**status)), accounts)
        original_open(order_id, contract, order, state)

    def on_status(order_id, status, filled, remaining, avg_fill_price, perm_id, parent_id, last_fill_price, client_id, why_held, mkt_cap_price=0):
        key = key_for(order_id, client_id, perm_id)
        statuses[key] = {"status": status, "filled": broker_number(filled), "remaining": broker_number(remaining), "whyHeld": why_held or None}
        if key in orders:
            orders[key].update(statuses[key])
        original_status(order_id, status, filled, remaining, avg_fill_price, perm_id, parent_id, last_fill_price, client_id, why_held, mkt_cap_price)

    broker.wrapper.openOrder, broker.wrapper.orderStatus = on_open, on_status
    try:
        result = await asyncio.wait_for(broker.reqAllOpenOrdersAsync(), timeout=timeout)
        await asyncio.wait_for(broker.reqCurrentTimeAsync(), timeout=verify_timeout)
        if result is None or not broker.isConnected():
            raise ValueError("Fresh order snapshot could not be verified")
        expected = {key_for(trade.order.orderId, trade.order.clientId, trade.order.permId) for trade in result}
        if not expected.issubset(orders):
            raise ValueError("Some fresh order callbacks were unavailable")
        return list(orders.values())
    finally:
        broker.wrapper.openOrder, broker.wrapper.orderStatus = original_open, original_status
