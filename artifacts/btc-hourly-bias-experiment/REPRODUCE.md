# Reproduce the BTC hourly experiment

Run these commands from `/Users/timsmith/Desktop/cursor/market-dashboard`.

## Regenerate the report offline

```sh
python3 scripts/research/btc_hourly_bias.py
```

This reads the saved `source-signals/signals.json`, `source-prices/candles.json`, and `source-prices/settlements.json`. It recreates the HTML/Markdown report, charts, observation and statistics CSVs, exclusions, and manifest. It uses NumPy and Matplotlib already available in the local Python environment. No dashboard service is needed.

The study is frozen at September 15, 2026 18:10:12 UTC, with completed hourly observations through 18:00 UTC. The bootstrap uses 10,000 daily resamples with seed 20260915 and deterministic group-specific seeds. Running again with identical inputs and runtime reproduces the statistical results.

## Verify the implementation

```sh
python3 -m unittest discover -s scripts/research -p 'test_btc*.py' -q
python3 scripts/research/btc_signal_history.py self-test
```

The tests cover publication/receipt timing, signal changes, missing reports, candle duplicates and gaps, incomplete hours, flat prices, exact range boundaries, Pacific daylight-saving changes, finalized settlement evidence, and deterministic resampling. Report generation also asserts that the aggregate direction counts reconcile.

## Rebuild source inputs

Price collection and cached archive replay:

```sh
python3 scripts/research/btc_price_history.py --as-of 2026-09-15T18:10:12Z --requests-per-second 5
```

The collector verifies and reuses preserved raw response archives. Coinbase data come from BTC-USD hourly candles. Kalshi evidence comes from the complete public historical market cursor for KXBTCD, deduplicated to agreeing finalized expiration values per event. Missing prices and incomplete settlement evidence are excluded. URLs, retrieval times, response hashes and coverage are retained in `source-prices/fetch-manifest.json` and the raw response metadata. A fresh full Kalshi archive collection is substantially larger than an offline analysis run.

Signal reconstruction from saved original publications:

```sh
python3 scripts/research/btc_signal_history.py finalize
```

See [signal evidence and reproduction details](source-signals/REPRODUCE.md) for optional OCR and collection commands, source access requirements, manual image review ledgers, the publication calendar, and exclusions. Full source collection uses the authorized private archive and saved connected-mailbox exports; it is not a public unauthenticated download.

After rebuilding any inputs, regenerate the report. Do not mix future observations into this frozen study. The analysis remains separate from dashboard operation and places no orders.
