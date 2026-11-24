import { marketStructureSummary } from './marketStructureSummary';

test('explains each published reading and names the one that disagrees', () => {
  expect(marketStructureSummary([
    ['SPX Gamma Exposure', 'Negative'], ['Systematic Flow Risk', 'Bearish'], ['PV Band Risk/Reward', 'Long'],
    ['Strategic Allocation', 'Risk Off'], ['Gamma throttle', '-49.03'], ['10D realized vol', '27.24%'],
  ])).toBe('Dealers are short gamma, so their hedging runs with price and amplifies moves; the throttle (-49.03) is the strength '
    + 'of that effect, and 27.24% is how much SPX actually moved over the last 10 sessions. Systematic funds (vol control, CTAs, '
    + 'risk parity) lean toward selling, most on breakdowns, and the allocation stance is Risk Off: cut gross, wider stops. '
    + 'The one offset is PV Band Risk/Reward, which favors the long side against the probable-volatility bands.');
});

test('a reading that agrees with the rest is not called an offset', () => {
  expect(marketStructureSummary([['Systematic Flow Risk', 'Bullish'], ['PV Band Risk/Reward', 'Long']]))
    .toBe('Systematic funds (vol control, CTAs, risk parity) lean toward buying, most on breakouts. '
      + 'PV Band Risk/Reward favors the long side against the probable-volatility bands.');
});

test('says nothing about readings the product did not print or values it does not know', () => {
  expect(marketStructureSummary([['Zero gamma', '7,733'], ['PV band', '7,610–7,852']])).toBeNull();
  expect(marketStructureSummary([['SPX Gamma Exposure', 'Mixed'], ['Gamma throttle', '-5.89']])).toBeNull();
  expect(marketStructureSummary(null)).toBeNull();
});
