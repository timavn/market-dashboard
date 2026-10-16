# Bitcoin Research matrix inputs

The interactive matrix filters the existing audited observation exports. It does not multiply marginal probabilities, use the design's illustrative percentages, or introduce new price observations. Historical closing direction is not an executable quote, contract win probability, or profit simulation.

Reproduce the compact input files from the unchanged public CSVs:

```sh
python3 scripts/research/build_btc_matrix_observations.py
```

The full `btc_five_year_study.py` rebuild also regenerates and publishes these files before replacing `study.json`, so later study updates cannot silently leave matrix inputs on the prior vintage. The loader rejects a study/observation timestamp mismatch.

Each `*-matrix-observations.json` includes its source CSV's SHA-256, archived study timestamp, source identities, explicit historical/non-executable status, and an allowlisted field catalog. Rows are arrays in that catalog's order to reduce transfer size. Only eligible signal/range entries are included. The loader verifies price direction and returns, range assignment, signal availability, exact USD feature lag, volume availability and classification, retrospective Quad assignments, uniqueness, and reconciliation against the existing study. The source CSVs and study are unchanged.

The UI loads only the selected interval. Filters are applied to individual observations, including arbitrary Quad unions, study dates, entry hour and weekday in New York time, and volume. First-per-day sampling always occurs **after every restriction**, selecting the earliest matching entry per New York calendar day. Hourly, New York calendar-day, and NYSE-session observations retain their original meanings.

Percentages retain unchanged closes in their denominator. Every cell displays observation count and distinct New York dates. Selected-cell 95% intervals use a deterministic 10,000-replicate bootstrap of whole New York date blocks; they are not intervals treating each hour as independent. These intervals are recomputed for the current sample and need not exactly match the earlier export's random seed. One-date samples have no interval. The minimum sample setting changes shading/annotation only, never the observations or percentages.

The next-layer comparison uses the parent restrictions plus complete inputs for the selected factors. The baseline and excluded-observation count are displayed separately, so missing Quad or volume coverage cannot masquerade as an improvement from the added restriction. Additional selections carry prior conditions forward. Exploratory comparisons overlap and are not adjusted for multiple testing.

Quad means **published retrospective actual-quarter classification**. It is not an archived forecast known at entry, and its use does not establish a tradeable historical Quad gate. Missing classifications remain unavailable. The original report coverage gaps and source-vintage limits remain documented in `README.md` and `manifest.json`.

Historical Bitcoin volatility regimes are currently unavailable: no verified Investable/Chop/Uninvestable definition or corresponding historical regime archive exists in this study. The dashboard's BITVX definition explicitly has no assigned regime ranges. The matrix's All-volatility cells use the full qualifying sample; regime-specific volatility cells remain unavailable rather than borrowing another asset's thresholds or inventing outcomes.
