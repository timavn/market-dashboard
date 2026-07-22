import axios from 'axios';

const API_BASE_URL =
  process.env.REACT_APP_BACKEND_URL ||
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

  async getPredictionMarketsOverview() {
    const response = await axios.get(`${BASE}/overview`, {
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
}

export default new PredictionMarketsIngestService();
