import React from 'react';
import { GLOBAL_MARKETS } from '../../constants/globalMarkets';
import { CORRELATION_PERIODS } from '../../constants/usdMarket';
import { USD_CORRELATION_HEATMAP_THRESHOLDS } from '../../constants/usdCorrelationPresentation';
import { CFTC_STALE_AFTER_DAYS } from '../../constants/cftcPositioning';
import { VOLATILITY_INDEX_DEFINITIONS } from '../../constants/volatilityIndexDefinitions';
import { VOL_RANGES } from '../../utils/volatilityRegimes';

const {
  GLOBAL_LIQUIDITY_RATIO_PRESSURE_WEIGHTS,
  GLOBAL_LIQUIDITY_REGIME_THRESHOLDS,
  GLOBAL_LIQUIDITY_SCORE_BREAKPOINTS,
  GLOBAL_LIQUIDITY_WEIGHTS,
  DEFAULT_GDP_LAG_MONTHS,
  US_LIQUIDITY_ACCELERATION_TOLERANCE,
  US_LIQUIDITY_GREEN_STACK_TO_GDP,
} = require('../../constants/liquidityModelMetadata.cjs');
const {
  DEFAULT_MAX_STALE_DAYS: USD_CORRELATION_MAX_STALE_DAYS,
  ROLLING_SAMPLE_COUNT,
  ROLLING_WINDOW,
  REQUIRED_ROLLING_OBSERVATIONS,
} = require('../../utils/usdCorrelations.cjs');
const { DEFAULT_COMPARISON_WINDOWS } = require('../../utils/marketStructureVolume.cjs');

const HEDGEYE_PROCESS_URL = 'https://app.hedgeye.com/education';
const HEDGEYE_RISK_RANGE_URL = 'https://app.hedgeye.com/user-guides/risk-range';
const CFTC_LEGACY_URL = 'https://publicreporting.cftc.gov/Commitments-of-Traders/Legacy_All/srt6-5q2f';
const CFTC_DISAGGREGATED_URL = 'https://publicreporting.cftc.gov/Commitments-of-Traders/Disaggregated_All/rxbv-e226';
const FRED_URL = 'https://fred.stlouisfed.org/';
const CBOE_VOLUME_URL = 'https://www.cboe.com/us/equities/market_statistics/historical_market_volume/';

export const DASHBOARD_GUIDE_SECTIONS = [
  ['start-here', 'Start Here'],
  ['volatility', '1. Volatility'],
  ['usd', '2. USD'],
  ['market-backdrop', '3. Market Backdrop'],
  ['cftc-positioning', '4. CFTC Positioning'],
  ['global-quads', '5. Global Quads'],
  ['dollar-liquidity', '6. Dollar Liquidity'],
  ['volume', '7. Volume'],
  ['reference', 'Reference'],
];

export const METHODOLOGY_LABELS = Object.freeze([
  'Hedgeye public concept',
  'Official provider formula',
  'Dashboard formula',
  'Dashboard heuristic',
  'Manual input',
]);

const CHAPTER_PARTS = [
  ['what', 'What it shows'],
  ['read', 'How to read it'],
  ['example', 'Worked example'],
  ['math', 'Exact math'],
  ['inputs', 'Inputs and cadence'],
  ['hedgeye', 'Hedgeye Process connection'],
  ['dashboard', 'Dashboard-specific behavior'],
  ['failure', 'Failure states'],
];

const MethodStatement = ({ label, children }) => (
  <div className="dashboard-guide__method-statement">
    <strong>{label}</strong>
    <div>{children}</div>
  </div>
);

const GuideChapter = ({ id, number, title, ...parts }) => (
  <section id={id} data-testid="dashboard-guide-chapter">
    <h2>{number}. {title}</h2>
    {CHAPTER_PARTS.map(([key, label]) => (
      <React.Fragment key={key}>
        <h3>{label}</h3>
        {parts[key]}
      </React.Fragment>
    ))}
  </section>
);

const formatConfiguredTime = ({ hour, minute }) => {
  const suffix = hour >= 12 ? 'p' : 'a';
  const normalizedHour = hour % 12 || 12;
  return `${normalizedHour}:${String(minute).padStart(2, '0')}${suffix}`;
};

const marketSession = (market) => (
  `${formatConfiguredTime(market.marketOpen)}–${formatConfiguredTime(market.marketClose)}`
);

const rangeDescription = (seriesKey) => {
  const ranges = VOL_RANGES[seriesKey]?.ranges;
  if (!ranges) return 'No dashboard regime range is assigned.';
  return ranges
    .map((range) => {
      const boundary = range.max == null
        ? `≥${range.min}`
        : Number(range.min) === 0
          ? `<${range.max}`
          : `${range.min}–<${range.max}`;
      return `${range.label}: ${boundary}`;
    })
    .join(' · ');
};

const percent = (value) => `${(value * 100).toFixed(0)}%`;

const BreakpointRows = ({ points }) => points.map(([input, score]) => (
  <tr key={`${input}-${score}`}>
    <td>{percent(input)}</td>
    <td>{score}</td>
  </tr>
));

const DashboardGuide = () => (
  <>
    <header className="process-library-article__header">
      <h1>Dashboard Guide</h1>
      <p>Front-Page Math and Methodology · Version 0.1 · Draft · September 3, 2026</p>
    </header>

    <section id="start-here">
      <h2>Start Here</h2>
      <p>
        This guide explains what the front-page cards display, how their numbers are calculated, and where each
        input comes from. It is an operator manual, not a recommendation, forecast, or order system. Every worked
        number is illustrative and must not be read as a current quote.
      </p>

      <h3>The shared return convention</h3>
      <MethodStatement label="Dashboard formula">
        <p className="wp-equation"><code>percentage return = (current value ÷ reference value − 1) × 100</code></p>
        <p>
          DAY can use a current or delayed provider quote against the previous close. The 15D, 1M, 3M, 6M, and 1Y
          columns use dated historical observations from completed sessions. YTD uses the first available
          observation of the calendar year. A quote and its period returns can therefore have different timestamps.
        </p>
      </MethodStatement>

      <h3>Data-state legend</h3>
      <table className="wp-table wp-table--definitions" aria-label="Dashboard data-state legend">
        <thead><tr><th>State</th><th>Meaning</th><th>Permitted read</th></tr></thead>
        <tbody>
          <tr><th scope="row">Live</th><td>A provider-verified current observation passed its freshness gate.</td><td>Read with its provider timestamp.</td></tr>
          <tr><th scope="row">Delayed</th><td>A valid provider observation is intentionally delayed.</td><td>Reference only; the delay marker remains visible.</td></tr>
          <tr><th scope="row">Historical</th><td>A completed-session or dated reference observation.</td><td>Use only for the stated as-of date and window.</td></tr>
          <tr><th scope="row">Refresh delayed</th><td>A refresh failed after a previously verified dated observation.</td><td>Read only as explicitly dated history, never as live.</td></tr>
          <tr><th scope="row">Manual</th><td>A person entered the value; no provider calculation occurred.</td><td>Verify the edit time and source material.</td></tr>
          <tr><th scope="row">Partial</th><td>Some required series or rows are missing.</td><td>Use available rows only; do not infer the gaps.</td></tr>
          <tr><th scope="row">Unavailable</th><td>The required inputs did not pass validation or freshness checks.</td><td>Leave the value empty; do not substitute cached, seeded, or modeled data.</td></tr>
        </tbody>
      </table>

      <h3>Daily market strip</h3>
      <MethodStatement label="Dashboard formula">
        <p>
          Four fixed panels show breadth, winners and losers, sector leadership, and outliers in the existing
          strip. The S&amp;P 500 universe is represented by State Street’s published SPY equity holdings;
          separate share classes count separately. Advancing/declining counts, median return, and winners/losers
          require verified quotes for the complete roster. Moving-average and 52-week statistics use holdings with
          a complete history for that window; an asterisk identifies partial history coverage and its tooltip gives
          the exact eligible count and denominator. Missing current quotes never silently reduce the universe.
        </p>
      </MethodStatement>
      <MethodStatement label="Dashboard heuristic">
        <p>
          Sector leadership compares the eleven Select Sector SPDR ETFs. SPY lift and drag estimate each holding’s
          contribution in percentage points using its published ETF weight and daily return. These are ETF-weight
          estimates, not official S&amp;P index attribution. The holdings date and provider observation time remain
          available in the strip’s details.
        </p>
        <p>
          Relative volume compares completed regular-session intervals at the same session time. The 40-session
          gain comparison uses the same elapsed trading interval, with its cutoff disclosed in the reading.
          Open-to-now reversals compare the opening gap and the latest return with the previous close.
          Against-sector readings identify a stock moving in the opposite direction from its sector ETF.
          Every reading uses verified provider observations; failed or expired current data clears from the strip.
        </p>
      </MethodStatement>

      <h3>Global market clocks</h3>
      <table className="wp-table" aria-label="Configured global market sessions">
        <thead><tr><th>Clock</th><th>Timezone</th><th>Configured regular session</th></tr></thead>
        <tbody>
          {GLOBAL_MARKETS.map((market) => (
            <tr key={market.id}>
              <th scope="row">{market.code}</th>
              <td>{market.timezone}</td>
              <td>{marketSession(market)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <MethodStatement label="Dashboard heuristic">
        <p>
          The clocks convert the current time into configured local time and classify regular, pre-market,
          post-market, weekend, and maintained-holiday periods. They are schedule indicators—not exchange-status
          feeds. Hong Kong and Tokyo lunch breaks are intentionally omitted from the simplified display.
        </p>
      </MethodStatement>
    </section>

    <GuideChapter
      id="volatility"
      number="1"
      title="Volatility"
      what={(
        <>
          <p>
            The first card is a cross-asset risk-temperature map. Most rows are annualized, forward-looking option
            volatility; VVIX measures volatility of VIX, while MOVE uses a different interest-rate-volatility scale.
            Annualization expresses the option market&apos;s expected standard deviation on a one-year scale even when
            the index horizon is 30 calendar days; it does not turn the reading into a one-year forecast.
          </p>
          <table className="wp-table" aria-label="Volatility index definitions">
            <thead><tr><th>Row</th><th>What it measures</th><th>Official methodology</th></tr></thead>
            <tbody>
              {Object.entries(VOLATILITY_INDEX_DEFINITIONS).map(([key, definition]) => (
                <tr key={key}>
                  <th scope="row">{definition.symbol}{key === 'NazVol' ? ' / NazVol' : ''}</th>
                  <td>{definition.horizon}</td>
                  <td><a href={definition.sourceUrl} target="_blank" rel="noreferrer">{definition.sourceLabel}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      read={(
        <>
          <p>
            A higher reading means the relevant option market prices a wider distribution of possible moves; it
            does not predict direction. Percentage columns describe changes in the index level, not the underlying
            asset return. Compare each row with its own history and scale rather than comparing raw points across
            unlike indices.
          </p>
          <MethodStatement label="Dashboard heuristic">
            <p>
              For VIX-style percentage indices, a rough one-session standard deviation is
              <code> index ÷ √252</code>. This shortcut does not apply point-for-point to MOVE because ICE describes
              MOVE as a basket of option-implied U.S. yield volatilities.
            </p>
          </MethodStatement>
        </>
      )}
      example={(
        <>
          <p>
            A VIX level of 20 implies roughly <code>20 ÷ √252 ≈ 1.26%</code> for a one-standard-deviation daily move.
            If VIX rose from 18 to 20 over 15 completed sessions, the card would show
            <code> (20 ÷ 18 − 1) × 100 = +11.11%</code>. It would not mean the S&amp;P 500 rose 11.11%.
          </p>
          <p><em>Illustrative values only; they are not current market observations.</em></p>
        </>
      )}
      math={(
        <>
          <MethodStatement label="Official provider formula">
            <p className="wp-equation"><code>{VOLATILITY_INDEX_DEFINITIONS.VIX.formula}</code></p>
            <table className="wp-table wp-table--definitions" aria-label="VIX formula terms">
              <thead><tr><th>Term</th><th>Meaning</th></tr></thead>
              <tbody>
                <tr><th scope="row"><code>T</code></th><td>Time to expiration in years.</td></tr>
                <tr><th scope="row"><code>R</code></th><td>Risk-free rate to expiration.</td></tr>
                <tr><th scope="row"><code>F</code></th><td>Forward index level derived from option prices.</td></tr>
                <tr><th scope="row"><code>K₀</code></th><td>First strike at or below the forward level.</td></tr>
                <tr><th scope="row"><code>K, ΔK</code></th><td>Option strike and the interval between neighboring strikes.</td></tr>
                <tr><th scope="row"><code>Q(K)</code></th><td>Mid-quote for the qualifying out-of-the-money option at strike K.</td></tr>
              </tbody>
            </table>
          </MethodStatement>
          <MethodStatement label="Dashboard formula">
            <p>
              Card changes use <code>(latest completed close ÷ reference close − 1) × 100</code>. References are the
              prior session (1D), 15 sessions (15D), 21 sessions (1M), 63 sessions (3M), 126 sessions (6M), and the
              prior calendar-year close (YTD).
            </p>
          </MethodStatement>
          <table className="wp-table" aria-label="Implemented volatility regime ranges">
            <thead><tr><th>Series</th><th>Implemented display ranges</th><th>Authority</th></tr></thead>
            <tbody>
              {Object.keys(VOLATILITY_INDEX_DEFINITIONS).map((key) => (
                <tr key={key}>
                  <th scope="row">{VOLATILITY_INDEX_DEFINITIONS[key].symbol}</th>
                  <td>{rangeDescription(key)}</td>
                  <td>Dashboard heuristic</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      inputs={(
        <p>
          VIX, VVIX, RVX, VXN, GVZ, OVX, and BITVX use attributed Cboe observations and completed histories. MOVE is
          a dated end-of-day reference in this dashboard. Each row carries its own provider, quote mode, as-of time,
          freshness, and historical-return date; one fresh row does not make the entire card fresh.
        </p>
      )}
      hedgeye={(
        <MethodStatement label="Hedgeye public concept">
          <p>
            Hedgeye describes price, volume, and volatility as distinct Process inputs and publicly frames VIX
            around 9–19, 20–29, and 29-plus environments. See the
            {' '}<a href={HEDGEYE_PROCESS_URL} target="_blank" rel="noreferrer">Hedgeye Process Guide</a>. The public
            guide does not publish the dashboard&apos;s non-VIX thresholds.
          </p>
        </MethodStatement>
      )}
      dashboard={(
        <MethodStatement label="Dashboard heuristic">
          <p>
            The implemented VIX buckets are &lt;20, 20–&lt;29, and ≥29; the code therefore simplifies the public
            framing&apos;s lower bound. RVX/VXN/GVZ use &lt;24, 24–&lt;36, ≥36; OVX uses &lt;40, 40–&lt;55, ≥55; MOVE uses
            &lt;100, 100–&lt;120, ≥120; and VVIX uses &lt;95, 95–&lt;115, ≥115. BITVX has no assigned regime range. These
            colors are context, not provider-defined signals or an execution instruction.
          </p>
        </MethodStatement>
      )}
      failure={(
        <p>
          Loading shows no value until validation completes. Delayed and historical observations remain explicitly
          marked. A failed refresh can retain only a labeled, last-verified dated reference. Missing, stale without a
          permitted dated-reference state, malformed, or unattributed values remain unavailable and are never filled
          from another volatility series.
        </p>
      )}
    />

    <GuideChapter
      id="usd"
      number="2"
      title="USD"
      what={(
        <p>
          The USD card combines G5 FX volatility, a verified high-impact events calendar, USD-first currency quotes,
          DXY/UUP dollar benchmarks, and DXY correlations with equities, commodities, gold, and Bitcoin. Each block
          has separate provenance and can have a different as-of time.
        </p>
      )}
      read={(
        <>
          <p>
            In <strong>USD/AUD</strong>, USD is the base currency and AUD is the quote currency. A price of 1.500
            means one U.S. dollar buys 1.500 Australian dollars. A positive return means USD strengthened against
            AUD over that window; a negative return means USD weakened against AUD.
          </p>
          <p>
            DXY is the U.S. Dollar Index level; UUP is an exchange-traded dollar proxy and can differ because it is
            a fund rather than the index. FXVL is CME&apos;s G5 option-implied volatility index. When that source is not
            available, the card labels its separate Yahoo-based G5 realized-volatility fallback as G5RV.
          </p>
          <p>
            Correlation ranges from −1 to +1. Positive means DXY and the other price level tended to move together;
            negative means they tended to move oppositely. It measures association, not causation or expected return.
          </p>
        </>
      )}
      example={(
        <>
          <p className="wp-equation"><code>1.500 × (1 − 0.0203) = 1.46955 AUD per USD</code></p>
          <p>
            An illustrative USD/AUD 15D reading of −2.03% means one USD buys 2.03% fewer AUD than at the reference
            close, so USD weakened relative to AUD. The fact that the numerical quote remains above 1 does not mean
            USD is economically “above” AUD; the number only reflects the chosen units.
          </p>
          <p><em>Illustrative values only; they are not current market observations.</em></p>
        </>
      )}
      math={(
        <>
          <MethodStatement label="Dashboard formula">
            <p className="wp-equation"><code>USD-first price Pᵢ = 1 ÷ source price P</code></p>
            <p className="wp-equation"><code>inverted return rᵢ = 1 ÷ (1 + r) − 1</code></p>
            <p>
              The reciprocal return—not merely a sign flip—is required when a source pair such as AUD/USD is
              displayed as USD/AUD.
            </p>
          </MethodStatement>
          <MethodStatement label="Dashboard formula">
            <p className="wp-equation">
              <code>ρ = Σ(x − x̄)(y − ȳ) ÷ √[Σ(x − x̄)² × Σ(y − ȳ)²]</code>
            </p>
            <p>
              DXY and each metric are aligned by date and Pearson correlation is calculated on closing price levels,
              not returns, for {CORRELATION_PERIODS.map(({ label }) => label).join(', ')}. Rolling statistics use a
              {` ${ROLLING_WINDOW}-session`} correlation and retain the latest {ROLLING_SAMPLE_COUNT} results, which
              requires {REQUIRED_ROLLING_OBSERVATIONS} aligned closing observations.
            </p>
          </MethodStatement>
          <MethodStatement label="Dashboard formula">
            <p className="wp-equation">
              <code>pair realized vol = sample SD[ln(Pₜ ÷ Pₜ₋₁)] × √252 × 100</code>
            </p>
            <p>
              The G5RV fallback computes that formula from 21 completed returns for EURUSD, GBPUSD, USDJPY,
              AUDUSD, and USDCAD, aligns the five series by date, and takes their arithmetic mean. Its display
              ranges are {rangeDescription('G5RV')}; every range is a dashboard heuristic, not a CME or Hedgeye
              signal. A verified FXVL row uses the provider-supplied CME level instead of this fallback calculation.
            </p>
          </MethodStatement>
        </>
      )}
      inputs={(
        <table className="wp-table" aria-label="USD card inputs and cadence">
          <thead><tr><th>Block</th><th>Input and cadence</th></tr></thead>
          <tbody>
            <tr><th scope="row">FX volatility</th><td>Attributed CME FXVL or Yahoo G5 21-session annualized realized volatility, with its own as-of state.</td></tr>
            <tr><th scope="row">Market events</th><td>Current verified Forex Factory snapshot, rendered in Eastern Time; stale or uncovered calendars are unavailable.</td></tr>
            <tr><th scope="row">Currencies</th><td>Provider quote for DAY plus completed daily histories for period returns.</td></tr>
            <tr><th scope="row">Correlations</th><td>Aligned completed Yahoo daily closing levels, calculated no later than the common required-series date.</td></tr>
          </tbody>
        </table>
      )}
      hedgeye={(
        <MethodStatement label="Hedgeye public concept">
          <p>
            The public Process treats the dollar and cross-asset relationships as contextual inputs. The
            {' '}<a href={HEDGEYE_RISK_RANGE_URL} target="_blank" rel="noreferrer">Risk Range Guide</a> uses the
            standard base/quote convention: the first currency strengthens when the pair rises. It does not publish
            the dashboard&apos;s price-level correlation engine.
          </p>
        </MethodStatement>
      )}
      dashboard={(
        <MethodStatement label="Dashboard heuristic">
          <p>
            The heat map classifies the displayed two-decimal correlation: absolute values ≤
            {USD_CORRELATION_HEATMAP_THRESHOLDS.neutralMagnitudeMax.toFixed(2)} are neutral, values above that
            boundary are colored by sign, and values ≥
            {USD_CORRELATION_HEATMAP_THRESHOLDS.strongMagnitudeMin.toFixed(2)} are strong. Percent-positive counts
            rolling correlations equal to zero as non-negative. These presentation bands are not Hedgeye signals.
          </p>
        </MethodStatement>
      )}
      failure={(
        <p>
          Invalid reciprocal prices, missing period-return provenance, zero-variance series, fewer than
          {` ${REQUIRED_ROLLING_OBSERVATIONS} aligned closes`}, or required histories more than
          {` ${USD_CORRELATION_MAX_STALE_DAYS} calendar days stale`} leave the affected output unavailable. Missing
          optional Silver history does not invalidate required DXY correlations. Calendar data disappears rather
          than falling back to an old week.
        </p>
      )}
    />

    <GuideChapter
      id="market-backdrop"
      number="3"
      title="Market Backdrop"
      what={(
        <p>
          Market Backdrop is a common spreadsheet view of U.S., European, and Asian equities, commodities, rates,
          credit spreads, and crypto. It lets the operator compare direction and magnitude across standard windows
          without implying that unlike assets share the same units or source timestamp.
        </p>
      )}
      read={(
        <p>
          Price is the latest permitted provider observation. DAY is the provider&apos;s daily change. The remaining
          columns are historical comparisons. Treasury and Bund rows are yields, curve and spread rows are basis
          points, and most other rows are index or asset-price levels.
        </p>
      )}
      example={(
        <p>
          If the 10-year yield is 4.25% and the 2-year yield is 4.00%, the 2s10s curve is
          <code> (4.25 − 4.00) × 100 = +25 bps</code>. If it moves from +15 bps to +25 bps, the displayed historical
          change is +10 bps—not +66.67%.
        </p>
      )}
      math={(
        <MethodStatement label="Dashboard formula">
          <p>
            Prices use <code>(current ÷ reference − 1) × 100</code>. Yield-curve level uses
            <code> (long yield − short yield) × 100</code> basis points, and historical curve changes subtract the
            aligned prior spread from the current spread. Calendar returns use the first valid observation in the
            relevant month, quarter, or year.
          </p>
        </MethodStatement>
      )}
      inputs={(
        <p>
          Each row combines its current quote status with a separately dated historical-return series. The card
          aggregates coverage, provider counts, and the oldest displayed source date; these card-level diagnostics
          never upgrade a missing row to available.
        </p>
      )}
      hedgeye={(
        <MethodStatement label="Hedgeye public concept">
          <p>
            The public Process emphasizes reading cross-asset price, volume, and volatility together. This card is
            the dashboard&apos;s consolidated observation layer; Hedgeye does not publish this table&apos;s return engine or
            asset grouping as a proprietary formula.
          </p>
        </MethodStatement>
      )}
      dashboard={(
        <MethodStatement label="Dashboard heuristic">
          <p>
            Positive price returns are normally green and negative returns red. IG and HY option-adjusted spreads
            invert that performance tone because wider spreads usually indicate worsening credit conditions. The
            inversion affects color interpretation only; it does not change the reported basis-point value.
          </p>
        </MethodStatement>
      )}
      failure={(
        <p>
          A row without a verified quote is blank even when another provider or a prior value exists. Period columns
          remain blank unless the response explicitly identifies them as historical and supplies an as-of date.
          Partial card coverage is disclosed by row and in the status diagnostics.
        </p>
      )}
    />

    <GuideChapter
      id="cftc-positioning"
      number="4"
      title="CFTC Positioning"
      what={(
        <p>
          The card summarizes weekly Commitments of Traders positioning across selected futures markets. It shows the
          latest net position, the change from the prior report, 3M/6M/1Y averages, 3Y extremes, and 1Y/3Y z-scores.
        </p>
      )}
      read={(
        <p>
          Positive net means the selected trader category reports more long than short contracts; negative means
          more short than long. A positive z-score is above that market&apos;s own historical mean. It is not directly
          comparable in contract size across instruments and is informational rather than an execution signal.
        </p>
      )}
      example={(
        <p>
          If non-commercial longs are 420,000 contracts and shorts are 350,000, net is +70,000. If the prior report
          was +55,000, week-over-week change is +15,000. With a 52-observation mean of +30,000 and sample standard
          deviation of 20,000, <code>z = (70,000 − 30,000) ÷ 20,000 = +2.00</code>.
        </p>
      )}
      math={(
        <>
          <MethodStatement label="Dashboard formula">
            <p className="wp-equation"><code>net position = reportable long contracts − reportable short contracts</code></p>
            <p>The subtraction uses the official long and short fields published in the applicable CFTC report.</p>
          </MethodStatement>
          <MethodStatement label="Dashboard formula">
            <p className="wp-equation"><code>weekly change = current net − prior-report net</code></p>
            <p className="wp-equation"><code>z = (current net − sample mean) ÷ sample standard deviation</code></p>
            <p>
              The 1Y and 3Y samples require 52 and 156 consecutive reporting observations, respectively. The current observation is
              included and standard deviation uses the <code>n − 1</code> sample denominator.
              The table shows 3M, 6M, and 1Y averages over 13, 26, and 52 observations, and the maximum and minimum
              over 156 observations. Calculations retain their precision; rounding applies only to display.
            </p>
          </MethodStatement>
        </>
      )}
      inputs={(
        <p>
          The weekly ingest uses CFTC Combined futures-and-options records. Most rows use
          <a href={CFTC_LEGACY_URL} target="_blank" rel="noreferrer"> Legacy All</a> non-commercial positions, including Silver.
          Gold uses <a href={CFTC_DISAGGREGATED_URL} target="_blank" rel="noreferrer"> Disaggregated All</a>
          managed-money positions. Silver&apos;s managed-money series is retained separately in its details.
          Each row identifies its trader group and links its official source. SPX uses code 13874A as a required integrity check.
        </p>
      )}
      hedgeye={(
        <MethodStatement label="Hedgeye public concept">
          <p>
            Hedgeye publicly discusses CFTC positioning as consensus and contrarian context. The official CFTC
            reports remain the data authority; the dashboard&apos;s instrument mapping, windows, and completeness gates
            are local implementation choices.
          </p>
        </MethodStatement>
      )}
      dashboard={(
        <MethodStatement label="Dashboard formula">
          <p>
            Main-table trader groups match the verified Macro Show comparison: Gold uses managed money; the other active rows
            use Legacy non-commercial traders. Silver&apos;s prediction-market monitor continues to select its separate managed-money series.
            Eurodollar is retained only as a discontinued historical reference dated June 13, 2023 and is not
            decision-eligible. The position date remains separate from retrieval time and the show date.
            Color describes positioning, not a buy recommendation. No missing weekly position is filled from price action or another contract.
          </p>
        </MethodStatement>
      )}
      failure={(
        <p>
          The ingest does not publish when the official required SPX row is missing or invalid, or when the latest
          required report is more than {CFTC_STALE_AFTER_DAYS} days old. Missing secondary markets are labeled partial or unavailable.
          Missing reporting observations leave the affected weekly change or statistic empty; official holiday shifts are allowed.
          Insufficient history leaves the relevant statistic empty rather than shortening the declared window silently.
        </p>
      )}
    />

    <GuideChapter
      id="global-quads"
      number="5"
      title="Global Quads"
      what={(
        <p>
          Global Quads organizes countries and quarters by the direction of change in growth and inflation. Actual
          and estimated quarters retain their published labels in the G20, emerging-market, and Global Macro Risk Monitor tables.
        </p>
      )}
      read={(
        <table className="wp-table" aria-label="Global Quad definitions">
          <thead><tr><th>Quad</th><th>Growth rate of change</th><th>Inflation rate of change</th><th>Common description</th></tr></thead>
          <tbody>
            <tr><th scope="row">1</th><td>Accelerating</td><td>Decelerating</td><td>Goldilocks</td></tr>
            <tr><th scope="row">2</th><td>Accelerating</td><td>Accelerating</td><td>Reflation</td></tr>
            <tr><th scope="row">3</th><td>Decelerating</td><td>Accelerating</td><td>Stagflation</td></tr>
            <tr><th scope="row">4</th><td>Decelerating</td><td>Decelerating</td><td>Deflation</td></tr>
          </tbody>
        </table>
      )}
      example={(
        <p>
          Suppose a country&apos;s growth rate of change is slowing while its inflation rate of change is rising. The
          conceptual classification is Quad 3. The grid records Hedgeye’s published classification; the
          dashboard does not derive it from GDP or CPI observations.
        </p>
      )}
      math={(
        <MethodStatement label="Published research">
          <p>
            Reviewed screenshots supply the published integers from 1 through 4 and explicit missing values.
            MODE / MEDIAN and MODE / MEAN rows are also published readings: the dashboard does not calculate aggregates or break ties.
          </p>
        </MethodStatement>
      )}
      inputs={(
        <p>
          Published tables are archived with their original screenshots and printed dates. Select the Global Quads title to open the tables and source charts.
          “E” denotes a published estimate; it does not become an actual when the quarter passes.
        </p>
      )}
      hedgeye={(
        <MethodStatement label="Hedgeye public concept">
          <p>
            Hedgeye&apos;s public Process maps the rate of change of growth and inflation into four Quad environments.
            The proprietary forecast construction behind published country assignments is not disclosed here and is
            not reverse-engineered. The dashboard displays sourced, dated research references.
          </p>
        </MethodStatement>
      )}
      dashboard={(
        <MethodStatement label="Reviewed screenshots">
          <p>
            Share a new table screenshot for an occasional reviewed update to both views.
            Color follows the sourced digit. The Quad overlay remains descriptive in the current Process registry;
            it has no approved authority to size or authorize a position.
          </p>
        </MethodStatement>
      )}
      failure={(
        <p>
          Missing cells mean no verified published value is available. Uncertain OCR and conflicting revisions are held.
          Previously verified tables retain their source dates, while extraction issues appear separately in Systems.
        </p>
      )}
    />

    <GuideChapter
      id="dollar-liquidity"
      number="6"
      title="Dollar Liquidity"
      what={(
        <p>
          The card contains two distinct monthly models: a global G4-plus-China M2/GDP risk model and a U.S. dollar
          liquidity stack. Both describe monetary-liquidity conditions; neither is a live cash balance or a trade
          instruction.
        </p>
      )}
      read={(
        <p>
          Lower global risk scores are more supportive and higher scores indicate greater liquidity risk. Read the
          score beside M2 growth, the M2-versus-GDP growth gap, M2/GDP, source coverage, and the as-of month. For the
          U.S. stack, read growth, acceleration, stack/GDP, and components together rather than using one label alone.
        </p>
      )}
      example={(
        <p>
          If a liquidity series rises from 100 to 102 over three months, annualized growth is
          <code> (102 ÷ 100)^(12 ÷ 3) − 1 ≈ 8.24%</code>. If nominal GDP annualized growth is 5.00%, the growth gap is
          <code> 8.24% − 5.00% = +3.24 percentage points</code>. This example does not reproduce a current model row.
        </p>
      )}
      math={(
        <>
          <MethodStatement label="Dashboard formula">
            <p className="wp-equation"><code>country M2 in USD = local-currency M2 × monthly USD conversion</code></p>
            <p className="wp-equation"><code>global M2/GDP = Σ country M2 in USD ÷ Σ country nominal GDP in USD</code></p>
            <p className="wp-equation"><code>annualized growth = (current ÷ prior)^(12 ÷ months) − 1</code></p>
            <p className="wp-equation"><code>growth gap = annualized M2 growth − annualized nominal-GDP growth</code></p>
          </MethodStatement>
          <table className="wp-table" aria-label="Global liquidity score weights">
            <thead><tr><th>Risk component</th><th>Weight</th></tr></thead>
            <tbody>
              {Object.entries(GLOBAL_LIQUIDITY_WEIGHTS).map(([key, weight]) => (
                <tr key={key}><th scope="row">{key.replace(/_/g, ' ')}</th><td>{percent(weight)}</td></tr>
              ))}
            </tbody>
          </table>
          <p>
            M2/GDP pressure is itself weighted {percent(GLOBAL_LIQUIDITY_RATIO_PRESSURE_WEIGHTS.level)} level,
            {` ${percent(GLOBAL_LIQUIDITY_RATIO_PRESSURE_WEIGHTS.trend3m)} 3-month trend, and `}
            {percent(GLOBAL_LIQUIDITY_RATIO_PRESSURE_WEIGHTS.trend6m)} 6-month trend. The weighted average
            renormalizes across finite components.
          </p>
          <div className="dashboard-guide__breakpoint-grid">
            {Object.entries(GLOBAL_LIQUIDITY_SCORE_BREAKPOINTS).map(([key, points]) => (
              <table className="wp-table" aria-label={`${key} liquidity-risk breakpoints`} key={key}>
                <thead><tr><th>{key}</th><th>Risk score</th></tr></thead>
                <tbody><BreakpointRows points={points} /></tbody>
              </table>
            ))}
          </div>
          <p>
            Values between breakpoints are linearly interpolated and values outside the table are capped at the
            endpoint score. Global regimes are supportive below
            {` ${GLOBAL_LIQUIDITY_REGIME_THRESHOLDS.supportiveBelow}`}, neutral/caution below
            {` ${GLOBAL_LIQUIDITY_REGIME_THRESHOLDS.neutralCautionBelow}`}, yellow risk below
            {` ${GLOBAL_LIQUIDITY_REGIME_THRESHOLDS.yellowRiskBelow}`}, and red risk at or above it.
          </p>
        </>
      )}
      inputs={(
        <p>
          The global model combines monthly U.S., Eurozone, Japan, U.K., and China M2, nominal GDP, and monthly FX.
          FRED supplies the configured public series where available; reviewed local CSVs supply the remaining GDP
          and money histories. GDP is lagged {DEFAULT_GDP_LAG_MONTHS} month with no lookahead and then forward-filled
          until a later observation becomes eligible. See <a href={FRED_URL} target="_blank" rel="noreferrer">FRED</a>.
        </p>
      )}
      hedgeye={(
        <MethodStatement label="Hedgeye public concept">
          <p>
            Liquidity is read as macro context alongside growth, inflation, price, volume, and volatility. The global
            risk score, its piecewise curves, and the U.S. stack rules are local dashboard models—not published
            Hedgeye formulas.
          </p>
        </MethodStatement>
      )}
      dashboard={(
        <MethodStatement label="Dashboard formula">
          <p>
            The U.S. stack adds bank deposits, retail money-market funds, derived institutional money-market funds,
            and currency in circulation. Institutional MMF equals total MMF minus retail MMF and cannot be negative;
            total MMF is excluded from the final sum to prevent double counting. Acceleration compares short and long
            annualized rates with a {(US_LIQUIDITY_ACCELERATION_TOLERANCE * 100).toFixed(2)}% tolerance. Red means 3M or 6M
            growth is negative; green requires stack/GDP ≥{US_LIQUIDITY_GREEN_STACK_TO_GDP.toFixed(2)} and positive
            3M, 6M, and 12M growth; all other complete cases are yellow.
          </p>
        </MethodStatement>
      )}
      failure={(
        <p>
          Missing required country inputs make the global latest row partial or unavailable; they are not replaced
          with another country. Missing U.S. GDP or a required stack component makes that model unavailable. Derived
          negatives fail validation. Provisional components remain labeled, and a dated monthly value is never
          described as a live market quote.
        </p>
      )}
    />

    <GuideChapter
      id="volume"
      number="7"
      title="Volume"
      what={(
        <p>
          The card compares current total U.S. market volume and exchange volume with the prior session and trailing
          averages. It is a dated market-structure snapshot, not order-book depth or a live executable-volume feed.
        </p>
      )}
      read={(
        <p>
          Total Market includes the configured consolidated exchange plus off-exchange universe. Tape A+B+C or Total
          Exchange represents listed U.S. exchange volume. Off-exchange volume is the TRF portion in the Cboe
          fallback. Positive comparison percentages mean the current session exceeded the baseline; negative means
          it fell below it.
        </p>
      )}
      example={(
        <p>
          If current total volume is 12.0 billion shares and the prior 21-session average is 10.0 billion,
          <code> (12.0 − 10.0) ÷ 10.0 × 100 = +20%</code>. The 10.0-billion average excludes the current 12.0-billion
          observation. Values displayed by the card are rounded to whole percentages.
        </p>
      )}
      math={(
        <MethodStatement label="Dashboard formula">
          <p className="wp-equation"><code>% difference = (current volume − baseline volume) ÷ baseline volume × 100</code></p>
          <table className="wp-table" aria-label="Volume comparison windows">
            <thead><tr><th>Comparison</th><th>Baseline</th></tr></thead>
            <tbody>
              <tr><th scope="row">Prior day</th><td>{DEFAULT_COMPARISON_WINDOWS.priorDay} prior completed session</td></tr>
              <tr><th scope="row">1M average</th><td>{DEFAULT_COMPARISON_WINDOWS.avg1M} prior completed sessions</td></tr>
              <tr><th scope="row">3M average</th><td>{DEFAULT_COMPARISON_WINDOWS.avg3M} prior completed sessions</td></tr>
              <tr><th scope="row">1Y average</th><td>{DEFAULT_COMPARISON_WINDOWS.avg1Y} prior completed sessions</td></tr>
            </tbody>
          </table>
          <p>All average windows exclude the current observation. A zero or missing baseline produces no percentage.</p>
        </MethodStatement>
      )}
      inputs={(
        <p>
          The preferred response is an extracted Hedgeye volume-slide snapshot whose displayed percentages are
          already calculated and carry slide, upload, and trading dates. The fallback aggregates
          <a href={CBOE_VOLUME_URL} target="_blank" rel="noreferrer"> Cboe Historical Market Volume</a>: all
          participant shares form Total Market, non-TRF participants form Exchange, and TRF participants form
          off-exchange volume.
        </p>
      )}
      hedgeye={(
        <MethodStatement label="Hedgeye public concept">
          <p>
            Volume is one of the Process&apos;s price-volume-volatility inputs. Hedgeye slide footnotes attribute Total
            Market Volume to total U.S. exchange plus OTC/OTCBB securities calculated by Bloomberg and Tape A+B+C to
            U.S. exchange volume. The dashboard preserves those footnotes when the extracted slide is the source.
          </p>
        </MethodStatement>
      )}
      dashboard={(
        <MethodStatement label="Dashboard heuristic">
          <p>
            The Cboe fallback is a separately labeled, dated methodology and is not represented as the Bloomberg
            calculation. Calibration against retained Hedgeye benchmarks can be marked provisional. Source type,
            methodology version, as-of trading date, and calibration status remain visible with the card. The
            fallback averages all available prior observations up to each 21/63/252-session cap; it does not require
            a full window. A newly started series can therefore show a shorter, provisional baseline that must be
            read with its coverage metadata.
          </p>
        </MethodStatement>
      )}
      failure={(
        <p>
          Fewer than two observations, a missing source date, stale data, or an invalid baseline leaves comparisons
          unavailable. A refresh failure may show only an explicitly dated prior snapshot with a refresh-delayed
          warning. The card never converts a prior snapshot into a live volume observation.
        </p>
      )}
    />

    <section id="reference">
      <h2>Reference</h2>
      <h3>Formula index</h3>
      <table className="wp-table" aria-label="Dashboard formula index">
        <thead><tr><th>Measure</th><th>Formula or rule</th><th>Authority</th></tr></thead>
        <tbody>
          <tr><th scope="row">Price return</th><td><code>(current ÷ reference − 1) × 100</code></td><td>Dashboard formula</td></tr>
          <tr><th scope="row">Inverted FX return</th><td><code>1 ÷ (1 + r) − 1</code></td><td>Dashboard formula</td></tr>
          <tr><th scope="row">Pearson correlation</th><td><code>covariance ÷ √(variance x × variance y)</code> on aligned price levels</td><td>Dashboard formula</td></tr>
          <tr><th scope="row">CFTC net</th><td><code>long − short</code> using official report fields</td><td>Dashboard formula</td></tr>
          <tr><th scope="row">CFTC z-score</th><td><code>(current − sample mean) ÷ sample SD</code></td><td>Dashboard formula</td></tr>
          <tr><th scope="row">Curve</th><td><code>(long yield − short yield) × 100</code> basis points</td><td>Dashboard formula</td></tr>
          <tr><th scope="row">Annualized liquidity growth</th><td><code>(current ÷ prior)^(12 ÷ months) − 1</code></td><td>Dashboard formula</td></tr>
          <tr><th scope="row">Volume difference</th><td><code>(current − baseline) ÷ baseline × 100</code></td><td>Dashboard formula</td></tr>
        </tbody>
      </table>

      <h3>Period and window glossary</h3>
      <table className="wp-table wp-table--definitions" aria-label="Dashboard period glossary">
        <thead><tr><th>Label</th><th>Default interpretation</th></tr></thead>
        <tbody>
          <tr><th scope="row">DAY / 1D</th><td>Current provider daily change or one completed-session comparison, as labeled.</td></tr>
          <tr><th scope="row">15D</th><td>Fifteen completed trading sessions.</td></tr>
          <tr><th scope="row">1M</th><td>Twenty-one completed trading sessions unless the field explicitly says calendar month.</td></tr>
          <tr><th scope="row">3M</th><td>Sixty-three completed trading sessions.</td></tr>
          <tr><th scope="row">6M</th><td>One hundred twenty-six completed trading sessions.</td></tr>
          <tr><th scope="row">YTD</th><td>Comparison with the first valid observation of the calendar year or prior-year close, as documented by the card.</td></tr>
          <tr><th scope="row">1Y</th><td>Two hundred fifty-two completed sessions or the nearest permitted one-year reference observation.</td></tr>
        </tbody>
      </table>

      <h3>Sources and cadence</h3>
      <table className="wp-table" aria-label="Dashboard source and cadence matrix">
        <thead><tr><th>Surface</th><th>Primary authority</th><th>Cadence</th></tr></thead>
        <tbody>
          <tr><th scope="row">Daily market strip</th><td>State Street SPY/sector holdings and verified Yahoo quotes and history</td><td>Five-minute collection; fixed display; completed 30-minute intervals for same-time outliers</td></tr>
          <tr><th scope="row">Market clocks</th><td>Configured timezone and session calendar</td><td>Local clock updates each minute</td></tr>
          <tr><th scope="row">Volatility</th><td>Cboe methodologies and ICE MOVE description</td><td>Provider snapshot plus completed-session history</td></tr>
          <tr><th scope="row">USD / Backdrop</th><td>Attributed quotes and completed daily histories</td><td>Per-source quote and historical cadence</td></tr>
          <tr><th scope="row">CFTC</th><td>Official CFTC Combined reports</td><td>Weekly</td></tr>
          <tr><th scope="row">Global Quads</th><td>Reviewed Hedgeye table screenshots</td><td>On screenshot update</td></tr>
          <tr><th scope="row">Dollar Liquidity</th><td>FRED and reviewed local macro histories</td><td>Monthly model</td></tr>
          <tr><th scope="row">Volume</th><td>Extracted Hedgeye/Bloomberg snapshot or labeled Cboe fallback</td><td>Completed trading-day snapshot</td></tr>
        </tbody>
      </table>

      <h3>Methodology provenance</h3>
      <ul className="dashboard-guide__provenance-list">
        {METHODOLOGY_LABELS.map((label) => (
          <li key={label}><strong>{label}</strong></li>
        ))}
      </ul>
      <p>
        Hedgeye references in this guide are paraphrases of public education material. Proprietary or unpublished
        mechanisms are identified as undisclosed rather than reconstructed. Official provider formulas retain their
        provider attribution. All local thresholds, transformations, and scoring rules are labeled as dashboard
        formulas or heuristics.
      </p>
      <p>
        Public conceptual references: <a href={HEDGEYE_PROCESS_URL} target="_blank" rel="noreferrer">Hedgeye Process Guide</a>
        {' '}and <a href={HEDGEYE_RISK_RANGE_URL} target="_blank" rel="noreferrer">Hedgeye Risk Range Guide</a>.
      </p>
    </section>
  </>
);

export default DashboardGuide;
