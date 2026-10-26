import { METRIC_DEFINITIONS } from './metricDefinitions';
import { getProcessRule } from './processDocuments';

describe('metric definitions use canonical Process rules', () => {
  test('uses the canonical Trade/Trend durations and asymmetric lifecycle precedence', () => {
    const ttt = METRIC_DEFINITIONS.ttt;
    expect(ttt.components.find(({ name }) => name === 'Trade').duration).toBe('3 weeks or less');
    expect(ttt.components.find(({ name }) => name === 'Trend').duration).toBe('3 months or more');
    expect(ttt.interpretation).toContain(
      getProcessRule('lifecycle.trend_break_trade_holds').statement,
    );
    expect(ttt.interpretation).toContain(getProcessRule('lifecycle.trade_break').statement);
    expect(ttt.interpretation.join(' ')).not.toMatch(/Trade breaks but Trend holds.*trim/i);
  });

  test('uses LRR/HRR and the approved favorable entry halves', () => {
    const riskRange = METRIC_DEFINITIONS.riskRange;
    expect(riskRange.components.map(({ name }) => name).join(' ')).not.toMatch(/\bTRR\b/);
    expect(riskRange.interpretation).toContain(getProcessRule('entry.long.range_half').statement);
    expect(riskRange.interpretation).toContain(getProcessRule('entry.short.range_half').statement);
  });

  test('presents ATR as the v2.0 sizing band and reference stop, not an approved stop-order policy', () => {
    const atrText = METRIC_DEFINITIONS.atr.interpretation.join(' ');
    const band = getProcessRule('risk.atr_band').parameters;
    const stop = getProcessRule('risk.atr_stop').parameters;
    expect(atrText).toMatch(/Position Sizing v2\.0 sizes every security from ATR/);
    expect(atrText).toContain(`${band.stopAtrMultiple} × ATR stop costs ${band.minStopLossPctNlv}% and ${band.maxStopLossPctNlv}% of NLV`);
    expect(atrText).toContain(`${stop.atrMultiple} × ATR from the entry price`);
    expect(atrText).toMatch(/Stop-order placement.*unresolved/i);
    expect(atrText).not.toMatch(/maximum-position backstop|beta/i);
    expect(getProcessRule('risk.hard_stop.policy').status).toBe('research');
    expect(METRIC_DEFINITIONS.atr.source).toBe('Position Sizing v2.0; stop-order policy remains research-only');
  });

  test('derives MIN / MAX from the ATR-band rule without beta', () => {
    const minMax = METRIC_DEFINITIONS.minMax;
    const band = getProcessRule('risk.atr_band').parameters;
    // Floor = MAX stop loss / (multiple × ceiling) = 0.25% / (2 × 10%) = 1.25%.
    const floorPct = (band.maxStopLossPctNlv / (band.stopAtrMultiple * band.maxPositionWeightPct)) * 100;
    expect(floorPct).toBeCloseTo(1.25, 10);
    expect(minMax.calculation).toContain('floored at 1.25%');
    expect(minMax.calculation).toContain(`Stop distance = ${band.stopAtrMultiple} × ATR %`);
    expect(minMax.calculation).toContain(`MIN = ${band.minStopLossPctNlv}% / stop distance, rounded up to ${band.executableIncrementPct} percentage points`);
    expect(minMax.calculation).toContain(`MAX = ${band.maxStopLossPctNlv}% / stop distance, rounded down to ${band.executableIncrementPct} percentage points`);
    expect(minMax.interpretation.join(' ')).toContain(`caps MAX at ${band.maxPositionWeightPct}%`);
    expect(`${minMax.definition} ${minMax.calculation}`).not.toMatch(/beta|SPY|risk cap/i);
    expect(minMax.source).toMatch(/^Site Position Sizing v2\.0;/);
    expect(METRIC_DEFINITIONS.ttt.source).toBe('The Process v0.1 and Position Sizing v2.0');
  });
});
