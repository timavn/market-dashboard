const { sidecarRequest, getSidecarProviderStatus } = require('../ibkrSidecarClient');
const { normalizeIbkrPosition } = require('../normalize/normalizePosition');
const { normalizeAccountSummary } = require('../normalize/normalizeAccountSummary');
const { getLongShortPositionSnapshot } = require('../../../utils/portfolioPositionSides.cjs');
const {
  setIbkrConnected,
  setIbkrLastPortfolioAt,
} = require('../providerStatus');

const ENABLED = process.env.IBKR_PORTFOLIO_ENABLED !== 'false';
const ACCOUNT_ID = process.env.IBKR_ACCOUNT_ID || '';
const LIVE_EVIDENCE_MAX_AGE_MS = Number(process.env.IBKR_LIVE_EVIDENCE_MAX_AGE_MS || 5 * 60_000);

function isOpenPosition(row) {
  return Number(row?.position || 0) !== 0 || Number(row?.marketValue || 0) !== 0;
}

async function getAccounts() {
  const res = await sidecarRequest('/accounts');
  if (!res.ok) return [];
  setIbkrConnected(true);
  return res.accounts || [];
}

function isFreshEvidence(value) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) return false;
  const age = Date.now() - timestamp;
  return age >= -5_000 && age <= LIVE_EVIDENCE_MAX_AGE_MS;
}

function verifiedLiveResponse(response) {
  return Boolean(
    response?.ok === true
    && response?.connected === true
    && response?.status === 'live'
    && response?.source === 'ibkr_live_session'
    && isFreshEvidence(response?.observed_at)
    && isFreshEvidence(response?.socket_verified_at)
  );
}

async function getPositions(accountId) {
  let res;
  try {
    res = await sidecarRequest('/portfolio/live-positions', { timeoutMs: 5000 });
  } catch (err) {
    setIbkrConnected(false, err.message);
    return {
      positions: [],
      accountId: accountId || ACCOUNT_ID || null,
      error: err.message,
      fetchedAt: new Date().toISOString(),
      liveSessionVerified: false,
    };
  }
  if (!verifiedLiveResponse(res) || !Array.isArray(res.accounts) || !Array.isArray(res.positions)) {
    const error = res?.message || 'The sidecar did not return a fresh socket-verified live position snapshot.';
    setIbkrConnected(false, error);
    return {
      positions: [],
      accountId: accountId || ACCOUNT_ID || null,
      error,
      fetchedAt: res?.observed_at || new Date().toISOString(),
      liveSessionVerified: false,
    };
  }

  const requested = accountId || ACCOUNT_ID || null;
  const counts = new Map(res.accounts.map((account) => [account, 0]));
  for (const position of res.positions) {
    if (counts.has(position.account) && isOpenPosition(position)) {
      counts.set(position.account, counts.get(position.account) + 1);
    }
  }
  const acct = requested || [...counts.entries()]
    .sort((left, right) => right[1] - left[1])[0]?.[0] || null;
  if (!acct || !res.accounts.includes(acct)) {
    const error = acct
      ? `Account ${acct} is not managed by the verified live IB session.`
      : 'The verified live IB session returned no managed account.';
    return {
      positions: [],
      accountId: acct,
      error,
      fetchedAt: res.observed_at,
      liveSessionVerified: false,
    };
  }

  const fetchedAt = res.observed_at;
  setIbkrConnected(true);
  setIbkrLastPortfolioAt(fetchedAt);
  return {
    positions: res.positions
      .filter((position) => position.account === acct)
      .filter(isOpenPosition)
      .map((position) => ({ ...position, fetched_at: fetchedAt })),
    accountId: acct,
    fetchedAt,
    socketVerifiedAt: res.socket_verified_at,
    liveSessionVerified: true,
    fromCache: false,
  };
}

async function resolveAccountId(accountId) {
  const requested = accountId || ACCOUNT_ID || null;
  const accounts = await getAccounts();
  if (requested) return accounts.includes(requested) ? requested : null;
  return accounts[0] || null;
}

async function getAccountSummary(accountId) {
  const acct = await resolveAccountId(accountId);
  if (!acct) return null;
  const res = await sidecarRequest(
    `/portfolio/live-account-summary?account=${encodeURIComponent(acct)}`,
  );
  if (!verifiedLiveResponse(res) || !res.summary || res.account !== acct) return null;
  return normalizeAccountSummary({
    ...res.summary,
    fetched_at: res.observed_at || res.fetched_at,
    source: res.source,
    socket_verified_at: res.socket_verified_at,
  });
}

async function getBalances(accountId) {
  const summary = await getAccountSummary(accountId);
  if (!summary) return null;
  return {
    totalCashValue: summary.totalCashValue,
    settledCash: summary.settledCash,
    netLiquidation: summary.netLiquidation,
    currency: summary.currency,
  };
}

async function getOpenOrders(accountId) {
  const acct = await resolveAccountId(accountId);
  if (!acct) return [];
  const res = await sidecarRequest(`/portfolio/open-orders?account=${encodeURIComponent(acct)}`);
  return res.orders || [];
}

async function getPnL(accountId) {
  const acct = await resolveAccountId(accountId);
  if (!acct) return null;
  const res = await sidecarRequest(`/portfolio/pnl?account=${encodeURIComponent(acct)}`);
  const pnl = res.pnl || null;
  const hasValidPnl =
    pnl &&
    ['dailyPnL', 'unrealizedPnL', 'realizedPnL'].some((key) => Number.isFinite(Number(pnl[key])));

  if (verifiedLiveResponse(res) && res.account === acct && hasValidPnl) {
    const dailyPnLPercent = pnl.dailyPnLPercentSource === 'ibkr_live_account_summary'
      && Number.isFinite(Number(pnl.dailyPnLPercent))
      ? Number(pnl.dailyPnLPercent)
      : null;
    return {
      ...pnl,
      dailyPnLPercent,
      dailyPnLPercentSource: dailyPnLPercent == null ? null : pnl.dailyPnLPercentSource,
      fetchedAt: res.observed_at,
      socketVerifiedAt: res.socket_verified_at,
      source: res.source,
      fromCache: false,
    };
  }
  return null;
}

async function getAccountSummaryBestEffort(accountId) {
  try {
    return await getAccountSummary(accountId);
  } catch (err) {
    console.warn('[Portfolio] IBKR account summary failed:', err.message);
    return null;
  }
}

async function getPnLBestEffort(accountId) {
  try {
    return await getPnL(accountId);
  } catch (err) {
    console.warn('[Portfolio] IBKR PnL failed:', err.message);
    return null;
  }
}

/**
 * @param {string} [accountId]
 * @param {(symbols: string[]) => Promise<Record<string, object>>} quoteFn
 */
function buildSnapshotSummary(holdings, accountSummary) {
  const totalValue =
    accountSummary?.netLiquidation ??
    holdings.reduce((sum, h) => sum + (h.marketValue || 0), 0);
  const { longCount, shortCount } = getLongShortPositionSnapshot(holdings);

  return {
    totalValue,
    totalGainLoss: holdings.reduce((s, h) => s + (h.gainLoss || 0), 0),
    positionCount: holdings.length,
    longCount,
    shortCount,
  };
}

function buildDataQuality(raw, holdings, fetchedAt) {
  const missingMarketValue = holdings
    .filter((h) => Number(h.quantity || 0) !== 0 && h.marketValue == null && !h.isPredictionMarket)
    .map((h) => h.symbol)
    .filter(Boolean);
  const predictionMarketContracts = holdings
    .filter((h) => Number(h.quantity || 0) !== 0 && h.isPredictionMarket)
    .map((h) => h.symbol || h.description)
    .filter(Boolean);
  const zeroQuantityFiltered = Math.max(0, raw.length - holdings.length);
  const warnings = [];
  if (missingMarketValue.length > 0) {
    warnings.push(
      `IBKR missing market values for ${missingMarketValue.slice(0, 8).join(', ')}${missingMarketValue.length > 8 ? ` +${missingMarketValue.length - 8} more` : ''}`,
    );
  }
  if (zeroQuantityFiltered > 0) {
    warnings.push(`Filtered ${zeroQuantityFiltered} closed/zero-quantity IBKR rows`);
  }

  return {
    fetchedAt,
    missingMarketValueCount: missingMarketValue.length,
    missingMarketValueSymbols: missingMarketValue,
    predictionMarketContractCount: predictionMarketContracts.length,
    predictionMarketContractSymbols: predictionMarketContracts,
    zeroQuantityFiltered,
    warningCount: warnings.length,
    warnings,
    status: missingMarketValue.length > 0 ? 'partial' : 'ok',
  };
}

async function getPortfolioSnapshot(accountId) {
  const {
    positions: raw,
    accountId: acct,
    error,
    fetchedAt,
    socketVerifiedAt,
    liveSessionVerified,
  } = await getPositions(accountId);

  if (error) {
    return {
      holdings: [],
      accountSummary: null,
      pnl: null,
      accountId: acct,
      error,
      summary: buildSnapshotSummary([], null),
      fetchedAt,
      liveSessionVerified: false,
    };
  }

  const [accountSummary, pnl] = await Promise.all([
    acct ? getAccountSummaryBestEffort(acct) : null,
    acct ? getPnLBestEffort(acct) : null,
  ]);

  if (!raw.length) {
    return {
      holdings: [],
      accountSummary,
      pnl,
      accountId: acct,
      summary: buildSnapshotSummary([], accountSummary),
      fetchedAt,
      dataSource: 'ibkr_api',
      liveSessionVerified,
      socketVerifiedAt,
      fromCache: false,
    };
  }

  const holdings = raw
    .map((p) => ({
      ...normalizeIbkrPosition(p),
      positionSource: 'ibkr_live_session',
    }))
    .filter((h) => Number(h.quantity || 0) !== 0 || Number(h.marketValue || 0) !== 0);

  return {
    holdings,
    accountSummary,
    pnl,
    accountId: acct,
    summary: buildSnapshotSummary(holdings, accountSummary),
    fetchedAt,
    dataQuality: buildDataQuality(raw, holdings, fetchedAt),
    dataSource: 'ibkr_api',
    liveSessionVerified,
    socketVerifiedAt,
    fromCache: false,
  };
}

async function getProviderStatus() {
  const status = await getSidecarProviderStatus('ibkr_portfolio');
  setIbkrConnected(Boolean(status.connected), status.message);
  return status;
}

module.exports = {
  getAccounts,
  getPositions,
  getBalances,
  getAccountSummary,
  getPortfolioSnapshot,
  getOpenOrders,
  getPnL,
  getProviderStatus,
  ENABLED,
};
