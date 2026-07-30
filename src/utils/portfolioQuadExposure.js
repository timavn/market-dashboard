import {
  getExposureDefinition,
  getExposureQuadFit,
  normalizeQuadKey,
  resolveSecurityExposureProfile,
} from '../constants/quadExposureCatalog';

const LIVE_POSITION_SOURCES = new Set(['ibkr_api', 'ibkr_live_session']);
const DERIVATIVE_SECURITY_TYPES = new Set(['OPT', 'FOP', 'FUT']);
const QUAD_KEYS = ['q1', 'q2', 'q3', 'q4'];

const UNAVAILABLE = Object.freeze({
  portfolio_unavailable: 'Portfolio data is unavailable.',
  non_ibkr_source: 'A verified IBKR API portfolio snapshot is required.',
  live_session_unverified: 'The IBKR portfolio session is not verified live.',
  cached_snapshot: 'Cached portfolio snapshots cannot be used for Quad exposure weights.',
  forbidden_snapshot_source: 'Mock, seeded, or stale portfolio data cannot be used for Quad exposure weights.',
  stale_data_quality: 'Portfolio data quality is stale or unavailable.',
  non_live_marks: 'Every weighted holding requires a verified live IBKR mark.',
  nav_unavailable: 'A positive live IBKR net liquidation value is required.',
  holding_market_value_unavailable: 'Every weighted holding requires a finite live market value.',
  holding_source_unverified: 'Every weighted holding must come from the verified IBKR position feed.',
});

const finiteNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const normalizedText = (value) => String(value || '').trim().toLowerCase();
const isValidObservedAt = (value) => Number.isFinite(Date.parse(String(value || '')));

const normalizeFit = (fit) => {
  const rawStatus = normalizedText(fit?.status);
  let status = 'not-listed';
  if (['best', 'favored', 'favorable', 'favoured', 'positive'].includes(rawStatus)) {
    status = 'favored';
  } else if (
    ['worst', 'unfavorable', 'unfavourable', 'negative', 'avoid'].includes(rawStatus)
  ) {
    status = 'unfavorable';
  }

  const rank = finiteNumber(fit?.rank);
  return {
    status,
    rank: rank != null && rank > 0 ? rank : null,
  };
};

const fitScore = (fit) => {
  const normalized = normalizeFit(fit);
  if (normalized.status === 'favored') {
    return 200 - (normalized.rank ?? 99);
  }
  if (normalized.status === 'unfavorable') {
    // Worst #1 is more adverse than Worst #5.
    return normalized.rank ?? 99;
  }
  return 100;
};

/**
 * Compare a prior Quad fit with a current Quad fit.
 *
 * Lower "Best" ranks are stronger and lower "Worst" ranks are more adverse.
 * Missing/not-listed exposure sits between the best and worst lists.
 */
export function compareQuadFit(previousFitOrOptions, currentFitArgument) {
  const isOptionsShape = (
    currentFitArgument === undefined
    && previousFitOrOptions
    && typeof previousFitOrOptions === 'object'
    && (
      Object.prototype.hasOwnProperty.call(previousFitOrOptions, 'previousFit')
      || Object.prototype.hasOwnProperty.call(previousFitOrOptions, 'currentFit')
    )
  );
  const previousFit = isOptionsShape
    ? previousFitOrOptions.previousFit
    : previousFitOrOptions;
  const currentFit = isOptionsShape
    ? previousFitOrOptions.currentFit
    : currentFitArgument;
  const previousScore = fitScore(previousFit);
  const currentScore = fitScore(currentFit);

  if (currentScore > previousScore) return 'improved';
  if (currentScore < previousScore) return 'deteriorated';
  return 'unchanged';
}

const normalizeSide = (value) => {
  if (typeof value === 'number') {
    if (value > 0) return 'long';
    if (value < 0) return 'short';
    return 'flat';
  }
  const normalized = normalizedText(value);
  if (['long', 'buy', 'bought'].includes(normalized)) return 'long';
  if (['short', 'sell', 'sold'].includes(normalized)) return 'short';
  return 'flat';
};

/**
 * Classify a position's direction against a Quad fit.
 *
 * Long best / short worst is aligned. Long worst / short best is opposed.
 */
export function classifyPositionAlignment(sideOrOptions, fitArgument) {
  const isOptionsShape = (
    fitArgument === undefined
    && sideOrOptions
    && typeof sideOrOptions === 'object'
  );
  const side = normalizeSide(
    isOptionsShape
      ? sideOrOptions.side ?? sideOrOptions.positionSide
      : sideOrOptions,
  );
  const fit = normalizeFit(
    isOptionsShape
      ? sideOrOptions.fit ?? sideOrOptions.currentFit
      : fitArgument,
  );

  if (side === 'flat' || fit.status === 'not-listed') return 'unscored';
  if (
    (side === 'long' && fit.status === 'favored')
    || (side === 'short' && fit.status === 'unfavorable')
  ) {
    return 'aligned';
  }
  return 'opposed';
}

const combineAlignments = (alignments) => {
  const scored = new Set(
    alignments.filter((alignment) => alignment === 'aligned' || alignment === 'opposed'),
  );
  if (scored.size > 1) return 'mixed';
  if (scored.has('aligned')) return 'aligned';
  if (scored.has('opposed')) return 'opposed';
  return 'unscored';
};

const isCashHolding = (holding = {}) => {
  const securityType = String(
    holding.secType ?? holding.securityType ?? holding.assetType ?? '',
  ).trim().toUpperCase();
  const assetClass = normalizedText(holding.assetClass);
  const symbol = normalizedText(holding.symbol);
  return (
    securityType === 'CASH'
    || assetClass === 'cash'
    || symbol === 'cash & cash investments'
  );
};

const isDerivativeHolding = (holding = {}) => {
  const securityType = String(
    holding.secType ?? holding.securityType ?? holding.assetType ?? '',
  ).trim().toUpperCase();
  return (
    DERIVATIVE_SECURITY_TYPES.has(securityType)
    || normalizedText(holding.assetClass) === 'derivatives'
  );
};

const isCurrentHolding = (holding = {}) => {
  if (isCashHolding(holding)) return false;
  const quantity = finiteNumber(
    holding.quantity ?? holding.position ?? holding.shares,
  );
  const marketValue = finiteNumber(holding.marketValue);
  if (quantity != null) return quantity !== 0 || (marketValue != null && marketValue !== 0);
  if (marketValue != null) return marketValue !== 0;
  return true;
};

const getVerifiedDerivativeExposure = (holding = {}) => {
  if (!isDerivativeHolding(holding)) return null;
  const genericVerified = holding.economicExposureVerified === true;
  const candidates = [
    {
      value: holding.deltaAdjustedMarketValue,
      verified: genericVerified || holding.deltaAdjustedMarketValueVerified === true,
      state: holding.deltaAdjustedMarketValueState ?? holding.economicExposureState,
    },
    {
      value: holding.economicExposureMarketValue,
      verified: genericVerified || holding.economicExposureMarketValueVerified === true,
      state: holding.economicExposureState,
    },
    {
      value: holding.economicNotional,
      verified: genericVerified || holding.economicNotionalVerified === true,
      state: holding.economicNotionalState ?? holding.economicExposureState,
    },
  ];

  const candidate = candidates.find((entry) => (
    entry.verified
    && normalizedText(entry.state) === 'live'
    && finiteNumber(entry.value) != null
  ));
  return candidate ? finiteNumber(candidate.value) : null;
};

const getWeightingValue = (holding) => (
  isDerivativeHolding(holding)
    ? getVerifiedDerivativeExposure(holding)
    : finiteNumber(holding.marketValue)
);

const hasForbiddenFlag = (value = {}) => (
  value.cacheOnly === true
  || value.cached === true
  || value.fromCache === true
  || value.mock === true
  || value.isMock === true
  || value.seed === true
  || value.seeded === true
  || value.isSeed === true
  || value.stale === true
);

const unavailableResult = (code, details = {}) => ({
  available: false,
  availability: 'unavailable',
  code,
  message: UNAVAILABLE[code] || UNAVAILABLE.portfolio_unavailable,
  reason: UNAVAILABLE[code] || UNAVAILABLE.portfolio_unavailable,
  nav: null,
  navSource: null,
  ...details,
});

/**
 * Return whether a portfolio snapshot is safe for live weighting.
 */
export function getPortfolioExposureAvailability(portfolioData) {
  if (!portfolioData || typeof portfolioData !== 'object') {
    return unavailableResult('portfolio_unavailable');
  }
  if (portfolioData.dataSource !== 'ibkr_api') {
    return unavailableResult('non_ibkr_source');
  }
  if (portfolioData.liveSessionVerified !== true) {
    return unavailableResult('live_session_unverified');
  }
  if (portfolioData.fromCache !== false) {
    return unavailableResult('cached_snapshot');
  }
  if (
    hasForbiddenFlag(portfolioData)
    || hasForbiddenFlag(portfolioData.meta)
    || hasForbiddenFlag(portfolioData._cache)
    || hasForbiddenFlag(portfolioData.dataQuality)
  ) {
    return unavailableResult('forbidden_snapshot_source');
  }

  const dataQuality = portfolioData.dataQuality || {};
  const qualityStatus = normalizedText(dataQuality.status);
  if (qualityStatus !== 'ok') {
    return unavailableResult('stale_data_quality');
  }
  if (normalizedText(dataQuality.markState) !== 'live') {
    return unavailableResult('non_live_marks');
  }

  const accountNav = finiteNumber(portfolioData.accountSummary?.netLiquidation);
  const summaryNav = finiteNumber(portfolioData.summary?.totalValue);
  const nav = accountNav != null && accountNav > 0
    ? accountNav
    : summaryNav != null && summaryNav > 0
      ? summaryNav
      : null;
  const navSource = accountNav != null && accountNav > 0
    ? 'accountSummary.netLiquidation'
    : summaryNav != null && summaryNav > 0
      ? 'summary.totalValue'
      : null;
  if (nav == null) {
    return unavailableResult('nav_unavailable');
  }

  const currentHoldings = Array.isArray(portfolioData.holdings)
    ? portfolioData.holdings.filter(isCurrentHolding)
    : [];
  const weightedHoldings = currentHoldings.filter((holding) => (
    !isDerivativeHolding(holding) || getVerifiedDerivativeExposure(holding) != null
  ));

  for (const holding of weightedHoldings) {
    if (
      hasForbiddenFlag(holding)
      || normalizedText(holding.priceState) !== 'live'
      || normalizedText(holding.marketValueState) !== 'live'
      || normalizedText(holding.priceSource) !== 'ibkr_live_last'
      || !isValidObservedAt(holding.priceObservedAt)
    ) {
      return unavailableResult('non_live_marks', {
        holdingSymbol: holding.symbol || holding.localSymbol || null,
      });
    }
    if (!LIVE_POSITION_SOURCES.has(normalizedText(holding.positionSource))) {
      return unavailableResult('holding_source_unverified', {
        holdingSymbol: holding.symbol || holding.localSymbol || null,
      });
    }
    if (finiteNumber(holding.marketValue) == null || getWeightingValue(holding) == null) {
      return unavailableResult('holding_market_value_unavailable', {
        holdingSymbol: holding.symbol || holding.localSymbol || null,
      });
    }
  }

  return {
    available: true,
    availability: 'live',
    code: 'live',
    message: 'Verified live portfolio exposure is available.',
    reason: null,
    nav,
    navSource,
  };
}

const safeExposureDefinition = (exposureId) => {
  try {
    return getExposureDefinition(exposureId);
  } catch (_error) {
    return null;
  }
};

const safeSecurityProfile = (holding) => {
  try {
    return resolveSecurityExposureProfile(
      holding,
      holding?.conid ?? holding?.conId ?? holding?.contractId,
    );
  } catch (_error) {
    return null;
  }
};

const safeExposureFit = (exposureId, quadKey) => {
  if (!quadKey) return null;
  try {
    const fit = getExposureQuadFit(exposureId, quadKey);
    return fit ? normalizeFit(fit) : { status: 'not-listed', rank: null };
  } catch (_error) {
    return { status: 'not-listed', rank: null };
  }
};

const normalizeProfile = (holding) => {
  const profile = safeSecurityProfile(holding);
  const primaryExposureId = profile?.primaryExposureId || null;
  const secondaryExposureIds = Array.isArray(profile?.secondaryExposureIds)
    ? profile.secondaryExposureIds
    : [];
  const exposureIds = [...new Set(
    [primaryExposureId, ...secondaryExposureIds].filter(Boolean),
  )];
  const definitions = exposureIds
    .map(safeExposureDefinition)
    .filter(Boolean);
  const validExposureIds = new Set(definitions.map((definition) => definition.id));
  const validPrimaryExposureId = validExposureIds.has(primaryExposureId)
    ? primaryExposureId
    : null;
  const classificationStatus = (
    validPrimaryExposureId
    && ['reviewed', 'provisional'].includes(normalizedText(profile?.classificationStatus))
  )
    ? normalizedText(profile.classificationStatus)
    : 'unclassified';

  return {
    primaryExposureId: validPrimaryExposureId,
    secondaryExposureIds: definitions
      .map((definition) => definition.id)
      .filter((id) => id !== validPrimaryExposureId),
    definitions,
    classificationStatus,
    classificationSource: profile?.classificationSource || 'unmapped',
    classificationVersion: profile?.classificationVersion || null,
  };
};

const makePositionKey = (holding, portfolioData, ordinal) => {
  const accountId = String(
    holding.accountId ?? holding.account ?? portfolioData?.accountId ?? 'unknown-account',
  ).trim() || 'unknown-account';
  const conid = holding.conid ?? holding.conId ?? holding.contractId;
  if (conid !== null && conid !== undefined && String(conid).trim()) {
    return `${accountId}#${String(conid).trim()}`;
  }
  const symbol = String(
    holding.symbol ?? holding.localSymbol ?? 'UNKNOWN',
  ).trim().toUpperCase() || 'UNKNOWN';
  return `${accountId}#${symbol}#${ordinal + 1}`;
};

const sideForHolding = (holding, weightingValue = null) => {
  const marketValue = weightingValue ?? finiteNumber(holding.marketValue);
  if (marketValue != null && marketValue !== 0) {
    return normalizeSide(marketValue);
  }
  return normalizeSide(
    finiteNumber(holding.quantity ?? holding.position ?? holding.shares) ?? 0,
  );
};

const quadFitsForDefinition = (definition) => QUAD_KEYS.reduce((fits, quadKey) => {
  fits[quadKey] = safeExposureFit(definition.id, quadKey);
  return fits;
}, {});

const makePositionLabel = ({
  definition,
  primaryExposureId,
  currentQuad,
  previousQuad,
  side,
}) => {
  const currentFit = safeExposureFit(definition.id, currentQuad);
  const previousFit = safeExposureFit(definition.id, previousQuad);
  return {
    exposureId: definition.id,
    id: definition.id,
    label: definition.label,
    dimension: definition.dimension,
    isPrimary: definition.id === primaryExposureId,
    quadFits: quadFitsForDefinition(definition),
    currentFit,
    previousFit,
    transition: previousQuad
      ? compareQuadFit(previousFit, currentFit)
      : 'unchanged',
    alignment: classifyPositionAlignment(side, currentFit),
  };
};

const sortExposures = (left, right) => (
  right.grossPct - left.grossPct
  || left.label.localeCompare(right.label)
);

const aggregateAlignment = (contributors) => (
  combineAlignments(contributors.map((contributor) => contributor.alignment))
);

/**
 * Aggregate one selected portfolio snapshot into overlapping Quad exposure lenses.
 */
export function aggregatePortfolioQuadExposures({
  portfolioData,
  currentQuad,
  previousQuad = null,
} = {}) {
  const normalizedCurrentQuad = normalizeQuadKey(currentQuad);
  const normalizedPreviousQuad = normalizeQuadKey(previousQuad);
  const availability = getPortfolioExposureAvailability(portfolioData);
  const holdings = Array.isArray(portfolioData?.holdings)
    ? portfolioData.holdings.filter(isCurrentHolding)
    : [];
  const nav = availability.available ? availability.nav : null;

  const positions = holdings.map((holding, ordinal) => {
    const profile = normalizeProfile(holding);
    const derivative = isDerivativeHolding(holding);
    const weightingValue = availability.available
      ? getWeightingValue(holding)
      : null;
    const side = sideForHolding(holding, weightingValue);
    const labels = profile.definitions.map((definition) => makePositionLabel({
      definition,
      primaryExposureId: profile.primaryExposureId,
      currentQuad: normalizedCurrentQuad,
      previousQuad: normalizedPreviousQuad,
      side,
    }));
    const canWeight = Boolean(
      availability.available
      && (!derivative || weightingValue != null)
    );
    const weightPct = canWeight ? (weightingValue / nav) * 100 : null;
    const accountId = holding.accountId
      ?? holding.account
      ?? portfolioData?.accountId
      ?? null;
    const conid = holding.conid ?? holding.conId ?? holding.contractId ?? null;

    return {
      positionKey: makePositionKey(holding, portfolioData, ordinal),
      accountId,
      conid,
      symbol: holding.symbol || holding.ticker || holding.localSymbol || 'UNKNOWN',
      localSymbol: holding.localSymbol || null,
      description: holding.description || '',
      secType: holding.secType || holding.securityType || holding.assetType || null,
      quantity: finiteNumber(
        holding.quantity ?? holding.position ?? holding.shares,
      ),
      currency: holding.currency || null,
      exchange: holding.exchange || holding.primaryExchange || null,
      side,
      classificationStatus: profile.classificationStatus,
      classificationSource: profile.classificationSource,
      classificationVersion: profile.classificationVersion,
      primaryExposureId: profile.primaryExposureId,
      secondaryExposureIds: profile.secondaryExposureIds,
      labels,
      marketValue: canWeight ? weightingValue : null,
      weightPct,
      grossWeightPct: weightPct == null ? null : Math.abs(weightPct),
      weightAvailability: canWeight,
      weightUnavailableReason: canWeight
        ? null
        : derivative && getVerifiedDerivativeExposure(holding) == null
          ? 'Verified live delta-adjusted market value or economic notional is required for derivatives.'
          : availability.message,
      alignment: combineAlignments(labels.map((label) => label.alignment)),
    };
  });

  const reviewedPositions = positions.filter(
    (position) => position.classificationStatus === 'reviewed',
  );
  const provisionalPositions = positions.filter(
    (position) => position.classificationStatus === 'provisional',
  );
  const unclassifiedPositions = positions.filter(
    (position) => position.classificationStatus === 'unclassified',
  );
  const baseCoverage = {
    totalPositionCount: positions.length,
    positionCount: positions.length,
    reviewedPositionCount: reviewedPositions.length,
    classifiedPositionCount: reviewedPositions.length,
    provisionalPositionCount: provisionalPositions.length,
    unclassifiedPositionCount: unclassifiedPositions.length,
    labeledPositionCount: reviewedPositions.length + provisionalPositions.length,
    unquantifiedPositionCount: positions.filter(
      (position) => position.weightAvailability === false,
    ).length,
    classificationCoveragePct: positions.length > 0
      ? (reviewedPositions.length / positions.length) * 100
      : 100,
  };

  if (!availability.available) {
    return {
      availability,
      currentQuad: normalizedCurrentQuad,
      previousQuad: normalizedPreviousQuad,
      nav: null,
      positions,
      exposures: [],
      coverage: {
        ...baseCoverage,
        totalGrossWeightPct: null,
        classifiedGrossWeightPct: null,
        provisionalGrossWeightPct: null,
        unclassifiedGrossWeightPct: null,
        classifiedShareOfGrossPct: null,
        unclassifiedShareOfGrossPct: null,
      },
    };
  }

  const exposureAccumulators = new Map();
  positions.forEach((position) => {
    if (position.weightAvailability !== true || position.marketValue == null) return;

    position.labels.forEach((label) => {
      let accumulator = exposureAccumulators.get(label.exposureId);
      if (!accumulator) {
        accumulator = {
          exposureId: label.exposureId,
          id: label.exposureId,
          label: label.label,
          dimension: label.dimension,
          longMarketValue: 0,
          shortMarketValue: 0,
          netMarketValue: 0,
          contributors: [],
          currentFit: label.currentFit,
          previousFit: label.previousFit,
          transition: label.transition,
        };
        exposureAccumulators.set(label.exposureId, accumulator);
      }

      const marketValue = position.marketValue;
      if (marketValue > 0) accumulator.longMarketValue += Math.abs(marketValue);
      if (marketValue < 0) accumulator.shortMarketValue += Math.abs(marketValue);
      accumulator.netMarketValue += marketValue;
      accumulator.contributors.push({
        positionKey: position.positionKey,
        accountId: position.accountId,
        conid: position.conid,
        symbol: position.symbol,
        localSymbol: position.localSymbol,
        side: position.side,
        isPrimary: label.isPrimary,
        marketValue,
        weightPct: position.weightPct,
        grossWeightPct: position.grossWeightPct,
        alignment: label.alignment,
      });
    });
  });

  const exposures = [...exposureAccumulators.values()]
    .map((exposure) => {
      const longPct = (exposure.longMarketValue / nav) * 100;
      const shortPct = (exposure.shortMarketValue / nav) * 100;
      const grossPct = longPct + shortPct;
      const netPct = (exposure.netMarketValue / nav) * 100;
      const contributors = exposure.contributors.sort(
        (left, right) => right.grossWeightPct - left.grossWeightPct,
      );
      return {
        ...exposure,
        longPct,
        shortPct,
        grossPct,
        netPct,
        positionCount: contributors.length,
        contributors,
        alignment: aggregateAlignment(contributors),
      };
    })
    .sort(sortExposures);

  const totalGrossWeightPct = positions.reduce(
    (sum, position) => sum + (position.grossWeightPct ?? 0),
    0,
  );
  const grossWeightForStatus = (status) => positions.reduce(
    (sum, position) => (
      position.classificationStatus === status
        ? sum + (position.grossWeightPct ?? 0)
        : sum
    ),
    0,
  );
  const classifiedGrossWeightPct = grossWeightForStatus('reviewed');
  const provisionalGrossWeightPct = grossWeightForStatus('provisional');
  const unclassifiedGrossWeightPct = grossWeightForStatus('unclassified');

  return {
    availability,
    currentQuad: normalizedCurrentQuad,
    previousQuad: normalizedPreviousQuad,
    nav,
    positions,
    exposures,
    coverage: {
      ...baseCoverage,
      totalGrossWeightPct,
      classifiedGrossWeightPct,
      provisionalGrossWeightPct,
      unclassifiedGrossWeightPct,
      classifiedShareOfGrossPct: totalGrossWeightPct > 0
        ? (classifiedGrossWeightPct / totalGrossWeightPct) * 100
        : 100,
      unclassifiedShareOfGrossPct: totalGrossWeightPct > 0
        ? (unclassifiedGrossWeightPct / totalGrossWeightPct) * 100
        : 0,
    },
  };
}

export default aggregatePortfolioQuadExposures;
