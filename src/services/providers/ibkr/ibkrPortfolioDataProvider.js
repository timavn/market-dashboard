const { sidecarRequest } = require('../ibkrSidecarClient');
const { normalizeIbkrPosition } = require('../normalize/normalizePosition');
const { normalizeAccountSummary } = require('../normalize/normalizeAccountSummary');
const {
  setIbkrConnected,
  setIbkrLastPortfolioAt,
} = require('../providerStatus');

const ENABLED = process.env.IBKR_PORTFOLIO_ENABLED !== 'false';
const ACCOUNT_ID = process.env.IBKR_ACCOUNT_ID || '';

async function getAccounts() {
  const res = await sidecarRequest('/accounts');
  if (!res.ok) return [];
  setIbkrConnected(true);
  return res.accounts || [];
}

async function resolveAccountId(accountId) {
  if (accountId) return accountId;
  if (ACCOUNT_ID) return ACCOUNT_ID;
  const accounts = await getAccounts();
  return accounts[0] || null;
}

async function getCachedPositions(accountId) {
  const acct = await resolveAccountId(accountId);
  if (!acct) return null;
  const res = await sidecarRequest(`/cache/portfolio?account=${encodeURIComponent(acct)}`, {
    timeoutMs: 2000,
  });
  if (!res.ok || !Array.isArray(res.positions) || res.positions.length === 0) {
    return null;
  }
  setIbkrLastPortfolioAt(res.fetched_at || new Date().toISOString());
  return { positions: res.positions, accountId: acct, fetchedAt: res.fetched_at, fromCache: true };
}

async function getPositions(accountId) {
  try {
    const cached = await getCachedPositions(accountId);
    if (cached) return cached;
  } catch {
    // fall through to REST snapshot
  }

  const acct = await resolveAccountId(accountId);
  if (!acct) return { positions: [], accountId: null };
  const res = await sidecarRequest(`/portfolio/positions?account=${encodeURIComponent(acct)}`);
  if (!res.ok) {
    setIbkrConnected(false, res.message);
    return { positions: [], accountId: acct, error: res.message };
  }
  setIbkrLastPortfolioAt(res.fetched_at || new Date().toISOString());
  return { positions: res.positions || [], accountId: acct, fetchedAt: res.fetched_at };
}

async function getCachedAccountSummary(accountId) {
  const acct = await resolveAccountId(accountId);
  if (!acct) return null;
  const res = await sidecarRequest(
    `/cache/account-summary?account=${encodeURIComponent(acct)}`,
    { timeoutMs: 2000 },
  );
  if (!res.ok || !res.summary || Object.keys(res.summary).length === 0) {
    return null;
  }
  return normalizeAccountSummary({ ...res.summary, fetched_at: res.fetched_at });
}

async function getAccountSummary(accountId) {
  try {
    const cached = await getCachedAccountSummary(accountId);
    if (cached) return cached;
  } catch {
    // fall through to REST snapshot
  }

  const acct = await resolveAccountId(accountId);
  if (!acct) return null;
  const res = await sidecarRequest(
    `/portfolio/account-summary?account=${encodeURIComponent(acct)}`,
  );
  if (!res.ok || !res.summary) return null;
  return normalizeAccountSummary({ ...res.summary, fetched_at: res.fetched_at });
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
  return res.pnl || null;
}

/**
 * @param {string} [accountId]
 * @param {(symbols: string[]) => Promise<Record<string, object>>} quoteFn
 */
function buildSnapshotSummary(holdings, accountSummary) {
  const totalValue =
    accountSummary?.netLiquidation ??
    holdings.reduce((sum, h) => sum + (h.marketValue || 0), 0);

  return {
    totalValue,
    totalGainLoss: holdings.reduce((s, h) => s + (h.gainLoss || 0), 0),
    positionCount: holdings.length,
    longCount: holdings.filter((h) => h.quantity > 0).length,
    shortCount: holdings.filter((h) => h.quantity < 0).length,
  };
}

async function getPortfolioSnapshot(accountId, quoteFn) {
  const { positions: raw, accountId: acct, error, fetchedAt } = await getPositions(accountId);

  if (error) {
    return { holdings: [], accountSummary: null, accountId: acct, error, fetchedAt };
  }

  const accountSummary = acct ? await getAccountSummary(acct) : null;

  if (!raw.length) {
    return {
      holdings: [],
      accountSummary,
      accountId: acct,
      summary: buildSnapshotSummary([], accountSummary),
      fetchedAt,
      dataSource: 'ibkr_api',
    };
  }

  const needsQuotes = raw.some((p) => p.marketValue == null || Number.isNaN(Number(p.marketValue)));
  const symbols = needsQuotes
    ? [...new Set(raw.map((p) => p.symbol).filter(Boolean))]
    : [];
  const quotesBySymbol = quoteFn && symbols.length > 0 ? await quoteFn(symbols) : {};

  const holdings = raw.map((p) => {
    const q = quotesBySymbol[(p.symbol || '').toUpperCase()];
    return normalizeIbkrPosition(p, q);
  });

  return {
    holdings,
    accountSummary,
    accountId: acct,
    summary: buildSnapshotSummary(holdings, accountSummary),
    fetchedAt,
    dataSource: 'ibkr_api',
  };
}

async function getProviderStatus() {
  try {
    const status = await sidecarRequest('/status', { timeoutMs: 3000 });
    setIbkrConnected(Boolean(status.connected), status.message);
    return {
      name: 'ibkr_portfolio',
      connected: Boolean(status.connected),
      status: status.status,
      accounts: status.accounts || [],
    };
  } catch (err) {
    return { name: 'ibkr_portfolio', connected: false, status: 'sidecar_offline', message: err.message };
  }
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
