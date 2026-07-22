# Dashboard morning checklist

Run this from the market-dashboard repository:

```bash
npm run morning
```

This safely starts missing repo-owned UI, API, sidecar, and outbound bridge
processes, then runs the same live readiness checks shown by the dashboard's
**SYS** button. If an owned API is serving an obsolete readiness contract or
its boot fingerprint no longer matches the current source, the command
restarts the owned stack once and validates it again. It will not sign in to IB
Gateway, alter AWS/Gmail configuration, kill an unknown process, or claim
stale/cache-only trading data is live.

For a strictly read-only check:

```bash
npm run morning:check
```

For automation or troubleshooting output:

```bash
npm run morning -- --json
```

## What must pass

- Dashboard UI and Express API answer on their expected local ports.
- The API and supervisor boot fingerprints match the current readiness source;
  an old-but-responsive process fails with `DASHBOARD_CODE_VERSION_DRIFT`.
- The IBKR sidecar is alive, its Python invocation and environment prefix come
  from this workspace, and its application and dependencies resolve here. (A
  macOS virtualenv's Python binary may itself symlink to the system framework.)
  An old/global environment fails with `RUNTIME_DRIFT` even if port 8765 responds.
- IB Gateway is authenticated, API socket access is enabled, and managed accounts are visible.
- The sidecar verifies a fresh live IB socket and every managed account through `/portfolio/live-positions`; zero open positions is a valid live result.
- Each Hermes worker has its own cadence-appropriate row in `MarketDashboardServiceHeartbeats`. The row must carry the owned Scheduler job ID and `aws-scheduler` trigger provenance; manual invocations and shared metrics from the consolidated worker Lambda are never treated as proof that a specific agent remains scheduled.
- The supervisor-owned, outbound-only Hermes snapshot bridge is running from this repository and has a fresh successful publish heartbeat. It opens no inbound port.
- The configured Gmail account has a fresh successful service heartbeat; OAuth-required state remains an explicit manual fix.
- The current prediction release has fresh native venue quotes for display.
- Separately, the IBKR prediction catalog contains a current executable contract with verified native conId, exchange, trading class, expiry, ContractDetails provenance, native YES/NO side, and fresh IB bid/ask; a failure here disables order entry without misreporting Kalshi display data as down.
- If IB returns no supported/entitled current-release product, execution readiness reports `UNSUPPORTED_OR_NOT_ENTITLED`; this is distinct from Gateway login, sidecar, and quote-freshness failures.
- RTA, ETF Pro, and Hedgeye research workflows expose their own availability and freshness.

Every failed or warning check includes its impact and the exact recovery command or manual action. Resolve actions in the order printed, then rerun the checklist.

The canonical capability, ownership, dependency, cadence, AWS identifier,
runbook, blocking policy, and recovery inventory lives in `ops/services.json`.
Both the API and morning CLI use it to collapse downstream symptoms into
unique root causes.

## Status semantics

- **Blocked** — dashboard core or live-portfolio capability failed. Do not use portfolio data.
- **Degraded** — core and live portfolio remain available, but an ancillary capability such as automation, prediction markets, or research is incomplete.
- **Ready** — every check passed. `fullyOperational` is true only in this state.

The report also includes `operational`, `fullyOperational`, `capabilities`, and `rootCauses` while preserving the version 1 fields consumed by existing clients.

## Safe repair actions

Checks may advertise an automatic repair only when its action ID is present in the manifest allowlist. `POST /api/system-readiness/actions/:actionId`:

- accepts requests only from the machine's loopback socket;
- requires the `X-Readiness-Repair: 1` confirmation header;
- maps the action ID to a fixed executable and fixed arguments;
- never accepts shell text, arbitrary arguments, credential changes, Gmail authorization, or IB Gateway login; and
- permits only six fixed repairs: start the local stack, restart the repo-owned
  local stack, rebuild the workspace sidecar runtime, retry the configured
  Gmail incremental poll, rebuild deterministic 90-day RTA projections, and
  reconcile the server-owned current CPI catalog.

Restart and runtime rebuild run through fixed delayed helpers so the API can
acknowledge the request before replacing itself. Gmail retry invokes only the
configured ingestion Lambda with a fixed incremental repair event; that manual
heartbeat cannot masquerade as scheduler proof. Projection rebuild and CPI
catalog reconciliation use fixed server-owned inputs. Gmail credential changes,
OAuth authorization, IB Gateway login, arbitrary processes, and caller-supplied
command arguments remain manual and unavailable through this endpoint.

## Exit codes

- `0` — ready
- `1` — usable but degraded
- `2` — a required capability is blocked
- `3` — the readiness report itself could not be collected or validated

`GET /api/health` remains a process-liveness probe. `GET /api/system-readiness` is the operational source of truth.

The login LaunchAgent runs the repository supervisor. The supervisor adopts
only processes whose command and working directory match this repository,
checks adopted and spawned services continuously, applies bounded exponential
restart backoff, and retries noncritical services after a five-minute circuit
cooldown. Unknown listeners are reported and never terminated. When the
LaunchAgent is loaded, CLI and readiness repairs restart it through
`launchctl kickstart` so recovery does not silently replace login supervision
with an unmanaged detached process.

On macOS, Desktop, Documents, and Downloads are protected folders. If this
repository remains under one of them, the LaunchAgent installer fails closed
and unloads a stalled job when the Node runtime lacks that folder grant. Grant
Files & Folders access (or Full Disk Access) to the exact Node executable named
by the installer, then rerun `npm run ops:launchagent:install`; moving the
repository to an unprotected development directory is the other durable
option.
