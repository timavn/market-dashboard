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

  test('does not present ATR as an approved hard-stop policy', () => {
    expect(METRIC_DEFINITIONS.atr.interpretation.join(' ')).toMatch(/maximum-position backstop/i);
    expect(METRIC_DEFINITIONS.atr.interpretation.join(' ')).toMatch(/Hard-stop.*unresolved/i);
  });
});
