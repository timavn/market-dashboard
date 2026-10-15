const { RGDP_TERMS_URL, parseRgdpContractIdentity, rgdpYesOutcome, validateRgdpGeneration } = require('./forecastExRgdpIdentity.cjs');

function contract(strike = 0, overrides = {}) {
  return {
    contractId: `RGDP_Q326_${strike}`, productId: 'RGDP', strike,
    question: `Will the annualized growth rate in US Real GDP exceed ${strike}% in Q3 2026?`,
    rulesUrl: RGDP_TERMS_URL,
    lastTradeDate: '2026-12-23T13:30:00.000Z',
    expirationDate: '2026-12-23T13:30:00.000Z',
    payoutDate: '2026-12-23T15:30:00.000Z',
    ...overrides,
  };
}

describe('ForecastEx real GDP contract identity', () => {
  test('derives measured quarter from question and ID, keeping December third reading separate', () => {
    expect(validateRgdpGeneration([contract(0), contract(-0.5)], { measuredQuarter: '2026-Q3' })).toEqual(expect.objectContaining({
      generationKey: 'RGDP_Q326', measuredQuarter: '2026-Q3', unit: 'qoq_saar_pct',
      settlementStage: 'third', comparator: '>', earlyResolution: false,
      resolutionAt: '2026-12-23T13:30:00.000Z', payoutAt: '2026-12-23T15:30:00.000Z',
      lines: [expect.objectContaining({ strike: -0.5 }), expect.objectContaining({ strike: 0 })],
    }));
  });

  test.each([
    ['question quarter', { question: 'Will the annualized growth rate in US Real GDP exceed 0% in Q2 2026?' }],
    ['question year', { question: 'Will the annualized growth rate in US Real GDP exceed 0% in Q3 2025?' }],
    ['question threshold', { question: 'Will the annualized growth rate in US Real GDP exceed 0.5% in Q3 2026?' }],
    ['nominal measure', { question: 'Will the annualized growth rate in US Nominal GDP exceed 0% in Q3 2026?' }],
    ['missing threshold', { strike: null }],
    ['inclusive comparator', { comparator: '>=' }],
    ['first estimate', { settlementStage: 'advance' }],
    ['YoY unit', { unit: 'yoy_pct' }],
    ['third party terms', { rulesUrl: 'https://example.com/RGDPTermsandConditions.pdf' }],
    ['other product terms', { rulesUrl: 'https://data.forecastex.com/regulatory/FESTermsandConditions.pdf' }],
    ['misleading terms hostname', { rulesUrl: 'https://data.forecastex.com.example.com/regulatory/RGDPTermsandConditions.pdf' }],
    ['early resolution', { earlyResolution: true }],
  ])('rejects conflicting %s', (_label, overrides) => {
    expect(() => parseRgdpContractIdentity(contract(0, overrides))).toThrow();
  });

  test('rejects the Q2 generation even when its release falls in Q3', () => {
    expect(() => validateRgdpGeneration([contract(0, {
      contractId: 'RGDP_Q226_0',
      question: 'Will the annualized growth rate in US Real GDP exceed 0% in Q2 2026?',
      lastTradeDate: '2026-09-30T12:30:00.000Z', expirationDate: '2026-09-30T12:30:00.000Z', payoutDate: '2026-09-30T14:30:00.000Z',
    })], { measuredQuarter: '2026-Q3' })).toThrow();
  });

  test.each([
    ['advance release', { lastTradeDate: '2026-10-29T12:30:00Z', expirationDate: '2026-10-29T12:30:00Z' }],
    ['unverified timezone', { expirationDate: '2026-12-23T07:30:00' }],
    ['missing payout', { payoutDate: null }],
    ['earlier payout', { payoutDate: '2026-12-22T15:30:00Z' }],
    ['trading cutoff', { lastTradeDate: '2026-12-22T13:30:00Z' }],
  ])('rejects invalid %s', (_label, overrides) => {
    expect(() => validateRgdpGeneration([contract(0, overrides)])).toThrow();
  });

  test('cross-checks the verified BEA deciding release and rejects mixed schedules', () => {
    expect(() => validateRgdpGeneration([contract()], { decidingReleaseAt: '2026-12-22T13:30:00Z' })).toThrow();
    expect(() => validateRgdpGeneration([contract(), contract(1, { payoutDate: '2026-12-24T15:30:00Z' })])).toThrow();
    expect(() => validateRgdpGeneration([contract(), contract()])).toThrow();
  });

  test.each([[0, 0, false], [-0.5, -0.5, false], [0, -0.5, true], [-1, -0.5, false], [0.1, 0, true], [null, 0, null]])(
    'uses a strict published-reading comparison for %p vs %p', (reading, strike, expected) => {
      expect(rgdpYesOutcome(reading, strike)).toBe(expected);
    },
  );
});
