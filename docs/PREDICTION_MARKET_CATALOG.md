# Prediction-market current-release catalog

The operational CPI identity is server owned. `GET /api/prediction-markets/cpi/current` derives the release from the latest verified Headline CPI YoY nowcast and returns its canonical `releaseKey` (`KXCPIYOY#YYYY-MM`), release date, venue-native events, coverage, and separate display/IBKR-execution readiness.

Historical month selection in the UI is view state only. Refresh and discovery POSTs intentionally send no month, and Express replaces any supplied CPI context with the current server release.

## Live-data boundaries

- Kalshi display quotes come directly from Kalshi's native YES and NO book fields.
- IBKR execution rows pass one shared qualification gate. It requires an authoritative `reqContractDetails` result, native conId, exchange, trading class, expiry, `catalog_source=ibkr_contract_details`, explicit current `releaseKey`, known native YES/NO side metadata, and a fresh executable native bid/ask pair.
- Expired, wrong-release, mock, cached, fallback, portfolio-derived, and legacy seed rows never satisfy display or execution readiness.
- The June `scripts/ibkr_sidecar/event_contracts.json` file is quarantined legacy input. The sidecar does not load it as the operational catalog.
- `PredictionMarketCatalogV2` is the sole operational metadata catalog. The sidecar receives the exact active generation in each refresh request; ignored local JSON is not read or promoted.

## Release-keyed DynamoDB adapter

`src/services/predictionMarketsIngest/catalogSchema.js` exports a pure, AWS `CreateTable`-compatible definition. It performs no deployment and is tested for exact structural equality with `infra/template.yaml`. The catalog writer and loader use the same configuration:

- table: `PREDICTION_MARKET_CATALOG_V2_TABLE` (default `PredictionMarketCatalogV2`);
- partition key: `releaseKey` (string);
- sort key: `contractKey` (`venue#nativeId`), with `__META__` reserved for that release's metadata row and the `__CONTROL__/CPI#CURRENT` item reserved for the active-release pointer;
- contract rows persist an allowlisted `metadata` document only. Bid/ask/last,
  implied/model probability, volume, quote timestamps, and live-quality flags
  are never written to or read from the catalog;
- billing: on demand; and
- point-in-time recovery enabled in the adapter definition.

Active trading routes read contract metadata from DynamoDB, then obtain every
quote live from its native venue. Catalog rows can never supply bid, ask, mark,
or freshness. A qualified reconciliation uses one optimistic
`TransactWriteItems` operation to replace only the successfully reconciled
venue, update `__META__`, and advance `__CONTROL__/CPI#CURRENT`. Other venues
survive a partial provider failure. Ordinary provider refreshes are upsert-only
and cannot delete absent contracts. Transaction failures propagate, so the
caller cannot report promotion after a partial write. The local runtime IAM
principal needs `dynamodb:Query` and `dynamodb:TransactWriteItems` on the table.

Example inspection without AWS changes:

```bash
node -e "console.log(JSON.stringify(require('./src/services/predictionMarketsIngest/catalogSchema').createDynamoCatalogTableInput(), null, 2))"
```

## Operational flow

1. `GET /api/prediction-markets/cpi/current` resolves the current release, loads the matching active V2 generation, and performs fresh Kalshi and IB sidecar quote requests. It never promotes the sidecar's retained `/events` snapshot into the live response.
2. The prediction-market watchlist also forces `POST /refresh` before an IBKR
   row can be marked executable. The retained `/events` snapshot is status-only.
3. `POST /api/prediction-markets/discover/ibkr` sends that server-owned release to the sidecar.
4. The sidecar makes venue/security-type ContractDetails queries and returns only native candidate identities; it never manufactures a Kalshi ticker, IB symbol, or localSymbol and never writes operational catalog state.
5. Express verifies the fresh candidate's release, conIds, exchange, trading class, expiry, native side, and complete target-strike coverage before atomically promoting it in V2.
6. `POST /api/prediction-markets/refresh/ibkr` loads V2 and asks the sidecar to quote only authoritative, current, unexpired catalog rows.
7. Readiness reports `prediction.display` independently from `prediction.ibkrExecution`.

## Reconciliation lifecycle

The Express process owns CPI catalog reconciliation. It reconciles once when
the stack starts, polls the current server-owned release/nowcast fingerprint,
and reconciles on any fingerprint change. On weekdays it also reconciles every
15 minutes during the 4:00–9:30 a.m. New York premarket window. Manual
`POST /api/prediction-markets/discover/ibkr` uses the same reconciler; any CPI
month supplied by the browser is ignored for operations.

Every run emits a typed `cpi_catalog_reconciliation` outcome. The sidecar
returns a non-promoted `catalog_candidate`; a run fails closed unless Express
independently verifies authoritative native contracts for every target strike
and DynamoDB confirms the atomic generation plus current-release pointer
promotion. Retained rows, zero fresh discoveries, partial discovery, or a V2
write failure do not satisfy reconciliation or alter the healthy generation.
Current scheduler state and the latest
outcome are available at `GET /api/prediction-markets/reconciliation/status`.
If IB's authoritative ContractDetails search returns no supported/entitled
current-release product, the sidecar, provider payload, route response, and
execution-readiness check preserve the typed
`UNSUPPORTED_OR_NOT_ENTITLED` error instead of collapsing it into a generic
“no live contract” message.
