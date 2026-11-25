const registryDocument = require('../../infra/lambdas/gmail_ingestor/research_products.json');
const entityCatalogDocument = require('../../infra/lambdas/gmail_ingestor/research_entities.json');
const { isMarketDay } = require('./analyticsDailyBrief.cjs');

const MARKET_TIME_ZONE = registryDocument.marketTimeZone || 'America/New_York';
const newYorkFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: MARKET_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const REQUIRED_STAGES = Object.freeze(
  Array.isArray(registryDocument.stages)
    ? [...registryDocument.stages]
    : ['received', 'parsed', 'validated', 'indexed'],
);
const STRUCTURED_ONLY_TICKERS = Object.freeze(
  (entityCatalogDocument.structuredOnlyTickers || [])
    .map((value) => String(value || '').trim().toUpperCase())
    .filter((value, index, values) => value && values.indexOf(value) === index),
);
const STRUCTURED_ONLY_TICKER_SET = new Set(STRUCTURED_ONLY_TICKERS);

// Signal Strength Shorts was a trial subscription that ended (last list 2026-10-30).
// The deployed registry still names it; nothing local lists, loads or reads it.
const RETIRED_RESEARCH_PRODUCT_IDS = Object.freeze(['signal-strength-shorts']);

const RESEARCH_PRODUCTS = Object.freeze(
  (registryDocument.products || []).filter((product) => !RETIRED_RESEARCH_PRODUCT_IDS.includes(product.id)).map((product) => Object.freeze({
    ...product,
    dashboardConsumer: Object.freeze({ ...(product.dashboardConsumer || registryDocument.defaultDashboardConsumer || {}) }),
    snapshotTypes: Object.freeze([
      product.id,
      ...(Array.isArray(product.snapshotTypes) ? product.snapshotTypes : []),
      ...(Array.isArray(product.aliases) ? product.aliases : []),
    ].map((value) => String(value || '').trim().toLowerCase())
      .filter((value, index, values) => value && values.indexOf(value) === index)),
    requiredStages: Object.freeze(
      Array.isArray(product.requiredStages) ? [...product.requiredStages] : [...REQUIRED_STAGES],
    ),
    authorities: Object.freeze({
      trade: false,
      trend: false,
      riskRange: false,
      supplementalRiskRange: false,
      ...(product.authorities || product.decisionAuthority || {}),
    }),
  })),
);

const RESEARCH_PRODUCT_BY_ID = Object.freeze(
  Object.fromEntries(RESEARCH_PRODUCTS.map((product) => [product.id, product])),
);

const CONTROLLED_EXPOSURE_TYPES = Object.freeze([
  'factor',
  'sector',
  'country',
  'commodity',
  'macro',
]);
const CONTROLLED_EXPOSURE_TYPE_SET = new Set(CONTROLLED_EXPOSURE_TYPES);

const configuredControlledExposures = entityCatalogDocument.controlledExposures || {
  factor: Object.fromEntries(
    Object.entries(entityCatalogDocument.factorAliases || {}).map(([id, aliases]) => [
      id,
      { label: id, aliases },
    ]),
  ),
};

const CONTROLLED_EXPOSURES = Object.freeze(
  Object.entries(configuredControlledExposures).flatMap(
    ([exposureType, definitions]) => {
      const type = String(exposureType || '').trim().toLowerCase();
      if (!CONTROLLED_EXPOSURE_TYPE_SET.has(type) || !definitions || typeof definitions !== 'object') {
        return [];
      }
      return Object.entries(definitions).map(([exposureId, definition]) => {
        const id = String(exposureId || '').trim().toLowerCase();
        const config = definition && typeof definition === 'object' && !Array.isArray(definition)
          ? definition
          : {};
        const aliases = [
          id,
          ...(Array.isArray(config.aliases) ? config.aliases : []),
        ].map((value) => String(value || '').trim().toLowerCase())
          .filter((value, index, values) => value && values.indexOf(value) === index);
        return Object.freeze({
          id,
          type,
          label: String(config.label || id),
          aliases: Object.freeze(aliases),
        });
      }).filter((exposure) => exposure.id);
    },
  ),
);

const CONTROLLED_EXPOSURE_BY_KEY = new Map(
  CONTROLLED_EXPOSURES.map((exposure) => [`${exposure.type}\u0000${exposure.id}`, exposure]),
);
const CONTROLLED_EXPOSURES_BY_ALIAS = (() => {
  const index = new Map();
  CONTROLLED_EXPOSURES.forEach((exposure) => {
    exposure.aliases.forEach((alias) => {
      const values = index.get(alias) || [];
      values.push(exposure);
      index.set(alias, values);
    });
  });
  return index;
})();

function getControlledExposure(value, exposureType = null, { legacyFactor = false } = {}) {
  const source = value && typeof value === 'object' ? value : { id: value, type: exposureType };
  const id = String(source.id || source.exposureId || source.exposure || '').trim().toLowerCase();
  const requestedType = String(source.type || source.exposureType || exposureType || '')
    .trim()
    .toLowerCase();
  if (!id) return null;

  if (requestedType && CONTROLLED_EXPOSURE_TYPE_SET.has(requestedType) && !legacyFactor) {
    const exact = CONTROLLED_EXPOSURE_BY_KEY.get(`${requestedType}\u0000${id}`);
    if (exact) return exact;
    const byTypedAlias = CONTROLLED_EXPOSURES.filter((exposure) => (
      exposure.type === requestedType && exposure.aliases.includes(id)
    ));
    return byTypedAlias.length === 1 ? byTypedAlias[0] : null;
  }

  const byAlias = CONTROLLED_EXPOSURES_BY_ALIAS.get(id) || [];
  if (byAlias.length === 1) return byAlias[0];
  if (requestedType && CONTROLLED_EXPOSURE_TYPE_SET.has(requestedType)) {
    return CONTROLLED_EXPOSURE_BY_KEY.get(`${requestedType}\u0000${id}`) || null;
  }
  return null;
}

function getSecurityExposureTags(symbol) {
  const normalized = String(symbol || '').trim().toUpperCase();
  if (!normalized) return [];
  const configured = entityCatalogDocument.securityExposureTags?.[normalized];
  const legacy = entityCatalogDocument.securityExposures?.[normalized];
  const source = Array.isArray(configured) ? configured : Array.isArray(legacy) ? legacy : [];
  const tags = source.map((entry) => (
    getControlledExposure(entry, null, {
      legacyFactor: typeof entry === 'string',
    })
  )).filter(Boolean);
  return [...new Map(tags.map((tag) => [`${tag.type}\u0000${tag.id}`, tag])).values()];
}

function newYorkParts(value = new Date()) {
  const parts = newYorkFormatter.formatToParts(value instanceof Date ? value : new Date(value));
  const values = {};
  parts.forEach((part) => {
    if (part.type !== 'literal') values[part.type] = part.value;
  });
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function dateFromIso(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? null
    : parsed;
}

function latestResearchMarketDate(now = new Date()) {
  const ny = newYorkParts(now);
  const cursor = dateFromIso(ny.date);
  if (!cursor) return ny.date;
  while (!isMarketDay(cursor)) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return cursor.toISOString().slice(0, 10);
}

// The publication time and its grace are configured once in the product registry.
// Existing environment overrides specify the final deadline, including grace.
function getResearchProductDeadline(productOrId) {
  const product = typeof productOrId === 'string'
    ? RESEARCH_PRODUCT_BY_ID[productOrId]
    : productOrId;
  const hour = Number(product?.deadlineHourET ?? (product?.cadence === 'weekly' ? 16 : 8));
  const minute = Number(product?.deadlineMinuteET ?? 0);
  const total = hour * 60 + minute + Math.max(0, Number(product?.graceMinutes) || 0);
  const deadline = { hour: Math.floor(total / 60), minute: total % 60 };
  if (product?.id === 'risk-ranges') {
    for (const [key, variable] of [['hour', 'RISK_RANGE_DEADLINE_HOUR_ET'], ['minute', 'RISK_RANGE_DEADLINE_MINUTE_ET']]) {
      const raw = process.env[variable];
      if (raw !== undefined && raw !== '' && Number.isFinite(Number(raw))) deadline[key] = Number(raw);
    }
  }
  return deadline;
}

/**
 * Product due policy used by SYS and research response coverage.
 *
 * Event-driven products become expected only when an artifact is observed.
 * This helper therefore returns false for event-driven products. Callers should
 * still surface received event-driven products and require every configured
 * processing stage to complete.
 */
function isResearchProductDue(productOrId, {
  now = new Date(),
  marketDate = null,
} = {}) {
  const product = typeof productOrId === 'string'
    ? RESEARCH_PRODUCT_BY_ID[productOrId]
    : productOrId;
  if (!product) return false;

  const ny = newYorkParts(now);
  const targetDate = marketDate || ny.date;
  const target = dateFromIso(targetDate);
  if (!target || !isMarketDay(target)) return false;

  if (product.cadence === 'market_day_0800') {
    if (targetDate < ny.date) return true;
    if (targetDate > ny.date) return false;
    const { hour: deadlineHour, minute: deadlineMinute } = getResearchProductDeadline(product);
    return ny.hour > deadlineHour || (ny.hour === deadlineHour && ny.minute >= deadlineMinute);
  }

  if (product.cadence === 'weekly') {
    if (target.getUTCDay() !== 5) return false;
    if (targetDate < ny.date) return true;
    if (targetDate > ny.date) return false;
    const { hour: deadlineHour, minute: deadlineMinute } = getResearchProductDeadline(product);
    return ny.hour > deadlineHour || (ny.hour === deadlineHour && ny.minute >= deadlineMinute);
  }

  return false;
}

function getResearchProduct(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (RESEARCH_PRODUCT_BY_ID[normalized]) return RESEARCH_PRODUCT_BY_ID[normalized];
  return RESEARCH_PRODUCTS.find((product) => product.snapshotTypes.includes(normalized)) || null;
}

function isStructuredOnlyTicker(value) {
  return STRUCTURED_ONLY_TICKER_SET.has(String(value || '').trim().toUpperCase());
}

module.exports = {
  CONTROLLED_EXPOSURES,
  CONTROLLED_EXPOSURE_TYPES,
  ENTITY_CATALOG: entityCatalogDocument,
  MARKET_TIME_ZONE,
  REQUIRED_STAGES,
  RESEARCH_PRODUCTS,
  RESEARCH_PRODUCT_BY_ID,
  RETIRED_RESEARCH_PRODUCT_IDS,
  STRUCTURED_ONLY_TICKERS,
  getControlledExposure,
  getResearchProduct,
  getResearchProductDeadline,
  getSecurityExposureTags,
  isResearchProductDue,
  isStructuredOnlyTicker,
  latestResearchMarketDate,
  newYorkParts,
};
