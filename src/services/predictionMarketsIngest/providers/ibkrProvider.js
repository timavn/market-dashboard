const {
  setProviderStatus,
  getIbkrStaleEvents,
  setIbkrStaleEvents,
} = require('../cache');
const { sidecarRequest, SIDECAR_BASE } = require('./ibkrHttp');

function ibkrEnabled() {
  return process.env.IBKR_INGEST_ENABLED !== 'false';
}

function mapSidecarStatus(status) {
  if (status === 'connected') return 'connected';
  if (status === 'tws_offline') return 'tws_offline';
  if (status === 'auth_required') return 'auth_required';
  if (status === 'sidecar_offline') return 'sidecar_offline';
  return status || 'unknown';
}

function staleWithFlag(events) {
  return (events || []).map((event) => ({
    ...event,
    data_quality_flags: [...new Set([...(event.data_quality_flags || []), 'stale_quote'])],
  }));
}

function setIbkrFamilyStatus(status, message, lastSuccessAt = null) {
  const payload = {
    status,
    message,
    ...(lastSuccessAt ? { last_success_at: lastSuccessAt } : {}),
  };
  setProviderStatus('ibkr', payload);
  setProviderStatus('forecastex', payload);
  setProviderStatus('cme', payload);
}

async function checkGatewayHealth() {
  if (!ibkrEnabled()) {
    return { ok: false, reason: 'disabled', message: 'IBKR ingest disabled' };
  }

  try {
    const status = await sidecarRequest('/status', { timeoutMs: 3000 });
    const mapped = mapSidecarStatus(status.status);
    if (mapped === 'connected') {
      setIbkrFamilyStatus('connected', null, new Date().toISOString());
      return {
        ok: true,
        authenticated: true,
        reason: 'connected',
        sidecar: SIDECAR_BASE,
        gateway: status,
      };
    }

    setIbkrFamilyStatus(mapped, status.message || 'IB Gateway/TWS is not connected');
    return {
      ok: false,
      authenticated: false,
      reason: mapped,
      message: status.message,
      sidecar: SIDECAR_BASE,
      gateway: status,
    };
  } catch (err) {
    const reason = err.reason === 'sidecar_offline' ? 'sidecar_offline' : 'error';
    const message =
      reason === 'sidecar_offline'
        ? `IBKR sidecar not reachable at ${SIDECAR_BASE}`
        : err.message;
    setIbkrFamilyStatus(reason, message);
    return { ok: false, reason, message, sidecar: SIDECAR_BASE };
  }
}

async function fetchIBKREvents() {
  if (!ibkrEnabled()) {
    setIbkrFamilyStatus('unknown', 'IBKR ingest disabled');
    return getIbkrStaleEvents();
  }

  try {
    const result = await sidecarRequest('/refresh', { method: 'POST', timeoutMs: 5000 });
    const provider = result.providers?.ibkr || {};
    const status = mapSidecarStatus(provider.status);
    const events = Array.isArray(result.events) ? result.events : [];

    setIbkrFamilyStatus(status, provider.message || null, provider.last_success_at || result.fetched_at);

    if (status !== 'connected') {
      return staleWithFlag(getIbkrStaleEvents());
    }

    setIbkrStaleEvents(events);
    return events;
  } catch (err) {
    const reason = err.reason === 'sidecar_offline' ? 'sidecar_offline' : 'error';
    const message =
      reason === 'sidecar_offline'
        ? `IBKR sidecar not reachable at ${SIDECAR_BASE}`
        : err.message;
    console.error('[IBKR] sidecar refresh error:', message);
    setIbkrFamilyStatus(reason, message);
    return staleWithFlag(getIbkrStaleEvents());
  }
}

async function fetchCategoryTree() {
  return [];
}

async function discoverForecastExContracts() {
  return [];
}

async function discoverCmeEventContracts() {
  return [];
}

module.exports = {
  fetchIBKREvents,
  checkGatewayHealth,
  fetchCategoryTree,
  discoverForecastExContracts,
  discoverCmeEventContracts,
};
