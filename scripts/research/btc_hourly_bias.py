#!/usr/bin/env python3
"""Reproducible historical BTC direction study; never provides executable quotes.

Consumes evidence collected by btc_signal_history.py and btc_price_history.py.
No credentials, live dashboard writes, or trade simulations are involved.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import math
import platform
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

UTC = timezone.utc
PACIFIC = ZoneInfo("America/Los_Angeles")
EASTERN = ZoneInfo("America/New_York")
STATES = ("BULLISH", "BEARISH", "NEUTRAL")
GROUPS = ("Current bullish run", "All bullish periods", "Bearish periods", "Neutral periods", "All known-signal hours")
ZONES = ("Below lower range", "Lower half", "Upper half", "Above upper range")
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT = ROOT / "artifacts/btc-hourly-bias-experiment"
SEED = 20260915


def instant(value):
    if not isinstance(value, str) or "T" not in value:
        raise ValueError(f"A full timestamp is required: {value!r}")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError(f"Timestamp needs a timezone: {value!r}")
    return parsed.astimezone(UTC)


def iso(value):
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def positive(value):
    if isinstance(value, bool) or value is None:
        return False
    try:
        return math.isfinite(float(value)) and float(value) > 0
    except (ValueError, TypeError):
        return False


def forbidden_provenance(row):
    import re
    flags = ("mock", "isMock", "seeded", "synthetic", "inferred", "portfolioDerived")
    if any(row.get(key) is True for key in flags):
        return True
    return bool(re.search(r"mock|seed|fixture|synthetic|inferred|portfolio|fallback", str(row.get("source", "")), re.I))


def pacific_time(value):
    return instant(value).astimezone(PACIFIC).strftime("%b %d, %Y %H:%M %Z") if value else "Unresolved"


def observed_rows(document):
    if isinstance(document, list):
        return document
    return document.get("rows", document.get("signals", document.get("records", [])))


def range_zone(price, lower, upper):
    if not all(positive(v) for v in (price, lower, upper)) or float(lower) >= float(upper):
        return None
    price, lower, upper = map(float, (price, lower, upper))
    if price < lower:
        return ZONES[0]
    if price <= (lower + upper) / 2:
        return ZONES[1]
    return ZONES[2] if price <= upper else ZONES[3]


class SignalTimeline:
    """Report availability, validity bounds and explicit gaps; no backward fill."""

    def __init__(self, document):
        self.document = document
        self.events = []
        self.interruptions = []
        for item in document.get("interruptions", []):
            self.interruptions.append((instant(item["startAt"]), instant(item["endAt"]) if item.get("endAt") else None, item.get("reason", "Unresolved source gap")))
        for item in observed_rows(document):
            row = dict(item)
            available = row.get("availableAt")
            if not available:
                date = row.get("reportDate")
                if not date:
                    continue
                available = iso(datetime.fromisoformat(date).replace(tzinfo=EASTERN))
                row["exclusionReason"] = row.get("exclusionReason") or "Verified availability time missing"
            row["_available"] = instant(available)
            row["_until"] = instant(row["validUntil"]) if row.get("validUntil") else None
            row["_state"] = str(row.get("trend") or "").upper()
            eligible = row.get("directionEligible", row.get("eligible", False))
            row["_eligible"] = bool(eligible) and row["_state"] in STATES and not row.get("exclusionReason")
            # Both publication and receipt evidence are required for this timed study.
            publication, received = row.get("publicationAt"), row.get("receivedAt")
            if not publication or not received:
                row["_eligible"] = False
                row["exclusionReason"] = row.get("exclusionReason") or "Publication or receipt evidence missing"
            elif row["_available"] < max(instant(publication), instant(received)):
                raise ValueError("Signal availability precedes publication or receipt")
            self.events.append(row)
        self.events.sort(key=lambda r: (r["_available"], r.get("reportDate", ""), r.get("sourceMessageId", "")))
        # Conflicting independent reports at the same instant must not depend on sort order.
        for i in range(1, len(self.events)):
            left, right = self.events[i - 1], self.events[i]
            if left["_available"] == right["_available"] and left["_state"] != right["_state"]:
                left["_eligible"] = right["_eligible"] = False
                left["exclusionReason"] = right["exclusionReason"] = "Conflicting simultaneous source states"

    def at(self, time):
        for start, end, reason in self.interruptions:
            if start <= time and (end is None or time < end):
                return None, reason
        chosen = None
        for row in self.events:
            if row["_available"] > time:
                break
            chosen = row
        if chosen is None:
            return None, "Before first timed report"
        for start, end, _reason in self.interruptions:
            if end is not None and time >= end and chosen["_available"] < end:
                return None, "No verified report after source gap"
        if chosen["_until"] and time >= chosen["_until"]:
            return None, "Signal validity ended before this hour"
        if not chosen["_eligible"]:
            return None, chosen.get("exclusionReason") or "Report direction unavailable"
        return chosen, None


def clean_candles(document, cutoff):
    slots, rejected = {}, []
    for row in observed_rows(document):
        try:
            start, end = instant(row["startAt"]), instant(row["endAt"])
            if end > cutoff:
                raise ValueError("Incomplete hour")
            if end - start != timedelta(hours=1) or start.minute or start.second or start.microsecond:
                raise ValueError("Non-hourly candle boundary")
            if not all(positive(row.get(k)) for k in ("open", "high", "low", "close")):
                raise ValueError("Invalid OHLC")
            if forbidden_provenance(row):
                raise ValueError("Unverified research-price provenance")
            if float(row["low"]) > min(float(row["open"]), float(row["close"])) or float(row["high"]) < max(float(row["open"]), float(row["close"])):
                raise ValueError("OHLC extrema inconsistent")
            if not row.get("source") or not row.get("rawResponse"):
                raise ValueError("Missing candle provenance")
            key = iso(start)
            if key in slots:
                prior = slots[key]
                if prior is None:
                    continue
                if any(prior.get(k) != row.get(k) for k in ("open", "high", "low", "close", "volume")):
                    slots[key] = None
                    rejected.append({"startAt": key, "reason": "Conflicting duplicate candle"})
                continue
            slots[key] = dict(row)
        except (KeyError, TypeError, ValueError) as error:
            rejected.append({"startAt": row.get("startAt"), "reason": str(error)})
    return [slots[k] for k in sorted(slots) if slots[k] is not None], rejected


def direction_return(start, end):
    start, end = float(start), float(end)
    return ("UP" if end > start else "DOWN" if end < start else "UNCHANGED"), (end / start - 1) * 100


def signal_fields(timeline, time, current_start=None):
    signal, reason = timeline.at(time)
    local = time.astimezone(PACIFIC)
    return {
        "hourStart": iso(time), "pacificStart": local.isoformat(timespec="seconds"),
        "pacificDay": local.date().isoformat(), "pacificHour": local.hour,
        "trend": signal["_state"] if signal else "UNKNOWN",
        "signalReportDate": signal.get("reportDate") if signal else None,
        "signalAvailableAt": iso(signal["_available"]) if signal else None,
        "signalSourceUrl": signal.get("sourceUrl") if signal else None,
        "signalMessageId": signal.get("sourceMessageId") if signal else None,
        "lowerRange": signal.get("lrr") if signal else None,
        "upperRange": signal.get("hrr") if signal else None,
        "exclusionReason": reason,
        "currentBullishRun": bool(signal and signal["_state"] == "BULLISH" and current_start and time >= current_start),
    }


def make_hourly(candles, timeline, current_start=None):
    output, previous = [], None
    for candle in candles:
        time = instant(candle["startAt"])
        row = {**signal_fields(timeline, time, current_start), **candle}
        row["direction"], row["returnPct"] = direction_return(row["open"], row["close"])
        row["rangeZone"] = range_zone(row["open"], row["lowerRange"], row["upperRange"])
        row["previousCloseDirection"], row["previousCloseReturnPct"] = None, None
        if previous and instant(previous["endAt"]) == time:
            row["previousCloseDirection"], row["previousCloseReturnPct"] = direction_return(previous["close"], row["close"])
        output.append(row)
        previous = candle
    return output


def make_settlement_changes(document, timeline, cutoff, current_start=None, study_start=None):
    by_time, rejects = {}, []
    for observation in observed_rows(document):
        try:
            time = instant(observation["closeAt"])
            if time > cutoff or time.minute or time.second:
                raise ValueError("Settlement outside completed hourly boundaries")
            if not positive(observation.get("value")) or not observation.get("eventTicker") or not observation.get("rawResponses"):
                raise ValueError("Settlement value or evidence missing")
            if forbidden_provenance(observation):
                raise ValueError("Unverified settlement provenance")
            if observation.get("status") != "finalized":
                raise ValueError("Non-final settlement")
            if observation.get("conflicting", False):
                raise ValueError("Conflicting strike settlement values")
            prior = by_time.get(time)
            if prior and float(prior["value"]) != float(observation["value"]):
                by_time[time] = None
                rejects.append({"closeAt": iso(time), "reason": "Conflicting simultaneous settlements"})
            elif time not in by_time:
                by_time[time] = observation
        except (KeyError, ValueError, TypeError) as error:
            rejects.append({"closeAt": observation.get("closeAt"), "reason": str(error)})
    output = []
    for time in sorted(by_time):
        if study_start is not None and time - timedelta(hours=1) < study_start:
            continue
        current, previous = by_time[time], by_time.get(time - timedelta(hours=1))
        if current is None or previous is None:
            continue
        row = signal_fields(timeline, time - timedelta(hours=1), current_start)
        direction, change = direction_return(previous["value"], current["value"])
        row.update({"endAt": iso(time), "previousSettlement": previous["value"], "settlement": current["value"],
                    "direction": direction, "returnPct": change, "eventTicker": current["eventTicker"],
                    "previousEventTicker": previous["eventTicker"], "source": current.get("source"),
                    "rawResponses": current["rawResponses"], "previousRawResponses": previous["rawResponses"]})
        output.append(row)
    return output, rejects


def cohort(rows, label):
    if label == GROUPS[0]:
        return [r for r in rows if r["currentBullishRun"]]
    if label == GROUPS[1]:
        return [r for r in rows if r["trend"] == "BULLISH"]
    if label == GROUPS[2]:
        return [r for r in rows if r["trend"] == "BEARISH"]
    if label == GROUPS[3]:
        return [r for r in rows if r["trend"] == "NEUTRAL"]
    return [r for r in rows if r["trend"] in STATES]


def summarize(rows, label, seed=SEED, iterations=10000, direction_key="direction", return_key="returnPct"):
    eligible = [r for r in rows if r.get(direction_key) in ("UP", "DOWN", "UNCHANGED")]
    n = len(eligible)
    counts = Counter(r[direction_key] for r in eligible)
    days = defaultdict(lambda: [0, 0])
    for row in eligible:
        days[row["pacificDay"]][0] += row[direction_key] == "UP"
        days[row["pacificDay"]][1] += 1
    interval = None
    if len(days) >= 2:
        values = np.array(list(days.values()), dtype=float)
        key = int.from_bytes(hashlib.sha256(label.encode()).digest()[:4], "little")
        rng = np.random.default_rng(seed ^ key)
        weights = rng.multinomial(len(values), np.full(len(values), 1 / len(values)), size=iterations)
        ratios = (weights @ values[:, 0]) / (weights @ values[:, 1]) * 100
        interval = [float(x) for x in np.quantile(ratios, [0.025, 0.975])]
    returns = [float(r[return_key]) for r in eligible if r.get(return_key) is not None]
    return {"label": label, "hours": n, "days": len(days), "up": counts["UP"], "down": counts["DOWN"],
            "unchanged": counts["UNCHANGED"], "upPct": counts["UP"] / n * 100 if n else None,
            "downPct": counts["DOWN"] / n * 100 if n else None,
            "unchangedPct": counts["UNCHANGED"] / n * 100 if n else None,
            "upPct95Interval": interval, "averageReturnPct": float(np.mean(returns)) if returns else None,
            "medianReturnPct": float(np.median(returns)) if returns else None,
            "limitedSample": n < 30 or len(days) < 10}


def write_csv(path, rows):
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    keys = list(dict.fromkeys(k for row in rows for k in row if not k.startswith("_")))
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, keys, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({k: json.dumps(v, separators=(",", ":")) if isinstance(v, (list, dict)) else v for k, v in row.items() if not k.startswith("_")})


def dump(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")


def number(value, digits=2, suffix=""):
    return "—" if value is None else f"{value:,.{digits}f}{suffix}"


def interval_text(row):
    value = row["upPct95Interval"]
    return "—" if value is None else f"{value[0]:.1f}–{value[1]:.1f}%"


def summary_table(rows):
    head = "| Period | Hours / days | Up / down / flat | Up % | 95% interval | Mean / median return |\n|---|---:|---:|---:|---:|---:|\n"
    return head + "\n".join(f"| {r['label']}{' †' if r['limitedSample'] else ''} | {r['hours']:,} / {r['days']} | {r['up']:,} / {r['down']:,} / {r['unchanged']:,} | {number(r['upPct'], 2, '%')} | {interval_text(r)} | {number(r['averageReturnPct'], 3, '%')} / {number(r['medianReturnPct'], 3, '%')} |" for r in rows)


def hour_table(by_hour):
    lines = ["| Hour starting PT | Current bullish | All bullish | Bullish 95% interval | Bearish | Neutral |",
             "|---|---:|---:|---:|---:|---:|"]
    def cell(row):
        return f"{number(row['upPct'], 1, '%')} ({row['hours']:,}){' †' if row['limitedSample'] else ''}"
    for hour in range(24):
        current, bullish, bearish, neutral = [by_hour[g][hour] for g in GROUPS[:4]]
        lines.append(f"| {hour:02}:00 | {cell(current)} | {cell(bullish)} | {interval_text(bullish)} | {cell(bearish)} | {cell(neutral)} |")
    return "\n".join(lines)


def matched_table(rows):
    return ("| Period | Same hours | Coinbase open→close up | BRTI settlement change up | Direction agrees |\n"
            "|---|---:|---:|---:|---:|\n" + "\n".join(
                f"| {r['label']} | {r['hours']:,} | {number(r['coinbaseUpPct'], 2, '%')} | {number(r['brtiUpPct'], 2, '%')} | {number(r['directionAgreementPct'], 2, '%')} |" for r in rows))


def conclusion(row):
    if not row["hours"]:
        return "No eligible hours were recovered for this period."
    majority = "more often up than down" if row["up"] > row["down"] else "more often down than up" if row["down"] > row["up"] else "equally often up and down"
    interval = row["upPct95Interval"]
    uncertainty = "The 95% interval includes 50%, so this sample does not clearly distinguish the up frequency from an even split."
    if interval and interval[0] > 50:
        uncertainty = "The daily-block 95% interval is above 50% in this covered sample."
    elif interval and interval[1] < 50:
        uncertainty = "The daily-block 95% interval is below 50% in this covered sample."
    elif not interval:
        uncertainty = "There are too few distinct days to estimate the daily-block interval."
    return f"BTC finished {majority}: {row['up']:,} up, {row['down']:,} down, and {row['unchanged']:,} unchanged hours ({row['upPct']:.2f}% up). {uncertainty}"


def make_charts(output, summaries, by_hour, hourly):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "axes.spines.top": False, "axes.spines.right": False})
    colors = ["#247953", "#247953", "#b74545", "#707780", "#434c58"]
    fig, ax = plt.subplots(figsize=(10, 3.5), layout="constrained")
    for i, (row, color) in enumerate(zip(summaries, colors)):
        if row["upPct"] is None:
            continue
        ax.scatter(row["upPct"], i, color=color, zorder=3, s=40)
        if row["upPct95Interval"]:
            ax.hlines(i, *row["upPct95Interval"], color=color, lw=2)
        ax.annotate(f" {row['upPct']:.1f}% · {row['hours']:,} hours", (row["upPct"], i), xytext=(5, 7), textcoords="offset points", fontsize=9)
    ax.set_yticks(range(len(summaries)), [r["label"] for r in summaries])
    ax.invert_yaxis()
    ax.axvline(50, color="#a4a9af", linestyle="--", lw=1)
    ax.set_xlabel("Hours closing above their open (%) · daily-block 95% intervals")
    ax.grid(axis="x", alpha=.15)
    fig.savefig(output / "direction-summary.png", dpi=180)
    plt.close(fig)
    fig, ax = plt.subplots(figsize=(10, 3.5), layout="constrained")
    for group, color, label in ((GROUPS[0], "#9ab6a5", "Current bullish run"), (GROUPS[1], "#247953", "All bullish periods")):
        values = by_hour[group]
        ax.plot(range(24), [r["upPct"] if r["upPct"] is not None else np.nan for r in values], marker="o", ms=3, color=color, label=label)
    ax.axhline(50, color="#a4a9af", linestyle="--", lw=1)
    ax.set_xticks(range(24), [f"{h:02}" for h in range(24)])
    ax.set_xlabel("Hour starting in America/Los_Angeles (DST-aware)")
    ax.set_ylabel("Up hours (%)")
    ax.legend(frameon=False, loc="best")
    ax.grid(axis="y", alpha=.15)
    fig.savefig(output / "hour-of-day.png", dpi=180)
    plt.close(fig)


def build_report(output, results, signal_document, hourly):
    groups = results["primary"]
    current = signal_document.get("currentRegime", {})
    onset = current.get("firstReportDate", current.get("reportDate", current.get("startedAt", "Unresolved")))
    onset_quality = current.get("onsetQuality", "unresolved")
    coverage = results["coverage"]
    text = f"""# Does BTC close up more often while the tracker is bullish?

Historical research · frozen at {pacific_time(results['asOf'])} · completed hours through {pacific_time(results['cutoff'])}

## Answer

**Current bullish run:** {conclusion(groups[0])}

**All recovered bullish periods:** {conclusion(groups[1])}

Across all known-signal hours, the up frequency was {number(groups[4]['upPct'], 2, '%')}. These samples overlap: the current run is part of all bullish history. The study measures direction, not a Kalshi strike's win rate or profitability.

## Current bullish start

First report in the current verified run: **{onset}**. Onset classification: **{onset_quality.replace('_', ' ')}**. Exact signal availability: {pacific_time(current.get('startedAt'))}.

{current.get('explanation', current.get('reason', 'Source transitions and any unresolved gaps are preserved in the signal history.'))}

The first complete eligible hour began at {pacific_time(min((r['startAt'] for r in hourly if r.get('currentBullishRun')), default=None))}. The experiment carries the last verified state between reports. Hedgeye specifies publication on U.S. trading days; weekends and market holidays were also checked for exceptional reports in the complete email inventory. [Publication schedule and Trend definition](https://app.hedgeye.com/user-guides/bitcoin-trend-tracker)

## Primary: hourly close versus open

{summary_table(groups)}

![Up frequency by signal](direction-summary.png)

Hours are assigned the most recent verified report available at their start. An intra-hour publication first applies to the next full hour. Unchanged hours remain in all percentage denominators. † indicates fewer than 30 hours or 10 distinct Pacific dates.

## Hour of day

![Hourly direction during bullish periods](hour-of-day.png)

Pacific clock hours include DST; repeated fall-back hours are separate UTC observations in the same clock-hour group. Full counts and intervals for every state/hour appear in the downloadable tables. These 24 comparisons are exploratory; the highest point is not a validated trading rule.

Each cell below shows **up percentage (number of hours)**.

{hour_table(results['byPacificHour'])}

## Position within the published range

Opening Coinbase price is compared with the tracker range known at that hour's start. Lower-half includes both the lower boundary and midpoint; upper-half includes the upper boundary. This comparison uses Coinbase spot prices against the published Hedgeye range, whose exact underlying feed is not assumed identical.

All recovered bullish periods:

{summary_table(results['rangeZones'][GROUPS[1]])}

Current bullish run, using the same fixed range zones:

{summary_table(results['rangeZones'][GROUPS[0]])}

Bullish hours with unavailable range boundaries: {results['bullishMissingRanges']:,}. They remain in the primary direction count and are excluded only from the range table.

Very small samples are especially limited: an all-up sample can produce a 100–100% resampling interval and cannot establish certainty about future hours. Other signal states and the combined sample are included in statistics.csv.

## Check 1: close versus previous hourly close

Only exactly consecutive candles qualify.

{summary_table(results['previousClose'])}

## Check 2: official Kalshi settlement versus previous hourly settlement

Published finalized KXBTCD expiration values are the official final-minute BRTI averages. Each event contributes one observation after agreeing strike values are deduplicated. Only observations exactly one hour apart qualify. Signal selection occurs at the earlier settlement time.

{summary_table(results['settlementChange'])}

This check measures change between settlement averages. It does not say whether buying Yes on any particular listed dollar strike would have won.

Because the Kalshi archive covers fewer hours, the comparison below uses **only identical hourly intervals available from both sources**. Candle open→close and settlement-average changes remain different definitions.

{matched_table(results['matchedSourceComparison'])}

## Coverage and limitations

- Coinbase interval: {coverage['startInclusive']} to {results['cutoff']} (UTC, end exclusive for hour starts).
- {coverage['expectedCandles']:,} expected hours; {coverage['observedCandles']:,} valid candles; {coverage['missingCandles']:,} missing/rejected hours.
- {coverage['knownSignalHours']:,} hours with usable signal timing; {coverage['unknownSignalHours']:,} observed hours excluded for unknown signal. Missing prices are never filled.
- {coverage['settlementObservations']:,} finalized hourly settlement observations yield {coverage['settlementPairs']:,} consecutive-hour changes; {coverage['knownSignalSettlementPairs']:,} have usable signal timing.
- Settlement gaps include unlisted hours and {coverage['excludedSettlementEvents']:,} events excluded by the collector for invalid or incomplete published settlement evidence. Their prices are not reconstructed from contract outcomes or nearby strikes.
- The signal archive is incomplete. Missing source tables, missing timestamps, and unverified publication-calendar gaps are exclusions, not neutral signals.
- Explicit signal interruptions cover August 6, 2025 (unavailable original image), October 6, 2025 (missing BTC table), and June 4–29, 2026 (missing trusted receipt times or reports). Exact boundaries and excluded hours are preserved in the coverage export.
- 95% intervals resample whole Pacific days with replacement ({results['bootstrapReplicates']:,} replicates; seed {SEED}), preserving within-day dependence. They do not eliminate dependence across days, selection bias from archive gaps, or the limited number of independent signal regimes.
- This tests an hourly implication of an intermediate-term Trend signal, which Hedgeye describes as a horizon of three months or more. It does not evaluate the signal's intended multi-month performance.
- Range and hour-of-day breakdowns are descriptive, without multiple-comparison claims. Returns are simple price changes, without leverage, entry prices, fees, or transaction-cost assumptions.

## Files and reproduction

- [Hourly observations](hourly-observations.csv)
- [Signal history and source evidence](signal-history.csv)
- [All cohort/hour/range statistics](statistics.csv)
- [Consecutive official settlement changes](settlement-changes.csv)
- [Coverage exclusions](coverage-exclusions.json)
- [Machine-readable results](results.json)
- [Source and reproducibility manifest](manifest.json)
- [Reproduction instructions](REPRODUCE.md)

Run `python3 scripts/research/btc_hourly_bias.py` from the repository root to regenerate this report from saved evidence without network access. Collection commands and source reconstruction steps are in the reproduction instructions. Original evidence and normalized inputs are preserved under `source-signals/` and `source-prices/`.

Primary references: [Coinbase hourly candle definitions](https://docs.cdp.coinbase.com/exchange/reference/exchangerestapi_getproductcandles), [Kalshi Bitcoin settlement rules](https://assets.kalshi.com/contract_terms/BTC.pdf). Individual Hedgeye reports are linked in signal-history.csv.
"""
    (output / "README.md").write_text(text, encoding="utf-8")
    # A self-contained HTML renderer for this fixed report structure; no external JavaScript.
    parts, in_table, in_list = [], False, False
    import re
    def inline(line):
        line = html.escape(line)
        line = re.sub(r"\*\*(.*?)\*\*", r"<strong>\1</strong>", line)
        line = re.sub(r"`([^`]+)`", r"<code>\1</code>", line)
        line = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', line)
        return line
    for line in text.splitlines():
        if not line.startswith("|") and in_table:
            parts.append("</tbody></table></div>"); in_table = False
        if not line.startswith("- ") and in_list:
            parts.append("</ul>"); in_list = False
        if not line:
            continue
        if line.startswith("|---"):
            continue
        if line.startswith("|"):
            cells = [inline(c.strip()) for c in line.strip("|").split("|")]
            if not in_table:
                parts.append('<div class="table-wrap"><table><thead><tr>' + "".join(f"<th>{c}</th>" for c in cells) + "</tr></thead><tbody>")
                in_table = True
            else:
                parts.append("<tr>" + "".join(f"<td>{c}</td>" for c in cells) + "</tr>")
        elif line.startswith("!["):
            match = re.match(r"!\[([^]]+)\]\(([^)]+)\)", line)
            import base64
            payload = base64.b64encode((output / match[2]).read_bytes()).decode()
            parts.append(f'<img alt="{html.escape(match[1])}" src="data:image/png;base64,{payload}">')
        elif line.startswith("# "):
            parts.append(f"<h1>{inline(line[2:])}</h1>")
        elif line.startswith("## "):
            parts.append(f"<h2>{inline(line[3:])}</h2>")
        elif line.startswith("- "):
            if not in_list:
                parts.append("<ul>"); in_list = True
            parts.append(f"<li>{inline(line[2:])}</li>")
        else:
            parts.append(f"<p>{inline(line)}</p>")
    if in_list: parts.append("</ul>")
    if in_table: parts.append("</tbody></table></div>")
    style = """body{font:15px/1.55 system-ui,sans-serif;color:#26303b;background:#f6f7f8;margin:0}main{max-width:1080px;margin:28px auto;padding:32px 40px;background:white;border:1px solid #dce1e5}h1{font-size:30px;line-height:1.2;max-width:850px}h2{font-size:20px;margin:30px 0 10px;border-top:1px solid #e3e7ea;padding-top:18px}a{color:inherit;text-decoration:none;border-bottom:1px dotted #9aa2a9}p{max-width:980px}img{max-width:100%;height:auto;display:block;margin:18px auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:9px 10px;border:1px solid #dce1e5;text-align:right;white-space:nowrap;font-weight:400}th{background:#f0f2f4;font-weight:600}th:first-child,td:first-child{text-align:left}li{margin:7px 0}.table-wrap{overflow:auto}code{background:#f1f3f5;padding:2px 5px}@media(max-width:700px){main{margin:0;padding:22px 16px}h1{font-size:25px}}@media print{body,main{background:white}main{margin:0;padding:0;border:0}h2{break-after:avoid}table,img{break-inside:avoid}}"""
    (output / "report.html").write_text('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BTC hourly direction study</title><style>' + style + "</style></head><body><main>" + "\n".join(parts) + "</main></body></html>", encoding="utf-8")


def run(args):
    output = args.output.resolve()
    signal_path, candle_path, settlement_path = args.signals, args.candles, args.settlements
    signals, candle_doc, settlement_doc = [json.loads(p.read_text()) for p in (signal_path, candle_path, settlement_path)]
    cutoff = instant(candle_doc["endExclusive"])
    start = instant(candle_doc["startInclusive"])
    timeline = SignalTimeline(signals)
    current = signals.get("currentRegime", {})
    current_start = instant(current["startedAt"]) if current.get("startedAt") else None
    candles, candle_rejects = clean_candles(candle_doc, cutoff)
    candles = [row for row in candles if start <= instant(row["startAt"]) < cutoff]
    hourly = make_hourly(candles, timeline, current_start)
    settlements, settlement_rejects = make_settlement_changes(settlement_doc, timeline, cutoff, current_start, study_start=start)
    if any(r["currentBullishRun"] for r in hourly) and not current_start:
        raise AssertionError("Current run needs verified start metadata")
    primary, previous, settlement = [], [], []
    matched = []
    settlements_by_start = {r['hourStart']: r for r in settlements}
    by_hour, zones = {}, {}
    stats_rows = []
    for group in GROUPS:
        selected = cohort(hourly, group)
        primary.append(summarize(selected, group, iterations=args.bootstrap))
        previous.append(summarize(selected, group + " · previous close", iterations=args.bootstrap, direction_key="previousCloseDirection", return_key="previousCloseReturnPct"))
        settlement.append(summarize(cohort(settlements, group), group + " · settlement", iterations=args.bootstrap))
        pairs = [(r, settlements_by_start[r['hourStart']]) for r in selected if r['hourStart'] in settlements_by_start]
        assert all(a['trend'] == b['trend'] for a, b in pairs)
        matched.append({'label': group, 'hours': len(pairs),
                        'coinbaseUpPct': sum(a['direction'] == 'UP' for a, _ in pairs) / len(pairs) * 100 if pairs else None,
                        'brtiUpPct': sum(b['direction'] == 'UP' for _, b in pairs) / len(pairs) * 100 if pairs else None,
                        'directionAgreementPct': sum(a['direction'] == b['direction'] for a, b in pairs) / len(pairs) * 100 if pairs else None})
        by_hour[group] = [summarize([r for r in selected if r["pacificHour"] == hour], f"{group} · {hour:02}:00 PT", iterations=args.bootstrap) for hour in range(24)]
        zones[group] = [summarize([r for r in selected if r["rangeZone"] == zone], f"{zone}", seed=SEED ^ int.from_bytes(hashlib.sha256(group.encode()).digest()[:4], "little"), iterations=args.bootstrap) for zone in ZONES]
        for item in [primary[-1], previous[-1], settlement[-1], *by_hour[group], *zones[group]]:
            stats_rows.append({"cohort": group, **item})
    known = cohort(hourly, GROUPS[4])
    expected = int((cutoff - start).total_seconds() // 3600)
    times = {instant(r["startAt"]) for r in candles}
    missing = [iso(start + timedelta(hours=i)) for i in range(expected) if start + timedelta(hours=i) not in times]
    exclusions = {"missingCandleStarts": missing, "rejectedCandles": candle_rejects, "rejectedSettlements": settlement_rejects,
                  "collectorRejectedCandles": candle_doc.get('rejected', []),
                  "collectorRejectedSettlementReasons": dict(Counter(r.get('reason') for r in settlement_doc.get('rejected', []))),
                  "collectorSettlementExclusionsFile": str(settlement_path.resolve()),
                  "unknownSignalReasons": dict(Counter(r["exclusionReason"] for r in hourly if r["trend"] == "UNKNOWN")),
                  "sourceInterruptions": signals.get("interruptions", [])}
    results = {"schemaVersion": 1, "asOf": candle_doc["asOf"], "cutoff": iso(cutoff), "bootstrapReplicates": args.bootstrap,
               "primary": primary, "previousClose": previous, "settlementChange": settlement,
               "byPacificHour": by_hour, "rangeZones": zones,
               "matchedSourceComparison": matched,
               "bullishMissingRanges": sum(r["rangeZone"] is None for r in cohort(hourly, GROUPS[1])),
               "coverage": {"startInclusive": iso(start), "expectedCandles": expected, "observedCandles": len(candles),
                            "missingCandles": len(missing), "knownSignalHours": len(known), "unknownSignalHours": len(hourly) - len(known),
                            "settlementObservations": len(observed_rows(settlement_doc)), "settlementPairs": len(settlements),
                            "excludedSettlementEvents": len({r.get('eventTicker') for r in settlement_doc.get('rejected', []) if r.get('eventTicker') and r.get('reason') == 'Invalid or disagreeing finalized observations'}),
                            "knownSignalSettlementPairs": len(cohort(settlements, GROUPS[4]))}}
    assert len(candles) + len(missing) == expected
    assert sum(primary[i]["hours"] for i in (1, 2, 3)) == primary[4]["hours"]
    assert all(r["up"] + r["down"] + r["unchanged"] == r["hours"] for r in stats_rows)
    output.mkdir(parents=True, exist_ok=True)
    write_csv(output / "hourly-observations.csv", hourly)
    write_csv(output / "signal-history.csv", observed_rows(signals))
    write_csv(output / "settlement-changes.csv", settlements)
    write_csv(output / "statistics.csv", stats_rows)
    dump(output / "results.json", results)
    dump(output / "coverage-exclusions.json", exclusions)
    make_charts(output, primary, by_hour, hourly)
    build_report(output, results, signals, hourly)
    evidence = [signal_path, candle_path, settlement_path, Path(__file__)]
    for name in ("btc_signal_history.py", "btc_price_history.py"):
        candidate = Path(__file__).with_name(name)
        if candidate.exists(): evidence.append(candidate)
    manifest = {"study": "BTC hourly direction conditional on previously available Crypto Tracker trend",
                "asOf": candle_doc["asOf"], "cutoff": iso(cutoff), "historicalResearchOnly": True,
                "python": platform.python_version(), "numpy": np.__version__, "bootstrapReplicates": args.bootstrap,
                "bootstrapSeed": SEED, "bootstrapUnit": "America/Los_Angeles calendar day",
                "inputs": [{"path": str(p.resolve()), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in evidence],
                "signalCoverage": signals.get("coverage"), "priceCoverage": candle_doc.get("coverage"),
                "settlementCoverage": settlement_doc.get("coverage"), "currentRegime": current,
                "publicationCadence": signals.get("publicationCadence"),
                "reproduction": "python3 scripts/research/btc_hourly_bias.py",
                "noLookahead": "Signal availability must be no earlier than verified publication and receipt and no later than hour start.",
                "uncertaintyLimit": "Day-block resampling does not remove cross-day dependence or archive selection bias."}
    dump(output / "manifest.json", manifest)
    print(json.dumps({"report": str(output / "report.html"), "coverage": results["coverage"], "current": primary[0], "bullish": primary[1]}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--signals", type=Path, default=DEFAULT_OUTPUT / "source-signals/signals.json")
    parser.add_argument("--candles", type=Path, default=DEFAULT_OUTPUT / "source-prices/candles.json")
    parser.add_argument("--settlements", type=Path, default=DEFAULT_OUTPUT / "source-prices/settlements.json")
    parser.add_argument("--bootstrap", type=int, default=10000)
    run(parser.parse_args())
