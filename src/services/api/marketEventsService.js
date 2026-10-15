import axios from 'axios';

// Relative by default so CRA can proxy in development and production remains
// same-origin. A deployed API origin can still be supplied explicitly.
const backendUrl = process.env.REACT_APP_BACKEND_URL || '';
const marketEventsClient = axios.create({
  baseURL: backendUrl,
  timeout: 15000,
  headers: { Accept: 'application/json' },
});

function unavailableError(error) {
  const payload = error?.response?.data;
  const normalized = new Error(
    payload?.reason || 'The verified selected-week calendar is unavailable.',
  );
  normalized.code = payload?.code || 'CALENDAR_API_UNAVAILABLE';
  normalized.retryAt = payload?.retryAt || null;
  normalized.liveInvalidation = true;
  normalized.cause = error;
  return normalized;
}

export async function fetchMarketEvents(options = {}) {
  try {
    const response = await marketEventsClient.get('/api/market-events', {
      signal: options.signal,
      ...(options.week === 'next' ? { params: { week: 'next' } } : {}),
    });
    return response.data;
  } catch (error) {
    if (error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError') throw error;
    throw unavailableError(error);
  }
}

export default fetchMarketEvents;
