const {
  cmeBulletinConfigForSymbol,
  createCmeDailyBulletinLoader,
  parseFinalCmeBulletinPages,
} = require('./cmeDailyBulletinSettlements.cjs');

const item = (str, x, y) => ({ str, transform: [1, 0, 0, 1, x, y] });

function equityPage(overrides = {}) {
  const values = [
    item('Fri, Aug 14, 2026', 490, 910),
    item('FINAL', 270, 925),
    item('EMINI S&P FUT', 18, 827),
    item(overrides.month || 'SEP26', 18, 822),
    item('7770.00', 45, 822),
    item('7824.25', 299, 822),
    item('+', 332, 822),
    item('5200', 351, 822),
    item('TOTAL  EMINI S&P FUT', 18, 779),
  ];
  return values.filter((candidate) => !overrides.removeFinal || candidate.str !== 'FINAL')
    .map((candidate) => (candidate.str.includes('Aug 14') && overrides.date ? { ...candidate, str: overrides.date } : candidate))
    .concat(overrides.extra || []);
}

function metalsPage(overrides = {}) {
  return [
    item('Fri, Aug 14, 2026', 490, 910),
    item('FINAL', 270, 925),
    item('GC FUT', 18, 865),
    item('COMEX GOLD FUTURES', 96, 865),
    item('AUG26', 18, 855),
    item('4410.00', 126, 855),
    item('4368.60', 281, 855),
    item('-', 312, 855),
    item('45.30', 329, 855),
    item('TOTAL  GC FUT', 18, 642),
    ...(overrides.extra || []),
  ];
}

describe('CME FINAL daily bulletin settlement parser', () => {
  test('extracts only the settlement cell for exact ESU26 and GCQ26 contract months', () => {
    expect(parseFinalCmeBulletinPages([equityPage()], {
      settlementSymbol: 'ESU26',
      tradingDate: '2026-08-14',
    })).toMatchObject({
      settlementSymbol: 'ESU26',
      contractMonth: 'SEP26',
      value: 7824.25,
      market: 'sp500',
      productCode: 'FES',
    });
    expect(parseFinalCmeBulletinPages([metalsPage()], {
      settlementSymbol: 'GCQ26',
      tradingDate: '2026-08-14',
    })).toMatchObject({
      settlementSymbol: 'GCQ26',
      contractMonth: 'AUG26',
      value: 4368.6,
      market: 'gold',
      productCode: 'METLG',
    });
  });

  test('rejects preliminary, wrong-date, duplicate-product, and duplicate-month documents', () => {
    expect(() => parseFinalCmeBulletinPages([equityPage({ removeFinal: true })], {
      settlementSymbol: 'ESU26', tradingDate: '2026-08-14',
    })).toThrow(/not marked FINAL/i);
    expect(() => parseFinalCmeBulletinPages([equityPage({ date: 'Thu, Aug 13, 2026' })], {
      settlementSymbol: 'ESU26', tradingDate: '2026-08-14',
    })).toThrow(/date did not match/i);
    expect(() => parseFinalCmeBulletinPages([equityPage({ extra: [item('EMINI S&P FUT', 18, 600)] })], {
      settlementSymbol: 'ESU26', tradingDate: '2026-08-14',
    })).toThrow(/ambiguous or missing expected product/i);
    expect(() => parseFinalCmeBulletinPages([metalsPage({ extra: [item('AUG26', 18, 800)] })], {
      settlementSymbol: 'GCQ26', tradingDate: '2026-08-14',
    })).toThrow(/ambiguous or missing expected contract month/i);
  });

  test('rejects unsupported symbols and ambiguous settlement cells', () => {
    expect(() => parseFinalCmeBulletinPages([equityPage()], {
      settlementSymbol: 'ESV26', tradingDate: '2026-08-14',
    })).toThrow(/exact supported/i);
    expect(() => parseFinalCmeBulletinPages([equityPage({ extra: [item('9999.00', 280, 822)] })], {
      settlementSymbol: 'ESU26', tradingDate: '2026-08-14',
    })).toThrow(/settlement cell was ambiguous/i);
  });

  test('constructs future quarterly ES bulletin identities dynamically', () => {
    expect(cmeBulletinConfigForSymbol('ESZ27')).toMatchObject({
      contractMonth: 'DEC27', market: 'sp500', productCode: 'FES',
    });
    expect(parseFinalCmeBulletinPages([equityPage({ month: 'DEC27' })], {
      settlementSymbol: 'ESZ27', tradingDate: '2026-08-14',
    })).toMatchObject({ settlementSymbol: 'ESZ27', contractMonth: 'DEC27', value: 7824.25 });
  });

  test('shares concurrent bulletin downloads and briefly throttles failed downloads', async () => {
    const pdfBuffer = Buffer.from('%PDF-test');
    const parser = jest.fn(async () => ({ text: JSON.stringify(equityPage()) }));
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      url: 'https://www.cmegroup.com/daily_bulletin/current/Section11_Equity_And_Index_Futures.pdf',
      headers: { get: () => 'application/pdf' },
      arrayBuffer: async () => pdfBuffer,
    }));
    const loader = createCmeDailyBulletinLoader({ fetchImpl, parser });
    const [first, second] = await Promise.all([
      loader({ settlementSymbol: 'ESU26', tradingDate: '2026-08-14' }),
      loader({ settlementSymbol: 'ESU26', tradingDate: '2026-08-14' }),
    ]);
    expect(first.value).toBe(7824.25);
    expect(second.value).toBe(7824.25);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const failedFetch = jest.fn(async () => { throw new Error('offline'); });
    const failingLoader = createCmeDailyBulletinLoader({
      fetchImpl: failedFetch,
      parser,
      failureCacheTtlMs: 30_000,
    });
    await expect(failingLoader({ settlementSymbol: 'ESU26', tradingDate: '2026-08-14' }))
      .rejects.toMatchObject({ code: 'CME_BULLETIN_FETCH_UNAVAILABLE' });
    await expect(failingLoader({ settlementSymbol: 'ESU26', tradingDate: '2026-08-14' }))
      .rejects.toMatchObject({ code: 'CME_BULLETIN_FETCH_UNAVAILABLE' });
    expect(failedFetch).toHaveBeenCalledTimes(1);
  });
});
