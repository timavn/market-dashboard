# Bitcoin hourly and daily range-entry research

Historical research only. Frozen cutoff: 2026-09-15T18:00:00Z.

## Hourly

9,944 completed price observations; 9,280 eligible entries; 10 missing intervals; 0 incomplete intervals.

- Hourly observations cover all 24 hours, including weekends. Entry is the opening price of a completed UTC hour; outcome is its close versus its open.
- Closing prices determine UP, DOWN or UNCHANGED; intraperiod highs, lows and touches do not determine the outcome. This is price-direction research, not perpetual-futures returns, contract win rates or a profit simulation.
- Published Trend and lower/upper ranges are evaluated at entry after verified publication and receipt. A report arriving during an interval applies only to later entries. Buy/Sell Trade values are range boundaries, not separate directional signals.
- The entry opening price assigns the bottom, middle or top third of the known published range. Below-range and above-range prices remain separate. Internal equality goes to the higher third; the upper boundary is included in the top third.
- Bullish + bottom third → UP and Bearish + top third → DOWN encode the requested hypotheses, without establishing predictive value. The current bullish run is a subset of bullish history.
- First per day selects the earliest qualifying hour per New York calendar date within each regime, zone and dollar filter; it remains a one-hour outcome.
- Dollar filters preserve the original prior-hour timing: at hour T, the DXY candle must end exactly T minus one hour.
- Daily correlations use 15 or 30 matched daily price levels; the separate 120-observation check uses matched hourly returns within 21 calendar days. All feature availability must precede entry. Daily DXY and BTC references retain the original conservative next-midnight plus one-hour availability convention.
- 95% intervals resample New York calendar days with replacement (10,000 replicates; fixed seed 20260915 plus a stable group hash). Fewer than 30 observations or 10 days is a limited sample. One-day groups have no interval. Unchanged outcomes remain in every percentage denominator.
- Missing prices and unavailable signals or ranges are excluded and counted. The frozen cutoff remains 2026-09-15T18:00:00Z (14:00 New York), so September 15 has hourly observations and no completed daily observation. The comparisons are exploratory, overlapping and unadjusted for multiple testing.
- Quad overlays group BTC outcomes by Hedgeye's published historical United States quarterly classifications. They are retrospective actual-quarter cohorts, not forecasts known before each BTC entry or additional entry signals.
- The G20 and Global tables printed 2026-08-12 agree on each included US quarter. Their original screenshots and reviewed transcription hashes are preserved. The source receipt/review was 2026-09-09T18:02:55.426921Z; its original publication timestamp is unknown.
- Published actual classifications: Q3 2025 → Quad 2; Q4 2025 → Quad 4; Q1 2026 → Quad 1; Q2 2026 → Quad 3. Excluded forecast-only quarters: Q3 2026 Quad 4 estimate. All-quads results retain the entire original BTC sample.
- Quarter assignment uses the BTC interval's entry timestamp in America/New_York. Hourly and daily outcomes, tracker availability, range thirds and dollar filters keep their original definitions. Each selected Quad recalculates its sample and uncertainty independently; unknown tracker periods remain excluded.

### Published actual-quarter cohorts

| Quad | Completed intervals | Eligible entries |
|---|---:|---:|
| Quad 1 | 2,159 | 2,159 |
| Quad 2 | 1,564 | 1,530 |
| Quad 3 | 2,179 | 1,572 |
| Quad 4 | 2,204 | 2,181 |

## Daily · NYSE

285 completed price observations; 267 eligible entries; 0 missing intervals; 1 incomplete intervals.

- Daily observations use the 09:30 America/New_York BTC-USD opening price and the close at 16:00, or 13:00 on official NYSE early-close dates. Weekends, NYSE holidays and incomplete sessions are excluded. These are BTC spot prices sampled during NYSE hours.
- Closing prices determine UP, DOWN or UNCHANGED; intraperiod highs, lows and touches do not determine the outcome. This is price-direction research, not perpetual-futures returns, contract win rates or a profit simulation.
- Published Trend and lower/upper ranges are evaluated at entry after verified publication and receipt. A report arriving during an interval applies only to later entries. Buy/Sell Trade values are range boundaries, not separate directional signals.
- The entry opening price assigns the bottom, middle or top third of the known published range. Below-range and above-range prices remain separate. Internal equality goes to the higher third; the upper boundary is included in the top third.
- Bullish + bottom third → UP and Bearish + top third → DOWN encode the requested hypotheses, without establishing predictive value. The current bullish run is a subset of bullish history.
- There is exactly one 09:30 entry per completed NYSE session. The full sequence of verified 15-minute candles must be present; no session prices are inferred from UTC daily bars or hourly bars.
- At 09:30, dollar filters use the 09:00 feature snapshot, whose DXY candle ended at 08:00 and conservatively became available at 09:00. A 10:00 snapshot is never used; missing prior points are not carried forward.
- Daily correlations use 15 or 30 matched daily price levels; the separate 120-observation check uses matched hourly returns within 21 calendar days. All feature availability must precede entry. Daily DXY and BTC references retain the original conservative next-midnight plus one-hour availability convention.
- 95% intervals resample New York calendar days with replacement (10,000 replicates; fixed seed 20260915 plus a stable group hash). Fewer than 30 observations or 10 days is a limited sample. One-day groups have no interval. Unchanged outcomes remain in every percentage denominator.
- Missing prices and unavailable signals or ranges are excluded and counted. The frozen cutoff remains 2026-09-15T18:00:00Z (14:00 New York), so September 15 has hourly observations and no completed daily observation. The comparisons are exploratory, overlapping and unadjusted for multiple testing.
- Quad overlays group BTC outcomes by Hedgeye's published historical United States quarterly classifications. They are retrospective actual-quarter cohorts, not forecasts known before each BTC entry or additional entry signals.
- The G20 and Global tables printed 2026-08-12 agree on each included US quarter. Their original screenshots and reviewed transcription hashes are preserved. The source receipt/review was 2026-09-09T18:02:55.426921Z; its original publication timestamp is unknown.
- Published actual classifications: Q3 2025 → Quad 2; Q4 2025 → Quad 4; Q1 2026 → Quad 1; Q2 2026 → Quad 3. Excluded forecast-only quarters: Q3 2026 Quad 4 estimate. All-quads results retain the entire original BTC sample.
- Quarter assignment uses the BTC interval's entry timestamp in America/New_York. Hourly and daily outcomes, tracker availability, range thirds and dollar filters keep their original definitions. Each selected Quad recalculates its sample and uncertainty independently; unknown tracker periods remain excluded.

### Published actual-quarter cohorts

| Quad | Completed intervals | Eligible entries |
|---|---:|---:|
| Quad 1 | 61 | 61 |
| Quad 2 | 46 | 45 |
| Quad 3 | 62 | 46 |
| Quad 4 | 64 | 63 |

## Reproduce

The derived analysis runs offline from the preserved archives:

```sh
python3 scripts/research/btc_interval_study.py
python3 -m unittest discover -s scripts/research -p 'test_btc*py' -q
```

To collect/recheck the frozen NYSE-session source archive first:

```sh
python3 scripts/research/btc_nyse_sessions.py
```

Original subscriber reports, message identifiers, source links, and raw provider bodies remain private in artifacts. Public CSVs contain allowlisted derived historical observations and timing. Manifest hashes identify all input documents and scripts. No live dashboard data or order path is modified.
