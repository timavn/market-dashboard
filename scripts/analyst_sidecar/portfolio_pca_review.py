"""Read-only presentation of the PCA service's saved, dated portfolio research.

The PCA service owns model estimation and capture verification. This adapter
keeps its original scope and provenance; a saved portfolio is never relabeled
as the current book, a quote, a signal, or an allocation recommendation.
"""
from __future__ import annotations

import asyncio
from datetime import date, datetime, time, timezone
from math import isfinite
import os
import re
from zoneinfo import ZoneInfo

import httpx

from portfolio_rollup_metrics import _time


MODEL_VERSION = "holdings-correlation-pca-v1"
SOURCE = "pca_saved_snapshot"
PCA_READ_TOTAL_TIMEOUT_SECONDS = 1
SNAPSHOT_FIELDS = (
    "id", "accountId", "sessionDate", "generatedAt", "config", "provenance",
    "coverage", "historicalOnly", "executable",
)
MODEL_FIELDS = ("modelVersion", "dates", "config", "summary", "holdings", "components", "otherComponents")
BAD_FLAGS = {
    "stale", "isStale", "cacheOnly", "cachedOnly", "cached", "fromCache", "from_cache",
    "mock", "isMock", "seed", "isSeed", "seeded", "isSeeded", "synthetic", "inferred",
    "fixture", "fallback", "offline", "disconnected", "refreshFailed",
}
BAD_STATES = {
    "stale", "cached", "cache-only", "cache_only", "cached_disconnected_snapshot", "offline",
    "disconnected", "error", "failed", "unavailable", "mock", "seed", "seeded", "inferred",
}


def portfolio_pca_enabled():
    """The user paused the saved-model read; re-enable it only on request."""
    return os.environ.get("ANALYST_PORTFOLIO_PCA_ENABLED", "false").lower() == "true"


def paused_portfolio_pca_section():
    """Keep the PCA risk section's place while its model read is paused."""
    return {"id": "pca-risk", "title": "PCA risk", "status": "pending", "citationIds": [], "blocks": []}


def _clean(value):
    if isinstance(value, list):
        return all(_clean(item) for item in value)
    if not isinstance(value, dict):
        return True
    if any(value.get(flag) is True for flag in BAD_FLAGS):
        return False
    if any(value.get(flag) is False for flag in ("connected", "verifiedAtCapture", "liveSessionVerified", "available", "ok", "success")):
        return False
    if value.get("actionable") is True or value.get("executable") is True:
        return False
    if any(str(value.get(field) or "").lower() in BAD_STATES for field in ("status", "state", "freshness")):
        return False
    if any(re.search(r"(?:^|[_ -])(mock|seeded|synthetic|fixture|inferred|fallback|offline|disconnected)(?:$|[_ -])",
                     str(value.get(field) or ""), re.I) for field in ("source", "provider", "dataSource")):
        return False
    return all(_clean(item) for item in value.values())


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and isfinite(value)


def _integer(value, minimum=0):
    return isinstance(value, int) and not isinstance(value, bool) and value >= minimum


def _day(value):
    try:
        return date.fromisoformat(value) if isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) else None
    except ValueError:
        return None


def _bound(value):
    if value is None:
        return datetime.now(timezone.utc)
    if isinstance(value, datetime):
        return value if value.tzinfo else None
    if isinstance(value, date):
        return datetime.combine(value, time.max, timezone.utc)
    if isinstance(value, str):
        stamp, day = _time(value), _day(value)
        return stamp or (datetime.combine(day, time.max, timezone.utc) if day else None)
    return None


def _hash(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def _validated(snapshot, account_id, as_of=None):
    try:
        return _valid_snapshot(snapshot, account_id, as_of)
    except (TypeError, ValueError, OverflowError):
        return False


def _valid_snapshot(snapshot, account_id, as_of=None):
    if not isinstance(snapshot, dict) or not _clean(snapshot):
        return False
    if (snapshot.get("source") != SOURCE or snapshot.get("status") not in {"available", "partial"}
            or snapshot.get("accountId") != account_id or not account_id
            or snapshot.get("historicalOnly") is not True or snapshot.get("executable") is not False
            or snapshot.get("actionable") is True or not _hash(snapshot.get("id"))):
        return False
    bound, session, generated = _bound(as_of), _day(snapshot.get("sessionDate")), _time(snapshot.get("generatedAt"))
    if (bound is None or session is None or generated is None or generated > bound
            or session > generated.astimezone(ZoneInfo("America/New_York")).date()
            or session > bound.astimezone(ZoneInfo("America/New_York")).date()):
        return False
    provenance, coverage, model = (snapshot.get(key) for key in ("provenance", "coverage", "model"))
    if not all(isinstance(item, dict) for item in (provenance, coverage, model)):
        return False
    sources = provenance.get("sources")
    if (provenance.get("sessionDate") != session.isoformat() or provenance.get("currency") != "USD"
            or provenance.get("historicalOnly") is not True or provenance.get("executable") is not False
            or provenance.get("catalogVersion") != "pca-macro-references-v1"
            or provenance.get("valuationBasis") != "current signed broker quantities × official session close / current broker NAV"
            or not _hash(provenance.get("inputHash")) or not isinstance(sources, list)
            or "yahoo" not in sources or any(source not in {"yahoo", "fred", "cboe"} for source in sources)):
        return False
    capture = _time(provenance.get("capturedAt"))
    observations = [_time(provenance.get(key)) for key in ("holdingsObservedAt", "navObservedAt", "socketVerifiedAt")]
    if (capture is None or capture > generated or capture.astimezone(ZoneInfo("America/New_York")).date() != session
            or any(stamp is None or not -5 <= (capture - stamp).total_seconds() <= 305 for stamp in observations)):
        return False
    config = model.get("config")
    if (model.get("modelVersion") != MODEL_VERSION or snapshot.get("modelVersion") != MODEL_VERSION
            or not isinstance(config, dict) or config != snapshot.get("config")
            or not _integer(config.get("window"), 63) or config["window"] > 504):
        return False
    dates = model.get("dates")
    if (not isinstance(dates, list) or len(dates) != config["window"] or any(_day(value) is None for value in dates)
            or dates != sorted(set(dates)) or dates[-1] != session.isoformat()):
        return False
    holdings, excluded, out_of_scope = model.get("holdings"), coverage.get("excluded"), coverage.get("outOfScope")
    if (coverage.get("scope") != "equities-etfs" or not isinstance(holdings, list) or not holdings
            or not isinstance(excluded, list) or not isinstance(out_of_scope, list)
            or not _integer(coverage.get("modeledCount"), 1) or not _integer(coverage.get("holdingCount"), 1)
            or coverage["modeledCount"] != len(holdings)
            or coverage["holdingCount"] != len(holdings) + len(excluded)
            or coverage.get("complete") is not (not excluded)
            or snapshot["status"] != ("available" if coverage["complete"] else "partial")
            or not _integer(provenance.get("historyCount"), len(holdings))):
        return False
    if any(not isinstance(row, dict) or not row.get("id") or not row.get("symbol")
           or not _number(row.get("weight")) for row in holdings):
        return False
    if len({row["id"] for row in holdings}) != len(holdings):
        return False
    summary, components, other = model.get("summary"), model.get("components"), model.get("otherComponents")
    if (not isinstance(summary, dict) or not isinstance(components, list) or not components
            or not isinstance(other, list) or len(components) > 5
            or not _number(summary.get("annualizedVolatility")) or summary["annualizedVolatility"] < 0
            or not _number(summary.get("dailyVariance")) or summary["dailyVariance"] < 0):
        return False
    for share in (summary.get("topFiveRiskShare"), summary.get("residualRiskShare"), summary.get("maxRiskShare")):
        if not (_number(share) and 0 <= share <= 1) and not (share is None and summary["dailyVariance"] == 0):
            return False
    for index, row in enumerate(components + other, 1):
        if (not isinstance(row, dict) or row.get("id") != f"PC{index}" or row.get("rank") != index
                or not isinstance(row.get("label"), str) or not row["label"].strip()
                or not ((_number(row.get("riskShare")) and 0 <= row["riskShare"] <= 1)
                        or (row.get("riskShare") is None and summary["dailyVariance"] == 0))):
            return False
    return True


async def read_portfolio_pca_review(base_url, account_id, timeout=1, *, transport=None, diagnostics=None, ensure_active=None):
    """Read a saved model once within one second; never start or rebuild a capture."""
    if not isinstance(account_id, str) or not account_id.strip():
        return {}
    loop = asyncio.get_running_loop()
    started = loop.time()
    phase_started = started
    budget = min(PCA_READ_TOTAL_TIMEOUT_SECONDS, timeout)
    measurement = {"budgetMs": round(budget * 1000), "attemptCount": 0, "attempts": [],
                   "outcome": "unavailable", "phase": "starting", "eventLoopLagMaxMs": 0}
    expected_tick = started + .05

    def record_lag():
        measurement["eventLoopLagMaxMs"] = max(measurement["eventLoopLagMaxMs"],
                                               round(max(0, loop.time() - expected_tick) * 1000, 2))

    async def watch_loop():
        nonlocal expected_tick
        while True:
            await asyncio.sleep(max(0, expected_tick - loop.time()))
            record_lag()
            expected_tick = loop.time() + .05

    watchdog = asyncio.create_task(watch_loop(), name="pca-acquisition-watchdog") if diagnostics is not None else None

    async def capture_remaining():
        remaining = await ensure_active() if ensure_active is not None else float("inf")
        if remaining <= 0:
            raise TimeoutError()
        return remaining

    try:
        deadline = loop.time() + budget
        async with asyncio.timeout(budget):
            # This local route reads an existing model. A failed availability
            # check settles immediately instead of retrying model acquisition.
            remaining = min(deadline - loop.time(), await capture_remaining())
            if remaining <= 0:
                measurement["outcome"] = "timeout"
                return {}
            attempt_started = loop.time()
            attempt_detail = {"attempt": 1, "phase": "client"}
            measurement["attemptCount"] = 1
            measurement["attempts"].append(attempt_detail)
            try:
                attempt_timeout = min(timeout, remaining)
                async with asyncio.timeout(attempt_timeout):
                    measurement["phase"] = "client"
                    phase_started = loop.time()
                    async with httpx.AsyncClient(timeout=attempt_timeout, transport=transport) as client:
                        attempt_detail["clientMs"] = round((loop.time() - phase_started) * 1000, 2)
                        measurement["phase"] = attempt_detail["phase"] = "request_headers"
                        phase_started = loop.time()
                        async with client.stream("GET", f"{base_url.rstrip('/')}/api/risk/pca/snapshot",
                                                 params={"account": account_id}) as response:
                            attempt_detail["requestHeadersMs"] = round((loop.time() - phase_started) * 1000, 2)
                            attempt_detail["httpStatus"] = response.status_code
                            response.raise_for_status()
                            measurement["phase"] = attempt_detail["phase"] = "response_body"
                            phase_started = loop.time()
                            await response.aread()
                            attempt_detail["bodyMs"] = round((loop.time() - phase_started) * 1000, 2)
                            attempt_detail["bodyBytes"] = len(response.content)
                            measurement["phase"] = attempt_detail["phase"] = "json_decode"
                            phase_started = loop.time()
                            payload = response.json()
                            attempt_detail["jsonDecodeMs"] = round((loop.time() - phase_started) * 1000, 2)
            except (httpx.HTTPError, TimeoutError) as exc:
                attempt_detail.update(errorType=type(exc).__name__, elapsedMs=round((loop.time()-attempt_started)*1000, 2),
                                      phaseElapsedMs=round((loop.time()-phase_started)*1000, 2))
                await capture_remaining()
                measurement["outcome"] = "timeout" if isinstance(exc, (httpx.TimeoutException, TimeoutError)) else "http_error" if isinstance(exc, httpx.HTTPStatusError) else "transport_error"
                return {}
            # A received but rejected model is not a transient delivery
            # failure. Keep every original evidence and account gate.
            await capture_remaining()
            measurement["phase"] = attempt_detail["phase"] = "envelope_validation"
            phase_started = loop.time()
            if (not isinstance(payload, dict) or payload.get("status") not in {"available", "partial"}
                    or payload.get("historicalOnly") is not True or payload.get("executable") is not False
                    or "no-store" not in response.headers.get("cache-control", "").lower()
                    or response.headers.get("x-data-use") != "historical-research-only"
                    or not _clean({key: value for key, value in payload.items() if key != "latestAttempt"})):
                attempt_detail["envelopeValidationMs"] = round((loop.time()-phase_started)*1000, 2)
                measurement["outcome"] = "rejected_envelope"
                return {}
            attempt_detail["envelopeValidationMs"] = round((loop.time()-phase_started)*1000, 2)
            saved = payload.get("snapshot")
            if not isinstance(saved, dict) or not isinstance(saved.get("model"), dict):
                measurement["outcome"] = "rejected_snapshot"
                return {}
            result = {field: saved[field] for field in SNAPSHOT_FIELDS if field in saved}
            result.update(status=payload["status"], source=SOURCE, asOf=saved.get("sessionDate"),
                          modelVersion=saved["model"].get("modelVersion"),
                          model={field: saved["model"][field] for field in MODEL_FIELDS if field in saved["model"]})
            measurement["phase"] = attempt_detail["phase"] = "snapshot_validation"
            phase_started = loop.time()
            valid = _validated(result, account_id)
            attempt_detail["snapshotValidationMs"] = round((loop.time()-phase_started)*1000, 2)
            attempt_detail["elapsedMs"] = round((loop.time()-attempt_started)*1000, 2)
            measurement["outcome"] = "available" if valid else "rejected_snapshot"
            await capture_remaining()
            return result if valid else {}
    except (httpx.HTTPError, ValueError, TypeError, TimeoutError) as exc:
        measurement["outcome"] = "timeout" if isinstance(exc, (httpx.TimeoutException, TimeoutError)) else "invalid_response"
        if measurement["attempts"]:
            measurement["attempts"][-1].update(errorType=type(exc).__name__, elapsedMs=round((loop.time()-attempt_started)*1000, 2))
        return {}
    except asyncio.CancelledError:
        measurement["outcome"] = "cancelled"
        raise
    finally:
        measurement["elapsedMs"] = round((loop.time()-started)*1000, 2)
        measurement["phaseElapsedMs"] = round((loop.time()-phase_started)*1000, 2)
        if watchdog is not None:
            record_lag()
            watchdog.cancel()
            # The enclosing source deadline can cancel this cleanup a second
            # time. Retain scalar timings before yielding to that cancellation.
            diagnostics.clear()
            diagnostics.update(measurement)
            await asyncio.gather(watchdog, return_exceptions=True)


def _date_label(value):
    return f"{value.strftime('%b')} {value.day}, {value.year}"


def _pct(value):
    return f"{value * 100:.1f}%" if _number(value) else "—"


def build_portfolio_pca_section(snapshot, metrics, as_of=None):
    """Describe the saved modeled securities, without claiming a same-book match."""
    accounts = metrics.get("accountIds") if isinstance(metrics, dict) else None
    if not isinstance(accounts, list) or len(accounts) != 1 or not _validated(snapshot, accounts[0], as_of):
        return None
    model, coverage, provenance = (snapshot[key] for key in ("model", "coverage", "provenance"))
    summary = model["summary"]
    captured_day = _time(provenance["holdingsObservedAt"]).astimezone(ZoneInfo("America/New_York")).date()
    caption = (f"Portfolio captured {_date_label(captured_day)} · {model['config']['window']}-session model "
               f"through {_date_label(_day(snapshot['sessionDate']))} · "
               f"{coverage['modeledCount']}/{coverage['holdingCount']} stocks & ETFs modeled")
    # Risk shares are the model's published values. A component's sign is an
    # arbitrary orientation and must not become a bullish/bearish label.
    components = sorted(model["components"] + model["otherComponents"],
                        key=lambda row: (-row["riskShare"] if _number(row["riskShare"]) else 0, row["rank"]))[:5]
    return {
        "id": "pca-risk", "title": "PCA risk", "citationIds": [], "status": snapshot["status"],
        "asOf": snapshot["sessionDate"], "generatedAt": snapshot["generatedAt"],
        "portfolioObservedAt": provenance["holdingsObservedAt"], "snapshotId": snapshot["id"],
        "modelVersion": MODEL_VERSION, "source": SOURCE, "historicalOnly": True, "executable": False,
        "coverage": coverage, "provenance": provenance,
        "blocks": [
            {"type": "paragraph", "text": caption, "citationIds": []},
            {"type": "paragraph", "text": (
                f"Modeled annualized volatility: {_pct(summary['annualizedVolatility'])} · "
                f"First five PCs: {_pct(summary['topFiveRiskShare'])} of modeled risk · "
                f"Other risk: {_pct(summary['residualRiskShare'])}"), "citationIds": []},
            {"type": "table", "columns": ["Largest risk components", "Interpretation", "Modeled risk share"],
             "rows": [{"cells": [row["id"], row["label"], _pct(row["riskShare"])], "citationIds": []}
                      for row in components]},
        ],
    }
