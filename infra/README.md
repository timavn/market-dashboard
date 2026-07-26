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
   The repository includes an idempotent administrator check/apply command
   that keeps the two principals separate and simulates every required
   action/resource pair after attachment:

   ```bash
   infra/scripts/install_local_principal_policies.sh \
     --apply \
     --admin-profile YOUR_ADMIN_PROFILE \
     --create-bridge-user
   ```

   Rerun the same command with `--verify` for a read-only permissions audit.
   It never creates access keys or edits local AWS credentials. Configure
   `HERMES_BRIDGE_AWS_PROFILE` to a local profile for the dedicated bridge
   principal after its credentials are provisioned through the normal secure
   administrator workflow.
6. Export the role ARN as `MARKET_DASHBOARD_CF_ROLE_ARN` and run:

   ```bash
   infra/scripts/deploy.sh
   ```

The first deployment creates retained/PITR DynamoDB tables, no-retry failure
handling, SNS email subscription, runtime roles, disabled schedules, and
disabled alarm actions. Confirm the SNS subscription email before the final
rollout phase. Do not use ad hoc environment-variable deploys to activate the
runtime. The staged activation command below preserves every deployed
non-control parameter, applies all five control parameters explicitly, and
verifies the resulting AWS resources.

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

5. Inspect the Gmail activation gate. This is read-only; when the schedule is
   disabled it reports that the OAuth canary will run only in apply mode:

   ```bash
   infra/scripts/activate_reliability.py \
     --phase gmail \
     --read-profile YOUR_READ_PROFILE
   ```

6. Enable Gmail with the explicit administrator profile and bootstrapped
   CloudFormation execution role:

   ```bash
   infra/scripts/activate_reliability.py \
     --phase gmail \
     --apply \
     --admin-profile YOUR_ADMIN_PROFILE \
     --cloudformation-role-arn \
       arn:aws:iam::915328198276:role/market-dashboard-cloudformation-deployment-v2
   ```

   Before enabling the schedule, apply mode checks only Secrets Manager
   metadata (never `GetSecretValue`), verifies the Lambda is active, and invokes
   one synchronous `authProbeOnly` canary with `forceAuthProbe`. That bounded
   path refreshes OAuth and calls the readonly Gmail profile endpoint; it does
   not list messages, advance the history cursor, or materialize data. The
   command emits only typed status/count fields from the Lambda response; it
   does not print subjects, senders, OAuth values, or the secret version.

7. Let the 15-minute schedule accumulate four consecutive heartbeats, then
   rerun the phase without `--apply`. `GMAIL_SCHEDULE_CANARY_FAILED` includes
   the exact bad status, provenance, cadence gap, or age:

   ```bash
   infra/scripts/activate_reliability.py \
     --phase gmail \
     --read-profile YOUR_READ_PROFILE
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

## Hermes and alarm cutover

The consolidated workers are lightweight readiness monitors. Analyst and
developer run every 15 minutes; security runs hourly. All three schedules run
24/7, including nights and weekends, so a missing-heartbeat alarm never
confuses an intentional off-hours gap with a dead service.

1. Install/restart the repo supervisor so the outbound bridge is running.
   Confirm its dedicated profile can publish a fresh, ready snapshot.
2. Stage each worker in order. Every command is read-only unless `--apply` is
   present:

   ```bash
   infra/scripts/activate_reliability.py --phase analyst --read-profile YOUR_READ_PROFILE
   infra/scripts/activate_reliability.py --phase analyst --apply \
     --admin-profile YOUR_ADMIN_PROFILE \
     --cloudformation-role-arn \
       arn:aws:iam::915328198276:role/market-dashboard-cloudformation-deployment-v2

   # After three 15-minute analyst heartbeats:
   infra/scripts/activate_reliability.py --phase developer --apply \
     --admin-profile YOUR_ADMIN_PROFILE \
     --cloudformation-role-arn \
       arn:aws:iam::915328198276:role/market-dashboard-cloudformation-deployment-v2

   # After three 15-minute developer heartbeats:
   infra/scripts/activate_reliability.py --phase security --apply \
     --admin-profile YOUR_ADMIN_PROFILE \
     --cloudformation-role-arn \
       arn:aws:iam::915328198276:role/market-dashboard-cloudformation-deployment-v2
   ```

   Each worker stage requires the four-poll Gmail gate, every preceding
   worker's three-cadence gate, and a fresh verified-live outbound bridge
   snapshot. Apply mode invokes one manual worker canary before enabling a new
   schedule. `SUCCESS` and `DEGRADED` both prove that the monitor ran;
   degradation remains visible as a typed `Healthy=0` condition for its alarm.
   A rejected/stale/untrusted snapshot blocks activation with its exact code.

3. After security has three hourly Scheduler heartbeats, enable alarm and
   recovery actions:

   ```bash
   infra/scripts/activate_reliability.py --phase alarms --read-profile YOUR_READ_PROFILE
   infra/scripts/activate_reliability.py --phase alarms --apply \
     --admin-profile YOUR_ADMIN_PROFILE \
     --cloudformation-role-arn \
       arn:aws:iam::915328198276:role/market-dashboard-cloudformation-deployment-v2
   ```

   This final gate also requires a confirmed email subscription on the exact
   operations SNS topic. After deployment it re-reads CloudFormation, every
   Scheduler job, all nine alarms, both alarm and OK action targets, and every
   heartbeat window. Missing-heartbeat alarms detect a schedule that stopped;
   separate `Healthy` alarms diagnose a monitor that ran but rejected its input
   or observed a degraded capability. Recovery notifications use the same
   confirmed topic.

For a read-only snapshot of the deployed controls, schedule contracts, alarm
actions, and enabled-service heartbeats:

```bash
infra/scripts/activate_reliability.py \
  --phase status \
  --read-profile YOUR_READ_PROFILE
```

`--phase full` is an idempotent repair path only after all Gmail/Hermes
heartbeat gates already pass; it never bypasses the staged canaries. Every
mutation validates account `915328198276`, region `us-west-1`, the exact stack,
and the explicit administrator profile. The command never creates access keys,
edits AWS credential files, reads secret values, or deploys without `--apply`.

Legacy Lambdas/schedules stay disabled for one trading-day rollback window.
Only after that window should an administrator remove them. The old local Risk
Range LaunchAgent is separately gated by the four-poll Gmail canary:

```bash
scripts/ops/retire_legacy_riskrange_launchagent.sh
```

That command archives rather than deletes its plist.
