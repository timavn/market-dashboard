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
const lastValidPnlByAccount = new Map();
const lastForcedSyncByAccount = new Map();
const FORCE_SYNC_COOLDOWN_MS = Number(process.env.IBKR_FORCE_SYNC_COOLDOWN_MS || 30_000);

function isOpenPosition(row) {
  return Number(row?.position || 0) !== 0 || Number(row?.marketValue || 0) !== 0;
}

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
  const candidates = [];
  for (const acct of accounts) {
    try {
      const res = await sidecarRequest(`/cache/portfolio?account=${encodeURIComponent(acct)}`, {
        timeoutMs: 1000,
      });
      const positions = Array.isArray(res.positions) ? res.positions.filter(isOpenPosition) : [];
      candidates.push({ accountId: acct, positionCount: positions.length });
    } catch {
      candidates.push({ accountId: acct, positionCount: 0 });
    }
  }

  const bestByPositions = candidates
    .filter((candidate) => candidate.positionCount > 0)
    .sort((a, b) => b.positionCount - a.positionCount)[0];
  if (bestByPositions) {
    return bestByPositions.accountId;
  }

  try {
    const status = await sidecarRequest('/status', { timeoutMs: 1500 });
    const streamedAccount = status?.stream?.portfolio_account;
    if (streamedAccount && accounts.includes(streamedAccount)) {
      return streamedAccount;
    }
  } catch {
    // Fall back to cache probing below.
  }
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
  const positions = res.positions.filter(isOpenPosition);
  if (positions.length === 0) {
    return null;
  }

  const missingMarketValues = positions.some(
    (p) => Number(p.position || 0) !== 0 && (p.marketValue == null || Number.isNaN(Number(p.marketValue))),
  );
  const lastForced = lastForcedSyncByAccount.get(acct) || 0;
  if (missingMarketValues && Date.now() - lastForced > FORCE_SYNC_COOLDOWN_MS) {
    lastForcedSyncByAccount.set(acct, Date.now());
    try {
      const synced = await sidecarRequest(`/portfolio/positions?account=${encodeURIComponent(acct)}`, {
        timeoutMs: 12000,
      });
      const syncedPositions = Array.isArray(synced.positions)
        ? synced.positions.filter(isOpenPosition)
        : [];
      if (synced.ok && syncedPositions.length > 0) {
        setIbkrLastPortfolioAt(synced.fetched_at || new Date().toISOString());
        return {
          positions: syncedPositions,
          accountId: acct,
          fetchedAt: synced.fetched_at,
          fromCache: false,
          forcedSync: true,
        };
      }
    } catch (err) {
      console.warn('[Portfolio] IBKR forced portfolio sync failed:', err.message);
    }
  }

  setIbkrLastPortfolioAt(res.fetched_at || new Date().toISOString());
  return { positions, accountId: acct, fetchedAt: res.fetched_at, fromCache: true };
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
  let res;
  try {
    res = await sidecarRequest(`/portfolio/positions?account=${encodeURIComponent(acct)}`);
  } catch (err) {
    setIbkrConnected(false, err.message);
    return {
      positions: [],
      accountId: acct,
      error: err.message,
      fetchedAt: new Date().toISOString(),
    };
  }
  if (!res.ok) {
    setIbkrConnected(false, res.message);
    return { positions: [], accountId: acct, error: res.message };
  }
  setIbkrLastPortfolioAt(res.fetched_at || new Date().toISOString());
  return {
    positions: (res.positions || []).filter(isOpenPosition),
    accountId: acct,
    fetchedAt: res.fetched_at,
  };
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
  const pnl = res.pnl || null;
  const hasValidPnl =
    pnl &&
    ['dailyPnL', 'unrealizedPnL', 'realizedPnL'].some((key) => Number.isFinite(Number(pnl[key])));

  if (hasValidPnl) {
    const cached = {
      ...pnl,
      fetchedAt: res.fetched_at || new Date().toISOString(),
    };
    lastValidPnlByAccount.set(acct, cached);
    return cached;
  }

  return lastValidPnlByAccount.get(acct) || null;
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

async function getPortfolioSnapshot(accountId, quoteFn) {
  const { positions: raw, accountId: acct, error, fetchedAt } = await getPositions(accountId);

  if (error) {
    const [accountSummary, pnl] = await Promise.all([
      acct ? getAccountSummaryBestEffort(acct) : null,
      acct ? getPnLBestEffort(acct) : null,
    ]);
    return {
      holdings: [],
      accountSummary,
      pnl,
      accountId: acct,
      error,
      summary: buildSnapshotSummary([], accountSummary),
      fetchedAt,
      dataSource: accountSummary ? 'ibkr_api' : undefined,
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
    };
  }

  const needsQuotes = raw.some((p) => p.marketValue == null || Number.isNaN(Number(p.marketValue)));
  const symbols = needsQuotes
    ? [
        ...new Set(
          raw
            .filter((p) => p.marketValue == null || Number.isNaN(Number(p.marketValue)))
            .map((p) => p.symbol)
            .filter(Boolean),
        ),
      ]
    : [];
  const quotesBySymbol = quoteFn && symbols.length > 0 ? await quoteFn(symbols) : {};

  const holdings = raw
    .map((p) => {
      const q = quotesBySymbol[(p.symbol || '').toUpperCase()];
      return normalizeIbkrPosition(p, q);
    })
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
