import { useDashboardResource } from './useDashboardResource';

const load = async () => {
  const response = await fetch(`${process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001'}/api/hedgeye/snapshot/global-quads`);
  if (!response.ok) throw new Error('Global Quads update unavailable');
  return response.json();
};
const validate = (payload) => {
  if (payload?.schemaVersion !== 1 || payload?.source !== 'hedgeye-published-global-quads'
    || !payload.data?.groups || !payload.data?.sources) throw new Error('Global Quads source unavailable');
  return payload;
};
const observedAt = payload => payload.date || payload.ingestion?.lastCheckedAt || null;
const options = { fetcher: load, validate, getObservedAt: observedAt, pollIntervalMs: 15 * 60 * 1000, active: true };
export function useGlobalQuads() {
  return useDashboardResource('global-quads', {}, options);
}
