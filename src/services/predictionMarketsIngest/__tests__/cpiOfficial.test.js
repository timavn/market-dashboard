const {
  BLS_CPI_DATA_URL,
  BLS_RELEASE_CHECKPOINTS,
  BLS_CPI_SERIES_ID,
  calculateOfficialCpiFinals,
  clearOfficialCpiFinalsCache,
  fetchOfficialCpiFinals,
  loadOfficialCpiFinals,
  mergeOfficialCpiFinals,
  normalizeBlsCpiDataFile,
  normalizeBlsCpiResponse,
  refreshOfficialCpiFinals,
} = require('../cpiOfficial');

describe('official BLS CPI finals', () => {
  beforeEach(() => {
    clearOfficialCpiFinalsCache();
  });

  afterEach(() => {
    clearOfficialCpiFinalsCache();
  });

  test('calculates the one-decimal year-over-year value from official CPI-U indexes', () => {
    expect(calculateOfficialCpiFinals([
      { year: '2025', period: 'M06', value: '322.561' },
      { year: '2026', period: 'M06', value: '333.952' },
    ])).toEqual([
      expect.objectContaining({
        id: '2026-06',
        value: 3.5,
        source: 'bls_api',
        seriesId: BLS_CPI_SERIES_ID,
      }),
    ]);
  });

  test('normalizes only the configured CPI-U series from a BLS response', () => {
    expect(normalizeBlsCpiResponse({
      Results: {
        series: [
          { seriesID: 'OTHER_SERIES', data: [{ year: '2026', period: 'M06', value: '999' }] },
          {
            seriesID: BLS_CPI_SERIES_ID,
            data: [
              { year: '2025', period: 'M06', value: '322.561' },
              { year: '2026', period: 'M06', value: '333.952' },
            ],
          },
        ],
      },
    })).toEqual([
      expect.objectContaining({ id: '2026-06', value: 3.5 }),
    ]);
  });

  test('parses the official BLS flat-file fallback', () => {
    expect(normalizeBlsCpiDataFile([
      'series_id         year period value footnote_codes',
      `${BLS_CPI_SERIES_ID} 2025 M06 322.561`,
      `${BLS_CPI_SERIES_ID} 2026 M06 333.952`,
      'OTHER_SERIES 2026 M06 999',
    ].join('\n'), { startYear: 2025, endYear: 2026 })).toEqual([
      expect.objectContaining({ id: '2026-06', value: 3.5, source: 'bls_flat_file' }),
    ]);
  });

  test('falls back to the official BLS flat file when the JSON API is unavailable', async () => {
    const httpClient = {
      get: jest.fn()
        .mockRejectedValueOnce(new Error('503 Service Unavailable'))
        .mockResolvedValueOnce({
          data: [
            'series_id year period value footnote_codes',
            `${BLS_CPI_SERIES_ID} 2025 M06 322.561`,
            `${BLS_CPI_SERIES_ID} 2026 M06 333.952`,
          ].join('\n'),
        }),
    };

    const result = await refreshOfficialCpiFinals({
      cacheKey: '2025-2026',
      httpClient,
      startYear: 2025,
      endYear: 2026,
    });

    expect(httpClient.get).toHaveBeenNthCalledWith(2, BLS_CPI_DATA_URL, expect.objectContaining({
      responseType: 'text',
    }));
    expect(result).toMatchObject({
      ok: true,
      source: 'bls_flat_file',
      finals: expect.arrayContaining([
        expect.objectContaining({ id: '2026-06', value: 3.5 }),
      ]),
    });
  });

  test('fetches the prior calendar year needed for the earliest requested YoY final', async () => {
    const httpClient = {
      get: jest.fn().mockResolvedValue({
        data: {
          status: 'REQUEST_SUCCEEDED',
          Results: {
            series: [{
              seriesID: BLS_CPI_SERIES_ID,
              data: [
                { year: '2024', period: 'M07', value: '313.534' },
                { year: '2025', period: 'M07', value: '323.427' },
                { year: '2026', period: 'M07', value: '334.424' },
              ],
            }],
          },
        },
      }),
    };

    const result = await fetchOfficialCpiFinals({
      httpClient,
      startYear: 2025,
      endYear: 2026,
    });

    expect(httpClient.get).toHaveBeenCalledWith(
      expect.stringContaining('/publicAPI/v2/timeseries/data/'),
      expect.objectContaining({
        params: expect.objectContaining({ startyear: 2024, endyear: 2026 }),
      }),
    );
    expect(result.finals).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '2025-07', value: 3.2 }),
      expect.objectContaining({ id: '2026-07', value: 3.4 }),
    ]));
  });

  test('returns the verified June checkpoint immediately while the remote refresh is pending', async () => {
    let resolveRequest;
    const pendingRequest = new Promise((resolve) => {
      resolveRequest = resolve;
    });
    const httpClient = { get: jest.fn(() => pendingRequest) };

    const result = await loadOfficialCpiFinals({
      httpClient,
      now: Date.parse('2026-08-09T12:00:00Z'),
      useCache: false,
    });

    expect(result).toMatchObject({
      ok: true,
      refreshing: true,
      remoteStatus: 'refreshing',
      finals: expect.arrayContaining([
        expect.objectContaining({ id: '2026-06', value: 3.5 }),
      ]),
    });
    expect(httpClient.get).toHaveBeenCalledWith(
      expect.stringContaining('/publicAPI/v2/timeseries/data/'),
      expect.objectContaining({ timeout: 10000 }),
    );

    resolveRequest({ data: { status: 'REQUEST_SUCCEEDED', Results: { series: [] } } });
    await Promise.resolve();
    await Promise.resolve();
  });

  test('can await the official remote refresh when a caller requires the latest completed month', async () => {
    const httpClient = {
      get: jest.fn().mockResolvedValue({
        data: {
          status: 'REQUEST_SUCCEEDED',
          Results: {
            series: [{
              seriesID: BLS_CPI_SERIES_ID,
              data: [
                { year: '2025', period: 'M07', value: '323.427' },
                { year: '2026', period: 'M07', value: '334.424' },
              ],
            }],
          },
        },
      }),
    };

    const result = await loadOfficialCpiFinals({
      httpClient,
      now: Date.parse('2026-09-02T12:00:00Z'),
      useCache: false,
      awaitRemote: true,
    });

    expect(result).toMatchObject({
      ok: true,
      refreshing: false,
      remoteStatus: 'ready',
      finals: expect.arrayContaining([
        expect.objectContaining({ id: '2026-07', value: 3.4 }),
      ]),
    });
  });

  test('updates the in-memory cache after a successful BLS refresh', async () => {
    const httpClient = {
      get: jest.fn().mockResolvedValue({
        data: {
          status: 'REQUEST_SUCCEEDED',
          Results: {
            series: [{
              seriesID: BLS_CPI_SERIES_ID,
              data: [
                { year: '2025', period: 'M06', value: '322.561' },
                { year: '2026', period: 'M06', value: '333.952' },
              ],
            }],
          },
        },
      }),
    };

    const refreshed = await refreshOfficialCpiFinals({
      cacheKey: '2025-2026',
      startYear: 2025,
      endYear: 2026,
      httpClient,
    });
    const cached = await loadOfficialCpiFinals({
      httpClient,
      now: Date.parse('2026-08-09T12:00:00Z'),
    });

    expect(refreshed).toMatchObject({ ok: true, remoteStatus: 'ready', refreshing: false });
    expect(cached).toMatchObject({ ok: true, remoteStatus: 'ready', refreshing: false });
    expect(cached.finals).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '2026-06', value: 3.5 }),
    ]));
    expect(httpClient.get).toHaveBeenCalledTimes(1);
  });

  test('retains the verified June checkpoint when both remote BLS sources fail', async () => {
    const httpClient = {
      get: jest.fn().mockRejectedValue(new Error('BLS unavailable')),
    };

    const result = await refreshOfficialCpiFinals({
      cacheKey: '2025-2026',
      startYear: 2025,
      endYear: 2026,
      httpClient,
    });

    expect(result).toMatchObject({
      ok: true,
      refreshing: false,
      remoteStatus: 'unavailable',
      finals: expect.arrayContaining([
        expect.objectContaining({ id: '2026-06', value: 3.5 }),
      ]),
    });
    expect(httpClient.get).toHaveBeenCalledTimes(2);
  });

  test('keeps the verified June release visible while the BLS flat file catches up', () => {
    expect(mergeOfficialCpiFinals([{ id: '2026-05', value: 4.25, source: 'bls_flat_file' }]))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: '2026-05', value: 4.25 }),
        expect.objectContaining(BLS_RELEASE_CHECKPOINTS[0]),
      ]));
  });
});
