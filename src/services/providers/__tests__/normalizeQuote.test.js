const { normalizeQuote, normalizeIbkrRaw, normalizeYahooLegacy } = require('../normalize/normalizeQuote');
const mockIbkr = require('../__fixtures__/mockIbkrQuote.json');
const mockYahoo = require('../__fixtures__/mockYahooQuote.json');

describe('normalizeQuote', () => {
  it('computes mid from bid and ask', () => {
    const q = normalizeIbkrRaw({ ...mockIbkr, timestamp: new Date().toISOString() });
    expect(q.mid).toBeCloseTo(189.51, 2);
    expect(q.mark).toBeCloseTo(189.51, 2);
    expect(q.source).toBe('ibkr');
    expect(q.valid).toBe(true);
  });

  it('uses last when bid/ask missing', () => {
    const q = normalizeQuote(
      { symbol: 'SPY', last: 450, close: 448, timestamp: new Date().toISOString() },
      'ibkr',
    );
    expect(q.mark).toBe(450);
    expect(q.mid).toBeNull();
  });

  it('rejects zero and invalid mark', () => {
    const q = normalizeQuote(
      { symbol: 'X', bid: 0, ask: 0, last: 0, timestamp: new Date().toISOString() },
      'ibkr',
    );
    expect(q.valid).toBe(false);
    expect(q.warning).toMatch(/invalid_mark/);
  });

  it('flags stale IBKR timestamps', () => {
    const q = normalizeQuote(
      { symbol: 'X', last: 10, close: 10, timestamp: '2020-01-01T00:00:00.000Z' },
      'ibkr',
    );
    expect(q.valid).toBe(false);
    expect(q.warning).toMatch(/stale_quote/);
  });

  it('does not fabricate freshness when a timestamp is missing', () => {
    const q = normalizeQuote({ symbol: 'X', last: 10, close: 9 }, 'ibkr');
    expect(q.timestamp).toBeNull();
    expect(q.valid).toBe(false);
    expect(q.warning).toMatch(/missing_timestamp/);
  });

  it('rejects an IBKR close-only reference even when it was received now', () => {
    const q = normalizeIbkrRaw({
      symbol: 'SPX',
      last: null,
      bid: null,
      ask: null,
      close: 7709.96,
      timestamp: new Date().toISOString(),
      dataType: 'live',
    });

    expect(q.mark).toBe(7709.96);
    expect(q.valid).toBe(false);
    expect(q.warning).toMatch(/close_only_reference/);
  });

  it.each(['frozen', 'delayed_frozen'])(
    'rejects IBKR %s marks so the composite provider can fall back',
    (dataType) => {
      const q = normalizeIbkrRaw({
        symbol: 'SPX',
        last: 7709.96,
        close: 7700,
        timestamp: new Date().toISOString(),
        dataType,
      });

      expect(q.valid).toBe(false);
      expect(q.warning).toMatch(/frozen_quote/);
    },
  );

  it('rejects an explicitly unentitled IBKR mark', () => {
    const q = normalizeIbkrRaw({
      symbol: 'RUT',
      last: 3000,
      close: 2990,
      timestamp: new Date().toISOString(),
      dataType: 'live',
      entitlementStatus: 'not_entitled',
    });

    expect(q.valid).toBe(false);
    expect(q.warning).toMatch(/entitlement_unavailable/);
  });

  it('never substitutes an IBKR fetch receipt time for a quote timestamp', () => {
    const q = normalizeQuote({
      symbol: 'SPX',
      last: 7700,
      fetched_at: new Date().toISOString(),
    }, 'ibkr');

    expect(q.timestamp).toBeNull();
    expect(q.valid).toBe(false);
    expect(q.warning).toMatch(/missing_timestamp/);
  });

  it('normalizes Yahoo legacy shape', () => {
    const q = normalizeYahooLegacy(mockYahoo, 'SPY');
    expect(q.source).toBe('yahoo');
    expect(q.mark).toBeCloseTo(450.25, 2);
  });
});
