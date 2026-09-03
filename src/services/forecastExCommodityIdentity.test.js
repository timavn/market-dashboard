const {
  buildExactForecastCommodityInstrument,
  parseForecastCommodityQuestion,
  validateForecastCommodityGeneration,
} = require('./forecastExCommodityIdentity.cjs');

const line = (productId, question, overrides = {}) => ({
  productId,
  question,
  rulesUrl: `https://www.forecastex.com/products/${productId}/official-terms`,
  expirationDate: '2026-08-21T20:00:00.000Z',
  payoutDate: '2026-08-22T20:00:00.000Z',
  ...overrides,
});

describe('ForecastEx dated commodity resolver identity', () => {
  test.each([
    ['METLG', 'Will December 2026 Gold Futures settle above 4,200?', {
      resolverSymbol: 'GCZ26', underlyingContractMonth: '202612',
      instrument: { symbol: 'GC', exchange: 'COMEX', tradingClass: 'GC', multiplier: '100' },
    }],
    ['METLS', 'Will March 2027 Silver Futures settle above 75?', {
      resolverSymbol: 'SIH27', underlyingContractMonth: '202703',
      instrument: { symbol: 'SI', exchange: 'COMEX', tradingClass: 'SI', multiplier: '5000' },
    }],
    ['COMCO', 'Will September 2026 ICE WTI futures contract settle above 85?', {
      resolverSymbol: 'WTIU26', underlyingContractMonth: '202609',
      instrument: { symbol: 'WTI', exchange: 'IPE', tradingClass: 'WBS', multiplier: '1000' },
    }],
  ])('parses an explicit %s resolver month into its exact IBKR future', (productCode, question, expected) => {
    const identity = parseForecastCommodityQuestion(question, { productCode });

    expect(identity).toMatchObject(expected);
    expect(buildExactForecastCommodityInstrument(identity)).toEqual(identity.instrument);
  });

  test('accepts only a generation whose official strikes prove one resolver and schedule', () => {
    const question = 'Will December 2026 Gold Futures settle above 4,200?';
    const identity = validateForecastCommodityGeneration([
      line('METLG', question),
      line('METLG', question.replace('4,200', '4,250')),
    ], 'METLG');

    expect(identity).toMatchObject({
      resolverSymbol: 'GCZ26',
      underlyingContractMonth: '202612',
      resolutionAt: '2026-08-21T20:00:00.000Z',
      payoutAt: '2026-08-22T20:00:00.000Z',
    });
  });

  test.each([
    ['an untrusted terms host', [line('METLS', 'Will March 2027 Silver Futures settle above 75?', {
      rulesUrl: 'https://example.com/METLS/terms',
    })]],
    ['conflicting contract months', [
      line('METLG', 'Will December 2026 Gold Futures settle above 4,200?'),
      line('METLG', 'Will February 2027 Gold Futures settle above 4,250?'),
    ]],
    ['an implicit front month', [line('COMCO', 'Will WTI futures settle above 85?')]],
  ])('rejects %s instead of inferring an exact resolver', (_label, lines) => {
    expect(() => validateForecastCommodityGeneration(lines, lines[0].productId))
      .toThrow(expect.objectContaining({ code: 'FORECASTEX_COMMODITY_IDENTITY_INVALID' }));
  });
});
