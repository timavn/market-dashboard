"""Independent, bounded read of the book and research for PM attention.

This does not create a review, change the ingestion cursor or persist account data.
A complete holdings snapshot is independent from optional full-book valuations.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import math

from finding_source_reports import attach_finding_source_reports
from hedgai_review import portfolio_tick_readings
from inbox_holdings import current_holding_weights
from portfolio_brief import rule_holdings
from portfolio_review import portfolio_metrics, _unverified_evidence


def _fresh(source, now):
    try:
        observed = datetime.fromisoformat(str(source.get("asOf")).replace("Z", "+00:00"))
        return (source.get("liveVerified") is True and source.get("freshness") == "live"
                and not _unverified_evidence(source) and observed.tzinfo
                and -30 <= (now - observed).total_seconds() <= 60)
    except (ValueError, TypeError):
        return False


def _signature(source):
    data = source.get("data") or {}
    rows = data.get("positions")
    accounts = data.get("accounts")
    if not isinstance(rows, list) or not isinstance(accounts, list) or not accounts:
        return None
    signature = {}
    for row in rows:
        quantity = row.get("quantity")
        if (not isinstance(quantity, (int, float)) or isinstance(quantity, bool)
                or not math.isfinite(quantity) or row.get("account") not in accounts
                or not row.get("symbol") or _unverified_evidence(row)):
            return None
        key = (row["account"], str(row.get("conId") or ""), row["symbol"])
        signature[key] = signature.get(key, 0) + quantity
    return sorted(accounts), sorted(signature.items())


async def capture_attention_context(*, market_date_reader, holdings_reader, portfolio_reader,
                                    universe_reader, symbols_reader, documents_reader,
                                    projector, sizing_reader, research_index, events=(),
                                    balance_reader=None, balance_exceptions=None, tick_reader=None, now=None):
    diagnostics = []

    async def read(name, callback, timeout):
        try:
            return await asyncio.wait_for(callback(), timeout)
        except Exception as exc:
            diagnostics.append({"component": name, "status": "unavailable", "reason": type(exc).__name__})
            return None

    async def research():
        day = await market_date_reader()
        return day, await universe_reader(day)

    async def no_balance():
        return None

    async def no_ticks():
        return {}

    # Tick is display-only context for alerts. A missing feed leaves Tick as N/A
    # and never affects completeness or the Trade/Trend rule inputs.
    tick_cutoff = (now or datetime.now(timezone.utc)).isoformat().replace("+00:00", "Z")
    book, valuation, research_result, documents, balance, tick_overlay = await asyncio.gather(
        read("holdings", holdings_reader, 12), read("valuations", portfolio_reader, 20),
        read("research", research, 35),
        read("documents", lambda: asyncio.to_thread(documents_reader), 20),
        read("balance", balance_reader or no_balance, 15),
        read("tick", (lambda: tick_reader(tick_cutoff)) if tick_reader else no_ticks, 10),
    )
    current_time = now or datetime.now(timezone.utc)
    book = book or {}
    market_date, universe = research_result or (None, {})
    book_ok = bool(_fresh(book, current_time) and (book.get("data") or {}).get("coverageComplete") is True and _signature(book) is not None)
    # A valuation reader may deliberately limit rows or fail after holdings were
    # read. It can enrich only an exact same-account, same-quantity complete book.
    valuation_ok = bool(book_ok and valuation and _fresh(valuation, current_time)
                        and _signature(valuation) == _signature(book))
    source = valuation if valuation_ok else book
    metrics = portfolio_metrics(projector(source)) if book_ok else {"available": False, "positions": []}
    positions = metrics.get("positions") or []
    held = sorted({row["symbol"] for row in positions if row.get("category") != "event_contract"})
    intelligence = universe
    held_research = None
    if held and market_date:
        # Universe pagination uses no historical payload. The separate complete
        # held-symbol request retains comparison evidence without a top-k scan.
        async def read_all_held():
            pages = await asyncio.gather(*(symbols_reader(held[offset:offset + 200], market_date)
                                           for offset in range(0, len(held), 200)))
            by_symbol = {symbol: security for page in pages for symbol, security in (page.get("bySymbol") or {}).items()}
            if not all(symbol in by_symbol for symbol in held):
                raise ValueError("Incomplete held-security research")
            return {"bySymbol": by_symbol}

        held_research = await read("held_research", read_all_held, 8)
        if held_research:
            intelligence = {**universe, "bySymbol": {**(universe.get("bySymbol") or {}), **(held_research.get("bySymbol") or {})}}
    sizing = {}
    if held and valuation_ok:
        # Sizing decides TREND_BREAK, MAX and risk-cap findings. Without it those
        # findings vanish, so a scan the source did not answer cannot be complete.
        sizing = await read("sizing", lambda: sizing_reader.read_current(held, source.get("asOf"), timeout=10), 12) or {}
    sizing_complete = not held or not valuation_ok or sizing.get("complete") is True
    weights = current_holding_weights(valuation, current_time) if valuation_ok else []
    rules = rule_holdings(metrics, intelligence, (sizing or {}).get("bySymbol")) if book_ok else []
    # Weight and NLV must have full account/valuation provenance, not a first
    # account's summary or marks from a partly valued book.
    weights_by_key = {(row["holding"], row["heldSide"]): row.get("currentHolding") for row in weights}
    try:
        ticks, _ = portfolio_tick_readings(tick_overlay, as_of=tick_cutoff) if tick_overlay else ({}, [])
    except Exception as exc:
        ticks = {}
        diagnostics.append({"component": "tick", "status": "unavailable", "reason": type(exc).__name__})
    for row in rules:
        if ticks.get(row["holding"]):
            row["tick"] = ticks[row["holding"]]
        weight = weights_by_key.get((row["holding"], row["heldSide"])) or {}
        row["weightPct"] = weight.get("weightPct")
        if not weight:
            row["netLiquidation"] = None
    current_time = now or datetime.now(timezone.utc)
    book_ok = book_ok and bool(_fresh(book, current_time))
    if not book_ok:
        positions, rules, weights = [], [], []
        diagnostics.append({"component": "holdings", "status": "unavailable", "reason": "fresh_complete_book_unavailable"})
    findings = [{"event": event} for event in events if isinstance(event, dict)]
    enriched = await asyncio.to_thread(attach_finding_source_reports, {"findings": findings}, research_index)
    balance = balance or {}
    balance_data = balance.get("data") or {}
    current = balance_data.get("current") or {}
    balance_fresh = bool(_fresh({**balance, "freshness": "live"}, current_time)
                         and balance.get("freshness") in {"live", "live_with_dated_verified_history"}
                         and current.get("available") is True and current.get("status") == "live"
                         and current.get("source") == "ibkr_live_session" and current.get("fromCache") is False
                         and not _unverified_evidence(current))
    # Nested financial facts must pass provenance independently. An otherwise
    # live envelope cannot upgrade a failed or cached margin/capacity response.
    safe_balance_data = dict(balance_data)
    safe_current = dict(current) if balance_fresh else {}
    for key in ("margin", "capacity", "cash", "buffer"):
        if key in safe_current and _unverified_evidence(safe_current[key]):
            safe_current.pop(key)
    safe_balance_data["current"] = safe_current
    interest = balance_data.get("interestStatus") or {}
    if _unverified_evidence(interest) or _unverified_evidence(interest.get("comparison") or {}):
        safe_balance_data.pop("interestStatus", None)
    exceptions = balance_exceptions(safe_balance_data, current_live=balance_fresh) if balance_exceptions else []
    exceptions = [item for item in exceptions if "shortfall" in item.lower() or "deficit" in item.lower() or "discrepancy" in item.lower()]
    return {
        "asOf": current_time.isoformat().replace("+00:00", "Z"), "marketDate": market_date,
        "holdings": {"liveVerified": book_ok, "complete": book_ok, "asOf": book.get("asOf") if book_ok else None,
                     "positions": positions, "currentHoldings": weights, "ruleHoldings": rules,
                     "researchComplete": bool((held_research is not None or not held) and sizing_complete)},
        "research": intelligence, "documents": documents or {},
        "events": [row["event"] for row in enriched.get("findings", [])],
        "account": {"verified": balance_fresh, "asOf": balance.get("asOf"), "issues": exceptions,
                    "historyVerified": (safe_balance_data.get("interestStatus") or {}).get("available") is True},
        "diagnostics": diagnostics,
        "complete": bool(book_ok and universe.get("scanComplete") is True and (held_research is not None or not held) and sizing_complete),
    }
