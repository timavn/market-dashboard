import { portfolioReviewOutlook } from './portfolioReviewOutlook';

const outlook = { from: 2, to: 3, status: 'scenario', citation: { id: 'call', title: 'The Call' } };
test('a sourced Quad 2 to 3 scenario uses existing exposures, respecting long and short direction', () => {
  const result = portfolioReviewOutlook({ quadOutlook: outlook, holdings: [
    { holding: 'XLF', heldSide: 'LONG', weightPct: 4 },
    { holding: 'XLU', heldSide: 'LONG', weightPct: 3 },
    { holding: 'XLI', heldSide: 'SHORT', weightPct: 2 },
    { holding: 'UNMAPPED', heldSide: 'LONG', weightPct: 5 },
  ] });
  expect(result.pressure.map(row => row.holding)).toEqual(['XLF']);
  expect(result.support.map(row => row.holding)).toEqual(['XLU', 'XLI']);
  expect(result.mapped).toBe(3);
});

test('research candidates need bullish Trade/Trend and positive improving historical EV', () => {
  const result = portfolioReviewOutlook({ quadOutlook: outlook, opportunities: [
    { symbol: 'XLU', trade: 'BULLISH', trend: 'BULLISH' },
    { symbol: 'XLF', trade: 'BULLISH', trend: 'BULLISH' },
    { symbol: 'TLT', trade: 'BULLISH', trend: 'NEUTRAL' },
  ] });
  expect(result.candidates.map(row => row.symbol)).toEqual(['XLU']);
  expect(portfolioReviewOutlook({ quadOutlook: { ...outlook, citation: null } })).toBeNull();
});

test('held securities use their exact +EV chart row before broader exposure profiles', () => {
  const result = portfolioReviewOutlook({ quadOutlook: { ...outlook, from: 1, to: 2 }, holdings: [
    { holding: 'HYG', heldSide: 'LONG', weightPct: 4 },
    { holding: 'HYG', heldSide: 'SHORT', weightPct: 2 },
  ] });
  expect(result.pressure.find(row => row.heldSide === 'LONG')).toMatchObject({ label: 'HY Credit', fit: 2.1 });
  expect(result.pressure.find(row => row.heldSide === 'SHORT').fit).toBe(-2.1);
});
