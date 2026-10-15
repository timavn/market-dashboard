const {
  FES_TERMS_URL,
  buildExactEsFutureInstrument,
  parseFesContractIdentity,
  matchesFesExpirationDate,
  parseFesResolverIdentity,
  validateOfficialFesSchedule,
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
  test('keeps native event and broker expiration dates separate without inventing a schedule', () => {
    const identity = parseFesContractIdentity('FES_081426_7775_NO', { expirationDate: '2026-08-17' });
    expect(identity).toEqual({
      productCode: 'FES', eventContract: 'FES_081426_7775', eventDate: '2026-08-14',
      expirationDate: '2026-08-17', strike: 7775, contractSide: 'NO',
    });
    expect(parseFesContractIdentity('FES_081426_7775')).toMatchObject({
      eventDate: '2026-08-14', expirationDate: null,
    });
    // The broker supplies this date. No weekday/holiday calendar guesses it.
    expect(parseFesContractIdentity('FES_081426_7775', { expirationDate: '2026-08-18' })).toMatchObject({
      expirationDate: '2026-08-18',
    });
    expect(matchesFesExpirationDate(identity, '2026-08-17T15:00:00Z')).toBe(true);
    expect(matchesFesExpirationDate(identity, '2026-08-17T01:00:00Z')).toBe(false);
    expect(matchesFesExpirationDate(identity, '2026-08-18T15:00:00Z')).toBe(false);
    expect(matchesFesExpirationDate({ ...identity, expirationDate: null }, '2026-08-14T22:00:00Z')).toBe(false);
  });

  test('accepts an event-day broker expiry without using it as the official resolution date', () => {
    const identity = parseFesContractIdentity('FES_091426_7625_NO', { expirationDate: '2026-09-14' });
    expect(identity).toMatchObject({ eventDate: '2026-09-14', expirationDate: '2026-09-14' });
    expect(matchesFesExpirationDate(identity, '2026-09-14T22:00:00Z')).toBe(false);
    expect(matchesFesExpirationDate(identity, '2026-09-15T15:00:00Z')).toBe(true);
    const schedule = {
      eventDate: identity.eventDate,
      brokerExpirationDate: identity.expirationDate,
      lastTradeDate: '2026-09-14T20:00:00Z',
      expirationDate: '2026-09-15T15:00:00Z',
      payoutDate: '2026-09-15T17:00:00Z',
    };
    expect(validateOfficialFesSchedule(schedule)).toEqual({
      lastTradeDate: '2026-09-14T20:00:00.000Z',
      expirationDate: '2026-09-15T15:00:00.000Z',
      payoutDate: '2026-09-15T17:00:00.000Z',
    });
    expect(() => validateOfficialFesSchedule({ ...schedule, expirationDate: '2026-09-14T22:00:00Z' })).toThrow();
    expect(() => validateOfficialFesSchedule({ ...schedule, brokerExpirationDate: '2026-09-16' })).toThrow();
    expect(() => validateOfficialFesSchedule({ ...schedule, brokerExpirationDate: '2026-09-13' })).toThrow();
  });

  test.each([
    ['FES_023026_7775', {}],
    ['FES_081426_7775', { eventDate: '2026-08-17' }],
    ['FES_081426_7775', { expirationDate: '2026-08-13' }],
    ['FES_081426_7775', { expirationDate: '2026-02-30' }],
  ])('rejects conflicting or invalid native date evidence (%s, %j)', (symbol, dates) => {
    expect(() => parseFesContractIdentity(symbol, dates)).toThrow(/event date or broker expiration/i);
  });

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
