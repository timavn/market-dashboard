# The Analyst shadow acceptance log

Shadow start: _not started_
Earliest eligible cutover date: _not set_
Owner: Tim

Do not disable legacy schedules or remove legacy surfaces until this log covers at least seven calendar days and every required check passes.

This file is a machine-enforced cutover input. Use ISO dates or timestamps for the first two fields. For every required run, fill all five evidence columns and begin Result with `Pass`, `Success`, `Accepted`, `OK`, or `✅`. Check every box, then set Decision to `approved`, `pass`, or `accepted` with an ISO decision date and reviewer. Set the rollback-retention end date at least 30 calendar days after the cutover validation date. Do not pre-check an item without its evidence.

## Required on-demand runs

| Date/time | Question | Result | Citation/date accuracy | Degradation handled correctly | Notes |
|---|---|---|---|---|---|
|  | Brief me now #1 |  |  |  |  |
|  | Brief me now #2 |  |  |  |  |
|  | Brief me now #3 |  |  |  |  |
|  | Brief me now #4 |  |  |  |  |
|  | Brief me now #5 |  |  |  |  |
|  | Historical research search |  |  |  |  |
|  | Compare research with portfolio |  |  |  |  |
|  | Market history / chart question |  |  |  |  |

## Acceptance gates

- [ ] Every registered product plus Monthly Inflation Nowcast appeared in each briefing packet.
- [ ] `available`, `not due`, `late`, `indexing`, `failed`, and `missing` were shown accurately when applicable.
- [ ] No old publication was described as newly published.
- [ ] Every Hedgeye claim used a validated source chip that resolved to the exact email, artifact, or PDF page.
- [ ] A no-match archive query returned “not found” without an uncited answer.
- [ ] Disconnected or stale IBKR tests showed no current quote, market value, allocation, or P/L fallback.
- [ ] OpenBB output retained its provider and historical/delayed label and was never described as verified-live.
- [ ] Responses contained only cited Hedgeye views and verified market or portfolio facts, with no unsourced interpretation.
- [ ] Chat resume, New Chat, history, streaming, Stop, and reconnect behaved correctly.
- [ ] Fresh load and New Chat showed a blank landing with only the three centered review actions; no Quick Reviews section, fixed review rows, top review bar, automatic selection, or attempt picker appeared.
- [ ] Each first prompt or review launch created exactly one creation-dated sidebar row; background updates never changed selection or reordered older rows.
- [ ] Same-kind active launches reused the running conversation, different kinds ran concurrently, and retry appended in place with fresh verified-live data.
- [ ] Hiding Analyst stopped its WebSocket and all review polling; a Hermes restart reconnected automatically without interrupting server-owned reviews or requiring a dashboard reload.
- [ ] Review summary/status payloads stayed compact, managed follow-up sessions never appeared as duplicate ordinary chats, and streaming Markdown was parsed only after completion.
- [ ] Valid, invalid-signature, oversize, missing-date, duplicate, parser-failure, and retry PDF flows behaved correctly.
- [ ] The deep Hermes contract remained verified after normal stack restarts.

## Cutover record

Decision: _pending_
Decision date: _pending_
Evidence reviewed by: _pending_
30-day rollback-retention end date: _pending_

Cutover and rollback commands are documented in [THE_ANALYST_CONSOLIDATION.md](./THE_ANALYST_CONSOLIDATION.md).
