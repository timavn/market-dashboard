# Reproduce the BTC and dollar indicator experiment

Run from `/Users/timsmith/Desktop/cursor/market-dashboard`.

## Offline analysis

```sh
python3 scripts/research/btc_usd_experiment.py
```

This keeps the original experiment intact. It reads its verified hourly BTC observations and tracker states, plus the saved DXY and daily BTC source files under this experiment's `source-usd/` directory. It regenerates the HTML/Markdown report, chart, hourly indicator observations, all statistics, coverage, and source hashes. The existing Python environment supplies NumPy and Matplotlib.

The frozen observation cutoff is September 15, 2026 18:00 UTC. Newly retrieved provider records retain their actual retrieval times; retrieval time is not substituted for historical observation time.

## Source collection and verification

```sh
python3 scripts/research/btc_usd_history.py
python3 -m unittest discover -s scripts/research -p 'test_btc_usd*.py' -q
```

The collector reuses hash-verified raw provider responses. It retrieves DXY index (`DX-Y.NYB`) hourly history from July 2025 and DXY/BTC daily history from July 2024 for correlation warmup. Original responses, source URLs, query parameters, provider metadata, retrieval times, exclusions, and official ICE timing documents are saved in `source-usd/`. Three independent short-window requests verified 72 overlapping hourly observations.

## Definitions

- Trend states and their publication/receipt timing come unchanged from the original BTC research archive.
- Primary correlations are full-precision Pearson correlations of paired daily closing price levels over 15 or 30 sessions. They reproduce the dashboard's method and symbols using historical completed bars, not its historical displayed rounded readings. A separate variant uses the last 120 matched hourly close-to-previous-close returns within 21 calendar days.
- Dollar move in basis points is `(hourly_close / reference_close - 1) * 10000`. Ten basis points means a 0.10% price move, not ten index points. The reference is either the latest available daily DXY close or the preceding consecutive hourly close.
- A BTC hour beginning at T uses the DXY hourly candle ending at T minus one hour. This leaves one hour for availability. The BTC result is its T-to-T-plus-one-hour close versus open. No result from that target hour enters an indicator.
- Daily DXY values use the next New York midnight as a conservative availability anchor; daily BTC values use the next UTC midnight. One further hour is added before use. ICE calculates the index past 17:00 New York on weekdays, so the dashboard's 17:00 date gate is not used to release historical final daily DXY closes.
- `usdSessionCloseAt` in the CSV is that conservative daily anchor, not a claim about the precise final index tick. `usdReferenceAvailableAt` includes the extra hour. `referenceAgeHours` is measured from that availability time. Weekend/holiday references can be older; current hourly DXY points must still satisfy the exact freshness rule.
- Missing, non-hour-aligned, incomplete and conflicting observations are excluded, never filled. All original BTC rows remain in the hourly export with eligibility and exclusion fields.
- `mainTrigger`, `short_windowTrigger`, `stronger_corrTrigger`, `smaller_moveTrigger`, `larger_moveTrigger`, `return_corrTrigger`, and `hour_moveTrigger` identify the exact selected hours.

## Uncertainty and controls

All counts include unchanged prices. Each 95% percentile interval uses 10,000 whole-Pacific-day bootstrap replicates, with base seed 20260915 and deterministic SHA256-derived seeds per group. The baseline-difference interval resamples the selected and baseline rows together to preserve their overlap. Baseline means the same tracker state, correlation condition and available data without the dollar move restriction. Dollar-only controls omit the correlation restriction.

The earlier/later split at February 20, 2026 is descriptive. All variants are exploratory; the analysis has no independent held-out validation. Correlated time series, repeated conditions, selected archive coverage and multiple comparisons limit interpretation. This is price-direction research and does not calculate trade or contract profitability.
