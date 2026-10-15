const {
  getProviderStatus,
  loadOperationalCatalogByRelease,
  setProviderStatus,
} = require('../cache');
const { getCurrentCpiRelease } = require('../cpiRelease');
const { sidecarRequest, SIDECAR_BASE } = require('./ibkrHttp');

const CPI_REFRESH_TIMEOUT_MS = Number(process.env.IBKR_CPI_REFRESH_TIMEOUT_MS || 30000);
const REFRESH_TIMEOUT_MS = Number(process.env.IBKR_REFRESH_TIMEOUT_MS || 5000);
const CPI_DISCOVER_TIMEOUT_MS = Number(process.env.IBKR_CPI_DISCOVER_TIMEOUT_MS || 20000);
const DISCOVER_TIMEOUT_MS = Number(process.env.IBKR_DISCOVER_TIMEOUT_MS || 60000);
const IBKR_CATALOG_VENUES = Object.freeze(['IBKR', 'ForecastEx', 'CME']);

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
    last_success_at: lastSuccessAt || null,
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
          ...(options.forceRefresh ? { forceRefresh: true } : {}),
          ...(options.retryMissing ? { retryMissing: true } : {}),
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
    const refreshEvidence = result.refreshEvidence || provider.refreshEvidence || null;

    setIbkrFamilyStatus(
      status,
      provider.message || null,
      status === 'connected' ? (provider.last_success_at || result.fetched_at) : null,
      {
        ...(cpiDiscovery ? { cpi_discovery: cpiDiscovery } : {}),
        ...(timing ? { cpi_timing: timing } : {}),
        gateway: { ok: status === 'connected' },
        contracts_added: result.contracts_added ?? 0,
        contracts_total: result.contracts_total ?? events.length,
        portfolio_seed_count: result.portfolio_seed_count ?? 0,
        ...(refreshEvidence ? { refreshEvidence } : {}),
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
    setIbkrFamilyStatus(reason, message, null, {
      gateway: { ok: false },
      errorCode: err.sidecarCode || err.code || null,
    });
    return [];
  }
}

/**
 * Read the current, server-owned prediction-market catalog generation and ask
 * the sidecar only for quotes belonging to that exact generation. This is a
 * read path: catalog discovery and promotion remain separate operator actions.
 */
async function fetchCurrentIbkrPredictionSnapshot(options = {}) {
  const healthCheck = options.checkGatewayHealth || checkGatewayHealth;
  const releaseLoader = options.getCurrentCpiRelease || getCurrentCpiRelease;
  const catalogLoader = options.loadOperationalCatalogByRelease || loadOperationalCatalogByRelease;
  const eventsLoader = options.fetchIBKREvents || fetchIBKREvents;
  const providerStatusLoader = options.getProviderStatus || getProviderStatus;
  const health = await healthCheck();

  if (!health.ok) {
    const refreshEvidence = options.forceRefresh ? {
      mode: 'on_demand_prediction_fanout',
      requestedContractCount: 0,
      brokerSnapshotRequestedCount: 0,
      brokerSnapshotRetryCount: 0,
      verifiedContractCount: 0,
      missingContractCount: null,
      missingContractCountKnown: false,
      coverageComplete: false,
      fromCache: false,
      blockedBy: health.reason || 'IBKR_GATEWAY_UNAVAILABLE',
      completedAt: new Date().toISOString(),
    } : null;
    return {
      health,
      release: null,
      events: [],
      provider: {
        status: health.reason || 'offline',
        errorCode: health.errorCode || null,
        message: health.message || 'IB Gateway/TWS is unavailable',
        ...(refreshEvidence ? { refreshEvidence } : {}),
      },
    };
  }

  let release = null;
  try {
    release = await releaseLoader();
    const catalogContracts = await catalogLoader(release.releaseKey, {
      venues: IBKR_CATALOG_VENUES,
      requireCurrent: true,
    });
    const events = await eventsLoader({
      cpi: release.cpi,
      catalogContracts,
      ...(options.forceRefresh ? { forceRefresh: true } : {}),
      ...(options.retryMissing ? { retryMissing: true } : {}),
    });
    const provider = providerStatusLoader().ibkr || {};
    return {
      health,
      release,
      events: Array.isArray(events) ? events : [],
      provider,
    };
  } catch (err) {
    const errorCode = err.code || err.sidecarCode || 'CATALOG_UNAVAILABLE';
    const message = err.message || 'The current prediction-market catalog is unavailable.';
    const refreshEvidence = options.forceRefresh ? {
      mode: 'on_demand_prediction_fanout',
      requestedContractCount: 0,
      brokerSnapshotRequestedCount: 0,
      brokerSnapshotRetryCount: 0,
      verifiedContractCount: 0,
      missingContractCount: null,
      missingContractCountKnown: false,
      coverageComplete: false,
      fromCache: false,
      blockedBy: errorCode,
      completedAt: new Date().toISOString(),
    } : null;
    setIbkrFamilyStatus('catalog_unavailable', message, null, {
      errorCode,
      gateway: { ok: true },
      releaseKey: release?.releaseKey || null,
      ...(refreshEvidence ? { refreshEvidence } : {}),
    });
    return {
      health,
      release,
      events: [],
      provider: {
        status: 'catalog_unavailable',
        errorCode,
        message,
        releaseKey: release?.releaseKey || null,
        ...(refreshEvidence ? { refreshEvidence } : {}),
      },
    };
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
  IBKR_CATALOG_VENUES,
  fetchIBKREvents,
  fetchCurrentIbkrPredictionSnapshot,
  checkGatewayHealth,
  discoverIbkrEventContracts,
  fetchCategoryTree,
  discoverForecastExContracts,
  discoverCmeEventContracts,
};
