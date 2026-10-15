# Independent Quad rank audit

Calculated 2026-09-09T04:53:56.806Z; completed-quarter cutoff **2026-Q2**.

Edition: `f5bb8d24d55dda4bb40c5163af20192ec5a83debb25c67d508f21291d26eac4a`. Input manifest: `31320d5e62ae9f5315793cf17557922f82ba37b5a69eff42b907ff4b517d9f22`.

All **141 published cells are preserved**. Audited **39 gaps**: **4 filled**, **6 insufficient history**, **22 unstable**, **7 undefined**.

“Insufficient history” includes unavailable or unvalidated source observations; the evidence below distinguishes these from a short calendar sample. No missing peer is removed. A star denotes an independent retrospective historical comparison, not a Hedgeye rank or a forecast.

| Factor | Quad | Proxy | Decision | Display | Observations / episodes | Evidence |
|---|---|---|---|---|---|---|
| Communication Services | Q4 | XLC | insufficient history | — | 8 / 6 | Fewer than 32 common calendar quarters. |
| Convertibles | Q4 | CWB | unstable | — | 11 / 8 | 2-quarter blocks: Bootstrap rank interval spans more than two positions. |
| Cyclical Growth | Q1 | — | undefined | — | 0 / 0 | No verified cyclical-growth benchmark or point-in-time constituent definition. |
| Cyclical Growth | Q3 | — | undefined | — | 0 / 0 | No verified cyclical-growth benchmark or point-in-time constituent definition. |
| EM $ Debt | Q2 | EMB | unstable | — | 15 / 8 | 2-quarter blocks: Bootstrap rank interval spans more than two positions. |
| EM $ Debt | Q4 | EMB | unstable | — | 11 / 8 | 2-quarter blocks: Bootstrap rank interval spans more than two positions. |
| EM Local Currency | Q1 | EMLC | unstable | — | 12 / 7 | 2-quarter blocks: Bootstrap rank interval spans more than two positions. |
| EM Local Currency | Q2 | EMLC | unstable | — | 15 / 8 | 2-quarter blocks: Bootstrap rank interval spans more than two positions. |
| EM Local Currency | Q3 | EMLC | unstable | — | 13 / 9 | 2-quarter blocks: Bootstrap rank interval spans more than two positions. |
| Energy | Q1 | XLE | insufficient history | — | 7 / 3 | Fewer than 32 common calendar quarters. |
| Equities | Q3 | SPY | filled | 5* | 22 / 12 | Mean -1.3572%; rank 5 of 5; interval envelope 3–5; all three block lengths and sensitivities pass. |
| Financials | Q1 | XLF | insufficient history | — | 7 / 3 | Fewer than 32 common calendar quarters. |
| FX | Q3 | — | undefined | — | 0 / 0 | Currency basket, weights and quote direction are undefined. EM FX is not broad FX. |
| Gold | Q1 | GLD | unstable | — | 20 / 12 | 2-quarter blocks: Bootstrap rank interval spans more than two positions. |
| Gold | Q2 | GLD | filled | 3* | 18 / 10 | Mean 1.6545%; rank 3 of 5; interval envelope 3–5; all three block lengths and sensitivities pass. |
| High Beta | Q3 | SPHB | unstable | — | 13 / 9 | 2-quarter blocks: Bootstrap rank interval spans more than two positions. |
| HY Credit | Q4 | HYG | unstable | — | 11 / 8 | 2-quarter blocks: Bootstrap rank interval spans more than two positions. |
| IG Credit | Q1 | LQD | unstable | — | 12 / 7 | 2-quarter blocks: Bootstrap rank interval spans more than two positions. |
| IG Credit | Q3 | LQD | unstable | — | 13 / 9 | 2-quarter blocks: Bootstrap rank interval spans more than two positions. |
| Leverage | Q2 | — | undefined | — | 0 / 0 | Balance-sheet leverage requires a defined equity characteristic and point-in-time fundamentals; leveraged ETFs are different. |
| Leverage | Q3 | — | undefined | — | 0 / 0 | Balance-sheet leverage requires a defined equity characteristic and point-in-time fundamentals; leveraged ETFs are different. |
| Materials | Q2 | XLB | insufficient history | — | 7 / 4 | Fewer than 32 common calendar quarters. |
| Materials | Q4 | XLB | insufficient history | — | 8 / 6 | Fewer than 32 common calendar quarters. |
| MBS | Q3 | MBB | unstable | — | 13 / 9 | 2-quarter blocks: Bootstrap rank interval spans more than two positions. |
| Mid Caps | Q2 | MDY | filled | 3* | 14 / 7 | Mean 6.7659%; rank 3 of 7; interval envelope 3–5; all three block lengths and sensitivities pass. |
| Mid Caps | Q4 | MDY | unstable | — | 11 / 8 | 2-quarter blocks: Bootstrap rank interval spans more than two positions. |
| Munis | Q1 | MUB | unstable | — | 12 / 7 | 2-quarter blocks: Bootstrap rank interval spans more than two positions. |
| Preferreds | Q1 | PFF | unstable | — | 12 / 7 | 2-quarter blocks: Bootstrap rank interval spans more than two positions. |
| Quality | Q1 | QUAL | filled | 1* | 11 / 6 | Mean 5.3951%; rank 1 of 7; interval envelope 1–2; all three block lengths and sensitivities pass. |
| Quality | Q2 | QUAL | unstable | — | 14 / 7 | 2-quarter blocks: Bootstrap rank interval spans more than two positions. |
| REITS | Q4 | XLRE | insufficient history | — | 8 / 6 | Fewer than 32 common calendar quarters. |
| Short Duration Treasurys | Q2 | SHY | unstable | — | 15 / 8 | 2-quarter blocks: Bootstrap rank interval spans more than two positions. |
| Short Duration Treasurys | Q3 | SHY | unstable | — | 13 / 9 | 2-quarter blocks: Bootstrap rank interval spans more than two positions. |
| Short Duration Treasurys | Q4 | SHY | unstable | — | 11 / 8 | 2-quarter blocks: Bootstrap rank interval spans more than two positions. |
| Size | Q1 | — | undefined | — | 0 / 0 | The factor direction and benchmark are undefined; mega-caps and small-minus-large are not interchangeable. |
| Size | Q4 | — | undefined | — | 0 / 0 | The factor direction and benchmark are undefined; mega-caps and small-minus-large are not interchangeable. |
| Small Caps | Q4 | IWM | unstable | — | 11 / 8 | 2-quarter blocks: Bootstrap rank interval spans more than two positions. |
| TIPS | Q2 | TIP | unstable | — | 15 / 8 | 2-quarter blocks: Bootstrap rank interval spans more than two positions. |
| USD | Q3 | UUP | unstable | — | 22 / 12 | 2-quarter blocks: Bootstrap rank interval spans more than two positions. |

## Evidence trail

Local immutable JSON files live under `data/quad-research/` (or `QUAD_RESEARCH_DIRECTORY`). They contain no portfolio positions. The API returns per-cell diagnostics and source hashes.

- Edition: `editions/f5bb8d24d55dda4bb40c5163af20192ec5a83debb25c67d508f21291d26eac4a.json` — all 39 decisions and every internal peer/Quad result.
- Inputs: `inputs/31320d5e62ae9f5315793cf17557922f82ba37b5a69eff42b907ff4b517d9f22.json` — exact aligned returns, vintage values, source validation and observation dates.
- Sources: `raw/<SHA256>.json`; retrieval records: `retrievals/<SHA256>.json` — request URL, provider and retrieval date. API credentials are removed from archived URLs.
- Each supported cell includes 2-, 4- and 8-quarter bootstrap intervals, deterministic seeds, invalid draw counts, both macro sensitivities and every episode deletion.

## Group coverage

| Group | Fixed start | End | Common quarters | Validation issues |
|---|---|---|---|---|
| Asset classes | 2007-Q2 | 2026-Q2 | 77 | None |
| Equity sectors | 2018-Q4 | 2026-Q2 | 31 | None |
| Equity styles | 2013-Q4 | 2026-Q2 | 51 | None |
| Fixed-income sectors | 2013-Q2 | 2026-Q2 | 53 | None |

## Source-validation scope

Corporate-action reconstruction covers all 37 ETFs and checks internal consistency against the same vendor. Independent issuer reconciliation is one SHY quarterly sample, within published rounding; it does not independently verify every historical return. The return convention is Yahoo split/distribution-adjusted market prices, which is not algebraically identical to cash-reinvestment accounting.

Each Quad has an original BEA advance-release example. Monthly CPI levels match the official BLS historical NSA table exactly and use the archived ALFRED release-date vintage; the BLS reference is a current historical table, not a separate archive of each original monthly news release.

Unclassified calendar quarters retained: 2025-Q4 (macro_levels_missing), 2026-Q1 (macro_levels_missing).

## Validation record

```json
{
  "adjustmentTolerance": 0.0001,
  "globalIngestionFailure": false,
  "independentIssuerReconciliation": {
    "computedReturn": 0.003322333512242759,
    "convention": "Issuer market-price performance uses exchange closing prices and accounts for fund distributions; this sample is after the August 10, 2020 convention change.",
    "difference": 0.000022333512242758875,
    "endDate": "2026-06-30",
    "id": "shy-2026-q2-market-close",
    "limitation": "One independently published quarterly sample, within issuer display rounding. Yahoo backward distribution adjustment is not mathematically identical to cash-reinvestment accounting.",
    "quarter": "2026-Q2",
    "reportedPrecisionPercentagePoints": 0.01,
    "reportedReturn": 0.0033,
    "reviewedAt": "2026-09-09T04:39:52.938Z",
    "scope": "independent quarterly sample; all-cohort corporate-action verification is separate",
    "sources": [
      {
        "kind": "performance",
        "reviewedHash": "dc03824876ac32ba69db65538f6e46e61ccf65a207f45e491a6909d2967c809a",
        "source": "BlackRock SHY published performance and distributions",
        "url": "https://www.blackrock.com/us/individual/products/239452/ishares-1-3-year-treasury-bond-etf"
      },
      {
        "kind": "convention",
        "reviewedHash": "a0dee7b4382979aac5bf98a01aebc144e24adc150068dc318894146094284051",
        "source": "BlackRock published ETF market-price performance convention",
        "url": "https://www.ishares.com/us/literature/product-brief/balq-product-brief.pdf"
      }
    ],
    "startDate": "2026-03-31",
    "status": "verified",
    "symbol": "SHY",
    "tolerance": 0.00005
  },
  "independentSourceValidation": {
    "issuer": {
      "computedReturn": 0.003322333512242759,
      "convention": "Issuer market-price performance uses exchange closing prices and accounts for fund distributions; this sample is after the August 10, 2020 convention change.",
      "difference": 0.000022333512242758875,
      "endDate": "2026-06-30",
      "id": "shy-2026-q2-market-close",
      "limitation": "One independently published quarterly sample, within issuer display rounding. Yahoo backward distribution adjustment is not mathematically identical to cash-reinvestment accounting.",
      "quarter": "2026-Q2",
      "reportedPrecisionPercentagePoints": 0.01,
      "reportedReturn": 0.0033,
      "reviewedAt": "2026-09-09T04:39:52.938Z",
      "scope": "independent quarterly sample; all-cohort corporate-action verification is separate",
      "sources": [
        {
          "kind": "performance",
          "reviewedHash": "dc03824876ac32ba69db65538f6e46e61ccf65a207f45e491a6909d2967c809a",
          "source": "BlackRock SHY published performance and distributions",
          "url": "https://www.blackrock.com/us/individual/products/239452/ishares-1-3-year-treasury-bond-etf"
        },
        {
          "kind": "convention",
          "reviewedHash": "a0dee7b4382979aac5bf98a01aebc144e24adc150068dc318894146094284051",
          "source": "BlackRock published ETF market-price performance convention",
          "url": "https://www.ishares.com/us/literature/product-brief/balq-product-brief.pdf"
        }
      ],
      "startDate": "2026-03-31",
      "status": "verified",
      "symbol": "SHY",
      "tolerance": 0.00005
    },
    "issues": [],
    "macro": {
      "cpiReference": {
        "kind": "cpi",
        "limitation": "Current BLS NSA historical table, read through the browser text tool because direct HTTP was denied. Exact sample monthly levels are reconciled with the GDP-release-date ALFRED vintage; this is not an independent archive of every monthly CPI release.",
        "reviewedHash": "cc62524bb67e3651ba3b860d525ef0505d394b60b00dc283c58c5cd951659ef2",
        "source": "BLS CPI-U independent table extraction",
        "url": "https://www.bls.gov/regions/northeast/data/consumerpriceindex_us_table.htm"
      },
      "examples": [
        {
          "cpiMonthlyLevelsMatched": 12,
          "currentYoy": 2.5933472703696836,
          "gdpAccelerationDisplayBoundPp": 0.1,
          "gdpYoyTolerancePp": 0.05,
          "growthAcceleration": 0.7059707590976183,
          "inflationAcceleration": -0.28941111188897484,
          "kind": "gdp",
          "numericalTolerancePp": 1e-9,
          "previousYoy": 1.8873765112720653,
          "publishedCurrentYoy": 2.6,
          "publishedPreviousYoy": 1.9,
          "quad": 1,
          "quarter": "2007-Q3",
          "releaseDate": "2007-10-31",
          "releaseText": "OCTOBER 31, 2007",
          "reviewedHash": "ff83c9fc2ec551eb93baf48310109cbd79c0720ba701f81d18234a94585a9ddb",
          "source": "Original macro validation reference",
          "sourceValues": {
            "cpi": {
              "2006-04-01": 201.5,
              "2006-05-01": 202.5,
              "2006-06-01": 202.9,
              "2006-07-01": 203.5,
              "2006-08-01": 203.9,
              "2006-09-01": 202.9,
              "2007-04-01": 206.686,
              "2007-05-01": 207.949,
              "2007-06-01": 208.352,
              "2007-07-01": 208.299,
              "2007-08-01": 207.917,
              "2007-09-01": 208.49
            },
            "gdp": {
              "2006-04-01": 11306.7,
              "2006-07-01": 11336.7,
              "2007-04-01": 11520.1,
              "2007-07-01": 11630.7
            }
          },
          "status": "verified",
          "url": "https://www.bea.gov/news/2007/gross-domestic-product-third-quarter-2007-advance-estimates"
        },
        {
          "cpiMonthlyLevelsMatched": 12,
          "currentYoy": 1.7794758859791093,
          "gdpAccelerationDisplayBoundPp": 0.1,
          "gdpYoyTolerancePp": 0.05,
          "growthAcceleration": 0.2321438991834901,
          "inflationAcceleration": 0.22732629386642955,
          "kind": "gdp",
          "numericalTolerancePp": 1e-9,
          "previousYoy": 1.5473319867956192,
          "publishedCurrentYoy": 1.8,
          "publishedPreviousYoy": 1.5,
          "quad": 2,
          "quarter": "2007-Q2",
          "releaseDate": "2007-07-27",
          "releaseText": "JULY 27, 2007",
          "reviewedHash": "799b6fd1a9f1c59f8382ad6e82108f94d33eb274fd9ca60891677cd0305fe32c",
          "source": "Original macro validation reference",
          "sourceValues": {
            "cpi": {
              "2006-01-01": 198.3,
              "2006-02-01": 198.7,
              "2006-03-01": 199.8,
              "2006-04-01": 201.5,
              "2006-05-01": 202.5,
              "2006-06-01": 202.9,
              "2007-01-01": 202.416,
              "2007-02-01": 203.499,
              "2007-03-01": 205.352,
              "2007-04-01": 206.686,
              "2007-05-01": 207.949,
              "2007-06-01": 208.352
            },
            "gdp": {
              "2006-01-01": 11238.7,
              "2006-04-01": 11306.7,
              "2007-01-01": 11412.6,
              "2007-04-01": 11507.9
            }
          },
          "status": "verified",
          "url": "https://www.bea.gov/news/2007/gross-domestic-product-second-quarter-2007-advance-estimates"
        },
        {
          "cpiMonthlyLevelsMatched": 12,
          "currentYoy": 2.4737835110350437,
          "gdpAccelerationDisplayBoundPp": 0.1,
          "gdpYoyTolerancePp": 0.05,
          "growthAcceleration": -0.3683133954721418,
          "inflationAcceleration": 1.6134268015883655,
          "kind": "gdp",
          "numericalTolerancePp": 1e-9,
          "previousYoy": 2.8420969065071855,
          "publishedCurrentYoy": 2.5,
          "publishedPreviousYoy": 2.8,
          "quad": 3,
          "quarter": "2007-Q4",
          "releaseDate": "2008-01-30",
          "releaseText": "JANUARY 30, 2008",
          "reviewedHash": "745a60d24dfbf033238dd463852713b4d3746f09384b84275757ed86ef255ab8",
          "source": "Original macro validation reference",
          "sourceValues": {
            "cpi": {
              "2006-07-01": 203.5,
              "2006-08-01": 203.9,
              "2006-09-01": 202.9,
              "2006-10-01": 201.8,
              "2006-11-01": 201.5,
              "2006-12-01": 201.8,
              "2007-07-01": 208.299,
              "2007-08-01": 207.917,
              "2007-09-01": 208.49,
              "2007-10-01": 208.936,
              "2007-11-01": 210.177,
              "2007-12-01": 210.036
            },
            "gdp": {
              "2006-07-01": 11336.7,
              "2006-10-01": 11395.5,
              "2007-07-01": 11658.9,
              "2007-10-01": 11677.4
            }
          },
          "status": "verified",
          "url": "https://www.bea.gov/sites/default/files/2019-11/gdp407a.txt"
        },
        {
          "cpiMonthlyLevelsMatched": 12,
          "currentYoy": -0.1832936053766221,
          "gdpAccelerationDisplayBoundPp": 0.1,
          "gdpYoyTolerancePp": 0.05,
          "growthAcceleration": -0.9290551509179568,
          "inflationAcceleration": -3.6975771921659977,
          "kind": "gdp",
          "numericalTolerancePp": 1e-9,
          "previousYoy": 0.7457615455413347,
          "publishedCurrentYoy": -0.2,
          "publishedPreviousYoy": 0.7,
          "quad": 4,
          "quarter": "2008-Q4",
          "releaseDate": "2009-01-30",
          "releaseText": "JANUARY 30, 2009",
          "reviewedHash": "70bf2e623435d7d7ed32c06ea78691e0be4b836406b6d036dc24436aa56db484",
          "source": "Original macro validation reference",
          "sourceValues": {
            "cpi": {
              "2007-07-01": 208.299,
              "2007-08-01": 207.917,
              "2007-09-01": 208.49,
              "2007-10-01": 208.936,
              "2007-11-01": 210.177,
              "2007-12-01": 210.036,
              "2008-07-01": 219.964,
              "2008-08-01": 219.086,
              "2008-09-01": 218.783,
              "2008-10-01": 216.573,
              "2008-11-01": 212.425,
              "2008-12-01": 210.228
            },
            "gdp": {
              "2007-07-01": 11625.7,
              "2007-10-01": 11620.7,
              "2008-07-01": 11712.4,
              "2008-10-01": 11599.4
            }
          },
          "status": "verified",
          "url": "https://www.bea.gov/sites/default/files/2019-11/gdp408a.txt"
        }
      ],
      "scope": "One original BEA advance release per Quad, with BLS monthly CPI-U NSA levels matched to the same ALFRED GDP-release-date vintage.",
      "status": "verified"
    },
    "sourceHashes": [
      "dc03824876ac32ba69db65538f6e46e61ccf65a207f45e491a6909d2967c809a",
      "a0dee7b4382979aac5bf98a01aebc144e24adc150068dc318894146094284051",
      "cc62524bb67e3651ba3b860d525ef0505d394b60b00dc283c58c5cd951659ef2",
      "ff83c9fc2ec551eb93baf48310109cbd79c0720ba701f81d18234a94585a9ddb",
      "799b6fd1a9f1c59f8382ad6e82108f94d33eb274fd9ca60891677cd0305fe32c",
      "745a60d24dfbf033238dd463852713b4d3746f09384b84275757ed86ef255ab8",
      "70bf2e623435d7d7ed32c06ea78691e0be4b836406b6d036dc24436aa56db484"
    ],
    "sources": [
      {
        "hash": "dc03824876ac32ba69db65538f6e46e61ccf65a207f45e491a6909d2967c809a",
        "retrievedAt": "2026-09-09T04:39:52.145Z",
        "source": "BlackRock SHY published performance and distributions",
        "url": "https://www.blackrock.com/us/individual/products/239452/ishares-1-3-year-treasury-bond-etf"
      },
      {
        "hash": "a0dee7b4382979aac5bf98a01aebc144e24adc150068dc318894146094284051",
        "retrievedAt": "2026-09-09T04:39:52.920Z",
        "source": "BlackRock published ETF market-price performance convention",
        "url": "https://www.ishares.com/us/literature/product-brief/balq-product-brief.pdf"
      },
      {
        "hash": "cc62524bb67e3651ba3b860d525ef0505d394b60b00dc283c58c5cd951659ef2",
        "retrievedAt": "2026-09-09T04:47:56.377Z",
        "source": "BLS CPI-U independent table extraction",
        "url": "https://www.bls.gov/regions/northeast/data/consumerpriceindex_us_table.htm"
      },
      {
        "hash": "ff83c9fc2ec551eb93baf48310109cbd79c0720ba701f81d18234a94585a9ddb",
        "retrievedAt": "2026-09-09T04:43:42.502Z",
        "source": "Original macro validation reference",
        "url": "https://www.bea.gov/news/2007/gross-domestic-product-third-quarter-2007-advance-estimates"
      },
      {
        "hash": "799b6fd1a9f1c59f8382ad6e82108f94d33eb274fd9ca60891677cd0305fe32c",
        "retrievedAt": "2026-09-09T04:43:42.345Z",
        "source": "Original macro validation reference",
        "url": "https://www.bea.gov/news/2007/gross-domestic-product-second-quarter-2007-advance-estimates"
      },
      {
        "hash": "745a60d24dfbf033238dd463852713b4d3746f09384b84275757ed86ef255ab8",
        "retrievedAt": "2026-09-09T04:43:42.901Z",
        "source": "Original macro validation reference",
        "url": "https://www.bea.gov/sites/default/files/2019-11/gdp407a.txt"
      },
      {
        "hash": "70bf2e623435d7d7ed32c06ea78691e0be4b836406b6d036dc24436aa56db484",
        "retrievedAt": "2026-09-09T04:43:43.061Z",
        "source": "Original macro validation reference",
        "url": "https://www.bea.gov/sites/default/files/2019-11/gdp408a.txt"
      }
    ],
    "status": "verified"
  },
  "ingestionFailed": false,
  "issues": [],
  "modeledBenchmarkCount": 37,
  "quarterReconciliationTolerance": 0.0002,
  "sourceCount": 49,
  "status": "verified",
  "valid": true
}
```
