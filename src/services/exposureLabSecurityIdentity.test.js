const {
  AUDITED_ARCHIVE_NAME_SOURCE,
  SEC_NAME_SOURCE,
  YAHOO_NAME_SOURCE,
  applyExposureLabSecurityNames,
  consolidateQualifiedIdentityAliases,
  createExposureLabSecurityIdentityResolver,
  normalizeSecurityName,
  parseSecCompanyTickerDirectory,
  parseYahooSecurityIdentity,
  resolveExposureLabYahooSymbol,
} = require('./exposureLabSecurityIdentity.cjs');

const SEC_DIRECTORY = {
  fields: ['cik', 'name', 'ticker', 'exchange'],
  data: [
    [1577552, 'Alibaba Group Holding Ltd', 'BABA', 'NYSE'],
    [1739445, 'Arcosa, Inc.', 'ACA', 'NYSE'],
    [9389, 'BALL Corp', 'BALL', 'NYSE'],
    [9999999, 'Neighborhood Intelligence, Inc.', 'BBBY', 'NYSE'],
    [1841175, 'Grayscale Bitcoin Mini Trust ETF', 'BTC', 'NYSE'],
    [1528849, 'RH', 'RH', 'NYSE'],
  ],
};

function yahooPayload({ symbol, longName, instrumentType = 'ETF' }) {
  return {
    chart: {
      error: null,
      result: [{
        meta: {
          symbol,
          longName,
          instrumentType,
          exchangeName: 'NYQ',
        },
      }],
    },
  };
}

describe('exposureLabSecurityIdentity', () => {
  test('parses the SEC directory and rejects discovery-product labels as names', () => {
    const directory = parseSecCompanyTickerDirectory(SEC_DIRECTORY);
    expect(directory.get('BABA')).toEqual(expect.objectContaining({
      name: 'Alibaba Group Holding Ltd',
      nameSource: SEC_NAME_SOURCE,
      cik: 1577552,
      exchange: 'NYSE',
    }));
    expect(normalizeSecurityName('Real-Time Alert', 'BABA')).toBeNull();
    expect(normalizeSecurityName('BABA', 'BABA')).toBeNull();
    expect(normalizeSecurityName('152931', 'HTV')).toBeNull();
    expect(directory.get('RH')).toEqual(expect.objectContaining({
      name: 'RH',
      nameSource: SEC_NAME_SOURCE,
    }));
  });

  test('uses audited mention-date identities for renamed, acquired, or reused symbols', () => {
    const result = applyExposureLabSecurityNames({
      rows: [
        { ticker: 'BBBY', discoveryState: 'structured', existingUniverse: false },
        { ticker: 'THS', discoveryState: 'candidate', confidenceKinds: ['text_explicit'] },
      ],
    }, { secDirectory: parseSecCompanyTickerDirectory(SEC_DIRECTORY) });
    const rows = Object.fromEntries(result.rows.map((row) => [row.ticker, row]));

    expect(rows.BBBY).toEqual(expect.objectContaining({
      name: 'Bed Bath & Beyond, Inc.',
      nameSource: AUDITED_ARCHIVE_NAME_SOURCE,
      nameVerified: false,
    }));
    expect(rows.THS).toEqual(expect.objectContaining({
      name: 'TreeHouse Foods, Inc.',
      nameSource: AUDITED_ARCHIVE_NAME_SOURCE,
      nameVerified: false,
    }));
  });

  test('normalizes audited research aliases to exact Yahoo identity symbols', () => {
    expect(resolveExposureLabYahooSymbol('EUR')).toBe('EURUSD=X');
    expect(resolveExposureLabYahooSymbol('5930.KR')).toBe('005930.KS');
    expect(resolveExposureLabYahooSymbol('CWR.LN')).toBe('CWR.L');
    expect(resolveExposureLabYahooSymbol('LTMC.IM')).toBe('LTMC.MI');
    expect(resolveExposureLabYahooSymbol('EDR.SM')).toBe('EDR.MC');
    expect(resolveExposureLabYahooSymbol('XMR')).toBe('XMR-USD');
    expect(resolveExposureLabYahooSymbol('USD/JPY')).toBe('USDJPY=X');
    expect(resolveExposureLabYahooSymbol('PAVE', (ticker) => ticker)).toBe('PAVE');
    expect(parseYahooSecurityIdentity('FDRXX', 'FDRXX', yahooPayload({
      symbol: 'FDRXX',
      longName: 'Fidelity Cash Reserves',
      instrumentType: 'MONEYMARKET',
    }))).toEqual(expect.objectContaining({
      name: 'Fidelity Cash Reserves',
      instrumentType: 'MONEYMARKET',
    }));
  });

  test('consolidates only unnamed list fragments into a unique provider-verified qualified symbol', () => {
    const result = consolidateQualifiedIdentityAliases({
      rows: [
        {
          ticker: 'ADS', name: null, nameVerified: false,
          discoveryState: 'candidate', confidenceKinds: ['structured_list'],
          mentionCount: 1, pullCount: 1, firstSeen: '2026-07-01', lastSeen: '2026-07-01',
          products: [{ product: 'the-call', mentionCount: 1, firstSeen: '2026-07-01', lastSeen: '2026-07-01' }],
          evidence: [{ product: 'the-call', kind: 'structured_list', path: 'data.longs[0]' }],
        },
        {
          ticker: 'ADS.DE', name: 'adidas AG', nameVerified: true,
          discoveryState: 'structured', confidenceKinds: ['declared_position'],
          mentionCount: 8, pullCount: 3, firstSeen: '2026-07-15', lastSeen: '2026-08-20',
          products: [{ product: 'the-call', mentionCount: 8, firstSeen: '2026-07-15', lastSeen: '2026-08-20' }],
          evidence: [],
        },
        {
          ticker: 'A', name: 'AGILENT TECHNOLOGIES, INC.', nameVerified: true,
          discoveryState: 'candidate', confidenceKinds: ['structured_list'],
          products: [{ product: 'the-call', mentionCount: 1 }],
        },
      ],
      meta: { universeCount: 3, resolvedNameCount: 2, unresolvedNameCount: 1 },
    });

    expect(result.rows.map((row) => row.ticker)).toEqual(['ADS.DE', 'A']);
    expect(result.rows[0]).toEqual(expect.objectContaining({
      mentionCount: 9,
      pullCount: 4,
      firstSeen: '2026-07-01',
      consolidatedAliases: ['ADS'],
    }));
    expect(result.meta).toEqual(expect.objectContaining({
      universeCount: 2,
      resolvedNameCount: 2,
      unresolvedNameCount: 0,
      consolidatedAliasCount: 1,
    }));
  });

  test('uses exact provider identities without treating Hedgeye labels or parser tokens as names', async () => {
    const httpClient = {
      get: jest.fn(async (url) => {
        if (url.includes('sec.gov')) return { data: SEC_DIRECTORY };
        if (url.includes('/PAVE')) {
          return { data: yahooPayload({
            symbol: 'PAVE',
            longName: 'Global X U.S. Infrastructure Development ETF',
          }) };
        }
        if (url.includes('/ATZ.TO')) {
          return { data: yahooPayload({
            symbol: 'ATZ.TO',
            longName: 'Aritzia Inc.',
            instrumentType: 'EQUITY',
          }) };
        }
        if (url.includes('/SNXX')) {
          return { data: yahooPayload({
            symbol: 'SNXX',
            longName: 'Tradr 2X Long SNDK Daily ETF',
          }) };
        }
        throw new Error(`Unexpected identity request: ${url}`);
      }),
    };
    const resolver = createExposureLabSecurityIdentityResolver({
      httpClient,
      now: () => Date.parse('2026-08-23T12:00:00.000Z'),
      concurrency: 2,
    });
    const result = await resolver.resolve({
      rows: [
        { ticker: 'BABA', name: 'Real-Time Alert', discoveryState: 'structured', existingUniverse: false },
        { ticker: 'BALL', name: 'Real-Time Alert', discoveryState: 'structured', existingUniverse: false },
        { ticker: 'PAVE', name: 'US Infrastructure', discoveryState: 'structured', existingUniverse: false },
        { ticker: 'ABOUT', name: 'Real-Time Alert', discoveryState: 'candidate', existingUniverse: false },
        {
          ticker: 'ACA', name: null, discoveryState: 'candidate', existingUniverse: false,
          confidenceKinds: ['text_explicit'],
        },
        { ticker: 'ATZ.TO', name: null, discoveryState: 'candidate', existingUniverse: false },
        {
          ticker: 'SNXX', name: null, discoveryState: 'candidate', existingUniverse: false,
          confidenceKinds: ['text_explicit'],
        },
        {
          ticker: 'SPY', name: 'S&P 500', catalogName: 'S&P 500',
          discoveryState: 'catalogued', existingUniverse: true,
        },
        {
          ticker: 'BTC', name: 'Bitcoin', catalogName: 'Bitcoin',
          discoveryState: 'catalogued', existingUniverse: true,
        },
      ],
      meta: { universeCount: 9 },
    });
    const rows = Object.fromEntries(result.rows.map((row) => [row.ticker, row]));

    expect(rows.BABA).toEqual(expect.objectContaining({
      name: 'Alibaba Group Holding Ltd',
      nameSource: SEC_NAME_SOURCE,
      nameVerified: true,
    }));
    expect(rows.BALL.name).toBe('BALL Corp');
    expect(rows.PAVE).toEqual(expect.objectContaining({
      name: 'Global X U.S. Infrastructure Development ETF',
      nameSource: YAHOO_NAME_SOURCE,
      nameVerified: true,
    }));
    expect(rows.ABOUT.name).toBeNull();
    expect(rows.ACA.name).toBeNull();
    expect(rows['ATZ.TO']).toEqual(expect.objectContaining({
      name: 'Aritzia Inc.',
      nameSource: YAHOO_NAME_SOURCE,
      nameVerified: true,
    }));
    expect(rows.SNXX).toEqual(expect.objectContaining({
      name: 'Tradr 2X Long SNDK Daily ETF',
      nameSource: YAHOO_NAME_SOURCE,
      nameVerified: true,
    }));
    expect(rows.SPY).toEqual(expect.objectContaining({
      name: 'S&P 500',
      nameSource: 'Dashboard security catalog',
      nameVerified: false,
    }));
    expect(rows.BTC).toEqual(expect.objectContaining({
      name: 'Bitcoin',
      nameSource: 'Dashboard security catalog',
      nameVerified: false,
    }));
    expect(result.meta).toEqual(expect.objectContaining({
      resolvedNameCount: 7,
      unresolvedNameCount: 2,
    }));
    expect(result.identityDirectory.status).toBe('available');
    expect(httpClient.get).toHaveBeenCalledTimes(4);
    expect(httpClient.get.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
      expect.stringContaining('/PAVE'),
      expect.stringContaining('/ATZ.TO'),
      expect.stringContaining('/SNXX'),
    ]));
  });

  test('keeps provider-derived names empty when the SEC directory is unavailable', async () => {
    const httpClient = {
      get: jest.fn().mockRejectedValue(Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })),
    };
    const resolver = createExposureLabSecurityIdentityResolver({ httpClient });
    const result = await resolver.resolve({
      rows: [
        { ticker: 'BABA', name: 'Real-Time Alert', discoveryState: 'structured', existingUniverse: false },
        {
          ticker: 'SPY', name: 'S&P 500', catalogName: 'S&P 500',
          discoveryState: 'catalogued', existingUniverse: true,
        },
      ],
    });

    expect(result.rows.find((row) => row.ticker === 'BABA').name).toBeNull();
    expect(result.rows.find((row) => row.ticker === 'SPY').name).toBe('S&P 500');
    expect(result.identityDirectory).toEqual(expect.objectContaining({
      status: 'unavailable',
      reason: 'ECONNREFUSED',
    }));
    expect(httpClient.get).toHaveBeenCalledTimes(1);
  });
});
