# Market Dashboard readiness infrastructure

This directory is the sole source for the v2 Gmail and Hermes runtime. The
template deliberately deploys with Gmail, Hermes, and alarm actions disabled;
rollout gates are enabled only after the preceding canary has passed.

## Security boundaries

- IB Gateway and the dashboard remain loopback-only. AWS never calls the Mac.
- `HERMES_OPERATIONS_BRIDGE_ENABLED` and
  `HERMES_PORTFOLIO_BRIDGE_ENABLED` default to the legacy
  `HERMES_BRIDGE_ENABLED` value, which itself defaults to `false`. When both
  partitions are disabled, the supervisor does not launch
  `scripts/ops/hermes_snapshot_bridge.js`.
- Operations telemetry can be enabled first and contains no positions or
  account data. The portfolio partition is independently enabled only after
  its verified-live gate passes. Both use outbound SigV4 DynamoDB writes and
  expose no inbound listener.
- Workers reject stale, cached, delayed, mock, seeded, synthetic, fallback,
  inferred, historical, or non-IBKR portfolio provenance.
- Quant Developer and Security consume operations telemetry without requiring
  IBKR. Only Quant Analyst consumes the portfolio partition and independently
  requires a ready `portfolio.live` gate plus fresh portfolio and
  Gateway-socket verification timestamps.
- Lambda async retries are zero. Expected readiness failures are typed
  heartbeats; unexpected runtime failures are delivered once to SQS.

## Local AWS profile contract

The local supervisor and LaunchAgent installer fail closed on three exact,
non-interchangeable profiles:

- `market-dashboard-local` must resolve to the dedicated read-only dashboard
  IAM user.
- `market-dashboard-bridge` must resolve to the dedicated write-only bridge
  IAM user.
- `market-dashboard-admin` must be an IAM Identity Center (SSO) profile; static
  administrator credentials are not supported.

Do not copy an SSO access key, secret, or session token into a local or bridge
profile. The repository preflight rejects configured session tokens, unusable
or expired providers, aliases, wrong accounts, and cross-wired API/bridge
principals without printing credential or caller-identity data. A legitimate
refreshable provider is accepted only when STS resolves it to the exact
approved identity. The SSO preflight also rejects an exported session with
less than 15 minutes remaining, while discarding all exported credential
fields.

Run a read-only check directly when diagnosing profile setup:

```bash
node scripts/ops/aws_profile_preflight.js --purpose api
node scripts/ops/aws_profile_preflight.js --purpose bridge
node scripts/ops/aws_profile_preflight.js --purpose admin
```

The LaunchAgent installer validates API credentials and, when either outbound
bridge partition is enabled, bridge credentials before it renders a plist,
stops a process, or changes launchd state. The supervisor repeats the relevant
check before every API or bridge process spawn and retries a blocked profile at
a bounded cadence.

## One-time administrator bootstrap

The configured `market-dashboard-local` IAM user intentionally has no
deployment authority. All mutations below use the short-lived IAM Identity
Center profile `market-dashboard-admin`; never add administrator keys to
`~/.aws/credentials`.

1. Install AWS CLI v2 and SAM CLI, configure the SSO profile, and sign in.
   Select account `915328198276`, the administrator permission set, and
   workload region `us-west-1`:

   ```bash
   export PATH="/opt/homebrew/bin:$PATH"
   aws configure sso --profile market-dashboard-admin
   aws sso login --profile market-dashboard-admin
   aws sts get-caller-identity \
     --profile market-dashboard-admin \
     --region us-west-1
   ```

2. Create or validate the single private artifact bucket. The helper creates
   it only after an authoritative not-found response, then enforces ownership,
   exact project/purpose tags, public-access blocks, encryption, versioning,
   and lifecycle retention. An existing same-account bucket without those
   tags is rejected rather than adopted:

   ```bash
   export MARKET_DASHBOARD_SAM_ARTIFACT_BUCKET=market-dashboard-sam-artifacts-915328198276-us-west-1
   infra/scripts/prepare_artifact_bucket.sh \
     --admin-profile market-dashboard-admin
   ```

3. Inventory the target and bootstrap stacks, functions, EventBridge Scheduler
   schedules, classic EventBridge scheduled rules, the seven SAM-owned tables,
   the six external dependency tables, and the deployment role/policy. Before
   any mutation, export Lambda packages/configuration, timer definitions,
   targets and tags, CloudFormation templates/parameters/resources, and table
   recovery metadata to a new mode-0700 directory outside the repository. Add
   any real legacy names through the comma-separated environment variables:

   ```bash
   rollback_parent="$(mktemp -d "${TMPDIR:-/tmp}/market-dashboard-rollback.XXXXXX")"
   chmod 700 "$rollback_parent"
   export MARKET_DASHBOARD_ROLLBACK_EXPORT="$rollback_parent/predeploy"
   MARKET_DASHBOARD_EXPORT_FUNCTIONS="${LEGACY_FUNCTION_NAMES:-}" \
   MARKET_DASHBOARD_EXPORT_SCHEDULES="${LEGACY_GMAIL_SCHEDULE_NAME:-}" \
   MARKET_DASHBOARD_EXPORT_EVENT_RULES="${LEGACY_EVENT_RULE_NAMES:-}" \
   infra/scripts/export_deployed_state.sh \
     --admin-profile market-dashboard-admin \
     "$MARKET_DASHBOARD_ROLLBACK_EXPORT"
   ```

   The exporter refuses existing or in-repository destinations, writes
   SHA-256 checksums, marks only authoritative missing-resource responses as
   safely absent, and aborts on permission, network, ambiguous failures,
   missing required Gmail-ledger/daily-snapshot dependencies, or ownership
   conflicts. Its `ownership-preflight.json` distinguishes external
   dependency tables from SAM-owned resources. Untagged or incompatible
   bootstrap resources are rejected rather than adopted.

4. Deploy the bounded CloudFormation execution role with the same explicit
   artifact bucket:

   ```bash
   export MARKET_DASHBOARD_CF_ROLE_ARN="$(
     infra/scripts/bootstrap_deployment_role.sh \
       --admin-profile market-dashboard-admin \
       --rollback-export "$MARKET_DASHBOARD_ROLLBACK_EXPORT"
   )"
   ```

5. Apply only `iam/local-readiness-catalog-policy.json` to the local dashboard
   API principal. The installer uses an exactly tagged customer-managed policy
   because the complete catalog plus the legacy inline grant exceeds the IAM
   user's aggregate inline-policy quota. It verifies the default version,
   exact document, tags, attachment entities, and absence of a same-name
   inline copy. This policy permits typed heartbeat reads,
   release-keyed catalog queries/atomic replacement, canonical research-event
   queries, expected-date Risk Range reads, and read-only Lambda metrics. Do
   not create or modify a bridge principal in this rollout. The installer
   compares the complete installed policy and simulates every action/resource
   pair before and after removing obsolete inline grants:

   ```bash
   infra/scripts/install_local_principal_policies.sh \
     --apply \
     --scope api \
     --admin-profile market-dashboard-admin \
     --remove-legacy-heartbeat-policy
   infra/scripts/install_local_principal_policies.sh \
     --verify \
     --scope api \
     --admin-profile market-dashboard-admin
   ```

   The removal flag is valid only with `--apply --scope api`. It removes the
   exact obsolete `MarketDashboardServiceHeartbeatsQuery` policy only after
   the complete replacement policy matches and every action/resource
   simulation passes, then verifies `NoSuchEntity`.

6. Validate, build, and deploy the stack with all schedules and alarm actions
   explicitly disabled:

   ```bash
   MARKET_DASHBOARD_AWS_ADMIN_PROFILE=market-dashboard-admin \
   MARKET_DASHBOARD_ROLLBACK_EXPORT="$MARKET_DASHBOARD_ROLLBACK_EXPORT" \
   infra/scripts/deploy.sh
   ```

   The base deploy command is hard-pinned to `market-dashboard-readiness-v2`
   and always sends all five control parameters as `DISABLED`; it rejects any
   environment request to enable Gmail, Hermes, or alarm actions. Only the
   staged activation command can enable a control.

7. Install the repo LaunchAgent with outbound portfolio publishing disabled.
   No bridge AWS profile is needed in this mode:

   ```bash
   HERMES_OPERATIONS_BRIDGE_ENABLED=false \
   HERMES_PORTFOLIO_BRIDGE_ENABLED=false \
   npm run ops:launchagent:install
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
actions and are never attempted by a repair endpoint. Reuse a healthy existing
credential; do not force fresh consent unnecessarily.

1. Inspect the existing `hermes/gmail/oauth` metadata and disabled Gmail
   activation state using the short-lived SSO profile:

   ```bash
   infra/scripts/activate_reliability.py \
     --phase gmail \
     --read-profile market-dashboard-admin
   ```

2. If the secret exists, run only the bounded OAuth/Gmail-profile probe. This
   invokes no message listing/backfill and performs no stack, schedule, or
   alarm change:

   ```bash
   infra/scripts/activate_reliability.py \
     --phase gmail \
     --apply \
     --auth-probe-only \
     --admin-profile market-dashboard-admin \
     --rollback-export "$MARKET_DASHBOARD_ROLLBACK_EXPORT" \
     --cloudformation-role-arn \
       arn:aws:iam::915328198276:role/market-dashboard-cloudformation-deployment-v2
   ```

3. Only if the secret is authoritatively absent or that typed probe fails,
   set the consumer OAuth app to **External / In production**, retain only
   `https://www.googleapis.com/auth/gmail.readonly`, and complete fresh user
   consent with offline access and explicit consent. Put `client_id`,
   `client_secret`, `refresh_token`, `user_id: "me"`, and the exact read-only
   `scope` in a JSON file outside the repository, set it to mode 0600, and
   promote it without printing the value:

   ```bash
   chmod 600 /absolute/path/to/oauth-secret.json
   infra/scripts/promote_gmail_secret.sh \
     --admin-profile market-dashboard-admin \
     /absolute/path/to/oauth-secret.json
   ```

   Rerun steps 1 and 2 and continue only after the bounded probe returns
   `passed: true`.

4. Immediately before v2 activation, disable an existing legacy Gmail timer
   only from its checksummed exported definition. The helper supports both
   EventBridge Scheduler schedules and classic EventBridge scheduled rules,
   and for rules also verifies the complete target and tag sets. Set
   `LEGACY_GMAIL_SCHEDULE_NAME` to the exact exported timer name:

   ```bash
   infra/scripts/disable_exported_legacy_gmail_schedule.py \
     --admin-profile market-dashboard-admin \
     --rollback-export "$MARKET_DASHBOARD_ROLLBACK_EXPORT" \
     --schedule-name "$LEGACY_GMAIL_SCHEDULE_NAME"
   ```

   The helper rejects the canonical v2 schedule, non-Gmail targets, checksum
   drift, live-definition/target/tag drift, and ambiguous AWS failures. It
   changes only the enabled state, preserves the exported definition, and
   verifies the live result. If the inventory proves no legacy Gmail timer
   exists, keep that absence evidence and skip this command.

5. Enable only Gmail with the explicit administrator profile, verified
   rollback export, artifact bucket, and bootstrapped CloudFormation execution
   role:

   ```bash
   infra/scripts/activate_reliability.py \
     --phase gmail \
     --apply \
     --admin-profile market-dashboard-admin \
     --rollback-export "$MARKET_DASHBOARD_ROLLBACK_EXPORT" \
     --cloudformation-role-arn \
       arn:aws:iam::915328198276:role/market-dashboard-cloudformation-deployment-v2
   ```

   Immediately before enabling the schedule, apply mode checks only Secrets Manager
   metadata (never `GetSecretValue`), verifies the Lambda is active, and invokes
   one synchronous `authProbeOnly` canary with `forceAuthProbe`. That bounded
   path refreshes OAuth and calls the readonly Gmail profile endpoint; it does
   not list messages, advance the history cursor, or materialize data. The
   command emits only typed status/count fields from the Lambda response; it
   does not print subjects, senders, OAuth values, or the secret version. If
   the activation deployment fails after it may have changed CloudFormation,
   the command immediately attempts and verifies a compensating deployment
   with every control disabled. The explicit `disabled` recovery phase itself
   never recursively compensates.

6. Let the 15-minute schedule accumulate four consecutive heartbeats, then
   rerun the Gmail phase in apply mode. This is the guarded post-cutover
   verification/recovery pass: it re-reads the exact schedule/alarm controls,
   requires all four successful Scheduler heartbeats, and automatically
   deploys and verifies every control `DISABLED` if the heartbeat gate fails.
   `GMAIL_SCHEDULE_CANARY_FAILED` identifies the bad status, provenance,
   cadence gap, or age:

   ```bash
   infra/scripts/activate_reliability.py \
     --phase gmail \
     --apply \
     --admin-profile market-dashboard-admin \
     --rollback-export "$MARKET_DASHBOARD_ROLLBACK_EXPORT" \
     --cloudformation-role-arn \
       arn:aws:iam::915328198276:role/market-dashboard-cloudformation-deployment-v2
   ```

An `invalid_grant` records `GMAIL_AUTH_REQUIRED` once and suppresses further
Google calls until the Secrets Manager version changes. The blocked circuit
checks Secrets Manager (but not Google) once per scheduled invocation so a new
version is detected immediately. Every poll, including zero-message polls,
records a heartbeat. Manual poll/backfill heartbeats use a separate service ID
and cannot satisfy scheduler readiness.

## Backfill and projection verification

For the bounded parser-repair incident involving exactly one current The Call,
Macro Show, and Risk Ranges failure, do **not** run a mailbox backfill. While
the existing Gmail schedule is still enabled and the three-error heartbeat is
current, capture an authenticated private incident receipt:

```bash
incident_parent="$(mktemp -d "${TMPDIR:-/tmp}/market-dashboard-gmail-incident.XXXXXX")"
chmod 700 "$incident_parent"
python3 infra/scripts/retry_failed_gmail_materializations.py \
  --prepare \
  --receipt "$incident_parent/incident.json" \
  --receipt-key "$incident_parent/incident.key" \
  --admin-profile market-dashboard-admin
```

Prepare mode accepts no message IDs, performs no AWS mutation, and writes the
three IDs only inside the HMAC-authenticated mode-0600 receipt. It requires the
SSO-only administrator profile, the canonical enabled schedule, an idle Gmail
runtime, a fresh genuine failed Scheduler heartbeat, and one active retryable
failed-ledger row for each allowlisted report type.

The guarded base deployment disables every schedule. Before staged activation
re-enables Gmail, apply the receipt against the exact tested parser release:

```bash
python3 infra/scripts/retry_failed_gmail_materializations.py \
  --apply \
  --receipt "$incident_parent/incident.json" \
  --receipt-key "$incident_parent/incident.key" \
  --admin-profile market-dashboard-admin
```

Apply mode refuses an enabled Gmail schedule, re-verifies the receipt HMAC,
the original heartbeat, and every selected live failure row, requires the
deployed Lambda `BUILD_VERSION` to equal the local Git commit, then invokes
only the three selected messages. Both modes print categories and counts
without message IDs or message content.

After the guarded four-heartbeat verification passes, invoke one ordered
backfill. The ingestor uses immutable Gmail message IDs and processes
oldest-first. The backfill command independently performs a strongly
consistent query for the newest four
`gmail:timsmithaviation@gmail.com` heartbeat rows and requires exact
`aws-lambda`/`aws-scheduler` provenance, the canonical schedule ID,
`scheduled=true`, `status=success`, zero errors/drops, 15-minute cadence, and
freshness before it can invoke Lambda. Manual, canary, or backfill heartbeats
cannot satisfy this gate. It also requires the exact SSO account/region and
rejects Lambda function errors, `PARTIAL_ERROR`, non-query backfills,
materialization errors, unverified canonical events, or empty RTA/ETF Pro
canonical products, emitting counts and gate metadata only:

```bash
infra/scripts/run_gmail_backfill.py \
  --admin-profile market-dashboard-admin
```

Then use the loopback-only readiness repair actions to rebuild research
projections and verify the fresh RTA/ETF checkpoints and expected Risk Range
manifest. The active surface stays unavailable when the Gmail heartbeat is
unhealthy; dated books remain archival only.

For this Gmail-only rollout, leave analyst, developer, security, and
operational-alarm controls disabled. Trigger the fixed 90-day rebuild through
the allowlisted loopback action:

```bash
rebuild_result="$(
  curl --fail --silent --show-error \
  -X POST \
  -H 'X-Readiness-Repair: 1' \
  http://127.0.0.1:3001/api/system-readiness/actions/rebuild-research-projections
)"
python3 -c '
import json, sys
result = json.load(sys.stdin)
execution = result.get("execution") or {}
if (
    result.get("completed") is not True
    or execution.get("status") != "succeeded"
    or int(execution.get("canonicalEventCount") or 0) <= 0
    or int(execution.get("rejectedCount") or -1) != 0
):
    raise SystemExit("verified canonical rebuild did not complete")
print(json.dumps({
    "completed": True,
    "canonicalEventCount": execution["canonicalEventCount"],
    "materializedEventCount": execution.get("materializedEventCount"),
    "rejectedCount": 0,
}, sort_keys=True))
' <<<"$rebuild_result"
```

The loopback action is synchronous and returns `completed: true` only after a
canonical v2, ledger-error-free, rejection-free 90-day rebuild produces a
valid current board/checkpoint. Do not continue merely because the HTTP
request was accepted.

Restart the repo-owned local stack to clear response caches and verify both
APIs. Do not accept cached, stale, reference-only, structurally rejected, or
ingestion-unhealthy responses:

```bash
npm run dev:restart
curl --fail --silent --show-error \
  http://127.0.0.1:3001/api/hedgeye/real-time-alert/positions
curl --fail --silent --show-error \
  http://127.0.0.1:3001/api/hedgeye/etfpro
```

RTA and ETF Pro must each report `available`, `current`, and
`comparisonSafe` as true and `referenceOnly` as false. ETF Pro must also
contain a nonempty canonical book and no replay rejection. If activation or
heartbeat verification fails, the activation command attempts and verifies a
compensating all-disabled deployment. Whether or not that automatic
compensation ran, the explicit fail-closed recovery command is:

```bash
infra/scripts/activate_reliability.py \
  --phase disabled \
  --apply \
  --admin-profile market-dashboard-admin \
  --rollback-export "$MARKET_DASHBOARD_ROLLBACK_EXPORT" \
  --cloudformation-role-arn \
    arn:aws:iam::915328198276:role/market-dashboard-cloudformation-deployment-v2
```

Require exit zero and a verified all-control `DISABLED` result; otherwise
treat controls as potentially enabled and inspect AWS directly. Retain the
blank UI and restore state only from the verified rollback export. Keep any
legacy pipeline disabled but recoverable for one trading day; retirement is a
separate change.

## Hermes and alarm cutover

The consolidated workers are lightweight readiness monitors. Developer and
Analyst run every 15 minutes; Security runs hourly. All schedules run 24/7.
Keep alarm actions disabled through the worker cadence gates.

1. After the local controller has completed its 24-hour shadow soak, install
   the LaunchAgent with operations-only telemetry and promote only the first
   low-risk repair class. This partition contains no account or position data:

   ```bash
   HERMES_OPERATIONS_BRIDGE_ENABLED=true \
   HERMES_PORTFOLIO_BRIDGE_ENABLED=false \
   HERMES_RELIABILITY_CONTROLLER_MODE=active \
   HERMES_RELIABILITY_ENABLED_ACTIONS=prune-dashboard-logs \
   npm run ops:launchagent:install
   ```

   Active mode dispatches nothing when
   `HERMES_RELIABILITY_ENABLED_ACTIONS` is empty. Add one exact action ID at a
   time to the comma-separated list only after the prior class has completed
   its observation window without a repair storm; reinstalling the LaunchAgent
   applies the new list. Unknown IDs are rejected.

2. Stage cloud controls in the exact Developer → Gmail → Security → Analyst
   order. Every command is read-only unless `--apply` is present. Apply mode
   also requires the tested-release receipt, verified rollback export,
   `market-dashboard-admin`, artifact bucket, and exact CloudFormation role
   documented above:

   ```bash
   infra/scripts/activate_reliability.py --phase developer --read-profile YOUR_READ_PROFILE
   infra/scripts/activate_reliability.py --phase developer --apply \
     --admin-profile YOUR_ADMIN_PROFILE \
     --cloudformation-role-arn \
       arn:aws:iam::915328198276:role/market-dashboard-cloudformation-deployment-v2

   # After one genuine 15-minute Developer Scheduler heartbeat:
   infra/scripts/activate_reliability.py --phase gmail --apply \
     --admin-profile YOUR_ADMIN_PROFILE \
     --cloudformation-role-arn \
       arn:aws:iam::915328198276:role/market-dashboard-cloudformation-deployment-v2

   # After four genuine 15-minute Gmail Scheduler heartbeats:
   infra/scripts/activate_reliability.py --phase security --apply \
     --admin-profile YOUR_ADMIN_PROFILE \
     --cloudformation-role-arn \
       arn:aws:iam::915328198276:role/market-dashboard-cloudformation-deployment-v2
   ```

3. After one genuine hourly Security heartbeat, enable the portfolio partition,
   verify its strict live IBKR provenance, and then activate Analyst:

   ```bash
   HERMES_OPERATIONS_BRIDGE_ENABLED=true \
   HERMES_PORTFOLIO_BRIDGE_ENABLED=true \
   npm run ops:launchagent:install

   infra/scripts/activate_reliability.py --phase analyst --apply \
     --admin-profile YOUR_ADMIN_PROFILE \
     --cloudformation-role-arn \
       arn:aws:iam::915328198276:role/market-dashboard-cloudformation-deployment-v2
   ```

   Operations stages require only fresh operations telemetry. Analyst alone
   requires the fresh verified-live portfolio partition. A stale, cached,
   mock, seeded, inferred, offline, or portfolio-derived input blocks the
   canary with its exact error code.

4. After Analyst has three genuine Scheduler heartbeats, enable alarm and
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
