const FORBIDDEN_LIVE_PROVENANCE = /delayed|frozen|stale|cache(?:d|_only|-only)?|mock|seed|fallback|offline|disconnected|historical|synthetic|inferred|derived/i;

export const SPX_STRATEGY_MAX_LEGS = 3;
export const SPX_PORTFOLIO_EVIDENCE_MAX_AGE_MS = 90_000;

const finiteNumber = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const freshTimestamp = (value, nowMs, maxAgeMs) => {
  const timestamp = Date.parse(String(value || ''));
  const ageMs = nowMs - timestamp;
  return Number.isFinite(timestamp) && ageMs >= -5_000 && ageMs <= maxAgeMs;
};

const unavailablePortfolio = (reason) => ({
  available: false,
  accountId: null,
  currency: null,
  netLiquidation: null,
  asOf: null,
  reason,
});

/**
 * The strategy sheet may only size from the direct, current IBKR account
 * summary already validated by PortfolioDashboard. Re-checking it here keeps
 * a retained parent snapshot from silently powering new quantities.
 */
export function resolveVerifiedPortfolioSizingBase(
  portfolioData,
  selectedAccount,
  nowMs = Date.now(),
  maxAgeMs = SPX_PORTFOLIO_EVIDENCE_MAX_AGE_MS,
) {
  const expectedAccount = String(selectedAccount || '').trim();
  const accountSummary = portfolioData?.accountSummary || null;
  const reportedAccount = String(portfolioData?.accountId || accountSummary?.accountId || '').trim();
  const netLiquidation = finiteNumber(accountSummary?.netLiquidation);
  const displayedTotal = finiteNumber(portfolioData?.summary?.totalValue);
  const currency = String(accountSummary?.currency || '').trim().toUpperCase();
  const source = String(accountSummary?.source || '').trim().toLowerCase();
  const observedAt = accountSummary?.lastUpdated || portfolioData?.fetchedAt || null;
  const socketVerifiedAt = accountSummary?.socketVerifiedAt || portfolioData?.socketVerifiedAt || null;
  const provenance = [
    source,
    portfolioData?.dataSource,
    portfolioData?.error,
  ].filter(Boolean).join(' ');

  if (!expectedAccount) return unavailablePortfolio('SELECT ACCOUNT');
  if (!portfolioData || !accountSummary) return unavailablePortfolio('IBKR PORTFOLIO UNAVAILABLE');
  if (reportedAccount !== expectedAccount) return unavailablePortfolio('ACCOUNT MISMATCH');
  if (
    portfolioData.dataSource !== 'ibkr_api'
    || portfolioData.liveSessionVerified !== true
    || portfolioData.fromCache !== false
    || !source.includes('ibkr')
    || FORBIDDEN_LIVE_PROVENANCE.test(provenance)
  ) {
    return unavailablePortfolio('LIVE IBKR PORTFOLIO REQUIRED');
  }
  if (
    !freshTimestamp(portfolioData.fetchedAt, nowMs, maxAgeMs)
    || !freshTimestamp(observedAt, nowMs, maxAgeMs)
    || !freshTimestamp(socketVerifiedAt, nowMs, maxAgeMs)
  ) {
    return unavailablePortfolio('PORTFOLIO STALE');
  }
  if (!(netLiquidation > 0) || currency !== 'USD') {
    return unavailablePortfolio('USD NET LIQUIDATION UNAVAILABLE');
  }
  if (displayedTotal != null && Math.abs(displayedTotal - netLiquidation) > 0.01) {
    return unavailablePortfolio('NET LIQUIDATION MISMATCH');
  }

  return {
    available: true,
    accountId: reportedAccount,
    currency,
    netLiquidation,
    asOf: observedAt,
    reason: null,
  };
}

const contractsAreExecutable = (contracts, nowMs) => {
  const expiresAt = Date.parse(String(contracts?.expiresAt || ''));
  const closeTime = Date.parse(String(contracts?.event?.closeTime || ''));
  const provenance = [contracts?.source, contracts?.reason].filter(Boolean).join(' ');
  return Boolean(
    contracts?.status === 'available'
    && contracts?.source === 'kalshi_trade_api_v2'
    && Number.isFinite(expiresAt)
    && nowMs <= expiresAt
    && Number.isFinite(closeTime)
    && nowMs < closeTime
    && !FORBIDDEN_LIVE_PROVENANCE.test(provenance)
  );
};

const directSideBook = (line, side) => {
  const prefix = side === 'YES' ? 'yes' : side === 'NO' ? 'no' : null;
  if (!prefix) return null;
  const bid = finiteNumber(line?.[`${prefix}Bid`]);
  const ask = finiteNumber(line?.[`${prefix}Ask`]);
  const askSize = finiteNumber(line?.[`${prefix}AskSize`]);
  if (!(ask > 0 && ask <= 1) || !(askSize >= 1)) return null;
  if (bid != null && (!(bid >= 0) || bid > ask)) return null;
  return {
    bid,
    ask,
    askSize,
    spread: bid == null ? null : ask - bid,
  };
};

/**
 * Rank only model-eligible strikes with a direct Kalshi ask and direct visible
 * ask size. The ladder itself remains strike-sorted; this ranking is isolated
 * to the execution-plan pane.
 */
export function buildSpxStrategyCandidates({
  analyses = [],
  contracts = null,
  nowMs = Date.now(),
  maxLegs = SPX_STRATEGY_MAX_LEGS,
} = {}) {
  if (!contractsAreExecutable(contracts, nowMs)) return [];

  return analyses
    .map(({ line, confluence }) => {
      if (
        !line
        || !confluence?.eligibilityPassed
        || !confluence?.scoreReady
        || finiteNumber(confluence?.score) == null
        || !['YES', 'NO'].includes(confluence?.side)
        || line.source !== 'kalshi_trade_api_v2'
        || (Array.isArray(line.derivedFields) && line.derivedFields.length > 0)
      ) return null;
      const book = directSideBook(line, confluence.side);
      if (!book) return null;
      return {
        ticker: line.ticker,
        threshold: finiteNumber(line.threshold),
        side: confluence.side,
        score: Number(confluence.score),
        maxScore: Number(confluence.maxScore || 8),
        bid: book.bid,
        ask: book.ask,
        askSize: book.askSize,
        spread: book.spread,
        volume24h: finiteNumber(line.volume24h),
        openInterest: finiteNumber(line.openInterest),
        updatedAt: line.updatedAt || contracts.asOf || null,
      };
    })
    .filter((candidate) => candidate?.ticker && candidate.threshold != null)
    .sort((left, right) => (
      right.score - left.score
      || (left.spread ?? Number.POSITIVE_INFINITY) - (right.spread ?? Number.POSITIVE_INFINITY)
      || right.askSize - left.askSize
      || (right.volume24h ?? -1) - (left.volume24h ?? -1)
      || (right.openInterest ?? -1) - (left.openInterest ?? -1)
      || left.threshold - right.threshold
    ))
    .slice(0, Math.max(0, Math.floor(Number(maxLegs) || 0)));
}

export function defaultSpxStrategyMix(candidates = []) {
  const tickers = candidates.map((candidate) => candidate?.ticker).filter(Boolean);
  if (!tickers.length) return {};
  const base = Math.floor(100 / tickers.length);
  let remainder = 100 - base * tickers.length;
  return Object.fromEntries(tickers.map((ticker) => {
    const value = base + (remainder > 0 ? 1 : 0);
    remainder = Math.max(0, remainder - 1);
    return [ticker, value];
  }));
}

const unavailablePlan = (reason, extras = {}) => ({
  ready: false,
  reason,
  budget: null,
  totalCost: null,
  unusedBudget: null,
  mixTotal: null,
  legs: [],
  ...extras,
});

export function sizeSpxStrategy({
  candidates = [],
  netLiquidation,
  portfolioPercent,
  legMix = {},
} = {}) {
  const nlv = finiteNumber(netLiquidation);
  const allocation = finiteNumber(portfolioPercent);
  if (!(nlv > 0)) return unavailablePlan('PORTFOLIO UNAVAILABLE');
  if (!candidates.length) return unavailablePlan('NO ELIGIBLE DIRECT BOOKS');
  if (!(allocation > 0) || allocation > 100) return unavailablePlan('ENTER 0–100%');

  const weights = candidates.map((candidate) => ({
    ticker: candidate.ticker,
    value: finiteNumber(legMix[candidate.ticker]),
  }));
  if (weights.some(({ value }) => value == null || value < 0 || value > 100)) {
    return unavailablePlan('INVALID MIX');
  }
  const mixTotal = weights.reduce((sum, { value }) => sum + value, 0);
  if (!(mixTotal > 0) || mixTotal > 100.000001) {
    return unavailablePlan(mixTotal > 100 ? 'MIX EXCEEDS 100%' : 'ENTER LEG MIX', { mixTotal });
  }

  const budget = nlv * (allocation / 100);
  const legs = candidates.map((candidate, index) => {
    const mix = weights[index].value;
    const requestedBudget = budget * (mix / 100);
    const requestedQuantity = Math.floor((requestedBudget + 1e-9) / candidate.ask);
    const visibleCapacity = Math.floor(candidate.askSize);
    const quantity = Math.max(0, Math.min(requestedQuantity, visibleCapacity));
    const cost = quantity * candidate.ask;
    return {
      ...candidate,
      mix,
      requestedBudget,
      requestedQuantity,
      visibleCapacity,
      quantity,
      cost,
      depthCapped: requestedQuantity > visibleCapacity,
    };
  });
  const totalCost = legs.reduce((sum, leg) => sum + leg.cost, 0);

  return {
    ready: true,
    reason: null,
    budget,
    totalCost,
    unusedBudget: Math.max(0, budget - totalCost),
    mixTotal,
    legs,
  };
}
