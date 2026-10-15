/** @jest-environment node */
const { createRegionalVolumeService } = require('./regionalVolumeService.cjs');

const NOW = new Date('2026-09-09T13:00:00Z');
const TARGET_DATE = '2026-09-08';
const EMPTY_METRICS = {
  priorDay: null, avg1M: null, avg3M: null, avg1Y: null,
  pctPriorDay: null, pct1M: null, pct3M: null, pct1Y: null,
};

function providerPayload(provider, volume) {
  return {
    asOf: TARGET_DATE,
    totalMarket: [],
    totalExchange: [{ date: TARGET_DATE, volume }],
    metrics: { exchange: { priorDay: volume, pctPriorDay: 10, pct1M: 5, pct3M: null, pct1Y: null } },
    meta: {
      status: 'current', verified: true, provider,
      asOfTradingDate: TARGET_DATE, fetchedAt: '2026-09-09T12:59:00Z',
    },
  };
}

function makeServices() {
  const usPayload = providerPayload('Cboe', 1000000000);
  const exUsPayload = providerPayload('IBKR', 1000000);
  const usService = { fetchSnapshot: jest.fn().mockResolvedValue(usPayload) };
  const exUsService = { fetchSnapshot: jest.fn().mockResolvedValue(exUsPayload) };
  return {
    usPayload,
    exUsPayload,
    usService,
    exUsService,
    service: createRegionalVolumeService({ usService, exUsService, now: () => NOW }),
  };
}

function expectUnavailable(payload, provider, errorCode) {
  expect(payload).toMatchObject({
    asOf: null,
    totalMarket: [],
    totalExchange: [],
    metrics: { exchange: EMPTY_METRICS },
    meta: {
      status: 'unavailable', verified: false, provider,
      asOfTradingDate: null, expectedTradingDate: TARGET_DATE,
      fetchedAt: NOW.toISOString(), errorCode,
      comparisonWindows: { priorDay: 1, avg1M: 21, avg3M: 60, avg1Y: 250 },
      ...(provider === 'IBKR' ? { providerConnected: false, contract: null } : {}),
    },
  });
  expect(payload.totalMarket).toHaveLength(0);
  expect(payload.totalExchange).toHaveLength(0);
  expect(payload.metrics.exchange).toEqual(EMPTY_METRICS);
}

describe('regional volume facade', () => {
  test('preserves the U.S. root payload and attaches independent ex-U.S. data without changing provenance', async () => {
    const { service, usPayload, exUsPayload } = makeServices();
    const originalUs = JSON.parse(JSON.stringify(usPayload));
    const originalExUs = JSON.parse(JSON.stringify(exUsPayload));

    const result = await service.fetchSnapshot();

    expect(result).toEqual({ ...originalUs, exUs: originalExUs });
    expect(result.meta).toBe(usPayload.meta);
    expect(result.totalExchange).toBe(usPayload.totalExchange);
    expect(result.metrics).toBe(usPayload.metrics);
    expect(result.exUs).toBe(exUsPayload);
    expect(usPayload).toEqual(originalUs);
    expect(exUsPayload).toEqual(originalExUs);
  });

  test('forwards the same options to both regional services', async () => {
    const { service, usService, exUsService } = makeServices();
    const options = { days: 2, force: true };

    await service.fetchSnapshot(options);

    expect(usService.fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(exUsService.fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(usService.fetchSnapshot.mock.calls[0][0]).toBe(options);
    expect(exUsService.fetchSnapshot.mock.calls[0][0]).toBe(options);
  });

  test('supplies empty options to both services when none are requested', async () => {
    const { service, usService, exUsService } = makeServices();

    await service.fetchSnapshot();

    expect(usService.fetchSnapshot).toHaveBeenCalledWith({});
    expect(exUsService.fetchSnapshot).toHaveBeenCalledWith({});
  });

  test('starts both requests before either provider completes', async () => {
    const { service, usService, exUsService, usPayload } = makeServices();
    let resolveUs;
    usService.fetchSnapshot.mockImplementation(() => new Promise(resolve => { resolveUs = resolve; }));

    const pending = service.fetchSnapshot();
    await Promise.resolve();

    expect(usService.fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(exUsService.fetchSnapshot).toHaveBeenCalledTimes(1);
    resolveUs(usPayload);
    await expect(pending).resolves.toMatchObject({ asOf: TARGET_DATE, exUs: { asOf: TARGET_DATE } });
  });

  test.each([
    ['U.S.', 'throw'], ['U.S.', 'reject'], ['ex-U.S.', 'throw'], ['ex-U.S.', 'reject'],
  ])('retains the other region when %s providers %s', async (region, failure) => {
    const { service, usService, exUsService, usPayload, exUsPayload } = makeServices();
    const failingService = region === 'U.S.' ? usService : exUsService;
    const error = new Error('Provider failed');
    if (failure === 'throw') {
      failingService.fetchSnapshot.mockImplementation(() => { throw error; });
    } else {
      failingService.fetchSnapshot.mockRejectedValue(error);
    }

    const result = await service.fetchSnapshot();

    expect(usService.fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(exUsService.fetchSnapshot).toHaveBeenCalledTimes(1);
    const failedPayload = region === 'U.S.' ? result : result.exUs;
    const healthyPayload = region === 'U.S.' ? result.exUs : result;
    expectUnavailable(
      failedPayload,
      region === 'U.S.' ? 'Cboe' : 'IBKR',
      region === 'U.S.' ? 'CBOE_VOLUME_FETCH_FAILED' : 'EX_US_VOLUME_FETCH_FAILED',
    );
    expect(healthyPayload).toMatchObject(region === 'U.S.' ? exUsPayload : usPayload);
  });

  test('returns empty histories and null metrics for both regions when both requests fail', async () => {
    const { service, usService, exUsService } = makeServices();
    usService.fetchSnapshot.mockImplementation(() => { throw new Error('Cboe unavailable'); });
    exUsService.fetchSnapshot.mockRejectedValue(new Error('IBKR disconnected'));

    const result = await service.fetchSnapshot();

    expectUnavailable(result, 'Cboe', 'CBOE_VOLUME_FETCH_FAILED');
    expectUnavailable(result.exUs, 'IBKR', 'EX_US_VOLUME_FETCH_FAILED');
    expect(usService.fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(exUsService.fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  test.each(['U.S.', 'ex-U.S.'])('preserves the %s service unavailable state and its original verification time', async region => {
    const { service, usService, exUsService, usPayload, exUsPayload } = makeServices();
    const unavailable = {
      asOf: null, totalMarket: [], totalExchange: [], metrics: { exchange: { ...EMPTY_METRICS } },
      meta: {
        status: 'unavailable', verified: false,
        provider: region === 'U.S.' ? 'Cboe' : 'IBKR',
        fetchedAt: '2026-09-09T12:59:30Z', errorCode: 'PROVIDER_DISCONNECTED',
      },
    };
    (region === 'U.S.' ? usService : exUsService).fetchSnapshot.mockResolvedValue(unavailable);

    const result = await service.fetchSnapshot();

    expect(result).toEqual(region === 'U.S.'
      ? { ...unavailable, exUs: exUsPayload }
      : { ...usPayload, exUs: unavailable });
    const unavailableResult = region === 'U.S.' ? result : result.exUs;
    expect(unavailableResult.meta).toBe(unavailable.meta);
  });

  test.each([null, undefined, false, 'unavailable', 0])('fails each region closed for a non-payload response %s', async invalid => {
    const { service, usService, exUsService } = makeServices();
    usService.fetchSnapshot.mockResolvedValue(invalid);
    exUsService.fetchSnapshot.mockResolvedValue(invalid);

    const result = await service.fetchSnapshot();

    expectUnavailable(result, 'Cboe', 'CBOE_VOLUME_FETCH_FAILED');
    expectUnavailable(result.exUs, 'IBKR', 'EX_US_VOLUME_FETCH_FAILED');
    expect(usService.fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(exUsService.fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  test('clears previously returned data from the failed region after a refresh', async () => {
    const { service, usService, exUsService, exUsPayload } = makeServices();
    expect((await service.fetchSnapshot()).asOf).toBe(TARGET_DATE);
    usService.fetchSnapshot.mockRejectedValue(new Error('Cboe offline'));

    const result = await service.fetchSnapshot();

    expectUnavailable(result, 'Cboe', 'CBOE_VOLUME_FETCH_FAILED');
    expect(result.exUs).toBe(exUsPayload);
    expect(usService.fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(exUsService.fetchSnapshot).toHaveBeenCalledTimes(2);
  });
});
