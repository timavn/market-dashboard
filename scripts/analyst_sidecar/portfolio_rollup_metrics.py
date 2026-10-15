"""Small rollups of verified, captured Portfolio Review accounting evidence.

Inputs are full ``portfolio_review.portfolio_metrics`` results, not the reduced
presentation metrics. Observation times describe each capture; an older review
is historical evidence, never a newly observed quote. Research mentions are not
security classifications and are intentionally not used to infer factor betas.
"""
from __future__ import annotations

from datetime import datetime, time, timezone
from functools import lru_cache
import json
from math import isclose, isfinite
from pathlib import Path
import subprocess
from typing import Any
from zoneinfo import ZoneInfo


COMPARISON_FIELDS = ("grossExposure", "netExposure", "grossLeverage", "netExposurePctOfNlv",
                     "longMarketValue", "shortMarketValue", "netLiquidation", "netAccruedInterest")
VALUED_MARKS = {"live", "settled", "resolver"}
BAD_FLAGS = ("stale", "cacheOnly", "cachedOnly", "fromCache", "from_cache", "mock", "seeded",
             "inferred", "synthetic", "fixture", "refreshFailed", "offline")
BAD_STATES = {"stale", "cached", "cache_only", "cached_disconnected_snapshot", "offline",
              "disconnected", "error", "failed", "unavailable", "mock", "seeded", "inferred"}
CATEGORY_LABELS = {
    "event_contract": "Event contracts", "listed_option": "Listed options",
    "stock": "Stocks & ETFs", "equity": "Stocks & ETFs", "etf": "Stocks & ETFs",
    "bond": "Bonds", "fixed_income": "Bonds", "future": "Futures", "futures": "Futures",
    "cash": "Cash", "forex": "Foreign exchange", "fx": "Foreign exchange",
    "fund": "Funds", "crypto": "Crypto", "commodity": "Commodities",
}
SECURITY_LABELS = {
    "STK": "Stocks & ETFs", "BOND": "Bonds", "FUT": "Futures", "CONTFUT": "Futures",
    "OPT": "Listed options", "FOP": "Listed options", "CASH": "Foreign exchange",
    "FUND": "Funds", "CRYPTO": "Crypto",
}
EASTERN = ZoneInfo("America/New_York")
ROOT = Path(__file__).resolve().parents[2]


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if isfinite(result) else None


def _time(value: Any) -> datetime | None:
    try:
        result = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return result if result.tzinfo else None
    except (TypeError, ValueError):
        return None


def _rejected(value: dict[str, Any]) -> bool:
    if any(value.get(flag) is True for flag in BAD_FLAGS):
        return True
    if any(value.get(flag) is False for flag in ("connected", "liveVerified", "verifiedAtCapture")):
        return True
    for field in ("status", "freshness", "source", "provenance"):
        state = str(value.get(field) or "").lower()
        if state in BAD_STATES or any(token in state for token in ("mock", "seeded", "fixture", "cached_disconnected")):
            return True
    return False


def _captured(metrics: Any) -> bool:
    return (isinstance(metrics, dict) and metrics.get("available") is True
            and _time(metrics.get("observedAt")) is not None
            and isinstance(metrics.get("positions"), list) and not _rejected(metrics))


def _position_value(position: Any) -> float | None:
    if not isinstance(position, dict) or _rejected(position) or position.get("markState") not in VALUED_MARKS:
        return None
    value, quantity = _number(position.get("marketValue")), _number(position.get("quantity"))
    if value is None or quantity is None or (value != 0 and (quantity == 0 or (value > 0) != (quantity > 0))):
        return None
    return value


def _currency_compatible(metrics: dict[str, Any]) -> bool:
    # A supplied valuationCurrency is evidence of conversion; security currency
    # alone never authorizes treating a native value as account-base currency.
    base = str(metrics.get("currency") or metrics.get("baseCurrency") or "").upper()
    currencies = {str(row.get("valuationCurrency") or row.get("currency") or "").upper()
                  for row in metrics["positions"] if isinstance(row, dict)} - {""}
    return len(currencies) <= 1 and (not base or not currencies or currencies == {base})


def _account_identity(metrics: dict[str, Any]) -> str | None:
    key = metrics.get("accountKey")
    return key if isinstance(key, str) and key.strip() else None


def _complete_metrics(metrics: Any) -> bool:
    if not _captured(metrics) or metrics.get("valuationComplete") is not True or not _currency_compatible(metrics):
        return False
    positions = metrics["positions"]
    values = [_position_value(row) for row in positions]
    if any(value is None for value in values):
        return False
    if any(metrics.get(field) is not None and _number(metrics[field]) != expected for field, expected in (
        ("positionCount", len(positions)), ("valuedCount", len(positions)), ("unavailableCount", 0),
    )):
        return False
    nlv = _number(metrics.get("netLiquidation"))
    if metrics.get("accountSummaryAvailable") is not True or nlv is None or nlv <= 0:
        return False
    gross, net = sum(abs(value) for value in values), sum(values)
    expected = {"grossExposure": gross, "netExposure": net,
                "grossLeverage": gross / nlv, "netExposurePctOfNlv": net / nlv * 100}
    return all(_number(metrics.get(field)) is not None
               and isclose(_number(metrics[field]), value, rel_tol=1e-9, abs_tol=1e-7)
               for field, value in expected.items())


def _complete_account_exposure(metrics: Any) -> bool:
    """Qualify independent broker totals even when some quotes are missing.

    ``portfolio_metrics`` supplies this proof only after checking the original
    captured balance, account, currency, socket, observation times and totals.
    It does not authorize position allocations or supply a missing quote.
    """
    if (not _captured(metrics) or metrics.get("exposureComplete") is not True
            or metrics.get("exposureBasis") != "broker_account"):
        return False
    proof = metrics.get("exposureProvenance")
    if (not isinstance(proof, dict) or _rejected(proof)
            or proof.get("verifiedAtCapture") is not True
            or proof.get("source") != "ibkr_live_session" or proof.get("fromCache") is not False
            or metrics.get("accountIds") != [proof.get("accountId")]
            or not proof.get("accountId") or not _account_identity(metrics)
            or not metrics.get("currency") or proof.get("currency") != metrics.get("currency")
            or _time(proof.get("observedAt")) is None
            or _time(proof.get("observedAt")) != _time(metrics.get("exposureObservedAt"))):
        return False
    nlv = _number(metrics.get("netLiquidation"))
    long_value, short_value = _number(metrics.get("longMarketValue")), _number(metrics.get("shortMarketValue"))
    if (metrics.get("accountSummaryAvailable") is not True or nlv is None or nlv <= 0
            or long_value is None or long_value < 0 or short_value is None or short_value > 0):
        return False
    gross, net = long_value - short_value, long_value + short_value
    expected = {"grossExposure": gross, "netExposure": net,
                "grossLeverage": gross / nlv, "netExposurePctOfNlv": net / nlv * 100}
    return all(_number(metrics.get(field)) is not None
               and isclose(_number(metrics[field]), value, rel_tol=1e-9, abs_tol=.01 if field.endswith("Exposure") else 1e-7)
               for field, value in expected.items())


def _comparison_complete(metrics: Any) -> bool:
    # Broker totals are independently qualified accounting evidence. Requiring
    # each executable quote here incorrectly blanks a complete account book.
    return (_complete_account_exposure(metrics) if isinstance(metrics, dict) and metrics.get("exposureBasis") == "broker_account"
            else _complete_metrics(metrics))


def comparison_observed_at(metrics: Any) -> str | None:
    if not isinstance(metrics, dict):
        return None
    value = metrics.get("exposureObservedAt") if metrics.get("exposureBasis") == "broker_account" else metrics.get("observedAt")
    return value if _time(value) else None


@lru_cache(maxsize=128)
def _previous_session(day: str) -> dict[str, Any] | None:
    """Reuse the dashboard's exchange calendar and early-close protocol."""
    script = (
        "const c=require('./src/utils/usEquityMarketCalendar.cjs');"
        "const p=require('./src/services/analyst/analystPolicy.cjs');"
        "const day=c.previousTradingDateKey(process.argv[1]);"
        "const w=p.portfolioCaptureWindow(new Date(day+'T12:00:00Z'));"
        "process.stdout.write(JSON.stringify({sessionDate:day,closeMinute:w.captureMinute-30}));"
    )
    try:
        result = subprocess.run(["node", "-e", script, day], cwd=ROOT, text=True,
                                capture_output=True, timeout=1, check=True)
        session = json.loads(result.stdout)
        session_day = datetime.strptime(session["sessionDate"], "%Y-%m-%d").date()
        minute = session["closeMinute"]
        if session_day.isoformat() != session["sessionDate"] or minute not in {780, 960}:
            return None
        closing = datetime.combine(session_day, time(minute // 60, minute % 60), EASTERN)
        return {"baselineKind": "previous-session-close", "baselineSessionDate": session_day.isoformat(),
                "baselineSessionCloseAt": closing.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")}
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
        return None


def previous_session_baseline(review_as_of: Any) -> dict[str, Any]:
    observed = _time(review_as_of)
    return dict(_previous_session(observed.astimezone(EASTERN).date().isoformat()) or {}) if observed else {}


def is_previous_session_close(metrics: Any, baseline: dict[str, Any]) -> bool:
    observed, close = _time(comparison_observed_at(metrics)), _time(baseline.get("baselineSessionCloseAt"))
    return bool(observed and close and observed >= close
                and observed.astimezone(EASTERN).date().isoformat() == baseline.get("baselineSessionDate"))


def build_review_comparison(current_metrics, previous_metrics, baseline_as_of=None, *, session_baseline=None, baseline_source=None):
    """Compare complete, separately captured values for the same account book.

    A session baseline must be a verified observation on the preceding exchange
    day at or after its close. The actual capture time is never rewritten to the
    exchange's closing clock, and arbitrary earlier reviews are not substitutes.
    """
    previous = previous_metrics if isinstance(previous_metrics, dict) else {}
    baseline = baseline_as_of if baseline_as_of is not None else comparison_observed_at(previous)
    result = {"status": "unavailable", "baselineAsOf": baseline if _time(baseline) else None, "metrics": {}}
    if session_baseline is not None:
        result.update(session_baseline, currentAsOf=comparison_observed_at(current_metrics))
        if not session_baseline or not is_previous_session_close(previous, session_baseline):
            result["baselineAsOf"] = None
            return result
    if not _comparison_complete(current_metrics) or not _comparison_complete(previous):
        return result
    account = _account_identity(current_metrics)
    if not account or account != _account_identity(previous):
        return result
    current_time, prior_time = _time(comparison_observed_at(current_metrics)), _time(comparison_observed_at(previous))
    if current_time is None or prior_time is None:
        return result
    if prior_time >= current_time or _time(baseline) != prior_time:
        return result
    current_currency = current_metrics.get("currency") or current_metrics.get("baseCurrency")
    prior_currency = previous.get("currency") or previous.get("baseCurrency")
    if current_currency != prior_currency:
        return result
    result.update(status="available", metrics={field: {"previous": _number(previous.get(field)), "current": _number(current_metrics.get(field))}
                                               for field in COMPARISON_FIELDS})
    if baseline_source:
        result["baselineSource"] = baseline_source
    return result


def _asset_label(position):
    category = str(position.get("category") or position.get("instrumentCategory") or "").lower()
    label = CATEGORY_LABELS.get(category)
    security_label = SECURITY_LABELS.get(str(position.get("secType") or "").upper())
    # Event contracts are identified by both security type and venue upstream.
    if category == "event_contract":
        return label
    if label and security_label and label != security_label:
        return None
    return label or security_label


def build_factor_exposure(metrics, intelligence=None):
    """Aggregate supported instrument classes, without asserting factor betas.

    ``intelligence`` is reserved for independently sourced classifications. Its
    current research references cannot establish sector weights or sensitivities.
    Coverage is classified gross value / full-book gross value, never row count.
    Every position needs a verified value; account aggregates cannot establish
    asset allocations or make a quoted subset represent the full portfolio.
    """
    result = {"status": "unavailable", "label": "Asset exposure", "rows": []}
    if (not _captured(metrics) or metrics.get("valuationComplete") is not True
            or not _currency_compatible(metrics)):
        return result
    nlv = _number(metrics.get("netLiquidation"))
    if metrics.get("accountSummaryAvailable") is not True or nlv is None or nlv <= 0:
        return result
    groups, verified_gross, classified_gross, rejected = {}, 0.0, 0.0, 0
    for position in metrics["positions"]:
        value = _position_value(position)
        if value is None:
            return result
        verified_gross += abs(value)
        label = _asset_label(position)
        if label is None:
            rejected += 1
            continue
        classified_gross += abs(value)
        group = groups.setdefault(label, {"label": label, "longPct": 0.0, "shortPct": 0.0, "netPct": 0.0})
        group["longPct" if value >= 0 else "shortPct"] += value / nlv * 100
        group["netPct"] += value / nlv * 100
    if verified_gross > 0:
        result["coveragePct"] = classified_gross / verified_gross * 100
    if not groups:
        return result
    complete = metrics.get("valuationComplete") is True and rejected == 0
    result.update(status="available" if complete else "partial", rows=sorted(groups.values(), key=lambda row: row["label"]))
    return result
