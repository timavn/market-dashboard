# Bitcoin Research design concepts

Generated with the built-in image_gen tool. These are static design explorations, not implemented dashboard changes. Every percentage, sample size and confidence interval shown in the images is illustrative; no volatility backtest was computed.

## Options

1. 01-layered-filters.png — Recommended. One row per filter. Baseline, dollar, and cumulative dollar + volatility results remain visible together. Change a condition beside its result. Add future factors as rows.
2. 02-side-by-side-stages.png — The same cumulative comparison in three stages. Easier to follow visually but consumes more space as factors are added.
3. 03-combination-grid.png — Compare dollar directions against volatility states together. Useful as a secondary comparison view once more filters exist.

All options retain the existing information behind compact disclosures: all entry zones and direction counts, confidence intervals and mean/median return, year stability, Volume and historical Quad, methodology, provenance and downloads. Regime and interval remain changeable. “Closed up/down” retains the original meaning of the outcome; it is not a claim about realized trade profitability.

## Evidence and implementation constraints

Inspected the running Bitcoin Research window, BitcoinResearch.jsx, bitcoinResearchService.js, and public/research/bitcoin/study.json.

The published study spans September 15, 2021–September 15, 2026, ending 14:00 New York, but verified signal history contains gaps. Dollar evidence starts September 17, 2024. Do not label every filtered result as based on five complete years. When showing differences, use a baseline with matching factor coverage and the same selected sampling.

BTC volatility Investable / Chop / Uninvestable classifications and filtered outcomes are not currently exported. Define the historical BTC metric, thresholds, observation timing, and provenance before computing those results; do not substitute present-day implied volatility or infer missing history. Unknown classifications must be excluded and reported in coverage.

The existing verified hourly baseline for bullish/bottom-third is 50.69% up across 2,316 hours / 170 days. The main dollar-down condition is 60.00% across 45 hours / 7 days, a limited sample. Those actual values are deliberately separate from the clearly labeled illustrative images. The current export does not establish a coverage-matched improvement for that difference.

## Reproduction

Original generation prompts: prompts.md
Targeted editing prompts: refinement-prompts.md
Final files are the three numbered PNGs in this folder.

