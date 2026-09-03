export const ANALYST_PDF_MAX_BYTES = 50 * 1024 * 1024;

const backendBase = () => {
  if (process.env.REACT_APP_BACKEND_URL) {
    return String(process.env.REACT_APP_BACKEND_URL).replace(/\/$/, '');
  }
  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:3001`;
  }
  return 'http://localhost:3001';
};

async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Analyst request failed (${response.status}).`);
    error.code = payload.code || `HTTP_${response.status}`;
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

  async archiveReviewConversation(conversationId) {
    return readJson(await timedFetch(
      `${backendBase()}/api/analyst/review-conversations/${encodeURIComponent(String(conversationId || ''))}`,
      { method: 'DELETE', cache: 'no-store' },
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
