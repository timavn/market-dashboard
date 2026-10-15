import {
  EXPOSURE_DIMENSIONS,
  HEDGEYE_EXPOSURE_LIST,
  getExposureDefinition,
  resolveSecurityExposureProfile,
} from '../constants/quadExposureCatalog';

export const FACTOR_EXPOSURE_TABS = Object.freeze([
  Object.freeze({ id: 'equityStyleFactors', label: 'Equity Style' }),
  Object.freeze({ id: 'equitySectors', label: 'Equity Sector' }),
  Object.freeze({ id: 'assetClasses', label: 'Asset Class' }),
  Object.freeze({ id: 'fixedIncomeSectors', label: 'Fixed Income' }),
]);

const finiteNumber = (value) => (
  value !== '' && value != null && Number.isFinite(Number(value)) ? Number(value) : null
);

const reviewedExposureIdsForDimension = (holding, dimension) => {
  const profile = resolveSecurityExposureProfile(holding);
  if (profile?.classificationStatus !== 'reviewed') return [];

  return [profile.primaryExposureId, ...(profile.secondaryExposureIds || [])]
    .map((id) => getExposureDefinition(id))
    .filter((definition) => definition?.dimension === dimension)
    .map(({ id }) => id);
};

export const holdingMatchesFactorExposure = (holding, dimension, exposureId) => (
  reviewedExposureIdsForDimension(holding, dimension).includes(exposureId)
);

export const buildPortfolioFactorExposure = (holdings, totalValue, dimension) => {
  const nav = finiteNumber(totalValue);
  if (!Array.isArray(holdings) || !(nav > 0)) {
    return {
      rows: [],
      coverage: { classifiedPct: 0, unclassifiedPct: 0 },
    };
  }

  const exposureTotals = new Map();
  let classifiedPct = 0;
  let unclassifiedPct = 0;

  holdings.forEach((holding) => {
    const marketValue = finiteNumber(holding?.marketValue);
    if (marketValue === null || marketValue === 0) return;

    const positionPct = Math.abs(marketValue / nav) * 100;
    const profile = resolveSecurityExposureProfile(holding);
    if (profile?.classificationStatus !== 'reviewed') {
      unclassifiedPct += positionPct;
      return;
    }
    classifiedPct += positionPct;

    const exposureIds = reviewedExposureIdsForDimension(holding, dimension);
    if (exposureIds.length === 0) return;

    const contributionPct = positionPct / exposureIds.length;
    exposureIds.forEach((id) => {
      const definition = getExposureDefinition(id);
      if (!definition) return;
      const current = exposureTotals.get(id) || {
        id,
        label: definition.label,
        longPct: 0,
        shortPct: 0,
      };
      if (marketValue > 0) current.longPct += contributionPct;
      else current.shortPct += contributionPct;
      exposureTotals.set(id, current);
    });
  });

  const rows = [...exposureTotals.values()]
    .map((row) => ({
      ...row,
      netPct: row.longPct - row.shortPct,
      grossPct: row.longPct + row.shortPct,
    }))
    .sort((left, right) => (
      right.grossPct - left.grossPct || left.label.localeCompare(right.label)
    ));

  return {
    rows,
    coverage: { classifiedPct, unclassifiedPct },
  };
};

// Show only Hedgeye worksheet factors, including factors with no position.
// Categories retain the existing attribution rule; rows across categories overlap.
export const buildPortfolioQuadExposure = (holdings, nav, available, unavailableHoldings = []) => {
  const canCalculate = available && Array.isArray(holdings) && finiteNumber(nav) > 0;
  const totals = new Map();
  if (canCalculate) {
    Object.keys(EXPOSURE_DIMENSIONS).forEach(dimension => {
      buildPortfolioFactorExposure(holdings, nav, dimension).rows.forEach(row => {
        totals.set(row.id, row);
      });
    });
  }
  const valuesFor = row => ({
    longPct: canCalculate ? row?.longPct || 0 : null,
    shortPct: canCalculate ? row?.shortPct || 0 : null,
    netPct: canCalculate ? row?.netPct || 0 : null,
    grossPct: canCalculate ? row?.grossPct || 0 : null,
  });
  const rows = HEDGEYE_EXPOSURE_LIST.map(exposure => ({
    ...exposure,
    ...valuesFor(totals.get(exposure.id)),
  }));
  const incompleteFactors = new Map();
  unavailableHoldings.forEach(holding => {
    const profile = resolveSecurityExposureProfile(holding);
    const ids = profile.classificationStatus === 'reviewed'
      ? [profile.primaryExposureId, ...(profile.secondaryExposureIds || [])] : [];
    ids.forEach(id => incompleteFactors.set(id, [...(incompleteFactors.get(id) || []), holding.symbol]));
  });
  return rows.map(row => incompleteFactors.has(row.id) ? {
    ...row, longPct: null, shortPct: null, netPct: null, grossPct: null,
    unavailableReason: `Missing verified valuation for ${[...new Set(incompleteFactors.get(row.id))].join(', ')}`,
  } : row);
};
