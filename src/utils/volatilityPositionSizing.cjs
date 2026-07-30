/**
 * Volatility-based position sizing suggestions.
 * Reference-only / non-executable — never places trades.
 */

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteOptional(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function liveSizingEligible(position, options) {
  return options?.livePortfolioVerified === true
    && position?.liveMarkVerified === true;
}

function clampWeight(weight, maxWeight) {
  if (!Number.isFinite(weight) || weight < 0) return 0;
  if (Number.isFinite(maxWeight) && maxWeight >= 0) return Math.min(weight, maxWeight);
  return weight;
}

function applyCapsAndRenormalize(rows, {
  totalAllocationPct,
  maxWeightPct,
  maxDollarNotional,
  portfolioValue,
  maxIterations = 20,
} = {}) {
  const totalAllocation = Math.max(0, Number(totalAllocationPct) || 0) / 100;
  const maxWeight = finitePositive(maxWeightPct) != null ? Number(maxWeightPct) / 100 : null;
  const maxDollar = finitePositive(maxDollarNotional);
  const nlv = finitePositive(portfolioValue);

  // Start from raw weights already scaled toward totalAllocation
  let weights = rows.map((row) => Math.max(0, Number(row.rawWeight) || 0));
  const sumRaw = weights.reduce((sum, w) => sum + w, 0);
  if (sumRaw > 0 && totalAllocation > 0) {
    weights = weights.map((w) => (w / sumRaw) * totalAllocation);
  } else {
    weights = weights.map(() => 0);
  }

  for (let iter = 0; iter < maxIterations; iter += 1) {
    let changed = false;
    weights = weights.map((weight, index) => {
      let next = clampWeight(weight, maxWeight);
      if (maxDollar != null && nlv != null && nlv > 0) {
        const dollarCapWeight = maxDollar / nlv;
        if (next > dollarCapWeight) {
          next = dollarCapWeight;
        }
      }
      // Keep rows without valid sizing vol at zero
      if (!Number.isFinite(rows[index].sizingVol) || rows[index].sizingVol <= 0) {
        next = 0;
      }
      if (Math.abs(next - weight) > 1e-12) changed = true;
      return next;
    });

    const cappedSum = weights.reduce((sum, w) => sum + w, 0);
    if (cappedSum <= 0 || totalAllocation <= 0) break;

    // Redistribute leftover allocation to uncapped names proportionally
    if (cappedSum < totalAllocation - 1e-10) {
      const freeIndexes = [];
      weights.forEach((weight, index) => {
        const atWeightCap = maxWeight != null && weight >= maxWeight - 1e-12;
        const atDollarCap = maxDollar != null && nlv != null
          && weight >= (maxDollar / nlv) - 1e-12;
        const hasVol = Number.isFinite(rows[index].sizingVol) && rows[index].sizingVol > 0;
        if (hasVol && !atWeightCap && !atDollarCap) freeIndexes.push(index);
      });
      if (freeIndexes.length === 0) break;
      const leftover = totalAllocation - cappedSum;
      const freeSum = freeIndexes.reduce((sum, i) => sum + weights[i], 0);
      if (freeSum <= 0) {
        const add = leftover / freeIndexes.length;
        freeIndexes.forEach((i) => {
          weights[i] += add;
        });
      } else {
        freeIndexes.forEach((i) => {
          weights[i] += leftover * (weights[i] / freeSum);
        });
      }
      changed = true;
      continue;
    }

    if (!changed) break;
  }

  return rows.map((row, index) => {
    if (row.available !== true) {
      return {
        ...row,
        suggestedWeight: null,
        suggestedWeightPct: null,
        suggestedDollars: null,
      };
    }
    const weight = weights[index] || 0;
    const suggestedDollars = nlv != null ? weight * nlv : null;
    return {
      ...row,
      suggestedWeight: weight,
      suggestedWeightPct: weight * 100,
      suggestedDollars,
    };
  });
}

/**
 * Equal-risk: raw w_i = 1 / sizingVol_i, normalize to totalAllocationPct, apply caps.
 */
function sizeEqualRisk(positions, options = {}) {
  const rows = (Array.isArray(positions) ? positions : []).map((position) => {
    const eligible = liveSizingEligible(position, options);
    const sizingVol = eligible ? finitePositive(position.sizingVol) : null;
    const rawWeight = sizingVol != null ? (1 / sizingVol) : 0;
    return {
      symbol: position.symbol,
      assetType: position.assetType || null,
      latestPrice: position.latestPrice ?? null,
      sizingVol,
      rv63: position.rv63 ?? null,
      rv252: position.rv252 ?? null,
      rv3y: position.rv3y ?? null,
      rv5y: position.rv5y ?? null,
      rv10y: position.rv10y ?? null,
      asOf: position.asOf ?? null,
      observationCount: position.observationCount ?? 0,
      annualizationFactor: position.annualizationFactor ?? null,
      liveMarkVerified: eligible,
      currentPositionDollars: eligible
        ? finiteOptional(position.currentPositionDollars)
        : null,
      currentWeightPct: eligible ? finiteOptional(position.currentWeightPct) : null,
      warning: position.warning || null,
      limitedHistory: Boolean(position.limitedHistory),
      spikeWarning: Boolean(position.spikeWarning),
      rawWeight,
      available: sizingVol != null,
    };
  });

  const sized = applyCapsAndRenormalize(rows, options);
  const nlv = finitePositive(options.portfolioValue);
  return sized.map((row) => {
    const current = row.currentPositionDollars;
    const suggested = row.suggestedDollars;
    return {
      ...row,
      mode: 'equal-risk',
      differenceDollars: (suggested != null && current != null) ? suggested - current : null,
      differenceWeightPct: (row.suggestedWeightPct != null && row.currentWeightPct != null)
        ? row.suggestedWeightPct - row.currentWeightPct
        : (suggested != null && current != null && nlv != null && nlv > 0
          ? ((suggested - current) / nlv) * 100
          : null),
      referenceOnly: true,
      executable: false,
    };
  });
}

/**
 * Per-position risk budget: notional = portfolioValue * riskBudgetPct / sizingVol
 */
function sizeRiskBudget(positions, options = {}) {
  const nlv = finitePositive(options.portfolioValue);
  const riskBudgetPct = Math.max(0, Number(options.riskBudgetPct) || 0) / 100;
  const maxWeight = finitePositive(options.maxWeightPct) != null
    ? Number(options.maxWeightPct) / 100
    : null;
  const maxDollar = finitePositive(options.maxDollarNotional);

  return (Array.isArray(positions) ? positions : []).map((position) => {
    const eligible = liveSizingEligible(position, options);
    const sizingVol = eligible ? finitePositive(position.sizingVol) : null;
    let suggestedDollars = null;
    let suggestedWeight = null;

    if (sizingVol != null && nlv != null && riskBudgetPct > 0) {
      suggestedDollars = (nlv * riskBudgetPct) / sizingVol;
      if (maxDollar != null) suggestedDollars = Math.min(suggestedDollars, maxDollar);
      suggestedWeight = suggestedDollars / nlv;
      if (maxWeight != null) {
        suggestedWeight = Math.min(suggestedWeight, maxWeight);
        suggestedDollars = suggestedWeight * nlv;
      }
    }

    const current = eligible ? finiteOptional(position.currentPositionDollars) : null;
    const suppliedCurrentWeightPct = eligible
      ? finiteOptional(position.currentWeightPct)
      : null;
    const currentWeightPct = suppliedCurrentWeightPct != null
      ? suppliedCurrentWeightPct
      : (current != null && nlv != null && nlv > 0 ? (current / nlv) * 100 : null);

    return {
      symbol: position.symbol,
      assetType: position.assetType || null,
      liveMarkVerified: eligible,
      latestPrice: position.latestPrice ?? null,
      sizingVol,
      rv63: position.rv63 ?? null,
      rv252: position.rv252 ?? null,
      rv3y: position.rv3y ?? null,
      rv5y: position.rv5y ?? null,
      rv10y: position.rv10y ?? null,
      asOf: position.asOf ?? null,
      observationCount: position.observationCount ?? 0,
      annualizationFactor: position.annualizationFactor ?? null,
      currentPositionDollars: current,
      currentWeightPct,
      warning: position.warning || null,
      limitedHistory: Boolean(position.limitedHistory),
      spikeWarning: Boolean(position.spikeWarning),
      available: sizingVol != null,
      suggestedWeight,
      suggestedWeightPct: suggestedWeight != null ? suggestedWeight * 100 : null,
      suggestedDollars,
      differenceDollars: (suggestedDollars != null && current != null)
        ? suggestedDollars - current
        : null,
      differenceWeightPct: (suggestedWeight != null && currentWeightPct != null)
        ? (suggestedWeight * 100) - currentWeightPct
        : null,
      mode: 'risk-budget',
      referenceOnly: true,
      executable: false,
    };
  });
}

function computeVolatilityPositionSizing(positions, options = {}) {
  const mode = String(options.mode || 'equal-risk').toLowerCase();
  if (mode === 'risk-budget' || mode === 'risk_budget') {
    return sizeRiskBudget(positions, options);
  }
  return sizeEqualRisk(positions, options);
}

module.exports = {
  applyCapsAndRenormalize,
  computeVolatilityPositionSizing,
  sizeEqualRisk,
  sizeRiskBudget,
};
