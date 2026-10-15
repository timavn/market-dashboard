"""Versioned, source-bound refresh of every captured portfolio position.

Acquisition belongs to ReviewRunV2. This projection neither fetches sources nor
changes saved captures, and archive research never grants execution eligibility.
"""
from __future__ import annotations

from copy import deepcopy
import json
import re

from portfolio_position_alignment import (
    ACTION_KINDS, TRADE_KINDS, TREND_KINDS, _aligned, _bias,
    _date_label, _explicit_comment, _number, _obj, _reference_date,
    _reference_source, _relation, _signal_candidates, _text, _time,
    _trade_direction, NY,
)
from portfolio_review import _unverified_evidence
from portfolio_capture import captured_security_name


TEMPLATE_VERSION = "portfolio-refresh-v1"
SECTION_DEFINITIONS = (
    ("refresh-realignment", "Highest-priority realignment"),
    ("refresh-watch-list", "Watch list"),
    ("refresh-aligned", "What is already aligned"),
    ("refresh-sequence", "Recommended sequence"),
)
COLUMNS = ["Ticker", "Security", "Position", "Source reading", "Review action", "Date"]
REALIGNMENT_COLUMNS = ["Ticker", "Security", "Bias", "Size", "Source action", "Notes", "Source date"]
UNSUPPORTED = {"opt", "option", "options", "fop", "future_option", "event_contract", "cash", "cash_balance"}
SUPPORTED_CATEGORIES = {"stock", "stocks", "equity", "equities", "etf", "future", "futures", "index", "bond", "fixed_income"}
SUPPORTED_SECURITY_TYPES = {"stk", "fut", "ind", "bond"}
RANK_KINDS = {"portfolio_rank", "portfolio_solutions_rank", "etf_pro_rank", "sector_rank"}


def _references(security, archived):
    rows = list(_obj(security).get("directReferences") or [])
    for item in _obj(security).get("history") or []:
        rows.extend(_obj(item).get("directReferences") or [])
    rows.extend(_obj(archived).get("references") or [])
    return [row for row in rows if isinstance(row, dict)]


def _valid_references(rows, symbol, cutoff):
    return [row for row in rows
            if _relation(row, symbol)[0] == "direct" and _reference_source(row, cutoff)
            and not any(row.get(flag) is True for flag in ("fixture", "isSeeded"))
            and (not row.get("eventTime") or (_time(row["eventTime"]) and _time(row["eventTime"]) <= cutoff))]


def _date_key(value):
    instant = _time(value)
    return instant.isoformat() if instant else str(value) + "T00:00:00+00:00"


def _source_date(reference):
    return str(reference.get("marketDate") or "")


def _citation(reference, cutoff):
    source = _reference_source(reference, cutoff)
    if source:
        # The immutable archive checkpoint owns full source bodies. Report
        # citations retain exact excerpts and identity/hash pointers once,
        # rather than repeating a publication's body for each held position.
        for key in ("sourceSnapshotId", "sourceSnapshotHash", "sourceContentHash", "sourceMessageId", "eventTime", "fieldPath"):
            if reference.get(key) is not None:
                source[key] = deepcopy(reference[key])
        proof = _obj(reference.get("sourceEvidence"))
        if proof:
            source["sourceEvidence"] = {key: deepcopy(value) for key, value in proof.items() if key != "bodyText"}
    return source


def _signals(security, references, symbol, cutoff):
    native = _signal_candidates(_obj(security), symbol, cutoff)
    native_refs = _references(security, {})
    eligible = set()
    for row in native:
        descriptor = _obj(_obj(security.get("decision")).get(row["kind"]))
        if not row.get("currentRule") or _unverified_evidence(descriptor) or descriptor.get("currentDecisionEligible") is False or descriptor.get("referenceOnly") is True:
            continue
        if any(ref.get("productId") == row["product"] and _reference_date(ref) == row["lastConfirmedAt"]
               and not _unverified_evidence(ref)
               and ref.get("currentDecisionEligible") is not False and ref.get("referenceOnly") is not True
               for ref in native_refs):
            eligible.add((row["product"], row["kind"], row["direction"], row["lastConfirmedAt"]))
    merged = {"decision": _obj(security.get("decision")), "directReferences": references, "history": [], "proxyReferences": []}
    candidates = _signal_candidates(merged, symbol, cutoff)
    for row in candidates:
        row["currentRule"] = (row["product"], row["kind"], row["direction"], row["lastConfirmedAt"]) in eligible
    ambiguous = []
    groups = {}
    for ref in references:
        kind = "trade" if ref.get("kind") in TRADE_KINDS else "trend" if ref.get("kind") in TREND_KINDS else None
        if not kind:
            continue
        value = ref.get("value")
        direction = (_trade_direction(ref) if kind == "trade" else
                     _bias(_obj(value).get("trend") if isinstance(value, dict) else value) or _bias(ref.get("direction")))
        if direction:
            groups.setdefault((ref.get("productId"), kind), []).append((ref, direction))
    for (product, kind), rows in groups.items():
        latest = max(_date_key(_reference_date(ref)) for ref, _ in rows)
        newest = [(ref, direction) for ref, direction in rows if _date_key(_reference_date(ref)) == latest]
        if len({direction for _, direction in newest}) > 1:
            ambiguous.append({"kind": "ambiguity", "product": product, "reading": f"Conflicting {kind.title()} readings",
                              "date": _reference_date(newest[0][0]), "citations": [_citation(ref, cutoff) for ref, _ in newest],
                              "currentRule": False, "sourceText": ""})
    return candidates, ambiguous


def _action_comment(reference, symbol):
    excerpt = reference.get("excerpt") or ""
    try:
        parsed = json.loads(excerpt)
        if isinstance(parsed, dict) and str(parsed.get("ticker") or parsed.get("symbol") or "").upper() == symbol:
            excerpt = parsed.get("signalPhrase") or parsed.get("headline") or ""
    except (TypeError, ValueError):
        pass
    comment = _explicit_comment(excerpt, symbol)
    # Archive extractors carry exact structured actions from publisher fields.
    # Require the original publication, its content hash, and a direct typed
    # reference; never infer a removal from a subsequent missing roster member.
    value, proof = _obj(reference.get("value")), _obj(reference.get("sourceEvidence"))
    action = str(value.get("action") or reference.get("action") or "").lower().replace("_", "-")
    side = str(value.get("side") or "").upper()
    matched_report = bool(proof.get("contentHash") and proof.get("sourceUrl") == reference.get("sourceUrl")
                          and proof.get("publicationDate") == reference.get("marketDate")
                          and (not reference.get("sourceMessageId") or proof.get("sourceMessageId") == reference.get("sourceMessageId")))
    if not side and matched_report and str(value.get("ticker") or value.get("symbol") or "").upper() == str(reference.get("sourceTicker") or symbol).upper():
        side = "LONG" if action == "sell-some" else "SHORT" if action == "cover-some" else ""
    if matched_report and ((side == "LONG" and action == "sell-some") or (side == "SHORT" and action == "cover-some")):
        return {"reading": "Sell some" if action == "sell-some" else "Cover some",
                "effect": "reduce-long" if action == "sell-some" else "reduce-short",
                "sourceText": excerpt or _text(proof.get("title"))}
    partial = "sell" if action in {"sell", "sell-some", "trim"} or _obj(comment).get("effect") == "sell-long" else "cover" if action in {"cover", "cover-some"} or _obj(comment).get("effect") == "cover-short" else None
    if partial and (comment or (side in {"LONG", "SHORT"} and matched_report)):
        scope = str(value.get("scope") or value.get("intent") or "").lower()
        instruction = None
        if matched_report:
            body = _text(proof.get("bodyText"))
            for sentence in re.split(r"(?<=[.!?])\s+|\n", body):
                exact = _explicit_comment(sentence, symbol)
                directive = re.search(r"\bPortfolio Managers should be (selling|covering)[\s-]+SOME\b[^.!?]*(?:[.!?]|$)", sentence, re.I)
                if (exact and exact.get("effect") == ("reduce-long" if partial == "sell" else "reduce-short")) or (
                        directive and directive[1].lower() == ("selling" if partial == "sell" else "covering")
                        and not re.search(r"\b(?:previously|historically|never|not|avoid|unless|if)\b", sentence[:directive.start()], re.I)):
                    instruction = exact.get("sourceText") if exact else directive[0]
                    break
        if instruction or scope in {"some", "partial", "sell-some", "cover-some", "reduce", "trim"}:
            return {"reading": "Sell some" if partial == "sell" else "Cover some",
                    "effect": "reduce-long" if partial == "sell" else "reduce-short",
                    "sourceText": instruction or excerpt or _text(proof.get("title"))}
    if comment:
        return comment
    if not (proof.get("contentHash") and proof.get("sourceUrl") and
            (proof.get("bodyText") or proof.get("title")) and side in {"LONG", "SHORT"}):
        return None
    canonical = {"add": "ADD", "added": "ADD", "remove": "REMOVE", "removed": "REMOVE"}.get(action)
    if canonical:
        result = _explicit_comment(f"{canonical} {symbol} — {side.title()}", symbol)
        result["sourceText"] = excerpt or _text(proof.get("title"))
        return result
    effects = {
        "sell-some": ("Sell some", "reduce-long"), "trim": ("Sell some", "reduce-long"),
        "cover-some": ("Cover some", "reduce-short"), "sell": ("Sell", "sell-long"),
        "exit": ("Exit Long", "exit-long"), "sell-all": ("Exit Long", "exit-long"),
        "cover": ("Cover", "cover-short"), "cover-all": ("Cover all", "exit-short"),
    }
    selected = effects.get(action)
    if selected and ((side == "LONG" and selected[1].endswith("long")) or
                     (side == "SHORT" and selected[1].endswith("short"))):
        return {"reading": selected[0], "effect": selected[1], "sourceText": excerpt or _text(proof.get("title"))}
    return None


def _roster_positions(publications, symbol, cutoff):
    """Affirmative exact membership may supersede removal; absence never may."""
    output = []
    for publication in publications:
        if not isinstance(publication, dict) or publication.get("completeRoster") is not True or not publication.get("contentHash") or _unverified_evidence(publication):
            continue
        if publication.get("eventTime") and (not _time(publication["eventTime"]) or _time(publication["eventTime"]) > cutoff):
            continue
        for member in publication.get("positions") or []:
            member = _obj(member)
            side = str(member.get("side") or "").upper()
            if side not in {"LONG", "SHORT"} or not _text(member.get("ticker")):
                continue
            reference = {**publication, "kind": "source_position", "matchType": "direct", "sourceTicker": member.get("ticker"),
                         "qualityStatus": "validated", "sourceEventId": publication.get("sourceMessageId") or publication.get("sourceSnapshotId"),
                         "sourceContentHash": publication["contentHash"], "excerpt": f"{member.get('ticker')}: Source {side.title()} position"}
            if _relation(reference, symbol)[0] != "direct":
                continue
            citation = _citation(reference, cutoff)
            if not citation:
                continue
            output.append({"kind": "source-position", "side": side, "effect": "bullish" if side == "LONG" else "bearish",
                           "direction": "BULLISH" if side == "LONG" else "BEARISH", "reading": f"Source {side.title()} position",
                           "date": _reference_date(reference), "orderAt": _reference_date(reference) if _time(_reference_date(reference)) else publication.get("eventTime") or _reference_date(reference),
                           "product": publication.get("productId"), "productLabel": publication.get("productLabel") or publication.get("productId"),
                           "marketDate": publication.get("marketDate"), "citations": [citation], "relation": "direct", "currentRule": False,
                           "sourceText": reference["excerpt"]})
    return output


def _actions(references, symbol, cutoff, publications=()):
    groups = {}
    for ref in references:
        if ref.get("kind") not in ACTION_KINDS:
            continue
        comment = _action_comment(ref, symbol)
        if not comment:
            continue
        effect = comment["effect"]
        side = "LONG" if effect.endswith("long") or effect == "bullish" else "SHORT" if effect.endswith("short") or effect == "bearish" else None
        if not side:
            continue
        family = "roster" if effect.startswith("remove-") or comment["reading"].startswith("Added source") else "action"
        groups.setdefault((ref.get("productId"), side, family), []).append({
            **comment, "kind": "action", "side": side, "product": ref.get("productId"),
            "productLabel": ref.get("productLabel") or ref.get("productId"),
            "date": _reference_date(ref), "citations": [_citation(ref, cutoff)],
            "orderAt": _reference_date(ref) if _time(_reference_date(ref)) else ref.get("eventTime") or _reference_date(ref),
            "currentRule": False, "marketDate": _source_date(ref), "relation": "direct",
        })
    for membership in _roster_positions(publications, symbol, cutoff):
        groups.setdefault((membership["product"], membership["side"], "roster"), []).append(membership)
    output, ambiguous = [], []
    for rows in groups.values():
        latest = max(_date_key(row["orderAt"]) for row in rows)
        newest = [row for row in rows if _date_key(row["orderAt"]) == latest]
        if len({row["effect"] for row in newest}) > 1:
            ambiguous.append({"kind": "ambiguity", "product": newest[0]["product"],
                              "reading": "Conflicting source actions", "date": newest[0]["date"],
                              "citations": [citation for row in newest for citation in row["citations"]],
                              "currentRule": False, "sourceText": ""})
            continue
        chosen = dict(sorted(newest, key=lambda row: row["citations"][0]["id"])[0])
        chosen["citations"] = list(chosen["citations"])
        # Repeated action confirmations keep the original action date until a
        # different explicit action intervenes. A re-add supersedes removal.
        original_order = chosen["orderAt"]
        original_citation = None
        for row in sorted(rows, key=lambda row: _date_key(row["orderAt"]), reverse=True):
            if row["effect"] != chosen["effect"]:
                break
            if _date_key(row["orderAt"]) < _date_key(original_order):
                chosen["date"] = row["date"]
                original_citation = row["citations"][0]
        if original_citation:
            chosen["citations"].append(original_citation)
        chosen["lastConfirmedAt"] = newest[0]["date"]
        chosen["currentSourceAction"] = chosen["marketDate"] == cutoff.astimezone(NY).date().isoformat() and chosen["date"] == newest[0]["date"]
        output.append(chosen)
    return output, ambiguous


def _ranks(references, cutoff):
    grouped = {}
    for reference in references:
        value = reference.get("value")
        rank = _number(_obj(value).get("rank") if isinstance(value, dict) else value)
        if reference.get("kind") in RANK_KINDS and rank is not None and rank > 0:
            grouped.setdefault((reference.get("productId"), reference.get("kind")), []).append((reference, rank))
    result = []
    for (product, _), rows in grouped.items():
        ref, rank = max(rows, key=lambda pair: _date_key(_reference_date(pair[0])))
        result.append({"kind": "rank", "product": product, "reading": f"Published rank {rank:g}",
                       "date": _reference_date(ref), "citations": [_citation(ref, cutoff)], "currentRule": False,
                       "sourceText": ref.get("excerpt") or ""})
    return result


def _position(position, index, current):
    position = _obj(position)
    quantity = _number(position.get("quantity"))
    symbol = _text(position.get("symbol")).upper()
    side = "LONG" if quantity is not None and quantity > 0 else "SHORT" if quantity is not None and quantity < 0 else None
    category, security_type = str(position.get("category") or "").lower(), str(position.get("secType") or "").lower()
    unsupported = category in UNSUPPORTED or security_type in UNSUPPORTED or not (
        category in SUPPORTED_CATEGORIES or security_type in SUPPORTED_SECURITY_TYPES)
    fresh = current and position.get("verified") is not False and not _unverified_evidence(position) and bool(symbol and side)
    name = next((_text(position.get(key)) for key in ("securityName", "longName", "companyName", "name", "description")
                 if _text(position.get(key)) and _text(position.get(key)).upper() != symbol), "—")
    return {"positionId": f"{position.get('account') or ''}:{position.get('conId') or ''}:{index}",
            "ticker": symbol or "—", "security": name, "account": position.get("account"),
            "conId": position.get("conId"), "category": position.get("category"), "secType": position.get("secType"),
            "contract": position.get("contract"), "expiration": position.get("expiration"), "strike": position.get("strike"),
            "right": position.get("right"), "eventSide": position.get("eventSide"), "currency": position.get("currency"),
            "quantity": quantity, "heldSide": side, "currentHoldingVerified": fresh,
            "supported": not unsupported and bool(symbol and side), "classification": "unavailable",
            "proposedAction": None, "currentActionAllowed": False, "evidence": [], "citationIds": []}


def _resolve(row, evidence, ambiguous):
    side = row["heldSide"]
    if not row["currentHoldingVerified"] or not row["supported"]:
        row["reading"] = "—"
        row["reviewAction"] = "Review instrument separately" if row["currentHoldingVerified"] and not row["supported"] else "—"
        return
    current_trade = [item for item in evidence if item["kind"] == "trade" and item.get("currentRule")]
    current_trend = [item for item in evidence if item["kind"] == "trend" and item.get("currentRule")]
    opposing_trade = [item for item in current_trade if item.get("direction") in {"BULLISH", "BEARISH"} and not _aligned(side, item["direction"])]
    aligned_trade = any(_aligned(side, item.get("direction")) for item in current_trade)
    opposing_trend = [item for item in current_trend if item.get("direction") in {"BULLISH", "BEARISH"} and not _aligned(side, item["direction"])]
    actions = [item for item in evidence if item["kind"] == "action" and item.get("side") == side and
               item.get("effect") in {"remove-long", "remove-short", "reduce-long", "reduce-short", "sell-long", "cover-short", "exit-long", "exit-short"}]
    primary = None
    if opposing_trade and not any(item.get("reading") == "Conflicting Trade readings" for item in ambiguous):
        primary = opposing_trade[0]
        row.update(classification="realignment", proposedAction="Exit Long" if side == "LONG" else "Cover Short",
                   currentActionAllowed=True, reviewAction="Trade opposes the holding; apply the exit rule")
    elif opposing_trend and aligned_trade and not any(item.get("reading") == "Conflicting Trend readings" for item in ambiguous):
        primary = opposing_trend[0]
        row.update(classification="realignment", proposedAction="Reduce to MIN", currentActionAllowed=True,
                   reviewAction="Trend opposes the holding while Trade remains aligned; apply MIN")
    elif actions:
        primary = max(actions, key=lambda item: _date_key(item["date"]))
        current = primary.get("currentSourceAction") is True
        effect = primary["effect"]
        label = ("Review partial Long reduction" if effect == "reduce-long" else "Review partial Short cover" if effect == "reduce-short"
                 else f"Requalify {side.title()} holding" if effect.startswith("remove-") else f"Review published {primary['reading']} action")
        row.update(classification="realignment", proposedAction=label if current else f"Requalify {side.title()} holding",
                   reviewAction=label if current else "Requalify against the dated source action", currentActionAllowed=False)
    elif ambiguous:
        primary = ambiguous[0]
        row.update(classification="watch", reviewAction="Resolve conflicting publication evidence")
    else:
        opposed = [item for item in evidence if item.get("direction") in {"BULLISH", "BEARISH"} and not _aligned(side, item["direction"])]
        if opposed:
            primary = max(opposed, key=lambda item: _date_key(item["date"]))
            row.update(classification="watch", reviewAction="Review dated direction alongside the latest Trade")
        elif any(item.get("currentRule") and _aligned(side, item.get("direction")) for item in evidence):
            primary = next(item for item in evidence if item.get("currentRule") and _aligned(side, item.get("direction")))
            row.update(classification="aligned", reviewAction="Current published direction supports the holding")
        else:
            primary = max(evidence, key=lambda item: _date_key(item["date"])) if evidence else None
            row.update(classification="watch", reviewAction="Review dated support" if primary else "—")
    row["reading"] = primary["reading"] if primary else "—"
    row["publishedAt"] = primary["date"] if primary else None
    row["sourceAction"] = primary["reading"] if primary and primary["kind"] == "action" else None
    row["reason"] = row["reviewAction"]


def _table_row(row, *, realignment=False):
    ids = row["citationIds"]
    position = row["heldSide"].title() if row["currentHoldingVerified"] and row["heldSide"] else "—"
    if row.get("weightPct") is not None:
        position += f" · {row['weightPct']:.2f}%"
    identity_detail = " · ".join(str(row[key]) for key in ("contract", "category", "secType", "expiration", "strike", "right", "eventSide", "account", "conId")
                                 if row.get(key) is not None and str(row[key]))
    reading_title = "\n".join(f"{item.get('productLabel') or item.get('product')} · {_date_label(item['date'])}: {item['reading']}"
                              for item in row["evidence"])
    bias, separator, size = position.partition(" · ")
    cells = ([row["ticker"], row["security"], bias, size if separator else "—", row.get("reading") or "—",
              row.get("reviewAction") or "—", _date_label(row.get("publishedAt"))] if realignment else
             [row["ticker"], row["security"], position, row.get("reading") or "—",
              row.get("reviewAction") or "—", _date_label(row.get("publishedAt"))])
    titles = ([identity_detail or row["ticker"], row["security"], identity_detail or "Captured position",
               "Captured position size", reading_title, row.get("reason") or "", row.get("publishedAt") or ""] if realignment else
              [identity_detail or row["ticker"], row["security"], identity_detail or "Captured position",
               reading_title, row.get("reason") or "", row.get("publishedAt") or ""])
    return {"cells": cells,
            "citationIds": ids, "cellCitationIds": [[], [], [], [], ids, ids, ids] if realignment else [[], [], [], ids, ids, ids],
            "cellTitles": titles,
            "holding": row["ticker"], "positionId": row["positionId"], "classification": row["classification"]}


def _product_coverage(archive, coverage):
    current = {str(row.get("product") or row.get("id")): row for row in _obj(coverage).get("products") or [] if isinstance(row, dict)}
    archived = {str(row.get("id") or row.get("product")): row for row in _obj(archive.get("coverage")).get("products") or [] if isinstance(row, dict)}
    result = []
    for product in sorted(set(current) | set(archived)):
        historical, now = _obj(archived.get(product)), _obj(current.get(product))
        result.append({**deepcopy(historical), "id": product, "label": historical.get("label") or now.get("label") or product,
                       "status": historical.get("status") or "incomplete", "currentStatus": now.get("status"),
                       "currentPublicationDate": now.get("latestPublicationDate"),
                       "reasons": list(dict.fromkeys([*(historical.get("reasons") or []), *([now.get("warning")] if now.get("warning") else [])]))})
    return result


def _selected_source_details(references, evidence, cutoff):
    selected = {citation["id"]: citation for item in evidence for citation in item.get("citations") or [] if citation}
    keys = {(citation.get("product"), citation.get("publicationDate"), citation.get("sourceUri"), citation.get("excerpt"))
            for citation in selected.values()}
    for reference in references:
        uri = reference.get("sourceUrl") or f"dynamodb://ResearchEntityEventsV1/{reference.get('sourceEventId') or reference.get('id') or ''}"
        key = (reference.get("productId"), reference.get("marketDate"), uri, reference.get("excerpt"))
        if key in keys:
            detail = _citation(reference, cutoff)
            if detail and detail["id"] in selected:
                selected[detail["id"]] = detail
    return selected


def _compact_evidence(item):
    facts = {key: deepcopy(value) for key, value in item.items() if key != "citations"}
    facts["citationIds"] = list(dict.fromkeys(citation["id"] for citation in item.get("citations") or [] if citation))
    return facts


def build_portfolio_refresh(metrics, intelligence, archive, coverage, *, as_of=None):
    """Return the immutable portfolio-refresh-v1 facts and four report sections.

    ``metrics`` must come from the same capture's ``portfolio_metrics``. Every
    supplied position retains a check row, including unsupported instruments.
    Completeness describes the available source archive, never all delivery.
    """
    metrics, intelligence, archive = _obj(metrics), _obj(intelligence), _obj(archive)
    cutoff = _time(as_of)
    positions = metrics.get("positions") if isinstance(metrics.get("positions"), list) else []
    count_matches = metrics.get("positionCount", len(positions)) == len(positions)
    available = metrics.get("available") is True and metrics.get("verified") is not False and not _unverified_evidence(metrics) and cutoff is not None and count_matches and _time(metrics.get("observedAt")) is not None
    products = _product_coverage(archive, coverage)
    archive_valid = archive.get("schemaVersion") == 1 and archive.get("scope") == "available-source-archive"
    scan_complete = archive_valid and archive.get("scanComplete") is True
    citations, holdings, facts_by_symbol = {}, [], {}
    for index, position in enumerate(positions):
        row = _position(position, index, available)
        symbol = row["ticker"]
        security = _obj(_obj(intelligence.get("bySymbol")).get(symbol))
        if row["security"] == "—":
            row["security"] = captured_security_name({**security, "symbol": symbol}) or "—"
        archived = _obj(_obj(archive.get("bySymbol")).get(symbol)) if archive_valid else {}
        if symbol not in facts_by_symbol:
            refs = _valid_references(_references(security, archived), symbol, cutoff) if cutoff else []
            signals, ambiguous = _signals(security, refs, symbol, cutoff) if cutoff else ([], [])
            actions, action_conflicts = _actions(refs, symbol, cutoff, archive.get("publications") or [] if archive_valid else []) if cutoff else ([], [])
            evidence = signals + actions + (_ranks(refs, cutoff) if cutoff else [])
            ambiguous += action_conflicts
            source_details = _selected_source_details(refs, evidence + ambiguous, cutoff)
            for item in evidence + ambiguous:
                item["citations"] = list({citation["id"]: source_details.get(citation["id"], citation)
                                          for citation in item["citations"] if citation}.values())
            facts_by_symbol[symbol] = evidence, ambiguous
        evidence, ambiguous = facts_by_symbol[symbol]
        row["evidence"] = [_compact_evidence(item) for item in evidence + ambiguous]
        row["checkedProducts"] = list(dict.fromkeys([*(_obj(archived).get("checkedProducts") or []),
            *(item.get("product") for item in row["evidence"] if item.get("product"))]))
        for item in evidence + ambiguous:
            for citation in item.get("citations") or []:
                if citation and citation.get("id"):
                    citations[citation["id"]] = citation
                    if citation["id"] not in row["citationIds"]:
                        row["citationIds"].append(citation["id"])
        _resolve(row, evidence, ambiguous)
        value, nlv = _number(_obj(position).get("marketValue")), _number(metrics.get("netLiquidation"))
        row["weightPct"] = abs(value) / nlv * 100 if row["currentHoldingVerified"] and _obj(position).get("markState") in {"live", "settled", "resolver"} and value is not None and nlv and nlv > 0 else None
        holdings.append(row)
    sections = [{"id": sid, "title": title, "blocks": [], "citationIds": []} for sid, title in SECTION_DEFINITIONS]
    buckets = {"realignment": sections[0], "watch": sections[1], "aligned": sections[2], "unavailable": sections[1]}
    if available:
        displayed_counts = {}
        for category, section in buckets.items():
            if category == "unavailable":
                continue
            selected = [row for row in holdings if row["classification"] == category and
                        (category != "watch" or (row["evidence"] and (row.get("reading") or "—") != "—"))]
            selected.sort(key=lambda row: (not row["currentActionAllowed"], -(row["weightPct"] or 0), row["ticker"], row["positionId"]))
            # Preserve every eligible row in the immutable capture; the report
            # UI owns its compact preview and Show all disclosure.
            displayed_counts[category] = {"total": len(selected), "shown": len(selected)}
            if selected:
                is_realignment = category == "realignment"
                section["blocks"].append({"type": "table", "columns": REALIGNMENT_COLUMNS if is_realignment else COLUMNS,
                                          "rows": [_table_row(row, realignment=is_realignment) for row in selected]})
                section["citationIds"] = list(dict.fromkeys([*section["citationIds"], *(cid for row in selected for cid in row["citationIds"])]))
        empty_copy = ("No evidenced realignment exceptions in this capture." if scan_complete else "The available evidence contains no realignment exception; the source scan is incomplete.",
                      "No additional evidenced watch-list exceptions.", "No holdings qualify as currently aligned in this capture.")
        for section, text in zip(sections[:3], empty_copy):
            if not section["blocks"]:
                section["blocks"] = [{"type": "paragraph", "text": text, "citationIds": []}]
        ordered = sorted([row for row in holdings if row["classification"] == "realignment"],
                         key=lambda row: (not row["currentActionAllowed"], -(row["weightPct"] or 0), row["ticker"], row["positionId"]))
        steps = [f"{row['ticker']}: {row['reviewAction']}." for row in ordered[:8]]
        if len(ordered) > 8:
            steps.append(f"Continue with the remaining {len(ordered) - 8} sourced realignment items in All holdings checked.")
        if any(row["classification"] == "watch" and row["evidence"] for row in holdings):
            steps.append("Review the remaining watch-list exceptions after the sourced realignment items.")
        if not steps:
            steps.append("No sourced realignment sequence is required by this capture.")
        sections[3]["blocks"] = [{"type": "paragraph", "text": f"{index}. {step}", "citationIds": ordered[index - 1]["citationIds"] if index <= min(len(ordered), 8) else []} for index, step in enumerate(steps, 1)]
        sections[3]["citationIds"] = list(dict.fromkeys(cid for row in ordered for cid in row["citationIds"]))
    else:
        for section in sections:
            section["blocks"] = [{"type": "paragraph", "text": "Portfolio comparison unavailable.", "citationIds": []}]
    sections[2]["blocks"].append({"type": "table", "title": "All holdings checked", "disclosure": "All holdings checked",
                                  "columns": COLUMNS, "rows": [_table_row(row) for row in holdings]})
    sections[2]["citationIds"] = list(dict.fromkeys([*sections[2]["citationIds"], *(cid for row in holdings for cid in row["citationIds"])]))
    reasons = list(_obj(archive.get("coverage")).get("reasons") or [])
    if not available:
        reasons.append(metrics.get("reasonCode") or "CURRENT_HOLDINGS_UNAVAILABLE")
    if not scan_complete:
        reasons.append("AVAILABLE_SOURCE_ARCHIVE_SCAN_INCOMPLETE")
    complete = available and scan_complete and all(row["currentHoldingVerified"] for row in holdings) and not any(
        row.get("status") in {"failed", "incomplete", "partial", "missing", "rejected"} or row.get("currentStatus") in {"failed", "missing", "late", "indexing"} for row in products)
    return {"version": 1, "templateVersion": TEMPLATE_VERSION, "asOf": as_of, "available": available, "complete": complete,
            "scope": "available-source-archive", "positionCount": len(holdings), "holdings": holdings,
            "productCoverage": products, "archiveManifest": deepcopy(_obj(archive.get("manifest"))),
            "diagnostics": {"reasons": list(dict.fromkeys(reasons)), "unsupportedPositionCount": sum(not row["supported"] for row in holdings),
                            "displayedCounts": displayed_counts if available else {},
                            "unresolvedPositionCount": sum(row["classification"] in {"watch", "unavailable"} for row in holdings)},
            "sections": sections, "citations": list(citations.values())}
