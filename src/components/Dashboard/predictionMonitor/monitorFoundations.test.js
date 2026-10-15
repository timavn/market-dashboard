import { finite } from './monitorNumbers';
import { MARKET_UI } from './marketUi';
import { formatIndex, formatCount, formatCents, formatAsOf } from './monitorFormatting';
import { isSpxMonitorSectionUsable } from './monitorSectionValidation';

test('keeps existing optional-number acceptance and display formatting without manufacturing missing values', () => {
  [null, undefined, '', NaN, Infinity, -Infinity, 'not a number'].forEach((value) => {
    expect(finite(value)).toBe(false);
    expect(formatIndex(value)).toBe('—');
    expect(formatCount(value)).toBe('—');
    expect(formatCents(value)).toBe('—');
  });
  [0, -1, '0', '2.5', ' '].forEach((value) => expect(finite(value)).toBe(true));
  expect(formatIndex('1234.567')).toBe('1,234.57');
  expect(formatIndex(1234.567, 1)).toBe('1,234.6');
  expect(formatCount('1234.5')).toBe('1,235');
  expect(formatCents(0.245)).toBe('25¢');
  expect(formatCents(0)).toBe('0¢');
  expect(formatAsOf(null)).toBe('—');
  expect(formatAsOf(null, true)).toBe('REFRESH DELAYED');
  expect(formatAsOf('2026-09-10')).toBe('Sep 10');
  expect(formatAsOf('2026-09-10', true)).toBe('Sep 10 · REFRESH DELAYED');
  expect(formatAsOf('unparsed provider date', true)).toBe('unparsed provider date');
});

test('preserves section invalidation, expiry boundary, and explicitly retained pending-refresh rules', () => {
  const now = Date.parse('2026-09-11T17:00:00Z');
  const available = { status: 'available', expiresAt: '2026-09-11T17:00:00Z' };
  expect(isSpxMonitorSectionUsable(available, now)).toBe(true);
  expect(isSpxMonitorSectionUsable(available, now + 1)).toBe(false);
  expect(isSpxMonitorSectionUsable({ status: 'partial' }, now)).toBe(true);
  expect(isSpxMonitorSectionUsable({ ...available, expiresAt: 'invalid' }, now)).toBe(false);
  [null, {}, { status: 'offline' }, { status: 'unavailable' }].forEach((value) => {
    expect(isSpxMonitorSectionUsable(value, now)).toBe(false);
  });
  ['refreshFailed', 'fromCache', 'cachedOnly', 'cacheOnly', 'seeded', 'mock', 'stale'].forEach((flag) => {
    expect(isSpxMonitorSectionUsable({ ...available, [flag]: true }, now)).toBe(false);
  });
  ['refreshing', 'refreshPending'].forEach((flag) => {
    expect(isSpxMonitorSectionUsable({ ...available, [flag]: true }, now)).toBe(false);
    expect(isSpxMonitorSectionUsable({ ...available, [flag]: true, refreshRetained: true }, now)).toBe(true);
    expect(isSpxMonitorSectionUsable({ ...available, [flag]: true, refreshRetained: true, refreshFailed: true }, now)).toBe(false);
  });
});

test('preserves historical date/provenance checks and immutable market defaults used by all monitor cards', () => {
  const historical = {
    status: 'historical', historicalThroughDate: '2026-09-10', asOf: '2026-09-10T22:00:00Z',
    source: 'Official session close', expiresAt: '2026-09-10T22:00:00Z',
  };
  const now = Date.parse('2026-09-11T17:00:00Z');
  expect(isSpxMonitorSectionUsable(historical, now)).toBe(true);
  expect(isSpxMonitorSectionUsable({ ...historical, status: 'available', availability: 'historical' }, now)).toBe(true);
  expect(isSpxMonitorSectionUsable({ ...historical, historicalThroughDate: '2026-09-09' }, now)).toBe(false);
  expect(isSpxMonitorSectionUsable({ ...historical, latestAt: '2026-09-09T22:00:00Z' }, now)).toBe(false);
  ['mock', 'seed', 'fixture', 'fallback', 'cache', 'portfolio', 'delayed', 'frozen', 'stale', 'offline', 'disconnected', 'synthetic', 'inferred', 'derived']
    .forEach((source) => expect(isSpxMonitorSectionUsable({ ...historical, source }, now)).toBe(false));
  expect(Object.isFrozen(MARKET_UI)).toBe(true);
  Object.values(MARKET_UI).forEach((market) => expect(Object.isFrozen(market)).toBe(true));
  expect(MARKET_UI.sp500.fixedContract).toEqual({ venueId: 'forecastex', venueLabel: 'ForecastEx', productCode: 'FES' });
  expect(MARKET_UI.cpi.fixedContract.productCode).toBe('KXCPIYOY');
  expect(MARKET_UI.gold.fixedContract.productCode).toBe('KXGOLDD');
  expect(MARKET_UI.bitcoin.chartCalendar).toBe('continuous');
  expect(Object.isFrozen(MARKET_UI.sp500.venueIds)).toBe(true);
  expect(Object.isFrozen(MARKET_UI.sp500.fixedContract)).toBe(true);
});
