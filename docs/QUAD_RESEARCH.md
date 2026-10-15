# Independent historical Quad ranks

The Portfolio factor matrix preserves the 141 published Hedgeye cells. Only its 39 original gaps can receive independent research. A gray `3*` means rank 3 by arithmetic average quarterly ETF total return among the explicitly defined peers. It does not mean position 3 in Hedgeye’s selected best/worst lists. Clicking any gap opens the historical explanation or the reason for withholding a result.

## Build and reproduce

```sh
npm run research:quad-ranks
npm run research:quad-ranks -- --cutoff 2026-Q2
npm run research:quad-ranks -- --replay INPUT_SHA256
```

The default cutoff is the last completed calendar quarter. A future or incomplete quarter is rejected. `--replay` uses an immutable input manifest and makes no historical-data requests. Identical inputs and methodology reproduce the ranks, intervals and edition hash. Retrieval metadata is part of the input edition, so a new retrieval may create a new edition even when the calculated ranks are unchanged. `--audit PATH` overrides the default `docs/QUAD_RESEARCH_AUDIT.md` report.

The builder uses the existing `FRED_API_KEY` and public issuer/Yahoo sources. No subscription purchase or scheduled job is involved. A completed quarter can be rebuilt after its GDP advance release becomes available. Missing macro observations remain unclassified calendar quarters. Transport failures and malformed responses are different from a genuinely unpublished observation.

## Fixed methodology

The versioned catalog is `src/services/quadResearch/catalog.cjs`. It is independent of portfolio classifications and contains the prescribed 5 asset-class, 11 sector, 7 style and 14 fixed-income peers. Their starts are 2007Q2, 2018Q4, 2013Q4 and 2013Q2 respectively. The sector cohort has only 31 quarters through 2026Q2. Historical ETF returns reflect the funds as managed at the time; material benchmark changes are recorded in the catalog rather than backcasting today’s index before its existence.

FX, Cyclical Growth, Leverage and Size have seven undefined gaps. Generic Credit, Defensives, Secular Growth and Low Beta also stay outside the research peer groups. Every existing published value remains intact.

Prices use the shared maximum daily adjusted-history transport and normalizer. The loader archives the full raw response and action records, verifies ETF identity and currency, detects duplicates before normalization, requires every expected trading session, and reconciles daily and quarterly adjustment ratios against split-adjusted closes and dividend events. Quarter returns are adjusted closing price at the final exchange session divided by the previous quarter’s final adjusted close, minus one. No peer is dropped or missing close substituted. Source validation includes separately archived issuer performance under matched dates and closing-price conventions; same-vendor action reconstruction is explicitly identified as such.

Macro classifications use real GDP year-over-year growth (`GDPC1`) and the arithmetic average of monthly headline CPI-U NSA year-over-year inflation (`CPIAUCNS`). Acceleration is the current rate minus the previous quarter’s rate. Each quarter’s GDP advance-release vintage supplies every GDP and CPI comparison level. Growth/inflation acceleration signs define Quad 1 (+/−), Quad 2 (+/+), Quad 3 (−/+) and Quad 4 (−/−). Exact zero or missing levels leave that quarter unclassified. The full chronological calendar remains present for both episodes and resampling. Latest-vintage labels are a separate sensitivity.

These are retrospective same-quarter associations. The GDP advance release arrives after quarter-end; these classifications were not available to trade during the measured quarter. Source policy follows the [FRED vintage API](https://fred.stlouisfed.org/docs/api/fred/series_observations.html), with release examples checked against original BEA/BLS publications.

All modeled peers are ranked internally for all four Quads. Unrounded arithmetic means determine descending equal-competition ranks; exact ties share a rank. Publication requires every check below:

| Check | Fixed requirement |
|---|---|
| Common history | At least 32 calendar quarters |
| Target Quad | At least 8 quarters across 3 contiguous episodes |
| Bootstrap | 5,000 joint moving-block draws for each length 2, 4 and 8; empirical 10th–90th percentile rank bounds contain the point rank and span at most 2 positions; at most 10% invalid draws |
| Latest-vintage and boundary sensitivities | Each variant has at least 6 target quarters in 2 episodes and changes rank by at most 2 positions |
| Near-boundary definition | Exclude a quarter when either absolute acceleration is at most 0.1 percentage point |
| Episode dependence | Delete each target episode in turn; at least 4 target quarters remain and rank moves at most 2 positions |

Moving blocks are non-circular: starts are sampled uniformly from observed chronological blocks, concatenated and truncated to the original window length. All peer returns and labels travel together, including unclassified quarters. The fixed seed and group/block-derived seeds are recorded in the edition. A bootstrap draw is invalid when it cannot produce a finite target-Quad rank, not merely because it fails the original sample eligibility gates. Unevaluable sensitivities withhold a result. Intervals are shown separately for each block length; their combined envelope is not itself an additional publication gate.

## Storage and API

`data/quad-research/` is local and ignored by Git. `QUAD_RESEARCH_DIRECTORY` can override it. Raw JSON payloads, exact input manifests and editions are addressed by SHA-256. Retrieval records retain sanitized source URLs and retrieval timestamps; API keys are removed. `latest.json` is replaced atomically only after input, edition, source and statistical evidence checks pass. Existing editions are never overwritten.

`GET /api/research/quad-ranks` is read-only and performs no ingestion or statistical work. A short-lived worker verifies the archived bytes without blocking the live-quote server or sharing its asynchronous filesystem queue. Concurrent requests share only an in-progress verification, never a cached result. The endpoint returns the dated edition, methodology, peer catalog and 39 gap decisions with provenance and diagnostics. Internal results for all 148 modeled peer/Quad combinations remain in the edition artifact. A failed rebuild leaves the previous verified dated edition selected. Missing, corrupt or revoked pointers, editions or source artifacts yield `available: false` and no estimates. Add an edition, input or raw-source hash to the local `revocations.json` document’s `hashes` array to revoke it; this is checked on every read.

The hook passes research into `PortfolioFactorQuadMatrix` separately. It cannot change `quadExposureCatalog`, `rankExposureQuads`, quote validity, portfolio valuation, sizing or order logic. Disconnected executable data remains governed by the existing quote pipeline independently of this dated research table.

## Verification

```sh
node --test src/services/providers/yahooAdjustedHistory.test.cjs src/services/quadResearch/*.test.cjs src/routes/quadResearch.test.cjs
npx jest --runInBand src/components/Dashboard/__tests__/PortfolioFactorQuadMatrix.test.jsx src/hooks/useQuadResearch.test.js
npm run build
```

The audit lists every original gap as filled, insufficient history, unstable or undefined, with its governing reason. Detailed diagnostics retain all failed checks, rather than only the first reason shown in the compact UI. Statistical thresholds are publication defaults, not promises about future returns, and are not tuned to match the publisher’s ranks.
