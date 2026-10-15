import { buildUsdCorrelationPresentation } from './usdCorrelationPresentation';

const input = (overrides = {}) => ({ proxy: 'GOLD', correlation: 0.45, loading: false, asOfLabel: 'Sep 10', ...overrides });

test.each([
  [0.456, '+0.46', 'is-positive'],
  [-0.456, '-0.46', 'is-negative'],
  [0, '0.00', 'is-muted'],
  [-0, '0.00', 'is-muted'],
  [0.001, '+0.00', 'is-positive'],
  [-0.001, '-0.00', 'is-negative'],
])('preserves %s formatting and unrounded sign tone', (correlation, value, tone) => {
  expect(buildUsdCorrelationPresentation(input({ correlation })))
    .toEqual({ value, meta: 'DXY vs GOLD · 30D · Sep 10', tone });
});

test.each([true, false])('keeps unmapped and accepted-value precedence over loading=%s', loading => {
  expect(buildUsdCorrelationPresentation(input({ proxy: null, correlation: null, loading })))
    .toEqual({ value: 'N/A', meta: 'No direct USD proxy', tone: 'is-muted' });
  expect(buildUsdCorrelationPresentation(input({ loading })))
    .toEqual({ value: '+0.45', meta: 'DXY vs GOLD · 30D · Sep 10', tone: 'is-positive' });
});

test.each([[true, '…'], [false, 'Unavailable']])('preserves mapped missing-data display while loading=%s', (loading, value) => {
  expect(buildUsdCorrelationPresentation(input({ correlation: null, loading })))
    .toEqual({ value, meta: 'DXY vs GOLD unavailable', tone: 'is-muted' });
});

test('passes prepared labels through and returns fresh immutable-input projections', () => {
  const props = Object.freeze(input({ proxy: 'BTC', asOfLabel: 'Custom date label' }));
  const first = buildUsdCorrelationPresentation(props);
  const second = buildUsdCorrelationPresentation(props);
  expect(first).toEqual({ value: '+0.45', meta: 'DXY vs BTC · 30D · Custom date label', tone: 'is-positive' });
  expect(second).toEqual(first);
  expect(second).not.toBe(first);
  expect(Object.values(first).every(value => typeof value === 'string')).toBe(true);
});
