# Maintaining the same dashboard safely

Start with the repository `AGENTS.md`. This map explains ownership after the
September 2026 refinement; it is not permission to redesign, change trading
rules, remove compatibility paths, or restart/deploy services.

## Where a change belongs

| Responsibility | Owner |
| --- | --- |
| Portfolio card sections and positions presentation | `src/components/Dashboard/portfolio/` |
| Portfolio research/current-history and market-context requests | `src/hooks/usePortfolioResearch.js`, `usePortfolioMarketContext.js` |
| Portfolio positions interactions and pure calculations | `portfolio/usePortfolioPositions.js`, `portfolioPositionsModel.js` |
| Dashboard resource lifecycles | `src/hooks/useDashboardPortfolio.js`, `useDashboardOverviewResources.js`, `useDashboardEtfProResource.js`, `useDashboardChangelog.js` |
| Saved workspace and resizing | `src/hooks/useDashboardWorkspaceState.js`, `useDashboardPanelResize.js`; `src/constants/dashboardWorkspace.js`; `src/utils/dashboardWorkspaceState.js` |
| Persistent panel presentation | `src/components/Dashboard/workspace/` |
| Reference-comparison projection and market-period merge | `src/utils/dashboardReferenceProjection.js`, `dashboardMarketPeriods.js` |
| Thin reference, volatility and correlation HTTP handlers | `src/routes/referenceHandlers.cjs`, `volatilityHandlers.cjs`, `correlationHandlers.cjs` |
| Currency endpoint without a verified provider | `src/routes/currencyPairsHandler.cjs` (503, empty unavailable response) |

`PortfolioBreakdown` and `PortfolioDashboard` remain orchestration/compatibility
owners. Keep lazy loaders and shared resource decisions in their established
owners.
Server provider construction, middleware, listeners, shutdown and WebSockets
remain in their current architecture. A shorter file is not itself a success;
a clear, independently testable responsibility is.

## A safe small change

1. Inspect callers, nearest working agreements, focused tests and the actual UI.
   Record the exact files you own; preserve all unrelated working-tree changes.
2. Preserve current tracked **and untracked** source. A Git revision alone may
   not contain the current product. Verify the source checkpoint and recovery
   patch. Never restore a whole old archive over later edits.
3. Add characterization tests before moving behavior. Keep a pure extraction
   separate from an intentional correction, with a failing regression for a fix.
4. Keep resource keys, account/instrument scope, timestamps, invalidation,
   cancellation, polling and session gates intact. Move cohesive owners, not
   arbitrary line ranges. Keep public exports until their consumers are migrated.
5. Run the narrow test, changed-file lint and production build. For UI work,
   compare real layout/navigation and retained state; use isolated fixtures for
   unavailable/provider-failure cases, never fabricated runtime market data.
6. At milestone gates, run the full suite. Record pre-existing failures separately
   and stop for an unexplained regression. Review only the owned diff and retain
   before/after evidence for targeted recovery.

The informational asset-performance overview may retain verified observations
with their original time and `D` marker. This exception does not permit retained
execution/sizing values. Quote availability and strategy status remain separate.

## Verification commands

```sh
npm test -- --runInBand --runTestsByPath path/to/focused.test.jsx
npx eslint path/to/changed.js path/to/changed.jsx
npm run build
node --test scripts/testing/verify.test.cjs
node --test scripts/testing/verificationReferences.test.cjs
node --test scripts/testing/architectureBoundaries.test.cjs
npm run test:node
npm test -- --runInBand --watchAll=false --silent
npm run lint
npm run verify:local
```

Choose real feature paths for the first two commands. `ops/verification.json`
defines the existing groups. The runner stops at the first failure, preserving
the exit status; a failed full local gate is not a green release. `release` also
installs dependencies and performs release-only checks; do not use it as a casual
substitute for local verification. Python environments and service lifecycle
remain governed by the main README and existing tooling.

The removed `verify:cpi-discovery` and `verify:workflow` aliases pointed to
nonexistent scripts. No replacement capability was invented. Reference tests
validate the current literal command grammar, not arbitrary shell semantics or
the installation of external tools.

## Architecture checks

`scripts/testing/architectureBoundaryPolicy.cjs` lists explicit module roles:
`pure`, `view`, `resource`, `handler`, or intentionally `mixed`.
The static checker rejects back-imports into orchestration parents, inappropriate
resource ownership, runtime fixture imports and cycles among listed modules.
It uses the existing Babel development dependency without executing runtime
modules. It is a focused regression guard, not a security sandbox, full dependency
graph, freshness validator or arbitrary computed-import resolver.

When moving/renaming an owner, update its exact policy path/role alongside its
behavior tests. Missing listed files fail. For a policy change, retain legitimate
fixtures and add a violating case. Do not add arbitrary line limits, formatting
assertions or broad exceptions just to make checks pass.

## Remaining work is explicit

See `CODEBASE_IMPROVEMENT.md` for verification results, recoverable milestones and
known issues, including the pre-existing infrastructure contract failure, bundle
size warning, holdings-overlap validation and accepted CPI reference aging.
See `CODEBASE_LEGACY_INVENTORY.md` before touching legacy code. Unmounted does not
mean unused; compatibility consumers and source-inspecting tests must be checked.

The refinement does not deploy or restart the API. Backend source changes take
effect at the next normal supervisor-managed restart. Do not represent isolated
handler tests as live-provider or production-release certification.
