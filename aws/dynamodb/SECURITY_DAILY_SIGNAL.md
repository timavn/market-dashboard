# SecurityDailySignal (derived analytics schema — sketch)

Materialized **per-symbol / per-day** row built deterministically from existing Hedgeye tables so performance analytics (timeline of trends, ranks, long/short context) do not require ad hoc joins across large snapshot blobs at read time.

## Table (conceptual): `SecurityDailySignal`

**Primary key**

| Attribute | Role |
|-----------|------|
| `symbol` | HASH — uppercase ticker |
| `date` | RANGE — `YYYY-MM-DD` |

**Suggested attributes**

| Attribute | Description |
|-----------|-------------|
| `sources` | Map — which feeds contributed that day (e.g. `{ riskRanges: true, signalStrength: true, macroShowLong: false }`) |
| `riskRangeTrend` | String — from `HedgeyeRiskRanges` / snapshot `risk-ranges` (`BULLISH` / `BEARISH` / …) |
| `lrr` / `hrr` | Number — optional denormalization from Risk Ranges |
| `signalStrengthListed` | Boolean — ticker appeared in Signal Strength list |
| `portfolioSolutionsRank` | Number — ETF rank slot when sourced from Portfolio Solutions |
| `macroShowSide` | String — `LONG` / `SHORT` when parsed from Macro Show |
| `theCallSide` | String — same for The Call |
| `momoTrend` | String — when present on Momo snapshot |
| `projectorVersion` | String — bump when merge rules change |

## Population model

1. **Source of truth** remains [`HedgeyeDailySnapshot`](./DYNAMODB_SCHEMA.md) + [`HedgeyeRiskRanges`](./DYNAMODB_SCHEMA.md) + [`RiskRangeData`](./DYNAMODB_SCHEMA.md).
2. A **batch projector** (Lambda scheduled or one-off CLI) reads snapshots for date `D`, extracts symbols from each relevant `snapshotType`, and writes/merges `SecurityDailySignal` items (`PutItem` or `UpdateItem` per `(symbol, date)`).
3. Idempotent projector runs align with [`HedgeyeProcessingLedger`](../lambda/HEDGEYE_PROCESSING_LEDGER.md): ledger guards PDF ingest; projector version guards recomputation.

## Global Secondary Index (optional)

- **GSI1**: HASH `date`, RANGE `symbol` — “all symbols touched on day D” without scanning the symbol partition space.

## Frontend reference implementation

See [`src/utils/securityDailySignalProjection.js`](../../src/utils/securityDailySignalProjection.js) for a minimal merge sketch used when prototyping dashboards offline.
