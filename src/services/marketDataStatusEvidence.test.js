const {
  LIVE_IBKR_MIXED_REASON,
  summarizeMarketDataStatusEvidence,
} = require('./marketDataStatusEvidence.cjs');

const NOW_MS = Date.parse('2026-08-10T17:20:00.000Z');
const NOW = new Date(NOW_MS).toISOString();

function cacheEntry({ source, dataType, timestamp = NOW, insertedAt = NOW, warning = null }) {
  return {
    timestamp: Date.parse(insertedAt),
    data: {
      symbol: source === 'ibkr' ? 'SPY' : 'EURUSD',
      price: '100',
      source,
      dataType,
      timestamp,
      warning,
    },
  };
}

describe('market data status evidence', () => {
  test('reports mixed coverage regardless of cache insertion order', () => {
    const providerStatus = { ibkr: { connected: true } };
    const delayed = cacheEntry({ source: 'yahoo', dataType: 'delayed' });
    const current = cacheEntry({ source: 'ibkr', dataType: 'live' });

    const first = summarizeMarketDataStatusEvidence({
      quoteEntries: [delayed, current],
      providerStatus,
      nowMs: NOW_MS,
    });
    const second = summarizeMarketDataStatusEvidence({
      quoteEntries: [current, delayed],
      providerStatus,
      nowMs: NOW_MS,
    });

    expect(first).toMatchObject({
      verified: true,
      available: true,
      availability: 'mixed',
      source: 'ibkr+yahoo',
      reason: LIVE_IBKR_MIXED_REASON,
    });
    expect(second).toMatchObject(first);
  });

  test('reports current IBKR stream evidence when no cache row is present', () => {
    expect(summarizeMarketDataStatusEvidence({
      providerStatus: {
        ibkr: {
          connected: true,
          lastQuoteAt: NOW,
          lastQuoteAvailability: 'current',
        },
      },
      nowMs: NOW_MS,
    })).toMatchObject({
      verified: true,
      available: true,
      availability: 'current',
      source: 'ibkr',
    });
  });

  test('does not treat disconnected IBKR cache rows as live evidence', () => {
    expect(summarizeMarketDataStatusEvidence({
      quoteEntries: [cacheEntry({ source: 'ibkr', dataType: 'live' })],
      providerStatus: { ibkr: { connected: false } },
      nowMs: NOW_MS,
    })).toMatchObject({
      verified: false,
      available: null,
    });
  });

  test('reports delayed-only coverage separately from mixed coverage', () => {
    expect(summarizeMarketDataStatusEvidence({
      quoteEntries: [cacheEntry({ source: 'yahoo', dataType: 'delayed' })],
      providerStatus: { ibkr: { connected: true } },
      nowMs: NOW_MS,
    })).toMatchObject({
      verified: true,
      available: true,
      availability: 'delayed',
      source: 'yahoo',
    });
  });

  test('ignores stale and historical entries', () => {
    expect(summarizeMarketDataStatusEvidence({
      quoteEntries: [
        cacheEntry({
          source: 'ibkr',
          dataType: 'live',
          insertedAt: new Date(NOW_MS - 61_000).toISOString(),
        }),
        cacheEntry({
          source: 'fred',
          dataType: 'historical',
        }),
      ],
      providerStatus: { ibkr: { connected: true } },
      nowMs: NOW_MS,
    })).toMatchObject({
      verified: false,
      available: null,
    });
  });
});
