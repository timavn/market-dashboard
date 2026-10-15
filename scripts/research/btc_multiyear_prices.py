#!/usr/bin/env python3
"""Collect immutable BTC-USD observations and derive complete research intervals.

The original Coinbase 15-minute response bodies are preserved with hashes.
Hourly, New York calendar-day and NYSE-session bars require every constituent
candle. A missing observation is never replaced by a price or zero volume.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, time, timedelta, timezone
import gzip
import hashlib
import json
import math
from pathlib import Path
from urllib.parse import urlencode, urlparse, parse_qs

from btc_nyse_sessions import (CALENDAR_SOURCES, EARLY_CLOSES, EASTERN, SOURCE,
                               normalize_quarter_hour, session_schedule)
from btc_price_history import COINBASE, Downloader, write_json
from btc_usd_features import instant, iso, positive, rejected_provenance

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "artifacts/btc-five-year-study/source-prices"
UTC = timezone.utc
STEP_SECONDS = 900
STEP = timedelta(seconds=STEP_SECONDS)
VALUE_FIELDS = ("open", "high", "low", "close", "volume")
PROVIDER_DOC = "https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles"


def timestamp(value):
    at = instant(value)
    if at.microsecond or int(at.timestamp()) % STEP_SECONDS:
        raise ValueError("Research boundaries must be aligned to 15-minute UTC buckets")
    return int(at.timestamp())


def windows(start, cutoff, step_seconds=STEP_SECONDS, page_size=299):
    first, last = timestamp(start), timestamp(cutoff)
    if first >= last:
        raise ValueError("Research start must precede its cutoff")
    for at in range(first, last, page_size * step_seconds):
        yield at, min(last, at + page_size * step_seconds)


def verify_raw(archive, relative, expected_url=None):
    """Verify original bytes, response identity and request bounds before reuse."""
    archive = Path(archive).resolve()
    path = (archive / relative).resolve()
    if not path.is_relative_to(archive) or not str(relative).startswith("raw/coinbase/"):
        raise ValueError("Invalid archived response path")
    raw = gzip.decompress(path.read_bytes())
    meta = json.loads(path.with_suffix(".metadata.json").read_text())
    url = meta.get("url", "")
    parsed, query = urlparse(url), parse_qs(urlparse(url).query)
    if (meta.get("provider") != "coinbase" or meta.get("httpStatus") != 200
            or meta.get("rawResponse") != relative or meta.get("bodyBytes") != len(raw)
            or meta.get("sha256") != hashlib.sha256(raw).hexdigest()
            or path.name != hashlib.sha256(url.encode()).hexdigest()[:24] + ".json.gz"
            or parsed.scheme != "https" or parsed.netloc != "api.exchange.coinbase.com"
            or parsed.path != "/products/BTC-USD/candles" or query.get("granularity") != ["900"]
            or (expected_url is not None and url != expected_url)):
        raise ValueError("Archived Coinbase response identity or hash mismatch")
    if set(query) != {"granularity", "start", "end"} or any(len(values) != 1 for values in query.values()):
        raise ValueError("Invalid archived Coinbase query")
    received = instant(meta["retrievedAt"])
    first, last = timestamp(query["start"][0]), timestamp(query["end"][0])
    if first >= last or instant(query["end"][0]) > received:
        raise ValueError("Invalid historical Coinbase request times")
    payload = json.loads(raw)
    if not isinstance(payload, list):
        raise ValueError("Coinbase response is not a candle array")
    return payload, meta


def normalize_page(payload, relative, first, last):
    rows, rejected = [], []
    for item in payload:
        try:
            row = normalize_quarter_hour(item, relative)
            at = timestamp(row["startAt"])
            # Coinbase may include buckets outside the requested interval.
            if at < first or at + STEP_SECONDS > last:
                continue
            if not all(math.isfinite(row[key]) for key in VALUE_FIELDS):
                raise ValueError("Non-finite provider observation")
            rows.append(row)
        except (ValueError, TypeError, OverflowError) as error:
            rejected.append({"rawResponse": relative, "reason": str(error)})
    return rows, rejected


def fetch_page(downloader, first, last):
    parameters = {"granularity": 900, "start": iso(datetime.fromtimestamp(first, UTC)),
                  "end": iso(datetime.fromtimestamp(last, UTC))}
    _, relative = downloader.get("coinbase", COINBASE, "/products/BTC-USD/candles", parameters)
    url = COINBASE + "/products/BTC-USD/candles?" + urlencode(sorted(parameters.items()))
    payload, _ = verify_raw(downloader.destination, relative, url)
    return normalize_page(payload, relative, first, last)


def merge_candles(slots, conflicts, rows):
    """Every conflicting timestamp is quarantined, including on gap rechecks."""
    for row in rows:
        at = timestamp(row["startAt"])
        if at in conflicts:
            continue
        prior = slots.get(at)
        if prior and any(prior[key] != row[key] for key in VALUE_FIELDS):
            del slots[at]
            conflicts.add(at)
        elif prior is None or row["rawResponse"] < prior["rawResponse"]:
            slots[at] = row


def missing_runs(slots, first, last, step_seconds=STEP_SECONDS):
    missing = []
    for at in range(first, last, step_seconds):
        if at in slots:
            continue
        if missing and missing[-1][1] == at:
            missing[-1][1] += step_seconds
        else:
            missing.append([at, at + step_seconds])
    return [{"startInclusive": iso(datetime.fromtimestamp(a, UTC)),
             "endExclusive": iso(datetime.fromtimestamp(b, UTC)),
             "intervals": (b - a) // step_seconds} for a, b in missing]


def collect(downloader, start, cutoff, workers=4):
    ranges = list(windows(start, cutoff))
    slots, conflicts, rejected = {}, set(), []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for index, (rows, bad) in enumerate(pool.map(lambda span: fetch_page(downloader, *span), ranges), 1):
            merge_candles(slots, conflicts, rows)
            rejected.extend(bad)
            if index % 50 == 0 or index == len(ranges):
                print(f"Coinbase 15-minute history: {index}/{len(ranges)} pages; {len(slots)} candles", flush=True)
    first, last = timestamp(start), timestamp(cutoff)
    gap_rechecks = []
    for gap in missing_runs(slots, first, last):
        before = len(slots)
        for a, b in windows(gap["startInclusive"], gap["endExclusive"]):
            rows, bad = fetch_page(downloader, a, b)
            merge_candles(slots, conflicts, rows)
            rejected.extend(bad)
        gap_rechecks.append({**gap, "recoveredCandles": len(slots) - before})
    rejected.extend({"startAt": iso(datetime.fromtimestamp(at, UTC)), "reason": "Conflicting provider candles"}
                    for at in sorted(conflicts))
    return slots, {"expectedIntervals": (last - first) // STEP_SECONDS,
                   "observedIntervals": len(slots), "missingIntervals": missing_runs(slots, first, last),
                   "rejected": rejected, "gapRechecks": gap_rechecks}


def calendar_schedule(start, cutoff):
    """Local calendar dates include weekends and actual 23/25-hour DST days."""
    start, cutoff = instant(start), instant(cutoff)
    first, last = start.astimezone(EASTERN).date(), cutoff.astimezone(EASTERN).date()
    complete, incomplete = [], []
    for offset in range((last - first).days + 1):
        day = first + timedelta(days=offset)
        opening = datetime.combine(day, time(), EASTERN).astimezone(UTC)
        closing = datetime.combine(day + timedelta(days=1), time(), EASTERN).astimezone(UTC)
        if opening < start or opening >= cutoff:
            continue
        row = {"sessionDate": day.isoformat(), "startAt": iso(opening), "endAt": iso(closing),
               "expectedCandles": int((closing - opening) / STEP)}
        (complete if closing <= cutoff else incomplete).append(row)
    return complete, incomplete


def hourly_schedule(start, cutoff):
    first, last = timestamp(start), timestamp(cutoff)
    complete, incomplete = [], []
    for at in range(((first + 3599) // 3600) * 3600, last, 3600):
        opening = datetime.fromtimestamp(at, UTC)
        row = {"sessionDate": opening.astimezone(EASTERN).date().isoformat(), "startAt": iso(opening),
               "endAt": iso(opening + timedelta(hours=1)), "expectedCandles": 4}
        (complete if at + 3600 <= last else incomplete).append(row)
    return complete, incomplete


def unverified(row):
    return (rejected_provenance(row) or row.get("source") != SOURCE
            or any(str(row.get(key, "")).lower() == "true" for key in
                   ("mock", "isMock", "seeded", "synthetic", "inferred", "portfolioDerived", "stale", "isStale", "cacheOnly", "cache_only"))
            or str(row.get("providerStatus", "")).lower() in ("offline", "disconnected", "error", "unavailable")
            or row.get("providerConnected") is False
            or row.get("complete") is False or row.get("isComplete") is False)


def aggregate_window(window, slots, interval_id, cutoff):
    first, last = timestamp(window["startAt"]), timestamp(window["endAt"])
    expected = list(range(first, last, STEP_SECONDS))
    if (first >= last or last > timestamp(cutoff) or len(expected) != window["expectedCandles"]):
        return None, "Incomplete or invalid interval boundary"
    if any(at not in slots for at in expected):
        return None, "Missing 15-minute source candles"
    candles = [slots[at] for at in expected]
    for at, row in zip(expected, candles):
        try:
            if (unverified(row) or not row.get("rawResponse") or timestamp(row["startAt"]) != at
                    or timestamp(row["endAt"]) != at + STEP_SECONDS
                    or not all(positive(row.get(key)) for key in ("open", "high", "low", "close"))
                    or not isinstance(row.get("volume"), (int, float)) or isinstance(row["volume"], bool)
                    or not math.isfinite(row["volume"]) or row["volume"] < 0
                    or not row["low"] <= min(row["open"], row["close"]) <= max(row["open"], row["close"]) <= row["high"]):
                return None, "Invalid or unverified source candle"
        except (KeyError, TypeError, ValueError):
            return None, "Invalid source candle timestamp or value"
    opening = instant(window["startAt"])
    return {**window, "hourStart": window["startAt"], "interval": interval_id,
            "timeZone": "America/New_York", "newYorkDay": window["sessionDate"],
            "newYorkStart": opening.astimezone(EASTERN).isoformat(timespec="seconds"),
            "durationHours": (last - first) / 3600, "open": candles[0]["open"], "close": candles[-1]["close"],
            "high": max(row["high"] for row in candles), "low": min(row["low"] for row in candles),
            "volume": math.fsum(row["volume"] for row in candles), "volumeUnit": "BTC",
            "source": SOURCE, "rawResponses": sorted({row["rawResponse"] for row in candles}),
            "candleCount": len(candles), "complete": True, "historical": True, "executable": False}, None


def derive(slots, start, cutoff, interval_id):
    schedule_fn = {"hourly": hourly_schedule, "calendar": calendar_schedule, "nyse": session_schedule}[interval_id]
    scheduled, incomplete = schedule_fn(start, cutoff)
    rows, missing = [], []
    for window in scheduled:
        row, reason = aggregate_window(window, slots, interval_id, cutoff)
        if row is not None:
            rows.append(row)
        else:
            missing.append({**window, "reason": reason})
    return rows, {"expectedIntervals": len(scheduled), "observedIntervals": len(rows),
                  "missingIntervalCount": len(missing), "missingIntervals": missing,
                  "incompleteIntervals": len(incomplete), "incompleteIntervalDetails": incomplete}


def verify_archive(archive):
    """Offline byte-level replay; normalized artifacts must exactly match raw data.

    Returns (quarter-hour slots keyed by UTC epoch seconds, document metadata).
    The historical collector's timestamp remains unchanged during verification.
    """
    archive = Path(archive)
    manifest = json.loads((archive / "fetch-manifest.json").read_text())
    document = json.loads((archive / "candles-15m.json").read_text())
    identity = ("schemaVersion", "source", "provider", "productId", "historical", "executable",
                "startInclusive", "studyStartInclusive", "cutoff", "asOf", "warmupDays", "providerDocumentation")
    if (any(document.get(key) != manifest.get(key) for key in identity)
            or document.get("schemaVersion") != 1 or document.get("source") != SOURCE
            or document.get("provider") != "Coinbase Exchange" or document.get("productId") != "BTC-USD"
            or document.get("historical") is not True or document.get("executable") is not False
            or document.get("granularitySeconds") != STEP_SECONDS or unverified(document)
            or document.get("providerDocumentation") != PROVIDER_DOC):
        raise ValueError("Invalid archived price document identity")
    first, last = timestamp(document["startInclusive"]), timestamp(document["cutoff"])
    if first >= last or instant(document["asOf"]) < instant(document["cutoff"]):
        raise ValueError("Invalid archived price document bounds")
    requests = manifest.get("requests")
    if not isinstance(requests, list) or not requests:
        raise ValueError("Archived price manifest has no requests")
    slots, conflicts, rejected = {}, set(), []
    for request in requests:
        payload, meta = verify_raw(archive, request["rawResponse"], request["url"])
        if any(request.get(key) != meta.get(key) for key in
               ("url", "provider", "retrievedAt", "httpStatus", "httpDate", "sha256", "rawResponse", "bodyBytes")):
            raise ValueError("Manifest request does not match archived response metadata")
        query = parse_qs(urlparse(meta["url"]).query)
        a, b = timestamp(query["start"][0]), timestamp(query["end"][0])
        if a < first or b > last or instant(meta["retrievedAt"]) > instant(document["asOf"]):
            raise ValueError("Archived request is outside the collection window")
        rows, bad = normalize_page(payload, request["rawResponse"], a, b)
        merge_candles(slots, conflicts, rows)
        rejected.extend(bad)
    rejected.extend({"startAt": iso(datetime.fromtimestamp(at, UTC)), "reason": "Conflicting provider candles"}
                    for at in sorted(conflicts))
    coverage = document.get("coverage", {})
    if (document.get("rows") != [slots[at] for at in sorted(slots)]
            or coverage != manifest.get("coverage", {}).get("15m")
            or coverage.get("expectedIntervals") != (last - first) // STEP_SECONDS
            or coverage.get("observedIntervals") != len(slots)
            or coverage.get("missingIntervalCount") != (last - first) // STEP_SECONDS - len(slots)
            or coverage.get("missingIntervals") != missing_runs(slots, first, last)
            or sorted(coverage.get("rejected", []), key=lambda row: json.dumps(row, sort_keys=True))
               != sorted(rejected, key=lambda row: json.dumps(row, sort_keys=True))):
        raise ValueError("Normalized candles or coverage do not match original Coinbase responses")
    for interval_id, filename in (("hourly", "hourly.json"), ("calendar", "calendar-days.json"), ("nyse", "nyse-sessions.json")):
        saved = json.loads((archive / filename).read_text())
        rows, expected_coverage = derive(slots, document["startInclusive"], document["cutoff"], interval_id)
        if (any(saved.get(key) != document.get(key) for key in identity)
                or saved.get("interval") != interval_id or saved.get("timeZone") != "America/New_York"
                or saved.get("rows") != rows or saved.get("coverage") != expected_coverage
                or manifest.get("coverage", {}).get(interval_id) != expected_coverage
                or saved.get("calendarSources") != (CALENDAR_SOURCES if interval_id == "nyse" else [])
                or saved.get("earlyCloseDates") != (sorted(EARLY_CLOSES) if interval_id == "nyse" else [])):
            raise ValueError(f"Derived {interval_id} archive does not match original Coinbase responses")
    return slots, {**{key: value for key, value in document.items() if key != "rows"},
                   "calendarSources": CALENDAR_SOURCES, "verifiedRequests": len(requests)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--study-start", default="2021-09-15T00:00:00Z")
    parser.add_argument("--cutoff", default="2026-09-15T18:00:00Z")
    parser.add_argument("--warmup-days", type=int, default=60)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    if not 0 <= args.warmup_days <= 366 or not 1 <= args.workers <= 4:
        raise ValueError("Invalid warmup or worker limit")
    start = iso(instant(args.study_start) - timedelta(days=args.warmup_days))
    downloader = Downloader(args.output, requests_per_second=4)
    slots, candle_coverage = collect(downloader, start, args.cutoff, args.workers)
    as_of = iso(datetime.now(UTC))
    metadata = {"schemaVersion": 1, "source": SOURCE, "provider": "Coinbase Exchange", "productId": "BTC-USD",
                "historical": True, "executable": False, "startInclusive": start,
                "studyStartInclusive": args.study_start, "cutoff": args.cutoff, "asOf": as_of,
                "warmupDays": args.warmup_days, "providerDocumentation": PROVIDER_DOC}
    candle_coverage["missingIntervalCount"] = candle_coverage["expectedIntervals"] - len(slots)
    write_json(args.output / "candles-15m.json", {**metadata, "granularitySeconds": 900,
               "rows": [slots[at] for at in sorted(slots)], "coverage": candle_coverage})
    coverage = {"15m": candle_coverage}
    for interval_id, filename in (("hourly", "hourly.json"), ("calendar", "calendar-days.json"), ("nyse", "nyse-sessions.json")):
        rows, interval_coverage = derive(slots, start, args.cutoff, interval_id)
        coverage[interval_id] = interval_coverage
        write_json(args.output / filename, {**metadata, "interval": interval_id, "timeZone": "America/New_York",
                   "calendarSources": CALENDAR_SOURCES if interval_id == "nyse" else [],
                   "earlyCloseDates": sorted(EARLY_CLOSES) if interval_id == "nyse" else [],
                   "rows": rows, "coverage": interval_coverage})
    # Requests retain their original observation/retrieval times when archives are reused.
    write_json(args.output / "fetch-manifest.json", {**metadata, "requests": sorted(downloader.requests, key=lambda row: row["url"]),
               "calendarSources": CALENDAR_SOURCES, "coverage": coverage,
               "inputsAndScripts": [{"path": str(path.relative_to(ROOT)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                   for path in (Path(__file__), ROOT / "scripts/research/btc_nyse_sessions.py",
                                ROOT / "scripts/research/btc_price_history.py", ROOT / "src/utils/usEquityMarketCalendar.cjs")]})
    print(json.dumps({key: {name: value for name, value in item.items() if name in
                           ("expectedIntervals", "observedIntervals", "missingIntervalCount", "incompleteIntervals")}
                      for key, item in coverage.items()}, indent=2), flush=True)


if __name__ == "__main__":
    main()
