import { buildIntradayTimeAxis, formatIntradayTimeTick } from './riskRangeChartAxes';

test('keeps the cash-session endpoints without crowding the opening label', () => {
  const open = Date.parse('2026-09-16T13:30:00Z');
  const close = Date.parse('2026-09-16T20:00:00Z');
  const axis = buildIntradayTimeAxis([open, open + 60_000], 8, {
    domain: [open, close], includeEndpoints: true, minimumTickGapMs: 45 * 60_000,
  });

  expect(axis.ticks[0]).toBe(open);
  expect(axis.ticks.at(-1)).toBe(close);
  expect(axis.ticks).not.toContain(Date.parse('2026-09-16T14:00:00Z'));
  axis.ticks.slice(1).forEach((tick, index) => {
    expect(tick - axis.ticks[index]).toBeGreaterThanOrEqual(45 * 60_000);
  });
});

test.each([
  ['2026-09-16T13:30:00Z', '09:30'],
  ['2026-09-16T20:00:00Z', '16:00'],
  ['2026-01-16T14:30:00Z', '09:30'],
])('formats %s as a compact New York session time', (timestamp, expected) => {
  expect(formatIntradayTimeTick(Date.parse(timestamp), 60 * 60_000, {
    clock24: true, timeZone: 'America/New_York',
  })).toBe(expected);
});
