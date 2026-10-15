# The Analyst — reliable personal portfolio analyst

Updated September 30, 2026. The floating panel, docking/resizing, left history, two review buttons (Portfolio Review and Predictive Markets Review), local services, and Hermes model remain in place. The dashboard’s SQLite workspace owns the visible conversation. Hermes supplies responses through a server-owned adapter.

## One conversation workflow

### Focused Hermes skills

The September 30 refinement uses The Analyst as the single visible Hermes bot and the default profile for new CLI invocations. The built-in default Hermes profile is hidden through Desktop's supported Hide control; its infrastructure and historical records remain intact because Hermes does not support deleting that root profile. The Analyst has six focused skills: `portfolio-review`, `balance-review`, `portfolio-cross-verification`, `prediction-markets-review`, `market-questions`, and `research-questions`. Routing and shared evidence/style rules live in `config/analyst/SOUL.md`, replacing the redundant `the-analyst` skill. `portfolio-review` owns the captured full-book report reference formerly in `portfolio-refresh`; runtime `portfolio-refresh-v1` report contracts remain intact. The Analyst's copy of the administration-only `hermes-agent` skill is archived. Each financial workflow controls its own concise answer format.

The local `analyst-skill-reader` plugin exposes only `skills_list` and `skill_view`, alongside the existing 15 market tools. Skill editing, shell expansion, and administration are unavailable to The Analyst. Profile setup installs managed skills and nested references, archives only the three explicitly retired skill folders outside discovery, and preserves unrelated user skills and bundled-skill metadata. A fresh Hermes session discovers the new guidance; saved reports remain unchanged.

The **Manual Portfolio Update** button sits directly below **Predictive Markets Review** and submits one explicit complete-book check in a new Analyst chat. The skill calls `get_portfolio_context(include_research_verification=true, compact_research_verification=true)`. Its `researchVerification` projection refreshes the complete broker book, audits all available-source publications and product coverage, and retains every holding with source evidence. Compact delivery avoids repeating archive documents and accounting diagnostics. Completeness describes that archive scope, not proof of complete publication delivery or universal alignment. Invalid current holdings cannot unlock a current all-clear.

`AnalystWorkspace.jsx` uses `/api/analyst/conversations`, `/messages`, and a replayable `/events` stream. Accepted prompts, message IDs, turn IDs, citations, titles, archive state, and ordered events live in `analyst_workspace.sqlite3` under the dashboard Analyst application-data directory. Browser disconnection never resubmits a prompt. Request IDs survive uncertain submissions and page reloads; event IDs and revision numbers prevent duplicate or older updates from overwriting current content.

Each response has its own server-owned Hermes socket. Stop validates the conversation and turn, and cancels only that response or deterministic review. Closing the panel leaves work running. A restart or lost response becomes explicitly interrupted and retryable. Saved history does not require Hermes to be online.

The response deadline matches Hermes's finite thirty-minute gateway budget. Reopening or retrying an older timed-out chat first checks for its actual saved completion. Recovery requires the exact latest prompt, linked session, original submission/completion times, and explicitly verified same-turn tool evidence. It updates the original assistant message, preserves dated sources, and never submits another prompt, reopens deleted history, or replaces a newer retry. A recovered answer remains its original captured observation.

New gateway sessions inherit the isolated Analyst profile's model, reasoning effort, and service tier instead of supplying a hard-coded Luna override. They continue following that profile on resume. Profile setup backs up and migrates only legacy dashboard Analyst Luna session metadata to the same policy, preserving historical models and all saved messages.

Internal review and explanation prompts are retained as operational records, never displayed as messages from the user or included in history search/counts. Empty assistant placeholders are also excluded from the transcript and count. Review imports skip runs already owned by the workspace; the repeatable visibility migration retains existing records while hiding duplicate imports. Retrying a failed explanation uses the saved report without rerunning its numeric review. While Hermes completes its startup verification, saved reports remain readable and automated reviews do not launch an explanation that is certain to fail.

Hermes tool lifecycle events are enabled for the response guard. Startup verification requires a real MCP tool-completion event as well as persisted tool history. If a completion event lacks evidence, the guard can reconcile the exact current prompt, authoring timestamp, final answer, and explicitly verified tool results from session history; unrelated or earlier turns cannot satisfy it.

Each guarded response receives the exact list of required refresh tools before generation. This internal checklist is hidden from visible chat history. Original review explanations and retries share the same source instructions. Balance explanations request the balance channel, independent holdings cross-check, and saved Process directly, avoiding an unrelated full dashboard fetch. Failed verification names the missing sources; offline or cache-only evidence still cannot unlock current claims.

New Chat opens the landing page without an empty history row. Drafts and scroll positions are saved per conversation. Search queries the local message history of visible conversations. Sidebar grouping and dated daily reviews use the Pacific calendar day, and every clock time is shown in Pacific time. Conversations archived earlier stay out of the sidebar.

Chats and dated daily reviews stay until you delete them. Every sidebar row has a trash button beside refresh: one click permanently deletes that chat (no confirmation, archive, or undo). While the delete is saving, the row stays in place as a disabled Deleting… row, so a repeated click cannot hit the next chat; it disappears once the delete is durably saved, and a failed delete shows a short error with Retry delete. Deleting a running review also stops its run. A Starting… row can be deleted once its start is accepted. Nothing deletes a chat automatically: reloads, reconnects, refreshes, and background completions never delete or hide one. Deleted chats keep a server tombstone, so Hermes imports, late completions, and background reviews cannot restore them.

Migration imports available Hermes messages and ReviewRunV2 records using stable source IDs. It preserves dates, reports, citations, follow-up discussion, and archived state. Internal portfolio audit prompts are excluded from ordinary history; their reports appear as dated **Portfolio audit** records. Original databases are retained.

## Daily reviews

The research-readiness gate uses the US equity exchange calendar and Eastern date. Every required product must be received, parsed, validated, cloud-indexed, and locally indexed for that date:

Risk Ranges, Early Look, Bitcoin Tracker, MOMO, Signal Strength, Portfolio Solutions, ETF Pro, Top 3 Things, and Market Situation Report.

Yesterday’s copies, failed stages, and locally outdated corrections cannot satisfy the gate. The landing page lists exact missing products. Other publications remain dated supporting context. Background work continues research ingestion and Inbox monitoring without creating, reopening, or refreshing conversations.

Reviews are user initiated through the existing review buttons, chat requests, or explicit refresh actions. **Portfolio Review** preserves available publications and coverage gaps. New captures and refreshes preserve earlier reports and follow-ups; historical sidebar selections remain saved records. Research arrival, opening the window, reconnecting, or background monitoring does not create a review chat.

The obsolete Hermes jobs **Analyst morning prediction review** (`2d25a4e61d86`) and **Analyst closing portfolio capture** (`b23c8641fd50`) were removed on September 30 after both adapters were verified to return `skipped / user_initiated_only`. Their job definitions, 29 output files, notepad database and execution ledger were backed up under `~/.hermes/backups/analyst-consolidation-20260930T184006Z/cron/` before removal. The distinct **Morning S&P 500 and MOMO roster** monitor (`ca1eba88a28c`) now belongs to the Analyst profile, retaining its weekday 05:00–08:30 America/Los_Angeles checks every thirty minutes, original job identity, next run, and historical continuity.

Hermes executes the verified roster precheck before constructing the Analyst agent. Expected publication waiting and non-trading days suppress agent work. Any necessary interpretation uses the same read-only financial tools and skill readers as chat; the monitor cannot repair services, place orders, or create dashboard conversations. Unchanged rosters stay quiet. The default profile has no active schedule. Hermes Desktop's scheduler serves the Analyst profile even while its separate dashboard gateway runs on port 9121.

The precheck maintains a bounded, profile-local verified roster baseline rather than relying on Hermes's truncated prior-output prompt. Initial continuity comes only from the original checker's structured ready result in saved run history, never from model-written ticker lists. Only a new verified ready result can advance the baseline. Ordered Top 10 and additional MOMO groups determine changes; a publication-date-only update stays quiet. Pending, unavailable, or failed evidence leaves the last verified baseline intact. This historical identity comparison does not supply executable prices.

The profile transfer backup is `~/.hermes/backups/analyst-momo-migration-20260930T191038Z/`. The migration preserves the monitor's 80 execution records, two incident records, and 50 byte-identical retained output files; no notepad entries existed. The job uses Analyst's Sol subscription route and its restricted cron toolsets.

The legacy `scripts/hermes/analyst_morning_review.py` adapter remains for compatibility and historical records; its automation endpoint acknowledges the manual-review policy without creating or resurrecting a conversation and has no active Hermes schedule.

The Analyst profile's Hermes job **Portfolio close capture (4:30pm ET)** (`30 13,14,15 * * 1-5` Pacific, via `scripts/run_analyst_portfolio_close.cjs`) POSTs `/api/analyst/automation/portfolio-close` 30 minutes after each exchange close. It starts a headless Portfolio Review run that captures verified IBKR holdings and account balances without creating or reopening an Analyst conversation. That run is the next session's **Since previous close** baseline (Friday's close on a Monday; exchange holidays are skipped). Systems → The Analyst → **Portfolio close baseline** warns when the previous session has no verified capture.

The former **Four-market morning prediction report**, both dated July cost-check automations, and the superseded **Analyst portfolio cross-check** remain paused in Codex. The existing AWS cost guard and computer maintenance continue independently. Hermes Desktop and local dashboard services must be running for the retained roster monitor.

Balance Review has been retired into Portfolio Review. Portfolio Review's Exposure & risk table ends with **Interest**, the same capture's verified IBKR net accrued interest, and Since previous close shows its current and previous-close values so the day-to-day accrual is visible. Saved Balance Review chats remain readable and deletable, but new Balance Review launches and refreshes are rejected.

Code reconciles the full holdings table and research, calculates exposures and capacity, and renders a concise summary with expandable detail. A bounded Hermes response explains priorities, recommendations, supporting sources, judgment, and uncertainty. Portfolio conflicts are limited to held securities; prediction contracts are classified separately. Missing research fields are grouped in coverage rather than repeated as sell conflicts. Balance summaries cover cash, margin, borrowing, liquidity buffers, capacity, and interest detail.

The interactive Analyst keeps GPT-6.1 Sol on the Codex route with the fast tier and High reasoning. New sessions inherit the isolated profile; changing its default does not interrupt an already-built response. The October 5 latency audit found that model calls accounted for 465 of 547 seconds in a manual full-book check, including 317 seconds for the final answer. Maximum reasoning, repeated source lookup, and the requested full roster dominated that capture; these timings are a baseline, not a promised response limit. Independent required tools can run together and reuse evidence within a turn only while its original freshness and provenance qualify. Portfolio and Predictive Markets narrative prompts use `get_dashboard_context(include_live_channels=false)` for dated supporting context alongside the required individual live tools, avoiding a duplicate holdings valuation, balance refresh, and native prediction scan. Default dashboard reads retain all channels. Manual verification preserves its complete holdings/archive scan, code-produced weights, and original action dates, with scoped evidence expansion for material exceptions.

The October 5 performance update preserves that model policy and publishes verified Portfolio and Predictive Markets sections progressively in the owning review post. Partial revisions carry their captured citations and remain active; completion replaces the same post, and Stop/deletion prevent late updates. A partial report cannot accept a portfolio baseline or imply a completed reconciliation. Compact status polls read scalar metadata only; Sources resolves one atomic conversation/run binding; saved Portfolio summaries hydrate only referenced captures. Recovery and saved-chat reads no longer wait for the archive import. Hidden Analyst windows stop subscriptions and queued reads, then resume from a validated snapshot cursor; unchanged evidence avoids repeated report parsing while corrections and revocations still update.

Date-scoped portfolio research starts alongside independent broker/supporting reads. Manual complete-book verification overlaps optional valuation with holdings and research, retaining research when valuation is unavailable and admitting weights only from a fresh matching full book. Exact archive citations resolve from a bounded research-only registry, including citations reissued from saved review context; unknown or conflicting IDs remain unavailable. Background embedding yields between 32-chunk batches for foreground queries while keeping one ONNX inference active, and cancelled searches release queued work and SQLite reads. A temporary-copy benchmark preserved the same 2,000 candidate rows and reduced warm candidate SQL from 106 ms to 10 ms. This measures candidate retrieval only; unchanged model reasoning and provider latency still determine complete-answer time.

`get_dashboard_context` and `get_process_context` are read-only tools in the fixed 15-tool allowlist. They expose independently gated holdings/balances, exposure, eight prediction monitors, market backdrop, volatility, currencies, correlations, liquidity, calendar, research coverage, the current verified Top 10 + MOMO company roster, and versioned Process documents. The roster contains identities and publication/source metadata only, never executable prices or saved cron output. `dailyMarket` adds up to five percentage gainers and decliners from the complete comparable S&P 500/SPY constituent group; its original session, coverage, provider and observation remain attached, with retained readings marked `D` and every row explicitly non-executable. Supporting historical indicators are labeled as dated context. Saved Process edits and resets synchronize to SQLite with their version and dashboard authorship; unsuccessful synchronization remains queued in local storage.

## Prediction recommendations

| Market | Native venue | Maximum setup loss |
|---|---|---|
| Silver | ForecastEx | 5% of verified NLV |
| Gold | Kalshi | 5% |
| WTI | Kalshi | 5% |
| Brent | Kalshi | 5% |
| Bitcoin | Kalshi | 5% |
| S&P 500 | ForecastEx | 5% |
| Nasdaq 100 | ForecastEx | 5% |
| CPI | Kalshi | 15% per release |

The setup groups contracts sharing the event and settlement; CPI groups its release. Existing plus proposed exposure shares the cap. Verified funding, native ask depth, fees, account scope, complete existing contract mapping, and fresh NLV constrain sizing further. Unknown exposure or missing live evidence withholds sizing. Stale, cached-disconnected, seeded, inferred, or fallback trading inputs cannot support a current recommendation. These percentages are ceilings, not deployment targets.

Non-CPI screens use the monitors’ current Risk Range, Trade/Trend, exact reference, native book, and settlement terms. They scan all available lines, not merely the five displayed nearest the midpoint. Risk-range location is never converted into an invented probability or expected return. CPI reuses the existing calibrated allocation and settlement-payoff functions, its nowcast history and official finals, and stops when incremental utility is nonpositive. No analyst tool places orders.

Nasdaq 100 retains independently verified ForecastEx catalog/book evidence. Cash NDX or a different dated future cannot substitute for the exact NQ settlement reference. COMPQ research is explicitly related context, so its range does not unlock Nasdaq sizing.

## Persistent portfolio inbox

The Express worker runs every five seconds while the dashboard services run, including with the browser closed. Gmail and PDF finalization write validated changes to the existing DynamoDB research ledger. The consumer reads a bounded incremental journal with a durable cursor and an overlapping checkpoint window; ordinary monitoring does not rescan the research archive. Initial research indexing remains a resumable bootstrap.

Typed actions retain exits, trims, covers, roster removals, and signal changes. Exact security identifiers and explicit share-class spelling aliases match freshly verified holdings. Commodity/index proxies are not security aliases. Missing unrelated Trade or Trend fields do not suppress a direct alert match.

Each finding persists its source citation, publication time, verification time, session state, lifecycle, and unread state. Acknowledgment never proves a trade. Position updates recheck unresolved findings; outages or invalid quantities remain pending verification. A smaller holding may partially address a trim; only verified target/exit evidence resolves it. Pending orders do not resolve findings. Corrections and changed lifecycle states notify again; duplicate deliveries and unchanged findings do not.

The Analyst button shows an unread badge. Inbox displays findings and monitor/ingestion health, including Gmail quarantine status and the cost projection. Delivery is dashboard-only. The healthy target is roughly one to two minutes after email arrival; Gmail, parsing, indexing, and IBKR outages can delay it.

## Faster polling and cost protection

Gmail’s existing scheduler is enabled at one minute after a live conservative projection below $15/month. The Lambda guard measures hourly and restores fifteen-minute polling at the $15 threshold or when cost evidence is unavailable. If schedule updates fail, it still limits actual work to fifteen-minute boundaries. This leaves headroom below the authorized $20/month limit.

The projection assumes no free-tier savings and rounds rates upward. It includes Lambda compute and requests, scheduler requests, CloudWatch API/log usage, all observed reads/writes on shared research tables, and a $3 reserve for other incremental AWS usage. At rollout the upper projection was about $14.73/month; it is not an invoice or a promise of future cost. References: [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/) and [DynamoDB on-demand pricing](https://aws.amazon.com/dynamodb/pricing/on-demand/).

`python3 scripts/analyst/polling_cost_guard.py` reads the current projection. `--enable` requires both a safe projection and deployed runtime guard. `scripts/analyst/deploy_workspace_ingestion.py` stages narrow overlays from backed-up deployed ZIPs, preserving the newer deployed parsers; `--apply` deploys those reviewed artifacts and narrowly scoped journal/cost permissions. `infra/template.yaml` and the PDF Makefile include the same hooks and permissions. A full infrastructure deployment defaults the schedule to fifteen minutes; faster activation is always cost-gated.

## Verification and recovery

Rollout validation passed: 105 Python tests, 62 Node tests, 28 Analyst UI tests, 39 adjacent tests, and the production build. Repeating migration twice against copies of the real stores retained all 16 conversations and 27 visible messages. Run `npm run test:analyst` and `npm run build`. Focused tests cover durable HTTP/SQLite integration, independent responses, duplicate events and requests, targeted Stop, replay, reload, archive/restore, background completion, all-nine readiness, corrections, holidays, alert lifecycle, all seven markets, combined caps, CPI calibration, funding outages, and cost-triggered slowdown. Adjacent CPI allocation, CORS, Process drafts, and monitor normalization suites also run during rollout.

The pre-change working tree, patches, hashes, SQLite backup copies, original deployed Lambda ZIPs, and cloud configuration were saved under:

`~/Library/Application Support/market-dashboard/rollback-exports/analyst-rebuild-20260905T163138Z/`

Restore through those backups if needed; do not delete the original review/Hermes databases. Local recovery uses `node scripts/dev-stack/cli.js restart --detach`. Review reports remain in the original engine store as well as the authoritative visible workspace. The superseded Codex **Analyst portfolio cross-check** automation is paused after replacement acceptance, with its reports retained.

Live acceptance on September 5 confirmed simultaneous Hermes conversations completing with the panel closed, correct history after reload and switching, targeted interruption, reversible archive/restore, and the deployed one-minute scheduler. IB Gateway was logged out, so live holdings, recommendations requiring broker evidence, and a real market-open alert-to-holding delivery could not be acceptance-tested. The system withholds that unavailable evidence. Gmail polling succeeded but reported existing quarantined artifacts; the inbox exposes that ingestion warning.
