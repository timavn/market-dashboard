# Market Dashboard

A local Mac workspace for portfolio monitoring, market research, prediction-market analysis, and operational checks. React 18 renders the dashboard; a local Express API coordinates IBKR, research providers, AWS storage, and optional Analyst services. Broker access is read-only.

## Capabilities

| Area | Purpose | Main implementation |
| --- | --- | --- |
| Market backdrop | Market pulse, volatility, currencies, correlations, published research and macro context | `src/components/Dashboard`, `src/services/providers` |
| Portfolio and Exposure Lab | Verified account balances and positions, factor exposure, interval-aligned risk analysis | `src/services/ibkr`, `src/utils/exposureLabFactorRisk.cjs` |
| Prediction markets | Venue-native ladders, resolver identity, dated context, CPI and other strategy sizing | `src/services/predictionMarketTest`, `src/utils/*StrategySizing*` |
| Contract P&L | Evidence-backed historical positions, executions and realized results | `src/services`, `infra/prediction-market-performance-ledger.yaml` |
| Research | Hedgeye publications, immutable artifacts, canonical event ledgers and validated projections | `infra`, `src/services`, `docs` |
| The Analyst | Optional local research chat, indexing and isolated PDF processing | `src/routes/analyst.cjs`, `scripts/analyst_sidecar`, `scripts/analyst` |
| Systems | Timestamped readiness, typed failures, ownership and bounded repair operations | `src/routes/systemReadiness.cjs`, `scripts/dev-stack`, `ops/services.json` |

Unavailable input is distinct from zero. Historical results and delayed market context remain explicitly dated; they do not authorize live sizing or substitute for executable quotes. Retired Performance, benchmark, options and volatility paths return unavailable states where verified inputs do not exist.

## Local architecture

```text
Browser at localhost:3000 (Vite + React + hot reload)
    └─ /api and /ws proxy → Express at 127.0.0.1:3001
          ├─ IBKR sidecar at 127.0.0.1:8765 → local IB Gateway/TWS
          ├─ Research/provider adapters → approved external sources
          ├─ AWS SDK v3 adapters → existing S3, DynamoDB and operational services
          └─ Optional Analyst gate → local Hermes + sidecar at 127.0.0.1:6951
```

`scripts/dev-stack/cli.js` owns local lifecycle and process identification. It starts core services independently of optional Analyst services. Analyst contract verification runs asynchronously and grants access only for the current verified service generation. Lost verification closes Analyst access without restarting the API.

UI, API and Python sidecars listen on loopback. Request boundaries check socket address, exact Host/port, browser Origin and cross-site fetch metadata before routes or upgrades. The Vite proxy preserves Origin and does not inject wildcard CORS. Local CLI/service callers without browser Origin remain supported; existing service authentication still applies. The trust model assumes processes on this Mac are trusted—it does not make this a multi-user remote service.

## Start and develop

Use Node **22.23.0** (`.nvmrc`) and npm 10. New isolated Python environments use Python 3.11 or 3.12. Install the AWS CLI and configure the repository's approved profiles; do not put credentials in browser settings.

```sh
nvm use
npm ci
node scripts/testing/verify.cjs setup-ibkr
node scripts/testing/verify.cjs setup-analyst  # optional for daily core use
npm start
```

Open **http://localhost:3000**. `npm start` and `npm run dev` use the same supervisor. Source edits update the UI through Vite; configuration/service edits may require a supervisor-managed restart. Fast Refresh retains component state where possible; mixed component/helper exports can propagate refresh to a parent.

For live account data, log into IB Gateway/TWS and enable its local read-only API socket. AWS profiles, broker sessions and Analyst model access may require a manual login; the corresponding capability stays unavailable until its dependency is ready.

```sh
npm run dev:status       # ownership and readiness
npm run dev:doctor       # diagnose the local stack
npm run dev:restart     # restart known repository services
npm run dev:stop
npm run auth:status
npm run morning:check   # read-only morning checks
```

Use `npm run dev:ui` only when running the UI independently of the supervisor. It keeps port 3000 and loopback binding; `npm run dev:api` serves port 3001. Avoid duplicate stacks or killing unknown port owners. Logs are under `~/Library/Logs/market-dashboard/`.

## Data and ownership contracts

The quote boundary carries source time separately from receipt time, expiry, instrument/account identity, provider generation, data type, entitlement evidence and rejection reasons. `src/services/providers/normalize/quoteContract.cjs` validates the observation envelope, while `quoteValidity.js` and `quoteObservation.cjs` validate prices and raw observations. Caches can reuse an observation within its original lifetime; they cannot renew its timestamp. API and stream delivery revalidate observations. A sidecar restart or account change cannot revive quotes from the prior generation.

`quoteRequestScheduler.cjs` coalesces overlapping instrument requests and bounds provider concurrency. Verified cache hits return immediately. `src/services/ibkr/quoteSubscriptions.cjs` tracks subscriptions per owner; one tab closing or submitting an empty list cannot unsubscribe another tab's instruments. Streams recover after clean EOF, timeouts and provider restarts.

`dashboardResourceRegistry.js` declares each UI resource's role and scope. `sessionResourceStore.js` clears executable/account data on **any failed refresh**, including generic HTTP, timeout and network errors. Mixed resources may retain only a validated reference projection with all executable books removed. Inactive panels preserve interaction state while polling and timers stop; executable expiry checks continue. See [data retention rules](docs/DASHBOARD_DATA_RETENTION.md).

CPI payoff risk evaluates held and proposed thresholds plus both tails, including contracts outside the visible ladder. Unknown terms produce incomplete-risk status. Exposure Lab compares matching return intervals and aggregates identical economic exposures before residual-risk calculation.

Native PDF parsing runs in disposable workers with bounded concurrency, input/output size, page geometry, CPU time, wall time and monitored memory. Credentials, embedding requests and storage operations stay in the parent service. These limits contain parser failures and resource exhaustion; the workers are not an OS filesystem sandbox.

## Build, tests and release

For small, behavior-preserving changes, see the [maintenance ownership map](docs/CODEBASE_MAINTENANCE.md),
[verified refinement milestones and known issues](docs/CODEBASE_IMPROVEMENT.md), and
[legacy/disuse inventory](docs/CODEBASE_LEGACY_INVENTORY.md).

```sh
npm run test:node
npm test -- --runInBand --watchAll=false
npm run lint
npm run build
npm run verify:local
```

Production output is written to `build/`. Vite preserves local Tremor and Lucide aliases. Browser-reachable first-party CommonJS is deliberately transformed by `scripts/build/local-commonjs.mjs`; unsupported dynamic CommonJS fails the build. `vite.config.mjs` explicitly allowlists public settings instead of exposing the environment.

Jest owns UI and Jest-style service tests; Node's runner owns tests importing `node:test`. Both match runtime aliases. Python sidecars have separate `.venv` paths and checked-in dependency constraints. Prepare clean test environments with the `setup-ibkr` / `setup-analyst` verification groups. Analyst checks include Ruff's undefined-name check before its unit tests.

For an existing supervised Mac installation, stop the LaunchAgent before rebuilding environments: boot out `gui/$(id -u)/com.market-dashboard.stack`, run `npm run dev:stop`, and verify the dashboard listeners and repair helpers have stopped. Run `npm run dev:sidecar:rebuild` and `npm run dev:analyst:sidecar:rebuild`, then the `ibkr` and `analyst` verification groups. Bootstrap the existing `~/Library/LaunchAgents/com.market-dashboard.stack.plist` only after they pass. Rebuilt environments stay at permanent `.venv.runtimes/runtime.*` paths, with `.venv` pointing to the selected runtime; the previous runtime is archived. Keep those runtime directories while their pointers exist. This preserves installed script and activation paths and permits rollback without reinstalling.

`ops/verification.json` is shared by local checks, CI and tested-release receipts. JavaScript, each Python sidecar, generated contracts, infrastructure tests and SAM validation are separate checks. `infra/scripts/prepare_tested_release.py` prepares the controlled cloud release from a clean exported revision. PRs verify changes; they no longer deploy the local frontend to S3. Cloud ingestion and its staged release process remain in place.

For an opt-in development measurement session, open `http://localhost:3000/?measure=1`. The hidden `#dashboard-performance-probe` output records aggregate request counts, React render durations, navigation paint latency and HMR timings. It records no market values or account data. Unsupported heap/long-task measurements are identified. Reload without the query to remove observer overhead. The probe is excluded from production builds.

## Troubleshooting

- A failed panel should leave navigation usable; close/reopen or use its retry control. Inspect UI/API logs for lazy-module failures after source updates.
- Requests must use `localhost` or `127.0.0.1` with the correct port and an approved local Origin. Do not restore wildcard CORS or `0.0.0.0` binding to bypass validation.
- Missing live quotes: check broker connectivity, account, entitlement, timestamp and generation. A dated close cannot repair missing live data.
- Missing Analyst: inspect its availability reason and contract verification. Core dashboard access should remain usable.
- Expired Systems checks are historical observations, not current health. Refresh and inspect the typed failure.

See [morning workflow](docs/DASHBOARD_MORNING_CHECKLIST.md), [read-only broker boundaries](docs/IBKR_READ_ONLY_BOUNDARIES.md), [Exposure Lab](docs/EXPOSURE_LAB.md), [prediction catalog](docs/PREDICTION_MARKET_CATALOG.md), [The Analyst](docs/THE_ANALYST.md), and [refinement validation](docs/REFINEMENT_2026-09-04.md).
