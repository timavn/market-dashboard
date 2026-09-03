const {
  createPublicSources,
  normalizeBlsApiYoY,
  normalizeCoinbaseTicker,
  normalizeKalshiEvent,
  parseBlsReleaseHtml,
  parseForecastExContractsResponse,
  parseForecastExPairsCsv,
} = require('./publicSources.cjs');

describe('Resolver Test public source parsers', () => {
  test('preserves native Kalshi bid/ask fields without complementary inference', () => {
    const snapshot = normalizeKalshiEvent({
      event: {
        event_ticker: 'KXWTI-26AUG1414',
        title: 'WTI',
        markets: [{
          ticker: 'KXWTI-26AUG1414-T81.49',
          floor_strike: 81.49,
          status: 'active',
          close_time: '2026-08-14T18:30:00Z',
          yes_bid_dollars: '0.42',
          yes_ask_dollars: '0.45',
          no_bid_dollars: '',
          no_ask_dollars: '',
          custom_strike: { front_month_contract: 'WBS 26U-ICE' },
        }],
      },
    }, { eventTicker: 'KXWTI-26AUG1414', fetchedAt: '2026-08-14T18:00:00.000Z' });

    expect(snapshot.lines[0]).toMatchObject({
      strike: 81.49,
      yesBid: 0.42,
      yesAsk: 0.45,
      noBid: null,
      noAsk: null,
      priceType: 'executable_bid_ask',
      customStrike: { frontMonthContract: 'WBS 26U-ICE' },
    });
  });

  test('double-parses ForecastEx contracts and takes only the latest timestamped execution', () => {
    const contracts = parseForecastExContractsResponse({
      statusCode: 200,
      body: {
        data: JSON.stringify([{
          contract_id: 'FES_082026_7800',
          product_id: 'FES',
          question: 'Will Sep-26 S&P 500 Index Futures settle above $7,800 on August 20 2026?',
          open_interest: 12,
          last_trade_date: '2026-08-20 15:00:00',
          expiration_date: '2026-08-20 15:00:00',
          exchange_spec_url: 'https://data.forecastex.com/regulatory/FESTermsandConditions.pdf',
        }]),
      },
    }, { productId: 'FES' });
    expect(contracts[0]).toMatchObject({
      contractId: 'FES_082026_7800',
      strike: 7800,
      resolverSymbol: 'ESU26',
      underlyingContractMonth: '202609',
      openInterest: 12,
      lastTradeDate: '2026-08-20T20:00:00.000Z',
      expirationDate: '2026-08-20T20:00:00.000Z',
    });

    const csv = [
      'pair_id,event_contract,expiration_date,quantity,yes_price,no_price,pair_time',
      'old,FES_082026_7800,2026-08-21,2,0.40,0.60,2026-08-20T12:00:00-05:00',
      'new,FES_082026_7800,2026-08-21,3,0.57,0.43,2026-08-20T14:59:00-05:00',
      'other,FNQ_081426_30100,2026-08-17,1,0.46,0.54,2026-08-14T14:59:00-05:00',
    ].join('\n');
    expect(parseForecastExPairsCsv(csv, { allowedPrefixes: ['FES_082026_'] })).toEqual([
      expect.objectContaining({ pairId: 'new', contractId: 'FES_082026_7800', yesPrice: 0.57, noPrice: 0.43 }),
    ]);
  });

  test('downloads and parses one ForecastEx tape for concurrent market subsets', async () => {
    const csv = [
      'pair_id,event_contract,expiration_date,quantity,yes_price,no_price,pair_time',
      'fes,FES_082026_7800,2026-08-21,3,0.57,0.43,2026-08-20T14:59:00-05:00',
      'fnq,FNQ_082026_30100,2026-08-21,2,0.46,0.54,2026-08-20T14:58:00-05:00',
    ].join('\n');
    const fetchImpl = jest.fn(async () => ({ ok: true, text: async () => csv }));
    const sources = createPublicSources({
      fetchImpl,
      now: () => new Date('2026-08-20T20:00:00.000Z'),
    });

    const [fes, fnq] = await Promise.all([
      sources.getForecastExPairs('20260820', ['FES_082026_']),
      sources.getForecastExPairs('20260820', ['FNQ_082026_']),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fes.executions.map((execution) => execution.contractId)).toEqual(['FES_082026_7800']);
    expect(fnq.executions.map((execution) => execution.contractId)).toEqual(['FNQ_082026_30100']);
    expect(fes.fetchedAt).toBe(fnq.fetchedAt);
  });

  test('rejects ambiguous or non-quarterly FES resolver identities from the official question', () => {
    const row = {
      contract_id: 'FES_082026_7375', product_id: 'FES',
      last_trade_date: '2026-08-20T15:00:00', expiration_date: '2026-08-21T10:00:00', payout_date: '2026-08-21T12:00:00',
    };
    expect(() => parseForecastExContractsResponse({ statusCode: 200, body: { data: JSON.stringify([{ ...row, question: 'Will S&P settle above $7,375?' }]) } }, { productId: 'FES' }))
      .toThrow(/exact dated/i);
    expect(() => parseForecastExContractsResponse({ statusCode: 200, body: { data: JSON.stringify([{ ...row, question: 'Will Oct-26 S&P 500 Index Futures settle above $7,375 on August 20 2026?' }]) } }, { productId: 'FES' }))
      .toThrow(/non-quarterly/i);
    expect(() => parseForecastExContractsResponse({ statusCode: 200, body: { data: JSON.stringify([{
      ...row,
      question: 'Will Sep-26 S&P 500 Index Futures settle above $7,375 on August 20 2026?',
      exchange_spec_url: 'https://example.com/FESTermsandConditions.pdf',
    }]) } }, { productId: 'FES' })).toThrow(/terms/i);
  });

  test('preserves Kalshi range buckets, including open-ended tails', () => {
    const result = normalizeKalshiEvent({
      event: {
        event_ticker: 'KXBTC-26AUG1417',
        title: 'BTC range',
        markets: [
          { ticker: 'LOW', strike_type: 'less', cap_strike: 60_000, subtitle: '$59,999.99 or below' },
          { ticker: 'MID', strike_type: 'between', floor_strike: 60_000, cap_strike: 60_499.99, subtitle: '$60,000 to 60,499.99' },
          { ticker: 'HIGH', strike_type: 'greater', floor_strike: 60_500, subtitle: '$60,500 or above' },
        ],
      },
    }, { eventTicker: 'KXBTC-26AUG1417' });

    expect(result.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ ticker: 'LOW', strikeType: 'less', upperBound: 60_000, lowerBound: null }),
      expect.objectContaining({ ticker: 'MID', strikeType: 'between', lowerBound: 60_000, upperBound: 60_499.99 }),
      expect.objectContaining({ ticker: 'HIGH', strikeType: 'greater', lowerBound: 60_500, upperBound: null }),
    ]));
  });

  test('validates an independent Coinbase BBO without treating it as a resolver', () => {
    expect(normalizeCoinbaseTicker({
      price: '62800.12',
      bid: '62799.99',
      ask: '62800.25',
      time: '2026-08-14T18:00:00.000Z',
    }, { productId: 'BTC-USD', fetchedAt: '2026-08-14T18:00:00.100Z' })).toMatchObject({
      provider: 'coinbase_exchange_public',
      productId: 'BTC-USD',
      price: 62800.12,
      bid: 62799.99,
      ask: 62800.25,
    });
  });

  test('extracts the literal BLS one-decimal sentence and independently verifies the indices', () => {
    const html = `
      <html><title>Consumer Price Index - August 2026</title><body>
      <p>The Consumer Price Index for All Urban Consumers changed in August.</p>
      <p>Over the last 12 months, the all items index increased 3.1 percent before seasonal adjustment.</p>
      </body></html>`;
    expect(parseBlsReleaseHtml(html, { reportMonthLabel: 'August 2026' })).toMatchObject({
      matchedReportMonth: true,
      value: 3.1,
    });
    expect(normalizeBlsApiYoY({
      Results: {
        series: [{
          seriesID: 'CUUR0000SA0',
          data: [
            { year: '2026', period: 'M08', value: '334.020' },
            { year: '2025', period: 'M08', value: '323.976' },
          ],
        }],
      },
    }, {
      seriesId: 'CUUR0000SA0',
      reportMonth: '2026-08',
      priorYearMonth: '2025-08',
    })).toMatchObject({ value: 3.1, currentIndex: 334.02, priorIndex: 323.976 });
  });

  test('fails closed when ForecastEx changes its nested response schema', () => {
    expect(() => parseForecastExContractsResponse({ statusCode: 200, body: { data: [] } }, { productId: 'FES' }))
      .toThrow(/schema changed/i);
  });
});
