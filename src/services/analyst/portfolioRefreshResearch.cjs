const { createHash } = require('node:crypto');
const {
  canonicalizeSymbol, extractSnapshotReferences, isValidMarketDate, normalizeRequestedSymbols,
  normalizeResearchBias, prepareNarrativeReferenceMatchers, prepareStructuredReferenceMatchers,
} = require('../../utils/securityIntelligence.cjs');
const { RESEARCH_PRODUCTS, getResearchProduct } = require('../../utils/researchProductRegistry.cjs');
const { publicationIssues } = require('../../utils/researchSourceQuality.cjs');

const SNAPSHOT_TABLE = 'HedgeyeDailySnapshot';
const MAX_SCAN_PAGES = 1000;
const SCAN_DEADLINE_MS = 25000;
const BAD_FLAGS = ['mock', 'isMock', 'seed', 'seeded', 'isSeed', 'isSeeded', 'fixture', 'synthetic', 'inferred', 'modelOnly', 'portfolioDerived', 'costBasisDerived', 'fallback',
  'cacheOnly', 'cache_only', 'cachedOnly', 'fromCache', 'from_cache', 'stale', 'isStale', 'offline', 'disconnected', 'refreshFailed'];
const BAD_STATES = /(?:^|[\s_-])(?:failed|error|unavailable|unverified|rejected|quarantined|mock|seed(?:ed)?|synthetic|inferred|cache|cached|offline|disconnected|stale)(?:$|[\s_-])/i;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const unique = values => [...new Set(values)];
const bad = value => Boolean(value && typeof value === 'object' && (value.verified === false || value.sourceVerified === false || value.connected === false
  || BAD_FLAGS.some(flag => value[flag] === true)
  || ['status', 'sourceStatus', 'qualityStatus', 'freshness', 'cacheState', 'cacheStatus', 'source', 'provider', 'lifecycleStage'].some(field => BAD_STATES.test(String(value[field] || '')))
  || ['metadata', 'meta', 'provenance', 'quality', 'sourceQuality', 'flags', 'providerStatus'].some(field => bad(value[field]))));
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const publicationDayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
const nyDay = value => publicationDayFormatter.format(new Date(value));
const tickerOf = value => normalizeRequestedSymbols([typeof value === 'string' ? value : value?.ticker || value?.symbol])[0];
const matches = (left, right) => canonicalizeSymbol(left) === canonicalizeSymbol(right);

function validatePortfolioRefreshRequest({ symbols, marketDate, asOf } = {}) {
  if (!Array.isArray(symbols) || symbols.some(symbol => typeof symbol !== 'string' || !tickerOf(symbol))) {
    throw Object.assign(new Error('A complete array of valid holding symbols is required.'), { statusCode: 400 });
  }
  if (!isValidMarketDate(marketDate) || instant(asOf) === null || marketDate > nyDay(asOf)) {
    throw Object.assign(new Error('A valid market date and timezone-aware capture time are required.'), { statusCode: 400 });
  }
  // Normalize one at a time: the general-purpose API's 200-symbol cap must not
  // silently truncate a complete broker book.
  return { symbols: unique(symbols.map(tickerOf)).sort(), marketDate, asOf };
}

function safeData(value, diagnostics, snapshot, path = 'data') {
  if (bad(value)) {
    diagnostics.push({ code: 'unverified-source-field', productId: productFor(snapshot), marketDate: snapshot.date,
      sourceSnapshotId: identity(snapshot), fieldPath: path, observed: value });
    return undefined;
  }
  if (Array.isArray(value)) return value.map((item, index) => safeData(item, diagnostics, snapshot, `${path}.${index}`)).filter(item => item !== undefined);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, safeData(item, diagnostics, snapshot, `${path}.${key}`)]).filter(([, item]) => item !== undefined));
  return value;
}

function identity(snapshot) {
  return `${snapshot.date}:${snapshot.snapshotType}`;
}

function productFor(snapshot) {
  // Crypto Quant and Bitcoin Tracker historically share a storage key. The
  // source's explicit report type is required to distinguish these products.
  const explicit = getResearchProduct(snapshot.reportType);
  const raw = String(snapshot.snapshotType || snapshot.reportType || '').trim().toLowerCase();
  return explicit?.id || getResearchProduct(raw)?.id || raw;
}

function eligible(snapshot, marketDate, asOf) {
  if (!isValidMarketDate(snapshot?.date)) return 'invalid-publication-date';
  if (snapshot.date > marketDate || snapshot.date > nyDay(asOf)) return 'future-publication';
  if (bad(snapshot) || bad(snapshot.data) || bad(snapshot.meta) || bad(snapshot.article)
    || snapshot.error || snapshot.refreshIssue) return 'unverified-source';
  for (const value of [snapshot.article?.publishedAt, ...['publishedAt', 'receivedAt', 'scrapedAt', 'retrievedAt', 'createdAt'].map(field => snapshot[field])]) {
    if (value && instant(value) !== null && instant(value) > instant(asOf)) return 'future-source-observation';
  }
  if (!snapshot.article?.feedUrl && !snapshot.sourceUrl && !snapshot.sourceMessageId && !snapshot.gmailMessageId
    && !snapshot.htmlSource && !snapshot.pdfSource && !snapshot.pdfS3Key && !snapshot.sourceArtifact) return 'source-provenance-missing';
  if (!productFor(snapshot)) return 'source-product-missing';
  return null;
}

function publicationClock(snapshot) {
  const value = snapshot.article?.publishedAt || snapshot.publishedAt;
  // Midnight import placeholders retain only their original publication date.
  return instant(value) !== null && !/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.0+)?(?:Z|\+00:00)$/.test(value)
    ? value : null;
}

function sourceEvidence(snapshot, contentHash, action = null) {
  const messageId = action?.sourceMessageId || snapshot.sourceMessageId || snapshot.gmailMessageId || null;
  const samePublication = !action?.sourceMessageId || action.sourceMessageId === (snapshot.sourceMessageId || snapshot.gmailMessageId);
  return {
    title: action?.headline || (samePublication ? snapshot.article?.headline || snapshot.subject || snapshot.data?.headline || snapshot.title : null) || null,
    bodyText: action?.bodyText || (samePublication ? snapshot.article?.bodyText : null) || null,
    sourceMessageId: messageId,
    publicationDate: snapshot.date, publishedAt: action
      ? publicationClock(action) || (samePublication ? publicationClock(snapshot) : null) : publicationClock(snapshot),
    sourceUrl: action?.sourceUrl || (messageId ? `gmail://message/${messageId}` : snapshot.article?.feedUrl || snapshot.sourceUrl) || null,
    eventTime: action?.eventTime || null,
    contentHash, sourceContentSha256: action?.contentSha256 || (samePublication ? snapshot.contentSha256 : null) || null,
  };
}

function completeRoster(snapshot) {
  const data = object(snapshot.data);
  let rows;
  if (snapshot.snapshotType === 'etf-pro' && (data.checkpointAvailable === true || snapshot.sourceKind === 'full-book-checkpoint')) {
    rows = data.rows;
  } else if (snapshot.snapshotType === 'investing-ideas' && data.checkpointAvailable !== false
    && Array.isArray(data.positions) && Number.isInteger(snapshot.positionCount) && snapshot.positionCount === data.positions.length) {
    rows = data.positions;
  }
  if (!Array.isArray(rows) || !rows.length || rows.some(bad)) return null;
  const positions = rows.map(row => ({ ticker: tickerOf(row), side: String(row.side || row.call || row.position || '').toUpperCase() }));
  if (positions.some(row => !row.ticker || !['LONG', 'SHORT'].includes(row.side))) return null;
  if (new Set(positions.map(row => row.ticker)).size !== positions.length) return null;
  return positions;
}

function independentTrendReferences(snapshot, symbols, diagnostics, preparedStructuredMatchers) {
  if (!['risk-ranges', 'early-look'].includes(snapshot.snapshotType)) return [];
  const result = [];
  for (const [key, row] of Object.entries(object(snapshot.data))) {
    if (!row || typeof row !== 'object') continue;
    const ticker = tickerOf(row) || tickerOf(row.originalName?.match(/\(([A-Z0-9.^_-]+)\)$/)?.[1]) || tickerOf(key);
    const trendWithheld = (row.withheldFields || []).includes('trend') || publicationIssues(snapshot).some(issue =>
      matches(issue.ticker, ticker) && [issue.field, ...(issue.affectedFields || [])].includes('trend'));
    const trend = trendWithheld ? null : normalizeResearchBias(row.trend);
    const low = row.lrr ?? row.low ?? row.riskRangeLow;
    const high = row.hrr ?? row.high ?? row.riskRangeHigh;
    if (validRange(low, high) || !ticker || (!trend && low == null && high == null)) continue;
    if (low != null || high != null) diagnostics.push({ productId: snapshot.snapshotType, marketDate: snapshot.date, ticker,
      code: 'invalid-range-fields', observed: { lrr: low ?? null, hrr: high ?? null }, sourceUrl: snapshot.article?.feedUrl || snapshot.sourceUrl || null });
    if (!trend || bad(row)) continue;
    const matchedSymbols = preparedStructuredMatchers
      ? preparedStructuredMatchers.matchStructuredTicker(ticker)
      : symbols.filter(value => matches(value, ticker));
    for (const symbol of matchedSymbols) {
      const value = { trend };
      result.push({ symbol, reference: {
        productId: snapshot.snapshotType, productLabel: getResearchProduct(snapshot.snapshotType)?.label,
        marketDate: snapshot.date, kind: 'trend_signal', direction: trend, value,
        matchType: symbol === ticker ? 'direct' : 'direct_alias', matchedText: ticker, sourceTicker: ticker,
        sourceUrl: snapshot.article?.feedUrl || snapshot.sourceUrl || null, qualityStatus: 'indexed',
        excerpt: `${ticker}: Trend ${trend}`, sourceText: JSON.stringify(row), fieldPath: `data.${key}.trend`,
        signalProvenance: { field: 'trend', method: 'explicit-field', sourceField: `data.${key}.trend`, sourceText: JSON.stringify(row) },
      } });
    }
  }
  return result;
}

function validRange(low, high) {
  const number = value => typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() ? Number(value.replace(/,/g, '')) : NaN;
  return Number.isFinite(number(low)) && Number.isFinite(number(high)) && number(low) < number(high);
}

function extractArchiveReferences(original, symbols, diagnostics, asOf, referenceOptions, contentHash) {
  const snapshot = { ...original, snapshotType: productFor(original), data: safeData(original.data, diagnostics, original) || {} };
  // Range validation is field-level. Preserve an explicitly published Trend
  // when the publisher's bounds are invalid, withholding only those bounds.
  const ranges = independentTrendReferences(snapshot, symbols, diagnostics, referenceOptions.preparedStructuredMatchers);
  if (['risk-ranges', 'early-look'].includes(snapshot.snapshotType)) {
    snapshot.data = Object.fromEntries(Object.entries(object(snapshot.data)).map(([key, row]) => {
      const low = row?.lrr ?? row?.low ?? row?.riskRangeLow;
      const high = row?.hrr ?? row?.high ?? row?.riskRangeHigh;
      if (!row || typeof row !== 'object' || validRange(low, high)) return [key, row];
      const independentFields = { ...row };
      for (const field of ['lrr', 'low', 'riskRangeLow', 'hrr', 'high', 'riskRangeHigh']) delete independentFields[field];
      return [key, independentFields];
    }));
  }
  const actionRows = snapshot.snapshotType === 'etf-pro' ? snapshot.data.changes || []
    : ['real-time-alert', 'investing-ideas'].includes(snapshot.snapshotType)
      ? snapshot.data.alerts || (snapshot.data.alert ? [snapshot.data.alert] : []) : [];
  if (!Array.isArray(actionRows) || actionRows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    diagnostics.push({ code: 'source-action-rows-invalid', productId: snapshot.snapshotType, marketDate: snapshot.date,
      sourceSnapshotId: identity(original), observed: actionRows });
  }
  const actions = Array.isArray(actionRows) ? actionRows.filter(row => row && typeof row === 'object' && !Array.isArray(row)) : [];
  const baseSnapshot = actions.length ? { ...snapshot, data: { ...snapshot.data,
    changes: [], added: [], removed: [], alerts: [], alert: null } } : snapshot;
  const references = extractSnapshotReferences(baseSnapshot, symbols, 'indexed', {
    ...referenceOptions, includeUnverifiedRiskRanges: true,
  })
    .filter(entry => !['historical_risk_range', 'supplemental_risk_range'].includes(entry.reference.kind)
      || validRange(entry.reference.value?.lrr, entry.reference.value?.hrr));
  if (snapshot.snapshotType === 'crypto-quant') {
    // The publisher uses the shared Bitcoin Tracker chart schema for Crypto
    // Quant. Reuse that exact structured extractor while retaining this
    // publication's separate product identity.
    references.push(...extractSnapshotReferences({ ...snapshot, snapshotType: 'bitcoin-trend-tracker' }, symbols, 'indexed', {
      ...referenceOptions, skipNarrativeMentions: true,
    })
      .filter(entry => entry.reference.kind === 'trend_signal')
      .map(entry => ({ ...entry, reference: { ...entry.reference, productId: 'crypto-quant',
        productLabel: getResearchProduct('crypto-quant').label } })));
  }
  for (const action of actions) {
    if ([action?.eventTime, action?.publishedAt].some(value => instant(value) !== null && instant(value) > instant(asOf))) {
      diagnostics.push({ code: 'future-source-action', productId: snapshot.snapshotType, marketDate: snapshot.date, ticker: tickerOf(action) });
      continue;
    }
    const sourceType = snapshot.snapshotType === 'etf-pro' ? 'etf-pro' : 'real-time-alert';
    const kind = sourceType === 'etf-pro' ? 'etf_pro_change' : 'real_time_alert';
    references.push(...extractSnapshotReferences({ ...snapshot, snapshotType: sourceType,
      data: sourceType === 'etf-pro' ? { changes: [action] } : { alerts: [action] } }, symbols, 'indexed', {
      ...referenceOptions, skipNarrativeMentions: true,
    })
      .filter(entry => entry.reference.kind === kind)
      .map(entry => ({ ...entry, actionRow: action, reference: { ...entry.reference, productId: snapshot.snapshotType,
        productLabel: getResearchProduct(snapshot.snapshotType)?.label || snapshot.snapshotType,
        kind: snapshot.snapshotType === 'investing-ideas' ? 'position_change' : kind } })));
  }
  return [...references, ...ranges].filter(entry => ['direct', 'direct_alias'].includes(entry.reference.matchType))
    .map(({ symbol, reference, actionRow }) => {
      const sourceTicker = reference.sourceTicker || reference.matchedText || symbol;
      const enriched = { ...reference, sourceTicker, publishedAt: publicationClock(original),
        sourceEventId: reference.sourceEventId || identity(original), sourceSnapshotId: identity(original), sourceContentHash: contentHash,
        referenceOnly: true, executable: false, currentDecisionEligible: false, decisionEligible: false };
      if (['etf_pro_change', 'real_time_alert', 'position_change'].includes(reference.kind)) {
        if (actionRow) enriched.value = { ...actionRow };
        else diagnostics.push({ code: 'source-action-details-missing', productId: enriched.productId, marketDate: original.date, ticker: symbol });
        enriched.sourceEvidence = sourceEvidence(original, contentHash, actionRow);
        enriched.sourceUrl = enriched.sourceEvidence.sourceUrl || reference.sourceUrl;
        enriched.publishedAt = enriched.sourceEvidence.publishedAt;
        enriched.eventTime = actionRow?.eventTime || null;
        enriched.sourceMessageId = enriched.sourceEvidence.sourceMessageId;
      }
      enriched.id = hash([symbol, enriched.productId, enriched.marketDate, enriched.publishedAt, enriched.kind,
        enriched.value, enriched.excerpt, enriched.sourceUrl, enriched.eventTime]).slice(0, 24);
      return { symbol, reference: enriched };
    }).filter(Boolean);
}

function rosterPublications(snapshot, productId, contentHash, asOf, diagnostics) {
  const data = object(snapshot.data);
  const checkpoints = productId === 'etf-pro' && Array.isArray(data.checkpointEvents) && data.checkpointEvents.length
    ? data.checkpointEvents : [null];
  return checkpoints.flatMap(checkpoint => {
    if (checkpoint && (bad(checkpoint) || (instant(checkpoint.eventTime) !== null && instant(checkpoint.eventTime) > instant(asOf)))) return [];
    // Merged ETF rows replay position actions. Only the original complete
    // checkpoint is a published roster; derived membership is not a new book.
    if (!checkpoint && productId === 'etf-pro' && (data.changes?.length || data.rows?.some(row => row.action))) return [];
    const positions = completeRoster(checkpoint ? { ...snapshot, snapshotType: productId,
      data: { checkpointAvailable: true, rows: checkpoint.rows } } : { ...snapshot, snapshotType: productId });
    if (!positions) {
      if (checkpoint) diagnostics.push({ code: 'invalid-source-roster', productId, marketDate: snapshot.date, sourceSnapshotId: identity(snapshot) });
      return [];
    }
    const evidence = sourceEvidence(snapshot, contentHash, checkpoint);
    return [{ productId, productLabel: getResearchProduct(productId)?.label || productId, marketDate: snapshot.date,
      publishedAt: evidence.publishedAt, eventTime: checkpoint?.eventTime || null,
      sourceMessageId: evidence.sourceMessageId, sourceUrl: evidence.sourceUrl,
      sourceSnapshotId: identity(snapshot), contentHash, completeRoster: true, positions }];
  });
}

async function scanPage(dynamodb, params, remaining) {
  const request = dynamodb.scan(params);
  let timer;
  try {
    return await Promise.race([request.promise(), new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { request.abort?.(); } catch { /* The deadline also closes providers without abort support. */ }
        reject(Object.assign(new Error('Archive scan deadline reached.'), { code: 'ARCHIVE_SCAN_DEADLINE' }));
      }, remaining);
    })]);
  } finally { clearTimeout(timer); }
}

async function capturePortfolioRefreshResearch({ dynamodb, symbols, marketDate, asOf,
  tableName = SNAPSHOT_TABLE, maxPages = MAX_SCAN_PAGES, deadlineMs = SCAN_DEADLINE_MS, now = Date.now } = {}) {
  const request = validatePortfolioRefreshRequest({ symbols, marketDate, asOf });
  // Archive captures retain only direct/alias references. Prepare their exact
  // narrative patterns once and avoid constructing discarded exposure rows.
  const referenceOptions = { skipExposureMentions: true,
    preparedNarrativeMatchers: prepareNarrativeReferenceMatchers(request.symbols),
    preparedStructuredMatchers: prepareStructuredReferenceMatchers(request.symbols) };
  const started = now();
  const reasons = [];
  const diagnostics = [];
  const rows = new Map();
  const ambiguous = new Set();
  const cursors = new Set();
  let lastKey;
  let pages = 0;
  let scanComplete = false;
  let evaluatedRows = 0;
  while (pages < maxPages) {
    const remaining = deadlineMs - (now() - started);
    if (remaining <= 0) { reasons.push('archive-scan-deadline'); break; }
    let page;
    try {
      page = await scanPage(dynamodb, { TableName: tableName, ConsistentRead: true, Limit: 1000,
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}) }, remaining);
    } catch (error) {
      reasons.push(error.code === 'ARCHIVE_SCAN_DEADLINE' ? 'archive-scan-deadline' : 'archive-page-unavailable');
      break;
    }
    pages += 1;
    if (!page || !Array.isArray(page.Items)) { reasons.push('archive-page-invalid'); break; }
    evaluatedRows += page.ScannedCount ?? page.Items.length;
    for (const snapshot of page.Items) {
      if (!snapshot || typeof snapshot !== 'object') { diagnostics.push({ code: 'invalid-source-row' }); continue; }
      const id = identity(snapshot);
      if (rows.has(id) && hash(rows.get(id)) !== hash(snapshot)) ambiguous.add(id);
      else rows.set(id, snapshot);
    }
    if (!page.LastEvaluatedKey || !Object.keys(page.LastEvaluatedKey).length) { scanComplete = true; break; }
    const cursor = hash(page.LastEvaluatedKey);
    if (cursors.has(cursor)) { reasons.push('archive-pagination-loop'); break; }
    cursors.add(cursor);
    lastKey = page.LastEvaluatedKey;
  }
  if (!scanComplete && pages >= maxPages) reasons.push('archive-page-limit');
  const products = new Map([...RESEARCH_PRODUCTS, { id: 'inflation-nowcast', label: 'Inflation Nowcast' }]
    .map(product => [product.id, { id: product.id, label: product.label, documentCount: 0, dates: [], reasons: [] }]));
  const bySymbol = Object.fromEntries(request.symbols.map(symbol => [symbol, { references: [], checkedProducts: [] }]));
  const publications = [];
  const documentHashes = [];
  const dates = [];
  let nonPublicationRows = 0;
  for (const snapshot of [...rows.values()].sort((a, b) => identity(a).localeCompare(identity(b)))) {
    const productId = productFor(snapshot);
    const coverage = products.get(productId);
    if (!coverage) {
      // The snapshot table also stores health records, latest pointers and
      // content-addressed derived state. They are not registered publications
      // and must not manufacture a missing or failed research product.
      nonPublicationRows += 1;
      diagnostics.push({ code: isValidMarketDate(snapshot.date) ? 'unregistered-source-product' : 'non-publication-source-row',
        productId: productId || null, snapshotType: snapshot.snapshotType || null,
        storageDate: snapshot.date || null, sourceSnapshotId: identity(snapshot) });
      continue;
    }
    const rejection = ambiguous.has(identity(snapshot)) ? 'ambiguous-source-revision' : eligible(snapshot, marketDate, asOf);
    if (rejection) {
      diagnostics.push({ code: rejection, productId, marketDate: snapshot.date, sourceSnapshotId: identity(snapshot) });
      if (!rejection.startsWith('future-')) coverage.reasons.push(rejection);
      continue;
    }
    coverage.documentCount += 1;
    coverage.dates.push(snapshot.date);
    const contentHash = hash(snapshot);
    documentHashes.push([identity(snapshot), contentHash]);
    dates.push(snapshot.date);
    for (const issue of publicationIssues(snapshot)) diagnostics.push({ ...issue, productId, marketDate: snapshot.date, sourceSnapshotId: identity(snapshot) });
    const diagnosticStart = diagnostics.length;
    try {
      publications.push(...rosterPublications(snapshot, productId, contentHash, asOf, diagnostics));
      for (const { symbol, reference } of extractArchiveReferences(snapshot, request.symbols, diagnostics, asOf, referenceOptions, contentHash)) bySymbol[symbol].references.push(reference);
    } catch {
      diagnostics.push({ code: 'source-extraction-unavailable', productId, marketDate: snapshot.date, sourceSnapshotId: identity(snapshot) });
    }
    for (const issue of diagnostics.slice(diagnosticStart)) {
      if (['unverified-source-field', 'source-action-details-missing', 'source-action-rows-invalid', 'source-extraction-unavailable', 'invalid-source-roster'].includes(issue.code)) coverage.reasons.push(issue.code);
    }
  }
  const productRows = [...products.values()].sort((a, b) => a.id.localeCompare(b.id)).map(product => ({
    id: product.id, label: product.label, status: !scanComplete || product.reasons.length ? 'partial' : product.documentCount ? 'checked' : 'no_publications',
    documentCount: product.documentCount, earliestDate: product.dates.sort()[0] || null, latestDate: product.dates.at(-1) || null,
    reasons: unique([...product.reasons, ...(!scanComplete ? reasons : [])]),
  }));
  for (const value of Object.values(bySymbol)) {
    value.references = [...new Map(value.references.map(reference => [reference.id, reference])).values()]
      .sort((a, b) => `${a.marketDate}:${a.publishedAt || a.eventTime || ''}:${a.productId}:${a.id}`.localeCompare(`${b.marketDate}:${b.publishedAt || b.eventTime || ''}:${b.productId}:${b.id}`));
    value.checkedProducts = productRows.filter(product => ['checked', 'no_publications'].includes(product.status)).map(product => product.id);
  }
  dates.sort();
  return { schemaVersion: 1, asOf, marketDate, scanComplete, scope: 'available-source-archive',
    requestedSymbols: request.symbols, referenceOnly: true, executable: false,
    coverage: { products: productRows, reasons: unique(reasons) }, bySymbol, publications, diagnostics,
    manifest: { source: tableName, documentCount: documentHashes.length, earliestDate: dates[0] || null,
      latestDate: dates.at(-1) || null, pages, evaluatedRows, hash: hash(documentHashes),
      nonPublicationRows,
      publicationScope: 'Registered source publication snapshots; operational and unregistered rows remain diagnostics. Delivery and overwritten same-day publications are not proven complete.' } };
}

module.exports = { capturePortfolioRefreshResearch, validatePortfolioRefreshRequest, MAX_SCAN_PAGES, SCAN_DEADLINE_MS };
