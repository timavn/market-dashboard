const MARKET_ORDER = Object.freeze(['sp500', 'wti', 'nasdaq100', 'gold']);

const MARKET_LABELS = Object.freeze({
  sp500: 'S&P 500',
  wti: 'WTI',
  nasdaq100: 'Nasdaq 100',
  gold: 'Gold',
});

const DIRECT_BOOK_MAX_AGE_MS = 2 * 60 * 1000;
const FORBIDDEN_PROVENANCE = /delayed|frozen|stale|cache(?:d|_only|-only)?|mock|seed|fallback|offline|disconnected|historical|synthetic|inferred|derived/i;
const REFRESH_FAILURE = /refresh(?:[_ -]?(?:failed|failure|error|issue|timeout|timed out))|(?:failed|failure|error).*refresh/i;

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function dateKey(value) {
  return String(value || '').match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || null;
}

function normalizedDirection(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (['BULLISH', 'BULL', 'LONG', 'BUY'].includes(normalized)) return 'BULLISH';
  if (['BEARISH', 'BEAR', 'SHORT', 'SELL'].includes(normalized)) return 'BEARISH';
  if (['NEUTRAL', 'FLAT', 'MIXED'].includes(normalized)) return 'NEUTRAL';
  return null;
}

function refreshFailed(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.refreshFailed === true || value.stale === true || value.cachedOnly === true) return true;
  const evidence = [
    value.source,
    value.status,
    value.freshness,
    value.availability,
    value.provenance,
    value.cacheState,
    value.refreshState,
    value.refreshIssue,
    value.reason,
    value.warning,
    value.error,
  ].filter(Boolean).join(' ');
  return Boolean(value.refreshIssue
    || FORBIDDEN_PROVENANCE.test(evidence)
    || REFRESH_FAILURE.test(evidence));
}

function futureTimestamp(value, nowMs) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && parsed > nowMs;
}

function openEvent(event, nowMs) {
  return Boolean(
    event
    && typeof event === 'object'
    && String(event.status || '').toLowerCase() === 'open'
    && futureTimestamp(event.closeTime, nowMs),
  );
}

function usableCurrentSection(value, nowMs) {
  if (!value || typeof value !== 'object' || value.status !== 'available' || refreshFailed(value)) return false;
  if (value.expiresAt && !futureTimestamp(value.expiresAt, nowMs)) return false;
  return true;
}

function unavailable(reason, extras = {}) {
  return {
    status: 'unavailable',
    asOf: null,
    source: null,
    reason,
    ...extras,
  };
}

function normalizeRiskRange(value, nowMs) {
  const lrr = finiteNumber(value?.lrr);
  const hrr = finiteNumber(value?.hrr);
  const trend = normalizedDirection(value?.trend);
  if (!usableCurrentSection(value, nowMs) || lrr == null || hrr == null || !(lrr < hrr)) {
    return unavailable(value?.reason || 'Current Risk Range is unavailable.', {
      lrr: null,
      hrr: null,
      buyTrade: null,
      sellTrade: null,
      previousClose: null,
      trend: null,
      date: dateKey(value?.date),
      fit: value?.fit || null,
      ticker: value?.ticker || null,
      setupEligible: false,
    });
  }
  return {
    status: 'available',
    lrr,
    hrr,
    buyTrade: lrr,
    sellTrade: hrr,
    previousClose: finiteNumber(value?.previousClose ?? value?.prevClose),
    trend,
    date: dateKey(value.date),
    fit: value.fit || null,
    setupEligible: !['related_only', 'strong_proxy', 'proxy'].includes(String(value.fit || '').toLowerCase()),
    ticker: value.ticker || null,
    source: value.source || null,
    asOf: value.asOf || null,
    expiresAt: value.expiresAt || null,
    reason: value.reason || null,
  };
}

function normalizeTrade(value, nowMs, requiredDate) {
  const direction = normalizedDirection(value?.direction ?? value?.raw);
  const tradeDate = dateKey(value?.date);
  const sessionDate = dateKey(requiredDate);
  if (!usableCurrentSection(value, nowMs) || !direction || !sessionDate || tradeDate !== sessionDate) {
    return unavailable(value?.reason || 'Same-session Trade signal is unavailable.', {
      direction: null,
      date: tradeDate,
      ticker: value?.ticker || null,
    });
  }
  return {
    status: 'available',
    direction,
    raw: value.raw || value.direction || null,
    date: tradeDate,
    ticker: value.ticker || null,
    source: value.source || null,
    asOf: value.asOf || null,
    expiresAt: value.expiresAt || null,
    reason: null,
  };
}

function normalizeReference(value, nowMs) {
  const price = finiteNumber(value?.value);
  const availability = String(value?.availability || '').toLowerCase();
  const fit = String(value?.fit || '').toLowerCase();
  const currentExact = usableCurrentSection(value, nowMs)
    && availability === 'live'
    && fit === 'exact'
    && price != null;
  if (!currentExact) {
    return unavailable(value?.reason || 'Current exact resolver reference is unavailable.', {
      value: null,
      label: value?.label || null,
      availability: value?.availability || 'unavailable',
      fit: value?.fit || null,
      contextValue: price,
      contextAsOf: value?.asOf || null,
    });
  }
  return {
    status: 'available',
    value: price,
    label: value.label || null,
    availability: 'live',
    fit: 'exact',
    source: value.source || null,
    asOf: value.asOf || null,
    expiresAt: value.expiresAt || null,
    reason: null,
  };
}

function normalizeUsd(value, nowMs) {
  const r30 = finiteNumber(value?.r30 ?? value?.value);
  if (!usableCurrentSection(value, nowMs) || r30 == null || r30 < -1 || r30 > 1) {
    return unavailable(value?.reason || 'Current exact USD correlation is unavailable.', {
      r15: null,
      r30: null,
      r90: null,
      contextOnly: true,
    });
  }
  return {
    status: 'available',
    r15: finiteNumber(value.r15),
    r30,
    r90: finiteNumber(value.r90),
    source: value.source || null,
    asOf: value.asOf || value.timestamp || null,
    expiresAt: value.expiresAt || null,
    reason: value.reason || 'Correlation context only; never an executable price.',
    contextOnly: true,
  };
}

function normalizeCftc(value, nowMs) {
  const zScore1Y = finiteNumber(value?.zScore1Y ?? value?.value);
  if (!usableCurrentSection(value, nowMs) || zScore1Y == null) {
    return unavailable(value?.reason || 'Current verified CFTC z-score is unavailable.', {
      zScore1Y: null,
      zScore3Y: null,
      contextOnly: true,
    });
  }
  return {
    status: 'available',
    zScore1Y,
    zScore3Y: finiteNumber(value.zScore3Y),
    latest: finiteNumber(value.latest),
    weeklyChange: finiteNumber(value.weeklyChange),
    source: value.source || null,
    asOf: value.asOf || null,
    expiresAt: value.expiresAt || null,
    reason: value.reason || 'Official positioning context only.',
    contextOnly: true,
  };
}

function normalizeCatalog(value, nowMs) {
  const lines = Array.isArray(value?.lines) ? value.lines : [];
  if (!usableCurrentSection(value, nowMs) || !openEvent(value.event, nowMs) || !lines.length) {
    return unavailable(value?.reason || 'No current contract catalog is available.', {
      event: null,
      contractCount: 0,
      catalogOnly: true,
    });
  }
  return {
    status: 'available',
    source: value.source || null,
    asOf: value.asOf || null,
    expiresAt: value.expiresAt || value.event.closeTime || null,
    event: {
      ticker: value.event.ticker || null,
      seriesTicker: value.event.seriesTicker || value.seriesTicker || null,
      title: value.event.title || null,
      closeTime: value.event.closeTime || null,
      availableOnBrokers: value.event.availableOnBrokers === true,
      brokerRoutable: value.event.brokerRoutable === true,
    },
    contractCount: lines.length,
    catalogOnly: true,
    reason: 'Contract geometry only; prices are omitted unless a verified direct native book is present.',
  };
}

function completeDirectLine(line) {
  const yesBid = finiteNumber(line?.yesBid);
  const yesAsk = finiteNumber(line?.yesAsk);
  const noBid = finiteNumber(line?.noBid);
  const noAsk = finiteNumber(line?.noAsk);
  const yesBidSize = finiteNumber(line?.yesBidSize);
  const yesAskSize = finiteNumber(line?.yesAskSize);
  return Boolean(
    line
    && line.directNative === true
    && !refreshFailed(line)
    && !FORBIDDEN_PROVENANCE.test(String(line.source || ''))
    && yesBid != null && yesAsk != null && noBid != null && noAsk != null
    && yesBid >= 0 && yesAsk > yesBid && yesAsk <= 1
    && noBid >= 0 && noAsk > noBid && noAsk <= 1
    && yesBidSize > 0 && yesAskSize > 0,
  );
}

function lineMidpoint(line) {
  return (Number(line.yesBid) + Number(line.yesAsk)) / 2;
}

function normalizeDirectLine(line) {
  return {
    ticker: line.ticker || line.contractId || null,
    threshold: finiteNumber(line.threshold),
    lowerBound: finiteNumber(line.lowerBound),
    upperBound: finiteNumber(line.upperBound),
    comparator: line.comparator || null,
    yesBid: finiteNumber(line.yesBid),
    yesAsk: finiteNumber(line.yesAsk),
    yesBidSize: finiteNumber(line.yesBidSize),
    yesAskSize: finiteNumber(line.yesAskSize),
    noBid: finiteNumber(line.noBid),
    noAsk: finiteNumber(line.noAsk),
    noBidSize: finiteNumber(line.noBidSize),
    noAskSize: finiteNumber(line.noAskSize),
    volume24h: finiteNumber(line.volume24h),
    openInterest: finiteNumber(line.openInterest),
    updatedAt: line.updatedAt || null,
    source: line.source || null,
    liveVerified: true,
  };
}

function normalizeDirectBook(snapshot, nowMs) {
  const selection = snapshot?.displaySelection || snapshot?.autoSelection;
  const contracts = selection?.contracts || snapshot?.displayContracts;
  const venueId = selection?.venueId || null;
  const venue = venueId ? snapshot?.venues?.[venueId] : null;
  const asOfMs = Date.parse(String(contracts?.asOf || ''));
  const directLines = (Array.isArray(contracts?.lines) ? contracts.lines : [])
    .filter(completeDirectLine)
    .sort((left, right) => (
      Math.abs(lineMidpoint(left) - 0.5) - Math.abs(lineMidpoint(right) - 0.5)
      || (finiteNumber(right.volume24h) || 0) - (finiteNumber(left.volume24h) || 0)
    ));
  const current = selection?.status === 'available'
    && contracts?.status === 'available'
    && !refreshFailed(selection)
    && !refreshFailed(contracts)
    && openEvent(contracts.event, nowMs)
    && Number.isFinite(asOfMs)
    && nowMs - asOfMs >= -5_000
    && nowMs - asOfMs <= DIRECT_BOOK_MAX_AGE_MS
    && futureTimestamp(contracts.expiresAt, nowMs)
    && venue?.brokerRoutable === true
    && venue?.bookQuality?.eligible === true
    && directLines.length > 0;
  if (!current) {
    return unavailable(selection?.reason || contracts?.reason || 'No verified direct native book is available.', {
      venueId,
      lineCount: 0,
      focusLines: [],
      directNative: false,
      executionVerified: false,
    });
  }
  return {
    status: 'available',
    venueId,
    source: contracts.source || null,
    asOf: contracts.asOf || null,
    expiresAt: contracts.expiresAt || null,
    lineCount: directLines.length,
    focusLines: directLines.slice(0, 5).map(normalizeDirectLine),
    allLines: directLines.map(normalizeDirectLine),
    directNative: true,
    executionVerified: false,
    reason: 'Verified direct native book for research; The Analyst does not execution-verify or place orders.',
  };
}

function locateInRiskRange(value, riskRange, metadata = {}) {
  if (value == null || riskRange.status !== 'available') {
    return {
      status: 'unavailable',
      zone: null,
      value: null,
      positionPct: null,
      referenceType: null,
      referenceLabel: null,
      referenceAsOf: null,
      liveVerified: false,
      researchContextOnly: false,
      reason: metadata.reason || 'A verified reference and current Risk Range are both required.',
    };
  }
  const width = riskRange.hrr - riskRange.lrr;
  const lowerThird = riskRange.lrr + (width / 3);
  const upperThird = riskRange.hrr - (width / 3);
  let zone = 'MIDDLE';
  if (value < riskRange.lrr) zone = 'BELOW_LRR';
  else if (value <= lowerThird) zone = 'LRR';
  else if (value > riskRange.hrr) zone = 'ABOVE_HRR';
  else if (value >= upperThird) zone = 'HRR';
  return {
    status: 'available',
    zone,
    value,
    positionPct: Math.round((((value - riskRange.lrr) / width) * 100) * 10) / 10,
    distanceToLrr: value - riskRange.lrr,
    distanceToHrr: riskRange.hrr - value,
    referenceType: metadata.referenceType || null,
    referenceLabel: metadata.referenceLabel || null,
    referenceAsOf: metadata.referenceAsOf || null,
    source: metadata.source || null,
    liveVerified: metadata.liveVerified === true,
    researchContextOnly: metadata.researchContextOnly === true,
    reason: null,
  };
}

function rangeLocation(reference, riskRange) {
  if (reference.status !== 'available') {
    return locateInRiskRange(null, riskRange, {
      reason: 'Current exact reference and Risk Range are both required.',
    });
  }
  return locateInRiskRange(reference.value, riskRange, {
    referenceType: 'live',
    referenceLabel: reference.label || 'Live',
    referenceAsOf: reference.asOf || null,
    source: reference.source || null,
    liveVerified: true,
    researchContextOnly: false,
  });
}

function publishedRangeLocation(riskRange) {
  if (riskRange.status !== 'available' || riskRange.previousClose == null) {
    return locateInRiskRange(null, riskRange, {
      reason: 'The current Risk Range publication does not contain a verified previous close.',
    });
  }
  return locateInRiskRange(riskRange.previousClose, riskRange, {
    referenceType: 'risk_range_previous_close',
    referenceLabel: 'RR close',
    referenceAsOf: riskRange.date || riskRange.asOf || null,
    source: riskRange.source || null,
    liveVerified: false,
    researchContextOnly: true,
  });
}

function setupScreen({ riskRange, trade, reference, location, directBook, strategy }) {
  const reasons = [];
  if (riskRange.status !== 'available' || !riskRange.trend) reasons.push('Current Risk Range Trend is unavailable.');
  if (riskRange.status === 'available' && riskRange.setupEligible === false) {
    reasons.push('The available Risk Range is proxy or related-index context and is not setup-eligible.');
  }
  if (trade.status !== 'available' || !trade.direction) reasons.push('Same-session Trade signal is unavailable.');
  if (reference.status !== 'available') reasons.push('Current exact resolver reference is unavailable.');
  const aligned = Boolean(
    riskRange.trend
    && trade.direction
    && riskRange.trend === trade.direction,
  );
  if (riskRange.trend && trade.direction && !aligned) reasons.push('Trade and Trend are not aligned.');
  let pattern = null;
  const eligibleRange = riskRange.status === 'available' && riskRange.setupEligible !== false;
  if (aligned && eligibleRange && trade.direction === 'BULLISH' && location.zone === 'LRR') pattern = 'BULLISH_AT_LRR';
  if (aligned && eligibleRange && trade.direction === 'BEARISH' && location.zone === 'HRR') pattern = 'BEARISH_AT_HRR';
  if (aligned && eligibleRange && location.status === 'available' && !pattern) {
    reasons.push(`Aligned ${trade.direction} signals are not in the required ${trade.direction === 'BULLISH' ? 'LRR' : 'HRR'} zone.`);
  }
  const researchQualified = Boolean(pattern);
  if (directBook.status !== 'available') reasons.push('No verified direct native book is available.');
  if (strategy?.status !== 'available') reasons.push(strategy?.reason || 'No validated contract strategy is available.');
  const rankEligible = researchQualified
    && directBook.status === 'available'
    && strategy?.status === 'available';
  return {
    status: researchQualified ? 'matched' : reasons.length ? 'incomplete' : 'no_match',
    pattern,
    tradeTrendAligned: aligned,
    researchQualified,
    rankEligible,
    recommendationAllowed: false,
    reasons: [...new Set(reasons)],
  };
}

function normalizeMarket(marketId, snapshot, nowMs) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.marketId !== marketId) {
    return {
      marketId,
      label: MARKET_LABELS[marketId],
      monitorStatus: 'unavailable',
      monitorAsOf: null,
      catalog: unavailable('The market monitor is unavailable.', { event: null, contractCount: 0, catalogOnly: true }),
      directBook: unavailable('The market monitor is unavailable.', { venueId: null, lineCount: 0, focusLines: [], directNative: false, executionVerified: false }),
      riskRange: unavailable('Current Risk Range is unavailable.', {
        lrr: null, hrr: null, buyTrade: null, sellTrade: null, previousClose: null,
        trend: null, fit: null, ticker: null, setupEligible: false,
      }),
      trade: unavailable('Same-session Trade signal is unavailable.', { direction: null, date: null }),
      bias: { status: 'unavailable', trade: null, trend: null, aligned: false },
      reference: unavailable('Current exact resolver reference is unavailable.', { value: null }),
      rangeLocation: { status: 'unavailable', zone: null, value: null, reason: 'Current exact reference and Risk Range are both required.' },
      publishedRangeLocation: { status: 'unavailable', zone: null, value: null, reason: 'Current Risk Range previous close is unavailable.' },
      rangePosition: { status: 'unavailable', zone: null, value: null, positionPct: null, reason: 'No verified range-position reference is available.' },
      usdCorrelation: unavailable('Current exact USD correlation is unavailable.', { r15: null, r30: null, r90: null, contextOnly: true }),
      cftcZScore: unavailable('Current verified CFTC z-score is unavailable.', { zScore1Y: null, zScore3Y: null, contextOnly: true }),
      strategy: { status: 'unavailable', model: null, reason: 'The market monitor is unavailable.' },
      setup: {
        status: 'incomplete', pattern: null, tradeTrendAligned: false, researchQualified: false,
        rankEligible: false, recommendationAllowed: false, reasons: ['The market monitor is unavailable.'],
      },
    };
  }

  const catalog = normalizeCatalog(snapshot.displayContracts, nowMs);
  const directBook = normalizeDirectBook(snapshot, nowMs);
  const monitorLiveRefreshFailed = snapshot.refresh?.state === 'error'
    || Boolean(snapshot.refresh?.lastError);
  // Research products are status/freshness-gated independently. A quote or
  // book refresh failure must not erase a still-current daily Risk Range.
  const riskRange = normalizeRiskRange(snapshot.riskRange, nowMs);
  const trade = normalizeTrade(snapshot.factors?.trade, nowMs, riskRange.date);
  const reference = monitorLiveRefreshFailed
    ? unavailable('The latest market-monitor refresh failed.', { value: null })
    : normalizeReference(snapshot.spot, nowMs);
  const location = rangeLocation(reference, riskRange);
  const publicationLocation = publishedRangeLocation(riskRange);
  const rangePosition = location.status === 'available' ? location : publicationLocation;
  const usdCorrelation = normalizeUsd(snapshot.factors?.usd, nowMs);
  const cftcZScore = normalizeCftc(snapshot.factors?.cftc, nowMs);
  const strategy = {
    status: snapshot.strategy?.status === 'available' ? 'available' : 'unavailable',
    model: snapshot.strategy?.model || null,
    eligibleVenueId: snapshot.strategy?.eligibleVenueId || null,
    reason: snapshot.strategy?.reason || null,
  };
  const setup = setupScreen({ riskRange, trade, reference, location, directBook, strategy });

  return {
    marketId,
    label: MARKET_LABELS[marketId],
    monitorStatus: snapshot.status || 'unavailable',
    monitorAsOf: snapshot.generatedAt || null,
    catalog,
    directBook,
    riskRange,
    trade,
    bias: {
      status: riskRange.trend && trade.direction ? (riskRange.trend === trade.direction ? 'aligned' : 'misaligned') : 'unavailable',
      trade: trade.direction,
      trend: riskRange.trend,
      aligned: Boolean(riskRange.trend && trade.direction && riskRange.trend === trade.direction),
    },
    reference,
    rangeLocation: location,
    publishedRangeLocation: publicationLocation,
    rangePosition,
    usdCorrelation,
    cftcZScore,
    strategy,
    setup,
  };
}

function buildMorningReport(snapshots, { now = new Date() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const markets = MARKET_ORDER.map((marketId) => normalizeMarket(
    marketId,
    snapshots?.[marketId],
    safeNowMs,
  ));
  const catalogCount = markets.filter((market) => market.catalog.status === 'available').length;
  const directBookCount = markets.filter((market) => market.directBook.status === 'available').length;
  const matchedSetupCount = markets.filter((market) => market.setup.researchQualified).length;
  const rankEligibleCount = markets.filter((market) => market.setup.rankEligible).length;
  const monitorTimes = markets.map((market) => isoTimestamp(market.monitorAsOf)).filter(Boolean).sort();
  const status = catalogCount === MARKET_ORDER.length ? 'available' : catalogCount ? 'partial' : 'unavailable';
  const warnings = markets.flatMap((market) => (
    market.monitorStatus === 'unavailable' ? [`${market.label} monitor is unavailable.`] : []
  ));
  return {
    schemaVersion: 1,
    reportType: 'four_market_morning',
    generatedAt: new Date(safeNowMs).toISOString(),
    asOf: monitorTimes[0] || null,
    status,
    marketOrder: [...MARKET_ORDER],
    summary: {
      requestedMarketCount: MARKET_ORDER.length,
      currentCatalogCount: catalogCount,
      verifiedDirectBookCount: directBookCount,
      executionVerifiedCount: 0,
      matchedSetupCount,
      rankEligibleCount,
    },
    markets,
    warnings,
    policy: {
      archiveUsedForCurrentFields: false,
      catalogPricesAreLive: false,
      currentFieldsMayUseArchiveFallback: false,
      rankOnlyWhenRankEligible: true,
      recommendationAllowed: false,
      requiredPattern: 'BULLISH Trade + BULLISH Trend in the LRR zone, or BEARISH Trade + BEARISH Trend in the HRR zone.',
      tradeLevelSemantics: 'Risk Range LRR and HRR are the published BUY TRADE and SELL TRADE levels; they are not a separate directional Trade signal.',
      rangePositionSemantics: 'Prefer a verified live exact reference. If unavailable, use only the previous close in the same current Risk Range publication and label it RR close.',
      missingFieldBehavior: 'Report unavailable explicitly; never substitute an older publication, inferred value, complementary quote, or model estimate.',
    },
  };
}

module.exports = {
  MARKET_ORDER,
  buildMorningReport,
  normalizeMarket,
  setupScreen,
};
