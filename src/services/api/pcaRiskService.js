import axios from 'axios';

const client = axios.create({
  baseURL: process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001',
  timeout: 120000,
  headers: { 'Content-Type': 'application/json' },
});
const root = '/api/risk/pca';

export const pcaRiskService = {
  async getSnapshot({ account, window, id, signal }) {
    return (await client.get(`${root}/snapshot`, { params: { account, window, ...(id ? { id } : {}) }, signal })).data;
  },
  async getHistory({ account, window, signal }) {
    return (await client.get(`${root}/history`, { params: { account, window }, signal })).data;
  },
  async getConfig({ account, signal }) {
    return (await client.get(`${root}/config`, { params: { account }, signal })).data;
  },
  async saveConfig(config) {
    return (await client.put(`${root}/config`, config)).data;
  },
  async refresh({ account, window }) {
    return (await client.post(`${root}/refresh`, { account, window })).data;
  },
  async compare(request) {
    return (await client.post(`${root}/compare`, request)).data;
  },
};

export default pcaRiskService;
