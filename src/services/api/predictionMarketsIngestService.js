import axios from 'axios';

const API_BASE_URL =
  process.env.REACT_APP_BACKEND_URL ||
  process.env.REACT_APP_API_BASE_URL ||
  'http://localhost:3001';

const BASE = `${API_BASE_URL}/api/prediction-markets`;

class PredictionMarketsIngestService {
  async getAggregatedEvents(params = {}) {
    const response = await axios.get(`${BASE}/aggregated-events`, {
      params,
      timeout: 60000,
    });
    return response.data;
  }

  async refreshIbkr(body = {}) {
    const response = await axios.post(`${BASE}/refresh/ibkr`, body, {
      timeout: 120000,
    });
    return response.data;
  }

  async getProviderStatus() {
    const response = await axios.get(`${BASE}/providers/status`, { timeout: 15000 });
    return response.data;
  }
}

export default new PredictionMarketsIngestService();
