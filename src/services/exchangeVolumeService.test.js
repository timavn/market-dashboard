/** @jest-environment node */
const fixture = require('./__fixtures__/exchange-volume-cboe-2026.json');
const { createExchangeVolumeService, parseCboeVolumeCsv, requiredVolumeDates, CBOE_VOLUME_URL } = require('./exchangeVolumeService.cjs');
const {
  calculateExchangeVolumeMetrics, expectedVolumeTradingDate, isVerifiedExchangeVolumeResponse,
  exchangeVolumeFreshness,
  EXCHANGE_VOLUME_WINDOWS,
} = require('../utils/exchangeVolume.cjs');

const NOW = new Date('2026-09-09T13:00:00Z');
const header = 'Day,Market Participant,Tape A Shares,Tape B Shares,Tape C Shares,Total Shares';
// Network-shaped unit-test input made from the independently downloaded totals.
// Real participant parsing is covered separately with the untouched CSV rows.
function csvForYear(year, totals = fixture.dailyTotals) {
  return [header, ...totals.filter(row => row.date.startsWith(String(year))).map(row => (
    `${row.date},Test aggregate,0,0,${row.consolidatedShares},${row.consolidatedShares}`
  ))].join('\n');
}

function clientFor(totals = fixture.dailyTotals) {
  return { get: jest.fn(async url => {
    const year = Number(url.match(/market_history_(\d{4})\.csv$/)[1]);
    return { status: 200, data: csvForYear(year, totals) };
  }) };
}


function participantClient({ omittedDates = [], renamedAt = null, realTarget = false } = {}) {
  const regularVenue = 'NYSE (N)';
  const trfVenue = 'FINRA / Nasdaq TRF Carteret (DQ)';
  return { get: jest.fn(async url => {
    const year = Number(url.match(/market_history_(\d{4})\.csv$/)[1]);
    const rows = fixture.dailyTotals.filter(row => row.date.startsWith(String(year))).flatMap(row => {
      if (realTarget && row.date === fixture.participantSamples.date) {
        const sample = fixture.participantSamples;
        const fields = header.split(',');
        return sample.rows.filter(values => !omittedDates.includes(row.date)
          || values[sample.csvHeader.indexOf('Market Participant')] !== trfVenue)
          .map(values => fields.map(field => values[sample.csvHeader.indexOf(field)]).join(','));
      }
      const trfName = renamedAt && row.date >= renamedAt ? 'FINRA / Renamed TRF (DQ)' : trfVenue;
      const half = row.consolidatedShares / 2;
      return [
        `${row.date},${regularVenue},0,0,${half},${half}`,
        ...(!omittedDates.includes(row.date) ? [`${row.date},${trfName},0,0,${half},${half}`] : []),
      ];
    });
    return { status: 200, data: [header, ...rows].join('\n') };
  }) };
}

function makeService(axiosClient = clientFor(), now = () => NOW) {
  return createExchangeVolumeService({ axiosClient, now });
}

describe('Cboe exchange-volume calculation', () => {
  test.each(fixture.benchmarks)('reproduces the source-derived exchange row for $date', benchmark => {
    const history = fixture.dailyTotals.filter(row => row.date <= benchmark.date)
      .sort((a, b) => b.date.localeCompare(a.date)).map(row => row.consolidatedShares);
    const metrics = calculateExchangeVolumeMetrics(history);
    expect([metrics.pctPriorDay, metrics.pct1M, metrics.pct3M, metrics.pct1Y].map(Math.round)).toEqual([
      benchmark.priorDay, benchmark.oneMonth, benchmark.threeMonth, benchmark.oneYear,
    ]);
  });

  test('parses all real participants, including FINRA, without truncating fractional shares', () => {
    const sample = fixture.participantSamples;
    const csv = [sample.csvHeader.join(','), ...sample.rows.map(row => row.join(','))].join('\n');
    const result = parseCboeVolumeCsv(csv, { targetDate: sample.date, year: 2026 });
    expect(result).toHaveLength(1);
    expect(result[0].volume).toBeCloseTo(sample.expectedConsolidatedShares, 4);
    expect(result[0].volume).toBeGreaterThan(7982369224); // on-exchange-only total
    expect(Number.isInteger(result[0].volume)).toBe(false);
  });

  test('uses exactly 21/60/250 preceding sessions and ignores observations beyond each window', () => {
    const history = [200, ...Array(250).fill(100), 100000];
    const metrics = calculateExchangeVolumeMetrics(history);
    expect(metrics).toMatchObject({ avg1M: 100, avg3M: 100, avg1Y: 100, pct1M: 100, pct3M: 100, pct1Y: 100 });
    history[22] = 200;
    expect(calculateExchangeVolumeMetrics(history).avg1M).toBe(100);
    expect(calculateExchangeVolumeMetrics(history).avg3M).toBeCloseTo(101.6666667);
    history[61] = 300;
    expect(calculateExchangeVolumeMetrics(history).avg3M).toBeCloseTo(101.6666667);
    expect(calculateExchangeVolumeMetrics(history).avg1Y).toBeCloseTo(101.2);
  });

  test.each([null, undefined, NaN, Infinity, 0, -1, '100'])('does not replace invalid history %s with zero or shift the window', invalid => {
    const history = [200, ...Array(250).fill(100)];
    history[45] = invalid;
    expect(calculateExchangeVolumeMetrics(history)).toMatchObject({ pctPriorDay: 100, pct1M: 100, pct3M: null, pct1Y: null });
  });

  test.each([
    ['2026-09-08T13:00:00Z', '2026-09-04'],
    ['2026-09-07T13:00:00Z', '2026-09-04'],
    ['2026-09-06T13:00:00Z', '2026-09-04'],
    ['2026-09-09T23:59:00Z', '2026-09-08'],
    ['2026-09-10T03:59:00Z', '2026-09-08'],
    ['2026-09-10T04:01:00Z', '2026-09-09'],
    ['2026-01-02T13:00:00Z', '2025-12-31'],
  ])('uses the previous New York trading date at %s', (now, date) => {
    expect(expectedVolumeTradingDate(now)).toBe(date);
  });
});

describe('verified exchange-volume service', () => {
  test('fetches the needed annual files and returns canonical exchange-only metrics', async () => {
    const client = clientFor();
    const result = await makeService(client).fetchSnapshot();
    expect(client.get.mock.calls.map(([url]) => url)).toEqual([CBOE_VOLUME_URL(2026), CBOE_VOLUME_URL(2025)]);
    expect(result.totalMarket).toEqual([]);
    expect(result.asOf).toBe('2026-09-08');
    expect(result.meta.comparisonWindows).toEqual(EXCHANGE_VOLUME_WINDOWS);
    expect(isVerifiedExchangeVolumeResponse(result, NOW)).toBe(true);
    expect(Object.values(result.metrics.exchange).every(Number.isFinite)).toBe(true);
    expect(Object.keys(result.metrics)).toEqual(['exchange']);
  });

  test('deduplicates simultaneous reads but re-verifies the provider on the next refresh', async () => {
    const client = clientFor();
    const service = makeService(client);
    const first = service.fetchSnapshot();
    const second = service.fetchSnapshot();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(client.get).toHaveBeenCalledTimes(2);
    await service.fetchSnapshot();
    expect(client.get).toHaveBeenCalledTimes(4);
  });

  test('calculates full windows independently of the requested response-history limit', async () => {
    const result = await makeService().fetchSnapshot({ days: 2 });
    expect(result.totalExchange).toHaveLength(2);
    expect(Math.round(result.metrics.exchange.pct1Y)).toBe(-15);
  });

  test('fetches an older year when the previous year contains fewer than 251 sessions', async () => {
    const target = '2025-12-31';
    const dates = requiredVolumeDates(target);
    const totals = dates.map(date => ({ date, consolidatedShares: 100 }));
    const client = clientFor(totals);
    const result = await makeService(client, () => new Date('2026-01-02T13:00:00Z')).fetchSnapshot();
    expect(client.get.mock.calls.map(([url]) => url)).toEqual([CBOE_VOLUME_URL(2025), CBOE_VOLUME_URL(2024)]);
    expect(result.asOf).toBe(target);
    expect(result.metrics.exchange.pct1Y).toBe(0);
  });

  test('fetches the preceding year to check the oldest averaging session roster', async () => {
    const dates = requiredVolumeDates('2026-12-31');
    expect(dates[dates.length - 1]).toBe('2026-01-02');
    const totals = [...dates, '2025-12-31'].map(date => ({ date, consolidatedShares: 100 }));
    const client = clientFor(totals);
    const result = await makeService(client, () => new Date('2027-01-04T13:00:00Z')).fetchSnapshot();
    expect(client.get.mock.calls.map(([url]) => url)).toEqual([CBOE_VOLUME_URL(2026), CBOE_VOLUME_URL(2025)]);
    expect(result.asOf).toBe('2026-12-31');
    expect(result.metrics.exchange.pct1Y).toBe(0);
  });

  test('does not average across a missing trading session', async () => {
    const absent = requiredVolumeDates('2026-09-08')[45];
    const result = await makeService(clientFor(fixture.dailyTotals.filter(row => row.date !== absent))).fetchSnapshot();
    expect(result.meta.status).toBe('current');
    expect(result.metrics.exchange).toMatchObject({ pct3M: null, pct1Y: null });
    expect(result.metrics.exchange.pct1M).toBeCloseTo(4.16688058);
  });

  test('rejects an omitted FINRA participant from the measured real source session', async () => {
    const client = participantClient({ realTarget: true, omittedDates: [fixture.participantSamples.date] });
    const result = await makeService(client).fetchSnapshot();
    expect(result).toMatchObject({ asOf: null, totalExchange: [], meta: { status: 'unavailable', verified: false } });
    expect(Object.values(result.metrics.exchange)).toEqual(Array(8).fill(null));
  });

  test('rejects an incomplete prior session instead of using an incorrect prior-day baseline', async () => {
    const result = await makeService(participantClient({ omittedDates: ['2026-09-04'] })).fetchSnapshot();
    expect(result.asOf).toBeNull();
    expect(result.totalExchange).toEqual([]);
    expect(result.meta.status).toBe('unavailable');
  });

  test('nulls only windows containing an isolated historical participant omission', async () => {
    const omittedDate = requiredVolumeDates('2026-09-08')[45];
    const result = await makeService(participantClient({ omittedDates: [omittedDate] })).fetchSnapshot();
    expect(result.meta.status).toBe('current');
    expect(result.metrics.exchange).toMatchObject({ pct3M: null, pct1Y: null });
    expect(result.metrics.exchange.pct1M).toBeCloseTo(4.16688058);
    expect(result.totalExchange.find(row => row.date === omittedDate).volume).toBeNull();
  });

  test('checks participant continuity across annual-file boundaries', async () => {
    const result = await makeService(participantClient({ omittedDates: ['2026-01-02'] })).fetchSnapshot();
    expect(result.meta.status).toBe('current');
    expect(result.metrics.exchange.pct1Y).toBeNull();
    expect(result.metrics.exchange.pct3M).toBeCloseTo(-11.70924877);
    expect(result.totalExchange.find(row => row.date === '2026-01-02').volume).toBeNull();
  });

  test('allows a genuine historical roster change across the year boundary', async () => {
    const result = await makeService(participantClient({ renamedAt: '2026-01-02' })).fetchSnapshot();
    expect(result.meta.status).toBe('current');
    expect(Object.values(result.metrics.exchange).every(Number.isFinite)).toBe(true);
    expect(Math.round(result.metrics.exchange.pct1Y)).toBe(-15);
  });

  test('conservatively withholds a target-day rename until the roster is stable', async () => {
    const result = await makeService(participantClient({ renamedAt: '2026-09-08' })).fetchSnapshot();
    expect(result.meta.status).toBe('unavailable');
    expect(result.totalExchange).toEqual([]);
  });

  test('ignores an unfinished current-date row even after the regular close', async () => {
    const client = clientFor([...fixture.dailyTotals, { date: '2026-09-09', consolidatedShares: 1 }]);
    const result = await makeService(client, () => new Date('2026-09-09T23:00:00Z')).fetchSnapshot();
    expect(result.asOf).toBe('2026-09-08');
    expect(result.totalExchange.some(row => row.date === '2026-09-09')).toBe(false);
    expect(Math.round(result.metrics.exchange.pctPriorDay)).toBe(20);
  });

  test.each(['2026-09-08', '2026-09-04'])('fails closed when the measured or previous session %s is missing', async absent => {
    const result = await makeService(clientFor(fixture.dailyTotals.filter(row => row.date !== absent))).fetchSnapshot();
    expect(result).toMatchObject({ asOf: null, totalMarket: [], totalExchange: [], meta: { status: 'unavailable', verified: false } });
    expect(Object.values(result.metrics.exchange)).toEqual(Array(8).fill(null));
  });

  test('drops previously successful results after a failed refresh', async () => {
    const client = clientFor();
    const service = makeService(client);
    expect((await service.fetchSnapshot()).meta.status).toBe('current');
    client.get.mockRejectedValue(new Error('provider unavailable'));
    const failed = await service.fetchSnapshot();
    expect(failed).toMatchObject({ asOf: null, totalExchange: [], totalMarket: [], meta: { status: 'unavailable', verified: false } });
    expect(Object.values(failed.metrics.exchange)).toEqual(Array(8).fill(null));
  });

  test.each([
    { stale: true }, { cacheOnly: true }, { seeded: true }, { mock: true },
    { providerConnected: false }, { meta: { status: 'offline' } }, { status: 503 },
  ])('rejects unverified upstream responses %j', async flags => {
    const client = clientFor();
    const original = client.get.getMockImplementation();
    client.get.mockImplementation(async url => ({ ...await original(url), ...flags }));
    const result = await makeService(client).fetchSnapshot();
    expect(result.totalExchange).toEqual([]);
    expect(result.meta.status).toBe('unavailable');
  });

  test.each([
    '<html>Provider error</html>',
    `${header}\n2026-09-08,NYSE,0,0,100,200`,
    `${header}\n2026-09-08,NYSE,0,0,,`,
    `${header}\n2026-09-08,NYSE,0,0,100,100\n2026-09-08,NYSE,0,0,100,100`,
  ])('rejects malformed or duplicated source data', async csv => {
    const result = await makeService({ get: jest.fn().mockResolvedValue({ status: 200, data: csv }) }).fetchSnapshot();
    expect(result.totalExchange).toEqual([]);
    expect(result.meta.status).toBe('unavailable');
  });
});

describe('volume response provenance and freshness', () => {
  test.each([
    result => { result.meta.fetchedAt = '2026-09-09T12:00:00Z'; },
    result => { result.asOf = '2026-03-18'; result.meta.asOfTradingDate = '2026-03-18'; },
    result => { result.meta.methodologyVersion = 'hedgeye-volume-slide-direct-v1'; },
    result => { result.meta.cacheOnly = true; },
    result => { result.totalExchange[0].mock = true; },
    result => { result.metrics.exchange.seeded = true; },
    result => { result.meta.sourceBreakdown = []; },
    result => { result.meta.comparisonWindows = { ...EXCHANGE_VOLUME_WINDOWS, avg1Y: 252 }; },
    result => { result.metrics.exchange.pct1M = '4'; },
  ])('rejects stale or unverified card data despite a recent retrieval timestamp', async alter => {
    const result = JSON.parse(JSON.stringify(await makeService().fetchSnapshot()));
    alter(result);
    expect(isVerifiedExchangeVolumeResponse(result, NOW)).toBe(false);
  });
});

describe('Products-panel Volume freshness', () => {
  test('reports a verified Cboe session as current with its trading date', async () => {
    const result = await makeService().fetchSnapshot({ days: 2 });
    expect(exchangeVolumeFreshness(result, NOW)).toMatchObject({
      status: 'current', date: '2026-09-08', lastUpdated: '2026-09-08', source: 'CboeHistoricalMarketVolume',
    });
  });

  test('reports a session Cboe has not posted yet as pending', async () => {
    const result = await makeService(clientFor(fixture.dailyTotals.filter(row => row.date !== '2026-09-08'))).fetchSnapshot();
    expect(exchangeVolumeFreshness(result, NOW)).toMatchObject({
      status: 'pending', date: null, reason: 'Cboe has not posted the 2026-09-08 session yet.',
    });
  });

  test('reports any other unverified response as an error', async () => {
    const client = { get: jest.fn(async () => ({ status: 200, data: '<html>blocked</html>' })) };
    const result = await makeService(client).fetchSnapshot();
    expect(exchangeVolumeFreshness(result, NOW)).toMatchObject({
      status: 'error', errorCode: 'CBOE_VOLUME_INVALID_CSV',
    });
  });
});
