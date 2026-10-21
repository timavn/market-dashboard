import {
  PORTFOLIO_QUAD_READINGS_KEY,
  currentPortfolioQuadReadings,
  loadPortfolioQuadReadings,
  publishedQuadReadings,
  quadReadingDate,
} from './portfolioQuadReadings';

const reading = (quad, asOf = '2026-09-08') => ({ quad, asOf, source: 'manual-hedgeye' });

test('expires the U.S. monthly reading at month rollover and G20/U.S. quarterly readings at quarter rollover', () => {
  const readings = { global: reading(1), usMonthly: reading(3), usQuarterly: reading(2, '2026-07-15') };
  expect(currentPortfolioQuadReadings(readings, '2026-09-08')).toEqual(readings);
  expect(currentPortfolioQuadReadings(readings, '2026-10-01')).toEqual({ global: null, usMonthly: null, usQuarterly: null });
  const august = { global: reading(1, '2026-08-20'), usMonthly: reading(3, '2026-08-20'), usQuarterly: reading(2, '2026-08-20') };
  expect(currentPortfolioQuadReadings(august, '2026-09-08')).toEqual({ global: august.global, usMonthly: null, usQuarterly: august.usQuarterly });
});

test.each([
  null,
  { quad: 3 },
  { ...reading(3), source: 'sample' },
  { ...reading(3), source: 'mock' },
  { ...reading(3), source: 'hedgeye-published' },
  { ...reading(3), source: 'hedgeye-published', sourceLabel: 'Unverified', sourceUrl: 'https://example.com' },
  reading(5),
  reading(0),
  reading(3, '2026-09-09'),
  reading(3, '2026-09-31'),
  reading(3, 'invalid'),
])('does not publish an invalid or unverified current reading: %p', value => {
  expect(currentPortfolioQuadReadings({ global: value, usMonthly: value, usQuarterly: value }, '2026-09-08'))
    .toEqual({ global: null, usMonthly: null, usQuarterly: null });
});

test('uses the U.S. calendar date at a UTC month boundary', () => {
  expect(quadReadingDate(new Date('2026-10-01T01:00:00Z'))).toBe('2026-09-30');
});

test('a new published update supersedes an older manual reading but preserves a same-day operator update', () => {
  localStorage.setItem(PORTFOLIO_QUAD_READINGS_KEY, JSON.stringify({
    global: reading(1, '2026-09-04'),
    usMonthly: reading(4),
  }));
  try {
    expect(loadPortfolioQuadReadings().global).toEqual(expect.objectContaining({ quad: 3, source: 'hedgeye-published' }));
    expect(loadPortfolioQuadReadings().usMonthly).toEqual(reading(4));
  } finally {
    localStorage.removeItem(PORTFOLIO_QUAD_READINGS_KEY);
  }
});

test('a reading parsed from the emails for this month supersedes an older bundled reference', () => {
  const october = { quad: 2, asOf: '2026-10-13', source: 'hedgeye-published', sourceLabel: 'ETF Pro · October 13, 2026 · Quad Path: October #Quad2', sourceUrl: 'https://mail.google.com/mail/#all/1a1363b72b765da0' };
  const payload = { schemaVersion: 1, readings: { '2026-10': october, '2026-11': { ...october, quad: 1 } } };
  expect(publishedQuadReadings(payload, '2026-10-21')).toEqual({ usMonthly: october });
  expect(publishedQuadReadings(payload, '2026-12-01')).toEqual({});
  expect(publishedQuadReadings({ readings: payload.readings }, '2026-10-21')).toEqual({});
  const loaded = loadPortfolioQuadReadings(publishedQuadReadings(payload, '2026-10-21'));
  expect(loaded.usMonthly).toBe(october);
  expect(currentPortfolioQuadReadings(loaded, '2026-10-21').usMonthly).toBe(october);
  // A forecast for next month published this month is not yet that month's reading.
  expect(currentPortfolioQuadReadings(loadPortfolioQuadReadings(publishedQuadReadings(payload, '2026-11-02')), '2026-11-02').usMonthly).toBeNull();
});
