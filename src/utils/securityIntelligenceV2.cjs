const {
  MAX_SYMBOLS,
  buildSecurityIntelligence,
  canonicalizeSymbol,
  filterSourceQualityRevisions,
  normalizeRequestedSymbols,
} = require('./securityIntelligence.cjs');
const {
  ENTITY_CATALOG,
  RESEARCH_PRODUCTS,
  isStructuredOnlyTicker,
} = require('./researchProductRegistry.cjs');
const {
  isCanonicalResearchBias,
  normalizeResearchBias,
} = require('./researchBias.cjs');

const { isExplicitTradeProvenance, isExactPublishedTradeReading } = require('./publishedResearchSignals.cjs');

const RESPONSE_SCHEMA_VERSION = 2;
const VERIFIED_CURRENT_QUALITY = new Set(['indexed']);
const DIRECT_MATCH_TYPES = new Set(['direct', 'direct_alias']);
const STRUCTURED_KINDS = new Set([
  'primary_risk_range',
  'historical_risk_range',
  'supplemental_risk_range',
  'tracker_trade',
  'trade_signal',
  'trend_signal',
  'signal_strength_added',
  'signal_strength_removed',
  'signal_strength_listed',
  'signal_strength_membership',
  'signal_strength_short_added',
  'signal_strength_short_removed',
  'signal_strength_short_membership',
  'portfolio_solutions_rank',
  'portfolio_solutions_mover',
  'position_mention',
  'real_time_alert',
  'etf_pro_change',
  'investing_idea_position',
]);
const SIGNAL_STRENGTH_ACTIONS = Object.freeze({
  long: { signal_strength_added: 'ADDED', signal_strength_removed: 'REMOVED', signal_strength_membership: null },
  short: { signal_strength_short_added: 'ADDED', signal_strength_short_removed: 'REMOVED', signal_strength_short_membership: null },
});
const UNIVERSE_EVENT_KINDS = new Set([
  ...STRUCTURED_KINDS,
  // Python ingestion event names are retained in the immutable ledger and
  // normalized to the JS projection later.
  'risk_range',
  'supplemental_risk_range',
  'portfolio_rank',
  'position_reference',
  'position_change',
]);
const UNIVERSE_COLLECTION_KEYS = new Set([
  'added',
  'addedlongs',
  'addedshorts',
  'alerts',
  'changes',
  'cryptos',
  'fullbooklongs',
  'fullbookshorts',
  'longs',
  'neutrals',
  'positions',
  'rankings',
  'removed',
  'removedlongs',
  'removedshorts',
  'rows',
  'securities',
  'shorts',
  'stocks',
  'symbols',
  'tickers',
]);
const STRUCTURED_SECURITY_FIELDS = new Set([
  'action',
  'buytrade',
  'call',
  'change',
  'downside',
  'hrr',
  'lrr',
  'low',
  'position',
  'positionsizing',
  'prevclose',
  'previousclose',
  'price',
  'rank',
  'riskrangehigh',
  'riskrangelow',
  'score',
  'selltrade',
  'side',
  'signal',
  'tradesignal',
  'trend',
  'upside',
]);
const UNIVERSE_IGNORED_TOKENS = new Set([
  ...(ENTITY_CATALOG.reservedTokens || []),
  'ALERT',
  'AUG',
  'AUGUST',
  'BEARISH',
  'BULLISH',
  'CASH',
  'COMMODITIES',
  'EQUITIES',
  'LONG',
  'NEUTRAL',
  'REAL-TIME',
  'SELL',
  'SEMICONDUCTORS',
  'SHORT',
  'SOFTWARE',
  'TREND',
].map((token) => String(token).trim().toUpperCase()));
Object.values(ENTITY_CATALOG.controlledExposures || {}).forEach((definitions) => {
  Object.values(definitions || {}).forEach((definition) => {
    const aliases = definition && typeof definition === 'object'
      ? definition.aliases || []
      : [];
    aliases.forEach((alias) => UNIVERSE_IGNORED_TOKENS.add(String(alias).trim().toUpperCase()));
  });
});

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeBias(value) {
  return normalizeResearchBias(value);
}

function normalizedSide(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (['LONG', 'BUY', 'BULLISH'].includes(raw)) return 'LONG';
  if (['SHORT', 'SELL', 'BEARISH'].includes(raw)) return 'SHORT';
  return null;
}

function referenceIsCurrentStructured(reference, marketDate) {
  return Boolean(
    reference
    && reference.marketDate === marketDate
    && VERIFIED_CURRENT_QUALITY.has(reference.qualityStatus)
    && DIRECT_MATCH_TYPES.has(reference.matchType)
    && STRUCTURED_KINDS.has(reference.kind),
  );
}

function referenceTimestamp(reference) {
  return String(reference?.publishedAt || reference?.marketDate || '');
}

function latestReferences(references) {
  if (!references.length) return [];
  const latestTimestamp = references
    .map(referenceTimestamp)
    .sort()
    .at(-1);
  return references.filter((reference) => referenceTimestamp(reference) === latestTimestamp);
}

function provenance(reference, productId, marketDate) {
  return {
    productId,
    marketDate,
    publishedAt: reference?.publishedAt || null,
    sourceUrl: reference?.sourceUrl || null,
    sourceEventId: reference?.sourceEventId || null,
    // The email the reading came from, so its Source can open the original (user-asked 2026-11-18).
    ...(reference?.sourceMessageId ? { sourceMessageId: reference.sourceMessageId } : {}),
    qualityStatus: reference?.qualityStatus || null,
    referenceOnly: reference?.marketDate !== marketDate,
    executable: false,
    signalProvenance: reference?.signalProvenance, sourceTicker: reference?.sourceTicker,
    fieldPath: reference?.fieldPath, sourceText: reference?.sourceText, matchType: reference?.matchType,
  };
}

function fieldValue(value, reference, productId, marketDate, extra = {}) {
  return {
    value,
    ...provenance(reference, productId, marketDate),
    ...extra,
  };
}

function rangeFromReference(reference) {
  const value = reference?.value;
  if (!value || typeof value !== 'object') return null;
  const lrr = finiteNumber(value.lrr ?? value.low ?? value.riskRangeLow);
  const hrr = finiteNumber(value.hrr ?? value.high ?? value.riskRangeHigh);
  if (lrr === null || hrr === null || lrr > hrr) return null;
  return {
    lrr,
    hrr,
    trend: normalizeBias(value.trend)
      || (isCanonicalResearchBias(reference.direction)
        ? normalizeBias(reference.direction)
        : null),
  };
}

function directionFromReference(reference) {
  const value = reference?.value;
  if (value && typeof value === 'object') {
    const side = normalizedSide(value.side || value.position);
    const bias = normalizeBias(value.bias || value.trend || value.direction);
    if (side || bias) {
      return {
        value: bias || (side === 'LONG' ? 'BULLISH' : 'BEARISH'),
        side,
        kind: reference.kind === 'tracker_trade' || reference.kind === 'trade_signal'
          ? 'trade'
          : ['primary_risk_range', 'supplemental_risk_range', 'trend_signal'].includes(reference.kind)
            ? 'trend'
            : 'position',
      };
    }
  }
  const raw = value !== null && value !== undefined && value !== ''
    ? normalizeBias(value)
    : isCanonicalResearchBias(reference?.direction)
      ? normalizeBias(reference.direction)
      : null;
  if (!raw) return null;
  return {
    value: raw === 'LONG' ? 'BULLISH' : raw === 'SHORT' ? 'BEARISH' : raw,
    side: normalizedSide(raw),
    kind: reference.kind === 'tracker_trade' || reference.kind === 'trade_signal'
      ? 'trade'
      : ['primary_risk_range', 'supplemental_risk_range', 'trend_signal'].includes(reference.kind)
        ? 'trend'
        : 'position',
  };
}

function hasConflictingValues(references, selector) {
  const values = [...new Set(references.map(selector).filter((value) => value !== null && value !== undefined))];
  return values.length > 1;
}

function deduplicateInvestingIdeaReferences(references) {
  const structured = references.filter((reference) => (
    reference?.value
    && typeof reference.value === 'object'
    && (reference.value.side || reference.value.position || reference.value.bias)
  ));
  // Older materializations can contain a typed row plus an alert-shaped leaf
  // for the same publication. The typed row is the canonical representation;
  // conflicting typed rows remain so the affected fields become CONFLICT.
  const candidates = structured.length ? structured : references;
  const seen = new Set();
  return candidates.filter((reference) => {
    const value = reference.value && typeof reference.value === 'object'
      ? {
        side: reference.value.side || reference.value.position || null,
        bias: reference.value.bias || null,
        prevClose: reference.value.prevClose ?? reference.value.previousClose ?? null,
        lrr: reference.value.lrr ?? null,
        hrr: reference.value.hrr ?? null,
      }
      : reference.value ?? reference.direction ?? null;
    const signature = JSON.stringify([
      reference.publishedAt || reference.marketDate || null,
      reference.sourceUrl || null,
      value,
    ]);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

function buildProductRecord({ product, productStatus, references, marketDate }) {
  const productId = product.id;
  const currentReferences = references.filter((reference) => referenceIsCurrentStructured(reference, marketDate));
  const canonicalReferences = productId === 'investing-ideas'
    ? deduplicateInvestingIdeaReferences(currentReferences)
    : currentReferences;
  const record = {
    id: productId,
    label: product.label,
    marketDate,
    pipelineStatus: productStatus?.status || 'missing',
    status: 'not_listed',
    qualityStatus: productStatus?.status || null,
    publishedAt: null,
    sourceUrl: null,
    evidenceIds: [],
    fields: {
      trade: null,
      trend: null,
      bias: null,
      side: null,
      riskRange: null,
      previousClose: null,
      action: null,
      rank: null,
      sizing: null,
      facts: [],
    },
    conflicts: [],
    referenceOnly: false,
    executable: false,
  };

  if (productStatus?.status === 'not_due') {
    record.status = 'not_due';
    return record;
  }
  if (productStatus?.status !== 'indexed') {
    record.status = 'unavailable';
    return record;
  }
  if (!canonicalReferences.length) return record;

  const latest = latestReferences(canonicalReferences);
  const sources = latest.filter(Boolean);
  record.publishedAt = sources[0]?.publishedAt || null;
  record.sourceUrl = sources[0]?.sourceUrl || null;
  record.evidenceIds = [...new Set(sources.map((reference) => reference.sourceEventId).filter(Boolean))];

  const trackerReferences = latest.filter((reference) => (
    ['tracker_trade', 'trade_signal'].includes(reference.kind)
    && isExplicitTradeProvenance(reference.signalProvenance)
  ));
  if (trackerReferences.length) {
    if (hasConflictingValues(trackerReferences, (reference) => normalizeBias(reference.value))) {
      record.conflicts.push('trade');
    } else {
      const reference = trackerReferences[0];
      const trade = normalizeBias(reference.value);
      if (trade) record.fields.trade = fieldValue(trade, reference, productId, marketDate, {
        authority: isExplicitTradeProvenance(reference.signalProvenance),
      });
    }
  }

  const rangeReferences = latest.filter((reference) => (
    ['primary_risk_range', 'historical_risk_range', 'supplemental_risk_range', 'investing_idea_position', 'trend_signal'].includes(reference.kind)
    && rangeFromReference(reference)
  ));
  if (rangeReferences.length) {
    const rangeKeys = rangeReferences.map((reference) => {
      const range = rangeFromReference(reference);
      return `${range.lrr}:${range.hrr}`;
    });
    if (new Set(rangeKeys).size > 1) {
      record.conflicts.push('riskRange');
    } else {
      const reference = rangeReferences[0];
      const range = rangeFromReference(reference);
      record.fields.riskRange = fieldValue(
        { lrr: range.lrr, hrr: range.hrr },
        reference,
        productId,
        marketDate,
        {
          trend: range.trend,
          authority: product.authorities?.riskRange === true,
        },
      );
      if (range.trend) {
        record.fields.trend = fieldValue(
          range.trend,
          reference,
          productId,
          marketDate,
          { authority: product.authorities?.trend === true },
        );
      }
    }
  }

  const directionReferences = latest
    .map((reference) => ({ reference, direction: directionFromReference(reference) }))
    .filter((entry) => entry.direction);
  if (directionReferences.length) {
    const directions = [...new Set(directionReferences.map((entry) => entry.direction.value))];
    if (directions.length > 1) {
      record.conflicts.push('bias');
    } else {
      const selected = directionReferences[0];
      const { reference, direction } = selected;
      record.fields.bias = fieldValue(
        direction.value,
        reference,
        productId,
        marketDate,
        {
          side: direction.side,
          kind: direction.kind,
          display: direction.side || direction.value,
          authority: direction.kind === 'trade'
            ? isExplicitTradeProvenance(reference.signalProvenance)
            : direction.kind === 'trend'
              ? product.authorities?.trend === true
              : false,
        },
      );
      record.fields.side = direction.side;
      if (direction.kind === 'trend' && !record.fields.trend) {
        // Published Trend is independent evidence even when this source's
        // numeric range is withheld for a discrepancy.
        record.fields.trend = fieldValue(
          direction.value,
          reference,
          productId,
          marketDate,
          { authority: product.authorities?.trend === true },
        );
      }
    }
  }

  const investingReference = latest.find((reference) => reference.kind === 'investing_idea_position');
  if (investingReference && investingReference.value && typeof investingReference.value === 'object') {
    const value = investingReference.value;
    record.fields.previousClose = finiteNumber(value.prevClose);
    record.fields.side = normalizedSide(value.side || value.position) || record.fields.side;
  }

  // Portfolio Solutions is a verified membership list, not a primary tracker
  // or Risk Ranges publication. Membership still carries an explicit current
  // directional implication for the security surfaces: listed securities are
  // BULLISH for both Trade and Trend. Keep the derived fields reference-only so
  // the list can corroborate health without replacing the primary authorities.
  const portfolioSolutionsReference = productId === 'portfolio-solutions'
    ? latestReferences(canonicalReferences.filter((reference) => (
      reference.kind === 'portfolio_solutions_rank'
      && finiteNumber(reference.value) !== null
    )))[0]
    : null;
  if (productId === 'portfolio-solutions' && portfolioSolutionsReference) {
    const derivedDirection = {
      authority: false,
      referenceOnly: true,
      rule: 'portfolio-solutions-listed',
    };
    record.fields.trade = fieldValue(
      'BULLISH',
      portfolioSolutionsReference,
      productId,
      marketDate,
      derivedDirection,
    );
    record.fields.trend = fieldValue(
      'BULLISH',
      portfolioSolutionsReference,
      productId,
      marketDate,
      derivedDirection,
    );
    record.fields.rank = fieldValue(
      finiteNumber(portfolioSolutionsReference.value),
      portfolioSolutionsReference,
      productId,
      marketDate,
    );
  }

  const factReferences = productId === 'portfolio-solutions' ? canonicalReferences : latest;
  factReferences.forEach((reference) => {
    const value = reference.value;
    const factValue = value && typeof value === 'object'
      ? { ...value }
      : value ?? reference.direction ?? null;
    record.fields.facts.push({
      kind: reference.kind,
      value: factValue,
      excerpt: reference.excerpt || null,
      ...provenance(reference, productId, marketDate),
    });
    // Each list reads only its own kinds, so a short kind recorded under the
    // long product before Shorts became its own (2026-10-29) never sets it.
    const signalAction = SIGNAL_STRENGTH_ACTIONS[productId === 'signal-strength-shorts' ? 'short' : 'long'][reference.kind];
    if (signalAction !== undefined) {
      record.fields.action = fieldValue(
        signalAction || reference.value || 'LISTED',
        reference,
        productId,
        marketDate,
      );
    }
  });

  record.status = record.conflicts.length ? 'conflict' : 'available';
  return record;
}

function collectUniverseSymbols({
  marketDate = null,
  snapshots = [],
  entityEvents = [],
  productManifests = [],
  riskRangeEnvelope = null,
  publishedTradeReadings = [],
} = {}) {
  const symbols = new Set();
  const add = (value) => {
    const raw = String(value || '').trim().toUpperCase();
    const parenthesized = raw.match(/\(([A-Z][A-Z0-9./=^_-]{0,11})\)/);
    const candidate = canonicalizeSymbol(parenthesized?.[1] || raw);
    if (
      candidate
      && !UNIVERSE_IGNORED_TOKENS.has(candidate)
      && /^[A-Z][A-Z0-9./=^_-]*$/.test(candidate)
    ) symbols.add(candidate);
  };
  const hasStructuredSecurityFields = (value) => (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).some((key) => STRUCTURED_SECURITY_FIELDS.has(String(key).toLowerCase()))
  );
  const visit = (value, collectionContext = false) => {
    if (Array.isArray(value)) {
      value.forEach((child) => {
        if (typeof child === 'string' && collectionContext) add(child);
        else visit(child, collectionContext);
      });
      return;
    }
    if (!value || typeof value !== 'object') return;
    const direct = value.ticker || value.symbol || value.asset;
    if (direct && (collectionContext || hasStructuredSecurityFields(value))) add(direct);
    Object.entries(value).forEach(([key, child]) => {
      if (['ticker', 'symbol', 'asset'].includes(key)) return;
      const keyIsCollection = UNIVERSE_COLLECTION_KEYS.has(String(key).toLowerCase());
      const childIsStructured = hasStructuredSecurityFields(child);
      // Within a row, only collection-valued fields may contribute a bare
      // string. Do not reinterpret ids, labels, sides, or asset-class text as
      // securities (ETF Pro rows contain generated ids such as AAAU_0).
      if (typeof child === 'string' && keyIsCollection) add(child);
      if (
        child
        && typeof child === 'object'
        && !Array.isArray(child)
        && /^(?:[A-Z][A-Z0-9./=^_-]{0,11})$/.test(key)
        && !/_\d+$/.test(key)
        && (keyIsCollection || childIsStructured)
      ) add(key);
      if (child && typeof child === 'object' && !Array.isArray(child) && childIsStructured) {
        const parenthesizedKey = String(key).match(/\(([A-Z][A-Z0-9./=^_-]{0,11})\)/);
        if (parenthesizedKey) add(parenthesizedKey[1]);
      }
      visit(child, collectionContext || keyIsCollection);
    });
  };
  Object.keys(riskRangeEnvelope?.ranges || {}).forEach(add);
  publishedTradeReadings.filter((reading) => isExactPublishedTradeReading(reading)
    && ['indexed', 'validated'].includes(reading.qualityStatus)).forEach((reading) => {
    const ticker = String(reading.sourceTicker || reading.ticker || '').toUpperCase();
    // Published source instruments are exact identities; exposure aliases such
    // as SPX -> SPY cannot rename an independently published Trade signal.
    if (/^[A-Z][A-Z0-9./=^_-]*$/.test(ticker)) symbols.add(ticker);
  });
  filterSourceQualityRevisions(entityEvents, productManifests).forEach((event) => {
    const matchType = String(event?.matchType || '').toLowerCase();
    const eventSymbol = canonicalizeSymbol(event?.entityId);
    if (
      event?.marketDate === marketDate
      && String(event.entityType || '').toLowerCase() === 'ticker'
      && UNIVERSE_EVENT_KINDS.has(String(event.eventType || event.kind || '').toLowerCase())
      && ['structured_membership', 'direct', 'direct_alias'].includes(matchType)
      && (!isStructuredOnlyTicker(eventSymbol) || matchType === 'structured_membership')
    ) add(event.entityId);
  });
  filterSourceQualityRevisions(snapshots, productManifests, { snapshots: true })
    .filter((snapshot) => !marketDate || snapshot?.date === marketDate)
    .forEach((snapshot) => visit(snapshot?.data));
  return [...symbols].sort();
}

function buildSecurityIntelligenceV2({
  symbols = [],
  scope = 'symbols',
  limit = MAX_SYMBOLS,
  cursor = null,
  ...params
} = {}) {
  const sourceSymbols = scope === 'universe'
    ? collectUniverseSymbols(params)
    : normalizeRequestedSymbols(symbols);
  const pageSize = Math.max(1, Math.min(MAX_SYMBOLS, Number(limit) || MAX_SYMBOLS));
  const offset = Math.max(0, Number.parseInt(cursor || '0', 10) || 0);
  const requestedSymbols = scope === 'universe'
    ? sourceSymbols.slice(offset, offset + pageSize)
    : sourceSymbols;
  const base = buildSecurityIntelligence({
    ...params,
    symbols: requestedSymbols,
  });
  const productStatusById = Object.fromEntries(
    asArray(base.products).map((product) => [product.id, product]),
  );

  const bySymbol = Object.fromEntries(
    Object.entries(base.bySymbol || {}).map(([symbol, security]) => {
      const references = asArray(security.directReferences);
      const products = Object.fromEntries(
        RESEARCH_PRODUCTS.map((product) => [
          product.id,
          buildProductRecord({
            product,
            productStatus: productStatusById[product.id],
            references: references.filter((reference) => reference.productId === product.id),
            marketDate: base.marketDate,
          }),
        ]),
      );
      const retainedTrade = security.lastVerifiedDecision?.trade;
      const publishedProduct = products[retainedTrade?.sourceId];
      if (publishedProduct && retainedTrade.sourceDate === base.marketDate
        && isExplicitTradeProvenance(retainedTrade.signalProvenance)
        && ['indexed', 'validated'].includes(retainedTrade.qualityStatus)
        && !publishedProduct.conflicts.includes('trade')) {
        publishedProduct.fields.trade = {
          ...retainedTrade, productId: retainedTrade.sourceId, marketDate: retainedTrade.sourceDate,
          authority: true, referenceOnly: retainedTrade.qualityStatus !== 'indexed', executable: false,
        };
        publishedProduct.publishedAt ||= retainedTrade.publishedAt;
        publishedProduct.sourceUrl ||= retainedTrade.sourceUrl;
        publishedProduct.qualityStatus = retainedTrade.qualityStatus;
        publishedProduct.referenceOnly ||= retainedTrade.qualityStatus !== 'indexed';
        if (['not_due', 'not_listed', 'unavailable'].includes(publishedProduct.status)) publishedProduct.status = 'available';
      }
      const fieldBearingProducts = Object.values(products).filter((product) => (
        ['available', 'conflict'].includes(product.status)
      ));
      // A conflict excludes only the affected normalized field. An
      // unaffected bias or range can still corroborate health through this
      // product, while the product remains visibly marked CONFLICT.
      const biasSources = fieldBearingProducts.filter((product) => (
        product.fields.bias || product.fields.trade || product.fields.trend
      ));
      const riskRangeSources = fieldBearingProducts.filter((product) => product.fields.riskRange);
      const unavailableProducts = Object.values(products)
        .filter((product) => product.status === 'unavailable')
        .map((product) => product.id);
      const hasDirectionalBias = biasSources.length > 0;
      const hasRiskRange = riskRangeSources.length > 0;
      const centralUnavailable = security.state === 'unavailable';
      const health = {
        status: centralUnavailable ? 'unavailable' : hasDirectionalBias && hasRiskRange ? 'ready' : 'attention',
        hasDirectionalBias,
        hasRiskRange,
        biasProducts: biasSources.map((product) => product.id),
        riskRangeProducts: riskRangeSources.map((product) => product.id),
        missing: [
          ...(!hasDirectionalBias ? ['directional_bias'] : []),
          ...(!hasRiskRange ? ['risk_range'] : []),
        ],
        unavailableProducts,
      };
      return [symbol, {
        ...security,
        products,
        health,
      }];
    }),
  );

  return {
    ...base,
    schemaVersion: RESPONSE_SCHEMA_VERSION,
    scope,
    requestedSymbols,
    bySymbol,
    page: scope === 'universe'
      ? {
        limit: pageSize,
        cursor: String(offset),
        nextCursor: offset + requestedSymbols.length < sourceSymbols.length
          ? String(offset + requestedSymbols.length)
          : null,
        total: sourceSymbols.length,
      }
      : null,
  };
}

module.exports = {
  RESPONSE_SCHEMA_VERSION,
  buildSecurityIntelligenceV2,
  collectUniverseSymbols,
};
