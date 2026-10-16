#!/usr/bin/env python3
"""Standalone BTC entry-position research using preserved signal and USD evidence."""
from __future__ import annotations

import argparse
from collections import Counter
import csv
import hashlib
import json
import math
from pathlib import Path
import platform
import shutil

import numpy as np

from btc_hourly_bias import SEED, dump, write_csv
from btc_usd_experiment import VARIATIONS, summarize, triggered
from btc_usd_features import instant

ROOT = Path(__file__).resolve().parents[2]
INPUT = ROOT / "artifacts/btc-hourly-usd-experiment/hourly-observations.csv"
BASE = ROOT / "artifacts/btc-hourly-bias-experiment"
OUTPUT = ROOT / "artifacts/btc-range-entry-experiment"
PUBLIC = ROOT / "public/research/bitcoin"
COHORTS = [
    {"id": "bullish", "label": "Bullish"},
    {"id": "bearish", "label": "Bearish"},
    {"id": "neutral", "label": "Neutral"},
    {"id": "all", "label": "All known signals"},
    {"id": "current_bullish", "label": "Current bullish run"},
]
ZONES = [
    {"id": "below", "label": "Below range"},
    {"id": "bottom", "label": "Bottom third"},
    {"id": "middle", "label": "Middle third"},
    {"id": "top", "label": "Top third"},
    {"id": "above", "label": "Above range"},
]
ENTRY_MODES = [
    {"id": "all_hours", "label": "Every qualifying hour"},
    {"id": "first_per_day", "label": "First qualifying hour per Pacific day"},
]
FILTERS = [{"id": "none", "label": "No dollar filter"}] + [
    {"id": f"{spec['id']}_{direction.lower()}",
     "label": f"USD {direction.lower()} ≥{spec['bp']} bp · {spec['label'].split(' · ')[0]} correlation ≤{spec['limit']:.2f}"
              + (" · prior hour" if spec["move"] == "usdHourMoveBp" else " · completed-day reference"),
     "correlationField": spec["corr"], "correlationMax": spec["limit"],
     "moveField": spec["move"], "minimumMoveBp": spec["bp"], "usdDirection": direction}
    for spec in VARIATIONS for direction in ("DOWN", "UP")
]
FLOAT_FIELDS = ("open", "high", "low", "close", "volume", "returnPct", "previousCloseReturnPct",
                "lowerRange", "upperRange", "corr15Level", "corr30Level", "corr120Return",
                "usdSessionMoveBp", "usdHourMoveBp", "referenceAgeHours", "usdClose", "usdSessionClose")


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def thirds_zone(price, lower, upper):
    """Outside zones remain separate; internal boundary equality goes upward."""
    if not all(finite(value) and value > 0 for value in (price, lower, upper)) or lower >= upper:
        return None
    if price < lower:
        return "below"
    if price > upper:
        return "above"
    one_third = lower + (upper - lower) / 3
    two_thirds = lower + 2 * (upper - lower) / 3
    if price < one_third:
        return "bottom"
    if price < two_thirds:
        return "middle"
    return "top"


def preferred_direction(cohort, zone):
    if cohort in ("bullish", "current_bullish") and zone == "bottom":
        return "UP"
    if cohort == "bearish" and zone == "top":
        return "DOWN"
    return None


def load_observations(path):
    with path.open(newline="") as stream:
        observations = list(csv.DictReader(stream))
    for row in observations:
        for key in FLOAT_FIELDS:
            row[key] = float(row[key]) if row.get(key) not in (None, "") else None
        for key in ("currentBullishRun", "indicatorEligible"):
            row[key] = str(row.get(key, "")).lower() == "true"
        row["pacificHour"] = int(row["pacificHour"])
    return observations


def prepare_observations(observations):
    enriched, reasons = [], Counter()
    for original in observations:
        row = dict(original)
        reason = None
        if row.get("trend") not in ("BULLISH", "BEARISH", "NEUTRAL"):
            reason = "Unknown tracker signal"
        else:
            try:
                if instant(row["signalAvailableAt"]) > instant(row["hourStart"]):
                    reason = "Signal was not yet available at entry"
            except (KeyError, ValueError, TypeError):
                reason = "Missing signal availability time"
        zone = thirds_zone(row.get("open"), row.get("lowerRange"), row.get("upperRange"))
        if reason is None and zone is None:
            reason = "Missing or invalid known risk range"
        if reason is None and (row.get("direction") not in ("UP", "DOWN", "UNCHANGED") or not finite(row.get("returnPct"))):
            reason = "Missing completed BTC outcome"
        row["entryZone"] = zone if reason is None else None
        row["rangePositionFraction"] = ((row["open"] - row["lowerRange"]) / (row["upperRange"] - row["lowerRange"])) if zone is not None else None
        row["entryEligible"] = reason is None
        row["entryExclusionReason"] = reason
        row["qualifyingFilters"] = ["none"] if reason is None else []
        if reason is None:
            for spec in VARIATIONS:
                for direction in ("DOWN", "UP"):
                    if triggered(row, spec, direction):
                        row["qualifyingFilters"].append(f"{spec['id']}_{direction.lower()}")
        else:
            reasons[reason] += 1
        enriched.append(row)
    return enriched, dict(reasons)


def in_cohort(row, cohort):
    if not row.get("entryEligible"):
        return False
    if cohort == "all":
        return True
    if cohort == "current_bullish":
        return row["trend"] == "BULLISH" and row.get("currentBullishRun") is True
    return row["trend"].lower() == cohort


def select_entries(observations, cohort, zone, filter_id, entry_mode):
    selected = sorted((row for row in observations if in_cohort(row, cohort)
                       and row["entryZone"] == zone and filter_id in row["qualifyingFilters"]),
                      key=lambda row: row["hourStart"])
    if entry_mode == "all_hours":
        return selected
    if entry_mode != "first_per_day":
        raise ValueError(f"Unknown entry mode: {entry_mode}")
    seen, first = set(), []
    for row in selected:
        if row["pacificDay"] not in seen:
            seen.add(row["pacificDay"])
            first.append(row)
    return first


def calculate(observations, iterations=10000):
    results = []
    for cohort in COHORTS:
        for zone in ZONES:
            for filter_def in FILTERS:
                for mode in ENTRY_MODES:
                    keys = {"cohort": cohort["id"], "zone": zone["id"], "filter": filter_def["id"], "entryMode": mode["id"]}
                    selected = select_entries(observations, cohort["id"], zone["id"], filter_def["id"], mode["id"])
                    name = "range-entry|" + "|".join(keys.values())
                    stats = summarize(selected, name, iterations)
                    preferred = preferred_direction(cohort["id"], zone["id"])
                    results.append({**keys, **stats, "preferredDirection": preferred,
                                    "preferredPct": stats["upPct"] if preferred == "UP" else stats["downPct"] if preferred == "DOWN" else None,
                                    "preferredPct95": stats["upPct95"] if preferred == "UP" else stats["downPct95"] if preferred == "DOWN" else None})
    return results


PUBLIC_FIELDS = ["hourStart", "endAt", "pacificStart", "pacificDay", "pacificHour", "trend",
                 "currentBullishRun", "signalReportDate", "signalAvailableAt", "lowerRange", "upperRange",
                 "open", "high", "low", "close", "direction", "returnPct", "entryZone", "rangePositionFraction",
                 "entryEligible", "entryExclusionReason", "qualifyingFilters", "corr15Level", "corr30Level",
                 "corr120Return", "corrAvailableAt", "corrSourceDate", "corr120ReturnEndAt", "corr120ReturnAvailableAt",
                 "usdSessionMoveBp", "usdHourMoveBp", "usdObservedAt", "usdAvailableAt", "usdClose",
                 "dailyReferenceDate", "usdReferenceAvailableAt", "referenceAgeHours", "indicatorEligible",
                 "indicatorExclusionReason"]


def public_observations(observations):
    return [{key: row.get(key) for key in PUBLIC_FIELDS} for row in observations]


def settlement_checks(observations, path, iterations=10000):
    with path.open(newline="") as stream:
        settlements = {row["hourStart"]: row for row in csv.DictReader(stream)}
    results = []
    for cohort, zone in (("bullish", "bottom"), ("bearish", "top"), ("current_bullish", "bottom")):
        for filter_id in ("none", "main_down", "main_up"):
            for mode in ENTRY_MODES:
                selected = select_entries(observations, cohort, zone, filter_id, mode["id"])
                matched = [row for row in selected if row["hourStart"] in settlements]
                official = [{**row, "direction": settlements[row["hourStart"]]["direction"],
                             "returnPct": float(settlements[row["hourStart"]]["returnPct"])} for row in matched]
                keys = {"cohort": cohort, "zone": zone, "filter": filter_id, "entryMode": mode["id"]}
                stats = summarize(official, "range-brti|" + "|".join(keys.values()), iterations)
                results.append({**keys, **stats, "preferredDirection": preferred_direction(cohort, zone),
                                "coinbaseQualifyingHours": len(selected), "missingSettlementHours": len(selected) - len(matched),
                                "coinbaseMatchedUpPct": 100 * sum(row["direction"] == "UP" for row in matched) / len(matched) if matched else None,
                                "coinbaseMatchedDownPct": 100 * sum(row["direction"] == "DOWN" for row in matched) / len(matched) if matched else None})
    return results


def validate_totals(observations, results):
    lookup = {(r["cohort"], r["zone"], r["filter"], r["entryMode"]): r for r in results}
    expected = len(COHORTS) * len(ZONES) * len(FILTERS) * len(ENTRY_MODES)
    assert len(lookup) == len(results) == expected, "Missing or duplicated comparison groups"
    for row in results:
        assert row["hours"] == row["up"] + row["down"] + row["unchanged"]
        if row["hours"]:
            assert abs(row["upPct"] + row["downPct"] + row["unchangedPct"] - 100) < 1e-9
        if row["entryMode"] == "first_per_day":
            assert row["hours"] == row["days"]
            assert row["hours"] <= lookup[(row["cohort"], row["zone"], row["filter"], "all_hours")]["hours"]
        if row["zone"] in ("below", "above"):
            assert row["preferredDirection"] is None
    for filter_def in FILTERS:
        for zone in ZONES:
            all_row = lookup[("all", zone["id"], filter_def["id"], "all_hours")]
            for metric in ("hours", "up", "down", "unchanged"):
                assert all_row[metric] == sum(lookup[(cohort, zone["id"], filter_def["id"], "all_hours")][metric]
                                              for cohort in ("bullish", "bearish", "neutral"))
    assert sum(lookup[("all", zone["id"], "none", "all_hours")]["hours"] for zone in ZONES) == sum(row["entryEligible"] for row in observations)
    return {"comparisonGroups": expected, "countsReconciled": True, "percentagesReconciled": True,
            "firstPerDayReconciled": True, "allRegimesPartitionReconciled": True, "outsideZonesNeverPreferred": True}


def coverage(observations, reasons, base_manifest):
    eligible = [row for row in observations if row["entryEligible"]]
    return {"observedHours": len(observations), "expectedHours": base_manifest["priceCoverage"]["expectedHours"],
            "missingCandleHours": base_manifest["priceCoverage"]["expectedHours"] - len(observations),
            "knownSignalHours": sum(row.get("trend") in ("BULLISH", "BEARISH", "NEUTRAL") for row in observations),
            "eligibleEntryHours": len(eligible), "excludedHours": len(observations) - len(eligible),
            "unknownRangeHours": reasons.get("Missing or invalid known risk range", 0),
            "unknownSignalHours": reasons.get("Unknown tracker signal", 0), "exclusionCounts": reasons,
            "zoneHours": dict(Counter(row["entryZone"] for row in eligible)),
            "trendHours": dict(Counter(row["trend"] for row in eligible)),
            "freshUsdEntryHours": sum(row.get("indicatorEligible") is True for row in eligible),
            "currentBullishStart": base_manifest["currentRegime"].get("startedAt"),
            "rangeDefinition": "Three equal price-width sections of the published lower-to-upper range, assigned from the hour's opening price.",
            "missingIntervals": base_manifest["priceCoverage"].get("missingIntervals", [])}


def methodology(iterations):
    return [
        "Entry is the Coinbase BTC-USD opening price of a completed UTC hour; outcome is that hour's close versus its open. This is price direction, not a contract-strike win rate or profit simulation.",
        "The published Crypto Tracker Trend and lower/upper ranges apply only after verified publication and receipt. Trade is an alias of Trend in the archive; Buy/Sell Trade values are range boundaries, not separate directional signals.",
        "Bottom third includes the lower bound and excludes the one-third boundary. Middle includes one-third and excludes two-thirds. Top includes two-thirds and the upper bound. Prices below or above the published range are separate groups and never highlighted as preferred entries.",
        "Highlighted research setups are Bullish + bottom third → UP and Bearish + top third → DOWN. The highlighting encodes the requested hypothesis; it does not establish predictive value.",
        "Every qualifying hour is the primary mode. First per day selects the earliest qualifying hour within each Pacific calendar date and each specific regime × zone × filter. It does not imply a fixed daily execution time or select the most favorable hour afterward.",
        "The current bullish run is a subset of bullish history. All known signals combine bullish, bearish, and neutral hours. First-per-day counts across regimes need not add to the all-signals count because each group selects independently.",
        "Dollar filters use the previous experiment's preserved DXY observations and timing. The dollar point must end exactly one hour before BTC entry; missing hourly points are not carried forward. A 10 bp move is 0.10%.",
        "Dashboard-compatible correlations use 15 or 30 aligned daily price levels. The separate 120-observation return-correlation check uses matched hourly returns within 21 calendar days. Thresholds mean correlation ≤ −0.50 or ≤ −0.75.",
        "Completed-day dollar movement compares the earlier hourly DXY point with the latest available daily close. Daily DXY observations become available at next New York midnight plus one hour, and BTC daily observations at next UTC midnight plus one hour. Historical publication latency is unknown; these are conservative timing conventions. Prior-hour movement compares consecutive DXY hourly closes.",
        f"95% intervals resample complete Pacific calendar days with replacement ({iterations:,} replicates; fixed seed {SEED} plus a stable group hash). Fewer than 30 hours or 10 days is a limited sample; a single-day group has no reported interval.",
        "Unchanged hours remain in the percentage denominator. Missing candles, unresolved reports, and unavailable ranges are excluded and counted; prices are never filled. The many overlapping comparisons are exploratory and receive no multiple-comparison adjustment.",
        "Official BRTI checks use only previously verified consecutive final hourly settlements, matched to the same Coinbase-selected entry hours. They measure settlement-to-settlement direction separately from Coinbase open-to-close direction.",
    ]


def format_pct(value):
    return "—" if value is None else f"{value:.2f}%"


def readme(study):
    selected = [r for r in study["rows"] if r["preferredDirection"] and r["filter"] == "none" and r["entryMode"] == "all_hours"]
    labels = {row["id"]: row["label"] for row in COHORTS}
    lines = ["# Bitcoin range-entry experiment", "", "Historical research only. Frozen completed-hour cutoff: " + study["endAt"] + ".", "",
             "## Requested entry hypotheses", "", "| Setup | Hours / days | Desired direction | Frequency | 95% interval |", "|---|---:|---|---:|---:|"]
    for row in selected:
        bounds = row["preferredPct95"]
        lines.append(f"| {labels[row['cohort']]} / {row['zone']} third | {row['hours']} / {row['days']} | {row['preferredDirection']} | {format_pct(row['preferredPct'])} | {('%.1f–%.1f%%' % tuple(bounds)) if bounds else '—'} |")
    lines += ["", "All 750 combinations, including empty samples, are in `study.json` and `statistics.csv`.", "",
              "## Method", ""] + ["- " + text for text in study["methodology"]]
    lines += ["", "## Reproduce", "", "Run from the repository root, using the preserved inputs:", "",
              "```sh", "python3 scripts/research/btc_range_entry_experiment.py", "python3 -m unittest discover -s scripts/research -p 'test_btc_range_entry_experiment.py' -q", "```", "",
              "The default run creates only this private artifact directory. Public export requires an explicit `--public-output` directory; the current dashboard's combined hourly/daily study is generated by `btc_interval_study.py`. This legacy analysis performs no network requests, modifies no dashboard data pipeline, and sends no orders.", "",
              "Inputs: the prior USD experiment's hourly observations plus the original BTC study's manifest and final settlement changes. SHA-256 hashes and validation results appear in `manifest.json`. Public downloads contain derived hourly observations without subscriber message IDs, mail links, source images, or raw provider responses.", ""]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=INPUT)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--public-output", type=Path, default=None,
                        help="Explicit optional export directory; the default preserves the dashboard's combined interval study")
    parser.add_argument("--bootstrap", type=int, default=10000)
    args = parser.parse_args()
    if args.bootstrap < 1:
        raise ValueError("Bootstrap count must be positive")
    args.output.mkdir(parents=True, exist_ok=True)
    if args.public_output is not None:
        args.public_output.mkdir(parents=True, exist_ok=True)
    base_manifest = json.loads((BASE / "manifest.json").read_text())
    source = load_observations(args.input)
    observations, reasons = prepare_observations(source)
    rows = calculate(observations, args.bootstrap)
    validation = validate_totals(observations, rows)
    official = settlement_checks(observations, BASE / "settlement-changes.csv", args.bootstrap)
    study = {"schemaVersion": 1, "status": "historical", "title": "Bitcoin: entry within the published range",
             "asOf": base_manifest["asOf"], "startAt": min(row["hourStart"] for row in observations), "endAt": base_manifest["cutoff"],
             "coverage": coverage(observations, reasons, base_manifest), "entryModes": ENTRY_MODES,
             "cohorts": COHORTS, "zones": ZONES, "filters": FILTERS, "rows": rows,
             "preferredSummary": [r for r in rows if r["preferredDirection"] and r["filter"] == "none" and r["entryMode"] == "all_hours"],
             "methodology": methodology(args.bootstrap), "settlementChecks": official,
             "downloads": [{"label": "Hourly observations", "href": "/research/bitcoin/hourly-observations.csv"},
                           {"label": "All comparison results", "href": "/research/bitcoin/statistics.csv"},
                           {"label": "Official settlement checks", "href": "/research/bitcoin/settlement-checks.csv"},
                           {"label": "Source and coverage manifest", "href": "/research/bitcoin/manifest.json"},
                           {"label": "Method and reproduction", "href": "/research/bitcoin/README.md"}]}
    dump(args.output / "study.json", study)
    write_csv(args.output / "hourly-observations.csv", public_observations(observations))
    write_csv(args.output / "statistics.csv", rows)
    write_csv(args.output / "settlement-checks.csv", official)
    dump(args.output / "coverage.json", study["coverage"])
    (args.output / "README.md").write_text(readme(study), encoding="utf-8")
    files = [args.input, BASE / "manifest.json", BASE / "settlement-changes.csv", Path(__file__),
             ROOT / "scripts/research/btc_usd_experiment.py", ROOT / "scripts/research/btc_usd_features.py"]
    manifest = {"schemaVersion": 1, "study": study["title"], "historicalResearchOnly": True,
                "asOf": study["asOf"], "startAt": study["startAt"], "endAt": study["endAt"],
                "python": platform.python_version(), "numpy": np.__version__, "bootstrapReplicates": args.bootstrap,
                "seed": SEED, "bootstrapUnit": "Pacific calendar day", "validation": validation,
                "signalField": "Published Trend; trade is an alias, Buy/Sell Trade are range boundaries",
                "entryModeConvention": "First qualifying hour per Pacific date within each cohort/zone/filter",
                "inputsAndScripts": [{"path": str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path),
                                      "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in files],
                "coverage": study["coverage"], "publicPrivacy": "No source emails, message IDs, mail links, report images, or raw provider responses exported."}
    dump(args.output / "manifest.json", manifest)
    if args.public_output is not None:
        for name in ("study.json", "hourly-observations.csv", "statistics.csv", "settlement-checks.csv", "manifest.json", "README.md"):
            shutil.copyfile(args.output / name, args.public_output / name)
    print(json.dumps({"groups": len(rows), "coverage": study["coverage"], "preferred": study["preferredSummary"], "validation": validation}, indent=2))


if __name__ == "__main__":
    main()
