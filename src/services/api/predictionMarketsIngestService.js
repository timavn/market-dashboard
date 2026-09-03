import axios from 'axios';

// Use the CRA proxy while the dashboard is running locally so the browser and
// API share one origin. This avoids localhost/127.0.0.1 transport differences
// masking an otherwise available verified-live market payload.
const API_BASE_URL = typeof window !== 'undefined' && /^(localhost|127\.0\.0\.1):3000$/.test(window.location.host)
  ? ''
  : process.env.REACT_APP_BACKEND_URL ||
    process.env.REACT_APP_API_BASE_URL ||
    'http://localhost:3001';

const BASE = `${API_BASE_URL}/api/prediction-markets`;
const IBKR_REFRESH_TIMEOUT_MS = Number(process.env.REACT_APP_IBKR_REFRESH_TIMEOUT_MS || 60000);
const IBKR_DISCOVER_TIMEOUT_MS = Number(process.env.REACT_APP_IBKR_DISCOVER_TIMEOUT_MS || 30000);

class PredictionMarketsIngestService {
  async getAggregatedEvents(params = {}) {
    const response = await axios.get(`${BASE}/aggregated-events`, {
      params,
      timeout: 60000,
    });
    return response.data;
  }

  async getWatchlist() {
    const response = await axios.get(`${BASE}/watchlist`, {
      timeout: 30000,
    });
    return response.data;
  }

  async getPredictionMarketsOverview(params = {}) {
    const response = await axios.get(`${BASE}/overview`, {
      params,
      timeout: 30000,
    });
    return response.data;
  }

  async getSpxPredictionMarketsOverview() {
    const response = await axios.get(`${BASE}/overview/spx`, {
      timeout: 30000,
    });
    return response.data;
  }

  async getWtiWorkbench(cadence = 'daily') {
    const response = await axios.get(`${BASE}/wti`, {
      params: { cadence },
      timeout: 30000,
    });
    return response.data;
  }

  async getLastSettledWtiSession(cadence = 'daily') {
    const response = await axios.get(`${BASE}/wti/last-settled`, {
      params: { cadence },
      timeout: 30000,
    });
    return response.data;
  }

  async getRecentSettledWtiSessions(cadence = 'daily', limit = 13) {
    const response = await axios.get(`${BASE}/wti/recent-settled`, {
      params: { cadence, limit },
      timeout: 30000,
    });
    return response.data;
  }

  async getSpxCloseWorkbench() {
    const response = await axios.get(`${BASE}/spx-close`, {
      timeout: 30000,
    });
    return response.data;
  }

  async getSpxCoverSnapshot() {
    const response = await axios.get(`${BASE}/spx-close/cover`, {
      timeout: 30000,
    });
    return response.data;
  }

  async getLastSettledSpxCloseSession() {
    const response = await axios.get(`${BASE}/spx-close/last-settled`, {
      timeout: 30000,
    });
    return response.data;
  }

  async getRecentSettledSpxCloseSessions(limit = 13) {
    const response = await axios.get(`${BASE}/spx-close/recent-settled`, {
      params: { limit },
      timeout: 30000,
    });
    return response.data;
  }

  async refreshIbkr(body = {}) {
    const response = await axios.post(`${BASE}/refresh/ibkr`, body, {
      timeout: body?.cpi ? IBKR_REFRESH_TIMEOUT_MS : 120000,
    });
    return response.data;
  }

  async discoverIbkr(body = {}) {
    const response = await axios.post(`${BASE}/discover/ibkr`, body, {
      timeout: body?.cpi ? IBKR_DISCOVER_TIMEOUT_MS : 120000,
    });
    return response.data;
  }

  async getProviderStatus() {
    const response = await axios.get(`${BASE}/providers/status`, { timeout: 15000 });
    return response.data;
  }

  async getCurrentCpiRelease() {
    const response = await axios.get(`${BASE}/cpi/current`, { timeout: 30000 });
    return response.data;
  }

  async getCpiOfficialFinals() {
    const response = await axios.get(`${BASE}/cpi/finals`, { timeout: 15000 });
    return response.data;
  }

  async getCpiBenchmarks(month) {
    const response = await axios.get(`${BASE}/cpi/benchmarks`, {
      params: { month },
      timeout: 30000,
    });
    return response.data;
  }
}

const predictionMarketsIngestService = new PredictionMarketsIngestService();

export default predictionMarketsIngestService;
