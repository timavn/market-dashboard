const {
  FES_TERMS_URL,
  buildExactEsFutureInstrument,
  parseFesResolverIdentity,
  validateFesGeneration,
} = require('./forecastExFesIdentity.cjs');

function row(strike, overrides = {}) {
  return {
    productId: 'FES',
    contractId: `FES_121727_${strike}`,
    strike,
    question: `Will Dec-27 S&P 500 Index Futures settle above $${Number(strike).toLocaleString('en-US')} on December 17 2027?`,
    lastTradeDate: '2027-12-17T21:00:00.000Z',
    expirationDate: '2027-12-20T16:00:00.000Z',
    payoutDate: '2027-12-20T18:00:00.000Z',
    rulesUrl: FES_TERMS_URL,
    ...overrides,
  };
}

describe('ForecastEx FES resolver identity', () => {
  test('parses a future generation into the exact quarterly ES instrument', () => {
    expect(parseFesResolverIdentity(
      'Will Dec-27 S&P 500 Index Futures settle above $7,500 on December 17 2027?',
      { eventDate: '2027-12-17', strike: 7500 },
    )).toMatchObject({
      resolverSymbol: 'ESZ27', underlyingContractMonth: '202712', cmeContractMonth: 'DEC27',
    });
    expect(buildExactEsFutureInstrument({ resolverSymbol: 'ESZ27', underlyingContractMonth: '202712' })).toMatchObject({
      displaySymbol: 'ESZ27', lastTradeDateOrContractMonth: '202712', secType: 'FUT', exchange: 'CME',
    });
    expect(buildExactEsFutureInstrument({ resolverSymbol: 'ESU26', underlyingContractMonth: '202612' })).toBeNull();
  });

  test('validates every strike, official terms, and the exact CT schedule as one generation', () => {
    expect(validateFesGeneration([row(7500), row(7550)])).toMatchObject({
      generationKey: 'FES_121727', resolverSymbol: 'ESZ27', underlyingContractMonth: '202712',
      lastTradeAt: '2027-12-17T21:00:00.000Z', resolutionAt: '2027-12-20T16:00:00.000Z', payoutAt: '2027-12-20T18:00:00.000Z',
    });
    expect(() => validateFesGeneration([row(7500), row(7550, { lastTradeDate: '2027-12-17T20:59:59.000Z' })]))
      .toThrow(/3:00 p\.m\. CT/i);
    expect(() => validateFesGeneration([row(7500, { rulesUrl: 'https://example.com/FESTermsandConditions.pdf' })]))
      .toThrow(/official FES terms/i);
    expect(() => validateFesGeneration([row(7500), row(7500)]))
      .toThrow(/duplicate or ambiguous strikes/i);
  });
});
