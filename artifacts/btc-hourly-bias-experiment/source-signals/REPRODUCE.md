# BTC signal history evidence

## Frozen study

July 28, 2025–September 15, 2026, with analysis cutoff `2026-09-15T18:10:12Z`.

`signals.json` is the analysis input: 285 Crypto Tracker report versions across 284 dates; 269 have verified publication, inbox receipt, original BTC direction, and ranges. One incorrectly classified MOMO report is preserved in excluded-source metadata and never affects the Crypto Tracker timeline. The March 11 correction remains a separate chronological publication.

The current verified transition is **BEARISH → BULLISH on August 20, 2026**, available at **12:38:43 UTC / 05:38:43 PT**. The first complete eligible hourly interval starts at 13:00 UTC / 06:00 PT. August 19 and August 20 original tables were visually checked.

## Reproduce from saved evidence

Run from the repository root:

```sh
python3 scripts/research/btc_signal_history.py self-test
python3 scripts/research/btc_signal_history.py finalize
```

Finalization uses saved inputs and the repository's U.S. trading-day calendar. It performs no network requests and does not change dashboard ingestion. Seven focused self-checks cover EST/EDT, inbox receipt versus sender Date, later image revisions, missing receipt, independent range quality, and refusing price-derived direction.

To reproduce OCR on the saved original image bytes:

```sh
python3 scripts/research/btc_signal_history.py --refresh ocr
python3 scripts/research/btc_signal_history.py finalize
```

OCR uses macOS Vision through the Swift source embedded in the Python script. It stores recognition text, confidence and bounding boxes. Existing Python packages used are boto3, python-dotenv and BeautifulSoup. The reviewer ledgers under `visual-review/` contain independently inspected values and exact image hashes; finalization requires every transition/boundary to have a visual review.

## Collect or extend source evidence

`collect` performs bounded DynamoDB reads and archived S3 HTML reads. It consumes the saved connected-Gmail exports `gmail-inventory.json` and `gmail-metadata.json`; it does not read OAuth secrets. The complete paginated Gmail query is recorded in the inventory. Metadata uses Gmail `internal_date` and trusted Google `Received` headers. Missing S3 HTML was exported from the same original Gmail messages into `html/` through the connected Gmail read tools.

```sh
python3 scripts/research/btc_signal_history.py collect
python3 scripts/research/btc_signal_history.py ocr
python3 scripts/research/btc_signal_history.py finalize
```

The collector's source window is frozen to this experiment. For an extension, obtain a new complete Gmail inventory/metadata export and set a new study cutoff before collecting additional dates. Never append future observations to the frozen study silently.

## Timing and image audit

- The published **TREND** is the signal. Buy TRADE and Sell TRADE supply the range; headline percentage performance is unrelated to direction.
- `availableAt` is the later of actual report publication and trusted inbox receipt. Stored midnight `publishedAt` and sender-Date-derived `scrapedAt` are never used as hourly availability.
- Each image URL is recovered from its original dated email, with a report-specific numeric path. Saved SHA256, ETag, source version ID and Last-Modified audit the fetched bytes. Last-Modified must precede that report's availability, so a later replacement cannot enter an earlier observation. Most tables do not print an exact date; date evidence is the archived report plus source version metadata, disclosed per record.
- `validUntil` and `interruptions` explicitly stop prior-state carry at invalid or missing reports. Source direction remains separate from range quality.
- The [official user guide](https://app.hedgeye.com/user-guides/bitcoin-trend-tracker) specifies publication on U.S. trading days. Last-state carry between reports is the experiment's stated convention. Weekend/holiday dates also have no exceptional report in the complete source inventory.

## Exclusions

- August 6, 2025: source image URLs returned HTTP 403; direction remains unknown until the next verified report.
- October 6, 2025: all observed source panels were inspected; no original BTC direction/range table was recoverable. No ETF proxy or headline substitute was used.
- June 4–29, 2026: 14 archived reports retain publication/table evidence but their Gmail IDs no longer resolve for trusted inbox timing; June 25–26 reports were not found in a separate expanded mailbox search. This interval is excluded from the primary timed sample.

Full source HTML, report metadata and original images are private subscriber evidence. The final analysis uses extracted BTC fields and links to the originals; it does not publish these research documents.
