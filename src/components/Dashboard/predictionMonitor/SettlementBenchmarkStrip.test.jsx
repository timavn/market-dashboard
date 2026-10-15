import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import SettlementBenchmarkStrip from './SettlementBenchmarkStrip';
import { buildSettlementBenchmarkView } from './settlementBenchmark';

jest.mock('react-dom/test-utils', () => ({
  ...jest.requireActual('react-dom/test-utils'),
  act: jest.requireActual('react').act,
}));

const NOW = Date.parse('2026-09-15T15:00:00Z');
const prepared = (symbol = 'BRTI') => ({
  contracts: { event: { ticker: 'SELECTED-EVENT' } },
  spot: { value: 76_401, source: 'kalshi_perpetual_public_trades' },
  resolverReference: {
    settlementBenchmark: {
      symbol, sourceName: 'CF Benchmarks', sourceUrl: 'https://www.cfbenchmarks.com/data/indices/BRTI',
      method: '60-second average', identityVerified: true, eventTicker: 'SELECTED-EVENT',
      expiresAt: '2026-09-15T15:30:00Z',
    },
    spot: {
      status: 'available', availability: 'live', fit: 'exact', source: 'cfbenchmarks_index',
      indexId: symbol, value: 76_344.59, asOf: '2026-09-15T14:59:55Z', expiresAt: '2026-09-15T15:00:55Z',
    },
  },
});

const model = (snapshot, options = {}) => buildSettlementBenchmarkView(snapshot, { nowMs: NOW, ...options });

test('shows the independently verified benchmark with its source and original 24-hour observation time', () => {
  const benchmark = model(prepared());
  render(<SettlementBenchmarkStrip benchmark={benchmark} />);
  const strip = screen.getByRole('group', { name: 'Prediction contract settlement input' });
  expect(strip).toHaveTextContent('SETTLEMENT INPUTBRTI76,344.59LIVE');
  expect(strip).not.toHaveTextContent('76,401');
  expect(strip).toHaveAttribute('title', expect.stringContaining('Sep 15 07:59 PDT'));
  expect(strip).toHaveAttribute('title', expect.stringContaining('Settlement uses 60-second average'));
  expect(screen.getByRole('link')).toHaveAttribute('href', 'https://www.cfbenchmarks.com/data/indices/BRTI');
});

test.each(['BRTI', 'ETHUSD_RTI', 'Metal.Index.GOLD/USD', 'Metal.Index.SILVER/USD'])(
  'reads the exact %s input even when the chart reference is a proxy', (symbol) => {
    const snapshot = prepared(symbol);
    const exact = snapshot.resolverReference.spot;
    if (symbol.startsWith('Metal.')) {
      delete exact.indexId;
      exact.feed = { symbol, priceFeedId: 100 };
      exact.source = 'pyth_pro_live';
    }
    snapshot.resolverReference.exactReference = { spot: exact };
    snapshot.resolverReference.spot = { ...exact, fit: 'proxy', value: 99_999 };
    expect(model(snapshot)).toMatchObject({ status: 'live', value: 76_344.59, symbol });
  },
);

test('uses provider identity for matching while keeping the verified contract display symbol', () => {
  const snapshot = prepared('ETHUSD_RTI');
  snapshot.resolverReference.settlementBenchmark.displaySymbol = 'ERTI';
  expect(model(snapshot)).toMatchObject({ status: 'live', symbol: 'ERTI', spot: { label: 'ERTI' } });
});

test('matches an exact dated futures settlement input through its verified instrument identity', () => {
  const snapshot = prepared('SIU6');
  delete snapshot.resolverReference.spot.indexId;
  snapshot.resolverReference.instrument = { displaySymbol: 'SIU6', secType: 'FUT' };
  expect(model(snapshot)).toMatchObject({ status: 'live', symbol: 'SIU6' });
  snapshot.resolverReference.instrument.displaySymbol = 'SIZ6';
  expect(model(snapshot)).toMatchObject({ status: 'unavailable', value: null });
});

test('an independent proxy outage leaves the freshly verified exact input available', () => {
  const snapshot = prepared();
  snapshot.resolverReference.exactReference = { spot: { ...snapshot.resolverReference.spot } };
  Object.assign(snapshot.resolverReference, { fit: 'proxy', connected: false, freshness: { status: 'unavailable' } });
  snapshot.resolverReference.spot = { status: 'unavailable', value: null, source: 'coinbase_exchange' };
  expect(model(snapshot)).toMatchObject({ status: 'live', value: 76_344.59 });
  snapshot.refreshFailed = true;
  expect(model(snapshot)).toMatchObject({ status: 'unavailable', value: null });
});

test.each(['stale', 'isStale', 'offline', 'disconnected', 'fromCache', 'cacheOnly', 'cachedOnly', 'cached', 'mock', 'isMock', 'seeded', 'synthetic', 'refreshFailed'])(
  '%s on the quote or its enclosing exact feed removes the value', (flag) => {
    for (const location of ['spot', 'exactReference']) {
      const snapshot = prepared();
      const reference = snapshot.resolverReference;
      reference.exactReference = { spot: { ...reference.spot } };
      (location === 'spot' ? reference.exactReference.spot : reference.exactReference)[flag] = true;
      expect(model(snapshot)).toMatchObject({ status: 'unavailable', value: null, spot: null });
    }
  },
);

test.each([
  { connected: false }, { isConnected: false }, { live: false },
  { providerStatus: { connected: false } }, { freshness: { status: 'stale' } },
  { metadata: { mock: true } },
])('rejects disconnected and rejected nested provider metadata %j', (metadata) => {
  const snapshot = prepared();
  Object.assign(snapshot.resolverReference, metadata);
  expect(model(snapshot)).toMatchObject({ status: 'unavailable', value: null });
});

test('expires the selected contract identity even while its index tick is fresh', () => {
  const snapshot = prepared();
  snapshot.resolverReference.settlementBenchmark.expiresAt = '2026-09-15T14:59:59Z';
  expect(model(snapshot)).toMatchObject({ status: 'unavailable', value: null });
});

test.each([
  ['wrong index', { indexId: 'OTHER' }],
  ['missing index', { indexId: null }],
  ['proxy', { fit: 'proxy' }],
  ['expired', { expiresAt: '2026-09-15T14:59:59Z' }],
  ['old with extended expiry', { asOf: '2026-09-15T14:58:00Z' }],
  ['future', { asOf: '2026-09-15T15:01:00Z' }],
  ['missing observation', { asOf: null }],
  ['missing source', { source: null }],
  ['cached source', { source: 'cfbenchmarks_cached' }],
  ['delayed', { availability: 'delayed' }],
  ['unavailable', { status: 'unavailable' }],
])('%s input stays unavailable while the perpetual price remains available', (_name, override) => {
  const snapshot = prepared();
  Object.assign(snapshot.resolverReference.spot, override);
  const benchmark = model(snapshot);
  render(<SettlementBenchmarkStrip benchmark={benchmark} />);
  const strip = screen.getByRole('group');
  expect(strip).toHaveTextContent('BRTIUNAVAILABLE');
  expect(strip).not.toHaveTextContent('76,344');
  expect(strip).not.toHaveTextContent('76,401');
  expect(benchmark.spot).toBeNull();
});

test('an unverified or mismatched selected contract cannot promote a fresh index tick', () => {
  const snapshot = prepared();
  snapshot.resolverReference.settlementBenchmark.identityVerified = false;
  expect(model(snapshot)).toMatchObject({ status: 'unavailable', symbol: null, value: null });
  snapshot.resolverReference.settlementBenchmark.identityVerified = true;
  snapshot.contracts.event.ticker = 'DIFFERENT-EVENT';
  expect(model(snapshot)).toMatchObject({ status: 'unavailable', symbol: null, value: null });
});

test('refresh failure immediately removes the previously verified reading', () => {
  const snapshot = prepared();
  const { rerender } = render(<SettlementBenchmarkStrip benchmark={model(snapshot)} />);
  expect(screen.getByText('76,344.59')).toBeInTheDocument();
  rerender(<SettlementBenchmarkStrip benchmark={model(snapshot, { refreshFailed: true })} />);
  expect(screen.getByText('UNAVAILABLE')).toBeInTheDocument();
  expect(screen.queryByText('76,344.59')).not.toBeInTheDocument();
});
