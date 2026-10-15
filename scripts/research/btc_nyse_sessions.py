#!/usr/bin/env python3
"""Verified BTC spot candles grouped into completed New York equity sessions.

Uses the shared US equity holiday calendar and archived Coinbase 15-minute
candles. These are historical BTC observations, never NYSE-traded BTC quotes.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, time, timedelta, timezone
import json
import math
from pathlib import Path
import subprocess
from zoneinfo import ZoneInfo

from btc_price_history import COINBASE, Downloader, number, write_json
from btc_usd_features import instant, iso, positive, rejected_provenance

ROOT = Path(__file__).resolve().parents[2]
EASTERN = ZoneInfo("America/New_York")
UTC = timezone.utc
STEP = timedelta(minutes=15)
SOURCE = "coinbase_exchange_public_15minute_candles"
DEFAULT_OUTPUT = ROOT / "artifacts/btc-interval-experiment/source-sessions"
CALENDAR_SOURCES = [
    "https://www.nyse.com/trade/hours-calendars",
    "https://ir.theice.com/press/news-details/2020/NYSE-Group-Announces-2021-2022-and-2023-Holiday-and-Early-Closings-Calendar/default.aspx",
    "https://s2.q4cdn.com/154085107/files/doc_news/NYSE-Group-Announces-2022-2023-and-2024-Holiday-and-Early-Closings-Calendar-2021.pdf",
    "https://s2.q4cdn.com/154085107/files/doc_news/NYSE-Group-Announces-2023-2024-and-2025-Holiday-and-Early-Closings-Calendar-2022.pdf",
    "https://www.nyse.com/publicdocs/ICE_NYSE_2025_Yearly_Trading_Calendar.pdf",
    "https://ir.theice.com/press/news-details/2024/The-New-York-Stock-Exchange-Will-Close-Markets-on-January-9-to-Honor-the-Passing-of-Former-President-Jimmy-Carter-on-National-Day-of-Mourning/default.aspx",
]
# Published shortened sessions for the supported, frozen research window.
EARLY_CLOSES = {"2021-11-26", "2022-11-25", "2023-07-03", "2023-11-24",
                "2024-07-03", "2024-11-29", "2024-12-24",
                "2025-07-03", "2025-11-28", "2025-12-24", "2026-11-27", "2026-12-24"}


def holidays_for_years(years):
    script = "const c=require('./src/utils/usEquityMarketCalendar.cjs'); console.log(JSON.stringify(JSON.parse(process.argv[1]).flatMap(y=>c.usEquityMarketHolidays(y))))"
    result = subprocess.check_output(["node", "-e", script, json.dumps(list(years))], cwd=ROOT, text=True)
    return {row["date"] for row in json.loads(result)}


def session_schedule(start, cutoff, holidays=None):
    """Return completed and in-progress sessions; never manufacture a partial day."""
    start, cutoff = instant(start), instant(cutoff)
    first, last = start.astimezone(EASTERN).date(), cutoff.astimezone(EASTERN).date()
    if first.year < 2021 or last.year > 2026:
        raise ValueError("Published early-close calendar supports 2021–2026 only")
    if holidays is None:
        holidays = holidays_for_years(range(first.year, last.year + 1))
    completed, incomplete = [], []
    for offset in range((last - first).days + 1):
        day = first + timedelta(days=offset)
        if day.weekday() >= 5 or day.isoformat() in holidays:
            continue
        opening = datetime.combine(day, time(9, 30), EASTERN).astimezone(UTC)
        closing = datetime.combine(day, time(13 if day.isoformat() in EARLY_CLOSES else 16), EASTERN).astimezone(UTC)
        if opening < start or opening >= cutoff:
            continue
        row = {"sessionDate": day.isoformat(), "startAt": iso(opening), "endAt": iso(closing),
               "timeZone": "America/New_York", "earlyClose": day.isoformat() in EARLY_CLOSES,
               "expectedCandles": int((closing - opening) / STEP)}
        (completed if closing <= cutoff else incomplete).append(row)
    return completed, incomplete


def normalize_quarter_hour(candle, raw_response):
    if not isinstance(candle, list) or len(candle) != 6:
        raise ValueError("Unexpected Coinbase candle schema")
    timestamp = number(candle[0])
    if timestamp != int(timestamp) or int(timestamp) % 900:
        raise ValueError("Candle is not aligned to a quarter hour")
    low, high, opening, close = [number(value, positive=True) for value in candle[1:5]]
    volume = number(candle[5])
    if volume < 0 or not low <= opening <= high or not low <= close <= high or not raw_response:
        raise ValueError("Invalid candle or missing original response")
    start = datetime.fromtimestamp(int(timestamp), UTC)
    return {"startAt": iso(start), "endAt": iso(start + STEP), "open": float(opening),
            "high": float(high), "low": float(low), "close": float(close), "volume": float(volume),
            "source": SOURCE, "rawResponse": raw_response}


def aggregate_session(session, candles, cutoff):
    start, end = instant(session["startAt"]), instant(session["endAt"])
    if end > instant(cutoff):
        return None, "Incomplete NYSE session"
    slots = {}
    for candle in candles:
        try:
            at, until = instant(candle["startAt"]), instant(candle["endAt"])
            if at < start or at >= end:
                continue
            if (until - at != STEP or at.minute % 15 or at.second or at.microsecond
                    or rejected_provenance(candle) or candle.get("complete") is False
                    or candle.get("isComplete") is False or not candle.get("source")
                    or not candle.get("rawResponse")
                    or not all(positive(candle.get(key)) for key in ("open", "high", "low", "close"))
                    or not isinstance(candle.get("volume"), (int, float)) or isinstance(candle.get("volume"), bool)
                    or not math.isfinite(candle["volume"]) or candle["volume"] < 0):
                return None, "Invalid or unverified session candle"
            if not float(candle["low"]) <= min(float(candle["open"]), float(candle["close"])) <= max(float(candle["open"]), float(candle["close"])) <= float(candle["high"]):
                return None, "Invalid session candle extrema"
            prior = slots.get(at)
            if prior and any(prior[key] != candle[key] for key in ("open", "high", "low", "close", "volume")):
                return None, "Conflicting duplicate session candle"
            slots[at] = candle
        except (KeyError, ValueError, TypeError):
            return None, "Invalid session candle timestamp"
    expected = [start + index * STEP for index in range(int((end - start) / STEP))]
    if not expected or set(slots) != set(expected):
        return None, "Missing 15-minute session candles"
    ordered = [slots[at] for at in expected]
    return {**session, "open": ordered[0]["open"], "close": ordered[-1]["close"],
            "high": max(row["high"] for row in ordered), "low": min(row["low"] for row in ordered),
            "volume": sum(row["volume"] for row in ordered), "source": SOURCE,
            "rawResponses": sorted({row["rawResponse"] for row in ordered}),
            "candleCount": len(ordered), "historical": True, "executable": False}, None


def collect_session(downloader, session, cutoff):
    payload, raw = downloader.get("coinbase", COINBASE, "/products/BTC-USD/candles", {
        "granularity": 900, "start": session["startAt"], "end": session["endAt"],
    })
    if not isinstance(payload, list):
        return None, {**session, "reason": "Coinbase response is not a candle array"}
    candles = []
    for item in payload:
        try:
            candles.append(normalize_quarter_hour(item, raw))
        except (ValueError, TypeError):
            return None, {**session, "reason": "Invalid provider candle", "rawResponse": raw}
    row, reason = aggregate_session(session, candles, cutoff)
    return row, {**session, "reason": reason, "rawResponse": raw} if reason else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", default="2025-07-28T00:00:00Z")
    parser.add_argument("--cutoff", default="2026-09-15T18:00:00Z")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    sessions, incomplete = session_schedule(args.start, args.cutoff)
    downloader = Downloader(args.output)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda session: collect_session(downloader, session, args.cutoff), sessions))
    rows = [row for row, _ in results if row]
    rejected = [reason for _, reason in results if reason]
    document = {"schemaVersion": 1, "historical": True, "executable": False, "source": SOURCE,
                "productId": "BTC-USD", "timeZone": "America/New_York", "startInclusive": args.start,
                "cutoff": args.cutoff, "asOf": iso(datetime.now(UTC)), "granularitySeconds": 900,
                "calendarSources": CALENDAR_SOURCES, "earlyCloseDates": sorted(EARLY_CLOSES),
                "expectedSessions": len(sessions), "incompleteSessions": incomplete, "rows": rows, "rejected": rejected}
    write_json(args.output / "sessions.json", document)
    write_json(args.output / "fetch-manifest.json", {"requests": downloader.requests, "calendarSources": CALENDAR_SOURCES,
               "startAt": args.start, "cutoff": args.cutoff, "observedSessions": len(rows), "missingSessions": len(rejected)})
    print(json.dumps({"observedSessions": len(rows), "expectedSessions": len(sessions), "missingSessions": len(rejected), "incompleteSessions": len(incomplete)}))


if __name__ == "__main__":
    main()
