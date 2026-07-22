# Market Dashboard readiness infrastructure

This directory is the sole source for the v2 Gmail and Hermes runtime. The
template deliberately deploys with Gmail, Hermes, and alarm actions disabled;
rollout gates are enabled only after the preceding canary has passed.

## Security boundaries

- IB Gateway and the dashboard remain loopback-only. AWS never calls the Mac.
- `scripts/ops/hermes_snapshot_bridge.js` makes SigV4-authenticated DynamoDB
  writes outbound and has no inbound listener.
- The bridge uploads account hashes and position identity/quantity only. It
  does not upload account numbers, portfolio prices, tokens, or credentials.
- Workers reject stale, cached, delayed, mock, seeded, synthetic, fallback,
  inferred, historical, or non-IBKR portfolio provenance.
- Workers independently require the exact six-capability readiness contract,
  a ready `portfolio.live` gate, and fresh portfolio and Gateway-socket
  verification timestamps; the bridge's `ready` label alone is insufficient.
- Lambda async retries are zero. Expected readiness failures are typed
  heartbeats; unexpected runtime failures are delivered once to SQS.

## One-time administrator bootstrap

The currently configured `market-dashboard-local` IAM user intentionally does
not have deployment authority. An AWS administrator must:

0. Before changing any deployed resource, grant temporary read-only access and
   export the named Lambda packages/configuration and Scheduler definitions to
   a new private directory. Add any legacy function/schedule names through the
   documented comma-separated environment variables before running it:

   ```bash
   MARKET_DASHBOARD_EXPORT_FUNCTIONS="legacy-one,legacy-two,market-dashboard-gmail-ingestor-v2,market-dashboard-hermes-worker-v2" \
   infra/scripts/export_deployed_state.sh /absolute/private/path/readiness-rollback-YYYYMMDD
   ```

   The exporter refuses to overwrite an existing directory and writes SHA-256
   checksums for every rollback artifact.

1. Install AWS SAM CLI locally and create a private SAM artifact bucket.
2. Deploy `bootstrap/deployment-role.yaml` once with
   `CAPABILITY_NAMED_IAM`, passing the artifact bucket name.
3. Grant the operator only `cloudformation:*` operations for the
   `market-dashboard-readiness-v2` stack plus `iam:PassRole` for the resulting
   deployment-role ARN.
4. Attach `iam/local-bridge-policy.json` to a dedicated local bridge principal
   or equivalent assumed role. Do not give the bridge read access to DynamoDB,
   Secrets Manager, or Lambda.
5. Attach `iam/local-readiness-catalog-policy.json` to the local dashboard API
   principal. This separate policy permits typed heartbeat reads,
   release-keyed catalog queries/atomic replacement, canonical research-event
   queries, expected-date Risk Range reads, and read-only Lambda metrics. Do
   not attach it to the outbound bridge principal.
6. Export the role ARN as `MARKET_DASHBOARD_CF_ROLE_ARN` and run:

   ```bash
   infra/scripts/deploy.sh
   ```

The first deployment creates retained/PITR DynamoDB tables, no-retry failure
handling, SNS email subscription, runtime roles, disabled schedules, and
disabled alarm actions. Confirm the SNS subscription email before the final
rollout phase.

`ops/services.json` is also the source for Hermes worker IDs, heartbeat IDs,
cadences, Scheduler expressions/time zones, capability IDs, function name, and
table defaults. After changing that manifest, regenerate the Lambda-safe
artifact and run the infrastructure tests:

```bash
infra/scripts/render_hermes_contract.py
python3 -m unittest discover -s infra/tests
```

The deployment command runs the generator in `--check` mode and refuses to
deploy if the checked-in artifact, SAM schedules, worker constants, or alarms
have drifted from the manifest.

## Gmail production OAuth cutover

Google consent-screen changes and user authorization are manual security
actions and are never attempted by a repair endpoint.

1. In the Google Cloud project, set the consumer OAuth app to **External / In
   production** and retain only
   `https://www.googleapis.com/auth/gmail.readonly`.
2. Complete a fresh user consent flow with offline access and explicit consent
   to obtain a new refresh token.
3. Put `client_id`, `client_secret`, `refresh_token`, `user_id: "me"`, and the
   read-only `scope` in a mode-0600 JSON file outside the repository.
4. Atomically promote it:

   ```bash
   infra/scripts/promote_gmail_secret.sh /absolute/path/to/oauth-secret.json
   ```

5. Deploy with Gmail only enabled:

   ```bash
   GMAIL_SCHEDULE_STATE=ENABLED infra/scripts/deploy.sh
   ```

6. After at least four scheduled polls, require the canary to pass:

   ```bash
   infra/scripts/verify_rollout.py --phase gmail
   ```

An `invalid_grant` records `GMAIL_AUTH_REQUIRED` once and suppresses further
Google calls until the Secrets Manager version changes. The blocked circuit
checks Secrets Manager (but not Google) once per scheduled invocation so a new
version is detected immediately. Every poll, including zero-message polls,
records a heartbeat. Manual poll/backfill heartbeats use a separate service ID
and cannot satisfy scheduler readiness.

## Backfill and projection verification

After the Gmail canary passes, invoke one ordered backfill. The ingestor uses
immutable Gmail message IDs and processes oldest-first:

```bash
aws lambda invoke \
  --region us-west-1 \
  --function-name market-dashboard-gmail-ingestor-v2 \
  --cli-binary-format raw-in-base64-out \
  --payload '{"forceBackfill":true}' \
  /tmp/market-dashboard-gmail-backfill-result.json
```

Then use the loopback-only readiness repair actions to rebuild research
projections and verify the fresh RTA/ETF checkpoints and expected Risk Range
manifest. The active surface stays unavailable when the Gmail heartbeat is
unhealthy; dated books remain archival only.

## Hermes cutover

1. Install/restart the repo supervisor so the outbound bridge is running.
2. Confirm the bridge heartbeat and a ready `ibkr_live` input snapshot.
3. Enable the analyst schedule first:

   ```bash
   GMAIL_SCHEDULE_STATE=ENABLED \
   HERMES_QUANT_ANALYST_SCHEDULE_STATE=ENABLED \
   infra/scripts/deploy.sh

   infra/scripts/verify_rollout.py --phase hermes --worker quant-analyst
   ```

4. After three successful analyst cadences, preserve that state and enable the
   developer schedule. Repeat the three-cadence gate before enabling security:

   ```bash
   GMAIL_SCHEDULE_STATE=ENABLED \
   HERMES_QUANT_ANALYST_SCHEDULE_STATE=ENABLED \
   HERMES_QUANT_DEVELOPER_SCHEDULE_STATE=ENABLED \
   infra/scripts/deploy.sh

   infra/scripts/verify_rollout.py --phase hermes --worker quant-developer

   GMAIL_SCHEDULE_STATE=ENABLED \
   HERMES_QUANT_ANALYST_SCHEDULE_STATE=ENABLED \
   HERMES_QUANT_DEVELOPER_SCHEDULE_STATE=ENABLED \
   HERMES_SECURITY_SCHEDULE_STATE=ENABLED \
   infra/scripts/deploy.sh

   infra/scripts/verify_rollout.py --phase hermes --worker security
   ```

5. After three complete cadences for every worker:

   ```bash
   infra/scripts/verify_rollout.py --phase hermes
   ```

6. Enable alarm actions only after both canaries pass:

   ```bash
   GMAIL_SCHEDULE_STATE=ENABLED \
   HERMES_QUANT_ANALYST_SCHEDULE_STATE=ENABLED \
   HERMES_QUANT_DEVELOPER_SCHEDULE_STATE=ENABLED \
   HERMES_SECURITY_SCHEDULE_STATE=ENABLED \
   OPERATIONAL_ALARMS_STATE=ENABLED \
   infra/scripts/deploy.sh
   ```

   Missing-heartbeat alarms detect a schedule that stopped invoking. Separate
   per-worker `Healthy` alarms notify the same SNS email when a scheduled run
   completed but rejected stale/unverified input or reported another typed
   unhealthy result. A fresh heartbeat therefore cannot hide a failed worker.

Legacy Lambdas/schedules stay disabled for one trading-day rollback window.
Only after that window should an administrator remove them. The old local Risk
Range LaunchAgent is separately gated by the four-poll Gmail canary:

```bash
scripts/ops/retire_legacy_riskrange_launchagent.sh
```

That command archives rather than deletes its plist.
