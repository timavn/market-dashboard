# Dashboard session retention and non-destructive refreshes

The front dashboard is a continuously readable work surface. A polling cycle
must never erase the last verified numbers merely because a replacement request
is in flight or failed.

## Reload postmortem

The original refresh implementation applied the live trading fail-closed rule to
informational cards. It cleared the market, volatility, and correlation values
before or after a request failed. The first retention fix removed those clears
for requests within one JavaScript session, but a browser reload necessarily
recreated the in-memory store with no data. That produced a blank/loading window
on every hard refresh even though the API was healthy.

Informational cards now use a versioned, validated `sessionStorage` snapshot as
their reload bridge. The snapshot is revalidated against the same provider
evidence and freshness rules before the first render, then immediately replaced
by the next verified response. It is always displayed as last-verified reference
data while a refresh is pending; it is never treated as live executable data.

## Required behavior

- Keep the last verified, still-fresh snapshot mounted while a refresh runs.
- Replace it atomically only after the new response passes validation.
- If a refresh fails, keep that snapshot visible and expose an explicit
  `refresh-delayed`/error state with its existing as-of provenance.
- Show a loading/empty state only when no verified snapshot has ever arrived.
- Never implement refresh logic as `setData({})`, `setRows([])`,
  `setSnapshot(null)`, or an equivalent clear-before-fetch operation.
- A full page reload must hydrate a valid informational snapshot before the
  first render, retain it while the replacement request is in flight, and clear
  it only when its freshness window expires or the snapshot itself is invalid.
  An informational card may retain a still-fresh value during an explicit
  provider outage, but it must show `refresh-delayed` and must never feed an
  executable surface.

Retention is limited to informational/reference dashboard cards and snapshots
that remain inside their authoritative freshness window. Live executable
resources—portfolio balances, positions, order tickets, sizing inputs, and
prediction-market quote ladders—continue to fail closed when their provider is
offline or the data is stale. A retained dashboard value must not be promoted
into one of those surfaces.

The shared `useSessionResource` store supports this explicitly through
`retainOnRefreshFailure: true`. It keeps the data, marks availability as
`refresh-delayed`, and preserves the error for the UI to display. Reload
hydration is separately opt-in through `displayRole: 'informational'` and
`persistReferenceSnapshot`. The persistence option is rejected for executable
resources, so a new live resource cannot accidentally turn a stored value into
an order, sizing input, portfolio balance, or prediction-market quote. An
executable resource still clears immediately on explicit offline, stale, cache,
or account-mismatch evidence.

## Central policy registry

Every refreshable navigation surface must declare its resources in
`dashboardResourceRegistry.js`. Each definition owns the resource and scope
keys, classification, validation, authoritative observation time, polling
policy, storage eligibility, warmup eligibility, and (for mixed data) the only
projection that may be retained as a reference.

| Classification | Retention contract |
| --- | --- |
| `dated-reference` | Retain validated dated reports and history through refresh failures. Restore them in the same tab with an as-of marker. |
| `informational-live` | Retain visual market context only inside its verified freshness window, then demote it to a delayed reference. It must not feed trading logic. |
| `executable-live` | Never store or retain after expiry or confirmed invalidation. Clear unsafe cells and disable dependent controls. |
| `mixed` | Retain only a positive-list reference projection. Live books, bids, asks, positions, balances, account data, and sizing/order outputs are excluded. |

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
the existing snapshot. `ResourceDataStatusChip` is the single adapter from this
state to live, refreshing, delayed/as-of, and unavailable UI, including the
observation time and latest refresh error in its accessible tooltip.

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

A hydrated value always renders as a reference and immediately revalidates in
the background. It cannot be promoted into executable state without a new,
validated live response.

## Persistent surfaces

`PersistentSurface` mounts a surface on first use and hides it without
unmounting. Hidden surfaces use `hidden`, `aria-hidden`, and `inert` and publish
inactive state through `useSurfaceActivity`, allowing non-core polling,
observers, timers, and global listeners to pause. The dashboard and secondary
routes are persistent siblings, as are top-level cards, nested views, Balance
and Contract P&L, and each individual prediction market. Component state and
scroll positions therefore survive close/reopen without any storage of
sensitive drafts.

When a hidden poller resumes, it waits only for the unelapsed portion of its
existing interval. Reopening a surface does not itself create a request while
its retained value is still valid; missing, expired, invalidated, scope-changed,
or explicitly refreshed data remains eligible for an immediate request.

Do not reset a persistent surface merely because it became inactive. Valid
reset reasons are an explicit user reset, an account/scope change, an
incompatible contract generation, or a genuine live-data invalidation.

## Idle warmup

After the visible dashboard settles, an idle queue preloads eligible chunks and
provider-pure informational resources. The queue is capped at two concurrent
tasks, runs each key once per page load, promotes a task when its panel opens,
and reuses the central store's in-flight request. It pauses while the document
is hidden or the browser is offline and starts no recurring hidden polling.

Executable/account resources, forced refreshes, order and sizing endpoints, and
requests that initiate provider work are rejected. Prediction-monitor warmup is
allowed only for the existing read-only coordinator snapshot route; the stored
result is its sanitized reference projection.

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
shutdown, and instant reopen. Warmup covers concurrency, priority, cancellation,
deduplication, and executable/forced exclusions.
