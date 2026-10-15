export const PREDICTION_MARKET_INDICATOR_POLL_MS = 30_000;
export const PREDICTION_MARKET_INDICATOR_MAX_AGE_MS = 45_000;

const EXPECTED_MARKETS = Object.freeze(['sp500', 'wti', 'nasdaq100', 'gold']);
const EXPECTED_TICKERS = Object.freeze({
  sp500: Object.freeze({ riskRange: 'SPX', trade: 'SPX' }),
  wti: Object.freeze({ riskRange: 'WTIC', trade: 'USO' }),
  nasdaq100: Object.freeze({ riskRange: 'COMPQ', trade: 'COMPQ' }),
  gold: Object.freeze({ riskRange: 'GLD', trade: 'GLD' }),
});
const FORBIDDEN_PROVENANCE = /delayed|frozen|stale|cache(?:d|_only|-only)?|mock|seed|fallback|offline|disconnected|historical|synthetic|inferred|derived/i;
const REFRESH_FAILURE = /refresh(?:[_ -]?(?:failed|failure|error|issue|timeout|timed out))|(?:failed|failure|error).*refresh/i;
const PROXY_FITS = new Set(['related_only', 'strong_proxy', 'proxy']);
const FUTURE_TOLERANCE_MS = 5_000;

const finiteNumber = (value) => {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const timestampMs = (value) => {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const dateKey = (value) => String(value || '').match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || null;

const direction = (value) => {
  const normalized = String(value || '').trim().toUpperCase();
  return ['BULLISH', 'BEARISH'].includes(normalized) ? normalized : null;
};

const invalidReport = (message) => Object.assign(new Error(message), {
  code: 'PREDICTION_MARKET_INDICATOR_REPORT_INVALID',
  liveInvalidation: true,
});

const sectionEvidence = (value) => [
  value?.source,
  value?.freshness,
  value?.availability,
  value?.provenance,
  value?.cacheState,
  value?.refreshState,
  value?.refreshIssue,
  value?.reason,
  value?.warning,
  value?.error,
].filter(Boolean).join(' ');

const unsafeSection = (value) => {
  if (!value || typeof value !== 'object') return true;
  if (
    value.refreshFailed === true
    || value.stale === true
    || value.cachedOnly === true
    || value.fromCache === true
    || value.mock === true
    || value.seeded === true
    || value.synthetic === true
    || value.inferred === true
    || value.refreshIssue
  ) return true;
  const evidence = sectionEvidence(value);
  return FORBIDDEN_PROVENANCE.test(evidence) || REFRESH_FAILURE.test(evidence);
};

const currentSection = (value, nowMs) => {
  const expiresAtMs = timestampMs(value?.expiresAt);
  const asOfMs = timestampMs(value?.asOf);
  return Boolean(
    value?.status === 'available'
    && !unsafeSection(value)
    && Number.isFinite(asOfMs)
    && Number.isFinite(expiresAtMs)
    && expiresAtMs > nowMs,
  );
};

function indicatorForMarket(market, nowMs) {
  const expectedTickers = EXPECTED_TICKERS[market?.marketId];
  if (!expectedTickers) return null;

  const riskRange = market.riskRange;
  const trade = market.trade;
  const reference = market.reference;
  const bias = market.bias;
  const location = market.rangeLocation;
  const setup = market.setup;
  if (
    !currentSection(riskRange, nowMs)
    || !currentSection(trade, nowMs)
    || !currentSection(reference, nowMs)
    || !bias || typeof bias !== 'object'
    || !location || typeof location !== 'object'
    || !setup || typeof setup !== 'object'
  ) return null;

  const lrr = finiteNumber(riskRange.lrr);
  const hrr = finiteNumber(riskRange.hrr);
  const price = finiteNumber(reference.value);
  const trend = direction(riskRange.trend);
  const tradeDirection = direction(trade.direction);
  const rangeDate = dateKey(riskRange.date);
  const tradeDate = dateKey(trade.date);
  const fit = String(riskRange.fit || '').trim().toLowerCase();
  if (
    lrr == null || hrr == null || price == null || !(lrr < hrr)
    || price < lrr || price > hrr
    || !trend || !tradeDirection || trend !== tradeDirection
    || !rangeDate || tradeDate !== rangeDate
    || String(riskRange.ticker || '').trim().toUpperCase() !== expectedTickers.riskRange
    || String(trade.ticker || '').trim().toUpperCase() !== expectedTickers.trade
    || riskRange.setupEligible !== true
    || PROXY_FITS.has(fit)
    || String(reference.availability || '').toLowerCase() !== 'live'
    || String(reference.fit || '').toLowerCase() !== 'exact'
  ) return null;

  const expectedZone = tradeDirection === 'BULLISH' ? 'LRR' : 'HRR';
  const expectedPattern = tradeDirection === 'BULLISH' ? 'BULLISH_AT_LRR' : 'BEARISH_AT_HRR';
  if (
    bias.status !== 'aligned'
    || bias.aligned !== true
    || direction(bias.trade) !== tradeDirection
    || direction(bias.trend) !== trend
    || location.status !== 'available'
    || location.zone !== expectedZone
    || finiteNumber(location.value) !== price
    || setup.status !== 'matched'
    || setup.pattern !== expectedPattern
    || setup.tradeTrendAligned !== true
    || setup.researchQualified !== true
    || setup.recommendationAllowed !== false
  ) return null;

  const width = hrr - lrr;
  const lowerThird = lrr + (width / 3);
  const upperThird = hrr - (width / 3);
  const geometryMatches = tradeDirection === 'BULLISH'
    ? price >= lrr && price <= lowerThird
    : price >= upperThird && price <= hrr;
  if (!geometryMatches) return null;

  const expiresAtMs = Math.min(
    timestampMs(riskRange.expiresAt),
    timestampMs(trade.expiresAt),
    timestampMs(reference.expiresAt),
  );
  const bullish = tradeDirection === 'BULLISH';
  return {
    tone: bullish ? 'bullish' : 'bearish',
    description: bullish
      ? 'Aligned bullish Trade and Trend in the lower Risk Range third.'
      : 'Aligned bearish Trade and Trend in the upper Risk Range third.',
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export function normalizePredictionMarketNavIndicators(report, {
  now = Date.now(),
  maxAgeMs = PREDICTION_MARKET_INDICATOR_MAX_AGE_MS,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const generatedAtMs = timestampMs(report?.generatedAt);
  const validStatus = ['available', 'partial', 'unavailable'].includes(report?.status);
  const exactOrder = Array.isArray(report?.marketOrder)
    && report.marketOrder.length === EXPECTED_MARKETS.length
    && report.marketOrder.every((marketId, index) => marketId === EXPECTED_MARKETS[index]);
  const markets = Array.isArray(report?.markets) ? report.markets : [];
  const marketIds = markets.map((market) => market?.marketId);
  const exactMarkets = markets.length === EXPECTED_MARKETS.length
    && new Set(marketIds).size === EXPECTED_MARKETS.length
    && EXPECTED_MARKETS.every((marketId) => marketIds.includes(marketId));
  const ageMs = nowMs - generatedAtMs;
  if (
    !report || typeof report !== 'object'
    || report.schemaVersion !== 1
    || report.reportType !== 'four_market_morning'
    || !validStatus
    || report.policy?.recommendationAllowed !== false
    || !Number.isFinite(nowMs)
    || !Number.isFinite(generatedAtMs)
    || ageMs < -FUTURE_TOLERANCE_MS
    || ageMs > maxAgeMs
    || !exactOrder
    || !exactMarkets
  ) {
    throw invalidReport('Prediction-market morning report is malformed, stale, or incomplete.');
  }

  const indicators = {};
  markets.forEach((market) => {
    const indicator = indicatorForMarket(market, nowMs);
    if (indicator) indicators[market.marketId] = indicator;
  });

  return {
    status: 'available',
    availability: 'live',
    source: 'prediction_market_morning_report',
    generatedAt: new Date(generatedAtMs).toISOString(),
    indicators,
  };
}

export function activePredictionMarketNavIndicators(resource, { now = Date.now() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!resource || resource.status !== 'available' || !Number.isFinite(nowMs)) return {};
  return Object.fromEntries(Object.entries(resource.indicators || {}).filter(([, indicator]) => (
    ['bullish', 'bearish'].includes(indicator?.tone)
    && timestampMs(indicator?.expiresAt) > nowMs
  )));
}

