import { ANALYST_PDF_MAX_BYTES, analystApi, analystWorkspaceApi, resolveAnalystBackendBase, validateAnalystPdf } from './analystClient';

describe('Analyst local connection pool', () => {
  const local = { protocol: 'http:', hostname: 'localhost', port: '3000' };
  test.each([undefined, 'http://localhost:3001', 'http://localhost:3001/'])('the default local backend %j uses its own loopback hostname', configuredBase => {
    expect(resolveAnalystBackendBase({ configuredBase, location: local })).toBe('http://127.0.0.1:3001');
  });
  test.each([
    'https://api.example.com', 'http://localhost:4001', 'http://localhost:3001/custom',
    'https://localhost:3001', 'http://127.0.0.1:3001',
  ])('preserves a custom backend %s', configuredBase => {
    expect(resolveAnalystBackendBase({ configuredBase, location: local })).toBe(configuredBase);
  });
  test('preserves production configuration and nonlocal defaults', () => {
    expect(resolveAnalystBackendBase({ configuredBase: 'http://localhost:3001', location: local, production: true })).toBe('http://localhost:3001');
    expect(resolveAnalystBackendBase({ location: { protocol: 'https:', hostname: 'dashboard.example.com', port: '' } })).toBe('https://dashboard.example.com:3001');
    expect(resolveAnalystBackendBase()).toBe('http://localhost:3001');
  });
});

const fileLike = ({ name = 'deck.pdf', type = 'application/pdf', bytes = '%PDF-', size } = {}) => {
  const encoded = Uint8Array.from([...bytes].map((character) => character.charCodeAt(0)));
  return {
    name,
    type,
    size: size ?? encoded.byteLength,
    slice: () => ({ arrayBuffer: async () => encoded.buffer }),
  };
};

describe('Analyst PDF client validation', () => {
  test('accepts a bounded PDF with the correct MIME and signature', async () => {
    await expect(validateAnalystPdf(fileLike())).resolves.toBe(true);
  });

  test.each([
    [fileLike({ name: 'deck.txt' }), /Only PDF/],
    [fileLike({ type: 'text/plain' }), /application\/pdf/],
    [fileLike({ size: 0 }), /empty/],
    [fileLike({ size: ANALYST_PDF_MAX_BYTES + 1 }), /50 MB/],
    [fileLike({ bytes: 'NOPE!' }), /signature/],
  ])('rejects an invalid file', async (file, expected) => {
    await expect(validateAnalystPdf(file)).rejects.toThrow(expected);
  });
});

describe('Analyst review acceptance deadlines', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    jest.useFakeTimers();
    global.fetch = jest.fn((_url, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ ok: true, json: async () => ({ conversation: { id: 'accepted-review' } }) }), 20_000);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      });
    }));
  });
  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
  });

  test('a slow review acknowledgment succeeds without an early timeout or duplicate request', async () => {
    const response = analystWorkspaceApi.request('/daily/portfolio-review', {});
    await Promise.all([
      expect(response).resolves.toEqual({ conversation: { id: 'accepted-review' } }),
      jest.advanceTimersByTimeAsync(20_000),
    ]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][1].signal.aborted).toBe(false);
  });

  test('ordinary history reads retain the shorter deadline', async () => {
    const response = analystWorkspaceApi.request('/conversations');
    await Promise.all([
      expect(response).rejects.toMatchObject({ code: 'ANALYST_REQUEST_TIMEOUT' }),
      jest.advanceTimersByTimeAsync(15_000),
    ]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('lightweight source metadata checks stop waiting after three seconds', async () => {
    const response = analystWorkspaceApi.request('/conversations/captured-review/sources');
    await Promise.all([
      expect(response).rejects.toMatchObject({ code: 'ANALYST_REQUEST_TIMEOUT' }),
      jest.advanceTimersByTimeAsync(3_000),
    ]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  test('a review start still has a finite deadline without resubmitting the review', async () => {
    global.fetch.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
    }));
    const response = analystWorkspaceApi.request('/daily/portfolio-review', { refresh: true, requestId: 'same-review' });
    await Promise.all([
      expect(response).rejects.toMatchObject({ code: 'ANALYST_REQUEST_TIMEOUT' }),
      jest.advanceTimersByTimeAsync(45_000),
    ]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('Analyst server error codes', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  test.each([[404, 'ANALYST_CONVERSATION_NOT_FOUND'], [410, 'ANALYST_CONVERSATION_DELETED']])(
    'a %i response exposes its explicit server code', async (status, code) => {
      global.fetch = jest.fn(async () => ({ ok: false, status, json: async () => ({ error: 'Conversation unavailable.', code }) }));
      await expect(analystWorkspaceApi.request('/conversations/saved')).rejects.toMatchObject({ code, serverCode: code, status });
    });

  test('a code-less 404 keeps its HTTP code without claiming a server reason', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'Not found' }) }));
    const error = await analystWorkspaceApi.request('/conversations/saved').catch(failure => failure);
    expect(error).toMatchObject({ code: 'HTTP_404', status: 404 });
    expect(error).not.toHaveProperty('serverCode');
  });
});

describe('Analyst workspace request headers', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
  });
  afterEach(() => { global.fetch = originalFetch; });

  test.each(['/inbox', '/conversations', '/conversations/capture?includeBriefs=false&briefScope=latest', '/conversations/capture/sources'])(
    'bodyless GET %s avoids a JSON Content-Type preflight', async path => {
      await expect(analystWorkspaceApi.request(path)).resolves.toEqual({ ok: true });
      const options = global.fetch.mock.calls[0][1];
      expect(options.method).toBe('GET');
      expect(options.cache).toBe('no-store');
      expect(options).not.toHaveProperty('headers');
      expect(options).not.toHaveProperty('body');
    });

  test.each([['POST', '/daily/portfolio-review'], ['PUT', '/process'], ['PATCH', '/conversations/capture']])(
    '%s %s retains its exact JSON content header and body', async (method, path) => {
      const body = { requestId: 'same-request', note: 'Original content' };
      await analystWorkspaceApi.request(path, body, method);
      expect(global.fetch.mock.calls[0][1]).toMatchObject({ method,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    });
});

describe('Analyst conversation delete', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  test('the client has no archive call', () => {
    expect(Object.keys(analystApi).filter(name => /archive/i.test(name))).toEqual([]);
    expect(Object.keys(analystWorkspaceApi).filter(name => /archive/i.test(name))).toEqual([]);
  });

  test('the trash button\'s permanent delete is one bodyless DELETE of that conversation', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    await expect(analystWorkspaceApi.request('/conversations/chat%2F1', undefined, 'DELETE')).resolves.toEqual({ ok: true });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toMatch(/\/api\/analyst\/conversations\/chat%2F1$/);
    expect(options.method).toBe('DELETE');
    expect(options.cache).toBe('no-store');
    expect(options).not.toHaveProperty('body');
  });
});
