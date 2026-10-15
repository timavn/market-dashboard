const { SERIES, parseOfficialSovereignCsv, fetchOfficialSovereignSeries } = require('./officialSovereignYields.cjs');

const NOW = Date.parse('2026-09-25T17:00:00.000Z');
const point = (date, close) => ({ t: Date.parse(`${date}T00:00:00Z`), close });
const bundesbank = rows => `"",${SERIES.BUND10Y.seriesId},${SERIES.BUND10Y.seriesId}_FLAGS\n"",Daily yield of the current 10 year federal bond,\nDecimals,2,\nlast update,2026-09-25 12:09:13,\n${rows}`;
const japan = rows => `Interest Rate,,,,(Unit : %)\nDate,1Y,5Y,10Y,20Y\n${rows}`;
const england = rows => `DATE,IUDMNPY\n${rows}`;
const response = data => ({ status: 200, data });

describe('official sovereign daily yield references', () => {
  test('retains negative and zero published yields, sorts and deduplicates dates, and ignores notes, missing data and future observations', () => {
    const parsed = parseOfficialSovereignCsv('BUND10Y', bundesbank([
      '2026-09-25,3.58,', '2026-09-22,-0.02,', '2026-09-23,0,',
      '2026-09-24,3.57,', '2026-09-25,3.59,Provisional', '2026-09-25,.,No value available',
      '2026-09-26,4.0,', '2026-09-20,.,No value available', '2026-09-19,,',
      '2026-09-18,Infinity,', '2026-09-17,3.1 note,', '2026-09-16,NaN,',
      '2026-02-30,3.0,', 'Comment,2026-09-25,3.5', '"Source note, not a date",99,',
    ].join('\n')), { now: NOW });
    expect(parsed).toEqual([
      point('2026-09-22', -0.02), point('2026-09-23', 0),
      point('2026-09-24', 3.57), point('2026-09-25', 3.59),
    ]);
  });

  test('finds the explicit Japan 10Y header rather than assuming a neighboring tenor', () => {
    expect(parseOfficialSovereignCsv('JGB10Y', japan([
      '2026/9/24,1.627,2.4,3.073,3.887', '2026/9/18,1.578,2.305,2.981,3.812',
      '2026/9/17,1,2,-,4', '2026/13/1,1,2,5,4',
      '"If you cannot download the latest csv data, clear your browser cache",,,,',
    ].join('\r\n')), { now: NOW, startDate: '2026-09-19' })).toEqual([point('2026-09-24', 3.073)]);
  });

  test('parses British daily dates and fails closed for another series or malformed content', () => {
    expect(parseOfficialSovereignCsv('GILT10Y', england('23 Sep 2026,5.291\n24 Sep 2026,5.3\n31 Sep 2026,99'), { now: NOW }))
      .toEqual([point('2026-09-23', 5.291), point('2026-09-24', 5.3)]);
    for (const payload of ['DATE,IUDMNZC\n23 Sep 2026,5.291', '<html>Service unavailable</html>', { close: 5.291 }]) {
      expect(parseOfficialSovereignCsv('GILT10Y', payload, { now: NOW })).toEqual([]);
    }
  });

  test('fetches a date-bounded Bundesbank series with its historical-only provenance intact', async () => {
    const httpClient = { get: jest.fn().mockResolvedValue(response(bundesbank('2026-09-24,3.57,\n2026-09-25,3.58,'))) };
    const series = await fetchOfficialSovereignSeries('bund10y', { httpClient, now: NOW, startDate: '2025-09-01' });
    expect(series).toEqual({
      symbol: 'BUND10Y', source: 'bundesbank', seriesId: SERIES.BUND10Y.seriesId,
      sourceUrl: SERIES.BUND10Y.sourceUrl, sourceInstrument: SERIES.BUND10Y.sourceInstrument,
      observationFrequency: 'daily', dataType: 'historical', receivedAt: new Date(NOW).toISOString(),
      closes: [point('2026-09-24', 3.57), point('2026-09-25', 3.58)],
    });
    const url = new URL(httpClient.get.mock.calls[0][0]);
    expect(url.searchParams.get('startPeriod')).toBe('2025-09-01');
    expect(url.searchParams.get('endPeriod')).toBe('2026-09-25');
  });

  test('merges the Japan archive and current publication without mixing benchmarks', async () => {
    const httpClient = { get: jest.fn()
      .mockResolvedValueOnce(response(japan('2026/8/31,1,2,2.943,4\n2026/9/1,1,2,2.9,4')))
      .mockResolvedValueOnce(response(japan('2026/9/1,1,2,2.987,4\n2026/9/24,1,2,3.073,4'))) };
    const series = await fetchOfficialSovereignSeries('JGB10Y', { httpClient, now: NOW });
    expect(series).toMatchObject({ source: 'japan_mof', observationFrequency: 'daily', dataType: 'historical' });
    expect(series.closes).toEqual([point('2026-08-31', 2.943), point('2026-09-01', 2.987), point('2026-09-24', 3.073)]);
    expect(httpClient.get.mock.calls.map(call => call[0])).toEqual([SERIES.JGB10Y.historyUrl, SERIES.JGB10Y.dataUrl]);
  });

  test('accepts an empty Japan current-month publication at month rollover while retaining verified archive data', async () => {
    const httpClient = { get: jest.fn()
      .mockResolvedValueOnce(response(japan('2026/8/31,1,2,2.943,4')))
      .mockResolvedValueOnce(response(japan(',,,,\n"Publisher note",,,,'))) };
    const series = await fetchOfficialSovereignSeries('JGB10Y', { httpClient, now: Date.parse('2026-09-01T00:00:00Z') });
    expect(series.closes).toEqual([point('2026-08-31', 2.943)]);
  });

  test('requests only the British nominal par series and exposes its precise instrument identity', async () => {
    const httpClient = { get: jest.fn().mockResolvedValue(response(england('23 Sep 2026,5.291'))) };
    const series = await fetchOfficialSovereignSeries('GILT10Y', { httpClient, now: NOW, startDate: '2025-09-01' });
    const url = new URL(httpClient.get.mock.calls[0][0]);
    expect(url.searchParams.get('SeriesCodes')).toBe('IUDMNPY');
    expect(url.searchParams.get('Datefrom')).toBe('01/Sep/2025');
    expect(url.searchParams.get('Dateto')).toBe('25/Sep/2026');
    expect(series).toMatchObject({ source: 'bank_of_england', sourceInstrument: expect.stringContaining('nominal par'), closes: [point('2026-09-23', 5.291)] });
  });

  test('shares a successful historical fetch without rewriting receipt time and does not restore it after an offline refresh', async () => {
    const httpClient = { get: jest.fn()
      .mockResolvedValueOnce(response(england('23 Sep 2026,5.291')))
      .mockRejectedValueOnce(new Error('Provider offline'))
      .mockResolvedValueOnce(response(england('24 Sep 2026,5.3'))) };
    const first = await fetchOfficialSovereignSeries('GILT10Y', { httpClient, now: NOW });
    const repeated = await fetchOfficialSovereignSeries('GILT10Y', { httpClient, now: NOW + 30_000 });
    expect(repeated).toBe(first);
    expect(httpClient.get).toHaveBeenCalledTimes(1);
    expect(await fetchOfficialSovereignSeries('GILT10Y', { httpClient, now: NOW + 60_000, forceRefresh: true })).toBeNull();
    const recovered = await fetchOfficialSovereignSeries('GILT10Y', { httpClient, now: NOW + 90_000 });
    expect(recovered.closes).toEqual([point('2026-09-24', 5.3)]);
    expect(recovered.receivedAt).toBe(new Date(NOW + 90_000).toISOString());
  });

  test.each([
    ['HTTP failure', { status: 503, data: england('23 Sep 2026,5.291') }],
    ['unidentified data', response('DATE,UNKNOWN\n23 Sep 2026,5.291')],
    ['cache-only JSON', response({ cacheOnly: true, price: 5.291 })],
    ['seed JSON', response({ seeded: true, price: 5.291 })],
    ['mock JSON', response({ mock: true, price: 5.291 })],
    ['future data', response(england('26 Sep 2026,5.291'))],
    ['missing values', response(england('23 Sep 2026,\n24 Sep 2026,..'))],
  ])('returns unavailable for %s', async (_label, providerResponse) => {
    const httpClient = { get: jest.fn().mockResolvedValue(providerResponse) };
    expect(await fetchOfficialSovereignSeries('GILT10Y', { httpClient, now: NOW })).toBeNull();
  });

  test('does not request unknown symbols or impossible requested dates', async () => {
    const httpClient = { get: jest.fn() };
    expect(await fetchOfficialSovereignSeries('UNKNOWN', { httpClient, now: NOW })).toBeNull();
    expect(await fetchOfficialSovereignSeries('GILT10Y', { httpClient, now: NOW, startDate: '2026-02-30' })).toBeNull();
    expect(httpClient.get).not.toHaveBeenCalled();
  });
});
