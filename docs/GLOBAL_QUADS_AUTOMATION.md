# Global Quads screenshot updates

## Current workflow — September 9, 2026

The user supplies occasional screenshots in the task. Codex transcribes the published tables, compares the readings against the originals, archives each screenshot, and imports the reviewed data. Both dashboard views share the same research snapshot. No user transcription, browser login, or separate upload interface is required.

The August 12, 2026 screenshots from the Q3 mid-quarter presentation have been imported:

| Table | Rows, including published aggregate | Sourced quarters |
| --- | ---: | --- |
| G20 | 21 | 2Q24 through 2Q27E |
| Emerging markets | 25 | 2Q24 through 2Q27E |
| Global Macro Risk Monitor | 47 | 3Q24 through 2Q27E |

All 1,162 cells were visually reviewed and cross-checked against independent OCR. The printed table date remains August 12; the upload date is not represented as a new research publication. The exact original publication timestamp is unknown and remains null. Forecast designations stay estimates as time passes. Missing values remain missing. MODE/MEDIAN and MODE/MEAN are distinct published rows and are never recomputed.

The compact card retains its existing country selection and shows the previous quarter, current quarter, and next three estimates (five quarter columns), rolling forward on New York calendar quarter boundaries. Only the three future headers carry `E`; the original published actual/estimate classification remains in each reading's source tooltip. Missing published readings remain blank without removing their quarter headers. Select the centered Global Quads title to open all three tables and their complete sourced history. Each reading and each table links to its archived source image. Screenshot sources do not acquire fictitious Gmail links.

## Operator import

Use `infra/scripts/import_global_quads_screenshots.py` with a reviewed JSON manifest. Preview is the default; `--apply` archives and publishes. The manifest includes each table's printed date, exact quarter labels, row values, image path and SHA-256, and a review record identifying the reviewer, review time, method, and transcription hash. The source is recorded as `reviewed-screenshot` with `visual-source-comparison`; no OCR confidence is fabricated.

```sh
python3 infra/scripts/import_global_quads_screenshots.py path/to/reviewed-transcription.json
python3 infra/scripts/import_global_quads_screenshots.py path/to/reviewed-transcription.json --apply
```

The September 9 import artifacts and validation results are in ignored `.cache/global-quads/screenshots-2026-08-12/`. Originals and review records are archived under the private S3 prefix `hedgeye-email/assets/global-quads/`. The existing `HedgeyeDailySnapshot` table holds immutable source history and a conditional-version current projection. Duplicate imports keep the original source date; older or conflicting readings cannot silently replace newer verified data.

Systems records the screenshot update mode separately from the research date. Old email extraction issues remain in the underlying health record and an archived control-history record, but are inactive for the screenshot workflow. Browser `quadForecast_v3` entries, monthly readings, and portfolio controls are unchanged.

## Automated email extraction

Global Quads email extraction and automatic publication are both disabled on the existing Gmail and PDF workers (`GLOBAL_QUADS_INGEST_ENABLED=0`, `GLOBAL_QUADS_PUBLISH_ENABLED=0`). Other ingestion, function code, and schedules were preserved. The infrastructure template reflects the same setting.

The earlier email-only backfill inspected 518 matching emails and held eight candidate tables because their quarter headings did not meet the 98% OCR threshold. That unattended gate remains unchanged. This reviewed-screenshot workflow replaces the proposed automatic rollout. Before any future reactivation, update and validate the deployed parser, verify actual source tables, and deliberately change the two flags; importing a screenshot does not turn email publication on.

## Verification

Focused importer/parser/storage, service/API, UI, and status checks pass. The importer checks source and transcription hashes, actual/estimate labels, missing cells, ordered quarters, and source dates. Tests cover duplicate imports, inactive email issues, and screenshot sources without invented email or publication metadata. Production build and changed-file lint pass. The running API and both dashboard views are checked against the saved data and source images.

The earlier broader infrastructure contract test has an unrelated mismatch around existing Analyst journal/event-ledger environment settings; no unrelated working-tree changes were reset or committed.
