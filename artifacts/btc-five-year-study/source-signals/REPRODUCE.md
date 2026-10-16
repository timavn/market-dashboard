# Five-year BTC report evidence

This private archive extends the frozen research window to September 15, 2021–September 15, 2026, with cutoff `2026-09-15T18:00:00Z`. It preserves the original shorter study separately.

The connector recovered 395 older candidate messages in the target window. Seven are promotional or welcome messages, leaving 388 actual Tracker reports. Of these, 385 have verified original BTC direction, ranges, publication time and trusted receipt. Three remain excluded: one inaccessible original image and two images with blacked-out asset identifiers.

The combined input has 673 report versions, 654 verified direction/range reports, and 130 visually reviewed reports. Missing expected publications interrupt the timeline. The long October 2022–December 2024 gap and smaller 2025 gaps remain unavailable; values are never carried through them. The complete dates and counts are in `coverage-summary.json` and `signals.json`.

## Reproduce from saved originals

From the repository root:

```sh
python3 -m unittest discover -s scripts/research -p test_btc_signal_history.py
python3 scripts/research/btc_signal_history.py --output artifacts/btc-five-year-study/source-signals import-gmail
python3 scripts/research/btc_signal_history.py --output artifacts/btc-five-year-study/source-signals --start 2021-09-15 --end 2026-09-15 --as-of 2026-09-15T18:00:00Z finalize
python3 scripts/research/btc_signal_history.py --output artifacts/btc-five-year-study/source-signals seal
python3 scripts/research/btc_signal_history.py --output artifacts/btc-five-year-study/source-signals verify
```

The saved raw Gmail MIME trees retain original headers and HTML. The importer supports both Gmail field conventions and two- or four-digit publication years. Availability is the maximum of publication and trusted receipt evidence. Original image bytes, SHA256, HTTP version metadata, OCR geometry, and visual reviewer ledgers remain bound to the original email image URL. Numeric OCR with malformed thousands separators is rejected.

`finalize` is offline. It verifies original image hashes/headers and source links, applies the visual review ledger, checks each direction transition, and rebuilds validity intervals and expected-report interruptions using the shared U.S. equity calendar. `seal` records SHA256 and size for every private source file; `verify_source_archive(path)` checks that manifest before the composer uses the normalized input. Any subsequent source change requires deliberate regeneration and resealing.

## Additional archive checks

`archive-audit/recovery-audit.json` records the completed mailbox searches, including Spam/Trash search for the major gap. The available connection returned HTTP 403 for the exact publisher article, date-filtered archive, search, and two subscribed macro-deck links. Computer use reported no connected browser. These access failures do not prove that older reports do not exist in the publisher archive.

Eight original macro preview images were recovered. `older-us-quad-checkpoint.json` contains an independently reviewed numeric United States Actuals row covering 2023 Q1–2025 Q1 from the original July 22, 2025 publication. Later overlapping actuals should use the existing newer verified checkpoint. Forecast columns and GDP/CPI-only history are excluded. No 2021–2022 US Quad classification was established.

All email bodies, subscriber links, source images, OCR and reviewer ledgers are private evidence. Public exports use extracted statistics and the sanitized coverage summary only.
