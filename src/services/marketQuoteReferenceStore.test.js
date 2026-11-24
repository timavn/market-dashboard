const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createMarketQuoteReferenceStore,
} = require('./marketQuoteReferenceStore.cjs');

const verifiedRow = (overrides = {}) => ({
  symbol: 'SPX',
  name: 'S&P 500',
  price: 7737.7,
  changePercent: 0.13,
  source: 'yahoo',
  dataType: 'delayed',
  availability: 'delayed',
  timestamp: '2026-09-04T17:00:25.000Z',
  quoteAsOf: '2026-09-04T17:00:25.000Z',
  ...overrides,
});

describe('marketQuoteReferenceStore', () => {
  let dataDir;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-quote-reference-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('rehydrates a dated, non-executable quote across a server restart', () => {
    const now = () => Date.parse('2026-09-04T17:01:00.000Z');
    const first = createMarketQuoteReferenceStore({ dataDir, now });
    expect(first.reconcileRows({
      mode: 'current',
      scope: 'us',
      incomingRows: [verifiedRow()],
      expectedSymbols: ['SPX'],
    })[0]).toEqual(expect.objectContaining({ availability: 'delayed' }));
    expect(first.flush()).toBe(true);

    const restarted = createMarketQuoteReferenceStore({ dataDir, now });
    const retained = restarted.reconcileRows({
      mode: 'current',
      scope: 'us',
      incomingRows: [],
      expectedSymbols: ['SPX'],
    });

    expect(retained).toEqual([expect.objectContaining({
      symbol: 'SPX', price: 7737.7, changePercent: 0.13,
      availability: 'reference', displayDelayed: true, displayOnly: true, executable: false,
      quoteAsOf: '2026-09-04T17:00:25.000Z', lastVerifiedAt: '2026-09-04T17:00:25.000Z',
    })]);
    expect(fs.existsSync(first.filePath)).toBe(true);
  });

  test('a stored quote priced off a wide, untraded book gives way to an older verified close', () => {
    const now = () => Date.parse('2026-11-24T03:50:00.000Z');
    const store = createMarketQuoteReferenceStore({ dataDir, now });
    const book = verifiedRow({ symbol: 'UUP', source: 'ibkr', dataType: 'live', availability: 'current', secType: 'STK',
      price: 32, mark: 32.005, mid: 32.005, bid: 29.6, ask: 34.41, last: null, changePercent: 7.47,
      timestamp: '2026-11-24T03:46:58.175Z', quoteAsOf: '2026-11-24T03:46:58.175Z' });
    expect(store.reconcileRows({ scope: 'currencies', incomingRows: [book], expectedSymbols: ['UUP'] })).toEqual([]);
    const close = verifiedRow({ symbol: 'UUP', price: 29.94, changePercent: 0.54,
      timestamp: '2026-11-23T21:00:00.000Z', quoteAsOf: '2026-11-23T21:00:00.000Z' });
    expect(store.reconcileRows({ scope: 'currencies', incomingRows: [close], expectedSymbols: ['UUP'] })[0])
      .toEqual(expect.objectContaining({ price: 29.94, changePercent: 0.54, availability: 'delayed' }));
    // A tight book with no last trade is still a price.
    const tight = { ...book, bid: 29.93, ask: 29.95, price: 29.94, mark: 29.94, mid: 29.94, changePercent: 0.54 };
    expect(store.reconcileRows({ scope: 'currencies', incomingRows: [tight], expectedSymbols: ['UUP'] })[0])
      .toEqual(expect.objectContaining({ source: 'ibkr', price: 29.94 }));
  });

  test('keeps omitted assets through repeated partial responses and replaces them on recovery', () => {
    let time = Date.parse('2026-09-04T17:01:00.000Z');
    const store = createMarketQuoteReferenceStore({ dataDir, now: () => time });
    const spx = verifiedRow();
    const russell = verifiedRow({ symbol: 'RUT', changePercent: -0.5 });
    const csi = verifiedRow({ symbol: 'CSI300', changePercent: 0.75 });
    const reconcile = (incomingRows) => store.reconcileRows({ scope: 'test',
      incomingRows, expectedSymbols: ['SPX', 'RUT', 'CSI300', 'MISSING'] });
    reconcile([spx, russell, csi]);
    time += 60_000;
    const partial = reconcile([spx]);
    expect(partial.map((row) => row.symbol)).toEqual(['SPX', 'RUT', 'CSI300']);
    expect(partial.slice(1)).toEqual([
      expect.objectContaining({ symbol: 'RUT', changePercent: -0.5, availability: 'reference', executable: false }),
      expect.objectContaining({ symbol: 'CSI300', changePercent: 0.75, availability: 'reference', executable: false }),
    ]);
    time += 60_000;
    const offline = reconcile([]);
    expect(offline.map((row) => row.quoteAsOf)).toEqual(Array(3).fill(spx.quoteAsOf));
    expect(offline.every((row) => row.displayDelayed && !row.executable)).toBe(true);
    const recovered = reconcile([verifiedRow({ symbol: 'RUT', changePercent: 1.1,
      quoteAsOf: new Date(time).toISOString(), timestamp: new Date(time).toISOString() })]);
    expect(recovered[1]).toMatchObject({ symbol: 'RUT', changePercent: 1.1, availability: 'delayed' });
    expect(recovered[1]).not.toHaveProperty('displayDelayed');
  });

  test('restores a missing quote from the newer verified period observation', () => {
    const store = createMarketQuoteReferenceStore({ dataDir });
    store.reconcileRows({ mode: 'periods', scope: 'asia', incomingRows: [verifiedRow({ symbol: 'CSI300',
      monthChangePct: 2.5, periodReturnsStatus: 'historical', periodReturnsAsOf: '2026-09-04' })] });
    const rows = store.reconcileRows({ mode: 'current', scope: 'asia', expectedSymbols: ['CSI300'] });
    expect(rows).toEqual([expect.objectContaining({ symbol: 'CSI300', monthChangePct: 2.5,
      availability: 'reference', quoteAsOf: '2026-09-04T17:00:25.000Z', executable: false })]);
  });

  test.each([
    ['SPX', '^GSPC'],
    ['RUT', '^RUT'],
  ])('persists %s native index timeframes through live quote refreshes and API restart', (symbol, seriesId) => {
    let time = Date.parse('2026-09-04T17:01:00.000Z');
    const now = () => time;
    const store = createMarketQuoteReferenceStore({ dataDir, now });
    const history = {
      fifteenDayChangePct: 1.5, monthChangePct: 2, threeMonthChangePct: -3,
      sixMonthChangePct: 4, ytdChangePct: 5, oneYearChangePct: 6,
      periodReturnsAsOf: '2026-09-03T13:30:00.000Z', periodReturnsStatus: 'historical',
      periodReturnsSource: 'yahoo', periodSourceSeriesId: seriesId,
      periodObservationFrequency: 'daily',
    };
    store.reconcileRows({ mode: 'periods', scope: 'us', incomingRows: [verifiedRow({ symbol, ...history })] });
    const quote = verifiedRow({ symbol, price: 7800, source: 'ibkr', dataType: 'live', availability: 'current',
      timestamp: new Date(time).toISOString(), quoteAsOf: new Date(time).toISOString(),
      fifteenDayChangePct: null, monthChangePct: null, threeMonthChangePct: null,
      sixMonthChangePct: null, ytdChangePct: null, oneYearChangePct: null,
      periodReturnsStatus: 'unavailable', periodReturnsAsOf: null, periodReturnsSource: null,
    });
    const [current] = store.reconcileRows({ mode: 'current', scope: 'us', incomingRows: [quote] });
    expect(current).toMatchObject({ ...quote, ...history });
    expect(current).not.toHaveProperty('displayDelayed');
    expect(store.snapshot().modes.current.us[symbol]).toMatchObject({ ...history, source: 'ibkr', quoteAsOf: quote.quoteAsOf });

    time += 60_000;
    const [failedHistory] = store.reconcileRows({ mode: 'periods', scope: 'us', incomingRows: [
      { ...quote, price: 7801, timestamp: new Date(time).toISOString(), quoteAsOf: new Date(time).toISOString() },
    ] });
    expect(failedHistory).toMatchObject({ ...history, source: 'ibkr', price: 7801 });
    expect(store.flush()).toBe(true);
    time += 500 * 24 * 60 * 60 * 1000;
    const restarted = createMarketQuoteReferenceStore({ dataDir, now });
    const [retained] = restarted.reconcileRows({ mode: 'current', scope: 'us', expectedSymbols: [symbol] });
    expect(retained).toMatchObject({ ...history, source: 'ibkr', price: 7801,
      availability: 'reference', displayDelayed: true, executable: false,
      quoteAsOf: failedHistory.quoteAsOf });
  });

  test('updates newer history independently when its attached quote is older than the current reading', () => {
    const now = () => Date.parse('2026-09-04T18:00:00.000Z');
    const store = createMarketQuoteReferenceStore({ dataDir, now });
    const current = verifiedRow({ source: 'ibkr', dataType: 'live', availability: 'current',
      price: 7800, timestamp: '2026-09-04T17:30:00.000Z', quoteAsOf: '2026-09-04T17:30:00.000Z' });
    store.reconcileRows({ mode: 'current', scope: 'us', incomingRows: [current] });
    const history = { monthChangePct: 3, periodReturnsStatus: 'historical',
      periodReturnsAsOf: '2026-09-04T13:30:00.000Z', periodReturnsSource: 'yahoo',
      periodSourceSeriesId: '^GSPC', periodObservationFrequency: 'daily' };
    const [row] = store.reconcileRows({ mode: 'periods', scope: 'us', incomingRows: [verifiedRow(history)] });
    expect(row).toMatchObject({ ...history, price: current.price, source: 'ibkr',
      quoteAsOf: current.quoteAsOf, availability: 'reference', executable: false });
    store.flush();
    const restarted = createMarketQuoteReferenceStore({ dataDir, now });
    const [restored] = restarted.reconcileRows({ scope: 'us', expectedSymbols: ['SPX'] });
    expect(restored).toMatchObject({ ...history, price: current.price, quoteAsOf: current.quoteAsOf });
  });

  test('persists partial history with each retained return on its original provider date', () => {
    const now = () => Date.parse('2026-09-04T18:00:00.000Z');
    const store = createMarketQuoteReferenceStore({ dataDir, now });
    const history = { monthChangePct: 2, oneYearChangePct: 6, periodReturnsStatus: 'historical',
      periodReturnsAsOf: '2026-09-03T13:30:00.000Z', periodReturnsSource: 'yahoo',
      periodSourceSeriesId: '^GSPC', periodObservationFrequency: 'daily' };
    store.reconcileRows({ mode: 'periods', scope: 'us', incomingRows: [verifiedRow(history)] });
    const [row] = store.reconcileRows({ mode: 'periods', scope: 'us', incomingRows: [verifiedRow({
      ...history, monthChangePct: 3, oneYearChangePct: null,
      timestamp: '2026-09-04T17:30:00.000Z', quoteAsOf: '2026-09-04T17:30:00.000Z',
      periodReturnsAsOf: '2026-09-04T13:30:00.000Z',
    })] });
    expect(row).toMatchObject({ monthChangePct: 3, oneYearChangePct: 6,
      periodReturnsAsOf: '2026-09-04T13:30:00.000Z', periodReturnProvenance: {
        oneYearChangePct: { asOf: history.periodReturnsAsOf, source: 'yahoo', sourceSeriesId: '^GSPC', retained: true },
      } });
    store.flush();
    const restarted = createMarketQuoteReferenceStore({ dataDir, now });
    const [restored] = restarted.reconcileRows({ scope: 'us', expectedSymbols: ['SPX'] });
    expect(restored).toMatchObject({ monthChangePct: 3, oneYearChangePct: 6,
      periodReturnProvenance: { oneYearChangePct: row.periodReturnProvenance.oneYearChangePct } });
  });

  test('does not copy monthly sovereign returns onto a different daily benchmark', () => {
    const now = () => Date.parse('2026-09-04T18:00:00.000Z');
    const store = createMarketQuoteReferenceStore({ dataDir, now });
    store.reconcileRows({ mode: 'periods', scope: 'rates.eu_sovereigns', incomingRows: [verifiedRow({
      symbol: 'BUND10Y', price: 2.97, source: 'fred', dataType: 'historical', availability: 'historical',
      sourceSeriesId: 'FRED_MONTHLY', observationFrequency: 'monthly', monthChangePct: 5,
      periodReturnsAsOf: '2026-08-01T00:00:00.000Z', periodReturnsStatus: 'historical',
      periodReturnsSource: 'fred', periodSourceSeriesId: 'FRED_MONTHLY', periodObservationFrequency: 'monthly',
    })] });
    const incoming = verifiedRow({ symbol: 'BUND10Y', price: 3.1, source: 'bundesbank',
      dataType: 'historical', availability: 'historical', sourceSeriesId: 'OFFICIAL_DAILY',
      observationFrequency: 'daily', timestamp: '2026-09-04T17:30:00.000Z', quoteAsOf: '2026-09-04T17:30:00.000Z' });
    const [row] = store.reconcileRows({ scope: 'rates.eu_sovereigns', incomingRows: [incoming] });
    expect(row).toEqual(incoming);
    expect(store.snapshot().modes.current['rates.eu_sovereigns'].BUND10Y).not.toHaveProperty('monthChangePct');
  });

  test.each([
    { periodReturnsSource: 'mock' }, { periodReturnsSource: 'seed' }, { periodReturnsSource: 'cache' },
    { periodReturnsStatus: 'unavailable' }, { periodReturnsAsOf: 'invalid' },
    { periodReturnsAsOf: '2027-09-04T13:30:00.000Z' },
  ])('does not persist rejected historical fields despite a valid quote: %j', (invalid) => {
    const now = () => Date.parse('2026-09-04T18:00:00.000Z');
    const store = createMarketQuoteReferenceStore({ dataDir, now });
    const [row] = store.reconcileRows({ mode: 'periods', scope: 'us', incomingRows: [verifiedRow({
      monthChangePct: 99, periodReturnsStatus: 'historical', periodReturnsAsOf: '2026-09-04T13:30:00.000Z',
      periodReturnsSource: 'yahoo', periodSourceSeriesId: '^GSPC', ...invalid,
    })] });
    expect(row.price).toBe(7737.7);
    expect(row).not.toHaveProperty('monthChangePct');
    expect(store.snapshot().modes.periods.us.SPX).not.toHaveProperty('monthChangePct');
  });

  test.each([
    { source: 'mock' }, { seeded: true }, { dataType: 'seed' }, { synthetic: true },
    { cacheOnly: true }, { fromCache: true }, { freshness: 'stale' }, { warning: 'provider_offline' },
    { source: 'portfolio' }, { price: null }, { quoteAsOf: 'invalid', timestamp: 'invalid' },
  ])('rejects unverified incoming evidence without replacing the last observation: %j', (invalid) => {
    const store = createMarketQuoteReferenceStore({ dataDir });
    store.reconcileRows({ scope: 'us', incomingRows: [verifiedRow()] });
    const rows = store.reconcileRows({ scope: 'us', expectedSymbols: ['SPX'],
      incomingRows: [verifiedRow({ ...invalid, changePercent: 99 })] });
    expect(rows).toEqual([expect.objectContaining({ changePercent: 0.13, availability: 'reference' })]);
    const empty = createMarketQuoteReferenceStore({ dataDir });
    expect(empty.reconcileRows({ scope: 'us', incomingRows: [verifiedRow(invalid)] })).toEqual([]);
  });

  test('keeps a newer dated period observation when a provider returns an older row', () => {
    const now = () => Date.parse('2026-09-04T18:00:00.000Z');
    const store = createMarketQuoteReferenceStore({ dataDir, now });
    store.reconcileRows({
      mode: 'periods',
      scope: 'rates.eu_sovereigns',
      incomingRows: [verifiedRow({
        symbol: 'BUND10Y',
        price: 2.97,
        source: 'trading_economics',
        quoteAsOf: '2026-09-04T17:30:00.000Z',
        timestamp: '2026-09-04T17:30:00.000Z',
      })],
      expectedSymbols: ['BUND10Y'],
    });

    const [row] = store.reconcileRows({
      mode: 'periods',
      scope: 'rates.eu_sovereigns',
      incomingRows: [verifiedRow({
        symbol: 'BUND10Y',
        price: 2.75,
        source: 'fred',
        dataType: 'historical',
        availability: 'historical',
        quoteAsOf: '2026-06-01T00:00:00.000Z',
        timestamp: '2026-06-01T00:00:00.000Z',
      })],
      expectedSymbols: ['BUND10Y'],
    });

    expect(row).toEqual(expect.objectContaining({
      price: 2.97,
      source: 'trading_economics',
      availability: 'reference',
      retentionReason: 'provider_observation_older_than_last_verified',
    }));
  });

  test('never persists mock or synthetic rows', () => {
    const store = createMarketQuoteReferenceStore({ dataDir });
    const rows = store.reconcileRows({
      scope: 'us',
      incomingRows: [verifiedRow({ source: 'mock', mock: true })],
      expectedSymbols: ['SPX'],
    });

    expect(rows).toEqual([]);
    expect(store.flush()).toBe(false);
    expect(fs.existsSync(store.filePath)).toBe(false);
  });

  test('re-observing the same reading does not rewrite the file; a newer one does', () => {
    const now = () => Date.parse('2026-09-04T17:01:00.000Z');
    const store = createMarketQuoteReferenceStore({ dataDir, now });
    const reconcile = (row) => store.reconcileRows({
      mode: 'current', scope: 'us', incomingRows: [row], expectedSymbols: ['SPX'],
    });
    reconcile(verifiedRow());
    expect(store.flush()).toBe(true);
    const written = fs.statSync(store.filePath).mtimeMs;
    const contents = fs.readFileSync(store.filePath, 'utf8');

    // The same observation again, as on every poll while a market is closed.
    reconcile(verifiedRow());
    expect(store.flush()).toBe(false);
    expect(fs.readFileSync(store.filePath, 'utf8')).toBe(contents);
    expect(fs.statSync(store.filePath).mtimeMs).toBe(written);

    // A restart that re-reads the file also recognises unchanged readings.
    const restarted = createMarketQuoteReferenceStore({ dataDir, now });
    restarted.reconcileRows({ mode: 'current', scope: 'us', incomingRows: [verifiedRow()], expectedSymbols: ['SPX'] });
    expect(restarted.flush()).toBe(false);

    reconcile(verifiedRow({ price: 7740.1, timestamp: '2026-09-04T17:00:55.000Z', quoteAsOf: '2026-09-04T17:00:55.000Z' }));
    expect(store.flush()).toBe(true);
    expect(JSON.parse(fs.readFileSync(store.filePath, 'utf8')).modes.current.us.SPX.price).toBe(7740.1);
  });
});
