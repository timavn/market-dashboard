const { formatInTimeZone } = require('date-fns-tz');
const {
  SYSTEM_ACCOUNT_ID,
  forecastExThresholdIdentity,
} = require('./predictionMarketPerformanceLedger.cjs');
const { validateFesGeneration } = require('./forecastExFesIdentity.cjs');

const RESEARCH_SCHEMA_VERSION = 1;
const RESEARCH_VERSION = 'spx-fes-poker-ledger-v1';
const CONTEXT_PREFIX = 'spx_fes_context#';
const OPPORTUNITY_PREFIX = 'spx_fes_opportunity#';
const HEALTH_KEY = 'spx_fes_health#collector';
const CONTEXT_RETENTION_SECONDS = 14 * 24 * 60 * 60;
const COLLECTOR_INTERVAL_MS = 30_000;
const ENTRY_CONTEXT_MAX_AGE_MS = 90_000;
const BASIS_MAX_SKEW_MS = 30_000;
const LIVE_QUOTE_MAX_AGE_MS = 60_000;
const PATH_WINDOW_GRACE_MS = 90_000;
const MAINTENANCE_INTERVAL_MS = 15 * 60_000;
const CHICAGO_TIME_ZONE = 'America/Chicago';
const FORBIDDEN_PROVENANCE = /delayed|frozen|stale|cache(?:d|_only|-only)?|mock|seed|fallback|offline|disconnected|historical|synthetic|inferred|derived|retained/i;

function finite(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function dateOnly(value) {
  return iso(value)?.slice(0, 10) || String(value || '').match(/^20\d{2}-\d{2}-\d{2}/)?.[0] || null;
}

function round(value, places = 6) {
  const number = finite(value);
  if (number == null) return null;
  const scale = 10 ** places;
  return Math.round(number * scale) / scale;
}

function average(values = []) {
  const present = values.map(finite).filter((value) => value != null);
  return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
}

function sum(values = []) {
  return values.map(finite).filter((value) => value != null).reduce((total, value) => total + value, 0);
}

function safeRatio(numerator, denominator) {
  const top = finite(numerator);
  const bottom = finite(denominator);
  return top != null && bottom != null && bottom > 0 ? top / bottom : null;
}

function metric(value, reason = null, extras = {}) {
  const present = finite(value);
  return {
    value: present == null ? null : round(present),
    reason: present == null ? reason || 'Insufficient verified prospective FES data.' : null,
    ...extras,
  };
}

function wilsonInterval(successes, observations, z = 1.959963984540054) {
  const n = finite(observations);
  const x = finite(successes);
  if (n == null || x == null || n <= 0 || x < 0 || x > n) return null;
  const p = x / n;
  const denominator = 1 + (z ** 2) / n;
  const center = (p + (z ** 2) / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p) + (z ** 2) / (4 * n)) / n)) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function rateMetric(successes, observations, reason = null) {
  const value = safeRatio(successes, observations);
  const interval = wilsonInterval(successes, observations);
  return metric(value, reason || 'No qualifying observations.', {
    successes: Number(successes || 0),
    observations: Number(observations || 0),
    interval95: interval ? { low: round(interval.low), high: round(interval.high), method: 'Wilson' } : null,
  });
}

function percentileZone(value, low, high) {
  const point = finite(value);
  const floor = finite(low);
  const ceiling = finite(high);
  if (point == null || floor == null || ceiling == null || !(floor < ceiling)) {
    return { percentile: null, zone: 'unavailable' };
  }
  const percentile = (point - floor) / (ceiling - floor);
  if (percentile < 0) return { percentile, zone: 'below' };
  if (percentile > 1) return { percentile, zone: 'above' };
  if (percentile < 1 / 3) return { percentile, zone: 'bottom third' };
  if (percentile < 2 / 3) return { percentile, zone: 'middle third' };
  return { percentile, zone: 'top third' };
}

function normalizeDirection(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (['BULLISH', 'BULL', 'LONG', 'BUY', 'POSITIVE'].includes(raw)) return 'BULLISH';
  if (['BEARISH', 'BEAR', 'SHORT', 'SELL', 'NEGATIVE'].includes(raw)) return 'BEARISH';
  if (['NEUTRAL', 'FLAT', 'MIXED'].includes(raw)) return 'NEUTRAL';
  return null;
}

function directionalAlignment(trade, trend) {
  const normalizedTrade = normalizeDirection(trade);
  const normalizedTrend = normalizeDirection(trend);
  if (!normalizedTrade || !normalizedTrend || normalizedTrade === 'NEUTRAL' || normalizedTrend === 'NEUTRAL') {
    return { status: 'unavailable', trade: normalizedTrade, trend: normalizedTrend, thesisSide: null };
  }
  if (normalizedTrade !== normalizedTrend) {
    return { status: 'conflicting', trade: normalizedTrade, trend: normalizedTrend, thesisSide: null };
  }
  return {
    status: normalizedTrade === 'BULLISH' ? 'aligned bullish' : 'aligned bearish',
    trade: normalizedTrade,
    trend: normalizedTrend,
    thesisSide: normalizedTrade === 'BULLISH' ? 'YES' : 'NO',
  };
}

function gammaSign(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'positive' || normalized === 'negative' || normalized === 'neutral') return normalized;
  return 'unavailable';
}

function vixRegime(value) {
  const number = finite(value);
  if (number == null) return 'unavailable';
  if (number < 20) return 'under 20';
  if (number < 29) return '20 to 29';
  return '29 or higher';
}

function contractPriceThird(value) {
  const number = finite(value);
  if (number == null || number < 0 || number > 1) return 'unavailable';
  if (number < 1 / 3) return 'bottom third';
  if (number < 2 / 3) return 'middle third';
  return 'top third';
}

function entryTimeBucket(value) {
  const parsed = Date.parse(value || '');
  if (!Number.isFinite(parsed)) return 'unavailable';
  const clock = formatInTimeZone(new Date(parsed), CHICAGO_TIME_ZONE, 'HH:mm').split(':').map(Number);
  const minutes = clock[0] * 60 + clock[1];
  if (minutes < 8 * 60 + 30 || minutes > 15 * 60) return 'outside collection session';
  if (minutes < 10 * 60) return '08:30–10:00 CT';
  if (minutes < 13 * 60) return '10:00–13:00 CT';
  return '13:00–15:00 CT';
}

function timeToCloseBucket(entryAt, closeAt) {
  const delta = Date.parse(closeAt || '') - Date.parse(entryAt || '');
  if (!Number.isFinite(delta) || delta < 0) return 'unavailable';
  if (delta <= 30 * 60_000) return '30m or less';
  if (delta <= 90 * 60_000) return '31–90m';
  return 'over 90m';
}

function actionSequenceSummary(records = [], countedBuyRecordKeys = null) {
  const counted = countedBuyRecordKeys instanceof Set ? countedBuyRecordKeys : null;
  let position = 0;
  let openedBefore = false;
  let addOnCount = 0;
  let reEntryCount = 0;
  const ordered = [...records].sort((left, right) => (
    String(left.executionTime || '').localeCompare(String(right.executionTime || ''))
    || String(left.recordKey || '').localeCompare(String(right.recordKey || ''))
  ));
  ordered.forEach((execution) => {
    const quantity = Math.abs(finite(execution.shares) || 0);
    if (!(quantity > 0)) return;
    if (execution.direction === 'BUY') {
      const isCounted = !counted || counted.has(execution.recordKey);
      if (isCounted && position > 0) addOnCount += 1;
      if (isCounted && position <= 0 && openedBefore) reEntryCount += 1;
      position += quantity;
      openedBefore = true;
      return;
    }
    if (execution.direction === 'SELL') position = Math.max(0, position - quantity);
  });
  return { addOnCount, reEntryCount };
}

function unsafeSection(section) {
  if (!section || section.refreshFailed === true || section.refreshRetained === true || section.fromCache === true || section.cachedOnly === true) return true;
  const provenance = [
    section.source, section.provenance, section.warning, section.reason,
    section.availability, section.cacheState, section.refreshIssue,
  ].filter(Boolean).join(' ');
  return FORBIDDEN_PROVENANCE.test(provenance);
}

function freshTimestamp(value, completedMs, maxAgeMs) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) && completedMs - parsed >= -5_000 && completedMs - parsed <= maxAgeMs;
}

function directSideQuote(line, side, completedMs) {
  const normalizedSide = String(side || '').toUpperCase();
  const prefix = normalizedSide === 'YES' ? 'yes' : normalizedSide === 'NO' ? 'no' : null;
  const updatedAt = iso(line?.updatedAt);
  const bid = prefix ? finite(line?.[`${prefix}Bid`]) : null;
  const ask = prefix ? finite(line?.[`${prefix}Ask`]) : null;
  const bidSize = prefix ? finite(line?.[`${prefix}BidSize`]) : null;
  const askSize = prefix ? finite(line?.[`${prefix}AskSize`]) : null;
  const verified = prefix
    && line?.directNative === true
    && line?.source === 'ibkr_tws_forecastex_live'
    && !unsafeSection(line)
    && freshTimestamp(updatedAt, completedMs, ENTRY_CONTEXT_MAX_AGE_MS)
    && bid != null && ask != null && bid >= 0 && ask <= 1 && bid <= ask
    && bidSize != null && askSize != null && bidSize > 0 && askSize > 0;
  return verified ? {
    bid, ask, bidSize, askSize, spread: ask - bid, updatedAt, source: 'ibkr_tws_forecastex_live', directNative: true,
  } : null;
}

function collectorWindow(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = formatInTimeZone(date, CHICAGO_TIME_ZONE, 'yyyy-MM-dd|HH|mm|ss|EEE').split('|');
  const minutes = Number(parts[1]) * 60 + Number(parts[2]);
  const seconds = Number(parts[3]);
  const weekday = !['Sat', 'Sun'].includes(parts[4]);
  return {
    date: parts[0],
    minutes,
    open: weekday && minutes >= 8 * 60 + 30 && (minutes < 15 * 60 || (minutes === 15 * 60 && seconds === 0)),
  };
}

function collectorHealthView(health, startedAt, nowMs) {
  const current = new Date(nowMs);
  const session = collectorWindow(current);
  const lastAttemptMs = Date.parse(health?.lastAttemptAt || '');
  const heartbeatAgeMs = Number.isFinite(lastAttemptMs) ? Math.max(0, nowMs - lastAttemptMs) : null;
  const base = {
    ...(health || {}),
    status: health?.status || (startedAt ? 'scheduled' : 'not_started'),
    reason: health?.reason || null,
    startedAt: health?.startedAt || startedAt || null,
    heartbeatAgeMs,
    sessionOpen: session.open,
  };
  if (!health) {
    return session.open && startedAt
      ? { ...base, status: 'unavailable', reason: 'The FES collector has no persisted heartbeat for the open CT session.' }
      : base;
  }
  if (session.open && base.status === 'capturing'
    && (heartbeatAgeMs == null || heartbeatAgeMs > COLLECTOR_INTERVAL_MS * 3)) {
    return { ...base, status: 'unavailable', reason: 'The FES collector heartbeat is stale for the open CT session.' };
  }
  if (!session.open && base.status === 'capturing') {
    return { ...base, status: 'scheduled', reason: 'Outside the 08:30–15:00 CT collection window.' };
  }
  return base;
}

function confluenceBand({ thesisSide, cashZone, gamma, vix }) {
  if (!thesisSide || cashZone === 'unavailable' || gamma === 'unavailable' || vix === 'unavailable') return { score: null, band: 'unavailable' };
  let score = 1;
  if ((thesisSide === 'YES' && cashZone === 'top third') || (thesisSide === 'NO' && cashZone === 'bottom third')) score += 1;
  if ((thesisSide === 'YES' && gamma === 'positive') || (thesisSide === 'NO' && gamma === 'negative')) score += 1;
  if (vix === 'under 20') score += 1;
  return { score, band: score <= 1 ? 'low' : score === 2 ? 'medium' : 'high' };
}

function contextUnavailable(reason, details = {}) {
  return { ok: false, reason, details };
}

function buildFesContext(snapshot, {
  completedAt = snapshot?.refresh?.completedAt || snapshot?.generatedAt,
  observedAt = new Date().toISOString(),
} = {}) {
  const completed = iso(completedAt);
  const completedMs = Date.parse(completed || '');
  if (snapshot?.schemaVersion !== 2 || snapshot?.marketId !== 'sp500' || !Number.isFinite(completedMs)) {
    return contextUnavailable('invalid_monitor_snapshot');
  }
  if (!iso(snapshot?.refresh?.completedAt)) return contextUnavailable('monitor_refresh_incomplete');
  const venue = snapshot.venues?.forecastex;
  const book = venue?.book;
  const rawLines = Array.isArray(book?.lines) ? book.lines : [];
  if (!venue || !book || !['available', 'partial'].includes(book.status) || unsafeSection(book) || !rawLines.length) {
    return contextUnavailable('direct_fes_book_unavailable');
  }
  let generation;
  try {
    generation = validateFesGeneration(rawLines.map((line) => ({
      productId: 'FES',
      contractId: line.contractId || line.ticker,
      strike: line.threshold,
      question: line.question,
      lastTradeDate: line.closeAt,
      expirationDate: line.expirationDate,
      payoutDate: line.payoutDate,
      rulesUrl: line.rulesUrl,
    })));
  } catch (error) {
    return contextUnavailable('ambiguous_fes_generation', { message: error.message });
  }
  const resolverIdentity = venue.resolverIdentity || {};
  if (resolverIdentity.generationKey !== generation.generationKey
    || resolverIdentity.eventDate !== generation.eventDate
    || resolverIdentity.resolverSymbol !== generation.resolverSymbol
    || resolverIdentity.underlyingContractMonth !== generation.underlyingContractMonth
    || resolverIdentity.resolverMonthLabel !== generation.resolverMonthLabel
    || iso(resolverIdentity.lastTradeAt) !== generation.lastTradeAt
    || iso(resolverIdentity.resolutionAt) !== generation.resolutionAt
    || iso(resolverIdentity.payoutAt) !== generation.payoutAt) {
    return contextUnavailable('fes_resolver_identity_conflict');
  }
  const cash = snapshot.spot;
  const esReference = snapshot.resolverReference;
  const es = esReference?.spot;
  const exactInstrument = esReference?.instrument;
  const cashValue = finite(cash?.value);
  const esValue = finite(es?.value);
  const cashAt = iso(cash?.asOf);
  const esAt = iso(es?.asOf);
  const cashVerified = cash?.status === 'available'
    && cash?.availability === 'live'
    && /^ibkr_live(?:_stream)?$/.test(String(cash?.source || ''))
    && !unsafeSection(cash)
    && cashValue != null && cashValue > 0
    && freshTimestamp(cashAt, completedMs, LIVE_QUOTE_MAX_AGE_MS);
  const esVerified = es?.status === 'available'
    && es?.availability === 'live'
    && es?.source === 'ibkr_live_native_quote'
    && es?.priceType === 'direct_last_trade'
    && !unsafeSection(es)
    && esValue != null && esValue > 0
    && freshTimestamp(esAt, completedMs, LIVE_QUOTE_MAX_AGE_MS)
    && exactInstrument?.displaySymbol === generation.resolverSymbol
    && exactInstrument?.lastTradeDateOrContractMonth === generation.underlyingContractMonth;
  if (!cashVerified || !esVerified) return contextUnavailable(!cashVerified ? 'live_cash_spx_unavailable' : 'live_exact_es_unavailable');
  const quoteSkewMs = Math.abs(Date.parse(cashAt) - Date.parse(esAt));
  if (quoteSkewMs > BASIS_MAX_SKEW_MS) return contextUnavailable('spx_es_quote_skew_exceeded', { quoteSkewMs });

  const riskRange = snapshot.riskRange;
  const rangeVerified = riskRange?.status === 'available'
    && !unsafeSection(riskRange)
    && dateOnly(riskRange.date) === generation.eventDate
    && finite(riskRange.lrr) != null
    && finite(riskRange.hrr) != null
    && finite(riskRange.lrr) < finite(riskRange.hrr);
  const lrr = rangeVerified ? finite(riskRange.lrr) : null;
  const hrr = rangeVerified ? finite(riskRange.hrr) : null;
  const basis = esValue - cashValue;
  const adjustedLow = lrr == null ? null : lrr + basis;
  const adjustedHigh = hrr == null ? null : hrr + basis;
  const cashGeometry = percentileZone(cashValue, lrr, hrr);
  const tradeFactor = snapshot.factors?.trade;
  const trade = tradeFactor?.status === 'available' && !unsafeSection(tradeFactor)
    && dateOnly(tradeFactor.date) === generation.eventDate
    ? tradeFactor.direction
    : null;
  const trend = rangeVerified ? riskRange.trend : null;
  const alignment = directionalAlignment(trade, trend);
  const gammaFactor = snapshot.factors?.gamma;
  const reportedGamma = gammaFactor?.status === 'available' && !unsafeSection(gammaFactor)
    ? gammaSign(gammaFactor.value)
    : 'unavailable';
  const gammaThrottle = gammaFactor?.status === 'available' && !unsafeSection(gammaFactor)
    ? finite(gammaFactor.throttle)
    : null;
  const vixFactor = snapshot.factors?.vix;
  const vix = vixFactor?.status === 'available' && !unsafeSection(vixFactor)
    && /^ibkr_live(?:_stream)?$/.test(String(vixFactor.source || ''))
    && freshTimestamp(vixFactor.asOf, completedMs, LIVE_QUOTE_MAX_AGE_MS)
    && finite(vixFactor.value) > 0
    ? finite(vixFactor.value)
    : null;
  const vixBucket = vixRegime(vix);
  const confluence = confluenceBand({
    thesisSide: alignment.thesisSide,
    cashZone: cashGeometry.zone,
    gamma: reportedGamma,
    vix: vixBucket,
  });
  const lines = rawLines.map((line) => {
    const strike = finite(line.threshold);
    const yes = directSideQuote(line, 'YES', completedMs);
    const no = directSideQuote(line, 'NO', completedMs);
    if (strike == null || (!yes && !no)) return null;
    const geometry = percentileZone(strike, adjustedLow, adjustedHigh);
    return {
      contractId: String(line.contractId || line.ticker || '').toUpperCase(),
      strike,
      strikePercentile: round(geometry.percentile),
      strikeZone: geometry.zone,
      esMoneyness: round(esValue - strike),
      sides: { YES: yes, NO: no },
    };
  }).filter(Boolean);
  if (!lines.length) return contextUnavailable('direct_fes_lines_unavailable');
  const contextId = `${generation.generationKey}#${completed}`;
  return {
    ok: true,
    context: {
      accountId: SYSTEM_ACCOUNT_ID,
      recordKey: `${CONTEXT_PREFIX}${contextId}`,
      itemType: 'spx_fes_context',
      researchVersion: RESEARCH_VERSION,
      contextId,
      generationKey: generation.generationKey,
      eventDate: generation.eventDate,
      resolverSymbol: generation.resolverSymbol,
      resolverContractMonth: generation.underlyingContractMonth,
      resolverMonthLabel: generation.resolverMonthLabel,
      rulesUrl: generation.rulesUrl,
      lastTradeAt: generation.lastTradeAt,
      resolutionAt: generation.resolutionAt,
      payoutAt: generation.payoutAt,
      completedAt: completed,
      observedAt: iso(observedAt) || new Date().toISOString(),
      spx: { value: cashValue, asOf: cashAt, source: cash.source },
      es: { value: esValue, asOf: esAt, source: es.source, priceType: es.priceType },
      basis: round(basis),
      basisQuoteSkewMs: quoteSkewMs,
      riskRange: {
        status: rangeVerified ? 'available' : 'unavailable',
        lrr, hrr,
        date: rangeVerified ? generation.eventDate : null,
        source: rangeVerified ? riskRange.source : null,
        reason: rangeVerified ? null : riskRange?.reason || 'Current same-session SPX Risk Range is unavailable.',
      },
      cashRangePercentile: round(cashGeometry.percentile),
      cashRangeZone: cashGeometry.zone,
      basisAdjustedRange: {
        status: adjustedLow != null && adjustedHigh != null ? 'available' : 'unavailable',
        low: round(adjustedLow), high: round(adjustedHigh),
        label: 'Research-derived cash Risk Range plus live ES−SPX basis',
      },
      directionalAlignment: alignment.status,
      tradeDirection: alignment.trade,
      trendDirection: alignment.trend,
      thesisSide: alignment.thesisSide,
      gammaSign: reportedGamma,
      gammaThrottle,
      vix,
      vixRegime: vixBucket,
      confluenceScore: confluence.score,
      confluenceBand: confluence.band,
      lines,
      provenance: {
        spx: { source: cash.source, asOf: cashAt, status: 'verified_live' },
        es: { source: es.source, asOf: esAt, symbol: generation.resolverSymbol, status: 'verified_live_direct_last' },
        riskRange: { source: rangeVerified ? riskRange.source : null, asOf: riskRange?.asOf || null, status: rangeVerified ? 'verified_current' : 'unavailable' },
        gamma: { source: reportedGamma === 'unavailable' ? null : gammaFactor.source, asOf: gammaFactor?.asOf || null, status: reportedGamma === 'unavailable' ? 'unavailable' : 'verified_reported' },
        vix: { source: vix == null ? null : vixFactor.source, asOf: vixFactor?.asOf || null, status: vix == null ? 'unavailable' : 'verified_live' },
        fesBook: { source: book.source, asOf: book.asOf, status: 'verified_direct_native' },
        fesTerms: { source: generation.rulesUrl, asOf: null, status: 'verified_official_terms' },
        settlement: { source: 'cme_daily_bulletin_final', status: 'pending_until_resolution', symbol: generation.resolverSymbol },
      },
      version: 1,
      createdAt: completed,
      updatedAt: completed,
      ttl: Math.floor(completedMs / 1000) + CONTEXT_RETENTION_SECONDS,
    },
  };
}

function opportunityFromContext(context, line) {
  const side = context.thesisSide;
  const quote = side ? line.sides?.[side] : null;
  const insideRange = ['bottom third', 'middle third', 'top third'].includes(line.strikeZone);
  if (!quote || !insideRange || !String(context.directionalAlignment).startsWith('aligned')) return null;
  const strikeKey = String(line.strike);
  const recordKey = `${OPPORTUNITY_PREFIX}${context.generationKey}#${strikeKey}#${side}`;
  return {
    accountId: SYSTEM_ACCOUNT_ID,
    recordKey,
    itemType: 'spx_fes_opportunity',
    researchVersion: RESEARCH_VERSION,
    opportunityId: `${context.generationKey}#${strikeKey}#${side}`,
    generationKey: context.generationKey,
    eventDate: context.eventDate,
    eventContract: `${context.generationKey}_${strikeKey}`,
    strike: line.strike,
    thesisSide: side,
    qualified: true,
    firstEligibleAt: context.completedAt,
    firstEligibleBid: quote.bid,
    firstEligibleAsk: quote.ask,
    firstEligibleBidSize: quote.bidSize,
    firstEligibleAskSize: quote.askSize,
    resolverSymbol: context.resolverSymbol,
    resolverContractMonth: context.resolverContractMonth,
    resolverMonthLabel: context.resolverMonthLabel,
    rulesUrl: context.rulesUrl,
    lastTradeAt: context.lastTradeAt,
    resolutionAt: context.resolutionAt,
    payoutAt: context.payoutAt,
    context: {
      cashRangeZone: context.cashRangeZone,
      cashRangePercentile: context.cashRangePercentile,
      strikeZone: line.strikeZone,
      strikePercentile: line.strikePercentile,
      directionalAlignment: context.directionalAlignment,
      gammaSign: context.gammaSign,
      gammaThrottle: context.gammaThrottle,
      vix: context.vix,
      vixRegime: context.vixRegime,
      confluenceScore: context.confluenceScore,
      confluenceBand: context.confluenceBand,
      basis: context.basis,
      esMoneyness: line.esMoneyness,
      entryTimeBucket: entryTimeBucket(context.completedAt),
      timeToLastTradeBucket: timeToCloseBucket(context.completedAt, context.lastTradeAt),
      contractPriceThird: contractPriceThird(quote.ask),
      coverage: {
        riskRange: context.riskRange.status === 'available',
        gamma: context.gammaSign !== 'unavailable',
        vix: context.vix != null,
        liveBasis: context.basis != null,
      },
    },
    outcome: null,
    version: 1,
    createdAt: context.completedAt,
    updatedAt: context.completedAt,
  };
}

function compactEntryContext(context, line, side, quote, actionDirection) {
  const qualified = actionDirection === 'BUY' && context.thesisSide === side
    && String(context.directionalAlignment).startsWith('aligned')
    && ['bottom third', 'middle third', 'top third'].includes(line.strikeZone);
  return {
    status: 'matched',
    researchVersion: RESEARCH_VERSION,
    contextRecordKey: context.recordKey,
    opportunityRecordKey: `${OPPORTUNITY_PREFIX}${context.generationKey}#${line.strike}#${side}`,
    capturedAt: context.completedAt,
    ageMs: null,
    generationKey: context.generationKey,
    eventDate: context.eventDate,
    strike: line.strike,
    side,
    actionDirection,
    qualified,
    resolverSymbol: context.resolverSymbol,
    resolverContractMonth: context.resolverContractMonth,
    resolverMonthLabel: context.resolverMonthLabel,
    rulesUrl: context.rulesUrl,
    lastTradeAt: context.lastTradeAt,
    resolutionAt: context.resolutionAt,
    payoutAt: context.payoutAt,
    priorBook: { ...quote },
    cashSpx: context.spx.value,
    cashRangePercentile: context.cashRangePercentile,
    cashRangeZone: context.cashRangeZone,
    riskRange: { ...context.riskRange },
    es: context.es.value,
    basis: context.basis,
    basisQuoteSkewMs: context.basisQuoteSkewMs,
    basisAdjustedRange: { ...context.basisAdjustedRange },
    strikePercentile: line.strikePercentile,
    strikeZone: line.strikeZone,
    esMoneyness: line.esMoneyness,
    sideAdjustedEsMoneyness: side === 'YES' ? line.esMoneyness : -line.esMoneyness,
    directionalAlignment: context.directionalAlignment,
    tradeDirection: context.tradeDirection,
    trendDirection: context.trendDirection,
    gammaSign: context.gammaSign,
    gammaThrottle: context.gammaThrottle,
    vix: context.vix,
    vixRegime: context.vixRegime,
    confluenceScore: context.confluenceScore,
    confluenceBand: context.confluenceBand,
    entryTimeBucket: entryTimeBucket(context.completedAt),
    timeToLastTradeBucket: timeToCloseBucket(context.completedAt, context.lastTradeAt),
    contractPriceThird: contractPriceThird(quote.ask),
    provenance: context.provenance,
  };
}

function quoteAtContext(context, strike, side) {
  const line = (context.lines || []).find((candidate) => finite(candidate.strike) === finite(strike));
  const quote = line?.sides?.[side] || null;
  return quote?.directNative === true && quote.source === 'ibkr_tws_forecastex_live' ? { line, quote } : null;
}

function pathPoint(context, strike, side) {
  const match = quoteAtContext(context, strike, side);
  return match ? {
    capturedAt: context.completedAt,
    bid: match.quote.bid,
    ask: match.quote.ask,
    bidSize: match.quote.bidSize,
    askSize: match.quote.askSize,
    source: match.quote.source,
    directNative: true,
  } : null;
}

function firstPathPoint(points, targetMs) {
  return points.find((point) => {
    const at = Date.parse(point.capturedAt);
    return at >= targetMs && at <= targetMs + PATH_WINDOW_GRACE_MS;
  }) || null;
}

function buildQuotePath(execution, contexts, nowMs = Date.now()) {
  const entry = execution.spxFesEntryContext;
  const executionMs = Date.parse(execution.executionTime || '');
  const closeMs = Date.parse(entry?.lastTradeAt || '');
  if (!entry || entry.status !== 'matched' || !Number.isFinite(executionMs) || !Number.isFinite(closeMs)
    || nowMs < closeMs + PATH_WINDOW_GRACE_MS) return null;
  const points = contexts.map((context) => pathPoint(context, entry.strike, entry.side)).filter(Boolean)
    .filter((point) => Date.parse(point.capturedAt) >= executionMs && Date.parse(point.capturedAt) <= closeMs)
    .sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt));
  const mark = (minutes) => {
    const point = firstPathPoint(points, executionMs + minutes * 60_000);
    return point ? { ...point, bidChange: round(point.bid - entry.priorBook.bid), askChange: round(point.ask - entry.priorBook.ask) }
      : { capturedAt: null, bid: null, ask: null, bidSize: null, askSize: null, bidChange: null, askChange: null, reason: `No verified direct same-side quote in the +${minutes}m to +${minutes}m90s window.` };
  };
  const bids = points.filter((point) => finite(point.bid) != null);
  const best = bids.length ? bids.reduce((winner, point) => point.bid > winner.bid ? point : winner) : null;
  const worst = bids.length ? bids.reduce((winner, point) => point.bid < winner.bid ? point : winner) : null;
  const preclose = [...points].reverse().find((point) => Date.parse(point.capturedAt) >= closeMs - 5 * 60_000) || null;
  const cashCloseContext = [...contexts].filter((context) => {
    const at = Date.parse(context.completedAt || '');
    return Number.isFinite(at) && at >= closeMs - 5 * 60_000 && at <= closeMs && finite(context.spx?.value) != null;
  }).sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)))[0] || null;
  const cashCloseGeometry = cashCloseContext
    ? percentileZone(cashCloseContext.spx.value, cashCloseContext.riskRange?.lrr, cashCloseContext.riskRange?.hrr)
    : { percentile: null, zone: 'unavailable' };
  return {
    status: 'finalized',
    researchVersion: RESEARCH_VERSION,
    finalizedAt: new Date(nowMs).toISOString(),
    source: 'prospective_direct_same_side_fes_book',
    plus5: mark(5),
    plus15: mark(15),
    plus30: mark(30),
    bestBid: best ? { ...best, change: round(best.bid - entry.priorBook.bid) } : { bid: null, change: null, reason: 'No verified post-fill direct bid.' },
    worstBid: worst ? { ...worst, change: round(worst.bid - entry.priorBook.bid) } : { bid: null, change: null, reason: 'No verified post-fill direct bid.' },
    lastPreClose: preclose ? { ...preclose, bidChange: round(preclose.bid - entry.priorBook.bid), askChange: round(preclose.ask - entry.priorBook.ask) }
      : { capturedAt: null, bid: null, ask: null, bidChange: null, askChange: null, reason: 'No verified direct quote within five minutes before official last trade.' },
    cashSpxClose: cashCloseContext ? {
      value: cashCloseContext.spx.value,
      observedAt: cashCloseContext.spx.asOf,
      capturedAt: cashCloseContext.completedAt,
      source: cashCloseContext.spx.source,
      rangeZone: cashCloseGeometry.zone,
      rangePercentile: round(cashCloseGeometry.percentile),
      publishedRangeContainedClose: cashCloseGeometry.percentile != null
        ? cashCloseGeometry.percentile >= 0 && cashCloseGeometry.percentile <= 1
        : null,
    } : {
      value: null,
      observedAt: null,
      capturedAt: null,
      source: null,
      rangeZone: 'unavailable',
      rangePercentile: null,
      publishedRangeContainedClose: null,
      reason: 'No verified live cash-SPX observation was captured within five minutes before official FES last trade.',
    },
    observationCount: points.length,
  };
}

function lifecycleOutcome(lifecycle) {
  const evidence = lifecycle?.settlementEvidence || {};
  const payout = finite(evidence.payoutPerContract ?? evidence.settlementPayout);
  if (!['verified', 'confirmed'].includes(String(lifecycle?.status || '').toLowerCase())
    || lifecycle?.resolutionType !== 'expiry'
    || evidence.source !== 'forecastex_official_prices'
    || !['YES', 'NO'].includes(String(evidence.outcome || '').toUpperCase())
    || ![0, 1].includes(payout)) return null;
  return { won: payout === 1 ? 1 : 0, payout, outcome: evidence.outcome || null };
}

function realizedLifecycles(records = []) {
  return records.filter((record) => {
    if (record?.itemType !== 'lifecycle'
      || !['verified', 'confirmed'].includes(String(record.status || '').toLowerCase())
      || finite(record.pnl) == null) return false;
    if (record.resolutionType === 'expiry') return lifecycleOutcome(record) != null;
    return record.resolutionType === 'early_exit';
  });
}

function maximumDrawdown(records = []) {
  const ordered = [...records].filter((record) => finite(record.pnl) != null)
    .sort((left, right) => String(left.resolvedDate || left.updatedAt || '').localeCompare(String(right.resolvedDate || right.updatedAt || '')));
  if (!ordered.length) return null;
  let equity = 0;
  let peak = 0;
  let maximum = 0;
  ordered.forEach((record) => {
    equity += finite(record.pnl) || 0;
    peak = Math.max(peak, equity);
    maximum = Math.max(maximum, peak - equity);
  });
  return maximum;
}

const COHORT_DIMENSIONS = Object.freeze({
  cashRangeZone: 'Cash-SPX range zone',
  strikeZone: 'Basis-adjusted strike zone',
  directionalAlignment: 'Directional alignment',
  gammaSign: 'Reported gamma sign',
  vixRegime: 'VIX regime',
  entryTimeBucket: 'Entry-time bucket',
  timeToLastTradeBucket: 'Time to last trade',
  contractPriceThird: 'Contract-price third',
  confluenceBand: 'Basis-adjusted confluence band',
});

function recordEventDate(record) {
  return record?.spxFesEntryContext?.eventDate
    || forecastExThresholdIdentity(record)?.resolutionDate
    || dateOnly(record?.resolvedDate || record?.expiration);
}

function eventInWindow(eventDate, window, nowMs) {
  if (window === 'all') return true;
  const days = window === '30d' ? 30 : 90;
  const at = Date.parse(`${eventDate || ''}T23:59:59Z`);
  return Number.isFinite(at) && at >= nowMs - days * 24 * 60 * 60_000;
}

function buildResearchResponse({
  accountId,
  window = 'all',
  accountRecords = [],
  opportunities = [],
  health = null,
  now = new Date(),
  startedAt = null,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const fesRecords = accountRecords.filter((record) => forecastExThresholdIdentity(record)?.productCode === 'FES');
  const executions = fesRecords.filter((record) => record.itemType === 'execution' && eventInWindow(recordEventDate(record), window, nowMs));
  const buys = executions.filter((record) => record.direction === 'BUY');
  const matchedLifecycleKeys = new Set(buys.filter((record) => record.spxFesEntryContext?.status === 'matched')
    .map((record) => record.lifecycleRecordKey).filter(Boolean));
  const allLifecycles = fesRecords.filter((record) => record.itemType === 'lifecycle' && eventInWindow(recordEventDate(record), window, nowMs));
  const lifecycles = allLifecycles.filter((record) => matchedLifecycleKeys.has(record.recordKey));
  const scopedOpportunities = opportunities.filter((record) => record.itemType === 'spx_fes_opportunity'
    && record.qualified === true && eventInWindow(record.eventDate, window, nowMs));
  const lifecycleByKey = new Map(lifecycles.map((record) => [record.recordKey, record]));
  const actionsByOpportunity = new Map();
  buys.filter((record) => record.spxFesEntryContext?.status === 'matched').forEach((execution) => {
    const key = execution.spxFesEntryContext.opportunityRecordKey;
    const value = actionsByOpportunity.get(key) || { executions: [], lifecycleKeys: new Set() };
    value.executions.push(execution);
    if (execution.lifecycleRecordKey) value.lifecycleKeys.add(execution.lifecycleRecordKey);
    actionsByOpportunity.set(key, value);
  });
  const actedOpportunityKeys = new Set(actionsByOpportunity.keys());
  const qualifiedDays = new Set(scopedOpportunities.map((record) => record.eventDate));
  const actionDays = new Set(scopedOpportunities.filter((record) => actedOpportunityKeys.has(record.recordKey)).map((record) => record.eventDate));
  const actionOpportunities = scopedOpportunities.filter((record) => actedOpportunityKeys.has(record.recordKey));
  const resolved = realizedLifecycles(lifecycles);
  const resolvedDays = new Set(resolved.map(recordEventDate).filter(Boolean));
  const matchedExecutions = buys.filter((record) => record.spxFesEntryContext?.status === 'matched');
  const matchedActions = executions.filter((record) => record.spxFesEntryContext?.status === 'matched');
  const unmatchedExecutions = buys.filter((record) => record.spxFesEntryContext?.status !== 'matched');
  const resolvedNet = sum(resolved.map((record) => record.pnl));
  const resolvedRisk = sum(resolved.map((record) => record.risked));
  const fees = sum(resolved.map((record) => record.fees));
  const wins = resolved.filter((record) => finite(record.pnl) > 0);
  const losses = resolved.filter((record) => finite(record.pnl) < 0);
  const grossWins = sum(wins.map((record) => record.pnl));
  const grossLosses = Math.abs(sum(losses.map((record) => record.pnl)));

  const calibrationRows = resolved.map((lifecycle) => {
    const outcome = lifecycleOutcome(lifecycle);
    if (!outcome) return null;
    const lifecycleBuys = buys.filter((execution) => execution.lifecycleRecordKey === lifecycle.recordKey);
    const quantity = sum(lifecycleBuys.map((execution) => execution.shares));
    const principal = sum(lifecycleBuys.map((execution) => finite(execution.price) * finite(execution.shares)));
    const paidProbability = safeRatio(principal, quantity);
    const breakeven = safeRatio(principal + (finite(lifecycle.fees) || 0), quantity);
    return paidProbability == null ? null : { lifecycle, y: outcome.won, paidProbability, breakeven };
  }).filter(Boolean);
  const paidProbabilities = calibrationRows.map((row) => row.paidProbability);
  const empirical = average(calibrationRows.map((row) => row.y));
  const meanPaid = average(paidProbabilities);
  const logLoss = average(calibrationRows.map((row) => {
    const probability = Math.min(1 - 1e-12, Math.max(1e-12, row.paidProbability));
    return -(row.y * Math.log(probability) + (1 - row.y) * Math.log(1 - probability));
  }));

  const dayPnl = new Map();
  resolved.forEach((record) => dayPnl.set(recordEventDate(record), (dayPnl.get(recordEventDate(record)) || 0) + (finite(record.pnl) || 0)));
  const profitableDays = [...dayPnl.values()].filter((value) => value > 0).length;
  const sequenceGroups = new Map();
  executions.forEach((execution) => {
    const identity = forecastExThresholdIdentity(execution);
    if (!identity?.eventContract || !identity.contractSide) return;
    const key = `${identity.eventContract}#${identity.contractSide}`;
    if (!sequenceGroups.has(key)) sequenceGroups.set(key, []);
    sequenceGroups.get(key).push(execution);
  });
  const matchedBuyKeys = new Set(matchedExecutions.map((execution) => execution.recordKey));
  const sequenceCounts = [...sequenceGroups.values()].reduce((total, group) => {
    if (!group.some((execution) => matchedBuyKeys.has(execution.recordKey))) return total;
    const summary = actionSequenceSummary(group, matchedBuyKeys);
    total.addOnCount += summary.addOnCount;
    total.reEntryCount += summary.reEntryCount;
    return total;
  }, { addOnCount: 0, reEntryCount: 0 });
  const sides = matchedActions.map((record) => record.spxFesEntryContext.side);
  const dayStrikeCounts = new Map();
  matchedExecutions.forEach((record) => {
    const eventDate = record.spxFesEntryContext.eventDate;
    if (!dayStrikeCounts.has(eventDate)) dayStrikeCounts.set(eventDate, new Set());
    dayStrikeCounts.get(eventDate).add(record.spxFesEntryContext.strike);
  });
  const matchedActionDays = new Set(matchedExecutions.map((record) => record.spxFesEntryContext.eventDate));
  const ladderDays = [...dayStrikeCounts.values()].filter((strikes) => strikes.size > 1).length;
  const offSetup = buys.filter((execution) => execution.spxFesEntryContext?.status === 'matched' && execution.spxFesEntryContext.qualified !== true).length;
  const earlyExit = resolved.filter((record) => record.resolutionType === 'early_exit').length;
  const held = resolved.filter((record) => record.resolutionType === 'expiry').length;

  const executionMetricsRows = matchedExecutions.map((execution) => {
    const entry = execution.spxFesEntryContext;
    const path = execution.spxFesQuotePath;
    return {
      spread: finite(entry.priorBook?.spread),
      bidDepth: finite(entry.priorBook?.bidSize),
      askDepth: finite(entry.priorBook?.askSize),
      fillVsAsk: finite(execution.price) != null && finite(entry.priorBook?.ask) != null ? finite(execution.price) - finite(entry.priorBook.ask) : null,
      depthParticipation: safeRatio(execution.shares, entry.priorBook?.askSize),
      plus5: finite(path?.plus5?.bidChange),
      plus15: finite(path?.plus15?.bidChange),
      plus30: finite(path?.plus30?.bidChange),
      best: finite(path?.bestBid?.change),
      worst: finite(path?.worstBid?.change),
      preclose: finite(path?.lastPreClose?.bidChange),
    };
  });

  const cohortTables = {};
  Object.entries(COHORT_DIMENSIONS).forEach(([dimension, label]) => {
    const values = new Map();
    scopedOpportunities.forEach((opportunity) => {
      const cohort = opportunity.context?.[dimension] || 'unavailable';
      if (!values.has(cohort)) values.set(cohort, []);
      values.get(cohort).push(opportunity);
    });
    cohortTables[dimension] = {
      key: dimension,
      label,
      mutuallyExclusive: true,
      rows: [...values.entries()].map(([cohort, rows]) => {
        const cohortKeys = new Set(rows.map((row) => row.recordKey));
        const cohortActions = [...cohortKeys].filter((key) => actedOpportunityKeys.has(key));
        const lifecycleKeys = new Set(cohortActions.flatMap((key) => [...(actionsByOpportunity.get(key)?.lifecycleKeys || [])]));
        const actual = [...lifecycleKeys].map((key) => lifecycleByKey.get(key)).filter(Boolean);
        const actualResolved = realizedLifecycles(actual);
        const actualCalibration = calibrationRows.filter((row) => lifecycleKeys.has(row.lifecycle.recordKey));
        const pathChanges = cohortActions.flatMap((key) => actionsByOpportunity.get(key)?.executions || [])
          .map((execution) => finite(execution.spxFesQuotePath?.plus15?.bidChange)).filter((value) => value != null);
        const covered = rows.filter((row) => {
          const coverage = row.context?.coverage || {};
          return coverage.riskRange === true && coverage.liveBasis === true
            && coverage.gamma === true && coverage.vix === true;
        }).length;
        const cohortRisk = sum(actualResolved.map((record) => record.risked));
        const cohortPnl = sum(actualResolved.map((record) => record.pnl));
        return {
          cohort,
          qualifiedOpportunityCount: rows.length,
          qualifiedDays: new Set(rows.map((row) => row.eventDate)).size,
          contractCount: actual.length,
          uniqueDays: new Set(actual.map(recordEventDate).filter(Boolean)).size,
          actionRate: rateMetric(cohortActions.length, rows.length),
          hitRate: rateMetric(actualCalibration.filter((row) => row.y === 1).length, actualCalibration.length),
          pnl: metric(actualResolved.length ? cohortPnl : null),
          roi: metric(cohortRisk > 0 ? cohortPnl / cohortRisk : null),
          calibrationGap: metric(actualCalibration.length ? average(actualCalibration.map((row) => row.y)) - average(actualCalibration.map((row) => row.paidProbability)) : null),
          quotePathChange: metric(average(pathChanges), 'No finalized +15-minute direct-bid observations.'),
          contextCoverage: rateMetric(covered, rows.length),
        };
      }).sort((left, right) => String(left.cohort).localeCompare(String(right.cohort))),
    };
  });

  const passes = scopedOpportunities.filter((record) => !actedOpportunityKeys.has(record.recordKey));
  const resolvedPasses = passes.filter((record) => [0, 1].includes(finite(record.outcome?.payoutForThesisSide)));
  const passValues = resolvedPasses.map((record) => {
    const payout = finite(record.outcome.payoutForThesisSide);
    const ask = finite(record.firstEligibleAsk);
    return payout == null || ask == null ? null : payout - ask;
  }).filter((value) => value != null);
  const outcomeGeometryRows = resolved.filter((record) => record.resolutionType === 'expiry').map((record) => {
    const evidence = record.settlementEvidence || {};
    const pathExecution = matchedExecutions
      .filter((execution) => execution.lifecycleRecordKey === record.recordKey)
      .sort((left, right) => String(left.executionTime || '').localeCompare(String(right.executionTime || '')))
      .find((execution) => execution.spxFesQuotePath?.status === 'finalized') || null;
    const path = pathExecution?.spxFesQuotePath || null;
    const rawSettlement = finite(evidence.underlyingSettlementValue);
    const resolverSource = String(evidence.underlyingSettlementSource || '');
    const resolverStatus = String(evidence.underlyingSettlementStatus || '');
    const officialEsSettlement = resolverSource === 'cme_daily_bulletin_final'
      && resolverStatus === 'official_final'
      ? rawSettlement
      : null;
    const strike = finite(record.strike);
    const distanceToStrike = officialEsSettlement != null && strike != null
      ? officialEsSettlement - strike
      : null;
    const cashClose = finite(path?.cashSpxClose?.value);
    const contained = typeof path?.cashSpxClose?.publishedRangeContainedClose === 'boolean'
      ? path.cashSpxClose.publishedRangeContainedClose
      : null;
    return {
      lifecycleRecordKey: record.recordKey,
      eventDate: recordEventDate(record),
      contract: record.contractLabel,
      side: record.contractSide,
      strike,
      resolverSymbol: record.settlementSymbol || evidence.underlyingSettlementSymbol || null,
      officialEsSettlement,
      officialEsSettlementSource: officialEsSettlement == null ? null : resolverSource,
      officialEsSettlementSourceUrl: officialEsSettlement == null ? null : evidence.underlyingSettlementSourceUrl || null,
      officialEsSettlementObservedAt: officialEsSettlement == null ? null : iso(evidence.underlyingSettlementObservedAt),
      officialEsSettlementReason: officialEsSettlement == null
        ? 'A matching official-final CME daily bulletin settlement is unavailable.'
        : null,
      distanceToStrike: round(distanceToStrike),
      sideAdjustedSettlementMargin: distanceToStrike == null
        ? null
        : round((record.contractSide === 'YES' ? 1 : -1) * distanceToStrike),
      cashSpxClose: cashClose,
      cashSpxCloseReason: cashClose == null
        ? path?.cashSpxClose?.reason || 'A verified cash-SPX observation within five minutes of official last trade is unavailable.'
        : null,
      cashSpxClosingRangeZone: path?.cashSpxClose?.rangeZone || 'unavailable',
      cashSpxClosingRangePercentile: finite(path?.cashSpxClose?.rangePercentile),
      publishedCashRangeContainedClose: contained,
      result: evidence.outcome || null,
      pnl: finite(record.pnl),
    };
  });
  const officialGeometry = outcomeGeometryRows.filter((row) => row.officialEsSettlement != null);
  const cashCloseGeometry = outcomeGeometryRows.filter((row) => row.cashSpxClose != null);
  const containmentGeometry = outcomeGeometryRows.filter((row) => row.publishedCashRangeContainedClose != null);
  const outcomeByLifecycle = new Map(outcomeGeometryRows.map((row) => [row.lifecycleRecordKey, row]));
  const latestOfficialGeometry = [...officialGeometry]
    .sort((left, right) => String(right.eventDate || '').localeCompare(String(left.eventDate || '')))[0] || null;
  const latestOfficialPayout = [...resolved]
    .filter((record) => record.resolutionType === 'expiry' && lifecycleOutcome(record))
    .sort((left, right) => String(recordEventDate(right) || '').localeCompare(String(recordEventDate(left) || '')))[0] || null;
  const handDates = [...new Set([
    ...scopedOpportunities.map((record) => record.eventDate),
    ...allLifecycles.map(recordEventDate),
  ].filter(Boolean))].sort().reverse().slice(0, 100);
  const hands = handDates.map((eventDate) => {
    const handOpportunities = scopedOpportunities.filter((record) => record.eventDate === eventDate);
    const handLifecycles = lifecycles.filter((record) => recordEventDate(record) === eventDate);
    const legacyLifecycles = allLifecycles.filter((record) => recordEventDate(record) === eventDate && !matchedLifecycleKeys.has(record.recordKey));
    const handResolved = realizedLifecycles(handLifecycles);
    const actionLines = handOpportunities.filter((record) => actedOpportunityKeys.has(record.recordKey));
    const passLines = handOpportunities.filter((record) => !actedOpportunityKeys.has(record.recordKey));
    const handActions = matchedActions
      .filter((record) => record.spxFesEntryContext.eventDate === eventDate)
      .sort((left, right) => String(left.executionTime || '').localeCompare(String(right.executionTime || '')));
    const latest = [...handOpportunities].sort((left, right) => String(right.firstEligibleAt).localeCompare(String(left.firstEligibleAt)))[0] || null;
    const representativeContext = handActions[0]?.spxFesEntryContext || latest?.context || null;
    return {
      eventDate,
      generationKey: representativeContext?.generationKey || latest?.generationKey || forecastExThresholdIdentity(handLifecycles[0] || legacyLifecycles[0])?.eventContract?.replace(/_(-?\d+(?:\.\d+)?)$/, '') || null,
      resolverSymbol: representativeContext?.resolverSymbol || latest?.resolverSymbol || [...handLifecycles, ...legacyLifecycles].find((row) => row.settlementSymbol)?.settlementSymbol || null,
      entryContext: representativeContext,
      qualifiedStrikeCount: handOpportunities.length,
      actionCount: handActions.length,
      qualifiedStrikeActionCount: actionLines.length,
      passCount: passLines.length,
      action: handActions.map((record) => ({
        executionId: record.execId || record.recordKey,
        executionTime: record.executionTime,
        strike: record.spxFesEntryContext.strike,
        side: record.spxFesEntryContext.side,
        direction: record.direction,
        fillPrice: finite(record.price),
        qualified: record.spxFesEntryContext.qualified === true,
        actionType: record.direction === 'SELL'
          ? 'exit'
          : record.spxFesEntryContext.qualified === true ? 'qualified_entry' : 'off_setup_entry',
      })),
      passes: passLines.map((record) => ({ strike: record.strike, side: record.thesisSide, ask: record.firstEligibleAsk, counterfactual: [0, 1].includes(finite(record.outcome?.payoutForThesisSide)) ? round(record.outcome.payoutForThesisSide - record.firstEligibleAsk) : null })),
      outcome: handResolved.map((record) => outcomeByLifecycle.get(record.recordKey)).filter(Boolean),
      pnl: handResolved.length ? round(sum(handResolved.map((record) => record.pnl))) : null,
      legacyUnmatched: legacyLifecycles.length > 0,
    };
  });

  const latestOpportunity = [...scopedOpportunities].sort((left, right) => String(right.firstEligibleAt).localeCompare(String(left.firstEligibleAt)))[0] || null;
  const resolvedDayCount = resolvedDays.size;
  const collectorHealth = collectorHealthView(health, startedAt, nowMs);
  const provenance = {
    ...(collectorHealth.provenance || {}),
    ...(latestOfficialGeometry ? {
      settlement: {
        source: latestOfficialGeometry.officialEsSettlementSource,
        sourceUrl: latestOfficialGeometry.officialEsSettlementSourceUrl,
        asOf: latestOfficialGeometry.officialEsSettlementObservedAt,
        symbol: latestOfficialGeometry.resolverSymbol,
        status: 'official_final',
      },
    } : {}),
    ...(latestOfficialPayout ? {
      forecastExOutcome: {
        source: latestOfficialPayout.settlementEvidence?.source,
        sourceUrl: latestOfficialPayout.settlementEvidence?.sourceUrl || null,
        asOf: iso(latestOfficialPayout.settlementEvidence?.outcomeObservedAt),
        status: 'official_final',
      },
    } : {}),
  };
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    researchVersion: RESEARCH_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    accountId,
    window,
    scope: {
      venue: 'ForecastEx',
      productCode: 'FES',
      market: 'SP500',
      pnlUnit: 'existing contract lifecycle',
      prospectiveOnly: true,
      excludes: ['Kalshi cash-SPX contracts', 'legacy FES rows without strict prospective entry context'],
      informationalOnly: true,
    },
    collector: {
      status: collectorHealth.status,
      reason: collectorHealth.reason,
      startedAt: collectorHealth.startedAt,
      lastAttemptAt: collectorHealth.lastAttemptAt || null,
      lastSuccessfulCaptureAt: collectorHealth.lastSuccessfulCaptureAt || null,
      latestContextAt: collectorHealth.latestContextAt || null,
      heartbeatAgeMs: collectorHealth.heartbeatAgeMs,
      sessionOpen: collectorHealth.sessionOpen,
      generationKey: collectorHealth.generationKey || latestOpportunity?.generationKey || null,
      resolverSymbol: collectorHealth.resolverSymbol || latestOpportunity?.resolverSymbol || null,
      resolverContractMonth: collectorHealth.resolverContractMonth || latestOpportunity?.resolverContractMonth || null,
      resolverMonthLabel: collectorHealth.resolverMonthLabel || latestOpportunity?.resolverMonthLabel || null,
      measurementDate: collectorHealth.measurementDate || latestOpportunity?.eventDate || null,
      lastTradeAt: collectorHealth.lastTradeAt || latestOpportunity?.lastTradeAt || null,
      resolutionAt: collectorHealth.resolutionAt || latestOpportunity?.resolutionAt || null,
      payoutAt: collectorHealth.payoutAt || latestOpportunity?.payoutAt || null,
      intervalMs: COLLECTOR_INTERVAL_MS,
      session: '08:30–15:00 America/Chicago',
    },
    coverage: {
      fesBuyExecutions: buys.length,
      matchedBuyExecutions: matchedExecutions.length,
      legacyOrUnmatchedBuyExecutions: unmatchedExecutions.length,
      fesActionExecutions: executions.length,
      matchedActionExecutions: matchedActions.length,
      actionContextCoverage: rateMetric(matchedActions.length, executions.length),
      entryContextCoverage: rateMetric(matchedExecutions.length, buys.length),
      finalizedActionQuotePathCoverage: rateMetric(matchedActions.filter((record) => record.spxFesQuotePath?.status === 'finalized').length, matchedActions.length),
      finalizedQuotePathCoverage: rateMetric(matchedExecutions.filter((record) => record.spxFesQuotePath?.status === 'finalized').length, matchedExecutions.length),
      qualifiedOpportunities: scopedOpportunities.length,
      qualifiedDays: qualifiedDays.size,
    },
    counts: {
      contracts: lifecycles.length,
      resolvedContracts: resolved.length,
      uniqueEventDays: new Set(lifecycles.map(recordEventDate).filter(Boolean)).size,
      resolvedEventDays: resolvedDayCount,
      qualifiedOpportunities: scopedOpportunities.length,
      qualifiedDays: qualifiedDays.size,
      actionOpportunities: actionOpportunities.length,
      actionDays: actionDays.size,
      legacyUnmatchedContracts: allLifecycles.length - lifecycles.length,
    },
    exploratory: {
      status: resolvedDayCount >= 30 ? 'minimum_sample_reached' : 'exploratory',
      resolvedEventDays: resolvedDayCount,
      minimumResolvedEventDays: 30,
      label: resolvedDayCount >= 30
        ? 'Minimum 30-day sample reached; results remain observational.'
        : `Exploratory — ${resolvedDayCount}/30 resolved FES event-days.`,
      warning: 'Confluence is ordinal context only; it is not a probability, expected value, sizing input, or order recommendation.',
    },
    actionFrequency: {
      qualifiedDayActionRate: rateMetric(actionDays.size, qualifiedDays.size),
      qualifiedStrikeActionRate: rateMetric(actionOpportunities.length, scopedOpportunities.length),
      yesRate: rateMetric(sides.filter((side) => side === 'YES').length, sides.length),
      noRate: rateMetric(sides.filter((side) => side === 'NO').length, sides.length),
      addOnRate: rateMetric(sequenceCounts.addOnCount, matchedExecutions.length, 'No matched prospective FES buy fills.'),
      reEntryRate: rateMetric(sequenceCounts.reEntryCount, matchedExecutions.length, 'No matched prospective FES buy fills.'),
      multiStrikeLadderRate: rateMetric(ladderDays, matchedActionDays.size),
      offSetupFillRate: rateMetric(offSetup, matchedExecutions.length),
      earlyExitRate: rateMetric(earlyExit, resolved.length),
      holdToResolutionRate: rateMetric(held, resolved.length),
    },
    performance: {
      resolvedContracts: resolved.length,
      uniqueEventDays: resolvedDays.size,
      netPnl: metric(resolved.length ? resolvedNet : null),
      aggregateRoi: metric(resolvedRisk > 0 ? resolvedNet / resolvedRisk : null),
      pnlPer100Risk: metric(resolvedRisk > 0 ? (resolvedNet / resolvedRisk) * 100 : null),
      profitFactor: metric(grossLosses > 0 ? grossWins / grossLosses : null, losses.length ? null : 'No realized losing contract in the selected sample.'),
      averageWin: metric(average(wins.map((record) => record.pnl)), 'No realized winning contract.'),
      averageLoss: metric(average(losses.map((record) => record.pnl)), 'No realized losing contract.'),
      fees: metric(resolved.length ? fees : null),
      expectancyPerContract: metric(average(resolved.map((record) => record.pnl))),
      maximumRealizedDrawdown: metric(maximumDrawdown(resolved)),
    },
    calibration: {
      label: 'Market-price calibration and selection; not a personal probability forecast.',
      sampleContracts: calibrationRows.length,
      hitRate: rateMetric(calibrationRows.filter((row) => row.y === 1).length, calibrationRows.length),
      profitableDayRate: rateMetric(profitableDays, dayPnl.size),
      averageFillImpliedProbability: metric(meanPaid),
      allInBreakevenProbability: metric(average(calibrationRows.map((row) => row.breakeven))),
      empiricalMinusPaidProbability: metric(empirical != null && meanPaid != null ? empirical - meanPaid : null),
      brierScore: metric(average(calibrationRows.map((row) => (row.paidProbability - row.y) ** 2))),
      logLoss: metric(logLoss),
    },
    executionAndPath: {
      sampleExecutions: executionMetricsRows.length,
      preFillSpread: metric(average(executionMetricsRows.map((row) => row.spread))),
      preFillBidDepth: metric(average(executionMetricsRows.map((row) => row.bidDepth))),
      preFillAskDepth: metric(average(executionMetricsRows.map((row) => row.askDepth))),
      fillVersusPriorAsk: metric(average(executionMetricsRows.map((row) => row.fillVsAsk))),
      depthParticipation: metric(average(executionMetricsRows.map((row) => row.depthParticipation))),
      plus5BidChange: metric(average(executionMetricsRows.map((row) => row.plus5))),
      plus15BidChange: metric(average(executionMetricsRows.map((row) => row.plus15))),
      plus30BidChange: metric(average(executionMetricsRows.map((row) => row.plus30))),
      bestBidExcursion: metric(average(executionMetricsRows.map((row) => row.best))),
      worstBidExcursion: metric(average(executionMetricsRows.map((row) => row.worst))),
      lastPreCloseBidChange: metric(average(executionMetricsRows.map((row) => row.preclose))),
    },
    outcomeGeometry: {
      label: 'ForecastEx payout is outcome authority; official-final CME settlement supplies resolver distance and margin.',
      sampleContracts: outcomeGeometryRows.length,
      officialEsSettlementCoverage: rateMetric(officialGeometry.length, outcomeGeometryRows.length),
      cashSpxCloseCoverage: rateMetric(cashCloseGeometry.length, outcomeGeometryRows.length),
      publishedCashRangeContainedCloseRate: rateMetric(
        containmentGeometry.filter((row) => row.publishedCashRangeContainedClose === true).length,
        containmentGeometry.length,
      ),
      averageDistanceToStrike: metric(average(officialGeometry.map((row) => row.distanceToStrike))),
      averageSideAdjustedSettlementMargin: metric(average(officialGeometry.map((row) => row.sideAdjustedSettlementMargin))),
      cashSpxClosingRangeZones: Object.fromEntries([...new Set(cashCloseGeometry.map((row) => row.cashSpxClosingRangeZone))]
        .sort().map((zone) => [zone, cashCloseGeometry.filter((row) => row.cashSpxClosingRangeZone === zone).length])),
      observations: [...outcomeGeometryRows]
        .sort((left, right) => String(right.eventDate || '').localeCompare(String(left.eventDate || '')))
        .slice(0, 100),
    },
    passAnalysis: {
      label: 'Hypothetical pre-fee $1 payout minus first eligible ask; never mixed with actual P&L.',
      passedOpportunities: passes.length,
      resolvedPassedOpportunities: resolvedPasses.length,
      averageCounterfactualPerContract: metric(average(passValues)),
      totalCounterfactualPerContract: metric(passValues.length ? sum(passValues) : null),
    },
    cohorts: {
      dimensions: Object.entries(COHORT_DIMENSIONS).map(([key, label]) => ({ key, label })),
      tables: cohortTables,
    },
    hands,
    provenance: Object.keys(provenance).length ? provenance : null,
  };
}

function createSpxFesResearchService({
  store,
  marketMonitorCoordinator,
  loadOfficialForecastExPrices = null,
  now = () => new Date(),
  logger = console,
  intervalMs = COLLECTOR_INTERVAL_MS,
} = {}) {
  if (!store) throw new TypeError('A prediction performance ledger store is required.');
  let timer = null;
  let running = false;
  let startedAt = null;
  let lastMaintenanceAt = 0;
  let outsideHealthChecked = false;

  async function queryPrefix(prefix) {
    if (typeof store.queryAccountPrefix === 'function') return store.queryAccountPrefix(SYSTEM_ACCOUNT_ID, prefix);
    return (await store.queryAccount(SYSTEM_ACCOUNT_ID)).filter((record) => String(record.recordKey || '').startsWith(prefix));
  }

  async function persistCreateOnly(item) {
    try {
      await store.transactSave([{ item, createOnly: true }]);
      return true;
    } catch (error) {
      if (error?.code === 'ConditionalCheckFailedException') return false;
      if (error?.code === 'TransactionCanceledException') {
        const existing = await store.get(item.accountId, item.recordKey).catch(() => null);
        if (existing) return false;
      }
      throw error;
    }
  }

  async function writeCollectorHealth(status, details = {}) {
    const timestamp = now().toISOString();
    const previous = await store.get(SYSTEM_ACCOUNT_ID, HEALTH_KEY).catch(() => null);
    const item = {
      accountId: SYSTEM_ACCOUNT_ID,
      recordKey: HEALTH_KEY,
      itemType: 'spx_fes_health',
      researchVersion: RESEARCH_VERSION,
      status,
      reason: details.reason || null,
      startedAt: previous?.startedAt || startedAt || timestamp,
      lastAttemptAt: details.lastAttemptAt || timestamp,
      lastSuccessfulCaptureAt: status === 'capturing' ? timestamp : previous?.lastSuccessfulCaptureAt || null,
      latestContextAt: details.latestContextAt || previous?.latestContextAt || null,
      generationKey: details.generationKey || previous?.generationKey || null,
      resolverSymbol: details.resolverSymbol || previous?.resolverSymbol || null,
      resolverContractMonth: details.resolverContractMonth || previous?.resolverContractMonth || null,
      resolverMonthLabel: details.resolverMonthLabel || previous?.resolverMonthLabel || null,
      measurementDate: details.measurementDate || previous?.measurementDate || null,
      lastTradeAt: details.lastTradeAt || previous?.lastTradeAt || null,
      resolutionAt: details.resolutionAt || previous?.resolutionAt || null,
      payoutAt: details.payoutAt || previous?.payoutAt || null,
      provenance: details.provenance || previous?.provenance || null,
      updatedAt: timestamp,
    };
    await store.put(item);
    return item;
  }

  async function captureSnapshot(snapshot) {
    const built = buildFesContext(snapshot, { completedAt: snapshot?.refresh?.completedAt, observedAt: now() });
    if (!built.ok) {
      await writeCollectorHealth('unavailable', { reason: built.reason });
      return built;
    }
    const context = built.context;
    await persistCreateOnly(context);
    const opportunities = context.lines.map((line) => opportunityFromContext(context, line)).filter(Boolean);
    for (const opportunity of opportunities) {
      await persistCreateOnly(opportunity);
    }
    await writeCollectorHealth('capturing', {
      latestContextAt: context.completedAt,
      generationKey: context.generationKey,
      resolverSymbol: context.resolverSymbol,
      resolverContractMonth: context.resolverContractMonth,
      resolverMonthLabel: context.resolverMonthLabel,
      measurementDate: context.eventDate,
      lastTradeAt: context.lastTradeAt,
      resolutionAt: context.resolutionAt,
      payoutAt: context.payoutAt,
      provenance: context.provenance,
    });
    return { ok: true, context, opportunities };
  }

  async function enrichCaptureResult({ accountId, result }) {
    const executionEntries = (result?.writeEntries || []).filter((entry) => {
      const item = entry?.item;
      return item?.itemType === 'execution'
        && ['BUY', 'SELL'].includes(item.direction)
        && entry.createOnly === true
        && !item.spxFesEntryContext
        && forecastExThresholdIdentity(item)?.productCode === 'FES';
    });
    const persistedHealth = executionEntries.length
      ? await store.get(SYSTEM_ACCOUNT_ID, HEALTH_KEY).catch(() => null)
      : null;
    const prospectiveStartAt = persistedHealth?.startedAt || startedAt;
    const contextsByGeneration = new Map();
    for (const entry of executionEntries) {
      const execution = entry.item;
      const identity = forecastExThresholdIdentity(execution);
      const generationKey = identity.eventContract.replace(/_(-?\d+(?:\.\d+)?)$/, '');
      if (!contextsByGeneration.has(generationKey)) {
        contextsByGeneration.set(generationKey, await queryPrefix(`${CONTEXT_PREFIX}${generationKey}#`));
      }
      const executionMs = Date.parse(execution.executionTime);
      const candidates = contextsByGeneration.get(generationKey).filter((context) => {
        const contextMs = Date.parse(context.completedAt || '');
        return Number.isFinite(contextMs) && contextMs <= executionMs && executionMs - contextMs <= ENTRY_CONTEXT_MAX_AGE_MS;
      }).sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)));
      let matched = null;
      for (const context of candidates) {
        const quoteMatch = quoteAtContext(context, identity.strike, identity.contractSide);
        if (quoteMatch) {
          matched = { context, ...quoteMatch };
          break;
        }
      }
      if (matched) {
        execution.spxFesEntryContext = compactEntryContext(
          matched.context,
          matched.line,
          identity.contractSide,
          matched.quote,
          execution.direction,
        );
        execution.spxFesEntryContext.ageMs = executionMs - Date.parse(matched.context.completedAt);
      } else {
        execution.spxFesEntryContext = {
          status: prospectiveStartAt && executionMs >= Date.parse(prospectiveStartAt) ? 'unmatched' : 'legacy_unmatched',
          researchVersion: RESEARCH_VERSION,
          reason: prospectiveStartAt && executionMs >= Date.parse(prospectiveStartAt)
            ? 'No exact completed pre-fill FES context was available within 90 seconds.'
            : 'Execution predates prospective FES context collection.',
          matchedAt: null,
        };
      }
    }
    return result;
  }

  async function finalizePathsForAccount(accountId) {
    const records = typeof store.queryAccountPrefix === 'function'
      ? await store.queryAccountPrefix(accountId, 'execution#')
      : await store.queryAccount(accountId);
    const pending = records.filter((record) => record.itemType === 'execution'
      && record.spxFesEntryContext?.status === 'matched'
      && !record.spxFesQuotePath
      && Date.parse(record.spxFesEntryContext.lastTradeAt || '') + PATH_WINDOW_GRACE_MS <= now().getTime());
    const cache = new Map();
    for (const execution of pending) {
      const generationKey = execution.spxFesEntryContext.generationKey;
      if (!cache.has(generationKey)) cache.set(generationKey, await queryPrefix(`${CONTEXT_PREFIX}${generationKey}#`));
      const path = buildQuotePath(execution, cache.get(generationKey), now().getTime());
      if (!path) continue;
      const next = { ...execution, spxFesQuotePath: path, version: Number(execution.version || 0) + 1, updatedAt: now().toISOString() };
      try {
        await store.put(next, { expectedVersion: execution.version });
      } catch (error) {
        if (error?.code !== 'ConditionalCheckFailedException') logger.warn?.(`[FES Research] quote-path finalization paused for ${execution.recordKey}: ${error.message}`);
      }
    }
  }

  async function finalizePaths() {
    const accounts = typeof store.listRegisteredManagedAccounts === 'function' ? await store.listRegisteredManagedAccounts() : [];
    for (const accountId of accounts) await finalizePathsForAccount(accountId);
  }

  async function officialOutcomeFor(opportunity, cache) {
    if (typeof loadOfficialForecastExPrices !== 'function') return null;
    const base = Date.parse(`${opportunity.eventDate}T00:00:00Z`);
    for (let offset = 0; offset <= 7; offset += 1) {
      const dataDate = new Date(base + offset * 24 * 60 * 60_000).toISOString().slice(0, 10);
      if (!cache.has(dataDate)) {
        try {
          cache.set(dataDate, await loadOfficialForecastExPrices({ dataDate }));
        } catch (_error) {
          cache.set(dataDate, null);
        }
      }
      const snapshot = cache.get(dataDate);
      let authoritativeUrl = false;
      try { authoritativeUrl = /(^|\.)forecastex\.com$/i.test(new URL(snapshot?.url).hostname); } catch (_error) { authoritativeUrl = false; }
      if (snapshot?.ok !== true
        || snapshot?.source !== 'forecastex_official_prices'
        || snapshot?.snapshotType !== 'settled_outcome_candidates'
        || snapshot?.dataDate !== dataDate
        || !authoritativeUrl
        || !/^[a-f0-9]{64}$/i.test(String(snapshot?.sha256 || ''))) continue;
      const rows = (snapshot.rows || []).filter((row) => String(row.eventContract || '').toUpperCase() === opportunity.eventContract.toUpperCase());
      const yes = rows.find((row) => row.subtype === 'YES');
      const no = rows.find((row) => row.subtype === 'NO');
      const expirationDates = new Set(rows.map((row) => dateOnly(row.expirationDate)).filter(Boolean));
      if (rows.length !== 2 || ![0, 1].includes(yes?.settlementPrice) || ![0, 1].includes(no?.settlementPrice)
        || yes.settlementPrice + no.settlementPrice !== 1
        || expirationDates.size !== 1
        || [...expirationDates][0] !== dateOnly(opportunity.resolutionAt)
        || !iso(snapshot.fetchedAt)) continue;
      const sideRow = opportunity.thesisSide === 'YES' ? yes : no;
      return {
        outcome: yes.settlementPrice === 1 ? 'YES' : 'NO',
        payoutForThesisSide: sideRow.settlementPrice,
        dataDate,
        observedAt: snapshot.fetchedAt,
        source: 'forecastex_official_prices',
        sourceUrl: snapshot.url,
        sourceHash: snapshot.sha256,
      };
    }
    return null;
  }

  async function finalizeOpportunityOutcomes() {
    const opportunities = await queryPrefix(OPPORTUNITY_PREFIX);
    const cache = new Map();
    for (const opportunity of opportunities.filter((record) => !record.outcome && Date.parse(record.resolutionAt || '') <= now().getTime())) {
      const outcome = await officialOutcomeFor(opportunity, cache);
      if (!outcome) continue;
      const next = { ...opportunity, outcome, version: Number(opportunity.version || 0) + 1, updatedAt: now().toISOString() };
      try {
        await store.put(next, { expectedVersion: opportunity.version });
      } catch (error) {
        if (error?.code !== 'ConditionalCheckFailedException') logger.warn?.(`[FES Research] opportunity outcome paused for ${opportunity.recordKey}: ${error.message}`);
      }
    }
  }

  async function tick() {
    if (running) return { status: 'busy' };
    running = true;
    try {
      const requestNow = now();
      const session = collectorWindow(requestNow);
      if (requestNow.getTime() - lastMaintenanceAt >= MAINTENANCE_INTERVAL_MS) {
        await finalizePaths();
        await finalizeOpportunityOutcomes();
        lastMaintenanceAt = requestNow.getTime();
      }
      if (!session.open) {
        if (!outsideHealthChecked) {
          const existing = await store.get(SYSTEM_ACCOUNT_ID, HEALTH_KEY).catch(() => null);
          if (existing?.status !== 'scheduled') {
            await writeCollectorHealth('scheduled', { reason: 'Outside the 08:30–15:00 CT collection window.' });
          }
          outsideHealthChecked = true;
        }
        return { status: 'scheduled', session };
      }
      outsideHealthChecked = false;
      if (!marketMonitorCoordinator || typeof marketMonitorCoordinator.refresh !== 'function') {
        await writeCollectorHealth('unavailable', { reason: 'SP500 monitor coordinator is unavailable.' });
        return { status: 'unavailable' };
      }
      await marketMonitorCoordinator.refresh('sp500');
      const snapshot = marketMonitorCoordinator.getSnapshot('sp500');
      const measurementDate = snapshot?.venues?.forecastex?.resolverIdentity?.eventDate;
      if (measurementDate !== session.date) {
        await writeCollectorHealth('scheduled', { reason: 'No FES measurement generation matches the current CT session.' });
        return { status: 'scheduled', session };
      }
      return captureSnapshot(snapshot);
    } catch (error) {
      logger.warn?.(`[FES Research] collector tick paused: ${error.message}`);
      try { await writeCollectorHealth('unavailable', { reason: error.code || error.message }); } catch (_error) { /* ledger outage remains explicit */ }
      return { status: 'unavailable', reason: error.code || error.message };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    startedAt = startedAt || now().toISOString();
    tick();
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function getResearch({ accountId, window = 'all' } = {}) {
    const accountRecordsPromise = typeof store.queryAccountPrefix === 'function'
      ? Promise.all([
        store.queryAccountPrefix(accountId, 'lifecycle#'),
        store.queryAccountPrefix(accountId, 'execution#'),
      ]).then((groups) => groups.flat())
      : store.queryAccount(accountId);
    const [accountRecords, opportunities, health] = await Promise.all([
      accountRecordsPromise,
      queryPrefix(OPPORTUNITY_PREFIX),
      store.get(SYSTEM_ACCOUNT_ID, HEALTH_KEY).catch(() => null),
    ]);
    return buildResearchResponse({ accountId, window, accountRecords, opportunities, health, now: now(), startedAt });
  }

  return {
    captureSnapshot,
    enrichCaptureResult,
    finalizeOpportunityOutcomes,
    finalizePaths,
    finalizePathsForAccount,
    getResearch,
    start,
    stop,
    tick,
  };
}

module.exports = {
  BASIS_MAX_SKEW_MS,
  COLLECTOR_INTERVAL_MS,
  CONTEXT_PREFIX,
  ENTRY_CONTEXT_MAX_AGE_MS,
  HEALTH_KEY,
  OPPORTUNITY_PREFIX,
  RESEARCH_VERSION,
  actionSequenceSummary,
  buildFesContext,
  buildQuotePath,
  buildResearchResponse,
  collectorWindow,
  collectorHealthView,
  createSpxFesResearchService,
  directionalAlignment,
  percentileZone,
  rateMetric,
  wilsonInterval,
};
