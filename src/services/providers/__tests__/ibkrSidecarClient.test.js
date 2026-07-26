const { sidecarRequest } = require('../ibkrSidecarClient');

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

    await expect(sidecarRequest('/portfolio/live-funding')).rejects.toMatchObject({
      status: 503,
      sidecarCode: 'UNSETTLED_SECURITIES_ACTIVITY',
      message: 'IBKR sidecar HTTP 503',
    });
  });
});
