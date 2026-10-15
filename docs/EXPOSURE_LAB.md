# Exposure Lab

Exposure Lab is a read-only portfolio factor-risk and security-universe QA surface. It combines a socket-verified IBKR portfolio with completed-session adjusted price history. It never submits, stages, or previews an order.

The in-app operator manual is available from the **Exposure Guide** rail button or directly at `#/process/exposure-lab`.

## Factor catalog

| Family | Factor | Return proxy |
| --- | --- | --- |
| Market | Market | SPY |
| Sector | Communication Services | XLC − SPY |
| Sector | Consumer Discretionary | XLY − SPY |
| Sector | Consumer Staples | XLP − SPY |
| Sector | Energy | XLE − SPY |
| Sector | Financials | XLF − SPY |
| Sector | Health Care | XLV − SPY |
| Sector | Industrials | XLI − SPY |
| Sector | Technology | XLK − SPY |
| Sector | Materials | XLB − SPY |
| Sector | Real Estate | XLRE − SPY |
| Sector | Utilities | XLU − SPY |
| Style | Value | IWD − IWF |
| Style | Momentum | MTUM − SPY |
| Style | Quality | QUAL − SPY |
| Style | Small vs Large | IWM − OEF |
| Style | High vs Low Beta | SPHB − SPLV |
| Style | Dividend | SDY − SPY |
| Style | Secular Growth | QQQ − SPY |
| Macro | Credit | HYG − LQD |
| Macro | Duration | TLT − SHY |
| Macro | USD | UUP |
| Macro | Commodities | DBC |
| Macro | Gold | GLD |
| Macro | EM FX | CEW − UUP |

Security loadings use up to 252 sessions in an exponentially weighted ridge regression with a 63-session half-life. Modeling begins at 30 aligned adjusted-return observations and progresses through 30, 60, 90, and 120-return quality tiers; 120 or more is seasoned. Factor proxies need at least 120 aligned observations before entering the common factor block. Portfolio covariance uses 90 sessions and 20% off-diagonal shrinkage.

## Unified correlation

The Correlation tab contains position × position, position × factor, and factor × factor matrices for 30, 90, and 180 completed sessions. Each cell requires `max(20, ceil(80% × window))` aligned adjusted-close simple returns. Cells with insufficient observations, missing history, or zero variance remain empty and retain a machine-readable reason plus observation count.

Position rows are sign-adjusted to portfolio P&L:

- position × position = `sideᵢ × sideⱼ × raw asset correlation`;
- position × factor = `sideᵢ × raw asset/factor correlation`; and
- factor × factor remains raw factor-return correlation.

Tooltips preserve the raw value. Red cells are positive P&L co-movement/common risk and blue cells are offsets. The server returns every eligible position up to the 75-symbol guardrail; the UI starts with the top 20 by gross NAV and provides All and search controls.

Largest common-risk and offsetting pairs are ranked directly by annualized signed pair covariance using current NAV weights and 20% off-diagonal shrinkage. No thematic label, composite concentration score, or transitive grouping is inferred.

## Geography

Allocation and Sensitivity are deliberately separate.

### Allocation

Audited security-master geography supports:

- `country_of_risk` for one reviewed stock country at 100%;
- `single_country_mandate` for a one-country ETF/fund at 100%; and
- `holdings_lookthrough` for ETF/fund ISO alpha-2 country weights totaling 100%.

Every record includes `sourceName` and `sourceAsOf`, with an optional HTTP(S) `sourceUrl`. A fixed ISO country-to-region catalog produces region totals. Listing exchange, ticker suffix, and trading currency are never used as geography. Net, Long, Short, and Gross `% NAV` are available by country and region. Unreviewed, unsupported, invalid, and stale allocations remain visible as Unknown. Holdings look-through expires after 120 days; country-of-risk and single-country mandates retain visible provenance dates without auto-expiry.

### Sensitivity

Sensitivity uses US/SPY, Canada/EWC, Europe/VGK, Japan/EWJ, Asia ex-Japan/AAXJ, China/MCHI, India/INDA, Latin America/ILF, and broad EM/EEM. Both the position and diagnostic proxy returns are OLS-residualized against ACWI before Pearson correlation. A portfolio row uses current signed NAV weights and reports modeled gross-NAV coverage.

These columns are overlapping market sensitivities. They are not additive allocation, domicile, or revenue exposure.

## Data and action gates

- Position weights and net liquidation must come from a fresh, non-cached, socket-verified IBKR portfolio response.
- Correlation, geography, factor exposure, and Hedge Lab inputs are built in the same server-owned snapshot from one adjusted-history fetch pass.
- Live and prior-close reference marks are labeled separately. First-order neutralization notionals require live marks.
- Yahoo history must contain explicit adjusted closes at daily granularity. Raw-close fallback is not permitted.
- Historical models are always labeled non-executable.
- Disconnected, stale, failed, mock, seed, cache-only, or otherwise unverified portfolio inputs clear every current portfolio matrix; prior rows are never retained.
- A factor proxy must have verified identity plus explicit analysis and hedge eligibility in the security master before a scenario notional can be displayed.
- Scenario output is first-order factor-neutral research only. There is no cross-factor optimizer, share conversion, order preview, staging, or submission route.

## Complete Hedgeye universe

The universe endpoint performs complete paginated scans of `HedgeyeDailySnapshot` and `HedgeyeRiskRanges`, then unions every retained structured/list/explicit ticker mention with the 119-row dashboard catalog. The Call and The Macro Show use their explicit source position sections instead of legacy parser arrays when those sections are available; prose that overflowed into an old `longs`, `shorts`, or `neutrals` array is excluded. On 2026-08-23 the archive contained:

| Source/result | Count |
| --- | ---: |
| Hedgeye snapshots scanned | 1,453 |
| Risk-range rows scanned | 3,194 |
| Distinct retained instruments/candidates | 942 |
| Current catalog entries | 119 |
| New structured mentions | 710 |
| Lower-confidence fallback/text candidates | 113 |
| Exact security/instrument names resolved | 847 |
| Unresolved review candidates | 95 |

All 942 retained rows remain visible in Universe QA. Lower-confidence fallback/text candidates are not promoted to tradable identities: every discovery defaults to unverified, analysis-ineligible, and hedge-ineligible. Known parser contamination, filenames, product labels, and prose words are not security candidates and are deliberately omitted. An unnamed list-only fragment is consolidated only when the same source product has exactly one provider-verified, exchange-qualified counterpart (for example, `ADS` into `ADS.DE`).

Security names are resolved independently of Hedgeye product content. The precedence is: an audited Exposure Lab security-master name, an exact SEC company-ticker directory match, exact Yahoo Finance instrument metadata for structured non-SEC symbols, and the existing dashboard catalog. Hedgeye fields such as `Real-Time Alert`, `The Call`, or other product labels are never accepted as canonical names. Tokens without an exact identity remain unnamed rather than receiving an inferred label.

## Security-master deployment

`infra/exposure-lab-security-master.yaml` defines the retained, deletion-protected DynamoDB table. `infra/iam/local-exposure-lab-security-master-policy.json` defines only the archive reads and security-review writes required by Exposure Lab. These artifacts must be reviewed and applied through the administrator deployment workflow before in-app review writes become available.

Each save transaction writes identity, eligibility, and optional geography together. Geography is cleared whenever identity is no longer verified. Existing records without geography remain valid and appear as Unknown; the DynamoDB table needs no migration.

Each save transaction writes both:

- a version-conditioned `CURRENT` record; and
- an immutable `AUDIT#<timestamp>#<event-id>` record containing the previous and next review state, reviewer, reason, and version.

Conflicting versions fail with HTTP 409 and require a reload before retrying.
