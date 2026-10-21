"""Read the website's sourced, completed-session sizing inputs in bounded batches."""
import asyncio
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx

from portfolio_review import _number


SOURCE = "Yahoo Finance chart API"


def _flagged(value):
    return isinstance(value, dict) and (
        any(value.get(key) is True for key in ("stale", "cacheOnly", "fromCache", "mock", "isMock", "seeded", "isSeeded", "synthetic", "inferred", "fallback", "offline", "disconnected"))
        or value.get("connected") is False
        or value.get("status") in {"unavailable", "failed", "error", "stale", "cache-only", "mock", "seeded", "offline", "disconnected"}
    )


def verified_sizing_inputs(payload, symbol, now=None):
    now = now or datetime.now(timezone.utc)
    row = (payload.get("rows") or {}).get(symbol) or {}
    provenance = row.get("provenance") or {}
    history = provenance.get("security") or {}
    if (payload.get("source") != SOURCE or row.get("source") != SOURCE or row.get("symbol") != symbol
            or payload.get("historicalOnly") is not True or payload.get("executable") is not False
            or row.get("historicalOnly") is not True or row.get("executable") is not False
            or any(_flagged(value) for value in (payload, row, provenance, history))
            or provenance.get("provider") != "Yahoo Finance" or provenance.get("dataset") != "chart"
            or provenance.get("interval") != "1d" or provenance.get("adjustedCloseRequired") is not True
            or history.get("requestedSymbol") != symbol):
        return {}
    instrument = row.get("instrumentType")
    if instrument not in {"ETF", "EQUITY", "CRYPTOCURRENCY"}:
        return {}
    expected = ((now.date() - timedelta(days=1)).isoformat() if instrument == "CRYPTOCURRENCY"
                else (payload.get("completedSession") or {}).get("expectedAsOf"))
    try:
        observed = datetime.fromisoformat(history["fetchedAt"].replace("Z", "+00:00"))
        closing_date = datetime.strptime(row["asOf"], "%Y-%m-%d")
        period = history.get("regularSession") or {}
        bar_time = (row.get("referencePrice") or {}).get("timestamp")
        timestamp = datetime.fromisoformat(bar_time.replace("Z", "+00:00")).timestamp() if bar_time else None
        start, end = _number(period.get("start")), _number(period.get("end"))
        foreign_completed = (history.get("exchangeTimezone") and history["exchangeTimezone"] != "America/New_York"
            and instrument != "CRYPTOCURRENCY" and start is not None and end is not None and start < end and timestamp is not None
            and (timestamp < start or timestamp < end <= now.timestamp()) and expected and row["asOf"] >= expected)
        if (not observed.tzinfo or not -5 <= (now - observed).total_seconds() <= 3600 or row["asOf"] != expected and not foreign_completed
                or not 0 <= (now.date() - closing_date.date()).days <= 7):
            return {}
    except (KeyError, TypeError, ValueError):
        return {}

    def metric(name, minimum, positive=False):
        value = row.get(name) or {}
        number = _number(value.get("value"))
        count = value.get("observations")
        try:
            date = datetime.strptime(value["asOf"], "%Y-%m-%d")
        except (KeyError, TypeError, ValueError):
            return None
        if (value.get("status") != "available" or _flagged(value) or value.get("source") != SOURCE
                or number is None or positive and number <= 0
                or not isinstance(count, int) or isinstance(count, bool) or count < minimum
                or not 0 <= (closing_date - date).days <= (0 if positive else 7)):
            return None
        return value

    benchmark = provenance.get("benchmark") or {}
    try:
        benchmark_age = (now - datetime.fromisoformat(benchmark["fetchedAt"].replace("Z", "+00:00"))).total_seconds()
    except (KeyError, TypeError, ValueError):
        benchmark_age = float("inf")
    beta = metric("beta", 126) if benchmark.get("symbol") == "SPY" and not _flagged(benchmark) and -5 <= benchmark_age <= 3600 else None
    return {"beta": beta, "atr14": metric("atr14", 14, True),
            "referencePrice": metric("referencePrice", 1, True), "asOf": row["asOf"],
            "historicalOnly": True, "executable": False}


# Inputs stay usable for MAX_AGE_SECONDS. A refresh starts once they are
# REFRESH_AFTER_SECONDS old, so 30-second attention scans never reach an expired
# cache and alternately lose every sizing-based finding.
MAX_AGE_SECONDS = 60
REFRESH_AFTER_SECONDS = 20


class PortfolioSizingReader:
    def __init__(self, base_url, request=None, clock=None):
        self.base_url = base_url.rstrip("/")
        self.request = request
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.cache = {}
        self.pending = {}

    @staticmethod
    def _window(as_of):
        observed = datetime.fromisoformat(as_of.replace("Z", "+00:00")).astimezone(ZoneInfo("America/New_York"))
        return observed.date().isoformat(), observed.hour * 60 + observed.minute >= 975

    def _cached(self, symbols, as_of):
        now = self.clock()
        window = self._window(as_of)
        ages = {symbol: (now - entry["capturedAt"]).total_seconds() for symbol in symbols
                if (entry := self.cache.get(symbol)) and entry["window"] == window}
        ages = {symbol: age for symbol, age in ages.items() if age <= MAX_AGE_SECONDS}
        # A source that answered without verified inputs is cached empty; it is
        # covered, but contributes no inputs.
        valid = {symbol: self.cache[symbol]["inputs"] for symbol in ages if self.cache[symbol]["inputs"]}
        missing = set(symbols) - set(ages)
        aging = {symbol for symbol, age in ages.items() if age > REFRESH_AFTER_SECONDS}
        return valid, missing, aging

    def _refresh(self, symbols, as_of):
        key = tuple(sorted(symbols))
        if key not in self.pending:
            task = asyncio.create_task(self.read(list(key), as_of))
            self.pending[key] = task
            def finished(done):
                self.pending.pop(key, None)
                if not done.cancelled():
                    done.exception()
            task.add_done_callback(finished)
        return self.pending[key]

    def read_cached(self, symbols, as_of):
        """Alerts use recently verified inputs while a new read runs in the background."""
        valid, missing, aging = self._cached(symbols, as_of)
        if missing or aging:
            self._refresh(missing | aging, as_of)
        return {"bySymbol": valid, "complete": not missing}

    async def read_current(self, symbols, as_of, timeout=15):
        """Like read_cached, but waits for symbols with no usable entry.

        complete is False when the source did not answer for every symbol, so a
        caller can tell missing inputs from an unavailable source.
        """
        valid, missing, aging = self._cached(symbols, as_of)
        if missing or aging:
            task = self._refresh(missing | aging, as_of)
            if missing:
                try:
                    await asyncio.wait_for(asyncio.shield(task), timeout)
                except Exception:
                    pass
                valid, missing, _ = self._cached(symbols, as_of)
        return {"bySymbol": valid, "complete": not missing}

    async def read(self, symbols, as_of):
        symbols = sorted(set(symbols))
        if not symbols:
            return {"bySymbol": {}, "historicalOnly": True, "executable": False}
        semaphore = asyncio.Semaphore(4)
        async with httpx.AsyncClient(timeout=25) as client:
            async def batch(selected):
                async with semaphore:
                    try:
                        if self.request:
                            payload = await self.request(selected)
                        else:
                            response = await client.get(f"{self.base_url}/api/security-risk-metrics", params={"symbols": ",".join(selected), "sizingOnly": "1"})
                            response.raise_for_status()
                            if "no-store" not in response.headers.get("Cache-Control", "").lower():
                                raise ValueError("Sizing response must be no-store")
                            payload = response.json()
                        return {symbol: verified_sizing_inputs(payload, symbol) for symbol in selected}
                    except Exception:
                        return {symbol: None for symbol in selected}

            tasks = [asyncio.create_task(batch(symbols[offset:offset + 6])) for offset in range(0, len(symbols), 6)]
            try:
                done, pending = await asyncio.wait(tasks, timeout=45)
                captured = {symbol: inputs for task in done for symbol, inputs in task.result().items()}
            finally:
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        now = self.clock()
        window = self._window(as_of)
        # A failed or timed-out batch is not an answer; only answers are cached.
        unavailable = [symbol for symbol in symbols if captured.get(symbol) is None]
        output = {symbol: captured.get(symbol) or {} for symbol in symbols}
        for symbol, inputs in output.items():
            self.cache.pop(symbol, None)
            if symbol not in unavailable:
                self.cache[symbol] = {"inputs": inputs, "window": window, "capturedAt": now}
        self.cache = {symbol: entry for symbol, entry in self.cache.items() if (now - entry["capturedAt"]).total_seconds() <= MAX_AGE_SECONDS}
        return {"bySymbol": output, "unavailable": unavailable, "asOf": now.isoformat(), "historicalOnly": True, "executable": False}
