const { validateRgdpGeneration } = require('../forecastExRgdpIdentity.cjs');
const { createGdpResearchService } = require('./gdpResearchService.cjs');

const GDP_QUARTER = '2026-Q3';
const GDP_GENERATION = 'RGDP_Q326';
const QUOTE_MAX_AGE_MS = 90_000;
const FORBIDDEN = /mock|seed|fixture|fallback|cache|portfolio|delayed|frozen|stale|offline|disconnected|historical|synthetic|inferred|derived/i;
const PRICE_FIELDS = ['yesBid', 'yesAsk', 'noBid', 'noAsk'];
const empty = (reason, extras = {}) => ({ status: 'unavailable', source: null, asOf: null, expiresAt: null, reason, ...extras });
const number = (value, min = -Infinity, max = Infinity) => ['number', 'string'].includes(typeof value) && value !== ''
  && Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max ? Number(value) : null;
const invalidProvenance = (value) => !value || [
  'fromCache', 'cachedOnly', 'cacheOnly', 'stale', 'isStale', 'seeded', 'mock', 'isMock',
  'synthetic', 'refreshFailed', 'referenceOnly', 'offline', 'disconnected',
].some((key) => value[key] === true)
  || (Array.isArray(value.derivedFields) && value.derivedFields.length > 0)
  || value.connected === false
  || /offline|error|disconnected|stale|unavailable/i.test(String(value.status || ''))
  || FORBIDDEN.test([value.source, value.provenance, value.dataType, value.providerStatus].filter(Boolean).join(' '));

function fresh(timestamp, nowMs) {
  const ms = Date.parse(timestamp || '');
  return Number.isFinite(ms) && ms <= nowMs + 5_000 && nowMs - ms <= QUOTE_MAX_AGE_MS;
}

function validEvent(event) {
  return event?.measuredQuarter === GDP_QUARTER && event?.settlementStage === 'third'
    && event?.productCode === 'RGDP' && event?.generationId === GDP_GENERATION
    && event?.rulesUrl === 'https://data.forecastex.com/regulatory/RGDPTermsandConditions.pdf';
}

// GDP research is an immutable dated reference. Only the native book expires.
// This also runs at every coordinator read, independently of provider refreshes.
function sanitizeGdpSnapshot(snapshot, nowMs = Date.now(), { failed = false } = {}) {
  if (!snapshot || snapshot.marketId !== 'gdp') return snapshot;
  const supplied = snapshot.contracts || {};
  const event = supplied.event || snapshot.venues?.forecastex?.catalog?.event || null;
  const expiresMs = Date.parse(supplied.expiresAt || '');
  const closeMs = Date.parse(event?.closeTime || '');
  const safe = !failed && !invalidProvenance(snapshot) && !invalidProvenance(supplied)
    && ['available', 'partial'].includes(supplied.status) && validEvent(event)
    && supplied.source === 'ibkr_tws_forecastex_live'
    && fresh(supplied.asOf, nowMs) && expiresMs >= nowMs && closeMs > nowMs;
  const lines = safe ? (supplied.lines || []).filter((line) => (
    !invalidProvenance(line) && line.directNative === true
    && line.source === 'ibkr_tws_forecastex_live' && fresh(line.updatedAt, nowMs)
    && line.comparator === '>' && number(line.threshold) !== null
    && String(line.contractId || line.ticker) === `${GDP_GENERATION}_${number(line.threshold)}`
    && PRICE_FIELDS.some((key) => number(line[key], 0, 1) !== null)
  )) : [];
  const contracts = lines.length ? { ...supplied, event, lines } : empty(
    failed ? 'GDP native quote refresh failed.' : 'No verified live GDP quotes are available.',
    { event, lines: [], refreshFailed: failed || supplied.refreshFailed === true },
  );
  const priorVenue = snapshot.venues?.forecastex || {};
  const venue = { ...priorVenue, book: contracts, contracts, brokerRoutable: false,
    status: lines.length ? 'available' : event ? 'partial' : 'unavailable',
    bookQuality: { eligible: false, directLineCount: lines.length, lineCount: lines.length, executableLineCount: 0 },
  };
  const executionContracts = empty('GDP is a display-only comparison.', { event: null, lines: [] });
  const displaySelection = { status: contracts.status, venueId: 'forecastex', generationId: event?.generationId || null,
    mode: 'display', strategyEligible: false, label: 'ForecastEx · GDP', contracts };
  return { ...snapshot,
    status: lines.length ? 'available' : snapshot.gdp ? 'partial' : 'unavailable',
    session: { state: lines.length ? 'open' : Number.isFinite(closeMs) && closeMs <= nowMs ? 'closed' : 'unknown', asOf: snapshot.generatedAt },
    contracts, displayContracts: contracts, displaySelection, venues: { forecastex: venue }, executionContracts,
    autoSelection: { status: 'unavailable', venueId: null, mode: 'none', contracts: executionContracts },
    strategy: { status: 'unavailable', model: null, eligibleVenueId: null, reason: 'GDP provides descriptive comparisons only.' },
  };
}

function normalizeBook(catalogLines, live, event, nowMs) {
  const envelopeSafe = live?.status === 'available' && !invalidProvenance(live) && fresh(live.fetchedAt, nowMs);
  const native = new Map((envelopeSafe ? live.lines || [] : []).map((line) => [line.contractId, line]));
  const lines = catalogLines.flatMap((line) => {
    const quote = native.get(line.contractId);
    if (!quote || invalidProvenance(quote) || quote.directNative !== true || quote.dataType !== 'live'
      || !fresh(quote.updatedAt, nowMs)) return [];
    const prices = Object.fromEntries(PRICE_FIELDS.map((key) => [key, number(quote[key], 0, 1)]));
    for (const side of ['yes', 'no']) {
      if (prices[`${side}Bid`] !== null && prices[`${side}Ask`] !== null
        && prices[`${side}Ask`] < prices[`${side}Bid`]) {
        prices[`${side}Bid`] = null;
        prices[`${side}Ask`] = null;
      }
    }
    if (!Object.values(prices).some((value) => value !== null)) return [];
    return [{
      ticker: line.contractId, contractId: line.contractId, threshold: number(line.strike),
      comparator: '>', strikeType: 'greater', status: 'available', ...prices,
      ...Object.fromEntries(PRICE_FIELDS.map((key) => [`${key}Size`, prices[key] !== null ? number(quote[`${key}Size`], 0) : null])),
      volume: number(line.volume, 0), volume24h: number(line.volume24h, 0), openInterest: number(line.openInterest, 0),
      updatedAt: quote.updatedAt, closeAt: event.closeTime,
      directNative: true, source: 'ibkr_tws_forecastex_live', depthCapability: 'top_of_book',
    }];
  }).sort((a, b) => a.threshold - b.threshold);
  return {
    status: lines.length ? 'available' : 'unavailable',
    source: lines.length ? 'ibkr_tws_forecastex_live' : null,
    asOf: lines.length ? live.fetchedAt : null,
    expiresAt: lines.length ? new Date(Math.min(Date.parse(event.closeTime),
      ...lines.map((line) => Date.parse(line.updatedAt) + QUOTE_MAX_AGE_MS))).toISOString() : null,
    event, lines, refreshFailed: live?.refreshFailed === true,
    reason: lines.length ? null : live?.reason || 'No verified live GDP quotes are available.',
  };
}

function createGdpMonitorService({ publicSources, loadForecastExLive, researchService, now = () => new Date() } = {}) {
  const research = researchService || createGdpResearchService({ now });
  let lastResearch = null;
  async function getSnapshot() {
    const results = await Promise.allSettled([
      research.getSnapshot(), publicSources.getForecastExContracts('RGDP'),
    ]);
    if (results[0].status === 'fulfilled') lastResearch = results[0].value;
    const gdp = lastResearch;
    const errors = results.flatMap((result, i) => result.status === 'rejected'
      ? [{ source: i ? 'forecastex_catalog' : 'gdp_research', message: String(result.reason?.message || result.reason) }] : []);
    let event = null;
    let publicLines = [];
    let catalogAsOf = null;
    let live = null;
    if (results[1].status === 'fulfilled') {
      try {
        const catalog = results[1].value;
        if (invalidProvenance(catalog) || !fresh(catalog.fetchedAt, now().getTime())) throw new Error('GDP contract catalog is not verified current data.');
        publicLines = (catalog.lines || []).filter((line) => /^RGDP_Q326_/.test(line.contractId || ''));
        const deciding = gdp?.schedule?.find((release) => release.stage === 'third')?.releaseAt;
        const identity = validateRgdpGeneration(publicLines, { measuredQuarter: GDP_QUARTER, ...(deciding ? { decidingReleaseAt: deciding } : {}) });
        const closeTime = identity.lastTradeAt || identity.resolutionAt;
        event = {
          ticker: GDP_GENERATION, generationId: GDP_GENERATION, venueId: 'forecastex',
          productCode: 'RGDP', seriesTicker: 'RGDP', title: 'US Real GDP Q3 2026', cadence: 'quarterly',
          measuredQuarter: GDP_QUARTER, settlementStage: 'third', metric: 'real_gdp', unit: 'percent_qoq_saar',
          comparator: '>', closeTime, resolutionAt: identity.resolutionAt,
          expirationTime: identity.resolutionAt, payoutAt: identity.payoutAt, timezone: 'America/Chicago',
          rulesUrl: identity.rulesUrl, status: Date.parse(closeTime) > now().getTime() ? 'open' : 'closed',
          brokerRoutable: false, canCloseEarly: false,
        };
        catalogAsOf = catalog.fetchedAt;
        if (event.status === 'open') {
          live = await loadForecastExLive({ marketId: 'gdp', productCode: 'RGDP', generationKey: GDP_GENERATION,
            measuredQuarter: GDP_QUARTER, closeTime, contracts: identity.lines || publicLines });
        }
      } catch (error) {
        errors.push({ source: event ? 'ibkr_gdp_book' : 'forecastex_identity', message: String(error.message || error) });
        live = { refreshFailed: true, reason: 'GDP contract data is unavailable.' };
      }
    }
    const generatedAt = now().toISOString();
    const nowMs = Date.parse(generatedAt);
    const contracts = event ? normalizeBook(publicLines, live, event, nowMs) : empty('No verified Q3 GDP contract identity.', { event: null, lines: [] });
    const unavailable = empty('Not applicable to a GDP release.', { executable: false, value: null, points: [], references: [] });
    const catalog = { status: event ? 'available' : 'unavailable', source: 'forecastex_official_contracts',
      asOf: catalogAsOf, event, lines: [], lineCount: event ? publicLines.length : 0, scheduleOnly: true,
      thresholds: event ? publicLines.map((line) => ({
        contractId: line.contractId, threshold: number(line.strike), comparator: '>',
        measuredQuarter: GDP_QUARTER, unit: 'percent_qoq_saar',
        volume: number(line.volume, 0), volume24h: number(line.volume24h, 0), openInterest: number(line.openInterest, 0),
        activityAsOf: catalogAsOf,
        activitySourceUrl: 'https://www.forecastex.com/api/contracts?page=1&pageSize=1000&productId=RGDP',
      })).sort((a, b) => a.threshold - b.threshold) : [],
    };
    const venue = { id: 'forecastex', label: 'ForecastEx', catalog, book: contracts, contracts,
      generationId: event?.generationId || null, generationKey: event?.generationId || null,
      brokerRoutable: false, generations: [], reference: null,
      settlementBasis: { status: event ? 'verified' : 'unavailable', instrument: 'U.S. real GDP QoQ SAAR',
        method: 'BEA third estimate', observationAt: event?.resolutionAt || null, sourceName: 'BEA',
        sourceUrl: 'https://www.bea.gov/data/gdp/gross-domestic-product', rulesUrl: event?.rulesUrl || null },
    };
    return sanitizeGdpSnapshot({
      schemaVersion: 2, marketId: 'gdp', displayName: 'U.S. real GDP', symbol: 'GDP', precision: 2,
      unit: 'percent_qoq_saar', generatedAt, gdp, contracts, venues: { forecastex: venue },
      selectedVenueId: 'forecastex', selectedGenerationId: event?.generationId || null,
      selectedGeneration: event, generationOptions: [],
      selection: { requestedVenue: 'forecastex', requestedGenerationId: null, venueId: 'forecastex', generationId: event?.generationId || null },
      spot: unavailable, chart: unavailable, riskRange: { ...unavailable, lrr: null, hrr: null, trend: null },
      factors: {}, factorRows: [], scoreInputs: {}, resolverMetadata: {}, resolverReference: null,
      sourceRefreshPending: live?.refreshing === true && !contracts.lines.length,
      sourceHealth: [
        { id: 'forecastex_catalog', label: 'ForecastEx RGDP', status: event ? 'available' : 'unavailable', asOf: catalogAsOf },
        { id: 'ibkr_gdp_book', label: 'IBKR GDP native quotes', status: contracts.status, asOf: contracts.asOf, reason: contracts.reason },
      ], errors,
    }, nowMs);
  }
  return { getSnapshot };
}

module.exports = { createGdpMonitorService, sanitizeGdpSnapshot, normalizeBook, GDP_QUARTER, GDP_GENERATION };
