# Market Dashboard refinement — September 4, 2026

This refinement preserves the local dashboard's portfolio, research, prediction-market, Analyst and operational workflows. Broker access remains read-only. Cloud resources were not deployed or modified by this work.

## Baseline and recovery

The starting checkout was `codex/hermes-gmail-resilience` at `593f055`, with 553 existing uncommitted changes. Those changes are part of the baseline, not changes attributable to this refinement. A private archive, SHA-256 manifest, Git status and binary patches preserve the complete tracked and untracked baseline under:

`~/Library/Application Support/market-dashboard/refinement-checkpoints/20260904T210430Z/`

An integrated checkpoint is retained at `20260904T214626Z-integrated` under the same directory. These are recovery checkpoints, not deployed releases. The final verified checkpoint is `20260904T224407Z-final`; it contains `refinement-only.patch`, a complete source archive, SHA-256 manifest and verification evidence. The patch compares against the preserved working-tree baseline, not HEAD. Runtime environments are also retained when their replacements are promoted. Do not reset the repository to HEAD to undo this refinement; that would discard pre-existing work.

## Implemented changes

| Area | Result and important boundary |
| --- | --- |
| Local access | UI, API and sidecars use loopback. HTTP and WebSocket boundaries validate client address, literal Host/port, approved browser Origin and fetch metadata. The real Vite proxy preserves Origin; forwarding headers cannot authorize a request. Existing local service authentication is retained. |
| Streaming | Frames, message rates, connections, subscriptions and pending output are bounded. Subscription ownership is counted per client; empty replacements and closing one tab preserve other owners. Streams reconcile generations and recover after clean EOF, errors and sidecar restarts. |
| Quote contract | Runtime validation includes source and receipt times, original expiry, requested and qualified instrument identity, explicit account/market scope, provider generation, data type, entitlement and rejection reason. Cache reads and API/WebSocket delivery revalidate the envelope. Numeric coercion cannot turn booleans or containers into prices. |
| Failed refreshes | Any failed executable/account refresh clears current data immediately, including generic network and timeout errors. Only explicitly validated, dated informational projections can remain. These projections cannot restore an executable book. |
| CPI sizing | Worst-case payoff includes all held/proposed thresholds and both tails, including thresholds outside the displayed ladder. Unknown terms produce incomplete risk. Missing probability coverage cannot authorize sizing. |
| Exposure Lab | Returns are paired by matching start/end intervals. Identical economic exposures are combined before residual variance, so splitting or offsetting a holding does not fabricate risk. |
| Legacy data | Fabricated Performance, benchmark, options, currency, volatility, liquidity, factor, scenario and macro/nowcast defaults were removed. Verified holdings and dated realized results remain; missing inputs are unavailable, distinct from zero. |
| Persistence | Remaining statement, holdings, snapshots, notes and legacy performance/aggregate reads follow pagination. AWS SDK v3 adapters preserve legacy request promises, DynamoDB serialization/cursors, temporary credentials, presigned-post conditions and buffered S3 reads with size limits. |
| Startup | Core services start independently of optional Analyst verification. A generation-bound supervisor/API gate closes Analyst access when verification or dependencies fail. Process-discovery timeouts preserve uncertain ownership instead of crashing the supervisor or spawning duplicates. Inconclusive inspection cannot authorize controller restarts, even through an older persisted incident; incidents must still match the current recovery policy. |
| Sustained work | Verified quote cache hits return immediately; overlapping misses are coalesced with bounded concurrency. Inactive panels stop their polling and timers while retaining interaction state. Chart geometry is separated from countdown/status rendering. Date formatters and deterministic yearly calendars are reused within bounded private caches. Flex statements are decoded once and indexed by account to avoid repeated tree walks; no statement-response or executable-data retention was added. |
| UI resilience | Panel error boundaries leave navigation usable. Closed utilities load lazily, and preloading follows restored panels or user intent. Dropdown keyboard behavior, focus restoration, shared modal scroll ownership, Systems dismissal and timestamp/age presentation were improved. |
| PDF processing | Native parsing runs in disposable processes with bounded admission, geometry, input/output, memory and time. Cancellation kills and reaps workers. Credentials, embeddings and storage stay in the parent; native diagnostics cannot corrupt the worker response protocol. |
| Toolchain | Vite replaces CRA/CRACO while preserving React 18, aliases, port 3000 and hot reload. First-party browser CommonJS is transformed deliberately and unsupported forms fail clearly. Public environment settings are explicitly allowlisted. Jest and Node-owned tests are separated. Quill 2 replaces the obsolete React Quill/Quill 1 wrapper. |
| Verification and release | Node and isolated Python dependency environments are pinned. Local checks, CI and tested-release receipts use `ops/verification.json`. Pull requests no longer automatically deploy the local frontend to S3. Existing staged cloud ingestion releases remain available. |

The CRA and AWS migrations follow their upstream lifecycle changes: [React's CRA retirement announcement](https://react.dev/blog/2025/02/14/sunsetting-create-react-app) and [AWS SDK v2 end-of-support documentation](https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/).

## Validation evidence

| Check | Result |
| --- | --- |
| Complete Jest run | 260 suites / 3,288 tests passed; original review had five failing suites. |
| Node contract runner | 253 tests passed, including the persisted controller-policy regression. |
| Promoted IBKR Python 3.11 environment | 184 tests passed. |
| Promoted Analyst Python 3.11 environment | Ruff undefined-name check and 94 tests passed. |
| Infrastructure | Complete suite: 476 tests run, one skipped; suite passed. Updated release-receipt regression: 11 passed. Generated contract and SAM validation passed. |
| ESLint | Zero errors, 140 warnings. The original review reported 439 errors. Remaining warnings mainly concern existing unused declarations and hook dependencies. |
| Dependencies | Clean isolated `npm ci` passed. Final npm audit: zero known vulnerabilities. Full installed IBKR (25 packages) and Analyst (89 packages) pip-audit runs, including build tools: zero known advisories. Both promoted environments pass `pip check`. |
| Production build | Passed; main JavaScript 273.15 kB gzipped versus the reviewed 353.09 kB, about 22.6% smaller. Large-chunk warnings remain. Development measurement code is absent from the production output. |
| Local boundaries | 24 actual running-stack HTTP probes passed across UI proxy, API and both Python sidecars. Actual Vite tests also verify API WebSocket and HMR rejection, including hostile/null origins, rebinding authorities, spoofed forwarding headers and combined approved-Origin/cross-site metadata. |
| Embedding compatibility | Three fixed synthetic texts produced identical 384-dimensional embeddings in FastEmbed 0.7.4 and 0.8.0, using the existing cached BGE model offline. CPU inference is selected explicitly to preserve the prior device behavior. |

Regression tests cover stale/unknown quotes, failed refreshes, account/generation changes, shared subscriptions, empty updates, clean EOF, malformed values, CPI outside-ladder thresholds, incomplete terms, missing return sessions, split/opposing exposures, worker resource limits, lifecycle ownership and UI focus/resource retention.

Build-tool auditing also found a Setuptools issue affecting exclusion rules while creating source distributions on macOS. The environments and reproducible bootstrap now use 83.0.0, which includes the [upstream normalization fix](https://setuptools.pypa.io/en/stable/history.html#v83-0-0). This was a packaging-tool issue, separate from dashboard request handling.

Browser checks exercised Balance opening/reopening, genuine Contract P&L, Exposure Lab, Systems closing/Escape and navigation focus restoration. A failed lazy import during an earlier stack interruption was contained by its panel boundary; navigation remained usable and a reload recovered the panel. No orders, Analyst prompts or cloud deployments were sent for browser validation.

## Measurement method and limits

The original review measured an initial JavaScript payload of approximately 353.09 kB gzipped. The local UI/API became unavailable before a comparable original browser profile was captured. There is therefore no defensible before/after browser CPU, heap, panel-opening or cold-start speedup ratio.

The opt-in development probe at `/?measure=1` records request categories, navigation paint timing, React commit duration, long tasks, retained DOM and heap where supported. Panel click measurements end after two animation frames; they are not a claim that all remote data has loaded. React duration is not total JavaScript CPU. Development instrumentation, concurrent work, warm caches, browser garbage collection and external provider latency affect observations.

A 5,000-event within-process benchmark of the research date-formatting path improved from 824.4 ms to 77.8 ms with identical complete JSON results across the DST fixture. This isolates formatter reuse; it does not establish an application-wide speedup.

A source-attributed Node CPU profile then identified repeated holiday generation and Flex XML processing. The pure calendar comparison covered 54,056 date checks from 1990–2026: 533.5 ms before versus 36.3 ms after, with identical decisions and annual holiday lists. A synthetic 10.8 MB, two-account Flex statement containing 8,000 executions parsed in 3,464.7 ms before versus 1,897.5 ms after; complete output hashes matched. These benchmarks isolate deterministic computation and do not alter network fetches, account/date filters or data freshness. The temporary local inspector was closed after profiling.

The promoted stack returned its first API HTTP 200 after 10.47 seconds and UI HTTP 200 after 10.62 seconds from LaunchAgent bootstrap. Analyst liveness followed at 12.08 seconds and IBKR sidecar liveness at 13.95 seconds. Optional Analyst deep verification completed around 38 seconds after supervisor launch; core access did not wait for it. Liveness does not assert that an upstream broker session is connected.

In the final browser cohort, DOMContentLoaded was 372.9 ms. Click-to-next-paint observations were Balance 26.6 ms on first opening and 29.9 ms on repeat, Contract P&L 28.0 ms, Systems 29.9 ms and Exposure Lab 23.7 ms. A reversible stylesheet edit produced a Vite hot update with 0.7 ms from update application to paint, without a document reload.

At 373 seconds, the probe recorded 805 React commits totaling 13.60 seconds, 12 long tasks totaling 736 ms, 2,836 DOM nodes, three active surfaces and four retained inactive surfaces. Heap observations were 56.38 MB at 175 seconds, 71.22 MB at 228 seconds and 69.04 MB at 373 seconds (decimal MB). These short, unforced-GC samples do not establish a long-term memory bound. Contract P&L made one request; the count stayed at one for more than five minutes after closing it. Core monitoring and the active CPI panel continued requesting their own data. No Vite error overlay or panel alert was present at the end of that cohort.

The running IB Gateway displayed “Connection to server failed: Server disconnected, please try again.” Its port remained open, but read-only API session establishment timed out. The same error class was present before promotion. The dialog was left untouched; broker-backed executable data remains unavailable until the Gateway session reconnects. Analyst was verified available independently.

After the final controlled restart, a 40.50-second profile of one unchanged API process measured 10.279 CPU-seconds (25.4% of one core) and approximately 74.6% sampled idle time. All 20 health probes succeeded: median 5.27 ms, p95 220.66 ms and maximum 655.10 ms. Calendar normalization's inclusive sampled weight fell from 8.307 seconds in the earlier profile to 0.335 seconds; Flex parsing did not occur in this later window, so its runtime improvement cannot be inferred from that comparison. Natural traffic and startup warmth differed. Intermittent latency remains; ForecastEx reference parsing was the largest remaining sampled source cost. The final inspector port was verified closed.

## Remaining boundaries

- This is a trusted single-Mac application. Loopback and browser trust checks do not authenticate other processes already running as the local user.
- PDF workers contain failures and resource exhaustion, but are not an OS filesystem sandbox.
- Some large chart/application modules remain and should be split incrementally around measured use. Passing lint does not mean every existing warning has been eliminated.
- API latency still has intermittent bursts. Further work should target the measured ForecastEx parsing path and move large parsing jobs off the request thread where justified; this pass does not establish a latency SLA.
- Dependency audits report known published advisories at the time of the check; they are not a proof that software has no vulnerabilities.
- Deployed AWS configuration, live order execution and cloud releases were not exercised. Broker access remained read-only. Short sustained-session measurements do not establish unattended multi-day behavior.
