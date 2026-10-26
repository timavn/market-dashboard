import React from 'react';
import {
  ATR_FLOOR,
  SIZING_CONSTANTS,
  calculateSizingBand,
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
  atr14: { value: 2.08, observations: 14, source: 'completed daily bars', asOf: '2026-07-17' },
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
  atr14: { value: 2.32, observations: 14, source: 'completed daily bars', asOf: '2026-07-17' },
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

// Bands for ATR at 1%, 2%, 4%, and 8% of a 100 spot.
const ATR_BAND_EXAMPLES = [1, 2, 4, 8].map(atr => ({ atr, band: calculateSizingBand({ atr14: atr, spot: 100 }) }));

const percent = (value, digits = 1) => `${Number(value).toFixed(digits)}%`;
const coefficientPercent = (value) => `${Number(value * 100).toFixed(0)}%`;
const decimal = (value, digits = 2) => Number(value).toFixed(digits);

const Equation = ({ number, children }) => (
  <div className="wp-equation" role="math" aria-label={`${children}. Equation ${number}.`}>
    <code>{children}</code>
    <span>({number})</span>
  </div>
);

const PositionSizingNote = ({ document, sectionPrefix = '' }) => {
  const metadata = document || getProcessDocument('position-sizing');
  const long = POSITION_SIZING_EXAMPLES.long;
  const short = POSITION_SIZING_EXAMPLES.short;
  const c = SIZING_CONSTANTS;
  const sectionId = (id) => (sectionPrefix ? `${sectionPrefix}--${id}` : id);

  return (
    <>
      <header className="wp-paper__title">
        <p className="wp-paper__series">{metadata.subtitle}</p>
        <h1 id={sectionId('position-sizing-title')}>{metadata.title}</h1>
        <p>Security-level allocation boundaries, targets, and lifecycle rules</p>
      </header>

      <section id={sectionId('abstract')} className="wp-abstract" data-testid="process-section">
        <p>
          <strong>Abstract.</strong> This note specifies a deterministic method for setting a security-level
          position weight. Each security is sized from its own 14-day ATR: a stop two ATRs away sets the minimum and
          maximum, so a stop-out costs about the same share of NLV for every security, and the same distance is the
          reference stop. When Trade and Trend are aligned, range location, risk-range structure,
          and extension beyond a prior all-time high or low determine a target inside the interval. New positions
          open at MIN. If Trend breaks while Trade remains aligned, MIN becomes the ceiling for an existing position.
          If Trade breaks, the position target becomes zero. Actionable dollars and quantities require fresh,
          verified IBKR spot and net liquidation value. The method is read-only and cannot transmit orders.
        </p>
      </section>

      <section id={sectionId('position-sizing')} data-testid="process-section">
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
            <tr><td>MAX</td><td>The largest position whose 2 × ATR stop costs no more than the maximum stop loss, capped by the ATR floor.</td></tr>
            <tr><td>Stop</td><td>The reference level two ATRs against the position from its entry price. It is a planning level, not an order.</td></tr>
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

      <section id={sectionId('data-requirements')} data-testid="process-section">
        <h2>2. Data Requirements</h2>
        <p>
          Every derived value retains source, observation count, and as-of time. Historical research may remain
          visible when execution data are unavailable, but it cannot substitute for live data.
        </p>
        <table className="wp-table">
          <thead><tr><th>Input</th><th>Requirement</th><th>Use</th></tr></thead>
          <tbody>
            <tr><td>ATR(14)</td><td>The latest 14 completed daily true ranges, with dated OHLC provenance.</td><td>MIN, MAX, and the stop distance.</td></tr>
            <tr><td>Closing price</td><td>The latest completed daily close, with dated provenance.</td><td>Converts ATR to a share of price.</td></tr>
            <tr><td>Trade</td><td>Published tracker direction and publication time.</td><td>Entry and terminal exit state.</td></tr>
            <tr><td>Trend</td><td>Published risk-range direction and publication time.</td><td>Active or MIN state.</td></tr>
            <tr><td>Risk ranges</td><td>Current LRR and HRR and all paginated prior editions.</td><td>Entry location and directional streaks.</td></tr>
            <tr><td>ATH / ATL</td><td>Maximum available completed traded-price history strictly before the current range edition.</td><td>Record extension.</td></tr>
            <tr><td>Spot and NLV</td><td>Fresh, connected, verified IBKR quote and account summary.</td><td>Executable dollars and quantity.</td></tr>
          </tbody>
        </table>
        <p>
          ATR uses completed daily bars only; partial daily bars are excluded. ATH and ATL comparisons use prices dated strictly before the current range edition. Structure and record
          history are optional strength inputs. If either is unavailable, it contributes zero and remains marked
          unavailable rather than being reported as a negative signal.
        </p>
      </section>

      <section id={sectionId('position-boundaries')} data-testid="process-section">
        <h2>3. Position-Size Boundaries</h2>
        <p>
          Every security uses the same equations, whatever its asset class. ATR is expressed as a share of the
          closing price so that it compares across prices, and the stop sits {c.STOP_ATR_MULTIPLE} ATRs away.
          MIN and MAX are the weights at which reaching that stop costs {percent(c.MIN_STOP_LOSS_PCT_NLV, 3)} and
          {` ${percent(c.MAX_STOP_LOSS_PCT_NLV, 2)}`} of NLV.
        </p>
        <Equation number="1">{`ATR % = max(ATR(14) / close, ${percent(ATR_FLOOR * 100, 2)})`}</Equation>
        <Equation number="2">{`stop distance = ${c.STOP_ATR_MULTIPLE} x ATR %`}</Equation>
        <Equation number="3">{`raw MIN = ${percent(c.MIN_STOP_LOSS_PCT_NLV, 3)} / stop distance; raw MAX = ${percent(c.MAX_STOP_LOSS_PCT_NLV, 2)} / stop distance`}</Equation>
        <p>
          Executable MIN is rounded upward and executable MAX downward to the nearest {percent(c.WEIGHT_INCREMENT, 2)} of
          NLV. Twice the volatility gets half the weight, so the loss at the stop stays level.
        </p>
        <table className="wp-table wp-table--numeric">
          <thead><tr><th>ATR % of price</th><th>Stop distance</th><th>MIN</th><th>MAX</th></tr></thead>
          <tbody>
            {ATR_BAND_EXAMPLES.map(({ atr, band }) => (
              <tr key={atr}><td>{percent(atr)}</td><td>{percent(band.stopDistance * 100)}</td><td>{percent(band.minWeight, 2)}</td><td>{percent(band.maxWeight, 2)}</td></tr>
            ))}
          </tbody>
        </table>

        <h3>3.1 ATR floor</h3>
        <p>
          Very quiet securities would otherwise receive very large weights. ATR below {percent(ATR_FLOOR * 100, 2)} of
          price is raised to the floor for sizing, which caps MAX at {percent(c.MAX_POSITION_WEIGHT, 0)}. The stop
          still uses the measured ATR, so a floored position risks less than the maximum stop loss.
        </p>

        <h3>3.2 Reference stop</h3>
        <Equation number="4">{`long stop = entry - ${c.STOP_ATR_MULTIPLE} x ATR(14); short stop = entry + ${c.STOP_ATR_MULTIPLE} x ATR(14)`}</Equation>
        <p>
          For a held position the entry is the verified IBKR average cost; for planning limits it is the latest
          close. A stop is a trigger, not a guaranteed fill: a gap can execute beyond it. The level is displayed for
          reference and no stop order is created.
        </p>
      </section>

      <section id={sectionId('target-position')} data-testid="process-section">
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
          nearest {percent(c.WEIGHT_INCREMENT, 2)} and clamped within the effective band.
        </p>
      </section>

      <section id={sectionId('position-lifecycle')} data-testid="process-section">
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

      <section id={sectionId('worked-examples')} data-testid="process-section">
        <h2>6. Worked Examples</h2>
        <p className="wp-method-note">
          The values in this section are generated by the production sizing engine from fixed example inputs at
          render time. They are not separate hand-calculated constants.
        </p>
        <h3>6.1 Long position</h3>
        <p>
          ATR 2.08 on spot 104 is {percent(long.sizingBand.relativeAtr * 100, 2)} of price, a stop distance of
          {` ${percent(long.stop.distance * 100, 2)}`}. That produces raw bounds {percent(long.rawMinWeight, 2)} and
          {` ${percent(long.rawMaxWeight, 2)}`}, rounded to {percent(long.minWeight, 2)} and {percent(long.maxWeight, 2)},
          with the stop at {decimal(long.stop.price)}. LRR 100, HRR 120, and spot 104 produce
          p = {decimal(long.rangePosition)} and a long range score of {decimal(long.strengthInputs.range.score)}.
          Higher-HRR and higher-LRR streaks are {long.streaks.higherHigh} and {long.streaks.higherLow}, producing a
          structure score of {decimal(long.strengthInputs.structure.score)}. HRR exceeds the prior ATH, so the record
          variable is one.
        </p>
        <Equation number="10">{`conviction = ${decimal(long.strengthInputs.range.weighted)} + ${decimal(long.strengthInputs.structure.weighted)} + ${decimal(long.strengthInputs.record.weighted)} = ${decimal(long.conviction)}`}</Equation>
        <Equation number="11">{`target = ${percent(long.minWeight, 2)} + ${decimal(long.conviction)}(${percent(long.operationalMaxWeight, 2)} - ${percent(long.minWeight, 2)}) -> ${percent(long.targetWeight, 2)}`}</Equation>
        <p>
          The calculated target is {percent(long.targetWeight, 2)}. A new position still opens at
          {` ${percent(long.minWeight, 2)}`}; later qualifying editions move it toward target.
        </p>

        <h3>6.2 Short position</h3>
        <p>
          ATR 2.32 on spot 58 is {percent(short.sizingBand.relativeAtr * 100, 2)} of price, producing an operational
          band of {percent(short.minWeight, 2)} to {percent(short.maxWeight, 2)} and a stop at
          {` ${decimal(short.stop.price)}`}. LRR 50, HRR 60, and spot 58 produce p =
          {` ${decimal(short.rangePosition)}`} and a short range score of
          {` ${decimal(short.strengthInputs.range.score)}`}. Lower-HRR and lower-LRR streaks are
          {` ${short.streaks.lowerHigh}`} and {short.streaks.lowerLow}. LRR does not extend below the prior ATL, so
          the record variable is zero.
        </p>
        <Equation number="12">{`conviction = ${decimal(short.strengthInputs.range.weighted)} + ${decimal(short.strengthInputs.structure.weighted)} + ${decimal(short.strengthInputs.record.weighted)} = ${decimal(short.conviction)}`}</Equation>
        <Equation number="13">{`target = ${percent(short.minWeight, 2)} + ${decimal(short.conviction)}(${percent(short.operationalMaxWeight, 2)} - ${percent(short.minWeight, 2)}) -> ${percent(short.targetWeight, 2)}`}</Equation>
        <p>
          The calculated short target is {percent(short.targetWeight, 2)}, and a new short opens at the
          {` ${percent(short.minWeight, 2)}`} MIN.
        </p>
      </section>

      <section id={sectionId('validation')} data-testid="process-section">
        <h2>7. Validation and Limitations</h2>
        <p>
          The calculation engine is pure: identical complete inputs and evaluation time produce an identical result.
          Tests cover ATR observation limits, the ATR floor, stop levels, long and short lifecycle states,
          range boundaries, streak resets, record comparisons, rounding, provenance, and missing inputs. Separate
          fail-closed tests require every disconnected, delayed, frozen, stale, cached, mock, seeded, synthetic,
          inferred, or fallback execution case to suppress actionable output.
        </p>
        <table className="wp-table">
          <thead><tr><th>Result group</th><th>Fields retained</th></tr></thead>
          <tbody>
            <tr><td>Boundaries</td><td>ATR share of price, floor status, stop distance and price, raw and operational MIN/MAX, and risk-blocked status.</td></tr>
            <tr><td>Strength</td><td>Range position and score, both structure streaks, record status, conviction, and target.</td></tr>
            <tr><td>Lifecycle</td><td>Bias, Trade, Trend, lifecycle state, research action, executable action, reasons, and blockers.</td></tr>
            <tr><td>Provenance</td><td>Source, observation count, and as-of time for ATR, signals, ranges, records, quote, and NLV.</td></tr>
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
          <li>ATR measures recent daily movement; it can lag a regime change and does not capture overnight gaps or event risk. Market beta is not part of security sizing.</li>
          <li>The method sizes one security at a time. Portfolio limits, correlation, and cash allocation belong to a separate technical note.</li>
          <li>Quantity requires verified multiplier, lot size, currency, and tradability. Unsupported instruments remain research-only.</li>
          <li>Record quality depends on verified daily history and appropriate continuous-contract mapping.</li>
        </ul>
      </section>
    </>
  );
};

export default PositionSizingNote;
