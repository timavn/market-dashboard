const { normalizeCpiMonthId } = require('../predictionMarketsIngest/cpiRelease');

// Reviewed against the complete official CPIY terms on September 19, 2026.
const CPIY_RULES_URL = 'https://data.forecastex.com/regulatory/CPIYTermsandConditions.pdf';
const MAX_AGE_MS = 60_000;
const BAD_SOURCE = /cache|mock|seed|fixture|synthetic|inferred|derived|portfolio|delayed|frozen|offline|disconnected|stale|fallback/i;
const number = value => value !== null && value !== '' && typeof value !== 'boolean' && Number.isFinite(Number(value)) ? Number(value) : null;
const array = value => Array.isArray(value) ? value : [];
const stamp = value => /(?:Z|[+-]\d{2}:?\d{2})$/.test(String(value || '')) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const fresh = (value, now) => stamp(value) && now - Date.parse(value) >= -5000 && now - Date.parse(value) <= MAX_AGE_MS;
const invalid = value => !value || ['fromCache', 'from_cache', 'cachedOnly', 'cacheOnly', 'stale', 'isStale', 'seeded', 'mock', 'isMock', 'synthetic', 'refreshFailed', 'offline', 'disconnected'].some(key => value[key] === true)
  || value.connected === false || Boolean(value.error)
  || /failed|error|unavailable/.test(String(value.status || ''))
  || BAD_SOURCE.test([value.source, value.status, value.freshness, value.provenance, value.catalog_source, value.providerStatus, ...array(value.data_quality_flags)].filter(Boolean).join(' '))
  || array(value.data_quality_flags).some(flag => /non_live|no_live|unknown_contract|expired_contract|catalog_missing|incomplete|failed/.test(String(flag)))
  || [value.metadata, value.provenance, value.freshness].some(nested => nested && typeof nested === 'object' && invalid(nested));
const empty = (reason, extra = {}) => ({ status: 'unavailable', source: null, asOf: null, expiresAt: null, reason, ...extra });

function cpiIdentity(catalog, release, now) {
  const month = normalizeCpiMonthId(release?.reportMonth || release?.cpi?.reportMonthId);
  const releaseAt = stamp(release?.releaseAt || release?.cpi?.releaseAt);
  const releaseKey = release?.releaseKey || release?.cpi?.releaseKey;
  if (!month || releaseKey !== `KXCPIYOY#${month}` || !releaseAt || Date.parse(releaseAt) <= now
    || invalid(catalog) || !fresh(catalog.fetchedAt, now)) return null;
  const generationId = `CPIY_${month.slice(5, 7)}${month.slice(2, 4)}`;
  const candidates = array(catalog.lines).filter(line => String(line?.contractId || '').startsWith(`${generationId}_`));
  if (!candidates.length) return null;
  const lines = candidates.map(line => {
    const match = String(line.contractId).match(/^CPIY_(\d{2})(\d{2})_(-?\d+(?:\.\d+)?)$/);
    const question = String(line.question || '').match(/^Will the year-over-year change in the US Consumer Price Index exceed (-?\d+(?:\.\d+)?)% in ([A-Za-z]+ 20\d{2})\?$/i);
    const threshold = number(line.strike);
    if (invalid(line) || !match || !question || line.productId !== 'CPIY'
      || (line.rulesUrl || line.exchangeSpecUrl) !== CPIY_RULES_URL
      || threshold === null || threshold !== Number(match[3]) || threshold !== Number(question[1])
      || normalizeCpiMonthId(question[2]) !== month
      || stamp(line.lastTradeDate) !== releaseAt || stamp(line.expirationDate) !== releaseAt
      || !stamp(line.payoutDate) || Date.parse(line.payoutDate) < Date.parse(releaseAt)) return null;
    return { ...line, threshold };
  });
  if (lines.some(line => !line) || new Set(lines.map(line => line.threshold)).size !== lines.length) return null;
  return { month, releaseAt, releaseKey, generationId, lines: lines.sort((a, b) => a.threshold - b.threshold) };
}

function nativeCpiLines(identity, evidence, now) {
  if (!identity || evidence?.health?.ok !== true || evidence?.provider?.status !== 'connected'
    || invalid(evidence) || invalid(evidence.provider)
    || evidence.release?.releaseKey !== identity.releaseKey) return [];
  const acceptedIds = new Set(identity.lines.map(line => line.contractId));
  const lines = new Map();
  for (const row of array(evidence.events)) {
    if (!row) continue;
    const id = row.publicContractId || row.contractId;
    const side = row.quote_side;
    const sourceId = String(row.conId || '');
    const venue = String(row.venue || '').toLowerCase();
    if (!acceptedIds.has(id) || invalid(row) || row.source_api !== 'IBKR_TWS_API'
      || !['forecastex', 'ibkr'].includes(venue) || row.exchange !== 'FORECASTX'
      || row.releaseKey !== identity.releaseKey || row.status !== 'open' || !['YES', 'NO'].includes(side)
      || !['1', 'live'].includes(String(row.dataType)) || !fresh(row.exchange_timestamp, now)
      || row.tradable_in_ibkr !== true || !(number(sourceId) > 0)
      || number(row.max_payout_per_contract) !== 1) continue;
    const bid = number(row.native_bid), ask = number(row.native_ask);
    const bidSize = number(row.native_bid_size), askSize = number(row.native_ask_size);
    const bidSafe = bid !== null && bid >= 0 && bid <= 1 && bidSize > 0;
    const askSafe = ask !== null && ask >= 0 && ask <= 1 && askSize > 0;
    if ((!bidSafe && !askSafe) || (bidSafe && askSafe && ask <= bid)) continue;
    const prefix = side.toLowerCase();
    const line = lines.get(id) || { ticker: id, contractId: id, directNative: true,
      source: 'ibkr_tws_forecastex_live', status: 'available', comparator: '>',
      threshold: identity.lines.find(item => item.contractId === id).threshold,
      yesBid: null, yesAsk: null, noBid: null, noAsk: null };
    // Two contracts with the same side must not silently overwrite provenance.
    if (line[`${prefix}ConId`]) continue;
    line[`${prefix}ConId`] = sourceId;
    line[`${prefix}Bid`] = bidSafe ? bid : null;
    line[`${prefix}Ask`] = askSafe ? ask : null;
    line[`${prefix}BidSize`] = bidSafe ? bidSize : null;
    line[`${prefix}AskSize`] = askSafe ? askSize : null;
    line.updatedAt = line.updatedAt && Date.parse(line.updatedAt) < Date.parse(row.exchange_timestamp)
      ? line.updatedAt : stamp(row.exchange_timestamp);
    line.evidence = { quotes: { source: line.source, asOf: line.updatedAt, fit: 'exact', executable: false } };
    lines.set(id, line);
  }
  return [...lines.values()].sort((a, b) => a.threshold - b.threshold);
}

function createCpiForecastExReviewService({ publicSources, loadCurrentCpiRelease, loadNativeSnapshot, loadComparison, now = () => new Date() }) {
  async function getSnapshot() {
    const results = await Promise.allSettled([
      loadCurrentCpiRelease(), publicSources.getForecastExContracts('CPIY', { forceRefresh: true }),
    ]);
    const release = results[0].status === 'fulfilled' ? results[0].value : null;
    const publicCatalog = results[1].status === 'fulfilled' ? results[1].value : null;
    const identity = cpiIdentity(publicCatalog, release, now().getTime());
    const [nativeResult, comparisonResult] = await Promise.allSettled([
      identity ? loadNativeSnapshot({ forceRefresh: true, getCurrentCpiRelease: async () => release }) : Promise.resolve(null),
      release ? loadComparison(release) : Promise.resolve(null),
    ]);
    const generatedAt = now().toISOString(), nowMs = Date.parse(generatedAt);
    const native = nativeResult.status === 'fulfilled' ? nativeResult.value : null;
    let forecastComparison = comparisonResult.status === 'fulfilled' ? comparisonResult.value : null;
    // Recheck catalog and expiry after the independent broker call completes.
    const valid = identity && cpiIdentity(publicCatalog, release, nowMs);
    if (valid && forecastComparison?.reportMonth === identity.month && forecastComparison?.releaseKey === identity.releaseKey
      && stamp(forecastComparison.releaseAt) === identity.releaseAt) {
      forecastComparison = { ...forecastComparison, sourceEventTicker: forecastComparison.eventTicker || null, eventTicker: identity.generationId };
    }
    const lines = valid ? nativeCpiLines(identity, native, nowMs) : [];
    const event = valid ? { ticker: identity.generationId, generationId: identity.generationId,
      seriesTicker: 'CPIY', venueId: 'forecastex', productCode: 'CPIY',
      title: `US Consumer Price Index Yearly ${release.forecastMonth || identity.month}`,
      reportMonth: identity.month, releaseKey: identity.releaseKey, releaseAt: identity.releaseAt,
      closeTime: identity.releaseAt, expirationTime: identity.releaseAt, status: 'open',
      comparator: '>', metric: 'Headline CPI YoY', unit: 'percent_yoy', payoutAmount: 1,
      rulesUrl: CPIY_RULES_URL, brokerRoutable: false, availableOnBrokers: false } : null;
    const asOf = lines.length ? lines.reduce((oldest, line) => Date.parse(line.updatedAt) < Date.parse(oldest) ? line.updatedAt : oldest, lines[0].updatedAt) : null;
    const book = lines.length ? { status: 'available', source: 'ibkr_tws_forecastex_live', event, lines, asOf,
      expiresAt: new Date(Math.min(Date.parse(identity.releaseAt), Date.parse(asOf) + MAX_AGE_MS)).toISOString() }
      : empty('No verified live ForecastEx CPI quotes are available.', { event, lines: [] });
    const catalog = valid ? { status: 'available', source: 'forecastex_official_contracts',
      asOf: publicCatalog.fetchedAt, expiresAt: identity.releaseAt, event,
      // Every actual threshold remains present, including unquoted adjacent levels.
      lines: identity.lines.map(line => ({ ticker: line.contractId, contractId: line.contractId, threshold: line.threshold,
        comparator: '>', status: 'catalog', source: 'forecastex_official_schedule', directNative: false,
        yesBid: null, yesAsk: null, noBid: null, noAsk: null })),
    } : empty('The exact ForecastEx CPI release identity is unavailable.', { event: null, lines: [] });
    const venue = { id: 'forecastex', label: 'ForecastEx', status: lines.length ? 'available' : valid ? 'partial' : 'unavailable',
      catalog, book, contracts: book, generationId: event?.generationId || null, generations: [],
      brokerRoutable: false, bookQuality: { eligible: false, directLineCount: lines.length, executableLineCount: 0 },
      settlementBasis: valid ? { status: 'verified', instrument: 'All Items CPI-U YoY',
        method: 'BLS initial release', observationAt: identity.releaseAt, sourceName: 'BLS',
        sourceUrl: 'https://www.bls.gov/cpi/', rulesUrl: CPIY_RULES_URL } : { status: 'unavailable' } };
    const displayContracts = { ...(lines.length ? book : catalog), bookExpiresAt: book.expiresAt,
      lines: catalog.lines.map(line => ({ ...line, ...(lines.find(quote => quote.contractId === line.contractId) || {}) })) };
    const displaySelection = { status: displayContracts.status, venueId: 'forecastex', generationId: event?.generationId || null,
      contracts: displayContracts, mode: 'display', strategyEligible: false, label: 'ForecastEx · CPI' };
    const execution = empty('CPI review provides descriptive comparisons only.', { event: null, lines: [] });
    const notApplicable = empty('Not applicable to a scheduled CPI release.', { availability: 'not_applicable', executable: false, value: null, points: [] });
    return { schemaVersion: 2, marketId: 'cpi', displayName: 'Headline CPI YoY', symbol: 'CPI', precision: 1, unit: 'percent', generatedAt,
      status: lines.length ? 'available' : forecastComparison ? 'partial' : 'unavailable', forecastComparison,
      venues: { forecastex: venue }, contracts: book, displayContracts, displaySelection,
      selectedVenueId: 'forecastex', selectedGenerationId: event?.generationId || null, selectedGeneration: event,
      selection: { requestedVenue: 'forecastex', venueId: 'forecastex', requestedGenerationId: null, generationId: event?.generationId || null },
      generationOptions: [], sourceHealth: [
        { id: 'forecastex_catalog', label: 'ForecastEx CPI', status: catalog.status, asOf: catalog.asOf },
        { id: 'forecastex_book', label: 'IBKR CPI native quotes', status: book.status, asOf: book.asOf },
      ], factors: {}, factorRows: [], resolverMetadata: {},
      spot: notApplicable, chart: notApplicable, riskRange: { ...notApplicable, lrr: null, hrr: null, trend: null },
      executionContracts: execution, autoSelection: { status: 'unavailable', venueId: null, contracts: execution },
      strategy: { status: 'unavailable', model: null, eligibleVenueId: null, reason: execution.reason } };
  }
  return { getSnapshot };
}

module.exports = { createCpiForecastExReviewService, cpiIdentity, nativeCpiLines, CPIY_RULES_URL };
