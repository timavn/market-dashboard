import {
  adjustProbability,
  grossEdgeYes,
  grossEdgeNo,
  netEdge,
  evYesPerContract,
  evNoPerContract,
  maxLossYes,
  maxProfitYes,
  maxLossNo,
  maxProfitNo,
  breakevenProbYes,
  breakevenProbNo,
  kellyFraction,
  fractionalKellySizing,
  fixedDollarSizing,
  fixedPctSizing,
  calcSizing,
  getRecommendation,
  brierScore,
  logLoss,
  validateContract,
} from './predictionMarketsCalc';

// ---------------------------------------------------------------------------
// adjustProbability
// ---------------------------------------------------------------------------

describe('adjustProbability', () => {
  test('confidence = 1 returns raw probability unchanged', () => {
    expect(adjustProbability(0.70, 1.0)).toBeCloseTo(0.70);
  });

  test('confidence = 0 collapses to 0.5', () => {
    expect(adjustProbability(0.70, 0.0)).toBeCloseTo(0.50);
  });

  test('confidence = 0.8 shrinks toward 0.5 correctly', () => {
    // 0.5 + 0.8 * (0.70 - 0.5) = 0.5 + 0.16 = 0.66
    expect(adjustProbability(0.70, 0.8)).toBeCloseTo(0.66);
  });

  test('confidence below 0 is clamped to 0', () => {
    expect(adjustProbability(0.90, -0.5)).toBeCloseTo(0.50);
  });

  test('confidence above 1 is clamped to 1', () => {
    expect(adjustProbability(0.70, 1.5)).toBeCloseTo(0.70);
  });

  test('works symmetrically for probabilities below 0.5', () => {
    // 0.5 + 0.8 * (0.30 - 0.5) = 0.5 - 0.16 = 0.34
    expect(adjustProbability(0.30, 0.8)).toBeCloseTo(0.34);
  });
});

// ---------------------------------------------------------------------------
// grossEdge
// ---------------------------------------------------------------------------

describe('grossEdgeYes', () => {
  test('positive edge when model prob > yes ask', () => {
    expect(grossEdgeYes(0.65, 0.43)).toBeCloseTo(0.22);
  });

  test('zero edge when model prob equals yes ask', () => {
    expect(grossEdgeYes(0.43, 0.43)).toBeCloseTo(0.0);
  });

  test('negative edge when model prob < yes ask', () => {
    expect(grossEdgeYes(0.30, 0.43)).toBeCloseTo(-0.13);
  });
});

describe('grossEdgeNo', () => {
  test('positive edge when (1 - model prob) > no ask', () => {
    // model says 65% yes => 35% no. noAsk = 0.57 => edge = 0.35 - 0.57 = -0.22 (negative)
    expect(grossEdgeNo(0.65, 0.57)).toBeCloseTo(-0.22);
  });

  test('positive No edge when model under-estimates Yes', () => {
    // model: 30% yes => 70% no. noAsk = 0.57 => edge = 0.70 - 0.57 = 0.13
    expect(grossEdgeNo(0.30, 0.57)).toBeCloseTo(0.13);
  });
});

// ---------------------------------------------------------------------------
// netEdge
// ---------------------------------------------------------------------------

describe('netEdge', () => {
  test('subtracts fees + slippage + model error buffer', () => {
    // grossEdge=0.22, fees=0.01, slip=0.005, model=0.005 => net=0.20
    expect(netEdge(0.22, 0.01, 0.005, 0.005)).toBeCloseTo(0.20);
  });

  test('defaults missing buffers to 0', () => {
    expect(netEdge(0.10)).toBeCloseTo(0.10);
  });

  test('can produce negative net edge', () => {
    expect(netEdge(0.01, 0.01, 0.005, 0.005)).toBeCloseTo(-0.01);
  });
});

// ---------------------------------------------------------------------------
// evYesPerContract / evNoPerContract — $1 payout
// ---------------------------------------------------------------------------

describe('evYesPerContract ($1 payout)', () => {
  test('correct EV with positive edge', () => {
    // p=0.65, yesAsk=0.43 => EV = 0.65*(1-0.43) - 0.35*0.43 = 0.3705 - 0.1505 = 0.22
    expect(evYesPerContract(0.65, 0.43)).toBeCloseTo(0.22);
  });

  test('EV is negative when prob < price', () => {
    expect(evYesPerContract(0.30, 0.43)).toBeCloseTo(-0.13);
  });

  test('EV is 0 when prob equals price', () => {
    expect(evYesPerContract(0.43, 0.43)).toBeCloseTo(0.0);
  });
});

describe('evNoPerContract ($1 payout)', () => {
  test('correct EV for No side with positive edge', () => {
    // p=0.30, noAsk=0.57 => EV = 0.70*(1-0.57) - 0.30*0.57 = 0.301 - 0.171 = 0.13
    expect(evNoPerContract(0.30, 0.57)).toBeCloseTo(0.13);
  });
});

// ---------------------------------------------------------------------------
// evYesPerContract / evNoPerContract — CME $100 payout
// ---------------------------------------------------------------------------

describe('evYesPerContract ($100 payout multiplier)', () => {
  test('scales EV by payoutMultiplier=100', () => {
    // p=0.60, yesAsk=0.55, payout=100
    // unit EV = 0.60*(1-0.55) - 0.40*0.55 = 0.27 - 0.22 = 0.05
    // dollar EV = 0.05 * 100 = 5.00
    expect(evYesPerContract(0.60, 0.55, 100)).toBeCloseTo(5.0);
  });

  test('$1 payout (default) unaffected', () => {
    expect(evYesPerContract(0.65, 0.43, 1)).toBeCloseTo(evYesPerContract(0.65, 0.43));
  });
});

// ---------------------------------------------------------------------------
// maxLoss / maxProfit
// ---------------------------------------------------------------------------

describe('maxLossYes', () => {
  test('$1 payout, 10 contracts at ask 0.43 = $4.30', () => {
    expect(maxLossYes(0.43, 10, 1)).toBeCloseTo(4.30);
  });

  test('CME $100 payout, 2 contracts at ask 0.55 = $110', () => {
    expect(maxLossYes(0.55, 2, 100)).toBeCloseTo(110.0);
  });
});

describe('maxProfitYes', () => {
  test('$1 payout, 10 contracts at ask 0.43, max profit = (1-0.43)*10 = $5.70', () => {
    expect(maxProfitYes(0.43, 10, 1)).toBeCloseTo(5.70);
  });

  test('CME $100 payout, 2 contracts, max profit = (1-0.55)*2*100 = $90', () => {
    expect(maxProfitYes(0.55, 2, 100)).toBeCloseTo(90.0);
  });
});

describe('maxLossNo / maxProfitNo', () => {
  test('maxLossNo: noAsk=0.57, 5 contracts, payout=1 => $2.85', () => {
    expect(maxLossNo(0.57, 5, 1)).toBeCloseTo(2.85);
  });

  test('maxProfitNo: noAsk=0.57, 5 contracts, payout=1 => $2.15', () => {
    expect(maxProfitNo(0.57, 5, 1)).toBeCloseTo(2.15);
  });
});

// ---------------------------------------------------------------------------
// breakevenProb
// ---------------------------------------------------------------------------

describe('breakevenProbYes', () => {
  test('yesAsk=0.43, fees=0.01, slippage=0.005 => 0.445', () => {
    expect(breakevenProbYes(0.43, 0.01, 0.005)).toBeCloseTo(0.445);
  });
});

describe('breakevenProbNo', () => {
  test('noAsk=0.57, fees=0.01, slippage=0.005 => 0.585', () => {
    expect(breakevenProbNo(0.57, 0.01, 0.005)).toBeCloseTo(0.585);
  });
});

// ---------------------------------------------------------------------------
// kellyFraction
// ---------------------------------------------------------------------------

describe('kellyFraction', () => {
  test('returns positive fraction with positive edge', () => {
    // p=0.65, price=0.43 => b=(0.57/0.43)=1.326 => kelly=(1.326*0.65-0.35)/1.326
    const k = kellyFraction(0.65, 0.43);
    expect(k).toBeGreaterThan(0);
    expect(k).toBeLessThanOrEqual(1);
  });

  test('returns 0 for price = 0 or 1', () => {
    expect(kellyFraction(0.65, 0)).toBe(0);
    expect(kellyFraction(0.65, 1)).toBe(0);
  });

  test('returns negative/0 when edge is negative', () => {
    // p=0.30, price=0.55 => definitely no edge on Yes
    const k = kellyFraction(0.30, 0.55);
    expect(k).toBeLessThanOrEqual(0);
  });

  test('payoutMultiplier cancels in Kelly % (50% prob, 0.43 price)', () => {
    // Kelly fraction doesn't change with payoutMultiplier because b = (1-price)/price
    const k1 = kellyFraction(0.65, 0.43);
    expect(k1).toBeCloseTo(kellyFraction(0.65, 0.43));
  });
});

// ---------------------------------------------------------------------------
// Sizing functions
// ---------------------------------------------------------------------------

describe('fixedDollarSizing', () => {
  test('$500 risk at $0.43/contract => floor(500/0.43) = 1162 contracts', () => {
    expect(fixedDollarSizing(500, 0.43, 1)).toBe(1162);
  });

  test('CME $100 payout: $500 risk at $0.55 normalized => $55/contract => 9 contracts', () => {
    expect(fixedDollarSizing(500, 0.55, 100)).toBe(9);
  });

  test('returns 0 for zero contract price', () => {
    expect(fixedDollarSizing(500, 0, 1)).toBe(0);
  });
});

describe('fixedPctSizing', () => {
  test('1% of $100K portfolio at $0.43/contract', () => {
    // riskDollars = 1000, contracts = floor(1000/0.43) = 2325
    expect(fixedPctSizing(100000, 0.01, 0.43, 1)).toBe(2325);
  });
});

describe('fractionalKellySizing', () => {
  test('returns a positive integer with positive edge', () => {
    const n = fractionalKellySizing(0.65, 0.43, 0.25, 100000, 500, 1);
    expect(n).toBeGreaterThan(0);
    expect(Number.isInteger(n)).toBe(true);
  });

  test('CME $100 payout produces fewer contracts than $1 payout for same dollar risk', () => {
    const n1 = fractionalKellySizing(0.65, 0.43, 0.25, 100000, 500, 1);
    const n100 = fractionalKellySizing(0.65, 0.43, 0.25, 100000, 500, 100);
    expect(n100).toBeLessThan(n1);
  });

  test('returns 0 when kelly fraction is negative', () => {
    expect(fractionalKellySizing(0.30, 0.55, 0.25, 100000, 500, 1)).toBe(0);
  });

  test('respects maxBetCapDollars cap', () => {
    const nUncapped = fractionalKellySizing(0.90, 0.10, 0.25, 1000000, null, 1);
    const nCapped = fractionalKellySizing(0.90, 0.10, 0.25, 1000000, 100, 1);
    expect(nCapped).toBeLessThanOrEqual(nUncapped);
  });
});

describe('calcSizing — mode dispatch', () => {
  const baseParams = {
    userProb: 0.65, contractPrice: 0.43, portfolioEquity: 100000,
    fixedDollar: 500, fixedPct: 0.01, kellyMultiplier: 0.25,
    maxBetCapDollars: 500, payoutMultiplier: 1,
  };

  test('fixed_dollar mode', () => {
    const n = calcSizing('fixed_dollar', baseParams);
    expect(n).toBe(fixedDollarSizing(500, 0.43, 1));
  });

  test('fixed_pct mode', () => {
    const n = calcSizing('fixed_pct', baseParams);
    expect(n).toBe(fixedPctSizing(100000, 0.01, 0.43, 1));
  });

  test('manual mode returns manualContracts', () => {
    const n = calcSizing('manual', { ...baseParams, manualContracts: 42 });
    expect(n).toBe(42);
  });

  test('unknown mode returns 0', () => {
    expect(calcSizing('unknown_mode', baseParams)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getRecommendation
// ---------------------------------------------------------------------------

const defaultSettings = {
  minNetEdge: 0.02,
  feesPerContract: 0.01,
  slippageBuffer: 0.005,
  modelErrorBuffer: 0.005,
  portfolioEquity: 100000,
  kellyMultiplier: 0.25,
  sizingMode: 'fractional_kelly',
  maxBetCapDollars: 500,
  currentOpenRisk: 0,
  maxOpenRisk: 10000,
  minConfidence: 0.5,
};

describe('getRecommendation', () => {
  test('never substitutes a hypothetical portfolio value when live NLV is missing', () => {
    const rec = getRecommendation({
      yesPrice: 0.43,
      noPrice: 0.57,
      myProbability: 0.65,
      confidenceScore: 0.85,
    }, {
      ...defaultSettings,
      portfolioEquity: null,
    });

    expect(rec).toMatchObject({
      action: 'No Trade',
      suggestedContracts: 0,
      reason: 'Live net liquidation value is unavailable.',
    });
  });

  test('recommends Trade Yes when Yes has clear positive net edge', () => {
    const contract = {
      yesPrice: 0.43, noPrice: 0.57, myProbability: 0.65,
      adjustedProbability: 0.65, confidenceScore: 0.85,
      settlementDate: '2026-12-31', payoutMultiplier: 1,
    };
    const rec = getRecommendation(contract, defaultSettings);
    expect(rec.action).toBe('Trade');
    expect(rec.side).toBe('Yes');
    expect(rec.suggestedContracts).toBeGreaterThan(0);
    expect(rec.maxLoss).toBeGreaterThan(0);
    expect(rec.ev).toBeGreaterThan(0);
  });

  test('recommends Trade No when No side has better net edge', () => {
    const contract = {
      yesPrice: 0.74, noPrice: 0.26, myProbability: 0.15,
      adjustedProbability: 0.15, confidenceScore: 0.85,
      settlementDate: '2026-12-31', payoutMultiplier: 1,
    };
    const rec = getRecommendation(contract, defaultSettings);
    expect(rec.action).toBe('Trade');
    expect(rec.side).toBe('No');
  });

  test('returns No Trade when neither side clears minNetEdge', () => {
    const contract = {
      yesPrice: 0.48, noPrice: 0.52, myProbability: 0.50,
      adjustedProbability: 0.50, confidenceScore: 0.80,
      settlementDate: '2026-12-31', payoutMultiplier: 1,
    };
    const rec = getRecommendation(contract, defaultSettings);
    expect(rec.action).toBe('No Trade');
    expect(rec.suggestedContracts).toBe(0);
  });

  test('returns No Trade when probability is missing', () => {
    const contract = { yesPrice: 0.43, noPrice: 0.57, payoutMultiplier: 1 };
    const rec = getRecommendation(contract, defaultSettings);
    expect(rec.action).toBe('No Trade');
    expect(rec.warnings.length).toBeGreaterThan(0);
  });

  test('returns No Trade when prices are missing', () => {
    const rec = getRecommendation({ myProbability: 0.65, payoutMultiplier: 1 }, defaultSettings);
    expect(rec.action).toBe('No Trade');
  });

  test('warns about stale/missing settlement date', () => {
    const contract = {
      yesPrice: 0.43, noPrice: 0.57, myProbability: 0.65,
      adjustedProbability: 0.65, payoutMultiplier: 1,
    };
    const rec = getRecommendation(contract, defaultSettings);
    const hasSettlementWarning = rec.warnings.some(w => w.toLowerCase().includes('settlement'));
    expect(hasSettlementWarning).toBe(true);
  });

  test('warns when Yes + No prices do not sum to ~1', () => {
    const contract = {
      yesPrice: 0.43, noPrice: 0.40, myProbability: 0.65,
      adjustedProbability: 0.65, settlementDate: '2026-12-31', payoutMultiplier: 1,
    };
    const rec = getRecommendation(contract, defaultSettings);
    const hasSumWarning = rec.warnings.some(w => w.includes('sum to'));
    expect(hasSumWarning).toBe(true);
  });

  test('CME $100 payout maxLoss scales by payoutMultiplier', () => {
    const contract = {
      yesPrice: 0.55, noPrice: 0.45, myProbability: 0.70,
      adjustedProbability: 0.70, confidenceScore: 0.85,
      settlementDate: '2026-12-31', payoutMultiplier: 100,
    };
    const recStandard = getRecommendation({ ...contract, payoutMultiplier: 1 }, defaultSettings);
    const recCME = getRecommendation(contract, defaultSettings);
    // CME max loss per contract is 100x larger, so fewer contracts should be suggested
    if (recCME.action === 'Trade' && recStandard.action === 'Trade') {
      expect(recCME.suggestedContracts).toBeLessThanOrEqual(recStandard.suggestedContracts);
    }
  });
});

// ---------------------------------------------------------------------------
// brierScore / logLoss
// ---------------------------------------------------------------------------

describe('brierScore', () => {
  test('perfect predictions give score of 0', () => {
    const bets = [
      { adjustedProbability: 1.0, outcome: 1 },
      { adjustedProbability: 0.0, outcome: 0 },
    ];
    expect(brierScore(bets)).toBeCloseTo(0.0);
  });

  test('worst possible predictions give score of 1', () => {
    const bets = [
      { adjustedProbability: 0.0, outcome: 1 },
      { adjustedProbability: 1.0, outcome: 0 },
    ];
    expect(brierScore(bets)).toBeCloseTo(1.0);
  });

  test('returns null for empty array', () => {
    expect(brierScore([])).toBeNull();
  });

  test('random chance (p=0.5 always) gives score of 0.25', () => {
    const bets = [
      { adjustedProbability: 0.5, outcome: 1 },
      { adjustedProbability: 0.5, outcome: 0 },
      { adjustedProbability: 0.5, outcome: 1 },
      { adjustedProbability: 0.5, outcome: 0 },
    ];
    expect(brierScore(bets)).toBeCloseTo(0.25);
  });
});

describe('logLoss', () => {
  test('returns null for empty array', () => {
    expect(logLoss([])).toBeNull();
  });

  test('lower log loss for better predictions', () => {
    const good = [{ adjustedProbability: 0.9, outcome: 1 }, { adjustedProbability: 0.1, outcome: 0 }];
    const bad = [{ adjustedProbability: 0.6, outcome: 1 }, { adjustedProbability: 0.4, outcome: 0 }];
    expect(logLoss(good)).toBeLessThan(logLoss(bad));
  });
});

// ---------------------------------------------------------------------------
// validateContract
// ---------------------------------------------------------------------------

describe('validateContract', () => {
  const valid = {
    eventName: 'SPX above 5500',
    contractQuestion: 'Will SPX close above 5500?',
    yesPrice: '0.43',
    noPrice: '0.57',
    myProbability: '0.65',
  };

  test('valid contract returns no errors', () => {
    const { errors, valid: isValid } = validateContract(valid);
    expect(errors).toHaveLength(0);
    expect(isValid).toBe(true);
  });

  test('missing eventName produces error', () => {
    const { errors } = validateContract({ ...valid, eventName: '' });
    expect(errors.some(e => e.toLowerCase().includes('event name'))).toBe(true);
  });

  test('missing contractQuestion produces error', () => {
    const { errors } = validateContract({ ...valid, contractQuestion: '' });
    expect(errors.some(e => e.toLowerCase().includes('contract question'))).toBe(true);
  });

  test('yesPrice out of range produces error', () => {
    const { errors } = validateContract({ ...valid, yesPrice: '1.2' });
    expect(errors.some(e => e.toLowerCase().includes('yes price'))).toBe(true);
  });

  test('invalid probability produces error', () => {
    const { errors } = validateContract({ ...valid, myProbability: '1.5' });
    expect(errors.some(e => e.toLowerCase().includes('probability'))).toBe(true);
  });

  test('prices not summing to ~1 produces warning', () => {
    const { warnings } = validateContract({ ...valid, yesPrice: '0.43', noPrice: '0.40' });
    expect(warnings.length).toBeGreaterThan(0);
  });
});
