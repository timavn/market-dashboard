const {
  toQuoteInstrument,
  classifyQuoteAvailability,
  buildQuoteMetadata,
  buildPeriodReturnsMetadata,
  isDisplayableQuoteRow,
} = require('../multiRegionQuoteIntegrity.cjs');

const now = () => new Date().toISOString();

describe('multi-region quote integrity', () => {
  it('builds an explicit provider descriptor without leaking display fields', () => {
    expect(toQuoteInstrument({
      symbol: 'USDCAD',
      name: 'USD/CAD',
      secType: 'CASH',
      provider: 'yahoo',
      yahooSymbol: 'USDCAD=X',
    })).toEqual({
      symbol: 'USDCAD',
      secType: 'CASH',
      exchange: undefined,
      currency: undefined,
      conId: undefined,
      provider: 'yahoo',
      providerSymbol: undefined,
      ibkrSymbol: undefined,
      yahooSymbol: 'USDCAD=X',
    });
  });

  it('keeps display and provider symbols separate for explicit IBKR index contracts', () => {
    expect(toQuoteInstrument({
      symbol: 'DJI',
      name: 'Dow 30',
      provider: 'ibkr',
      providerSymbol: 'INDU',
      conId: 1935181,
      secType: 'IND',
      exchange: 'CME',
    })).toEqual({
      symbol: 'DJI',
      secType: 'IND',
      exchange: 'CME',
      currency: undefined,
      conId: 1935181,
      provider: 'ibkr',
      providerSymbol: 'INDU',
      ibkrSymbol: 'INDU',
      yahooSymbol: undefined,
    });
  });

  it('preserves independent IBKR and Yahoo identities for an automatic cash-index route', () => {
    expect(toQuoteInstrument({
      symbol: 'DJI',
      provider: 'auto',
      ibkrSymbol: 'INDU',
      yahooSymbol: '^DJI',
      conId: 1935181,
      secType: 'IND',
      exchange: 'CME',
      currency: 'USD',
    })).toEqual({
      symbol: 'DJI',
      secType: 'IND',
      exchange: 'CME',
      currency: 'USD',
      conId: 1935181,
      provider: 'auto',
      providerSymbol: undefined,
      ibkrSymbol: 'INDU',
      yahooSymbol: '^DJI',
    });
  });

  it('classifies only verified provider shapes as usable', () => {
    expect(classifyQuoteAvailability({ price: '100', source: 'ibkr', dataType: 'live', entitlementStatus: 'live', timestamp: now() }))
      .toBe('current');
    expect(classifyQuoteAvailability({
      price: '100',
      source: 'yahoo',
      dataType: 'delayed',
      timestamp: now(),
      warning: 'ibkr: stale_quote; yahoo_fallback',
    })).toBe('delayed');
    expect(classifyQuoteAvailability({ price: '4.25', source: 'fred', dataType: 'historical', timestamp: '2026-07-10T00:00:00.000Z' }))
      .toBe('historical');
    expect(classifyQuoteAvailability({
      price: '2.97',
      source: 'trading_economics',
      dataType: 'delayed',
      timestamp: now(),
    })).toBe('delayed');
  });

  it.each([
    [{ price: null, source: 'ibkr', timestamp: now() }, 'missing price'],
    [{ price: '100', source: 'ibkr', timestamp: null }, 'missing timestamp'],
    [{ price: '100', source: 'cache', timestamp: now() }, 'cache-only source'],
    [{ price: '100', source: 'mock', timestamp: now() }, 'mock source'],
    [{ price: '100', source: 'ibkr', timestamp: now(), warning: 'stale_quote' }, 'stale IBKR warning'],
    [{ price: '100', source: 'ibkr', dataType: 'live', timestamp: now(), warning: 'close_only_reference' }, 'close-only IBKR reference'],
    [{ price: '100', source: 'ibkr', dataType: 'frozen', timestamp: now() }, 'frozen IBKR quote'],
    [{ price: '100', source: 'ibkr', dataType: 'delayed_frozen', timestamp: now() }, 'delayed-frozen IBKR quote'],
    [{ price: '100', source: 'yahoo', dataType: 'delayed', timestamp: '2026-06-01T00:00:00.000Z' }, 'stale delayed quote'],
    [{ symbol: 'BTC', price: '63000', source: 'yahoo', dataType: 'delayed', timestamp: '2026-07-13T02:00:00.000Z' }, 'stale continuous crypto quote'],
    [{ price: '100', source: 'ibkr', timestamp: now(), entitlementStatus: 'not_entitled' }, 'denied entitlement'],
    [{ price: '100', source: 'unknown', timestamp: now() }, 'unknown source'],
  ])('marks %s unavailable (%s)', (quote) => {
    expect(classifyQuoteAvailability(quote)).toBe('unavailable');
  });

  it('clears quoteAsOf when a quote is unavailable while preserving diagnostics', () => {
    expect(buildQuoteMetadata({
      price: '100',
      source: 'ibkr',
      dataType: 'live',
      timestamp: now(),
      warning: 'provider_offline',
    })).toMatchObject({
      availability: 'unavailable',
      quoteAsOf: null,
      warning: 'provider_offline',
      usable: false,
    });
  });

  it.each(['DOGE', 'LINK', 'DOGE-USD', 'LINK-USD'])('applies the continuous two-hour freshness bound to %s', (symbol) => {
    const clock = Date.now();
    const quote = { symbol, price: '0.08477', source: 'yahoo', dataType: 'delayed' };
    expect(classifyQuoteAvailability({
      ...quote, timestamp: new Date(clock - 2 * 60 * 60_000 + 1).toISOString(),
    }, { now: clock })).toBe('delayed');
    expect(classifyQuoteAvailability({
      ...quote, timestamp: new Date(clock - 2 * 60 * 60_000 - 1).toISOString(),
    }, { now: clock })).toBe('unavailable');
  });

  it.each(['XLF', 'VNQ'])('keeps the existing exchange-session reference allowance for %s', (symbol) => {
    expect(classifyQuoteAvailability({
      symbol, price: '90', source: 'yahoo', dataType: 'delayed',
      timestamp: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    })).toBe('delayed');
  });

  it('labels dated period returns historical and missing returns unavailable', () => {
    expect(buildPeriodReturnsMetadata({
      weekChangePct: 1.2,
      monthChangePct: 2.3,
      asOf: '2026-07-10T00:00:00.000Z',
    })).toEqual({
      periodReturnsAsOf: '2026-07-10T00:00:00.000Z',
      periodReturnsStatus: 'historical',
    });
    expect(buildPeriodReturnsMetadata(null)).toEqual({
      periodReturnsAsOf: null,
      periodReturnsStatus: 'unavailable',
    });
  });

  it('filters rejected rows while retaining verified delayed, historical, and derived rows', () => {
    const timestamp = now();
    expect(isDisplayableQuoteRow({
      symbol: 'SMH',
      price: '250',
      source: 'yahoo',
      dataType: 'delayed',
      availability: 'delayed',
      timestamp,
      warning: 'yahoo_fallback',
    })).toBe(true);
    expect(isDisplayableQuoteRow({
      symbol: 'DJI',
      price: '54000',
      source: 'yahoo',
      dataType: 'delayed',
      availability: 'delayed',
      timestamp,
      warning: 'ibkr: close_only_reference; missing_timestamp; stale_quote; delayed_data',
    })).toBe(true);
    expect(isDisplayableQuoteRow({
      symbol: 'UST2Y',
      price: '4.15',
      source: 'fred',
      dataType: 'historical',
      availability: 'historical',
      timestamp: '2026-08-13T00:00:00.000Z',
    })).toBe(true);
    expect(isDisplayableQuoteRow({
      symbol: 'CURVE_2s10s',
      price: '-42.5',
      source: 'derived',
      dataType: 'derived',
      availability: 'historical',
      timestamp: '2026-08-13T00:00:00.000Z',
    })).toBe(true);
    [
      { availability: 'unavailable', source: 'yahoo', dataType: 'delayed' },
      { availability: 'delayed', source: 'cache', dataType: 'delayed' },
      { availability: 'delayed', source: 'mock', dataType: 'delayed' },
      { availability: 'delayed', source: 'yahoo', dataType: 'stale' },
      { availability: 'delayed', source: 'yahoo', dataType: 'delayed', warning: 'provider_offline' },
      { availability: 'delayed', source: 'yahoo', dataType: 'delayed', entitlementStatus: 'not_entitled' },
      { availability: 'delayed', source: 'unknown', dataType: 'delayed' },
    ].forEach((row) => expect(isDisplayableQuoteRow({
      ...row,
      symbol: 'BAD',
      price: '100',
      timestamp,
    })).toBe(false));
  });
});
