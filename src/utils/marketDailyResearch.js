import { safeResearchUrl } from './researchSourceUrl';
import { securityIntelligencePayload } from './securityIntelligenceResponses';

const DIRECTIONS = new Set(['BULLISH', 'BEARISH', 'NEUTRAL']);
const REJECTED_FLAGS = [
  'stale', 'isStale', 'mock', 'isMock', 'seed', 'seeded', 'synthetic', 'inferred',
  'fromCache', 'cacheOnly', 'cache_only', 'offline', 'disconnected', 'fallback',
];
const REJECTED_STATE = /(?:^|[\s_-])(?:unavailable|offline|disconnected|stale|expired|mock|seed|seeded|synthetic|inferred|cached|cache-only|fallback|error|failed)(?:$|[\s_-])/i;
const EVIDENCE_METADATA = ['metadata', 'meta', 'provenance', 'quality', 'flags', 'providerStatus'];
const FIELD_KINDS = {
  trade: new Set(['tracker_trade', 'trade_signal']),
  trend: new Set(['primary_risk_range', 'supplemental_risk_range', 'historical_risk_range', 'investing_idea_position']),
};

export function validMarketResearchDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const parsed = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

export const marketResearchTickers = (tickers) => [...new Set(
  (Array.isArray(tickers) ? tickers : [])
    .map((ticker) => String(ticker || '').trim().toUpperCase())
    .filter((ticker) => /^[A-Z][A-Z0-9.^/-]{0,14}$/.test(ticker)),
)];

// Inspect this record's evidence, never reject one independent product because
// another product in the same envelope is unavailable.
function rejectedEvidence(value) {
  if (!value || typeof value !== 'object') return false;
  if (REJECTED_FLAGS.some((key) => value[key] === true)
    || value.connected === false || value.available === false
    || ['status', 'state', 'freshness', 'source', 'provider', 'dataType']
      .some((key) => REJECTED_STATE.test(String(value[key] || '')))) return true;
  return EVIDENCE_METADATA.some((key) => rejectedEvidence(value[key]));
}

function exactTickerReference(reference, ticker) {
  if (!['direct', 'direct_alias'].includes(reference?.matchType)) return false;
  const matched = String(reference.matchedText || '').trim().toUpperCase();
  // The canonical API also maps cash indexes to ETFs. Require the published
  // instrument itself here: an SPX signal must not become a SPY signal.
  return matched === ticker || matched.endsWith(`(${ticker})`);
}

function referenceDirection(reference, fieldName) {
  const raw = fieldName === 'trend' && reference?.value && typeof reference.value === 'object'
    ? reference.value.trend
    : reference?.value;
  return DIRECTIONS.has(raw) ? raw : reference?.direction;
}

function verifiedFieldReference({ security, product, field, fieldName, ticker, marketDate, now }) {
  const sourceUrl = safeResearchUrl(field.sourceUrl);
  if (!sourceUrl || field.marketDate !== marketDate || field.productId !== product.id
    || field.qualityStatus !== 'indexed' || field.referenceOnly === true
    || field.rule || rejectedEvidence(field) || !DIRECTIONS.has(field.value)) return null;
  const publishedAt = field.publishedAt ? Date.parse(field.publishedAt) : null;
  if (field.publishedAt && (!Number.isFinite(publishedAt) || publishedAt > now + 5_000)) return null;

  return (Array.isArray(security.directReferences) ? security.directReferences : []).find((reference) => (
    reference.marketDate === marketDate
    && reference.productId === product.id
    && reference.qualityStatus === 'indexed'
    && !rejectedEvidence(reference)
    && reference.referenceOnly !== true
    && FIELD_KINDS[fieldName].has(reference.kind)
    && exactTickerReference(reference, ticker)
    && referenceDirection(reference, fieldName) === field.value
    && safeResearchUrl(reference.sourceUrl) === sourceUrl
    && (reference.publishedAt || null) === (field.publishedAt || null)
    && (!field.sourceEventId || reference.sourceEventId === field.sourceEventId)
  )) || null;
}

/** Source-dated research context only; never quotes, ranges, or a new signal. */
export function projectMarketDailyResearch(response, { marketDate, tickers, now = Date.now() } = {}) {
  const payload = securityIntelligencePayload(response);
  if (!validMarketResearchDate(marketDate) || payload?.marketDate !== marketDate
    || Number(payload?.schemaVersion) !== 2 || rejectedEvidence(response)
    || rejectedEvidence(payload)) return [];

  const items = new Map();
  const requestedTickers = marketResearchTickers(tickers);
  requestedTickers.forEach((ticker) => {
    const security = payload.bySymbol?.[ticker];
    if (!security || security.symbol !== ticker || rejectedEvidence(security)) return;
    Object.values(security.products || {}).forEach((product) => {
      if (!product || !['available', 'conflict'].includes(product.status)
        || product.pipelineStatus !== 'indexed' || product.marketDate !== marketDate
        || product.referenceOnly === true || rejectedEvidence(product)
        || typeof product.label !== 'string' || !product.label.trim()) return;

      ['trade', 'trend'].forEach((fieldName) => {
        const field = product.fields?.[fieldName];
        if (!field || product.conflicts?.includes(fieldName)) return;
        const reference = verifiedFieldReference({ security, product, field, fieldName, ticker, marketDate, now });
        if (!reference) return;
        const horizon = fieldName === 'trade' ? 'Trade' : 'Trend';
        const direction = field.value;
        const displayDirection = direction[0] + direction.slice(1).toLowerCase();
        const id = `${ticker}:${product.id}:${fieldName}:${marketDate}`;
        items.set(id, {
          id,
          ticker,
          productId: product.id,
          horizon,
          direction,
          authoritative: field.authority === true,
          text: `${ticker} ${horizon} is ${displayDirection} in Hedgeye’s ${product.label}.`,
          sourceTitle: product.label,
          sourceUrl: safeResearchUrl(field.sourceUrl),
          publicationDate: marketDate,
          publishedAt: field.publishedAt || null,
        });
      });
    });
  });
  return [...items.values()].sort((left, right) => Number(right.authoritative) - Number(left.authoritative)
    || requestedTickers.indexOf(left.ticker) - requestedTickers.indexOf(right.ticker)
    || left.horizon.localeCompare(right.horizon));
}

// A session return and a published horizon can share a direction without one
// confirming the other. This comparison deliberately makes no causal claim.
export function describeMarketDailyResearch(item, changePercent) {
  if (!item || !DIRECTIONS.has(item.direction) || !['Trade', 'Trend'].includes(item.horizon)
    || !marketResearchTickers([item.ticker]).length) return '';
  if (typeof changePercent !== 'number' || !Number.isFinite(changePercent)) return item.text || '';
  const direction = item.direction[0] + item.direction.slice(1).toLowerCase();
  const published = `its published ${item.horizon} is ${direction}`;
  if (changePercent === 0) return `${item.ticker} is unchanged this session; ${published}.`;
  const move = changePercent > 0 ? 'higher' : 'lower';
  if (item.direction === 'NEUTRAL') return `${item.ticker} is ${move} this session; ${published}.`;
  const sharesDirection = (changePercent > 0) === (item.direction === 'BULLISH');
  return sharesDirection
    ? `${item.ticker}’s session ${changePercent > 0 ? 'gain' : 'decline'} shares the direction of its published ${direction} ${item.horizon}.`
    : `${item.ticker} is ${move} this session while ${published}.`;
}
