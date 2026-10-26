---
name: portfolio-review
description: Explain a captured Portfolio Review, its holdings changes and portfolio implications, or direct a formal review refresh to the dashboard, including any request for a new complete-book check.
---

# Portfolio review

Use the saved review's captured evidence to explain that review. A request for current holdings requires `get_portfolio_context`; interpreting the current process also requires `get_process_context`. Use `get_dashboard_context` only when the question or review narrative needs broader context. Targeted new research uses `research-questions`.

The dashboard owns the ReviewRunV2 report and its calculations. Preserve its compact daily rollup, dated Trade/Trend readings, source actions, captured exceptions, Sources, and saved history. Do not recreate the report or orchestrate a new report with Hermes tools. A new formal review, including a chat request for a complete check of every holding against research, uses the dashboard's existing Portfolio Review action, which regenerates the latest evidence each time it runs.

## Captured full-book refresh

A captured Portfolio Review may include the existing `portfolio-refresh-v1` reconciliation. Read the [captured refresh template](references/report-template.md) only when explaining that section's four ordered sections, all-holdings checks, or capture completeness. Use the saved capture's exact facts, source dates, citations, product coverage, and template version. A bounded follow-up context may omit holding detail; do not invent the omitted rows or rewrite the saved review with today's book or publications.

Highest-priority realignment uses `Ticker | Security | Bias | Size | Source action | Notes | Source date`: keep captured Long/Short separate from verified size, preserve partial source actions, and leave an unavailable size as `—`. Other captured refresh tables keep their existing columns. Fit the table to the report column with wrapped source action and notes; keep names compact with their full captured value on hover.

## Explain the review

Lead with the material change or highest-priority evidenced issue and why it matters to the captured long or short. Separate what the publisher actually said from the portfolio-rule implication. Preserve Sell some versus Sell/Exit, Cover some versus a full cover, direct versus proxy evidence, and original change dates. The exact action report's body and structured scope take precedence over a generic Sell/Cover headline. Do not manufacture a current action from archived removals, roster rank, or an omitted holding.

When adding the dashboard's optional review narrative, use the existing `## Review notes` outline: short meaningful subheadings, one concise fact per paragraph as **Label:** explanation, and bullets only for actions or a single grouped evidence gap. Do not duplicate its tables or full account snapshot. The narrative request's word limit applies.

For a normal follow-up, answer the question directly. If a comparison needs a table, start `Ticker | Security`, then only the relevant source reading, portfolio implication, and date. Use only code-computed sizing; an unsupported target is `—`. Cite supporting publications near the affected holding and in compact section Sources.
