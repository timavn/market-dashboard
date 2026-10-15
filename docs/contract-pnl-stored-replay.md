# Stored Contract P&L evidence and replay

Settled accounting history is independent of executable quotes. These tools do
not derive prices, infer that an offline account is flat, or replace original
Flex reports. A complete source window does not certify every reconstructed
lifecycle: conflicting or ambiguous economic records remain quarantined.

## Read-only review

Validate existing normalized files without a Flex request, state change, or
ledger connection:

```sh
node scripts/prediction_pnl_backfill.cjs --dry-run --stored --from 2026-01-01 --through 2026-09-10
```

Preview those files against the actual configured Contract P&L account's ledger:

```sh
node scripts/prediction_pnl_backfill.cjs --dry-run --stored --replay-ledger --from 2026-01-01 --through 2026-09-10 --audit /absolute/private/checkpoint/replay-audit.json
```

The second command uses only the `market-dashboard-local` AWS profile, reads
ledger prefixes with pagination, and stops on permission failures. There is no
credential/profile fallback. The explicit audit file is created with mode 0600
and cannot overwrite an existing file. Console output masks accounts and omits
private proposed entries. Without `--audit`, it writes no local artifact.

The preview checks source-file byte hashes and actual ledger hashes before and
after reconciliation. It rejects duplicate conditional target keys, serializes
and deserializes proposed entries exactly as persistence does, and requires real
reconciliation to produce zero additional writes both immediately and one minute
later. An explicit private audit also captures the exact input ledger/source
evidence so subsequent review does not depend on a changing live process.

The durable accounting audit includes per-account/per-market risked, paid, P&L,
entry-plus-exit fees, withheld reasons, component classifications, and per-result
broker cash-flow comparisons. Multiple competing lifecycles or missing/nonflat
source evidence remain unproven; the audit never splits or guesses allocations.
The existing generic convention of all fees in risked and gross exit proceeds
is bridged only when its raw risked/paid differences exactly match reported exit
fees, with matching P&L and total fees. Raw differences remain visible. Native
ForecastEx entries and opposite-side cashouts retain their existing convention.
New or monetarily changed published results require these financial controls.
Unchanged prior verified settlements remain available while a delayed broker
removal posting is missing, with that source-tape limitation explicit.

`ready_for_review`
means that this preview is stable and idempotent; it does not mean permission to
publish, that all economic ambiguities are resolved, or that quotes are live.

## Existing approval workflow

Without `--stored`, the pre-existing `--dry-run` command still requests Flex
reports. Do not use it for an existing-files-only audit.

`--stored --save-preview` explicitly writes a local source-validation preview.
The separate existing `--commit <hash>` operation approves automatic Flex sync;
it revalidates source byte hashes, account coverage, conflicts, required sections,
and zero-to-cent controls. It is not a ledger-repair publication command. Neither
option can be combined with `--replay-ledger`.

## Programmatic interfaces

- `validateFlexActivitySnapshots(snapshots, {accountId, expectedFromDate, expectedToDate})`
  is the shared pure validator. Preview, approval, and historical reads use it.
- `createFlexActivityReader().read(options)` caches parsed source files and
  account-scoped validation by stat signature. `force: true` rehashes actual bytes;
  `invalidate()` discards the cache. Results include `validationVersion`,
  `sourceManifest`, `sourceHashes`, `sourceFingerprint`, and conflict scope.
  Historical HTTP reads should consume their published read model, not repeatedly
  invoke this background ingestion reader.
- `previewPredictionMarketLedgerReplay({store, accountIds, readHistory, now})`
  calls only read methods. `accountIds` must come from the current application
  allowlist, not a client-supplied arbitrary account.
- `publishReviewedPredictionMarketLedgerReplay({preview, reviewedPreviewHash,
  authorizedAccountIds, store, readHistory, onBeforeAccountWrite,
  onAfterAccountWrite})` is deliberately not exposed by the command line.

Publication requires an independently reviewed exact artifact hash, current
allowlist, unchanged source/ledger evidence, fixed-point reconciliation, and the
normal account capture lease. New lifecycle UUIDs from the reviewed preview are
preserved, not regenerated. It uses existing conditional version/create-only
writes and audit revisions; a completion marker is written only after all
lifecycle groups succeed. Repeating a completed publication returns its marker
without more writes. A partial publication requires a new inspected preview.

Never reclaim/reuse another reconciler's lease or force a failed condition. A
running API may legitimately own the lease. Preserve original reports and all
revision records, and verify the published historical projection separately from
current/open P&L before considering a repair complete.

## Rollout verification (September 11, 2026)

The private checkpoint contains source/ledger snapshots and successive reviewed
replay audits. Source reports and their hashes were preserved. The running
historical endpoint publishes 38 verified results: 14 S&P, 6 Gold, 15 CPI and 3
WTI. The financial audit includes fees, partial exits and settlement postings;
it distinguishes exact reconciliations, explicit fee-allocation conventions and
an unchanged official settlement with a remaining broker-tape limitation.
The final `ledger-replay-preview-v8-post-order-fix.json` audit proposed zero
writes against the actual ledger and passed both immediate and one-minute
persisted repeat-run checks, with no duplicate targets or monetary differences.

Twelve quarantined evidence exceptions remain distinct from those results. They
include unmatched close postings, two residual cash-out representations whose
verified original economic lifecycles already display, two execution-evidence
conflicts, and an unsupported silver identity. They are not twelve missing
settled contracts. Coverage remains partial; table and Overview show verified
subtotals and never turn missing history into zero.

Historical browsing was checked in the running light-mode card: all history,
Gold/S&P filters, contract search, sorting, venue selection, Overview,
execution expansion/re-expansion, warm reopen and a full page reload. The cold
page's first card opening displayed saved results in the first observation
(the entire opening/inspection call took under one second). Local React
render-to-commit samples were approximately 2 ms for search/sort, 7–14 ms for
market filters and 31 ms for reopen. These are render measurements, not a claim
about click-to-paint latency. Warm loopback history HTTP reads were 4–6 ms
(20 ms for the first sampled connection); the history handler reported 0–1 ms.

Regression tests cover provider-free history/details, offline and expired
current data, request deduplication, account revocation and response races,
revision replacement, failed-detail retries, source contradictions, FES date
schedules, and persisted replay idempotence. Recursive database map-key order
does not constitute new accounting evidence; array ordering and actual money
changes still do. Development-only bounded render diagnostics live on the
Contract P&L surface and contain no account or financial data.

Final validation: 329 Jest suites / 4,559 tests and 22 focused native Node tests
passed; the production build passed. Changed-file lint has no errors; existing
unused-symbol warnings and the existing large-bundle warning remain separate.

The sub-second cold-card observation above is **not** a guarantee during a full
server restart. Sampling the final managed restart exposed shared event-loop
stalls: history requests sometimes exceeded a three-second timeout even though
the historical handler itself measured 0–4 ms. Formatter reuse reduced several
hot background paths without changing dates, but the whole-server startup
acceptance remains open. Do not describe this remaining server-wide issue as a
history reconstruction or Gateway dependency in the new historical endpoint.
After the normal startup source refresh published its new source observation,
the saved generation and file modification time remained unchanged for more
than 110 seconds across background capture cycles. All 38 historical results
remained visible; current rows appeared independently when available.
The final read-only native profile confirmed that repeated formatter
construction was gone, while date parsing, sorting and garbage collection in
HTTPS-response processing still occupied the API thread. Concurrent portfolio
and multi-region quote requests also stalled. A JavaScript-level CPU profile or
bounded startup processing spans are the next diagnostic checkpoint; another
unattributed refactor would not be a justified fix.
