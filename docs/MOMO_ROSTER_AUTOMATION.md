# Morning MOMO roster

Hermes owns this recurring automation. The former Codex schedule
`morning-s-p-500-and-momo-roster` is paused.

The default Hermes profile has an active job named **Morning S&P 500 and MOMO
roster**, ID `ca1eba88a28c`. It checks every 30 minutes from 05:00 through 08:30
on weekdays in `America/Los_Angeles`. Hermes Desktop's scheduler runs the job;
Hermes Desktop and the local dashboard API must be running. The isolated Analyst
profile retains its existing restricted tools.

The existing Hedgeye ingestion pipeline imports the daily publication. Each
Hermes check requests the dashboard's fresh roster through
`scripts/check_momo_roster.cjs`. The endpoint selects the ten largest unique
S&P 500 companies by verified Nasdaq company market cap, followed by the current
MOMO publication's additional companies. Each group is ordered by market cap.
GOOGL represents Alphabet; GOOG is excluded. No daily ticker edits are needed.

The Analyst's existing `get_dashboard_context` tool also reads the same verified
roster through the endpoint's bounded `context=analyst` projection. It receives
company identities, current publication status, and source/freshness metadata.
It receives no prices, risk ranges, or saved cron output. The shared verifier
rejects stale membership, incomplete publications, and missing or duplicate
additions. This adds no second roster schedule and does not widen Analyst tools.

The pre-check source is `scripts/hermes/momo_roster_precheck.py`. Its installed
copy is `/Users/timsmith/.hermes/scripts/market_dashboard_momo_roster.py` because
Hermes requires job scripts inside its scripts directory. Reinstall that copy
when changing the source. The script gates non-trading days and expected pending
publications before 08:30 without invoking the agent. Verified results and failed
checks wake Hermes; job continuity supplies previous results for comparison.

Results stay in Hermes's local run history. Unchanged successful rosters are
silent. Missing publications at 08:30 and unavailable data trigger investigation;
neither prior-day research nor invented values may fill the gap.

Manage and inspect the native job:

```sh
hermes -p default cron list --all
hermes -p default cron runs ca1eba88a28c --limit 5
hermes -p default cron run ca1eba88a28c
hermes -p default cron pause ca1eba88a28c
hermes -p default cron resume ca1eba88a28c
```

The CLI's gateway warning only checks messaging gateways. Hermes Desktop runs
its own scheduler, whose heartbeat and last-success markers are in
`/Users/timsmith/.hermes/cron/`. Use native run history and current ticker markers
to verify execution rather than installing a duplicate gateway.
