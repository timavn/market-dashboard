# Portfolio PCA risk

Open **Portfolio → PCA**. This replaces the unused Exposure Lab workspace. Quad rankings and weights remain independent inputs to the investment process; PCA describes the common risks in the captured holdings.

## Model

- Default: 126 completed daily observations; configurable from 63 to 504 sessions. Prices need one additional observation to calculate returns.
- Fit a correlation PCA to centered, standardized adjusted simple returns of the covered holdings. Position sizes do not define the axes. Display five PCs and retain all remaining components in risk totals.
- For unit-variance PC scores, holding loading is its correlation with the score. Holding exposure is signed NAV weight × daily volatility × loading. Portfolio PC exposure is the sum of those holding exposures; its variance contribution is the squared exposure.
- A holding's signed component variance contribution equals holding exposure × portfolio component exposure. These signed contributions sum to component variance, including short and hedge offsets.
- Concentration is component variance / total covered-portfolio variance. Default watch/high limits are 35%/50%; both are configurable. Limits also apply to components beyond PC5. Annualized volatility uses 252 sessions.
- The 44-reference macro catalog interprets components through correlations only. References never enter the PCA training matrix or alter quad factors. Component signs are aligned to sufficiently correlated prior scores when possible; ranks remain current variance ranks.

Candidate comparisons freeze the selected snapshot's complete PCA basis and dates. Signed changes are percentage points of NAV, with NAV fixed and cash balancing changes. New securities require complete matching history. Full residual covariance retains candidate-to-holding and candidate-to-candidate offsets. Compare absolute variance, concentration shares, and total volatility together. This is a research calculation with no order integration.

## Evidence and coverage

Fresh verified broker quantities and USD NAV are combined with verified official session closes. The universe contains equities and ETFs/ETPs only, including long and short positions. Prediction contracts and identified non-equity instruments are outside scope and do not count as missing equity coverage. Classification uses broker contract type, event venue, and contract metadata rather than an equity ticker blacklist. Missing instrument identity remains a verification gap. USD stocks and ETFs/ETPs use their own split- and dividend-adjusted returns; leveraged products are not multiplied by leverage again. Unverified equity quantities/currencies, incomplete histories and zero-variance training series are explicit exclusions. Covered weights are never rescaled to conceal excluded positions.

Coverage is a compact disclosure in the workspace. A genuine equity's missing close remains visible even if the ticker is unfamiliar: EXPGY, for example, is an equity ADR rather than an event contract. A missing live quote does not by itself invalidate separately verified quantity and official-close evidence for this historical risk model.

IBKR rows represent aggregate positions. Identical duplicate deliveries count once; contradictory quantities or security identities are excluded. Coverage counts unique securities, and gross weight is reported as fully verified only when all required positions can be valued consistently.

History comes from the existing Yahoo transport with security/currency/session checks. FRED yields and spreads become basis-point changes. FX quotes are normalized to the catalog's direction before calculating returns and aligned by the provider's session timezone. Spot VIX uses Cboe daily index-point changes. Missing history is neither forward-filled nor replaced with zero. References with less than 80% overlapping observations are omitted from interpretation.

Historical snapshots retain their original dates and evidence when providers become unavailable. They are never executable quotes. Holdings/NAV observation timestamps remain separate from the return-window ending session.

## Operation

The API's worker runs after 17:30 America/New_York on US trading days, retries incomplete or failed captures every 15 minutes through 20:00, and checks for a missing snapshot on startup within that same window. The API must be running. Manual builds are available after 17:30 on trading days until local midnight. This prevents mixing an intraday book and NAV with yesterday's closes. Current holdings are captured at run time; historical holdings are not reconstructed. Dated snapshot browsing and candidate comparisons remain available at any time.

Private server-side state is stored under `~/Library/Application Support/market-dashboard/portfolio-pca` on macOS or `~/.local/state/market-dashboard/portfolio-pca` elsewhere. Set `PORTFOLIO_PCA_STATE_DIR` to override. Directories/files use 0700/0600 permissions; account folders are hashed. `IBKR_ACCOUNT_ID` optionally selects the worker's default account; otherwise an account alias is learned only from a verified capture. Snapshots and their input evidence are immutable and content-addressed; public API responses omit raw evidence and solver state. Account history is not saved in browser storage.

API routes under `/api/risk/pca`: `GET snapshot`, `GET history`, `GET/PUT config`, `POST refresh`, and `POST compare`. Refresh returns immediately; the UI polls until the attempt finishes.

## Verification

```sh
node --test src/services/pca/*.test.cjs src/routes/pcaRisk.test.cjs
CI=true npm test -- --runInBand --watchAll=false src/components/Dashboard/PcaRiskWorkspace.test.jsx
npm run build
```

Tests cover signed hedges, variance reconciliation, residual covariance, reference independence, malformed or incomplete data, provider/session provenance, account isolation, persistence, scheduling, asynchronous refresh and candidate comparisons.

Method references: [PCA centering and variance definitions](https://scikit-learn.org/stable/modules/generated/sklearn.decomposition.PCA.html), [FRED high-yield spread units](https://fred.stlouisfed.org/series/BAMLH0A0HYM2). Standardization is explicit in this implementation because PCA alone does not scale input variables.
