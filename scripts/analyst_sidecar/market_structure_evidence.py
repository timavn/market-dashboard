"""Shared, dated numeric evidence from archived Market Structure charts.

These are published research readings, not current executable market quotes.
Validate a chart against its captured publication; do not expire a saved review
simply because that publication is now old.
"""

from datetime import date, datetime
import math
import re


_FIELDS = {
    "spxGammaVolatilityThrottle": {
        "gammaThrottle": (-250, 250), "tenDayRealizedVolatility": (0, 250),
    },
    "spxProbableVolatilityGamma": {
        "zeroGamma": (100, 100000), "lowerPvBand": (100, 100000),
        "upperPvBand": (100, 100000),
    },
}
_ROWS = (
    ("spxGammaVolatilityThrottle", "gammaThrottle", "Gamma throttle"),
    ("spxGammaVolatilityThrottle", "tenDayRealizedVolatility", "10-day realized volatility"),
    ("spxProbableVolatilityGamma", "zeroGamma", "Zero-gamma level"),
    ("spxProbableVolatilityGamma", "lowerPvBand", "Lower probable-volatility band"),
    ("spxProbableVolatilityGamma", "upperPvBand", "Upper probable-volatility band"),
    ("spxProbableVolatilityGamma", "strikesInPlay", "Strikes in play"),
)
_UNSAFE = re.compile(
    r"stale|cache|mock|seed|fallback|offline|disconnect|synthetic|inferred|derived|"
    r"frozen|delayed|portfolio|refresh(?:[_ -]?(?:failed|failure|error|issue|timeout|timed out))|"
    r"(?:failed|failure|error).*refresh", re.I,
)
_BAD_FLAGS = (
    "stale", "isStale", "cachedOnly", "cacheOnly", "fromCache", "from_cache", "refreshFailed",
    "mock", "isMock", "seed", "seeded", "fallback", "offline", "disconnected", "synthetic", "inferred",
)


def _dict(value):
    return value if isinstance(value, dict) else {}


def _date(value):
    try:
        return datetime.strptime(str(value or "").strip(), "%Y-%m-%d").date().isoformat()
    except ValueError:
        return None


def _number(value):
    if isinstance(value, bool) or value is None or value == "":
        return None
    try:
        numeric = float(str(value).replace(",", ""))
        return numeric if math.isfinite(numeric) else None
    except (ValueError, TypeError):
        return None


def evidence_safe(*values):
    """Keep the chart contract at least as strict as other review evidence."""
    for value in values:
        value = _dict(value)
        if (any(value.get(flag) is True for flag in _BAD_FLAGS)
                or value.get("connected") is False or value.get("refreshIssue") or value.get("error")):
            return False
        if any(str(value.get(key) or "").lower() in {"error", "unavailable", "failed"}
               for key in ("status", "providerStatus", "sourceStatus")):
            return False
        provenance = " ".join(str(value.get(key) or "") for key in (
            "source", "provenance", "status", "providerStatus", "sourceStatus", "availability",
            "cacheState", "freshness", "flags", "dataQualityFlags", "data_quality_flags",
            "warning", "reason", "refreshIssue",
        ))
        if _UNSAFE.search(provenance):
            return False
    return True


def verified_metric(snapshot, key):
    """Verify labeled numbers against their chart hash, parser, and publication.

    Matches the numeric/date contract used by Predictive Markets Review and
    verifiedMarketStructureChartMetrics in marketStructureReport.cjs. Axis
    coordinates, another publication's chart, and unlabeled guesses do not
    establish a published level.
    """
    snapshot = _dict(snapshot)
    data = _dict(snapshot.get("data"))
    metric = _dict(_dict(data.get("chartMetrics")).get(key))
    if (key not in _FIELDS or snapshot.get("schemaVersion") != "market-structure-v4"
            or snapshot.get("contentComplete") is not True
            or not evidence_safe(snapshot, data, metric) or metric.get("extractionBasis") != "labeled-chart-ocr"
            or metric.get("parserVersion") not in {
                "market-structure-chart-metrics-v2", "market-structure-chart-metrics-v3"}):
        return {}
    day, published = _date(metric.get("chartDate")), _date(snapshot.get("date"))
    if not day or not published or not 0 <= (date.fromisoformat(published) - date.fromisoformat(day)).days <= 4:
        return {}
    chart_id = metric.get("chartId")
    charts = data.get("charts") or _dict(snapshot.get("article")).get("charts") or []
    if not isinstance(charts, list) or not re.fullmatch(r"[a-f0-9]{64}", str(chart_id or "")) or not any(
        isinstance(chart, dict) and evidence_safe(chart) and chart.get("id") == chart.get("sha256") == chart_id
        and (not chart.get("s3Key") or re.fullmatch(
            r"hedgeye-email/assets/market-structure/" + chart_id + r"\.(?:png|jpg|webp)", str(chart["s3Key"])))
        for chart in charts
    ):
        return {}
    values = {field: value for field, (low, high) in _FIELDS[key].items()
              if (value := _number(metric.get(field))) is not None and low <= value <= high}
    if key == "spxProbableVolatilityGamma":
        if values.get("lowerPvBand", 0) >= values.get("upperPvBand", float("inf")):
            values.pop("lowerPvBand", None)
            values.pop("upperPvBand", None)
        strikes = metric.get("strikesInPlay")
        if (isinstance(strikes, list) and strikes and len(strikes) <= 20
                and all(_number(v) is not None and 100 <= _number(v) <= 100000 for v in strikes)):
            values["strikesInPlay"] = list(strikes)
    return {**values, "date": day} if values else {}


def _format(value):
    return f"{_number(value):,.2f}".rstrip("0").rstrip(".")


def metric_rows(snapshot, citation_id):
    """Project supported SPX readings, retaining separate report/chart dates."""
    snapshot = _dict(snapshot)
    metrics = {key: verified_metric(snapshot, key) for key in _FIELDS}
    source_metrics = _dict(_dict(snapshot.get("data")).get("chartMetrics"))
    rows = []
    for key, field, label in _ROWS:
        metric = metrics[key]
        if field not in metric:
            continue
        value = metric[field]
        reading = " / ".join(_format(strike) for strike in value) if field == "strikesInPlay" else _format(value)
        day = date.fromisoformat(metric["date"])
        source_metric = _dict(source_metrics.get(key))
        source = str(source_metric.get("source") or "")
        source = source if len(source) <= 120 and re.fullmatch(r"[A-Za-z0-9.-]+(?:/[A-Za-z0-9.-]+)*", source) else None
        rows.append({
            "cells": [label, reading, f"{day:%b} {day.day}, {day.year}"],
            "citationIds": [citation_id] if citation_id else [],
            "provenance": {
                "publicationDate": _date(snapshot.get("date")), "chartDate": metric["date"],
                **{name: source_metric[name] for name in ("chartId", "parserVersion", "extractionBasis")},
                **({"source": source} if source else {}),
            },
        })
    return rows
