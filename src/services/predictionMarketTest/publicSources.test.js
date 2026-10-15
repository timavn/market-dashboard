const {
  createPublicSources,
  normalizeBlsApiYoY,
  normalizeCoinbaseTicker,
  normalizeKalshiEvent,
  parseBlsReleaseHtml,
  parseForecastExContractsResponse,
  parseForecastExPairsCsv,
  parseForecastExPairRows,
  parseForecastExPairRowsAsync,
} = require('./publicSources.cjs');

describe('Resolver Test public source parsers', () => {
  test('parses quarter-based GDP metadata without promoting catalog last prices into a quote', () => {
    const row = {
      contract_id: 'RGDP_Q326_-0.5', product_id: 'RGDP',
      question: 'Will the annualized growth rate in US Real GDP exceed -0.5% in Q3 2026?',
      last_trade_date: '2026-12-23T07:30:00', expiration_date: '2026-12-23T07:30:00', payout_date: '2026-12-23T09:30:00',
      exchange_spec_url: 'https://data.forecastex.com/regulatory/RGDPTermsandConditions.pdf',
      open_interest: 110, last_yes_price: 0.88, last_no_price: 0.12,
    };
    const payload = (overrides = {}) => ({ statusCode: 200, body: { data: JSON.stringify([{ ...row, ...overrides }]) } });
    const [parsed] = parseForecastExContractsResponse(payload(), { productId: 'RGDP' });
    expect(parsed).toMatchObject({
      measuredQuarter: '2026-Q3', settlementStage: 'third', comparator: '>', strike: -0.5,
      lastTradeDate: '2026-12-23T13:30:00.000Z', payoutDate: '2026-12-23T15:30:00.000Z', openInterest: 110, volume: null,
    });
    expect(parsed.yesBid).toBeUndefined();
    expect(parsed.yesPrice).toBeUndefined();
    expect(parsed.noAsk).toBeUndefined();
    expect(() => parseForecastExContractsResponse(payload({ contract_id: 'RGDP_Q226_-0.5' }), { productId: 'RGDP' })).toThrow();
  });

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

  test('forced ForecastEx reads bypass both catalog and tape caches while preserving execution times', async () => {
    let clock = Date.parse('2026-08-20T20:00:00.000Z');
    const pairTime = '2026-08-20T19:59:00.000Z';
    const csv = `pair_id,event_contract,expiration_date,quantity,yes_price,no_price,pair_time\ntrade,FGC_082026_4000,2026-08-21,3,0.57,0.43,${pairTime}`;
    const catalog = JSON.stringify({ statusCode: 200, body: { data: JSON.stringify([{ contract_id: 'FGC_082026_4000', product_id: 'FGC' }]) } });
    const fetchImpl = jest.fn(async url => ({ ok: true, text: async () => url.includes('/contracts?') ? catalog : csv }));
    const sources = createPublicSources({ fetchImpl, now: () => new Date(clock) });
    await sources.getForecastExContracts('FGC');
    await sources.getForecastExPairs('20260820', ['FGC_']);
    await sources.getForecastExContracts('FGC');
    await sources.getForecastExPairs('20260820', ['FGC_']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    clock += 100;
    const options = { forceRefresh: true, refreshAfter: clock };
    const [contracts, pairs, otherPairs] = await Promise.all([
      sources.getForecastExContracts('FGC', options),
      sources.getForecastExPairs('20260820', ['FGC_'], options),
      sources.getForecastExPairs('20260820', ['FES_'], options),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(contracts.fetchedAt).toBe(new Date(clock).toISOString());
    expect(pairs.fetchedAt).toBe(otherPairs.fetchedAt);
    expect(pairs.trades[0].pairTime).toBe(pairTime);
    await sources.getForecastExPairs('20260820', ['FGC_'], options);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  test('forced tape reads do not join pre-boundary acquisitions or let late results overwrite them', async () => {
    let clock = Date.parse('2026-08-20T20:00:00.000Z');
    const pending = [];
    const csv = price => `pair_id,event_contract,expiration_date,quantity,yes_price,no_price,pair_time\ntrade,FGC_082026_4000,2026-08-21,3,${price},0.43,2026-08-20T19:59:00.000Z`;
    const fetchImpl = jest.fn(() => new Promise(resolve => pending.push(resolve)));
    const sources = createPublicSources({ fetchImpl, now: () => new Date(clock) });
    const first = sources.getForecastExPairs('20260820', ['FGC_']);
    for (let step = 0; step < 5; step += 1) await Promise.resolve();
    clock += 100;
    const options = { forceRefresh: true, refreshAfter: clock };
    const forced = sources.getForecastExPairs('20260820', ['FGC_'], options);
    const duplicate = sources.getForecastExPairs('20260820', ['FGC_'], options);
    for (let step = 0; step < 5; step += 1) await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    pending[1]({ ok: true, text: async () => csv(0.57) });
    expect((await forced).trades[0].yesPrice).toBe(0.57);
    expect((await duplicate).trades[0].yesPrice).toBe(0.57);
    pending[0]({ ok: true, text: async () => csv(0.40) });
    expect((await first).trades[0].yesPrice).toBe(0.40);
    expect((await sources.getForecastExPairs('20260820', ['FGC_'])).trades[0].yesPrice).toBe(0.57);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('failed forced public acquisition clears a prior success instead of returning it', async () => {
    let clock = Date.parse('2026-08-20T20:00:00.000Z');
    const fetchImpl = jest.fn(async () => ({ ok: true, text: async () => JSON.stringify({ price: 100, bid: 99, ask: 101, time: '2026-08-20T19:59:59Z' }) }));
    const sources = createPublicSources({ fetchImpl, now: () => new Date(clock) });
    expect((await sources.getCoinbaseSpot('BTC-USD')).sourceTimestamp).toBe('2026-08-20T19:59:59.000Z');
    clock += 100;
    fetchImpl.mockResolvedValue({ ok: false, status: 503 });
    await expect(sources.getCoinbaseSpot('BTC-USD', { forceRefresh: true, refreshAfter: clock })).rejects.toThrow();
    await expect(sources.getCoinbaseSpot('BTC-USD')).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
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


describe('cooperative ForecastEx execution tape parsing', () => {
  const header = 'pair_id,event_contract,expiration_date,quantity,yes_price,no_price,pair_time';

  test('preserves literal prices, timestamps, quoted CSV fields, blank lines and trailing CRLF', async () => {
    const csv = '\uFEFF\r\n' + [header,
      'late,FES_082026_7800,2026-08-21,3,0.5700,0.4300,2026-08-20T14:59:00-05:00',
      '"trade""one","FES_082026_,edge",2026-08-21,"1,234",0.46,0.54,2026-08-20T14:58:00-05:00',
      '',
      'excluded,FNQ_082026_30100,2026-08-21,2,0.46,0.54,2026-08-20T14:58:00-05:00',
    ].join('\r\n') + '\r\n';
    const options = { allowedPrefixes: ['FES_082026_'] };
    const result = await parseForecastExPairRowsAsync(csv, options);
    expect(result).toEqual(parseForecastExPairRows(csv, options));
    expect(result).toEqual([
      { pairId: 'trade"one', contractId: 'FES_082026_,edge', expirationDate: '2026-08-21', quantity: 1234,
        yesPrice: 0.46, noPrice: 0.54, pairTime: '2026-08-20T19:58:00.000Z' },
      { pairId: 'late', contractId: 'FES_082026_7800', expirationDate: '2026-08-21', quantity: 3,
        yesPrice: 0.57, noPrice: 0.43, pairTime: '2026-08-20T19:59:00.000Z' },
    ]);
    expect(await parseForecastExPairRowsAsync(header + '\r\n')).toEqual([]);
    expect(await parseForecastExPairRowsAsync(header + '\n' +
      'outside,FNQ_082026_30100,2026-08-21,2,bad,bad,bad', options)).toEqual([]);
  });

  test('matches stable ordering for reversed timestamps and equal keys across sorting batches', async () => {
    const rows = Array.from({ length: 1800 }, (_, index) =>
      `same,FES_082026_${index % 3},2026-08-21,${index},0.57,0.43,2026-08-20T19:5${5 - index % 6}:00Z`);
    const csv = [header, ...rows].join('\n');
    const result = await parseForecastExPairRowsAsync(csv);
    expect(result).toEqual(parseForecastExPairRows(csv));
    const tied = result.filter(row => row.contractId === 'FES_082026_0' && row.pairTime === '2026-08-20T19:55:00.000Z');
    expect(tied.map(row => row.quantity)).toEqual([...tied.map(row => row.quantity)].sort((a, b) => a - b));
    expect(result.every(row => Object.keys(row).length === 7)).toBe(true);
  });

  test.each([
    '', ' \r\n', 'x'.repeat(12 * 1024 * 1024 + 1),
    'pair_id,event_contract',
    `${header}\nshort,FES_082026_7800`,
    `${header}\ninvalid,FES_082026_7800,2026-08-21,3,1.1,0.43,2026-08-20T19:59:00Z`,
    `${header}\ninvalid,FES_082026_7800,2026-08-21,3,0.57,NaN,2026-08-20T19:59:00Z`,
    `${header}\ninvalid,FES_082026_7800,2026-08-21,3,0.57,0.43,unverified-time`,
    `${header}\n"unterminated,FES_082026_7800,2026-08-21,3,0.57,0.43,2026-08-20T19:59:00Z`,
  ].map((csv, index) => [index, csv]))('rejects invalid tape %s with the original validation error', async (_index, csv) => {
    let original;
    try { parseForecastExPairRows(csv); } catch (error) { original = error; }
    expect(original).toBeDefined();
    await expect(parseForecastExPairRowsAsync(csv)).rejects.toMatchObject({ code: original.code, message: original.message });
  });

  test('a late invalid forced tape clears prior success without publishing its validated prefix', async () => {
    let clock = Date.parse('2026-08-20T20:00:00.000Z');
    const valid = 'trade,FES_082026_7800,2026-08-21,1,0.57,0.43,2026-08-20T19:59:00Z';
    const fetchImpl = jest.fn(async () => ({ ok: true, text: async () => header + '\n' + valid }));
    const sources = createPublicSources({ fetchImpl, now: () => new Date(clock) });
    expect((await sources.getForecastExPairs('20260820', ['FES_'])).trades[0].yesPrice).toBe(0.57);
    const invalid = [header, ...Array(700).fill(valid),
      'invalid,FES_082026_7800,2026-08-21,1,NaN,0.43,2026-08-20T19:59:00Z'].join('\n');
    fetchImpl.mockResolvedValue({ ok: true, text: async () => invalid });
    clock += 100;
    await expect(sources.getForecastExPairs('20260820', ['FES_'], { forceRefresh: true, refreshAfter: clock }))
      .rejects.toMatchObject({ code: 'PM_TEST_FORECASTEX_PAIRS_INVALID' });
    await expect(sources.getForecastExPairs('20260820', ['FES_']))
      .rejects.toMatchObject({ code: 'PM_TEST_FORECASTEX_PAIRS_INVALID' });
    expect(sources.getHealth().forecastex.status).toBe('unavailable');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test('a full runtime tape leaves an event-loop turn available before acquisition finishes', async () => {
    const { setImmediate: eventLoopTurn } = require('node:timers/promises');
    const rows = Array.from({ length: 6000 }, (_, index) =>
      `pair-${index},FES_082026_${7800 + index % 3},2026-08-21,${index + 1},0.57,0.43,2026-08-20T19:59:00Z`);
    const csv = [header, ...rows.reverse()].join('\n');
    const sources = createPublicSources({
      fetchImpl: async () => ({ ok: true, text: async () => csv }),
      now: () => new Date('2026-08-20T20:00:00.000Z'),
    });
    let finished = false;
    const read = sources.getForecastExPairs('20260820', ['FES_082026_']).then(value => { finished = true; return value; });
    await eventLoopTurn();
    expect(finished).toBe(false);
    const result = await read;
    expect(result.executions).toEqual(parseForecastExPairRows(csv));
    expect(result.provider).toBe('forecastex_public_execution_tape');
    expect(result.fetchedAt).toBe('2026-08-20T20:00:00.000Z');
  });
});
