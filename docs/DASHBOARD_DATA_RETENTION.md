# Dashboard session retention and non-destructive refreshes

The dashboard preserves readable reference context and fails executable data
closed. An eligible verified snapshot can remain mounted while its replacement
is in flight. What remains after a failed refresh depends on its declared
resource policy; a transport failure is never evidence that an old trading value
is live.

## Reload postmortem

The original refresh implementation applied the live trading fail-closed rule to
informational cards. It cleared the market, volatility, and correlation values
before or after a request failed. The first retention fix removed those clears
for requests within one JavaScript session, but a browser reload necessarily
recreated the in-memory store with no data. That produced a blank/loading window
on every hard refresh even though the API was healthy.

Informational cards that opt into persistence use a versioned, validated
`sessionStorage` snapshot as their reload bridge. The snapshot is revalidated
against its resource's provider-evidence and retention rules before the first
render. It is displayed as last-verified reference data while a refresh is
pending; it is never treated as live executable data. Persistence and retention
are configured per resource, not granted to every informational card.

## Required behavior

- Keep the last verified snapshot mounted while a refresh runs if its resource
  policy permits that reading to remain visible.
- Replace it atomically only after the new response passes validation.
- After any failed executable or account-scoped refresh, clear current data and
  dependent trading controls immediately. This includes HTTP errors, timeouts,
  transport errors, validation failures, offline providers and wrong scope.
- After a failed mixed refresh, clear the full live snapshot. Only its existing,
  validated reference projection may remain, with live books and sizing absent.
- Informational and dated-reference cards may retain eligible context after a
  failed refresh when their resource policy permits it, with explicit
  delayed/error state and original as-of provenance.
- The main dashboard asset-performance table retains each asset's last verified
  provider observation through partial responses, failed refreshes, provider
  disconnects, aging, and same-tab page reloads. Show retained readings with the
  shared `D` marker and their original provider and observation time; never
  advance their timestamps or label them live. Replace an asset's reading only
  when a newer verified observation arrives. Show dashes only when no verified
  observation exists. This exception never supplies execution, sizing, or order
  controls and does not permit fabricated observations.
- Show loading when an initial verification is pending, and unavailable when no
  safe value remains for the resource's declared role.
- Do not clear safe data before starting a replacement fetch. Clearing after
  failed verification or expiry is required for executable data.
- For resources with persistence enabled, a full page reload hydrates an eligible
  informational snapshot before the first render. Apply that resource's expiry,
  validation, and retention rules while refreshing it. The main asset-performance
  table demotes aging readings to delayed references instead of clearing them;
  other cards may require expiry or outage to clear the value. Retained context
  must never feed an executable surface.

Retention is limited to eligible informational/reference dashboard observations.
Freshness limits whether a reading is current; the resource's retention policy
separately determines whether it may remain visible as dated context. Live executable
resources—portfolio balances, positions, order tickets, sizing inputs, and
prediction-market quote ladders—fail closed after any failed refresh, on
provider disconnection, and when their freshness window expires. A retained dashboard value must not be promoted
into one of those surfaces.

The shared `useSessionResource` store supports this explicitly through
`retainOnRefreshFailure: true`. It keeps the data, marks availability as
`refresh-delayed`, and preserves the error for the UI to display. Reload
hydration is separately opt-in through `displayRole: 'informational'` and
`persistReferenceSnapshot`. The persistence option is rejected for executable
resources, so a new live resource cannot accidentally turn a stored value into
an order, sizing input, portfolio balance, or prediction-market quote. An
executable or account-scoped resource clears immediately on every failed
verification, regardless of whether the error has a provider-specific code.
Mixed resources retain only their validated reference projection after failure;
the previous full snapshot cannot remain executable until its ordinary TTL.

## Central policy registry

Every refreshable navigation surface must declare its resources in
`dashboardResourceRegistry.js`. Each definition owns the resource and scope
keys, classification, validation, authoritative observation time, polling
policy, storage eligibility, warmup eligibility, and (for mixed data) the only
projection that may be retained as a reference.

| Classification | Retention contract |
| --- | --- |
| `dated-reference` | Retain validated dated reports and history only where enabled by the resource policy. Same-tab restoration additionally requires storage eligibility and an as-of marker. |
| `informational-live` | Apply the resource's retention and storage settings. Retained context is a delayed reference with original provenance and must not feed trading logic. |
| `executable-live` | Never store or retain after any failed refresh, expiry, or invalidation. Clear unsafe cells and disable dependent controls. |
| `mixed` | Retain only a positive-list reference projection. Live books, bids, asks, positions, balances, account data, and sizing/order outputs are excluded. |

The `market-quotes` resource explicitly enables failure/expiry retention and
same-tab persistence for the main asset-performance table. In contrast,
`volatility` disables failure/expiry retention and storage, despite sharing the
`informational-live` classification. Classification alone does not establish a
card's retention behavior.

Development assertions reject session storage for executable or account-scoped
resources, stale retention for executable resources, and persisted mixed
resources without both a positive-list projection and a reference validator.
Scope is part of the resource key. Account and contract-generation changes use
new keys and invalidate the prior executable scope.

## Resource state machine

The shared store exposes five stable display phases:

- `first-load`: no validated current or retained reference exists.
- `ready`: the current response is validated and safe for its declared role.
- `refreshing-with-data`: a replacement is in flight while the existing safe
  snapshot remains rendered.
- `delayed-reference`: only last-verified informational context may be shown.
- `unavailable`: no safe value exists for the declared role.

Refresh commits are atomic. A response is validated, checked for forbidden
cache/mock/seed/offline evidence, projected when required, and only then swaps
the existing snapshot. `ResourceDataStatusChip` adapts this state to live,
refreshing, delayed/as-of, and unavailable UI, including the observation time and
latest refresh error in its accessible tooltip. The main asset-performance table
uses the shared row-level `D` marker for retained observations.

## Same-tab persistence

The persisted envelope is versioned and bound to the exact resource key, scope
key, classification, projection version, and expiry. Parsing or validation
failure deletes only that corrupt record. Unavailable storage and quota errors
are non-fatal and fall back to the in-memory store.

Only informational projections are written. The following must never appear in
session storage:

- account identifiers, balances, portfolio positions, or account P&L;
- prediction-market books, bids, asks, depth, or live position overlays;
- sizing calculations, order drafts, eligibility, or executable controls;
- mock, seeded, synthetic, inferred, portfolio-derived, or wrong-scope data.

A hydrated value always renders as a reference and revalidates when its surface
and browser document are eligible for work. It cannot be promoted into executable state without a new,
validated live response.

## Persistent surfaces

`PersistentSurface` mounts a surface on first use and hides it without
unmounting. Hidden surfaces use `hidden`, `aria-hidden`, and `inert` and publish
inactive state through `useSurfaceActivity`, allowing non-core polling,
observers, timers, and global listeners to pause. The dashboard, Process overlay,
top-level cards, nested views, Balance, Contract P&L, and each individual
prediction market retain their own instances. Component state and
scroll positions therefore survive close/reopen without any storage of
sensitive drafts.

When a hidden poller resumes, it waits only for the unelapsed portion of its
existing interval. Reopening a surface does not itself create a request while
its retained value is still valid; missing, expired, invalidated, scope-changed,
or explicitly refreshed data remains eligible for an immediate request.

Browser-document hiding also pauses the core portfolio, quote, navigation-status
and provider-status polling loops. Deferred first loads wait for visibility too.
On return, active polling resources refresh once immediately; duplicate visible
events do not create extra requests. Expiry timers remain active so old executable
values and Systems health cannot stay marked current while the document is hidden.
The Systems core snapshot expires after 30 seconds and shows its original check
time until explicitly refreshed. Its login checks continue only while visible.

Each persistent surface contains render and lazy-load failures locally, with a
retry and dashboard reload action. Navigation surfaces manage keyboard focus on
open and return it to their launcher on close, without stealing focus from a
newer stacked panel. Embedded cards keep their existing focus behavior. Shared
scroll locks are reference-counted; closing one overlay cannot unlock another.

Do not reset a persistent surface merely because it became inactive. Valid
reset reasons are an explicit user reset, an account/scope change, an
incompatible contract generation, or a genuine live-data invalidation.

## Idle warmup

After the visible dashboard settles, the idle queue automatically warms only
restored panel state. Other eligible chunks and provider-pure informational
resources are enqueued on navigation focus, pointer intent, or panel opening.
Startup does not preload every monitor or utility panel. Balance and Contract
P&L are lazy-loaded like the other navigation panels.

The queue is capped at two concurrent tasks, runs each key once per page load,
promotes intended tasks, and reuses the central store's in-flight request. It
pauses while the document is hidden or the browser is offline and starts no
recurring hidden polling.

Executable/account resources, forced refreshes, order and sizing endpoints, and
requests that initiate provider work are rejected. Prediction-monitor warmup is
allowed only for the existing read-only coordinator snapshot route; the stored
result is its sanitized reference projection.

## Retained legacy components

`TickerTape` and `USDProxies` have no current importers. `VolatilityPanel` is
imported only by the currently unmounted `ResizableBottomPanels`. They remain
available as components, but all random series, prices, percentage changes,
and fallback metric constants have been removed. Supplied quotes require an
exact instrument, known provider, valid observation date, and no mock, stale,
cache-only, inferred, or disconnected evidence. They display as dated reference
observations. Historical charts use exact-symbol API records and show their
actual observation dates; insufficient history leaves comparison metrics blank.
Unconfigured volatility indices remain selectable with an unavailable state.

The legacy `PortfolioAnalytics` service is reached by the API client's old
snapshot/holdings envelope branch, not by the current direct local portfolio
response. It preserves supplied totals and position-size calculations. Risk,
drawdown, liquidity, sensitivities, factor weights, and scenario outcomes now
remain null where the required verified history or model inputs are absent.
No cross-sectional gain/loss proxy, random days-to-exit, or fixed allocation is
presented as a measured account statistic. Missing daily change stays null.

`MacroSignalsCard` is imported by the legacy prediction-markets module but is
not rendered by current navigation. Missing or failed signal inputs now show
unavailable; its demo rows and hardcoded inflation-nowcast fallback were
removed. Supplied nowcasts retain their publication date and release date.
The old duplicate nowcast filename forwards to the same guarded component.

## Rollback and test requirements

The feature is UI-only and controlled by
`REACT_APP_DASHBOARD_SESSION_RETENTION`. It is enabled unless the value is
exactly `false`; setting it to `false` disables new retention, persistence, and
warmup behavior without changing any backend, API, sidecar, or service.

Every refreshable dashboard resource needs regression coverage for in-flight
retention, failed refresh, atomic replacement, and its invalidation boundary.
Persisted resources additionally cover hard-refresh hydration, corruption,
wrong scope, forbidden provenance, expiry, and unavailable storage. Persistent
surfaces cover one initial mount, retained child and scroll state, inactive work
shutdown, focus restoration, and instant reopen. Warmup covers concurrency,
priority, cancellation, deduplication, intent-only startup, and executable/forced
exclusions. Failure tests cover generic HTTP/transport/timeout errors as well as
explicit provider errors, including removal of live books from mixed monitors.
