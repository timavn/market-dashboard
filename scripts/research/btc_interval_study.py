#!/usr/bin/env python3
"""Publish hourly and NYSE-session BTC range-entry research from verified archives."""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timedelta
import gzip
import hashlib
import json
from pathlib import Path
import shutil
from urllib.parse import parse_qs, urlparse

from btc_hourly_bias import SignalTimeline, direction_return, dump, signal_fields, write_csv
from btc_nyse_sessions import (DEFAULT_OUTPUT as SESSION_ARCHIVE, EASTERN, SOURCE as DAILY_SOURCE,
                               aggregate_session, normalize_quarter_hour, session_schedule)
from btc_quad_overlay import assign_quads, normalize_history
from btc_range_entry_experiment import (BASE, COHORTS, FILTERS, INPUT, PUBLIC, ZONES,
                                        in_cohort, load_observations, preferred_direction,
                                        prepare_observations, public_observations)
from btc_usd_experiment import summarize
from btc_usd_features import instant, iso, positive, rejected_provenance

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "artifacts/btc-interval-experiment"
QUAD_ARCHIVE = OUTPUT / "source-quads"
HOURLY_MODES = [{"id": "all_hours", "label": "Every qualifying hour"},
                {"id": "first_per_day", "label": "First qualifying hour per New York day"}]
DAILY_MODES = [{"id": "all_days", "label": "Every NYSE session"}]
FEATURE_FIELDS = ["corr15Level", "corr30Level", "corr120Return", "corrAvailableAt", "corrSourceDate",
                  "corr120ReturnEndAt", "corr120ReturnAvailableAt", "corr120ReturnCount",
                  "usdSessionMoveBp", "usdHourMoveBp", "usdObservedAt", "usdAvailableAt", "usdClose",
                  "usdSessionCloseDate", "usdSessionCloseAt", "usdSessionClose", "dailyReferenceDate",
                  "usdReferenceAvailableAt", "referenceAgeHours", "indicatorEligible", "indicatorExclusionReason"]


def unverified(row):
    flags = ("mock", "isMock", "seeded", "synthetic", "inferred", "portfolioDerived", "stale", "isStale", "cacheOnly", "cache_only")
    failed_statuses = {"offline", "disconnected", "error", "failed", "stale", "cache-only", "cache_only"}
    return (rejected_provenance(row) or any(str(row.get(key, "")).lower() == "true" for key in flags)
            or any(str(row.get(key, "")).lower() in failed_statuses for key in ("providerStatus", "status"))
            or row.get("providerConnected") is False or row.get("connected") is False)


def prepare_hourly(source, cutoff):
    slots, rejected, conflicts = {}, [], set()
    for row in source:
        try:
            start, end = instant(row["hourStart"]), instant(row["endAt"])
            if (unverified(row) or row.get("source") != "coinbase_exchange_public_hourly_candles"
                    or not row.get("rawResponse") or end > instant(cutoff)
                    or (end - start).total_seconds() != 3600
                    or start.minute or start.second or start.microsecond
                    or not all(positive(row.get(key)) for key in ("open", "high", "low", "close"))
                    or row.get("complete") is False or row.get("isComplete") is False):
                raise ValueError("Invalid, incomplete or unverified hourly candle")
            if not row["low"] <= min(row["open"], row["close"]) <= max(row["open"], row["close"]) <= row["high"]:
                raise ValueError("Invalid hourly candle extrema")
            direction, change = direction_return(row["open"], row["close"])
            local = start.astimezone(EASTERN)
            normalized = {**row, "direction": direction, "returnPct": change,
                          "newYorkDay": local.date().isoformat(), "newYorkStart": local.isoformat(timespec="seconds"),
                          "interval": "hourly", "timeZone": "America/New_York"}
            key = iso(start)
            if key in conflicts:
                continue
            if key in slots and slots[key] != normalized:
                del slots[key]
                conflicts.add(key)
                raise ValueError("Conflicting duplicate hourly observation")
            slots[key] = normalized
        except (KeyError, TypeError, ValueError) as error:
            rejected.append({"startAt": row.get("hourStart"), "endAt": row.get("endAt"), "reason": str(error)})
    return prepare_observations([slots[key] for key in sorted(slots)]), rejected


def archived_daily_prices(document, archive, schedule, cutoff):
    """Recheck original response hashes and every session boundary on each rerun."""
    if unverified(document) or document.get("source") != DAILY_SOURCE:
        raise ValueError("Unverified daily price archive")
    expected = {row["sessionDate"]: row for row in schedule}
    output, rejected, seen = [], [], set()
    day_counts = Counter(row.get("sessionDate") for row in document.get("rows", []))
    for recorded in document.get("rows", []):
        day = recorded.get("sessionDate")
        if day_counts[day] > 1:
            if day not in seen:
                rejected.append({"sessionDate": day, "reason": "Duplicate session observations"})
                seen.add(day)
            continue
        try:
            if day not in expected or day in seen or unverified(recorded):
                raise ValueError("Unexpected, duplicate or unverified session")
            seen.add(day)
            if recorded.get("source") != DAILY_SOURCE or not recorded.get("rawResponses"):
                raise ValueError("Missing verified daily price provenance")
            candles = []
            for relative in recorded["rawResponses"]:
                path = (archive / relative).resolve()
                if not path.is_relative_to(archive.resolve()):
                    raise ValueError("Invalid archived response path")
                raw = gzip.decompress(path.read_bytes())
                metadata = json.loads(path.with_suffix(".metadata.json").read_text())
                if hashlib.sha256(raw).hexdigest() != metadata.get("sha256"):
                    raise ValueError("Archived response hash mismatch")
                if metadata.get("httpStatus") != 200 or metadata.get("provider") != "coinbase":
                    raise ValueError("Unverified archived provider response")
                url = metadata.get("url", "")
                parsed = urlparse(url)
                query = parse_qs(parsed.query)
                if (parsed.scheme != "https" or parsed.netloc != "api.exchange.coinbase.com"
                        or parsed.path != "/products/BTC-USD/candles"
                        or query.get("granularity") != ["900"]
                        or query.get("start") != [expected[day]["startAt"]]
                        or query.get("end") != [expected[day]["endAt"]]
                        or path.name != hashlib.sha256(url.encode()).hexdigest()[:24] + ".json.gz"):
                    raise ValueError("Archived response is not the requested BTC session")
                candles.extend(normalize_quarter_hour(item, relative) for item in json.loads(raw))
            row, reason = aggregate_session(expected[day], candles, cutoff)
            if row is None:
                raise ValueError(reason)
            for key in ("startAt", "endAt", "open", "high", "low", "close", "volume", "candleCount"):
                if row[key] != recorded.get(key):
                    raise ValueError("Recorded session differs from original candles")
            output.append(row)
        except (OSError, KeyError, TypeError, ValueError) as error:
            rejected.append({"sessionDate": day, "reason": str(error)})
    for day in expected.keys() - seen:
        rejected.append({"sessionDate": day, "reason": "Missing completed session prices"})
    return sorted(output, key=lambda row: row["startAt"]), rejected


def past_features(opening, hourly):
    """09:30 entry uses the exact 09:00 feature snapshot, never the 10:00 row."""
    reference = opening.replace(minute=0, second=0, microsecond=0)
    source = hourly.get(iso(reference))
    empty = {key: None for key in FEATURE_FIELDS}
    empty.update({"indicatorEligible": False, "indicatorExclusionReason": "Prior completed dollar observations unavailable",
                  "indicatorReferenceAt": iso(reference)})
    if source is None:
        return empty
    result = {**empty, **{key: source.get(key) for key in FEATURE_FIELDS}}
    for key in ("usdAvailableAt", "corrAvailableAt", "corr120ReturnAvailableAt", "usdReferenceAvailableAt"):
        if result.get(key) and instant(result[key]) > opening:
            return {**empty, "indicatorExclusionReason": "Dollar feature was not yet available at entry"}
    if result.get("usdObservedAt") and instant(result["usdObservedAt"]) != reference - timedelta(hours=1):
        return {**empty, "indicatorExclusionReason": "Nonconsecutive prior dollar observation"}
    if result.get("referenceAgeHours") is not None:
        result["referenceAgeHours"] += (opening - reference).total_seconds() / 3600
    return result


def prepare_daily(prices, timeline, hourly, current_start):
    output = []
    hourly_by_time = {row["hourStart"]: row for row in hourly}
    for price in prices:
        opening = instant(price["startAt"])
        if unverified(price) or price.get("source") != DAILY_SOURCE or not price.get("rawResponses"):
            continue
        row = {**price, **signal_fields(timeline, opening, current_start),
               **past_features(opening, hourly_by_time), "interval": "daily", "timeZone": "America/New_York",
               "newYorkDay": price["sessionDate"], "newYorkStart": opening.astimezone(EASTERN).isoformat(timespec="seconds")}
        row["direction"], row["returnPct"] = direction_return(price["open"], price["close"])
        output.append(row)
    return prepare_observations(output)


def select(observations, cohort, zone, filter_id, entry_mode):
    selected = sorted((row for row in observations if in_cohort(row, cohort)
                       and row["entryZone"] == zone and filter_id in row["qualifyingFilters"]), key=lambda row: row["hourStart"])
    if entry_mode in ("all_hours", "all_days"):
        return selected
    if entry_mode != "first_per_day":
        raise ValueError("Unknown interval entry mode")
    first = {}
    for row in selected:
        first.setdefault(row["newYorkDay"], row)
    return list(first.values())


def calculate(observations, interval_id, modes, iterations, sample_name=None):
    results = []
    for cohort in COHORTS:
        for zone in ZONES:
            for filter_def in FILTERS:
                for mode in modes:
                    keys = {"cohort": cohort["id"], "zone": zone["id"], "filter": filter_def["id"], "entryMode": mode["id"]}
                    selected = select(observations, *keys.values())
                    # Adapter only: the established bootstrap routine names its group key pacificDay.
                    stats = summarize([{**row, "pacificDay": row["newYorkDay"]} for row in selected],
                                      "ny-interval|" + (sample_name or interval_id) + "|" + "|".join(keys.values()), iterations)
                    stats["observations"] = stats["hours"]
                    if interval_id == "daily":
                        del stats["hours"]
                    preferred = preferred_direction(cohort["id"], zone["id"])
                    results.append({**keys, **stats, "preferredDirection": preferred,
                                    "preferredPct": stats["upPct"] if preferred == "UP" else stats["downPct"] if preferred == "DOWN" else None,
                                    "preferredPct95": stats["upPct95"] if preferred == "UP" else stats["downPct95"] if preferred == "DOWN" else None})
    return results


def validate(observations, results, modes, daily=False):
    assert len(results) == len(COHORTS) * len(ZONES) * len(FILTERS) * len(modes)
    lookup = {(r["cohort"], r["zone"], r["filter"], r["entryMode"]): r for r in results}
    assert len(lookup) == len(results)
    for row in results:
        assert row["observations"] == row["up"] + row["down"] + row["unchanged"]
        if row["observations"]:
            assert abs(row["upPct"] + row["downPct"] + row["unchangedPct"] - 100) < 1e-9
        if daily or row["entryMode"] == "first_per_day":
            assert row["observations"] == row["days"]
    mode = modes[0]["id"]
    assert sum(lookup[("all", zone["id"], "none", mode)]["observations"] for zone in ZONES) == sum(r["entryEligible"] for r in observations)
    for zone in ZONES:
        for filter_def in FILTERS:
            for metric in ("observations", "up", "down", "unchanged"):
                assert lookup[("all", zone["id"], filter_def["id"], mode)][metric] == sum(lookup[(cohort, zone["id"], filter_def["id"], mode)][metric] for cohort in ("bullish", "bearish", "neutral"))
    return {"comparisonGroups": len(results), "countsReconciled": True, "percentagesReconciled": True,
            "allRegimesPartitionReconciled": True, "newYorkDayGrouping": True}


def coverage(observations, reasons, expected, missing, incomplete, current_start):
    eligible = sum(row["entryEligible"] for row in observations)
    return {"observedIntervals": len(observations), "expectedIntervals": expected,
            "eligibleEntryIntervals": eligible, "excludedIntervals": len(observations) - eligible,
            "missingIntervalCount": expected - len(observations), "missingCandleIntervals": expected - len(observations),
            "missingIntervals": missing, "incompleteIntervals": len(incomplete), "incompleteIntervalDetails": incomplete,
            "unknownSignalIntervals": reasons.get("Unknown tracker signal", 0), "exclusionCounts": reasons,
            "currentBullishStart": iso(current_start), "trendIntervals": dict(Counter(r["trend"] for r in observations if r["entryEligible"])),
            "freshUsdEntryIntervals": sum(r["entryEligible"] and r.get("indicatorEligible") is True for r in observations)}


def methodology(interval_id, iterations):
    basis = ("Hourly observations cover all 24 hours, including weekends. Entry is the opening price of a completed UTC hour; outcome is its close versus its open."
             if interval_id == "hourly" else
             "Daily observations use the 09:30 America/New_York BTC-USD opening price and the close at 16:00, or 13:00 on official NYSE early-close dates. Weekends, NYSE holidays and incomplete sessions are excluded. These are BTC spot prices sampled during NYSE hours.")
    return [basis,
            "Closing prices determine UP, DOWN or UNCHANGED; intraperiod highs, lows and touches do not determine the outcome. This is price-direction research, not perpetual-futures returns, contract win rates or a profit simulation.",
            "Published Trend and lower/upper ranges are evaluated at entry after verified publication and receipt. A report arriving during an interval applies only to later entries. Buy/Sell Trade values are range boundaries, not separate directional signals.",
            "The entry opening price assigns the bottom, middle or top third of the known published range. Below-range and above-range prices remain separate. Internal equality goes to the higher third; the upper boundary is included in the top third.",
            "Bullish + bottom third → UP and Bearish + top third → DOWN encode the requested hypotheses, without establishing predictive value. The current bullish run is a subset of bullish history.",
            ("First per day selects the earliest qualifying hour per New York calendar date within each regime, zone and dollar filter; it remains a one-hour outcome." if interval_id == "hourly" else
             "There is exactly one 09:30 entry per completed NYSE session. The full sequence of verified 15-minute candles must be present; no session prices are inferred from UTC daily bars or hourly bars."),
            ("Dollar filters preserve the original prior-hour timing: at hour T, the DXY candle must end exactly T minus one hour." if interval_id == "hourly" else
             "At 09:30, dollar filters use the 09:00 feature snapshot, whose DXY candle ended at 08:00 and conservatively became available at 09:00. A 10:00 snapshot is never used; missing prior points are not carried forward."),
            "Daily correlations use 15 or 30 matched daily price levels; the separate 120-observation check uses matched hourly returns within 21 calendar days. All feature availability must precede entry. Daily DXY and BTC references retain the original conservative next-midnight plus one-hour availability convention.",
            f"95% intervals resample New York calendar days with replacement ({iterations:,} replicates; fixed seed 20260915 plus a stable group hash). Fewer than 30 observations or 10 days is a limited sample. One-day groups have no interval. Unchanged outcomes remain in every percentage denominator.",
            "Missing prices and unavailable signals or ranges are excluded and counted. The frozen cutoff remains 2026-09-15T18:00:00Z (14:00 New York), so September 15 has hourly observations and no completed daily observation. The comparisons are exploratory, overlapping and unadjusted for multiple testing."]


def public_rows(observations):
    base = public_observations(observations)
    extra = ("interval", "timeZone", "newYorkDay", "newYorkStart", "sessionDate", "earlyClose", "candleCount", "indicatorReferenceAt",
             "quad", "quadQuarter", "quadKind", "quadSource", "quadBasis", "quadSourceAsOf", "quadAvailableAt", "quadExclusionReason")
    return [{**row, **{key: original.get(key) for key in extra}, "source": "Coinbase BTC-USD", "historical": True, "executable": False}
            for row, original in zip(base, observations)]


def build_interval(interval_id, observations, reasons, expected, missing, incomplete, current_start, iterations, as_of):
    daily = interval_id == "daily"
    modes = DAILY_MODES if daily else HOURLY_MODES
    stats = calculate(observations, interval_id, modes, iterations)
    validation = validate(observations, stats, modes, daily)
    downloads = [{"label": ("Daily" if daily else "Hourly") + " observations", "href": f"/research/bitcoin/{interval_id}-observations.csv"},
                 {"label": "All comparison results", "href": f"/research/bitcoin/{interval_id}-statistics.csv"},
                 {"label": "Source and coverage manifest", "href": "/research/bitcoin/manifest.json"},
                 {"label": "Method and reproduction", "href": "/research/bitcoin/README.md"}]
    study = {"id": interval_id, "interval": interval_id, "label": "Daily · NYSE" if daily else "Hourly", "schemaVersion": 2,
             "status": "historical", "title": "Bitcoin: entry within the published range", "asOf": as_of,
             "timeZone": "America/New_York", "priceBasis": "open_to_close", "session": "nyse" if daily else "24h",
             "source": "Coinbase BTC-USD", "startAt": min(r["hourStart"] for r in observations),
             "endAt": max(r["endAt"] for r in observations), "entryModes": modes, "cohorts": COHORTS,
             "zones": ZONES, "filters": FILTERS, "rows": stats,
             "preferredSummary": [r for r in stats if r["preferredDirection"] and r["filter"] == "none" and r["entryMode"] == modes[0]["id"]],
             "coverage": coverage(observations, reasons, expected, missing, incomplete, current_start),
             "methodology": methodology(interval_id, iterations), "downloads": downloads, "settlementChecks": []}
    return study, validation


def quad_gap_coverage(gaps, interval_id, source, quad):
    """Classify absent time slots without inventing any price observations."""
    selected, count = [], 0
    for gap in gaps:
        start = gap.get("startInclusive") or gap.get("startAt")
        end = gap.get("endExclusive") or gap.get("endAt")
        if start is None and gap.get("sessionDate"):
            start = datetime.fromisoformat(gap["sessionDate"] + "T09:30:00").replace(tzinfo=EASTERN).isoformat()
        if start is None:
            raise ValueError("Missing interval timestamp prevents Quad coverage attribution")
        at = instant(start)
        times = []
        if interval_id == "hourly" and end:
            while at < instant(end):
                times.append({"hourStart": iso(at)})
                at += timedelta(hours=1)
        else:
            times.append({"hourStart": iso(at)})
        matched = sum(row["quad"] == quad for row in assign_quads(times, source, "retrospective_actual"))
        if matched:
            selected.append({**gap, "intervals": matched})
            count += matched
    return selected, count


def add_quad_overlays(study, observations, source, iterations):
    classified = assign_quads(observations, source, "retrospective_actual")
    relevant = [row for row in source["quarters"]
                if instant(row["periodStart"]) < instant(study["endAt"])
                and instant(row["periodEnd"]) > instant(study["startAt"])]
    metadata = {"basis": "retrospective_actual", "country": source["country"], "source": source["source"],
                "sourceAsOf": source["sourceAsOf"], "publishedAt": None, "availableAt": source["availableAt"],
                "quarterAssignments": [row for row in relevant if row["kind"] == "actual"],
                "excludedQuarters": [row for row in relevant if row["kind"] != "actual"],
                "classifiedIntervals": sum(row["quad"] is not None for row in classified),
                "unclassifiedIntervals": sum(row["quad"] is None for row in classified),
                "classifiedEligibleEntries": sum(row["quad"] is not None and row["entryEligible"] for row in classified),
                "unclassifiedEligibleEntries": sum(row["quad"] is None and row["entryEligible"] for row in classified)}
    assignments = "; ".join(f"Q{row['quarter'][-1]} {row['quarter'][:4]} → Quad {row['quad']}"
                             for row in metadata["quarterAssignments"])
    excluded = "; ".join(f"Q{row['quarter'][-1]} {row['quarter'][:4]} Quad {row['quad']} estimate"
                         for row in metadata["excludedQuarters"])
    methods = [
        "Quad overlays group BTC outcomes by Hedgeye's published historical United States quarterly classifications. They are retrospective actual-quarter cohorts, not forecasts known before each BTC entry or additional entry signals.",
        f"The G20 and Global tables printed {source['sourceAsOf']} agree on each included US quarter. Their original screenshots and reviewed transcription hashes are preserved. The source receipt/review was {source['availableAt']}; its original publication timestamp is unknown.",
        f"Published actual classifications: {assignments}. Excluded forecast-only quarters: {excluded or 'none'}. All-quads results retain the entire original BTC sample.",
        "Quarter assignment uses the BTC interval's entry timestamp in America/New_York. Hourly and daily outcomes, tracker availability, range thirds and dollar filters keep their original definitions. Each selected Quad recalculates its sample and uncertainty independently; unknown tracker periods remain excluded.",
    ]
    overlays, validations = [], {}
    for quad in (1, 2, 3, 4):
        selected = [row for row in classified if row["quad"] == quad]
        reasons = dict(Counter(row["entryExclusionReason"] for row in selected if not row["entryEligible"]))
        missing, missing_count = quad_gap_coverage(study["coverage"]["missingIntervals"], study["id"], source, quad)
        incomplete, _ = quad_gap_coverage(study["coverage"]["incompleteIntervalDetails"], study["id"], source, quad)
        rows = calculate(selected, study["id"], study["entryModes"], iterations, sample_name=f"{study['id']}|q{quad}")
        validations[f"q{quad}"] = validate(selected, rows, study["entryModes"], study["id"] == "daily")
        overlays.append({"id": f"q{quad}", "quad": quad, "label": f"Quad {quad}", "basis": "retrospective_actual",
            "rows": rows, "coverage": coverage(selected, reasons, len(selected) + missing_count, missing, incomplete,
                                                instant(study["coverage"]["currentBullishStart"])), "methodology": methods})
    assert sum(row["coverage"]["observedIntervals"] for row in overlays) == metadata["classifiedIntervals"]
    assert metadata["classifiedIntervals"] + metadata["unclassifiedIntervals"] == study["coverage"]["observedIntervals"]
    assert sum(row["coverage"]["eligibleEntryIntervals"] for row in overlays) == metadata["classifiedEligibleEntries"]
    assert metadata["classifiedEligibleEntries"] + metadata["unclassifiedEligibleEntries"] == study["coverage"]["eligibleEntryIntervals"]
    study["quadOverlay"], study["quadOverlays"] = metadata, overlays
    study["methodology"] += methods
    study["downloads"].insert(2, {"label": "Quad cohort results", "href": f"/research/bitcoin/{study['id']}-quad-statistics.csv"})
    return classified, validations


def readme(study):
    lines = ["# Bitcoin hourly and daily range-entry research", "", "Historical research only. Frozen cutoff: " + study["endAt"] + ".", ""]
    for interval in study["intervals"]:
        c = interval["coverage"]
        lines += ["## " + interval["label"], "", f"{c['observedIntervals']:,} completed price observations; {c['eligibleEntryIntervals']:,} eligible entries; {c['missingIntervalCount']} missing intervals; {c['incompleteIntervals']} incomplete intervals.", ""]
        lines += ["- " + item for item in interval["methodology"]] + [""]
        lines += ["### Published actual-quarter cohorts", "", "| Quad | Completed intervals | Eligible entries |", "|---|---:|---:|"]
        lines += [f"| {quad['label']} | {quad['coverage']['observedIntervals']:,} | {quad['coverage']['eligibleEntryIntervals']:,} |"
                  for quad in interval.get("quadOverlays", [])] + [""]
    lines += ["## Reproduce", "", "The derived analysis runs offline from the preserved archives:", "", "```sh", "python3 scripts/research/btc_interval_study.py", "python3 -m unittest discover -s scripts/research -p 'test_btc*py' -q", "```", "", "To collect/recheck the frozen NYSE-session source archive first:", "", "```sh", "python3 scripts/research/btc_nyse_sessions.py", "```", "", "Original subscriber reports, message identifiers, source links, and raw provider bodies remain private in artifacts. Public CSVs contain allowlisted derived historical observations and timing. Manifest hashes identify all input documents and scripts. No live dashboard data or order path is modified.", ""]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--public-output", type=Path, default=PUBLIC)
    parser.add_argument("--session-archive", type=Path, default=SESSION_ARCHIVE)
    parser.add_argument("--quad-archive", type=Path, default=QUAD_ARCHIVE)
    parser.add_argument("--bootstrap", type=int, default=10000)
    args = parser.parse_args()
    if args.bootstrap < 1:
        raise ValueError("Bootstrap replicates must be positive")
    base_manifest = json.loads((BASE / "manifest.json").read_text())
    cutoff, as_of = base_manifest["cutoff"], base_manifest["asOf"]
    raw_hourly = load_observations(INPUT)
    (hourly, hourly_reasons), hourly_rejected = prepare_hourly(raw_hourly, cutoff)
    start = min(row["hourStart"] for row in hourly)
    sessions, incomplete = session_schedule(start, cutoff)
    session_path = args.session_archive / "sessions.json"
    session_doc = json.loads(session_path.read_text())
    prices, missing = archived_daily_prices(session_doc, args.session_archive, sessions, cutoff)
    signal_path = BASE / "source-signals/signals.json"
    timeline = SignalTimeline(json.loads(signal_path.read_text()))
    current_start = instant(base_manifest["currentRegime"]["startedAt"])
    daily, daily_reasons = prepare_daily(prices, timeline, hourly, current_start)
    hourly_study, hourly_validation = build_interval("hourly", hourly, hourly_reasons,
        base_manifest["priceCoverage"]["expectedHours"], base_manifest["priceCoverage"]["missingIntervals"] + hourly_rejected,
        [], current_start, args.bootstrap, as_of)
    daily_study, daily_validation = build_interval("daily", daily, daily_reasons,
        len(sessions), missing, incomplete, current_start, args.bootstrap, as_of)
    quad_history_path = args.quad_archive / "global-quads-history.json"
    quad_source = normalize_history(json.loads(quad_history_path.read_text()), args.quad_archive, cutoff)
    dump(args.quad_archive / "us-quarterly-checkpoint.json", quad_source)
    hourly, hourly_quad_validation = add_quad_overlays(hourly_study, hourly, quad_source, args.bootstrap)
    daily, daily_quad_validation = add_quad_overlays(daily_study, daily, quad_source, args.bootstrap)
    study = {"schemaVersion": 2, "status": "historical", "title": hourly_study["title"], "asOf": as_of,
             "startAt": start, "endAt": cutoff, "intervals": [hourly_study, daily_study]}
    files = [INPUT, BASE / "manifest.json", signal_path, session_path, args.session_archive / "fetch-manifest.json",
             Path(__file__), ROOT / "scripts/research/btc_nyse_sessions.py", ROOT / "scripts/research/btc_range_entry_experiment.py",
             ROOT / "scripts/research/btc_hourly_bias.py", ROOT / "scripts/research/btc_usd_experiment.py", ROOT / "scripts/research/btc_usd_features.py",
             ROOT / "scripts/research/btc_quad_overlay.py", quad_history_path, args.quad_archive / "us-quarterly-checkpoint.json",
             args.quad_archive / "g20.png", args.quad_archive / "global.png",
             ROOT / "src/utils/usEquityMarketCalendar.cjs"]
    manifest = {"schemaVersion": 2, "historicalResearchOnly": True, "study": study["title"], "asOf": as_of,
                "startAt": start, "endAt": cutoff, "timeZone": "America/New_York", "priceBasis": "open_to_close",
                "bootstrapReplicates": args.bootstrap, "seed": 20260915, "bootstrapUnit": "New York calendar day",
                "calendarSources": session_doc["calendarSources"],
                "validation": {"hourly": hourly_validation, "daily": daily_validation},
                "quadOverlayValidation": {"hourly": hourly_quad_validation, "daily": daily_quad_validation},
                "quadOverlay": {"hourly": hourly_study["quadOverlay"], "daily": daily_study["quadOverlay"]},
                "coverage": {"hourly": hourly_study["coverage"], "daily": daily_study["coverage"]},
                "inputsAndScripts": [{"path": str(path.relative_to(ROOT)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in files],
                "publicPrivacy": "No subscriber report content, message IDs, mail links, source images or raw provider bodies exported."}
    args.output.mkdir(parents=True, exist_ok=True)
    args.public_output.mkdir(parents=True, exist_ok=True)
    dump(args.output / "study.json", study)
    dump(args.output / "manifest.json", manifest)
    (args.output / "README.md").write_text(readme(study), encoding="utf-8")
    for interval, observations in ((hourly_study, hourly), (daily_study, daily)):
        write_csv(args.output / f"{interval['id']}-observations.csv", public_rows(observations))
        write_csv(args.output / f"{interval['id']}-statistics.csv", interval["rows"])
        write_csv(args.output / f"{interval['id']}-quad-statistics.csv", [
            {"quad": overlay["quad"], "quadBasis": overlay["basis"], **row}
            for overlay in interval["quadOverlays"] for row in overlay["rows"]])
    # Preserve the established hourly download URL, alongside explicit interval URLs.
    shutil.copyfile(args.output / "hourly-statistics.csv", args.output / "statistics.csv")
    for name in ("study.json", "manifest.json", "README.md", "hourly-observations.csv", "daily-observations.csv", "hourly-statistics.csv", "daily-statistics.csv", "hourly-quad-statistics.csv", "daily-quad-statistics.csv", "statistics.csv"):
        shutil.copyfile(args.output / name, args.public_output / name)
    print(json.dumps({"coverage": manifest["coverage"], "validation": manifest["validation"], "dailyPreferred": daily_study["preferredSummary"]}, indent=2))


if __name__ == "__main__":
    main()
