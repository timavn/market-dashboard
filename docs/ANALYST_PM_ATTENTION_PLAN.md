# Analyst Inbox: portfolio-manager attention plan

September 22, 2026. Product plan and implementation record.

The first implementation now replaces the event-forwarding Inbox with independently collected portfolio, research, account, and dashboard findings. It preserves exact source actions, evaluates verified current holdings, considers sourced long and short cases across the research universe, and checks registered research destinations and service health. The existing worker refreshes this assessment without waiting for the daily review. Findings retain their evidence and material revision; acknowledging an unchanged condition survives refreshes and outages. The requested reset archives the previous queue without deleting saved conversations or research.

The implementation uses deterministic evidence checks and source passage selection. Cross-product model synthesis, independent publisher discovery, and universal confirmation of every rendered dashboard destination are not yet implemented. Existing consumer snapshots and health checks establish only their own coverage; they do not prove that every dashboard feature is healthy. The broader requirements below remain the product direction, not a claim that all planned capabilities are complete.

The Analyst should bring Tim timely, constructive judgment grounded in the Hedgeye process: protect the current book, identify where exposure deserves reconsideration, find compelling new long and short ideas, and explain market developments that could change a decision. New-position ideas are explicitly in scope. Useful analysis should arrive before every input for an executable trade is available.

The existing Analyst Inbox remains the point of delivery. Its compact rows, linked sources, acknowledgment behavior, conversation history, and composer remain the workflow. No new dashboard area or order controls are needed.

Dashboard-wide operational monitoring is a first-class responsibility. Tim explicitly wants alerts when a published product has not reached its intended destination, expected morning research has not arrived on a trading day, or a dependency such as IB Gateway prevents the portfolio from updating. Coverage must extend across the configured dashboard, not just the Analyst's own research inputs.

## What needs to change

The running Inbox was inspected on September 22. EWL appeared with `Current position: Short` and `Action: Neutral — no change`. CORN and BYND both appeared with `Action: Reduce position size`, obscuring their different source instructions. These are observations of the existing interface, not current trading recommendations.

The code explains this behavior:

- `src/services/analyst/analystPolicy.cjs` principally evaluates research events against holdings. Its action allowlist excludes buy/add/new-short opportunities, and it drops first-time unheld securities. Partial-action parsing and lifecycle handling differ from the display projection.
- `src/utils/analystInboxAlerts.cjs` admits validated source actions without consistently enforcing current applicability or resolved state. A source publication can therefore become an alert even when it identifies no remaining portfolio issue.
- `src/components/Dashboard/AnalystInbox.jsx` substitutes a generic portfolio effect and suppresses the precise source action when both occupy the Action row.
- `scripts/analyst_sidecar/finding_source_reports.py` requires an exact indexed ledger artifact to attach a report body. Older snapshot-only evidence can lack that body. Missing context must be repaired through verified source linkage, never supplied from a similar report.
- `scripts/analyst_sidecar/portfolio_brief.py::opportunity_signals` only lists unheld securities with bullish Trade and Trend. It provides no investment case, short candidates, counterevidence, range context, or reason to consider the idea now.

Keep the research ledger comprehensive. Derive PM attention from it separately: an ordinary observation can be important comparison evidence without belonging in the Inbox.

## What deserves an Inbox item

| Item | Evidence needed | What Tim should learn |
| --- | --- | --- |
| Portfolio issue | Verified current holding plus applicable published action or approved process rule | What is wrong now, which position it affects, the source/rule, and the remaining decision |
| Heavier/lighter opportunity | Research change or price/range setup interpreted through the existing sizing process | Why reconsider this exposure, what supports the adjustment, and what could argue against it |
| New-position idea | A specific thesis grounded in indexed Hedgeye research and a timely reason to consider it | Long or short case, why now, potential role in the book, supporting and conflicting evidence, and what to watch next |
| Market watch | A meaningful published change or verified comparable observation with a clear decision implication | What changed, over what period, why it matters, and what would confirm or weaken that interpretation |
| Account/dashboard issue | Verified financial exception or persistent failure of a decision dependency | The consequence for the PM and the concrete recovery step, where known |

A new report, ticker mention, healthy account reading, routine refresh, or unchanged signal is not sufficient by itself. An opposite-side source action is not automatically a conflict. An EWL sell report while already short should remain in research history unless separate evidence establishes a new relevant issue or constructive idea.

Broad market watches can be useful even without a current holding. Explicitly distinguish their general market importance from a demonstrated effect on Tim's book. Do not manufacture a held-security relationship to justify inclusion.

## How new ideas become astute analysis

Use the full indexed Security Intelligence universe, including unheld securities and both long and short candidates. Reuse the product registry to distinguish authoritative Trade/Trend publications from contextual products. A Portfolio Solutions listing, ETF Pro reading, sector thesis, or Macro Show discussion can support an idea without becoming a fabricated Trade signal.

For each shortlisted idea, assemble:

1. The investment case and its specific source evidence, with publication date and exact instrument identity.
2. Why it deserves attention now: an explicit source action, changed thesis, catalyst, signal transition, evidenced range development, or a newly relevant portfolio need.
3. Independently published Trade and Trend, where available, preserving their horizons and any disagreement.
4. A comparable Risk Range and verified price, when available, with observed date/time and quote status. Do not combine an index range with an ETF or different futures price.
5. Portfolio fit: existing direct/proxy exposure, overlap, cash capacity, and evidenced concentration or factor context. Only claim the instrument is unheld after a fresh complete holdings check.
6. The strongest evidenced counterargument and a concrete confirmation/invalidation condition. Use published thresholds when available; otherwise describe an observable condition without inventing a price.

The Analyst may synthesize an original constructive idea from several sources. Identify that synthesis as its own inference, cite the supporting facts, and preserve contrary evidence. Do not attribute the resulting recommendation to Hedgeye unless Hedgeye explicitly published it. Confidence should be explained through evidence, not an invented probability.

Keep three evidence states internally, without creating three UI areas:

| State | Meaning |
| --- | --- |
| Research idea | A supported thesis worth discussing or watching. Full Trade/Trend, a live quote, and a calculated size are not prerequisites. |
| Process setup | The existing process supports the direction and timing using independently published signals and comparable verified price/range evidence. Show the applicable observation status; this alone does not authorize executable sizing. |
| Sized action | The existing deterministic engine also has the fresh quote, NLV, beta/ATR, provenance, instrument, and funding evidence needed for its output. |

Use `src/utils/signalWeightedPositionSizing.js` and `portfolioReviewRules.js`; do not create competing rules in prompts. Honor Trade priority over Trend, the existing MIN/MAX and ATR logic, and the applicable entry/range conditions. An underweight label alone does not mean add. An attractive research idea can remain visible as a watch while current entry or sizing is unsupported.

Quad, liquidity, volume, dollar, and factor observations enrich the thesis. The saved Process governs their decision authority. Currently unresolved allocation limits or Quad size modifiers must remain descriptive; the model cannot promote them into approved rules. No automatic position, order, or allocation change is part of this plan.

## Market and operational coverage

Start with existing services rather than additional providers:

- Rates/curve: reuse date-aligned spread history from `server.js::buildSpreadBpsSeries`. Measure comparable 2Y/10Y observations and explain whether narrowing comes from the short or long end when both changes are evidenced. Avoid the mixed-time headline subtraction. Inversion/uninversion and published research warnings can establish relevance; ordinary narrowing requires an evidenced reason to matter, not an invented materiality threshold or automatic recession conclusion.
- Macro and flows: use dated Quad transitions, dollar/correlation changes, volatility, liquidity, market structure, volume, and the market calendar. Distinguish a published signal from model context and a scenario from an observed regime. Keep SPY volume distinct from market-wide volume.
- Portfolio/account: independently scan the verified full book with the existing rule evaluator, and reuse verified Balance Review exceptions for cash, funding, margin, and accounting discrepancies. Research events are not the only trigger. Healthy short exposure or interest accrual alone is not a problem.
- Dashboard: use `src/services/systemStatusService.cjs`, `src/services/systemReadinessService.cjs`, and product-specific research readiness. Group failures by their decision consequence, such as inability to verify current holdings. A confirmed blocking failure is actionable immediately; apply existing service health/retry policy to transient or ambiguous readings. Keep raw provider errors and monitor diagnostics in Systems/Sources.

Prioritize urgent process/financial issues and failures blocking reliable decisions, then time-sensitive opportunities, then contextual watches. Rank within those classes by evidenced portfolio impact, source significance, timeliness, and distinctiveness. Do not let a high-impact watch disappear behind a quota or pad the queue to a daily target. Combine items sharing a cause while retaining all affected instruments and sources.

## Dashboard-wide delivery and health monitoring

Maintain a structured coverage map connecting each configured dashboard feature to its products/providers, expected schedule, required processing stages, and consumer destinations. Cover the portfolio, research windows, Analyst, market overview, rates/FX/volatility, reference cards, events, and prediction-market surfaces as applicable. Audit the complete enabled feature/resource roster during implementation; a new registered product or destination must enter this map without a ticker-specific UI branch. Show missing monitoring coverage in Systems rather than assuming an unchecked feature is healthy.

For each expected publication, reconcile its identity, market/publication date, and latest verified revision through receipt, parsing, validation, storage/indexing, API delivery, and the data consumed by each configured destination. A successful email poll or upload does not establish that the dashboard received the product. One updated card does not establish that every intended destination is current. A closed window is not a delivery failure: verify its underlying consumer response; use a rendering/error signal where available to distinguish a display failure from a data failure.

Use the existing product registry and `src/utils/researchProductRegistry.cjs::isResearchProductDue`, with the shared exchange calendar and ET publication deadlines. Reconcile an existing inconsistency: the registry defaults Risk Ranges to 08:00 ET, while `src/utils/riskRangePublication.cjs::expectedRiskRangePublication` defaults to 08:15 ET. The proposed shared policy is an expected arrival at 08:00 ET with a 15-minute grace period before a missing-delivery alert; store it once and use it across Systems, research readiness, and Inbox. An explicit processing failure on a received publication can alert before that deadline. Respect holidays, weekends, daylight-saving changes, product-specific weekly schedules, and documented publication exceptions. Event-driven products are expected when a publication is observed, not automatically each morning. Yesterday's edition cannot satisfy today's due product.

Reuse `src/utils/researchPipelineCoverage.cjs` for stage/count reconciliation, `src/utils/systemReadiness.cjs` for dependency grouping, and `src/utils/gmailPollHealth.cjs` for scheduled-ingestion heartbeat checks. Extend these with independent publication discovery where supported and consumer readback. Track individual report/attachment identities and revisions: an earlier successful report on the same day cannot conceal a later missing edition, attachment, or transcript.

Distinguish these cases in the alert:

| Verified situation | Example message contract (illustrative, not a current incident) |
| --- | --- |
| Expected Risk Ranges edition is overdue and the receipt check is healthy | **Risk Ranges missing:** Today's expected report has not been received. Current range updates are unavailable. |
| Exact publication is known to be out, but no matching local receipt/upload exists | **Product not imported:** The report is available at its verified source, but has not reached the dashboard. |
| Receipt succeeded but parsing, validation, or storage failed | **Product processing failed:** The report arrived, but its data could not be loaded. Name the affected destination and useful recovery action. |
| Product is indexed but an intended destination still serves an older revision or no data | **Product missing from [destination]:** The report was received, but this view has not updated. |
| IB Gateway connection/account check fails | **IB Gateway disconnected:** Portfolio holdings and balances cannot refresh. Name login/reconnect only when the observed failure supports that step. |
| The Gmail/publisher/coverage check itself failed | **Research delivery cannot be verified:** The source check is unavailable. Do not assert that Hedgeye failed to publish or that an email never arrived. |

Monitor quote/session health, broker account coverage, ingestion, API availability, scheduled jobs, and the Analyst worker heartbeat alongside product delivery. Match expected freshness to the instrument's session and the product's cadence; ordinary after-hours last-close data or an unopened window is not an outage. A stale monitor cannot supply an all-clear.

Each operational item states the affected product/service, what is wrong, which dashboard function cannot update, when the issue began, and a supported next step. Link to its source or the relevant Systems detail. A verified missing product or broken view is itself a relevant dashboard issue; it does not need a held-position conflict to qualify. Keep raw stack traces, retry counters, and stage names out of the main copy unless they help Tim identify the problem.

Group dependent symptoms under a demonstrated root cause: one Gateway incident can explain unavailable holdings, balances, and related portfolio checks. Preserve affected destinations in the detail. If no common cause is established, do not invent one or suppress distinct failures. Check operational health independently of research completion, portfolio availability, and model generation, so a missing Risk Ranges product cannot prevent its own alert.

Track delivery incidents by product + expected edition + destination/root cause as appropriate. Update an existing incident as it moves from receipt failure to processing or delivery failure. Acknowledgment hides an unchanged incident but does not stop monitoring. A newly missed trading-day edition is a new expected obligation; if a continuing upstream outage explains it, update that incident's affected editions and notify again only for a material escalation or new required action. Mark recovery only after the required consumer data is verified. Remove resolved active rows and retain the resolution in history without routine recovery noise.

Reuse the existing Hermes/health supervision for monitor-heartbeat checks. If the local dashboard and delivery channel are both down, the Inbox cannot show an immediate alert: record the incident through the available independent supervisor and reconcile it when the channel returns. Do not claim continuous monitoring while the monitor is unavailable or add a new external notification channel as part of this plan.

## Compact message contract

Retain the existing fully bordered rows, square corners, directional colors, source footer, and immediate Acknowledge behavior. Use the ticker for a security item and a concise topic such as `Yield curve` for a market/account item. Keep relevant original dates visible with the existing 24-hour convention.

Security rows retain Current position and Position size when those facts are relevant and verified. For a verified new candidate, show `Not held`; an incomplete holdings response cannot establish that fact. Macro/account rows omit inapplicable position fields.

The first substantive line states the decision or concern precisely. Preserve the source action within the Action row, for example `Sell some — reduce the long position` or `Cover some — reduce the short position`, only when that action remains applicable. Do not flatten these into full exits or generic reduce text.

Use compact Context and relevant Trade, Trend, Underlying, and History rows to answer: what changed, why now, why it matters, and what would alter the conclusion. For ideas, include the case and watch condition in concise prose. Keep all evidence accessible from the footer. Do not add filler rows merely because a template contains them.

Selecting an item should let Tim discuss it through the existing Analyst conversation/composer, carrying the item's identity and evidence. A saved discussion stays tied to the evidence considered at the time; current recommendations refresh their required inputs.

An empty Inbox means no new items requiring attention. It must not imply every check succeeded when dependencies are unavailable.

## Identity, acknowledgment, and resolution

Create a durable condition identity independent of publication ID: account scope + instrument/topic + detector + rule or thesis + direction/horizon where relevant. Attach source documents and revisions to that condition. Distinct theses or horizons must not be merged merely because they share a ticker.

Persist `firstReportedAt`, `lastEvidenceAt`, source references, observation status, applicability, lifecycle, evidence fingerprint, material revision, and acknowledged revision. Preserve original change dates through repeated publication and reindexing.

Use “material change only” as the proposed acknowledgment default. Acknowledge immediately removes the row, saves in the background, and remains effective across refresh/restart. It does not assert that a trade occurred or that the concern was resolved. Restore only that row if saving fails.

Notify again for a materially changed conclusion, escalation, newly applicable action, or recurrence after verified resolution. New timestamps, quote noise, provider reconnection, duplicate imports, and unchanged confirmations do not reopen an item. Unchanged unresolved concerns remain available in history and the daily review.

Partial sell/cover actions need their own canonical scope. A smaller position alone does not prove compliance with a particular source instruction or justify another reduction. Use verified fills/holdings and an explicit quantity/target where available; otherwise state only the observed reduction and avoid claiming a required remainder. Acknowledgment prevents unchanged partial instructions from nagging indefinitely.

Outages mark current assessment unavailable rather than resolving conditions or preserving stale executable conclusions. Preserve research evidence. Publish at most the appropriate grouped dependency issue; reassess the original condition when verified inputs return.

## Implementation sequence

1. **Fix source meaning and relevance.** Normalize full/partial buy, sell, short, and cover actions once before policy and presentation. Repair exact-source body linkage with provenance checks. Exclude resolved, superseded, inapplicable, and no-change events from the active projection. Preserve the evidence ledger and existing acknowledgments.
2. **Add condition-based evaluation.** Introduce a small `src/services/analyst/attention/` service with separate evaluators for portfolio rules, source actions, opportunities, market watches, and dependency/account issues. Keep fetching outside React. Extend `scripts/analyst_sidecar/workspace.py` with additive issue/evidence/revision storage and expose it through the existing `/api/analyst/inbox` contract. Include a schema version and acknowledge the seen material revision so a concurrent escalation is not accidentally dismissed.
3. **Build constructive opportunity analysis.** Extend the existing universe capture and replace the shallow opportunity selector with a shortlist carrying citations, history, contrary evidence, and process results. Fetch exact documents, deeper history, and quote/sizing inputs only for that shortlist. Use the same candidates in Portfolio Review to avoid a second conflicting idea list.
4. **Connect the wider dashboard.** Add the coverage map, schedule-aware expected-publication checks, exact-edition/revision reconciliation across configured destinations, and broker/provider/worker health evaluators described above. Feed independently refreshed book/account data and changed macro/source observations into the evaluators. Reuse the existing worker and Hermes integration; schedule source acquisition by its own cadence. A five-second worker tick must not refetch every series or run a model each time. Operational, account, and portfolio checks must continue independently of the all-products daily review gate. Reuse existing authorized recovery mechanisms; reporting an incident does not authorize new repairs or change credentials.
5. **Add bounded synthesis and presentation.** Give Hermes captured, versioned evidence plus deterministic evaluator results. Let it explain and compare, including counterarguments. Validate citations, numerical claims, action scope, and evidence version before publishing. Reject or recompute output if the evidence changed while generation ran. Model failure must not suppress deterministic urgent issues. Preserve existing cost controls.
6. **Migrate and verify.** Build condition state from the ledger/current verified state, map legacy evidence and acknowledgments, and retain the old records. Backfill establishes comparison history; it must not flood the Inbox with historical changes. Publish currently verified unresolved breaches with their original dates, and source-backed timely ideas without falsely labeling old research as a new signal. Make migration idempotent and review the resulting queue before switching the projection.

## Acceptance checks

- EWL sell + already short produces no conflict without an independent applicable reason.
- Sell-SOME and Cover-SOME retain exact meaning across parsing, persistence, display, and resolution; a headline cannot override the exact applicable body instruction.
- A new unheld long or short idea can appear with dated evidence, thesis, counterevidence, and a watch condition. A ticker mention or aligned signal tuple alone cannot.
- A useful research idea survives loss of an executable quote, while current entry/size is withheld. Missing holdings cannot become `Not held` or a fabricated portfolio-fit claim.
- Trade/Trend disagreement or the wrong range half cannot produce an eligible open/add action. Exits and reductions still follow the existing process precedence, including adverse Trade or Trend changes. Proxy mismatch and incomplete required inputs cannot produce executable sizing; the existing deterministic rules remain authoritative.
- Offline, stale, cache-only, seeded, mock, delayed, and last-close cases preserve their correct evidence status and never appear as live executable data.
- Curve comparisons use compatible dates/sources. Source-backed macro watches can appear without a held instrument, with no invented portfolio effect or forecast.
- Duplicate reports, replay, imports, restarts, and unchanged confirmations preserve identity, original date, and acknowledgment. Genuine escalation and recurrence notify exactly once.
- Acknowledgment remains immediate and supports successive clicks; failure restores only the affected row. Concurrent newer revisions survive acknowledgment of an older one.
- Provider failure neither resolves a financial issue nor produces a separate noisy alert per security. Recovery alone does not revive acknowledged unchanged items.
- Missing morning Risk Ranges alerts only after the shared configured deadline/grace on a trading day. Pre-deadline, weekend, holiday, and documented nonpublication cases remain quiet. Test ET daylight-saving boundaries, late arrival, weekly/event-driven product schedules, and identical due decisions across Systems, research readiness, and Inbox.
- A verified published report with no matching receipt, an arrived report that failed processing, and an indexed report missing from one consumer produce distinct truthful explanations. A successful upstream stage or updated sibling destination cannot mask the failed destination; corrected revisions must propagate as well.
- A failed Gmail/source check produces a verification/outage incident, not an unsupported claim that the publisher failed to publish. Stale coverage evidence cannot establish delivery success or absence.
- Confirmed Gateway disconnection produces a concise issue explaining the blocked portfolio update. Dependent holdings/balance symptoms group under that incident; fresh verified account and consumer data are required to resolve it. A freshly verified empty portfolio is valid; reconnection alone and partial account coverage are insufficient.
- Monitoring runs with no new research events, before daily reviews are ready, and while the Analyst model is unavailable. Test stale worker heartbeat, restart reconciliation, and persistence across acknowledgment.
- The coverage map accounts for every enabled dashboard feature and its expected destinations. Closed windows do not trigger false delivery failures; actual consumer mismatch or rendering failure does.
- Baseline observations support before/after comparisons without masquerading as new changes. Source corrections replace/revoke the affected claims while retaining history.
- Model output cannot invent sources, prices, signals, thresholds, approved limits, targets, or attributed source recommendations. A stale generation cannot overwrite a newer evaluation.

Validation covers policy/projection/store/UI behavior, fresh and unavailable evidence, source scope, acknowledgment races, lifecycle, publication schedules, and consumer failures. Focused tests and the production build pass. Existing unrelated prediction-review and Sources-label tests fail on the prior code as well. The repository contains extensive unrelated working-tree changes, which remain untouched.
