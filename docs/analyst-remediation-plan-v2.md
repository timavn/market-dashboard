# Analyst remediation plan, version 2 (revised 2026-10-09)

**Goal (unchanged).** All four modes are fast and reliable. The Sources table always says what is happening. The Analyst never shows a false "IB Gateway unavailable" and never loses a chat. Each mode's sources and the report template/content stay exactly as they are.

**How this version was produced.** I checked the first plan read-only against the code, the logs and both stores. Eight investigators covered one area each, a skeptic tried to disprove each finding, and a final critic looked for anything they all missed. 121 findings were raised and 119 survived. Nothing in the repo or the stores was changed.

---

## 1. What changed and why

### Corrections to the first plan's facts

| First plan said | What the evidence shows | Consequence |
|---|---|---|
| The review store uses a rollback journal | Both stores are in **WAL mode** (header bytes 18/19 = 2) | A `cp` backup can be torn. Read-only inspection must open with `?mode=ro&immutable=1`; plain `-readonly` fails with CANTOPEN when no `-shm` file exists. |
| The 20:35Z incident shows the mechanism is still live | dc5c5fd5, 8b7c5439 and 2431e33c ran on the **pre-13:46 build** (sidecar PID 23565). Codex edited app.py, market.py, review_runs_v2.py and the governor at 13:40–13:43 and moved the incident's blocker (synchronous report builders run during portfolio finalization) to `to_thread`. | Re-baseline on current code before fixing anything. Starvation still happens on current code (b309f2e4, 019f8052) but for different reasons; see Step 4. |
| A concurrent-review fan-out starved the loop | Concurrent tasks cannot starve asyncio. Synchronous or GIL-bound work does. It still happens with a single review running. | Queueing whole reviews is the wrong fix (Section 3). |
| "3.26 GB SQLite read" in the preflight | It is one primary-key row lookup; the whole preflight takes about 1 s or less | Not a target. |
| Root cause C: freshness margin of about 0.25 s caused 2431e33c | 2431e33c probed `/livez` under old code. **No stored run has ever failed root cause C.** The heartbeat refreshes on demand; the maximum served age is 14.22 s, so the margin is about 1 s. | Drop the `max_age` contract change. |
| Root cause B makes the IB Gateway row show Disconnected | For current captures the explicit `ibGateway` row already wins (b309f2e4 shows "IB Gateway · Connected") | The real harm is holdings silently failing (Held Event-Contract Exposure blocked, Manual fails outright). The precheck exists in **three** functions, not one. |
| Manual uses a "60 s gateway window" | It is the **same 1 s probe**; 60 s is only a freshness check | Manual has the same false-verdict defect and needs the same fixes. |
| The `AnalystPanel.jsx` re-exports cause full page reloads | **Refuted.** ui.log today: 34 `hmr update AnalystWorkspace.jsx`, 0 page reloads, 0 mentions of AnalystPanel | Today's self-refreshes were Vite restarts during controller **stack restarts on code drift**. |
| 17 unexplained deletes; asks the user whether they did it | 17 is a UTC-day count (9 fall on the PDT day). All 17 match one-to-one with sidebar trash clicks → `DELETE /api/analyst/conversations/:id` → `/internal/workspace/delete`. No agent, script, Hermes or automatic code path deleted anything. 11 of 17 were followed by a relaunch within 11 s, and 4 cancelled reviews that were still running. | Deleting was the user restarting slow or stuck reviews, so the root fix is Steps 3–6. The real chat-loss bug is client-side eviction (Step 7). The user's 08:31 "disappeared on refresh" chat was not tombstoned. |
| PCA: "the only success took 3187 ms against a 1 s cap" | That run had a 24 s budget. **8 of 8 reads since the 1 s cap began have failed**, from a 2.5 MB read plus decoding and `_clean` run twice on the loop. | Make the read fast. Raising the cap would break AGENTS.md:79. |
| Balance averages 11.0 s | That is the capture only. Click to settled is about 63 s including the Hermes model phase (37.8 s). Manual's model phase took 182.7 s. | Measure every mode per phase. |
| predictionUniverse is 10.8 MB per row | About 6 MB over the last 7 days | Minor. |
| server.js at 85 % of a core from SSE polling | server.js runs at 57–100 % **with the Analyst closed** | The SSE poll is not the main CPU source. |
| "813 untracked files" | 11,758 files, 734 MB | `git add -A` is unsafe (Step 0). |

### Major gaps the first plan missed

1. **The whole stack runs at background priority.** The LaunchAgent sets `ProcessType=Background` (`ops/launchd/com.market-dashboard.stack.plist.template:24-25`). Every stack process runs at PRI 4; an interactive shell runs at 31. On the M2 that means efficiency cores only and throttled disk I/O. The alpha scan took 9.35 s at normal priority and 24.37 s under `taskpolicy -b`, a 2.6× difference. This is likely the single largest speed lever, and it needs no app-code change.
2. **The Predictive alpha-code archive scan times out at 30 s on every run** (5 of 5 recent runs; `prediction_research_reader.py:26`). It scans all history (5,339 documents). The timed-out executor thread keeps using CPU and holding the GIL afterwards. This is the 30–40 s silent window in which the user deleted and relaunched reviews.
3. **Running work in `to_thread` does not free the event loop when the work holds the GIL.** Python 3.11 has the GIL enabled. JSON encode and decode of multi-MB payloads holds it for the whole call. The PCA watchdog recorded loop lag of 46–734 ms, and trivial workspace operations took 1.1–4.5 s during run 019f8052.
4. **Tests can damage the live stores.** `test_ibkr_review_readiness.py:12`, `test_workspace_response_latency.py:9` and `test_portfolio_brief.py:30` import `app` before setting `ANALYST_DATA_DIR`. Importing app.py (`app.py:172-186`) opens the live stores, runs migrations and marks every in-flight live review **failed** (REVIEW_PROCESS_RESTARTED). Codex ran exactly such commands today. The first plan's "baseline tests first" step would do this.
5. **Codex has been working on the same problem in the same tree.** Nine Codex sessions ran today. They implemented a plan called "Repair Analyst updates and persistent chats" and edited app.py, market.py, review_runs_v2.py, workspace.py, AnalystWorkspace.jsx, the governor, the readiness tests and AGENTS.md:83-85. Codex's snapshot ref `eb84101c` (13:50) matches every current target file.
6. **The reliability controller restarts the stack on code drift.** `DASHBOARD_CODE_VERSION_DRIFT` triggered `restart-local-stack` at 20:45:05Z, about 5 minutes after edits. That killed prediction run 019f8052 and reloaded the page. It also restarted the IBKR sidecar about 18 times today. Every edit made under this plan will trigger the same thing.
7. **Some of today's "unavailable" verdicts were real.** The controller recorded IBKR_GATEWAY_API_UNRESPONSIVE from 11:01 to 12:27 PDT and NOT_AUTHENTICATED from 15:07 to 15:14 PDT. "Every failure is local" is a point-in-time observation, not a rule.
8. **Client paths that drop a chat without any deletion.** `load()` calls `forget()` on any HTTP 404 (`AnalystWorkspace.jsx:386`) and on `archived` (`:375`). The sidecar maps every Python KeyError to 404. `forget()` removes the selection, the sidebar receipt, the draft and the scroll position. AGENTS.md:84 allows this only on a verified deletion.
9. **Cold-start lockup.** `/events` returns 503 while the sidecar is down. Under the EventSource spec a non-200 response closes the stream permanently, and it is never recreated. `list()`/`load()` stop retrying after about 0.6 s. The Analyst stays on "Reconnecting…" until the user reopens it.
10. **The delete hazard is a row sliding under the pointer.** On click the row is filtered out immediately (`AnalystWorkspace.jsx:1119`), so the next row moves under the cursor. The trash icon sits 1 px from refresh (`AnalystPanel.css:806-817`). Double and triple clicks delete several rows: bursts were 0.85 s or less apart.
11. **A deadline failure overwrites the partial report.** At 75/90/20 s the `failed` frame replaces the progressively published report with one line, which conflicts with AGENTS.md:78-79.
12. **The client shows false "IB Gateway · Unavailable" with no check at all.** Two `/sources` read misses on a saved review turn every Checking row into Unavailable (`AnalystReviewSources.jsx:112`), including the derived IB Gateway row. This is likely the most common false verdict a user sees.
13. **Express labels any IBKR-sidecar `/accounts ok:false` as GATEWAY_UNAVAILABLE** (`ibkrPortfolioDataProvider.js:41-49`; 908 lines today). The dedicated funding, balance and observation clients do the same (ibkr `app.py:7293, :7684, :8062`).
14. **Manual-mode specifics.**
    - The Express poller kills a healthy capture after 3 failed status reads (`analystManualVerification.cjs:27-33`).
    - The Express and sidecar 180 s deadlines are nested, so Express fires first.
    - Manual rows orphaned by an unclean sidecar exit are never cleaned up.
15. **An in-flight review launch cannot be restored after a reload.** Its request ID lives only in memory, and the start POST can take up to 45 s.
16. **More load the plan did not count.**
    - A second always-on 5 s inbox poller (`DashboardTopNavigation.jsx:77`) downloads 2.37 MB of findings to render 56 KB.
    - The 30 s attention scan makes about 20 local broker/API calls per cycle, duplicating review acquisition.
    - The analystDaily tick overruns its 5 s interval (about 11 s effective).
    - `/sources` re-reads and parses about 10.6 MB of evidence on every poll.
17. **Eastern-midnight boundary (21:00 PDT).** Evening launches create a conversation dated tomorrow and listed under a future date heading. No test covers it.
18. **Problems can't be traced to a cause today.** IBKR_GATEWAY_READINESS_TIMEOUT comes from four different mechanisms. Nothing measures loop lag. Log lines have no timestamps. Express keeps stage diagnostics for only 3 runs, in memory.

---

## 2. Revised order of work

Each step is batched so it needs **one restart outside active reviews**. Each step has its own tests and a measured before/after.

0. Safety: coordination, checkpoint, backups, test isolation, restart procedure
1. Diagnostics-only instrumentation, then re-baseline on current code
2. Host fixes: process priority and controller restart policy *(need your approval)*
3. Predictive silent window and live Sources progress, which stop the delete-and-relaunch pattern
4. Event-loop blocking and redundant load
5. Gateway verdict fixes across all four modes
6. Deadline failures keep the partial report
7. Chat persistence: no unverified eviction, cold-start recovery, safe delete
8. Loading UI
9. Final verification

The first plan put chat deletion first. The evidence points the other way: most deletes were reactions to Steps 3–6 problems, and nothing was deleted by code.

---

## Step 0 — Safety (replaces the first plan's Step 0)

**0.1 Coordinate with Codex (blocking).**
- Confirm that the Codex threads on this repo are finished or paused before any edit.
- Read Codex's "Repair Analyst updates and persistent chats" plan and its 13:20–13:50 edits, so this plan neither redoes nor reverts them.
- Treat AGENTS.md:83-85 as freshly user-directed.
- Preserve Codex's snapshot: `git update-ref refs/local-checkpoints/codex-1350 eb84101ce41766b6f0643d3a4ff80a5a4a797025`.

**0.2 Checkpoint without `git add -A`.** Do not use `git switch -c … && git add -A && git commit`. It would sweep in:
- 11,758 files (about 300 MB compressed), including a 60 MB file over GitHub's warning size
- personal PDFs and licensed research screenshots
- unrelated infra WIP
- the deletion of `deploy.yml`

Use a temporary index and a non-branch ref instead. This leaves HEAD, the branch, the real index (and its stale lock) and the working tree untouched. It runs no hooks, and plain `git push` and `git push --all` never push it.
```bash
cd /Users/timsmith/Desktop/cursor/market-dashboard
TMPIDX="$(mktemp -t md-ckpt-index)"; rm -f "$TMPIDX"
GIT_INDEX_FILE="$TMPIDX" git read-tree HEAD
GIT_INDEX_FILE="$TMPIDX" git add -A
GIT_INDEX_FILE="$TMPIDX" git rm --cached -r -q --ignore-unmatch artifacts public/research/bitcoin output/pdf data/research/hedgai/sources
TREE=$(GIT_INDEX_FILE="$TMPIDX" git write-tree)
C=$(git commit-tree "$TREE" -p HEAD -m 'LOCAL ONLY checkpoint before analyst fixes 2026-10-09 - never push')
git update-ref refs/local-checkpoints/analyst-fix-20261009 "$C"; rm -f "$TMPIDX"
```
`.git/index.lock` does not need to be removed for this. Leave it until you confirm no Codex git operation is running.

**0.3 Backups through the SQLite backup API, not `cp`.**
- Back up `analyst_workspace.sqlite3`, `analyst_reviews_v2.sqlite3`, `research.sqlite3` and Hermes `state.db`.
- Use Python's `sqlite3` `.backup()`. The code already does this at `review_runs_v2.py:316-317`.
- 94 GiB is free, which is enough.

**0.4 Fix test isolation before running any test.**
- Prefix every Python test command with `ANALYST_DATA_DIR="$(mktemp -d -t analyst-test)"`.
- Add the `os.environ.setdefault('ANALYST_DATA_DIR', …)` header (the same one as `test_prediction_checkpoint.py:13-16`) above `import app` in the three modules listed in Gap 4.
- Make `scripts/testing/run-python.cjs` *override* `ANALYST_DATA_DIR` with a fresh temp directory for the analyst group.
- Only then record the baseline.
- The "known pre-existing" `analystWorkspace.test.cjs` failure is plausible but unconfirmed, and Codex edited the file today. Re-measure it rather than assume it.

**0.5 Restart procedure for every step.**
1. Confirm zero queued or running runs, using a `mode=ro&immutable=1` query on `analyst_review_runs_v2`.
2. Confirm no Manual capture is acquiring, and that controller.log shows `inFlightAction` null.
3. Run a write-free syntax check: `python -c "import ast,sys;[ast.parse(open(f).read()) for f in sys.argv[1:]]" scripts/analyst_sidecar/*.py`.
4. Send SIGTERM to the analyst sidecar only.
5. Wait for `/livez` and for the Analyst contract to verify (up to 240 s).
6. Every manual kill counts toward the monitor's limit of 5 restarts in 5 minutes.
7. Changes to `.cjs` files need an Express restart. Changes to `.jsx` files hot-reload into your open tab.

**0.6 Where verification happens.**
- Repeated, back-to-back, reload-mid-run and HMR checks run on the isolated smoke harness. Use API on 3101, UI on 3100, sidecar on 6952, Hermes on 9122, and a temporary `ANALYST_DATA_DIR`. It has no launcher yet, so document one.
- Live checks are one approved run per mode at the end. Agree beforehand what happens to the daily reviews it refreshes and to any new Manual chat.

## Step 1 — Instrumentation only (no behaviour change, one restart)

- Add a **thread-based loop-lag sampler** that writes a timestamped line whenever lag exceeds 250 ms.
- On every gateway verdict, record which bound fired (outer, inner, producer or `/status`), plus `ioMs` and `loopLagMs`.
- Write them to run `diagnostics_json`, **not** to evidence or checkpoint detail, so fingerprints and saved captures stay byte-identical.
- Add timestamped Python logging and a uvicorn access format with the runId.
- Persist the Express stage diagnostics, which are currently kept for 3 runs in memory.
- Add a delete audit record: when, kind, title, trading_date, message_count, user-agent.
- Add per-phase timings for all **four** modes: capture, Hermes model phase, and click to settled.
- **Re-baseline on current code.** Record per mode and phase: deadline failures, loop-lag p99, false-verdict count, and deletes within N seconds of a launch.

## Step 2 — Host fixes *(each is a persistent config change and needs your yes)*

1. Change the template at `ops/launchd/com.market-dashboard.stack.plist.template:24-25` from `ProcessType Background` to `Standard`.
2. Reinstall it with `scripts/ops/install_launchagent.sh`.
3. Confirm the stack runs at PRI 31 (`ps -o pri`), then re-baseline. The trade-off is more performance-core use and battery draw.
4. Make the reliability controller **defer `restart-local-stack` on code drift** while any Analyst run, turn or Manual capture is active.
5. Separately, find out why the controller restarted the IBKR sidecar about 18 times today. Each restart costs about 60 s in which no mode can verify the gateway.

## Step 3 — Predictive silent window and live Sources progress

**Alpha-code scan.**
- Keep the research-first ordering. It is documented anti-contention (`app.py:3047-3048, :3065-3067`) and pinned by `test_review_latency.py:1117-1153`.
- Fix the scan itself instead:
  - Cache per-document alpha candidates keyed by (documentId, contentHash, parserVersion, scannerVersion), at index time or on first use.
  - Aggregate them per review, applying the cutoff at aggregation.
  - Add a per-document cancel flag so a timed-out scan frees the executor.
- Prove the output is identical by replaying `scan_alpha_codes` against saved cutoffs.
- **Content note:** alpha codes will start appearing where runs are currently "partial". That restores the intended source but is visible, so it needs your approval.

**Push Sources progress instead of polling for it.**
- After each commit, set an in-memory notifier from both the workspace dispatch and `ReviewExecutionContext.checkpoint`, using `call_soon_threadsafe`.
- Expose a long-poll `events` operation on it.
- Run **one shared Express poller** that fans out to every SSE client, replacing one 750 ms timer per connection.
- Send a dedicated `source-progress` event that the browser routes to `revalidateSources(id)` only, never to `load(id)`.
- Lower the fallback poll only after the push path is proven. The first plan's 750 ms → 15 s change would have delayed every sidecar-written event, including its own checkpoint events and Manual `revision` events.

**Make `/sources` cheap.**
- Add an LRU of parsed evidence keyed by fingerprint, and memoize the output for terminal runs. Alternatively, persist a compact per-source summary at checkpoint time.
- Gate the change on byte-identical `/sources` output for saved runs.
- After that, raising the 3 s client timeout to 10 s is only a safety margin.

## Step 4 — Event-loop blocking and redundant load (byte-identical changes first)

- Move the remaining on-loop builders (`app.py:2792-2998`) into `to_thread`.
- PCA: move the `response.json()` decode (`portfolio_pca_review.py:233`) and `_clean` off the loop, and run `_clean` once instead of twice (`:244-266`). Keep the bounded 1 s read (AGENTS.md:79).
- Move the synchronous `readiness`, `changes` and `set_sync_state` SQLite calls (`app.py:4286-4294, 4323, 4332`) off the loop.
- Share one `httpx.AsyncClient` per base URL. `market.py:1522` builds a new client inside the 1 s bound on every call.
- Checkpoint micro-fixes:
  - Compute the fingerprint from the string that is already serialized.
  - Skip the discarded `self.get()` after `merge_dependency`.
  - Keep `canonical_json` exactly as it is, so fingerprints and report revisions stay stable.
- Give CPU-heavy report builders their **own small executor**, separate from store work and from the probe.
- Defer the 30 s attention scan while a Portfolio or Predictive review is queued or acquiring, skipping at most 2 cycles in a row.
- Stop the `DashboardTopNavigation.jsx:77` poller while the Analyst is open.
- Add an inbox-only findings projection with a single-flight cache.
- Add a `documents(product, publication_date)` index for the 72 unindexed source-report lookups.
- Cache the attention `enabled()` setting, and stop polling the archived list once restoration is done.
- Portfolio finalization takes 9–17 s after the last source. Add phase timestamps, then profile `build_portfolio_refresh` and the Express `portfolio-refresh-research` route.
- **Gate:** saved runs must replay byte-identical in `sections_json`, `report_markdown` and `/sources`.

## Step 5 — Gateway verdicts in all four modes

**Probe.**
- Run the GET in `IbkrReader.readiness` on a **dedicated 1–2 worker executor**, never the default pool.
- Inside that thread, measure the I/O time, the receipt time and the heartbeat age.
- Keep the async signature and both `wait_for` layers, so `test_ibkr_review_readiness.py` keeps its under-1.3 s limits.
- Add a "probe busy" short-circuit.
- If a timeout coincides with `loopLagMs` over 250 ms, classify it "unverified – local contention" and re-probe once. Never re-probe an at-budget timeout.

**Keep "any unverified result ends the attempt"** for Portfolio, Predictive and Manual. The binding tests (`:179-206`, `:208-226`, `:267-291`) and AGENTS.md:79 require it. The fix is to stop producing *false* unverified results. For non-disconnect results, stamp the untried dependents with a non-gateway code. Reserve gateway codes for a verified disconnect.

**Holdings.**
- Remove the `/status` precheck from `holdings_context`, `portfolio_context` **and** `market_snapshot` together. `/portfolio/live-positions` plus the validator at `market.py:1766-1775` remain the guard.
- Map transport errors and a live-positions 503 to holdings-scoped codes, and add them to `CAPTURE_FAILURES` (`analystReviewSources.cjs:45-50`).
- Rewrite `test_balance_holdings.py` deliberately.

**Balance and funding.**
- Map `/accounts ok:false` (`ibkrPortfolioDataProvider.js:41-49`) by its `status` field.
- Do the same for dedicated-client GATEWAY_UNAVAILABLE.
- Keep GATEWAY_UNAVAILABLE only for a verified not-connected or not-authenticated state.

**Producer.** Split "socket not yet connected or reconnecting" from a true NOT_AUTHENTICATED (governor `:646-648`) before treating it as a verified disconnect.

**Manual.**
- Apply the same probe fixes.
- Treat failed status reads as transient until the overall deadline, stopping only on a definitive 404 or 409.
- Set the Express deadline to the sidecar budget plus a margin.
- Settle orphaned queued or acquiring rows as MANUAL_VERIFICATION_RESTARTED during **lifespan startup, not at import**.

**Display.**
- A read failure must leave rows non-terminal, with bounded retries and a way to revalidate. It must never map Checking to Unavailable at `AnalystReviewSources.jsx:112` (AGENTS.md:69).
- Do **not** switch the IB Gateway row to "explicit capture only". It does nothing for new captures and would rewrite 807 legacy saved runs, flipping 191 "Connected" rows to Unavailable.

## Step 6 — Deadline failures

- A terminal failure that follows a published progressive revision must not overwrite the message text. Append a compact status line instead, and settle unfinished sources.
- Showing the partial report body on failed runs changes what saved failed reviews display, so it needs your approval.
- Update `test_review_runs_v2.py:941` deliberately.
- Measure every Step 3–5 change against each mode's deadline.

## Step 7 — Chat persistence

**No unverified eviction.**
- The sidecar returns explicit codes: 404 `ANALYST_CONVERSATION_NOT_FOUND`, or 410 `ANALYST_CONVERSATION_DELETED` when a tombstone exists. Every other KeyError becomes a 500.
- The client evicts only on those codes, on a `deleted` SSE frame, or after its own delete is verified.
- Archived rows are excluded from the list but never `forget()`-ed.
- Add negative tests.

**Cold-start recovery.**
- When `stream.readyState === EventSource.CLOSED`, recreate the stream with capped backoff (1, 2, 4 … 15 s).
- Reconnect with `after=<observedCursor>` so old events are not replayed (AGENTS.md:84).
- Retry failed `list`/`load` with the same backoff while the panel is active.
- On the server, answer an unavailable stream with a 200 and an `unavailable` event instead of a 503.

**Restore in-flight launches.** Persist only `{kind, requestId, tradingDate, launchKey}`, which AGENTS.md:84 allows. Reconcile it on reload and reuse the requestId on a second click.

**Safe delete.** Keep the row in place as a disabled "Deleting…" row until the server acknowledges. An inline confirm, spacing changes and Undo are your call. Undo needs a restore operation that does not exist yet.

**Recovery offer.** Everything deleted today is still recoverable: the review-store runs succeeded, and Hermes `state.db` holds the transcripts. A restore would be an explicit user action that clears the tombstone.

**Cross-store consistency.**
- Filter `GET /review-conversations` by workspace tombstones when reading.
- Remove the dead archive route.
- Do **not** hard-delete review-store data. Evidence is shared and deduplicated across runs, "since previous close" reads runs from deleted chats, and two WAL files cannot be deleted atomically. The store also returns 409 while a run is active.

**Timing.** One delete held the workspace write lock for 22.7 s, longer than the 15 s browser timeout. Time each statement in the delete transaction; it is likely the same contention as Step 4.

## Step 8 — Loading UI

- Close the real stuck paths first: path 1, and the read-failure mapping fixed in Step 5.
- Give each `missing` row a **typed reason** computed when the Sources payload is built, with no evidence change. Show it as one short gray word: `Late`, `Missing`, `Not checked` or `Not due`.
- Leave only `optional:true` rows and settled not-due rows out of the N/M ready count. The first plan's blanket "Not due" would have hidden late, rejected and never-attempted required sources.
- Show liveness in two ways:
  - Spin the Checking icon, reusing `analyst-spin` and respecting `prefers-reduced-motion`.
  - Show one gray `aria-hidden` **header** clock counting from run start. Reviews use `capturedAt`, which is the run's createdAt; add `startedAt` for Manual.
- **No live per-row clocks yet.**
  - No per-source start time exists anywhere.
  - Predictive rows start about 38 s after the run is created, so a clock from run start would be wrong for them.
  - Writing a "started" checkpoint would break the code that treats any recorded checkpoint as settled.
  - If per-row clocks are wanted later, keep an in-memory start map per run, exposed only while the run is active.
- Show a settled row's elapsed time only in its popup, in gray, never in the blue date style (AGENTS.md:80).
- No amber: it breaks the shared green/red/gray rule (AGENTS.md:68) and would fire on healthy 22 s rows. If wanted, show a gray "Taking longer than usual" hint derived from `deadlineAt`.
- Show the model phase ("summarizing") distinctly for Balance and Manual.
- No new retry button.
- Sources sits inside `role=log aria-live=polite`, so any ticking text must be `aria-hidden`.

## Step 9 — Final verification

- **Byte-identical replay** of saved runs, except restorations you approved.
- **Targets measured against the Step 1 baseline:**
  - loop-lag p99 under about 50 ms during concurrent runs
  - zero false gateway verdicts
  - click-to-settled time per mode and phase
  - fewer deadline failures
  - fewer deletes within N seconds of a launch
- **Live checks:** one approved run per mode in a quiet window, including one launch **after 21:00 PDT** and one with **two Analyst windows** open.

---

## 3. Dropped from the first plan, and why

- **Queueing the daily reviews.** Deadlines are fixed when a run is created, so a 20 s Balance Review queued behind a Portfolio Review would fail before it started. It also misses Manual and the background jobs, conflicts with AGENTS.md:70, and adds 47–85 s of waiting.
- **Continuing after an unverified gateway check.** Contradicts the binding tests and AGENTS.md:79. It would be a product change needing your explicit consent.
- **An environment-variable timeout above 1 s.** It masks the problem, and AGENTS.md:79 requires about 1 s.
- **`max_age` in `/gateway-readiness`.** No failure was ever caused by it, and it breaks 3 exact-payload IBKR tests.
- **Deriving the IB Gateway row only from the explicit capture.** It rewrites saved history.
- **Hard delete with a `deleted_review_conversations` tombstone, prune and VACUUM.**
  - VACUUM gives no speed: the freelist is 41 pages, and 4,590 of 4,605 evidence rows are still referenced.
  - It destroys today's only recovery path.
  - It cannot be atomic across two WAL files.
- **A longer PCA timeout, or showing PCA as "skipped".** Breaks AGENTS.md:79 and misreports the source's status.
- **Running the gateway probe concurrently with other work.** Breaks AGENTS.md:79's check-before-acquire rule and saves almost nothing.
- **Overlapping Predictive research with the market fetch.** Reverses a documented anti-contention fix.
- **SSE fallback 750 ms → 15 s before a push path exists.** It would delay every event the sidecar writes.
- **A blind LIMIT on findings, or no longer writing inbox events.** Both change Inbox behaviour.
- **Moving the AnalystPanel re-exports and dropping the `historyLoaded` gate.** The first is refuted; the second has little effect and adds risk.
- **Amber, a blanket "Not due" and 1 Hz per-row clocks.** See Step 8.

## 4. Decisions needed from you

1. **Codex:** are the Codex threads on this repo finished or paused? Should this work build on Codex's "Repair Analyst updates and persistent chats" changes?
2. **Process priority:** may I change the LaunchAgent from `Background` to `Standard`?
3. **Controller:** should it defer stack restarts on code drift while Analyst work is in flight?
4. **Deletes:** were you deleting reviews to restart slow or stuck ones? Do you want today's deleted reviews and chats restored? For the delete guard, is keep-in-place "Deleting…" enough, or do you also want a confirm and/or Undo?
5. **Visible content restorations:** may alpha codes (Predictive) and the PCA section (Portfolio) reappear once they stop timing out? Should a deadline-failed review keep its partial report?
6. **Wording:**
   - "Unverified" for gateway checks that failed without a verified disconnect.
   - `Late` / `Missing` / `Not checked` / `Not due` for missing-source rows.
7. **Evening launches** (after 21:00 PDT, already the next Eastern trading date): how should they be labeled and grouped in the sidebar?
