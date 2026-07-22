import React from 'react';
import {
  SIZING_CONSTANTS,
  calculateSizingDecision,
} from '../../utils/signalWeightedPositionSizing';
import { getProcessDocument } from '../../constants/processDocuments';

export const POSITION_SIZING_SECTIONS = [
  ['abstract', 'Abstract'],
  ['position-sizing', 'Position sizing'],
  ['data-requirements', 'Data requirements'],
  ['position-boundaries', 'Position-size boundaries'],
  ['target-position', 'Target position'],
  ['position-lifecycle', 'Position lifecycle'],
  ['worked-examples', 'Worked examples'],
  ['validation', 'Validation and limitations'],
];

const LONG_INPUT = Object.freeze({
  bias: 'LONG',
  beta: { value: 1.25, observations: 252, source: 'adjusted daily returns', asOf: '2026-07-17' },
  atr14: { value: 1, observations: 14, source: 'completed daily bars', asOf: '2026-07-17' },
  spot: 104,
  lrr: 100,
  hrr: 120,
  tradeSignal: 'LONG',
  trendSignal: 'LONG',
  priorAth: 119,
  priorAtl: 91,
  riskRangeHistory: [
    { date: '2026-07-13', hrr: 116, lrr: 97 },
    { date: '2026-07-14', hrr: 117, lrr: 97 },
    { date: '2026-07-15', hrr: 118, lrr: 98 },
    { date: '2026-07-16', hrr: 119, lrr: 99 },
    { date: '2026-07-17', hrr: 120, lrr: 100 },
  ],
  provenance: {
    signals: {
      trade: { source: 'published tracker', asOf: '2026-07-17' },
      trend: { source: 'published risk range', asOf: '2026-07-17' },
    },
    range: { source: 'published risk range', asOf: '2026-07-17', observations: 5 },
    records: { source: 'adjusted daily history', asOf: '2026-07-16', observations: 252 },
  },
});

const SHORT_INPUT = Object.freeze({
  bias: 'SHORT',
  beta: { value: 1.8, observations: 252, source: 'adjusted daily returns', asOf: '2026-07-17' },
  atr14: { value: 0.25, observations: 14, source: 'completed daily bars', asOf: '2026-07-17' },
  spot: 58,
  lrr: 50,
  hrr: 60,
  tradeSignal: 'SHORT',
  trendSignal: 'SHORT',
  priorAth: 66,
  priorAtl: 49,
  riskRangeHistory: [
    { date: '2026-07-13', hrr: 64, lrr: 54 },
    { date: '2026-07-14', hrr: 63, lrr: 54 },
    { date: '2026-07-15', hrr: 63, lrr: 53 },
    { date: '2026-07-16', hrr: 62, lrr: 52 },
    { date: '2026-07-17', hrr: 60, lrr: 50 },
  ],
  provenance: {
    signals: {
      trade: { source: 'published tracker', asOf: '2026-07-17' },
      trend: { source: 'published risk range', asOf: '2026-07-17' },
    },
    range: { source: 'published risk range', asOf: '2026-07-17', observations: 5 },
    records: { source: 'adjusted daily history', asOf: '2026-07-16', observations: 252 },
  },
});

export const POSITION_SIZING_EXAMPLES = Object.freeze({
  long: calculateSizingDecision(LONG_INPUT),
  short: calculateSizingDecision(SHORT_INPUT),
});

const percent = (value, digits = 1) => `${Number(value).toFixed(digits)}%`;
const coefficientPercent = (value) => `${Number(value * 100).toFixed(0)}%`;
const decimal = (value, digits = 2) => Number(value).toFixed(digits);
const NOTE_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const formatAsOf = (date) => {
  const [year, month, day] = String(date || '').split('-').map(Number);
  return year && month && day ? `${day} ${NOTE_MONTHS[month - 1]} ${year}` : String(date || '');
};

const Equation = ({ number, children }) => (
  <div className="wp-equation" role="math" aria-label={`${children}. Equation ${number}.`}>
    <code>{children}</code>
    <span>({number})</span>
  </div>
);

const PositionSizingNote = ({ document }) => {
  const metadata = document || getProcessDocument('position-sizing');
  const long = POSITION_SIZING_EXAMPLES.long;
  const short = POSITION_SIZING_EXAMPLES.short;
  const c = SIZING_CONSTANTS;

  return (
    <>
      <header className="wp-paper__title">
        <p className="wp-paper__series">{metadata.subtitle}</p>
        <h1 id="position-sizing-title">{metadata.title}</h1>
        <p>Security-level allocation boundaries, targets, and lifecycle rules</p>
        <p className="wp-paper__version">
          Version {metadata.version}&nbsp;&nbsp;|&nbsp;&nbsp;{metadata.status}&nbsp;&nbsp;|&nbsp;&nbsp;{formatAsOf(metadata.asOf)}
        </p>
      </header>

      <section id="abstract" className="wp-abstract" data-testid="process-section">
        <p>
          <strong>Abstract.</strong> This note specifies a deterministic method for setting a security-level
          position weight. A 252-session beta against SPY establishes an initial minimum and maximum, and an ATR
          constraint may reduce the maximum. When Trade and Trend are aligned, range location, risk-range structure,
          and extension beyond a prior all-time high or low determine a target inside the interval. New positions
          open at MIN. If Trend breaks while Trade remains aligned, MIN becomes the ceiling for an existing position.
          If Trade breaks, the position target becomes zero. Actionable dollars and quantities require fresh,
          verified IBKR spot and net liquidation value. The method is read-only and cannot transmit orders.
        </p>
      </section>

      <section id="position-sizing" data-testid="process-section">
        <h2>1. Position Sizing</h2>
        <p>
          Position weight is measured as a percentage of portfolio net liquidation value (NLV). The method first
          calculates an allowable interval, MIN to MAX, and then calculates a target within it. Direction is separate
          from magnitude: long and short positions use the same absolute sizing equations, while the side supplies
          the sign.
        </p>

        <h3>1.1 Definitions</h3>
        <table className="wp-table wp-table--definitions">
          <thead><tr><th>Term</th><th>Definition</th></tr></thead>
          <tbody>
            <tr><td>MIN</td><td>The smallest meaningful active position and the ceiling after a verified Trend break while Trade still supports the held side.</td></tr>
            <tr><td>MAX</td><td>The largest position allowed by the beta band after application of the ATR constraint.</td></tr>
            <tr><td>Trade</td><td>The published short-duration directional signal, covering three weeks or less. It has terminal authority over the position lifecycle.</td></tr>
            <tr><td>Trend</td><td>The published intermediate-duration directional signal, covering three months or more.</td></tr>
            <tr><td>LRR / HRR</td><td>The current published low and high risk-range endpoints.</td></tr>
            <tr><td>Bias</td><td>The intended side of the position: long or short.</td></tr>
          </tbody>
        </table>
        <p>
          Trade and Trend are independent inputs. Trade comes from the published tracker direction and Trend comes
          from the published risk-range direction. A missing value remains missing; neither signal is copied from or
          inferred from the other.
        </p>

        <h3>1.2 Signal requirements</h3>
        <ol>
          <li>A new position requires Trade and Trend to support the same non-neutral bias.</li>
          <li>If Trend breaks while Trade still supports the held side, an existing weight above MIN is reduced directly to MIN. A smaller position is not increased, and no new position is opened.</li>
          <li>If Trade breaks, an existing position is assigned a zero target regardless of Trend.</li>
          <li>A missing signal is unknown rather than a break and prevents an executable recommendation.</li>
        </ol>
      </section>

      <section id="data-requirements" data-testid="process-section">
        <h2>2. Data Requirements</h2>
        <p>
          Every derived value retains source, observation count, and as-of time. Historical research may remain
          visible when execution data are unavailable, but it cannot substitute for live data.
        </p>
        <table className="wp-table">
          <thead><tr><th>Input</th><th>Requirement</th><th>Use</th></tr></thead>
          <tbody>
            <tr><td>Beta</td><td>Adjusted closes for the security and SPY; 252 aligned completed sessions, with at least 126 observations.</td><td>Initial MIN and MAX.</td></tr>
            <tr><td>ATR(14)</td><td>The latest 14 completed daily true ranges, with dated OHLC provenance.</td><td>Volatility limit on MAX.</td></tr>
            <tr><td>Trade</td><td>Published tracker direction and publication time.</td><td>Entry and terminal exit state.</td></tr>
            <tr><td>Trend</td><td>Published risk-range direction and publication time.</td><td>Active or MIN state.</td></tr>
            <tr><td>Risk ranges</td><td>Current LRR and HRR and all paginated prior editions.</td><td>Entry location and directional streaks.</td></tr>
            <tr><td>ATH / ATL</td><td>Maximum available completed traded-price history strictly before the current range edition.</td><td>Record extension.</td></tr>
            <tr><td>Spot and NLV</td><td>Fresh, connected, verified IBKR quote and account summary.</td><td>Executable dollars and quantity.</td></tr>
          </tbody>
        </table>
        <p>
          Beta returns use only adjacent dates common to the security and SPY; partial daily bars are excluded.
          ATH and ATL comparisons use prices dated strictly before the current range edition. Structure and record
          history are optional strength inputs. If either is unavailable, it contributes zero and remains marked
          unavailable rather than being reported as a negative signal.
        </p>
      </section>

      <section id="position-boundaries" data-testid="process-section">
        <h2>3. Position-Size Boundaries</h2>
        <p>
          Beta is estimated from adjusted simple daily returns. Its magnitude is used because the same allocation
          boundaries apply to long and short positions.
        </p>
        <Equation number="1">{`effective beta = clamp(|beta|, ${c.MIN_BETA}, ${c.MAX_BETA.toFixed(1)})`}</Equation>
        <Equation number="2">{`raw MIN = ${c.MIN_WEIGHT_NUMERATOR}% / effective beta`}</Equation>
        <Equation number="3">{`raw MAX = ${c.MAX_WEIGHT_NUMERATOR}% / effective beta`}</Equation>
        <p>
          Executable MIN is rounded upward and executable MAX downward to the nearest {percent(c.WEIGHT_INCREMENT)}
          of NLV. Before application of the ATR constraint, the beta endpoints produce the following bands.
        </p>
        <table className="wp-table wp-table--numeric">
          <thead><tr><th>Effective beta</th><th>MIN</th><th>MAX</th></tr></thead>
          <tbody>
            <tr><td>0.50</td><td>4.0%</td><td>12.0%</td></tr>
            <tr><td>1.00</td><td>2.0%</td><td>6.0%</td></tr>
            <tr><td>2.00</td><td>1.0%</td><td>3.0%</td></tr>
          </tbody>
        </table>

        <h3>3.1 ATR constraint</h3>
        <p>
          ATR limits security-specific volatility not captured by SPY beta. The assumed adverse distance is
          {` ${c.ATR_MULTIPLIER} ATRs`}; the maximum NLV loss budget at that distance is
          {` ${percent(c.ATR_RISK_BUDGET, 2)}`}.
        </p>
        <Equation number="4">{`ATR MAX = ${percent(c.ATR_RISK_BUDGET, 2)} / (${c.ATR_MULTIPLIER} x ATR(14) / spot)`}</Equation>
        <Equation number="5">effective MAX = min(beta MAX, ATR MAX)</Equation>
        <p>
          Effective MAX is rounded down to the executable grid. If the ATR maximum is below MIN, no positive target
          is produced because the security cannot be held at the defined minimum within the volatility budget.
        </p>
      </section>

      <section id="target-position" data-testid="process-section">
        <h2>4. Target Position Within the Band</h2>
        <Equation number="6">p = (spot - LRR) / (HRR - LRR)</Equation>
        <p>
          A long may open or add only when 0 ≤ p ≤ 0.5; its range score is 1 - 2p. A short may open or add only when
          0.5 ≤ p ≤ 1; its range score is 2p - 1. A wrong-half or out-of-range price remains visible but cannot
          authorize an open or add.
        </p>

        <h3>4.1 Directional structure</h3>
        <p>
          Long structure counts consecutive higher HRRs and higher LRRs. Short structure counts consecutive lower
          HRRs and lower LRRs. Endpoint streaks are independent and each is capped at {c.MAX_STREAK} published
          editions. A tie, missing value, or missing expected edition resets only the affected streak.
        </p>
        <Equation number="7">{`structure = 0.5 x (min(high streak, ${c.MAX_STREAK}) / ${c.MAX_STREAK} + min(low streak, ${c.MAX_STREAK}) / ${c.MAX_STREAK})`}</Equation>

        <h3>4.2 Record extension</h3>
        <p>
          The long record variable equals one when the current HRR exceeds the prior traded-price ATH. The short
          variable equals one when the current LRR is below the prior traded-price ATL. If the required history is
          unavailable or not prior to the edition, the record input is unavailable and contributes zero.
        </p>

        <h3>4.3 Conviction and target</h3>
        <Equation number="8">{`conviction = ${coefficientPercent(c.RANGE_CONVICTION_WEIGHT)} x range + ${coefficientPercent(c.STRUCTURE_CONVICTION_WEIGHT)} x structure + ${coefficientPercent(c.RECORD_CONVICTION_WEIGHT)} x record`}</Equation>
        <Equation number="9">target = MIN + conviction x (effective MAX - MIN)</Equation>
        <p>
          Record extension has the largest coefficient but does not force MAX. The final target is rounded to the
          nearest {percent(c.WEIGHT_INCREMENT)} and clamped within the effective band.
        </p>
      </section>

      <section id="position-lifecycle" data-testid="process-section">
        <h2>5. Position Lifecycle</h2>
        <table className="wp-table wp-table--lifecycle">
          <thead><tr><th>Verified state</th><th>Existing position</th><th>New candidate</th></tr></thead>
          <tbody>
            <tr><td>Trade and Trend support the bias</td><td>ACTIVE; target may be between MIN and MAX.</td><td>Open at MIN only in the favorable range half.</td></tr>
            <tr><td>Trade supports the bias; Trend breaks</td><td>BENCH; reduce any excess directly to MIN. Do not increase a smaller position.</td><td>Show MIN as a reference; no open action.</td></tr>
            <tr><td>Trade breaks</td><td>EXIT; target is zero regardless of Trend.</td><td>No position.</td></tr>
            <tr><td>Required signal or execution data is missing</td><td>Show available research; no executable action or quantity.</td><td>Same.</td></tr>
          </tbody>
        </table>
        <p>
          New positions begin at MIN. At each new range edition, normal adds and trims move
          {` ${percent(c.NORMAL_STEP)}`} toward target. The step becomes {percent(c.ACCELERATED_STEP)} when the record
          signal fires or both relevant structure streaks are at least three. Opens and adds still require the
          favorable half; risk-reducing trims do not.
        </p>
        <p>
          Signal deterioration bypasses gradual stepping. A verified Trend break with Trade intact caps the existing
          position at MIN without increasing a smaller holding. A verified Trade break moves it directly to zero. A
          reversal exits the old side first; the opposite side must independently meet alignment and entry-location
          requirements.
        </p>
      </section>

      <section id="worked-examples" data-testid="process-section">
        <h2>6. Worked Examples</h2>
        <p className="wp-method-note">
          The values in this section are generated by the production sizing engine from fixed example inputs at
          render time. They are not separate hand-calculated constants.
        </p>
        <h3>6.1 Long position</h3>
        <p>
          Beta 1.25 produces raw bounds {percent(long.rawMinWeight, 2)} and {percent(long.rawMaxWeight, 2)}, rounded
          to {percent(long.minWeight)} and {percent(long.betaMaxWeight)}. LRR 100, HRR 120, and spot 104 produce
          p = {decimal(long.rangePosition)} and a long range score of {decimal(long.strengthInputs.range.score)}.
          Higher-HRR and higher-LRR streaks are {long.streaks.higherHigh} and {long.streaks.higherLow}, producing a
          structure score of {decimal(long.strengthInputs.structure.score)}. HRR exceeds the prior ATH, so the record
          variable is one.
        </p>
        <Equation number="10">{`conviction = ${decimal(long.strengthInputs.range.weighted)} + ${decimal(long.strengthInputs.structure.weighted)} + ${decimal(long.strengthInputs.record.weighted)} = ${decimal(long.conviction)}`}</Equation>
        <Equation number="11">{`target = ${percent(long.minWeight)} + ${decimal(long.conviction)}(${percent(long.operationalMaxWeight)} - ${percent(long.minWeight)}) -> ${percent(long.targetWeight)}`}</Equation>
        <p>
          The calculated target is {percent(long.targetWeight)}. A new position still opens at
          {` ${percent(long.minWeight)}`}; later qualifying editions move it toward target.
        </p>

        <h3>6.2 Short position</h3>
        <p>
          Beta 1.80 produces an operational band of {percent(short.minWeight)} to
          {` ${percent(short.betaMaxWeight)}`}. LRR 50, HRR 60, and spot 58 produce p =
          {` ${decimal(short.rangePosition)}`} and a short range score of
          {` ${decimal(short.strengthInputs.range.score)}`}. Lower-HRR and lower-LRR streaks are
          {` ${short.streaks.lowerHigh}`} and {short.streaks.lowerLow}. LRR does not extend below the prior ATL, so
          the record variable is zero.
        </p>
        <Equation number="12">{`conviction = ${decimal(short.strengthInputs.range.weighted)} + ${decimal(short.strengthInputs.structure.weighted)} + ${decimal(short.strengthInputs.record.weighted)} = ${decimal(short.conviction)}`}</Equation>
        <Equation number="13">{`target = ${percent(short.minWeight)} + ${decimal(short.conviction)}(${percent(short.operationalMaxWeight)} - ${percent(short.minWeight)}) -> ${percent(short.targetWeight)}`}</Equation>
        <p>
          The calculated short target is {percent(short.targetWeight)}, and a new short opens at the
          {` ${percent(short.minWeight)}`} MIN.
        </p>
      </section>

      <section id="validation" data-testid="process-section">
        <h2>7. Validation and Limitations</h2>
        <p>
          The calculation engine is pure: identical complete inputs and evaluation time produce an identical result.
          Tests cover beta regression and observation limits, clamps, ATR precedence, long and short lifecycle states,
          range boundaries, streak resets, record comparisons, rounding, provenance, and missing inputs. Separate
          fail-closed tests require every disconnected, delayed, frozen, stale, cached, mock, seeded, synthetic,
          inferred, or fallback execution case to suppress actionable output.
        </p>
        <table className="wp-table">
          <thead><tr><th>Result group</th><th>Fields retained</th></tr></thead>
          <tbody>
            <tr><td>Boundaries</td><td>Raw and effective beta, raw and operational MIN/MAX, ATR limit, and risk-blocked status.</td></tr>
            <tr><td>Strength</td><td>Range position and score, both structure streaks, record status, conviction, and target.</td></tr>
            <tr><td>Lifecycle</td><td>Bias, Trade, Trend, lifecycle state, research action, executable action, reasons, and blockers.</td></tr>
            <tr><td>Provenance</td><td>Source, observation count, and as-of time for beta, ATR, signals, ranges, records, quote, and NLV.</td></tr>
          </tbody>
        </table>

        <h3>7.1 Execution control and shadow mode</h3>
        <p>
          Executable action requires a live IBKR quote bound to the calculation spot and a fresh verified IBKR
          account summary bound to NLV. Unsupported or unverifiable instrument details suppress quantity output.
          Before dashboard recommendations are promoted, shadow results must be recorded with their method version,
          complete inputs, result, reasons, and as-of times. Neither shadow nor displayed output may transmit an order.
        </p>

        <h3>7.2 Limitations</h3>
        <ul>
          <li>SPY beta measures common-market sensitivity, not total security risk; ATR is a secondary constraint.</li>
          <li>The method sizes one security at a time. Portfolio limits, correlation, and cash allocation belong to a separate technical note.</li>
          <li>Quantity requires verified multiplier, lot size, currency, and tradability. Unsupported instruments remain research-only.</li>
          <li>Record quality depends on verified daily history and appropriate continuous-contract mapping.</li>
        </ul>
      </section>
    </>
  );
};

export default PositionSizingNote;
