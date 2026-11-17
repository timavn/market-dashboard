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
EASTERN = ZoneInfo("America/New_York")
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


def _eastern_date(value: Any) -> str | None:
    """The New York market day of an instant, e.g. 2026-11-02."""
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(EASTERN).date().isoformat()
    except ValueError:
        return None


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
            or (reason if reason in {"Below range", "Above range"} else DASH))


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


def _sizing_block(members: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Each sized setup's tickets (daily, then weekly): its share of the Kalshi account, what each input added, and its lines."""
    isnum = lambda value: isinstance(value, (int, float)) and not isinstance(value, bool)
    signed = lambda value: "0" if abs(value) < 0.005 else f"{value:+.2f}".rstrip("0").rstrip(".").replace("-", "−")
    markets = []
    for row in members:
        sizing = row.get("sizing")
        if not isinstance(sizing, dict) or not isnum(sizing.get("pct")):
            continue
        account = (sizing.get("account") or {}).get("value")
        inputs = [{"label": "Base", "points": f"{sizing.get('basePct', 3):g}%"}] + [
            {"label": item.get("label"), "points": signed(item["points"]),
             **({"note": "no reading" if item.get("missing") else item["detail"]} if item.get("missing") or item.get("detail") else {})}
            for item in sizing.get("components") or [] if isinstance(item, dict) and isnum(item.get("points"))]
        band = sizing.get("volBand")
        for duration, ticket in (("Daily", sizing), ("Weekly", sizing.get("weekly"))):
            if not isinstance(ticket, dict) or (duration == "Weekly" and not ticket.get("event")):
                continue
            lines = []
            for line in ticket.get("lines") or []:
                funded = isnum(line.get("dollars")) and isnum(line.get("contracts"))
                lines.append({"line": f"Above {_number(line.get('strike'))}",
                              "from": f"{line['fromCentrePct']:+.1f}%" if isnum(line.get("fromCentrePct")) else NA,
                              "buy": "Yes" if line.get("buy") == "YES" else "No",
                              "ask": f"{line['ask'] * 100:.0f}¢" if isnum(line.get("ask")) else NA,
                              "stake": (f"{line['pct']:.1f}%" if isnum(line.get("pct")) else NA) + (f" · ${line['dollars']:,.0f}" if funded else ""),
                              **({"contracts": f"{line['contracts']:,}", "wins": f"${line.get('win') or 0:,.0f}"} if funded else {}),
                              **({"capped": True} if line.get("capped") else {})})
            market = {
                "market": row.get("label"), "side": "Long" if sizing.get("side") == "LONG" else "Short",
                "duration": duration + (f" · closes {_pacific(ticket['closes'])}" if ticket.get("closes") else ""),
                "pct": f"{sizing['pct']:.1f}%", "maxPct": f"{sizing.get('maxPct', 5.5):g}%",
                "dollars": f"${account * sizing['pct'] / 100:,.0f} of ${account:,.0f}" if isnum(account) else None,
                "inputs": inputs, "event": ticket.get("event"), "lines": lines,
            }
            if not lines:
                market["reason"] = ticket.get("reason") or "Kalshi lines not read"
            elif isnum(ticket.get("unspentPct")) and ticket["unspentPct"] >= 0.05:
                market["unspent"] = f"{ticket['unspentPct']:.1f}%"
            ladder = ticket.get("ladder") or {}
            centre, sigma = ladder.get("centre"), ladder.get("sigma")
            if isnum(centre) and isnum(sigma) and centre:
                market["price"] = _number(centre)
                market["move"] = f"±{_number(sigma)} ({sigma / centre * 100:.1f}%)"
            span = row.get("range") or {}
            if isnum(span.get("low")) and isnum(span.get("high")):
                market["range"] = f"{_number(span['low'])}–{_number(span['high'])}"
            if band or sizing.get("expanding"):
                market["vol"] = " · ".join(filter(None, [band and f"Vol {band.lower()}", "expanding" if sizing.get("expanding") else None]))
                if not band:
                    market["vol"] = "Vol expanding"
            if ticket.get("quotedAt"):
                market["quoted"] = _pacific(ticket["quotedAt"])
            if lines and not sizing.get("account"):
                market["note"] = "Kalshi balance unavailable; shares of the account only."
            markets.append({key: value for key, value in market.items() if value not in (None, "")})
    return {"markets": markets} if markets else None


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


def _bias_cell(direction: Any, broken: dict[str, Any] | None = None, name: str = "") -> str:
    """Token for a bias word; its publication date and product appear in the As of cell.

    A call whose Alpha Code line the price has crossed reads Neutral; the token's
    optional fourth field says why, for the cell's tooltip only.
    """
    word = DIRECTION.get(direction) or NA
    if not broken:
        return f"BIAS({word};;)"
    published = broken.get("published") or {}
    clean = lambda value: re.sub(r"[;()|]", " ", str(value or "")).strip()
    note = (f"{str(broken.get('side') or '').capitalize()} the {broken.get('productLabel') or 'Alpha Code'} {name} line "
            f"{_number(broken.get('level'))} since {_pacific(broken.get('since'))} · {published.get('source') or 'Published'} "
            f"{DIRECTION.get(published.get('value')) or ''} {_short_date(published.get('date'))} reads Neutral until reclaimed · "
            "inferred, not stated by the source")
    return f"BIAS({word};;;{clean(' '.join(note.split()))})"


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
    """Market name with its sub-label; boards captured with price history add the 20-session Z-score:
    REF(name;DXY;z) for the Dollar, MKT(name;GLD range;z) for a related range, NAME(name;;z) otherwise."""
    z = (row.get("zScore") or {}).get("value")
    z = f";{z:+.1f}" if isinstance(z, (int, float)) and not isinstance(z, bool) else ";" if "zScore" in row else ""
    if row.get("reference"):
        return f"REF({row.get('label')};{row['reference']}{z})"
    risk_range = row.get("range") or {}
    if risk_range.get("fit") == "related-only" and risk_range.get("ticker"):
        return f"MKT({row.get('label')};{risk_range['ticker']} range{z})"
    return f"NAME({row.get('label') or NA};{z})" if z else row.get("label") or NA


def _alpha_code(row: dict[str, Any]) -> dict[str, Any] | None:
    """This morning's Alpha Code, or without one the highest-priority product's single Trade or Trend level."""
    research = row.get("research") or {}
    if research.get("alphaCode"):
        return research["alphaCode"]
    singles = [item for item in research.get("findings") or []
               if item.get("kind") in ("tradeLevel", "trendLevel") and item.get("fit") == "exact"]
    trade = next((item for item in singles if item["kind"] == "tradeLevel"), None)
    trend = next((item for item in singles if item["kind"] == "trendLevel"), None)
    if not (trade or trend):
        return None
    first = trade or trend
    return {"trade": (trade or {}).get("level"), "trend": (trend or {}).get("level"), "unit": first.get("unit"),
            "approximate": bool((trade or {}).get("approximate") or (trend or {}).get("approximate")),
            "productLabel": first.get("productLabel")}


def _range_cell(row: dict[str, Any]) -> str:
    """Token the report UI draws as a one-line price-in-range bar with this morning's Alpha Code under it.

    RR(low;high;price;decimals;unit;acTrade;acTrend;approx;dots;product) — dots is 1 when the Alpha Code
    is on the range's own instrument, so its levels can be marked on the bar.
    """
    risk_range = row.get("range") or {}
    low, high = risk_range.get("low"), risk_range.get("high")
    if not all(isinstance(value, (int, float)) for value in (low, high)):
        return _number((row.get("price") or {}).get("value"), percent=row.get("group") == "rates")
    # A range is always drawn with its own instrument's price (e.g. Nasdaq Composite for COMPQ).
    price = (row.get("rangePrice") or row.get("price") or {}).get("value")
    decimals = 0 if max(abs(low), abs(high)) >= 1000 else 2
    value = f"{price:.{decimals}f}" if isinstance(price, (int, float)) else ""
    unit = "%" if row.get("group") == "rates" else ""
    token = f"RR({low:.{decimals}f};{high:.{decimals}f};{value};{decimals};{unit}"
    code = _alpha_code(row)
    if not code:
        return token + ")"
    level = lambda key: f"{code[key]:g}" if isinstance(code.get(key), (int, float)) and not isinstance(code.get(key), bool) else ""
    # The Alpha Code is printed for the market itself; a range drawn on another instrument (COMPQ) gets no dots.
    dots = 0 if row.get("rangePrice") else 1
    product = re.sub(r"[;()|]", " ", str(code.get("productLabel") or "")).strip()
    return f"{token};{level('trade')};{level('trend')};{1 if code.get('approximate') else 0};{dots};{product})"


def _level(value: Any, unit: str | None) -> str:
    """A printed signal level: yields to two decimals, prices as published (83,000 · 92 · 6.45)."""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return ""
    if unit == "%":
        return f"{value:.2f}"
    return f"{value:,.0f}" if abs(value) >= 1000 else f"{value:,.2f}".rstrip("0").rstrip(".")


def _structure_cell(row: dict[str, Any]) -> str:
    """Token the report UI stacks as today's range moves, the run counts and the all-time high check.

    STRUCT(lowSteps;lowRun;highSteps;highRun;ath;athDate;athPct;topAbove;unit[;volume;tone;direction]) — steps oldest
    first as + (higher), - (lower) or = (unchanged); runs signed (+8 = eight higher in a row ending today). Boards with
    volume add DV/AV, how it reads for the Trend (supports, warns or confirms), and the day's direction (+/-).
    """
    structure = row.get("structure")
    if not isinstance(structure, dict):
        return NA
    run = lambda leg: f"{'+' if leg.get('direction', 0) > 0 else '-' if leg.get('direction', 0) < 0 else ''}{leg.get('run') or 0}"
    low, high = structure.get("low") or {}, structure.get("high") or {}
    unit = "%" if row.get("group") == "rates" else ""
    ath, ath_date, ath_pct, top_above = "", "", "", "0"
    record = structure.get("allTimeHigh") or {}
    if isinstance(record.get("value"), (int, float)):
        ath = _level(record["value"], unit)
        match = re.match(r"^(\d{4})-(\d{2})-(\d{2})", str(record.get("date") or ""))
        if match:
            month = MONTHS[int(match[2]) - 1]
            # The full date, shown when the ATH line is opened.
            ath_date = f"{month} {int(match[3])}, {match[1]}"
        price = ((row.get("rangePrice") or row.get("price")) or {}).get("value")
        if isinstance(price, (int, float)) and record["value"]:
            ath_pct = f"{round((price / record['value'] - 1) * 100):+d}"
        top_above = "1" if record.get("rangeTopAbove") else "0"
    signal = ((row.get("volume") or {}).get("signal") or {}) if "volume" in row else None
    direction = {"up": "+", "down": "-"}.get((signal or {}).get("direction"), "")
    volume = "" if signal is None else f";{signal.get('move') or ''};{signal.get('tone') or ''};{direction}"
    return (f"STRUCT({low.get('steps', '')};{run(low)};{high.get('steps', '')};{run(high)};"
            f"{ath};{ath_date};{ath_pct};{top_above};{unit}{volume})")


def _volume_cell(row: dict[str, Any]) -> str:
    """Token the report UI draws under Tick, Trade and Trend: the latest session's ETF volume against the prior
    session and its 15-, 30- and 90-calendar-day averages, as signed whole percents.

    VOL(d1;d15;d30;d90;date;symbol;side) — side is the day's move with (+) or against (-) the Trend, empty without one.
    Empty readings when the market's volume is unavailable, so the row keeps its shape.
    """
    volume = row.get("volume")
    if not isinstance(volume, dict):
        return "VOL(;;;;;;)"
    pct = lambda key: f"{round(volume[key]):+d}" if isinstance(volume.get(key), (int, float)) else ""
    side = {"with": "+", "against": "-"}.get((volume.get("signal") or {}).get("side"), "")
    return (f"VOL({pct('d1')};{pct('d15')};{pct('d30')};{pct('d90')};{volume.get('date') or ''};"
            f"{volume.get('symbol') or ''};{side})")


TONE = {"Bullish": "positive", "Bearish": "negative", "Long": "positive", "Short": "negative",
        "positive": "positive", "negative": "negative"}


def _fact_text(item: dict[str, Any], row: dict[str, Any]) -> list[dict[str, Any]]:
    """Display facts for one finding, each read as "Label: value"; a range identical to the board's own Risk Range adds nothing."""
    kind, unit = item.get("kind"), item.get("unit")
    fmt = lambda value: f"{_level(value, unit)}{'%' if unit == '%' else ''}"
    who = f"{item['instrumentLabel']} " if item.get("instrumentLabel") and item.get("instrumentLabel") != "spot" else ""
    approx = "~" if item.get("approximate") else ""
    if kind == "alphaCode":
        return [{"text": f"{who}Alpha Code: {approx}{fmt(item.get('trade'))} / {fmt(item.get('trend'))}", "tone": "key"}]
    if kind in ("tradeLevel", "trendLevel"):
        return [{"text": f"{who}{'Trade' if kind == 'tradeLevel' else 'Trend'} level: {approx}{fmt(item.get('level'))}", "tone": "key"}]
    if kind == "riskRange":
        board_range = row.get("range") or {}
        same_instrument = not item.get("instrument") or item.get("instrument") == board_range.get("ticker")
        if same_instrument and board_range.get("low") == item.get("low") and board_range.get("high") == item.get("high"):
            return []
        spot = " (spot)" if item.get("instrumentLabel") == "spot" else ""
        facts = [{"text": f"{who}Risk Range{spot}: {fmt(item.get('low'))}–{fmt(item.get('high'))}", "tone": None}]
        if item.get("trend"):
            facts.append({"text": f"{who}Trend: {item['trend']}", "tone": TONE.get(item["trend"])})
        return facts
    if kind == "signal":
        return [{"text": f"{who}{label}: {item[key]}", "tone": TONE.get(item[key])}
                for key, label in (("trade", "Trade"), ("trend", "Trend")) if item.get(key)]
    if kind == "position":
        action = f"{item['action']} " if item.get("action") and item.get("action") not in ("Buy", "Short") else ""
        target = f" {item['instrumentLabel']}" if item.get("instrumentLabel") else ""
        inverse = " (inverse to yield)" if item.get("inverse") else ""
        return [{"text": f"{action}{item.get('side')}{target}{inverse}", "tone": None if item.get("inverse") else TONE.get(item.get("side"))}]
    if kind == "trendChange":
        return [{"text": f"Trend: {item.get('from') or 'N/A'} → {item.get('to') or 'N/A'}", "tone": TONE.get(item.get("to"))}]
    if kind == "structure":
        return [{"text": f"{signal['label']}: {signal['value']}", "tone": TONE.get(signal.get("tone"))}
                for signal in item.get("signals") or []]
    if kind == "structureLevels":
        number = lambda value: f"{value:,.0f}" if abs(value) >= 1000 else f"{value:g}"
        present = lambda key: isinstance(item.get(key), (int, float)) and not isinstance(item.get(key), bool)
        facts = []
        if present("zeroGamma"):
            facts.append(f"Zero gamma: {number(item['zeroGamma'])}")
        if present("lowerPvBand") and present("upperPvBand"):
            facts.append(f"PV band: {number(item['lowerPvBand'])}–{number(item['upperPvBand'])}")
        if item.get("strikesInPlay"):
            facts.append("Strikes in play: " + ", ".join(number(value) for value in item["strikesInPlay"]))
        if present("gammaThrottle"):
            facts.append(f"Gamma throttle: {number(item['gammaThrottle'])}")
        if present("realizedVolatility"):
            facts.append(f"10D realized vol: {number(item['realizedVolatility'])}%")
        return [{"text": fact, "tone": None} for fact in facts]
    return []


def _research_block(board: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Per market, one entry per mention in the morning's products, in time order.

    A sentence's entry carries the part of it about that market (the extractor's
    trimmed context) and the full sentence as its source; data a product publishes
    without prose (levels tables, positions, trend changes) reads as its facts, with
    the line or list the product printed it in as its source.
    """
    research = board.get("research")
    if not isinstance(research, dict):
        return None
    products = research.get("products") or []
    published = {product.get("label"): product.get("publishedAt") for product in products}
    # Each product's email, which its Source shows clipped to the quoted line.
    messages = {product.get("label"): product.get("messageId") for product in products}
    order = {product.get("label"): index for index, product in enumerate(products)}
    clock = lambda value: (lambda when: when.rsplit(" ", 1)[-1] if ":" in when else None)(_pacific(value)) if value else None
    # The Pacific date the product was published, e.g. Oct 22.
    day = lambda value: (lambda when: (re.match(r"^[A-Z][a-z]{2} \d{1,2}", when) or [None])[0])(_pacific(value)) if value else None
    markets = []
    for row in rows:
        entries: dict[tuple[str, str], dict[str, Any]] = {}
        for finding in (row.get("research") or {}).get("findings") or []:
            label = finding.get("productLabel") or finding.get("product") or "Research"
            when = finding.get("eventTime") or published.get(label)
            time, date = clock(when), day(when)
            excerpt = finding.get("excerpt")
            if excerpt:
                context = finding.get("context") or excerpt
                entries.setdefault((label, excerpt), {"product": label, "time": time, "context": context, "source": excerpt, "date": date,
                                                      "messageId": messages.get(label)})
                continue
            facts = _fact_text(finding, row)
            if not facts:
                continue
            if finding.get("kind") == "position" and finding.get("name"):
                # A position the product's own prose already names ("BUY SIGNAL UUP") adds nothing.
                names = {finding["name"], finding.get("instrumentLabel"), *re.findall(r"\(([A-Z0-9.]+)\)", finding["name"])} - {None}
                if any(key[0] == label and key[1] == entry.get("source") and any(name in key[1] for name in names)
                       for key, entry in entries.items()):
                    continue
                action = finding.get("action")
                verb = f"{action} {finding.get('side')}" if action in ("Added", "Removed") else action or finding.get("side")
                context = f"{verb} {finding['name']}" + (" (inverse to yield)" if finding.get("inverse") else "")
            else:
                context = " · ".join(fact["text"] for fact in facts)
            entry = {"product": label, "time": time, "context": context, "source": finding.get("sourceText"), "date": date,
                     "messageId": messages.get(label)}
            # Reported data ("Label: value" readings) lists as one line per fact rather than a sentence.
            if finding.get("kind") != "position" and all(": " in fact["text"] for fact in facts):
                entry["facts"] = [fact["text"] for fact in facts]
            entries.setdefault((label, context), entry)
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
            "tick": usd.get("tick"), "trade": usd.get("trade"), "trend": usd.get("trend"), "research": usd.get("research"),
            "structure": usd.get("structure"), **({"volume": usd.get("volume")} if "volume" in usd else {}),
            **({"zScore": usd.get("zScore")} if "zScore" in usd else {})}


def _section_rows(board: dict[str, Any], rows: list[dict[str, Any]]) -> list[tuple[str, str, list[dict[str, Any]]]]:
    sections = board.get("sections") or DEFAULT_SECTIONS
    group = lambda row: GROUP_ALIASES.get(row.get("group"), row.get("group"))
    return [(section["id"], section["label"], [row for row in rows if group(row) == section["id"]]) for section in sections]


def research_by_section(board: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Each section's research block, keyed by section id, stamped with the section and the research market date
    so the report can ask for the same section on an earlier market day. The US Dollar's research appears once,
    with the first section that shows its row."""
    research = board.get("research")
    if not isinstance(research, dict):
        return {}
    rows = [row for row in board.get("rows") or [] if isinstance(row, dict) and row.get("id") != "cpi"]
    dollar = _dollar_row(board.get("usd"))
    blocks: dict[str, dict[str, Any]] = {}
    for section_id, _label, members in _section_rows(board, rows):
        if not members or section_id == "inflation":
            continue
        block = _research_block(board, ([dollar] if dollar and not blocks else []) + members)
        if block:
            blocks[section_id] = {"section": section_id, "marketDate": research.get("marketDate"), **block}
    return blocks


# Products a range or Trend names by id; the board's own feed times date their edition.
PRODUCT_IDS = {"risk-ranges": "Risk Ranges", "crypto-quant": "Crypto Quant"}
FEED_DATES = {"riskranges": "riskRanges", "cryptoquant": "cryptoQuant"}
LEADING_PRODUCTS = ("riskranges", "cryptoquant")


def _product_key(label: Any) -> str:
    """One key per product however a feed spells it: "Macro Show" and "The Macro Show" are the same product."""
    return re.sub(r"[^a-z0-9]", "", re.sub(r"^the\s+", "", str(label or "").strip().lower()))


class _CitedProducts:
    """Every Hedgeye product the review draws on, recorded as each cell or research entry is written, so the
    Sources line names exactly the products the body uses, each at the latest edition received: this market day's
    when the board read it, even if it states no new Trade, otherwise the newest of an earlier day."""

    def __init__(self, board: dict[str, Any]):
        research = board.get("research") if isinstance(board.get("research"), dict) else {}
        products = [item for item in research.get("products") or [] if isinstance(item, dict) and item.get("label")]
        self.names = {_product_key(item["label"]): str(item["label"]) for item in products}
        self.order = {_product_key(item["label"]): index for index, item in enumerate(products)}
        self.published = {_product_key(item["label"]): item.get("publishedAt") for item in products}
        self.latest = {_product_key(item["label"]): item.get("latestEdition") for item in products}
        self.ids = {_product_key(item["label"]): item.get("key") for item in products if item.get("key")}
        self.feeds = board.get("sources") or {}
        self.cited: dict[str, dict[str, Any]] = {}

    def cite(self, label: Any, when: Any = None) -> None:
        name = str(label or "").strip()
        key = _product_key(name)
        # An Alpha Code line is named for its level; the product that printed it is cited on its own.
        if not key or key == "research" or re.match(r"^Alpha Code\b", name):
            return
        item = self.cited.setdefault(key, {"name": self.names.get(key, name), "when": [], "seen": len(self.cited)})
        if when:
            item["when"].append(str(when))

    def _published(self, key: str, item: dict[str, Any]) -> str | None:
        """The latest edition received: the feed's own time for Risk Ranges and Crypto Quant."""
        if self.feeds.get(FEED_DATES.get(key, "")):
            return str(self.feeds[FEED_DATES[key]])
        when = item["when"] + [str(known[key]) for known in (self.published, self.latest) if known.get(key)]
        # Instants sort after a bare date on the same Pacific day.
        stamp = lambda value: (_pacific_day(value), "T" in value, value)
        return max(when, key=stamp) if when else None

    def items(self) -> list[dict[str, Any]]:
        """Each cited product once, in reading order, with its research product id and latest edition used."""
        rank = lambda key: (LEADING_PRODUCTS.index(key) if key in LEADING_PRODUCTS else len(LEADING_PRODUCTS),
                            self.order.get(key, len(self.order)), self.cited[key]["seen"])
        return [{"key": key, "id": self.ids.get(key) or re.sub(r"[^a-z0-9]+", "-", self.cited[key]["name"].lower()).strip("-"),
                 "label": self.cited[key]["name"], "publishedAt": self._published(key, self.cited[key])}
                for key in sorted(self.cited, key=rank)]

    def named(self) -> list[str]:
        return [item["label"] + (f" {_pacific_zoned(item['publishedAt'])}" if item["publishedAt"] else "")
                for item in self.items()]


def _pacific_day(value: Any) -> str:
    text = str(value or "")
    if not re.match(r"^\d{4}-\d{2}-\d{2}T", text):
        return text[:10]
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(PACIFIC).date().isoformat()
    except ValueError:
        return text[:10]


def _cite_row(cited: _CitedProducts, row: dict[str, Any]) -> None:
    """The products one market row's cells name: its range and Trend, its Trade, and any Alpha Code."""
    trade, risk_range = (row.get(key) or {} for key in ("trade", "range"))
    drawn = all(isinstance(risk_range.get(key), (int, float)) for key in ("low", "high"))
    if drawn or row.get("trend"):
        cited.cite(PRODUCT_IDS.get(risk_range.get("product"), "Risk Ranges"), risk_range.get("date"))
    cited.cite(trade.get("source"), trade.get("publishedAt") or trade.get("date"))
    for broken in (row.get("alphaBreaks") or {}).values():
        if isinstance(broken, dict):
            # The line's product is cited; "since" is when price crossed it, not when it was published.
            cited.cite(broken.get("productLabel"))
            published = broken.get("published") or {}
            cited.cite(published.get("source"), published.get("publishedAt") or published.get("date"))
    code = _alpha_code(row) if drawn else None
    if code:
        label = code.get("productLabel")
        cited.cite(label, code.get("publishedAt") or cited.published.get(_product_key(label)))


def _cited(board: dict[str, Any]) -> _CitedProducts:
    """What the rendered review draws on: every market row it lays out (the US Dollar first in each section) and
    every research entry it prints. The report's Sources line and the Sources panel both read this."""
    cited = _CitedProducts(board)
    rows = [row for row in board.get("rows") or [] if isinstance(row, dict) and row.get("id") != "cpi"]
    dollar = _dollar_row(board.get("usd"))
    for section_id, _label, members in _section_rows(board, rows):
        if members and section_id != "inflation":
            for row in ([dollar] if dollar else []) + members:
                _cite_row(cited, row)
    if isinstance(board.get("research"), dict):
        for block in research_by_section(board).values():
            for market in block["markets"]:
                for entry in market["entries"]:
                    cited.cite(entry.get("product"), cited.published.get(_product_key(entry.get("product"))))
    return cited


def cited_products(board: dict[str, Any]) -> list[dict[str, Any]]:
    """Every Hedgeye product the review cites: id, label and the latest edition read (an instant or a date)."""
    return _cited(board).items() if isinstance(board, dict) else []


def _lines_block(members: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Each market's Kalshi line monitor (gate, graded lines, held lines), passed through for the report to fold."""
    markets = []
    for row in members:
        if not isinstance(row.get("kalshiLines"), dict):
            continue
        levels = _curve_levels(row)
        markets.append({**row["kalshiLines"], "levels": levels} if levels else row["kalshiLines"])
    return {"markets": markets} if markets else None


def _curve_levels(row: dict[str, Any]) -> dict[str, Any] | None:
    """The levels the settlement curve marks: the Alpha Code, and the Risk Range when it is on the price Kalshi settles on
    (not a related instrument's range, such as COMPQ for the Nasdaq-100)."""
    number = lambda value: value if isinstance(value, (int, float)) and not isinstance(value, bool) else None
    levels: dict[str, Any] = {}
    risk_range = row.get("range") or {}
    low, high = number(risk_range.get("low")), number(risk_range.get("high"))
    if low is not None and high is not None and high > low and not row.get("rangePrice") \
            and risk_range.get("fit") != "related-only":
        levels.update({"rangeLow": low, "rangeHigh": high})
        # A range whose top is above the all-time high draws that line blue.
        if ((row.get("structure") or {}).get("allTimeHigh") or {}).get("rangeTopAbove"):
            levels["rangeHighAth"] = True
    code = _alpha_code(row) or {}
    for key in ("trade", "trend"):
        if number(code.get(key)) is not None:
            levels[key] = code[key]
    if "trade" in levels or "trend" in levels:
        levels["approximate"] = bool(code.get("approximate"))
    return levels or None


def _fenced(kind: str, value: dict[str, Any]) -> list[str]:
    return [f"```{kind}", json.dumps(value, ensure_ascii=False, separators=(",", ":")), "```", ""]


def render_setup_board(board: dict[str, Any]) -> str:
    rows = [row for row in board.get("rows") or [] if isinstance(row, dict)]
    cited = _cited(board)
    priced = [row for row in rows if row.get("id") != "cpi"]
    sources = board.get("sources") or {}
    # Boards captured with the morning's products carry Alpha Codes in the range cell and a research block.
    with_research = isinstance(board.get("research"), dict)
    # Boards captured with Risk Range history add higher highs and higher lows before As of.
    sessions = board.get("structureSessions")
    # Boards captured with ETF volume add it after Trend; the report draws it under Tick, Trade and Trend.
    with_volume = isinstance(board.get("volumeWindows"), dict)
    research_blocks = research_by_section(board) if with_research else {}
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
                with_consensus = any("consensus" in forecast for forecast in forecasts)
                rows = []
                for forecast in forecasts:
                    month = re.match(r"^(\d{4})-(\d{2})$", str(forecast.get("reportMonth") or ""))
                    coded = re.search(r"-(\d{2})([A-Z]{3})$", str(forecast.get("eventTicker") or ""))
                    label = (f"{MONTHS[int(month[2]) - 1]} {month[1]}" if month
                             else f"{MONTHS[MONTH_CODES[coded[2]] - 1]} 20{coded[1]}" if coded and coded[2] in MONTH_CODES else NA)
                    published = _pacific_zoned(forecast.get("publishedAt"))
                    # Boards captured with the survey consensus show it where older ones named the Kalshi contract.
                    second = (_number(forecast.get("consensus"), percent=True) if isinstance(forecast.get("consensus"), (int, float)) else NA
                              ) if with_consensus else (
                        _event_label({"eventTicker": forecast.get("eventTicker")}) if forecast.get("eventTicker") else NA)
                    rows.append([f"{cpi.get('label') or 'CPI YoY'} · {label}", second,
                                 *(_number(forecast.get(key), percent=True) if forecast.get("available") else NA
                                   for key in ("lower", "base", "upper")),
                                 published if published != DASH else NA])
                lines += _table(["Market", "Consensus" if with_consensus else "Kalshi", "Low", "Base", "High", "Published"], rows)
            if held := _lines_block(members):
                lines += _fenced("analyst-lines", held)
            continue
        drivers = _driver_block(board, members, label)
        if drivers["volatility"] or drivers.get("correlations"):
            lines += ["```analyst-drivers", json.dumps(drivers, ensure_ascii=False, separators=(",", ":")), "```", ""]
        table = []
        dollar = _dollar_row(board.get("usd"))
        for row in ([dollar] if dollar else []) + members:
            price, tick, trade, risk_range = (row.get(key) or {} for key in ("price", "tick", "trade", "range"))
            trend_product = "Crypto Quant" if risk_range.get("product") == "crypto-quant" else "Risk Ranges"
            breaks = row.get("alphaBreaks") or {}
            trend_break = breaks.get("trend")
            table.append([_market_cell(row), _bias_cell(tick.get("direction")), _bias_cell(trade.get("direction"), breaks.get("trade"), "Trade"),
                          _bias_cell(row.get("trend"), trend_break, "Trend"), *([_volume_cell(row)] if with_volume else []), _range_cell(row),
                          *([_structure_cell(row)] if sessions else []),
                          _as_of_cell(price.get("asOf"), [
                              (tick.get("date"), f"HedgAI {tick.get('ticker') or ''}".strip() if tick else None),
                              (trade.get("date"), trade.get("source")),
                              (_eastern_date(trend_break.get("since")), f"Alpha Code {_number(trend_break.get('level'))}") if trend_break
                              else (risk_range.get("date") if row.get("trend") else None, trend_product if row.get("trend") else None)])])
        lines += _table(["Market", "Tick", "Trade", "Trend", *(["Volume"] if with_volume else []), "Price and Risk Range",
                         *(["Structure"] if sessions else []), "Status"], table)
        # Only a withheld price is noted under the table; the explanatory proxy, inverse-Tick and
        # Kalshi-rule footnotes were removed at Tim's request (2026-11-16).
        notes = []
        for row in members:
            if rejected := row.get("priceRejected"):
                notes.append(f"{row['label']} price withheld: {rejected.get('symbol')} returned "
                             f"{_number(rejected.get('value'))}, inconsistent with its Risk Range.")
        if notes:
            lines += [" ".join(notes), ""]
        # Boards captured with the line monitor fold each market's Kalshi lines under its section's table.
        if monitor := _lines_block(members):
            lines += _fenced("analyst-lines", monitor)
        # Boards captured with sizing show each setup's position and line split under its section's table.
        sizing = _sizing_block(members)
        if sizing:
            lines += ["```analyst-sizing", json.dumps(sizing, ensure_ascii=False, separators=(",", ":")), "```", ""]
        block = research_blocks.get(section_id)
        if block:
            lines += ["```analyst-research", json.dumps(block, ensure_ascii=False, separators=(",", ":")), "```", ""]

    # Boards captured with the Kalshi positions end with the whole book.
    if isinstance(board.get("kalshiBook"), dict):
        lines += ["## Kalshi book", "", *_fenced("analyst-kalshi-book", board["kalshiBook"])]
    # Boards captured with the paper ledger say how the sized tickets have done so far.
    paper = board.get("paper")
    if isinstance(paper, dict) and paper.get("tickets"):
        settled, opened = paper.get("settled") or 0, paper.get("open") or 0
        result = (f"{settled} settled, {paper.get('wonTickets') or 0} won, {paper['returnOnStake'] * 100:+.1f}% on stake after fees"
                  if settled and isinstance(paper.get("returnOnStake"), (int, float)) else "none settled yet")
        lines += [f"Paper tickets: {result}" + (f"; {opened} open." if opened else "."), ""]
    # Hedgeye products as the body cites them, then the CPI publications and the market data feeds.
    dated = [(label, _pacific_zoned(sources.get(key))) for key, label in (
        ("inflationNowcast", "Inflation Nowcast"), ("cpiConsensus", "Trading Economics CPI consensus"))]
    named = (cited.named() + [f"{label} {date}" for label, date in dated if date != DASH]
             + ["HedgAI Signals", "Cboe volatility indices", "Kalshi"])
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
