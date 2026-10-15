import { mergePredictionMonitorSnapshots, reconcilePredictionMonitorSnapshot } from './predictionMonitorSnapshotReconciler';

const NOW = Date.parse('2026-09-02T16:00:00.000Z');

test.each(['refreshing', 'unavailable'])('keeps direct Bitcoin %s data separate from previous Coinbase and resource history', (status) => {
  const priorChart = {
    status: 'available', availability: 'live', source: 'coinbase_exchange_public_candles',
    asOf: new Date(NOW - 1000).toISOString(), expiresAt: new Date(NOW + 60000).toISOString(),
    points: [{ timestamp: NOW - 2000, value: 75000 }, { timestamp: NOW - 1000, value: 75100 }],
  };
  const previous = { marketId: 'bitcoin', chart: priorChart };
  const incoming = {
    marketId: 'bitcoin',
    perpetualReference: { referenceKind: 'perpetual_contract' },
    spot: { status, value: null },
    chart: { status, points: [], refreshFailed: status === 'unavailable' },
    chartReferences: { basis: { symbol: 'BTC' } },
  };
  expect(mergePredictionMonitorSnapshots(previous, incoming, NOW)).toBe(incoming);
  expect(reconcilePredictionMonitorSnapshot({
    currentData: previous, currentReferenceData: previous, incomingData: incoming, nowMs: NOW,
  })).toBe(incoming);
  expect(mergePredictionMonitorSnapshots({ ...previous, perpetualReference: incoming.perpetualReference }, incoming, NOW))
    .toBe(incoming);
});

test('GDP failures replace the native book without reviving previous quotes', () => {
  const gdp = { quarter: '2026-Q3', forecasts: [{ value: 4.02, publishedAt: '2026-08-31' }] };
  const previous = { marketId: 'gdp', gdp, contracts: { status: 'available', lines: [{ threshold: 0, yesBid: 0.4 }] } };
  const incoming = { marketId: 'gdp', gdp, contracts: { status: 'unavailable', refreshFailed: true, lines: [] } };
  expect(mergePredictionMonitorSnapshots(previous, incoming, NOW)).toBe(incoming);
});

const eventFor = (releaseKey, eventTicker, reportMonth) => ({
  ticker: eventTicker,
  eventTicker,
  seriesTicker: 'KXCPIYOY',
  releaseKey,
  reportMonth,
  closeTime: new Date(NOW + 60_000).toISOString(),
});

const liveBook = (releaseKey, eventTicker, reportMonth) => ({
  status: 'available',
  source: 'kalshi_batch_orderbooks_v2',
  asOf: new Date(NOW).toISOString(),
  expiresAt: new Date(NOW + 60_000).toISOString(),
  event: eventFor(releaseKey, eventTicker, reportMonth),
  lines: [{
    ticker: `${eventTicker}-T2.6`,
    threshold: 2.6,
    yesBid: 0.4,
    yesAsk: 0.42,
    noBid: 0.58,
    noAsk: 0.6,
    directNative: true,
    source: 'kalshi_batch_orderbooks_v2',
  }],
});

const pendingBook = (releaseKey, eventTicker, reportMonth, overrides = {}) => ({
  status: 'refreshing',
  source: null,
  asOf: null,
  expiresAt: null,
  event: eventFor(releaseKey, eventTicker, reportMonth),
  lines: [],
  refreshing: true,
  refreshPending: true,
  refreshFailed: false,
  reason: 'The exact CPI native book is refreshing.',
  ...overrides,
});

const snapshot = ({
  releaseKey = 'KXCPIYOY#2026-08',
  eventTicker = 'KXCPIYOY-26AUG',
  reportMonth = '2026-08',
  book = null,
} = {}) => {
  const effectiveBook = book || liveBook(releaseKey, eventTicker, reportMonth);
  const catalog = {
    status: 'available',
    source: 'kalshi_trade_api_v2_catalog',
    expiresAt: effectiveBook.event.closeTime,
    event: effectiveBook.event,
    lines: [{
      ticker: `${eventTicker}-T2.6`,
      threshold: 2.6,
      source: 'kalshi_trade_api_v2_catalog',
      yesBid: null,
      yesAsk: null,
      noBid: null,
      noAsk: null,
      directNative: false,
    }],
  };
  return {
    schemaVersion: 2,
    marketId: 'cpi',
    status: effectiveBook.status === 'available' ? 'available' : 'partial',
    forecastComparison: {
      status: 'available', releaseKey, reportMonth,
      releaseAt: new Date(NOW + 120_000).toISOString(), eventTicker,
    },
    ladderReference: {
      status: 'available', kind: 'hedgeye_base', value: 2.6,
      reportMonth, executable: false,
    },
    contracts: effectiveBook,
    displayContracts: effectiveBook,
    executionContracts: { status: 'unavailable', event: null, lines: [] },
    venues: {
      kalshi: {
        id: 'kalshi', label: 'Kalshi', generationId: eventTicker,
        brokerRoutable: false, catalog, book: effectiveBook, contracts: effectiveBook,
        bookQuality: { eligible: false, directLineCount: effectiveBook.lines.length, executableLineCount: 0 },
      },
    },
    displaySelection: { status: 'available', venueId: 'kalshi', contracts: effectiveBook },
    autoSelection: {
      status: 'unavailable', venueId: null,
      contracts: { status: 'unavailable', event: null, lines: [] },
    },
    factors: {},
    factorRows: [],
    scoreInputs: {},
  };
};

describe('prediction monitor CPI snapshot reconciliation', () => {
  test('retains a fresh native book only for the same release while refresh is pending', () => {
    const previous = snapshot();
    const incoming = snapshot({
      book: pendingBook('KXCPIYOY#2026-08', 'KXCPIYOY-26AUG', '2026-08'),
    });
    const merged = mergePredictionMonitorSnapshots(previous, incoming, NOW);

    expect(merged.contracts).toMatchObject({
      status: 'available', refreshPending: true, refreshRetained: true,
      event: { releaseKey: 'KXCPIYOY#2026-08' },
    });
    expect(merged.contracts.lines[0]).toMatchObject({ directNative: true, yesBid: 0.4 });
    expect(merged.venues.kalshi.book.refreshRetained).toBe(true);
    expect(merged.autoSelection).toMatchObject({
      status: 'unavailable',
      contracts: { status: 'unavailable', lines: [] },
    });
    expect(merged.executionContracts.lines).toHaveLength(0);
  });

  test('does not carry quotes or catalog state across the CPI release key boundary', () => {
    const previous = snapshot();
    const releaseKey = 'KXCPIYOY#2026-09';
    const eventTicker = 'KXCPIYOY-26SEP';
    const reportMonth = '2026-09';
    const incoming = snapshot({
      releaseKey,
      eventTicker,
      reportMonth,
      book: pendingBook(releaseKey, eventTicker, reportMonth),
    });
    const merged = mergePredictionMonitorSnapshots(previous, incoming, NOW);

    expect(merged.forecastComparison.releaseKey).toBe(releaseKey);
    expect(merged.contracts).toMatchObject({
      status: 'refreshing', refreshPending: true, lines: [],
      event: { eventTicker },
    });
    expect(merged.contracts.refreshRetained).not.toBe(true);
    expect(merged.venues.kalshi.catalog.event.eventTicker).toBe(eventTicker);
    expect(merged.venues.kalshi.book.lines).toHaveLength(0);
  });

  test('clears the live book on an explicit same-release refresh failure', () => {
    const previous = snapshot();
    const failedBook = pendingBook('KXCPIYOY#2026-08', 'KXCPIYOY-26AUG', '2026-08', {
      status: 'unavailable',
      refreshing: false,
      refreshPending: false,
      refreshFailed: true,
      refreshIssue: 'Kalshi CPI orderbook offline.',
    });
    const incoming = snapshot({ book: failedBook });
    const merged = mergePredictionMonitorSnapshots(previous, incoming, NOW);

    expect(merged.venues.kalshi.book).toMatchObject({
      status: 'refresh_failed', refreshFailed: true, lines: [],
    });
    expect(merged.displayContracts.lines).toHaveLength(1);
    expect(merged.displayContracts.lines.every((line) => (
      line.directNative === false
      && line.yesBid === null
      && line.yesAsk === null
      && line.noBid === null
      && line.noAsk === null
    ))).toBe(true);
    expect(merged.executionContracts.lines).toHaveLength(0);
  });
});
