# Captured portfolio refresh — portfolio-refresh-v1

> Portfolio Review no longer displays the four sections below, in new or saved captures. The projection still runs and its facts remain in each capture (Product readings, all-holdings checks, completeness). Use this reference only to explain those saved facts; do not recreate the sections in a reply.

Read this reference only when explaining the existing full-book refresh section inside a captured Portfolio Review. The Python `portfolio_refresh.build_portfolio_refresh` projection owns its reconciliation and tables. ReviewRunV2 persists the captured holdings, available source archive and evidence before rendering. A formal refresh creates a new capture; it does not revise an earlier capture's narrative or facts. Hermes explains the result without rebuilding the report.

## Captured report sections

Preserve the projection's four ordered sections:

1. **Highest-priority realignment.** Current direct Trade conflicts and applicable Trend/MIN rules first; explicit publisher reductions, exits, removals and historical requalification exceptions follow. Keep the publisher's exact reading beside the proposed review action, with its original date.
2. **Watch list.** Dated directional conflicts, ambiguous same-date evidence, rank-only observations, missing support and unsupported instruments. Rankings and list membership do not establish Sell or directional Trade. An unsupported analytical field is `—`.
3. **What is already aligned.** Positions supported by eligible direct research without an unresolved opposing reading or action. The expandable **All holdings checked** table retains every captured position. No exceptions is not an all-clear when source or instrument coverage is incomplete.
4. **Recommended sequence.** The code orders evidenced realignment by applicable current process rules, then independently available weight, then ticker. Remaining watch exceptions follow. Preserve that order and distinguish publisher action from review interpretation; do not add unsupported target weights, order quantities or model probabilities.

## Captured securities tables and sources

The server's securities tables begin `Ticker | Security`, preserve the captured identity and position side, and end with the reading's date. **Highest-priority realignment** uses the selected compact template:

`Ticker | Security | Bias | Size | Source action | Notes | Source date`

Bias is the captured Long/Short side. Size is the same independently verified captured percentage previously shown beside the position, with unchanged precision; unavailable size is `—`. Source action preserves the original reading, including Sell some or Cover some. Notes retain its separate portfolio review implication. Source date remains attached to that reading. Source citations and evidence hover details remain attached to the source action, notes and date. Fit this table within the report column without horizontal overflow, using compact bias/size columns, wrapped source action and notes, and ellipsized security names with full captured values on hover. A saved capture's values and evidence stay unchanged when its presentation uses this template.

Watch list, What is already aligned, and All holdings checked retain their existing columns:

`Ticker | Security | Position | Source reading | Review action | Date`

Security names and full hover values come from the captured identity. Position percentages require verified captured valuation and NLV. Source citations remain in each section's Sources footer; source detail retains exact content, source instrument, publication date, questionable original fields, immutable IDs and hashes. Delivery gaps and scan diagnostics belong in Sources or diagnostics. Do not recreate these tables in an optional explanation or replace an unavailable field with a newer observation.

## Capture completeness

The projection returns `version: 1`, `templateVersion: portfolio-refresh-v1`, capture time, complete held-position checks, per-product current/archive coverage, archive manifest, the four sections and immutable citations. Every supplied holding remains in its roster, including unsupported or unvalued instruments. Offline, stale, cache-only, seeded, mock, malformed or count-inconsistent holdings cannot support a current proposed action. A verified empty book differs from unavailable holdings.

`scanComplete`, product counts/date bounds, page count and content hash establish the available-archive scan's stated scope. They do not prove every publication was delivered or every holding is aligned. Semantic-search results, a five-day window, roster omission or a successful partial import cannot prove full-product reconciliation. Retain independently valid fields when another source value is questionable, with its original discrepancy and provenance.

Same-date unresolved conflicts remain watch items. An explicit later re-add or affirmative membership in a verified complete publisher book can supersede that product's older removal; absence cannot create a removal. The exact report's partial body instruction and structured action scope take precedence over a generic Sell/Cover headline. Archived actions remain dated requalification evidence; only independently current eligible research can apply a present Trade/Trend rule. Explain saved reviews from their own evidence and template version.
