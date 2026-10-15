"""Dated market-structure evidence and its meaning in a manager's review."""

from datetime import date
from hashlib import sha256
import json
import re

from daily_research_rollup import _date, _dict, _number, _text
from market_structure_evidence import verified_metric as _metric
from prediction_review import safe

GAMMA_SOURCE = "https://www.cboe.com/insights/posts/volatility-insights-evaluating-the-market-impact-of-spx-0-dte-options"


def display_date(value):
    day = _date(str(value or "")[:10])
    if not day:
        return "—"
    parsed = date.fromisoformat(day)
    return f"{parsed:%b} {parsed.day}, {parsed.year}"


def num(value):
    number = _number(value)
    return "—" if number is None else f"{number:,.2f}".rstrip("0").rstrip(".")


def context_citation(label, source, as_of, excerpt, uri=None, reading_date=None):
    identity = sha256(json.dumps([label, source, as_of, excerpt], sort_keys=True).encode()).hexdigest()[:32]
    product_label = ("IBKR" if source == "ibkr_historical_bars" else "Dollar context" if source.startswith("Yahoo Finance")
                     else "CFTC" if source == "cftc-public-reporting-environment" else label)
    day = reading_date or str(as_of or "")[:10]
    readable_excerpt = re.sub(r"\b\d{4}-\d{2}-\d{2}\b", lambda match: display_date(match.group()), excerpt)
    return {"id": f"cite_{identity}", "documentId": f"doc_{identity}", "product": label.lower().replace(" ", "-"),
            "productLabel": product_label, "title": f"{label} · {display_date(day)}", "publicationDate": day,
            "sourceUri": uri, "excerpt": readable_excerpt, "source": source, "observedAt": as_of}


def structure_blocks(snapshot, monitor, cid, *, as_of, market_date, market_volume=None):
    from prediction_structure_context import prediction_structure_context

    data = _dict(snapshot.get("data"))
    rows = []
    for signal in data.get("signals") or []:
        if isinstance(signal, dict) and safe(signal) and signal.get("label") and signal.get("value"):
            rows.append({"cells": [_text(signal["label"]), _text(signal["value"]), display_date(snapshot.get("date"))], "citationIds": [cid]})
    throttle = _metric(snapshot, "spxGammaVolatilityThrottle")
    gamma_map = _metric(snapshot, "spxProbableVolatilityGamma")
    for label, value, day in (
        ("Gamma Volatility Throttle", num(throttle.get("gammaThrottle")), throttle.get("date")),
        ("10-day realized volatility · chart", num(throttle.get("tenDayRealizedVolatility")) + "%" if "tenDayRealizedVolatility" in throttle else "—", throttle.get("date")),
        ("SPX zero-gamma level", num(gamma_map.get("zeroGamma")), gamma_map.get("date")),
        ("SPX PV bands · lower / upper", f"{num(gamma_map.get('lowerPvBand'))} / {num(gamma_map.get('upperPvBand'))}", gamma_map.get("date")),
    ):
        rows.append({"cells": [label, value, display_date(day)], "citationIds": [cid] if day else []})
    if gamma_map.get("strikesInPlay"):
        rows.append({"cells": ["SPX strikes in play", ", ".join(num(v) for v in gamma_map["strikesInPlay"]), display_date(gamma_map["date"])], "citationIds": [cid]})
    context = prediction_structure_context(monitor, as_of=as_of, market_date=market_date, market_volume=market_volume)
    context_sources = [context_citation(source["label"], source["source"], source["asOf"], source["excerpt"], reading_date=source.get("date"))
                       for source in context["sources"]]
    context_ids = [source["id"] for source in context_sources]
    rows.extend({"cells": [label, reading, display_date(day)], "citationIds": context_ids if reading != "—" else []}
                for label, reading, day in context["rows"])
    blocks = [{"type": "table", "columns": ["Signal", "Reading", "As of"], "rows": rows}]
    # The summary is rendered with this report's already-validated manager view,
    # so futures prices can never be substituted into cash-index reward/risk.
    blocks.append({"type": "structure-summary", "signals": {row["cells"][0]: row["cells"][1] for row in rows[:len(data.get('signals') or [])]}, "citationIds": [cid]})
    gamma_text = ("Gamma: Positive dealer gamma can dampen price moves as hedges sell rallies and buy declines; "
                  "negative dealer gamma can amplify moves as hedges follow price. "
                  "Gamma describes potential volatility, not a Bullish or Bearish price forecast.")
    gamma_citation = context_citation("Cboe gamma methodology", "Cboe", "2023-09-08", gamma_text, GAMMA_SOURCE)
    blocks.append({"type": "paragraph", "text": gamma_text, "citationIds": [cid, gamma_citation["id"]]})
    if "gammaThrottle" in throttle:
        value = throttle["gammaThrottle"]
        relation = "below" if value < 0 else "above" if value > 0 else "at"
        blocks.append({"type": "paragraph", "text": (
            f"Throttle: {num(value)} is {relation} the zero boundary. More negative readings indicate greater volatility-expansion pressure; "
            "more positive readings indicate greater compression. Watch the distance from zero and changes in realized volatility. "
            "The throttle's zero boundary is an index reading; the SPX zero-gamma row is a separate price level."), "citationIds": [cid]})
    if gamma_map:
        levels = []
        if "zeroGamma" in gamma_map:
            levels.append(f"zero gamma {num(gamma_map['zeroGamma'])}")
        if "lowerPvBand" in gamma_map or "upperPvBand" in gamma_map:
            levels.append(f"PV band {num(gamma_map.get('lowerPvBand'))}–{num(gamma_map.get('upperPvBand'))}")
        blocks.append({"type": "paragraph", "text": "Levels to watch: " + "; ".join(levels) + ". Compare cash SPX with these published levels when judging containment or expansion.", "citationIds": [cid]})
    # Preserve an explicit text/chart disagreement rather than silently changing
    # the source's volatility number. This is source interpretation, not an error.
    body = _text(_dict(snapshot.get("article")).get("bodyText"))
    match = re.search(r"10[-– ]day realized volatility[^.]*?(?:hitting|at|of|is)\s+(\d+\.\d+)", body, re.I)
    chart_vol = throttle.get("tenDayRealizedVolatility")
    if match and chart_vol is not None and abs(float(match[1]) - chart_vol) > .005:
        blocks.append({"type": "paragraph", "text": f"Realized volatility: the dated chart reports {chart_vol:.2f}%; the article text reports {float(match[1]):.2f}%. The two published readings differ.", "citationIds": [cid]})
    blocks.extend({"type": "paragraph", "text": paragraph, "citationIds": context_ids} for paragraph in context["paragraphs"])
    return blocks, [gamma_citation, *context_sources]


def spx_structure_interpretation(view, signals):
    """Combine published structure with independent Trade/Trend and comparable RR."""
    parts = []
    for name, key in (("Trade", "trade"), ("Trend", "trend")):
        direction = _dict(view.get(key)).get("direction")
        if direction in {"BULLISH", "BEARISH", "NEUTRAL"}:
            parts.append(f"S&P 500 {name} is {direction.title()}")
    context = [f"{label.lower()} is {signals[label]}" for label in ("Systematic Flow Risk", "PV Band Risk/Reward", "Strategic Allocation") if signals.get(label)]
    lines = ["S&P 500 context: " + "; ".join([*parts, *context]) + "."] if parts or context else []
    chosen = _dict(view.get("trade")) or _dict(view.get("trend"))
    direction = chosen.get("direction")
    allocation = str(signals.get("Strategic Allocation") or "").lower()
    if direction in {"BULLISH", "BEARISH"} and allocation in {"risk on", "risk off"}:
        aligned = (direction == "BULLISH") == (allocation == "risk on")
        stance = "supports" if aligned else "opposes"
        horizon = "Trade" if view.get("trade") else "Trend"
        lines[0] += f" Allocation {stance} the {direction.title()} {horizon} bias."
        if all(str(signals.get(label) or "").lower() == "neutral" for label in ("Systematic Flow Risk", "PV Band Risk/Reward")):
            lines[0] += " Flow and PV bands provide no additional directional confirmation."
    risk_range = _dict(view.get("riskRange"))
    if risk_range and risk_range.get("low") is not None and risk_range.get("high") is not None:
        line = f"Risk Range: {risk_range.get('instrument') or 'SPX'} {num(risk_range['low'])}–{num(risk_range['high'])} ({display_date(risk_range.get('publishedAt'))})."
        rr = _dict(risk_range.get("rewardRisk"))
        if rr.get("ratio") is not None:
            line += f" From {rr.get('basisLabel') or 'SPX'} {num(rr.get('referenceValue'))}, {str(rr.get('direction') or '').title()} reward/risk is {num(rr['ratio'])}:1: {num(rr.get('reward'))} points of reward versus {num(rr.get('risk'))} points of risk."
        else:
            underlying = _dict(view.get("underlying"))
            if underlying.get("label") and underlying.get("value") is not None and underlying['label'] != risk_range.get('instrument'):
                line += f" The quoted {underlying['label']} level {num(underlying['value'])} is the contract reference. {risk_range.get('instrument') or 'SPX'} is the basis for this range; comparable reward/risk —."
        line += " Read the published PV-band stance alongside this range and the gamma regime when assessing an extension or reversal."
        lines.append(line)
    return lines
