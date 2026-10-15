import axios from 'axios';
import {
  canonicalPredictionMonitorContext,
  predictionMonitorIdentityKey,
} from '../../utils/predictionMonitorIdentity';

const API_BASE_URL = typeof window !== 'undefined' && /^(localhost|127\.0\.0\.1):3000$/.test(window.location.host)
  ? ''
  : process.env.REACT_APP_BACKEND_URL
    || process.env.REACT_APP_API_BASE_URL
    || 'http://localhost:3001';

const BASE = `${API_BASE_URL}/api/prediction-market-test`;
const MONITOR_MARKETS = new Set(['cpi', 'gdp', 'silver', 'gold', 'wti', 'brent', 'bitcoin', 'ethereum', 'sp500', 'nasdaq100']);
const monitorEtags = new Map();
const monitorSnapshots = new Map();

const predictionMarketTestService = {
  async getMorningReport({ signal } = {}) {
    const response = await axios.get(`${BASE}/morning-report`, {
      signal,
      timeout: 20_000,
      headers: { 'Cache-Control': 'no-cache' },
      // The report's HTTP status reflects contract-catalog availability. Its
      // per-market research inputs are independently validated by the caller.
      validateStatus: (status) => status === 200 || status === 503,
    });
    return response.data;
  },

  async getMonitor(marketId, {
    signal,
    venue = 'auto',
    generationId = null,
    view = 'card',
  } = {}) {
    const normalized = String(marketId || '').trim().toLowerCase();
    if (!MONITOR_MARKETS.has(normalized)) {
      throw new TypeError(`Prediction-market monitor must be one of: ${[...MONITOR_MARKETS].join(', ')}.`);
    }
    const canonical = canonicalPredictionMonitorContext({
      marketId: normalized,
      venue,
      generationId,
    });
    const params = {
      view,
      ...(canonical.venue !== 'auto' ? { venue: canonical.venue } : {}),
      ...(canonical.generationId ? { generationId: canonical.generationId } : {}),
    };
    const requestKey = predictionMonitorIdentityKey({ ...canonical, view }, { includeView: true });
    const etag = monitorEtags.get(requestKey);
    const response = await axios.get(`${BASE}/monitor/${normalized}`, {
      signal,
      timeout: 20_000,
      headers: {
        'Cache-Control': 'no-cache',
        ...(etag ? { 'If-None-Match': etag } : {}),
      },
      ...(Object.keys(params).length ? { params } : {}),
      validateStatus: (status) => status === 200 || status === 304,
    });
    if (response.status === 304) {
      const retained = monitorSnapshots.get(requestKey);
      if (retained) return retained;
      throw new Error('Prediction monitor returned 304 without a retained card revision.');
    }
    const nextEtag = response.headers?.etag;
    if (nextEtag) monitorEtags.set(requestKey, nextEtag);
    monitorSnapshots.set(requestKey, response.data);
    return response.data;
  },

  async getSpxMonitor({ signal } = {}) {
    const response = await axios.get(`${BASE}/spx-monitor`, {
      signal,
      timeout: 20_000,
      headers: { 'Cache-Control': 'no-cache' },
    });
    return response.data;
  },

  async getSnapshot({ signal } = {}) {
    const response = await axios.get(`${BASE}/snapshot`, {
      signal,
      timeout: 15_000,
      headers: { 'Cache-Control': 'no-cache' },
    });
    return response.data;
  },

  async getHealth({ signal } = {}) {
    const response = await axios.get(`${BASE}/health`, {
      signal,
      timeout: 5_000,
      headers: { 'Cache-Control': 'no-cache' },
    });
    return response.data;
  },
};

export default predictionMarketTestService;
