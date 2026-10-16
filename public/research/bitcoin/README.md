# Bitcoin five-year research

Historical open-to-close research. Target 2021-09-15T04:00:00Z through frozen cutoff 2026-09-15T18:00:00Z.

## Reproduce offline

```sh
python3 scripts/research/btc_five_year_study.py
python3 -m unittest discover -s scripts/research -p 'test_btc*py' -q
```

Original study: `artifacts/btc-five-year-study/original-study/` contains its public exports, source scripts and hash manifest. Original source archives remain in their original artifact locations. Current and original data can be compared without overwriting their evidence.

Reproduce the original frozen exports without network or source changes: `python3 scripts/research/btc_reproduce_original.py`.

Collection scripts: `btc_multiyear_prices.py`, `btc_volume_history.py`, `btc_usd_history.py`; recovered report artifacts are private under `source-signals/`. Raw source requests and hashes are verified before offline computation.

## Recovered report coverage

654 reports have verified Trend and range evidence. Source history is discontinuous; gaps longer than two weeks: 2022-10-05 to 2024-12-16; 2025-01-15 to 2025-02-05; 2025-05-01 to 2025-05-28; 2026-06-04 to 2026-06-29. Publisher reports exist within the mailbox gap, but the worked January 2023 recovery did not establish historical receipt evidence. These observations remain excluded under the agreed timing rule. Price and volume coverage remains separately visible.

## Primary hypothesis: bullish, bottom third, below-average volume

| Interval | Qualifying observations / days | Up closes | Comparable baseline | Difference, pp | 95% difference interval, pp | Mean / median return |
|---|---:|---:|---:|---:|---:|---:|
| Hourly | 1399 / 119 | 49.89% | 50.69% | -0.80 | -2.31 to 0.74 | -0.01% / -0.00% |
| 24 hours | 63 / 63 | 46.03% | 44.79% | 1.24 | -6.11 to 8.33 | -0.32% / -0.21% |
| NYSE session | 34 / 34 | 44.12% | 45.45% | -1.34 | -13.42 to 10.61 | -0.29% / -0.36% |

All three difference intervals include zero. The recovered sample does not establish improvement from the volume restriction. Yearly and alternate-lag/venue results are included in the dashboard; they are descriptive checks of the fixed rule, not threshold optimization.

## Original-window comparison

The original hourly study contains 9944 price observations; 9941 remain under the expanded requirement for complete 15-minute constituents. Overlapping open/close disagreements: 0. 3 original hours lack complete constituent candles and are excluded; the original exports are unchanged.

## Hourly

43,812 completed prices; 22,648 eligible signal/range entries; 26 missing complete price intervals.

| Year | Prices | Signals/ranges | Volume | Dollar | Actual Quads |
|---|---:|---:|---:|---:|---:|
| 2021 | 2592 | 2585 | 2592 | 0 | 0 |
| 2022 | 8760 | 6601 | 8760 | 0 | 0 |
| 2023 | 8753 | 0 | 8753 | 0 | 8753 |
| 2024 | 8779 | 376 | 8779 | 1735 | 8779 |
| 2025 | 8754 | 7519 | 8754 | 5992 | 8754 |
| 2026 | 6174 | 5567 | 6174 | 4184 | 4336 |

- Hourly observations cover all 24 hours, including weekends. Entry is the opening price of a completed UTC hour; outcome is its close versus its open.
- Closing prices determine UP, DOWN or UNCHANGED; intraperiod highs, lows and touches do not determine the outcome. This is price-direction research, not perpetual-futures returns, contract win rates or a profit simulation.
- Published Trend and lower/upper ranges are evaluated at entry after verified publication and receipt. A report arriving during an interval applies only to later entries. Buy/Sell Trade values are range boundaries, not separate directional signals.
- The entry opening price assigns the bottom, middle or top third of the known published range. Below-range and above-range prices remain separate. Internal equality goes to the higher third; the upper boundary is included in the top third.
- Bullish + bottom third → UP and Bearish + top third → DOWN encode the requested hypotheses, without establishing predictive value. The current bullish run is a subset of bullish history.
- First per day selects the earliest qualifying hour per New York calendar date within each regime, zone, dollar and volume filter; it remains a one-hour outcome.
- Dollar filters preserve the original prior-hour timing: at hour T, the DXY candle must end exactly T minus one hour.
- Daily correlations use 15 or 30 matched daily price levels; the separate 120-observation check uses matched hourly returns within 21 calendar days. All feature availability must precede entry. Daily DXY and BTC references retain the original conservative next-midnight plus one-hour availability convention.
- 95% intervals resample New York calendar days with replacement (10,000 replicates; fixed seed 20260915 plus a stable group hash). Fewer than 30 observations or 10 days is a limited sample. One-day groups have no interval. Unchanged outcomes remain in every percentage denominator.
- Missing prices and unavailable signals or ranges are excluded and counted. The frozen cutoff remains 2026-09-15T18:00:00Z (14:00 New York), so September 15 has hourly observations and no completed daily observation. The comparisons are exploratory, overlapping and unadjusted for multiple testing.
- Volume is Coin Metrics exchange-reported Bitcoin spot turnover in USD across covered markets; it is not total market activity or perpetual/ETF volume.
- Below average means the latest completed UTC day is strictly below the average of its preceding 15 completed UTC days, including weekends. The evaluated day is excluded from its own average.
- A UTC volume day becomes usable one hour after its following midnight. Missing days or lookback inputs remain unavailable; no older observation is carried forward.
- Historical volumes are the latest retrieved vintage. Original publication and revision timestamps are unavailable, so this proxy does not reproduce an exact historical live feed.
- Sensitivity checks use one additional day of lag and Coinbase BTC-USD spot volume in BTC with the same complete UTC-day rule. These checks keep the fixed 15-day threshold.
- The volume baseline uses the same overall study date window, regime, range zone, dollar and Quad restrictions, retaining only entries with complete volume inputs and removing the below/above-average restriction. First-per-day sampling is applied after these restrictions in each sample. It includes both low- and high-volume dates, rather than only dates selected by the volume rule.
- Volume comparison differences use paired resampling of the same New York date blocks for selected and baseline samples. Weekly sensitivity resamples Monday-start calendar-week blocks; yearly results are descriptive. Both retain unchanged closes in the denominator. All confidence intervals use 10,000 replicates batched 256 at a time.
- Dollar-filtered observations are unavailable before the recovered hourly DXY series beginning September 17, 2024. Earlier daily DXY closes alone cannot establish the required hourly condition. Quad groups use only separately verified actual-quarter evidence; missing optional evidence does not remove unfiltered observations.
- The original 2025–2026 study and its scripts are archived separately. Recovered report periods are included only after verified source and availability review. Reports never extend across unverified source gaps.
- Report history is discontinuous. Source gaps longer than two weeks: 2022-10-05 to 2024-12-16; 2025-01-15 to 2025-02-05; 2025-05-01 to 2025-05-28; 2026-06-04 to 2026-06-29. Shorter unavailable periods are also excluded and counted.
- Authenticated publisher archives contain additional reports in the mailbox gap. A January 2023 original was recovered, but historical receipt evidence was not established. Its publication time and image version alone do not satisfy the agreed entry-timing rule, so publisher-only observations remain excluded.
- Historical US Quads are retrospective published actual-quarter classifications, not forecasts known at entry. Estimates and quarters without independently verified classifications are excluded only when a Quad is selected.
- The verified source is the G20 and Global tables dated 2026-08-12, archived/reviewed 2026-09-09T18:02:55.426921Z; original publication time is unknown.
- Earlier actual Quads are recovered from the original 2025-07-22 G20 table, published 2025-07-22T11:23:00Z and received 2025-07-22T11:26:56Z; reviewed retrospectively 2026-09-15T23:15:37.000556+00:00. The overlap agrees with the newer source. Newly covered quarters: 2023-Q1, 2023-Q2, 2023-Q3, 2023-Q4, 2024-Q1, 2024-Q2. No 2021–2022 classifications were established.

## 24 hours

1,817 completed prices; 936 eligible signal/range entries; 9 missing complete price intervals.

| Year | Prices | Signals/ranges | Volume | Dollar | Actual Quads |
|---|---:|---:|---:|---:|---:|
| 2021 | 107 | 106 | 107 | 0 | 0 |
| 2022 | 365 | 275 | 365 | 0 | 0 |
| 2023 | 363 | 0 | 363 | 0 | 363 |
| 2024 | 363 | 15 | 363 | 73 | 363 |
| 2025 | 364 | 311 | 364 | 252 | 364 |
| 2026 | 255 | 229 | 255 | 175 | 179 |

- 24-hour observations run midnight to midnight in America/New_York, including weekends. Daylight-saving changes create actual 23-hour and 25-hour calendar days. These are single calendar-day open-to-close outcomes, not rolling returns after hourly entries.
- Closing prices determine UP, DOWN or UNCHANGED; intraperiod highs, lows and touches do not determine the outcome. This is price-direction research, not perpetual-futures returns, contract win rates or a profit simulation.
- Published Trend and lower/upper ranges are evaluated at entry after verified publication and receipt. A report arriving during an interval applies only to later entries. Buy/Sell Trade values are range boundaries, not separate directional signals.
- The entry opening price assigns the bottom, middle or top third of the known published range. Below-range and above-range prices remain separate. Internal equality goes to the higher third; the upper boundary is included in the top third.
- Bullish + bottom third → UP and Bearish + top third → DOWN encode the requested hypotheses, without establishing predictive value. The current bullish run is a subset of bullish history.
- There is exactly one entry at New York midnight per completed calendar day. Every constituent 15-minute Coinbase candle must be present; missing observations are never filled.
- At New York midnight, dollar conditions use only the exact entry-hour snapshot, with the prior DXY hour conservatively lagged one additional hour; no subsequent data is used.
- Daily correlations use 15 or 30 matched daily price levels; the separate 120-observation check uses matched hourly returns within 21 calendar days. All feature availability must precede entry. Daily DXY and BTC references retain the original conservative next-midnight plus one-hour availability convention.
- 95% intervals resample New York calendar days with replacement (10,000 replicates; fixed seed 20260915 plus a stable group hash). Fewer than 30 observations or 10 days is a limited sample. One-day groups have no interval. Unchanged outcomes remain in every percentage denominator.
- Missing prices and unavailable signals or ranges are excluded and counted. The frozen cutoff remains 2026-09-15T18:00:00Z (14:00 New York), so September 15 has hourly observations and no completed daily observation. The comparisons are exploratory, overlapping and unadjusted for multiple testing.
- Volume is Coin Metrics exchange-reported Bitcoin spot turnover in USD across covered markets; it is not total market activity or perpetual/ETF volume.
- Below average means the latest completed UTC day is strictly below the average of its preceding 15 completed UTC days, including weekends. The evaluated day is excluded from its own average.
- A UTC volume day becomes usable one hour after its following midnight. Missing days or lookback inputs remain unavailable; no older observation is carried forward.
- Historical volumes are the latest retrieved vintage. Original publication and revision timestamps are unavailable, so this proxy does not reproduce an exact historical live feed.
- Sensitivity checks use one additional day of lag and Coinbase BTC-USD spot volume in BTC with the same complete UTC-day rule. These checks keep the fixed 15-day threshold.
- The volume baseline uses the same overall study date window, regime, range zone, dollar and Quad restrictions, retaining only entries with complete volume inputs and removing the below/above-average restriction. First-per-day sampling is applied after these restrictions in each sample. It includes both low- and high-volume dates, rather than only dates selected by the volume rule.
- Volume comparison differences use paired resampling of the same New York date blocks for selected and baseline samples. Weekly sensitivity resamples Monday-start calendar-week blocks; yearly results are descriptive. Both retain unchanged closes in the denominator. All confidence intervals use 10,000 replicates batched 256 at a time.
- Dollar-filtered observations are unavailable before the recovered hourly DXY series beginning September 17, 2024. Earlier daily DXY closes alone cannot establish the required hourly condition. Quad groups use only separately verified actual-quarter evidence; missing optional evidence does not remove unfiltered observations.
- The original 2025–2026 study and its scripts are archived separately. Recovered report periods are included only after verified source and availability review. Reports never extend across unverified source gaps.
- Report history is discontinuous. Source gaps longer than two weeks: 2022-10-05 to 2024-12-16; 2025-01-15 to 2025-02-05; 2025-05-01 to 2025-05-28; 2026-06-04 to 2026-06-29. Shorter unavailable periods are also excluded and counted.
- Authenticated publisher archives contain additional reports in the mailbox gap. A January 2023 original was recovered, but historical receipt evidence was not established. Its publication time and image version alone do not satisfy the agreed entry-timing rule, so publisher-only observations remain excluded.
- Historical US Quads are retrospective published actual-quarter classifications, not forecasts known at entry. Estimates and quarters without independently verified classifications are excluded only when a Quad is selected.
- The verified source is the G20 and Global tables dated 2026-08-12, archived/reviewed 2026-09-09T18:02:55.426921Z; original publication time is unknown.
- Earlier actual Quads are recovered from the original 2025-07-22 G20 table, published 2025-07-22T11:23:00Z and received 2025-07-22T11:26:56Z; reviewed retrospectively 2026-09-15T23:15:37.000556+00:00. The overlap agrees with the newer source. Newly covered quarters: 2023-Q1, 2023-Q2, 2023-Q3, 2023-Q4, 2024-Q1, 2024-Q2. No 2021–2022 classifications were established.

## NYSE session

1,254 completed prices; 649 eligible signal/range entries; 0 missing complete price intervals.

| Year | Prices | Signals/ranges | Volume | Dollar | Actual Quads |
|---|---:|---:|---:|---:|---:|
| 2021 | 76 | 76 | 76 | 0 | 0 |
| 2022 | 251 | 188 | 251 | 0 | 0 |
| 2023 | 250 | 0 | 250 | 0 | 250 |
| 2024 | 252 | 11 | 252 | 72 | 252 |
| 2025 | 250 | 215 | 250 | 247 | 250 |
| 2026 | 175 | 159 | 175 | 174 | 123 |

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
- Volume is Coin Metrics exchange-reported Bitcoin spot turnover in USD across covered markets; it is not total market activity or perpetual/ETF volume.
- Below average means the latest completed UTC day is strictly below the average of its preceding 15 completed UTC days, including weekends. The evaluated day is excluded from its own average.
- A UTC volume day becomes usable one hour after its following midnight. Missing days or lookback inputs remain unavailable; no older observation is carried forward.
- Historical volumes are the latest retrieved vintage. Original publication and revision timestamps are unavailable, so this proxy does not reproduce an exact historical live feed.
- Sensitivity checks use one additional day of lag and Coinbase BTC-USD spot volume in BTC with the same complete UTC-day rule. These checks keep the fixed 15-day threshold.
- The volume baseline uses the same overall study date window, regime, range zone, dollar and Quad restrictions, retaining only entries with complete volume inputs and removing the below/above-average restriction. First-per-day sampling is applied after these restrictions in each sample. It includes both low- and high-volume dates, rather than only dates selected by the volume rule.
- Volume comparison differences use paired resampling of the same New York date blocks for selected and baseline samples. Weekly sensitivity resamples Monday-start calendar-week blocks; yearly results are descriptive. Both retain unchanged closes in the denominator. All confidence intervals use 10,000 replicates batched 256 at a time.
- Dollar-filtered observations are unavailable before the recovered hourly DXY series beginning September 17, 2024. Earlier daily DXY closes alone cannot establish the required hourly condition. Quad groups use only separately verified actual-quarter evidence; missing optional evidence does not remove unfiltered observations.
- The original 2025–2026 study and its scripts are archived separately. Recovered report periods are included only after verified source and availability review. Reports never extend across unverified source gaps.
- Report history is discontinuous. Source gaps longer than two weeks: 2022-10-05 to 2024-12-16; 2025-01-15 to 2025-02-05; 2025-05-01 to 2025-05-28; 2026-06-04 to 2026-06-29. Shorter unavailable periods are also excluded and counted.
- Authenticated publisher archives contain additional reports in the mailbox gap. A January 2023 original was recovered, but historical receipt evidence was not established. Its publication time and image version alone do not satisfy the agreed entry-timing rule, so publisher-only observations remain excluded.
- Historical US Quads are retrospective published actual-quarter classifications, not forecasts known at entry. Estimates and quarters without independently verified classifications are excluded only when a Quad is selected.
- The verified source is the G20 and Global tables dated 2026-08-12, archived/reviewed 2026-09-09T18:02:55.426921Z; original publication time is unknown.
- Earlier actual Quads are recovered from the original 2025-07-22 G20 table, published 2025-07-22T11:23:00Z and received 2025-07-22T11:26:56Z; reviewed retrospectively 2026-09-15T23:15:37.000556+00:00. The overlap agrees with the newer source. Newly covered quarters: 2023-Q1, 2023-Q2, 2023-Q3, 2023-Q4, 2024-Q1, 2024-Q2. No 2021–2022 classifications were established.

Public exports contain allowlisted derived values and provenance only. Original subscriber reports, message identifiers, images, links and raw provider bodies remain private.
