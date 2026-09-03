const MAX_POINTS_BY_RANGE = Object.freeze({ '1d': 220, '5d': 360, '10d': 520 });

function downsamplePoints(points, maximum) {
  const rows = Array.isArray(points) ? points : [];
  if (rows.length <= maximum) return rows;
  const selected = new Set([0, rows.length - 1]);
  const stride = (rows.length - 1) / (maximum - 1);
  for (let index = 1; index < maximum - 1; index += 1) {
    selected.add(Math.round(index * stride));
  }
  return [...selected].sort((left, right) => left - right).map((index) => rows[index]);
}

function compactChartVariant(variant, range) {
  if (!variant || typeof variant !== 'object') return variant;
  const maximum = MAX_POINTS_BY_RANGE[range] || MAX_POINTS_BY_RANGE['10d'];
  return {
    ...variant,
    points: downsamplePoints(variant.points, maximum),
  };
}

function compactChart(chart) {
  if (!chart || typeof chart !== 'object') return chart;
  const variants = Object.fromEntries(['1d', '5d', '10d'].map((range) => [
    range,
    compactChartVariant(chart.variants?.[range] || (range === '1d' ? chart : null), range),
  ]));
  return { ...compactChartVariant(chart, '1d'), variants };
}

function summaryContracts(contracts) {
  if (!contracts || typeof contracts !== 'object') return contracts;
  const { lines, ...summary } = contracts;
  return { ...summary, lineCount: Array.isArray(lines) ? lines.length : 0 };
}

const EVENT_FIELDS = Object.freeze([
  'ticker', 'eventTicker', 'generationId', 'venueId', 'seriesTicker', 'productCode', 'cadence',
  'title', 'status', 'openTime', 'closeTime', 'expirationTime', 'observationTime',
  'resolutionAt', 'payoutAt', 'timezone', 'settlementSources', 'rulesUrl',
  'resolverSymbol', 'resolverContractMonth', 'mutuallyExclusive',
  'availableOnBrokers', 'brokerRoutable', 'releaseKey', 'reportMonth',
  'reportMonthId', 'forecastMonth', 'releaseAt', 'metric',
]);

const LINE_FIELDS = Object.freeze([
  'ticker', 'contractId', 'threshold', 'lowerBound', 'upperBound', 'value',
  'strikeType', 'comparator', 'status', 'yesBid', 'yesAsk', 'yesBidSize',
  'yesAskSize', 'noBid', 'noAsk', 'noBidSize', 'noAskSize', 'lastTrade',
  'volume24h', 'totalVolume', 'openInterest', 'liquidity', 'updatedAt', 'closeAt',
  'openAt', 'expirationAt', 'notionalValue', 'minTick', 'title', 'source',
  'directNative', 'depthCapability', 'canCloseEarly',
]);

function pickFields(value, fields) {
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(fields
    .filter((field) => value[field] !== undefined)
    .map((field) => [field, value[field]]));
}

function lineAnchor(line) {
  const lower = Number(line?.lowerBound);
  const upper = Number(line?.upperBound);
  if (line?.comparator === 'inclusive_range' && Number.isFinite(lower) && Number.isFinite(upper)) {
    return { lower, upper, anchor: (lower + upper) / 2 };
  }
  const threshold = Number(line?.threshold ?? line?.value);
  return Number.isFinite(threshold) ? { lower: threshold, upper: threshold, anchor: threshold } : null;
}

function lineActivity(line) {
  return ['openInterest', 'volume24h', 'totalVolume', 'liquidity']
    .reduce((total, field) => total + (Number.isFinite(Number(line?.[field])) ? Number(line[field]) : 0), 0);
}

function selectLadderLines(lines, referenceValue, linesPerSide = 5, maximumWithoutReference = 10) {
  const ordered = (Array.isArray(lines) ? lines : []).map((line, originalIndex) => ({
    line,
    originalIndex,
    geometry: lineAnchor(line),
  })).filter(({ geometry }) => geometry).sort((left, right) => (
    left.geometry.anchor - right.geometry.anchor || left.originalIndex - right.originalIndex
  ));
  const reference = Number(referenceValue);
  if (!Number.isFinite(reference)) {
    return ordered
      .sort((left, right) => (
        lineActivity(right.line) - lineActivity(left.line)
        || left.geometry.anchor - right.geometry.anchor
        || String(left.line?.ticker || '').localeCompare(String(right.line?.ticker || ''))
      ))
      .slice(0, maximumWithoutReference)
      .sort((left, right) => left.geometry.anchor - right.geometry.anchor || left.originalIndex - right.originalIndex)
      .map(({ line }) => line);
  }
  const below = ordered.filter(({ geometry }) => geometry.upper < reference).slice(-linesPerSide);
  const containing = ordered.filter(({ geometry }) => geometry.lower <= reference && geometry.upper >= reference);
  const above = ordered.filter(({ geometry }) => geometry.lower > reference).slice(0, linesPerSide);
  return [...below, ...containing, ...above].map(({ line }) => line);
}

function compactContracts(contracts, referenceValue, reference = null) {
  if (!contracts || typeof contracts !== 'object') return contracts;
  const selectedLines = selectLadderLines(contracts.lines, referenceValue);
  const compact = pickFields(contracts, [
    'status', 'source', 'asOf', 'expiresAt', 'seriesTicker', 'reason', 'bookStatus',
    'bookExpiresAt', 'refreshing', 'refreshPending', 'refreshRetained',
    'refreshFailed', 'refreshIssue', 'scheduleOnly',
  ]);
  return {
    ...compact,
    event: pickFields(contracts.event, EVENT_FIELDS) || null,
    lines: selectedLines.map((line) => pickFields(line, LINE_FIELDS)),
    lineCount: Array.isArray(contracts.lines) ? contracts.lines.length : 0,
    ladderSelection: {
      displayedLineCount: selectedLines.length,
      totalLineCount: Array.isArray(contracts.lines) ? contracts.lines.length : 0,
      referenceValue: Number.isFinite(Number(referenceValue)) ? Number(referenceValue) : null,
      referenceKind: reference?.kind || null,
      referenceLabel: reference?.label || null,
      corePerSide: 5,
    },
  };
}

function compactCpiForecastComparison(comparison) {
  if (!comparison || typeof comparison !== 'object') return null;
  const source = (value, extras = {}) => value && typeof value === 'object' ? {
    status: value.status || 'unavailable',
    value: value.value != null && Number.isFinite(Number(value.value)) ? Number(value.value) : null,
    reportMonth: value.reportMonth || comparison.reportMonth || null,
    source: value.source || null,
    sourceUrl: value.sourceUrl || null,
    asOf: value.asOf || null,
    expiresAt: value.expiresAt || comparison.releaseAt || null,
    refreshPending: value.refreshPending === true,
    reason: value.reason || null,
    ...extras,
  } : null;
  const hedgeye = source(comparison.hedgeye, {
    scenarios: (Array.isArray(comparison.hedgeye?.scenarios) ? comparison.hedgeye.scenarios : [])
      .slice(0, 3)
      .map((scenario) => ({
        key: scenario?.key || null,
        label: scenario?.label || null,
        value: scenario?.value != null && Number.isFinite(Number(scenario.value))
          ? Number(scenario.value)
          : null,
      })),
    baseValue: comparison.hedgeye?.baseValue != null
      && Number.isFinite(Number(comparison.hedgeye.baseValue))
      ? Number(comparison.hedgeye.baseValue)
      : null,
  });
  const clevelandFed = source(comparison.clevelandFed, {
    points: (Array.isArray(comparison.clevelandFed?.points) ? comparison.clevelandFed.points : [])
      .slice(-120)
      .map((point) => ({ timestamp: Number(point.timestamp), value: Number(point.value) }))
      .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.value)),
    datasetAsOf: comparison.clevelandFed?.datasetAsOf || null,
  });
  const final = comparison.bls?.latestFinal;
  const bls = source(comparison.bls, {
    latestFinal: final ? {
      reportMonth: final.reportMonth || null,
      value: final.value != null && Number.isFinite(Number(final.value)) ? Number(final.value) : null,
      source: final.source || null,
      seriesId: final.seriesId || null,
      sourceUrl: final.sourceUrl || null,
    } : null,
    fetchedAt: comparison.bls?.fetchedAt || null,
    remoteStatus: comparison.bls?.remoteStatus || null,
  });
  return {
    status: comparison.status || 'unavailable',
    releaseKey: comparison.releaseKey || null,
    reportMonth: comparison.reportMonth || null,
    forecastMonth: comparison.forecastMonth || null,
    releaseAt: comparison.releaseAt || null,
    eventTicker: comparison.eventTicker || null,
    metric: comparison.metric || 'Headline CPI YoY',
    unit: comparison.unit || 'percent',
    hedgeye,
    clevelandFed,
    bls,
    reason: comparison.reason || null,
  };
}

function compactLadderReference(reference) {
  if (!reference || typeof reference !== 'object') return null;
  return {
    status: reference.status || 'unavailable',
    kind: reference.kind || null,
    label: reference.label || null,
    value: reference.value != null && Number.isFinite(Number(reference.value)) ? Number(reference.value) : null,
    reportMonth: reference.reportMonth || null,
    source: reference.source || null,
    asOf: reference.asOf || null,
    expiresAt: reference.expiresAt || null,
    availability: reference.availability || null,
    executable: false,
  };
}

function compactVenue(venue) {
  if (!venue || typeof venue !== 'object') return venue;
  const reference = venue.reference ? {
    status: venue.reference.status,
    fit: venue.reference.fit,
    resolver: venue.reference.resolver,
    directionalFeed: venue.reference.directionalFeed || null,
    basisValidation: venue.reference.basisValidation || null,
  } : null;
  return {
    id: venue.id,
    label: venue.label,
    status: venue.status,
    resolver: venue.resolver,
    settlementBasis: venue.settlementBasis,
    equivalenceFingerprint: venue.equivalenceFingerprint,
    brokerRoutable: venue.brokerRoutable === true,
    generationId: venue.generationId || null,
    resolverIdentity: venue.resolverIdentity || null,
    activity: venue.activity || null,
    bookQuality: venue.bookQuality || null,
    backgroundRefresh: venue.backgroundRefresh === true,
    // Card responses carry the selected display ladder once at the top level.
    // Venue entries retain only availability/count metadata so a large native
    // catalog cannot be duplicated into every five-second browser poll.
    catalog: summaryContracts(venue.catalog),
    book: summaryContracts(venue.book),
    contracts: summaryContracts(venue.contracts),
    reference,
  };
}

function selectionSummary(selection) {
  if (!selection || typeof selection !== 'object') return selection;
  const { contracts, ...summary } = selection;
  return { ...summary, contractSummary: summaryContracts(contracts) };
}

function compactSourceHealth(sourceHealth) {
  return (Array.isArray(sourceHealth) ? sourceHealth : []).map((entry) => ({
    id: entry.id,
    label: entry.label,
    status: entry.status,
    asOf: entry.asOf || null,
    reason: entry.reason || null,
    refreshPending: entry.refreshPending === true,
  }));
}

function compactGoldMarketReferences(references) {
  if (!Array.isArray(references)) return [];
  return references.slice(0, 3).map((reference) => ({
    key: reference?.key || null,
    label: reference?.label || null,
    symbol: reference?.symbol || null,
    role: reference?.role === 'direct' ? 'direct' : 'proxy',
    status: ['live', 'historical', 'delayed', 'loading', 'unavailable'].includes(reference?.status)
      ? reference.status
      : 'unavailable',
    price: reference?.price != null && Number.isFinite(Number(reference.price))
      ? Number(reference.price)
      : null,
    previousClose: reference?.previousClose != null && Number.isFinite(Number(reference.previousClose))
      ? Number(reference.previousClose)
      : null,
    changePercent: reference?.changePercent != null && Number.isFinite(Number(reference.changePercent))
      ? Number(reference.changePercent)
      : null,
    unit: reference?.unit || 'USD/ozt',
    source: reference?.source || null,
    instrument: reference?.instrument ? {
      symbol: reference.instrument.symbol || null,
      displaySymbol: reference.instrument.displaySymbol || null,
      conId: reference.instrument.conId != null
        && Number.isInteger(Number(reference.instrument.conId))
        ? Number(reference.instrument.conId)
        : null,
      secType: reference.instrument.secType || null,
      exchange: reference.instrument.exchange || null,
      currency: reference.instrument.currency || null,
      contractMonth: reference.instrument.contractMonth || null,
    } : null,
    asOf: reference?.asOf || null,
    expiresAt: reference?.expiresAt || null,
    retainedStatus: ['live', 'historical'].includes(reference?.retainedStatus)
      ? reference.retainedStatus
      : null,
    displayOnly: reference?.displayOnly === true,
    executable: false,
    refreshPending: reference?.refreshPending === true,
    refreshRetained: reference?.refreshRetained === true,
    delayedReason: reference?.delayedReason || null,
    reason: reference?.reason || null,
  }));
}

function compactChartReference(reference) {
  if (!reference || typeof reference !== 'object') return null;
  return {
    role: reference.role || null,
    symbol: reference.symbol || null,
    riskRangeTicker: reference.riskRangeTicker || null,
    exact: reference.exact === true,
    fit: reference.fit || null,
    instrument: reference.instrument || null,
    resolver: reference.resolver || null,
    spot: reference.spot || null,
    chart: compactChart(reference.chart),
    freshness: reference.freshness || null,
    directionalFeed: reference.directionalFeed || null,
    disclosure: reference.disclosure || null,
    backgroundRefresh: reference.backgroundRefresh === true,
  };
}

function compactChartReferences(references) {
  if (!references || typeof references !== 'object') return null;
  return {
    basis: compactChartReference(references.basis),
    contract: compactChartReference(references.contract),
  };
}

function compactResolverTracking(tracking) {
  if (!tracking || typeof tracking !== 'object') return null;
  const numeric = (value) => value != null && Number.isFinite(Number(value))
    ? Number(value)
    : null;
  const compactFinal = (value) => value && typeof value === 'object' ? {
    eventTicker: value.eventTicker || null,
    value: numeric(value.value),
    observationAt: value.observationAt || null,
    finalizedAt: value.finalizedAt || null,
    source: value.source || null,
  } : null;
  const compactSettlement = (value) => {
    const final = compactFinal(value);
    return final ? {
      ...final,
      status: value.status === 'available' ? 'available' : 'unavailable',
      availability: value.availability === 'official_final' ? 'official_final' : null,
      final: value.final === true,
    } : null;
  };
  return {
    status: ['available', 'partial', 'loading', 'unavailable'].includes(tracking.status)
      ? tracking.status
      : 'unavailable',
    source: tracking.source || null,
    resolverSymbol: tracking.resolverSymbol || null,
    proxySymbol: tracking.proxySymbol || null,
    sampleSize: Number.isInteger(Number(tracking.sampleSize)) ? Number(tracking.sampleSize) : 0,
    meanSignedErrorUsd: numeric(tracking.meanSignedErrorUsd),
    meanAbsoluteErrorUsd: numeric(tracking.meanAbsoluteErrorUsd),
    medianAbsoluteErrorUsd: numeric(tracking.medianAbsoluteErrorUsd),
    p90AbsoluteErrorUsd: numeric(tracking.p90AbsoluteErrorUsd),
    maxAbsoluteErrorUsd: numeric(tracking.maxAbsoluteErrorUsd),
    guardBandUsd: numeric(tracking.guardBandUsd),
    settlements: (Array.isArray(tracking.settlements) ? tracking.settlements : [])
      .slice(-20)
      .map(compactSettlement)
      .filter(Boolean),
    latestFinal: compactFinal(tracking.latestFinal),
    currentEventFinal: compactFinal(tracking.currentEventFinal),
    exactUrl: tracking.exactUrl || null,
    entitlement: tracking.entitlement || null,
    methodology: tracking.methodology || null,
    asOf: tracking.asOf || null,
    refreshPending: tracking.refreshPending === true,
    reason: tracking.reason || null,
  };
}

function createCardView(snapshot) {
  const selectedVenueId = snapshot?.selectedVenueId || snapshot?.displaySelection?.venueId || null;
  const selectedVenue = selectedVenueId ? snapshot?.venues?.[selectedVenueId] : null;
  const chart = compactChart(snapshot?.chart);
  const sourceContracts = snapshot?.contracts || snapshot?.displayContracts || { status: 'unavailable', event: null, lines: [] };
  const ladderReference = compactLadderReference(snapshot?.ladderReference);
  const referenceValue = snapshot?.resolverReference?.spot?.value
    ?? snapshot?.resolverReference?.lastVerifiedSpot?.value
    ?? snapshot?.spot?.value
    ?? ladderReference?.value
    ?? null;
  const contracts = compactContracts(sourceContracts, referenceValue, ladderReference);
  const venues = Object.fromEntries(Object.entries(snapshot?.venues || {}).map(([venueId, venue]) => [
    venueId,
    compactVenue(venue),
  ]));
  const settlementBasis = selectedVenue?.settlementBasis || null;
  return {
    schemaVersion: 2,
    cardView: true,
    marketId: snapshot?.marketId || null,
    displayName: snapshot?.displayName || null,
    symbol: snapshot?.symbol || null,
    precision: snapshot?.precision,
    unit: snapshot?.unit,
    generatedAt: snapshot?.generatedAt || null,
    revision: Number(snapshot?.revision) || 0,
    status: snapshot?.status || 'unavailable',
    refreshPending: snapshot?.refreshPending === true || snapshot?.sourceRefreshPending === true,
    refresh: snapshot?.refresh || null,
    session: snapshot?.session || null,
    spot: snapshot?.spot || null,
    cashSpot: snapshot?.cashSpot || null,
    spySpot: snapshot?.spySpot || null,
    chartReferences: compactChartReferences(snapshot?.chartReferences),
    goldMarketReferences: compactGoldMarketReferences(snapshot?.goldMarketReferences),
    resolverTracking: compactResolverTracking(
      snapshot?.resolverTracking || snapshot?.resolverReference?.resolverTracking,
    ),
    chart,
    directionalFeed: snapshot?.directionalFeed || snapshot?.resolverReference?.directionalFeed || null,
    basisValidation: snapshot?.basisValidation || null,
    proxyFit: snapshot?.resolverReference?.proxyFit || snapshot?.proxyFit || null,
    riskRange: snapshot?.riskRange || null,
    forecastComparison: compactCpiForecastComparison(snapshot?.forecastComparison),
    ladderReference,
    factors: snapshot?.factors || {},
    factorRows: snapshot?.factorRows || [],
    scoreInputs: snapshot?.scoreInputs || {},
    resolverMetadata: snapshot?.resolverMetadata || {},
    resolverReference: snapshot?.resolverReference ? {
      status: snapshot.resolverReference.status,
      fit: snapshot.resolverReference.fit,
      resolver: snapshot.resolverReference.resolver,
      instrument: snapshot.resolverReference.instrument || null,
      spot: snapshot.resolverReference.spot || snapshot?.spot || null,
      lastVerifiedSpot: snapshot.resolverReference.lastVerifiedSpot || null,
      proxyFit: snapshot.resolverReference.proxyFit || snapshot?.proxyFit || null,
      directionalFeed: snapshot.resolverReference.directionalFeed || null,
      basisValidation: snapshot.resolverReference.basisValidation || null,
    } : null,
    settlementSummary: settlementBasis ? {
      status: settlementBasis.status,
      instrumentScope: settlementBasis.instrumentScope || null,
      instrument: settlementBasis.instrument || null,
      method: settlementBasis.method || null,
      observationAt: settlementBasis.observationAt || null,
      sourceName: settlementBasis.sourceName || null,
      sourceUrl: settlementBasis.sourceUrl || null,
      reason: settlementBasis.reason || null,
    } : null,
    selectedVenueId,
    selection: snapshot?.selection || null,
    selectedGenerationId: snapshot?.selectedGenerationId || null,
    selectedGeneration: snapshot?.selectedGeneration ? {
      ...snapshot.selectedGeneration,
      lines: undefined,
    } : null,
    generationOptions: (snapshot?.generationOptions || []).map((generation) => ({
      ...generation,
      lines: undefined,
    })),
    productActivity: snapshot?.productActivity || null,
    venues,
    autoSelection: selectionSummary(snapshot?.autoSelection),
    displaySelection: selectionSummary(snapshot?.displaySelection),
    contracts,
    executionContracts: summaryContracts(snapshot?.executionContracts),
    strategy: snapshot?.strategy || null,
    sourceHealth: compactSourceHealth(snapshot?.sourceHealth),
    compactHealth: {
      status: snapshot?.status || 'unavailable',
      sourceCount: Array.isArray(snapshot?.sourceHealth) ? snapshot.sourceHealth.length : 0,
      errorCount: Array.isArray(snapshot?.errors) ? snapshot.errors.length : 0,
      generatedAt: snapshot?.generatedAt || null,
    },
    errors: snapshot?.errors || [],
  };
}

module.exports = {
  MAX_POINTS_BY_RANGE,
  createCardView,
  downsamplePoints,
};
