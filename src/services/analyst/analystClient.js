export const ANALYST_PDF_MAX_BYTES = 50 * 1024 * 1024;

export const resolveAnalystBackendBase = ({ configuredBase, location, production = false } = {}) => {
  const base = String(configuredBase || (location
    ? `${location.protocol}//${location.hostname}:3001` : 'http://localhost:3001')).replace(/\/$/, '');
  const localDevelopment = !production && location?.protocol === 'http:' && location.port === '3000'
    && ['localhost', '127.0.0.1'].includes(location.hostname);
  // Overview history/quote requests and its persistent streams use localhost.
  // Keep Analyst control requests in another browser HTTP connection pool,
  // reaching the same loopback listener and existing local trust boundary.
  return localDevelopment && base === 'http://localhost:3001' ? 'http://127.0.0.1:3001' : base;
};
const backendBase = () => resolveAnalystBackendBase({
  configuredBase: process.env.REACT_APP_BACKEND_URL,
  location: typeof window === 'undefined' ? undefined : window.location,
  production: process.env.NODE_ENV === 'production',
});

async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Analyst request failed (${response.status}).`);
    error.code = payload.code || `HTTP_${response.status}`;
    // Keep the server's own reason separately: only an explicit not-found or
    // deleted code verifies that saved navigation may be evicted.
    if (typeof payload.code === 'string' && payload.code) error.serverCode = payload.code;
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function timedFetch(url, options = {}, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error('The Analyst request timed out.');
      timeoutError.code = 'ANALYST_REQUEST_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export const analystApi = {
  async status() {
    return readJson(await timedFetch(`${backendBase()}/api/analyst/status`, { cache: 'no-store' }));
  },

  async catalog() {
    return readJson(await timedFetch(`${backendBase()}/api/analyst/catalog`, { cache: 'no-store' }));
  },

  async imports() {
    return readJson(await timedFetch(`${backendBase()}/api/analyst/sources`, { cache: 'no-store' }));
  },

  async startReview({ reviewKind, conversationId, sessionId, requestId }) {
    return readJson(await timedFetch(`${backendBase()}/api/analyst/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ reviewKind, conversationId, sessionId, requestId }),
    }, 8_000));
  },

  async reviewConversations({ limit = 50, cursor = '', query = '' } = {}) {
    const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    const params = new URLSearchParams({ limit: String(boundedLimit) });
    if (cursor) params.set('cursor', String(cursor));
    if (query) params.set('q', String(query));
    return readJson(await timedFetch(
      `${backendBase()}/api/analyst/review-conversations?${params.toString()}`,
      { cache: 'no-store' },
      15_000,
    ));
  },

  async createReviewConversation(reviewKind, { requestId } = {}) {
    return readJson(await timedFetch(
      `${backendBase()}/api/analyst/review-conversations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ reviewKind, requestId }),
      },
      8_000,
    ));
  },

  async reviewConversation(conversationId) {
    return readJson(await timedFetch(
      `${backendBase()}/api/analyst/review-conversations/${encodeURIComponent(String(conversationId || ''))}`,
      { cache: 'no-store' },
      8_000,
    ));
  },

  async review(runId) {
    return readJson(await timedFetch(
      `${backendBase()}/api/analyst/reviews/${encodeURIComponent(String(runId || ''))}`,
      { cache: 'no-store' },
    ));
  },

  async reviewStatus(runId) {
    return readJson(await timedFetch(
      `${backendBase()}/api/analyst/reviews/${encodeURIComponent(String(runId || ''))}/status`,
      { cache: 'no-store' },
    ));
  },

  async reviews({ conversationId, sessionId, limit = 100 } = {}) {
    const query = conversationId
      ? `conversationId=${encodeURIComponent(String(conversationId))}`
      : sessionId
        ? `sessionId=${encodeURIComponent(String(sessionId))}`
      : `limit=${Math.max(1, Math.min(500, Number(limit) || 100))}`;
    return readJson(await timedFetch(`${backendBase()}/api/analyst/reviews?${query}`, { cache: 'no-store' }));
  },

  async retryReview(runId, { requestId } = {}) {
    return readJson(await timedFetch(
      `${backendBase()}/api/analyst/reviews/${encodeURIComponent(String(runId || ''))}/retry`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ requestId }),
      },
      8_000,
    ));
  },

  async retryReviewConversation(conversationId, { requestId, previousRunId } = {}) {
    return readJson(await timedFetch(
      `${backendBase()}/api/analyst/review-conversations/${encodeURIComponent(String(conversationId || ''))}/retries`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ requestId, previousRunId }),
      },
      8_000,
    ));
  },

  async post(path, body) {
    return readJson(await fetch(`${backendBase()}/api/analyst${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
  },
};

export function analystWebSocketUrl() {
  const url = new URL('/ws/analyst', backendBase());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export async function validateAnalystPdf(file) {
  if (!file) throw new Error('Choose a PDF first.');
  if (!String(file.name || '').toLowerCase().endsWith('.pdf')) {
    throw new Error('Only PDF files are accepted.');
  }
  if (String(file.type || '').toLowerCase() !== 'application/pdf') {
    throw new Error('The file must use the application/pdf MIME type.');
  }
  if (!Number.isFinite(file.size) || file.size <= 0) throw new Error('The PDF is empty.');
  if (file.size > ANALYST_PDF_MAX_BYTES) throw new Error('The PDF exceeds the 50 MB maximum.');
  const signatureBytes = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  const signature = String.fromCharCode(...signatureBytes);
  if (signature !== '%PDF-') throw new Error('The file signature is not a PDF.');
  return true;
}

export async function stageAnalystPdf(file, onProgress) {
  await validateAnalystPdf(file);
  const authorization = await analystApi.post('/sources/presign', {
    filename: file.name,
    contentType: 'application/pdf',
    sizeBytes: file.size,
  });
  const form = new FormData();
  Object.entries(authorization.fields || {}).forEach(([key, value]) => form.append(key, String(value)));
  form.append('file', file, file.name);
  onProgress?.('uploading');
  const uploaded = await fetch(authorization.url, { method: 'POST', body: form });
  if (!uploaded.ok) throw new Error(`Staging upload failed (${uploaded.status}).`);
  onProgress?.('indexing');
  return analystApi.post('/sources/analyze', { key: authorization.key });
}

export const analystWorkspaceApi = {
  async request(path, body, method = body === undefined ? 'GET' : 'POST') {
    // Saved-review lookup and durable acceptance can queue behind research
    // indexing. Give starts their own budget; never resend a timed-out POST.
    const timeoutMs = method === 'POST' && path.startsWith('/daily/') ? 45_000
      : method === 'GET' && (/^\/conversations\/[^/]+\/sources$/.test(path) || path.startsWith('/requests/')) ? 3_000 : 15_000;
    return readJson(await timedFetch(`${backendBase()}/api/analyst${path}`, {
      method, cache: 'no-store',
      ...(method !== 'GET' || body !== undefined ? { headers: { 'Content-Type': 'application/json' } } : {}),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }, timeoutMs));
  },
  events(after = 0) { return new EventSource(`${backendBase()}/api/analyst/events?after=${after}`); },
};
