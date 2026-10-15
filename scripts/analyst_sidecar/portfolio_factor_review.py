"""Read-only, dated factor research for a separately verified matching live book.

The existing Exposure Lab owns the model. This adapter never estimates loadings,
converts them to allocations, or includes the service's hedge scenarios.
"""
from __future__ import annotations

import asyncio
from collections import Counter
from datetime import date
from math import isclose

import httpx

from portfolio_rollup_metrics import _complete_metrics, _number, _rejected, _time


SNAPSHOT_FIELDS = (
    "status", "modelVersion", "historicalOnly", "executable", "actionable", "asOf",
    "generatedAt", "portfolioState", "sourceScope", "positions", "factors",
    "portfolio", "coverage", "provenance",
)


async def read_portfolio_factor_review(base_url, account_id, timeout=8, *, transport=None):
    """Capture existing historical research with a bounded, read-only request."""
    if not isinstance(account_id, str) or not account_id.strip():
        return {}
    try:
        async with asyncio.timeout(timeout):
            async with httpx.AsyncClient(timeout=timeout, transport=transport) as client:
                response = await client.get(
                    f"{base_url.rstrip('/')}/api/risk/exposure-lab/snapshot",
                    params={"account": account_id},
                )
                response.raise_for_status()
                payload = response.json()
        if not isinstance(payload, dict) or payload.get("status") not in {"available", "partial"}:
            return {}
        state = payload.get("portfolioState")
        if not isinstance(state, dict) or state.get("accountId") != account_id:
            return {}
        return {field: payload[field] for field in SNAPSHOT_FIELDS if field in payload}
    except (httpx.HTTPError, ValueError, TypeError, TimeoutError):
        return {}


def _clean(value):
    return isinstance(value, dict) and not _rejected(value) and not any(
        value.get(flag) is True for flag in ("isMock", "isSeed", "seed", "cached", "isStale")
    )


def _symbol(row):
    return str(row.get("symbol") or "").strip().upper()


def _exclusion(row):
    if row.get("category") == "event_contract" or row.get("instrumentCategory") == "event_contract":
        return "prediction_market_separate_ledger"
    if str(row.get("secType") or "").upper() in {"OPT", "OPTION", "FOP", "CASH"} or row.get("marketValue") == 0:
        return "unsupported_or_unpriced_instrument"
    return None


def _matching_book(snapshot, metrics):
    state, scope = snapshot.get("portfolioState"), snapshot.get("sourceScope")
    if not _clean(state) or not isinstance(scope, dict):
        return False
    accounts = metrics.get("accountIds")
    if not isinstance(accounts, list) or len(accounts) != 1 or state.get("accountId") != accounts[0]:
        return False
    quality = state.get("dataQuality")
    if (state.get("mode") != "live" or state.get("markState") != "live"
            or state.get("dataSource") != "ibkr_api" or state.get("liveSessionVerified") is not True
            or state.get("fromCache") is not False or not _clean(quality)
            or quality.get("status") != "ok"):
        return False
    current = metrics["positions"]
    modeled = snapshot.get("positions")
    excluded = scope.get("excludedHoldings")
    if not isinstance(modeled, list) or not modeled or not isinstance(excluded, list):
        return False
    eligible, expected_excluded = {}, Counter()
    for row in current:
        if not _clean(row) or row.get("account") != accounts[0] or not _symbol(row):
            return False
        reason = _exclusion(row)
        if reason:
            expected_excluded[(_symbol(row), str(row.get("secType") or "").upper(), reason)] += 1
            continue
        # The model identifies securities by symbol only, not contract identity.
        # Do not silently apply a spot-symbol model to a future or other contract.
        if row.get("secType") != "STK" or row.get("markState") != "live" or _symbol(row) in eligible:
            return False
        eligible[_symbol(row)] = row
    if (len(modeled) != len(eligible) or scope.get("sourceHoldingCount") != len(current)
            or scope.get("eligibleHoldingCount") != len(eligible)
            or scope.get("eligibleSymbolCount") != len(eligible)
            or any(not isinstance(row, dict) for row in excluded)
            or Counter((_symbol(row), str(row.get("secType") or "").upper(), row.get("reason"))
                       for row in excluded) != expected_excluded):
        return False
    seen = set()
    for row in modeled:
        if not _clean(row) or _symbol(row) not in eligible or _symbol(row) in seen:
            return False
        seen.add(_symbol(row))
        quantity, value, weight = (_number(row.get(key)) for key in ("quantity", "marketValue", "signedWeightPct"))
        expected_quantity = _number(eligible[_symbol(row)].get("quantity"))
        if (quantity is None or expected_quantity is None or value is None or weight is None
                or quantity == 0 or value == 0 or weight == 0
                or not isclose(quantity, expected_quantity, rel_tol=1e-9, abs_tol=1e-9)
                or (quantity > 0) != (value > 0) or (value > 0) != (weight > 0)):
            return False
        # Separate live captures may move slightly. Withhold a materially
        # different NLV denominator; the service rounds weights to .001%.
        expected_weight = value / metrics["netLiquidation"] * 100
        if not isclose(weight, expected_weight, rel_tol=.01, abs_tol=.001):
            return False
    return True


def _pct(value, signed=False):
    number = _number(value)
    return "—" if number is None else f"{number:+.1f}%" if signed and number else f"{number:.1f}%"


def build_portfolio_factor_section(snapshot, metrics, max_capture_skew_seconds=60):
    """Project supported historical sensitivities only for the same captured book."""
    if not _complete_metrics(metrics) or not _clean(snapshot):
        return None
    if (snapshot.get("status") not in {"available", "partial"}
            or snapshot.get("modelVersion") != "exposure-lab-ridge-v2"
            or snapshot.get("historicalOnly") is not True or snapshot.get("executable") is not False
            or snapshot.get("actionable") is not False or not _matching_book(snapshot, metrics)):
        return None
    observed = _time(metrics.get("observedAt"))
    state = snapshot["portfolioState"]
    times = [_time(state.get(key)) for key in ("fetchedAt", "socketVerifiedAt")]
    generated = _time(snapshot.get("generatedAt"))
    if (generated is None or any(stamp is None or abs((stamp - observed).total_seconds()) > max_capture_skew_seconds
                                 for stamp in times)
            or generated < max(times) or (generated - observed).total_seconds() > max_capture_skew_seconds):
        return None
    try:
        model_day = date.fromisoformat(snapshot.get("asOf"))
    except (TypeError, ValueError):
        return None
    if model_day > min(observed.date(), generated.date()):
        return None
    provenance = snapshot.get("provenance")
    if (not _clean(provenance) or provenance.get("provider") != "Yahoo Finance chart API"
            or provenance.get("returnBasis") != "explicit adjusted close; completed daily sessions only"):
        return None
    definitions = provenance.get("factorDefinitions")
    if not isinstance(definitions, list) or any(not isinstance(row, dict) for row in definitions):
        return None
    definitions = {row.get("id"): row for row in definitions}
    factors = snapshot.get("factors")
    if not isinstance(factors, list):
        return None
    accepted, seen = [], set()
    for factor in factors:
        if not _clean(factor):
            return None
        identity = factor.get("id")
        definition = definitions.get(identity)
        net, gross = _number(factor.get("netExposurePct")), _number(factor.get("grossExposurePct"))
        if (not identity or identity in seen or not definition or not factor.get("label")
                or factor.get("status") != "available" or not factor.get("formula")
                or factor.get("formula") != definition.get("formula")
                or net is None or gross is None or gross < 0 or abs(net) > gross + .001):
            return None
        seen.add(identity)
        accepted.append(factor)
    modeled = [row for row in snapshot["positions"] if row.get("modelStatus") == "available"]
    if not accepted or not modeled:
        return None
    modeled_gross = sum(abs(_number(row["marketValue"])) for row in modeled)
    # Include explicitly excluded positions in the coverage denominator.
    whole_gross = sum(abs(_number(row["marketValue"])) for row in snapshot["positions"])
    whole_gross += sum(abs(_number(row["marketValue"])) for row in metrics["positions"] if _exclusion(row))
    coverage = modeled_gross / whole_gross * 100 if whole_gross > 0 else 0
    accepted.sort(key=lambda row: (-abs(_number(row["netExposurePct"])), row["label"]))
    caption = f"Historical sensitivities through {model_day.isoformat()} · {coverage:.0f}% of gross exposure modeled"
    if snapshot["status"] == "partial":
        caption += " · Partial model"
    if len(accepted) > 8:
        caption += " · Largest 8 net sensitivities"
    return {
        "id": "factor-exposure", "title": "Factor exposure", "citationIds": [],
        "status": snapshot["status"], "asOf": model_day.isoformat(),
        "modelVersion": snapshot["modelVersion"], "portfolioObservedAt": state["fetchedAt"],
        "coveragePct": coverage, "provenance": provenance,
        "blocks": [
            {"type": "paragraph", "text": caption, "citationIds": []},
            {"type": "table", "columns": ["Factor", "Gross (% NLV)", "Net (% NLV)", "Risk contribution"],
             "rows": [{"cells": [row["label"], _pct(row["grossExposurePct"]), _pct(row["netExposurePct"], True),
                                  _pct(row.get("contributionToTotalRiskPct"), True)], "citationIds": []}
                      for row in accepted[:8]]},
        ],
    }
