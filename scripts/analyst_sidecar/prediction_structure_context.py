"""Dated supporting facts from one prediction-review capture, never live quotes."""

from datetime import date, datetime, timezone
import math
import re
from zoneinfo import ZoneInfo


_BAD_FLAGS = ("stale", "isStale", "mock", "isMock", "seed", "seeded", "isSeed", "isSeeded",
              "cacheOnly", "cachedOnly", "cache_only", "fromCache", "from_cache", "cached",
              "offline", "disconnected", "refreshFailed", "refreshRetained", "fallback",
              "synthetic", "inferred", "modelOnly", "testOnly")
_BAD_TEXT = re.compile(r"stale|cache|mock|seed|offline|disconnect|fail|error|synthetic|inferred|fallback|model|provisional", re.I)
_WINDOWS = {"priorDay": 1, "avg1M": 21, "avg3M": 60, "avg1Y": 250}


def _obj(value):
    return value if isinstance(value, dict) else {}


def _number(value):
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def _day(value):
    try:
        return date.fromisoformat(value) if isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) else None
    except ValueError:
        return None


def _time(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if _day(value):
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc) if parsed.tzinfo else None
    except (ValueError, TypeError):
        return None


def _safe(value):
    value = _obj(value)
    if (any(value.get(flag) in (True, "true") for flag in _BAD_FLAGS)
            or _obj(value.get("_cache")).get("hit") is True or _obj(value.get("_cache")).get("stale") is True
            or any(value.get(flag) is False for flag in ("verified", "sourceVerified", "connected", "providerConnected"))
            or any(_BAD_TEXT.search(str(value.get(key) or "")) for key in
                   ("source", "sourceStatus", "status", "freshness", "cacheState", "provenance"))):
        return False
    return all(_safe(value[key]) for key in ("meta", "metadata", "providerStatus") if isinstance(value.get(key), dict))


def _factor(value, cutoff, market_day, *, historical=False):
    value = _obj(value)
    if not value.get("source") or not _safe(value):
        return None
    observed = _time(value.get("asOf"))
    if not observed or observed > cutoff:
        return None
    if any(value.get(key) is not None and _day(value[key]) is None for key in ("date", "historicalThroughDate")):
        return None
    reading_day = _day(value.get("date") or value.get("historicalThroughDate"))
    if not reading_day:
        reading_day = _day(value.get("asOf")) or observed.astimezone(ZoneInfo("America/New_York")).date()
    if reading_day > market_day:
        return None
    expires = _time(value.get("expiresAt"))
    if value.get("status") == "historical" and historical:
        if (value.get("availability") not in {"historical", "last_close"}
                or _day(value.get("historicalThroughDate")) != market_day
                or (value.get("expiresAt") is not None and (not expires or expires <= cutoff))):
            return None
    elif value.get("status") != "available" or not expires or expires <= cutoff:
        return None
    return reading_day.isoformat()


def _format(value, places=2, signed=False):
    return f"{value:+,.{places}f}" if signed else f"{value:,.{places}f}"


def prediction_structure_context(snapshot, *, as_of, market_date, market_volume=None):
    """Project independently verified factors as captured, with original source dates."""
    rows, paragraphs, sources = [], [], []
    empty = {"rows": [["SPX / dollar correlation", "—", None], ["SPY volume (ETF proxy)", "—", None]],
             "paragraphs": [], "sources": []}
    cutoff, market_day = _time(as_of), _day(market_date)
    if not cutoff or not market_day or market_day > cutoff.astimezone(ZoneInfo("America/New_York")).date():
        return empty
    factors = _obj(_obj(snapshot).get("factors")) if _safe(snapshot) and _obj(snapshot).get("marketId", "sp500") == "sp500" else {}

    def add(label, reading, day, factor):
        rows.append([label, reading, day])
        sources.append({"label": label, "source": factor["source"], "asOf": factor["asOf"], "date": day,
                        "excerpt": f"{label}: {reading}. Reading date: {day}."})

    usd = _obj(factors.get("usd"))
    usd_day = _factor(usd, cutoff, market_day)
    windows = [(label, _number(usd.get(key))) for label, key in (("15D", "r15"), ("30D", "r30"), ("90D", "r90"))]
    windows = [(label, value if value is not None and abs(value) <= 1 else None) for label, value in windows]
    if usd_day and usd.get("sourceStatus") == "current" and any(value is not None for _, value in windows):
        add("SPX / dollar correlation", " · ".join(f"{label} {_format(value, 3, True) if value is not None else '—'}"
                                                   for label, value in windows), usd_day, usd)
        signs = {1 if value > 0 else -1 for _, value in windows if value is not None and value != 0}
        if len(signs) > 1:
            paragraphs.append("The SPX/dollar relationship changes sign across the reported windows, so it does not confirm a single S&P direction.")
        elif signs:
            paragraphs.append("SPX and the dollar moved in " + ("the same direction" if 1 in signs else "opposite directions")
                              + " across the reported correlation windows.")
    else:
        rows.append(["SPX / dollar correlation", "—", None])

    dxy = _obj(factors.get("dxy"))
    dxy_day = _factor(dxy, cutoff, market_day, historical=True)
    dxy_value = _number(dxy.get("value"))
    if dxy_day and dxy_value is not None and dxy_value > 0:
        reading = _format(dxy_value) + (" · last close" if dxy.get("status") == "historical" else "")
        for key, label in (("fifteenDayChangePercent", "15D"), ("thirtyDayChangePercent", "30D")):
            change = _number(dxy.get(key))
            if change is not None:
                reading += f" · {label} {_format(change, 2, True)}%"
        add("Dollar index", reading, dxy_day, dxy)

    volume = _obj(factors.get("spyVolume"))
    volume_day = _factor(volume, cutoff, market_day, historical=True)
    ratio, current, average = (_number(volume.get(key)) for key in ("ratio", "currentVolume", "average20"))
    if (volume_day and volume.get("source") == "ibkr_historical_bars" and volume.get("comparisonSessions") == 20
            and ratio is not None and ratio >= 0 and current is not None and current >= 0
            and average is not None and average > 0 and math.isclose(ratio, current / average, rel_tol=1e-6, abs_tol=1e-8)):
        completed = volume.get("status") == "historical"
        baseline = "20-session average" if completed else "20-session average at the same time"
        add("SPY volume (ETF proxy)", f"{_format(ratio)}× {baseline}", volume_day, volume)
        clock = _time(volume["asOf"]).astimezone(ZoneInfo("America/Los_Angeles")).strftime("%H:%M %Z")
        period = "Completed-session" if completed else f"Through {clock},"
        paragraphs.append(f"{period} SPY ETF volume was {_format(current, 0)} shares versus {_format(average, 0)} "
                          f"for the {baseline}. SPY is the ETF proxy for S&P participation.")
    else:
        rows.append(["SPY volume (ETF proxy)", "—", None])

    for key, label in (("vix", "VIX"), ("vvix", "VVIX")):
        factor = _obj(factors.get(key))
        reading_day = _factor(factor, cutoff, market_day, historical=True)
        value = _number(factor.get("value"))
        if reading_day and value is not None and value > 0:
            add(label, _format(value) + (" · last close" if factor.get("status") == "historical" else ""), reading_day, factor)

    cftc = _obj(factors.get("cftc"))
    cftc_day = _factor(cftc, cutoff, market_day)
    net, weekly = _number(cftc.get("latest")), _number(cftc.get("weeklyChange"))
    if (cftc_day and cftc.get("source") == "cftc-public-reporting-environment"
            and cftc.get("contractCode") == "13874A" and cftc.get("seriesType") == "legacy-noncommercial-combined"
            and net is not None):
        reading = f"Net {_format(net, 0, True)} contracts"
        if weekly is not None:
            reading += f" · weekly {_format(weekly, 0, True)}"
        add("SPX noncommercial futures", reading, cftc_day, cftc)

    _market_volume_context(market_volume, cutoff, market_day, rows, paragraphs, sources)
    return {"rows": rows, "paragraphs": paragraphs, "sources": sources}


def _market_volume_context(value, cutoff, market_day, rows, paragraphs, sources):
    value = _obj(value)
    meta, metrics = _obj(value.get("meta")), _obj(_obj(value.get("metrics")).get("exchange"))
    fetched = _time(meta.get("fetchedAt"))
    roster = value.get("totalExchange")
    if (not all(_safe(item) for item in (value, meta, metrics)) or meta.get("status") != "current"
            or meta.get("verified") is not True or meta.get("provider") != "Cboe"
            or meta.get("sourceType") != "cboe-consolidated-volume"
            or meta.get("methodologyVersion") != "cboe-consolidated-exchange-volume-v2"
            or any(_day(day) != market_day for day in (value.get("asOf"), meta.get("asOfTradingDate"), meta.get("expectedTradingDate")))
            or not fetched or not 0 <= (cutoff - fetched).total_seconds() <= 1200
            or meta.get("comparisonWindows") != _WINDOWS or not isinstance(roster, list) or not roster
            or _day(_obj(roster[0]).get("date")) != market_day or not all(_safe(row) for row in roster)
            or not any(_obj(source).get("id") == "cboeConsolidatedVolume" and _obj(source).get("provider") == "Cboe"
                       and _obj(source).get("dataset") == "Historical Market Volume" and _safe(source)
                       for source in meta.get("sourceBreakdown") or [])):
        return
    current = _number(_obj(roster[0]).get("volume"))
    if current is None or current <= 0 or _number(metrics.get("priorDay")) != current:
        return
    entries = []
    for key, label, baseline_key in (("pctPriorDay", "prior session", None), ("pct1M", "21-session average", "avg1M"),
                                     ("pct3M", "60-session average", "avg3M"), ("pct1Y", "250-session average", "avg1Y")):
        percent = _number(metrics.get(key))
        baseline = _number(metrics.get(baseline_key)) if baseline_key else _number(_obj(roster[1]).get("volume")) if len(roster) > 1 else None
        if (percent is not None and baseline is not None and baseline > 0
                and math.isclose(percent, (current / baseline - 1) * 100, rel_tol=1e-6, abs_tol=1e-6)):
            entries.append([f"U.S. volume vs {label}", f"{_format(percent, 2, True)}%", market_day.isoformat()])
    if not entries:
        return
    rows.extend(entries)
    paragraphs.append(f"U.S. consolidated volume was {_format(current, 0)} shares, including exchange and FINRA-reported trades in listed stocks.")
    changes = [float(row[1].replace('%', '').replace(',', '')) for row in entries]
    if all(change > 0 for change in changes):
        paragraphs[-1] += " Participation was above every reported comparison; this measures activity, without establishing buying or selling pressure."
    elif all(change < 0 for change in changes):
        paragraphs[-1] += " Participation was below every reported comparison, indicating lighter activity behind price moves."
    else:
        paragraphs[-1] += " Participation is mixed across the comparison windows; evaluate it alongside price direction."
    sources.append({"label": "U.S. market volume", "source": "Cboe Historical Market Volume", "asOf": meta["fetchedAt"],
                    "date": market_day.isoformat(),
                    "excerpt": f"Session {market_day.isoformat()}; {_format(current, 0)} consolidated shares. "
                               + "; ".join(f"{row[0]}: {row[1]}" for row in entries)})
