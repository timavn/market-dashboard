import React from 'react';

const {
  DEFAULT_CORRELATION_WINDOWS,
  DEFAULT_COVARIANCE_SHRINKAGE,
  DEFAULT_COVARIANCE_WINDOW,
  DEFAULT_HALF_LIFE,
  DEFAULT_MIN_OBSERVATIONS,
  DEFAULT_REGRESSION_SESSIONS,
  DEFAULT_RIDGE_LAMBDA,
  DEFAULT_SEASONED_OBSERVATIONS,
  FACTOR_DEFINITIONS,
  MODEL_VERSION,
  SAMPLE_SIZE_TIERS,
  factorFormula,
} = require('../../constants/exposureLabModel.cjs');
const {
  DEFAULT_CORRELATION_WINDOW,
  MINIMUM_CORRELATION_COVERAGE,
  MINIMUM_CORRELATION_OBSERVATIONS,
} = require('../../utils/exposureLabDiagnostics.cjs');
const {
  GEOGRAPHY_CONTROL_SYMBOL,
  GEOGRAPHY_HOLDINGS_MAX_AGE_DAYS,
  GEOGRAPHY_PROXIES,
} = require('../../constants/exposureLabGeography.cjs');

export const EXPOSURE_LAB_GUIDE_SECTIONS = [
  ['start-here', 'Start here'],
  ['data-and-gates', 'Data provenance and gates'],
  ['summary-strip', 'Summary strip'],
  ['exposure-matrix', 'Exposure Matrix'],
  ['factor-catalog', 'Complete factor catalog'],
  ['worked-example', 'Worked SUJA example'],
  ['other-tabs', 'Correlation and Geography'],
  ['decision-playbooks', 'Decision playbooks'],
  ['mathematical-appendix', 'Mathematical appendix'],
  ['failure-states', 'Failure-state reference'],
];

const FACTOR_INTERPRETATIONS = Object.freeze({
  market: {
    positive: 'Moves with broad U.S. equities after controlling for the other factors.',
    negative: 'Moves against broad U.S. equities after controlling for the other factors.',
  },
  'style-value': {
    positive: 'Value tilt: IWD-like behavior relative to IWF.',
    negative: 'Growth tilt: IWF-like behavior relative to IWD.',
  },
  'style-momentum': {
    positive: 'Momentum leadership relative to the broad market.',
    negative: 'Anti-momentum or laggard behavior relative to the broad market.',
  },
  'style-quality': {
    positive: 'Quality exposure relative to the broad market.',
    negative: 'Lower-quality exposure relative to the broad market.',
  },
  'style-size': {
    positive: 'Small-cap exposure relative to mega/large-cap exposure.',
    negative: 'Mega/large-cap exposure relative to small caps.',
  },
  'style-beta': {
    positive: 'High-beta exposure relative to low-volatility equities.',
    negative: 'Low-volatility exposure relative to high-beta equities.',
  },
  'style-dividend': {
    positive: 'Dividend exposure relative to the broad market.',
    negative: 'Non-dividend or lower-yield exposure relative to the broad market.',
  },
  'style-secular-growth': {
    positive: 'QQQ-like secular-growth exposure relative to the broad market.',
    negative: 'Non-QQQ or anti-growth exposure relative to the broad market.',
  },
  'macro-credit': {
    positive: 'Risk-on high-yield credit relative to investment-grade credit.',
    negative: 'Higher-quality credit/duration exposure relative to high yield.',
  },
  'macro-duration': {
    positive: 'Long-duration Treasury exposure relative to short duration.',
    negative: 'Short-duration or rising-rate sensitivity relative to long duration.',
  },
  'macro-usd': {
    positive: 'Benefits from, or behaves with, a stronger U.S. dollar.',
    negative: 'Anti-dollar exposure.',
  },
  'macro-commodities': {
    positive: 'Broad commodity sensitivity.',
    negative: 'Moves against broad commodities.',
  },
  'macro-gold': {
    positive: 'Gold sensitivity.',
    negative: 'Moves against gold.',
  },
  'macro-em-fx': {
    positive: 'Emerging-market currency exposure relative to the U.S. dollar.',
    negative: 'U.S.-dollar exposure relative to emerging-market currencies.',
  },
});

function factorInterpretation(factor) {
  if (factor.family === 'Sector') {
    return {
      positive: `${factor.label} sensitivity relative to SPY.`,
      negative: `Opposite ${factor.label} relative sensitivity; not automatically a direct sector short.`,
    };
  }
  return FACTOR_INTERPRETATIONS[factor.id] || {
    positive: `Positive conditional sensitivity to ${factor.label}.`,
    negative: `Negative conditional sensitivity to ${factor.label}.`,
  };
}

function FactorCatalogRows() {
  return FACTOR_DEFINITIONS.map((factor) => {
    const interpretation = factorInterpretation(factor);
    return (
      <tr key={factor.id}>
        <td>{factor.family}</td>
        <th scope="row">{factor.label}</th>
        <td><code>{factorFormula(factor)}</code></td>
        <td>{interpretation.positive}</td>
        <td>{interpretation.negative}</td>
      </tr>
    );
  });
}

const blockerRows = [
  ['factor_risk_snapshot_unavailable', 'The factor snapshot itself is unavailable; no scenario can be calculated.'],
  ['live_marks_unavailable', 'Positions are verified, but marks are reference or unavailable; dollar sizing is blocked.'],
  ['security_master_unavailable', 'The reviewed-instrument ledger cannot be verified.'],
  ['incomplete_security_model_coverage', 'At least one included position has no usable factor model.'],
  ['preliminary_security_models', `At least one modeled position has fewer than ${DEFAULT_SEASONED_OBSERVATIONS} aligned returns.`],
  ['hedge_instrument_review_incomplete', 'One or both proxy instruments lack verified identity plus analysis and hedge eligibility.'],
];

const ExposureLabGuide = () => (
  <>
    <section id="start-here">
      <h2>Start here</h2>
      <p>
        Exposure Lab answers one operating question: <em>what common risks does the portfolio actually own, and
        which positions create them?</em> It is a historical risk decomposition, not an expected-return model, a
        price forecast, or an order system.
      </p>
      <h3>The daily sequence</h3>
      <ol>
        <li>Press <strong>Refresh</strong> and verify the portfolio state, IBKR state, model version, and as-of date.</li>
        <li>Check <strong>Model Coverage</strong>, then scan Sample and R² before trusting any security row.</li>
        <li>Read the Portfolio footer in Absolute mode to find the largest factor exposures.</li>
        <li>Read the same footer versus SPY to understand active factor bets against the benchmark.</li>
        <li>Scan each important factor column to identify the securities contributing to that exposure.</li>
        <li>Use Correlation to compare position P&amp;L, positions versus factors, and factors versus factors.</li>
        <li>Read the covariance-ranked common-risk and offsetting pairs; no transitive clusters are inferred.</li>
        <li>Use Geography Allocation for audited country weights and Geography Sensitivity for de-marketed regional diagnostics.</li>
        <li>Only then consider resizing, substituting, or researching an offset. Hedge Lab remains a non-executable scenario.</li>
      </ol>
      <p>
        A green cell means a positive signed exposure and a red cell means a negative signed exposure. Color does
        not mean good or bad. Whether an exposure is desirable depends on the portfolio thesis and risk budget.
      </p>
    </section>

    <section id="data-and-gates">
      <h2>Data provenance and gates</h2>
      <table className="wp-table">
        <thead>
          <tr><th>Source</th><th>What it supplies</th><th>Required interpretation</th></tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">IBKR</th>
            <td>Current positions, signed market values, account identity, and net liquidation value.</td>
            <td>Must be socket-verified, from the live IBKR API, and explicitly non-cached or the factor snapshot is cleared.</td>
          </tr>
          <tr>
            <th scope="row">Yahoo Finance</th>
            <td>Explicit adjusted closes for factor proxies and modeled securities.</td>
            <td>Completed daily sessions only. This is historical research data, never an executable quote.</td>
          </tr>
          <tr>
            <th scope="row">Hedgeye archive</th>
            <td>Every retained ticker mention found in complete snapshot and Risk Range scans.</td>
            <td>Discovery only. Hedgeye does not supply the factor scores shown in the matrix.</td>
          </tr>
          <tr>
            <th scope="row">Security master</th>
            <td>Reviewed identity, canonical symbol, instrument type, and analysis/hedge eligibility.</td>
            <td>Every change requires a reviewer and reason and produces a versioned audit event.</td>
          </tr>
        </tbody>
      </table>
      <p>
        <strong>LIVE</strong> means the verified portfolio also has live marks with good data quality.
        <strong> REFERENCE</strong> means positions and NLV are verified but marks are not live; historical factor
        analysis may remain visible, while dollar hedge scenarios remain blocked. <strong>UNAVAILABLE</strong> means
        the required live portfolio or historical inputs did not pass their gate. The guide itself is static and
        remains readable without any provider connection.
      </p>
    </section>

    <section id="summary-strip">
      <h2>Summary strip</h2>
      <table className="wp-table wp-table--definitions">
        <thead>
          <tr><th>Field</th><th>Meaning</th><th>How to use it</th></tr>
        </thead>
        <tbody>
          <tr><th scope="row">Net</th><td>Signed position market value divided by NLV.</td><td>First read of directional balance; it does not describe factor neutrality.</td></tr>
          <tr><th scope="row">Gross</th><td>Absolute position market value divided by NLV.</td><td>Capital at risk before long/short offsets.</td></tr>
          <tr><th scope="row">Pred Vol</th><td>Annualized factor variance plus modeled residual variance.</td><td>Model estimate of total portfolio volatility, not a forecast guarantee.</td></tr>
          <tr><th scope="row">Factor Vol</th><td>Annualized volatility attributable to the common-factor block.</td><td>Compare with Pred Vol to judge common versus idiosyncratic risk.</td></tr>
          <tr><th scope="row">Corr Coverage</th><td>Share of default-window position matrix cells that passed the observation and variance gates.</td><td>Read with the positions-with-history count before using pair rankings.</td></tr>
          <tr><th scope="row">Model Coverage</th><td>Gross NAV represented by securities with available factor models, plus modeled/total counts.</td><td>Check before interpreting totals. Gross-based coverage can exceed 100% when the book is levered.</td></tr>
          <tr><th scope="row">As Of</th><td>Latest completed date used by the factor covariance block.</td><td>Confirms the historical model date; it is not a live quote timestamp.</td></tr>
        </tbody>
      </table>
    </section>

    <section id="exposure-matrix">
      <h2>Exposure Matrix</h2>
      <h3>Fixed columns</h3>
      <table className="wp-table wp-table--definitions">
        <thead>
          <tr><th>Column</th><th>Definition</th><th>Operating read</th></tr>
        </thead>
        <tbody>
          <tr><th scope="row">Symbol</th><td>Current verified IBKR holding included in the model scope.</td><td>The matrix models the portfolio, not every row in Universe QA.</td></tr>
          <tr><th scope="row">Sample</th><td>Progressive tier based on aligned security/factor daily returns.</td><td>Hover for the exact observation count and distance to the next tier.</td></tr>
          <tr><th scope="row">Side</th><td>Long or short from the sign of the verified market value.</td><td>A short reverses the sign of its loading when converted to portfolio contribution.</td></tr>
          <tr><th scope="row">% NAV</th><td>Signed market value divided by verified NLV.</td><td>Positive for longs and negative for shorts.</td></tr>
          <tr><th scope="row">R²</th><td>Exponentially weighted, in-sample fraction of return variance explained by all factors together.</td><td>Judge model fit alongside Sample; never read R² as conviction or expected return.</td></tr>
        </tbody>
      </table>

      <h3>Sample tiers</h3>
      <table className="wp-table wp-table--numeric">
        <thead><tr><th>Displayed tier</th><th>Exact range</th><th>Use</th></tr></thead>
        <tbody>
          <tr><th scope="row">&lt;{DEFAULT_MIN_OBSERVATIONS}</th><td>0–{DEFAULT_MIN_OBSERVATIONS - 1}</td><td>Unmodeled. Factor cells stay unavailable.</td></tr>
          <tr><th scope="row">{SAMPLE_SIZE_TIERS[0]}</th><td>{SAMPLE_SIZE_TIERS[0]}–{SAMPLE_SIZE_TIERS[1] - 1}</td><td>Early, preliminary estimate.</td></tr>
          <tr><th scope="row">{SAMPLE_SIZE_TIERS[1]}</th><td>{SAMPLE_SIZE_TIERS[1]}–{SAMPLE_SIZE_TIERS[2] - 1}</td><td>Building, preliminary estimate.</td></tr>
          <tr><th scope="row">{SAMPLE_SIZE_TIERS[2]}</th><td>{SAMPLE_SIZE_TIERS[2]}–{SAMPLE_SIZE_TIERS[3] - 1}</td><td>Moderate, preliminary estimate.</td></tr>
          <tr><th scope="row">{SAMPLE_SIZE_TIERS[3]}+</th><td>{SAMPLE_SIZE_TIERS[3]} or more</td><td>Seasoned for the current operating gate.</td></tr>
        </tbody>
      </table>
      <p>
        Practical R² triage—not a hard portfolio rule—is: roughly 70% or more is factor-dominated, 40–70% is mixed,
        and below 40% is more idiosyncratic or weakly fit. A negative R² is possible under a penalized model and means
        the fitted factor block performed worse in sample than the weighted mean. Compare securities rather than
        treating these bands as an approval gate.
      </p>
      <p>
        The Portfolio footer has one deliberate exception: the value physically under the R² header is
        <strong> modeled gross-NAV coverage</strong>, not a portfolio R². It can exceed 100% in a levered book.
      </p>

      <h3>Factor cells and controls</h3>
      <p className="wp-equation">
        <code>factor contribution (% NAV) = signed portfolio weight × factor loading × 100</code>
      </p>
      <p>
        <strong>% NAV contribution</strong> is the default and answers, “how much of the portfolio&apos;s exposure comes
        from this security?” <strong>Loading</strong> shows the raw conditional regression coefficient and answers,
        “how sensitive has this security been to one unit of this factor, holding the other factors fixed?” A loading
        is unitless and is not a position weight.
      </p>
      <p>
        <strong>Absolute</strong> displays the summed portfolio factor exposure. <strong>vs SPY</strong> subtracts
        SPY&apos;s estimated factor loading from each portfolio total. This benchmark switch changes the factor values
        in the Portfolio footer only; security-level rows continue to display their absolute loading or contribution.
      </p>
    </section>

    <section id="factor-catalog">
      <h2>Complete factor catalog</h2>
      <p>
        These are transparent ETF return proxies defined locally by model <code>{MODEL_VERSION}</code>. A spread such
        as <code>XLE - SPY</code> is the adjusted daily return of XLE minus SPY. Every loading is conditional on the
        entire factor set, so correlated proxies can divide one economic exposure across several columns.
      </p>
      <table className="wp-table exposure-lab-guide__factor-table" aria-label="Exposure Lab factor catalog">
        <thead>
          <tr><th>Family</th><th>Factor</th><th>Return proxy</th><th>Positive loading</th><th>Negative loading</th></tr>
        </thead>
        <tbody><FactorCatalogRows /></tbody>
      </table>
    </section>

    <section id="worked-example">
      <h2>Worked SUJA example</h2>
      <p>
        This is an illustrative snapshot, not a current value. Suppose SUJA is a 2.11% short and its conditional
        Market loading is +3.80:
      </p>
      <p className="wp-equation"><code>−2.11% × +3.80 ≈ −8.02% Market contribution</code></p>
      <p>
        The positive loading says SUJA&apos;s historical returns behaved like a high-beta equity after controlling for
        the other factors. The negative position weight turns that into a negative portfolio Market contribution.
        The result is an exposure estimate—not an expected return, price target, or prediction that SUJA will fall.
      </p>
      <p>
        If Sample displays <strong>60</strong>, the exact count is somewhere from 60 through 89 and appears in the
        cell tooltip. At an exact count such as 73, the model keeps the factor cells so the risk can be monitored,
        but labels the estimate preliminary. The global Hedge Lab sizing gate remains blocked until every included
        modeled security reaches {DEFAULT_SEASONED_OBSERVATIONS} aligned returns and all other gates pass.
      </p>
    </section>

    <section id="other-tabs">
      <h2>Correlation and Geography</h2>
      <h3>Unified Correlation</h3>
      <p>
        Position × position, position × factor, and factor × factor matrices use adjusted-close simple returns over
        the latest {DEFAULT_CORRELATION_WINDOWS.join(', ')} completed-session windows. Every cell requires
        <code> max({MINIMUM_CORRELATION_OBSERVATIONS}, ceil({MINIMUM_CORRELATION_COVERAGE} × window))</code> aligned
        observations. A failed gate stays empty and its tooltip reports the reason and observation count.
      </p>
      <p>
        Position cells describe P&amp;L co-movement: a short multiplies its raw asset correlation by −1. Factor-factor
        cells remain raw. Hover to compare the sign-adjusted and raw values. Red means positive P&amp;L co-movement or
        common risk; blue means an offset. The initial position scope is the top 20 by gross NAV, with All and search
        controls up to the 75-symbol server guardrail.
      </p>
      <ul>
        <li><strong>Largest common-risk pairs</strong> have positive annualized signed pair covariance.</li>
        <li><strong>Largest offsetting pairs</strong> have negative annualized signed pair covariance.</li>
        <li>Ranking uses current NAV weights and {DEFAULT_COVARIANCE_SHRINKAGE * 100}% off-diagonal shrinkage over the default {DEFAULT_CORRELATION_WINDOW}-session window.</li>
        <li>No thematic label, composite concentration score, or transitive grouping is inferred.</li>
      </ul>

      <h3>Geography Allocation</h3>
      <p>
        Allocation is sourced only from an audited security-master record. Stocks use one country of risk at 100%.
        Funds use either a single-country mandate or audited holdings look-through weights totaling 100%. Net, Long,
        Short, and Gross % NAV views are available by country and fixed region. Unreviewed, invalid, unsupported, or
        stale records remain in <strong>Unknown</strong>; listing exchange, ticker suffix, and trading currency are
        never substitutes. Holdings look-through expires after {GEOGRAPHY_HOLDINGS_MAX_AGE_DAYS} days.
      </p>

      <h3>Geography Sensitivity</h3>
      <p>
        The diagnostic columns are {GEOGRAPHY_PROXIES.map((proxy) => `${proxy.label}/${proxy.symbol}`).join(', ')}.
        Both a position and a proxy are residualized against {GEOGRAPHY_CONTROL_SYMBOL} with an intercept before
        Pearson correlation. The portfolio row uses current signed NAV weights and reports modeled gross-NAV
        coverage. These sensitivities overlap and are not additive allocation, domicile, or revenue exposure.
      </p>

      <h3>Universe QA</h3>
      <table className="wp-table">
        <thead><tr><th>State</th><th>Meaning</th><th>What it does not prove</th></tr></thead>
        <tbody>
          <tr><th scope="row">Catalogued</th><td>Already present in the dashboard security catalog.</td><td>It is not automatically approved for analysis or hedging.</td></tr>
          <tr><th scope="row">Structured</th><td>Found in a trusted structured field, key, or Risk Range row.</td><td>The token is not necessarily a verified instrument identity.</td></tr>
          <tr><th scope="row">Candidate</th><td>Found in a lower-confidence list or explicit text mention.</td><td>It may be a parser token rather than a security.</td></tr>
        </tbody>
      </table>
      <p>
        <strong>Security name</strong> never comes from a Hedgeye product label. The display uses an audited
        security-master name first, then an exact SEC ticker-directory match, exact Yahoo instrument metadata for
        structured non-SEC symbols, and finally the dashboard catalog. A dash means no exact directory identity was
        found; the tool leaves that candidate unnamed instead of guessing.
      </p>
      <p>
        Review identity before enabling analysis. A verified record needs a canonical symbol and instrument type.
        Hedge eligibility requires analysis eligibility. Every save needs a reviewer and audit reason; version
        conflicts require a reload. The universe is a discovery ledger and can grow independently of the current
        portfolio matrix. The same versioned review can add or clear geography, country weights, source name,
        source date, and optional source URL. Geography is automatically cleared whenever identity is no longer verified.
      </p>

      <h3>Hedge Lab</h3>
      <p>
        Hedge Lab targets zero first-order exposure with a 0.5% tolerance. For an eligible factor it shows equal
        dollar notionals for the long and short proxy legs needed to offset the current factor exposure. It does not
        solve interactions across factors, convert dollars to shares, account for transaction costs, preview an
        order, stage an order, or submit an order.
      </p>
      <table className="wp-table wp-table--definitions">
        <thead><tr><th>Blocker</th><th>Meaning</th></tr></thead>
        <tbody>
          {blockerRows.map(([blocker, meaning]) => (
            <tr key={blocker}><th scope="row"><code>{blocker}</code></th><td>{meaning}</td></tr>
          ))}
        </tbody>
      </table>
    </section>

    <section id="decision-playbooks">
      <h2>Decision playbooks</h2>
      <table className="wp-table">
        <thead><tr><th>Observation</th><th>Investigation</th><th>Permitted conclusion</th></tr></thead>
        <tbody>
          <tr>
            <th scope="row">Market exposure is too large</th>
            <td>Read the Market contribution column, confirm Sample and R², then inspect position-factor correlation and common-risk pairs.</td>
            <td>Identify the least thesis-critical contributors for resizing or research a verified offset. Do not infer an exact hedge from factor exposure alone.</td>
          </tr>
          <tr>
            <th scope="row">Sector/style/macro tilt is unintended</th>
            <td>Find the largest same-sign contributors, switch to Loading to separate position size from sensitivity, and inspect correlated factor columns.</td>
            <td>Decide whether the exposure is intentional, duplicated, or incidental before changing a security.</td>
          </tr>
          <tr>
            <th scope="row">Different positions appear to be the same bet</th>
            <td>Inspect the sign-adjusted matrix, raw tooltips, annualized common-risk pair ranking, and modeled coverage across windows.</td>
            <td>Document directly observed pairwise overlap. Do not extrapolate a transitive cluster from indirect links.</td>
          </tr>
          <tr>
            <th scope="row">Geographic concentration is unclear</th>
            <td>Separate audited Allocation from overlapping ACWI-controlled Sensitivity; inspect Unknown and modeled gross-NAV coverage.</td>
            <td>Distinguish reviewed country weights from market behavior. Do not reinterpret sensitivity as revenue or domicile exposure.</td>
          </tr>
          <tr>
            <th scope="row">An intended factor is missing</th>
            <td>Check both Absolute and vs SPY, then inspect opposite-sign contributors that may be canceling the desired exposure.</td>
            <td>Separate a genuinely absent factor from a benchmark-relative or long/short cancellation.</td>
          </tr>
          <tr>
            <th scope="row">Sample, R², or coverage is weak</th>
            <td>Read the exact observation count, model reason, history failures, and gross NAV left unmodeled.</td>
            <td>Wait for evidence or use independent risk work. Do not force a model-driven portfolio change from an unreliable row.</td>
          </tr>
        </tbody>
      </table>
      <p>
        The final PM record should name the factor, current exposure, largest contributors, sample/coverage quality,
        relevant correlations, intended versus accidental status, and the reason for any resize. Exposure Lab
        diagnoses the portfolio; it does not authorize the trade.
      </p>
    </section>

    <section id="mathematical-appendix">
      <h2>Mathematical appendix</h2>
      <h3>Security regression</h3>
      <p className="wp-equation"><code>rᵢ,t = αᵢ + βᵢ′fₜ + εᵢ,t</code></p>
      <p>
        Security and factor adjusted-close simple returns are aligned by completed trading date. The engine uses at
        most {DEFAULT_REGRESSION_SESSIONS} aligned sessions, exponentially weights recent data with a
        {` ${DEFAULT_HALF_LIFE}`}-session half-life, standardizes factor columns, and applies a ridge penalty of
        {` ${DEFAULT_RIDGE_LAMBDA}`}. At least {DEFAULT_MIN_OBSERVATIONS} aligned security returns are required;
        {` ${DEFAULT_SEASONED_OBSERVATIONS}`} are required for seasoned status. The intercept is unpenalized through
        weighted centering.
      </p>
      <p className="wp-equation"><code>R² = 1 − weighted residual sum of squares / weighted total sum of squares</code></p>

      <h3>Portfolio aggregation and risk</h3>
      <p className="wp-equation"><code>b = Σᵢ wᵢβᵢ</code></p>
      <p className="wp-equation"><code>variance = b′ΣF b + Σᵢ wᵢ²σε,i²</code></p>
      <p className="wp-equation"><code>annualized volatility = √variance × √252</code></p>
      <p>
        Factor covariance uses the latest {DEFAULT_COVARIANCE_WINDOW} aligned sessions. Diagonal variances remain
        unchanged; off-diagonal covariances are multiplied by
        {` ${(1 - DEFAULT_COVARIANCE_SHRINKAGE).toFixed(1)}`}—equivalent to
        {` ${(DEFAULT_COVARIANCE_SHRINKAGE * 100).toFixed(0)}%`} shrinkage toward zero. The residual term assumes
        cross-security residual covariance is zero, an important simplification.
      </p>

      <h3>Correlation sufficiency</h3>
      <p className="wp-equation"><code>minimum observations = max({MINIMUM_CORRELATION_OBSERVATIONS}, ceil({MINIMUM_CORRELATION_COVERAGE} × requested window))</code></p>
      <p className="wp-equation"><code>P&amp;L correlationᵢⱼ = sideᵢ × sideⱼ × raw asset correlationᵢⱼ</code></p>
      <p className="wp-equation"><code>annualized pair risk = 2 × |wᵢ| × |wⱼ| × signed covarianceᵢⱼ × (1 − {DEFAULT_COVARIANCE_SHRINKAGE}) × 252</code></p>
      <p>
        The model is deliberately interpretable but not structurally pure. ETF proxies include their own sector,
        country, duration, and construction effects. Correlated regressors can split one economic exposure across
        columns even with ridge stabilization. Results are backward-looking, regime-dependent, in-sample, and do not
        model nonlinear payoffs, factor interactions, residual cross-correlation, transaction costs, or liquidity.
      </p>
    </section>

    <section id="failure-states">
      <h2>Failure-state reference</h2>
      <table className="wp-table wp-table--definitions">
        <thead><tr><th>State or reason</th><th>What happened</th><th>Operator response</th></tr></thead>
        <tbody>
          <tr><th scope="row"><code>live_portfolio_unavailable</code></th><td>IBKR portfolio retrieval failed.</td><td>Wait for verified connectivity and refresh; no prior portfolio rows should remain.</td></tr>
          <tr><th scope="row"><code>live_portfolio_unverified</code></th><td>The response was cached, disconnected, or not socket-verified.</td><td>Do not use it. Exposure Lab retries briefly and otherwise stays unavailable.</td></tr>
          <tr><th scope="row"><code>net_liquidation_unavailable</code></th><td>A positive verified NLV was not available.</td><td>Position weights and portfolio exposure cannot be calculated.</td></tr>
          <tr><th scope="row"><code>factor_history_unavailable</code></th><td>The proxy set lacks enough aligned adjusted history.</td><td>Inspect history failures and wait for valid completed-session data.</td></tr>
          <tr><th scope="row"><code>insufficient_aligned_returns</code></th><td>A security has fewer than {DEFAULT_MIN_OBSERVATIONS} common returns.</td><td>Leave the row unmodeled until it reaches the floor.</td></tr>
          <tr><th scope="row"><code>zero_factor_variance</code></th><td>An aligned factor column has no usable variance.</td><td>Treat the security model as unavailable; do not fill the cell.</td></tr>
          <tr><th scope="row"><code>singular_factor_system</code></th><td>The penalized linear system still could not be solved.</td><td>Treat the security model as unavailable and investigate the histories.</td></tr>
          <tr><th scope="row"><code>portfolio_scope_exceeds_model_limit</code></th><td>The eligible symbol count exceeds the configured guardrail, 75 by default.</td><td>Review configuration and scope; the server returns no risk snapshot.</td></tr>
          <tr><th scope="row"><code>insufficient_aligned_observations</code></th><td>A correlation cell did not reach the 80% window gate.</td><td>Read the reported count; leave the cell empty rather than imputing a value.</td></tr>
          <tr><th scope="row"><code>zero_variance</code></th><td>One aligned return series has no usable variance.</td><td>Treat that matrix cell as unavailable.</td></tr>
          <tr><th scope="row"><code>holdings_lookthrough_stale</code></th><td>A fund allocation source is older than {GEOGRAPHY_HOLDINGS_MAX_AGE_DAYS} days.</td><td>The full position moves to Unknown until a reviewed source is saved.</td></tr>
          <tr><th scope="row"><code>control_history_unavailable</code></th><td>{GEOGRAPHY_CONTROL_SYMBOL} history did not pass the sensitivity gate.</td><td>Clear geography sensitivities; do not substitute an uncontrolled proxy correlation.</td></tr>
          <tr><th scope="row">History failure</th><td>One or more security or proxy histories failed validation or retrieval.</td><td>Check whether the failure removes a factor or leaves gross NAV unmodeled.</td></tr>
          <tr><th scope="row">Preliminary model</th><td>The row is modeled but has fewer than {DEFAULT_SEASONED_OBSERVATIONS} returns.</td><td>Use it for monitored risk only; Hedge Lab remains blocked globally.</td></tr>
          <tr><th scope="row">Security master unavailable</th><td>Reviewed identity and eligibility cannot be verified.</td><td>Keep universe discoveries visible but block review-dependent scenario output.</td></tr>
          <tr><th scope="row">Reference marks</th><td>The portfolio is verified but live marks did not pass.</td><td>Historical exposure remains research-only; dollar scenarios stay blocked.</td></tr>
        </tbody>
      </table>
      <p>
        Never replace an unavailable live input with a cached portfolio, prior close, model value, seed, or inferred
        quote. The valid states are loading, an explicit unavailable/error state, or verified live portfolio data.
      </p>
    </section>
  </>
);

export default ExposureLabGuide;
