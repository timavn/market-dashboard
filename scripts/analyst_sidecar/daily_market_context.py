"""Bounded daily-strip rankings: dated informational evidence, never execution data."""

import asyncio
from datetime import datetime, timezone
import math
import re
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

import httpx


DAILY_MARKET_PATH = "/api/market/daily-snapshot"
UNIVERSE_LABEL = "S&P 500 · SPY"
MAX_MOVERS_PER_SIDE = 5
REQUEST_TIMEOUT_SECONDS = 8
BLOCKED_FLAGS = (
    "mock", "isMock", "fixture", "isFixture", "seed", "seeded", "isSeed",
    "stale", "isStale", "cacheOnly", "isCacheOnly", "cache_only", "cached",
    "fromCache", "refreshFailed", "offline", "disconnected", "synthetic",
    "fallback", "isFallback", "modelOnly", "portfolioDerived", "costBasisDerived", "inferred",
)


def _blocked(value):
    if not isinstance(value, dict):
        return True
    return (any(value.get(key) is True for key in BLOCKED_FLAGS)
            or value.get("connected") is False or value.get("available") is False
            or any(re.search(r"(?:^|[\s_-])(?:unavailable|error|mock|fixture|seed|seeded|stale|"
                             r"cache[\s_.-]*only|offline|disconnected|synthetic|fallback|model[\s_.-]*only|"
                             r"inferred)(?:$|[\s_-])", str(value.get(key) or ""), re.I)
                   for key in ("status", "source", "provider", "freshness", "provenance", "warning")))


def _time(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo is not None else None
    except (AttributeError, TypeError, ValueError):
        return None


def _date(value):
    try:
        return bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) and datetime.strptime(value, "%Y-%m-%d"))
    except (TypeError, ValueError):
        return False


def _source(value):
    try:
        url = urlparse(value.get("sourceUrl"))
        return (isinstance(value.get("source"), str) and bool(value["source"].strip())
                and url.scheme == "https" and bool(url.hostname) and not url.username and not url.password)
    except (AttributeError, TypeError, ValueError):
        return False


def unavailable_daily_market():
    return {"status": "unavailable", "classification": "dated_supporting_context",
            "liveVerified": False, "executable": False, "displayOnly": True,
            "source": DAILY_MARKET_PATH, "freshness": "unavailable", "data": None}


def project_daily_market(payload, now=None):
    """Preserve one complete published mover group; never rerank or mix sessions."""
    now = now or datetime.now(timezone.utc)
    if (_blocked(payload) or payload.get("status") not in {"available", "partial"}
            or payload.get("displayOnly") is not True or payload.get("executable") is not False):
        return unavailable_daily_market()
    references = payload.get("referenceObservations")
    observation = references.get("movers") if isinstance(references, dict) else None
    if not isinstance(observation, dict) or _blocked(observation):
        return unavailable_daily_market()
    observed, expires = _time(observation.get("asOf")), _time(observation.get("expiresAt"))
    universe, coverage = observation.get("universe"), observation.get("coverage")
    quote_status = observation.get("quoteStatus")
    if (not observed or not expires or expires <= observed or (observed - now).total_seconds() > 5
            or not _source(observation) or not _date(observation.get("marketDate"))
            or observation["marketDate"] > observed.astimezone(ZoneInfo("America/New_York")).date().isoformat()
            or quote_status not in {"live", "delayed", "last-close"}
            or not isinstance(universe, dict) or universe.get("label") != UNIVERSE_LABEL
            or type(universe.get("count")) is not int or not 500 <= universe["count"] <= 550
            or _blocked(universe) or not _date(universe.get("asOf")) or not isinstance(coverage, dict) or _blocked(coverage)
            or type(coverage.get("quotes")) is not int or coverage["quotes"] != universe["count"]
            or coverage.get("total") != universe["count"]
            or "movers" in (payload.get("incompleteReferenceGroups") or [])):
        return unavailable_daily_market()
    details = payload.get("moverDetails")
    if not isinstance(details, dict):
        return unavailable_daily_market()
    projected, tickers = {}, set()
    retained = observation.get("retained") is True or expires <= now
    for side in ("winners", "losers"):
        rows = details.get(side)
        if not isinstance(rows, list) or len(rows) > MAX_MOVERS_PER_SIDE:
            return unavailable_daily_market()
        projected[side] = []
        prior_return = None
        for row in rows:
            if not isinstance(row, dict):
                return unavailable_daily_market()
            timestamp, expiry = _time(row.get("asOf")), _time(row.get("expiresAt"))
            change = row.get("changePercent")
            if (_blocked(row) or not _source(row) or not timestamp or (timestamp - now).total_seconds() > 5
                    or (row.get("expiresAt") is not None and (not expiry or expiry <= timestamp))
                    or row.get("marketDate") != observation["marketDate"] or row.get("status") != quote_status
                    or not re.fullmatch(r"[A-Z][A-Z0-9.-]{0,9}", str(row.get("ticker") or ""))
                    or row["ticker"] in tickers or not isinstance(row.get("name"), str) or not row["name"].strip()
                    or type(change) not in {int, float} or not math.isfinite(change)
                    or (side == "winners" and (change <= 0 or prior_return is not None and change > prior_return))
                    or (side == "losers" and (change >= 0 or prior_return is not None and change < prior_return))):
                return unavailable_daily_market()
            tickers.add(row["ticker"])
            prior_return = change
            retained = retained or row.get("retained") is True or bool(expiry and expiry <= now)
            projected[side].append({key: row[key] for key in (
                "ticker", "name", "changePercent", "asOf", "expiresAt", "marketDate", "status",
                "source", "sourceUrl", "delayedSource") if key in row})
    display_status = "D" if retained or quote_status == "delayed" else "LAST CLOSE" if quote_status == "last-close" else "LIVE"
    for rows in projected.values():
        for row in rows:
            row.update(retained=retained, displayStatus=display_status, executable=False)
    return {"status": "available", "classification": "dated_supporting_context",
            "liveVerified": False, "executable": False, "displayOnly": True,
            "source": DAILY_MARKET_PATH, "asOf": observation["asOf"],
            "freshness": "retained_verified_reference" if retained else "verified_informational_observation",
            "data": {"universe": {key: universe[key] for key in ("label", "count", "asOf")},
                     "coverage": {key: coverage[key] for key in ("quotes", "total")},
                     "ranking": "session-percentage-change", "retained": retained, "displayStatus": display_status,
                     "observation": {key: observation[key] for key in (
                         "asOf", "expiresAt", "marketDate", "quoteStatus", "source", "sourceUrl")},
                     **projected}}


class DailyMarketContextReader:
    def __init__(self, base_url, client_factory=httpx.AsyncClient, timeout=REQUEST_TIMEOUT_SECONDS):
        self.base_url = base_url.rstrip("/")
        self.client_factory = client_factory
        self.timeout = min(REQUEST_TIMEOUT_SECONDS, max(0.01, timeout))

    async def context(self):
        async def read():
            async with self.client_factory(timeout=self.timeout) as client:
                response = await client.get(f"{self.base_url}{DAILY_MARKET_PATH}", headers={
                    "Accept": "application/json", "Cache-Control": "no-cache", "Pragma": "no-cache"})
                response.raise_for_status()
                if ("no-store" not in [part.strip().lower() for part in response.headers.get("Cache-Control", "").split(",")]
                        or len(response.content) > 250_000):
                    return unavailable_daily_market()
                return project_daily_market(response.json())
        try:
            return await asyncio.wait_for(read(), timeout=self.timeout)
        except Exception:
            return unavailable_daily_market()
