# Quad worksheet: all "Not listed" cells

Reviewed September 8, 2026. Investigation only; no dashboard behavior or ranks changed.

The running portfolio worksheet has 45 factors and 180 Quad cells. There are 39 unlisted cells across 26 factors; 19 factors have entries in all four Quads. The missing cells match the omissions in the corresponding Hedgeye summary chart. They are not failed market-data requests or entries dropped by the renderer.

## Why the gaps exist

`src/constants/expectedValuesData.js` contains four selected best/worst lists. `src/constants/quadExposureCatalog.js` preserves those lists as `QUAD_PLAYBOOK`, builds the union of their labels, and gives a factor `status: 'not-listed', rank: null` wherever neither list contains it. `PortfolioFactorQuadMatrix.jsx` displays that state literally.

A number is the factor's position within its category's Best or Worst list for that Quad. It is not an average return, a full-universe rank, or a ranking of that factor's four possible economic regimes. Absence establishes no numerical rank or return sign. The source does not explain each individual omission.

I checked the lists against page 11 of [Hedgeye's March 5, 2026 Macro Show presentation](https://app.hedgeye.com/mu/he_tms_km_rr_3-5-2026?encoded_data=fCiU%2CbVmwShfVZr2+Z5%2Fd7udyL8AfpsI%3D%21). The entries and ordering match, allowing REITs capitalization. Its footnote identifies quarterly GIP model market-history backtests beginning in Q1 1998, but this summary does not supply the complete numerical results or each series' sample count. This is a verified matching edition, not a claim that it is the latest published edition.

The separate `quadRankings.js` file contains only the Best lists, so it cannot recover the missing cells either.

## Every affected factor

All missing Quads below are verified against the stored worksheet and running UI. The final column describes a possible research route, not a verified replacement rank or an approved security mapping. Symbols are candidate matches already present in the repository's separate return table.

| Factor | Missing Quads | Route to a complete comparison |
| --- | --- | --- |
| Communication Services | Q4 | Verify the XLC return series, source edition, and backtest period. |
| Convertibles | Q4 | Verify the CWB return series and source. |
| Cyclical Growth | Q1, Q3 | Define the original factor basket. The stored "Cyclicals / RSP" row is not an established equivalent. |
| EM $ Debt | Q2, Q4 | Verify the EMB / EM USD Debt series and source. |
| EM Local Currency | Q1, Q2, Q3 | Verify the EMLC series and source. Only one Quad has a summary entry. |
| Energy | Q1 | Verify the XLE sector series and source; oil commodity returns are a different exposure. |
| Equities | Q3 | Verify the SPY / S&P 500 series and whether it is the intended broad-equity benchmark. |
| Financials | Q1 | Verify the XLF sector series and source. |
| FX | Q3 | Define the currency basket and quote direction. The stored EM FX / CEW row does not establish coverage for broad FX or yen exposure. |
| Gold | Q1, Q2 | Verify the GLD / gold series and source; do not substitute gold-mining stocks. |
| High Beta | Q3 | Verify the SPHB series and source. |
| HY Credit | Q4 | Verify the HYG series and source. |
| IG Credit | Q1, Q3 | Verify the LQD series and source. |
| Leverage | Q2, Q3 | Establish the source's factor definition and benchmark. The worksheet does not establish that this is the same as daily ETF leverage. No dedicated return row exists locally. |
| Materials | Q2, Q4 | Verify the XLB sector series and source. |
| MBS | Q3 | Verify the MBB series and source. |
| Mid Caps | Q2, Q4 | Verify the MDY series and source. |
| Munis | Q1 | Verify the MUB series and source. |
| Preferreds | Q1 | Verify the PFF series and source. |
| Quality | Q1, Q2 | Verify the QUAL series and source. |
| REITS | Q4 | Verify the XLRE series and source. |
| Short Duration Treasurys | Q2, Q3, Q4 | Verify the SHY / 1-3 year series and source. Only one Quad has a summary entry. |
| Size | Q1, Q4 | Define the original factor. The stored "Size / OEF" row does not establish equivalence to the source's Size factor. |
| Small Caps | Q4 | Verify the IWM series and source. |
| TIPS | Q2 | Choose the source's maturity definition first: the stored table has both STIP and TIP rows with different results. |
| USD | Q3 | Verify the UUP / US Dollar Index series and source. |

There are 21 factors with plausible local return-table matches and five with additional definition problems: Cyclical Growth, FX, Leverage, Size, and TIPS. These are research candidates, not 39 recovered values.

## Why the local return table cannot simply fill the blanks

`quarterlyExpectedValues` in `src/constants/expectedValuesData.js` stores four percentages for many exposures. It has no source URL, publication date, backtest endpoint, per-series sample size, or benchmark methodology. Its Git history establishes when the file was added, not where the numbers came from. I did not establish authoritative provenance for those exact percentages in this review.

The two tables also answer different questions. For example, the stored Energy percentages would order its regimes Q2, Q1, Q3, Q4; the summary-based ordering utility produces Q3, Q2, Q1, Q4. Neither ordering can validate the other. This example diagnoses a methodological difference; the stored percentages have not been endorsed as verified research.

Older Hedgeye editions are not safe patch sources. The [2021 Hedgeye presentation, page 10](https://docs3.hedgeye.com/mass/Hedgeye_Bitcoin.pdf) explicitly lists Energy and Financials among Q1's weakest sectors, and includes REITs among Q4's strongest sectors. Those entries differ from the matching 2026 edition. Importing only the missing entries would create a mixed-version chart.

The related `rankExposureQuads` utility explicitly places unlisted Quads in the middle and ties multiple unlisted Quads. That is a display convention, not an observed ranking. Any future complete return comparison should use verified returns rather than carry forward that convention.

## Recommended disposition

1. Keep useful factor/exposure rows. Deleting every incomplete row would remove 26 of 45 rows, including Energy, Financials, Gold, Quality, and broad Equities.
2. Replace the repeated visible "Not listed" wording with a quiet dash, retaining an accessible description and tooltip explaining that the source gives no rank. This is a proposed cleanup, not a change made in this audit.
3. If a complete four-Quad comparison is wanted, select a dated full backtest, verify the benchmark for each row, and calculate the comparison consistently from that dataset. Display any independent calculation as such; do not splice computed returns into the publisher's Best/Worst list positions.
4. Omit unresolved factors from that complete numerical comparison until their definitions and data are established. Preserve their separately useful portfolio classifications where those are supported. The five definition cases above deserve review first.

## Separate exposure availability issue

The running worksheet also showed N/A exposure totals for Commodities, Equities, and Industrials. Its tooltips identified a missing verified September 8 close for SRUUF and EXPGY. These missing valuations explain those Net % NAV cells; they do not explain any Quad ranking omission.

## Validation and scope

- Inspected all 45 rows of the running localhost portfolio worksheet; the 39 missing cells match the catalog inventory.
- Checked the corresponding published lists using the source PDF's extracted text. The web screenshot tool returned no usable image, and direct downloads returned HTTP 403, so this review does not claim visual verification of the source PDF.
- Ran the existing catalog, matrix, and Quad-order tests: 3 suites, 32 tests passed. An existing React testing-library `act` deprecation warning was emitted.
- The repository already contained extensive unrelated changes, including changes/untracked files in this feature. This audit adds only this document and preserves those changes. No production code was edited; a production build was not needed for this documentation-only result.
