# Security record

One per-ticker record in the Express server that every dashboard surface reads, so a ticker's name, research decisions, product calls, risk, sizing and recent activity are the same figure everywhere.

```
GET /api/security-universe?symbols=DRAM,LULU(≤50)&fields=identity,research,stance,risk,activity
```

Code: `src/services/securityUniverse/` (service, `pieceCache`, `fields`, `pieces/*`), route `src/routes/securityUniverse.cjs`, wiring in `server.js` next to the identity resolver.

## Record

Every leaf is a **Field**: `{ status, value, source, asOf, reason, …}`. A missing fact is a Field with `value: null` and a reason (`symbol-not-in-verified-primary-publication`, `identity-directory-unavailable`, `Contract-specific sizing required`, …). Nothing falls back to mock, seeded, catalog or stale data, and an expired cache entry is never served.

| Piece | Fields | Built from | Cadence |
|---|---|---|---|
| `identity` | `name`, `displayName`, `instrumentType`, `exchange`, `priced` | Identity resolver (`exposureLabSecurityIdentity.cjs`): SEC ticker directory, Yahoo for tickers SEC does not list, and an exact ETF/fund name over a SEC trust registrant. `displayName` is Yahoo's exact-ticker `longName`, or the SEC name re-cased (`securityDisplayName.cjs`), each cited to its own source. | 24h when complete; partial or failed 5 min |
| `research` | `trade`, `trend`, `tail`, `riskRange`, `signalStrength`, `signalStrengthShorts` | `loadCanonicalSecurityIntelligence` (security intelligence v2 decision descriptors, the shared research projection AGENTS.md requires). `trade` is `partial` when the published-trade archive has not read every source within 15 min (`status().refreshedAt`). | 60s, failure 30s |
| `stance` | `calls[]` | The stance book the Inbox attention scan last scored (`dailyWorkflow.scoredStanceBook()`), read with `stanceBook.securityCalls`. A book the scan could not read is `stance-book-unreadable`, never an empty list. | Every scan; unavailable when more than 5 min old |
| `risk` | `instrumentType`, `referencePrice`, `atr14`, `atrPct`, `beta`, `sizing` | `buildSecurityRiskMetricsResponse({ sizingOnly })`, the same code as `/api/security-risk-metrics`, then `securitySizingReference`, the Positions table's own gate and Sizing v2.0 band. | Shared 1h bar cache |
| `activity` | `zScore20`, `realizedVol` (rv21/rv63/rv252, close-to-close), `horizons` (Inbox horizon table) | `horizonStats`, `calculatePriceZScore20` and `buildRealizedVolatilitySnapshot` on the same `sizing-2y` bars. | Shared 1h bar cache |

### One instrument per record

`resolveHistoryInstrument(symbol)` in `server.js` gives the one Yahoo symbol behind a dashboard symbol: its listed share class (BRK.B → BRK-B) or the instrument the dashboard prices for an alias (BTC → BTC-USD, GOLD → GC=F, CORN → ZC=F). Daily history, the identity resolver and the record all resolve through it. Before this change, identity and bars used different share-class rules, so RPI.L was looked up as RPI-L.

- `identity.name` is always the **listed** security for the exact ticker, the one an IBKR STK holding is (BTC = Grayscale Bitcoin Mini Trust ETF).
- `identity.priced` is set only when the dashboard prices a **different** instrument under that ticker (BTC → "Bitcoin USD", GOLD → "Gold", CORN → "Corn Futures"). This marks a pre-existing problem: risk, ATR and sizing for a held CORN or BTC share are computed from futures or spot bars (see migration 5).
- `research.riskRange` / `trend` carry `sourceInstrument` and `match: direct | proxy | unverified`:
  - **Aliases.** Readings routed through a research alias (SPX → SPY, RUT → IWM, DXY → UUP) are `proxy`. The only exceptions are tickers that `src/constants/instrumentEquivalence.json` lists as measuring the same instrument (BITCOIN ≡ BTC).
  - **Ingest rewrites.** The email parser files GOLD as GLD and WTI as USO (`rewrittenAtIngest`), so those are `proxy` too.
  - **Scale check.** A range more than 2× away from the security's own completed close is `proxy` whatever its key says.
  - **Live, 2026-10-30.** SPY/SPX, IWM/RUT, UUP/DXY, USO/WTIC and GLD/GOLD are `proxy`; AAPL, XLV and BTC/BITCOIN are `direct`.

## Readers today

| Surface | How it reads the record |
|---|---|
| Inbox stance cards | `analystAttention` loads `fields=identity` for held symbols (batches of 50, 8s timeout) and passes `context.securities` into `evaluateResearchAttention`. `presentation.stance.name` is `identity.displayName`. A Signal Strength roster name is used only while the record has no identity. Names are display-only and not part of `material`, so no alert re-opens. |
| `/api/security-identities` | Projection of `identity`. Same rows, caps and 503 rules as before; adds `displayName`. Portfolio Brief and Daily Rollup names (via `usePortfolioSecurityNames`) now show `displayName`. |
| `/api/analyst/horizon-stats` | Projection of `activity.horizons`. Same shape and 25-symbol cap; symbols without verified history are omitted. |
| Stance cards and the record | Both use `stanceBook.stanceCall` and the same roster-drop rule on the same scored book. The card shows the calls that bear on the side held; the record lists every product call. |

## Remaining migrations, recommended order

1. **Sidecar sizing and names** (`scripts/analyst_sidecar/portfolio_sizing.py` `PortfolioSizingReader`, `portfolio_capture.captured_security_name`, `portfolio_brief.rule_holdings`). Read `risk` and `identity` from the record instead of `/api/security-risk-metrics` plus the Python gate copy (`verified_sizing_inputs`). This fills `securityName`, which is null in production because IBKR rows carry no name, and retires the second gate implementation. Medium risk: saved reviews re-project captured shapes, and freshness gates are coupled to Express cache settings.
2. **Inbox research rows** (`attentionResearch.cjs` `durationRows`, `stanceOrder`, the opportunity counterpoint, `processLimitRows`). Read `context.securities` research and risk. This changes Trade/Trend `material`, so plan one re-fingerprint, or alerts re-open as unread. Show the `proxy` source instrument on range rows.
3. **Front end**, lowest risk first:
   1. AnalystInbox horizon fetch (`AnalystWorkspace.loadHorizonStats`) → `fields=activity`.
   2. AnalystDailyRollup and MorningTldrPanel names → `identity.displayName`.
   3. PortfolioBreakdown + `usePortfolioMarketContext` + `usePortfolioResearch` → `risk`/`research`. Positions use the `maximum` bar scope today, so they can sit on a different last bar than the record for up to an hour. Move them to the record's bars and unify the stop basis: average cost there, last close in the Inbox and Portfolio Review.
   4. Exposure Lab `useUniverseSizing` / `SecuritySizingCell`.
   5. SignalStrengthPanel, VolumePanel and PerformanceTracking still name securities from the static `SECURITIES_LIST`.
   6. `useDashboardResearch`, which merges 7 sources in the browser.
   7. The Volatility table reads `/api/volatility-snapshot`, an index-level reading rather than per-security facts. It stays separate.
4. **Exposure Lab universe names** (`loadExposureLabUniverse`, 1,009 rows). Different precedence (catalog for BTC/ETH/GOLD/XRP, audited archive names) and Yahoo is never tried for catalogued rows. Move it to `identity` with the reviewed security-master override (`ExposureLabSecurityMasterV1`, empty today) added as the top precedence. Warm the 24h identity cache first.
5. **Instrument keying and source fixes.**
   - Key held positions by IBKR conId/secType, so a held BTC/CORN share is never priced as spot or futures.
   - Fix security intelligence at the source, so proxied SPX/RUT/DXY/WTI/gold ranges are not `decisionEligible` for ETF holdings. `rule_holdings` accepts `direct_alias` references today.
   - Consolidate the ~10 ticker alias tables (`YAHOO_TICKER_MAP`, `securitiesConfig.js`, `research_entities.json`, `RISK_RANGE_TICKER_ALIASES`, the parser `TICKER_MAP` copies, …) into one catalog.
   - Retire the duplicate Z-score (6) and realized-vol (3) implementations in favour of the record's.
   - Review client localStorage retention (`dashboardResourceRegistry`, 30 days) against the no-stale rule.

Not covered yet: a Tail producer (every Tail is `no-published-tail-source`), and The Call / Macro Show / Early Look / Portfolio Solutions in the stance book.
