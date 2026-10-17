"""Render the Predictive Markets Review setup board captured from Express."""

from __future__ import annotations

import json
import math
import re
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
MONTH_CODES = {code.upper(): index for index, code in enumerate(MONTHS, 1)}
DIRECTION = {"BULLISH": "Bullish", "BEARISH": "Bearish", "NEUTRAL": "Neutral"}
DASH = "—"
NA = "N/A"
PACIFIC = ZoneInfo("America/Los_Angeles")
DEFAULT_SECTIONS = ({"id": "metals", "label": "Metals"}, {"id": "crypto", "label": "Crypto"}, {"id": "oil", "label": "Oil"},
                    {"id": "indices", "label": "Indices"}, {"id": "rates", "label": "Rates"}, {"id": "inflation", "label": "CPI"})
# Captures before the sectioned board grouped WTI as energy.
GROUP_ALIASES = {"energy": "oil"}


def _number(value: Any, *, percent: bool = False) -> str:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return DASH
    if percent:
        return f"{value:.2f}%"
    if abs(value) >= 1000:
        return f"{value:,.0f}"
    return f"{value:,.3f}".rstrip("0").rstrip(".") if abs(value) < 1 else f"{value:,.2f}".rstrip("0").rstrip(".")


def _short_date(value: Any) -> str:
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})", str(value or ""))
    return f"{MONTHS[int(match[2]) - 1]} {int(match[3])}" if match else DASH


def _event_label(event: dict[str, Any]) -> str:
    ticker = str((event or {}).get("eventTicker") or "")
    match = re.search(r"-\d{2}([A-Z]{3})(\d{2})?(?:H?(\d{2})(\d{2})?)?(H|L)?$", ticker)
    if not match or match[1] not in MONTH_CODES:
        return DASH
    month = MONTHS[MONTH_CODES[match[1]] - 1]
    if match[5]:
        return f"{month} {'max' if match[5] == 'H' else 'min'}"
    if not match[2]:
        return month
    day = f"{month} {int(match[2])}"
    hour = int(match[3]) if match[3] else None
    if hour == 16 and match[4] == "00":
        return f"{day} close"
    if hour is not None and match[4] is None:
        return f"{day} {hour - 12 if hour > 12 else hour}{'pm' if hour >= 12 else 'am'}"
    return day


def _contract(row: dict[str, Any]) -> str:
    labels = [_event_label(event) for event in row.get("events") or []]
    if row.get("id") == "wti":
        # WTI settles on the day's futures settlement; its ticker hour is not an observation time.
        labels = [re.sub(r" \d{1,2}(?:am|pm)$", "", label) for label in labels]
    labels = [label for label in labels if label != DASH]
    if len(labels) == 2 and labels[0].endswith(" max") and labels[1].endswith(" min"):
        return labels[0][:-4] + " max/min"
    return " · ".join(labels) or DASH


def _pacific(value: Any) -> str:
    """Compact 24-hour Pacific observation time, e.g. Oct 12 07:06."""
    text = str(value or "")
    # Date-only publications (e.g. Treasury daily yields) arrive as UTC midnight; keep their own date.
    if not re.match(r"^\d{4}-\d{2}-\d{2}T", text) or re.search(r"T00:00:00(?:\.0+)?(?:Z|\+00:00)$", text):
        return _short_date(text)
    try:
        moment = datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(PACIFIC)
    except ValueError:
        return DASH
    return f"{MONTHS[moment.month - 1]} {moment.day} {moment:%H:%M}"


def _pacific_zoned(value: Any) -> str:
    """Publication time as the Sources table shows it, e.g. Oct 15 04:37 PDT; date-only stays a date."""
    text = _pacific(value)
    if not re.search(r"\d{2}:\d{2}$", text):
        return text
    moment = datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(PACIFIC)
    return f"{text} {moment.tzname()}"


def _signal(reading: dict[str, Any] | None) -> str:
    if not reading:
        return DASH
    # Tick, Trade and Trend share one vocabulary: Bullish, Bearish or Neutral.
    text = DIRECTION.get(reading.get("direction"), DASH)
    date = _short_date(reading.get("date"))
    return f"{text} {date}" if date != DASH and text != DASH else text


def _setup(row: dict[str, Any]) -> str:
    setup = row.get("setup") or {}
    reason = setup.get("reason")
    return ({"LONG": "Long", "SHORT": "Short"}.get(setup.get("side"))
            or (reason if reason in {"Below range", "Above range", "Blocked by Trade"} else DASH))


def _cell(value: Any) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")


def _table(columns: list[str], rows: list[list[str]]) -> list[str]:
    return ["| " + " | ".join(columns) + " |", "| " + " | ".join("---" for _ in columns) + " |",
            *("| " + " | ".join(_cell(value) for value in row) + " |" for row in rows), ""]


def _older_note(value: Any, board_as_of: Any) -> str | None:
    """'Oct 9 close' when a reading is from an earlier day than the review."""
    observed = _pacific(value)
    if observed == DASH or observed.startswith(_pacific(board_as_of).rsplit(" ", 1)[0] + " "):
        return None
    return f"{observed.rsplit(' ', 1)[0] if ':' in observed else observed} close"


def _range_text(reading: dict[str, Any]) -> str | None:
    low, high = reading.get("low"), reading.get("high")
    return f"{_number(low)}–{_number(high)}" if isinstance(low, (int, float)) and isinstance(high, (int, float)) else None


def _implied_move(gauge: dict[str, Any], row: dict[str, Any] | None) -> str | None:
    """One-day move implied by an annualized volatility index: level / sqrt(252)."""
    level = gauge.get("value")
    if not isinstance(level, (int, float)):
        return None
    daily = level / math.sqrt(252)
    if gauge.get("symbol") == "MOVE":
        return f"±{daily:.1f} bp"
    price = ((row or {}).get("price") or {}).get("value")
    if not isinstance(price, (int, float)):
        return f"±{daily:.1f}%"
    move = price * daily / 100
    return f"±{daily:.1f}% · ±{move:,.0f}" if move >= 10 else f"±{daily:.1f}% · ±{move:.2f}"


def _driver_block(board: dict[str, Any], members: list[dict[str, Any]], section_label: str) -> dict[str, Any]:
    """Section-wide tables above the market table: volatility, then correlation with the US Dollar."""
    as_of = board.get("asOf")
    gauges = {}
    for row in members:
        gauge = row.get("volatility") or {}
        if not gauge.get("symbol"):
            continue
        entry = gauges.setdefault(gauge["symbol"], [gauge, []])
        if not isinstance(entry[0].get("value"), (int, float)) and isinstance(gauge.get("value"), (int, float)):
            entry[0] = gauge
        entry[1].append(row)
    # Each configured gauge keeps its row in market order; one without a reading reads N/A.
    volatility = [{"symbol": symbol, "market": rows[0].get("label") if len(rows) == 1 else section_label,
                   "level": f"{gauge['value']:.2f}", "d1": gauge.get("changePct"), "d15": gauge.get("d15"), "m1": gauge.get("m1"),
                   "regimeKey": gauge.get("regimeKey"), "regimeValue": gauge["value"],
                   "signal": DIRECTION.get(gauge.get("trend")), "range": _range_text(gauge),
                   "implied": _implied_move(gauge, rows[0] if len(rows) == 1 else None),
                   "note": _older_note(gauge.get("asOf"), as_of)}
                  if isinstance(gauge.get("value"), (int, float))
                  else {"symbol": symbol, "market": rows[0].get("label") if len(rows) == 1 else section_label,
                        "level": NA, "note": "Unavailable"}
                  for symbol, (gauge, rows) in gauges.items()]
    fmt = lambda value: f"{value:+.2f}" if isinstance(value, (int, float)) else NA
    correlations, dates = [], set()
    for row in members:
        corr = row.get("usdCorrelation") or {}
        if any(isinstance(corr.get(key), (int, float)) for key in ("d15", "d30", "d60", "d90")):
            correlations.append({"market": row.get("label"), "d15": fmt(corr.get("d15")), "d30": fmt(corr.get("d30")),
                                 "d60": fmt(corr.get("d60")), "d90": fmt(corr.get("d90"))})
            dates.add(_short_date(corr.get("calculationDate")))
    clean = lambda item: {key: value for key, value in item.items() if value not in (None, "")}
    block = {"volatility": [clean(item) for item in volatility]}
    if correlations:
        block["correlations"] = {"rows": correlations,
                                 **({"asOf": f"{dates.pop()} close"} if len(dates) == 1 and DASH not in dates else {})}
    return block


def _bias_cell(direction: Any) -> str:
    """Token for a bias word; its publication date and product appear in the As of cell."""
    return f"BIAS({DIRECTION.get(direction) or NA};;)"


def _as_of_cell(observed: Any, readings: list[tuple[Any, Any]]) -> str:
    """Token the report UI stacks as pull time, then Tick/Trade/Trend publication date and product.

    ASOF(pulled;tickDate,tickProduct;tradeDate,tradeProduct;trendDate,trendProduct)
    """
    clean = lambda value: re.sub(r"[;,()|]", " ", str(value or "")).strip()
    pulled = _pacific(observed)
    parts = [clean(pulled if pulled != DASH else NA)]
    parts += [f"{clean(_short_date(date) if date else '')},{clean(product)}" for date, product in readings]
    return f"ASOF({';'.join(parts)})"


def _market_cell(row: dict[str, Any]) -> str:
    if row.get("reference"):
        return f"REF({row.get('label')};{row['reference']})"
    risk_range = row.get("range") or {}
    if risk_range.get("fit") == "related-only" and risk_range.get("ticker"):
        return f"MKT({row.get('label')};{risk_range['ticker']} range)"
    return row.get("label") or NA


def _range_cell(row: dict[str, Any]) -> str:
    """Token the report UI draws as a one-line price-in-range bar: RR(low;high;price;decimals;unit)."""
    risk_range = row.get("range") or {}
    low, high = risk_range.get("low"), risk_range.get("high")
    if not all(isinstance(value, (int, float)) for value in (low, high)):
        return _number((row.get("price") or {}).get("value"), percent=row.get("group") == "rates")
    # A range is always drawn with its own instrument's price (e.g. Nasdaq Composite for COMPQ).
    price = (row.get("rangePrice") or row.get("price") or {}).get("value")
    decimals = 0 if max(abs(low), abs(high)) >= 1000 else 2
    value = f"{price:.{decimals}f}" if isinstance(price, (int, float)) else ""
    unit = "%" if row.get("group") == "rates" else ""
    return f"RR({low:.{decimals}f};{high:.{decimals}f};{value};{decimals};{unit})"


def _level(value: Any, unit: str | None) -> str:
    """A printed signal level: yields to two decimals, prices as published (83,000 · 92 · 6.45)."""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return ""
    if unit == "%":
        return f"{value:.2f}"
    return f"{value:,.0f}" if abs(value) >= 1000 else f"{value:,.2f}".rstrip("0").rstrip(".")


def _alpha_cell(row: dict[str, Any]) -> str:
    """Token the report UI stacks as Trade and Trend levels with the price above or below each.

    ALPHA(trade;trend;tradeRel;trendRel;unit;approx;product)
    """
    research = row.get("research") or {}
    code = research.get("alphaCode")
    price = (row.get("price") or {}).get("value")
    relation = lambda level: ("above" if price > level else "below" if price < level else "at") \
        if isinstance(price, (int, float)) and isinstance(level, (int, float)) else ""
    if not code:
        # Without a full code, the highest-priority product's single Trade or Trend level for the market itself.
        singles = [item for item in research.get("findings") or []
                   if item.get("kind") in ("tradeLevel", "trendLevel") and item.get("fit") == "exact"]
        trade = next((item for item in singles if item["kind"] == "tradeLevel"), None)
        trend = next((item for item in singles if item["kind"] == "trendLevel"), None)
        if not (trade or trend):
            return "N/A"
        first = trade or trend
        code = {"trade": (trade or {}).get("level"), "trend": (trend or {}).get("level"), "unit": first.get("unit"),
                "approximate": bool((trade or {}).get("approximate") or (trend or {}).get("approximate")),
                "productLabel": first.get("productLabel")}
    clean = lambda value: re.sub(r"[;()|]", " ", str(value or "")).strip()
    unit = code.get("unit") or ""
    return (f"ALPHA({_level(code.get('trade'), unit)};{_level(code.get('trend'), unit)};"
            f"{relation(code.get('trade'))};{relation(code.get('trend'))};{unit};{1 if code.get('approximate') else 0};"
            f"{clean(code.get('productLabel'))})")


TONE = {"Bullish": "positive", "Bearish": "negative", "Long": "positive", "Short": "negative",
        "positive": "positive", "negative": "negative"}


def _fact_text(item: dict[str, Any], row: dict[str, Any]) -> list[dict[str, Any]]:
    """Display facts for one finding; a range identical to the board's own Risk Range adds nothing."""
    kind, unit = item.get("kind"), item.get("unit")
    fmt = lambda value: f"{_level(value, unit)}{'%' if unit == '%' else ''}"
    who = f"{item['instrumentLabel']} " if item.get("instrumentLabel") and item.get("instrumentLabel") != "spot" else ""
    approx = "~" if item.get("approximate") else ""
    if kind == "alphaCode":
        return [{"text": f"{who}Alpha Code {approx}{fmt(item.get('trade'))} / {fmt(item.get('trend'))}", "tone": "key"}]
    if kind in ("tradeLevel", "trendLevel"):
        return [{"text": f"{who}{'Trade' if kind == 'tradeLevel' else 'Trend'} level {approx}{fmt(item.get('level'))}", "tone": "key"}]
    if kind == "riskRange":
        board_range = row.get("range") or {}
        same_instrument = not item.get("instrument") or item.get("instrument") == board_range.get("ticker")
        if same_instrument and board_range.get("low") == item.get("low") and board_range.get("high") == item.get("high"):
            return []
        spot = " (spot)" if item.get("instrumentLabel") == "spot" else ""
        facts = [{"text": f"{who}Risk Range{spot} {fmt(item.get('low'))}–{fmt(item.get('high'))}", "tone": None}]
        if item.get("trend"):
            facts.append({"text": f"{who}Trend {item['trend']}", "tone": TONE.get(item["trend"])})
        return facts
    if kind == "signal":
        return [{"text": f"{who}{label} {item[key]}", "tone": TONE.get(item[key])}
                for key, label in (("trade", "Trade"), ("trend", "Trend")) if item.get(key)]
    if kind == "position":
        action = f"{item['action']} " if item.get("action") and item.get("action") not in ("Buy", "Short") else ""
        target = f" {item['instrumentLabel']}" if item.get("instrumentLabel") else ""
        inverse = " (inverse to yield)" if item.get("inverse") else ""
        return [{"text": f"{action}{item.get('side')}{target}{inverse}", "tone": None if item.get("inverse") else TONE.get(item.get("side"))}]
    if kind == "trendChange":
        return [{"text": f"Trend changed {item.get('from') or 'N/A'} → {item.get('to') or 'N/A'}", "tone": TONE.get(item.get("to"))}]
    if kind == "structure":
        return [{"text": f"{signal['label']} {signal['value']}", "tone": TONE.get(signal.get("tone"))}
                for signal in item.get("signals") or []]
    return []


def _research_block(board: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Per market, one entry per mention in the morning's products, in time order.

    A sentence's entry carries the part of it about that market (the extractor's
    trimmed context) and the full sentence as its source; data a product publishes
    without prose (levels tables, positions, trend changes) reads as its facts.
    """
    research = board.get("research")
    if not isinstance(research, dict):
        return None
    products = research.get("products") or []
    published = {product.get("label"): product.get("publishedAt") for product in products}
    order = {product.get("label"): index for index, product in enumerate(products)}
    clock = lambda value: (lambda when: when.rsplit(" ", 1)[-1] if ":" in when else None)(_pacific(value)) if value else None
    markets = []
    for row in rows:
        entries: dict[tuple[str, str], dict[str, Any]] = {}
        for finding in (row.get("research") or {}).get("findings") or []:
            label = finding.get("productLabel") or finding.get("product") or "Research"
            time = clock(finding.get("eventTime") or published.get(label))
            excerpt = finding.get("excerpt")
            if excerpt:
                context = finding.get("context") or excerpt
                entries.setdefault((label, excerpt), {"product": label, "time": time, "context": context,
                                                      **({"source": excerpt} if excerpt != context else {})})
                continue
            facts = _fact_text(finding, row)
            if not facts:
                continue
            if finding.get("kind") == "position" and finding.get("name"):
                # A position the product's own prose already names ("BUY SIGNAL UUP") adds nothing.
                names = {finding["name"], finding.get("instrumentLabel"), *re.findall(r"\(([A-Z0-9.]+)\)", finding["name"])} - {None}
                if any(key[0] == label and (entry.get("source") or entry["context"]) and any(name in (entry.get("source") or entry["context"]) for name in names)
                       for key, entry in entries.items()):
                    continue
                action = finding.get("action")
                verb = f"{action} {finding.get('side')}" if action in ("Added", "Removed") else action or finding.get("side")
                context = f"{verb} {finding['name']}" + (" (inverse to yield)" if finding.get("inverse") else "")
            else:
                context = (f"{finding['source']}: " if finding.get("source") else "") + " · ".join(fact["text"] for fact in facts)
            entries.setdefault((label, context), {"product": label, "time": time, "context": context})
        ordered = sorted(entries.values(), key=lambda entry: (entry["time"] is None, entry["time"] or "", order.get(entry["product"], 99)))
        markets.append({"market": row.get("label"), "entries": [{key: value for key, value in entry.items() if value} for entry in ordered]})
    return {"markets": markets} if markets else None


def _dollar_row(usd: dict[str, Any] | None) -> dict[str, Any] | None:
    """The US Dollar Index laid out like a market row above each section's markets."""
    if not usd:
        return None
    has_range = isinstance(usd.get("low"), (int, float)) and isinstance(usd.get("high"), (int, float))
    return {"id": "usd", "label": "US Dollar", "reference": "DXY",
            "price": {"value": usd.get("value"), "asOf": usd.get("asOf")},
            "range": {"low": usd.get("low"), "high": usd.get("high"), "date": usd.get("rangeDate")} if has_range else {},
            "tick": usd.get("tick"), "trade": usd.get("trade"), "trend": usd.get("trend"), "research": usd.get("research")}


def _section_rows(board: dict[str, Any], rows: list[dict[str, Any]]) -> list[tuple[str, str, list[dict[str, Any]]]]:
    sections = board.get("sections") or DEFAULT_SECTIONS
    group = lambda row: GROUP_ALIASES.get(row.get("group"), row.get("group"))
    return [(section["id"], section["label"], [row for row in rows if group(row) == section["id"]]) for section in sections]


def render_setup_board(board: dict[str, Any]) -> str:
    rows = [row for row in board.get("rows") or [] if isinstance(row, dict)]
    priced = [row for row in rows if row.get("id") != "cpi"]
    sources = board.get("sources") or {}
    # Boards captured with the morning's products carry an Alpha Code column and research block.
    with_research = isinstance(board.get("research"), dict)
    dollar_research_shown = False
    lines = []
    for section_id, label, members in _section_rows(board, rows):
        if not members:
            continue
        lines += [f"## {label}", ""]
        if section_id == "inflation":
            for cpi in members:
                # Every published nowcast month from the current release on; older captures carry one forecast.
                forecasts = cpi.get("forecasts") or [{**(cpi.get("forecast") or {}),
                                                      "eventTicker": ((cpi.get("events") or [{}])[0]).get("eventTicker")}]
                rows = []
                for forecast in forecasts:
                    month = re.match(r"^(\d{4})-(\d{2})$", str(forecast.get("reportMonth") or ""))
                    coded = re.search(r"-(\d{2})([A-Z]{3})$", str(forecast.get("eventTicker") or ""))
                    label = (f"{MONTHS[int(month[2]) - 1]} {month[1]}" if month
                             else f"{MONTHS[MONTH_CODES[coded[2]] - 1]} 20{coded[1]}" if coded and coded[2] in MONTH_CODES else NA)
                    published = _pacific_zoned(forecast.get("publishedAt"))
                    rows.append([f"{cpi.get('label') or 'CPI YoY'} · {label}",
                                 _event_label({"eventTicker": forecast.get("eventTicker")}) if forecast.get("eventTicker") else NA,
                                 *(_number(forecast.get(key), percent=True) if forecast.get("available") else NA
                                   for key in ("lower", "base", "upper")),
                                 published if published != DASH else NA])
                lines += _table(["Market", "Kalshi", "Nowcast low", "Base", "High", "Published"], rows)
            continue
        drivers = _driver_block(board, members, label)
        if drivers["volatility"] or drivers.get("correlations"):
            lines += ["```analyst-drivers", json.dumps(drivers, ensure_ascii=False, separators=(",", ":")), "```", ""]
        table = []
        dollar = _dollar_row(board.get("usd"))
        for row in ([dollar] if dollar else []) + members:
            price, tick, trade, risk_range = (row.get(key) or {} for key in ("price", "tick", "trade", "range"))
            trend_product = "Crypto Quant" if risk_range.get("product") == "crypto-quant" else "Risk Ranges"
            table.append([_market_cell(row), _bias_cell(tick.get("direction")), _bias_cell(trade.get("direction")),
                          _bias_cell(row.get("trend")), *([_alpha_cell(row)] if with_research else []), _range_cell(row),
                          _as_of_cell(price.get("asOf"), [
                              (tick.get("date"), f"HedgAI {tick.get('ticker') or ''}".strip() if tick else None),
                              (trade.get("date"), trade.get("source")),
                              (risk_range.get("date") if row.get("trend") else None, trend_product if row.get("trend") else None)])])
        lines += _table(["Market", "Tick", "Trade", "Trend", *(["Alpha Code"] if with_research else []),
                         "Price and Risk Range", "As of (PT)"], table)
        notes = []
        for row in members:
            if row.get("rangePrice") and row.get("range"):
                notes.append(f"{row['label']} {_number((row.get('price') or {}).get('value'))}; its bar shows the "
                             f"{row['range'].get('ticker')} range and {row['rangePrice'].get('label')} price.")
        for row in members:
            if rejected := row.get("priceRejected"):
                notes.append(f"{row['label']} price withheld: {rejected.get('symbol')} returned "
                             f"{_number(rejected.get('value'))}, inconsistent with its Risk Range.")
        inverse = [f"{row['label']} ({row['tick']['ticker']})" for row in members if (row.get("tick") or {}).get("inverse")]
        if inverse:
            notes.append("Tick for " + ", ".join(inverse) + " is a Treasury price ETF signal, read inversely as a yield direction.")
        if section_id == "rates":
            notes.append("Kalshi yield contracts pay if the daily Treasury yield reaches the line on any business day this month.")
        if notes:
            lines += [" ".join(notes), ""]
        # The US Dollar's research appears once, with the first section that shows its row.
        research_rows = ([dollar] if dollar and not dollar_research_shown else []) + members
        dollar_research_shown = dollar_research_shown or bool(dollar)
        block = _research_block(board, research_rows) if with_research else None
        if block:
            lines += ["```analyst-research", json.dumps(block, ensure_ascii=False, separators=(",", ":")), "```", ""]

    dated = [(label, _pacific_zoned(sources.get(key))) for key, label in (
        ("riskRanges", "Risk Ranges"), ("cryptoQuant", "Crypto Quant"), ("inflationNowcast", "Inflation Nowcast"))]
    named = [f"{label} {date}" for label, date in dated if date != DASH] + ["HedgAI Signals", "Cboe volatility indices", "Kalshi"]
    lines += ["Sources: " + ", ".join(named), ""]
    if with_research:
        products = board["research"].get("products") or []
        clock = lambda value: _pacific(value).rsplit(" ", 1)[-1] if ":" in _pacific(value) else _pacific(value)
        read = [f"{item.get('label')} {clock(item['publishedAt'])}" if item.get("publishedAt") else str(item.get("label"))
                for item in products if item.get("status") == "read"]
        missing = [str(item.get("label")) for item in products if item.get("status") != "read"]
        day = _short_date(board["research"].get("marketDate"))
        lines += [f"Research read for {day}: " + (", ".join(read) or "none") + "."
                  + (f" Not published yet: {', '.join(missing)}." if missing else ""), ""]
    return "\n".join(lines).strip() + "\n"
