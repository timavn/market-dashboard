import { isRefreshDelayedVolatilityRow } from './volatilitySnapshotRows';

const NEW_YORK_TIME_ZONE = 'America/New_York';
const LIVE_RESPONSE_MAX_AGE_MS = 120000;
const FUTURE_CLOCK_TOLERANCE_MS = 15000;

const BLOCKED_PROVENANCE = /(?:^|[\s_-])(stale|cache(?:d|_only|-only)?|mock|seed|fallback|offline|disconnected|synthetic|inferred|derived)(?:$|[\s_-])/i;

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boundedProbability(value) {
  const number = finiteNumber(value);
  return number != null && number >= 0 && number <= 1 ? number : null;
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value);
  return number != null && number >= 0 ? number : null;
}

function firstFinite(...values) {
  for (const value of values) {
    const number = finiteNumber(value);
    if (number != null) return number;
  }
  return null;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null) ?? null;
}

export function normalizeWtiCadence(value) {
  return String(value || '').toLowerCase() === 'weekly' ? 'weekly' : 'daily';
}

export function expectedWtiSeries(cadence) {
  return normalizeWtiCadence(cadence) === 'weekly' ? 'KXWTIW' : 'KXWTI';
}

export function dateKeyInNewYork(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NEW_YORK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year && values.month && values.day
    ? `${values.year}-${values.month}-${values.day}`
    : null;
}

export function wtiEventDate(event = {}) {
  return dateKeyInNewYork(event.strikeDate || event.eventDate || event.observationTime || event.closeTime || event.settlementTime);
}

function normalizeInclusive(raw, edge) {
  const direct = firstDefined(
    raw?.[`${edge}Inclusive`],
    raw?.inclusivity?.[edge],
    raw?.bounds?.[`${edge}Inclusive`],
  );
  return typeof direct === 'boolean' ? direct : null;
}

function normalizeGeometry(raw = {}, cadence = 'daily') {
  const normalizedCadence = normalizeWtiCadence(cadence);
  const geometrySource = raw.geometry && typeof raw.geometry === 'object' ? raw.geometry : raw;
  const rawGeometry = String(
    geometrySource.kind || geometrySource.geometry || geometrySource.type || geometrySource.strikeType || '',
  ).toLowerCase();
  const geometry = rawGeometry === 'between' || rawGeometry === 'bucket'
    ? 'between'
    : rawGeometry === 'below' || rawGeometry === 'less_than' || rawGeometry === 'lower_tail' || rawGeometry === 'less'
      ? 'below'
      : rawGeometry === 'above' || rawGeometry === 'greater_than' || rawGeometry === 'upper_tail' || rawGeometry === 'greater' || normalizedCadence === 'daily'
        ? 'above'
        : null;
  const threshold = firstFinite(geometrySource.threshold, raw.threshold, raw.strike, raw.strikeValue);
  const lower = firstFinite(
    geometrySource.lower,
    geometrySource.lowerBound,
    raw.lower,
    raw.lowerBound,
    raw.floor,
    geometry === 'above' ? threshold : null,
  );
  const upper = firstFinite(
    geometrySource.upper,
    geometrySource.upperBound,
    raw.upper,
    raw.upperBound,
    raw.ceiling,
    geometry === 'below' ? threshold : null,
  );

  if (normalizedCadence === 'daily') {
    if (geometry !== 'above' || threshold == null) return null;
    return {
      geometry: 'above',
      threshold,
      lower: threshold,
      upper: null,
      lowerInclusive: false,
      upperInclusive: null,
      operator: '>',
    };
  }

  if (geometry === 'between' && lower != null && upper != null && lower < upper) {
    return {
      geometry,
      threshold: null,
      lower,
      upper,
      lowerInclusive: normalizeInclusive(geometrySource, 'lower'),
      upperInclusive: normalizeInclusive(geometrySource, 'upper'),
      operator: null,
    };
  }
  if (geometry === 'below' && upper != null) {
    return {
      geometry,
      threshold: upper,
      lower: null,
      upper,
      lowerInclusive: null,
      upperInclusive: normalizeInclusive(geometrySource, 'upper'),
      operator: null,
    };
  }
  if (geometry === 'above' && lower != null) {
    return {
      geometry,
      threshold: lower,
      lower,
      upper: null,
      lowerInclusive: normalizeInclusive(geometrySource, 'lower'),
      upperInclusive: null,
      operator: null,
    };
  }
  return null;
}

function marketProvenanceBlocked(raw = {}) {
  const provenance = [
    raw.source,
    raw.sourceApi,
    raw.source_api,
    raw.quoteSource,
    raw.quoteStatus,
    raw.freshness,
    raw.warning,
  ].filter(Boolean).join(' ');
  return BLOCKED_PROVENANCE.test(provenance);
}

export function normalizeWtiMarket(raw = {}, cadence = 'daily', { historical = false } = {}) {
  const ticker = String(raw.ticker || raw.marketTicker || '').trim().toUpperCase();
  const eventTicker = String(raw.eventTicker || raw.event_ticker || '').trim().toUpperCase() || null;
  const geometry = normalizeGeometry(raw, cadence);
  if (!ticker || !geometry) return null;

  const normalized = {
    ...geometry,
    ticker,
    eventTicker,
    title: raw.title || raw.subtitle || null,
    closeTime: raw.closeTime || raw.close_time || null,
    status: raw.status || null,
    rulesPrimary: raw.rulesPrimary || raw.rules_primary || null,
    rulesSecondary: raw.rulesSecondary || raw.rules_secondary || null,
    volume24h: nonNegativeNumber(firstDefined(raw.volume24h, raw.volume_24h)),
    volumeTotal: nonNegativeNumber(firstDefined(raw.volumeTotal, raw.volume_total, raw.volume)),
    openInterest: nonNegativeNumber(firstDefined(raw.openInterest, raw.open_interest)),
    result: raw.result ? String(raw.result).toLowerCase() : null,
    settlementPayout: boundedProbability(firstDefined(raw.settlementPayout, raw.settlement_payout)),
    nativeBookComplete: typeof raw.nativeBook?.complete === 'boolean' ? raw.nativeBook.complete : null,
    nativeBook: raw.nativeBook && typeof raw.nativeBook === 'object' ? {
      yesPrices: raw.nativeBook.yesPrices === true,
      noPrices: raw.nativeBook.noPrices === true,
      yesDepth: raw.nativeBook.yesDepth === true,
      noDepth: raw.nativeBook.noDepth === true,
      complete: raw.nativeBook.complete === true,
      derivedFields: Array.isArray(raw.nativeBook.derivedFields) ? raw.nativeBook.derivedFields : [],
    } : null,
  };

  if (historical) return normalized;

  const blocked = marketProvenanceBlocked(raw);
  return {
    ...normalized,
    yesBid: blocked ? null : boundedProbability(firstDefined(raw.yesBid, raw.yes_bid)),
    yesAsk: blocked ? null : boundedProbability(firstDefined(raw.yesAsk, raw.yes_ask)),
    yesBidSize: blocked ? null : nonNegativeNumber(firstDefined(raw.yesBidSize, raw.yes_bid_size)),
    yesAskSize: blocked ? null : nonNegativeNumber(firstDefined(raw.yesAskSize, raw.yes_ask_size)),
    noBid: blocked ? null : boundedProbability(firstDefined(raw.noBid, raw.no_bid)),
    noAsk: blocked ? null : boundedProbability(firstDefined(raw.noAsk, raw.no_ask)),
    noBidSize: blocked ? null : nonNegativeNumber(firstDefined(raw.noBidSize, raw.no_bid_size)),
    noAskSize: blocked ? null : nonNegativeNumber(firstDefined(raw.noAskSize, raw.no_ask_size)),
    nativeBookAvailable: !blocked,
  };
}

export function hasCompleteNativeWtiBook(market = {}) {
  const directCore = [market.yesBid, market.yesAsk, market.noBid, market.noAsk]
    .every((value) => boundedProbability(value) != null)
    && [market.yesBidSize, market.yesAskSize]
      .every((value) => finiteNumber(value) != null && Number(value) > 0)
    && market.yesBid <= market.yesAsk
    && market.noBid <= market.noAsk;
  if (!directCore) return false;
  if (Array.isArray(market.nativeBook?.derivedFields) && market.nativeBook.derivedFields.length > 0) return false;
  if (market.nativeBookComplete === false || market.nativeBook?.complete === false) return false;
  return true;
}

function marketSortValue(market) {
  if (market.geometry === 'below') return Number.NEGATIVE_INFINITY;
  return firstFinite(market.lower, market.threshold, market.upper) ?? Number.POSITIVE_INFINITY;
}

function normalizeSettlementMapping(raw = {}) {
  const status = String(raw.status || 'unavailable').toLowerCase();
  const available = ['available', 'verified', 'consistent', 'consistent_unverified'].includes(status);
  return {
    status: available ? status : 'unavailable',
    contractLabel: raw.contractLabel || raw.frontMonthContract || raw.front_month_contract || null,
    contractMonth: raw.contractMonth || raw.contract_month || null,
    observation: raw.observation || raw.observationMethod || raw.observationTime || null,
    unit: raw.unit || raw.units || null,
    precision: raw.precision ?? raw.precisionDecimals ?? null,
    rollConvention: raw.rollConvention || raw.roll_convention || null,
    reason: raw.reason || (available ? null : 'The exact ICE settlement mapping is unavailable or inconsistent.'),
    proxyCalibrationAvailable: available && (raw.proxyCalibrationAvailable === true || raw.calibrationAvailable === true),
  };
}

function normalizeEvent(raw = {}, seriesTicker, cadence) {
  const ticker = String(raw.ticker || raw.eventTicker || '').trim().toUpperCase();
  return {
    ticker,
    seriesTicker: String(raw.seriesTicker || seriesTicker || '').trim().toUpperCase(),
    title: raw.title || `${normalizeWtiCadence(cadence) === 'weekly' ? 'Weekly' : 'Daily'} WTI settlement`,
    status: raw.status || null,
    closeTime: raw.closeTime || raw.close_time || null,
    strikeDate: raw.strikeDate || raw.strike_date || raw.eventDate || null,
    eventDate: raw.eventDate || raw.strikeDate || raw.strike_date || null,
    observationTime: raw.observationTime || null,
    expectedExpirationTime: raw.expectedExpirationTime || null,
    availableOnBrokers: raw.availableOnBrokers === true,
    totalMarketCount: finiteNumber(raw.totalMarketCount),
    quotedMarketCount: finiteNumber(raw.quotedMarketCount),
    settlementSource: raw.settlementSource || null,
  };
}

function blockedPayloadProvenance(payload = {}) {
  const text = [
    payload.source,
    payload.sourceApi,
    payload.source_api,
    payload.provider?.source,
    payload.provider?.status,
    payload.provider?.warning,
    payload.freshness,
    payload.warning,
  ].filter(Boolean).join(' ');
  return BLOCKED_PROVENANCE.test(text);
}

export function normalizeWtiWorkbench(payload, cadence = 'daily', now = Date.now()) {
  const normalizedCadence = normalizeWtiCadence(cadence);
  const expectedSeries = expectedWtiSeries(normalizedCadence);
  const seriesTicker = String(
    payload?.seriesTicker || payload?.event?.seriesTicker || expectedSeries,
  ).toUpperCase();
  const event = normalizeEvent(payload?.event, seriesTicker, normalizedCadence);
  const fetchedAtMs = Date.parse(payload?.fetchedAt || '');
  const ageMs = now - fetchedAtMs;
  const exactSeries = seriesTicker === expectedSeries
    && event.seriesTicker === expectedSeries
    && event.ticker.startsWith(`${expectedSeries}-`);
  const current = Number.isFinite(fetchedAtMs)
    && ageMs >= -FUTURE_CLOCK_TOLERANCE_MS
    && ageMs <= LIVE_RESPONSE_MAX_AGE_MS;
  const providerStatus = String(payload?.provider?.status || '').toLowerCase();
  const providerAvailable = !providerStatus || ['live', 'current', 'available'].includes(providerStatus);

  if (
    !payload?.ok
    || payload?.historicalOnly === true
    || payload?.executable === true
    || !exactSeries
    || !current
    || !providerAvailable
    || blockedPayloadProvenance(payload)
  ) {
    return {
      ok: false,
      reason: !current ? 'stale_or_missing_snapshot' : !exactSeries ? 'wrong_series' : 'unavailable_live_snapshot',
      data: null,
    };
  }

  const markets = (Array.isArray(payload.markets) ? payload.markets : [])
    .map((market) => normalizeWtiMarket(market, normalizedCadence))
    .filter((market) => market && (!market.eventTicker || market.eventTicker === event.ticker))
    .sort((left, right) => marketSortValue(left) - marketSortValue(right));
  const hasDirectNativePrice = markets.some((market) => (
    [market.yesBid, market.yesAsk, market.noBid, market.noAsk]
      .some((value) => boundedProbability(value) != null)
  ));
  if (!markets.length || !hasDirectNativePrice) {
    return { ok: false, reason: 'no_direct_native_book', data: null };
  }

  return {
    ok: true,
    reason: null,
    data: {
      ...payload,
      marketType: normalizedCadence,
      seriesTicker: expectedSeries,
      fetchedAt: payload.fetchedAt,
      historicalOnly: false,
      executable: false,
      event,
      settlementMapping: normalizeSettlementMapping(payload.settlementMapping),
      markets,
      policy: {
        ...(payload.policy || {}),
        researchOnly: true,
        recommendationAvailable: false,
        orderEntryAvailable: false,
      },
    },
  };
}

export function resolveWtiMarketAtValue(market = {}, value) {
  const settlement = finiteNumber(value);
  if (settlement == null) return null;
  if (market.geometry === 'above') {
    const boundary = firstFinite(market.lower, market.threshold);
    if (boundary == null) return null;
    if (market.operator === '>') return settlement > boundary ? 'yes' : 'no';
    if (settlement === boundary && market.lowerInclusive == null) return null;
    return market.lowerInclusive ? (settlement >= boundary ? 'yes' : 'no') : (settlement > boundary ? 'yes' : 'no');
  }
  if (market.geometry === 'below') {
    const boundary = firstFinite(market.upper, market.threshold);
    if (boundary == null) return null;
    if (settlement === boundary && market.upperInclusive == null) return null;
    return market.upperInclusive ? (settlement <= boundary ? 'yes' : 'no') : (settlement < boundary ? 'yes' : 'no');
  }
  if (market.geometry === 'between') {
    const lower = finiteNumber(market.lower);
    const upper = finiteNumber(market.upper);
    if (lower == null || upper == null || lower >= upper) return null;
    if ((settlement === lower && market.lowerInclusive == null) || (settlement === upper && market.upperInclusive == null)) return null;
    const aboveLower = market.lowerInclusive ? settlement >= lower : settlement > lower;
    const belowUpper = market.upperInclusive ? settlement <= upper : settlement < upper;
    return aboveLower && belowUpper ? 'yes' : 'no';
  }
  return null;
}

function geometryIdentity(market) {
  return [
    market.geometry,
    market.lower,
    market.upper,
    market.threshold,
    market.lowerInclusive,
    market.upperInclusive,
    market.operator,
  ].join('|');
}

export function normalizeSettledWtiSession(payload, cadence = 'daily') {
  const normalizedCadence = normalizeWtiCadence(cadence);
  const expectedSeries = expectedWtiSeries(normalizedCadence);
  const seriesTicker = String(payload?.seriesTicker || payload?.event?.seriesTicker || expectedSeries).toUpperCase();
  const event = normalizeEvent(payload?.event, seriesTicker, normalizedCadence);
  const settlementValue = firstFinite(payload?.settlementValue, payload?.settlement_value, payload?.closeValue);
  const settlementMapping = normalizeSettlementMapping(payload?.settlementMapping);
  const finalStatus = String(event.status || '').toLowerCase();
  if (
    payload?.historicalOnly !== true
    || payload?.executable !== false
    || seriesTicker !== expectedSeries
    || event.seriesTicker !== expectedSeries
    || !event.ticker.startsWith(`${expectedSeries}-`)
    || settlementValue == null
    || settlementMapping.status === 'unavailable'
    || (finalStatus && !['settled', 'final', 'closed', 'determined'].includes(finalStatus))
  ) return null;

  const seen = new Set();
  const markets = [];
  for (const rawMarket of Array.isArray(payload.markets) ? payload.markets : []) {
    const market = normalizeWtiMarket(rawMarket, normalizedCadence, { historical: true });
    if (!market || (market.eventTicker && market.eventTicker !== event.ticker)) return null;
    const result = String(market.result || '').toLowerCase();
    const expectedResult = resolveWtiMarketAtValue(market, settlementValue);
    const expectedPayout = result === 'yes' ? 1 : result === 'no' ? 0 : null;
    if (!['yes', 'no'].includes(result) || expectedPayout !== market.settlementPayout) return null;
    if (expectedResult && expectedResult !== result) return null;
    const identity = geometryIdentity(market);
    if (seen.has(identity)) return null;
    seen.add(identity);
    markets.push(market);
  }
  if (!markets.length) return null;

  return {
    ...payload,
    ok: true,
    marketType: normalizedCadence,
    seriesTicker: expectedSeries,
    historicalOnly: true,
    executable: false,
    event,
    settlementValue,
    settlementTime: payload.settlementTime || payload.settlement_time || event.closeTime,
    settlementMapping,
    markets: markets.sort((left, right) => marketSortValue(left) - marketSortValue(right)),
    policy: {
      historicalOnly: true,
      executable: false,
      quotesAvailable: false,
      researchOnly: true,
      recommendationAvailable: false,
      orderEntryAvailable: false,
    },
  };
}

export function normalizeRecentSettledWtiSessions(payload, cadence = 'daily') {
  const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
  return sessions
    .map((session) => {
      const complete = normalizeSettledWtiSession({
        historicalOnly: true,
        executable: false,
        ...session,
      }, cadence);
      if (complete) return complete;

      const normalizedCadence = normalizeWtiCadence(cadence);
      const expectedSeries = expectedWtiSeries(normalizedCadence);
      const eventTicker = String(session?.eventTicker || session?.event?.ticker || '').toUpperCase();
      const closeTime = session?.closeTime || session?.event?.closeTime || null;
      const settlementValue = firstFinite(session?.settlementValue, session?.settlement_value);
      if (
        session?.historicalOnly !== true
        || session?.executable !== false
        || !eventTicker.startsWith(`${expectedSeries}-`)
        || !Number.isFinite(Date.parse(closeTime || ''))
        || settlementValue == null
      ) return null;
      return {
        historicalOnly: true,
        executable: false,
        marketType: normalizedCadence,
        seriesTicker: expectedSeries,
        event: {
          ticker: eventTicker,
          seriesTicker: expectedSeries,
          title: session?.event?.title || `${normalizedCadence === 'weekly' ? 'Weekly' : 'Daily'} WTI settlement`,
          closeTime,
        },
        settlementValue,
        settlementTime: session.settlementTime || null,
        settlementMapping: {
          status: 'consistent_unverified',
          contractLabel: session.frontMonthContract || null,
          contractMonth: session.contractMonth || null,
          proxyCalibrationAvailable: false,
        },
        venue: session.venue || null,
        markets: [],
      };
    })
    .filter(Boolean);
}

function riskRangeRows(history) {
  if (Array.isArray(history)) return history;
  if (Array.isArray(history?.WTIC)) return history.WTIC;
  if (Array.isArray(history?.rows)) return history.rows;
  return [];
}

export function findWtiRiskRangeForEvent(history, event = {}) {
  const targetDate = wtiEventDate(event);
  if (!targetDate) return null;
  const match = riskRangeRows(history).find((row) => (
    String(row?.date || '').slice(0, 10) === targetDate
    && (!row?.ticker || String(row.ticker).toUpperCase() === 'WTIC')
  ));
  const lrr = finiteNumber(match?.lrr);
  const hrr = finiteNumber(match?.hrr);
  if (!match || lrr == null || hrr == null || !(lrr < hrr)) return null;
  return {
    ...match,
    ticker: 'WTIC',
    date: targetDate,
    lrr,
    hrr,
  };
}

export function normalizeOvxReference(snapshot, { historical = false, now = Date.now() } = {}) {
  if (historical) return { status: 'unavailable', reason: 'Historical OVX snapshots are not available.' };
  const row = snapshot?.OVX;
  const value = firstFinite(row?.lastPx, row?.last, row?.value);
  const asOf = row?.asOf || row?.timestamp || snapshot?.lastUpdated || null;
  const today = dateKeyInNewYork(now);
  const source = row?.sourceLabel || row?.source || null;
  const provenance = [source, row?.warning].filter(Boolean).join(' ');
  const refreshDelayed = isRefreshDelayedVolatilityRow(row, now);
  const available = (
    (row?.availability === 'available' && row?.freshness === 'current')
    || refreshDelayed
  )
    && value != null
    && value >= 0
    && Boolean(asOf)
    && dateKeyInNewYork(asOf) === today
    && !BLOCKED_PROVENANCE.test(provenance);
  if (!available) return { status: 'unavailable', reason: 'A fresh current-session OVX reference is unavailable.' };
  return {
    status: refreshDelayed ? 'refresh-delayed' : 'available',
    value,
    asOf,
    date: dateKeyInNewYork(asOf),
    source,
    quoteMode: row.quoteMode || null,
    refreshDelayed,
    lastVerifiedAt: refreshDelayed ? row.lastVerifiedAt : null,
    executable: false,
  };
}

export function describeWtiGeometry(market = {}) {
  const money = (value) => {
    const number = finiteNumber(value);
    return number == null ? '—' : `$${number.toFixed(2)}`;
  };
  if (market.geometry === 'above') {
    const boundary = firstFinite(market.lower, market.threshold);
    const label = market.lowerInclusive === true ? 'At least' : 'Above';
    return `${label} ${money(boundary)}`;
  }
  if (market.geometry === 'below') {
    const boundary = firstFinite(market.upper, market.threshold);
    const label = market.upperInclusive === true ? 'At most' : 'Below';
    return `${label} ${money(boundary)}`;
  }
  if (market.geometry === 'between') {
    return `${money(market.lower)}–${money(market.upper)}`;
  }
  return market.title || market.ticker || 'WTI contract';
}

export function selectDefaultWtiMarket(markets = []) {
  const complete = markets.filter(hasCompleteNativeWtiBook);
  const candidates = complete.length ? complete : markets;
  return [...candidates].sort((left, right) => (
    (finiteNumber(right.volume24h) ?? -1) - (finiteNumber(left.volume24h) ?? -1)
  ))[0] || null;
}

export function isWtiPositionForEvent(position = {}, eventTicker = '') {
  const expectedEvent = String(eventTicker || '').trim().toUpperCase();
  if (!expectedEvent) return false;
  const explicitEvent = String(position.eventTicker || position.event_ticker || '').trim().toUpperCase();
  if (explicitEvent) return explicitEvent === expectedEvent;
  const text = [
    position.symbol,
    position.localSymbol,
    position.description,
    position.contract_title,
    position.question,
    position.ticker,
  ].filter(Boolean).join(' ').toUpperCase();
  return text.includes(expectedEvent);
}

export function filterWtiPositionsForEvent(sharedPositionsState, eventTicker) {
  const status = String(sharedPositionsState?.status || 'unavailable').toLowerCase();
  if (!['live', 'partial'].includes(status)) return [];
  return (Array.isArray(sharedPositionsState?.positions) ? sharedPositionsState.positions : [])
    .filter((position) => isWtiPositionForEvent(position, eventTicker));
}

export const WTI_LIVE_RESPONSE_MAX_AGE_MS = LIVE_RESPONSE_MAX_AGE_MS;
