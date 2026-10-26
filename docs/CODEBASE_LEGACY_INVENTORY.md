# Milestone 7d — bounded legacy/disuse inventory

Audit date: 2026-09-11. Read-only repository audit; no deletion or production edit.
This milestone records disuse evidence without deleting implementation. Line numbers below
describe the audited source; use the named declarations as stable anchors after
the separately staged route extractions.

## Method and limits

- Read root AGENTS.md and the live-trading-data-guard skill completely.
- Searched the repository for exact module paths, exported identifiers, direct
  imports/requires, lazy `import()` calls, `require.context`, `import.meta.glob`,
  source-reading tests, and server `eval`/`new Function` entry points.
- Parsed the actual `server.js` with the already-installed Babel parser/traverse
  to inspect lexical bindings, reference paths, and constant violations. The
  server was never imported or executed; no provider was called.
- Checked Vite/CommonJS resolution and Jest/native test discovery. No discovered
  dynamic loader targets the isolated logo file or private server bindings.
- This is a finite inventory, not a claim that every unreferenced file in the
  repository is safe to delete or that external/local tooling has been audited.

## Proven unreferenced private server declarations — retain for now

All five have zero Babel binding references, zero reassignments, no exports, and
no string-based source extraction/callers in the repository. `server.js` exports
only `app`; its route registry does not expose these function bindings.

| Declaration in server.js | Audited lines | Body lines | Consumers |
| --- | --- | ---: | --- |
| `resolveEtfProFromEmailFullBook` | 846–877 | 32 | None |
| private `fetchYahooQuote` | 2373–2504 | 132 | None |
| `fetchFredHistoricalData` | 7100–7150 | 51 | None |
| `calculateAnnualizedROC` | 7153–7163 | 11 | None |
| `getValueMonthsAgo` | 7166–7203 | 38 | None |

Important name collision: `fetchYahooQuote` in
`src/services/providers/yahoo/yahooMarketDataProvider.js` is called and exported;
it is not a removal candidate. The documentation
comment in `normalize/normalizeQuote.js` mentioning the server's old function is
not an executable consumer.

The source-reading tests inspect AWS configuration/credential ordering, regional
symbol mappings, or the exact `isQuoteUsableNow` function. They do not extract the
five candidates:

- `scripts/dev-stack/cli.test.js`
- `src/services/aws/clients.test.cjs`
- `src/services/providers/__tests__/multiRegionServerConfig.test.js`
- `src/services/providers/normalize/quoteContract.test.cjs`

Future smallest removal scope: remove only these five function declarations
(264 body lines), leaving imports/provider setup/routes/middleware/listeners
unchanged. Re-run binding/source-consumer checks against that checkpoint first;
then compare HTTP registration method/path/order, run provider/quote contracts
and focused route tests, lint, and the normal integration gate. Do not remove
newly unused dependencies opportunistically in that patch.

`buildHistoricalBackfillStatus` and `getFlexConfig` are also unreferenced imported
bindings in the server, but their modules are used elsewhere. They are inventory
entries, not permission to remove entire require statements or module startup.

## Unmounted or legacy does not mean unused — preserve

| Path/group | Concrete consumers or remaining behavior | Decision |
| --- | --- | --- |
| `PortfolioBreakdown.jsx` literal `false &&` JSX (2356–2634) | The JSX itself is unreachable, but old column/search/sort state, memoized sorting, and a resize effect still run. `positions.legacySizing` shares active target/edit maps and calculators. | No broad branch/support-code deletion in this milestone. |
| `usePortfolioPositions.js` `legacySizing` | Parent still consumes it; direct hook tests use its exposed maps/calculators. Shared bindings also support active position inputs. | Keep until a dedicated legacy-support boundary is proven. |
| `PortfolioBreakdown.incrementor.test.js` / `.buySell.test.js` | Jest discovers them. They copy algorithms rather than importing the active component; the old increment tests assert 0.10 while active integration asserts 0.01. | Record test-quality debt, not unused production. Do not silently replace active semantics. |
| `legacyQuoteAdapter.js` | Composite quote provider and IBKR stream bridge call `toLegacyQuote`; quote-envelope tests use it. | Active compatibility and market-data safety code. Keep. |
| `legacyMarketDisplay.js` | USDProxies, VolatilityPanel, TickerTape, and its tests import it. | Keep. |
| `legacyHermesMode.cjs` | Server mutation/read-only gates, dev-stack CLI, readiness service, and tests import it. | Active operational safety policy. Keep. |

For a later portfolio cleanup, start with removing only the literal false JSX
under the existing active positions characterization tests. Then inventory each
remaining parent binding separately. Never remove the actual hook's shared maps,
live-NAV/evidence gates, call-time quote validation, research resources, or active
card behavior because the old JSX mentions the same names.

## Completion

This milestone is complete as an evidence inventory. No runtime behavior,
provider acceptance, compatibility exports, tests, CSS, assets, or legacy files
were removed. A future deletion requires its own checkpoint and review.
