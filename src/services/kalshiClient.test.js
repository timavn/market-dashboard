/**
 * @jest-environment node
 */
const { kalshiFetch, parseUrl } = require('./kalshiClient');

describe('Kalshi client query serialization', () => {
  test('serializes orderbook ticker arrays as repeated query parameters', () => {
    const { url } = parseUrl('https://example.test/trade-api/v2', '/markets/orderbooks', {
      tickers: ['ONE', 'TWO', 'THREE'],
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.getAll('tickers')).toEqual(['ONE', 'TWO', 'THREE']);
    expect(parsed.searchParams.get('tickers')).not.toContain(',');
  });
});

describe('Kalshi client request timeout', () => {
  const CREDENTIAL_VARIABLES = ['KALSHI_API_KEY_ID', 'KALSHI_PRIVATE_KEY_PEM', 'KALSHI_PRIVATE_KEY_PATH', 'KALSHI_REQUEST_TIMEOUT_MS'];
  let originalFetch;
  let originalEnvironment;

  beforeEach(() => {
    originalFetch = global.fetch;
    // No request leaves this file, and none is signed with a real key.
    originalEnvironment = Object.fromEntries(CREDENTIAL_VARIABLES.map((name) => [name, process.env[name]]));
    CREDENTIAL_VARIABLES.forEach((name) => { delete process.env[name]; });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const untilAborted = (signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
  });

  test('every request carries a time limit and an answer in time is returned', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ events: [{ ticker: 'ONE' }] }) }));

    await expect(kalshiFetch('/events', { limit: 1 })).resolves.toEqual({ events: [{ ticker: 'ONE' }] });

    const [, init] = global.fetch.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal.aborted).toBe(false);
  });

  test('a request Kalshi never answers is given up on', async () => {
    global.fetch = jest.fn((url, init) => untilAborted(init.signal));

    await expect(kalshiFetch('/events', {}, { timeoutMs: 40 })).rejects.toMatchObject({
      code: 'KALSHI_TIMEOUT',
      message: 'Kalshi did not respond within 0.04 seconds',
    });
  });

  test('a body that stalls after the headers is covered by the same limit', async () => {
    global.fetch = jest.fn(async (url, init) => ({ ok: true, status: 200, json: () => untilAborted(init.signal) }));

    await expect(kalshiFetch('/events', {}, { timeoutMs: 40 })).rejects.toMatchObject({ code: 'KALSHI_TIMEOUT' });
  });

  test('the limit can be set for the process', async () => {
    process.env.KALSHI_REQUEST_TIMEOUT_MS = '30';
    global.fetch = jest.fn((url, init) => untilAborted(init.signal));

    await expect(kalshiFetch('/events')).rejects.toMatchObject({
      message: 'Kalshi did not respond within 0.03 seconds',
    });
  });

  test('other failures are reported as before', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 429, text: async () => '' }));
    await expect(kalshiFetch('/events')).rejects.toMatchObject({ code: 'RATE_LIMIT' });

    global.fetch = jest.fn(async () => ({ ok: false, status: 503, text: async () => 'maintenance' }));
    await expect(kalshiFetch('/events')).rejects.toMatchObject({ status: 503, message: 'Kalshi HTTP 503: maintenance' });

    const offline = new TypeError('fetch failed');
    global.fetch = jest.fn(async () => { throw offline; });
    await expect(kalshiFetch('/events')).rejects.toBe(offline);
  });
});
