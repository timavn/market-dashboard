import catalog from '../constants/marketRotationCatalog.json';
import { buildMarketDailyDetail, formatMarketDailyTime } from './marketDailyNarrative';

const NOW = Date.parse('2026-09-24T14:45:00.000Z');
const AS_OF = '2026-09-24T14:40:00.000Z';
const EXPIRES = '2026-09-24T15:00:00.000Z';
const quote = (ticker, changePercent, fields = {}) => ({
  ticker, name: `${ticker} company`, changePercent, asOf: AS_OF, expiresAt: EXPIRES,
  status: 'delayed', marketDate: '2026-09-24', delayedSource: true,
  source: 'Yahoo Finance', sourceUrl: `https://finance.yahoo.com/quote/${ticker}`,
  ...fields,
});
const daily = (fields = {}) => ({
  status: 'available', asOf: AS_OF, expiresAt: EXPIRES,
  source: 'State Street / Yahoo Finance', sourceUrl: 'https://www.ssga.com',
  universe: { label: 'S&P 500 · SPY', count: 503, asOf: '2026-09-23' },
  coverage: { quotes: 503, total: 503, history50: 503, history200: 501, year: 499, intradayVolume: 503, intradayGain: 503, reversalComparisons: 503, sectorComparisons: 503 },
  breadth: { advancing: 306, declining: 190, unchanged: 7, medianReturn: 0.42, above50Pct: 63, above200Pct: 71, newHighs: 22, newLows: 9 },
  winners: [quote('AAA', 8.15), quote('BBB', 5.84), quote('CCC', 4.03)],
  losers: [quote('DDD', -6.91), quote('EEE', -5.11), quote('FFF', -4.66)],
  leadership: {
    leadingSector: quote('XLI', 1.21, { name: 'Industrials ETF' }),
    laggingSector: quote('XLP', -0.51, { name: 'Consumer staples ETF' }),
    lift: quote('AAA', 8.15, { contributionPp: 0.11 }),
    drag: quote('DDD', -6.91, { contributionPp: -0.04 }),
  },
  outliers: {
    relativeVolume: quote('AAA', 8.15, { ratio: 3.2, cutoff: '2026-09-24T14:30:00.000Z' }),
    unusualGain: quote('BBB', 5.84, { sessions: 40 }),
    reversal: quote('CCC', 4.03, { gapPercent: -1.75 }),
    againstSector: quote('FFF', -4.66, { sectorName: 'Industrials ETF', sectorChangePercent: 1.21 }),
  },
  ...fields,
});
const rotationQuote = (ticker, changePercent, fields = {}) => quote(ticker, changePercent, {
  ...[...catalog.themes, ...catalog.instruments].find(item => item.ticker === ticker), proxy: true, ...fields,
});
const rotation = () => ({
  status: 'available', source: 'Yahoo Finance', proxy: true, asOf: AS_OF, expiresAt: EXPIRES,
  themes: {
    software: rotationQuote('IGV', 1.25), semiconductors: rotationQuote('SMH', -0.65),
    leader: rotationQuote('URA', 2.4), laggard: rotationQuote('TAN', -2.1),
    coverage: { verified: 10, total: 10, comparable: true, expiresAt: EXPIRES },
  },
  factors: catalog.factors.map((definition, index) => ({
    id: definition.id, label: definition.label, left: rotationQuote(definition.left, index === 0 ? 1.2 : -0.2),
    right: rotationQuote(definition.right, 0.4), spreadPp: index === 0 ? 0.8 : -0.6,
    asOf: AS_OF, expiresAt: EXPIRES, status: 'delayed', marketDate: '2026-09-24', source: 'Yahoo Finance', proxy: true,
  })),
});
const detail = (section, snapshot = daily(), rotated = rotation()) => buildMarketDailyDetail(section, snapshot, rotated, NOW);

test('orders expanded breadth from daily participation and dispersion to trend confirmation', () => {
  const result = detail('breadth');
  expect(result.groups.map(group => group.id)).toEqual(['participation', 'trend']);
  expect(result.groups.flatMap(group => group.rows.map(row => row.id))).toEqual(['advances', 'large-moves', 'median', 'return-range', 'average-50', 'average-200', 'extremes']);
  expect(result.groups[0].narrative).toMatch(/extends beyond the largest index weights/);
  expect(result.groups[1].narrative).toMatch(/majority of the eligible constituents are above each/);
  expect(result.groups[0].tickers).toEqual(['SPY']);
  expect(result.groups[0].rows[0].valueParts).toEqual([
    { text: '306', tone: 'positive' }, { text: ' / ', tone: 'neutral' }, { text: '190', tone: 'negative' },
  ]);
  expect(result.groups[1].rows[1].detail).toContain('501 / 503 holdings');
  expect(result.status).toBe('DELAYED');
  expect(result.marketDate).toBe('2026-09-24');
  expect(result.groups[0].rows[0].detail).toContain('Sep 24 10:40 ET');
  expect(result.methodology).toContain('SPY equity holdings proxy');
});

test('narrative follows a negative observation and incomplete counts never shrink the denominator', () => {
  const data = daily();
  data.breadth = { ...data.breadth, advancing: 190, declining: 306, medianReturn: -0.42, above50Pct: 40, above200Pct: 35 };
  expect(detail('breadth', data).groups[0].narrative).toContain('Weakness extends');
  expect(detail('breadth', data).groups[1].narrative).toContain('below each moving average');
  data.coverage.quotes = 499;
  const incomplete = detail('breadth', data);
  expect(incomplete.groups[0].rows.map(row => row.value)).toEqual(['— / —', '— / —', '—', '— to —']);
  expect(incomplete.groups[0].narrative).toBe('');
  expect(incomplete.methodology).toContain('499 / 503');
});

test('separates sector dispersion from SPY-weight contribution', () => {
  const result = detail('leadership');
  expect(result.groups.map(group => group.id)).toEqual(['sectors', 'contribution']);
  expect(result.groups[0].narrative).toContain('1.72 percentage points');
  expect(result.groups[1].narrative).toContain("AAA's lift outweighs DDD's drag");
  expect(result.groups[1].rows[0].value).toBe('+0.11 pp');
  expect(result.groups[1].rows[0].detail).toContain('estimated fund contribution');
  expect(result.groups[0].tickers).toEqual(['XLI', 'XLP']);
});

test('interweaves technology participation and a complete theme ranking with real issuer evidence', () => {
  const result = detail('themes');
  expect(result.groups.map(group => group.id)).toEqual(['technology', 'rotation']);
  expect(result.groups[0].narrative).toContain('not moving together');
  expect(result.groups[1].narrative).toContain('4.50 percentage points');
  expect(result.groups[1].narrative).toContain('complete 10-ETF roster');
  expect(result.tickers).toEqual(['IGV', 'SMH', 'URA', 'TAN']);
  expect(result.groups[0].rows[0].sources).toEqual(expect.arrayContaining([
    { label: 'Yahoo Finance', url: 'https://finance.yahoo.com/quote/IGV' },
    { label: 'IGV issuer', url: catalog.themes[0].issuerUrl },
  ]));
});

test('does not narrate incomplete theme ranks or pair spreads with a missing leg', () => {
  const data = rotation();
  data.themes.coverage.verified = 9;
  data.factors[0].right = null;
  const themes = detail('themes', null, data);
  expect(themes.groups[0].rows[0].value).toBe('+1.25%');
  expect(themes.groups[1].rows.map(row => row.value)).toEqual(['—', '—']);
  expect(themes.groups[1].narrative).toBe('');
  const factors = detail('factors', null, data);
  expect(factors.groups[0].rows[0].value).toBe('—');
  expect(factors.groups[0].narrative).not.toContain('Growth');
  expect(factors.groups[1].rows[1].value).toBe('-0.60 pp');
});

test('factor narrative follows the direction of each ETF spread and preserves leg observations', () => {
  const result = detail('factors');
  expect(result.groups[0].narrative).toContain('Growth is outperforming value');
  expect(result.groups[0].narrative).toContain('S&P 500 is outperforming momentum');
  expect(result.groups[1].narrative).toContain('Low volatility is outperforming high beta');
  expect(result.groups[1].narrative).toContain('S&P 500 is outperforming small caps');
  expect(result.groups[0].rows[0].detail).toContain('IWF: +1.20%');
  expect(result.groups[0].rows[0].detail).toContain('IWD: +0.40%');
  expect(result.groups[0].tickers).toEqual(['IWF', 'IWD', 'MTUM', 'SPY']);
  expect(result.groups[1].narrative).not.toContain('The spreads compare');
  const data = rotation();
  data.factors[1].left.changePercent = 1.4;
  data.factors[1].spreadPp = 1;
  expect(detail('factors', null, data).groups[0].narrative).toContain('Momentum is outperforming S&P 500');
});

test('keeps all three winners and losers, with complete security names and rank interpretation', () => {
  const result = detail('movers');
  expect(result.groups.map(group => group.rows.length)).toEqual([3, 3]);
  expect(result.groups[0].rows[0]).toMatchObject({ ticker: 'AAA', name: 'AAA company', value: '+8.15%', tone: 'positive' });
  expect(result.groups[1].rows[0]).toMatchObject({ ticker: 'DDD', value: '-6.91%', tone: 'negative' });
  expect(result.groups[1].narrative).toContain('largest decline');
});

test('outliers distinguish same-time activity and price divergence without inferring a cause', () => {
  const result = detail('outliers');
  expect(result.groups[0].rows[0].detail).toContain('Comparison through Sep 24 10:30 ET');
  expect(result.groups[0].rows[0].value).toBe('3.2× usual');
  expect(result.groups[2].rows[0].value).toBe('-1.75% → +4.03%');
  expect(result.groups[2].rows[0].valueParts).toEqual([
    { text: '-1.75%', tone: 'negative' }, { text: ' → ', tone: 'neutral' }, { text: '+4.03%', tone: 'positive' },
  ]);
  expect(result.groups[2].narrative).toContain('crossed the prior close');
  expect(result.groups[3].narrative).toContain('moving opposite Industrials ETF');
  expect(result.groups[1].narrative).not.toMatch(/buy|sell|catalyst|Hedgeye/);
});

test.each(['breadth', 'leadership', 'themes', 'factors', 'movers', 'outliers'])('unavailable %s retains compact rows without invented narrative', section => {
  const result = detail(section, null, null);
  expect(result.groups).toHaveLength(section === 'outliers' ? 4 : 2);
  expect(result.groups.every(group => group.narrative === '')).toBe(true);
  expect(result.groups.every(group => group.description.length > 20)).toBe(true);
  expect(result.status).toBe('UNAVAILABLE');
  expect(result.asOf).toBeNull();
  expect(result.marketDate).toBeNull();
  expect(result.sources).toEqual([]);
});

test.each([
  { stale: true }, { mock: true }, { seeded: true }, { inferred: true }, { cacheOnly: true },
  { fromCache: true }, { connected: false }, { provider: 'offline' }, { metadata: { synthetic: true } },
])('withholds all daily narratives and values for contaminated evidence: %p', flags => {
  const result = detail('breadth', daily(flags));
  expect(result.status).toBe('UNAVAILABLE');
  expect(result.groups.every(group => group.narrative === '')).toBe(true);
  expect(result.groups[0].rows[0].value).toBe('— / —');
});

test.each([{ stale: true }, { mock: true }, { seeded: true }, { cacheOnly: true }, { connected: false }])('rejects a contaminated theme without removing independent valid factor pairs: %p', flags => {
  const data = rotation();
  Object.assign(data.themes.software, flags);
  expect(detail('themes', null, data).groups[0].narrative).toBe('');
  expect(detail('themes', null, data).groups[0].rows[0].value).toBe('—');
  expect(detail('factors', null, data).groups[0].narrative).toContain('Growth is outperforming');
});

test('row provenance is required before identifying a winner', () => {
  const data = daily();
  data.winners = [quote('AAA', 99, { sourceUrl: null })];
  const result = detail('movers', data);
  expect(result.groups[0].rows[0].value).toBe('—');
  expect(result.groups[0].narrative).toBe('');
});

test('preserves rank slots and does not promote a second-place mover when the leading observation is invalid', () => {
  const data = daily();
  data.winners[0].sourceUrl = null;
  const result = detail('movers', data);
  expect(result.groups[0].rows[0].value).toBe('—');
  expect(result.groups[0].rows[1].ticker).toBe('BBB');
  expect(result.groups[0].narrative).toBe('');
});

test.each([
  { marketDate: '2026-09-23' }, { status: 'last-close' }, { asOf: '2026-09-24T14:00:00Z' },
])('keeps individual theme observations but withholds a combined claim when observations are incomparable: %p', overrides => {
  const data = rotation();
  Object.assign(data.themes.semiconductors, overrides);
  const result = detail('themes', null, data);
  expect(result.groups[0].rows[0].value).toBe('+1.25%');
  expect(result.groups[0].rows[1].value).toBe('-0.65%');
  expect(result.groups[0].narrative).toBe('');
});

test('withholds sector dispersion when the sectors have different observation sessions', () => {
  const data = daily();
  data.leadership.laggingSector.marketDate = '2026-09-23';
  const result = detail('leadership', data);
  expect(result.groups[0].rows[1].value).toBe('-0.51%');
  expect(result.groups[0].narrative).toBe('');
  expect(result.marketDate).toBeNull();
});

test('does not directly compare trend breadth across different eligible denominators', () => {
  const data = daily();
  data.breadth.above50Pct = 45;
  data.breadth.above200Pct = 60;
  expect(detail('breadth', data).groups[1].narrative).toContain('different eligible histories');
  data.coverage.history200 = data.coverage.history50;
  expect(detail('breadth', data).groups[1].narrative).toContain('shorter-term participation is weaker');
});

test('last-close display is delayed while retaining the source session date and original observation', () => {
  const data = daily();
  [...data.winners, ...data.losers, ...Object.values(data.leadership), ...Object.values(data.outliers)].forEach(row => {
    row.status = 'last-close'; row.marketDate = '2026-09-23'; row.asOf = '2026-09-23T20:00:00Z';
  });
  data.asOf = '2026-09-23T20:00:00Z';
  const result = detail('leadership', data);
  expect(result.status).toBe('DELAYED');
  expect(result.marketDate).toBe('2026-09-23');
  expect(result.groups[0].rows[0].detail).toContain('DELAYED · Sep 23 16:00 ET · DELAYED SOURCE');
  expect(result.groups[0].rows[0].detail).not.toContain('Sep 24');
});

test('formats dates and times consistently and does not synthesize a market date from the clock', () => {
  expect(formatMarketDailyTime(AS_OF)).toBe('Sep 24 10:40 ET');
  expect(formatMarketDailyTime('2026-09-24')).toBe('Sep 24');
  expect(formatMarketDailyTime(null)).toBe('');
  expect(detail('themes', null, null).marketDate).toBeNull();
  expect(detail('unknown')).toBeNull();
});


test('expanded outliers include every verified security in research and retain each category baseline', () => {
  const data = daily({ outlierDetails: {
    relativeVolume: [quote('AAA', 8.15, { ratio: 3.2 }), quote('GGG', -2, { ratio: 2.4 })],
    unusualGain: [quote('BBB', 5.84, { sessions: 40 })],
    reversal: [quote('CCC', 4.03, { gapPercent: -1.75 }), quote('HHH', -2, { gapPercent: 1 })],
    againstSector: [quote('FFF', -4.66, { sectorChangePercent: 1.21, sectorName: 'Industrials ETF' })],
  } });
  const result = detail('outliers', data);
  expect(result.groups.map(group => group.rows.length)).toEqual([2, 1, 2, 1]);
  expect(result.tickers).toEqual(['AAA', 'GGG', 'BBB', 'CCC', 'HHH', 'FFF']);
  expect(result.groups[0].narrative).toContain('AAA and GGG recorded');
  expect(result.groups[2].rows[1]).toMatchObject({ ticker: 'HHH', value: '+1.00% → -2.00%', changePercent: -2 });
  expect(result.groups[3].rows[0]).toMatchObject({ ticker: 'FFF', value: '-4.66% / +1.21%', changePercent: -4.66 });
  expect(result.sources).toContainEqual({ label: 'Yahoo Finance', url: 'https://finance.yahoo.com/quote/GGG' });
  expect(result.methodology).toContain('a security can qualify in more than one category');
});

test('empty expanded categories never revive headline rows or invent additional qualifiers', () => {
  const result = detail('outliers', daily({ outlierDetails: { relativeVolume: [], unusualGain: [], reversal: [], againstSector: [] } }));
  expect(result.tickers).toEqual([]);
  expect(result.groups.every(group => group.rows.length === 1 && !group.rows[0].ticker && !group.narrative)).toBe(true);
});

test('expanded outliers retain expired verified observations and withhold unproven or nonqualifying readings', () => {
  const result = detail('outliers', daily({ outlierDetails: {
    relativeVolume: [quote('AAA', 1, { ratio: 3, expiresAt: '2026-09-24T14:44:00Z' }), quote('BBB', 2, { ratio: 3, sourceUrl: null }), quote('CCC', 2, { ratio: 1.9 })],
    unusualGain: [quote('DDD', 2, { sessions: 20 })],
    reversal: [quote('EEE', 2, { gapPercent: 1 })],
    againstSector: [quote('FFF', 2, { sectorChangePercent: 1 })],
  } }));
  expect(result.tickers).toEqual(['AAA']);
  expect(result.groups[0].rows[0]).toMatchObject({ retained: true, value: '3.0× usual' });
  expect(result.groups.slice(1).every(group => !group.narrative)).toBe(true);
});

test.each([{ offline: true }, { stale: true }, { mock: true }, { seeded: true }, { cacheOnly: true }])('rejects contaminated expanded outlier evidence: %p', flags => {
  const result = detail('outliers', daily({ outlierDetails: { relativeVolume: [quote('AAA', 2, { ratio: 3, ...flags })] } }));
  expect(result.status).toBe('UNAVAILABLE');
  expect(result.tickers).toEqual([]);
});


test('expanded breadth shows meaningful move counts and the middle return range only for complete valid evidence', () => {
  const data = daily();
  Object.assign(data.breadth, { upOnePercent: 70, downOnePercent: 55, lowerQuartileReturn: -0.8, upperQuartileReturn: 1.1 });
  let result = detail('breadth', data);
  expect(result.groups[0].rows[1].value).toBe('70 / 55');
  expect(result.groups[0].rows[3].value).toBe('-0.80% to +1.10%');
  expect(result.groups[0].rows[3].detail).toContain('linear interpolation');
  expect(result.groups[1].rows[0].value).toBe('63%');
  expect(result.groups[1].rows[1].value).toBe('71%');
  data.coverage.quotes = 502;
  result = detail('breadth', data);
  expect(result.groups[0].rows[1].value).toBe('— / —');
  expect(result.groups[0].rows[3].value).toBe('— to —');
  data.coverage.quotes = 503;
  data.breadth.upOnePercent = 504;
  data.breadth.lowerQuartileReturn = 5;
  result = detail('breadth', data);
  expect(result.groups[0].rows[1].value).toBe('— / —');
  expect(result.groups[0].rows[3].value).toBe('— to —');
});

test('leadership displays both sides of sector and contribution ranks with source coverage', () => {
  const data = daily();
  data.leadershipDetails = {
    leadingSectors: [data.leadership.leadingSector, quote('XLE', 0.9)],
    laggingSectors: [data.leadership.laggingSector, quote('XLK', -0.2)],
    lifts: [data.leadership.lift, quote('GGG', 1.5, { contributionPp: 0.06 })],
    drags: [data.leadership.drag, quote('HHH', -1, { contributionPp: -0.02 })],
    sectorParticipation: { advancing: 8, declining: 3, unchanged: 0, total: 11 },
  };
  const result = detail('leadership', data);
  expect(result.groups.map(group => group.rows.length)).toEqual([4, 4]);
  expect(result.groups[0].narrative).toContain('8 of 11 sectors');
  expect(result.groups[1].rows.map(row => row.value)).toEqual(['+0.11 pp', '+0.06 pp', '-0.04 pp', '-0.02 pp']);
  expect(result.tickers).toEqual(['XLI', 'XLE', 'XLP', 'XLK', 'AAA', 'GGG', 'DDD', 'HHH']);
  data.leadershipDetails.lifts[1].expiresAt = '2026-09-24T14:44:00Z';
  expect(detail('leadership', data).groups[1].rows[1]).toMatchObject({ value: '+0.06 pp', retained: true });
});

test('movers expand to five per side without reviving compact rows for empty details', () => {
  const data = daily();
  data.moverDetails = {
    winners: [...data.winners, quote('GGG', 3), quote('HHH', 2)],
    losers: [...data.losers, quote('III', -3), quote('JJJ', -2)],
  };
  const result = detail('movers', data);
  expect(result.groups.map(group => group.rows.length)).toEqual([5, 5]);
  expect(result.groups[0].narrative).toContain('+8.15% to +2.00%');
  expect(result.tickers).toContain('JJJ');
  data.moverDetails.winners = [];
  expect(detail('movers', data).groups[0].rows[0].value).toBe('—');
  expect(detail('movers', data).groups[0].narrative).toBe('');
});

test('expanded themes keep six distinct ETFs including technology and both ends of remaining rotation', () => {
  const data = rotation();
  const changes = { IGV: 1.25, SMH: -0.65, URA: 2.4, TAN: -2.1, CIBR: 1.4, SKYY: 0.8, XBI: 0.1, KRE: -1.2, ITB: -0.2, XRT: -0.8 };
  data.themes.ranked = catalog.themes.map(row => rotationQuote(row.ticker, changes[row.ticker])).sort((a, b) => b.changePercent - a.changePercent);
  const result = detail('themes', null, data);
  expect(result.groups.map(group => group.rows.length)).toEqual([2, 4]);
  expect(result.tickers).toEqual(['IGV', 'SMH', 'URA', 'CIBR', 'TAN', 'KRE']);
  expect(result.groups[1].narrative).toContain('5 of 10 themes are higher');
  data.themes.ranked[1].mock = true;
  const rejected = detail('themes', null, data);
  expect(rejected.groups[1].rows.every(row => row.value === '—')).toBe(true);
  expect(rejected.groups[1].narrative).toBe('');
});

test('factor details show each independently verified ETF return while withholding an invalid spread', () => {
  const data = rotation();
  const result = detail('factors', null, data);
  expect(result.groups[0].rows[0].legs).toEqual([
    expect.objectContaining({ ticker: 'IWF', value: '+1.20%', tone: 'positive' }),
    expect.objectContaining({ ticker: 'IWD', value: '+0.40%', tone: 'positive' }),
  ]);
  data.factors[0].right.stale = true;
  const invalid = detail('factors', null, data).groups[0].rows[0];
  expect(invalid.value).toBe('—');
  expect(invalid.legs[0].value).toBe('+1.20%');
  expect(invalid.legs[1].value).toBe('—');
});


test.each(['breadth', 'leadership', 'movers', 'outliers'])('expired verified %s stays readable with its original observation', section => {
  const source = daily({ expiresAt: '2026-09-24T14:44:59Z' });
  const result = detail(section, source);
  expect(result.status).toBe('DELAYED');
  expect(result.asOf).toBe(AS_OF);
  expect(result.groups.some(group => group.rows.some(row => row.value !== '—'))).toBe(true);
  expect(result.groups.flatMap(group => group.rows).filter(row => row.value !== '—')
    .every(row => row.retained && row.detail.includes('DELAYED') && row.asOf === AS_OF)).toBe(true);
});
