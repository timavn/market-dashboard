import React from 'react';

// Keep this document identity so saved links and user-owned Process edits survive
// the replacement of Exposure Lab with the independent PCA workspace.
export const EXPOSURE_LAB_GUIDE_SECTIONS = [
  ['start-here', 'Start here'],
  ['data-and-gates', 'Data and coverage'],
  ['components', 'Reading the components'],
  ['candidates', 'Comparing candidates'],
  ['mathematical-appendix', 'Methodology'],
  ['failure-states', 'Failure-state reference'],
];

export default function ExposureLabGuide() {
  return <>
    <section id="start-here">
      <h2>Start here</h2>
      <p>PCA asks: what common risks does the portfolio actually own? Quad rankings determine the exposures you want. PCA independently checks whether positions assigned to different factors are behaving like the same underlying trade.</p>
      <p>Open Portfolio → PCA. Read the snapshot date and coverage, then the largest share of portfolio risk. Select a component to see the holdings driving or offsetting it. These are daily post-close estimates from the captured portfolio.</p>
    </section>
    <section id="data-and-gates">
      <h2>Data and coverage</h2>
      <p>The default window is 126 trading days, with 63- and 252-day presets and custom windows from 63 to 504 days. Each included holding needs the entire window of adjusted daily returns and a verified signed position weight against account net liquidation.</p>
      <p>Stocks and ETFs use their own adjusted returns, including leveraged and inverse funds. Leverage is not applied a second time. Prediction contracts and other non-equity instruments sit outside this model and its coverage count. Contract type and broker metadata determine that scope, not ticker guesses. USD-listed equities in a verified USD account are supported first; ambiguous currencies, missing closes, and insufficient equity history remain coverage gaps.</p>
      <p>The covered subset keeps its actual weights. It is never scaled up to pretend it is the whole portfolio. A partial report cannot establish that the whole book is diversified. Provider failures preserve a saved report with its original date; they never refresh its holdings date.</p>
    </section>
    <section id="components">
      <h2>Reading the components</h2>
      <table className="wp-table" aria-label="PCA risk measures">
        <thead><tr><th>Measure</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td>Variance explained</td><td>The share of standardized holding-return variation explained by the component, independent of position size.</td></tr>
          <tr><td>Signed exposure</td><td>Portfolio return sensitivity to a positive one-standard-deviation move in that component, with holding volatility and signed weights restored.</td></tr>
          <tr><td>Portfolio risk share</td><td>The component’s variance contribution divided by the variance of the covered portfolio.</td></tr>
          <tr><td>Holding contribution</td><td>A signed attribution of component variance. Negative contributions identify offsets or hedges; contributions sum to the component’s variance.</td></tr>
          <tr><td>Other risk</td><td>All portfolio variance beyond the first five displayed components. This is an aggregate, not a sixth component.</td></tr>
        </tbody>
      </table>
      <p>A component warns at 35% of portfolio variance and is high at 50%, with both limits configurable. Components beyond the first five are checked individually too. A low concentration share does not by itself imply low total volatility.</p>
      <p>Macro references help interpret and name components using observed correlations. They never define the PCA axes or replace your quad factors. The label is descriptive, and component meanings can change between snapshots.</p>
    </section>
    <section id="candidates">
      <h2>Comparing candidates</h2>
      <p>Enter a ticker and a signed percentage-point NAV change, or combine changes into a basket. A +1 change adds one percentage point to the signed holding weight; −1 subtracts one. For a short position, a positive change reduces the short and a negative change increases it.</p>
      <p>The comparison freezes the selected snapshot’s components and dates. New securities need complete history on those same dates. Review component exposure, variance and concentration changes together with total volatility and Other risk. Moving risk outside the first five PCs is not automatically diversification.</p>
      <p>Account NAV stays fixed and cash balances the proposed changes. The comparison does not preview an order, stage an order, or submit an order, and it does not change quad targets.</p>
    </section>
    <section id="mathematical-appendix">
      <h2>Methodology</h2>
      <p>Daily split- and dividend-adjusted simple returns are centered and divided by their sample standard deviations. PCA uses these standardized holding returns without position-size weighting. Unit-variance component scores define each holding’s correlation loading.</p>
      <p>Multiply each loading by the holding’s daily volatility, then by its signed NAV weight. Sum those sensitivities for portfolio exposure. Squared exposure is component variance. A holding’s signed variance contribution is its exposure contribution multiplied by total component exposure.</p>
      <p>Full residual covariance is retained for candidate comparisons, including candidate-to-holding and candidate-to-candidate hedges. Daily variance is annualized using 252 sessions. Near-zero portfolio variance produces unavailable concentration ratios.</p>
      <p>Reference ETFs use adjusted returns; yields and spreads use basis-point changes; FX directions are normalized before calculating returns; spot VIX uses index-point changes. Reference publication delays affect interpretation coverage, not the holdings training window.</p>
      <p>Automatic collection runs at 17:30 America/New_York on trading days while the API is running, with retries until 20:00. Manual builds are available after 17:30 on trading days. Saved snapshots and candidate comparisons remain available at any time. Missed historical holdings are never reconstructed from today’s book.</p>
    </section>
    <section id="failure-states">
      <h2>Failure-state reference</h2>
      <p>UNAVAILABLE means the required verified inputs are absent. Partial coverage lists the excluded holdings. Short histories are not padded, missing returns are not filled with zero, and current quotes are not fabricated from the model.</p>
      <p>A failed refresh leaves a saved dated report unchanged. The guide itself is static and remains readable without any provider connection.</p>
    </section>
  </>;
}
