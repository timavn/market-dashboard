# Codebase improvement: same product, safer internals

## Current status — September 11, 2026

The finite milestone checklist is complete. The September 11 continuation
finished 27 bounded slices with recoverable source deltas. The existing product
and workflow were preserved; source corrections are called out separately.
Final JavaScript verification passed: 4,414 Jest tests / 322 suites, 422 Node
tests, lint with zero errors and 140 existing warnings, and the production build.
IBKR/Analyst Python and generated-contract checks passed; the same pre-existing
infrastructure test still fails. This is not an all-green release certification.
Use [the maintenance map](CODEBASE_MAINTENANCE.md) for future edits and the final
section below for remaining issues and verification/recovery evidence.

## Working method

Improve one bounded area at a time. Preserve the existing layout, workflow,
calculations, data contracts, and trading safeguards. Separate structural moves
from intentional behavior changes. File length is a symptom, not a target: a
successful extraction gives one card a clear owner without scattering its logic
or creating a large pass-through prop interface.

For each milestone:

1. Inspect the current working tree, nearest working agreements, tests, and
   rendered surface. Record the exact files the milestone owns.
2. Preserve the current source, including relevant untracked work. Verify the
   checkpoint; never assume `HEAD` contains the user's current product.
3. Add missing characterization tests before moving code. Keep behavioral fixes
   separate so a failure can be traced to one change.
4. Move the smallest complete component boundary. Keep shared fetching/domain
   logic in services or hooks and card-specific display state with the card.
5. Run focused tests, changed-file lint, integration tests, and the production
   build. Inspect the actual running UI and compare against the baseline.
6. Review the milestone-only diff and record remaining issues. The September 11
   continuation request authorizes proceeding through the remaining list without
   a user pause after each verified slice. Stop for regressions, overlapping edits
   or decisions requiring new authority. Roll back only this milestone's changes.

Stop if unrelated edits overlap the target, an unexplained test regression
appears, data provenance changes, duplicate subscriptions/requests appear, or
visual/keyboard behavior changes unintentionally. Do not fix a failing baseline
by deleting safety tests or weakening production validation.

## Milestone sequence

| Milestone | Bounded objective | Status |
| --- | --- | --- |
| 1 | Source checkpoint, test baseline, current UI baseline, known-issue inventory | Complete; known infrastructure failure recorded |
| 2 | Extract the portfolio leveraged-products cell and centered details modal | Complete; tests/build and browser comparison passed |
| 3 | Extract portfolio research presentation one section at a time | Complete: 3a–3f current/history/decision/context sections and shared calculation dialog isolated; verification passed |
| 4 | Separate portfolio data/view-model hooks and remaining focused cards | Complete: 4a–4h and both characterized request-ownership corrections verified |
| 5 | Modularize the active prediction monitor card by card | Complete: 5a–5h and separate failed-refresh guard correction verified |
| 6 | Simplify shared domain boundaries and dashboard shell composition | Complete: 6a–6d resource, workspace, presentation and domain owners verified |
| 7 | Split server responsibilities; remove legacy paths only after proving disuse | Complete: thin handlers, isolated currency correction and evidence-based legacy inventory |
| 8 | Tighten maintenance tooling and regression checks based on earlier work | Complete: tested runner, command references, scoped architecture checks, maintenance guide and final audit |

Later milestones are direction, not approval for a broad rewrite. Reassess their
scope against the current tree when reached. Do not add dependencies, redesign
the app, or change financial mappings as part of a structural extraction.

## Remaining execution checklist — September 11 continuation

The user authorized completing the remaining list sequentially. Read-only audits
turned the broad milestones into the finite boundaries below. Completion means
these active responsibilities have tested owners, not that every large or legacy
file has disappeared. Preserve compatibility paths without adequate disuse proof.
Run focused tests, changed-file lint, build and rendered checks per production
slice; run the full Node/Jest/lint/build baseline at substantive milestone gates.

- [x] 4d: USD-correlation presentation, preserving upstream mapping/source gates.
- [x] 4e: Portfolio current/lazy-history request lifecycle and race ownership.
- [x] 4e-retry: Correct the characterized pending-history cancellation retry gap.
- [x] 4f: Portfolio market-context batching, priority requests and sizing expiry.
- [x] 4f-ownership: Prevent an obsolete batch from releasing a newer request's markers.
- [x] 4g: Cohesive research-card composition and pure research-row builders.
- [x] 4h: Active positions card, ledger model and interactions.
- [x] 5a: Active Gold correlation card.
- [x] 5b: MOMO Tracker card.
- [x] 5b-refresh: Reject explicitly failed MOMO spot refreshes (separate characterized guard correction).
- [x] 5c: Proxy-fit and Pyth tracking cards.
- [x] 5d: Factor/source sheets, including SPX and CPI-specific content.
- [x] 5e: Contract ladder and its quote/position/reference rows.
- [x] 5f: Active CPI forecast card and release comparison views.
- [x] 5g: Chart shell, series/annotations and view-model ownership.
- [x] 5h: Card-specific Gold/MOMO/CPI resource lifecycles.
- [x] 6a: Dashboard portfolio, overview and supporting resource-owner hooks.
- [x] 6b: Persistent workspace state and focused resize ownership.
- [x] 6c: Named persistent workspace shells/composition.
- [x] 6d: Shared reference projections and market-period merge domain modules.
- [x] 7a: Tested reference handlers: overlap, calendar and exchange volume.
- [x] 7b: Tested volatility and USD/Gold correlation handlers.
- [x] 7c: Separate fail-closed correction for fabricated currency-pair endpoint.
- [x] 7d: Legacy/disuse inventory; remove only proven-unused implementation.
- [x] 8a: Dependency-injected, directly tested verification runner.
- [x] 8b: Manifest/script validation and explicitly resolve broken aliases.
- [x] 8c: Scoped architecture checks and accurate maintenance documentation.
- [x] Final: Complete regression results, browser smoke checks, recovery manifests
      and an honest remaining-issues inventory.

The active prediction monitor is `PredictionMarketResolverTest`, retained in
eight dashboard market instances; GDP already delegates to its own card.
`PredictionMarkets`/`PredictionMarketsHub` are not mounted by the current shell
and are preserved during active-card work. `App.jsx` is already focused route
composition and is not an extraction target solely for line-count reduction.
Server lifecycle/WebSocket ownership and provider algorithms remain outside the
enumerated thin-handler moves; no deployments or live trading operations are
authorized by this structural improvement plan.

## Milestone 1 — September 10, 2026

### Source checkpoint

The starting branch was `codex/hermes-gmail-resilience`, at `593f055`.
There were 749 Git status entries: 320 modified, 20 deleted, and 409 untracked
entries (an untracked directory can contain multiple files).

Private local checkpoint:

`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260910T182438Z-milestone1-7M9721`

The checkpoint contains 1,398 selected source/config/documentation/asset files,
records 20 source deletions, and lists 227 exclusions. File hashes were checked
against both the copied source and a separately unpacked archive. The workspace
was stable during capture. `manifest.json` records the inventory and exclusions;
`checkpoint-verification.json` records the verification result.

Archive SHA-256:
`d1ae8e000faecd859eb35cf45b23f7b189f927b3834977f3427511d64c7ff9ba`

This is a source checkpoint, **not** a backup of account/runtime data, credentials,
installed dependencies, or generated output. Those remain untouched. Do not
restore the whole archive over a later working tree or use a blanket Git reset.
Recover a selected file into a separate folder, compare it with current work,
and apply only the intended milestone reversal. No commit or staging operation
was made for this milestone.

`milestone1-delta/` in the checkpoint contains this task's before/after files,
hash manifest, and a task-only `changes.patch`. Forward and reverse applicability
were checked without applying changes to the working repository. Recheck against
the current files before any future reversal; this is not authority to discard
later edits.

### Verification baseline

Node `22.23.0` and npm `10.9.8` match the declared project runtime. The existing
`npm run verify:local` runner stopped at its first failed stage. The remaining
local-manifest checks were then run independently, preserving every result.

| Check | Initial result |
| --- | --- |
| Node contracts | 351 passed |
| Dashboard Jest | 283 suites passed, 5 failed; 3,923 tests passed, 7 failed |
| Repository JavaScript lint | Passed |
| Production build | Passed; existing large-chunk warning |
| IBKR Python checks | 194 tests passed |
| Analyst Python checks | 161 tests passed; static checks passed |
| Generated Hermes contract | Passed |
| Infrastructure Python | 498 tests run: 496 passed, 1 failed, 1 skipped |

Seven obsolete UI test expectations were corrected in five test files:

- `ExceptionFirstRadar`, `MarketPulseRibbon`, `PredictionMarketResolverTest`, and
  `VolatilityTable`: six cases now require an immediate `D` for explicitly delayed
  or retained references, preserving value and original-observation-time checks.
  The shared marker and its own tests already require this behavior.
- `WtiWorkbench`: one case now expects rejected refresh-delayed OVX context to
  remain unavailable while the independently verified native contract ladder
  stays visible. This agrees with the existing OVX normalizer and its unit test.
  The main asset-performance table retention exception does not extend to WTI.

No production behavior was changed. The two portfolio integration suites already
passed (132 tests) and needed no correction. The five corrected suites passed
individually (271 tests). The complete post-correction Jest run passed all
**3,930 tests across 288 suites**, followed by passing repository lint and a
passing production build. Evidence is in the checkpoint's
`verification/post-correction-results.json` and corresponding logs. The unrelated
infrastructure failure below remains; this is not an all-green release gate.

`DASHBOARD_DATA_RETENTION.md` was aligned with the current working agreements:
retention/persistence are per-resource; the main asset-performance table retains
verified readings with original provenance; executable data still fails closed.

### Rendered baseline

The existing local UI, API, and IBKR sidecar were running. The stack scan reported
a degraded research bridge, recorded separately below; nothing was restarted.
Browser inspection used the existing application and real provider state, not
injected quotes, mocked network responses, or account/order actions.

- Main overview: existing compact reference strip and data-status presentation
  inspected. Delayed observations carry the shared `D` with their source time.
- Portfolio: expanded a security research row, opened the AMZD/AMZN direct-product
  popup and GDXD/GDX proxy popup, then closed them. At a 1,280 × 720 viewport,
  each popup was centered within one pixel and did not scroll. Negative leverage
  was red; the proxy ticker span was underlined, not the multiplier.
- Screenshots of these popups were captured in the implementation task. They
  record layout, not fixed financial values or verified catalog accuracy.
- Active Gold monitor: navigation, initial loading/unavailable presentation, and
  the subsequently populated chart, native ladder, and dated context inspected.
  Missing quote/depth cells stayed explicit. No orders or trading controls were
  exercised. A settled-state screenshot was also captured in the task.

This is a smoke baseline, not exhaustive browser coverage or a production release
certification. Automated tests cover additional unavailable, stale, seed/mock,
cache-only, and request-failure cases; no live provider was disconnected to test
those cases in the user's running session.

### Known issues kept separate

1. **Infrastructure contract mismatch:**
   `test_pdf_processor_has_completion_safe_runtime_and_least_privilege_access`
   fails because its exact expected environment omits the template's
   `ANALYST_CHANGE_JOURNAL_ENABLED` and `RESEARCH_EVENT_LEDGER_TABLE` entries.
   A later assertion in the same test also omits `ResearchEventLedgerV2.Arn` from
   the allowed resource set. The PDF runtime emits journal entries and its package
   includes the journal module. Review the intended journal permissions/behavior
   in a separate infrastructure change before aligning both assertions. No IAM,
   template, runtime, or infrastructure tests were changed here. The full local
   verification gate is **not green** while this remains.
2. **Research bridge degraded:** reported by the existing stack, not introduced
   here. No repair, restart, deployment, or cloud mutation was attempted.
3. **Build size:** existing entry chunk about 970 kB minified (278 kB gzip), with
   a >500 kB warning. Record it; do not change chunking during the first extraction.
4. **Tooling debt resolved in 8b:** the two aliases `verify:cpi-discovery` and
   `verify:workflow` pointed to absent files and were retired after checking
   consumers/history. Neither belonged to the verification manifest; no
   replacement capability or placeholder was invented. Reference tests added.
5. **Holdings-overlap validation hardening:** the current UI validator can coerce
   a null percentage to zero and lacks explicit percentage bounds. No malformed
   live response was established in this baseline. Add a distinct behavior-fix
   task with service/UI fixtures; do not silently alter validation while moving
   the popup.

### First extraction boundary: milestone 2

Current large-component sizes are 8,509 lines (`PredictionMarketResolverTest`),
7,275 (`PredictionMarkets`), 5,880 (`PortfolioBreakdown`), and 3,354
(`PortfolioDashboard`). These are a baseline, not line-count quotas.

Start in `PortfolioBreakdown` with the leveraged-products cell, fit-row sizing,
and centered details modal. Keep catalog relationships, issuer URLs, overlap
calculation/validation, quote policy, other research cells, and the portfolio
container's data flow unchanged. Inspect the existing modal host/lifecycle before
choosing the final component interface; no new modal framework is needed.

Before the move, extend characterization coverage for close/backdrop/Escape,
active-to-hidden transitions, request cancellation and rapid-selection races,
reopening, missing overlap references, actual issuer destinations, and resize
cleanup. Preserve current direct/proxy labels, proxy-only ticker underlining,
signed colors, product ordering, compact sizing, and omission of unavailable
overlap percentages. Any discovered behavior defect gets a separate correction.

Acceptance: focused tests and portfolio integration suites pass, no new full-suite
failures, lint/build pass, identical browser layout and dismissal behavior, no
duplicate fetching/listeners, and a small reviewable diff with a recovery path.
The milestone 1 baseline above was reviewed before milestone 2. The isolated
infrastructure follow-up remains separate from this UI extraction.

## Milestone 2 — September 10, 2026

### What moved

- `portfolio/LeveragedProductsCell.jsx` owns the compact catalog-driven cell and
  its resize/fit behavior (122 lines).
- `portfolio/LeveragedProductModal.jsx` owns the centered, text-first popup
  (117 lines). Its selection remains in `PortfolioBreakdown`, shared by all rows.
- `hooks/useLeveragedProductOverlap.js` owns the existing overlap request and
  validation. Request identity is still active state + base + reference, not the
  leveraged ticker. Same-reference product switches reuse the request; closing,
  hiding, and unmounting cancel it; hidden selection resumes on reactivation.
- The exact feature CSS moved into `portfolio/LeveragedProducts.css`, imported
  after the base stylesheet to preserve the cascade and five-pixel cell padding.
- The existing metric wrapper and two shared research-date helpers moved unchanged
  into `PortfolioMetricCell.jsx` and `utils/researchDateFormat.js`. The cell and
  parent share these small dependencies instead of duplicating markup or dates.

`PortfolioBreakdown.jsx` decreased from 5,880 to 5,552 lines. This is one complete
feature boundary, not a rewrite of the remaining portfolio code. Catalog entries,
issuer URLs, quote/sizing/order policy, overlap calculations and validation rules,
other card behavior, and server/provider code were not changed. The prior named
fit-helper export remains available for existing callers.

### Checks and evidence

Seven characterization tests were added before moving production code and passed
against the original implementation (86 tests in that portfolio suite). They
cover same-reference reuse, cancellation/races, hide/resume, reopen, close/backdrop
vs inside clicks, issuer destinations, missing references, and resize cleanup.
Sixteen standalone feature tests then passed against the extracted components,
including unavailable/cache/stale/mismatched overlap omission and failed fetches.
The two portfolio integration suites passed after extraction (139 tests).

The browser comparison found **identical DOM markup and dimensions** for both
the AMZN products cell and AMZD details modal before/after the move. Padding and
negative color were identical. GDXD still underlines only the proxy ticker, not
its multiplier; its popup remained centered within one pixel and did not scroll
at 1,280 × 720. No provider data was injected and no trading action was performed.
An independent source review found no behavioral changes in the moved fit,
validation, date, metric, or modal logic.

Checkpoint and verification evidence:

`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260910T201012Z-milestone2-QA5C3z`

The starting checkpoint has 1,399 source files, records 20 source deletions, and
lists 227 exclusions. Copy and archive recovery hashes were verified before edits.
Archive SHA-256:
`893e0d40376c39a9241a3e693e1c2f76df66cd09d91a2fae497838600a5c8ddf`

The same source-only recovery limitations described in milestone 1 apply.
`verification/results.json` and individual logs record the final checks;
`ui-comparison.json` records the browser measurements. Final results:

- Dashboard Jest: **3,953 tests passed across 289 suites** (23 added tests).
- Node contracts: **351 passed**.
- Repository lint: passed, zero errors; 140 existing warnings, unchanged from
  milestone 1. Extracted production files and standalone tests lint cleanly.
- Production build: passed, with the existing large-chunk warning.
- Milestone-only source diff and forward/reverse patch applicability: verified.

`milestone2-delta/` contains the 12 task-owned before/after files, hash manifest,
and `changes.patch`. No rollback was applied to the working repository. No files
outside this milestone's inventory changed relative to its source checkpoint.
As before, compare against future edits before using any recovery artifact.

Python infrastructure was not rerun for this UI-only move; do not interpret the
earlier infrastructure failure as repaired. No dependencies were added, nothing
was staged or committed, and the running stack was not restarted.

### Pre-existing issues observed during characterization

An existing position-sizing test uses the real session clock, so its simulated
61-second expiry can cross the 16:15 ET cutoff and change the expected session.
It passed before and after that boundary but failed during one diagnostic run.
Some existing portfolio tests also leave a temporary `useQuadResearch` Axios
handle until its timeout; the process subsequently exits. Neither behavior came
from the new tests (which exit cleanly) and neither was changed in this structural
milestone. The previous infrastructure mismatch, build warning, and overlap
validation hardening remain separately tracked.

Next: review this milestone before extracting another portfolio research section.
The first bounded section of milestone 3 is recorded below.

## Milestone 3a — current research products, September 10, 2026

### Scope and boundaries

`portfolio/PortfolioResearchProducts.jsx` now owns the current TIME / PRODUCT /
DETAIL table header, loading row, summaries, and expanded facts/source context.
It is a 151-line controlled presentation component, not a new dashboard area.
`PortfolioBreakdown.jsx` decreased from 5,552 to 5,401 lines.

The component returns a Fragment so the grids remain direct children of the
existing research panel. Expansion state remains in the portfolio, keyed by the
same position-row and product IDs, with a shared toggle callback. This preserves
independence between duplicate-symbol positions, sorting/filtering, and
collapse/reopen behavior. It also preserves the existing available-but-empty-fact
expanded state; this extraction does not silently change that edge case.

The unchanged `formatResearchTime` helper moved into `researchDateFormat.js`;
the unchanged `safeResearchUrl` helper moved into `researchSourceUrl.js` and is
shared with the parent's evidence selection. Synthetic midnight-UTC publication
times remain omitted; legitimate times still display in New York time. Existing
HTTP(S)/root-relative source URL rules are preserved.

Only current-product button, summary, unavailable-note, facts/context/source
styles and their two narrow-container overrides moved to
`portfolio/PortfolioResearchProducts.css`. Header, generic table, history, loading,
and column styles remain shared. This avoids overriding the equal-specificity
narrow-container header rule when the feature stylesheet loads later.

No research fetch, freshness/eligibility gate, canonical/legacy row builder,
WeakMap cache, history merge, signal calculation, quote/sizing rule, or provider
was changed. The previous five-market-days history section remains in the parent
for its own later extraction. Milestone 3 as a whole is not complete.

### Verification and recovery

Three characterization tests passed against the original implementation
(89 tests in that suite), covering paired title/detail toggles, independent
duplicate-position expansion through reorder/filter/reopen, and context removal
and recovery when the requested security universe changes. Post-extraction
portfolio/dashboard/leveraged-product suites passed (158 tests). An additional
29 isolated component tests pass, including explicit conflicts, unavailable
evidence, URL safety, fact slicing, controlled expansion, and DST/time formatting.
Independent review verified both moved helpers byte-for-byte, all 20 moved CSS
rules, all 413 retained rules, and unchanged request/history callbacks.

In the existing browser, all 12 AMZN header/current-row elements had identical
before/after DOM, column widths, heights, fonts, and padding. The pane was 394 px
wide; its header remained 18 px high with 9.5 px type. Current provider data for
that security rendered `UNAVAILABLE`/`N/A`; expanded evidence and source links
are tested with isolated fixtures, not fabricated in the running dashboard.

Private source checkpoint:

`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260910T203331Z-milestone3-VCI5tA`

It includes 1,407 source files, records 20 source deletions, and lists 227
exclusions. Both copy hashes and archive recovery were verified before edits.
Archive SHA-256:
`9937c0ae802a8cc2168c7b98bd063789e9c360e9a5547e201bcff72a5b2277f9`

The earlier source-only backup limitations apply. Browser evidence is in
`ui-comparison.json`; final checks are in `verification/results.json` and their
individual logs. Final results:

- Dashboard Jest: **3,985 tests passed across 290 suites** (32 added tests).
- Node contracts: **351 passed**.
- Repository lint: zero errors; the same 140 pre-existing warnings. Changed
  production files and the standalone component suite lint cleanly.
- Production build: passed with the existing large-chunk warning.
- Source inventory and task-only patch: verified. `milestone3a-delta/` contains
  the nine owned files' before/after versions, hash manifest, and `changes.patch`.
  Forward and reverse applicability were checked without modifying the working
  repository. No source outside this inventory changed relative to the checkpoint.

This completes slice 3a, not the entire research decomposition or a production
release certification. The earlier infrastructure failure was not rerun or
repaired in this UI-only change. No dependencies, data fixtures in runtime, stack
restarts, staged changes, or commits were introduced. Check current files against
later work before using any recovery artifact.

### Newly identified pre-existing refresh defect — recommended next correction

`mergeSecurityIntelligenceResponses` intentionally gives an already-painted
current payload precedence over slower historical data. That is correct for
history completion. The current-response completion path also passes
`current.data` first and the fresh response second, so old current fields win
there too. A read-only reproduction of the exact helper confirmed that a fresh
unavailable/missing product, empty facts, and bearish decision can return the
previous ready/indexed product, prior facts, and bullish decision instead.
The success handler clears the error and marks the request ready, so this is not
presented as loading/error reference retention.

`reproduce-research-merge.cjs` in the private checkpoint evaluates the original
pure helper against synthetic input and prints previous versus incoming fields.
It reads the preserved source only and does not contact or modify the running
application. This is diagnostic evidence, not a test asserting the bug is correct.

This affects same-universe polling/manual refresh of existing symbols; changing
the requested universe clears the previous payload. It predates this extraction
and was left unchanged. The characterization tests do not encode stale evidence
winning over a fresh response as desirable behavior.

Prioritize a **separate behavior correction before further research extraction**:
fresh current responses must replace current evidence, revocations and conflicts
must remain visible, historical data must stay historical, and a slower history
response must not overwrite a newer current response. Add deterministic tests for
those cases before changing the merge. Do not combine that correction with the
history component move. Previously recorded infrastructure, lint/build warnings,
test timing/handle issues, and overlap-validation debt remain separate.

## Milestone 3b — research refresh precedence, September 10, 2026

### Intentional behavior correction

This slice fixes the pre-existing defect identified in 3a, without extracting
another component or changing the layout. A successful current-only response
now replaces the previous current snapshot in full. Updated facts, source links,
decisions, ranges, coverage, provenance, conflicts and unavailable states win;
omitted fields, aliases and securities are not filled back in from older data.

`utils/securityIntelligenceResponses.js` owns the small, pure replacement and
history-combination contract outside presentation code. Only `history` and
`historicalReferences` may cross from a previous/history response, and only when
the normalized market date, schema and symbol-map shape match. Same-session
current-only responses may retain already-loaded history, since their empty
history arrays do not represent a history refresh. An actual history completion
replaces those historical fields, including empty or omitted ones.

History responses cannot change current decisions, `lastVerifiedDecision`,
products, coverage, timestamps or market date. Missing/null current symbols stay
missing/null. Wrapped and raw envelopes, legacy `securities`, and V2 `bySymbol`
retain the current response's format and metadata.

The current response alone sets the research date, including nested dates in
wrapped responses. Loaded history is scoped to date/schema/map as well as the
requested symbols, so a new-session poll requests a new history window. A
mismatched history response is reported unavailable without changing current
evidence. History cannot start against a previous ready render while a new
current request is in flight. Existing abort and request-sequence guards remain.

Existing dated, reference-only research retention during loading/request errors
is unchanged; it does not authorize executable quotes or restore evidence after
a successful response removes it. Quote freshness, sizing, order controls,
provider services, research row builders and all styling remain unchanged.

### Verification and recovery

Private source checkpoint:

`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260910T210218Z-milestone3b-TV5dzP`

It contains 1,411 selected source files, records 20 source deletions, and lists
227 exclusions. Copy hashes and unpacked archive hashes were verified before
edits; the source was stable at capture. Archive SHA-256:
`3a72acac9318cc048dc6e62b53ca200c2a17c0c0d0d19d884e5df73210bb56cd`

The source-only recovery limitations above still apply. This task owns five
files: `PortfolioBreakdown.jsx`, its security-intelligence integration test,
the new response utility and its unit test, and this report.

The actual dashboard was inspected before and after the change. An AMZN manual
refresh retained the existing compact presentation; unavailable current research
remained unavailable and ten historical product rows stayed under the previous
five-market-days disclosure with their original dates. No provider fixtures were
injected into the app, no orders were entered, and the stack was not restarted.
Changing-current/race scenarios are covered by isolated automated tests, not
claimed as observed live-provider transitions. `ui-verification.json` records
the browser check and its limits.

The response utility passes 38 isolated contract tests. Eleven new deterministic
portfolio integration tests cover fresh replacements/revocations, omitted fields
and symbols, source links, ranges, late current/history requests, nested dates,
same-session history retention, history failures, and polling across market days.
Running those final regressions against the checkpoint's original production
component (via an isolated Jest transformer, not a runtime/source rollback)
produced ten failures and one existing cancellation-guard pass. All eleven pass
against the fix. This also caught the batched loading-to-ready rollover case:
history now rechecks when the accepted response changes, not only on a status
transition. Independent review found no blocking issues in the final changes.

An existing request-error test expected an unnecessary early history request.
Its count now requires the correct `[current, history, current]` sequence; all
reference-only, disabled-control and provenance assertions remain. The final
targeted run passes 12 tests (eleven new plus this corrected expectation); four
neighbor/utility suites passed another 136 tests. The full portfolio integration
suite passes all 100 cases in the final broader run.

Final repository-wide results (`verification/results.json` and individual logs):

- Dashboard Jest: **4,034 passed across 291 suites** (49 tests added this slice).
- Node contracts: **351 passed**.
- Repository lint: **zero errors; 140 existing warnings**, unchanged from 3a.
  Changed production files and the new utility tests lint cleanly.
- Production build: passed with the existing large-chunk warning.
- Source inventory: exactly the five task-owned files changed; no other source
  drift relative to this slice's checkpoint.
- Task-only recovery: `milestone3b-delta/` contains before/after files, hash
  manifest and `changes.patch`; forward/reverse applicability is verified
  without reversing anything in the working tree. Check against later work
  before applying any recovery artifact.

`integration-original-final-regressions.json` records the original-code red
run; `integration-green.json` records the final targeted green run. The earlier
aggregate failure caused solely by the obsolete request-count assertion is
preserved as `portfolio-integration-before-request-count-update.json`.
Python/infrastructure checks were not rerun for this client-side correction;
the known infrastructure failure is not claimed repaired. No dependencies,
staging, commits, provider changes or runtime data injection were introduced.

Next: extract the historical research presentation as its own bounded structural
slice, preserving this tested current/history boundary. The rest of milestone 3
and later milestones remain unstarted; this is not a broad rewrite or release
certification. Previously recorded infrastructure failures, warnings and other
unrelated debt remain separate.

## Milestone 3c — historical research presentation, September 10, 2026

### Structural scope

The previous-five-market-days disclosure now lives in the 53-line
`portfolio/PortfolioResearchHistory.jsx`, with its three history-specific CSS
rules in `PortfolioResearchHistory.css`. It returns the same native `<details>`
element directly, not a wrapper or new dashboard card. The component accepts
position-row ID, prepared display rows, history-day count, loading and error;
it owns no fetching, timers, market data or trading controls.

`PortfolioBreakdown.jsx` decreased from 5,409 to 5,366 lines. Its old history-only
renderer became a pure display-row projection using the same date, direction
and note formatting. Shared reference-row/cell styles, loading animation and
responsive columns remain in the parent stylesheet. The now-unused parent
`formatResearchTime` import was removed; the shared formatter was not changed.

Historical filtering, verification, product grouping/order, raw cached rows,
cache keys, request callbacks and the 3b refresh protections are unchanged.
Display formatting runs after cache retrieval, just as it previously ran while
rendering. The initial development extraction formatted inside the cache; the
browser check exposed incompatibility with pre-existing hot-reload cache entries.
That intermediate change was removed before completion. The final cache format
is identical to the starting implementation and no runtime cache was cleared.

Branch order remains loading, then nonempty dated rows (including retained
history after a history error), then the existing generic error/empty message.
Native disclosure state persists through updates and stable position reorder;
collapsing/remounting a position panel resets its history disclosure closed.
Duplicate positions retain independent disclosures. Text stays noninteractive;
no links, product controls, raw errors or executable values were introduced.

### Verification and recovery

Three characterization tests passed against the original production component
before the move, then passed after extraction. They cover disclosure identity
through loading/error/recovery, independent duplicate-position state through
reorder/remount, and dated text-only rows with unchanged columns and tooltips.
Thirteen isolated feature tests cover the same native-state contract, row keys,
display priorities, empty states and escaped text. The portfolio integration,
current-product and response-contract suites passed 170 tests after extraction;
the new feature suite separately passed all 13 tests. The existing temporary
portfolio test handle/Testing Library deprecation warnings are not new failures.

The actual AMZN history disclosure and ten rows had **identical HTML and all
twelve measured elements' dimensions/styles** before and after extraction.
At the inspected 394 px pane width, the summary stayed 197 × 18 px, row height
21.59375 px, and date/product/detail columns and font sizes were unchanged.
A real manual refresh preserved the open disclosure. No provider fixtures,
orders, stack restarts or runtime cache manipulation were used.

Independent review checked the exact three moved CSS rules and all retained
rules, markup/classes/keys, display formatting and the unchanged fetch/filter/
validation/cache paths. No blocking findings remained.

Private source checkpoint:

`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260910T220233Z-milestone3c-Wp6WdV`

The checkpoint includes 1,413 selected source files, records 20 source deletions,
and lists 227 exclusions. Copy and unpacked archive hashes were verified before
edits with a stable source tree. Archive SHA-256:
`8f067a845a088497a53a29c7464359d210b78ab74b6517d65f79dbc483bd8f61`

The source-only recovery limitations above still apply. This slice owns seven
files: the parent component/style, integration test, new history component/style/
test and this report. Final results are recorded in `verification/results.json`
and its individual logs; `ui-comparison.json` records the browser comparison.

- Dashboard Jest: **4,050 passed across 292 suites** (16 tests added).
- Node contracts: **351 passed**.
- Repository lint: **zero errors; 140 existing warnings**, unchanged from 3b.
  Changed production files and isolated history tests lint cleanly.
- Production build: passed with the existing large-chunk warning.
- Source inventory: only the seven owned files changed relative to this
  checkpoint; no unrelated source drift.
- Task-only recovery: `milestone3c-delta/` contains before/after files, a hash
  manifest and `changes.patch`. Forward/reverse applicability was verified
  without reversing anything in the working tree. Recheck against later edits
  before any future recovery.

Python/infrastructure checks were not rerun for this presentation-only move;
the known infrastructure failure remains separate. No dependencies, provider
changes, runtime data, commits or staged changes were introduced.

Next: inspect and isolate the portfolio research decision-metrics presentation,
keeping the calculations and current/history authority boundaries intact.
Milestone 3 is not complete as a whole; later architecture/server milestones
remain unstarted. Existing infrastructure failures and unrelated warnings/debt
remain separately tracked, not silently repaired by this extraction.

## Milestone 3d — decision-metrics presentation, September 10, 2026

### Structural scope

`portfolio/PortfolioDecisionMetrics.jsx` now owns the four primary/supplemental
decision header/value grids. It is a 98-line stateless presentation component,
returning a Fragment with no new DOM wrapper. Ten named prepared metric props,
display-only quad groups/order text, and three explicit explanation/product
callbacks replace the inline presentation. Decision-only header-button and
quad-order styles moved verbatim into `PortfolioDecisionMetrics.css`; shared
grid/cell styles remain shared.

`PortfolioBreakdown.jsx` decreased from 5,366 to 5,289 lines. Source validation,
value formatting, contribution signs, reference-only treatment, provenance,
coverage, modal payload assembly, and financial calculations remain in the
parent unchanged. The separate initial-research and range-refresh loading
conditions are preserved. Beta/Quad headers remain clickable independently of
quote availability; their values remain noninteractive. The existing leveraged
products cell is reused without changing its catalog, selection, or resizing.
Market-context presentation, research caches, refresh precedence, provider
services, polling, and execution safeguards are untouched.

### Verification and recovery

Two new integration characterizations passed against the original inline
implementation before extraction. They protect duplicate-position Beta header
dispatch after reorder and reopening an explanation after its benchmark,
calculation, date, value and tone change. The extracted integration suite then
passed all 105 tests; three neighboring portfolio feature suites passed 58
tests. Fourteen new isolated component tests passed for grid order/spans,
provenance, semantic/reference styling, quad ties/fallbacks, empty/loading/zero
values, unavailable projection replacement, escaped text, callback freshness,
real leveraged-product selection, and input immutability. These presentation
tests do not claim to validate raw provider flags; those guards remain covered
by the existing integration and domain suites.

The running AMZN card's six metric grids had identical HTML, dimensions, and
computed styles before and after extraction at the inspected 394 px pane width.
Beta and Quad dialog text also matched exactly. The AMZD product popup opened
centered, showed the negative multiplier in red, required no scrolling, and
closed correctly. Position collapse/reopen worked; the inspected card was
returned to its collapsed state. No runtime fixtures, orders, provider changes,
cache clearing, or stack restarts were used. Independent checkpoint-diff review
found no actionable issues.

Private source checkpoint:

`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260910T221643Z-milestone3d-GKjX76`

The checkpoint includes 1,416 selected source files, records 20 source deletions,
and lists 227 exclusions. Copy and unpacked archive hashes were verified before
edits with a stable source tree. Archive SHA-256:
`157567ed4ffbb8cfcd046903dafb5b0530cf5f57429f1a4023f3070d6fc20d39`

The source-only recovery limitations above still apply. This slice owns seven
files: parent component/style, integration test, new decision component/style/
test, and this report. Browser evidence is in `ui-comparison.json`; final
regression evidence is stored in `verification/results.json` and its logs.

- Dashboard Jest: **4,066 passed across 293 suites** (16 tests added).
- Node contracts: **351 passed**.
- Repository lint: **zero errors; 140 existing warnings**, unchanged from 3c.
  Changed production files and isolated decision tests lint cleanly; the
  integration file retains its existing commented-tests warning.
- Production build: passed with the existing large-chunk warning.
- Source inventory: only the seven owned files changed relative to this
  checkpoint; no unrelated source drift.
- Task-only recovery: `milestone3d-delta/` contains before/after files, a hash
  manifest and `changes.patch`. Forward/reverse applicability was verified
  without reversing anything in the working tree. Recheck against later edits
  before any future recovery.

Python/infrastructure checks were not rerun for this presentation-only move;
the known infrastructure failure remains separate. No dependencies, provider
changes, runtime data, commits or staged changes were introduced.

Next: inspect and isolate the market-context row (price Z-score, sizing
volatility, relevant volatility index, USD correlation, and stop-loss reference).
Keep its data validation, calculations, and explanation payloads unchanged.
Milestone 3 is not complete as a whole; later architecture/server milestones
remain unstarted.

## Milestone 3e — market-context presentation, September 10, 2026

### Structural scope

The five-column market-context header/value section now lives in the 53-line
`portfolio/PortfolioMarketContext.jsx`. Its four exclusive sizing-volatility
and warning-badge rules moved byte-for-byte into `PortfolioMarketContext.css`.
It returns the same two grids without a new wrapper and reuses the shared
metric cell and delayed-data marker. Parent-owned prepared values, marker
metadata, sizing display, and explanation callbacks define its boundary.

`PortfolioBreakdown.jsx` decreased from 5,289 to 5,272 lines. The small line-count
change is intentional: calculations and validation remain in place while the
presentation gains a clear owner. The now-unused metric-cell wrapper/import
and delayed-marker import were removed. Source fetching, historical-risk
validation, sizing freshness rules, IBKR stop eligibility/sign/color, USD
mapping/zero handling, volatility admission, and modal payloads are unchanged.
Unavailable sizing volatility remains noninteractive; an unavailable stop can
still explain its missing inputs without creating an order. Historical risk
references are not promoted into executable quotes. Existing calculation-dialog
snapshot behavior was not changed during this extraction.

### Verification and recovery

Three new integration cases passed against the original inline implementation
before extraction. They cover Spike-over-Limited badge priority and warning
details, removal of sizing controls after failure, per-position long/short stop
payloads after reordered/updated holdings, retained/historical marker provenance,
and neutral zero USD correlation. Fourteen isolated component tests passed for
layout, prepared states, callbacks, badges, marker date/visibility/portal
lifecycles, duplicate-row isolation, escaped text, and immutable inputs.

One initial combined test run exposed a timing assumption in an existing history
test: current research can render before a separate effect commits history's
loading state. The assertion now awaits the active request and loading element
before checking that it remains hidden. All original assertions are preserved;
no production history code changed. The six affected portfolio suites then
passed all 194 tests. The existing temporary Axios handle and Testing Library
deprecation warnings remain separately tracked.

Browser verification compared AMZN and TLT. All twelve grids matched in HTML,
dimensions, and computed styling for the same verified observations. An initial
comparison encountered temporarily unavailable position-dependent values; a
normal subsequent provider update restored them without intervention. Long and
short stop dialog text matched exactly, and MOVE's D popup retained its original
observation timestamp. The running sizing-volatility source was unavailable;
available sizing/badge interactions were checked with isolated test fixtures,
not injected into the dashboard. Card collapse/reopen worked, and both inspected
cards were returned collapsed. Independent source/style review found no
actionable issues. No stack restarts, orders, provider changes, or cache clearing
were used.

Private source checkpoint:

`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260911T012617Z-milestone3e-ieziDI`

The checkpoint includes 1,419 selected source files, records 20 source deletions,
and lists 227 exclusions. Copy and unpacked archive hashes were verified before
edits with a stable source tree. Archive SHA-256:
`f2a876fb37245327a33f6d50549b546ce5563de52f880ba5977c8e65d04b89e5`

This slice owns seven files: parent component/style, integration test, new
market-context component/style/test, and this report. Source-only recovery
limitations above still apply. Browser evidence is in `ui-comparison.json`;
regression results are in `verification/results.json` and its logs.

- Dashboard Jest: **4,083 passed across 294 suites** (17 tests added).
  The full run began before the synchronization-only test edit; all six affected
  suites were also rerun successfully after it. Details are recorded in
  `verification/focused-regression.json`.
- Node contracts: **351 passed**.
- Repository lint: **zero errors; 140 existing warnings**, unchanged from 3d.
  Changed production and isolated feature tests lint cleanly; the integration
  file retains one existing commented-tests warning.
- Production build: passed with the existing large-chunk warning.
- Source inventory: only the seven owned files changed relative to this
  checkpoint; no unrelated source drift.
- Task-only recovery: `milestone3e-delta/` contains before/after files, a hash
  manifest and `changes.patch`. Forward/reverse applicability was verified
  without reversing anything in the working tree. Recheck against later edits
  before any future recovery.

Python/infrastructure checks were not rerun for this presentation-only move;
the known infrastructure failure remains separate. No dependencies, provider
changes, runtime data, commits or staged changes were introduced.

Next: isolate the shared portfolio calculation/explanation dialog, preserving
its centered layout, close behavior, and the distinction between dynamically
revalidated position-size explanations and snapshot reference explanations.
All four inline research sections now have separate presentation owners; the
shared dialog remains before completing milestone 3. Later data/view-model,
prediction-market, and server milestones remain unstarted.

## Milestone 3f — September 10, 2026 (local)

Extracted the shared calculation/explanation popup into
`portfolio/PortfolioMetricVerificationModal.jsx` with its own stylesheet. The
component owns the body portal, existing markup, Escape listener, and close
interactions. Selection state remains in `PortfolioBreakdown`, whose stable
close callback clears it. Both existing explanation leaf components and their
financial text are unchanged. The parent is now 5,215 lines, down from 5,272.

The parent still revalidates position-size inputs on every active render while
that explanation is selected. Refresh failure and local freshness expiry must
continue removing the displayed band from an already-open popup. Beta, stop,
sizing-volatility and Quad explanations retain their click-time snapshots.
No fetching, subscriptions, validation, calculations, mappings, order controls,
or focus-management redesign were introduced.

Three new integration characterization tests passed against the original inline
popup before extraction, then against the extracted component. They cover
snapshot retention through an upstream refresh, hidden-surface Escape and
reactivation, body-portal ownership, autofocus, inside versus backdrop dismissal,
and unchanged provider request counts. Fourteen isolated tests cover the three
content branches using the real explanation leaves, reference invalidation,
prepared text escaping, close callbacks, and listener cleanup. All seven affected
portfolio suites passed **211 tests** after extraction.

Browser verification compared AMZN's generic Beta, Quad ranking and position-size
popups. All three matched in HTML, text, dimensions, and computed styling, with
close-button autofocus preserved. Both the small generic and existing scrollable
position-size layouts were visually inspected. Hot reload reset the expanded
research row; it was reopened normally for comparison, then returned collapsed.
Independent source/style review found no actionable issues. No runtime fixtures,
orders, provider changes, stack restarts or cache clearing were used.

Private source checkpoint:

`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260911T035719Z-milestone3f-8sv4q3`

The checkpoint includes 1,422 selected source files, records 20 source deletions,
and lists 227 exclusions. Copy and unpacked archive hashes were verified before
edits with a stable source tree. Archive SHA-256:
`207dc8201215f7736b004ea44cd89202a9590b07009d966d2ac2c4af99362340`

This slice owns seven files: parent component/style, integration test, new modal
component/style/test, and this report. Source-only recovery limitations above
still apply. Browser evidence is in `ui-comparison.json`; full regression results
are recorded in `verification/results.json` and its logs.

- Dashboard Jest: **4,100 passed across 295 suites** (17 tests added).
- Node contracts: **351 passed**.
- Repository lint: **zero errors; 140 existing warnings**, unchanged from 3e.
  Changed production and isolated feature tests lint cleanly; the integration
  file retains one existing commented-tests warning.
- Production build: passed with the existing large-chunk warning.
- Source inventory: only the seven owned files changed relative to this
  checkpoint; no unrelated source drift.
- Task-only recovery: `milestone3f-delta/` contains before/after files, a hash
  manifest and `changes.patch`. Forward/reverse applicability was verified
  without reversing anything in the working tree. Recheck against later edits
  before any future recovery.

The focused integration run emitted the existing temporary async-handle warning
and then exited successfully without forced termination. The earlier standalone
characterization runs also retain the existing Testing Library deprecation
warning. Python/infrastructure checks were not rerun for this presentation-only
move; the known infrastructure failure remains separate. No dependencies,
runtime data, commits or staged changes were introduced.

Milestone 3 is complete for the agreed research-presentation scope. This does not
mean the entire portfolio component is modularized; its data, calculations,
remaining focused cards and orchestration still belong to later bounded slices.

Next candidate for milestone 4: extract only the existing `sizingVolatilityModel`
formatter into a pure `buildSizingVolatilityPresentation` helper. Keep its
validation, freshness clock, fetching, and click-state wiring in the parent.
Characterize unavailable references with leftover values, loading text, numeric
rounding, warning/badge precedence, annualization and snapshot behavior before
moving it. This is a proposed next slice, not an implemented hook/data rewrite.

## Milestone 4a — September 11, 2026

Extracted sizing-volatility display preparation into
`portfolio/sizingVolatilityPresentation.js`. Its two pure helpers separately
prepare the cell and its explanation. The parent still builds explanation text
only on click, preserving the original warning-processing timing and selected
snapshot. No React state, callbacks, provider requests or clock reads live in the
formatter. `PortfolioBreakdown` is now 5,178 lines, down from 5,215.

The parent still owns source/freshness validation, the completed-session policy,
volatility calculations, date formatting and click-state wiring. It passes the
existing partial-batch-aware loading flag. Formatting uses measured volatility,
not the separate minimum sizing denominator, with strict numeric handling,
one-decimal cells, two-decimal explanations, and the same warning/badge priority.
An unavailable reference produces no numeric value, badge, or explanation control even
if leftover numeric fields are present. Historical references remain explicitly
non-executable; the live-trading-data guard required keeping acceptance decisions
upstream rather than interpreting raw provider data in this formatter.

One new integration characterization test passed against the inline formatter
before extraction and against the extracted version. It refreshes the value,
date, observation count and warnings, verifies the open explanation stays an
exact snapshot, and checks the new payload appears when reopened without extra
provider requests. Seventeen isolated formatter tests cover precise projection
shapes, missing/loading inputs, warning order/priority, measured volatility below
the floor, annualization, immutability, fresh output objects and lazy warning
access. A temporary source-parity harness compared the original IIFE with both
helpers across **480 isolated input combinations**, with identical cell and
click-payload results. No test fixtures entered runtime paths.

All five affected portfolio/volatility suites passed **196 tests**. Browser
comparison of AMZN (42.3%) and TLT (9.8%) matched cell and dialog HTML, text,
dimensions and computed styling for the same provider observations. The TLT
example also confirms the cell continues showing measured volatility below 10%,
not the sizing-policy floor. Close-button autofocus and dismissal worked; both
inspected rows were returned collapsed. Independent review found no actionable
issues. No styles, controls, financial text, providers or stack processes changed.

Private source checkpoint:

`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260911T154921Z-milestone4a-KN2Sv4`

The checkpoint includes 1,425 selected source files, records 20 source deletions,
and lists 227 exclusions. Copy and unpacked archive hashes were verified before
edits with a stable source tree. Archive SHA-256:
`da548eb44579a42db3411d98ee587d70c1253bff625f24b20c3402d12fecfee9`

This slice owns five files: parent component, integration test, new formatter and
test, and this report. Source-only recovery limitations above still apply.
Browser evidence is in `ui-comparison.json`; formatter parity and full regression
results are in `verification/formatter-parity.json`, `verification/results.json`
and the verification logs.

- Dashboard Jest: **4,118 passed across 296 suites** (18 tests added).
- Node contracts: **351 passed**.
- Repository lint: **zero errors; 140 existing warnings**, unchanged from 3f.
  Changed production and isolated formatter tests lint cleanly; the integration
  file retains one existing commented-tests warning.
- Production build: passed with the existing large-chunk warning.
- Source inventory: only the five owned files changed relative to this
  checkpoint; no unrelated source drift.
- Task-only recovery: `milestone4a-delta/` contains before/after files, a hash
  manifest and `changes.patch`. Forward/reverse applicability was verified
  without reversing anything in the working tree. Recheck against later edits
  before any future recovery.

The focused integration run emitted the existing temporary async-handle warning
and then exited successfully without forced termination; its standalone baseline
also retains the existing Testing Library deprecation warning. Python and
infrastructure checks were not rerun for this formatter-only extraction; the
known infrastructure failure remains separate. No dependencies, runtime data,
provider changes, commits or staged changes were introduced.

Milestone 4a is complete. The remainder of milestone 4 is not yet implemented.

Next candidate for milestone 4b: the existing Beta explanation payload only.
Keep source acceptance, covariance/variance parsing, locale/date formatting,
cell colors and click state in the parent. Characterize positive, negative and
near-zero values, missing and zero equation operands, defaults, unavailable
output and immutable inputs; retain the existing refresh/selection integration
tests. No broader data/hooks or stop-calculation rewrite is included.

## Milestone 4b — September 11, 2026

Extracted the Beta explanation payload into `portfolio/betaPresentation.js`.
The pure helper receives the accepted Beta reference and prepared equation/date
labels, then returns the existing explanation text. It has no provider calls,
React state, callbacks, clock reads, or Beta calculation. The parent retains
source acceptance, finite-operand parsing, locale/date formatting, cell tone,
selection and render-time payload construction. `PortfolioBreakdown` is now
5,160 lines, down from 5,178.

The live-trading-data guard guided the boundary: the formatter does not decide
whether raw data is usable. Historical Beta acceptance remains separate from
position-size availability, and no execution or sizing gates changed. Existing
numeric-string handling, strict near-zero threshold, default benchmark/counts,
missing-operand fallback and zero-operand display are preserved. No Beta is
recalculated from rounded display operands.

The existing five decision-metrics characterization tests passed before and
after extraction, unchanged. They already cover duplicate-position selection,
unavailable Beta, valid Beta alongside unavailable sizing, refreshed data/tone,
open-popup snapshots, lifecycle and provider request counts. Twenty new isolated
tests cover exact positive/negative payloads, near-zero boundaries, missing/zero
operands, defaults, supplied labels, unavailable output and immutable plain-data
results. A temporary harness compared the original inline payload and extracted
helper across **830 isolated cases** using U.S. and German number labels; every
payload matched. All five affected portfolio/volatility suites passed **199
tests**.

Browser verification compared AMZN (1.41) and FXC (0.05) using unchanged provider
observations. Cell and dialog HTML, text, dimensions and computed styling matched;
close-button autofocus and dismissal remained intact. Before/after AMZN popup
screenshots were visually inspected, and both rows were returned collapsed.
Unavailable and numeric-edge branches were tested with isolated fixtures only.
Independent review found no actionable issues. No styles, financial wording,
provider behavior, orders, stack restarts or cache clearing changed.

Private source checkpoint:

`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260911T160544Z-milestone4b-pNmRTe`

The checkpoint includes 1,427 selected source files, records 20 source deletions,
and lists 227 exclusions. Copy and unpacked archive hashes were verified before
edits with a stable source tree. Archive SHA-256:
`4280ae8fceb7667a9330ab99502d290fad24782a49d045d597037a3161891506`

This slice owns four files: parent component, new formatter/test and this report.
The existing integration tests, validators and styles remain unchanged.
Source-only recovery limitations above still apply. Browser evidence is in
`ui-comparison.json`; parity and regression results are in
`verification/formatter-parity.json`, `verification/results.json` and their logs.

- Dashboard Jest: **4,138 passed across 297 suites** (20 tests added).
- Node contracts: **351 passed**.
- Repository lint: **zero errors; 140 existing warnings**, unchanged from 4a.
  All three changed production/test files lint cleanly.
- Production build: passed with the existing large-chunk warning.
- Source inventory: only the four owned files changed relative to this
  checkpoint; no unrelated source drift.
- Task-only recovery: `milestone4b-delta/` contains before/after files, a hash
  manifest and `changes.patch`. Forward/reverse applicability was verified
  without reversing anything in the working tree. Recheck against later edits
  before any future recovery.

The focused integration run emitted the existing temporary async-handle warning
and then exited successfully without forced termination. The standalone baseline
also retains existing React testing deprecation/asynchronous-history warnings.
Python and infrastructure checks were not rerun for this explanation-only
extraction; the known infrastructure failure remains separate. No dependencies,
runtime data, provider changes, commits or staged changes were introduced.

Milestone 4b is complete; the remaining milestone 4 work is still unimplemented.

Next candidate for milestone 4c: the stop-loss explanation and cell projection,
fed an already-calculated reference with formatted labels/date and tone. Keep
IBKR acceptance, stop arithmetic, mark selection and callback state in the
parent. Characterize unavailable-but-clickable explanations, long/short formula
direction, zero/negative references, missing-ATR versus missing-basis metadata,
and open-popup snapshots through refresh before moving that boundary.

## Milestone 4c — September 11, 2026

Extracted the stop-loss cell and explanation text into
`portfolio/stopLossPresentation.js`. The pure helper receives an already-calculated
reference, prepared currency/date labels, direction and semantic tone. It returns
plain display data without React state, callbacks, provider calls, clock reads,
or stop arithmetic. `PortfolioBreakdown` is now 5,146 lines, down from 5,160.

The parent still owns IBKR acceptance, historical ATR validation, average-cost
and quantity eligibility, stop calculation, mark selection, risk-distance color,
and click-state wiring. The live-trading-data guard guided this boundary: usable
source data is accepted upstream, and the result remains a non-executable
reference. No order, sizing or execution control changed. Zero and negative
calculated references are preserved rather than mistaken for missing data;
unavailable references retain their explanation button and independent long/short
formula direction.

Two new integration characterization tests passed before and after extraction.
They cover basis and ATR refreshes, exact click-time popup snapshots until reopened,
unavailable short references, missing-basis versus missing-ATR metadata, and no
extra provider requests from opening explanations. Seventeen new isolated tests
cover complete payloads, rounding, zero/negative references, verbatim labels,
passed-through tone, immutable inputs, fresh plain-data outputs and the absence
of recalculation or new acceptance rules. A temporary parity harness compared
the original inline blocks against the helper across **168 isolated cases**,
including U.S. and German currency labels; all projections matched. All five
affected portfolio/volatility suites passed **198 tests**. No fixtures entered
runtime data paths.

Browser comparison checked AMZN long and TLT short stop references against the
same broker/ATR observations. Cell and dialog HTML, text, geometry and computed
styling matched exactly. The centered popup retained close-button autofocus and
dismissal; before/after AMZN screenshots were visually inspected. Both rows were
returned collapsed. Independent review found no actionable issues. No styles,
financial wording, provider behavior, orders, stack restarts or cache clearing
changed.

Private source checkpoint:

`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260911T171139Z-milestone4c-dOcR7g`

The checkpoint includes 1,429 selected source files, records 20 source deletions,
and lists 227 exclusions. Copy and unpacked archive hashes were verified before
edits with a stable source tree. Archive SHA-256:
`22455efb648f5df0291e84519ed073d9e03c89dfbe5a10629221a05387097a36`

This slice owns five files: parent component, integration test, new formatter/test
and this report. Source-only recovery limitations above still apply. Browser
evidence is in `ui-comparison.json`; parity and regression evidence is in
`verification/formatter-parity.json`, `verification/focused-regression.json`,
`verification/results.json` and the verification logs.

- Dashboard Jest: **4,157 passed across 298 suites** (19 tests added).
- Node contracts: **351 passed**.
- Repository lint: **zero errors; 140 existing warnings**, unchanged from 4b.
  Changed production and isolated formatter tests lint cleanly; the integration
  file retains one existing commented-tests warning.
- Production build: passed with the existing large-chunk warning.
- Source inventory: only the five owned files changed relative to this
  checkpoint; no unrelated source drift.
- Task-only recovery: `milestone4c-delta/` contains before/after files, a hash
  manifest and `changes.patch`. Forward/reverse applicability was verified
  without reversing anything in the working tree. Recheck against later edits
  before any future recovery.

The standalone characterization baseline retains the existing React Testing
Library deprecation warning. Python and infrastructure checks were not rerun for
this presentation-only extraction; the known infrastructure failure remains
separate. No dependencies, runtime data, provider changes, commits or staged
changes were introduced.

Milestone 4c is complete; the remaining milestone 4 work is still unimplemented.

Next candidate for milestone 4d: extract only the USD-correlation value, metadata
and tone projection. Keep the proxy catalog, source-status acceptance, 30D/1M
selection, finite-number parsing and date formatting in the parent. Characterize
unmapped versus loading/unavailable output, signed and zero values, mapping/value
precedence over loading, and exact date metadata. This is a proposed next slice,
not an implemented change or broader data/hooks rewrite.

## Milestone 4d — September 11, 2026

USD-correlation display now has a pure `usdCorrelationPresentation.js` owner.
The parent retains mappings, source-status acceptance, 30D/1M selection, numeric
parsing and conditional date formatting. A new integration test passed against
the original implementation before extraction; eleven isolated cases cover
loading/unavailable precedence, positive/negative/zero and near-zero formatting,
labels and immutable inputs. Independent source-equivalence review passed 216
cases with no findings. No source acceptance or financial behavior changed.

Verification: **140 focused tests**, **4,169 Jest tests across 299 suites**,
**351 Node contracts**, lint with **zero errors / 140 existing warnings**, and
production build passed (existing large-chunk warning). IBIT (-0.77) and TLT
(unmapped N/A) rendered identical cell HTML, text, geometry and computed styling;
the screenshot was inspected and rows returned collapsed. The live-data guard
kept all quote/source decisions outside the formatter. Python/infrastructure
checks were not rerun; the known infrastructure failure remains separate.

Private checkpoint:
`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260911T172347Z-milestone4d-sSLImW`

The source copy and restored archive verified 1,431 files, 20 recorded deletions
and 227 exclusions; archive SHA-256:
`04b71e4cf7ae70c61795ef03445472c790b6697c24a12c8c2bee2b9ce543204c`.
This slice owns the parent, integration test, new formatter/test and this report.
`task-delta/` records recoverable before/after files and a forward/reverse-checked
patch; `verification/` records full checks and focused/browser evidence. No
unrelated source drift, dependencies, provider changes or staged changes.

Proceed to 4e: one current/lazy-history request owner. Audit identified a possible
pre-existing canceled-history retry gap on hiding/changing expanded row counts;
characterize it separately and do not silently change it during the move.

## Milestone 4e — research lifecycle, September 11, 2026

Current research and lazy five-day history now have one owner in
`src/hooks/usePortfolioResearch.js`. The parent passes activity, the stable symbol
scope, actual expanded-row count and manual refresh generation. It receives the
existing state/date and a synchronous history invalidation action. Nine request,
scope and refresh refs, both request callbacks and both effects moved together;
shared timing/history constants live in `src/constants/portfolioResearch.js`.
The parent is now 4,910 lines. No row, quote or order implementation moved here.

Source comparison confirms the callbacks/effects exactly match the prior version
after identifier changes. Current-before-history ordering, independence from
market-context polling, history-only merge authority, date/schema scopes, partial
refresh behavior, abort checks and manual invalidation order are preserved.
The live-data guard keeps retained data explicitly dated research, not executable
prices, and existing downstream decision acceptance remains unchanged.

All 115 existing portfolio integration tests and 38 response-helper tests pass.
Sixteen new direct hook tests cover empty/inactive states, current-before-history,
V1/V2 selection, scope changes, late responses, retained dated failures,
resume-delay/cleanup, synchronous invalidation, mismatch rejection and rollover.
Changed-file lint is clean, and the production build passes with its existing
chunk-size warning. The full IBIT research panel matched its baseline HTML, text,
161-node geometry and styling, including seven history rows; disclosure was
exercised and the row returned collapsed. Independent review found no regression.

Two explicit tests confirm the existing retry gap: changing expanded count or
hiding/resuming during pending history aborts that request but leaves the started
marker set. They document current behavior only; a separate corrective slice
will replace them with retry/ownership regressions before proceeding to 4f.

Private checkpoint:
`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260911T173009Z-milestone4e-LlJydv`

The source copy and restored archive verified 1,433 files, 20 recorded deletions
and 227 exclusions; archive SHA-256:
`4151033919f4e90083c3bd3353c6eac2b671c636b10aa1a9a68ce27ae82a31a9`.
Owned files: parent, new hook/test/constants, and this report. Full verification
passed **4,185 Jest tests across 300 suites**, **351 Node contracts**, repository
lint with **zero errors / 140 existing warnings**, and production build with its
existing large-chunk warning. Python/infrastructure checks were not rerun; the
known unrelated infrastructure failure remains separate. `task-delta/` contains
before/after files and a forward/reverse-checked recovery patch. Source inventory
matches only the five owned files. No provider actions, dependencies, order
controls or stack restarts were introduced. The structural slice is complete;
the known retry behavior is deliberately not claimed fixed yet.

## Milestone 4e-retry — separate reliability correction

The new direct lifecycle regressions reproduce six expected failures against the
unchanged extracted hook: expanding a second row aborts pending history, and
hide/resume or collapse/reopen does not retry the canceled request. The tests also
preserve accepted populated/empty history, current-before-history sequencing,
scope rejection and late-response protections. This correction is intentionally
separate from the structural 4e checkpoint; source/quote acceptance is unchanged.

Private pre-correction checkpoint:
`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260911T173829Z-milestone4e-retry-rR1YEi`

The source copy and restored archive verified 1,436 files, 20 recorded deletions
and 227 exclusions; archive SHA-256:
`23e6ec7c55f70adf2528584fd9d0f2415ef959741aca5a81f17fb6b3c8c1d1a3`.
Owned files are the research hook, its direct tests, the portfolio integration
test and this report. History now depends on whether any row is open, rather than
the exact row count. Cleanup releases only the unfinished, unaccepted attempt it
owns; matching loaded scope protects accepted empty results, and old cleanup cannot
invalidate a replacement generation. No changes to current request logic, response
scope/merge validation, provider sources or quote handling were made.

Both new integration tests failed before the fix and pass afterward. The focused
four-suite run passed **182 tests**. Full verification passed **4,194 Jest tests
across 300 suites**, **351 Node contracts**, lint with **zero errors / 140 existing
warnings**, and production build with its existing chunk-size warning. The focused
run emitted the known temporary async-handle warning, then exited successfully.
Python/infrastructure checks were not rerun; the known unrelated failure remains.

In the running dashboard, IBIT/TLT history remained available across two open rows
and collapse/reopen. Research text was unchanged; the only markup difference from
the structural baseline was the existing live stop-distance color changing as
quotes moved. All other markup matched. No test data was injected. The rows were
returned collapsed. Independent review found no actionable issue. `verification/`
records red/green and UI evidence, and `task-delta/` contains forward/reverse-checked
recovery with `intendedBehaviorChanges: true`. Only the four owned files changed.
The retry correction is complete; proceed to market-context ownership (4f).

## Milestone 4f — market-context lifecycle

`usePortfolioMarketContext` now owns the risk/volatility/USD state, request
generations, historical cache, sequential eight-symbol batches, priority-request
deduplication, polling and sizing clock. The parent supplies activity, stable
symbol scope, holdings and refresh generation; it receives existing state and
the two call-time reference/priority actions. Exact optional-number conversion
is shared in `portfolioNumbers`, with seventeen characterization cases. The
parent is now 4,505 lines and has no inline provider-request lifecycles.

Bulk, priority and sizing source acceptance remain intentionally distinct. The
live-data guard keeps historical reference retention separate from valid sizing;
`getPositionSizeReference` remains an ordinary call-time getter using
`Math.max(sizingClock, Date.now())`, including all matching instrument types.
The priority callback still returns the identical promise for duplicate pending
requests. The local clock effect now registers after the research effects; it has
no research dependency, and both its active-only lifecycle and call-time freshness
behavior are preserved. No quote/stop math, trade controls or styles changed.

Independent source comparison passed for all eight moved blocks plus the numeric
parser. The existing portfolio tests, real validator and numeric tests passed
**173 tests**; changed-production lint and build passed. Twenty direct hook tests
also passed for batching, partial failures, source independence, scope/visibility
handling, priority behavior and real-validator expiry/unsafe inputs. Full checks
passed **4,231 Jest tests across 302 suites**, **351 Node contracts**, repository
lint with **zero errors / 140 existing warnings**, and production build with its
existing chunk-size warning. Python/infrastructure checks were not rerun.

Browser comparison: TLT context markup/text/geometry/styles matched exactly.
AMZN geometry/styles and all non-volatility cells matched; its volatility provider
advanced from 13:40 to 13:45 EDT with new VXN/VIX readings. The TLT sizing
explanation and close focus/dismissal worked; rows were returned collapsed.

Private checkpoint:
`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260911T174717Z-milestone4f-vH8CQ8`

The source copy and restored archive verified 1,436 files, 20 recorded deletions
and 227 exclusions; archive SHA-256:
`dc70dff8810e90cb566851e032e6bda0219ebe3d2e3b0f27d05d2399d43b150a`.
Owned files: parent, new hook/test, numeric helper/test and this report. The source
inventory contains only these six changes. `verification/` records focused/full
and browser checks; `task-delta/` records before/after files and a forward/reverse
applicability-checked recovery patch. No provider operations or dependencies changed.

Separate confirmed pre-existing ownership race: an old second-batch completion
deletes symbols from the shared in-flight set before checking its generation.
During a newer partial refresh, this can permit a duplicate priority request.
Exact-source deferred reproduction produced a fifth request while the new second
batch was still pending. The structural extraction preserves it; correct it in a
separate, narrowly tested ownership slice before moving to 4g.

## Milestone 4f-ownership — separate reliability correction

Two red regressions reproduced a fifth, duplicate request after an obsolete
second batch resolved or rejected while the refreshed second batch was pending.
The in-flight map now records each symbol's owning bulk generation. Success and
failure release only matching owners; obsolete, old-only symbols still clean up.
Priority guard order, status handling, source acceptance and sizing are unchanged.

All **179 focused tests** passed (23 hook, 117 portfolio integration, 39 real sizing
validator), changed-file lint is clean and production build passed with the known
chunk warning. Browser TLT panel geometry remained identical and loading settled;
the row was returned collapsed. Full regression is recorded at the 4f structural
gate and will run again at the portfolio milestone gate; no Python checks here.

Private checkpoint:
`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260911T175910Z-milestone4f-ownership-y5dHBV`

The stable source copy and restored archive verified 1,440 files, 20 recorded
deletions and 227 exclusions; archive SHA-256:
`6d1807e08531c59505473c5dcfeb9f627caadac277bd86495cbef47e1144155e`.
Only the hook, its tests and this report changed. `task-delta/` records the three
owned files and a forward/reverse-checked patch, marked as an intentional behavior
correction. Proceed to cohesive research-row/domain composition (4g).

## Milestone 4g — research domain and panel composition

`portfolioResearchRows.js` owns the cohesive current/canonical/history product-row
formatting pipeline and its private evidence/fact helpers. `PortfolioResearchPanel`
composes the four existing sections from grouped display data and actions. The
parent is now **3,612 lines**. Source/decision acceptance, stop/sizing arithmetic,
WeakMap and fallback payload ownership, exact cache tokens, raw historical caching,
position identities and controlled product expansion remain unchanged in the parent.
CSS imports retain their existing order. No new provider or policy was introduced.

Sixteen frozen-input domain characterization cases passed before parent wiring;
all **117 existing portfolio integration tests** and **three real-section panel
tests** passed after wiring. Changed-file lint is clean and build passed with the
existing chunk warning. The integration runner emitted its known temporary async
handle warning, then exited successfully. Independent review confirmed the actual
parent equals the checkpoint plus exactly ten reviewed wiring edits.

Browser: TLT research text and markup outside the sizing cell matched exactly.
The sizing source naturally entered a refresh (9.8% to loading), with the same cell
geometry and no frozen/injected data. Beta explanation opened with the correct TLT
payload and focused close button, dismissed correctly, and the row was collapsed.
The last full gate is 4f; the full portfolio gate follows 4h.

Private checkpoint:
`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260911T180054Z-milestone4g-qaS5YY`

The stable source copy and restored archive verified 1,440 files, 20 recorded
deletions and 227 exclusions; archive SHA-256:
`dd183fe2fbd76ef339ba4381019e4bb0f25c7bb9222a0a415f89810a0b507a1c`.
Only the parent, two new implementation files, their two tests and this report
changed. `task-delta/` contains before/after files and forward/reverse applicability
checks. Proceed to the active positions card without moving dormant legacy JSX.

## Milestone 4h — active positions card and ledger ownership

`PortfolioPositionsCard` now owns the active toolbar, sibling long/short panes,
row presentation and target-input markup. `usePortfolioPositions` owns the three
filters, five shared target/edit maps, exact target events, share arithmetic and
CSV interaction. `portfolioPositionsModel` owns catalog-backed classification,
weights, source-dated display marks and formatting. The parent is **2,655 lines**.
Live evidence/NAV/factor expiry, holding IDs, research expansion, requests and
dialogs remain with their existing parent owner. No subscription, provider,
calculation, control or stylesheet changed. Shared ledger CSS stays in place to
avoid moving mixed selectors and changing the existing cascade.

Four new active-ledger tests passed before the move and all **121 portfolio
integration tests** passed afterward. Eleven new direct model/hook tests passed
for mark provenance, historical dates, formatting, factor-filter unavailability,
call-time sizing eligibility, shared targets and rounding. Independent AST review
confirmed copied helpers, calculations, input expressions, unchanged effects and
the entire dormant legacy JSX. Its temporary `legacySizing` bridge shares the
same state; it does not duplicate active target state.

Full milestone gate: **4,257 Jest tests / 304 suites**, **351 Node contracts**,
repository lint (**zero errors / 140 existing warnings**) and production build
passed. The eleven new direct tests ran separately after full-suite discovery;
their changed-file lint is clean. The build retains its existing chunk-size
warning. Python/infrastructure checks were not rerun here.

Browser checks passed for search, stable TLT row identity, sort/sleeve filtering,
research expansion and the centered TLT sizing explanation. The card remained
834 × 306 pixels at the same viewport; shell/toolbar geometry and styling matched.
Both panes returned to 38 long / 19 short positions, with research collapsed.
Provider sizing observations naturally progressed from loading to verified values;
the comparison does not claim fixed live values. Historical-reference rows kept
sizing inputs unavailable. CSV download plumbing was exercised in tests only.

Characterized pre-existing interaction: Escape clears editing state and triggers
blur, which commits the visible target draft. Preserve this during extraction;
an Escape-to-cancel change requires a separate explicit behavior correction.

Private checkpoint:
`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260911T180643Z-milestone4h-w9r12s`

The stable source copy and restored archive verified 1,444 files, 20 recorded
deletions and 227 exclusions; archive SHA-256:
`61ec497d80d72c7b40c71a983c01a931d20ce0b88711910986c908814978a98d`.
Owned files are the parent, existing integration test, three new implementation
files, their two direct tests and this report. `verification/` records the full
gate and focused/browser evidence; `task-delta/` records task-only before/after
files and forward/reverse applicability checks. Proceed to Gold correlation (5a).

## Milestone 5a — Gold correlation card

`GoldCorrelationPanel` owns the unchanged completed-session matrix and its exact
exclusive CSS. `goldCorrelationContext` owns normalization, post-normalization
usability and canonical Gold factor replacement; `goldContextValidation` shares
the original Gold-only primitive/provenance/date checks with header and settlement
callers. Existing public monitor exports remain compatible. Resource ownership,
one-day activation, retry/success polling, date/age gates, transforms, observations,
source checks, factor ordering and non-executable context policy are unchanged.

Six direct card tests passed before parent wiring. All **222 tests** passed across
the complete monitor suite and the new card suite afterward. Changed-file lint is
clean; production build passed with the known chunk warning. Source comparison
confirmed literal helper bodies and exclusive CSS. No requests moved or multiplied.

Browser: all **88 matrix nodes** had identical markup, text, relative geometry and
computed styles. The foreground Gold 5D and 10D views omitted the matrix and 1D
restored it. WTI and SP500 kept Gold in its hidden persistent surface, not their
active view. The SP500 MOMO baseline currently reads `NO NEW DATA`; later checks
must not fabricate positive provider state merely for a visual comparison.

Private checkpoint:
`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260911T182304Z-milestone5a-X9VKH4`

The stable source copy and restored archive verified 1,449 files, 20 recorded
deletions and 227 exclusions; archive SHA-256:
`33ad9ae65605b8c265c1f27b6fb15f242466564f8f244d0e7ef5da954c47d211`.
Owned files: monitor JSX/CSS, the new card/CSS/test, two domain helpers and this
report. Focused/browser evidence is in `verification/`; the eight-file task-only
recovery patch is forward/reverse applicability checked in `task-delta/`.

## Milestone 5b — MOMO Tracker card

`MomoTrackerPanel` owns the existing seven-column reference/spot table and its
exclusive styles. `momoTrackerContext` owns the unchanged publication and direct
live spot normalizers plus call-time spot expiry. Parent aliases preserve both
public normalizer exports. Publication/spot polling, resource failure policy,
New York date validation, row completeness/order and 60-second spot expiration
remain unchanged. Existing inactive theme selectors were moved literally; no
new theme behavior was added. The active monitor is now **7,874 lines**.

Seven new leaf/domain tests passed before parent wiring. All **223 tests** across
the full monitor and two new suites passed afterward. Changed-file lint is clean;
build passed with its existing chunk warning. Source-equivalence checks covered
exact domain and panel bodies plus CSS selectors/declarations/media contexts.

Browser: the current `NO NEW DATA` shell matched all three nodes exactly in text,
markup, geometry and styles. MOMO was absent from foreground SP500 5D and 10D;
1D was restored. Verified-positive table/spot states were tested with isolated
test fixtures only, not injected into the user's running application.

Private checkpoint:
`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260911T182649Z-milestone5b-Ikyt3T`

The stable source copy and restored archive verified 1,454 files, 20 recorded
deletions and 227 exclusions; archive SHA-256:
`ec4a56201e0cb24dcf528c7f03abcdaf421c11df5150bb0675b8ad9052ad32f0`.
Owned files: monitor JSX/CSS, new MOMO card/CSS/test, context/test and this report.
`verification/` records focused/browser evidence; `task-delta/` records the eight
owned before/after files and forward/reverse applicability checks.

Separate confirmed pre-existing guard gap: the spot normalizer adds a
`refresh-failed` provenance marker for `quote.refreshFailed` but its rejection
pattern does not recognize that marker. An offline deterministic reproduction
accepted an otherwise fresh flagged quote as live while correctly rejecting a
cache-marked peer. The structural move preserves this defect; add a red regression
and correct it separately before continuing. Do not change publication retention.

## Milestone 5b-refresh — separate failed-refresh spot correction

Six red regressions reproduced acceptance of explicitly failed refreshes through
the flag and existing warning/source-status/freshness channels. One narrow change
adds `refresh[_ -]?failed` to the existing forbidden-provenance pattern. A failed
spot is now unavailable immediately, even with a recent timestamp; a successful
peer remains independent. Publication retention, its New York date, spot age
limits, requests and styling did not change.

All **229 tests** passed across the complete monitor and two MOMO suites; the six
new regressions include actual table rerender with the real normalizer. Changed
lint is clean and build passed with the existing chunk warning. Browser `NO NEW
DATA` markup/geometry/styles remained identical; no provider failure was injected
into the running user session.

Private checkpoint:
`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260911T182915Z-milestone5b-refresh-XdnoOO`

The stable source copy and restored archive verified 1,459 files, 20 recorded
deletions and 227 exclusions; archive SHA-256:
`e51b7f5f78988ec216df324ad749797079299d4b0a286f39652aa359d7c22f2a`.
Only the context pattern, two test files and this report changed. Focused/browser
evidence and the four-file behavior-change recovery patch are recorded in
`verification/` and `task-delta/`. Proceed to proxy-fit/Pyth cards (5c).

## Milestone 5c — proxy-fit and Pyth tracking cards

`ProxyFitPanel`, `PythTrackingPanel`, their exact formatting helpers and exclusive
styles now have focused owners. Existing shared chart-grid placement remains in
the monitor stylesheet; source normalization, selected-market/range behavior,
requests, final-reference precedence and Pyth metric availability did not change.
The shared ATH date formatter stays available to the chart through an import.
The parent monitor is **7,703 lines**.

Seventeen new card tests passed before wiring. Two initial new-test queries
assumed scoped row headers that the original markup does not provide; only the
queries were corrected to assert the existing table structure. No production
markup was changed to satisfy those tests. All **233 tests** passed across the
complete monitor and card suites after wiring. Changed-file lint is clean and
build passed with its existing chunk warning. Exact-source checks covered seven
declarations and 49 CSS rules with their original media contexts.

Browser: all 43 SP500 proxy nodes matched markup/text/geometry/styles exactly.
Pyth's 34-node markup, text, computed styles and internal element dimensions
matched after its normal active refresh. Its existing shared flex canvas was
4.5 pixels taller than the earlier hidden-surface capture; the content stayed
centered with a uniform 2.25-pixel vertical offset, and no local sizing rule or
element size changed. This is not a claim of identical absolute canvas height.
Pyth was absent in Gold 5D/10D and restored in 1D. Brent retained its prepared
comparison and existing exact-resolver link/disclosure; the link was not opened.
Responsive rules were source-compared, not verified by resizing the browser.

Private checkpoint:
`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260911T183115Z-milestone5c-9J4twZ`

The stable source copy and restored archive verified 1,459 files, 20 recorded
deletions and 227 exclusions; archive SHA-256:
`0f27af0eabd8f63a5bc94473e703ea6bb5aeb9e1675409eb40e65e758f75aa90`.
Owned files: monitor JSX/CSS, two new cards, shared helpers/CSS/test and this report.
Focused/browser results and an eight-file applicability-checked recovery patch
are in `verification/` and `task-delta/`. Proceed to factor/source sheets (5d).

## Milestone 5d — factor and source tables

SPX, generic market and CPI source tables now have focused presentation owners.
Shared numeric, display, market-identity, section-validation and CPI-value helpers
have single dependency-free owners. Parent compatibility exports, factor scoring,
acceptance gates, resources and mixed table CSS remain unchanged. The monitor is
**6,966 lines**. Source review confirmed 28 moved declarations and preserved
the remaining parent declarations; no child imports the parent.

Sixteen new direct tests passed before wiring. All **268 monitor/card tests**
passed afterward; changed-file lint is clean and build passed with the existing
chunk warning. CPI's 22-node unavailable source table matched exactly. SPX and
Gold outer panels remained 465.59 × 456.20 pixels. Gold computed styles matched
on all 56 nodes; only the naturally advancing GVZ observation changed. SPX also
received new provider availability/observation states during comparison, so this
is not a claim of identical live text or descendant count. No data was injected.

Private checkpoint:
`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260911T183638Z-milestone5d-qrKnjT`

The stable source copy and restored archive verified 1,464 files, 20 recorded
deletions and 227 exclusions; archive SHA-256:
`edd2036d75b4b4af14445e3d7849aa40259da057ce8f98bcced27ff8e92882ac`.
Owned files: parent JSX, nine new runtime helpers/components, three tests and
this report. Focused/browser evidence and the fourteen-file applicability-checked
recovery patch are recorded in `verification/` and `task-delta/`. Proceed to 5e.

## Milestone 5e — contract ladder

The nine-column ladder, native quote cells, reference markers and position rows
now belong to `ContractLadder`, with focused geometry, presentation, position and
reference helpers. Parent acceptance of provider rows and position envelopes,
current account/generation, polling and resource ownership remains unchanged.
No opposite-side quote or size is inferred. Existing compatibility exports are
retained. The parent is **6,384 lines**. Twenty-seven declarations and 76 exclusive
CSS rules were source-equivalent; shared table/layout rules stay in the parent.

All 24 new direct tests passed before wiring, including frozen inputs, four-sided
native quotes, missing sides/sizes, removal of accepted rows, reference expiry and
provenance, CPI report matching and account/generation position aggregation.
After wiring **292 tests / 9 suites** passed. Changed-file lint is clean and build
passed with the existing chunk warning; existing act warnings remain test-only.

Browser: CPI's 28-node unavailable ladder matched exactly and had no vertical
overflow. Gold's 243-node geometry and computed styles matched exactly while
provider quote values advanced normally. SP500 kept its 698.40 × 456.20-pixel
ladder and nine-column arrangement; a natural live-to-delayed reference transition
added the existing three-node `D` marker, so descendant/text equality is not
claimed there. No provider data or failure was injected.

Private checkpoint:
`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260911T184422Z-milestone5e-PXkrn0`

The stable source copy and restored archive verified 1,476 files, 20 recorded
deletions and 227 exclusions; archive SHA-256:
`4b6f4914949643a77bd7314151eb364dd832a8cb249eb185ceea14e839a4824c`.
Only parent JSX/CSS, seven new ladder files and this report changed. Focused/browser
evidence and the ten-file applicability-checked recovery patch are recorded in
`verification/` and `task-delta/`. Proceed to CPI forecast/release views (5f).

## Milestone 5f — CPI forecast and release views

The CPI comparison shell, forecast board, release setup and tooltip/source links
now have dedicated components. Exact forecast normalization/calendar logic,
contract-clock formatting, settlement identity and label collision helpers have
single shared owners. The parent keeps resources and public compatibility exports.
Thirty-six moved declarations and 89 exclusive CSS rules retain original bodies,
ordering and media contexts. Mixed clock/ladder/source styles stay with the parent.
The active monitor is now **5,224 lines**.

Eleven new direct tests passed before wiring, covering exact-period/source gates,
aging, weekend publication gaps, actual-release timing, forecast precision,
settlement generation and real chart rendering. After wiring **303 tests / 11
suites** passed. Changed-file lint is clean; build passed with the existing chunk
warning. The staged patch's source-order packaging issue was corrected and proven
against a fresh scratch copy before it touched the repository.

Browser: the 77-node current CPI comparison matched exactly in markup, text,
geometry and computed styles. The real provider currently reports no usable
current comparison; positive chart/actual transitions were verified in isolated
tests, not with fabricated runtime data. Existing forecast/release layout and
source disclosure remain unchanged.

Private checkpoint:
`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260911T184745Z-milestone5f-MLSY2m`

The stable source copy and restored archive verified 1,483 files, 20 recorded
deletions and 227 exclusions; archive SHA-256:
`857bd2da92e4b267de61988a2104558ed28643ab54e2345bdb2f0fd8951b8e3c`.
Owned files: parent JSX/CSS, eleven new CPI/shared-helper/test files and this report.
Focused/browser evidence and the fourteen-file applicability-checked recovery
patch are recorded in `verification/` and `task-delta/`. Proceed to chart owners (5g).

## Milestone 5g — chart shell, model and drawing ownership

The chart now has a shell, local view-model hook and memoized drawing hook, with
focused session/calendar, axes, structure-score, settlement, annotation and header
modules. The parent remains responsible for resource feeds and selection. Its
**2,418 lines** now focus on orchestration rather than the chart implementation.
The drawing hook retains the original memoized element, avoiding an extra wrapper
or a redraw on a countdown-only update. Shared CSS was not changed.

Independent AST checks confirmed all **78 helpers**, ordered model statements,
plot memo/tree/dependencies, public props/defaults and shell JSX exactly match the
pre-move source. All **54 retained parent declarations** also match. Ten new direct
tests passed before wiring; **313 tests / 12 suites** passed afterward. Tests cover
real Recharts rendering, invalidation, expiry, separate contract series, exact-date
ranges, Labor Day closures, Gold settlement identity and owned resize cleanup.
Changed-file lint is clean and build passed with the existing chunk warning.

Browser: SPX 1D/5D/10D and Gold 1D retained their 1164 × 243.80-pixel chart shell.
Price/contract lines, session dates, weekend/Labor Day labels, ATH and range labels
remained present as applicable; SPX was restored to 1D. Live reference/ATH data and
Gold settlement/header availability advanced during inspection, so complete
descendant/text/style equality is not claimed. Exact source markup and CSS checks
plus deterministic chart regressions complement these real-provider observations.
No provider data was injected, and positive unavailable states were not fabricated.

Private checkpoint:
`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260911T185117Z-milestone5g-HItWfm`

The stable source copy and restored archive verified 1,494 files, 20 recorded
deletions and 227 exclusions; archive SHA-256:
`546aedc9edbcae5ab16d65e3902adc29833857a3e06ee207cb58057640be10c4`.
Owned files: parent JSX, eleven new runtime modules, one test and this report.
Focused/browser evidence and the fourteen-file applicability-checked recovery
patch are recorded in `verification/` and `task-delta/`. Proceed to resource hooks (5h).

## Milestone 5h — card reference resource ownership

Gold correlation, MOMO publication/spot and CPI benchmark resources now have
focused hooks. Existing resource keys, activation, scope, polling, validation,
original observation times and Gold usability checks were preserved. The active
monitor is **2,283 lines**, still orchestrating eight retained market instances.
Twenty-four new direct tests passed before wiring; **337 tests / 13 suites**
passed afterward. Full gate: **4,389 Jest tests / 318 suites**, **351 Node tests**,
repository lint (zero errors; 140 existing warnings), and production build passed
(existing large-chunk warning). Changed-file lint is clean.

Browser: Gold correlation (88 nodes) and MOMO (three nodes) matched captured
markup/text/geometry/styles and disappeared outside their one-day views, which
were restored. CPI retained its compact forecast/release shell while ordinary
source checking/expiry changed its status; exact dynamic content equality is not
claimed. No provider data was injected.

Existing issue characterized, not changed: shared reference resources ignore
`retainOnRefreshFailure: false` for clearing and have no expiry timer. The CPI
benchmark has no additional age gate after initial acceptance, so an accepted
benchmark can persist beyond 30 minutes until replacement/scope invalidation.
It retains its original date; correcting this needs a separate behavior slice.

Private checkpoint:
`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260911T185630Z-milestone5h-T3nncl`

The verified source/archive contains 1,506 files, 20 recorded deletions and 227
exclusions; archive SHA-256:
`7d190f925f103f4d2baac4dddb75a618f055e94820183d963d8bf11ad89f0562`.
Owned files: parent JSX, three new resource hooks, their direct test and this
report. Full/focused evidence and the six-file applicability-checked recovery
patch are in `verification/` and `task-delta/`. Proceed to dashboard owners (6a).
## Milestone 6a — dashboard resource owners

Five hooks now own portfolio/account/provider polling, overview quote/period
resources, ETF Pro, changelog sharing, and prediction navigation indicators.
Nine unchanged timing constants have one owner. The parent retains manual/window
refresh coordination, warmup, reference projection and every JSX/CSS boundary.
It is now **2,933 lines**. Forty-four moved hook blocks and five private helpers
retain their bodies. Hook grouping changes independent effect registration order,
not keys/cadence/activation; initial request counts and settled gates are tested.

Eight direct real-resource tests passed before wiring; **61 tests / two suites**
passed after wiring, including dashboard warmup/persistence integration. Changed
lint is 0/0 and build passed with the existing chunk warning. Browser navigation
matched exactly; portfolio navigation remained usable, no horizontal overflow or
Vite error overlay appeared. Provider values continue to advance naturally.

Private checkpoint: `20260911T190548Z-milestone6a-JUDcRP` in the refinement-checkpoints
directory documented above. Its stable copy/restored archive verified 1,510 files,
20 recorded deletions and 227 exclusions; archive SHA-256
`ca60f3041e51573423340cf1782af418b7f44338c704ab71abd135f86c275f2c`.
Only the parent, seven new hook/timing/test files and this report changed; the
nine-file recovery delta is applicability-checked. No resource policy changed.

## Milestone 6b — workspace persistence and resizing

Saved panel selection, stack/geometry and initial workspace snapshot now belong
to a workspace-state hook with storage/migration helpers and constants. A separate
resize hook owns pointer/keyboard listeners and cleanup; parent overlay geometry
and focus behavior remain in place. Stable setter dependencies were made explicit;
the original handlers, storage format and limits are unchanged. Parent: **2,497
lines**. Seven direct tests passed before wiring; **68 tests / three suites**
passed afterward, with clean changed-file lint and a successful build.

Browser: the restored active prediction workspace retained exact dimensions,
styles and visibility. Hot reload discarded an already-closed retained portfolio
instance, as expected for a remount; opening Portfolio still rendered its card.
Full descendant equality across that remount is not claimed. Keyboard/pointer
resize, persistence and callback stability are covered by isolated/integration
tests. No provider or trading interaction was performed.

Checkpoint `20260911T190733Z-milestone6b-M1CgdV` verified 1,517 files, 20 deletions,
227 exclusions and a stable restored archive, SHA-256
`80d1a14cfe34a73eb6578b887f950ab874fbb973f6f5eb297a3f12f2540a28bf`.
Owned files: parent, five new workspace/resize/test files and this report; the
seven-file delta has forward/reverse applicability evidence. Continue to shells.

## Milestone 6c — named workspace presentation shells

Fourteen named presentation components now own existing panel wrappers and the
controlled book reader. Resources, lazy loaders, Suspense children, eight keyed
prediction-market instances and short Process/TLDR wrappers stay parent-owned.
All fourteen shell/child substitutions reproduce the original JSX; no CSS, DOM
wrappers or lifecycle state were added. Parent: **1,645 lines**.

Five new direct tests passed before wiring; **78 tests / five suites** passed
afterward, including retained-state, occlusion, refs and resize callbacks.
Changed lint is 0/0; production build passed with the known chunk warning.
Browser: both captured Portfolio (860 × 704) and prediction (1166 × 704) shells
matched exactly in style/class/visibility/geometry. Contract P&L opened with both
resize edges, occluded Portfolio and restored it on closing. No horizontal
overflow or Vite error overlay appeared. No trading controls were changed/used.

Checkpoint `20260911T190919Z-milestone6c-ilrckZ` verified 1,522 files, 20 deletions,
227 exclusions, source stability and archive restoration; SHA-256
`a2148b956a4f5cc7b42e2ff981db0e2a2ffe3dd244e97a843a593b70fb87569a`.
Owned files: parent, fourteen shell modules, one test and this report. The
seventeen-file recovery delta is applicability-checked. Continue to pure domains.

## Milestone 6d — pure dashboard domains and milestone gate

Reference comparison/failure projection and market-period merging now have
dedicated pure modules. All eleven declarations retain exact source/AST bodies;
the parent component is unchanged and keeps its public merge compatibility
export. Original quote evidence stays separate from dated period metadata.
Parent: **1,497 lines**. Five direct tests passed before wiring; **83 tests / six
suites** passed afterward. Changed-file lint is clean and build passed.

The full milestone gate passed: **4,414 Jest tests / 322 suites**, **351 Node
tests**, repository lint (0 errors / 140 existing warnings), and production build
(existing chunk warning). Independent review confirmed all 26 installed 6a–6d
modules and the parent match reviewed staging. Browser navigation and the
Portfolio/prediction shell sizes remain unchanged, with no overflow or Vite error.

Checkpoint `20260911T191121Z-milestone6d-QOpkhO` verified 1,537 files, 20 deletions,
227 exclusions, stability and archive restore; SHA-256
`ab987d58defbffb69dbf180144fe22bd1671d2ed63b6adc8354c6dd033b147f2`.
Full gate logs/results are in its `verification/`. Owned files: parent, two pure
modules, one test and this report; five-file recovery delta applicability checked.
Continue to thin server handlers; no service lifecycle change is included.

## Milestone 7a — reference HTTP handlers

Overlap, exchange volume and calendar callbacks now have dependency-injected
factories. Their exact status/header/body/parameter/rejection behavior and route
order are unchanged; services, provider gates, caches and startup remain in the
server's existing owners. **23 direct Node tests** passed before/after wiring;
**74 service tests / four suites** passed. Server syntax and build passed. New
files lint cleanly; server retains its seven existing unused-binding warnings.
These are presentation-neutral changes tested without importing the server,
calling providers or restarting the running API.

Checkpoint `20260911T191630Z-milestone7a-1hVR8G` verified 1,540 files, 20 deletions,
227 exclusions, stability and archive restoration; SHA-256
`9799d9867700bc9eb56b40e94ca125dbae1098e533d028c17fc89a0730fa945d`.
Only server.js, the handler/test and this report changed. The four-file delta
has forward/reverse applicability proof. Continue to volatility/correlation.

## Milestone 7b — volatility and correlation handlers

Five existing VIX/generic-volatility/snapshot/USD/Gold callbacks now live in two
injected handler modules. Existing status/body/logging/header behavior, source
validation and provider construction remain unchanged. Twelve new direct tests
passed before wiring; **35 combined handler tests** and **34 service tests / four
suites** passed afterward. Installed server AST independently matches the actual
7a/7b scratch-application proof. Server syntax and build passed; new lint is 0/0,
with the same seven pre-existing server warnings. No live API restart/request.

Checkpoint `20260911T191735Z-milestone7b-U3oszm` verified 1,542 files, 20 deletions,
227 exclusions, stability and archive restore; SHA-256
`6d2e3a67204b3f58637231ca8625dbd94cb442b2a834679e386555e24d7373fd`.
Owned files: server.js, four handler/test files and this report. Six-file recovery
delta is applicability-checked; the pre-existing trailing-space server comment
was preserved rather than reformatted. Continue to the separate currency fix.

## Milestone 7c — remove fabricated currency endpoint data

Separate behavior correction: `/api/usd/currency-pairs` no longer returns seven
fixed rates with freshly manufactured timestamps. It returns HTTP 503,
`Cache-Control: no-store`, and `{status:'unavailable', currencyPairs:[],
reason:'verified_currency_pair_provider_unavailable'}` until an actual provider
is wired. No replacement prices, source claims or dates are invented.

The original isolated callback failed the same unavailable contract (200 versus
503); the new callback passed. Five direct tests passed before wiring and **40
combined handler tests** afterward. Server syntax/build passed, new lint is 0/0
and server retains its seven old warnings. Installed server AST independently
matches the actual composed 7a/7b/7c proof; all 95 top-level route registrations
retain method/path/order. Only the nine authorized callbacks changed.

The Analyst supporting-context caller already catches 503 before JSON parsing
and marks this channel unavailable independently. The old USD aggregate service
rejects through its existing error path; no active caller of that aggregate was
found. Its public API remains. No API restart or live endpoint test was performed;
this source correction takes effect on the next normal managed restart.

Checkpoint `20260911T191900Z-milestone7c-r43cER` verified 1,546 files, 20 deletions,
227 exclusions, stable source and restored archive; SHA-256
`60c1771811c45ba7c51207be7b0705402681be107373c1421fe0f7c1d2c75fcd`.
Owned files: server.js, new handler/test and this report. Four-file recovery delta
is applicability-checked and explicitly marked as an intentional behavior change.

## Milestone 7d — legacy/disuse inventory

`CODEBASE_LEGACY_INVENTORY.md` records concrete direct/dynamic consumers, source-
inspecting tests and safe future cleanup boundaries. Independent lexical binding
analysis confirms five private server functions have zero references or
reassignments. They and an isolated orphan logo are documented, not deleted.
Legacy prediction components still have lazy/test consumers; old portfolio
support hooks still execute and share active state. All are retained. No runtime,
CSS, dependency, test or asset was removed simply because it is large/unmounted.

This finite milestone is complete as the agreed disuse inventory, not a claim
that all old code is gone. Production verification from 7c remains applicable;
this slice changes only the inventory and improvement report, with a verified
source checkpoint and two-file recovery delta.
Checkpoint `20260911T192009Z-milestone7d-dmqv0t`: 1,548 files, 20 deletions,
227 exclusions, stable copy/restored archive; SHA-256
`0c9f4faacd603f0e0b833e564eaba69e298c5cbfb46d3b47f711b77335693886`.

## Milestone 8a — testable verification runner

The existing CLI now delegates to an injectable `runVerification` function;
requiring it for tests does not start checks. Group selection, command order,
working directory, inherited output, CI/AWS test environment, first-failure stop
and exit codes are preserved. Nine tests passed in an isolated proof before
wiring; **15 runner/Python-tool tests** passed after installation. Changed lint
is clean. The manifest and production application are unchanged; no release,
installation or provider command was run by these injected tests.

Checkpoint `20260911T192056Z-milestone8a-ZODgmJ` verified 1,549 files, 20 deletions,
227 exclusions and stable copy/restored archive; SHA-256
`b351c4c022beecaf4c8be683035bb57af247aee6d7b3983b41a317e623f254e4`.
Owned files: runner, new test and this report; three-file recovery delta checked.

## Milestone 8b — declared command references

Four dependency-free tests now validate actual package/manifest aliases, literal
files, test directories and templates, plus bounded grammar fixtures. Before the
change, one test failed solely on the two known absent targets. Removing exactly
those two aliases made all four pass; **13 combined reference/runner tests** and
changed-file lint passed. A byte comparison proves package.json changed only by
those two lines. Dependencies, lockfile, CI and verification manifest unchanged.
This is declaration validation, not arbitrary shell parsing or command execution.

Checkpoint `20260911T192200Z-milestone8b-zcnPkd` verified 1,550 files, 20 deletions,
227 exclusions, stable copy and restored archive; SHA-256
`084f03ddf95ae788bd18613589b15b7d7f844f7cff3da6d21a443eb41ac072ca`.
Owned files: package.json, new reference test and this report. The three-file
recovery delta preserves the removed aliases if deliberate restoration is needed.

## Milestone 8c — scoped architecture guard and maintenance map

The static checker covers **94 explicit module owners**, rejects back-imports to
orchestration parents, inappropriate UI/resource ownership, runtime fixture
imports and scoped cycles. It uses the existing Babel development dependency
without executing application modules. Mixed view-models remain explicit;
there are no line limits or repository-wide migration rules. Eighteen architecture
tests and **31 combined maintenance tests** pass; changed lint is clean.
Independent review found two omitted portfolio-resource roles; a failing actual-
policy regression was added before correcting that coverage gap. The two new
6d domain modules are covered too. No runtime behavior changed in this step.

`CODEBASE_MAINTENANCE.md` maps the new owners, small-change workflow, verification
commands, limits and recovery rules; README links it and the audit documents.
Two small documentation inaccuracies were corrected after independent review.

Checkpoint `20260911T192256Z-milestone8c-ai8x5b` verified 1,551 files, 20 deletions,
227 exclusions, stable source and restored archive; SHA-256
`17aaa184f085dc67c72fae7f875750eda8d17b1117b967e80e1182f2602f3dbc`.
Owned files: three checker/policy/test files, maintenance guide, README, legacy
inventory and this report; seven-file recovery delta applicability checked.
Only final regression, rendered smoke and recovery audit remain.

## Final continuation verification — September 11, 2026

All 27 remaining slices (4d through 8c, including separate characterized
corrections) are complete. The ending orchestration sizes, compared with this
continuation's actual 4d checkpoint, are:

| Active parent | Before continuation | After |
| --- | ---: | ---: |
| PortfolioBreakdown.jsx | 5,146 lines | 2,655 lines |
| PredictionMarketResolverTest.jsx | 8,509 lines | 2,283 lines |
| PortfolioDashboard.jsx | 3,354 lines | 1,497 lines |

This is an ownership improvement, not a claim that fewer total lines or faster
bundles were produced. Cards, chart helpers, resource lifecycles, workspace shells
and thin handlers now have focused owners and direct tests. Legacy compatibility
paths remain where disuse or safe removal was not established.

### Final checks

The actual updated CLI, `node scripts/testing/verify.cjs node`, passed end to end:

| Check | Result |
| --- | --- |
| Native Node contracts/tooling/architecture | 422 passed |
| Jest UI/service regressions | 4,414 passed / 322 suites |
| Repository JavaScript lint | 0 errors; 140 pre-existing warnings |
| Production build | Passed; existing large-chunk warning |
| IBKR Python (fresh independent rerun) | 194 passed |
| Analyst Python and undefined-name lint (fresh independent rerun) | 161 passed; lint passed |
| Generated Hermes contract | Passed |
| Infrastructure Python | 498 run: 496 passed, 1 failed, 1 skipped; same baseline failure |

Browser smoke checks used real provider state without fixtures: Portfolio
rendered verified account rows and dated/unavailable quote distinctions;
SP500 retained its selected 5D chart across a Gold round-trip, then was restored
to 1D. Gold chart/correlation and CPI forecast/ladder rendered. Contract P&L's
open/occlude/close cycle and both resize edges were checked earlier in 6c.
Portfolio was returned to the foreground at 860 pixels wide. No Vite error
overlay or horizontal overflow appeared. Quotes and availability advanced
naturally; this is not execution/provider certification.

### Recovery and preserved work

Final source checkpoint:
`/Users/timsmith/Library/Application Support/market-dashboard/refinement-checkpoints/20260911T192412Z-milestone8-final-I1bCjE`

It verified 1,555 source files, 20 recorded pre-existing deletions, 227 exclusions,
source stability and archive restoration. Archive SHA-256:
`bbcbc90443624c1c265a74923ea0a42ce1e8053a97080e8e95b4198c47a732ce`.
The final CLI receipt/log is in `verification/`. Fresh Python receipts/logs are
under checkpoint `20260911T191121Z-milestone6d-QOpkhO/python-verification/`.

`recovery-audit.json` verifies all 27 task-delta manifests, patch hashes and
before/after hashes. The latest captured versions of all **134 distinct owned
files** matched the workspace before this final documentation-only update.
Every delta has forward/reverse applicability evidence; the final report update
has its own one-file delta. The whole-source comparison before final reporting
showed no changes outside the captured state. Do not blanket-restore checkpoints
over later work. No Git staging/commit/reset or dependency installation occurred.

### Remaining issues — not hidden by checklist completion

- The infrastructure permissions/environment assertion remains the known failing
  baseline test. No IAM, cloud template or deployment behavior was changed.
- The existing entry bundle is 978.91 kB minified / 280.07 kB gzip, and the 140
  existing lint warnings remain. Bundle optimization was not part of this pass.
- Holdings-overlap validation still needs its separately documented null/bounds
  hardening. No percentage or financial mapping was changed by these moves.
- Accepted CPI benchmark references can outlive their 30-minute acceptance age
  under the existing reference-store policy; original dates remain. This was
  characterized, not silently fixed during the structural extraction.
- Legacy prediction compatibility, unreachable portfolio presentation/support
  debt and copied-algorithm tests remain inventoried. Existing target-input
  Escape/blur behavior was preserved, not redesigned.

The separately corrected currency endpoint no longer has fabricated data in
source. The running API was not restarted; backend changes take effect on its
next normal supervisor-managed restart. No orders, cloud release, deployment,
live provider disruption or legacy-file deletion was performed. Only the two
broken package aliases were removed; their recovery delta retains the old lines.
