"""Past-only dollar features for the standalone BTC hourly research experiment.

The dashboard's 15/30-session correlations use daily price levels.  The separate
120-observation check uses hourly returns.  Neither is an executable quote.
"""
from __future__ import annotations

from bisect import bisect_right
from collections import Counter, defaultdict
from datetime import date, datetime, time, timedelta, timezone
import math
import re
from zoneinfo import ZoneInfo

UTC = timezone.utc
EASTERN = ZoneInfo("America/New_York")
HOUR = timedelta(hours=1)
DAILY_WINDOWS = (15, 30)
RETURN_WINDOW = 120
RETURN_MAX_AGE = timedelta(days=21)


def instant(value):
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and "T" in value:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    else:
        raise ValueError("A complete timezone-aware timestamp is required")
    if parsed.tzinfo is None:
        raise ValueError("A timestamp must include its timezone")
    return parsed.astimezone(UTC)


def iso(value):
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def rows(document):
    return document if isinstance(document, list) else document.get("rows", [])


def positive(value):
    if isinstance(value, bool) or value is None:
        return False
    try:
        return math.isfinite(float(value)) and float(value) > 0
    except (TypeError, ValueError):
        return False


def rejected_provenance(row):
    if any(row.get(key) is True for key in ("mock", "isMock", "seeded", "synthetic", "inferred", "portfolioDerived")):
        return True
    return bool(re.search(r"mock|seed|fixture|synthetic|inferred|portfolio|fallback", str(row.get("source", "")), re.I))


def document_cutoff(document):
    if isinstance(document, list):
        return None
    values = []
    for key in ("asOf", "endExclusive", "endInclusive", "cutoff"):
        if document.get(key):
            values.append(instant(document[key]))
    return min(values) if values else None


def pearson(pairs):
    """Full precision; a constant series has no defined correlation."""
    if len(pairs) < 2:
        return None
    mx = math.fsum(x for x, _ in pairs) / len(pairs)
    my = math.fsum(y for _, y in pairs) / len(pairs)
    vx = math.fsum((x - mx) ** 2 for x, _ in pairs)
    vy = math.fsum((y - my) ** 2 for _, y in pairs)
    if vx <= 0 or vy <= 0:
        return None
    covariance = math.fsum((x - mx) * (y - my) for x, y in pairs)
    return max(-1.0, min(1.0, covariance / math.sqrt(vx * vy)))


def clean_hourly(document):
    """Keep real, complete UTC-hour OHLC bars; reject every conflicting bucket."""
    candidates = defaultdict(list)
    rejected = []
    cutoff = document_cutoff(document)
    for row in rows(document):
        try:
            start = instant(row.get("startAt") or row.get("hourStart"))
            end = instant(row["endAt"])
            values = tuple(row.get(key) for key in ("open", "high", "low", "close"))
            if (end - start != HOUR or start.minute or start.second or start.microsecond
                    or (cutoff is not None and end > cutoff)
                    or row.get("complete") is False or row.get("isComplete") is False
                    or rejected_provenance(row) or not all(positive(value) for value in values)):
                raise ValueError("incomplete, off-hour, invalid or unverified bar")
            opening, high, low, close = map(float, values)
            if low > min(opening, close) or high < max(opening, close) or low > high:
                raise ValueError("invalid OHLC extrema")
            candidates[end].append({**row, "_start": start, "_end": end,
                                    "open": opening, "high": high, "low": low, "close": close})
        except (KeyError, TypeError, ValueError, OverflowError) as error:
            rejected.append({"startAt": row.get("startAt"), "reason": str(error)})
    accepted = {}
    duplicate_count = 0
    for end, alternatives in candidates.items():
        distinct = {tuple(row[key] for key in ("open", "high", "low", "close")) for row in alternatives}
        if len(distinct) > 1:
            rejected.append({"endAt": iso(end), "reason": "conflicting duplicate hourly bars", "rows": len(alternatives)})
        else:
            accepted[end] = alternatives[0]
            duplicate_count += len(alternatives) - 1
    return accepted, {"accepted": len(accepted), "identicalDuplicates": duplicate_count, "rejected": rejected}


def daily_close_time(day, instrument):
    """Conservative daily completion convention, not an asserted index close."""
    session = date.fromisoformat(day)
    if instrument == "BTC":
        return datetime.combine(session + timedelta(days=1), time(), UTC)
    return datetime.combine(session + timedelta(days=1), time(), EASTERN).astimezone(UTC)


def clean_daily(document, instrument):
    candidates = defaultdict(list)
    rejected = []
    cutoff = document_cutoff(document)
    for row in rows(document):
        try:
            day = row.get("date") or row.get("sessionDate")
            date.fromisoformat(day)
            end = instant(row["endAt"]) if row.get("endAt") else daily_close_time(day, instrument)
            available = max(end, instant(row["availableAt"])) if row.get("availableAt") else end
            if (not positive(row.get("close")) or rejected_provenance(row)
                    or row.get("complete") is False or row.get("isComplete") is False
                    or (cutoff is not None and end > cutoff)):
                raise ValueError("incomplete, invalid or unverified daily bar")
            candidates[day].append({**row, "date": day, "close": float(row["close"]),
                                    "_end": end, "_available": available + HOUR})
        except (KeyError, TypeError, ValueError, OverflowError) as error:
            rejected.append({"date": row.get("date") or row.get("sessionDate"), "reason": str(error)})
    accepted = {}
    duplicate_count = 0
    for day, alternatives in candidates.items():
        if len({row["close"] for row in alternatives}) > 1:
            rejected.append({"date": day, "reason": "conflicting duplicate daily bars", "rows": len(alternatives)})
        else:
            accepted[day] = alternatives[0]
            duplicate_count += len(alternatives) - 1
    return accepted, {"accepted": len(accepted), "identicalDuplicates": duplicate_count, "rejected": rejected}


def level_correlation_history(usd_daily, btc_daily):
    paired = []
    history = []
    for day in sorted(usd_daily.keys() & btc_daily.keys()):
        usd, btc = usd_daily[day], btc_daily[day]
        paired.append((usd["close"], btc["close"]))
        history.append({"_available": max(usd["_available"], btc["_available"]),
                        "corrSourceDate": day,
                        **{f"corr{window}Level": pearson(paired[-window:]) if len(paired) >= window else None
                           for window in DAILY_WINDOWS}})
    return history


def hourly_return_pairs(usd_hourly, btc_hourly):
    paired = []
    for end in sorted(usd_hourly.keys() & btc_hourly.keys()):
        previous = end - HOUR
        if previous not in usd_hourly or previous not in btc_hourly:
            continue
        paired.append({"_end": end,
                       "usdReturn": usd_hourly[end]["close"] / usd_hourly[previous]["close"] - 1,
                       "btcReturn": btc_hourly[end]["close"] / btc_hourly[previous]["close"] - 1})
    return paired


def build_features(btc_hourly, usd_hourly_doc, usd_daily_doc, btc_daily_doc):
    """Return copied BTC rows plus auditable indicators and data coverage.

    A BTC hour beginning at T uses the DXY bar ending exactly T-1h.  Its
    completed-day comparison close must end strictly before that DXY bar.
    Every price and correlation is conservatively available one hour after its
    final input closes.  No DXY point is carried into a missing/hourly gap.
    """
    usd_hours, usd_hour_coverage = clean_hourly(usd_hourly_doc)
    btc_hours, btc_hour_coverage = clean_hourly(btc_hourly)
    usd_days, usd_day_coverage = clean_daily(usd_daily_doc, "DXY")
    btc_days, btc_day_coverage = clean_daily(btc_daily_doc, "BTC")
    correlations = level_correlation_history(usd_days, btc_days)
    correlation_times = [row["_available"] for row in correlations]
    dollar_closes = sorted(usd_days.values(), key=lambda row: row["_end"])
    dollar_close_times = [row["_end"] for row in dollar_closes]
    return_pairs = hourly_return_pairs(usd_hours, btc_hours)
    return_times = [row["_end"] for row in return_pairs]
    output = []
    exclusion_counts = Counter()
    for original in rows(btc_hourly):
        row = {**original, "corr15Level": None, "corr30Level": None,
               "corr120Return": None, "usdSessionMoveBp": None, "usdHourMoveBp": None,
               "usdObservedAt": None, "usdAvailableAt": None, "corrAvailableAt": None,
               "corrSourceDate": None, "usdSessionCloseDate": None,
               "usdSessionCloseAt": None, "usdSessionClose": None, "usdClose": None,
               "dailyReferenceDate": None, "usdReferenceAvailableAt": None, "referenceAgeHours": None,
               "corr120ReturnEndAt": None, "corr120ReturnAvailableAt": None,
               "corr120ReturnCount": 0, "indicatorEligible": False,
               "indicatorExclusionReason": None}
        try:
            target = instant(original.get("hourStart") or original.get("startAt"))
            target_end = instant(original["endAt"])
        except (KeyError, ValueError, TypeError):
            row["indicatorExclusionReason"] = "Invalid BTC target timestamp"
            output.append(row)
            exclusion_counts[row["indicatorExclusionReason"]] += 1
            continue
        predictor_end = target - HOUR
        predictor = usd_hours.get(predictor_end)
        btc_valid = target_end in btc_hours and btc_hours[target_end]["_start"] == target
        corr_index = bisect_right(correlation_times, target) - 1
        if corr_index >= 0:
            daily = correlations[corr_index]
            row.update({key: daily[key] for key in ("corr15Level", "corr30Level", "corrSourceDate")})
            row["corrAvailableAt"] = iso(daily["_available"])
        # bisect_left equivalent ensures a close at the predictor end is excluded.
        session_index = bisect_right(dollar_close_times, predictor_end - timedelta(microseconds=1)) - 1
        baseline = dollar_closes[session_index] if session_index >= 0 else None
        if baseline is not None and baseline["_available"] > target:
            baseline = None
        if predictor is not None:
            row.update({"usdObservedAt": iso(predictor_end), "usdAvailableAt": iso(predictor_end + HOUR),
                        "usdClose": predictor["close"], "usdRawResponse": predictor.get("rawResponse")})
            previous = usd_hours.get(predictor_end - HOUR)
            if previous is not None:
                row["usdHourMoveBp"] = (predictor["close"] / previous["close"] - 1) * 10_000
            if baseline is not None:
                row.update({"usdSessionCloseDate": baseline["date"], "usdSessionCloseAt": iso(baseline["_end"]),
                            "usdSessionClose": baseline["close"],
                            "dailyReferenceDate": baseline["date"],
                            "usdReferenceAvailableAt": iso(baseline["_available"]),
                            "referenceAgeHours": (target - baseline["_available"]).total_seconds() / 3600,
                            "usdSessionMoveBp": (predictor["close"] / baseline["close"] - 1) * 10_000})
        pairs_end = bisect_right(return_times, predictor_end)
        selected = return_pairs[max(0, pairs_end - RETURN_WINDOW):pairs_end]
        selected = [pair for pair in selected if pair["_end"] >= predictor_end - RETURN_MAX_AGE]
        row["corr120ReturnCount"] = len(selected)
        if len(selected) == RETURN_WINDOW:
            row["corr120Return"] = pearson([(pair["usdReturn"], pair["btcReturn"]) for pair in selected])
            row["corr120ReturnEndAt"] = iso(selected[-1]["_end"])
            row["corr120ReturnAvailableAt"] = iso(selected[-1]["_end"] + HOUR)
        if not btc_valid:
            reason = "Invalid or conflicting BTC target bar"
        elif predictor is None:
            reason = "No DXY bar ending exactly one hour before BTC hour"
        else:
            reason = None
        row["indicatorEligible"] = reason is None
        row["indicatorExclusionReason"] = reason
        if reason:
            exclusion_counts[reason] += 1
        output.append(row)
    coverage = {"btcHourly": btc_hour_coverage, "usdHourly": usd_hour_coverage,
                "usdDaily": usd_day_coverage, "btcDaily": btc_day_coverage,
                "pairedDailyObservations": len(correlations), "pairedHourlyReturns": len(return_pairs),
                "targetRows": len(output), "indicatorEligibleHours": sum(row["indicatorEligible"] for row in output),
                "featureCounts": {key: sum(row.get(key) is not None for row in output)
                                  for key in ("corr15Level", "corr30Level", "corr120Return", "usdSessionMoveBp", "usdHourMoveBp")},
                "missingFeatureCounts": {key: sum(row.get(key) is None for row in output)
                                         for key in ("corr15Level", "corr30Level", "corr120Return", "usdSessionMoveBp", "usdHourMoveBp")},
                "referencesOlderThan48Hours": sum(row["referenceAgeHours"] is not None and row["referenceAgeHours"] > 48 for row in output),
                "exclusionCounts": dict(exclusion_counts),
                "availabilityPolicy": "Daily observations use collector availability (next New York midnight for DXY; next UTC midnight for BTC) plus one hour. Full hourly bars use bar end plus one hour. No historical publication timestamps or exact official DXY closing times are asserted.",
                "referenceAgeBasis": "Hours since completed daily reference became conservatively available, not hours since the final index tick.",
                "priceLagHours": 1, "dailyCorrelationBasis": "Aligned daily closing price levels; Pearson, full precision",
                "returnCorrelationWindow": RETURN_WINDOW, "returnCorrelationMaxAgeDays": RETURN_MAX_AGE.days}
    return output, coverage
