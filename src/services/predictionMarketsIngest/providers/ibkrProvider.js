const { setProviderStatus } = require('../cache');
const { sidecarRequest, SIDECAR_BASE } = require('./ibkrHttp');

const CPI_REFRESH_TIMEOUT_MS = Number(process.env.IBKR_CPI_REFRESH_TIMEOUT_MS || 30000);
const REFRESH_TIMEOUT_MS = Number(process.env.IBKR_REFRESH_TIMEOUT_MS || 5000);
const CPI_DISCOVER_TIMEOUT_MS = Number(process.env.IBKR_CPI_DISCOVER_TIMEOUT_MS || 20000);
const DISCOVER_TIMEOUT_MS = Number(process.env.IBKR_DISCOVER_TIMEOUT_MS || 60000);

function ibkrEnabled() {
  return process.env.IBKR_INGEST_ENABLED !== 'false';
}

function mapSidecarStatus(status) {
  if (status === 'connected') return 'connected';
  if (status === 'tws_offline' || status === 'gateway_offline') return 'tws_offline';
  if (status === 'auth_required') return 'auth_required';
  if (status === 'sidecar_offline') return 'sidecar_offline';
  return status || 'unknown';
}

function setIbkrFamilyStatus(status, message, lastSuccessAt = null, extra = {}) {
  const payload = {
    status,
    message,
    errorCode: extra?.errorCode || null,
    ...(lastSuccessAt ? { last_success_at: lastSuccessAt } : {}),
    ...(extra || {}),
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

async function fetchIBKREvents(options = {}) {
  if (!ibkrEnabled()) {
    setIbkrFamilyStatus('unknown', 'IBKR ingest disabled');
    return [];
  }

  try {
    const body = options?.cpi
      ? {
          cpi: options.cpi,
          catalogContracts: Array.isArray(options.catalogContracts)
            ? options.catalogContracts
            : [],
        }
      : undefined;
    const result = await sidecarRequest('/refresh', {
      method: 'POST',
      body,
      timeoutMs: body?.cpi ? CPI_REFRESH_TIMEOUT_MS : REFRESH_TIMEOUT_MS,
    });
    const provider = result.providers?.ibkr || {};
    const status = mapSidecarStatus(provider.status);
    const events = Array.isArray(result.events) ? result.events : [];
    const cpiDiscovery = result.cpi_discovery || null;
    const timing = result.timing || null;

    setIbkrFamilyStatus(
      status,
      provider.message || null,
      provider.last_success_at || result.fetched_at,
      {
        ...(cpiDiscovery ? { cpi_discovery: cpiDiscovery } : {}),
        ...(timing ? { cpi_timing: timing } : {}),
        gateway: { ok: status === 'connected' },
        contracts_added: result.contracts_added ?? 0,
        contracts_total: result.contracts_total ?? events.length,
        portfolio_seed_count: result.portfolio_seed_count ?? 0,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      },
    );

    if (status !== 'connected') {
      return [];
    }

    return events;
  } catch (err) {
    const reason = err.reason === 'sidecar_offline' ? 'sidecar_offline' : 'error';
    const message =
      reason === 'sidecar_offline'
        ? `IBKR sidecar not reachable at ${SIDECAR_BASE}`
        : err.message;
    console.error('[IBKR] sidecar refresh error:', message);
    setIbkrFamilyStatus(reason, message, null, { gateway: { ok: false } });
    return [];
  }
}

async function discoverIbkrEventContracts(body = {}) {
  if (!ibkrEnabled()) {
    return { ok: false, contracts_added: 0, contracts_total: 0, message: 'IBKR ingest disabled' };
  }

  try {
    const result = await sidecarRequest('/discover', {
      method: 'POST',
      body,
      timeoutMs: body?.cpi ? CPI_DISCOVER_TIMEOUT_MS : DISCOVER_TIMEOUT_MS,
    });
    const status = mapSidecarStatus(result.status);
    setIbkrFamilyStatus(
      status,
      result.message || null,
      status === 'connected' ? new Date().toISOString() : null,
      {
        ...(result.cpi_discovery ? { cpi_discovery: result.cpi_discovery } : {}),
        ...(result.timing ? { cpi_timing: result.timing } : {}),
        gateway: { ok: status === 'connected' },
        contracts_added: result.contracts_added ?? 0,
        contracts_total: result.contracts_total ?? 0,
        portfolio_seed_count: result.portfolio_seed_count ?? 0,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      },
    );
    return result;
  } catch (err) {
    const reason = err.reason === 'sidecar_offline' ? 'sidecar_offline' : 'error';
    const message =
      reason === 'sidecar_offline'
        ? `IBKR sidecar not reachable at ${SIDECAR_BASE}`
        : err.message;
    console.error('[IBKR] discover error:', message);
    return { ok: false, contracts_added: 0, contracts_total: 0, message };
  }
}

async function fetchCategoryTree() {
  return [];
}

async function discoverForecastExContracts() {
  const result = await discoverIbkrEventContracts();
  return result.contracts_total ? [] : [];
}

async function discoverCmeEventContracts() {
  const result = await discoverIbkrEventContracts();
  return result.contracts_total ? [] : [];
}

module.exports = {
  fetchIBKREvents,
  checkGatewayHealth,
  discoverIbkrEventContracts,
  fetchCategoryTree,
  discoverForecastExContracts,
  discoverCmeEventContracts,
};
