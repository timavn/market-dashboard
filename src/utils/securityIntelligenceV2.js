import { normalizeResearchBias } from './researchBias.cjs';

const PRODUCT_PRIORITY = Object.freeze([
  'risk-ranges',
  'bitcoin-trend-tracker',
  'momo-tracker',
  'signal-strength',
  'signal-strength-shorts',
  'investing-ideas',
  'portfolio-solutions',
]);

const finiteNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const normalizeSymbol = (value) => String(value || '').trim().toUpperCase();

const productValues = (security) => Object.values(security?.products || {})
  .filter(Boolean);

export const isCanonicalSecurityIntelligence = (payload) => (
  Number(payload?.schemaVersion) === 2 && payload?.bySymbol && typeof payload.bySymbol === 'object'
);

export const getCanonicalSecurity = (payload, symbol) => {
  if (!isCanonicalSecurityIntelligence(payload)) return null;
  const requested = normalizeSymbol(symbol);
  return payload.bySymbol?.[requested] || null;
};

export const getCanonicalProduct = (security, productId) => (
  security?.products?.[String(productId || '').trim().toLowerCase()] || null
);

export const canonicalProductState = (product) => {
  const state = String(product?.status || '').trim().toLowerCase();
  if (['available', 'not_listed', 'not_due', 'unavailable', 'conflict'].includes(state)) {
    return state;
  }
  return 'unavailable';
};

export const canonicalField = (product, fieldName) => {
  const field = product?.fields?.[fieldName];
  if (!field || typeof field !== 'object' || field.value === null || field.value === undefined) {
    return null;
  }
  return field;
};

export const canonicalFieldState = (product, fieldName) => {
  if (canonicalField(product, fieldName)) return 'available';
  return canonicalProductState(product);
};

const productRank = (product) => {
  const index = PRODUCT_PRIORITY.indexOf(String(product?.id || '').toLowerCase());
  return index === -1 ? PRODUCT_PRIORITY.length : index;
};

export const getCanonicalRiskRange = (
  security,
  { primaryOnly = false, productIds = PRODUCT_PRIORITY } = {},
) => {
  const requestedIds = new Set(productIds.map((value) => String(value || '').toLowerCase()));
  const candidates = productValues(security)
    .filter((product) => (
      requestedIds.has(String(product.id || '').toLowerCase())
      && canonicalProductState(product) === 'available'
      && canonicalField(product, 'riskRange')
    ))
    .sort((left, right) => productRank(left) - productRank(right));
  const selected = primaryOnly
    ? candidates.filter((product) => product.id === 'risk-ranges')[0]
    : candidates[0];
  if (!selected) return null;
  const field = canonicalField(selected, 'riskRange');
  const value = field?.value || {};
  const lrr = finiteNumber(value.lrr);
  const hrr = finiteNumber(value.hrr);
  if (lrr === null || hrr === null || lrr >= hrr) return null;
  return {
    lrr,
    hrr,
    trend: normalizeResearchBias(field?.trend || selected.fields?.trend?.value),
    date: selected.marketDate || null,
    timestamp: selected.publishedAt || field?.publishedAt || null,
    sourceUrl: selected.sourceUrl || field?.sourceUrl || null,
    productId: selected.id,
    state: canonicalProductState(selected),
    qualityStatus: selected.qualityStatus || field?.qualityStatus || null,
    referenceOnly: Boolean(selected.referenceOnly || field?.referenceOnly),
  };
};

export const getCanonicalDirection = (security) => {
  const candidates = productValues(security)
    .filter((product) => canonicalProductState(product) === 'available')
    .map((product) => {
      const field = canonicalField(product, 'trade')
        || canonicalField(product, 'trend')
        || canonicalField(product, 'bias');
      if (!field) return null;
      return {
        value: normalizeResearchBias(field.value),
        side: field.side || product.fields?.side || null,
        productId: product.id,
        date: product.marketDate || null,
        timestamp: product.publishedAt || field.publishedAt || null,
        sourceUrl: product.sourceUrl || field.sourceUrl || null,
        authority: field.authority === true,
        referenceOnly: Boolean(product.referenceOnly || field.referenceOnly),
      };
    })
    .filter((candidate) => candidate && candidate.value)
    .sort((left, right) => (
      Number(right.authority) - Number(left.authority)
      || PRODUCT_PRIORITY.indexOf(left.productId) - PRODUCT_PRIORITY.indexOf(right.productId)
    ));
  return candidates[0] || null;
};

// Signal Strength (longs) by default; pass 'signal-strength-shorts' for the Shorts list.
export const getCanonicalSignalStrength = (security, productId = 'signal-strength') => {
  const product = getCanonicalProduct(security, productId);
  if (canonicalProductState(product) !== 'available') {
    return product ? { status: canonicalProductState(product), value: null, productId } : null;
  }
  const field = canonicalField(product, 'action');
  return field
    ? {
      status: 'available',
      value: field.value,
      productId: product.id,
      date: product.marketDate,
      timestamp: product.publishedAt || field.publishedAt || null,
      sourceUrl: product.sourceUrl || field.sourceUrl || null,
    }
    : { status: 'not_listed', value: null, productId: product.id };
};

export const canonicalFacts = (security, productId = null) => {
  const products = productId
    ? [getCanonicalProduct(security, productId)].filter(Boolean)
    : productValues(security);
  return products.flatMap((product) => (product.fields?.facts || []).map((fact) => ({
    ...fact,
    productId: product.id,
    productLabel: product.label,
    state: canonicalProductState(product),
  })));
};

export const buildCanonicalRiskRangeMap = (payload, { primaryOnly = true } = {}) => {
  if (!isCanonicalSecurityIntelligence(payload)) return {};
  return Object.fromEntries(
    Object.entries(payload.bySymbol || {}).map(([symbol, security]) => {
      const range = getCanonicalRiskRange(security, { primaryOnly });
      return [normalizeSymbol(symbol), range || null];
    }),
  );
};

/**
 * Adapt canonical tracker rows to the small snapshot shape still consumed by
 * the prediction-signal normalizer. The values remain canonical fields; this
 * is only a presentation adapter, not a second source of research data.
 */
export const buildCanonicalTrackerSnapshot = (payload, productId) => {
  if (!isCanonicalSecurityIntelligence(payload)) return null;
  const normalizedProductId = String(productId || '').trim().toLowerCase();
  const stocks = {};
  Object.entries(payload.bySymbol || {}).forEach(([symbol, security]) => {
    const product = getCanonicalProduct(security, normalizedProductId);
    if (canonicalProductState(product) !== 'available') return;
    const trade = normalizeResearchBias(canonicalField(product, 'trade')?.value);
    const trend = normalizeResearchBias(canonicalField(product, 'trend')?.value);
    const bias = normalizeResearchBias(canonicalField(product, 'bias')?.value);
    const facts = canonicalFacts(security, normalizedProductId);
    const factValues = facts.reduce((result, fact) => {
      if (fact?.value && typeof fact.value === 'object') return { ...result, ...fact.value };
      return result;
    }, {});
    stocks[normalizeSymbol(symbol)] = {
      ...factValues,
      trade,
      tradeSignal: trade,
      trend: trend || bias,
      trackerTrend: trend || bias,
      date: product.marketDate || payload.marketDate || null,
      sourceUrl: product.sourceUrl || null,
    };
  });
  return {
    date: payload.marketDate || null,
    snapshotType: normalizedProductId,
    data: { stocks },
    canonical: true,
  };
};

export const canonicalUnavailableLabel = (product) => {
  const state = canonicalProductState(product);
  if (state === 'not_listed' || state === 'not_due') return 'N/A';
  if (state === 'available') return null;
  return state === 'conflict' ? 'CONFLICT' : 'UNAVAILABLE';
};

const securityIntelligenceV2 = {
  isCanonicalSecurityIntelligence,
  getCanonicalSecurity,
  getCanonicalProduct,
  canonicalProductState,
  canonicalField,
  canonicalFieldState,
  getCanonicalRiskRange,
  getCanonicalDirection,
  getCanonicalSignalStrength,
  canonicalFacts,
  buildCanonicalRiskRangeMap,
  buildCanonicalTrackerSnapshot,
  canonicalUnavailableLabel,
};

export default securityIntelligenceV2;
