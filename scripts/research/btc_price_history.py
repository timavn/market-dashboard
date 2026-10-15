#!/usr/bin/env python3
"""Download auditable, historical BTC candles and finalized Kalshi settlements.

This research archive never supplies executable quotes or fills missing prices.
Raw successful provider bodies are gzip-compressed without changing their JSON.
Reruns reuse those immutable responses, retaining the original retrieval time.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from decimal import Decimal, InvalidOperation
import gzip
import hashlib
import json
from pathlib import Path
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

UTC = timezone.utc
HOUR = 3600
COINBASE = "https://api.exchange.coinbase.com"
KALSHI = "https://api.elections.kalshi.com/trade-api/v2"
PRICE_SOURCE = "coinbase_exchange_public_hourly_candles"
SETTLEMENT_SOURCE = "kalshi_published_finalized_expiration_value"


def parse_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def iso(value):
    if isinstance(value, (int, float)):
        value = datetime.fromtimestamp(value, UTC)
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def number(value, positive=False):
    if isinstance(value, bool) or value is None:
        raise ValueError("Invalid numeric observation")
    try:
        result = Decimal(str(value))
    except InvalidOperation as exc:
        raise ValueError("Invalid numeric observation") from exc
    if not result.is_finite() or (positive and result <= 0):
        raise ValueError("Invalid numeric observation")
    return result


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    temporary.replace(path)


class Downloader:
    def __init__(self, destination, requests_per_second=4):
        self.destination = destination
        self.interval = 1 / requests_per_second
        self.lock = threading.Lock()
        self.next_request = 0
        self.requests = []

    def get(self, provider, base, path, parameters):
        query = urllib.parse.urlencode(sorted(parameters.items()))
        url = base + path + ("?" + query if query else "")
        key = hashlib.sha256(url.encode()).hexdigest()[:24]
        relative = Path("raw") / provider / (key + ".json.gz")
        raw_path = self.destination / relative
        meta_path = raw_path.with_suffix(".metadata.json")
        if raw_path.exists() and meta_path.exists():
            raw = gzip.decompress(raw_path.read_bytes())
            metadata = json.loads(meta_path.read_text())
            if hashlib.sha256(raw).hexdigest() != metadata["sha256"]:
                raise ValueError(f"Archive digest mismatch: {relative}")
            metadata = {**metadata, "reusedArchive": True}
        else:
            for attempt in range(8):
                with self.lock:
                    wait = max(0, self.next_request - time.monotonic())
                    self.next_request = max(time.monotonic(), self.next_request) + self.interval
                if wait:
                    time.sleep(wait)
                request = urllib.request.Request(url, headers={
                    "User-Agent": "market-dashboard-btc-hourly-research/1.0",
                    "Accept": "application/json", "Accept-Encoding": "gzip",
                })
                try:
                    with urllib.request.urlopen(request, timeout=35) as response:
                        raw = response.read()
                        if response.headers.get("Content-Encoding") == "gzip":
                            raw = gzip.decompress(raw)
                        metadata = {
                            "url": url, "provider": provider, "retrievedAt": iso(datetime.now(UTC)),
                            "httpStatus": response.status, "httpDate": response.headers.get("Date"),
                            "sha256": hashlib.sha256(raw).hexdigest(), "rawResponse": str(relative),
                            "bodyBytes": len(raw), "reusedArchive": False,
                        }
                    json.loads(raw)  # Never archive malformed JSON as a usable response.
                    raw_path.parent.mkdir(parents=True, exist_ok=True)
                    raw_path.write_bytes(gzip.compress(raw, compresslevel=6, mtime=0))
                    write_json(meta_path, metadata)
                    break
                except (urllib.error.URLError, TimeoutError, OSError) as exc:
                    retryable = not isinstance(exc, urllib.error.HTTPError) or exc.code in (408, 429, 500, 502, 503, 504)
                    if not retryable or attempt == 7:
                        raise
                    delay = min(30, 2 ** attempt)
                    if isinstance(exc, urllib.error.HTTPError):
                        try:
                            delay = max(delay, float(exc.headers.get("Retry-After", 0)))
                        except ValueError:
                            pass
                    print(f"{provider}: retry {attempt + 1} after {type(exc).__name__}; waiting {delay}s", flush=True)
                    time.sleep(delay)
        with self.lock:
            self.requests.append(metadata)
        return json.loads(raw), str(relative)


def normalize_candle(candle, start_ts, end_ts, raw_response):
    if not isinstance(candle, list) or len(candle) != 6:
        raise ValueError("Unexpected Coinbase candle schema")
    timestamp = number(candle[0])
    if timestamp != int(timestamp) or int(timestamp) % HOUR:
        raise ValueError("Candle is not aligned to a UTC hour")
    timestamp = int(timestamp)
    if timestamp < start_ts or timestamp + HOUR > end_ts:
        return None
    low, high, opening, close = [number(item, positive=True) for item in candle[1:5]]
    volume = number(candle[5])
    if volume < 0 or not low <= opening <= high or not low <= close <= high:
        raise ValueError("Invalid OHLC relationship")
    return {
        "startAt": iso(timestamp), "endAt": iso(timestamp + HOUR),
        "open": float(opening), "high": float(high), "low": float(low), "close": float(close),
        "volume": float(volume), "source": PRICE_SOURCE, "rawResponse": raw_response,
    }


def missing_runs(actual, first, last, step=HOUR):
    missing = [ts for ts in range(first, last, step) if ts not in actual]
    runs = []
    for timestamp in missing:
        if runs and runs[-1][1] == timestamp:
            runs[-1][1] += step
        else:
            runs.append([timestamp, timestamp + step])
    return [{"startInclusive": iso(start), "endExclusive": iso(end), "hours": (end - start) // step}
            for start, end in runs]


def load_candles(downloader, start_ts, end_ts):
    by_time = {}
    rejected = []
    chunks = 0
    for chunk_start in range(start_ts, end_ts, 299 * HOUR):
        chunk_end = min(end_ts, chunk_start + 299 * HOUR)
        payload, raw = downloader.get("coinbase", COINBASE, "/products/BTC-USD/candles", {
            "granularity": HOUR, "start": iso(chunk_start), "end": iso(chunk_end),
        })
        if not isinstance(payload, list):
            raise ValueError("Coinbase response is not a candle array")
        for candle in payload:
            try:
                row = normalize_candle(candle, chunk_start, chunk_end, raw)
                if row is None:
                    continue
                existing = by_time.get(row["startAt"])
                if existing and any(existing[key] != row[key] for key in ("open", "high", "low", "close", "volume")):
                    raise ValueError("Conflicting duplicate candle")
                by_time[row["startAt"]] = row
            except ValueError as exc:
                rejected.append({"rawResponse": raw, "candle": candle, "reason": str(exc)})
        chunks += 1
        if chunks % 10 == 0:
            print(f"Coinbase: {chunks} pages; {len(by_time)} complete candles", flush=True)
    actual = {int(parse_time(timestamp).timestamp()) for timestamp in by_time}
    gap_rechecks = []
    for gap in missing_runs(actual, start_ts, end_ts):
        payload, raw = downloader.get("coinbase", COINBASE, "/products/BTC-USD/candles", {
            "granularity": HOUR, "start": gap["startInclusive"], "end": gap["endExclusive"],
        })
        if not isinstance(payload, list):
            raise ValueError("Coinbase gap recheck is not a candle array")
        gap_start = int(parse_time(gap["startInclusive"]).timestamp())
        gap_end = int(parse_time(gap["endExclusive"]).timestamp())
        recovered = 0
        for candle in payload:
            try:
                row = normalize_candle(candle, gap_start, gap_end, raw)
                if row is not None:
                    by_time[row["startAt"]] = row
                    actual.add(int(parse_time(row["startAt"]).timestamp()))
                    recovered += 1
            except ValueError as exc:
                rejected.append({"rawResponse": raw, "candle": candle, "reason": str(exc)})
        gap_rechecks.append({**gap, "rawResponse": raw, "recoveredHours": recovered})
        chunks += 1
    return {"rows": sorted(by_time.values(), key=lambda row: row["startAt"]), "rejected": rejected,
            "coverage": {"expectedHours": (end_ts - start_ts) // HOUR, "observedHours": len(by_time),
                         "missingIntervals": missing_runs(actual, start_ts, end_ts), "pages": chunks,
                         "gapRechecks": gap_rechecks}}


def inspect_settlement(market, start_ts, end_ts):
    if not isinstance(market, dict):
        raise ValueError("Market is not an object")
    close_ts = int(parse_time(market["close_time"]).timestamp())
    if close_ts < start_ts or close_ts > end_ts:
        return None
    if not str(market.get("event_ticker", "")).startswith("KXBTCD-"):
        raise ValueError("Wrong market identity")
    if market.get("status") not in ("finalized", "settled") or market.get("is_provisional") is True:
        raise ValueError("Market settlement is not final")
    value = number(market.get("expiration_value"), positive=True)
    rules = " ".join((market.get("rules_primary", ""), market.get("rules_secondary", "")))
    if not re.search(r"\bBRTI\b|Bitcoin Real.Time Index", rules, re.I):
        raise ValueError("No verified BRTI rule")
    if not re.search(r"\b(sixty|60)\b", rules, re.I) or not re.search(r"averag", rules, re.I):
        raise ValueError("No verified 60-observation averaging rule")
    if close_ts % HOUR:
        raise ValueError("Settlement is not at a UTC hour")
    return close_ts, value


def collect_settlement_market(groups, market, raw, start_ts, end_ts, rejected):
    event = market.get("event_ticker") if isinstance(market, dict) else None
    try:
        inspected = inspect_settlement(market, start_ts, end_ts)
        if inspected is None:
            return
        close_ts, value = inspected
        group = groups.setdefault(event, {"closeTimes": set(), "values": set(), "marketTickers": set(),
                                         "rawResponses": set(), "rulesPrimary": market.get("rules_primary"),
                                         "rulesSecondary": market.get("rules_secondary"), "invalid": False})
        group["closeTimes"].add(close_ts)
        group["values"].add(value)
        group["marketTickers"].add(market["ticker"])
        group["rawResponses"].add(raw)
    except (ValueError, KeyError, TypeError) as exc:
        rejected.append({"eventTicker": event, "marketTicker": market.get("ticker") if isinstance(market, dict) else None,
                         "rawResponse": raw, "reason": str(exc)})
        if event:
            group = groups.setdefault(event, {"closeTimes": set(), "values": set(), "marketTickers": set(),
                                             "rawResponses": set(), "invalid": False})
            group["invalid"] = True


def load_market_pages(downloader, path, start_ts, end_ts):
    groups, rejected, cursor, seen_cursors = {}, [], "", set()
    pages = 0
    count = 0
    while True:
        params = {"series_ticker": "KXBTCD", "limit": 1000}
        if path == "/markets":
            params.update({"status": "settled", "min_close_ts": start_ts, "max_close_ts": end_ts})
        if cursor:
            params["cursor"] = cursor
        payload, raw = downloader.get("kalshi", KALSHI, path, params)
        markets = payload.get("markets")
        if not isinstance(markets, list):
            raise ValueError("Kalshi response is not a market array")
        page_times = []
        for market in markets:
            try:
                page_times.append(int(parse_time(market["close_time"]).timestamp()))
            except (KeyError, ValueError, TypeError):
                pass
            collect_settlement_market(groups, market, raw, start_ts, end_ts, rejected)
        pages += 1
        count += len(markets)
        if pages % 25 == 0:
            earliest = iso(min(page_times)) if page_times else "none"
            print(f"Kalshi {path}: {pages} pages; {len(groups)} events; oldest page {earliest}", flush=True)
        # Historical cursor order is not strictly by close time: late finalizations
        # can appear after older events. Exhaust it rather than guessing a cutoff.
        cursor = payload.get("cursor", "")
        if not cursor:
            break
        if cursor in seen_cursors:
            raise ValueError("Kalshi pagination repeated a cursor")
        seen_cursors.add(cursor)
    return {"groups": groups, "rejected": rejected, "pages": pages, "marketRows": count}


def finalize_settlements(parts, start_ts, end_ts):
    merged, rejected = {}, []
    for part in parts:
        rejected.extend(part["rejected"])
        for event, group in part["groups"].items():
            if event not in merged:
                merged[event] = group
            else:
                for key in ("closeTimes", "values", "marketTickers", "rawResponses"):
                    merged[event][key].update(group[key])
                merged[event]["invalid"] |= group["invalid"]
    rows = []
    for event, group in merged.items():
        if group["invalid"] or len(group["values"]) != 1 or len(group["closeTimes"]) != 1:
            rejected.append({"eventTicker": event, "reason": "Invalid or disagreeing finalized observations",
                             "values": [str(value) for value in sorted(group["values"])],
                             "rawResponses": sorted(group["rawResponses"])})
            continue
        rows.append({"eventTicker": event, "closeAt": iso(next(iter(group["closeTimes"]))),
                     "value": float(next(iter(group["values"]))), "status": "finalized", "source": SETTLEMENT_SOURCE,
                     "marketTickers": sorted(group["marketTickers"]), "rawResponses": sorted(group["rawResponses"]),
                     "rulesPrimary": group.get("rulesPrimary"), "rulesSecondary": group.get("rulesSecondary")})
    rows.sort(key=lambda row: (row["closeAt"], row["eventTicker"]))
    # Duplicate event identities at the same timestamp are not silently combined.
    by_time = {}
    for row in rows:
        by_time.setdefault(row["closeAt"], []).append(row)
    rows = [rows_at_time[0] for rows_at_time in by_time.values() if len(rows_at_time) == 1]
    for timestamp, rows_at_time in by_time.items():
        if len(rows_at_time) > 1:
            rejected.append({"closeAt": timestamp, "reason": "Multiple event identities at one hour",
                             "eventTickers": [row["eventTicker"] for row in rows_at_time]})
    actual = {int(parse_time(row["closeAt"]).timestamp()) for row in rows}
    return {"rows": rows, "rejected": rejected, "coverage": {
        "expectedHourlyObservationSlots": (end_ts - start_ts) // HOUR + 1,
        "observedHours": len(rows), "missingIntervals": missing_runs(actual, start_ts, end_ts + HOUR),
        "pages": sum(part["pages"] for part in parts), "marketRowsChecked": sum(part["marketRows"] for part in parts),
        "note": "Missing slots include hours without a listed/finalized KXBTCD event; no missing observations are filled.",
    }}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", default="2025-07-28T00:00:00Z")
    parser.add_argument("--as-of", required=True)
    parser.add_argument("--output", type=Path, default=Path("artifacts/btc-hourly-bias-experiment/source-prices"))
    parser.add_argument("--requests-per-second", type=float, default=4)
    args = parser.parse_args()
    start = parse_time(args.start)
    as_of = parse_time(args.as_of)
    end = as_of.replace(minute=0, second=0, microsecond=0)
    if start.minute or start.second or start.microsecond or start >= end:
        parser.error("start must be an exact UTC hour before the last completed hour")
    if not 0 < args.requests_per_second <= 10:
        parser.error("requests-per-second must be between 0 and 10")
    start_ts, end_ts = int(start.timestamp()), int(end.timestamp())
    downloader = Downloader(args.output, args.requests_per_second)
    common = {"schemaVersion": 1, "asOf": iso(as_of), "startInclusive": iso(start),
              "endExclusive": iso(end), "historical": True, "executable": False}
    cutoff, cutoff_raw = downloader.get("kalshi", KALSHI, "/historical/cutoff", {})
    write_json(args.output / "fetch-manifest.json", {**common, "status": "running", "cutoff": cutoff})
    with ThreadPoolExecutor(max_workers=3) as pool:
        candles_future = pool.submit(load_candles, downloader, start_ts, end_ts)
        recent_future = pool.submit(load_market_pages, downloader, "/markets", start_ts, end_ts)
        historical_future = pool.submit(load_market_pages, downloader, "/historical/markets", start_ts, end_ts)
        candles = candles_future.result()
        write_json(args.output / "candles.json", {**common, "source": PRICE_SOURCE, "productId": "BTC-USD", **candles})
        settlements = finalize_settlements([recent_future.result(), historical_future.result()], start_ts, end_ts)
    write_json(args.output / "settlements.json", {**common, "endInclusive": iso(end), "source": SETTLEMENT_SOURCE,
                "seriesTicker": "KXBTCD", "cutoff": cutoff, "cutoffRawResponse": cutoff_raw, **settlements})
    manifest = {**common, "status": "complete", "completedAt": iso(datetime.now(UTC)),
                "cutoff": cutoff, "candlesCoverage": candles["coverage"], "settlementsCoverage": settlements["coverage"],
                "requests": sorted(downloader.requests, key=lambda request: request["url"]),
                "documentation": [
                    "https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles",
                    "https://docs.kalshi.com/api-reference/historical/get-historical-markets",
                    "https://docs.kalshi.com/api-reference/historical/get-historical-cutoff-timestamps",
                ]}
    write_json(args.output / "fetch-manifest.json", manifest)
    print(json.dumps({"status": "complete", "asOf": common["asOf"],
                      "candles": candles["coverage"], "settlements": settlements["coverage"]}), flush=True)


if __name__ == "__main__":
    main()
