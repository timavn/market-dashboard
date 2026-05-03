# Hedgeye processing ledger (idempotency)

Bulk Textract backfills should **not** pay twice for the same PDF bytes. Use a small DynamoDB table as a processing ledger keyed by content hash.

## Table: `HedgeyeProcessingLedger`

| Key | Type |
|-----|------|
| Partition `snapshotType` | String — same values as `HedgeyeDailySnapshot.snapshotType` (e.g. `signal-strength`, `bitcoin-trend-tracker`) |
| Sort `contentSha256` | String — hex SHA-256 of the PDF file |

**Attributes (optional metadata):**

- `reportDate` — `YYYY-MM-DD` from the report (not part of the key; informational)
- `pdfSource` — S3 key after upload
- `dynamoSnapshotKey` — human-readable `(date)#(snapshotType)` or similar if useful for audits
- `processedAt` — ISO UTC timestamp
- `processorVersion` — bump when parser logic changes enough to warrant reprocessing

## Workflow

1. After downloading a PDF locally (or listing from S3), compute `sha256_file(path)` via [`hedgeye_processing_ledger.py`](hedgeye_processing_ledger.py).
2. `get_existing_item(snapshot_type, sha)` — if present, skip Textract/Dynamo writes for this file.
3. On successful parse + DynamoDB write, call `try_claim_pdf_processed(...)`.

`try_claim_pdf_processed` uses `PutItem` with `ConditionExpression` so concurrent workers cannot double-insert the same `(snapshotType, contentSha256)`.

## Reprocessing

To force re-run after improving parsers:

- Delete the ledger row for that hash, **or**
- Bump parser output versioning and include version in `contentSha256` mix only if you deliberately change inputs — simpler: delete ledger rows or use a new `snapshotType` suffix (not recommended).

## CLI / batch integration

[`process_hedgeye_batch.py`](process_hedgeye_batch.py) may call the ledger helpers before each processor (optional flag `--skip-ledger` for forced reruns). Wiring is intentionally lightweight until you enable the table in AWS.
