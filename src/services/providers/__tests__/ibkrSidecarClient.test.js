const { getSidecarProviderStatus, sidecarRequest } = require('../ibkrSidecarClient');

describe('ibkrSidecarClient error provenance', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('parses only the sidecar error code from a failed JSON response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: jest.fn().mockResolvedValue(JSON.stringify({
        errorCode: 'UNSETTLED_SECURITIES_ACTIVITY',
        message: 'sensitive broker amount 12345',
      })),
    });

    await expect(sidecarRequest('/portfolio/live-balance')).rejects.toMatchObject({
      status: 503,
      sidecarCode: 'UNSETTLED_SECURITIES_ACTIVITY',
      message: 'IBKR sidecar HTTP 503',
    });
  });

  test('accepts the sidecar snake_case error code used by the live portfolio endpoint', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: jest.fn().mockResolvedValue(JSON.stringify({
        status: 'positions_request_timeout',
        error_code: 'IBKR_POSITIONS_REQUEST_TIMEOUT',
        message: 'The fresh positions request timed out.',
      })),
    });

    await expect(sidecarRequest('/portfolio/live-positions')).rejects.toMatchObject({
      status: 503,
      sidecarCode: 'IBKR_POSITIONS_REQUEST_TIMEOUT',
    });
  });

  test('coalesces concurrent provider health probes without sharing caller identity', async () => {
    global.fetch = jest.fn(async (url) => ({
      ok: true,
      status: 200,
      text: jest.fn().mockResolvedValue(JSON.stringify(
        String(url).endsWith('/livez')
          ? { ok: true, status: 'alive' }
          : { connected: true, status: 'connected', accounts: ['U1234567'] },
      )),
    }));

    const [marketData, portfolio, monitor] = await Promise.all([
      getSidecarProviderStatus('ibkr'),
      getSidecarProviderStatus('ibkr_portfolio'),
      getSidecarProviderStatus('prediction_monitor'),
    ]);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(marketData).toMatchObject({ name: 'ibkr', connected: true });
    expect(portfolio).toMatchObject({ name: 'ibkr_portfolio', connected: true });
    expect(monitor).toMatchObject({ name: 'prediction_monitor', connected: true });
  });

  test('rechecks the sidecar after a shared provider health probe completes', async () => {
    global.fetch = jest.fn(async (url) => ({
      ok: true,
      status: 200,
      text: jest.fn().mockResolvedValue(JSON.stringify(
        String(url).endsWith('/livez')
          ? { ok: true, status: 'alive' }
          : { connected: true, status: 'connected', accounts: [] },
      )),
    }));

    await getSidecarProviderStatus('first');
    await getSidecarProviderStatus('second');

    expect(global.fetch).toHaveBeenCalledTimes(4);
  });
});
