"""Compact product labels from a Portfolio Review's immutable publications.

Membership and source actions explain the captured research context, not the
user's original entry thesis and never an independently published Trade signal.
"""
from __future__ import annotations

from copy import deepcopy
import math
import re

from daily_research_rollup import accepted_snapshots
from portfolio_position_alignment import (
    _comment_candidates, _obj, _prepare_commentary, _reference_date,
    _reference_source, _relation, _signal_candidates, _text, _time,
)
from portfolio_refresh import _action_comment


MEMBERSHIP_KINDS = {"position_mention", "position_reference", "investing_idea_position",
                    "signal_strength_added", "signal_strength_removed", "signal_strength_listed",
                    "signal_strength_membership", "signal_strength_short_added", "signal_strength_short_removed",
                    "signal_strength_short_membership", "portfolio_solutions_rank", "portfolio_rank", "etf_pro_rank"}
ACTION_KINDS = {"real_time_alert", "etf_pro_change", "position_change", "source_action"}
READING_KINDS = {"source-position", "action", "membership", "rank", "commentary", "trade", "trend", "tick"}


def _membership(reference):
    kind = reference.get("kind")
    if kind in {"portfolio_solutions_rank", "portfolio_rank", "etf_pro_rank"}:
        value = reference.get("value")
        rank = value.get("rank") if isinstance(value, dict) else value
        if isinstance(rank, (int, float)) and not isinstance(rank, bool) and math.isfinite(rank) and rank > 0:
            return "rank", f"Rank #{rank:g}"
        return None
    if kind in {"signal_strength_added", "signal_strength_short_added"}:
        return "membership", "Added"
    if kind in {"signal_strength_removed", "signal_strength_short_removed"}:
        return "membership", "Removed"
    if kind == "signal_strength_short_membership":
        return "membership", "Listed"
    value = reference.get("value")
    explicit = (_obj(value).get("side") or _obj(value).get("position")
                or (value if isinstance(value, str) else None) or reference.get("direction"))
    side = str(explicit or "").upper()
    if kind in {"signal_strength_listed", "signal_strength_membership"}:
        return "membership", side.title() if side in {"LONG", "SHORT", "BULLISH", "BEARISH", "NEUTRAL"} else "Listed"
    if side in {"LONG", "SHORT", "NEUTRAL"}:
        return "source-position", f"Source {side.title()} position"
    if side in {"BULLISH", "BEARISH"}:
        return "source-position", side.title()
    return None


def _product(reference, citation):
    """Signal Strength Shorts is its own product, also for its events recorded
    under the long product before the split (2026-10-29)."""
    if str(reference.get("kind") or "").startswith("signal_strength_short_"):
        return "signal-strength-shorts", "Signal Strength Shorts"
    return reference["productId"], citation["productLabel"]


def portfolio_product_readings(holdings, intelligence, daily_research, *, as_of):
    """Return source-bound labels by held ticker, without calls or mutations."""
    cutoff = _time(as_of)
    if not cutoff:
        return {}
    publications = _prepare_commentary(accepted_snapshots(_obj(daily_research), as_of=cutoff))
    output = {}
    for holding in holdings:
        symbol = _text(holding.get("holding")).upper()
        security = _obj(_obj(_obj(intelligence).get("bySymbol")).get(symbol))
        if not symbol:
            continue
        candidates = _signal_candidates(security, symbol, cutoff)
        candidates += [candidate for candidate in _comment_candidates(symbol, security, publications, cutoff)
                       if candidate.get("kind") != "action"]
        # The product view uses the most recent reading, while the alignment
        # narrative may retain the original date of a confirmed transition.
        for candidate in candidates:
            if candidate.get("lastConfirmedAt"):
                candidate["date"] = candidate["lastConfirmedAt"]
                if candidate.get("direction"):
                    candidate["reading"] = f"{candidate['direction'].title()} {candidate['kind'].title()}"
        references = list(security.get("directReferences") or [])
        for history in security.get("history") or []:
            references.extend(_obj(history).get("directReferences") or [])
        latest_membership = {}
        for reference in references:
            if not isinstance(reference, dict) or reference.get("kind") not in MEMBERSHIP_KINDS | ACTION_KINDS:
                continue
            relation, source_ticker = _relation(reference, symbol)
            citation = _reference_source(reference, cutoff)
            if relation != "direct" or not citation or any(reference.get(flag) is True for flag in ("fixture", "isSeeded")):
                continue
            label = _membership(reference) if reference.get("kind") in MEMBERSHIP_KINDS else None
            action = _action_comment(reference, symbol) if reference.get("kind") in ACTION_KINDS else None
            if not label and not action:
                continue
            kind, reading = label if label else ("action", action["reading"])
            date = _reference_date(reference)
            product, product_label = _product(reference, citation)
            candidate = {"product": product, "productLabel": product_label,
                         "reading": reading, "kind": kind, "date": date,
                         "relation": relation, "sourceTicker": source_ticker, "citations": [citation]}
            key = (product, "membership" if label else "action")
            prior = latest_membership.get(key, [])
            newest = str(prior[0]["date"]) if prior else ""
            if str(date) > newest:
                latest_membership[key] = [candidate]
            elif str(date) == newest:
                latest_membership[key].append(candidate)
        candidates += [item for values in latest_membership.values() for item in values]
        records = {}
        for candidate in candidates:
            if not candidate.get("citations"):
                continue
            item = {field: deepcopy(candidate.get(field)) for field in
                    ("product", "productLabel", "reading", "kind", "date", "relation", "sourceTicker", "citations")}
            key = (item["product"], item["kind"], item["reading"], item["relation"], item["sourceTicker"], item["date"])
            existing = records.get(key)
            if existing:
                sources = {source["id"]: source for source in existing["citations"] + item["citations"]}
                existing["citations"] = list(sources.values())
            else:
                records[key] = item
        output[symbol] = list(records.values())
    return output


def with_captured_refresh_products(holdings, report):
    """Retain the same capture's archive evidence in compact position rows.

    Refresh report tables intentionally keep only their displayed primary
    reading. Their original structured holdings retain every product reading
    and citation ID; no source scan is performed by this display projection.
    """
    citations = {source["id"]: source for source in _obj(report).get("citations") or []
                 if isinstance(source, dict) and source.get("id")}
    for holding in holdings:
        symbol = holding["holding"]
        captured = list(holding.get("productReadings") or [])
        for checked in _obj(report).get("holdings") or []:
            if checked.get("ticker") != symbol or checked.get("heldSide") != holding.get("heldSide"):
                continue
            for evidence in checked.get("evidence") or []:
                item = _obj(evidence)
                if item.get("kind") not in READING_KINDS or not item.get("product") or not item.get("date") or not item.get("reading"):
                    continue
                sources = [citations[cid] for cid in item.get("citationIds") or [] if cid in citations]
                if not sources:
                    continue
                # Archive rank rows were projected from verified exact direct
                # references, before their optional relation field was added.
                relation = item.get("relation") or ("direct" if item["kind"] == "rank" else None)
                if relation not in {"direct", "proxy"}:
                    continue
                reading = item["reading"]
                if item["kind"] in {"trade", "trend"} and item.get("direction") in {"BULLISH", "BEARISH", "NEUTRAL"}:
                    reading = f"{item['direction'].title()} {item['kind'].title()}"
                rank = re.fullmatch(r"Published rank ([0-9]+(?:\.[0-9]+)?)", reading) if item["kind"] == "rank" else None
                if rank:
                    reading = f"Rank #{rank[1]}"
                captured.append({"product": item["product"], "productLabel": item.get("productLabel")
                                 or sources[0].get("productLabel") or sources[0].get("title") or item["product"],
                                 "reading": reading, "kind": item["kind"], "date": item["date"],
                                 "lastConfirmedAt": item.get("lastConfirmedAt") or item["date"],
                                 "relation": relation, "sourceTicker": item.get("sourceTicker") or (symbol if relation == "direct" else None),
                                 "citations": deepcopy(sources)})
        grouped = {}
        for item in captured:
            key = (item["product"], item["kind"], item["relation"], item["sourceTicker"])
            group = grouped.setdefault(key, [])
            group.append(item)
        selected = []
        for group in grouped.values():
            latest = max(str(item.get("lastConfirmedAt") or item["date"]) for item in group)
            source_map = {source["id"]: source for item in group for source in item["citations"]}
            readings = {}
            for item in group:
                if str(item.get("lastConfirmedAt") or item["date"]) == latest:
                    readings.setdefault(item["reading"], {**item, "citations": list(source_map.values())})
            selected.extend(readings.values())
        holding["productReadings"] = selected
