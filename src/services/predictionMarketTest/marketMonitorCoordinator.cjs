const {
  MARKET_CONFIGS,
  MARKET_IDS,
  selectAutoVenue,
  selectRequestedVenue,
} = require('./marketMonitorService.cjs');
const {
  historicalBarDateKey,
  latestCompletedSpxSessionDate,
  latestCompletedWtiSessionDate,
} = require('../predictionMarketsIngest/watchlistProvider');
const {
  retainVerifiedAthWhilePending,
  synchronizeVerifiedAthAcrossChartRanges,
} = require('../../utils/predictionMarketAth.cjs');

const DEFAULT_REFRESH_INTERVAL_MS = 5_000;
const DEFAULT_ACTIVE_POLL_MS = 5_000;
const DISCONNECTED_REFRESH_INTERVAL_MS = 30_000;
const MAX_PENDING_BACKOFF_MS = 30_000;
const MAX_CONSECUTIVE_PENDING_REFRESHES = 12;
const MAX_COMPATIBILITY_STATES = 24;
const GOLD_HEADER_KEYS = Object.freeze(['selectedResolver', 'xauusd', 'activeComex']);
const GOLD_HEADER_QUOTE_MAX_AGE_MS = 60_000;
const GOLD_HEADER_CURRENT_BAR_MAX_AGE_MS = 10 * 60_000;
const FORBIDDEN_LIVE_REFERENCE = /(?:mock|seed|fixture|fallback|cache|portfolio|delayed|frozen|stale|offline|disconnected|historical|synthetic|inferred|derived)/i;
const FORBIDDEN_DISPLAY_REFERENCE = /(?:mock|seed|fixture|fallback|cache|portfolio|delayed|frozen|stale|offline|disconnected|synthetic|inferred|derived)/i;
const HARD_LIVE_FAILURE = /(?:disconnect|offline|delayed|frozen|stale|expired|wrong[_ -]?generation|prior[_ -]?generation|entitle|permission|not[_ -]?connected|gateway[_ -]?(?:unavailable|not connected)|non[_ -]?live)/i;

function previousCalendarSessionDate(nowMs) {
  const today = historicalBarDateKey(nowMs);
  if (!today) return null;
  const parsed = Date.parse(`${today}T12:00:00.000Z`);
  return Number.isFinite(parsed)
    ? new Date(parsed - (24 * 60 * 60_000)).toISOString().slice(0, 10)
    : null;
}

function utcWeekendDate(date) {
  const timestamp = Date.parse(`${date}T12:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return false;
  const weekday = new Date(timestamp).getUTCDay();
  return weekday === 0 || weekday === 6;
}

function expectedHistoricalDateForMarket(marketId, nowMs) {
  if (['sp500', 'nasdaq100'].includes(marketId)) return latestCompletedSpxSessionDate(nowMs);
  if (marketId === 'bitcoin') return previousCalendarSessionDate(nowMs);
  return latestCompletedWtiSessionDate(nowMs);
}

function verifiedHistoricalSection(section, expectedHistoricalDate) {
  const status = String(section?.status || '').toLowerCase();
  const availability = String(section?.availability || '').toLowerCase();
  const historicalThroughDate = String(section?.historicalThroughDate || '');
  const latestDate = historicalBarDateKey(Date.parse(section?.latestAt || section?.asOf || ''));
  return (status === 'historical' || availability === 'historical')
    && /^\d{4}-\d{2}-\d{2}$/.test(String(expectedHistoricalDate || ''))
    && historicalThroughDate === expectedHistoricalDate
    && latestDate === expectedHistoricalDate;
}

function nextTurn() {
  return new Promise((resolve) => {
    if (typeof setImmediate === 'function') setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

function isoNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function unavailable(reason, extras = {}) {
  return {
    status: 'unavailable',
    source: null,
    asOf: null,
    expiresAt: null,
    reason,
    ...extras,
  };
}

function emptyContracts(reason) {
  return unavailable(reason, { event: null, lines: [] });
}

function verifiedFreshLiveReference(section, nowMs, { requireExact = false } = {}) {
  const expiresAt = Date.parse(section?.expiresAt || '');
  const source = String(section?.source || '').trim();
  return section?.status === 'available'
    && section?.availability === 'live'
    && (!requireExact || section?.fit === 'exact')
    && section?.value !== null
    && section?.value !== undefined
    && section?.value !== ''
    && Number.isFinite(Number(section.value))
    && source.length > 0
    && !FORBIDDEN_LIVE_REFERENCE.test(source)
    && section?.refreshFailed !== true
    && section?.fromCache !== true
    && section?.cachedOnly !== true
    && section?.stale !== true
    && section?.seeded !== true
    && Number.isFinite(expiresAt)
    && nowMs <= expiresAt;
}

function verifiedDisplayReference(section, nowMs, {
  requireExact = false,
  expectedHistoricalDate = null,
} = {}) {
  const status = String(section?.status || '').toLowerCase();
  const availability = String(section?.availability || '').toLowerCase();
  const source = String(section?.source || '').trim();
  const asOf = Date.parse(section?.asOf || section?.latestAt || '');
  const expiresAt = Date.parse(section?.expiresAt || '');
  const historical = verifiedHistoricalSection(section, expectedHistoricalDate);
  return ['available', 'historical'].includes(status)
    && ['live', 'current', 'historical'].includes(availability || (historical ? 'historical' : ''))
    && (!requireExact || section?.fit === 'exact')
    && ['exact', 'proxy'].includes(String(section?.fit || 'exact').toLowerCase())
    && section?.value !== null
    && section?.value !== undefined
    && section?.value !== ''
    && Number.isFinite(Number(section.value))
    && source.length > 0
    && !FORBIDDEN_DISPLAY_REFERENCE.test(source)
    && section?.executable !== true
    && section?.refreshFailed !== true
    && section?.fromCache !== true
    && section?.cachedOnly !== true
    && section?.stale !== true
    && section?.seeded !== true
    && Number.isFinite(asOf)
    && asOf <= nowMs + 5_000
    && (historical || (Number.isFinite(expiresAt) && nowMs <= expiresAt));
}

function terminalUnavailableSection(section) {
  const status = String(section?.status || '').toLowerCase();
  return ['unavailable', 'refresh_failed'].includes(status)
    && section?.refreshing !== true
    && section?.refreshPending !== true
    && (
      section?.refreshFailed === true
      || Boolean(section?.errorCode)
      || Boolean(String(section?.reason || '').trim())
    );
}

function retainVerifiedLiveReference(section) {
  return {
    ...section,
    refreshing: false,
    refreshFailed: false,
    refreshIssue: null,
    refreshRetained: true,
    refreshPending: true,
  };
}

function freshLiveReferenceDuringProgress(previous, next, nowMs, options = {}) {
  const nextStatus = String(next?.status || '').toLowerCase();
  const pending = (nextStatus === 'refreshing'
    || next?.refreshing === true
    || next?.refreshPending === true)
    && next?.refreshFailed !== true
    && !hardLiveFailure(next);
  if (!pending) return null;
  // A secondary section (ATH/Risk Range history, for example) may still be
  // hydrating even though this pass already delivered a newer verified live
  // reference. Publish that newer observation instead of retaining the prior
  // tick merely because the containing reference is still progressive.
  if (verifiedFreshLiveReference(next, nowMs, options)) {
    return retainVerifiedLiveReference(next);
  }
  return verifiedFreshLiveReference(previous, nowMs, options)
    ? retainVerifiedLiveReference(previous)
    : null;
}

function verifiedFreshLiveBook(book, nowMs) {
  const status = String(book?.status || '').toLowerCase();
  const source = String(book?.source || '').trim();
  const expiresAt = Date.parse(book?.expiresAt || '');
  const lines = Array.isArray(book?.lines) ? book.lines : [];
  return ['available', 'partial'].includes(status)
    && source.length > 0
    && !FORBIDDEN_LIVE_REFERENCE.test(source)
    && book?.refreshFailed !== true
    && book?.fromCache !== true
    && book?.cachedOnly !== true
    && book?.seeded !== true
    && Number.isFinite(expiresAt)
    && nowMs <= expiresAt
    && lines.some((line) => (
      line?.directNative === true
      && !FORBIDDEN_LIVE_REFERENCE.test(String(line?.source || line?.evidence?.quotes?.source || ''))
      && Number.isFinite(Date.parse(line?.updatedAt || line?.evidence?.quotes?.asOf || ''))
      && [line?.yesBid, line?.yesAsk, line?.noBid, line?.noAsk]
        .some((value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)))
    ));
}

function isFesNativeBook(book) {
  const eventIdentity = `${book?.event?.productCode || ''} ${book?.event?.seriesTicker || ''} ${book?.event?.ticker || ''}`;
  return /(?:^|\s)FES(?:_|\s|$)/i.test(eventIdentity)
    || (Array.isArray(book?.lines) && book.lines.some((line) => /^FES_/i.test(String(line?.contractId || line?.ticker || ''))));
}

function isCpiNativeBook(book) {
  const eventIdentity = `${book?.event?.seriesTicker || ''} ${book?.event?.ticker || ''}`;
  return /(?:^|\s)KXCPIYOY(?:-|\s|$)/i.test(eventIdentity)
    || (Array.isArray(book?.lines) && book.lines.some((line) => /^KXCPIYOY-/i.test(String(line?.ticker || ''))));
}

function hardLiveFailure(section) {
  return section?.hardFailure === true
    || HARD_LIVE_FAILURE.test(`${section?.errorCode || ''} ${section?.refreshIssue || section?.reason || ''}`);
}

function verifiedGoldMarketReference(reference, nowMs) {
  const status = String(reference?.status || '').toLowerCase();
  const retainedStatus = String(reference?.retainedStatus || '').toLowerCase();
  const effectiveStatus = status === 'delayed' ? retainedStatus : status;
  const source = String(reference?.source || '').trim();
  const asOf = Date.parse(reference?.asOf || '');
  const expiresAt = Date.parse(reference?.expiresAt || '');
  const price = Number(reference?.price);
  const provenance = [
    source,
    reference?.warning,
    reference?.provenance,
    reference?.cacheState,
    reference?.fromCache ? 'cached' : null,
    reference?.cachedOnly ? 'cached-only' : null,
    reference?.mock ? 'mock' : null,
    reference?.seeded ? 'seed' : null,
  ].filter(Boolean).join(' ');
  const common = GOLD_HEADER_KEYS.includes(reference?.key)
    && ['live', 'historical'].includes(effectiveStatus)
    && Number.isFinite(price)
    && price > 0
    && /^(?:ibkr|pyth)(?:\b|_)/i.test(source)
    && !FORBIDDEN_DISPLAY_REFERENCE.test(provenance)
    && reference?.refreshFailed !== true
    && reference?.fromCache !== true
    && reference?.cachedOnly !== true
    && reference?.stale !== true
    && reference?.mock !== true
    && reference?.seeded !== true
    && Number.isFinite(asOf)
    && asOf <= nowMs + 5_000
    && (status !== 'delayed' || (
      reference?.displayOnly === true
      && reference?.executable === false
      && reference?.refreshRetained === true
    ));
  if (!common) return false;
  if (effectiveStatus === 'historical') {
    return historicalBarDateKey(asOf) === expectedHistoricalDateForMarket('gold', nowMs);
  }
  const maxAgeMs = source.toLowerCase() === 'ibkr_historical_bars'
    ? GOLD_HEADER_CURRENT_BAR_MAX_AGE_MS
    : GOLD_HEADER_QUOTE_MAX_AGE_MS;
  const ageMs = nowMs - asOf;
  return ageMs >= -5_000
    && ageMs <= maxAgeMs
    && Number.isFinite(expiresAt)
    && nowMs <= expiresAt;
}

function goldReferenceIdentityMatches(previous, next) {
  if (!previous || !next || previous.key !== next.key) return false;
  const previousConId = Number(previous?.instrument?.conId);
  const nextConId = Number(next?.instrument?.conId);
  if (Number.isInteger(previousConId) && previousConId > 0
    && Number.isInteger(nextConId) && nextConId > 0
    && previousConId !== nextConId) return false;
  const previousMonth = String(previous?.instrument?.contractMonth || '').slice(0, 6);
  const nextMonth = String(next?.instrument?.contractMonth || '').slice(0, 6);
  if (/^\d{6}$/.test(previousMonth) && /^\d{6}$/.test(nextMonth)
    && previousMonth !== nextMonth) return false;
  const specificSymbol = (reference) => {
    const symbol = String(
      reference?.instrument?.displaySymbol
      || reference?.instrument?.symbol
      || reference?.symbol
      || '',
    ).trim().toUpperCase();
    return ['', 'GC', 'GOLD'].includes(symbol) ? null : symbol;
  };
  const previousSymbol = specificSymbol(previous);
  const nextSymbol = specificSymbol(next);
  return !previousSymbol || !nextSymbol || previousSymbol === nextSymbol;
}

function goldReferenceRefreshPending(reference, snapshotRefreshPending = false) {
  if (hardLiveFailure(reference)) return false;
  const status = String(reference?.status || '').toLowerCase();
  if (['loading', 'refreshing'].includes(status)
    || reference?.refreshing === true
    || reference?.refreshPending === true) return true;
  const reason = String(reference?.refreshIssue || reference?.reason || '');
  return snapshotRefreshPending
    && status === 'unavailable'
    && /(?:load|refresh|pending|checking|waiting)/i.test(reason);
}

function delayedGoldMarketReference(previous, next) {
  const retainedStatus = previous?.status === 'delayed'
    ? previous?.retainedStatus
    : previous?.status;
  return {
    ...previous,
    status: 'delayed',
    retainedStatus: ['live', 'historical'].includes(retainedStatus) ? retainedStatus : 'live',
    displayOnly: true,
    executable: false,
    refreshPending: true,
    refreshRetained: true,
    refreshFailed: false,
    delayedReason: next?.refreshIssue || next?.reason || 'A fresh quote is loading; showing the last verified value.',
    reason: next?.refreshIssue || next?.reason || previous?.reason || null,
  };
}

function unavailableGoldMarketReference(reference, reason) {
  return {
    ...reference,
    status: 'unavailable',
    price: null,
    previousClose: null,
    changePercent: null,
    source: null,
    asOf: null,
    expiresAt: null,
    retainedStatus: null,
    displayOnly: false,
    executable: false,
    refreshPending: false,
    refreshRetained: false,
    refreshFailed: false,
    delayedReason: null,
    reason: reason || reference?.reason || 'Verified Gold reference is unavailable.',
  };
}

function sanitizeGoldMarketReferences(references, nowMs) {
  if (!Array.isArray(references)) return [];
  return references.slice(0, GOLD_HEADER_KEYS.length).map((reference) => {
    if (verifiedGoldMarketReference(reference, nowMs)) return reference;
    const status = String(reference?.status || '').toLowerCase();
    const leakedDisplayValue = (
      reference?.price !== null
      && reference?.price !== undefined
      && reference?.price !== ''
      && Number.isFinite(Number(reference.price))
    )
      || Boolean(reference?.source)
      || ['live', 'historical', 'delayed'].includes(status);
    if (!leakedDisplayValue) return reference;
    return unavailableGoldMarketReference(
      reference,
      hardLiveFailure(reference)
        ? reference?.refreshIssue || reference?.reason
        : 'The last verified Gold reference expired and is refreshing.',
    );
  });
}

function mergeGoldMarketReferencesDuringProgress(previous, next, nowMs, snapshotRefreshPending = false) {
  const previousByKey = new Map((Array.isArray(previous) ? previous : [])
    .map((reference) => [reference?.key, reference]));
  const nextByKey = new Map((Array.isArray(next) ? next : [])
    .map((reference) => [reference?.key, reference]));
  return GOLD_HEADER_KEYS.map((key) => {
    const prior = previousByKey.get(key) || null;
    const incoming = nextByKey.get(key) || (snapshotRefreshPending && prior ? {
      key,
      label: prior.label,
      symbol: prior.symbol,
      role: prior.role,
      status: 'loading',
      reason: 'A fresh Gold reference is loading.',
    } : null);
    if (verifiedGoldMarketReference(incoming, nowMs)) return incoming;
    if (prior
      && incoming
      && goldReferenceIdentityMatches(prior, incoming)
      && verifiedGoldMarketReference(prior, nowMs)
      && goldReferenceRefreshPending(incoming, snapshotRefreshPending)) {
      return delayedGoldMarketReference(prior, incoming);
    }
    return incoming;
  }).filter(Boolean);
}

function retainVerifiedLiveBook(book, issue = null) {
  return {
    ...book,
    refreshing: false,
    refreshPending: true,
    refreshRetained: true,
    refreshFailed: false,
    refreshDelayed: Boolean(issue),
    refreshIssue: issue || null,
  };
}

function freshLiveBookDuringProgress(previous, next, nowMs) {
  const nextStatus = String(next?.status || '').toLowerCase();
  const pending = (nextStatus === 'refreshing' || next?.refreshing === true || next?.refreshPending === true)
    && next?.refreshFailed !== true;
  if (!pending
    || hardLiveFailure(next)
    || (!isFesNativeBook(previous) && !isCpiNativeBook(previous))
    || !verifiedFreshLiveBook(previous, nowMs)) return null;
  const previousEvent = eventIdentity(previous);
  const nextEvent = eventIdentity(next);
  if (previousEvent && nextEvent && previousEvent !== nextEvent) return null;
  return retainVerifiedLiveBook(previous);
}

function clearTradingLine(line, source = null) {
  return {
    ...line,
    status: 'catalog',
    yesBid: null,
    yesAsk: null,
    yesBidSize: null,
    yesAskSize: null,
    noBid: null,
    noAsk: null,
    noBidSize: null,
    noAskSize: null,
    previousYesBid: null,
    previousYesAsk: null,
    previousPrice: null,
    updatedAt: null,
    source: source || line?.source || null,
    directNative: false,
    depthCapability: 'no_live_book',
    quoteSources: {},
    nativeOrderbook: undefined,
    evidence: line?.evidence ? { ...line.evidence, quotes: null } : line?.evidence,
  };
}

function catalogOnly(catalog, reason) {
  if (!catalog || catalog.status !== 'available' || !Array.isArray(catalog.lines)) return catalog;
  return {
    ...catalog,
    lines: catalog.lines.map((line) => clearTradingLine(line, catalog.source)),
    bookStatus: 'unavailable',
    scheduleOnly: true,
    reason,
  };
}

function catalogOnlyGeneration(generation, reason) {
  if (!generation) return generation;
  const source = generation.venueId === 'forecastex'
    ? 'forecastex_official_schedule'
    : 'kalshi_trade_api_v2_catalog';
  return {
    ...generation,
    bookStatus: 'unavailable',
    quotedLineCount: 0,
    executableLineCount: 0,
    lines: (Array.isArray(generation.lines) ? generation.lines : []).map((line) => clearTradingLine(line, source)),
    bookReason: reason,
  };
}

function clearProxyFit(proxyFit, reason, { failed = false } = {}) {
  if (!proxyFit) return proxyFit;
  const windows = Array.isArray(proxyFit.rows) && proxyFit.rows.length
    ? proxyFit.rows.map((row) => row.window)
    : [5, 20, 60, 120];
  return {
    status: failed ? 'unavailable' : 'loading',
    proxyLabel: proxyFit.proxyLabel || null,
    underlyingLabel: proxyFit.underlyingLabel || null,
    currentBasisPct: null,
    alignedThroughDate: null,
    alignedObservations: 0,
    rows: windows.map((window) => ({
      window,
      status: 'unavailable',
      averageBasisPct: null,
      deviationZ: null,
      returnCorrelation: null,
      observations: 0,
    })),
    reason,
  };
}

function clearReferenceDuringWholeRefresh(reference, reason, {
  failed = false,
  nowMs = Date.now(),
  expectedHistoricalDate = null,
} = {}) {
  if (!reference) return reference;
  const state = failed ? 'refresh_failed' : 'refreshing';
  const retainFresh = !failed;
  const displaySpot = ['live', 'current', 'historical'].includes(String(reference.spot?.availability || '').toLowerCase())
    || ['available', 'historical'].includes(String(reference.spot?.status || '').toLowerCase());
  const retainedSpot = retainFresh && verifiedDisplayReference(reference.spot, nowMs, { expectedHistoricalDate })
    ? retainVerifiedLiveReference(reference.spot)
    : null;
  const cleared = {
    ...reference,
    proxyFit: clearProxyFit(reference.proxyFit, reason, { failed }),
    spot: retainedSpot || (displaySpot ? unavailable(reason, {
      status: state,
      value: null,
      label: reference.spot?.label || null,
      fit: reference.spot?.fit || reference.fit || 'exact',
      availability: 'unavailable',
      executable: false,
      refreshing: !failed,
      refreshFailed: failed,
      refreshIssue: reason,
      errorCode: failed ? 'PM_MONITOR_REFRESH_FAILED' : null,
    }) : reference.spot),
    chart: failed
      ? clearSpxChart(reason, reference.chart)
      : terminalUnavailableSection(reference.chart)
        ? reference.chart
        : retainChartWhileRefreshing(
          reference.chart,
          refreshingSpxChart(reason, reference.chart),
          nowMs,
          expectedHistoricalDate,
        ),
  };
  if (!reference.chartReferences) return cleared;
  const clearEntry = (entry) => {
    if (!entry) return entry;
    const result = clearReferenceDuringWholeRefresh(
      { ...entry, chartReferences: null },
      reason,
      { failed, nowMs, expectedHistoricalDate },
    );
    const delayed = !failed && (
      result?.spot?.refreshRetained === true
      || result?.chart?.refreshRetained === true
    );
    return {
      ...result,
      freshness: inferredChartReferenceFreshness(result, delayed ? {
        status: 'delayed',
        reason,
      } : {}),
    };
  };
  return {
    ...cleared,
    chartReferences: {
      basis: clearEntry(reference.chartReferences.basis),
      contract: clearEntry(reference.chartReferences.contract),
    },
  };
}

function clearLiveTradingSnapshot(snapshot, reason, { failed = false, nowMs = Date.now() } = {}) {
  if (!snapshot) return snapshot;
  const expectedHistoricalDate = expectedHistoricalDateForMarket(snapshot.marketId, nowMs);
  const state = failed ? 'refresh_failed' : 'refreshing';
  const emptyBook = (event = null) => unavailable(reason, {
    status: state,
    event,
    lines: [],
    refreshing: !failed,
    refreshFailed: failed,
    refreshIssue: reason,
    errorCode: failed ? 'PM_MONITOR_REFRESH_FAILED' : null,
  });
  const venues = Object.fromEntries(Object.entries(snapshot.venues || {}).map(([id, venue]) => {
    const catalog = catalogOnly(venue.catalog, reason);
    const priorBook = venue.book || venue.contracts;
    const retainFreshBook = !failed
      && isFesNativeBook(priorBook)
      && verifiedFreshLiveBook(priorBook, nowMs);
    const book = retainFreshBook
      ? retainVerifiedLiveBook(priorBook, failed ? reason : null)
      : emptyBook(catalog?.event || null);
    return [id, {
      ...venue,
      status: ['available', 'partial'].includes(book?.status)
        ? book.status
        : catalog?.status === 'available' ? 'partial' : state,
      catalog,
      book,
      contracts: book,
      reference: clearReferenceDuringWholeRefresh(venue.reference, reason, {
        failed,
        nowMs,
        expectedHistoricalDate,
      }),
      generations: retainFreshBook
        ? venue.generations
        : (venue.generations || []).map((generation) => catalogOnlyGeneration(generation, reason)),
      bookQuality: retainFreshBook ? venue.bookQuality : {
        eligible: false,
        lineCount: 0,
        directLineCount: 0,
        executableLineCount: 0,
        displayedDepth: 0,
        displayedAskDepth: 0,
        medianSpread: null,
      },
    }];
  }));
  const autoSelection = {
    status: 'unavailable',
    mode: 'none',
    venueId: null,
    generationId: null,
    label: 'No executable venue',
    reason,
    contracts: emptyBook(),
  };
  const requestedSelection = {
    venue: snapshot?.selection?.requestedVenue || 'auto',
    generationId: snapshot?.selection?.requestedGenerationId || null,
  };
  const displaySelection = selectRequestedVenue(venues, autoSelection, requestedSelection);
  const generationOptions = (snapshot.generationOptions || []).map((generation) => {
    const retainedVenue = venues[generation.venueId];
    const retainedGeneration = retainedVenue?.book?.refreshRetained === true
      && generation.generationId === retainedVenue?.generationId;
    return retainedGeneration ? generation : catalogOnlyGeneration(generation, reason);
  });
  const selectedGenerationId = displaySelection.generationId
    || displaySelection.contracts?.event?.generationId
    || displaySelection.contracts?.event?.ticker
    || snapshot.selectedGenerationId
    || null;
  const selectedGeneration = generationOptions.find((generation) => (
    generation.venueId === displaySelection.venueId
    && generation.generationId === selectedGenerationId
  )) || null;
  const selectedVenueReference = displaySelection.venueId
    ? venues[displaySelection.venueId]?.reference || null
    : null;
  const displaySpot = ['live', 'current', 'historical'].includes(String(snapshot.spot?.availability || '').toLowerCase())
    || ['available', 'historical'].includes(String(snapshot.spot?.status || '').toLowerCase());
  const retainFreshReference = !failed;
  const retainedSpot = retainFreshReference && verifiedDisplayReference(snapshot.spot, nowMs, { expectedHistoricalDate })
    ? retainVerifiedLiveReference(snapshot.spot)
    : null;
  const retainedResolverSpot = retainFreshReference
    && verifiedDisplayReference(snapshot.resolverReference?.spot, nowMs, {
      expectedHistoricalDate,
    })
    ? retainVerifiedLiveReference(snapshot.resolverReference.spot)
    : null;
  const sourceHealth = (snapshot.sourceHealth || []).map((source) => (
    source?.applicable === false || source?.status === 'not_applicable'
      ? source
      : {
          ...source,
          status: state,
          reason,
          errorCode: failed ? 'PM_MONITOR_REFRESH_FAILED' : null,
        }
  ));
  const clearedFallbackReference = clearReferenceDuringWholeRefresh(
    snapshot.resolverReference,
    reason,
    { failed, nowMs, expectedHistoricalDate },
  );
  const fallbackResolverReference = clearedFallbackReference ? {
    ...clearedFallbackReference,
    lastVerifiedSpot: failed ? null : snapshot.resolverReference.lastVerifiedSpot,
    spot: retainedResolverSpot || clearedFallbackReference.spot || unavailable(reason, {
      status: state,
      value: null,
      availability: 'unavailable',
      fit: snapshot.resolverReference.spot?.fit || 'exact',
      executable: false,
      refreshing: !failed,
      refreshFailed: failed,
    }),
  } : snapshot.resolverReference;
  const mirroredReference = selectedVenueReference || fallbackResolverReference;
  const chartReferences = mirroredReference?.chartReferences
    || (snapshot.chartReferences ? {
      basis: clearReferenceDuringWholeRefresh(
        { ...snapshot.chartReferences.basis, chartReferences: null },
        reason,
        { failed, nowMs, expectedHistoricalDate },
      ),
      contract: clearReferenceDuringWholeRefresh(
        { ...snapshot.chartReferences.contract, chartReferences: null },
        reason,
        { failed, nowMs, expectedHistoricalDate },
      ),
    } : null);
  const resolvedReference = mirroredReference && chartReferences
    ? { ...mirroredReference, chartReferences }
    : mirroredReference;
  const fallbackSpot = retainedSpot || (displaySpot ? unavailable(reason, {
    status: state,
    value: null,
    label: snapshot.spot?.label || null,
    fit: snapshot.spot?.fit || 'exact',
    availability: 'unavailable',
    executable: false,
    refreshing: !failed,
    refreshFailed: failed,
    refreshIssue: reason,
    errorCode: failed ? 'PM_MONITOR_REFRESH_FAILED' : null,
  }) : snapshot.spot);
  const fallbackChart = failed
    ? clearSpxChart(reason, snapshot.chart)
    : terminalUnavailableSection(snapshot.chart)
      ? snapshot.chart
      : retainChartWhileRefreshing(
          snapshot.chart,
          refreshingSpxChart(reason, snapshot.chart),
          nowMs,
          expectedHistoricalDate,
        );
  return {
    ...snapshot,
    status: Object.values(venues).some((venue) => venue.catalog?.status === 'available') ? 'partial' : state,
    spot: chartReferences?.basis?.spot || selectedVenueReference?.spot || fallbackSpot,
    chart: chartReferences?.basis?.chart || selectedVenueReference?.chart || fallbackChart,
    chartReferences,
    resolverReference: resolvedReference,
    resolverMetadata: snapshot.resolverMetadata ? {
      ...snapshot.resolverMetadata,
      reference: resolvedReference?.resolver || null,
    } : snapshot.resolverMetadata,
    venues,
    generationOptions,
    selectedVenueId: displaySelection.venueId,
    selectedGenerationId,
    selectedGeneration,
    sourceHealth,
    sourceRefreshPending: !failed,
    autoSelection,
    displaySelection,
    displayContracts: displaySelection.contracts,
    contracts: displaySelection.contracts,
    executionContracts: autoSelection.contracts,
  };
}

function clearSpxChart(reason, previousChart = null) {
  const variant = (range) => unavailable(reason, {
    range,
    availability: 'unavailable',
    points: [],
    references: [],
    rangeDates: [],
    dailyRanges: [],
    refreshFailed: true,
    refreshIssue: reason,
    fit: previousChart?.fit || 'exact',
    executable: false,
  });
  const oneDay = variant('1d');
  return {
    ...oneDay,
    variants: {
      '1d': { ...oneDay },
      '5d': variant('5d'),
      '10d': variant('10d'),
    },
  };
}

function refreshingSpxChart(reason, previousChart = null) {
  const variant = (range) => unavailable(reason, {
    status: 'refreshing',
    refreshing: true,
    range,
    availability: 'unavailable',
    points: [],
    references: [],
    rangeDates: [],
    dailyRanges: [],
    fit: previousChart?.variants?.[range]?.fit || previousChart?.fit || 'exact',
    executable: false,
  });
  const oneDay = variant('1d');
  return {
    ...oneDay,
    variants: {
      '1d': { ...oneDay },
      '5d': variant('5d'),
      '10d': variant('10d'),
    },
  };
}

function buildMonitorSkeleton(marketId, now = () => new Date()) {
  const config = MARKET_CONFIGS[marketId];
  if (!config) return null;
  const generatedAt = isoNow(now);
  const waiting = `Refreshing the current ${config.fullLabel} monitor.`;
  const emptyVenue = (id, label, resolver) => ({
    id,
    label,
    status: 'refreshing',
    resolver,
    brokerRoutable: false,
    equivalenceFingerprint: null,
    catalog: unavailable(waiting, { event: null, lines: [] }),
    book: emptyContracts('No verified live book has loaded.'),
    contracts: emptyContracts('No verified executable contract ladder has loaded.'),
    reference: null,
    bookQuality: {
      eligible: false,
      lineCount: 0,
      directLineCount: 0,
      executableLineCount: 0,
      displayedDepth: 0,
      displayedAskDepth: 0,
      medianSpread: null,
    },
  });
  const venueIds = Array.isArray(config.venueIds)
    ? config.venueIds
    : ['kalshi', ...(config.forecastExProduct ? ['forecastex'] : [])];
  const venues = Object.fromEntries(venueIds.map((venueId) => (
    venueId === 'forecastex'
      ? ['forecastex', emptyVenue('forecastex', 'ForecastEx', config.forecastExResolver)]
      : ['kalshi', emptyVenue('kalshi', 'Kalshi', config.kalshiResolver)]
  )));
  const fixedVenueId = venueIds.length === 1 ? venueIds[0] : null;
  const fixedVenueLabel = fixedVenueId === 'forecastex' ? 'ForecastEx' : fixedVenueId === 'kalshi' ? 'Kalshi' : null;
  return {
    schemaVersion: 2,
    marketId,
    displayName: config.fullLabel,
    symbol: config.symbol,
    precision: config.precision,
    unit: config.unit,
    generatedAt,
    status: 'refreshing',
    session: { state: 'unknown', asOf: generatedAt },
    resolverMetadata: {
      ...(venueIds.includes('kalshi') ? { kalshi: config.kalshiResolver } : {}),
      ...(venueIds.includes('forecastex') ? { forecastex: config.forecastExResolver } : {}),
      reference: null,
    },
    spot: unavailable(waiting, {
      value: null,
      label: config.symbol,
      fit: 'exact',
      availability: 'unavailable',
      executable: false,
    }),
    chart: refreshingSpxChart(waiting),
    chartReferences: null,
    riskRange: unavailable(marketId === 'cpi' ? 'Risk Range is not applicable to CPI.' : waiting, {
      lrr: null,
      hrr: null,
      trend: null,
      fit: config.riskRange?.fit || 'not_applicable',
      ticker: config.riskRange?.ticker || null,
    }),
    ...(marketId === 'cpi' ? {
      forecastComparison: {
        status: 'refreshing', releaseKey: null, reportMonth: null, forecastMonth: null,
        releaseAt: null, eventTicker: null, metric: 'Headline CPI YoY', unit: 'percent',
        hedgeye: unavailable(waiting, { scenarios: [], baseValue: null }),
        clevelandFed: unavailable(waiting, { value: null, points: [] }),
        bls: unavailable(waiting, { latestFinal: null }),
        reason: waiting,
      },
      ladderReference: null,
    } : {}),
    factors: {},
    factorRows: [],
    scoreInputs: {},
    generationOptions: [],
    selectedGeneration: null,
    selectedGenerationId: null,
    selectedVenueId: null,
    productActivity: null,
    sourceHealth: [],
    venues,
    autoSelection: {
      status: 'unavailable',
      mode: 'none',
      venueId: null,
      label: 'No executable venue',
      reason: 'Live venue books are refreshing.',
      contracts: emptyContracts('No verified executable contract ladder has loaded.'),
    },
    displaySelection: {
      status: 'refreshing',
      mode: 'none',
      venueId: fixedVenueId,
      label: fixedVenueLabel ? `${fixedVenueLabel} catalog refreshing` : 'Catalog refreshing',
      reason: waiting,
      contracts: emptyContracts(waiting),
    },
    displayContracts: emptyContracts(waiting),
    contracts: emptyContracts('No verified executable contract ladder has loaded.'),
    strategy: {
      status: 'unavailable',
      model: marketId === 'sp500' && venueIds.includes('kalshi') ? 'spx-close-confluence-v1' : null,
      eligibleVenueId: marketId === 'sp500' && venueIds.includes('kalshi') ? 'kalshi' : null,
      reason: marketId === 'sp500' && venueIds.includes('kalshi')
        ? 'The validated strategy is unavailable until the exact live KXINXU book is verified.'
        : `No validated ${config.fullLabel} prediction-contract strategy or sizing model is configured.`,
    },
    errors: [],
  };
}

function expired(value, nowMs) {
  const expiresAt = Date.parse(value?.expiresAt || '');
  return Number.isFinite(expiresAt) && expiresAt < nowMs;
}

function snapshotHasExpiredLiveData(snapshot, nowMs) {
  const isExpiredLiveSection = (section) => {
    const status = String(section?.status || '').toLowerCase();
    const availability = String(section?.availability || '').toLowerCase();
    return (availability === 'live' || ['available', 'partial'].includes(status))
      && expired(section, nowMs);
  };
  const hasExpiredChartReference = (reference) => (
    isExpiredLiveSection(reference?.spot)
    || isExpiredLiveSection(reference?.chart)
    || Object.values(reference?.chart?.variants || {}).some(isExpiredLiveSection)
  );
  const hasExpiredChartReferences = (references) => (
    hasExpiredChartReference(references?.basis)
    || hasExpiredChartReference(references?.contract)
  );
  if (isExpiredLiveSection(snapshot?.spot)) return true;
  if (Object.values(snapshot?.chart?.variants || {}).some(isExpiredLiveSection)) return true;
  if (hasExpiredChartReferences(snapshot?.chartReferences)) return true;
  if ((snapshot?.goldMarketReferences || []).some((reference) => {
    const status = String(reference?.status || '').toLowerCase();
    const retainedStatus = String(reference?.retainedStatus || '').toLowerCase();
    return (status === 'live' || (status === 'delayed' && retainedStatus === 'live'))
      && expired(reference, nowMs);
  })) return true;
  return Object.values(snapshot?.venues || {}).some((venue) => (
    isExpiredLiveSection(venue?.book || venue?.contracts)
    || isExpiredLiveSection(venue?.reference?.spot)
    || isExpiredLiveSection(venue?.reference?.chart)
    || Object.values(venue?.reference?.chart?.variants || {}).some(isExpiredLiveSection)
    || hasExpiredChartReferences(venue?.reference?.chartReferences)
  ));
}

function expireBook(book, nowMs) {
  if (!book) return book;
  const bookExpired = expired(book, nowMs);
  const refreshPending = book?.refreshing === true || book?.refreshPending === true;
  const retainedRefresh = refreshPending
    && book?.refreshRetained === true
    && verifiedFreshLiveBook(book, nowMs);
  const unsafeRefresh = (refreshPending && !retainedRefresh)
    || (book?.refreshFailed === true && hardLiveFailure(book));
  if (!bookExpired && !unsafeRefresh) return book;
  return unavailable(
    unsafeRefresh
      ? book.refreshIssue || book.reason || 'The native live book refresh is incomplete.'
      : 'The native live book expired and is refreshing.', {
    event: book.event || null,
    lines: [],
    expiredAt: book.expiresAt || null,
    refreshing: book.refreshing === true,
    refreshPending: book.refreshPending === true,
    refreshFailed: book.refreshFailed === true,
    refreshIssue: book.refreshIssue || null,
    errorCode: book.errorCode || null,
  });
}

function expireLiveSection(section, nowMs, kind) {
  if (!section || section.availability !== 'live' || !expired(section, nowMs)) return section;
  return unavailable(`The verified live ${kind} expired and is refreshing.`, kind === 'chart'
    ? {
        points: [], references: [], fit: section.fit || 'exact',
        availability: 'unavailable', executable: false, expiredAt: section.expiresAt || null,
      }
    : {
        value: null, label: section.label || null, fit: section.fit || 'exact',
        availability: 'unavailable', executable: false, expiredAt: section.expiresAt || null,
      });
}

function expireChart(chart, nowMs) {
  if (!chart) return chart;
  const supplied = chart.variants || {};
  const expireVariant = (variant, range) => {
    if (!variant) return unavailable('Verified chart history is unavailable.', {
      range,
      availability: 'unavailable',
      points: [],
      references: [],
      rangeDates: [],
      dailyRanges: [],
      fit: chart.fit || 'exact',
      executable: false,
    });
    const expired = expireLiveSection(variant, nowMs, 'chart');
    return expired?.status === 'unavailable'
      ? {
          ...expired,
          range,
          rangeDates: [],
          dailyRanges: [],
        }
      : expired;
  };
  const variants = {
    '1d': expireVariant(supplied['1d'] || chart, '1d'),
    '5d': expireVariant(supplied['5d'], '5d'),
    '10d': expireVariant(supplied['10d'], '10d'),
  };
  return { ...variants['1d'], variants };
}

function sanitizeCpiForecastComparison(comparison, nowMs) {
  if (!comparison || typeof comparison !== 'object') return comparison;
  const releaseAt = Date.parse(comparison.releaseAt || '');
  if (Number.isFinite(releaseAt) && releaseAt > nowMs) return comparison;
  const reason = 'The retained CPI forecast comparison expired at the release boundary.';
  return {
    ...comparison,
    status: 'unavailable',
    hedgeye: unavailable(reason, { scenarios: [], baseValue: null }),
    clevelandFed: unavailable(reason, { value: null, points: [] }),
    bls: unavailable(reason, { latestFinal: null }),
    reason,
  };
}

function sanitizeCachedSnapshot(snapshot, nowMs) {
  if (!snapshot) return snapshot;
  const venues = Object.fromEntries(Object.entries(snapshot.venues || {}).map(([id, venue]) => {
    const book = expireBook(venue?.book || venue?.contracts, nowMs);
    const contracts = expireBook(venue?.contracts || venue?.book, nowMs);
    const bookSafe = ['available', 'partial'].includes(String(book?.status || '').toLowerCase())
      && (book?.refreshing !== true || book?.refreshRetained === true)
      && (book?.refreshPending !== true || book?.refreshRetained === true)
      && book?.refreshFailed !== true;
    const generations = (venue?.generations || []).map((generation) => (
      bookSafe && generation.generationId === venue.generationId
        ? generation
        : catalogOnlyGeneration(generation, book?.reason || 'No fresh native book is available for this generation.')
    ));
    return [id, {
      ...venue,
      book,
      contracts,
      reference: expireReferenceWithChartReferences(
        venue?.reference,
        nowMs,
        `${venue.label || id} resolver reference`,
      ),
      generations,
      bookQuality: bookSafe ? venue.bookQuality : {
        eligible: false,
        lineCount: 0,
        directLineCount: 0,
        executableLineCount: 0,
        displayedDepth: 0,
        displayedAskDepth: 0,
        medianSpread: null,
      },
      status: contracts?.status === 'available'
        ? 'available'
        : venue?.catalog?.status === 'available' ? 'partial' : 'unavailable',
    }];
  }));
  const autoSelection = selectAutoVenue(venues, nowMs);
  const requestedSelection = {
    venue: snapshot?.selection?.requestedVenue || 'auto',
    generationId: snapshot?.selection?.requestedGenerationId || null,
  };
  const displaySelection = selectRequestedVenue(venues, autoSelection, requestedSelection);
  const generationOptions = (snapshot.generationOptions || []).map((generation) => {
    const venue = venues[generation.venueId];
    const bookSafe = ['available', 'partial'].includes(String(venue?.book?.status || '').toLowerCase())
      && (venue?.book?.refreshing !== true || venue?.book?.refreshRetained === true)
      && (venue?.book?.refreshPending !== true || venue?.book?.refreshRetained === true)
      && venue?.book?.refreshFailed !== true;
    return bookSafe && generation.generationId === venue?.generationId
      ? generation
      : catalogOnlyGeneration(
          generation,
          venue?.book?.reason || 'No fresh native book is available for this generation.',
        );
  });
  const selectedGenerationId = displaySelection.generationId
    || displaySelection.contracts?.event?.generationId
    || displaySelection.contracts?.event?.ticker
    || snapshot.selectedGenerationId
    || null;
  const selectedGeneration = generationOptions.find((generation) => (
    generation.venueId === displaySelection.venueId
    && generation.generationId === selectedGenerationId
  )) || snapshot.selectedGeneration || null;
  const selectedVenueReference = displaySelection.venueId
    ? venues[displaySelection.venueId]?.reference || null
    : null;
  const fallbackResolverReference = expireReferenceWithChartReferences(
    snapshot.resolverReference,
    nowMs,
    'resolver reference',
  );
  const mirroredReference = selectedVenueReference || fallbackResolverReference;
  const chartReferences = mirroredReference?.chartReferences
    || expireChartReferences(snapshot.chartReferences, nowMs);
  const resolvedReference = mirroredReference && chartReferences
    ? { ...mirroredReference, chartReferences }
    : mirroredReference;
  const goldMarketReferences = snapshot.marketId === 'gold'
    ? sanitizeGoldMarketReferences(snapshot.goldMarketReferences, nowMs)
    : snapshot.goldMarketReferences;
  const forecastComparison = snapshot.marketId === 'cpi'
    ? sanitizeCpiForecastComparison(snapshot.forecastComparison, nowMs)
    : snapshot.forecastComparison;
  const ladderReference = snapshot.marketId === 'cpi'
    && forecastComparison?.status !== 'unavailable'
    && snapshot.ladderReference?.reportMonth === forecastComparison?.reportMonth
      ? snapshot.ladderReference
      : snapshot.marketId === 'cpi' ? null : snapshot.ladderReference;
  return {
    ...snapshot,
    ...(snapshot.marketId === 'gold' ? { goldMarketReferences } : {}),
    ...(snapshot.marketId === 'cpi' ? { forecastComparison, ladderReference } : {}),
    spot: chartReferences?.basis?.spot
      || selectedVenueReference?.spot
      || expireLiveSection(snapshot.spot, nowMs, 'reference'),
    chart: chartReferences?.basis?.chart
      || selectedVenueReference?.chart
      || expireChart(snapshot.chart, nowMs),
    chartReferences,
    resolverReference: resolvedReference,
    resolverMetadata: snapshot.resolverMetadata ? {
      ...snapshot.resolverMetadata,
      reference: resolvedReference?.resolver || null,
    } : snapshot.resolverMetadata,
    venues,
    generationOptions,
    autoSelection,
    displaySelection,
    selectedVenueId: displaySelection.venueId,
    selectedGenerationId,
    selectedGeneration,
    productActivity: displaySelection.venueId && venues[displaySelection.venueId]
      ? venues[displaySelection.venueId].activity || null
      : null,
    displayContracts: displaySelection.contracts,
    contracts: displaySelection.contracts,
    executionContracts: autoSelection.contracts,
  };
}

function successfulAndFresh(section, nowMs, expectedHistoricalDate = null) {
  const status = String(section?.status || '').toLowerCase();
  const expiresAt = Date.parse(section?.expiresAt || section?.event?.closeTime || '');
  return ['available', 'historical', 'partial'].includes(status)
    && (verifiedHistoricalSection(section, expectedHistoricalDate)
      || (Number.isFinite(expiresAt) && expiresAt >= nowMs));
}

function verifiedChartContext(section, nowMs, expectedHistoricalDate = null) {
  const status = String(section?.status || '').toLowerCase();
  const source = String(section?.source || '').trim();
  const expiresAt = Date.parse(section?.expiresAt || '');
  const datedHistorical = verifiedHistoricalSection(section, expectedHistoricalDate);
  return ['available', 'historical', 'partial'].includes(status)
    && source.length > 0
    && !FORBIDDEN_DISPLAY_REFERENCE.test(source)
    && section?.refreshFailed !== true
    && section?.fromCache !== true
    && section?.cachedOnly !== true
    && section?.stale !== true
    && section?.seeded !== true
    && Array.isArray(section?.points)
    && section.points.length >= 2
    && (datedHistorical || (Number.isFinite(expiresAt) && expiresAt >= nowMs));
}

function retainChartSectionWhileRefreshing(previous, next, nowMs, expectedHistoricalDate = null) {
  const refreshing = String(next?.status || '').toLowerCase() === 'refreshing'
    || next?.refreshing === true
    || next?.refreshPending === true;
  if (!refreshing) return next;
  // Progressive context flags do not make a newly delivered, provenance-safe
  // price series less current. Prefer it and mark it retained only so the UI
  // knows the remaining refresh is non-destructive.
  if (verifiedChartContext(next, nowMs, expectedHistoricalDate)) {
    return {
      ...next,
      refreshing: false,
      refreshPending: true,
      refreshRetained: true,
      refreshFailed: false,
      refreshIssue: null,
    };
  }
  if (!verifiedChartContext(previous, nowMs, expectedHistoricalDate)) return next;
  return {
    ...previous,
    refreshing: false,
    refreshPending: true,
    refreshRetained: true,
    refreshFailed: false,
    refreshIssue: null,
  };
}

function markChartRefreshPending(chart) {
  if (!chart) return chart;
  const markSection = (section) => {
    if (!section || section?.refreshFailed === true || hardLiveFailure(section)) return section;
    return { ...section, refreshPending: true };
  };
  return {
    ...markSection(chart),
    ...(chart.variants ? {
      variants: Object.fromEntries(Object.entries(chart.variants).map(([range, variant]) => [
        range,
        markSection(variant),
      ])),
    } : {}),
  };
}

function verifiedDailyRiskRange(range) {
  const date = String(range?.date || '');
  const publicationDate = String(range?.riskRangePublicationDate || date);
  const carriedForward = range?.riskRangeCarryForward === 'last_published_non_publication_session';
  const references = Array.isArray(range?.references) ? range.references : [];
  const referenceFor = (label) => references.find((reference) => reference?.label === label);
  const lrr = Number(referenceFor('LRR')?.value);
  const hrr = Number(referenceFor('HRR')?.value);
  if (range?.status !== 'available'
    || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !Number.isFinite(lrr)
    || !Number.isFinite(hrr)
    || lrr >= hrr
    || range?.refreshFailed === true
    || range?.fromCache === true
    || range?.cachedOnly === true
    || range?.seeded === true) return false;
  return ['LRR', 'HRR'].every((label) => {
    const reference = referenceFor(label);
    const source = String(reference?.source || '').trim();
    const asOf = String(reference?.asOf || '');
    const referenceDate = /^\d{4}-\d{2}-\d{2}/.test(asOf) ? asOf.slice(0, 10) : publicationDate;
    return reference?.status === 'available'
      && source.length > 0
      && !FORBIDDEN_DISPLAY_REFERENCE.test(source)
      && (carriedForward
        ? utcWeekendDate(date)
          && /^\d{4}-\d{2}-\d{2}$/.test(publicationDate)
          && publicationDate < date
          && reference?.carriedForward === true
          && referenceDate === publicationDate
        : referenceDate === date)
      && reference?.refreshFailed !== true
      && reference?.fromCache !== true
      && reference?.cachedOnly !== true
      && reference?.seeded !== true;
  });
}

function retainRiskRangeOverlaysWhilePending(previous, next) {
  if (!previous
    || previous.refreshFailed === true
    || previous.fromCache === true
    || previous.cachedOnly === true
    || previous.seeded === true
    || FORBIDDEN_DISPLAY_REFERENCE.test(String(previous.source || ''))
    || !next
    || next.riskRangeRefreshPending !== true
    || next.refreshFailed === true
    || next.fromCache === true
    || next.cachedOnly === true
    || next.seeded === true
    || FORBIDDEN_DISPLAY_REFERENCE.test(String(next.source || ''))
    || !Array.isArray(next.dailyRanges)) return next;
  const priorByDate = new Map((previous?.dailyRanges || [])
    .filter(verifiedDailyRiskRange)
    .map((range) => [range.date, range]));
  let retained = false;
  const dailyRanges = next.dailyRanges.map((range) => {
    if (verifiedDailyRiskRange(range)) return range;
    const prior = priorByDate.get(range?.date);
    if (!prior) return range;
    retained = true;
    return {
      ...range,
      status: 'available',
      references: prior.references.map((reference) => ({ ...reference })),
      ...(prior.structure ? { structure: prior.structure } : {}),
      reason: null,
      refreshPending: true,
      refreshRetained: true,
    };
  });
  if (!retained) return next;
  const missingDates = dailyRanges.filter((range) => !verifiedDailyRiskRange(range)).map((range) => range.date);
  return {
    ...next,
    dailyRanges,
    riskRangeStatus: missingDates.length ? 'partial' : 'available',
    riskRangeMissingDates: missingDates,
    riskRangeRefreshPending: true,
    riskRangeRefreshRetained: true,
  };
}

function retainChartWhileRefreshing(previous, next, nowMs, expectedHistoricalDate = null) {
  if (!next) return next;
  const retainedRoot = retainVerifiedAthWhilePending(
    previous,
    retainRiskRangeOverlaysWhilePending(
      previous,
      retainChartSectionWhileRefreshing(previous, next, nowMs, expectedHistoricalDate),
    ),
  );
  if (!next.variants) return synchronizeVerifiedAthAcrossChartRanges(retainedRoot);
  const previousVariants = previous?.variants || {};
  const variants = Object.fromEntries(Object.entries(next.variants).map(([range, variant]) => [
    range,
    retainVerifiedAthWhilePending(
      previousVariants[range] || (range === '1d' ? previous : null),
      retainRiskRangeOverlaysWhilePending(
        previousVariants[range] || (range === '1d' ? previous : null),
        retainChartSectionWhileRefreshing(
          previousVariants[range] || (range === '1d' ? previous : null),
          variant,
          nowMs,
          expectedHistoricalDate,
        ),
      ),
    ),
  ]));
  return synchronizeVerifiedAthAcrossChartRanges({ ...retainedRoot, variants });
}

function chartReferenceIdentity(reference) {
  const instrument = reference?.instrument || {};
  const directionalFeed = reference?.directionalFeed || {};
  const conId = Number(instrument.conId || instrument.conid || directionalFeed.conId);
  const contractMonth = String(
    instrument.contractMonth
      || directionalFeed.contractMonth
      || instrument.lastTradeDateOrContractMonth
      || directionalFeed.lastTradeDate
      || '',
  ).replace(/[^0-9]/g, '').slice(0, 8);
  const symbol = String(
    instrument.displaySymbol
      || instrument.localSymbol
      || directionalFeed.localSymbol
      || reference?.symbol
      || '',
  ).trim().toUpperCase();
  return {
    conId: Number.isInteger(conId) && conId > 0 ? conId : null,
    contractMonth: /^\d{6,8}$/.test(contractMonth) ? contractMonth : null,
    symbol: symbol || null,
  };
}

function chartReferenceIdentityMatches(previous, next) {
  if (!previous || !next) return false;
  const prior = chartReferenceIdentity(previous);
  const incoming = chartReferenceIdentity(next);
  if (prior.conId && incoming.conId && prior.conId !== incoming.conId) return false;
  if (prior.contractMonth && incoming.contractMonth
    && prior.contractMonth.slice(0, 6) !== incoming.contractMonth.slice(0, 6)) return false;
  if (prior.symbol && incoming.symbol && prior.symbol !== incoming.symbol) {
    const symbolIdentity = (value, reference) => {
      const symbol = String(value || '').toUpperCase();
      const dated = symbol.match(/^(ES|GC|SI|CL|BZ|WBS)[FGHJKMNQUVXZ]\d{1,2}$/);
      if (dated) return { family: dated[1], specific: true };
      if (['ES', 'GC', 'SI', 'CL', 'BZ', 'WBS'].includes(symbol)) {
        return { family: symbol, specific: false };
      }
      if (symbol === 'SP500'
        && reference?.role === 'contract_reference'
        && reference?.riskRangeTicker === 'SPX') return { family: 'ES', specific: false };
      return { family: symbol, specific: true };
    };
    const priorSymbol = symbolIdentity(prior.symbol, previous);
    const incomingSymbol = symbolIdentity(incoming.symbol, next);
    // A root-only loading shell does not prove that a futures roll occurred.
    // Retain the still-valid dated value until a new conId/month/specific
    // symbol arrives; those verified identities still clear immediately.
    if (priorSymbol.family !== incomingSymbol.family
      || (priorSymbol.specific && incomingSymbol.specific)) return false;
  }
  return true;
}

function chartReferenceHardFailure(reference) {
  return [
    reference,
    reference?.spot,
    reference?.chart,
    ...Object.values(reference?.chart?.variants || {}),
  ].some((section) => hardLiveFailure(section));
}

function chartReferenceRefreshPending(reference, snapshotRefreshPending = false) {
  if (!reference || chartReferenceHardFailure(reference)) return false;
  const sections = [
    reference,
    reference.spot,
    reference.chart,
    ...Object.values(reference?.chart?.variants || {}),
  ];
  if (sections.some((section) => (
    ['loading', 'refreshing'].includes(String(section?.status || '').toLowerCase())
      || section?.refreshing === true
      || section?.refreshPending === true
  ))) return true;
  const issue = sections.map((section) => (
    `${section?.errorCode || ''} ${section?.refreshIssue || section?.reason || ''}`
  )).join(' ');
  return /(?:timeout|timed out|unresponsive|temporar|retry|loading|refresh|pending|checking|waiting)/i.test(issue)
    || (snapshotRefreshPending && sections.some((section) => (
      String(section?.status || '').toLowerCase() === 'unavailable'
    )));
}

function inferredChartReferenceFreshness(reference, overrides = {}) {
  const spot = reference?.spot || {};
  const chart = reference?.chart || {};
  const status = String(spot.status || chart.status || reference?.status || '').toLowerCase();
  const availability = String(spot.availability || chart.availability || '').toLowerCase();
  const inferredStatus = status === 'historical' || availability === 'historical'
    ? 'verified_historical'
    : ['available', 'partial'].includes(status)
      ? 'verified_live'
      : ['loading', 'refreshing'].includes(status)
        ? 'loading'
        : 'unavailable';
  return {
    ...(reference?.freshness || {}),
    status: inferredStatus,
    asOf: spot.asOf || chart.asOf || chart.latestAt || null,
    expiresAt: spot.expiresAt || chart.expiresAt || null,
    reason: spot.refreshIssue || spot.reason || chart.refreshIssue || chart.reason || null,
    ...overrides,
  };
}

function mergeChartReferenceDuringProgress(
  previous,
  next,
  nowMs,
  expectedHistoricalDate = null,
  snapshotRefreshPending = false,
) {
  if (!next) return next;
  if (!previous || !chartReferenceIdentityMatches(previous, next) || chartReferenceHardFailure(next)) {
    return { ...next, freshness: inferredChartReferenceFreshness(next) };
  }
  const transient = chartReferenceRefreshPending(next, snapshotRefreshPending);
  if (!transient) return { ...next, freshness: inferredChartReferenceFreshness(next) };

  const pendingSpot = next.spot && !hardLiveFailure(next.spot)
    ? { ...next.spot, refreshPending: true }
    : next.spot;
  const pendingChart = next.chart && !chartReferenceHardFailure({ chart: next.chart })
    ? markChartRefreshPending(next.chart)
    : next.chart;
  const incomingSpotVerified = verifiedDisplayReference(next.spot, nowMs, { expectedHistoricalDate });
  const priorSpotVerified = verifiedDisplayReference(previous.spot, nowMs, { expectedHistoricalDate });
  const spot = freshLiveReferenceDuringProgress(
    previous.spot,
    pendingSpot,
    nowMs,
  ) || retainHistoricalContext(
    previous.spot,
    pendingSpot,
    nowMs,
    expectedHistoricalDate,
  ) || pendingSpot;
  const chart = retainChartWhileRefreshing(
    previous.chart,
    pendingChart,
    nowMs,
    expectedHistoricalDate,
  );
  const retainedSpot = !incomingSpotVerified && priorSpotVerified && spot?.refreshRetained === true;
  const retainedChart = chart?.refreshRetained === true
    && !verifiedChartContext(next.chart, nowMs, expectedHistoricalDate);
  const delayed = retainedSpot
    || retainedChart
    || String(next?.freshness?.status || '').toLowerCase() === 'delayed';
  return {
    ...next,
    ...(delayed ? {
      symbol: previous.symbol || next.symbol,
      instrument: previous.instrument || next.instrument,
      resolver: previous.resolver || next.resolver,
      exact: previous.exact === true,
      fit: previous.fit || next.fit,
      directionalFeed: previous.directionalFeed || next.directionalFeed,
      disclosure: next.disclosure || previous.disclosure || null,
    } : {}),
    spot,
    chart,
    freshness: inferredChartReferenceFreshness({ ...next, spot, chart }, delayed ? {
      status: 'delayed',
      asOf: spot?.asOf || chart?.asOf || chart?.latestAt || previous?.freshness?.asOf || null,
      expiresAt: spot?.expiresAt || chart?.expiresAt || previous?.freshness?.expiresAt || null,
      reason: next?.spot?.refreshIssue
        || next?.spot?.reason
        || next?.chart?.refreshIssue
        || next?.chart?.reason
        || 'A fresh reference is loading; showing the last verified value.',
    } : {}),
  };
}

function mergeChartReferencesDuringProgress(
  previous,
  next,
  nowMs,
  expectedHistoricalDate = null,
  snapshotRefreshPending = false,
) {
  if (!next) return next;
  return {
    basis: mergeChartReferenceDuringProgress(
      previous?.basis,
      next.basis,
      nowMs,
      expectedHistoricalDate,
      snapshotRefreshPending,
    ),
    contract: mergeChartReferenceDuringProgress(
      previous?.contract,
      next.contract,
      nowMs,
      expectedHistoricalDate,
      snapshotRefreshPending,
    ),
  };
}

function expireChartReference(reference, nowMs, kind = 'chart reference') {
  if (!reference) return reference;
  const spot = expireLiveSection(reference.spot, nowMs, kind);
  const chart = expireChart(reference.chart, nowMs);
  return {
    ...reference,
    spot,
    chart,
    freshness: inferredChartReferenceFreshness({ ...reference, spot, chart }),
  };
}

function expireChartReferences(references, nowMs) {
  if (!references) return references;
  return {
    basis: expireChartReference(references.basis, nowMs, 'Risk Range basis reference'),
    contract: expireChartReference(references.contract, nowMs, 'contract reference'),
  };
}

function expireReferenceWithChartReferences(reference, nowMs, kind = 'resolver reference') {
  if (!reference) return reference;
  return {
    ...reference,
    spot: expireLiveSection(reference.spot, nowMs, kind),
    chart: expireChart(reference.chart, nowMs),
    ...(reference.chartReferences ? {
      chartReferences: expireChartReferences(reference.chartReferences, nowMs),
    } : {}),
  };
}

function retainDuringProgress(previous, next, nowMs, { retainOnUnavailable = false } = {}) {
  const nextStatus = String(next?.status || '').toLowerCase();
  const mayRetain = nextStatus === 'refreshing'
    || (retainOnUnavailable && nextStatus === 'unavailable');
  if (!mayRetain || !successfulAndFresh(previous, nowMs)) return next;
  return {
    ...previous,
    refreshing: nextStatus === 'refreshing',
    refreshRetained: true,
    refreshFailed: nextStatus === 'unavailable',
    refreshIssue: nextStatus === 'unavailable' ? next?.refreshIssue || next?.reason || null : null,
  };
}

function retainHistoricalContext(previous, next, nowMs, expectedHistoricalDate = null) {
  const nextStatus = String(next?.status || '').toLowerCase();
  const mayRetain = nextStatus === 'refreshing' || next?.refreshing === true || next?.refreshPending === true;
  if (!mayRetain || !verifiedDisplayReference(previous, nowMs, { expectedHistoricalDate })) return next;
  return {
    ...previous,
    refreshing: false,
    refreshPending: true,
    refreshRetained: true,
    refreshFailed: false,
    refreshIssue: null,
  };
}

function eventIdentity(section) {
  const event = section?.event;
  return String(event?.ticker || event?.eventTicker || event?.contractId || event?.generationKey || '');
}

function mergeProgressiveSnapshot(previous, next, nowMs) {
  if (!previous || previous.marketId !== next?.marketId) return next;
  const expectedHistoricalDate = expectedHistoricalDateForMarket(next.marketId, nowMs);
  const retainedLiveSpot = freshLiveReferenceDuringProgress(previous.spot, next.spot, nowMs);
  const spot = retainedLiveSpot || retainHistoricalContext(
    previous.spot,
    next.spot,
    nowMs,
    expectedHistoricalDate,
  );
  const nextResolverReference = next.resolverReference;
  const retainedResolverSpot = freshLiveReferenceDuringProgress(
    previous.resolverReference?.spot,
    nextResolverReference?.spot,
    nowMs,
  ) || retainHistoricalContext(
    previous.resolverReference?.spot,
    nextResolverReference?.spot,
    nowMs,
    expectedHistoricalDate,
  );
  const previousLastVerifiedSpot = previous.resolverReference?.lastVerifiedSpot;
  const nextLastVerifiedSpot = nextResolverReference?.lastVerifiedSpot;
  const nextResolverGenerationKey = next.venues?.forecastex?.generationKey
    || next.venues?.forecastex?.book?.event?.ticker
    || null;
  const previousLastRetainedUntil = Date.parse(previousLastVerifiedSpot?.retainedUntil || '');
  const lastVerifiedSpot = nextLastVerifiedSpot || (
    previousLastVerifiedSpot
    && Number.isFinite(previousLastRetainedUntil)
    && previousLastRetainedUntil > nowMs
    && (!nextResolverGenerationKey
      || nextResolverGenerationKey === previousLastVerifiedSpot.generationKey)
      ? previousLastVerifiedSpot
      : null
  );
  const resolverBase = nextResolverReference || (lastVerifiedSpot ? previous.resolverReference : null);
  const resolverReference = resolverBase ? {
    ...resolverBase,
    spot: retainedResolverSpot || nextResolverReference?.spot || resolverBase.spot,
    lastVerifiedSpot,
    chart: retainChartWhileRefreshing(
      previous.resolverReference?.chart,
      nextResolverReference?.chart || resolverBase.chart,
      nowMs,
      expectedHistoricalDate,
    ),
  } : nextResolverReference;
  const retainedBookVenueIds = new Set();
  const venues = Object.fromEntries([...new Set([
    ...Object.keys(previous.venues || {}),
    ...Object.keys(next.venues || {}),
  ])].map((id) => {
    const sameCpiRelease = next.marketId !== 'cpi'
      || (
        previous.forecastComparison?.releaseKey
        && previous.forecastComparison.releaseKey === next.forecastComparison?.releaseKey
      );
    const priorVenue = sameCpiRelease ? previous.venues?.[id] : null;
    const nextVenue = next.venues?.[id];
    if (!nextVenue) return [id, priorVenue];
    // A still-open public catalog is non-executable geometry and may survive a
    // localized provider miss. Native live books never receive that exception.
    const catalog = retainDuringProgress(priorVenue?.catalog, nextVenue.catalog, nowMs, {
      retainOnUnavailable: true,
    });
    const retainedBook = freshLiveBookDuringProgress(
      priorVenue?.book || priorVenue?.contracts,
      nextVenue.book || nextVenue.contracts,
      nowMs,
    );
    if (retainedBook) retainedBookVenueIds.add(id);
    let book = retainedBook || nextVenue.book || nextVenue.contracts;
    const catalogEvent = eventIdentity(catalog);
    const bookEvent = eventIdentity(book);
    if (catalogEvent && bookEvent && catalogEvent !== bookEvent) book = nextVenue.book;
    const priorGeneration = String(
      priorVenue?.generationId
      || priorVenue?.generationKey
      || eventIdentity(priorVenue?.catalog)
      || '',
    );
    // A bounded ForecastEx refresh first publishes an unavailable shell. The
    // catalog retained just above still proves which generation is being
    // refreshed, so use that identity instead of briefly treating it as a new
    // generation and dropping its verified historical reference.
    const nextGeneration = String(
      nextVenue?.generationId
      || nextVenue?.generationKey
      || eventIdentity(catalog)
      || '',
    );
    const sameGeneration = priorGeneration && nextGeneration && priorGeneration === nextGeneration;
    const nextReference = nextVenue.reference || null;
    const sameReferenceIdentity = sameGeneration
      && chartReferenceIdentityMatches(priorVenue?.reference, nextReference);
    const referenceRefreshPending = sameReferenceIdentity
      && nextVenue.backgroundRefresh === true
      && nextReference
      && nextReference?.spot?.refreshFailed !== true
      && nextReference?.chart?.refreshFailed !== true;
    const pendingReferenceSpot = referenceRefreshPending && !hardLiveFailure(nextReference.spot)
      ? { ...nextReference.spot, refreshPending: true }
      : nextReference?.spot;
    const pendingReferenceChart = referenceRefreshPending
      ? markChartRefreshPending(nextReference.chart)
      : nextReference?.chart;
    const incomingChartReferences = nextReference?.chartReferences || null;
    const chartReferences = incomingChartReferences
      ? mergeChartReferencesDuringProgress(
          sameGeneration ? priorVenue?.reference?.chartReferences : null,
          incomingChartReferences,
          nowMs,
          expectedHistoricalDate,
          referenceRefreshPending || nextVenue.backgroundRefresh === true,
        )
      : null;
    const retainedVenueReferenceSpot = sameReferenceIdentity && nextReference
      ? freshLiveReferenceDuringProgress(
          priorVenue?.reference?.spot,
          pendingReferenceSpot,
          nowMs,
        ) || retainHistoricalContext(
          priorVenue?.reference?.spot,
          pendingReferenceSpot,
          nowMs,
          expectedHistoricalDate,
        )
      : null;
    const reference = nextReference ? {
      ...nextReference,
      spot: retainedVenueReferenceSpot || pendingReferenceSpot,
      chart: sameReferenceIdentity
        ? retainChartWhileRefreshing(
            priorVenue?.reference?.chart,
            pendingReferenceChart,
            nowMs,
            expectedHistoricalDate,
          )
        : pendingReferenceChart,
      ...(chartReferences ? { chartReferences } : {}),
      ...(referenceRefreshPending ? { backgroundRefresh: true } : {}),
    } : nextReference;
    return [id, {
      ...nextVenue,
      catalog,
      book,
      contracts: book,
      reference,
      ladderSelection: nextVenue.ladderSelection || (sameGeneration ? priorVenue?.ladderSelection : null) || null,
      bookQuality: retainedBook ? priorVenue?.bookQuality : nextVenue.bookQuality,
      status: book?.status === 'available'
        ? 'available'
        : catalog?.status === 'available' ? 'partial' : nextVenue.status,
    }];
  }));
  const riskRange = retainDuringProgress(previous.riskRange, next.riskRange, nowMs, {
    retainOnUnavailable: true,
  });
  const factors = Object.fromEntries([...new Set([
    ...Object.keys(previous.factors || {}),
    ...Object.keys(next.factors || {}),
  ])].map((key) => [
    key,
    retainDuringProgress(previous.factors?.[key], next.factors?.[key], nowMs, {
      retainOnUnavailable: true,
    }),
  ]));
  const retainedFactorIds = new Set(Object.entries(factors)
    .filter(([, factor]) => factor?.refreshRetained === true)
    .map(([key]) => key));
  if (riskRange?.refreshRetained) retainedFactorIds.add('riskRange');
  const priorRows = new Map((previous.factorRows || []).map((row) => [row.id, row]));
  const factorRows = (next.factorRows || []).map((row) => (
    retainedFactorIds.has(row.id) && priorRows.has(row.id)
      ? { ...priorRows.get(row.id), refreshing: true, refreshRetained: true }
      : row
  ));
  const generationOptions = (next.generationOptions || []).map((generation) => {
    if (!retainedBookVenueIds.has(generation.venueId)) return generation;
    return (previous.generationOptions || []).find((candidate) => (
      candidate.venueId === generation.venueId
      && candidate.generationId === generation.generationId
    )) || generation;
  });
  const autoSelection = selectAutoVenue(venues, nowMs);
  const requestedSelection = {
    venue: next?.selection?.requestedVenue || 'auto',
    generationId: next?.selection?.requestedGenerationId || null,
  };
  const displaySelection = selectRequestedVenue(venues, autoSelection, requestedSelection);
  const selectedGenerationId = displaySelection.generationId
    || displaySelection.contracts?.event?.generationId
    || displaySelection.contracts?.event?.ticker
    || next.selectedGenerationId
    || null;
  const selectedGeneration = generationOptions.find((generation) => (
    generation.venueId === displaySelection.venueId
    && generation.generationId === selectedGenerationId
  )) || next.selectedGeneration || null;
  const selectedVenueReference = displaySelection.venueId
    ? venues[displaySelection.venueId]?.reference || null
    : null;
  const mirroredReference = selectedVenueReference || resolverReference;
  const incomingChartReferences = mirroredReference?.chartReferences || next.chartReferences || null;
  const chartReferences = incomingChartReferences
    ? mergeChartReferencesDuringProgress(
        previous.chartReferences || previous.resolverReference?.chartReferences,
        incomingChartReferences,
        nowMs,
        expectedHistoricalDate,
        next.sourceRefreshPending === true,
      )
    : null;
  const resolvedReference = mirroredReference && chartReferences
    ? { ...mirroredReference, chartReferences }
    : mirroredReference;
  const goldMarketReferences = next.marketId === 'gold'
    ? mergeGoldMarketReferencesDuringProgress(
        previous.goldMarketReferences,
        next.goldMarketReferences,
        nowMs,
        next.sourceRefreshPending === true,
      )
    : next.goldMarketReferences;
  return {
    ...next,
    ...(next.marketId === 'gold' ? { goldMarketReferences } : {}),
    // Completed-session references are dated research context and can be
    // retained inside their own expiry window. Live references clear on any
    // explicit provider failure or disconnect.
    spot: chartReferences?.basis?.spot || selectedVenueReference?.spot || spot,
    chart: chartReferences?.basis?.chart || selectedVenueReference?.chart || retainChartWhileRefreshing(
      previous.chart,
      next.chart,
      nowMs,
      expectedHistoricalDate,
    ),
    chartReferences,
    resolverReference: resolvedReference,
    resolverMetadata: next.resolverMetadata ? {
      ...next.resolverMetadata,
      reference: resolvedReference?.resolver || null,
    } : next.resolverMetadata,
    riskRange,
    factors,
    factorRows,
    venues,
    generationOptions,
    autoSelection,
    displaySelection,
    selectedVenueId: displaySelection.venueId,
    selectedGenerationId,
    selectedGeneration,
    productActivity: displaySelection.venueId && venues[displaySelection.venueId]
      ? venues[displaySelection.venueId].activity || null
      : null,
    displayContracts: displaySelection.contracts,
    contracts: displaySelection.contracts,
    executionContracts: autoSelection.contracts,
  };
}

function failStalledPendingSection(section, reason, { clearBook = false, clearChart = false } = {}) {
  if (!section || (
    section.status !== 'refreshing'
    && section.refreshing !== true
    && section.refreshPending !== true
  )) return section;
  const retainedContext = section.refreshRetained === true
    && ['available', 'historical', 'partial'].includes(String(section.status || '').toLowerCase());
  if (retainedContext) {
    return {
      ...section,
      refreshing: false,
      refreshPending: false,
      refreshRetained: false,
      refreshFailed: false,
      refreshDelayed: true,
      refreshIssue: reason,
      errorCode: 'PM_SOURCE_REFRESH_TIMEOUT',
    };
  }
  return {
    ...section,
    status: 'unavailable',
    source: null,
    asOf: null,
    expiresAt: null,
    reason,
    refreshing: false,
    refreshPending: false,
    refreshRetained: false,
    refreshFailed: true,
    refreshIssue: reason,
    errorCode: 'PM_SOURCE_REFRESH_TIMEOUT',
    ...(clearBook ? { lines: [] } : {}),
    ...(clearChart ? {
      availability: 'unavailable', points: [], references: [], rangeDates: [], dailyRanges: [],
    } : {}),
  };
}

function failStalledChartReference(reference, reason) {
  if (!reference) return reference;
  const spot = failStalledPendingSection(reference.spot, reason);
  const chartVariants = Object.fromEntries(Object.entries(reference?.chart?.variants || {}).map(([range, variant]) => [
    range,
    failStalledPendingSection(variant, reason, { clearChart: true }),
  ]));
  const chartRoot = failStalledPendingSection(reference.chart, reason, { clearChart: true });
  const oneDay = chartVariants['1d'] || chartRoot;
  const chart = oneDay && Object.keys(chartVariants).length ? {
    ...oneDay,
    variants: {
      '1d': oneDay,
      '5d': chartVariants['5d'] || unavailable(reason, { range: '5d', points: [] }),
      '10d': chartVariants['10d'] || unavailable(reason, { range: '10d', points: [] }),
    },
  } : chartRoot;
  const delayed = spot?.refreshDelayed === true || chart?.refreshDelayed === true;
  return {
    ...reference,
    spot,
    chart,
    freshness: inferredChartReferenceFreshness({ ...reference, spot, chart }, delayed ? {
      status: 'delayed',
      reason,
    } : {}),
  };
}

function failStalledRefreshes(snapshot) {
  const reason = 'Source refresh did not complete within the bounded retry window.';
  const venues = Object.fromEntries(Object.entries(snapshot?.venues || {}).map(([id, venue]) => {
    const catalog = failStalledPendingSection(venue.catalog, reason);
    const book = failStalledPendingSection(venue.book || venue.contracts, reason, { clearBook: true });
    return [id, {
      ...venue,
      catalog,
      book,
      contracts: book,
      status: book?.status === 'available' ? 'available' : catalog?.status === 'available' ? 'partial' : 'unavailable',
      backgroundRefresh: false,
    }];
  }));
  const chartVariants = Object.fromEntries(Object.entries(snapshot?.chart?.variants || {}).map(([range, variant]) => [
    range,
    failStalledPendingSection(variant, reason, { clearChart: true }),
  ]));
  const chartRoot = failStalledPendingSection(snapshot?.chart, reason, { clearChart: true });
  const oneDay = chartVariants['1d'] || chartRoot;
  const chart = oneDay ? {
    ...oneDay,
    variants: {
      '1d': oneDay,
      '5d': chartVariants['5d'] || unavailable(reason, { range: '5d', points: [], references: [], rangeDates: [], dailyRanges: [] }),
      '10d': chartVariants['10d'] || unavailable(reason, { range: '10d', points: [], references: [], rangeDates: [], dailyRanges: [] }),
    },
  } : chartRoot;
  const sourceHealth = (snapshot?.sourceHealth || []).map((source) => source.status === 'refreshing' ? {
    ...source,
    status: 'refresh_failed',
    errorCode: 'PM_SOURCE_REFRESH_TIMEOUT',
    reason,
  } : source);
  const chartReferences = snapshot?.chartReferences ? {
    basis: failStalledChartReference(snapshot.chartReferences.basis, reason),
    contract: failStalledChartReference(snapshot.chartReferences.contract, reason),
  } : null;
  const resolverReference = snapshot?.resolverReference && chartReferences
    ? { ...snapshot.resolverReference, chartReferences }
    : snapshot?.resolverReference;
  return {
    ...snapshot,
    spot: chartReferences?.basis?.spot || failStalledPendingSection(snapshot?.spot, reason),
    chart: chartReferences?.basis?.chart || chart,
    chartReferences,
    resolverReference,
    riskRange: failStalledPendingSection(snapshot?.riskRange, reason),
    factors: Object.fromEntries(Object.entries(snapshot?.factors || {}).map(([id, factor]) => [
      id,
      failStalledPendingSection(factor, reason),
    ])),
    venues,
    sourceHealth,
    sourceRefreshPending: false,
    errors: [...(snapshot?.errors || []), { source: 'refresh_coordinator', code: 'PM_SOURCE_REFRESH_TIMEOUT', message: reason }],
  };
}

function createMarketMonitorCoordinator({
  monitorService,
  marketIds = MARKET_IDS,
  scheduledMarketIds = marketIds,
  now = () => new Date(),
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
  activePollMs = DEFAULT_ACTIVE_POLL_MS,
  logger = console,
} = {}) {
  if (!monitorService || typeof monitorService.getSnapshot !== 'function') {
    throw new TypeError('monitorService.getSnapshot is required');
  }
  const createState = () => ({
    snapshot: null,
    inFlight: null,
    revision: 0,
    startedAt: null,
    completedAt: null,
    lastSuccessAt: null,
    lastError: null,
    consecutivePending: 0,
    nextSourceRefreshAt: 0,
    selection: { venue: 'auto', generationId: null },
    createdAtMs: Date.now(),
    lastAccessAtMs: Date.now(),
  });
  const states = new Map(marketIds.map((marketId) => [marketId, createState()]));
  const scheduledMarkets = new Set((Array.isArray(scheduledMarketIds) ? scheduledMarketIds : marketIds)
    .filter((marketId) => marketIds.includes(marketId)));
  let stopped = false;
  let prewarmPromise = null;
  let schedulerTimer = null;

  function currentMs() {
    const value = now();
    return value instanceof Date ? value.getTime() : Number(value);
  }

  function normalizeSelection(selection = {}) {
    const venue = ['kalshi', 'forecastex'].includes(String(selection?.venue || '').trim().toLowerCase())
      ? String(selection.venue).trim().toLowerCase()
      : 'auto';
    const generationId = String(selection?.generationId || '').trim() || null;
    return { venue, generationId };
  }

  function stateKey(marketId, selection = {}) {
    const normalized = normalizeSelection(selection);
    if (marketId === 'sp500' && normalized.venue === 'forecastex' && !normalized.generationId) return marketId;
    // Fixed Kalshi cards reuse their startup-prewarmed state instead of
    // allocating a second cold snapshot after a hard reload. Their active
    // generation remains server-owned and rolls inside that canonical state.
    if (['cpi', 'gold'].includes(marketId) && normalized.venue === 'kalshi' && !normalized.generationId) return marketId;
    return normalized.venue === 'auto' && !normalized.generationId
      ? marketId
      : `${marketId}|${normalized.venue}|${normalized.generationId || 'default'}`;
  }

  function stateFor(marketId, selection = {}, { create = true } = {}) {
    if (!marketIds.includes(marketId)) return null;
    const key = stateKey(marketId, selection);
    let state = states.get(key);
    if (!state && create) {
      if (states.size >= marketIds.length + MAX_COMPATIBILITY_STATES) return null;
      const normalized = normalizeSelection(selection);
      if (normalized.generationId) {
        const published = stateFor(marketId, {}, { create: false })?.snapshot?.generationOptions || [];
        const validGeneration = published.some((generation) => (
          generation?.venueId === normalized.venue
          && generation?.generationId === normalized.generationId
        ));
        if (!validGeneration) return null;
      }
      state = createState();
      state.selection = normalized;
      states.set(key, state);
    }
    if (state) state.lastAccessAtMs = currentMs();
    return state || null;
  }

  function refreshMetadata(state) {
    const rapidPending = state.snapshot?.sourceRefreshPending === true;
    return {
      state: state.inFlight || rapidPending ? 'refreshing' : state.lastError ? 'error' : 'idle',
      revision: state.revision,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      lastError: state.lastError ? { ...state.lastError } : null,
      suggestedNextPollMs: state.inFlight || rapidPending ? activePollMs : refreshIntervalMs,
    };
  }

  function decorate(snapshot, state) {
    const nowMs = currentMs();
    const safe = sanitizeCachedSnapshot(snapshot, nowMs);
    if (!state.inFlight) return {
      ...safe,
      revision: state.revision,
      refreshPending: safe?.sourceRefreshPending === true,
      refresh: refreshMetadata(state),
    };
    const retainSection = (section) => {
      if (!section || typeof section !== 'object') return section;
      const usable = ['available', 'historical', 'partial'].includes(String(section.status || '').toLowerCase());
      const terminal = terminalUnavailableSection(section);
      if (usable) return { ...section, refreshing: false, refreshPending: true, refreshRetained: true };
      if (terminal) return { ...section, refreshing: false, refreshPending: false };
      return { ...section, status: 'refreshing', refreshing: true, refreshPending: true };
    };
    const chart = retainSection(safe.chart);
    if (chart?.variants) {
      chart.variants = Object.fromEntries(Object.entries(chart.variants).map(([range, variant]) => [
        range,
        retainSection(variant),
      ]));
    }
    const retainChartReference = (reference) => {
      if (!reference) return reference;
      const retainedSpot = retainSection(reference.spot);
      const retainedChart = retainSection(reference.chart);
      if (retainedChart?.variants) {
        retainedChart.variants = Object.fromEntries(Object.entries(retainedChart.variants).map(([range, variant]) => [
          range,
          retainSection(variant),
        ]));
      }
      const retained = retainedSpot?.refreshRetained === true || retainedChart?.refreshRetained === true;
      return {
        ...reference,
        spot: retainedSpot,
        chart: retainedChart,
        freshness: inferredChartReferenceFreshness({ ...reference, spot: retainedSpot, chart: retainedChart }, retained ? {
          status: 'delayed',
          reason: 'A fresh reference is loading; showing the last verified value.',
        } : {}),
      };
    };
    const chartReferences = safe.chartReferences ? {
      basis: retainChartReference(safe.chartReferences.basis),
      contract: retainChartReference(safe.chartReferences.contract),
    } : null;
    const resolverReference = safe.resolverReference && chartReferences
      ? { ...safe.resolverReference, chartReferences }
      : safe.resolverReference;
    const goldMarketReferences = safe?.marketId === 'gold'
      ? (safe.goldMarketReferences || []).map((reference) => (
          verifiedGoldMarketReference(reference, nowMs)
            ? delayedGoldMarketReference(reference, {
                status: 'loading',
                reason: 'A fresh Gold reference is loading.',
              })
            : reference
        ))
      : safe?.goldMarketReferences;
    return {
      ...safe,
      revision: state.revision,
      refreshPending: true,
      spot: chartReferences?.basis?.spot || retainSection(safe.spot),
      chart: chartReferences?.basis?.chart || chart,
      chartReferences,
      resolverReference,
      riskRange: retainSection(safe.riskRange),
      ...(safe?.marketId === 'gold' ? { goldMarketReferences } : {}),
      refresh: refreshMetadata(state),
    };
  }

  function refresh(marketId, selection = {}) {
    const state = stateFor(marketId, selection);
    if (!state) return Promise.reject(Object.assign(new Error(`Unsupported prediction-market monitor: ${marketId}`), { code: 'PM_MONITOR_UNSUPPORTED_MARKET' }));
    if (state.inFlight) return state.inFlight;
    if (stopped) return Promise.resolve(state.snapshot);
    state.startedAt = isoNow(now);
    const request = nextTurn()
      .then(() => monitorService.getSnapshot(marketId, state.selection))
      .then((snapshot) => {
        if (!snapshot || snapshot.schemaVersion !== 2 || snapshot.marketId !== marketId) {
          throw Object.assign(new Error(`Monitor service returned an invalid ${marketId} snapshot.`), {
            code: 'PM_MONITOR_SNAPSHOT_INVALID',
          });
        }
        // Publish one atomic revision after applying the coordinator's
        // provenance- and expiry-aware progressive merge. This retains only
        // still-valid research/history while a bounded refresh is pending;
        // live books and quotes still clear immediately on hard failures.
        state.snapshot = state.snapshot
          ? mergeProgressiveSnapshot(state.snapshot, snapshot, currentMs())
          : snapshot;
        state.revision += 1;
        state.lastSuccessAt = isoNow(now);
        state.lastError = null;
        if (state.snapshot.sourceRefreshPending === true) {
          state.consecutivePending += 1;
          if (state.consecutivePending >= MAX_CONSECUTIVE_PENDING_REFRESHES) {
            state.snapshot = failStalledRefreshes(state.snapshot);
            state.consecutivePending = 0;
            state.nextSourceRefreshAt = 0;
            return state.snapshot;
          }
          const backoffMs = Math.min(
            refreshIntervalMs,
            MAX_PENDING_BACKOFF_MS,
            activePollMs * (2 ** Math.min(Math.max(0, state.consecutivePending - 1), 5)),
          );
          state.nextSourceRefreshAt = currentMs() + backoffMs;
        } else {
          state.consecutivePending = 0;
          state.nextSourceRefreshAt = 0;
        }
        return state.snapshot;
      })
      .catch((error) => {
        const message = String(error?.message || error || 'Monitor refresh failed.').slice(0, 240);
        state.lastError = {
          code: error?.code || 'PM_MONITOR_REFRESH_FAILED',
          message,
          at: isoNow(now),
        };
        if (state.snapshot) {
          const retained = sanitizeCachedSnapshot(state.snapshot, currentMs());
          state.snapshot = {
            ...retained,
            sourceRefreshPending: false,
            errors: [
              ...(Array.isArray(retained.errors) ? retained.errors : []),
              { source: 'refresh_coordinator', code: state.lastError.code, message },
            ],
          };
        }
        logger?.error?.(`[Prediction Monitor] ${marketId}/${state.selection.venue}/${state.selection.generationId || 'default'} background refresh failed:`, error);
        return state.snapshot;
      })
      .finally(() => {
        state.completedAt = isoNow(now);
        state.inFlight = null;
      });
    state.inFlight = request;
    return request;
  }

  function getSnapshot(marketId, selection = {}) {
    const state = stateFor(marketId, selection);
    if (!state) {
      throw Object.assign(new Error(`Unsupported prediction-market monitor selection: ${marketId}`), {
        code: marketIds.includes(marketId) ? 'PM_MONITOR_SELECTION_UNPUBLISHED' : 'PM_MONITOR_UNSUPPORTED_MARKET',
        status: 400,
      });
    }
    // Deliberately pure: monitor reads never call a provider or enqueue work.
    // The background scheduler is the only owner of refresh side effects.
    return decorate(state.snapshot || buildMonitorSkeleton(marketId, now), state);
  }

  function disconnectedSnapshot(snapshot) {
    const text = (snapshot?.sourceHealth || []).map((entry) => (
      `${entry?.id || ''} ${entry?.status || ''} ${entry?.reason || ''}`
    )).join(' ');
    return /(?:ibkr|broker|gateway).*(?:disconnect|offline|not connected|unavailable)/i.test(text);
  }

  function stateIsDue(state, nowMs) {
    if (state.inFlight) return false;
    if (!state.snapshot) return true;
    const completedMs = Date.parse(state.completedAt || '');
    const interval = disconnectedSnapshot(state.snapshot)
      ? DISCONNECTED_REFRESH_INTERVAL_MS
      : state.snapshot.sourceRefreshPending === true
        ? activePollMs
        : refreshIntervalMs;
    return !Number.isFinite(completedMs)
      || nowMs - completedMs >= interval
      || (snapshotHasExpiredLiveData(state.snapshot, nowMs)
        && nowMs - completedMs >= Math.min(interval, activePollMs))
      || (state.snapshot.sourceRefreshPending === true && nowMs >= state.nextSourceRefreshAt);
  }

  function scheduleTick(delayMs = 250) {
    if (stopped || schedulerTimer) return;
    schedulerTimer = setTimeout(() => {
      schedulerTimer = null;
      if (stopped) return;
      const nowMs = currentMs();
      [...states.entries()].forEach(([key, state]) => {
        const marketId = key.split('|')[0];
        if (scheduledMarkets.has(marketId) && stateIsDue(state, nowMs)) void refresh(marketId, state.selection);
      });
      scheduleTick(250);
    }, delayMs);
    schedulerTimer.unref?.();
  }

  function start() {
    stopped = false;
    if (!prewarmPromise) {
      const startupOrder = ['gold', 'silver', 'wti', 'brent', 'bitcoin', 'cpi', 'sp500', 'nasdaq100']
        .filter((marketId) => marketIds.includes(marketId) && scheduledMarkets.has(marketId));
      prewarmPromise = Promise.allSettled(startupOrder.map((marketId) => refresh(marketId))).finally(() => {
        prewarmPromise = null;
      });
    }
    scheduleTick(50);
    return true;
  }

  function stop() {
    stopped = true;
    if (schedulerTimer) clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }

  function getHealth() {
    const nowMs = currentMs();
    const defaultStates = marketIds.map((marketId) => [marketId, stateFor(marketId, {})]);
    return Object.fromEntries(defaultStates.map(([marketId, state]) => {
      const generatedMs = Date.parse(state.snapshot?.generatedAt || '');
      const selections = [...states.entries()].filter(([key]) => key === marketId || key.startsWith(`${marketId}|`));
      return [marketId, {
        pipelineEnabled: scheduledMarkets.has(marketId),
        state: state.inFlight ? 'refreshing' : state.lastError && !state.snapshot ? 'error' : state.snapshot ? 'ready' : 'not_started',
        revision: state.revision,
        cacheAgeMs: Number.isFinite(generatedMs) ? Math.max(0, nowMs - generatedMs) : null,
        inFlight: Boolean(state.inFlight),
        startedAt: state.startedAt,
        completedAt: state.completedAt,
        lastSuccessAt: state.lastSuccessAt,
        lastError: state.lastError,
        sourceErrors: Array.isArray(state.snapshot?.errors) ? state.snapshot.errors : [],
        sourceHealth: Array.isArray(state.snapshot?.sourceHealth) ? state.snapshot.sourceHealth : [],
        selectionCount: selections.length,
        compatibilityStateLimit: MAX_COMPATIBILITY_STATES,
        selections: selections.map(([key, candidate]) => ({
          key,
          selection: candidate.selection,
          state: candidate.inFlight ? 'refreshing' : candidate.lastError ? 'error' : candidate.snapshot ? 'ready' : 'not_started',
          inFlight: Boolean(candidate.inFlight),
          lastSuccessAt: candidate.lastSuccessAt,
          lastError: candidate.lastError,
        })),
      }];
    }));
  }

  return { getHealth, getSnapshot, refresh, start, stop };
}

module.exports = {
  DEFAULT_ACTIVE_POLL_MS,
  DEFAULT_REFRESH_INTERVAL_MS,
  MAX_CONSECUTIVE_PENDING_REFRESHES,
  MAX_COMPATIBILITY_STATES,
  buildMonitorSkeleton,
  createMarketMonitorCoordinator,
  mergeProgressiveSnapshot,
  failStalledRefreshes,
  clearLiveTradingSnapshot,
  sanitizeCachedSnapshot,
};
