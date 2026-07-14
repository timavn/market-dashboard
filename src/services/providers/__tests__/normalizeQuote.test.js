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

  it('normalizes Yahoo legacy shape', () => {
    const q = normalizeYahooLegacy(mockYahoo, 'SPY');
    expect(q.source).toBe('yahoo');
    expect(q.mark).toBeCloseTo(450.25, 2);
  });
});
