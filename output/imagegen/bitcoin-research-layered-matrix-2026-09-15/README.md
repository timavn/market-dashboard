# Bitcoin Research: global Quad filter and linked matrices

Design artifact: 01-quad-and-volume-drilldown.png
Generated using the built-in image_gen tool. Exact prompt: prompt.md.
No production code changed. Every percentage, count and interval in the mockup is illustrative.

## Interaction

- Historical US Quad is a global multi-select. It can select any subset, not an assumed permanent pair. The pictured exploration leaves all selected to compare them below.
- The main matrix keeps the approved Regime/Entry-zone rows and USD/Volatility columns.
- Clicking a main cell locks its conditions as the parent cohort and reveals a second matrix beneath it.
- In the pictured example, the 66% cell with 200 hours / 40 days expands into Quad × Volume. All secondary values are joint frequencies computed only among the parent cohort.
- The next selection shows 80% with 40 hours / 10 days. The smaller count is visible beside the apparent increase. This is an illustrative design scenario, not an empirical finding.
- Apply & add layer pins the new conditions. The next matrix can display another available pair of factors while the plain-text filter path preserves all previous conditions.
- Changing an upstream control invalidates/recalculates descendants. A later Quad layer must respect a Quad subset already chosen globally; it cannot silently reintroduce excluded Quads.
- Show unknown combinations as unavailable and small samples without heatmap emphasis. Additional layers can narrow results drastically.
- Recalculate joint outcomes from eligible observations. Never multiply standalone factor percentages or infer outcomes from marginal summaries.

## Quad review

The local reviewed Best/Worst +EV catalog marks Cryptocurrency, including IBIT, as not covered:
docs/QUAD_EV_CLASSIFICATION_REVIEW_2026-09-07.md, lines 3, 40, 82, 132.

The separate Bitcoin/GBTC numerical quarterly-return row in src/constants/expectedValuesData.js:98 has no established authoritative provenance. The audit explicitly records this limitation:
docs/QUAD_NOT_LISTED_AUDIT_2026-09-08.md:54.
Do not promote those stored values into a preferred-Quad rule.

Primary publisher material inspected:
- Hedgeye, May 22, 2025, Three Reasons To Buy Bitcoin: discusses a monthly Quad 2 transition, describes Quad 3 as its strongest historical BTC regime and Quad 4 as its poor regime. This dated commentary does not establish a permanent rule limiting Bitcoin longs to exactly two Quads.
  https://app.hedgeye.com/insights/166479-three-reasons-to-buy-bitcoin-right-now/print
- Hedgeye, June 11, 2025, Bitcoin's Still Ripping: discusses Bitcoin strength in Quad 2 and historical weakness in Quad 4.
  https://app.hedgeye.com/insights/167250-mccullough-bitcoin-s-still-ripping-nowhere-near-breaking-trend/print
- Hedgeye, March 5, 2026, The Macro Show, page 9: distinguishes quarterly macro regime, monthly overlay, and signals used to time exposure. Page 11 contains the Best/Worst chart matched by the local audit.
  https://app.hedgeye.com/mu/he_tms_km_rr_3-5-2026?encoded_data=fCiU%2CbVmwShfVZr2+Z5%2Fd7udyL8AfpsI%3D%21

No specific two-Quad Bitcoin eligibility rule was verified. Keep research selections configurable and source-linked rather than presenting a guessed pair as the publisher's guidance. Any later hard eligibility rule should be explicit and separately reviewed.

## Before implementation

- Existing Bitcoin Quad overlays are retrospective actual-quarter classifications, not forecasts known at entry; see public/research/bitcoin/README.md:70. They support descriptive historical grouping. Testing a tradeable Quad gate requires archived classifications/forecasts available before each entry, with monthly and quarterly horizons kept distinct.
- The five-year study has signal gaps and shorter dollar and Quad coverage. Compare parent/child results on matched required-factor coverage and display excluded observations.
- Volatility categories and their historical metrics/thresholds are not implemented by this image task.
- Preserve the original unfiltered baseline, parent baseline and selected subgroup separately. More filters can overfit; include year/episode stability, uncertainty, and a genuinely untouched validation period before interpreting the largest cell as predictive.
- Unknown Quad is excluded from a specific Quad-selected cohort and counted in coverage; never inferred.

