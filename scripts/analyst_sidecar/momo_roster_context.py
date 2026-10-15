"""Read the dashboard's verified company/MOMO universe as bounded research context."""

import asyncio
from datetime import datetime, timezone
import re
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

import httpx


ROSTER_PATH = "/api/market/sp500-contributors?context=analyst"
MAX_AGE_SECONDS = 20 * 60
REQUEST_TIMEOUT_SECONDS = 35
BLOCKED_FLAGS = (
    "mock", "isMock", "seed", "seeded", "isSeed", "stale", "isStale", "cacheOnly",
    "isCacheOnly", "fromCache", "refreshFailed", "offline", "disconnected", "synthetic",
    "fallback", "isFallback", "modelOnly", "portfolioDerived", "inferred", "costBasisDerived",
)


def _blocked(value):
    if not isinstance(value, dict):
        return True
    evidence = " ".join(str(value.get(key) or "") for key in
                        ("status", "warning", "error", "freshness", "provenance", "dataStatus"))
    return (any(value.get(key) is True for key in BLOCKED_FLAGS)
            or value.get("connected") is False or value.get("available") is False
            or re.search(r"unavailable|failed|error|offline|disconnect|stale|mock|seed|synthetic|"
                         r"cache|fallback|model.only|inferred|derived", evidence, re.I) is not None)


def _recent(value, now):
    try:
        observed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return observed.tzinfo is not None and -5 <= (now - observed).total_seconds() <= MAX_AGE_SECONDS
    except (AttributeError, TypeError, ValueError):
        return False


def _official_url(value, host):
    try:
        parsed = urlparse(value)
        return (parsed.scheme == "https" and not parsed.username and not parsed.password
                and (parsed.hostname == host or parsed.hostname.endswith(f".{host}")))
    except (AttributeError, TypeError, ValueError):
        return False


def unavailable_roster(reason="Current company/MOMO roster could not be verified."):
    return {"status": "unavailable", "classification": "dated_supporting_context",
            "liveVerified": False, "source": ROSTER_PATH, "freshness": "unavailable",
            "data": None, "reason": reason}


def project_momo_roster(payload, now=None):
    """Read the bounded server projection, verified by the same validator as the morning audit."""
    now = now or datetime.now(timezone.utc)
    today = now.astimezone(ZoneInfo("America/New_York")).date().isoformat()
    if (_blocked(payload) or payload.get("schemaVersion") != "MomoRosterContextV1"
            or payload.get("status") not in {"available", "partial"}
            or payload.get("source") != ROSTER_PATH or payload.get("date") != today
            or payload.get("classification") != "dated_supporting_context"
            or payload.get("liveVerified") is not False or payload.get("freshness") != "current_roster"
            or not _recent(payload.get("asOf"), now)):
        return unavailable_roster()
    data = payload.get("data")
    if not isinstance(data, dict):
        return unavailable_roster()
    top_ten, additions = data.get("topTenTickers"), data.get("momoAdditionalTickers")
    if (not isinstance(top_ten, list) or len(top_ten) != 10
            or not isinstance(additions, list) or len(additions) > 25
            or data.get("tickerOrder") != top_ten + additions
            or any(not isinstance(ticker, str) or not re.fullmatch(r"[A-Z][A-Z0-9.]{0,9}", ticker)
                   or ticker == "GOOG" for ticker in top_ten + additions)
            or len(set(top_ten + additions)) != len(top_ten + additions)
            or data.get("ranking") != "company-market-cap"
            or data.get("momoStatus") not in {"available", "pending", "unavailable"}):
        return unavailable_roster()
    available = data["momoStatus"] == "available"
    if (payload["status"] != ("available" if available else "partial")
            or available and data.get("momoPublicationDate") != today
            or not available and (additions or data.get("momoPublicationDate") is not None)):
        return unavailable_roster()
    sources = data.get("sources") or {}
    if not isinstance(sources, dict):
        return unavailable_roster()
    membership, ranking, momo = sources.get("membership") or {}, sources.get("ranking") or {}, sources.get("momo") or {}
    if not all(isinstance(value, dict) for value in (membership, ranking, momo)):
        return unavailable_roster()
    if (membership.get("provider") != "State Street" or not _official_url(membership.get("sourceUrl"), "ssga.com")
            or ranking.get("provider") != "Nasdaq" or not _official_url(ranking.get("sourceUrl"), "nasdaq.com")
            or not _recent(ranking.get("retrievedAt"), now)
            or available and (momo.get("provider") != "Hedgeye" or momo.get("product") != "MOMO Tracker"
                              or momo.get("publicationDate") != today)):
        return unavailable_roster()
    # Keep the allowlist even though the source is already compact: later API
    # additions must not silently become prices or raw documents in model context.
    source_projection = {
        "membership": {key: membership.get(key) for key in ("provider", "sourceUrl", "asOf")},
        "ranking": {key: ranking.get(key) for key in ("provider", "sourceUrl", "retrievedAt")},
    }
    if available:
        source_projection["momo"] = {key: momo.get(key) for key in ("provider", "product", "publicationDate")}
    return {"status": payload["status"], "classification": "dated_supporting_context", "liveVerified": False,
            "source": ROSTER_PATH, "asOf": payload["asOf"], "freshness": "current_roster", "data": {
                "topTenTickers": top_ten, "momoAdditionalTickers": additions, "tickerOrder": top_ten + additions,
                "momoStatus": data["momoStatus"], "momoPublicationDate": data.get("momoPublicationDate"),
                "ranking": "company-market-cap", "sources": source_projection,
            }, "scope": "Research coverage universe; company ranks first, then MOMO additions by market cap."}


class MomoRosterContextReader:
    def __init__(self, base_url, client_factory=httpx.AsyncClient, timeout=REQUEST_TIMEOUT_SECONDS):
        self.base_url = base_url.rstrip("/")
        self.client_factory = client_factory
        self.timeout = min(REQUEST_TIMEOUT_SECONDS, max(0.01, timeout))

    async def context(self):
        async def read():
            async with self.client_factory(timeout=self.timeout) as client:
                response = await client.get(f"{self.base_url}{ROSTER_PATH}", headers={
                    "Accept": "application/json", "Cache-Control": "no-cache", "Pragma": "no-cache"})
                response.raise_for_status()
                if ("no-store" not in [value.strip().lower() for value in response.headers.get("Cache-Control", "").split(",")]
                        or len(response.content) > 10_000):
                    return unavailable_roster()
                return project_momo_roster(response.json())
        try:
            return await asyncio.wait_for(read(), timeout=self.timeout)
        except Exception:
            return unavailable_roster()
