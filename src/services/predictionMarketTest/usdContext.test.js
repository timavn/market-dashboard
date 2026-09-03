const { normalizeDxyContext } = require('./usdContext.cjs');

const NOW = Date.parse('2026-08-17T15:00:00.000Z');

function usdSnapshot(overrides = {}) {
  return {
    sourceStatus: 'current',
    source: 'Yahoo Finance daily bars',
    timestamp: '2026-08-17T15:00:00.000Z',
    calculationDate: '2026-08-14',
    assetContext: {
      dxy: {
        status: 'historical',
        availability: 'historical',
        value: 98.42,
        previousClose: 98.11,
        changePercent: 0.316,
        asOf: '2026-08-14',
        source: 'Yahoo Finance completed DXY daily bars',
        decisionEligible: false,
      },
    },
    ...overrides,
  };
}

describe('completed-session DXY context', () => {
  test('accepts the verified DXY close as historical context only', () => {
    expect(normalizeDxyContext(usdSnapshot(), NOW)).toMatchObject({
      status: 'historical',
      availability: 'historical',
      value: 98.42,
      previousClose: 98.11,
      changePercent: 0.316,
      source: 'Yahoo Finance completed DXY daily bars',
      asOf: '2026-08-14',
      historicalThroughDate: '2026-08-14',
      decisionEligible: false,
    });
  });

  test.each([
    ['cached', { fromCache: true }],
    ['stale', { calculationDate: '2026-08-01', assetContext: { dxy: { ...usdSnapshot().assetContext.dxy, asOf: '2026-08-01' } } }],
    ['mismatched date', { calculationDate: '2026-08-13' }],
    ['unverified source', { assetContext: { dxy: { ...usdSnapshot().assetContext.dxy, source: 'manual DXY value' } } }],
    ['disconnected', { sourceStatus: 'offline' }],
  ])('fails closed for %s DXY data', (_label, overrides) => {
    expect(normalizeDxyContext(usdSnapshot(overrides), NOW)).toMatchObject({
      status: 'unavailable',
      availability: 'unavailable',
      value: null,
      source: null,
      asOf: null,
      decisionEligible: false,
    });
  });
});
