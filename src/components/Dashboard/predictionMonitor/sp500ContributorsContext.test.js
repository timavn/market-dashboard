import { currentSp500Contributors, currentSp500ContributorQuote } from './sp500ContributorsContext';

const NOW = Date.parse('2026-09-14T21:30:00Z');
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const snapshot = () => ({
  status: 'available', asOf: '2026-09-11', fetchedAt: new Date(NOW).toISOString(),
  source: 'State Street / S&P Dow Jones Indices', sourceUrl: 'https://www.ssga.com/spy',
  rows: ['NVDA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'AVGO', 'BRK.B', 'META', 'LLY', 'TSLA'].map((ticker, index) => ({
    ticker, weightPct: 10 - index,
    marketCap: { status: 'available', value: 5e12, currency: 'USD', source: 'Nasdaq', sourceUrl: 'https://api.nasdaq.com/summary', fetchedAt: new Date(NOW).toISOString(), timestampKind: 'retrieved' },
    quote: { status: 'last-close', price: 200, changePercent: -1.2, asOf: '2026-09-14T20:00:00Z', marketDate: '2026-09-14', source: 'Nasdaq', sourceUrl: 'https://api.nasdaq.com/info' },
  })),
});

test('sorts by verified company market cap independently of index weight without mutating source', () => {
  const input = snapshot();
  const caps = { NVDA: 5e12, AAPL: 4e12, MSFT: 3e12, AMZN: 2e12, GOOGL: 6e12, AVGO: 1.5e12, 'BRK.B': 1.1e12, META: 1.25e12, LLY: 1e12, TSLA: 9e11 };
  input.rows.forEach((row) => { row.marketCap.value = caps[row.ticker]; });
  input.rows.reverse();
  freeze(input);
  const original = JSON.stringify(input);
  const result = currentSp500Contributors(input, NOW);
  expect(result.rows.map((row) => row.ticker)).toEqual(['GOOGL', 'NVDA', 'AAPL', 'MSFT', 'AMZN', 'AVGO', 'META', 'BRK.B', 'LLY', 'TSLA']);
  expect(result.rows.map((row) => row.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(result.rows[0]).toMatchObject({ rank: 1, weightPct: 6, marketCap: { value: 6e12, timestampKind: 'retrieved' }, quote: { status: 'last-close', changePercent: -1.2 } });
  expect(result.rows[7]).toMatchObject({ ticker: 'BRK.B', weightPct: 4, marketCap: { value: 1.1e12 } });
  expect(result.asOf).toBe('2026-09-11');
  expect(JSON.stringify(input)).toBe(original);
});

test('breaks market-cap ties by index weight and exact ticker consistently across source order', () => {
  const input = snapshot();
  input.rows.forEach((row) => {
    if (['GOOGL', 'BRK.B'].includes(row.ticker)) {
      row.marketCap.value = 6e12;
      row.weightPct = 6;
    }
  });
  const result = currentSp500Contributors(input, NOW);
  const reversed = currentSp500Contributors({ ...input, rows: [...input.rows].reverse() }, NOW);
  expect(result.rows.map((row) => row.ticker)).toEqual(['BRK.B', 'GOOGL', 'NVDA', 'AAPL', 'MSFT', 'AMZN', 'AVGO', 'META', 'LLY', 'TSLA']);
  expect(reversed.rows.map((row) => row.ticker)).toEqual(result.rows.map((row) => row.ticker));
});

const withMomo = (input = snapshot(), tickers = ['SNOW', 'NFLX']) => ({
  ...input,
  momoPublicationDate: '2026-09-14',
  momoSnapshot: {
    date: '2026-09-14', snapshotType: 'momo-tracker',
    meta: { stockCount: 8 },
    data: Object.fromEntries([...tickers, 'MSFT', 'AAPL', 'AMZN', 'META', 'GOOGL', 'NVDA'].map((ticker) => [ticker, {
      buyTrade: 100, sellTrade: 110, upside: 5, downside: -5, trend: 'BULLISH', rangeStatus: 'available',
    }])),
  },
});

test('sorts dynamic current MOMO supplements by cap after the ten companies without invented ranks or weights', () => {
  const input = withMomo();
  input.supplementalRows = ['SNOW', 'NFLX'].map((ticker, index) => ({
    ...input.rows[0], ticker, name: ticker, weightPct: 99, rank: 1,
    marketCap: { ...input.rows[0].marketCap, value: (index + 1) * 1e11 },
  }));
  freeze(input);
  const result = currentSp500Contributors(input, NOW);
  expect(result.rows.map((row) => row.ticker)).toEqual(input.rows.map((row) => row.ticker));
  expect(result.rows).toHaveLength(10);
  expect(result.supplementalRows.map((row) => row.ticker)).toEqual(['NFLX', 'SNOW']);
  expect(result.supplementalRows[0]).toEqual({
    ticker: 'NFLX', name: 'NFLX', marketCap: input.supplementalRows[1].marketCap, quote: input.rows[0].quote,
  });
  expect(result.supplementalRows[0]).not.toHaveProperty('weightPct');
  expect(result.supplementalRows[0]).not.toHaveProperty('rank');
  expect(currentSp500Contributors(snapshot(), NOW).supplementalRows).toEqual([]);
});

test('rejects extras outside the current verified publication, duplicates, ranked names and GOOG', () => {
  const input = withMomo();
  input.supplementalRows = ['OTHER', 'SNOW', 'NVDA', 'GOOG'].map((ticker) => ({ ...input.rows[0], ticker }));
  expect(currentSp500Contributors(input, NOW).supplementalRows.map((row) => row.ticker)).toEqual(['SNOW']);
  input.supplementalRows.push({ ...input.rows[0], ticker: 'SNOW' });
  expect(currentSp500Contributors(input, NOW).supplementalRows).toEqual([]);
  input.supplementalRows.pop();
  input.rows[0].ticker = 'SNOW';
  expect(currentSp500Contributors(input, NOW).supplementalRows.map((row) => row.ticker)).toEqual(['NVDA']);
  input.rows[0].ticker = 'GOOG';
  expect(currentSp500Contributors(input, NOW)).toBeNull();
});

test.each(['offline', 'disconnected', 'stale', 'mock', 'seeded', 'cacheOnly', 'fromCache', 'refreshFailed', 'modelOnly', 'portfolioDerived', 'costBasisDerived'])('rejects %s supplemental rows and independently removes their flagged data', (flag) => {
  const input = withMomo();
  input.supplementalRows = [{ ...input.rows[0], ticker: 'SNOW', [flag]: true }];
  expect(currentSp500Contributors(input, NOW).supplementalRows).toEqual([]);
  delete input.supplementalRows[0][flag];
  input.supplementalRows[0].marketCap[flag] = true;
  input.supplementalRows[0].quote[flag] = true;
  expect(currentSp500Contributors(input, NOW).supplementalRows).toEqual([
    { ticker: 'SNOW', name: 'SNOW', marketCap: null, quote: null },
  ]);
});

test.each(['offline', 'disconnected', 'stale', 'mock', 'seeded', 'cacheOnly', 'fromCache', 'refreshFailed'])('rejects supplemental membership from a %s MOMO publication', (flag) => {
  const input = withMomo();
  input.supplementalRows = [{ ...input.rows[0], ticker: 'SNOW' }];
  input.momoSnapshot[flag] = true;
  expect(currentSp500Contributors(input, NOW).supplementalRows).toEqual([]);
  expect(currentSp500Contributors(input, NOW).rows).toHaveLength(10);
});

test('removes aged and unverified supplemental fundamentals and quotes, and expires old publication membership', () => {
  const input = withMomo();
  input.supplementalRows = [{ ...input.rows[0], ticker: 'SNOW' }];
  input.supplementalRows[0].marketCap.fetchedAt = new Date(NOW - 21 * 60_000).toISOString();
  input.supplementalRows[0].quote.sourceUrl = 'https://nasdaq.com.example.org/info';
  expect(currentSp500Contributors(input, NOW).supplementalRows).toEqual([
    { ticker: 'SNOW', name: 'SNOW', marketCap: null, quote: null },
  ]);
  expect(currentSp500Contributors({ ...input, status: 'unavailable' }, NOW)).toBeNull();
  input.momoSnapshot.date = '2026-09-11';
  expect(currentSp500Contributors(input, NOW).supplementalRows).toEqual([]);
});

test('accepts unknown index weights without converting them into zero or changing company ranks', () => {
  const input = snapshot();
  input.rows[0].weightPct = null;
  input.rows[0].marketCap.value = 6e12;
  const result = currentSp500Contributors(input, NOW);
  expect(result.rows[0]).toMatchObject({ ticker: 'NVDA', rank: 1, weightPct: null });
  expect(result.rows).toHaveLength(10);
  input.rows[0].weightPct = -1;
  expect(currentSp500Contributors(input, NOW)).toBeNull();
});

test('puts unavailable market caps after verified caps without inferring a cap from weight or price', () => {
  const input = snapshot();
  input.rows[0].marketCap = { ...input.rows[0].marketCap, value: 99e12, stale: true };
  input.rows[1].marketCap = null;
  const result = currentSp500Contributors(input, NOW);
  expect(result.rows.slice(-2).map((row) => row.ticker)).toEqual(['NVDA', 'AAPL']);
  expect(result.rows[0].ticker).toBe('MSFT');
  expect(result.rows.slice(-2).map((row) => row.marketCap)).toEqual([null, null]);
  expect(result.rows.slice(-2).map((row) => row.weightPct)).toEqual([10, 9]);
  expect(result.rows.slice(-2).every((row) => row.quote.price === 200)).toBe(true);
});

test.each(['offline', 'disconnected', 'stale', 'mock', 'seeded', 'cacheOnly', 'fromCache', 'refreshFailed'])('rejects %s source snapshots and independently removes flagged caps/quotes', (flag) => {
  expect(currentSp500Contributors({ ...snapshot(), [flag]: true }, NOW)).toBeNull();
  const input = snapshot();
  input.rows[0].marketCap[flag] = true;
  input.rows[0].quote[flag] = true;
  const result = currentSp500Contributors(input, NOW);
  expect(result.rows[9]).toMatchObject({ ticker: 'NVDA', marketCap: null, quote: null });
  expect(result.rows[1].marketCap.value).toBe(5e12);
});

test('rejects incomplete, duplicate, old and unverified index composition', () => {
  expect(currentSp500Contributors({ ...snapshot(), rows: snapshot().rows.slice(1) }, NOW)).toBeNull();
  const duplicate = snapshot();
  duplicate.rows[1].ticker = duplicate.rows[0].ticker;
  expect(currentSp500Contributors(duplicate, NOW)).toBeNull();
  expect(currentSp500Contributors({ ...snapshot(), asOf: '2026-09-10' }, NOW)).toBeNull();
  expect(currentSp500Contributors({ ...snapshot(), sourceUrl: 'https://ssga.com.example.org' }, NOW)).toBeNull();
  expect(currentSp500Contributors({ ...snapshot(), fetchedAt: new Date(NOW - 21 * 60_000).toISOString() }, NOW)).toBeNull();
});

test('accepts dated official close over the weekend, removes it at next open, and does not accept an old session at today close', () => {
  const fridayClose = { ...snapshot().rows[0].quote, marketDate: '2026-09-11', asOf: '2026-09-11T20:00:00Z' };
  expect(currentSp500ContributorQuote(fridayClose, Date.parse('2026-09-12T17:00:00Z'))).toMatchObject({ status: 'last-close' });
  expect(currentSp500ContributorQuote(fridayClose, Date.parse('2026-09-14T13:29:00Z'))).toMatchObject({ status: 'last-close' });
  expect(currentSp500ContributorQuote(fridayClose, Date.parse('2026-09-14T13:30:00Z'))).toBeNull();
  expect(currentSp500ContributorQuote(fridayClose, NOW)).toBeNull();
});

test('keeps live and delayed quote lifetimes distinct, and drops either when the session closes', () => {
  const now = Date.parse('2026-09-14T18:00:00Z');
  const quote = { ...snapshot().rows[0].quote, status: 'live', asOf: new Date(now - 60_000).toISOString() };
  expect(currentSp500ContributorQuote(quote, now)?.status).toBe('live');
  expect(currentSp500ContributorQuote(quote, now + 1)).toBeNull();
  expect(currentSp500ContributorQuote({ ...quote, status: 'delayed' }, now + 60_000)?.status).toBe('delayed');
  expect(currentSp500ContributorQuote({ ...quote, status: 'delayed' }, now + 21 * 60_000)).toBeNull();
  expect(currentSp500ContributorQuote(quote, NOW)).toBeNull();
});
