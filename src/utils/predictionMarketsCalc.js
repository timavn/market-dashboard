/**
 * Prediction Markets Calculation Library
 * Pure functions — no side effects, no imports.
 * All prices are in $0–$1 normalized form (0 = 0%, 1 = 100%).
 * payoutMultiplier = 1 for ForecastEx/Kalshi ($1 contracts).
 * payoutMultiplier = 100 for CME Event Contracts ($100 payout).
 * Dollar amounts = normalized_price * payoutMultiplier.
 */

// ---------------------------------------------------------------------------
// Probability Adjustment
// ---------------------------------------------------------------------------

/**
 * Apply confidence haircut: shrinks probability toward 50%.
 * confidenceMultiplier: 0 = all bets are 50%, 1 = use raw probability unchanged.
 */
export function adjustProbability(rawProb, confidenceMultiplier) {
  const cm = Math.max(0, Math.min(1, confidenceMultiplier ?? 1));
  return 0.5 + cm * (rawProb - 0.5);
}

// ---------------------------------------------------------------------------
// Edge & Expected Value
// ---------------------------------------------------------------------------

/**
 * Gross edge for the Yes side: user probability minus contract price.
 */
export function grossEdgeYes(userProb, yesPrice) {
  return userProb - yesPrice;
}

/**
 * Gross edge for the No side: (1 - user probability) minus no price.
 */
export function grossEdgeNo(userProb, noPrice) {
  return (1 - userProb) - noPrice;
}

/**
 * Net edge after fees, slippage, and model-error buffer.
 */
export function netEdge(grossEdge, feesPerContract, slippageBuffer, modelErrorBuffer) {
  return grossEdge - (feesPerContract ?? 0) - (slippageBuffer ?? 0) - (modelErrorBuffer ?? 0);
}

/**
 * Expected value per contract for the Yes side.
 * Full form: p * (payoutMult - yesPrice*payoutMult) - (1-p) * (yesPrice*payoutMult)
 * Simplifies to: payoutMultiplier * (p - yesPrice)
 */
export function evYesPerContract(userProb, yesPrice, payoutMultiplier = 1) {
  return payoutMultiplier * (userProb * (1 - yesPrice) - (1 - userProb) * yesPrice);
}

/**
 * Expected value per contract for the No side.
 */
export function evNoPerContract(userProb, noPrice, payoutMultiplier = 1) {
  return payoutMultiplier * ((1 - userProb) * (1 - noPrice) - userProb * noPrice);
}

/**
 * Total EV for a position (gross, before fees).
 */
export function totalEV(evPerContract, numContracts) {
  return evPerContract * numContracts;
}

/**
 * Net EV after total fees deducted.
 */
export function netEV(evPerContract, numContracts, totalFees) {
  return evPerContract * numContracts - (totalFees ?? 0);
}

/**
 * Breakeven probability for Yes (price + cost of fees/slippage per dollar risked).
 */
export function breakevenProbYes(yesPrice, feesPerContract, slippageBuffer) {
  return yesPrice + (feesPerContract ?? 0) + (slippageBuffer ?? 0);
}

/**
 * Breakeven probability for No.
 */
export function breakevenProbNo(noPrice, feesPerContract, slippageBuffer) {
  return noPrice + (feesPerContract ?? 0) + (slippageBuffer ?? 0);
}

// ---------------------------------------------------------------------------
// Max Loss / Profit
// ---------------------------------------------------------------------------

export function maxLossYes(yesPrice, numContracts, payoutMultiplier = 1) {
  return yesPrice * payoutMultiplier * numContracts;
}

export function maxProfitYes(yesPrice, numContracts, payoutMultiplier = 1) {
  return (1 - yesPrice) * payoutMultiplier * numContracts;
}

export function maxLossNo(noPrice, numContracts, payoutMultiplier = 1) {
  return noPrice * payoutMultiplier * numContracts;
}

export function maxProfitNo(noPrice, numContracts, payoutMultiplier = 1) {
  return (1 - noPrice) * payoutMultiplier * numContracts;
}

// ---------------------------------------------------------------------------
// Kelly Sizing
// ---------------------------------------------------------------------------

/**
 * Kelly fraction for a binary contract.
 * b = payout_profit / amount_risked
 * kelly = (b*p - q) / b
 *
 * For Yes: amount_risked = yesPrice, payout_profit = 1 - yesPrice
 * For No:  amount_risked = noPrice,  payout_profit = 1 - noPrice
 */
/**
 * Kelly fraction for a binary contract.
 * payoutMultiplier scales b (the odds ratio) correctly for CME $100 contracts.
 * b = (payoutMultiplier - contractPrice*payoutMultiplier) / (contractPrice*payoutMultiplier)
 *   = (1 - contractPrice) / contractPrice  — payoutMultiplier cancels out, so Kelly % is unchanged.
 * Dollar sizing must still account for payoutMultiplier in the risk-per-contract calc.
 */
export function kellyFraction(userProb, contractPrice) {
  if (contractPrice <= 0 || contractPrice >= 1) return 0;
  const p = userProb;
  const q = 1 - p;
  const b = (1 - contractPrice) / contractPrice;
  return (b * p - q) / b;
}

/**
 * Fractional Kelly — returns suggested number of contracts (floored).
 * Caps at maxBetCap dollars of risk.
 */
export function fractionalKellySizing(userProb, contractPrice, kellyMultiplier, portfolioEquity, maxBetCapDollars, payoutMultiplier = 1) {
  if (!Number.isFinite(Number(portfolioEquity)) || Number(portfolioEquity) <= 0) return 0;
  const kf = kellyFraction(userProb, contractPrice);
  if (kf <= 0) return 0;
  const fractionedKelly = kf * (kellyMultiplier ?? 0.25);
  const dollarRisk = fractionedKelly * portfolioEquity;
  const cappedRisk = maxBetCapDollars ? Math.min(dollarRisk, maxBetCapDollars) : dollarRisk;
  // Each contract risks contractPrice * payoutMultiplier dollars
  const riskPerContract = contractPrice * payoutMultiplier;
  return Math.max(0, Math.floor(cappedRisk / riskPerContract));
}

/**
 * Conservative Kelly — uses half-Kelly with an additional cap.
 */
export function conservativeKellySizing(userProb, contractPrice, portfolioEquity, maxBetCapDollars, payoutMultiplier = 1) {
  return fractionalKellySizing(userProb, contractPrice, 0.25, portfolioEquity, maxBetCapDollars, payoutMultiplier);
}

/**
 * Fixed dollar risk sizing — accounts for payoutMultiplier.
 * riskPerContract = contractPrice * payoutMultiplier
 */
export function fixedDollarSizing(fixedRiskDollars, contractPrice, payoutMultiplier = 1) {
  const riskPerContract = contractPrice * payoutMultiplier;
  if (!Number.isFinite(Number(fixedRiskDollars)) || Number(fixedRiskDollars) <= 0 || riskPerContract <= 0) return 0;
  return Math.max(0, Math.floor(fixedRiskDollars / riskPerContract));
}

/**
 * Fixed percent of portfolio sizing.
 */
export function fixedPctSizing(portfolioEquity, pctOfPortfolio, contractPrice, payoutMultiplier = 1) {
  return fixedDollarSizing(portfolioEquity * pctOfPortfolio, contractPrice, payoutMultiplier);
}

/**
 * Master sizing function — dispatches to correct mode.
 */
export function calcSizing(mode, params) {
  const {
    userProb, contractPrice, portfolioEquity,
    fixedDollar, fixedPct, kellyMultiplier,
    maxBetCapDollars, manualContracts,
    payoutMultiplier = 1,
  } = params;

  switch (mode) {
    case 'fixed_dollar':
      return fixedDollarSizing(fixedDollar ?? 0, contractPrice, payoutMultiplier);
    case 'fixed_pct':
      return fixedPctSizing(portfolioEquity ?? 0, fixedPct ?? 0.01, contractPrice, payoutMultiplier);
    case 'fractional_kelly':
      return fractionalKellySizing(userProb, contractPrice, kellyMultiplier ?? 0.25, portfolioEquity ?? 0, maxBetCapDollars, payoutMultiplier);
    case 'conservative_kelly':
      return conservativeKellySizing(userProb, contractPrice, portfolioEquity ?? 0, maxBetCapDollars, payoutMultiplier);
    case 'manual':
      return manualContracts ?? 0;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Recommendation Engine
// ---------------------------------------------------------------------------

/**
 * Returns a full recommendation object.
 * settings: { minNetEdge, maxOpenRisk, currentOpenRisk, maxBetCapDollars, feesPerContract,
 *             slippageBuffer, modelErrorBuffer, portfolioEquity, kellyMultiplier,
 *             sizingMode, fixedDollar, fixedPct, minConfidence, stalePriceThresholdHours }
 */
export function getRecommendation(contract, settings = {}) {
  const {
    yesPrice, noPrice, myProbability, adjustedProbability,
    confidenceScore, settlementDate, bid, ask,
  } = contract;

  const prob = adjustedProbability ?? myProbability;
  const warnings = [];
  const {
    minNetEdge = 0.02,
    feesPerContract = 0,
    slippageBuffer = 0,
    modelErrorBuffer = 0,
    minConfidence = 0.5,
    portfolioEquity = null,
    kellyMultiplier = 0.25,
    sizingMode = 'fractional_kelly',
    fixedDollar = 500,
    fixedPct = 0.01,
    maxBetCapDollars = 5000,
    currentOpenRisk = 0,
    maxOpenRisk = 10000,
  } = settings;

  // --- Validation checks ---
  if (!prob || prob === undefined) {
    return { action: 'No Trade', side: null, reason: 'Model probability missing.', warnings: ['No model probability entered.'], suggestedContracts: 0, ev: 0, maxLoss: 0, maxProfit: 0 };
  }
  if (!yesPrice || !noPrice) {
    return { action: 'No Trade', side: null, reason: 'Contract prices missing.', warnings: ['Yes/No prices required.'], suggestedContracts: 0, ev: 0, maxLoss: 0, maxProfit: 0 };
  }
  if (!Number.isFinite(Number(portfolioEquity)) || Number(portfolioEquity) <= 0) {
    return {
      action: 'No Trade',
      side: null,
      reason: 'Live net liquidation value is unavailable.',
      warnings: ['Position sizing and order fields are disabled until live NLV is verified.'],
      suggestedContracts: 0,
      ev: 0,
      maxLoss: 0,
      maxProfit: 0,
    };
  }
  if (prob < 0 || prob > 1) {
    warnings.push('Probability out of range (0–1).');
  }

  // Price sanity
  const priceSum = yesPrice + noPrice;
  if (Math.abs(priceSum - 1) > 0.05) {
    warnings.push(`Yes + No prices sum to ${priceSum.toFixed(3)}, expected ~1.00. Check inputs.`);
  }

  // Spread check
  if (bid && ask && (ask - bid) > 0.05) {
    warnings.push(`Wide spread: bid ${bid.toFixed(3)} / ask ${ask.toFixed(3)}. Liquidity risk.`);
  }

  // Confidence check
  if (confidenceScore !== undefined && confidenceScore < minConfidence) {
    warnings.push(`Model confidence (${(confidenceScore * 100).toFixed(0)}%) below threshold (${(minConfidence * 100).toFixed(0)}%).`);
  }

  // Settlement date check
  if (settlementDate) {
    const daysToSettlement = (new Date(settlementDate) - new Date()) / (1000 * 60 * 60 * 24);
    if (daysToSettlement < 0) {
      warnings.push('Settlement date has passed. Mark as settled or canceled.');
    } else if (daysToSettlement < 1) {
      warnings.push('Less than 24h to settlement — high risk.');
    }
  } else {
    warnings.push('Settlement date not set.');
  }

  // Risk cap check
  if (currentOpenRisk >= maxOpenRisk) {
    return { action: 'No Trade', side: null, reason: 'Max open risk limit reached.', warnings, suggestedContracts: 0, ev: 0, maxLoss: 0, maxProfit: 0 };
  }

  // --- Edge calculations ---
  const geYes = grossEdgeYes(prob, yesPrice);
  const geNo = grossEdgeNo(prob, noPrice);
  const neYes = netEdge(geYes, feesPerContract, slippageBuffer, modelErrorBuffer);
  const neNo = netEdge(geNo, feesPerContract, slippageBuffer, modelErrorBuffer);

  const payoutMult = contract.payoutMultiplier ?? 1;
  const evY = evYesPerContract(prob, yesPrice, payoutMult);
  const evN = evNoPerContract(prob, noPrice, payoutMult);

  // Pick best side
  let bestSide = null;
  let bestNetEdge = -Infinity;
  let contractPrice = 0;
  let evPerContract = 0;

  if (neYes > neNo && neYes > minNetEdge) {
    bestSide = 'Yes';
    bestNetEdge = neYes;
    contractPrice = yesPrice;
    evPerContract = evY;
  } else if (neNo > neYes && neNo > minNetEdge) {
    bestSide = 'No';
    bestNetEdge = neNo;
    contractPrice = noPrice;
    evPerContract = evN;
  }

  if (!bestSide || bestNetEdge <= minNetEdge) {
    return {
      action: 'No Trade',
      side: null,
      reason: `Net edge (${Math.max(neYes, neNo).toFixed(4)}) below minimum threshold (${minNetEdge}).`,
      warnings,
      suggestedContracts: 0,
      ev: 0,
      maxLoss: 0,
      maxProfit: 0,
      grossEdgeYes: geYes,
      grossEdgeNo: geNo,
      netEdgeYes: neYes,
      netEdgeNo: neNo,
    };
  }

  // Sizing
  const suggestedContracts = calcSizing(sizingMode, {
    userProb: prob,
    contractPrice,
    portfolioEquity,
    fixedDollar,
    fixedPct,
    kellyMultiplier,
    maxBetCapDollars,
  });

  const finalContracts = Math.min(
    suggestedContracts,
    maxBetCapDollars ? Math.floor(maxBetCapDollars / contractPrice) : suggestedContracts
  );

  const pm = contract.payoutMultiplier ?? 1;
  const ml = bestSide === 'Yes' ? maxLossYes(yesPrice, finalContracts, pm) : maxLossNo(noPrice, finalContracts, pm);
  const mp = bestSide === 'Yes' ? maxProfitYes(yesPrice, finalContracts, pm) : maxProfitNo(noPrice, finalContracts, pm);
  const totalEvCalc = netEV(evPerContract, finalContracts, feesPerContract * finalContracts);

  // Post-sizing risk check
  if (currentOpenRisk + ml > maxOpenRisk) {
    warnings.push(`This bet would push total open risk to $${(currentOpenRisk + ml).toFixed(0)}, exceeding cap of $${maxOpenRisk}.`);
  }

  return {
    action: 'Trade',
    side: bestSide,
    suggestedContracts: finalContracts,
    ev: totalEvCalc,
    maxLoss: ml,
    maxProfit: mp,
    grossEdgeYes: geYes,
    grossEdgeNo: geNo,
    netEdgeYes: neYes,
    netEdgeNo: neNo,
    kellyFractionYes: kellyFraction(prob, yesPrice),
    kellyFractionNo: kellyFraction(prob, noPrice),
    reason: `${bestSide} side has net edge of ${(bestNetEdge * 100).toFixed(2)}%.`,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Band-to-Probability Helper
// ---------------------------------------------------------------------------

/**
 * Convert a model forecast band into a probability for a given threshold.
 *
 * distribution: 'normal' | 'triangular' | 'uniform'
 * eventType: 'above_threshold' | 'below_threshold' | 'inside_range' | 'outside_range'
 */
export function bandToProb({ currentLevel, lowerBound, upperBound, expectedLevel, confidence, threshold, eventType, distribution }) {
  distribution = distribution || 'normal';
  eventType = eventType || 'above_threshold';
  const warnings = [];

  const mu = expectedLevel ?? (lowerBound + upperBound) / 2;
  const range = upperBound - lowerBound;

  if (range <= 0) {
    warnings.push('Upper bound must be greater than lower bound.');
    return { probability: null, explanation: 'Invalid range.', warnings };
  }

  let prob = 0;
  let explanation = '';

  if (distribution === 'normal') {
    // Approximate sigma from range: assume ~95% of probability within [lower, upper]
    const sigma = range / (2 * 1.96);
    const z = (threshold - mu) / sigma;
    const cdf = normalCDF(z);

    switch (eventType) {
      case 'above_threshold':
        prob = 1 - cdf;
        explanation = `Using normal distribution (μ=${mu.toFixed(2)}, σ=${sigma.toFixed(2)}): P(X > ${threshold}) = ${(prob * 100).toFixed(1)}%`;
        break;
      case 'below_threshold':
        prob = cdf;
        explanation = `P(X < ${threshold}) = ${(prob * 100).toFixed(1)}%`;
        break;
      case 'inside_range': {
        const z1 = (lowerBound - mu) / sigma;
        const z2 = (upperBound - mu) / sigma;
        prob = normalCDF(z2) - normalCDF(z1);
        explanation = `P(${lowerBound} < X < ${upperBound}) = ${(prob * 100).toFixed(1)}%`;
        break;
      }
      case 'outside_range': {
        const z1 = (lowerBound - mu) / sigma;
        const z2 = (upperBound - mu) / sigma;
        prob = 1 - (normalCDF(z2) - normalCDF(z1));
        explanation = `P(X < ${lowerBound} or X > ${upperBound}) = ${(prob * 100).toFixed(1)}%`;
        break;
      }
      default:
        prob = 0;
    }

  } else if (distribution === 'triangular') {
    // Triangular distribution: a=lower, b=upper, c=mode (expected)
    const a = lowerBound, b = upperBound, c = mu;
    switch (eventType) {
      case 'above_threshold':
        prob = 1 - triangularCDF(threshold, a, b, c);
        explanation = `Triangular(${a}, ${b}, mode=${c}): P(X > ${threshold}) = ${(prob * 100).toFixed(1)}%`;
        break;
      case 'below_threshold':
        prob = triangularCDF(threshold, a, b, c);
        explanation = `P(X < ${threshold}) = ${(prob * 100).toFixed(1)}%`;
        break;
      case 'inside_range':
        prob = triangularCDF(upperBound, a, b, c) - triangularCDF(lowerBound, a, b, c);
        explanation = `P(${lowerBound} < X < ${upperBound}) = ${(prob * 100).toFixed(1)}%`;
        break;
      case 'outside_range':
        prob = 1 - (triangularCDF(upperBound, a, b, c) - triangularCDF(lowerBound, a, b, c));
        explanation = `P(outside range) = ${(prob * 100).toFixed(1)}%`;
        break;
      default:
        prob = 0;
    }

  } else if (distribution === 'uniform') {
    switch (eventType) {
      case 'above_threshold':
        prob = Math.max(0, Math.min(1, (upperBound - threshold) / range));
        explanation = `Uniform[${lowerBound}, ${upperBound}]: P(X > ${threshold}) = ${(prob * 100).toFixed(1)}%`;
        break;
      case 'below_threshold':
        prob = Math.max(0, Math.min(1, (threshold - lowerBound) / range));
        explanation = `P(X < ${threshold}) = ${(prob * 100).toFixed(1)}%`;
        break;
      case 'inside_range':
        prob = 1;
        explanation = 'P(inside [lower, upper]) = 100% by definition for uniform distribution.';
        warnings.push('Inside range always = 1 for uniform. Use normal or triangular.');
        break;
      case 'outside_range':
        prob = 0;
        explanation = 'P(outside [lower, upper]) = 0 for uniform distribution.';
        break;
      default:
        prob = 0;
    }
  }

  // Confidence adjustment
  if (confidence !== undefined && confidence < 1) {
    const confAdjProb = 0.5 + confidence * (prob - 0.5);
    warnings.push(`Confidence-adjusted probability: ${(confAdjProb * 100).toFixed(1)}% (raw: ${(prob * 100).toFixed(1)}%)`);
    prob = confAdjProb;
  }

  if (prob < 0.1 || prob > 0.9) {
    warnings.push('Extreme probability — verify band assumptions are correct.');
  }

  return {
    probability: Math.max(0, Math.min(1, prob)),
    explanation,
    warnings,
  };
}

// Normal CDF approximation (Abramowitz & Stegun)
function normalCDF(z) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

// Triangular CDF
function triangularCDF(x, a, b, c) {
  if (x <= a) return 0;
  if (x >= b) return 1;
  if (x <= c) return Math.pow(x - a, 2) / ((b - a) * (c - a));
  return 1 - Math.pow(b - x, 2) / ((b - a) * (b - c));
}

// ---------------------------------------------------------------------------
// Performance Analytics
// ---------------------------------------------------------------------------

/**
 * Brier score: mean((p - outcome)^2)
 * lower is better.
 */
export function brierScore(closedBets) {
  if (!closedBets.length) return null;
  const sum = closedBets.reduce((acc, b) => {
    const outcome = b.outcome ?? (b.settlementValue >= 0.99 ? 1 : 0);
    const p = b.adjustedProbability ?? b.myProbability ?? 0.5;
    return acc + Math.pow(p - outcome, 2);
  }, 0);
  return sum / closedBets.length;
}

/**
 * Log loss: -mean(outcome * ln(p) + (1-outcome) * ln(1-p))
 * p clipped to [0.001, 0.999]
 */
export function logLoss(closedBets) {
  if (!closedBets.length) return null;
  const sum = closedBets.reduce((acc, b) => {
    const outcome = b.outcome ?? (b.settlementValue >= 0.99 ? 1 : 0);
    const p = Math.max(0.001, Math.min(0.999, b.adjustedProbability ?? b.myProbability ?? 0.5));
    return acc + (outcome * Math.log(p) + (1 - outcome) * Math.log(1 - p));
  }, 0);
  return -(sum / closedBets.length);
}

/**
 * Calibration by 8 probability buckets.
 */
export function calibrationBuckets(closedBets) {
  const buckets = [
    { label: '50–55%', min: 0.50, max: 0.55 },
    { label: '55–60%', min: 0.55, max: 0.60 },
    { label: '60–65%', min: 0.60, max: 0.65 },
    { label: '65–70%', min: 0.65, max: 0.70 },
    { label: '70–75%', min: 0.70, max: 0.75 },
    { label: '75–80%', min: 0.75, max: 0.80 },
    { label: '80–90%', min: 0.80, max: 0.90 },
    { label: '90–100%', min: 0.90, max: 1.01 },
  ];

  return buckets.map(bucket => {
    const bets = closedBets.filter(b => {
      const p = b.adjustedProbability ?? b.myProbability ?? 0;
      return p >= bucket.min && p < bucket.max;
    });

    if (!bets.length) {
      return { ...bucket, n: 0, avgPredicted: null, actualHitRate: null, calibrationError: null, pnl: 0, avgPrice: null, avgEdge: null };
    }

    const avgPredicted = bets.reduce((s, b) => s + (b.adjustedProbability ?? b.myProbability ?? 0), 0) / bets.length;
    const wins = bets.filter(b => (b.outcome ?? (b.settlementValue >= 0.99 ? 1 : 0)) === 1).length;
    const actualHitRate = wins / bets.length;
    const calibrationError = avgPredicted - actualHitRate;
    const pnl = bets.reduce((s, b) => s + (b.realizedProfit ?? 0), 0);
    const avgPrice = bets.reduce((s, b) => s + (b.entryPrice ?? 0), 0) / bets.length;
    const avgEdge = bets.reduce((s, b) => {
      const side = b.contractSide === 'Yes' ? grossEdgeYes : grossEdgeNo;
      const p = b.adjustedProbability ?? b.myProbability ?? 0;
      return s + side(p, b.entryPrice ?? 0);
    }, 0) / bets.length;

    return { ...bucket, n: bets.length, avgPredicted, actualHitRate, calibrationError, pnl, avgPrice, avgEdge };
  });
}

/**
 * Win rate for closed bets.
 */
export function winRate(closedBets) {
  if (!closedBets.length) return null;
  const wins = closedBets.filter(b => (b.realizedProfit ?? 0) > 0).length;
  return wins / closedBets.length;
}

/**
 * EV residual per bet: realized profit vs expected at entry.
 */
export function evResiduals(closedBets) {
  return closedBets.map(b => {
    const side = b.contractSide === 'Yes' ? evYesPerContract : evNoPerContract;
    const p = b.adjustedProbability ?? b.myProbability ?? 0;
    const expectedAtEntry = side(p, b.entryPrice ?? 0) * (b.numContracts ?? 0) - (b.totalFees ?? 0);
    const realized = b.realizedProfit ?? 0;
    return {
      contractId: b.contractId,
      eventName: b.eventName,
      expectedAtEntry,
      realized,
      residual: realized - expectedAtEntry,
    };
  });
}

/**
 * Group performance by a dimension key.
 */
export function performanceByDimension(closedBets, dimensionKey) {
  const groups = {};
  closedBets.forEach(b => {
    const key = b[dimensionKey] ?? 'Unknown';
    if (!groups[key]) groups[key] = [];
    groups[key].push(b);
  });
  return Object.entries(groups).map(([label, bets]) => ({
    label,
    n: bets.length,
    totalPnl: bets.reduce((s, b) => s + (b.realizedProfit ?? 0), 0),
    winRate: winRate(bets),
    avgEdgeAtEntry: bets.reduce((s, b) => {
      const p = b.adjustedProbability ?? b.myProbability ?? 0.5;
      const ge = b.contractSide === 'Yes' ? grossEdgeYes(p, b.entryPrice ?? 0) : grossEdgeNo(p, b.entryPrice ?? 0);
      return s + ge;
    }, 0) / bets.length,
    brierScore: brierScore(bets),
  }));
}

// ---------------------------------------------------------------------------
// Risk Aggregation
// ---------------------------------------------------------------------------

/**
 * Compute open risk summary across all open contracts.
 */
export function openRiskSummary(openContracts) {
  const totalMaxLoss = openContracts.reduce((s, c) => {
    const pm = c.payoutMultiplier ?? 1;
    const ml = c.contractSide === 'Yes'
      ? maxLossYes(c.entryPrice ?? c.yesPrice ?? 0, c.numContracts ?? 0, pm)
      : maxLossNo(c.entryPrice ?? c.noPrice ?? 0, c.numContracts ?? 0, pm);
    return s + ml;
  }, 0);

  const totalMaxProfit = openContracts.reduce((s, c) => {
    const pm = c.payoutMultiplier ?? 1;
    const mp = c.contractSide === 'Yes'
      ? maxProfitYes(c.entryPrice ?? c.yesPrice ?? 0, c.numContracts ?? 0, pm)
      : maxProfitNo(c.entryPrice ?? c.noPrice ?? 0, c.numContracts ?? 0, pm);
    return s + mp;
  }, 0);

  const byAssetClass = {};
  const byCategory = {};
  const bySettlementDate = {};

  openContracts.forEach(c => {
    const pm = c.payoutMultiplier ?? 1;
    const ml = c.contractSide === 'Yes'
      ? maxLossYes(c.entryPrice ?? c.yesPrice ?? 0, c.numContracts ?? 0, pm)
      : maxLossNo(c.entryPrice ?? c.noPrice ?? 0, c.numContracts ?? 0, pm);

    const ac = c.assetClass ?? 'unknown';
    byAssetClass[ac] = (byAssetClass[ac] ?? 0) + ml;

    const cat = c.eventCategory ?? 'unknown';
    byCategory[cat] = (byCategory[cat] ?? 0) + ml;

    const sd = c.settlementDate ?? 'unknown';
    bySettlementDate[sd] = (bySettlementDate[sd] ?? 0) + ml;
  });

  return { totalMaxLoss, totalMaxProfit, byAssetClass, byCategory, bySettlementDate, openCount: openContracts.length };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateContract(contract) {
  const errors = [];
  const warnings = [];

  if (!contract.eventName?.trim()) errors.push('Event name is required.');
  if (!contract.contractQuestion?.trim()) errors.push('Contract question is required.');

  const yp = parseFloat(contract.yesPrice);
  const np = parseFloat(contract.noPrice);
  if (isNaN(yp) || yp <= 0 || yp >= 1) errors.push('Yes price must be between 0 and 1 (exclusive).');
  if (isNaN(np) || np <= 0 || np >= 1) errors.push('No price must be between 0 and 1 (exclusive).');
  if (!isNaN(yp) && !isNaN(np) && Math.abs(yp + np - 1) > 0.05) {
    warnings.push(`Yes + No prices = ${(yp + np).toFixed(3)}, expected ~1.00.`);
  }

  const mp = parseFloat(contract.myProbability);
  if (isNaN(mp) || mp < 0 || mp > 1) errors.push('My probability must be between 0 and 1.');

  if (!contract.settlementDate) warnings.push('Settlement date not set.');

  return { errors, warnings, valid: errors.length === 0 };
}
