"""Source-bound position confirmations and contradictions for captured reviews.

This is a pure presentation projection. Callers supply the verified holdings
captured with a review; no current holdings, prices or publications are fetched.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
import math
import re
from zoneinfo import ZoneInfo

from daily_research_rollup import accepted_snapshots, _article_sections, _citation, _paragraphs, _symbol, PRODUCTS, SIDE_LINE, WRAPPER, _heading
from hedgai_review import portfolio_tick_readings
from portfolio_review import _typed_reference_citation, _trade_instrument_aliases, stated_trade_values


NY = ZoneInfo("America/New_York")
COLUMNS = ["Ticker", "Security", "Position", "Product", "Reading", "Why"]
DIRECTIONS = {"BULLISH": "Bullish", "BEARISH": "Bearish", "NEUTRAL": "Neutral"}
TREND_KINDS = {"primary_risk_range", "historical_risk_range", "supplemental_risk_range", "trend_signal"}
TRADE_KINDS = {"trade_signal", "tracker_trade"}
BAD_FLAGS = ("mock", "isMock", "seed", "seeded", "synthetic", "inferred")
ACTION_KINDS = {"real_time_alert", "etf_pro_change", "position_change", "source_action"}
DIRECT = {"direct", "direct_alias"}


def _obj(value):
    return value if isinstance(value, dict) else {}


def _number(value):
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def _text(value):
    return " ".join(value.split()) if isinstance(value, str) else ""


def _time(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.astimezone(timezone.utc) if parsed.tzinfo else None
    except (ValueError, TypeError):
        return None


def _dated(value, cutoff):
    if not cutoff:
        return False
    if isinstance(value, str) and len(value) == 10:
        try:
            day = datetime.strptime(value, "%Y-%m-%d").date()
            return day.isoformat() == value and day <= cutoff.astimezone(NY).date()
        except ValueError:
            return False
    published = _time(value)
    return bool(published and published <= cutoff)


def _date_label(value):
    instant = _time(value)
    try:
        day = instant.astimezone(NY) if instant else datetime.strptime(str(value)[:10], "%Y-%m-%d")
        return f"{day:%b} {day.day}, {day.year}"
    except (ValueError, TypeError):
        return "—"


def _safe(value):
    return isinstance(value, dict) and not any(value.get(flag) is True for flag in BAD_FLAGS) and value.get("verified") is not False


def _reference_date(reference):
    published = _time(reference.get("publishedAt"))
    # The ledger uses UTC midnight as an import placeholder for date-only
    # publications. Never shift that original market date to the prior ET day.
    if published and (published.hour or published.minute or published.second):
        return reference["publishedAt"]
    return reference.get("marketDate") or reference.get("publishedAt")


def _bias(value):
    value = str(value or "").upper()
    value = {"LONG": "BULLISH", "SHORT": "BEARISH", "FLAT": "NEUTRAL"}.get(value, value)
    return value if value in DIRECTIONS else None


def _aligned(side, direction):
    return (side == "LONG" and direction == "BULLISH") or (side == "SHORT" and direction == "BEARISH")


def _reference_source(reference, cutoff):
    if (not _safe(reference) or reference.get("qualityStatus") not in {"indexed", "validated"}
            or not _dated(_reference_date(reference), cutoff)
            or not (reference.get("sourceUrl") or reference.get("sourceEventId"))):
        return None
    citation = _typed_reference_citation(reference)
    if citation:
        citation["productLabel"] = reference.get("productLabel") or PRODUCTS.get(reference.get("productId")) or str(reference.get("productId") or "").replace("-", " ").title()
        if _time(_reference_date(reference)):
            citation["publishedAt"] = _reference_date(reference)
    return citation


def _trade_direction(reference):
    proof = _obj(reference.get("signalProvenance"))
    if (proof.get("field") != "trade" or proof.get("method") not in {"explicit-field", "explicit-statement"}
            or not _text(proof.get("sourceField")) or not _text(proof.get("sourceText"))):
        return None
    statement = proof["sourceText"]
    if proof["method"] == "explicit-field":
        if not re.search(r"(?:^|\.)(?:trade|tradeSignal|tradeBias)$", proof["sourceField"], re.I):
            return None
    elif stated_trade_values(statement) != {_bias(reference.get("value") or reference.get("direction"))}:
        return None
    return _bias(reference.get("value") or reference.get("direction"))


def _relation(reference, symbol):
    """An inferred exposure match is never enough to create a position reading."""
    match = reference.get("matchType")
    source = _text(reference.get("sourceTicker") or reference.get("matchedText") or symbol).upper()
    if match in DIRECT:
        aliases = _trade_instrument_aliases()
        field_source = re.search(r"(?:^|\.)data\.([A-Z][A-Z0-9.^-]{0,12})(?:\.|$)", str(reference.get("fieldPath") or ""))
        claimed = [reference.get("sourceTicker"), reference.get("matchedText"), field_source[1] if field_source else None]
        for candidate in claimed:
            if candidate and re.fullmatch(r"\^?[A-Z][A-Z0-9.^-]{0,12}", str(candidate)) and aliases.get(candidate, candidate) != aliases.get(symbol, symbol):
                return None, None
        return "direct", source
    mapping = _obj(reference.get("instrumentMapping"))
    if (match == "proxy" and mapping.get("verified") is True and mapping.get("heldTicker") == symbol
            and mapping.get("sourceTicker") == source and mapping.get("relationship") == "proxy"
            and mapping.get("sourceUrl")):
        return "proxy", source
    return None, None


def _signal_candidates(security, symbol, cutoff):
    references = [*_obj(security).get("directReferences", [])]
    for history in security.get("history") or []:
        references.extend(_obj(history).get("directReferences") or [])
    # Only explicit, verified proxy mappings are considered; inferredReferences
    # from theme/sector memberships are deliberately not read here.
    references.extend(security.get("proxyReferences") or [])
    grouped = {}
    for reference in references:
        if not isinstance(reference, dict):
            continue
        field = "trade" if reference.get("kind") in TRADE_KINDS else "trend" if reference.get("kind") in TREND_KINDS else None
        relation, source_ticker = _relation(reference, symbol)
        citation = _reference_source(reference, cutoff)
        if not field or not relation or not citation:
            continue
        value = reference.get("value")
        direction = _trade_direction(reference) if field == "trade" else _bias(_obj(value).get("trend") if isinstance(value, dict) else value) or _bias(reference.get("direction"))
        if not direction:
            continue
        key = (reference.get("productId"), field, relation, source_ticker)
        grouped.setdefault(key, []).append({"reference": reference, "citation": citation, "value": direction,
                                           "date": _reference_date(reference)})
    output = []
    for (product, field, relation, source_ticker), records in grouped.items():
        by_date = {}
        for record in records:
            by_date.setdefault(str(record["date"]), []).append(record)
        ordered = sorted(by_date)
        newest = by_date[ordered[-1]]
        if len({item["value"] for item in newest}) != 1:
            continue
        current = sorted(newest, key=lambda item: item["citation"]["id"])[0]
        first, prior = current, None
        for day in reversed(ordered[:-1]):
            older = by_date[day]
            if len({item["value"] for item in older}) != 1:
                break
            item = sorted(older, key=lambda entry: entry["citation"]["id"])[0]
            if item["value"] == current["value"]:
                first = item
            else:
                prior = item
                break
        # Repeated confirmations retain the first evidenced transition date.
        reading = f"{DIRECTIONS[prior['value']]} → {DIRECTIONS[current['value']]} {field.title()}" if prior else f"{DIRECTIONS[current['value']]} {field.title()}"
        citations = [current["citation"], first["citation"], *([prior["citation"]] if prior else [])]
        descriptor = _obj(_obj(security.get("decision")).get(field))
        current_rule = (relation == "direct" and descriptor.get("status") == "available"
                        and _bias(descriptor.get("value")) == current["value"] and descriptor.get("sourceId") == product
                        and str(current["reference"].get("marketDate")) == cutoff.astimezone(NY).date().isoformat()
                        and not any(descriptor.get(flag) is True for flag in ("stale", "cacheOnly", "offline", "disconnected", "mock", "seeded")))
        output.append({"kind": field, "direction": current["value"], "reading": reading,
                       "date": first["date"] if prior else current["date"], "lastConfirmedAt": current["date"],
                       "product": product, "productLabel": current["citation"].get("productLabel") or product,
                       "citations": citations, "currentRule": current_rule, "relation": relation,
                       "sourceTicker": source_ticker, "transition": bool(prior),
                       "sourceText": current["reference"].get("excerpt") or _obj(current["reference"].get("signalProvenance")).get("sourceText") or reading})
    return output


def _explicit_comment(text, symbol):
    """Require the named security and affirmative action in the same clause."""
    text = _text(text)
    if not text or len(text) > 1100:
        return None
    # An explicit partial sale often includes 'not an exit'; preserve that
    # qualifier without accepting other negations or contingent coaching.
    checked = re.sub(r"\b(?:this is )?not an exit\b", "", text, flags=re.I)
    if re.search(r"\b(?:if|unless|could|would|might|maybe|previously|historically|used to|not|never|avoid|don['’]t|will)\b|\?", checked, re.I):
        return None
    ticker = r"(?<![A-Za-z0-9.])\$?" + re.escape(symbol) + r"(?![A-Za-z0-9]|\.[A-Za-z0-9])"
    matches = list(re.finditer(ticker, text))
    hit = next((match for match in matches if text[max(0, match.start() - 1):match.start()] == "("), matches[0] if matches else None)
    if not hit:
        return None
    roster = re.fullmatch(r"\s*(ADD|REMOVE)\s+" + ticker + r"\s*[—–-]\s*(Long|Short)(?:\s*[—–-].*)?", text, re.I)
    if roster:
        action, side = roster[1].upper(), roster[2].lower()
        effect = ("bullish" if side == "long" else "bearish") if action == "ADD" else f"remove-{side}"
        return {"reading": f"{'Added' if action == 'ADD' else 'Removed'} source {side.title()}", "effect": effect, "sourceText": text}
    before, after = text[:hit.start()], text[hit.end():]
    # Subject-led commentary or an immediately preceding action. Stop the
    # subject clause at a second explicit ticker rather than borrowing its view.
    other_ticker = re.search(r"\$[A-Z][A-Z0-9.]{0,8}\b|\b[A-Z]{2,6}(?:\.[A-Z]{1,3})?\b", after)
    if other_ticker and other_ticker.group().lstrip("$") not in {"LONG", "SHORT", "BUY", "SELL", "SOME", "BULLISH", "BEARISH", "TREND", "TRADE", "ETF"}:
        after = after[:other_ticker.start()]
    suffix = re.sub(r"\b(?:short|long)(?:er)?[\s-]+(?:term|run)\b", "horizon", after[:180], flags=re.I).lstrip(" )\t:—–-")
    prefix = re.sub(r"\b(?:short|long)(?:er)?[\s-]+(?:term|run)\b", "horizon", before[-80:], flags=re.I)
    subject = not before.strip(" •*-0123456789.)\t") or re.fullmatch(r"[A-Za-z &'’().-]{0,80}\(", before.strip())
    def action(pattern):
        return bool((subject and re.match(r"(?:we\s+(?:are\s+)?)?" + pattern, suffix, re.I))
                    or re.search(r"(?:^|[—–:;.!-]\s*)(?:we\s+(?:are\s+)?)?" + pattern + r"(?:\s+(?:in|of|on|to|some|more))*\s*$", prefix.rstrip(), re.I))
    for pattern, label, effect in (
        (r"\b(?:sell(?:ing)?[\s-]+some|trim(?:ming)?(?:\s+(?:some|the|our))?(?:\s+(?:long\s+)?position)?|reduc(?:e|ing)\s+(?:(?:the|our)\s+)?(?:long\s+)?(?:position|shares|exposure))\b(?!\s+costs\b)", "Sell some", "reduce-long"),
        (r"\bcover(?:ing)?[\s-]+some\b", "Cover some", "reduce-short"),
        (r"\b(?:sell(?:ing)?[\s-]+all|exit(?:ing)?(?: the)?(?: long)?(?: position)?)\b", "Exit Long", "exit-long"),
        (r"\bsell(?:ing)?\b", "Sell", "sell-long"),
        (r"\bcover(?:ing)?[\s-]+all\b", "Cover all", "exit-short"),
        (r"\bcover(?:ing)?(?: the)?(?: short)?(?: position)?\b", "Cover", "cover-short"),
        (r"\b(?:(?:(?:is|remains|stays|has turned)\s+)?(?:short|bearish)(?=$|[.,;:]|\s+(?:on|into|after|ahead|as|despite|because|with|at|in|for|and)\b)|shorting\b|maintain(?:ing)? (?:the )?short\b)", "Bearish commentary", "bearish"),
        (r"\b(?:(?:(?:is|remains|still|looks like)\s+)?(?:(?:a|an)\s+)?(?:(?:good|great|attractive|compelling)\s+)?buying opportunity\b|buy(?:ing)?(?=$|\s+(?:some|more|on|into|after)\b)|(?:(?:is|remains|stays|has turned)\s+)?(?:long|bullish)(?=$|[.,;:]|\s+(?:on|into|after|ahead|as|despite|because|with|at|in|for|and)\b)|maintain(?:ing)? (?:the )?long\b|add(?:ing)?(?: to)?(?: the)? long\b)", "Buying opportunity / Long support", "bullish"),
    ):
        if action(pattern):
            return {"reading": label, "effect": effect, "sourceText": text}
    return None


def _bounded_positions(snapshot):
    """Read explicit source sides, including multi-ticker parenthesized items."""
    groups, active = {"Long": [], "Short": [], "Neutral": []}, None
    body = _obj(snapshot.get("article")).get("bodyText") or ""
    for raw in body.splitlines():
        line = raw.strip()
        labeled = SIDE_LINE.match(line)
        if labeled:
            label, values = labeled.groups()
            active = "Long" if label.upper() in {"LONG", "LONGS", "BULLISH"} else "Short" if label.upper() in {"SHORT", "SHORTS", "BEARISH"} else "Neutral"
        elif not line:
            continue
        elif active and not WRAPPER.search(line) and not _heading(line):
            values = line
        else:
            active = None
            continue
        for item in re.split(r",\s*(?![^()]*\))", values):
            item = item.strip(" •$")
            named = re.fullmatch(r"([^:;\n]+?)\s*\(([A-Z0-9][A-Z0-9./^, -]*)\)", item)
            if named:
                symbols = [symbol.strip() for symbol in named[2].split(",")]
                if not all(re.fullmatch(r"[A-Z][A-Z0-9./^-]{0,19}", symbol) for symbol in symbols):
                    active = None
                    break
                groups[active].extend(f"{named[1].strip()} ({symbol})" for symbol in symbols)
            elif re.fullmatch(r"[A-Z][A-Z0-9./^-]{0,19}", item):
                groups[active].append(item)
            elif item:
                active = None
                break
    sides = {}
    for side, items in groups.items():
        for item in items:
            sides.setdefault(_symbol(item), set()).add(side)
    return {side: [item for item in items if len(sides[_symbol(item)]) == 1] for side, items in groups.items()}


def _prepare_commentary(snapshots):
    """Parse each immutable publication once for this projection only."""
    publications = []
    for product, snapshot in snapshots.items():
        if product not in {"the-call", "the-macro-show", "early-look", "top-3-things"}:
            continue
        citation = _citation(snapshot, product)
        positions = {}
        if product in {"the-call", "the-macro-show"}:
            for side, names in _bounded_positions(snapshot).items():
                if side not in {"Long", "Short"}:
                    continue
                for name in names:
                    positions.setdefault(_symbol(name), (side, name))
        statements = []
        for heading, section in _article_sections(snapshot):
            if heading.lower() in {"hedgeye positions", "tldr - positions mentioned", "tl;dr - positions mentioned"}:
                continue
            for paragraph in _paragraphs(section):
                statements.extend(re.split(r"\n|(?<=[.!?])\s+(?=[A-Z$])", paragraph))
        publications.append({"product": product, "citation": citation, "positions": positions, "statements": statements})
    return publications


def _comment_candidates(symbol, security, publications, cutoff):
    output = []
    for publication in publications:
        citation, product = publication["citation"], publication["product"]
        common = {"date": citation.get("publishedAt") or citation["publicationDate"],
                  "product": product, "productLabel": citation["productLabel"], "citations": [citation],
                  "relation": "direct", "sourceTicker": symbol, "currentRule": False}
        position = publication["positions"].get(symbol)
        if position:
            side, name = position
            output.append({**common, "kind": "source-position", "direction": "BULLISH" if side == "Long" else "BEARISH",
                           "reading": f"Source {side} position", "sourceText": name})
        for statement in publication["statements"]:
            # The subject parser requires this exact source ticker too. This
            # cheap absence check avoids building its regex for unrelated rows.
            if symbol not in statement:
                continue
            comment = _explicit_comment(statement, symbol)
            if comment:
                output.append({**comment, **common, "kind": "commentary"})
    for reference in security.get("directReferences") or []:
        if not isinstance(reference, dict) or reference.get("kind") not in ACTION_KINDS:
            continue
        relation, source_ticker = _relation(reference, symbol)
        citation = _reference_source(reference, cutoff)
        if not citation or relation != "direct":
            continue
        excerpt = reference.get("excerpt") or ""
        try:
            parsed = json.loads(excerpt)
            if isinstance(parsed, dict) and str(parsed.get("ticker") or parsed.get("symbol") or "").upper() == symbol:
                excerpt = parsed.get("signalPhrase") or parsed.get("headline") or ""
        except (ValueError, TypeError):
            pass
        comment = _explicit_comment(excerpt, symbol)
        if comment:
            output.append({**comment, "kind": "action", "date": _reference_date(reference),
                "product": reference["productId"], "productLabel": citation["productLabel"], "citations": [citation],
                "relation": relation, "sourceTicker": source_ticker, "currentRule": False})
    return output


def _classify(evidence, side, aligned_trade):
    direction = evidence.get("direction")
    effect = evidence.get("effect")
    if effect in {"remove-long", "remove-short"}:
        removed = "LONG" if effect == "remove-long" else "SHORT"
        return ("contradiction", f"Removed from the publisher's {removed.title()} roster; review the holding against the dated source.") if side == removed else (None, None)
    if effect in {"reduce-long", "sell-long", "exit-long"}:
        why = {"reduce-long": "The source calls for a partial Long reduction.", "sell-long": "The source reports a Sell against the held Long position.", "exit-long": "The source explicitly exits its Long position."}[effect]
        return ("contradiction", why) if side == "LONG" else (None, None)
    if effect in {"reduce-short", "cover-short", "exit-short"}:
        why = {"reduce-short": "The source calls for a partial Short cover.", "cover-short": "The source reports a Cover against the held Short position.", "exit-short": "The source explicitly covers all of its Short position."}[effect]
        return ("contradiction", why) if side == "SHORT" else (None, None)
    direction = direction or {"bullish": "BULLISH", "bearish": "BEARISH"}.get(effect)
    if direction not in {"BULLISH", "BEARISH"}:
        return None, None
    aligned = _aligned(side, direction)
    kind = evidence["kind"]
    if kind == "action":
        # Indexed action excerpts may be clipped chunks of an email, including
        # headers and a partial paragraph. Keep those exact bytes in evidence;
        # the table explains only the independently parsed action and its effect.
        action = evidence["reading"] if evidence["reading"].startswith("Added source ") else (
            "Buy" if effect == "bullish" and re.search(r"\bbuy(?:ing)?\b", _text(evidence.get("sourceText")), re.I)
            else "Long" if direction == "BULLISH" else "Short")
        return ("confirmation" if aligned else "contradiction",
                f"Published {action} action {'supports' if aligned else 'opposes'} the held {side.title()} position.")
    if aligned:
        why = "Explicit commentary supports the held direction." if kind in {"commentary", "action"} else f"Published {kind.title()} supports the held direction."
        if kind == "tick":
            why = "Qualifying HedgAI signal supports the position on the shortest research horizon."
        if kind == "source-position":
            why = "The publisher's stated position matches the held direction."
        if kind == "commentary" and evidence.get("sourceText"):
            source_text = _text(evidence["sourceText"])
            why = f"{source_text[:220].rstrip()}{'…' if len(source_text) > 220 else ''} Supports the held {side.title()} direction."
        return "confirmation", why
    if evidence.get("relation") == "proxy":
        return "contradiction", f"{evidence['sourceTicker']} is a proxy reference; its {kind.title()} opposes the held direction. Review the relationship."
    if kind == "trade" and evidence.get("currentRule"):
        return "contradiction", "Trade opposes the held direction; the portfolio rule calls for exit."
    if kind == "trend" and evidence.get("currentRule") and aligned_trade:
        return "contradiction", "Trend opposes the position while Trade remains aligned; the portfolio rule caps the position at MIN."
    if kind == "tick":
        return "contradiction", "Qualifying HedgAI signal opposes the position on the shortest horizon; review alongside Trade and Trend."
    if kind == "source-position":
        return "contradiction", "The publisher's stated position opposes the held direction."
    if kind in {"trade", "trend"}:
        return "contradiction", f"Published {kind.title()} opposes the held direction; review the dated evidence with the latest Trade."
    source_text = _text(evidence.get("sourceText"))
    why = f"{source_text[:220].rstrip()}{'…' if len(source_text) > 220 else ''} Opposes the held {side.title()} direction." if source_text else "Explicit source commentary opposes the held direction."
    return "contradiction", why


def _holding_valid(holding):
    if (not _safe(holding) or holding.get("heldSide") not in {"LONG", "SHORT"}
            or not _text(holding.get("holding"))
            or any(holding.get(flag) is True for flag in ("stale", "cacheOnly", "offline", "disconnected"))
            or str(holding.get("category") or holding.get("secType") or "").lower() in {"option", "options", "opt", "fop", "future_option", "event_contract"}):
        return False
    quantity = _number(holding.get("quantity"))
    return quantity is None or (quantity != 0 and (quantity > 0) == (holding["heldSide"] == "LONG"))


def build_position_alignment_sections(holdings, intelligence, daily_research, *, as_of=None):
    """Return (two ordered sections, citations), without mutating input evidence.

    ``None`` holdings means unavailable; an empty list means a verified empty
    book. Holdings are the output of ``rule_holdings`` at this review's capture.
    """
    cutoff = _time(as_of)
    sections = [{"id": "position-confirmations", "title": "Position confirmations", "blocks": [], "citationIds": []},
                {"id": "position-contradictions", "title": "Position contradictions", "blocks": [], "citationIds": []}]
    if holdings is None or not cutoff:
        for section in sections:
            section["blocks"] = [{"type": "paragraph", "text": "Position comparison unavailable.", "citationIds": []}]
        return sections, []
    snapshots = accepted_snapshots(_obj(daily_research), as_of=cutoff)
    commentary = _prepare_commentary(snapshots)
    tick_readings, tick_citations = portfolio_tick_readings(_obj(daily_research).get("hedgai"), as_of=as_of)
    tick_sources = {citation["id"]: citation for citation in tick_citations}
    rows = {"confirmation": [], "contradiction": []}
    all_citations = {}
    for holding in holdings:
        if not _holding_valid(holding):
            continue
        symbol, side = holding["holding"].upper(), holding["heldSide"]
        security = _obj(_obj(_obj(intelligence).get("bySymbol")).get(symbol))
        candidates = _signal_candidates(security, symbol, cutoff)
        candidates += _comment_candidates(symbol, security, commentary, cutoff)
        tick = tick_readings.get(symbol)
        if tick and tick.get("qualified") is True and tick.get("status") == "published" and tick.get("value") in {"BULLISH", "BEARISH"}:
            candidates.append({"kind": "tick", "direction": tick["value"], "reading": f"{DIRECTIONS[tick['value']]} HedgAI",
                "date": tick["publishedAt"], "product": "hedgai-signals", "productLabel": "HedgAI Signals",
                "citations": [tick_sources[cid] for cid in tick["citationIds"] if cid in tick_sources],
                "currentRule": False, "relation": "direct", "sourceTicker": symbol,
                "sourceText": f"{tick['sourceLabel']}: {tick['contribution']}; initiated {tick.get('initiatedAt') or '—'}; metrics {tick['metricsDate']}"})
        aligned_trade = any(item["kind"] == "trade" and item.get("currentRule") and _aligned(side, item.get("direction")) for item in candidates)
        classified, seen = [], set()
        for candidate in candidates:
            category, why = _classify(candidate, side, aligned_trade)
            key = (candidate["product"], candidate["kind"], candidate["reading"], candidate["date"])
            if not category or key in seen:
                continue
            seen.add(key)
            classified.append({**candidate, "category": category, "why": why})
        if not classified:
            continue
        category = "contradiction" if any(item["category"] == "contradiction" for item in classified) else "confirmation"
        selected = [item for item in classified if item["category"] == category]
        # One held position appears in one section. All supportive and opposing
        # evidence remains available from its linked product/evidence cell.
        selected.sort(key=lambda item: (0 if item["kind"] == "trade" and item.get("currentRule") else 1 if item["kind"] == "trend" and item.get("currentRule") else 2 if item["kind"] == "action" else 3 if item["kind"] == "commentary" else 4, str(item["date"])), reverse=False)
        primary = selected[0]
        citations = {citation["id"]: citation for item in classified for citation in item["citations"] if citation and citation.get("id")}
        all_citations.update(citations)
        ids = list(citations)
        weight = _number(holding.get("weightPct"))
        position = f"{side.title()} · {weight:.2f}%" if weight is not None and weight >= 0 else f"{side.title()} · —"
        name = next((_text(holding.get(key)) for key in ("securityName", "longName", "companyName", "name") if _text(holding.get(key))), "—")
        relationship = f" · {primary['sourceTicker']} proxy" if primary.get("relation") == "proxy" else ""
        reading = f"{primary['reading']}{relationship} · {_date_label(primary['date'])}"
        products = list(dict.fromkeys(item["productLabel"] for item in selected))
        detail = "\n".join(f"{item['productLabel']} · {_date_label(item['date'])}: {item['reading']}\n{item.get('sourceText') or ''}" for item in classified)
        cells = [symbol, name, position, ", ".join(products), reading, primary["why"]]
        row = {"cells": cells, "citationIds": ids, "cellCitationIds": [[], [], [], ids, ids, ids],
               "cellTitles": [symbol, name, "Captured position and portfolio weight", ", ".join(dict.fromkeys(item["productLabel"] for item in classified)), detail, primary["why"]],
               "evidenceTexts": list(dict.fromkeys(_text(item.get("sourceText")) for item in classified if _text(item.get("sourceText")))),
               "holding": symbol, "heldSide": side, "weightPct": weight, "classification": category,
               "publishedAt": primary["date"], "relationship": primary.get("relation"),
               "evidence": deepcopy(classified)}
        rows[category].append(row)
    for section, category in zip(sections, ("confirmation", "contradiction")):
        matched = sorted(rows[category], key=lambda row: (-(row["weightPct"] or 0), row["holding"]))
        section["citationIds"] = list(dict.fromkeys(cid for row in matched for cid in row["citationIds"]))
        section["blocks"] = [{"type": "table", "columns": COLUMNS, "rows": matched}] if matched else [
            {"type": "paragraph", "text": f"No evidenced position {category}s in this capture.", "citationIds": []}]
    return sections, list(all_citations.values())
