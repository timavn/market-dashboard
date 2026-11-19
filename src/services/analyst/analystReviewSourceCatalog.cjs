const registry = require('../../../infra/lambdas/gmail_ingestor/research_products.json');

const gatewayDependencies = new Set(['portfolio', 'portfolioOpenOrders', 'balance', 'portfolioBalance', 'portfolioFactors']);
// Predictive Markets Review setup board inputs, in display order. The sidecar
// projection uses the same ids (analyst_review_sources.PREDICTION_BOARD_SOURCES).
// Hedgeye inputs reuse their research product ids so pre-run readiness applies.
const predictionBoardSources = [['risk-ranges', 'Risk Ranges'], ['crypto-quant', 'Crypto Quant'],
  ['hedgai-signals', 'HedgAI Signals'], ['tradeResearch', 'Trade research'], ['inflation-nowcast', 'Monthly Inflation Nowcast'],
  ['marketPrices', 'Market prices'], ['volatilityIndices', 'Volatility indices'],
  ['usdCorrelations', 'USD correlations'], ['kalshiContracts', 'Kalshi contracts']];
// Registered products Portfolio Review leaves out, while loading and once loaded (user-specified 2026-11-18;
// mirrors analyst_review_sources.RETIRED_REVIEW_SOURCES): Crypto Quant is the daily Bitcoin email, listed as Bitcoin
// Tracker, and Signal Strength Shorts was a trial that ended.
const RETIRED_REVIEW_SOURCES = new Set(['crypto-quant', 'signal-strength-shorts']);
const source = (id, label, status) => ({ id, label, status, observedAt: null,
  ...(gatewayDependencies.has(id) ? { requiresIbGateway: true } : {}),
});

// The pending display and server acquisition projection use the same roster.
// These rows reserve presentation space, without supplying source evidence.
function pendingReviewSourceItems(kind, status = 'checking') {
  if (kind === 'prediction-markets-review') return predictionBoardSources.map(([id, label]) => source(id, label, status));
  if (!['portfolio-review', 'balance-review'].includes(kind)) return [];
  const items = [source('portfolio', 'IBKR holdings', status)];
  if (kind === 'portfolio-review') items.push(source('portfolioBalance', 'IBKR account exposure', status),
    source('portfolioOpenOrders', 'IBKR open orders', status),
    source('portfolioRefreshResearch', 'Portfolio research archive', status),
    ...registry.products.filter(row => !RETIRED_REVIEW_SOURCES.has(row.id)).map(row => source(row.id, row.label, status)), source('inflation-nowcast', 'Monthly Inflation Nowcast', status),
    source('marketSituation', 'Market data', status));
  if (kind === 'balance-review') items.unshift(source('balance', 'IBKR balances', status));
  if (kind === 'balance-review') items.push(source('interestStatus', 'Interest accruals', status), source('history', 'Interest history', status));
  return items;
}

module.exports = { pendingReviewSourceItems, RETIRED_REVIEW_SOURCES };
