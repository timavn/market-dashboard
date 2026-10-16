# Bitcoin range-entry experiment

Historical research only. Frozen completed-hour cutoff: 2026-09-15T18:00:00Z.

## Requested entry hypotheses

| Setup | Hours / days | Desired direction | Frequency | 95% interval |
|---|---:|---|---:|---:|
| Bullish / bottom third | 728 / 58 | UP | 49.59% | 46.7–52.6% |
| Bearish / top third | 1257 / 104 | DOWN | 51.87% | 49.3–54.5% |
| Current bullish run / bottom third | 163 / 12 | UP | 47.24% | 43.1–51.9% |

All 750 combinations, including empty samples, are in `study.json` and `statistics.csv`.

## Method

- Entry is the Coinbase BTC-USD opening price of a completed UTC hour; outcome is that hour's close versus its open. This is price direction, not a contract-strike win rate or profit simulation.
- The published Crypto Tracker Trend and lower/upper ranges apply only after verified publication and receipt. Trade is an alias of Trend in the archive; Buy/Sell Trade values are range boundaries, not separate directional signals.
- Bottom third includes the lower bound and excludes the one-third boundary. Middle includes one-third and excludes two-thirds. Top includes two-thirds and the upper bound. Prices below or above the published range are separate groups and never highlighted as preferred entries.
- Highlighted research setups are Bullish + bottom third → UP and Bearish + top third → DOWN. The highlighting encodes the requested hypothesis; it does not establish predictive value.
- Every qualifying hour is the primary mode. First per day selects the earliest qualifying hour within each Pacific calendar date and each specific regime × zone × filter. It does not imply a fixed daily execution time or select the most favorable hour afterward.
- The current bullish run is a subset of bullish history. All known signals combine bullish, bearish, and neutral hours. First-per-day counts across regimes need not add to the all-signals count because each group selects independently.
- Dollar filters use the previous experiment's preserved DXY observations and timing. The dollar point must end exactly one hour before BTC entry; missing hourly points are not carried forward. A 10 bp move is 0.10%.
- Dashboard-compatible correlations use 15 or 30 aligned daily price levels. The separate 120-observation return-correlation check uses matched hourly returns within 21 calendar days. Thresholds mean correlation ≤ −0.50 or ≤ −0.75.
- Completed-day dollar movement compares the earlier hourly DXY point with the latest available daily close. Daily DXY observations become available at next New York midnight plus one hour, and BTC daily observations at next UTC midnight plus one hour. Historical publication latency is unknown; these are conservative timing conventions. Prior-hour movement compares consecutive DXY hourly closes.
- 95% intervals resample complete Pacific calendar days with replacement (10,000 replicates; fixed seed 20260915 plus a stable group hash). Fewer than 30 hours or 10 days is a limited sample; a single-day group has no reported interval.
- Unchanged hours remain in the percentage denominator. Missing candles, unresolved reports, and unavailable ranges are excluded and counted; prices are never filled. The many overlapping comparisons are exploratory and receive no multiple-comparison adjustment.
- Official BRTI checks use only previously verified consecutive final hourly settlements, matched to the same Coinbase-selected entry hours. They measure settlement-to-settlement direction separately from Coinbase open-to-close direction.

## Reproduce

Run from the repository root, using the preserved inputs:

```sh
python3 scripts/research/btc_range_entry_experiment.py
python3 -m unittest discover -s scripts/research -p 'test_btc_range_entry_experiment.py' -q
```

The default run creates this artifact directory and refreshes only `public/research/bitcoin/` derived research files. It performs no network requests, modifies no dashboard data pipeline, and sends no orders.

Inputs: the prior USD experiment's hourly observations plus the original BTC study's manifest and final settlement changes. SHA-256 hashes and validation results appear in `manifest.json`. Public downloads contain derived hourly observations without subscriber message IDs, mail links, source images, or raw provider responses.
