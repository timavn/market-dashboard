# The Analyst consolidation runbook

This release prepares the retirement of the legacy Quant Analyst, Quant Developer, and Security workers. It does **not** bypass the seven-day shadow gate and it does not delete any rollback resource. The current acceptance record is [THE_ANALYST_SHADOW_ACCEPTANCE.md](./THE_ANALYST_SHADOW_ACCEPTANCE.md).

## Resulting ownership

| Concern | Owner after cutover | Automatic? |
|---|---|---|
| Cited research, briefing, history, and portfolio comparison | The Analyst | On demand only |
| Gmail ingestion and research indexing | Research pipeline | Yes |
| Portfolio and current quote verification | IBKR readiness | Yes |
| Fixed local recovery actions | System Readiness controller | Yes, allowlist only |
| Cloud schedule, alarm, and heartbeat monitoring | Cloud watchdog | Yes |
| Development, security review, or arbitrary repair | No Analyst tool | No |

The Analyst remains read-only and has no terminal, file-write, browser, delegation, cron, repair, account-control, or order tool. System Readiness is a separate dashboard surface.

## Compatibility modes

- `LEGACY_HERMES_MODE=shadow` is the default during acceptance. Legacy behavior remains available for comparison and rollback preparation.
- `LEGACY_HERMES_MODE=read-only` removes legacy fields from `/api/workflow-status`. The legacy director status GET remains available for rollback inspection, while director commands and alert actions return HTTP 410 with `LEGACY_HERMES_RETIRED`.
- `REACT_APP_ANALYST_SHADOW_MODE=false` places The Analyst in the former TL;DR position, removes the duplicate Analyst entry, and hides the Managing Director controls.
- `READINESS_CONTROLLER_MODE` and `READINESS_CONTROLLER_ENABLED_ACTIONS` are authoritative. The old Hermes-prefixed aliases are compatibility-only and must be removed in the day-30 release.

## Pre-cutover gate

Do not continue until all of these are true:

1. The shadow log contains five passing briefs and the three other required questions across at least seven calendar days.
2. Every acceptance checkbox is checked and the decision is explicitly `approved`, `pass`, or `accepted` with an ISO decision date and reviewer.
3. The Analyst contract, Codex-style blank/conversation flow, Gmail ingestion, indexing, cadence coverage, citations, PDF flows, hidden-idle behavior, reconnect, and degradation checks pass.
4. `market-dashboard-admin` is an authenticated AWS SSO profile with CloudFormation access.
5. A new private rollback export and an immutable tested-release receipt exist outside the repository.

The `consolidated` cloud phase and the local cutover utility both parse and enforce the shadow log. A blank, early, or incomplete log fails before mutation.

Prepare the rollback export with a new absolute destination that does not already exist:

```bash
export MARKET_DASHBOARD_ROLLBACK_EXPORT="/Users/timsmith/Library/Application Support/market-dashboard/rollback-exports/analyst-cutover-YYYYMMDDTHHMMSSZ"
infra/scripts/export_deployed_state.sh \
  --admin-profile market-dashboard-admin \
  "$MARKET_DASHBOARD_ROLLBACK_EXPORT"
```

The export contains checksummed CloudFormation parameters, Scheduler and alarm definitions, Lambda configuration/code, retained table inventories, and an allowlisted non-secret local bridge/controller snapshot. Any missing permission or ownership conflict blocks cutover.

Prepare the tested release from a clean committed revision using `infra/scripts/prepare_tested_release.py prepare`, then set:

```bash
export MARKET_DASHBOARD_RELEASE_RECEIPT=/absolute/path/to/tested-release-receipt.json
export MARKET_DASHBOARD_CF_ROLE_ARN=arn:aws:iam::915328198276:role/market-dashboard-cloudformation-deployment-v2
export MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET=market-dashboard-sam-artifacts-915328198276-us-west-1
```

## Cutover

Record one exact UTC cutover timestamp before the first mutation.

1. Apply the compatibility release and exact cloud control state. This keeps Gmail, the cloud watchdog, and operational alarms enabled, while forcing all three legacy worker schedules off. The worker Lambda remains deployed but enters `retired` mode before any write path.

   ```bash
   infra/scripts/activate_reliability.py \
     --phase consolidated \
     --apply \
     --admin-profile market-dashboard-admin \
     --cloudformation-role-arn "$MARKET_DASHBOARD_CF_ROLE_ARN" \
     --rollback-export "$MARKET_DASHBOARD_ROLLBACK_EXPORT" \
     --release-receipt "$MARKET_DASHBOARD_RELEASE_RECEIPT" \
     --shadow-acceptance docs/THE_ANALYST_SHADOW_ACCEPTANCE.md
   ```

2. Apply the local half. This switches legacy APIs to read-only, hides the old UI, disables all bridge partitions, preserves the readiness action allowlist under its new variable, reinstalls the LaunchAgent, and restarts the owned stack. It compensates back to the exported shadow settings if installation fails.

   ```bash
   npm run ops:analyst:local -- \
     --mode cutover \
     --apply \
     --rollback-export "$MARKET_DASHBOARD_ROLLBACK_EXPORT" \
     --shadow-acceptance docs/THE_ANALYST_SHADOW_ACCEPTANCE.md
   ```

3. Wait at least 75 minutes. Then run the read-only verifier with the exact timestamp captured above:

   ```bash
   npm run verify:analyst:consolidation -- \
     --cutover-at 2026-08-15T16:00:00Z \
     --admin-profile market-dashboard-admin
   ```

The verifier requires the single Analyst surface, generic readiness IDs, an intentionally disabled bridge with no PID, HTTP 410 legacy mutations, disabled worker schedules, zero post-cutover worker runs/heartbeats, a fresh Gmail heartbeat, a fresh watchdog heartbeat, retired worker mode, and non-breaching worker missing-heartbeat alarms.

Also rerun the live-data guard with IBKR disconnected. No current quote, market value, allocation, cost basis, or P/L may be present.

## Rollback during the 30-day window

Rollback immediately for citation-validation failure, live-data fallback, available-but-missing briefing products, persistent Analyst contract failure, or lost readiness coverage.

Restore local bridge/shadow state **before** restoring cloud worker schedules, because a restored Quant Analyst schedule requires fresh verified bridge input:

```bash
npm run ops:analyst:local -- \
  --mode rollback \
  --apply \
  --rollback-export "$MARKET_DASHBOARD_ROLLBACK_EXPORT"

infra/scripts/activate_reliability.py \
  --phase rollback \
  --apply \
  --admin-profile market-dashboard-admin \
  --cloudformation-role-arn "$MARKET_DASHBOARD_CF_ROLE_ARN" \
  --rollback-export "$MARKET_DASHBOARD_ROLLBACK_EXPORT" \
  --release-receipt "$MARKET_DASHBOARD_RELEASE_RECEIPT"
```

The cloud rollback restores the exact exported control parameters rather than assuming every schedule was enabled. Verify each schedule that was restored produces a genuine scheduled heartbeat.

## Day-30 decommission

Day 30 is a separate destructive release. Do not run it merely because cutover succeeded.

- Confirm the rollback-retention end date has elapsed and no rollback criterion fired.
- Export `HermesAgentRuns` and only the worker-owned `HermesAlerts` partitions.
- Confirm no readers or writers remain for `HermesInputSnapshots`, then export it.
- Remove the three Scheduler schedules, worker Lambda, worker-specific alarms and IAM grants, snapshot bridge, Managing Director code, worker-status code, legacy API routes, environment aliases, and obsolete tests/docs.
- Remove `HermesInputSnapshots` and `HermesAgentRuns` only after their final exports are verified.
- Retain `HermesAlerts` while the cloud watchdog still uses its separate partition.
- Retain Gmail, cloud-watchdog, service-heartbeat, research, Analyst, IBKR, and deterministic readiness resources.
- Do not rename shared physical AWS resources as part of decommission.

The compatibility release intentionally contains no day-30 deletion command.
