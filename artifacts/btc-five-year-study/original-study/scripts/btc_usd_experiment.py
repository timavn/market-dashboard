#!/usr/bin/env python3
"""Offline extension of the BTC hourly study with previously observable DXY filters."""
from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import html
import json
import platform
from collections import Counter
from pathlib import Path

import numpy as np

from btc_hourly_bias import GROUPS, SEED, cohort, dump, write_csv
from btc_usd_features import build_features

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "artifacts/btc-hourly-bias-experiment"
OUTPUT = ROOT / "artifacts/btc-hourly-usd-experiment"
VARIATIONS = [
    {"id": "main", "label": "30-session levels · −0.50 · 10 bp", "corr": "corr30Level", "limit": -.5, "move": "usdSessionMoveBp", "bp": 10},
    {"id": "short_window", "label": "15-session levels · −0.50 · 10 bp", "corr": "corr15Level", "limit": -.5, "move": "usdSessionMoveBp", "bp": 10},
    {"id": "stronger_corr", "label": "30-session levels · −0.75 · 10 bp", "corr": "corr30Level", "limit": -.75, "move": "usdSessionMoveBp", "bp": 10},
    {"id": "smaller_move", "label": "30-session levels · −0.50 · 5 bp", "corr": "corr30Level", "limit": -.5, "move": "usdSessionMoveBp", "bp": 5},
    {"id": "larger_move", "label": "30-session levels · −0.50 · 20 bp", "corr": "corr30Level", "limit": -.5, "move": "usdSessionMoveBp", "bp": 20},
    {"id": "return_corr", "label": "120-hour returns · −0.50 · 10 bp", "corr": "corr120Return", "limit": -.5, "move": "usdSessionMoveBp", "bp": 10},
    {"id": "hour_move", "label": "30-session levels · −0.50 · prior-hour 10 bp", "corr": "corr30Level", "limit": -.5, "move": "usdHourMoveBp", "bp": 10},
]


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and np.isfinite(value)


def load_hourly(path):
    with path.open() as stream:
        rows = list(csv.DictReader(stream))
    for row in rows:
        for key in ("open", "high", "low", "close", "volume", "returnPct", "previousCloseReturnPct", "lowerRange", "upperRange"):
            row[key] = float(row[key]) if row.get(key) else None
        row["currentBullishRun"] = row["currentBullishRun"] == "True"
        row["pacificHour"] = int(row["pacificHour"])
    return rows


def eligible(row, spec):
    return bool(row.get("indicatorEligible")) and finite(row.get(spec["corr"])) and finite(row.get(spec["move"]))


def correlated(row, spec):
    return eligible(row, spec) and row[spec["corr"]] <= spec["limit"] + 1e-12


def triggered(row, spec, usd_direction):
    if not correlated(row, spec):
        return False
    move = row[spec["move"]]
    return move >= spec["bp"] - 1e-9 if usd_direction == "UP" else move <= -spec["bp"] + 1e-9


def seed_for(name):
    return SEED ^ int.from_bytes(hashlib.sha256(name.encode()).digest()[:4], "little")


def pct(numerator, denominator):
    return float(numerator / denominator * 100) if denominator else None


def interval(samples):
    valid = samples[np.isfinite(samples)]
    return [float(x) for x in np.percentile(valid, [2.5, 97.5])] if len(valid) else None


def summarize(rows, name, iterations=10000):
    counts = Counter(row["direction"] for row in rows)
    days = sorted({row["pacificDay"] for row in rows})
    n = len(rows)
    result = {"hours": n, "days": len(days), "up": counts["UP"], "down": counts["DOWN"],
              "unchanged": counts["UNCHANGED"], "upPct": pct(counts["UP"], n),
              "downPct": pct(counts["DOWN"], n), "unchangedPct": pct(counts["UNCHANGED"], n),
              "meanReturnPct": float(np.mean([row["returnPct"] for row in rows])) if n else None,
              "medianReturnPct": float(np.median([row["returnPct"] for row in rows])) if n else None,
              "limitedSample": n < 30 or len(days) < 10, "upPct95": None, "downPct95": None}
    if len(days) < 2:
        return result
    by_day = {day: [0, 0, 0] for day in days}
    for row in rows:
        item = by_day[row["pacificDay"]]
        item[0] += 1
        item[1] += row["direction"] == "UP"
        item[2] += row["direction"] == "DOWN"
    blocks = np.array(list(by_day.values()), dtype=float)
    indices = np.random.default_rng(seed_for(name)).integers(0, len(days), size=(iterations, len(days)))
    samples = blocks[indices].sum(axis=1)
    result["upPct95"] = interval(100 * samples[:, 1] / samples[:, 0])
    result["downPct95"] = interval(100 * samples[:, 2] / samples[:, 0])
    return result


def relative_to_baseline(selected, baseline, expected, name, iterations=10000):
    """Joint daily resampling retains overlap between conditional and baseline samples."""
    days = sorted({row["pacificDay"] for row in baseline})
    result = {"baselineHours": len(baseline), "baselineDays": len(days), "baselineTargetPct": None,
              "targetLiftPp": None, "targetLift95": None}
    if not baseline or not selected:
        return result
    result["baselineTargetPct"] = pct(sum(r["direction"] == expected for r in baseline), len(baseline))
    result["targetLiftPp"] = pct(sum(r["direction"] == expected for r in selected), len(selected)) - result["baselineTargetPct"]
    if len(days) < 2 or len({row["pacificDay"] for row in selected}) < 2:
        return result
    blocks = {day: [0, 0, 0, 0] for day in days}
    for row in baseline:
        blocks[row["pacificDay"]][0] += 1
        blocks[row["pacificDay"]][1] += row["direction"] == expected
    for row in selected:
        blocks[row["pacificDay"]][2] += 1
        blocks[row["pacificDay"]][3] += row["direction"] == expected
    values = np.array(list(blocks.values()), dtype=float)
    indices = np.random.default_rng(seed_for(name)).integers(0, len(days), size=(iterations, len(days)))
    sample = values[indices].sum(axis=1)
    valid = sample[:, 2] > 0
    result["targetLift95"] = interval(100 * sample[valid, 3] / sample[valid, 2] - 100 * sample[valid, 1] / sample[valid, 0])
    return result


def calculate(rows, iterations):
    output = []
    for spec in VARIATIONS:
        for group in GROUPS:
            pool = [row for row in cohort(rows, group) if eligible(row, spec)]
            corr_pool = [row for row in pool if correlated(row, spec)]
            for usd_direction in ("DOWN", "UP"):
                selected = [row for row in corr_pool if triggered(row, spec, usd_direction)]
                expected = "UP" if usd_direction == "DOWN" else "DOWN"
                name = f"{spec['id']}|{group}|{usd_direction}"
                stats = summarize(selected, name, iterations)
                result = {"variation": spec["id"], "label": spec["label"], "cohort": group,
                          "usdDirection": usd_direction, "expectedBtcDirection": expected,
                          "correlationField": spec["corr"], "correlationMax": spec["limit"],
                          "moveField": spec["move"], "minimumMoveBp": spec["bp"],
                          "eligibleHours": len(pool), "negativeCorrelationHours": len(corr_pool), **stats,
                          "targetPct": stats["upPct"] if expected == "UP" else stats["downPct"],
                          "targetPct95": stats["upPct95"] if expected == "UP" else stats["downPct95"],
                          **relative_to_baseline(selected, corr_pool, expected, name + "|lift", iterations)}
                # Dollar-only control shows whether the correlation restriction adds anything.
                dollar_only = [row for row in pool if (row[spec["move"]] >= spec["bp"] - 1e-9 if usd_direction == "UP" else row[spec["move"]] <= -spec["bp"] + 1e-9)]
                result["dollarOnlyHours"] = len(dollar_only)
                result["dollarOnlyTargetPct"] = pct(sum(row["direction"] == expected for row in dollar_only), len(dollar_only))
                # Descriptive stability check, not a held-out test: fixed midpoint of covered UTC time.
                midpoint = "2026-02-20T00:00:00Z"
                for label, subset in (("earlier", [r for r in selected if r["hourStart"] < midpoint]),
                                      ("later", [r for r in selected if r["hourStart"] >= midpoint])):
                    result[label + "Hours"] = len(subset)
                    result[label + "TargetPct"] = pct(sum(r["direction"] == expected for r in subset), len(subset))
                output.append(result)
    return output


def settlement_checks(rows, source_path):
    """Use only the existing verified consecutive official settlement intervals."""
    with source_path.open() as stream:
        settlements = {r["hourStart"]: r for r in csv.DictReader(stream)}
    output = []
    for spec in (VARIATIONS[0], VARIATIONS[-1]):
        for group in GROUPS[:2]:
            for usd_direction in ("DOWN", "UP"):
                expected = "UP" if usd_direction == "DOWN" else "DOWN"
                selected = [r for r in cohort(rows, group) if triggered(r, spec, usd_direction)]
                matched = [r for r in selected if r["hourStart"] in settlements]
                observed = [{**r, "direction": settlements[r["hourStart"]]["direction"],
                             "returnPct": float(settlements[r["hourStart"]]["returnPct"])} for r in matched]
                stats = summarize(observed, f"settlement|{spec['id']}|{group}|{usd_direction}")
                output.append({"variation": spec["id"], "cohort": group, "usdDirection": usd_direction,
                               "expectedBtcDirection": expected, "qualifyingCoinbaseHours": len(selected),
                               "missingSettlementHours": len(selected) - len(matched), **stats,
                               "targetPct": stats["upPct"] if expected == "UP" else stats["downPct"],
                               "targetPct95": stats["upPct95"] if expected == "UP" else stats["downPct95"],
                               "coinbaseMatchedTargetPct": pct(sum(r["direction"] == expected for r in matched), len(matched))})
    return output


def num(value, digits=2, suffix=""):
    return "—" if value is None else f"{value:,.{digits}f}{suffix}"


def ci(value):
    return "—" if value is None else f"{value[0]:.1f}–{value[1]:.1f}"


def percent_ci(value):
    return "—" if value is None else ci(value) + "%"


def main_table(rows):
    lines = ["| Tracker period / dollar move | Hours / days | BTC up / down / flat | BTC opposite dollar | 95% interval | Mean / median BTC return |",
             "|---|---:|---:|---:|---:|---:|"]
    for row in rows:
        move = "down ≥10 bp" if row["usdDirection"] == "DOWN" else "up ≥10 bp"
        direction = row["expectedBtcDirection"].lower()
        lines.append(f"| {row['cohort']} / {move}{' †' if row['limitedSample'] else ''} | {row['hours']:,} / {row['days']} | {row['up']} / {row['down']} / {row['unchanged']} | {direction}: {num(row['targetPct'], 2, '%')} | {percent_ci(row['targetPct95'])} | {num(row['meanReturnPct'], 3, '%')} / {num(row['medianReturnPct'], 3, '%')} |")
    return "\n".join(lines)


def variation_table(rows):
    lines = ["| Variation / USD move | Hours / days | BTC opposite USD | 95% interval | Same-correlation baseline | Difference (pp) | 95% difference interval |",
             "|---|---:|---:|---:|---:|---:|---:|"]
    for r in rows:
        lines.append(f"| {r['label']} / {r['usdDirection'].lower()}{' †' if r['limitedSample'] else ''} | {r['hours']:,} / {r['days']} | {num(r['targetPct'], 2, '%')} | {percent_ci(r['targetPct95'])} | {num(r['baselineTargetPct'], 2, '%')} | {num(r['targetLiftPp'])} | {ci(r['targetLift95'])} |")
    return "\n".join(lines)


def chart(output, rows):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(10, 5), layout="constrained")
    labels = []
    for i, row in enumerate(rows):
        labels.append(f"{row['label']}\nUSD {row['usdDirection'].lower()} · {row['hours']} hours" + (" †" if row["limitedSample"] else ""))
        if row["targetPct"] is None:
            continue
        color = "#247953" if row["usdDirection"] == "DOWN" else "#b74545"
        ax.scatter(row["targetPct"], i, color=color, s=30)
        if row["targetPct95"]:
            ax.hlines(i, *row["targetPct95"], color=color, lw=1.5)
    ax.set_yticks(range(len(rows)), labels, fontsize=8)
    ax.invert_yaxis()
    ax.axvline(50, ls="--", lw=1, color="#90979e")
    ax.set_xlabel("BTC next-hour direction opposite the earlier dollar move (%) · 95% daily-block interval")
    ax.spines[["top", "right"]].set_visible(False)
    ax.grid(axis="x", alpha=.15)
    fig.savefig(output / "usd-filter-results.png", dpi=180)
    plt.close(fig)


def render_html(markdown, output):
    import re
    def inline(text):
        text = html.escape(text)
        text = re.sub(r"\*\*(.*?)\*\*", r"<strong>\1</strong>", text)
        text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
        return re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', text)
    content, table, listing = [], False, False
    for line in markdown.splitlines():
        if table and not line.startswith("|"):
            content.append("</tbody></table></div>"); table = False
        if listing and not line.startswith("- "):
            content.append("</ul>"); listing = False
        if not line: continue
        if line.startswith("|---"): continue
        if line.startswith("|"):
            cells = [inline(c.strip()) for c in line.strip("|").split("|")]
            if not table:
                content.append('<div class="table-wrap"><table><thead><tr>' + "".join(f"<th>{c}</th>" for c in cells) + "</tr></thead><tbody>")
                table = True
            else:
                content.append("<tr>" + "".join(f"<td>{c}</td>" for c in cells) + "</tr>")
        elif line.startswith("!["):
            alt, name = line[2:].split("](", 1)
            data = base64.b64encode((output / name[:-1]).read_bytes()).decode()
            content.append(f'<img alt="{html.escape(alt)}" src="data:image/png;base64,{data}">')
        elif line.startswith("#"):
            depth = len(line) - len(line.lstrip("#"))
            content.append(f"<h{depth}>{inline(line[depth:].strip())}</h{depth}>")
        elif line.startswith("- "):
            if not listing: content.append("<ul>"); listing = True
            content.append(f"<li>{inline(line[2:])}</li>")
        else:
            content.append(f"<p>{inline(line)}</p>")
    if table: content.append("</tbody></table></div>")
    if listing: content.append("</ul>")
    style = "body{background:#f5f6f8;color:#242a30;font:14px/1.55 Arial,sans-serif;margin:0}main{max-width:1120px;margin:28px auto;padding:32px;background:white;border:1px solid #e0e3e6}h1{font-size:27px}h2{font-size:20px;border-top:1px solid #e0e3e6;padding-top:20px;margin-top:28px}table{border-collapse:collapse;width:100%;font-size:12px}td,th{border:1px solid #e0e3e6;padding:7px;text-align:right;font-weight:400}th{background:#f1f2f4;font-weight:600}td:first-child,th:first-child{text-align:left}a{color:inherit;text-decoration:none;border-bottom:1px dotted #b5bbc0}img{width:100%;height:auto}.table-wrap{overflow-x:auto}code{background:#f2f3f4}li{margin:5px 0}@media(max-width:800px){main{margin:0;padding:18px}h1{font-size:23px}}"
    (output / "report.html").write_text('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BTC and dollar indicator experiment</title><style>' + style + "</style><main>" + "\n".join(content) + "</main></html>")


def build_report(output, results, coverage, settlements):
    main = [r for r in results if r["variation"] == "main"]
    bull = [r for r in results if r["cohort"] == GROUPS[1]]
    chart_rows = [r for r in bull if r["variation"] in ("main", "stronger_corr", "larger_move", "hour_move")]
    chart(output, chart_rows)
    one_hour = [r for r in bull if r["variation"] == "hour_move"]
    official = [r for r in settlements if r["variation"] == "hour_move" and r["cohort"] == GROUPS[1]]
    highlights = []
    for row in [r for r in main if r["cohort"] == GROUPS[1]]:
        state = "fell" if row["usdDirection"] == "DOWN" else "rose"
        outcome = row["expectedBtcDirection"].lower()
        text = f"When DXY {state} at least 0.10%, BTC's following measured hour was {outcome} {num(row['targetPct'], 2, '%')} of the time ({row['hours']:,} hours on {row['days']} Pacific dates; 95% interval {ci(row['targetPct95'])}%)."
        if row["limitedSample"]: text += " This is a limited sample."
        highlights.append(text)
    text = f"""# Does the dollar improve BTC's hourly direction signal?

Historical research · same frozen BTC sample as the original study · completed BTC hours through September 15, 2026 11:00 PDT.

## Requested test

**During bullish Crypto Tracker periods, with BTC–DXY 30-session correlation at −0.50 or lower:**

{highlights[0]}

{highlights[1]}

These are exploratory conditional frequencies. An interval containing 50% does not distinguish the opposite-direction frequency from an even split. An apparent difference from 50% is not proof of improvement: the same-correlation baseline and its paired difference interval are shown below. Variations were examined together and are not independent confirmations or a validated trading strategy.

**The stronger pattern was a 0.10% dollar move within one hour**, keeping the same ≤ −0.50 daily-level correlation: BTC subsequently closed up {num(one_hour[0]['targetPct'], 1, '%')} after dollar declines ({one_hour[0]['hours']} hours), and down {num(one_hour[1]['targetPct'], 1, '%')} after dollar rises ({one_hour[1]['hours']} hours). This is a small, concentrated sample: only {sum(r['earlierHours'] for r in one_hour)} qualifying hours were before February 20, 2026. It is a candidate for further testing, not established predictive performance.

## What the filters mean

- **Dollar:** DXY cash index, Yahoo symbol DX-Y.NYB, matching the dashboard's current reference. This is not a futures contract, ETF, or broad trade-weighted dollar series.
- **10 basis points = 0.10%**, measured from the latest available completed DXY daily close to the latest eligible hourly close. Separate variants use 5 bp, 20 bp, or the last one-hour move. This conservative historical reference may differ from a live quote's displayed daily change.
- **Correlation ≤ −0.50:** −0.70 qualifies; −0.30 does not. The main calculation matches the dashboard's Pearson correlation of daily **price levels**, over 30 aligned sessions. It is rebuilt using only completed observations; it is not an archived screenshot of the dashboard's displayed correlation. The 15-session and hourly-return versions are separately labeled.
- **BTC outcome:** the subsequent measured Coinbase hour's close versus open. The tracker state is the state known when that hour began. Up, down and unchanged prices all remain in the percentage denominator.
- **Conservative timing:** use a completed dollar hour that ended one hour before the BTC hour begins, adding one hour for data availability. For BTC's 10:00–11:00 interval, the dollar observation ends at 09:00. Daily DXY data wait until the next New York midnight plus one hour; daily BTC data wait until the next UTC midnight plus one hour. Correlations wait for both bars. ICE's weekday index calculation extends past 17:00 New York, so a 17:00 gate is unsuitable for the final daily index close.
- **Session gaps:** no new hourly dollar observation means no qualifying BTC hour. Dollar prices are never filled across closures or missing data. The prior daily close remains only a disclosed comparison reference.

## Main result by tracker state

30-session daily-level correlation ≤ −0.50; dollar move from latest available daily close ≥10 bp in either direction. “BTC opposite dollar” means BTC up after dollar down, or BTC down after dollar up.

{main_table(main)}

† Fewer than 30 hours or 10 distinct Pacific dates. Several hours can share the same daily correlation and dollar condition, so the hour count overstates the number of independent opportunities.

## Variations during all bullish periods

The baseline includes the same tracker state, correlation rule, source coverage and indicator availability, without restricting the dollar's direction or minimum move. Difference is the filtered opposite-direction frequency minus that baseline, in percentage points. The difference interval resamples both overlapping groups together by day.

{variation_table(bull)}

![Selected dollar-filter variations](usd-filter-results.png)

The downloaded statistics additionally include dollar-only controls, all tracker states, and an earlier/later split at February 20, 2026. That split is descriptive and does not constitute an independent holdout test. Of the {sum(r['hours'] for r in one_hour)} bullish one-hour-move observations, {sum(sorted(coverage['bullishHourMoveCountsByMonth'].values(), reverse=True)[:2])} came from the two busiest months ({', '.join(k for k, v in sorted(coverage['bullishHourMoveCountsByMonth'].items(), key=lambda item: item[1], reverse=True)[:2])}). Price-level correlations can reflect shared trends; the 120-hour-return variant checks a different definition and has very little qualifying data here.

## Official settlement check for the one-hour move

Using the same selected hours during bullish tracker periods, and the original study's verified consecutive BRTI settlement averages:

| Prior dollar move | Paired hours | BTC opposite dollar: BRTI | 95% interval | Coinbase on identical hours |
|---|---:|---:|---:|---:|
| Down ≥10 bp | {official[0]['hours']} | {num(official[0]['targetPct'], 2, '%')} up | {percent_ci(official[0]['targetPct95'])} | {num(official[0]['coinbaseMatchedTargetPct'], 2, '%')} up |
| Up ≥10 bp | {official[1]['hours']} | {num(official[1]['targetPct'], 2, '%')} down | {percent_ci(official[1]['targetPct95'])} | {num(official[1]['coinbaseMatchedTargetPct'], 2, '%')} down |

The settlement check points in the same direction with weaker frequencies. It measures change between consecutive official averages, not whether a particular dollar-strike contract wins. Missing settlement hours are excluded; full counts for this and the daily-move filter are downloadable.

## Coverage and uncertainty

- Original BTC sample: {coverage['btcHours']:,} completed observed hours, including {coverage['knownSignalHours']:,} with usable tracker timing.
- Hours with an eligible DXY observation: {coverage['indicatorEligibleHours']:,}; source, timing and feature exclusions are counted separately in coverage.json.
- All-bullish hours eligible for the main test before the correlation filter: {next(r['eligibleHours'] for r in main if r['cohort'] == GROUPS[1]):,}; after the negative-correlation filter: {next(r['negativeCorrelationHours'] for r in main if r['cohort'] == GROUPS[1]):,}.
- 95% percentile intervals use 10,000 resamples of whole Pacific days, fixed seed {SEED} with deterministic group-specific seeds. They preserve within-day dependence but do not remove cross-day dependence, archive selection effects, or multiple-comparison risk. Very small all-up/all-down samples can yield degenerate intervals without implying certainty.
- Daily/history values are the provider's currently retrievable historical records. The one-hour lag is a conservative timing convention, not proof of the original data vendor's precise publication time or absence of later corrections.
- This measures historical price direction. It does not simulate a Kalshi strike payout, order execution, or profits.

## Files and reproduction

- [Every BTC hour with dollar indicators and exclusions](hourly-observations.csv)
- [All variation and control statistics](statistics.csv)
- [Official settlement checks](settlement-checks.csv)
- [Coverage and excluded observations](coverage.json)
- [Source and calculation manifest](manifest.json)
- [Repeat the experiment locally](REPRODUCE.md)
- [Original BTC study](../btc-hourly-bias-experiment/report.html)

Dollar definition and timing: [ICE U.S. Dollar Index](https://www.ice.com/forex/usdx), [ICE index calculation-hours notice](https://www.ice.com/publicdocs/equity_indices/notices/DXY_ICE_FX_Indices_Methodology_Updates_20210311.pdf). Historical provider: [Yahoo DXY history](https://finance.yahoo.com/quote/DX-Y.NYB/history/). The source archive preserves raw responses, timestamps and hashes.
"""
    (output / "README.md").write_text(text)
    render_html(text, output)


def run(args):
    output = args.output
    source = output / "source-usd"
    paths = [BASE / "hourly-observations.csv", source / "hourly.json", source / "daily-dxy.json", source / "daily-btc.json"]
    hourly = load_hourly(paths[0])
    documents = [json.loads(path.read_text()) for path in paths[1:]]
    rows, feature_coverage = build_features(hourly, *documents)
    coverage = {"btcHours": len(rows), "knownSignalHours": sum(r["trend"] != "UNKNOWN" for r in rows),
                "indicatorEligibleHours": sum(bool(r.get("indicatorEligible")) for r in rows), "features": feature_coverage}
    coverage["bullishHourMoveCountsByMonth"] = dict(sorted(Counter(r["hourStart"][:7] for r in cohort(rows, GROUPS[1])
        if triggered(r, VARIATIONS[-1], "UP") or triggered(r, VARIATIONS[-1], "DOWN")).items()))
    results = calculate(rows, 10000)
    settlement_path = BASE / "settlement-changes.csv"
    settlements = settlement_checks(rows, settlement_path)
    assert len(rows) == len(hourly)
    assert all(r["up"] + r["down"] + r["unchanged"] == r["hours"] for r in results)
    for row in rows:
        for spec in VARIATIONS:
            row[spec["id"] + "Trigger"] = "USD_UP" if triggered(row, spec, "UP") else "USD_DOWN" if triggered(row, spec, "DOWN") else ""
    output.mkdir(exist_ok=True, parents=True)
    write_csv(output / "hourly-observations.csv", rows)
    write_csv(output / "statistics.csv", results)
    write_csv(output / "settlement-checks.csv", settlements)
    dump(output / "results.json", results)
    dump(output / "coverage.json", coverage)
    scripts = [Path(__file__), Path(__file__).with_name("btc_usd_features.py"), Path(__file__).with_name("btc_usd_history.py"), Path(__file__).with_name("btc_hourly_bias.py")]
    manifest = {"study": "BTC hourly direction conditional on previously observable DXY movement and correlation",
                "frozenCutoff": "2026-09-15T18:00:00Z", "historicalResearchOnly": True,
                "python": platform.python_version(), "numpy": np.__version__, "bootstrapReplicates": 10000,
                "seed": SEED, "variants": VARIATIONS, "availabilityLagHours": 1,
                "inputsAndScripts": [{"path": str(p.resolve()), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in paths + [settlement_path] + scripts],
                "reproduction": "python3 scripts/research/btc_usd_experiment.py"}
    dump(output / "manifest.json", manifest)
    build_report(output, results, coverage, settlements)
    print(json.dumps({"report": str(output / "report.html"), "coverage": coverage,
                      "mainBullish": [r for r in results if r["variation"] == "main" and r["cohort"] == GROUPS[1]]}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    run(parser.parse_args())
