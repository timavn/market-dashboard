import predictionMarketAth from './predictionMarketAth.cjs';
import analyticsDailyBrief from './analyticsDailyBrief.cjs';

const {
  retainVerifiedAthWhilePending,
  synchronizeVerifiedAthAcrossChartRanges,
} = predictionMarketAth;

const FORBIDDEN_REFERENCE_SOURCE = /(?:mock|seed|fixture|fallback|cache|portfolio|delayed|frozen|stale|offline|disconnected|synthetic|inferred|derived)/i;

const finite = (value) => (
  value !== null
  && value !== undefined
  && value !== ''
  && Number.isFinite(Number(value))
);

const sectionUsable = (section, nowMs = Date.now()) => {
  if (!section || !['available', 'partial', 'historical'].includes(section.status)) return false;
  if (section.refreshFailed === true || section.fromCache === true || section.cachedOnly === true
    || section.cacheOnly === true || section.seeded === true || section.mock === true || section.stale === true) return false;
  if ((section.refreshing === true || section.refreshPending === true) && section.refreshRetained !== true) return false;
  const status = String(section.status || '').toLowerCase();
  const availability = String(section.availability || '').toLowerCase();
  if (status === 'historical' || availability === 'historical') {
    const historicalThroughDate = String(section.historicalThroughDate || '');
    const latestAt = Date.parse(section.latestAt || section.asOf || '');
    const latestDate = Number.isFinite(latestAt) ? new Date(latestAt).toISOString().slice(0, 10) : null;
    const source = String(section.source || '');
    return /^\d{4}-\d{2}-\d{2}$/.test(historicalThroughDate)
      && latestDate === historicalThroughDate
      && !FORBIDDEN_REFERENCE_SOURCE.test(source);
  }
  if (!section.expiresAt) return true;
  const expiresAt = Date.parse(section.expiresAt);
  return Number.isFinite(expiresAt) && nowMs <= expiresAt;
};

const verifiedDisplayReference = (section, nowMs = Date.now()) => {
  const status = String(section?.status || '').toLowerCase();
  const availability = String(section?.availability || '').toLowerCase();
  const source = String(section?.source || '').trim();
  const asOf = Date.parse(section?.asOf || '');
  const expiresAt = Date.parse(section?.expiresAt || '');
  const historicalThroughDate = String(section?.historicalThroughDate || '');
  const datedHistorical = status === 'historical' || availability === 'historical';
  const historicalDateMatches = datedHistorical
    && Number.isFinite(asOf)
    && /^\d{4}-\d{2}-\d{2}$/.test(historicalThroughDate)
    && new Date(asOf).toISOString().slice(0, 10) === historicalThroughDate;
  const retainedRefresh = section?.refreshRetained === true
    && (section?.refreshPending === true || section?.refreshing === true);
  return ['available', 'historical'].includes(status)
    && ['live', 'current', 'historical'].includes(availability || (datedHistorical ? 'historical' : ''))
    && ['exact', 'proxy'].includes(String(section?.fit || 'exact').toLowerCase())
    && finite(section?.value)
    && source.length > 0
    && !FORBIDDEN_REFERENCE_SOURCE.test(source)
    && (section?.refreshing !== true || retainedRefresh)
    && (section?.refreshPending !== true || retainedRefresh)
    && section?.refreshFailed !== true
    && section?.fromCache !== true
    && section?.cachedOnly !== true
    && section?.seeded !== true
    && Number.isFinite(asOf)
    && asOf <= nowMs + 5_000
    && (historicalDateMatches || (!datedHistorical && Number.isFinite(expiresAt) && nowMs <= expiresAt));
};

const retainDisplayReferenceDuringRefresh = (previous, next, nowMs = Date.now()) => {
  const pending = String(next?.status || '').toLowerCase() === 'refreshing'
    || next?.refreshing === true
    || next?.refreshPending === true;
  if (!pending || !verifiedDisplayReference(previous, nowMs)) return next;
  return {
    ...previous,
    refreshing: false,
    refreshPending: true,
    refreshRetained: true,
    refreshFailed: false,
    refreshIssue: null,
  };
};

const retainPendingOrFailedSection = (previous, next, nowMs) => {
  const pending = String(next?.status || '').toLowerCase() === 'refreshing'
    || next?.refreshing === true
    || next?.refreshPending === true;
  const retained = Boolean(
    (next?.refreshFailed === true || pending)
    && sectionUsable(previous, nowMs),
  );
  return {
    retained,
    value: retained ? {
      ...previous,
      refreshing: false,
      refreshPending: pending,
      refreshRetained: pending,
      refreshFailed: next?.refreshFailed === true,
      refreshIssue: next?.refreshIssue || next?.reason || (pending ? null : 'Refresh delayed'),
    } : next,
  };
};

const verifiedFreshNativeBook = (section, nowMs) => {
  const expiresAt = Date.parse(section?.bookExpiresAt || section?.expiresAt || '');
  const source = String(section?.source || '').trim();
  const lines = Array.isArray(section?.lines) ? section.lines : [];
  return ['available', 'partial'].includes(String(section?.status || '').toLowerCase())
    && source.length > 0
    && !FORBIDDEN_REFERENCE_SOURCE.test(source)
    && !/historical/i.test(source)
    && section?.refreshFailed !== true
    && Number.isFinite(expiresAt)
    && nowMs <= expiresAt
    && lines.some((line) => line?.directNative === true
      && [line.yesBid, line.yesAsk, line.noBid, line.noAsk].some(finite));
};

const isFesNativeBook = (section) => {
  const eventIdentity = `${section?.event?.productCode || ''} ${section?.event?.seriesTicker || ''} ${section?.event?.ticker || ''}`;
  return /(?:^|\s)FES(?:_|\s|$)/i.test(eventIdentity)
    || (Array.isArray(section?.lines)
      && section.lines.some((line) => /^FES_/i.test(String(line?.contractId || line?.ticker || ''))));
};

const isCpiNativeBook = (section) => {
  const eventIdentity = `${section?.event?.seriesTicker || ''} ${section?.event?.ticker || ''}`;
  return /(?:^|\s)KXCPIYOY(?:-|\s|$)/i.test(eventIdentity)
    || (Array.isArray(section?.lines)
      && section.lines.some((line) => /^KXCPIYOY-/i.test(String(line?.ticker || ''))));
};

const retainNativeBookDuringRefresh = (previous, next, nowMs) => {
  const nextStatus = String(next?.status || '').toLowerCase();
  if (next?.refreshRetained === true && verifiedFreshNativeBook(next, nowMs)) return next;
  const pending = (nextStatus === 'refreshing' || next?.refreshing === true || next?.refreshPending === true)
    && next?.refreshFailed !== true;
  if (!pending
    || (!isFesNativeBook(previous) && !isCpiNativeBook(previous))
    || !verifiedFreshNativeBook(previous, nowMs)) return next;
  return {
    ...previous,
    refreshing: false,
    refreshPending: true,
    refreshRetained: true,
    refreshFailed: false,
    refreshIssue: null,
  };
};

const verifiedChartSectionDuringRefresh = (section, nowMs) => {
  const status = String(section?.status || '').toLowerCase();
  const availability = String(section?.availability || '').toLowerCase();
  const source = String(section?.source || '').trim();
  const expiresAt = Date.parse(section?.expiresAt || '');
  const historicalThroughDate = String(section?.historicalThroughDate || '');
  const latestAt = Date.parse(section?.latestAt || section?.asOf || '');
  const datedHistorical = (status === 'historical' || availability === 'historical')
    && Number.isFinite(latestAt)
    && /^\d{4}-\d{2}-\d{2}$/.test(historicalThroughDate)
    && new Date(latestAt).toISOString().slice(0, 10) === historicalThroughDate;
  return ['available', 'partial', 'historical'].includes(status)
    && source.length > 0
    && !FORBIDDEN_REFERENCE_SOURCE.test(source)
    && section?.refreshFailed !== true
    && section?.fromCache !== true
    && section?.cachedOnly !== true
    && section?.stale !== true
    && section?.seeded !== true
    && Array.isArray(section?.points)
    && section.points.length >= 2
    && (datedHistorical || (Number.isFinite(expiresAt) && nowMs <= expiresAt));
};

const retainChartSectionDuringRefresh = (previous, next, nowMs) => {
  if (verifiedChartSectionDuringRefresh(next, nowMs)) return next;
  const refreshing = next?.status === 'refreshing'
    || next?.refreshing === true
    || next?.refreshPending === true;
  if (!verifiedChartSectionDuringRefresh(previous, nowMs)) return next;
  return {
    ...previous,
    refreshing: false,
    refreshPending: refreshing,
    refreshRetained: true,
    refreshFailed: false,
    refreshIssue: refreshing ? null : next?.refreshIssue || next?.reason || 'Chart refresh unavailable.',
    displayDelayed: !refreshing,
  };
};

const publicationDateForSession = (date) => {
  const timestamp = Date.parse(`${date}T12:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return null;
  const publication = new Date(timestamp);
  if (publication.toISOString().slice(0, 10) !== date) return null;
  while (!analyticsDailyBrief.isMarketDay(publication)) publication.setUTCDate(publication.getUTCDate() - 1);
  return publication.toISOString().slice(0, 10);
};

const verifiedDailyRiskRange = (range) => {
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
      && !FORBIDDEN_REFERENCE_SOURCE.test(source)
      && (carriedForward
        ? publicationDateForSession(date) === publicationDate
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
};

const retainRiskRangeOverlaysDuringRefresh = (previous, next) => {
  if (!previous
    || previous.refreshFailed === true
    || previous.fromCache === true
    || previous.cachedOnly === true
    || previous.seeded === true
    || FORBIDDEN_REFERENCE_SOURCE.test(String(previous.source || ''))
    || !next
    || next.riskRangeRefreshPending !== true
    || next.refreshFailed === true
    || next.fromCache === true
    || next.cachedOnly === true
    || next.seeded === true
    || FORBIDDEN_REFERENCE_SOURCE.test(String(next.source || ''))
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
      riskRangePublicationDate: prior.riskRangePublicationDate,
      riskRangeCarryForward: prior.riskRangeCarryForward,
      ...(prior.structure ? { structure: prior.structure } : {}),
      reason: null,
      refreshPending: true,
      refreshRetained: true,
    };
  });
  if (!retained) return next;
  const missingDates = dailyRanges
    .filter((range) => !verifiedDailyRiskRange(range))
    .map((range) => range.date);
  return {
    ...next,
    dailyRanges,
    riskRangeStatus: missingDates.length ? 'partial' : 'available',
    riskRangeMissingDates: missingDates,
    riskRangeRefreshPending: true,
    riskRangeRefreshRetained: true,
  };
};

const retainChartDuringRefresh = (previous, next, nowMs) => {
  if (!next) return next;
  const retainedRoot = retainVerifiedAthWhilePending(
    previous,
    retainRiskRangeOverlaysDuringRefresh(
      previous,
      retainChartSectionDuringRefresh(previous, next, nowMs),
    ),
  );
  if (!next.variants) return synchronizeVerifiedAthAcrossChartRanges(retainedRoot);
  const previousVariants = previous?.variants || {};
  const variants = Object.fromEntries(Object.entries(next.variants).map(([range, variant]) => [
    range,
    retainVerifiedAthWhilePending(
      previousVariants[range] || (range === '1d' ? previous : null),
      retainRiskRangeOverlaysDuringRefresh(
        previousVariants[range] || (range === '1d' ? previous : null),
        retainChartSectionDuringRefresh(
          previousVariants[range] || (range === '1d' ? previous : null),
          variant,
          nowMs,
        ),
      ),
    ),
  ]));
  return synchronizeVerifiedAthAcrossChartRanges({ ...retainedRoot, variants });
};

const catalogOnlySection = (catalog, reason) => {
  if (!catalog || catalog.status !== 'available' || !Array.isArray(catalog.lines)) return null;
  return {
    ...catalog,
    source: catalog.source || 'venue_catalog',
    lines: catalog.lines.map((line) => ({
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
      updatedAt: null,
      directNative: false,
      nativeOrderbook: undefined,
    })),
    scheduleOnly: true,
    bookStatus: 'refresh_failed',
    reason,
  };
};

const populatedChart = (section) => (
  Array.isArray(section?.points) && section.points.length >= 2
);

const pendingChartShell = (section, range) => ({
  ...(section || {}),
  status: 'refreshing',
  availability: section?.availability || 'unavailable',
  range: section?.range || range,
  points: Array.isArray(section?.points) ? section.points : [],
  refreshing: true,
  refreshPending: true,
  refreshFailed: false,
});

const normalizeRefreshingChartShell = (previous, next) => {
  const rootRefreshing = next?.refresh?.state === 'refreshing'
    || next?.refreshing === true
    || next?.refreshPending === true;
  if (!rootRefreshing || !previous?.chart) return next;
  const nextChart = next.chart;
  const rootChart = populatedChart(nextChart)
    ? nextChart
    : pendingChartShell(nextChart, '1d');
  const priorVariants = previous.chart?.variants || {};
  const incomingVariants = nextChart?.variants || {};
  const variantKeys = [...new Set([
    ...Object.keys(priorVariants),
    ...Object.keys(incomingVariants),
  ])];
  if (!variantKeys.length) return { ...next, chart: rootChart };
  const variants = Object.fromEntries(variantKeys.map((range) => {
    const variant = incomingVariants[range];
    return [range, populatedChart(variant) ? variant : pendingChartShell(variant, range)];
  }));
  return { ...next, chart: { ...rootChart, variants } };
};

export function mergePredictionMonitorSnapshots(previous, incoming, nowMs = Date.now()) {
  // The perpetual provider owns freshness and pending retention. Do not bring
  // legacy spot prices or failed direct data back through the resource cache.
  if (incoming?.perpetualReference || previous?.perpetualReference) return incoming;
  // GDP has no progressive price/reference merge: a failed native refresh must
  // replace the prior ladder while its independently dated research survives.
  if (incoming?.marketId === 'gdp') return incoming;
  if (!previous || !incoming || previous.marketId !== incoming.marketId) return incoming;
  const next = normalizeRefreshingChartShell(previous, incoming);
  const sameCpiRelease = next.marketId !== 'cpi'
    || (
      previous.forecastComparison?.releaseKey
      && previous.forecastComparison.releaseKey === next.forecastComparison?.releaseKey
    );
  const mergedSpot = retainDisplayReferenceDuringRefresh(previous.spot, next.spot, nowMs);
  const spot = { retained: mergedSpot !== next.spot, value: mergedSpot };
  const chart = { retained: false, value: retainChartDuringRefresh(previous.chart, next.chart, nowMs) };
  const riskRange = retainPendingOrFailedSection(previous.riskRange, next.riskRange, nowMs);
  const hasVenueFailureMetadata = Array.isArray(next.autoSelection?.refreshFailedVenueIds);
  const failedVenueIds = new Set(next.autoSelection?.refreshFailedVenueIds || []);
  const previousAutoVenueId = previous.autoSelection?.venueId;
  const previousExactVenues = previous.autoSelection?.contracts?.comparedVenues || [];
  const autoRefreshMatchesPrevious = previousAutoVenueId === 'exact-best'
    ? previousExactVenues.length > 0 && previousExactVenues.every((id) => failedVenueIds.has(id))
    : failedVenueIds.has(previousAutoVenueId);
  const nextContracts = hasVenueFailureMetadata && next.contracts?.refreshFailed && !autoRefreshMatchesPrevious
    ? { ...next.contracts, refreshFailed: false, refreshIssue: null }
    : next.contracts;
  const retainedContracts = retainNativeBookDuringRefresh(
    sameCpiRelease ? previous.contracts : null,
    nextContracts,
    nowMs,
  );
  const contracts = { retained: retainedContracts !== nextContracts, value: retainedContracts };
  const selectedDisplayVenueId = next.displaySelection?.venueId;
  const selectedDisplayVenue = next.venues?.[selectedDisplayVenueId];
  const selectedBookFailed = [selectedDisplayVenue?.book, selectedDisplayVenue?.contracts, next.contracts]
    .some((section) => section?.refreshFailed === true
      || ((section?.refreshing === true || section?.refreshPending === true)
        && section?.refreshRetained !== true));
  const safeDisplayCatalog = selectedBookFailed
    ? catalogOnlySection(
        selectedDisplayVenue?.catalog,
        selectedDisplayVenue?.book?.refreshIssue
          || selectedDisplayVenue?.contracts?.refreshIssue
          || next.contracts?.refreshIssue
          || 'Native book refresh failed.',
      )
    : null;
  const nextDisplayContracts = safeDisplayCatalog || next.displayContracts || next.displaySelection?.contracts;
  const retainedDisplayContracts = safeDisplayCatalog
    ? nextDisplayContracts
    : retainNativeBookDuringRefresh(
        sameCpiRelease ? previous.displayContracts : null,
        nextDisplayContracts,
        nowMs,
      );
  const displayContracts = {
    retained: retainedDisplayContracts !== nextDisplayContracts,
    value: retainedDisplayContracts,
  };
  const factorKeys = [...new Set([
    ...Object.keys(previous.factors || {}),
    ...Object.keys(next.factors || {}),
  ])];
  const factorSections = Object.fromEntries(factorKeys.map((key) => [
    key,
    retainPendingOrFailedSection(previous.factors?.[key], next.factors?.[key], nowMs),
  ]));
  const factors = Object.fromEntries(factorKeys.map((key) => [key, factorSections[key].value]));
  const previousFactorRows = new Map((previous.factorRows || []).map((row) => [row.id, row]));
  const factorRows = (next.factorRows || []).map((row) => {
    const retained = row.id === 'riskRange'
      ? riskRange.retained
      : factorSections[row.id]?.retained === true;
    return retained && previousFactorRows.has(row.id)
      ? { ...previousFactorRows.get(row.id), refreshDelayed: true }
      : row;
  });
  const previousInputs = previous.scoreInputs || {};
  const nextInputs = next.scoreInputs || {};
  const nextResolverGenerationKey = next.venues?.forecastex?.generationKey
    || next.venues?.forecastex?.book?.event?.ticker
    || null;
  const previousLastVerifiedSpot = previous.resolverReference?.lastVerifiedSpot;
  const previousLastRetainedUntil = Date.parse(previousLastVerifiedSpot?.retainedUntil || '');
  const lastVerifiedSpot = next.resolverReference?.lastVerifiedSpot || (
    previousLastVerifiedSpot
    && Number.isFinite(previousLastRetainedUntil)
    && nowMs < previousLastRetainedUntil
    && (!nextResolverGenerationKey || nextResolverGenerationKey === previousLastVerifiedSpot.generationKey)
      ? previousLastVerifiedSpot
      : null
  );
  const resolverReference = (next.resolverReference || lastVerifiedSpot)
    ? {
        ...(next.resolverReference || previous.resolverReference),
        ...(next.resolverReference ? {
          spot: retainDisplayReferenceDuringRefresh(
            previous.resolverReference?.spot,
            next.resolverReference.spot,
            nowMs,
          ),
          chart: retainChartDuringRefresh(
            previous.resolverReference?.chart,
            next.resolverReference.chart,
            nowMs,
          ),
        } : {}),
        lastVerifiedSpot,
      }
    : next.resolverReference;

  const venueKeys = [...new Set([
    ...Object.keys(previous.venues || {}),
    ...Object.keys(next.venues || {}),
  ])];
  const venues = Object.fromEntries(venueKeys.map((key) => {
    const previousVenue = sameCpiRelease ? previous.venues?.[key] : null;
    const nextVenue = next.venues?.[key];
    if (!nextVenue) return [key, previousVenue];
    const nextBook = nextVenue.book || nextVenue.contracts;
    const retainedBook = retainNativeBookDuringRefresh(
      previousVenue?.book || previousVenue?.contracts,
      nextBook,
      nowMs,
    );
    const previousGeneration = String(previousVenue?.generationId || previousVenue?.generationKey || '');
    const nextGeneration = String(nextVenue?.generationId || nextVenue?.generationKey || '');
    const sameGeneration = previousGeneration && nextGeneration && previousGeneration === nextGeneration;
    const reference = nextVenue.reference ? {
      ...nextVenue.reference,
      spot: sameGeneration
        ? retainDisplayReferenceDuringRefresh(
            previousVenue?.reference?.spot,
            nextVenue.reference.spot,
            nowMs,
          )
        : nextVenue.reference.spot,
      chart: sameGeneration
        ? retainChartDuringRefresh(previousVenue?.reference?.chart, nextVenue.reference.chart, nowMs)
        : nextVenue.reference.chart,
    } : nextVenue.reference;
    if (retainedBook !== nextBook) {
      return [key, {
        ...nextVenue,
        status: retainedBook?.status || nextVenue.status,
        book: retainedBook,
        contracts: retainedBook,
        reference,
        ladderSelection: nextVenue.ladderSelection
          || (sameGeneration ? previousVenue?.ladderSelection : null)
          || null,
        bookQuality: previousVenue?.bookQuality || nextVenue.bookQuality,
      }];
    }
    const failed = [nextVenue.book, nextVenue.contracts]
      .some((section) => section?.refreshFailed === true
        || ((section?.refreshing === true || section?.refreshPending === true)
          && section?.refreshRetained !== true));
    if (!failed) return [key, {
      ...nextVenue,
      contracts: nextVenue.contracts,
      book: nextVenue.book,
      reference,
    }];
    const reason = nextVenue.book?.refreshIssue
      || nextVenue.contracts?.refreshIssue
      || nextVenue.book?.reason
      || nextVenue.contracts?.reason
      || 'Native book refresh failed.';
    const book = {
      status: nextVenue.book?.refreshing || nextVenue.contracts?.refreshing
        || nextVenue.book?.refreshPending || nextVenue.contracts?.refreshPending
        ? 'refreshing' : 'refresh_failed',
      source: null,
      asOf: null,
      expiresAt: null,
      event: nextVenue.catalog?.event || null,
      lines: [],
      refreshFailed: !nextVenue.book?.refreshing && !nextVenue.contracts?.refreshing
        && !nextVenue.book?.refreshPending && !nextVenue.contracts?.refreshPending,
      refreshing: nextVenue.book?.refreshing === true || nextVenue.contracts?.refreshing === true,
      refreshPending: nextVenue.book?.refreshPending === true || nextVenue.contracts?.refreshPending === true,
      refreshIssue: reason,
      reason,
    };
    return [key, {
      ...nextVenue,
      status: nextVenue.catalog?.status === 'available' ? 'partial' : 'unavailable',
      catalog: catalogOnlySection(nextVenue.catalog, reason) || nextVenue.catalog,
      contracts: book,
      book,
      reference,
      bookQuality: {
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
  const retainedSelectedVenueBook = venues[selectedDisplayVenueId]?.book?.refreshRetained === true;
  const mergedDisplayContracts = retainedSelectedVenueBook
    && verifiedFreshNativeBook(previous.displayContracts, nowMs)
    ? {
        ...previous.displayContracts,
        refreshing: false,
        refreshPending: true,
        refreshRetained: true,
        refreshFailed: false,
        refreshIssue: venues[selectedDisplayVenueId]?.book?.refreshIssue || null,
      }
    : displayContracts.value;

  return {
    ...next,
    spot: spot.value,
    chart: chart.value,
    riskRange: riskRange.value,
    resolverReference,
    contracts: contracts.value,
    displayContracts: mergedDisplayContracts,
    factors,
    factorRows,
    venues,
    autoSelection: next.autoSelection ? {
      ...next.autoSelection,
      contracts: next.marketId === 'cpi'
        ? next.autoSelection.contracts
        : contracts.value,
    } : next.autoSelection,
    displaySelection: next.displaySelection ? {
      ...next.displaySelection,
      contracts: mergedDisplayContracts,
    } : next.displaySelection,
    scoreInputs: {
      ...nextInputs,
      targetDate: contracts.retained ? previousInputs.targetDate : nextInputs.targetDate,
      riskRange: riskRange.retained ? previousInputs.riskRange : nextInputs.riskRange,
      trade: factorSections.trade?.retained ? previousInputs.trade : nextInputs.trade,
      usd: factorSections.usd?.retained ? previousInputs.usd : nextInputs.usd,
      vix: factorSections.vix?.retained ? previousInputs.vix : nextInputs.vix,
      marketStructure: factorSections.gamma?.retained || factorSections.structure?.retained
        ? previousInputs.marketStructure
        : nextInputs.marketStructure,
    },
  };
}

/** Resource-policy adapter used by the shared session resource commit path. */
export function reconcilePredictionMonitorSnapshot({
  currentData,
  currentReferenceData,
  incomingData,
  nowMs = Date.now(),
}) {
  const previous = currentData?.marketId === incomingData?.marketId
    ? currentData
    : currentReferenceData?.marketId === incomingData?.marketId
      ? currentReferenceData
      : null;
  const reconciled = mergePredictionMonitorSnapshots(previous, incomingData, nowMs);
  if (reconciled?.perpetualReference || currentReferenceData?.perpetualReference) return reconciled;
  if (
    currentReferenceData?.marketId !== incomingData?.marketId
    || !currentReferenceData?.chart
    || !reconciled?.chart
  ) return reconciled;
  return {
    ...reconciled,
    chart: retainChartDuringRefresh(
      currentReferenceData.chart,
      reconciled.chart,
      nowMs,
    ),
  };
}

export default reconcilePredictionMonitorSnapshot;
